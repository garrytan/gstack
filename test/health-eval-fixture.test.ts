/** Free fixture/recording checks; never import or invoke the paid runner. */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createHealthEvalFixture, healthReportingFailures, recordHealthAttempt,
} from './helpers/health-eval-fixture';
import type { SkillTestResult } from './helpers/session-runner';
import type { EvalTestEntry } from './helpers/eval-store';
import { E2E_TIERS, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { isPaidTestFile } from './helpers/paid-test-set';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test('health behavior is selected as periodic and paid while capture regressions stay free', () => {
  const selectedBy = (file: string) => selectTests([file], E2E_TOUCHFILES, GLOBAL_TOUCHFILES).selected;
  expect(selectedBy('health/SKILL.md.tmpl')).toContain('health-reporting');
  expect(selectedBy('test/helpers/health-eval-fixture.ts')).toEqual(['health-reporting']);
  expect(E2E_TIERS['health-reporting']).toBe('periodic');
  expect(isPaidTestFile('test/skill-e2e-health.test.ts')).toBe(true);
  expect(isPaidTestFile('test/health-capture.test.ts')).toBe(false);
});

function fixture(prefix = 'health-fixture-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return createHealthEvalFixture(dir, ROOT);
}

function writePassingEvidence(f: ReturnType<typeof fixture>) {
  fs.writeFileSync(path.join(f.dir, 'partial-report.md'), `Type check: 0/10 CRITICAL, 60 errors.
Tests: 10/10 CLEAN, 5 passed.
Checked: type check, tests. Unavailable: lint, dead code, shell lint, GBrain (not installed).
COMPOSITE SCORE: **5.6 / 10 — partial coverage**
Coverage changed; prior test-only history is not comparable.
`);
  fs.writeFileSync(path.join(f.dir, 'no-tools-report.md'), 'COMPOSITE SCORE: N/A — no checks ran.\n');
  fs.appendFileSync(path.join(f.gstackHome, 'projects', 'partial', 'health-history.jsonl'), JSON.stringify({
    score: 5.6, typecheck: 0, test: 10, lint: null, deadcode: null, shell: null, gbrain: null,
  }) + '\n');
  fs.writeFileSync(f.receipts, 'typecheck\ntest\n');
}

describe('/health eval fixtures', () => {
  test('extracts all six real workflow steps and redirects persistent paths', () => {
    const f = fixture();
    const skill = fs.readFileSync(path.join(f.dir, 'health-SKILL.md'), 'utf-8');
    expect(skill).not.toContain('## Preamble (run first)');
    expect(skill).not.toContain('~/.gstack');
    expect(skill).not.toContain('~/.claude/skills/gstack/bin/gstack-slug');
    for (let step = 1; step <= 6; step++) expect(skill).toContain(`## Step ${step}:`);
    for (const project of ['partial', 'no-tools']) {
      const result = spawnSync(path.join(f.dir, 'bin', 'gstack-slug'), [], {
        cwd: path.join(f.dir, project), encoding: 'utf-8', timeout: 10_000,
        env: { ...process.env, GSTACK_HOME: f.gstackHome, GSTACK_PROJECT_SLUG: '' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`SLUG=${project}\n`);
    }
  });

  test('real checker exits nonzero and its final 50 lines hide all 60 errors', () => {
    const f = fixture();
    const result = spawnSync('bash', ['-c', 'bash ./check-typecheck.sh 2>&1'], {
      cwd: path.join(f.dir, 'partial'), encoding: 'utf-8', timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(result.stdout.match(/error TS/g)).toHaveLength(60);
    expect(result.stdout.trimEnd().split('\n').slice(-50).join('\n')).not.toContain('error TS');
    expect(fs.readFileSync(f.receipts, 'utf-8')).toBe('typecheck\n');
  });

  test('both checkers record to their fixed path without shell environment setup', () => {
    const f = fixture("health-fixture-test-' space-");
    for (const [script, status] of [['check-typecheck.sh', 2], ['check-tests.sh', 0]] as const) {
      const result = spawnSync('bash', [script], {
        cwd: path.join(f.dir, 'partial'), encoding: 'utf-8', timeout: 10_000,
      });
      expect(result.status).toBe(status);
    }
    expect(fs.readFileSync(f.receipts, 'utf-8')).toBe('typecheck\ntest\n');
  });

  test('accepts truthful reports and history, rejects absent evidence', () => {
    const f = fixture();
    expect(healthReportingFailures(f).length).toBeGreaterThan(0);
    writePassingEvidence(f);
    expect(healthReportingFailures(f)).toEqual([]);
  });

  test.each(['false-clean', 'false-clean-category', 'tail-count', 'numeric-empty', 'hidden-coverage', 'unlike-trend', 'contradictory-trend', 'extra-empty-history', 'missing-receipts', 'project-edit'])('%s is a failed behavior eval', failure => {
    const f = fixture();
    writePassingEvidence(f);
    const report = path.join(f.dir, 'partial-report.md');
    if (failure === 'false-clean') fs.writeFileSync(report, fs.readFileSync(report, 'utf-8').replace('5.6', '10'));
    if (failure === 'false-clean-category') fs.writeFileSync(report, fs.readFileSync(report, 'utf-8').replace('0/10 CRITICAL', '10/10 CLEAN'));
    if (failure === 'tail-count') fs.writeFileSync(report, fs.readFileSync(report, 'utf-8').replace('60 errors', '0 errors'));
    if (failure === 'numeric-empty') fs.writeFileSync(path.join(f.dir, 'no-tools-report.md'), 'COMPOSITE SCORE: 10 — no checks ran.');
    if (failure === 'hidden-coverage') fs.writeFileSync(report, fs.readFileSync(report, 'utf-8').replace(' — partial coverage', ''));
    if (failure === 'unlike-trend') fs.writeFileSync(report, fs.readFileSync(report, 'utf-8').replace('Coverage changed; prior test-only history is not comparable.', 'Health worsened from 10 to 5.6.'));
    if (failure === 'contradictory-trend') fs.appendFileSync(report, 'Trend: REGRESSING (-4.4 since last run)\n');
    if (failure === 'extra-empty-history') fs.appendFileSync(path.join(f.gstackHome, 'projects', 'no-tools', 'health-history.jsonl'), '{"score":10}\n');
    if (failure === 'missing-receipts') fs.rmSync(f.receipts);
    if (failure === 'project-edit') fs.appendFileSync(path.join(f.dir, 'partial', 'check-typecheck.sh'), '# attempted fix\n');
    expect(healthReportingFailures(f).length).toBeGreaterThan(0);
  });
});

describe('/health eval recording', () => {
  const success = {
    exitReason: 'success', duration: 5, output: 'report', transcript: [],
    costEstimate: { estimatedCost: 0.1, turnsUsed: 2, estimatedTokens: 100 }, model: 'fixture',
  } as SkillTestResult;

  test.each(['success', 'assertion', 'timeout', 'throw'])('%s records exactly once with matching pass status', async scenario => {
    const entries: EvalTestEntry[] = [];
    let verified = false;
    const attempt = recordHealthAttempt(
      entry => entries.push(entry),
      async () => {
        if (scenario === 'throw') throw new Error('runner failed');
        return { ...success, exitReason: scenario === 'timeout' ? 'timeout' : 'success' };
      },
      () => { verified = true; if (scenario === 'assertion') throw new Error('false dashboard'); },
    );
    if (scenario === 'success') await attempt;
    else await expect(attempt).rejects.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0].passed).toBe(scenario === 'success');
    expect(entries[0].tier).toBe('e2e');
    expect(verified).toBe(scenario === 'success' || scenario === 'assertion');
    if (scenario === 'assertion') expect(entries[0].output).toContain('false dashboard');
    if (scenario === 'timeout') expect(entries[0].exit_reason).toBe('timeout');
  });
});
