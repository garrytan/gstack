/**
 * Unit tests for budget-override audit logger.
 *
 * The audit trail is the only check on `EVALS_BUDGET_OVERRIDE_REASON` and
 * `GSTACK_SIZE_BUDGET_OVERRIDE_REASON` — if the logger silently drops events,
 * overrides become invisible and the budget gates are theater. These tests
 * pin the contract: every override produces exactly one JSONL line with
 * timestamp + scope + reason + CI provenance.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logBudgetOverride } from './budget-override';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-override-test-'));
process.env.GSTACK_HOME = TMP_HOME;
const AUDIT_PATH = path.join(TMP_HOME, 'analytics', 'spend-overrides.jsonl');

describe('logBudgetOverride', () => {
  beforeEach(() => {
    // Start each test with a clean audit file
    try { fs.unlinkSync(AUDIT_PATH); } catch { /* doesn't exist */ }
  });

  test('writes one JSONL line per call with required fields', () => {
    logBudgetOverride({
      scope: 'evals-cost-cap-e2e',
      reason: 'model price went up, will rebase the cap next sprint',
      details: { tier: 'e2e', cap: 25, observed_cost_usd: 31.4 },
    });

    expect(fs.existsSync(AUDIT_PATH)).toBe(true);
    const lines = fs.readFileSync(AUDIT_PATH, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.scope).toBe('evals-cost-cap-e2e');
    expect(entry.reason).toBe('model price went up, will rebase the cap next sprint');
    expect(entry.details).toEqual({ tier: 'e2e', cap: 25, observed_cost_usd: 31.4 });
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('captures CI provenance when CI env is set', () => {
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REF_NAME = 'feature/x';
    process.env.GITHUB_SHA = 'deadbeefcafe1234';

    logBudgetOverride({ scope: 'skill-size-budget', reason: 'big diff bake-in' });

    const entry = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf-8').trim());
    expect(entry.ci).toBe(true);
    expect(entry.runner).toBe('github-actions');
    expect(entry.branch).toBe('feature/x');
    expect(entry.commit).toBe('deadbeef');

    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_SHA;
  });

  test('defaults provenance to local when CI is unset', () => {
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_SHA;
    delete process.env.CI_RUNNER;
    delete process.env.CI_COMMIT_REF_NAME;
    delete process.env.CI_COMMIT_SHORT_SHA;

    logBudgetOverride({ scope: 'skill-size-budget-corpus', reason: 'local dev test' });

    const entry = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf-8').trim());
    expect(entry.ci).toBe(false);
    expect(entry.runner).toBe('local');
    expect(entry.branch).toBe('unknown');
    expect(entry.commit).toBe('unknown');
  });

  test('append-only: multiple calls produce multiple lines', () => {
    logBudgetOverride({ scope: 's1', reason: 'r1' });
    logBudgetOverride({ scope: 's2', reason: 'r2' });
    logBudgetOverride({ scope: 's3', reason: 'r3' });

    const lines = fs.readFileSync(AUDIT_PATH, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    const scopes = lines.map(l => JSON.parse(l).scope);
    expect(scopes).toEqual(['s1', 's2', 's3']);
  });

  test('omits details key when entry.details is absent (uses empty object)', () => {
    logBudgetOverride({ scope: 'plain', reason: 'no details' });
    const entry = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf-8').trim());
    expect(entry.details).toEqual({});
  });

  test('never throws even when audit directory is missing — creates it', () => {
    // Remove the analytics dir to force mkdir
    try { fs.rmSync(path.join(TMP_HOME, 'analytics'), { recursive: true, force: true }); } catch { /* */ }
    expect(() => logBudgetOverride({ scope: 'recreate', reason: 'test' })).not.toThrow();
    expect(fs.existsSync(AUDIT_PATH)).toBe(true);
  });

  test('survives an unwritable audit path (logs warning, does not throw)', () => {
    // Point GSTACK_HOME at a path inside a file (illegal directory location)
    const originalHome = process.env.GSTACK_HOME;
    const bogusFile = path.join(TMP_HOME, 'not-a-dir.txt');
    fs.writeFileSync(bogusFile, 'just a file');
    process.env.GSTACK_HOME = bogusFile;
    expect(() => logBudgetOverride({ scope: 'unwritable', reason: 'fs error path' })).not.toThrow();
    process.env.GSTACK_HOME = originalHome;
  });
});
