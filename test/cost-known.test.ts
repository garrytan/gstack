/**
 * cost_known (F): cost_usd stays a finite number; a trial whose harness
 * captured no billing says so, and totals never print a bare sum over
 * unknown costs. Old records without the field still read as known.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TRIAL_OUTCOME_SCHEMA, formatTrialOutcomes, parseTrialOutcomes, trialCostKnown, type TrialOutcomeRecord } from './helpers/eval-store';
import { SessionObserver } from './helpers/session-ledger';
import { runRecordedCodexEval } from './helpers/codex-eval';
import { trialRecordProblems as trialRecordProblemsV1 } from './fixtures/trial-record-v1-reader';
import { backfillEvalFiles, type Registry } from '../scripts/eval-flake-rank';
import { classifyTrialShard, formatCost, runPaidReport } from '../scripts/test-paid-shards';

const record = (over: Partial<TrialOutcomeRecord> = {}): TrialOutcomeRecord => ({
  schema: TRIAL_OUTCOME_SCHEMA, case: 'c', file: 'test/c.test.ts', tier: 'gate', kind: 'rule', trial: 1, panel: { n: 1, k: 1 }, attempt: 1,
  outcome: 'passed', duration_ms: 1, cost_usd: 0, policy_version: 1, quarantined: false, execution: 'executed', source: 'junit', ...over,
});

describe('producers', () => {
  test('a session is billed only when its terminal result carries total_cost_usd', () => {
    const billed = new SessionObserver(0);
    billed.observe({ type: 'result', subtype: 'success', total_cost_usd: 0.42 }, 1);
    const unbilled = new SessionObserver(0);
    unbilled.observe({ type: 'assistant', message: { content: [] } }, 1);
    expect([billed.billed, unbilled.billed]).toEqual([true, false]);
  });

  test('a trial is cost-known only when every record and session captured billing', () => {
    expect(trialCostKnown([{ cost_known: true }, {}], [{ billed: true }])).toEqual({});
    expect(trialCostKnown([{}], [{ billed: false }])).toEqual({ cost_known: false });
    expect(trialCostKnown([{ cost_known: false }])).toEqual({ cost_known: false });
    expect(trialCostKnown([], [{ billed: true }])).toEqual({ cost_known: false });
  });

  test('Codex records and an isolated trial without billing say cost unknown; cost_usd stays a number', async () => {
    const entries: any[] = [];
    await runRecordedCodexEval({ name: 'n', suite: 's', budgetMs: 1_000, record: entry => entries.push(entry), validate: () => {},
      run: async () => ({ output: '', stderr: '', exitCode: 0, durationMs: 5, toolCalls: [], tokens: 10, rawLines: [] } as any) });
    expect(entries[0]).toMatchObject({ cost_usd: 0, cost_known: false });
    const plan = { kind: 'behavior' as const, panel: { n: 3, k: 2 }, quarantined: false };
    const shard = { status: 'passed' as const, executedTests: 1, skippedTests: 0, elapsedMs: 5 };
    const known = classifyTrialShard(shard, 'c', 1, plan, { records: [{ passed: true, cost_usd: 0.3 }], contract: null, sessions: [] });
    const pty = classifyTrialShard(shard, 'c', 1, plan, { records: [{ passed: true, cost_usd: 0 }], contract: null,
      sessions: [{ key: 'pty:c#1', runner: 'pty', started_at: 't', elapsed_ms: 1, end: 'completed', billed: false }] });
    expect(known).toMatchObject({ cost_usd: 0.3 });
    expect(known.cost_known).toBeUndefined();
    expect(pty).toMatchObject({ cost_usd: 0, cost_known: false });
  });
});

describe('serializer and readers', () => {
  test('mixed old and new records round-trip; the frozen v1 reader accepts the new field', () => {
    const records = [record(), record({ trial: 1, case: 'd', cost_known: false }), record({ case: 'e', cost_known: true })];
    expect(parseTrialOutcomes(formatTrialOutcomes(records))).toEqual({ records, errors: [] });
    for (const r of records) expect(trialRecordProblemsV1(r)).toEqual([]);
  });

  test('history import keeps an unknown cost; an old legacy record stays known', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-known-backfill-'));
    const file = path.join(dir, '1.91.19-x-e2e-2026-10-04-1200.json');
    fs.writeFileSync(file, JSON.stringify({ tier: 'e2e', git_sha: 's', timestamp: 't', tests: [
      { name: 'old-case', passed: true, cost_usd: 1.5, duration_ms: 1 }, { name: 'new-case', passed: true, cost_usd: 0, cost_known: false, duration_ms: 1 }] }));
    const registry: Registry = { tiers: { 'old-case': 'gate', 'new-case': 'gate' }, kinds: { 'old-case': 'rule', 'new-case': 'rule' },
      touchfiles: {}, judgeTouchfiles: {}, globals: [], testNames: {} };
    const { records } = backfillEvalFiles([file], undefined, registry);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(records.find(r => r.case === 'old-case')).not.toHaveProperty('cost_known');
    expect(records.find(r => r.case === 'new-case')).toMatchObject({ cost_usd: 0, cost_known: false });
  });

  test('totals: known sum plus the unknown count; never a bare total over unknowns; no total when all are unknown', () => {
    expect(formatCost(4.2, 0, 10)).toBe('cost $4.20');
    expect(formatCost(4.2, 3, 10)).toBe('cost $4.20 known + 3 of 10 trial(s) cost unknown');
    expect(formatCost(0, 10, 10)).toBe('cost unknown (no billing captured for any of 10 trial(s))');
  });

  test('the census report headline counts trials whose cost is unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-known-report-'));
    fs.cpSync(path.join(import.meta.dir, 'fixtures', 'paid-report-census', 'gate'), dir, { recursive: true });
    const lines: string[] = [];
    const { log, error } = console;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    console.error = console.log;
    try { runPaidReport(dir, { env: {} }); } finally { console.log = log; console.error = error; }
    const history = fs.readFileSync(path.join(dir, 'trial-outcomes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    fs.rmSync(dir, { recursive: true, force: true });
    // The 2026-10-03 gate fixture holds JUnit results only: no eval record captured billing.
    expect(history.every(r => r.cost_known === false && r.cost_usd === 0)).toBe(true);
    expect(lines.join('\n')).toContain(`cost unknown (no billing captured for any of ${history.length} trial(s))`);
    expect(lines.join('\n')).not.toContain('cost $0.00');
  });
});
