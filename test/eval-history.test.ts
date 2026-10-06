/**
 * eval:pass-rates report views (plan 0.1): session headroom, the verdict red
 * ledger with the all-green probability, one census's triage view, and the
 * CLI contract (offline --help, unknown flag and case rejected before any
 * fetch, --case applied to JSON and alarms, the 85% alarm in --gate).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TRIAL_OUTCOME_SCHEMA, formatTrialOutcomes, type TrialOutcomeRecord } from './helpers/eval-store';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';
import { HEADROOM_FAIL } from './helpers/eval-budgets';
import { criticalPath, formatHeadroom, formatRedLedger, headroom, headroomAlarms, parsePassRatesArgs, redLedger, triageRun,
  verdictsOf, HEADROOM_MIN_SAMPLES, RED_RATE_SHRINK } from '../scripts/lib/eval-history';
import type { HistoryFetcher } from '../scripts/eval-flake-rank';

const SCRIPT = path.resolve(import.meta.dir, '../scripts/eval-flake-rank.ts');

const rec = (over: Partial<TrialOutcomeRecord>): TrialOutcomeRecord => ({
  schema: TRIAL_OUTCOME_SCHEMA, case: 'rule-a', file: 'test/a.test.ts', tier: 'gate', kind: 'rule', trial: 1, panel: { n: 1, k: 1 },
  attempt: 1, outcome: 'passed', duration_ms: 1000, cost_usd: 0, policy_version: EVAL_POLICY.version, quarantined: false,
  execution: 'executed', source: 'junit', run_id: '1', lane: 'gate/full census', ...over,
});
const session = (elapsed: number, budget = 100_000, end = 'completed') => ({ key: 'pty:x#1', runner: 'pty', elapsed_ms: elapsed, budget_ms: budget, end });

describe('headroom', () => {
  const records = [
    ...[1, 2, 3].map(run => rec({ case: 'slow', run_id: String(run), duration_ms: 95_000, sessions: [session(run === 3 ? 88_000 : 60_000)] })),
    ...[1, 2, 3].map(run => rec({ case: 'fine', run_id: String(run), sessions: [session(70_000), { ...session(10_000), key: 'claude-p:y#1' }] })),
    ...[1, 2].map(run => rec({ case: 'rare', run_id: String(run), sessions: [session(99_000)] })),
    rec({ case: 'legacy', duration_ms: 517_000 }),
    rec({ case: 'timedout', run_id: '1', outcome: 'failed', failure_class: 'timeout', sessions: [session(100_050, 100_000, 'session_timeout')] }),
    rec({ case: 'timedout', run_id: '2', sessions: [session(50_000)] }), rec({ case: 'timedout', run_id: '3', sessions: [session(50_000)] }),
    rec({ case: 'skipped-only', outcome: 'skipped', sessions: [session(99_000)] }),
  ];
  const cases = headroom(records);
  const byCase = Object.fromEntries(cases.map(c => [c.case, c]));

  test('88% alarms, 70% passes, too few samples is insufficient, a timeout is censored, no ledger is unknown, skipped never counts', () => {
    expect(byCase.slow).toMatchObject({ status: 'over', worst: { key: 'pty:x#1', samples: 3, maxRatio: 0.88, censored: 0 } });
    expect(byCase.fine).toMatchObject({ status: 'ok', worst: { maxRatio: 0.7 } });
    expect(byCase.rare!.status).toBe('insufficient');
    expect(HEADROOM_MIN_SAMPLES).toBe(3);
    expect(byCase.timedout).toMatchObject({ status: 'over', worst: { censored: 1, samples: 3 } });
    expect(byCase.legacy).toMatchObject({ status: 'unknown', caseWallMs: 517_000 });
    expect(byCase['skipped-only']).toBeUndefined();
    expect(headroomAlarms(cases).map(a => a.case).sort()).toEqual(['slow', 'timedout']);
    expect(headroomAlarms(cases)[0]!.message).toContain(`above the ${HEADROOM_FAIL * 100}% cap`);
  });

  test('the session column and the case wall column are labelled differently; unknown sessions are never scored', () => {
    const lines = formatHeadroom(cases);
    expect(lines[1]).toContain('session max/budget');
    expect(lines[1]).toContain('case wall (upper bound, not a session clock)');
    expect(lines.find(l => l.endsWith('legacy'))).toMatch(/^ {2}unknown\s+unknown \(no session ledger\)\s+-\s+517s/);
  });

  test('critical path is the slowest slice job; non-slice jobs only bound the run wall', () => {
    const job = (name: string, start: number, end: number) => ({ name, startedAt: new Date(start * 1000).toISOString(), completedAt: new Date(end * 1000).toISOString() });
    const cp = criticalPath('9', [job('build-image', 0, 60), job('eval-slices (1)', 60, 400), job('gate-census (11)', 70, 781), job('report', 781, 840)],
      { entries: [{ file: 'test/skill-e2e-plan-mode-no-op.test.ts', slice: 11, status: 'planned' }, { file: 'x', slice: 2, status: 'planned' }] });
    expect(cp).toEqual({ run: '9', jobs: 2, slowest: { name: 'gate-census (11)', ms: 711_000 }, wallMs: 840_000, files: ['test/skill-e2e-plan-mode-no-op.test.ts'] });
  });
});

describe('red ledger over the 8 wave censuses', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'eval-history', 'wave-reds-8-censuses.json'), 'utf8'));
  // Every other verdict of each census lane, as a passing rule case (same ids across censuses).
  const passing = fixture.censuses.flatMap((c: any) => Array.from({ length: c.otherVerdicts }, (_, i) =>
    rec({ run_id: c.run, lane: c.lane, case: `green-${c.lane}-${i}`, file: `test/green-${i}.test.ts` })));
  const records: TrialOutcomeRecord[] = [...fixture.records, ...passing];
  const ledger = redLedger(records);

  test('21 verdict reds across 8 censuses; 27 of 28 failed trials are class assertion; red trials carry no recorded cause', () => {
    expect(new Set(ledger.censuses.map(c => c.run)).size).toBe(8);
    expect(ledger.pooled.reds).toBe(21);
    const failed = records.filter(r => r.outcome === 'failed');
    expect(failed).toHaveLength(28);
    expect(failed.filter(r => r.failure_class === 'assertion')).toHaveLength(27);
    // 22 failed trials sit in red verdicts; the other 6 are the failed trials of split PASS panels.
    expect(ledger.censuses.reduce((sum, c) => sum + (c.byCause.unrecorded ?? 0), 0)).toBe(22);
    expect(ledger.censuses.map(c => c.reds.length).reduce((a, b) => a + b, 0)).toBe(21);
  });

  test('the all-green probability follows its documented formula and sits inside its interval', () => {
    const latest = verdictsOf(records).filter(v => v.run === '37198445662');
    const rate = ledger.pooled.reds / ledger.pooled.verdicts;
    const expected = latest.reduce((p, v) => {
      const mine = verdictsOf(records).filter(x => x.case === v.case);
      return p * (1 - (mine.filter(x => x.failsLane).length + RED_RATE_SHRINK * rate) / (mine.length + RED_RATE_SHRINK));
    }, 1);
    expect(ledger.allGreen!.p).toBeCloseTo(expected, 12);
    expect(ledger.allGreen!.verdicts).toBe(latest.length);
    expect(ledger.allGreen!.lo).toBeLessThan(ledger.allGreen!.p);
    expect(ledger.allGreen!.hi).toBeGreaterThan(ledger.allGreen!.p);
    const text = formatRedLedger(ledger).join('\n');
    expect(text).toContain('all-green probability (approximation, assumes independent verdicts)');
    expect(text).toContain('rerun: bun run eval:pass-rates --reds');
    expect(text).toContain('37186854666 gate/full census: 1 red of');
    expect(text).toContain('class: timeout 1; cause: unrecorded 1');
    expect(formatRedLedger(ledger).at(-1)).toBe('guide: docs/evals/census-red.md');
  });

  test('new records group reds by machine cause', () => {
    const l = redLedger([rec({ outcome: 'failed', failure_class: 'assertion', failure_cause: 'refusal' }), rec({ case: 'b' })]);
    expect(l.censuses[0]).toMatchObject({ byClass: { assertion: 1 }, byCause: { refusal: 1 } });
  });
});

describe('triageRun (stub fetcher, no network)', () => {
  test('downloads only the slice a red names, reports an oversize slice, and shows values and history', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const downloaded: string[] = [];
    const fetcher: HistoryFetcher = {
      listRuns: () => [], downloadZip: () => { throw new Error('unused'); },
      listArtifacts: () => [{ id: 1, name: 'paid-plan', size: 100 }, { id: 2, name: 'paid-slice-5-a1', size: 10 }, { id: 3, name: 'paid-slice-7-a1', size: 70 * 1024 * 1024 },
        { id: 4, name: 'paid-slice-9-a1', size: 10 }],
    };
    const download = (match: (name: string) => boolean) => {
      const names = ['paid-plan', 'paid-slice-5-a1', 'paid-slice-7-a1', 'paid-slice-9-a1'].filter(match);
      downloaded.push(...names);
      return names.map(name => {
        const dir = path.join(cacheDir, name);
        fs.mkdirSync(dir, { recursive: true });
        if (name === 'paid-plan') fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ entries: [
          { file: 'test/skill-llm-eval.test.ts', slice: 5, status: 'planned' }, { file: 'test/big.test.ts', slice: 7, status: 'planned' },
          { file: 'test/green.test.ts', slice: 9, status: 'planned' }] }));
        return dir;
      });
    };
    const lane = 'periodic/full census';
    const records = [
      rec({ run_id: '42', lane, case: 'qa-only/SKILL.md workflow', file: 'test/skill-llm-eval.test.ts', kind: 'judge', outcome: 'failed', failure_class: 'assertion',
        failure_cause: 'assertion', error: 'expect(received).toBeGreaterThanOrEqual(expected)',
        failure_detail: { judge: [{ dimension: 'clarity', mean: 3.67, threshold: 4, samples: 3, rationale: 'Clarity suffers from density.' }] } }),
      rec({ run_id: '41', lane, case: 'qa-only/SKILL.md workflow', file: 'test/skill-llm-eval.test.ts', kind: 'judge' }),
      rec({ run_id: '42', lane, case: 'big-case', file: 'test/big.test.ts', outcome: 'failed', failure_class: 'timeout' }),
      rec({ run_id: '42', lane, case: 'green', file: 'test/green.test.ts' }),
    ];
    const lines = triageRun({ repo: 'o/r', run: { id: 42, attempt: 1, sha: 'abcdef1234567', branch: 'b', createdAt: 't' }, records, cacheDir, fetcher, download });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    expect(downloaded).toEqual(['paid-plan', 'paid-slice-5-a1']);
    expect(lines[0]).toContain('run 42 (b @ abcdef123, t): 2 verdict red(s)');
    expect(lines).toContain('✗ qa-only/SKILL.md workflow  periodic/full census  FAIL  (history: 1/2 verdicts green)');
    expect(lines.join('\n')).toContain('t1: assertion / cause assertion — expect(received).toBeGreaterThanOrEqual(expected)  clarity 3.67 < 4 (3 samples) "Clarity suffers from density."');
    expect(lines.join('\n')).toContain(`evidence: ${path.join(cacheDir, 'paid-slice-5-a1', 'shards', 'skill-llm-eval')}`);
    expect(lines).toContain('    evidence: paid-slice-7-a1 too large to fetch (70 MB)');
  });
});

describe('eval:pass-rates CLI contract', () => {
  function withFakeGh(run: (env: NodeJS.ProcessEnv, called: () => boolean, dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passrates-gh-'));
    const marker = path.join(dir, 'gh-called');
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    try {
      run({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GSTACK_STATE_ROOT: path.join(dir, 'state') }, () => fs.existsSync(marker), dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const cli = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, env });

  test('--help is offline; an unknown flag or case exits 2 before any fetch', () => {
    withFakeGh((env, called) => {
      const help = cli(['--help'], env);
      expect(help.status).toBe(0);
      for (const flag of ['--headroom', '--reds', '--run <id>', '--case <id>', '--gate', '--help']) expect(help.stdout).toContain(flag);
      for (const args of [['--bogus'], ['--case', 'no-such-case'], ['--runs', '0'], ['--headroom', '--reds'], ['--run']]) {
        const r = cli(args, env);
        expect(r.status, args.join(' ')).toBe(2);
        expect(r.stderr).toContain('Usage: bun run eval:pass-rates');
      }
      expect(called()).toBe(false);
    });
  });

  test('--case narrows the JSON and the alarms; --gate alarms above 85% of a session budget; scope is printed', () => {
    withFakeGh((env, called, dir) => {
      const drift = (id: string) => Array.from({ length: 12 }, (_, i) => rec({ case: id, kind: 'behavior', tier: 'periodic', panel: { n: 3, k: 2 },
        trial: (i % 3) + 1, run_id: String(Math.floor(i / 3)), outcome: i < 11 ? 'passed' : 'failed', ...(i < 11 ? {} : { failure_class: 'assertion' as const }) }));
      const slow = [1, 2, 3].map(run => rec({ case: 'plan-mode-no-op', run_id: String(run), sessions: [session(run === 1 ? 88_000 : 50_000)] }));
      fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), formatTrialOutcomes([...drift('plan-ceo-review-format-mode'), ...drift('plan-review-prosons-neutral-neg'), ...slow]));
      const json = cli(['--dir', dir, '--json', '--case', 'plan-review-prosons-neutral-neg'], env);
      expect(json.status, json.stderr).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.scope).toBe(`local dirs ${dir}`);
      expect(parsed.cases.map((c: any) => c.case)).toEqual(['plan-review-prosons-neutral-neg']);
      expect(parsed.alarms.map((a: any) => a.case)).toEqual(['plan-review-prosons-neutral-neg']);
      const gate = cli(['--dir', dir, '--gate', '--case', 'plan-mode-no-op'], env);
      expect(gate.status).toBe(1);
      expect(gate.stdout).toContain(`scope: local dirs ${dir}`);
      expect(gate.stdout).toContain('[headroom] plan-mode-no-op session pty:x#1: max 88s of 100s (88%)');
      expect(gate.stdout).not.toContain('[drift]');
      const plain = cli(['--dir', dir, '--case', 'plan-mode-no-op'], env);
      expect(plain.status).toBe(0);
      expect(plain.stdout).not.toContain('[headroom]');
      expect(cli(['--dir', dir, '--headroom'], env).stdout).toContain('over          88% 88s/100s');
      expect(called()).toBe(false);
    });
  });

  test('flag parsing', () => {
    const known = (id: string) => id === 'a';
    expect(parsePassRatesArgs(['--run', '37198445662', '--case', 'a'], known)).toMatchObject({ view: 'run', runId: 37198445662, caseFilter: 'a' });
    expect(parsePassRatesArgs(['--run', '1', '--dir', 'x'], known)).toEqual({ error: '--run reads one GitHub run; it cannot combine with --dir' });
    expect(parsePassRatesArgs(['-h'], known)).toEqual({ help: true });
  });
});
