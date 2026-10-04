/**
 * Cancellation recovery (W1c: CEO-14/25/34, ENG-4/5/8), driven from recorded
 * gh responses: no network, no API spend.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectRecovery, ghFailureReason, readCheckpoint, recoveryDecision, storeRunId,
  type GhRunner, type WorkflowRun,
} from '../scripts/recover-receipts';
import { selectPlanReceipts, writeNegativeReceipt, writePanelReceipt } from '../scripts/e2e-shard-reuse';
import { buildRunManifest, type SliceResult } from '../scripts/test-paid-shards';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-receipts-'));
const REPO = 'garrytan/gstack';
const SHA = 'd'.repeat(40);
const scope = { repo: REPO, pr: 42, headRepo: REPO, branch: 'feature' };
const run = (id: number, status: string, conclusion: string | null, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id, status, conclusion, event: 'pull_request', head_sha: SHA, run_attempt: 1, updated_at: '2026-10-04T00:00:00Z',
  head_repository: { full_name: REPO }, pull_requests: [{ number: 42 }], ...over,
});
const passReceipt = (dir: string, key: string, completedAt: number) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ schema: 1, proof: { source: { runId: '100/1', revision: SHA, completedAt } } }));
};

/** A scripted gh: run list, per-run polls, artifact lists, and downloads that copy fixture trees. */
function fakeGh(state: { runs: WorkflowRun[]; artifacts?: Record<number, Record<string, (dir: string) => void>>; failList?: string }): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const respond: GhRunner = (args: string[]) => {
    calls.push(args);
    const ok = (body: unknown) => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args[0] === 'api' && args.some(a => a.endsWith('/workflows/evals.yml/runs'))) {
      return state.failList ? { status: 1, stdout: '', stderr: state.failList } : ok({ workflow_runs: state.runs });
    }
    const artifactsOf = args.find(a => /\/runs\/\d+\/artifacts$/.test(a));
    if (artifactsOf) {
      const id = Number(/runs\/(\d+)\//.exec(artifactsOf)![1]);
      return ok({ artifacts: Object.keys(state.artifacts?.[id] ?? {}).map(name => ({ name, expired: false })) });
    }
    const polled = args.find(a => /\/runs\/\d+$/.test(a));
    if (polled) return ok(state.runs.find(r => r.id === Number(/(\d+)$/.exec(polled)![1])));
    if (args[0] === 'run' && args[1] === 'download') {
      const id = Number(args[2]);
      const names = args.flatMap((a, i) => args[i - 1] === '-n' ? [a] : []);
      const dest = args[args.indexOf('-D') + 1]!;
      for (const name of names) state.artifacts![id]![name]!(names.length === 1 ? dest : path.join(dest, name));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return Object.assign(respond, { calls });
}
const clock = (start = 1_000_000) => { let t = start; return { now: () => t, sleep: (ms: number) => { t += ms; } }; };
const collect = (store: string, gh: GhRunner, over: Partial<Parameters<typeof collectRecovery>[0]> = {}) =>
  collectRecovery({ ...scope, store, selfRunId: 500, gh, budgetMs: 60_000, pollMs: 5_000, ...clock(), ...over });

describe('receipt recovery checkpoint (ENG-4)', () => {
  test('A stores PASS -> B fails and is still cancelling -> C skips B -> D reconciles B and blocks the PASS', () => {
    const key = 'a'.repeat(64);
    const store = path.join(scratch, 'eng4-store');
    passReceipt(store, key, 1_000);
    const runB = run(300, 'in_progress', null);
    // C: B never completes inside the budget.
    const c = collect(store, fakeGh({ runs: [run(400, 'in_progress', null), runB] }), { selfRunId: 400, storeKey: 'eval-input-v1-1-pr-42-200-1-merged' });
    expect(c.checkpoint.unresolved.map(u => u.runId)).toEqual(['300']);
    expect(recoveryDecision(store)).toMatchObject({ reuse: false });
    expect(recoveryDecision(store).reason).toContain('300');
    // C's report saved a newer store; B finished cancelling with a completed FAIL in its slice receipts.
    const d = collect(store, fakeGh({
      runs: [run(500, 'in_progress', null), run(400, 'completed', 'success'), run(300, 'completed', 'cancelled')],
      artifacts: { 300: { 'paid-slice-1-a1': dir => writeNegativeReceipt(path.join(dir, 'receipts'), { schema: 1, key, source: { runId: '300/1', revision: SHA, completedAt: 2_000 } }) } },
    }), { storeKey: 'eval-input-v1-1-pr-42-400-1-merged' });
    expect(d.checkpoint.unresolved).toEqual([]);
    expect(d.checkpoint.processed).toEqual(['300']);
    expect(recoveryDecision(store).reuse).toBe(true);
    expect(selectPlanReceipts(store, path.join(scratch, 'eng4-plan')).blocked).toEqual([`${key}.json`]);
  });

  test('a processed run is never downloaded again and runs older than the restored store are skipped', () => {
    const store = path.join(scratch, 'processed-store');
    const gh = fakeGh({ runs: [run(300, 'completed', 'cancelled'), run(150, 'completed', 'cancelled')],
      artifacts: { 300: { 'paid-slice-1-a1': dir => fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true }) } } });
    collect(store, gh, { storeKey: 'eval-input-v1-1-pr-42-200-1-merged' });
    expect(gh.calls.filter(c => c[0] === 'run').map(c => c[2])).toEqual(['300']);
    const again = fakeGh({ runs: [run(300, 'completed', 'cancelled')] });
    expect(collect(store, again, { storeKey: 'eval-input-v1-1-pr-42-200-1-merged' }).lines).toContain('no cancelled runs to recover');
    expect(again.calls.filter(c => c[0] === 'run')).toEqual([]);
    expect(storeRunId('eval-input-v1-9-pr-42-37199589136-2-merged')).toBe(37199589136);
    expect(storeRunId('')).toBe(0);
  });
});

describe('panel negatives from a cancelled run (ENG-5)', () => {
  // Gate has no behavior panels today; the periodic plan supplies a real one.
  const manifest = buildRunManifest({ tier: 'periodic', sliceCount: 3, evalsAll: true, env: { EVALS_ALL: '1' } });
  const trials = manifest.entries.filter(entry => entry.status === 'planned' && entry.trial);
  const panelKey = trials[0]!.file.replace(/~t\d+$/, '');
  const panelTrials = trials.filter(entry => entry.file.startsWith(`${panelKey}~t`));
  const plan = panelTrials[0]!.trial!;
  const inputKey = 'b'.repeat(64);
  const slices = (outcome: 'passed' | 'failed', count: number): Record<string, (dir: string) => void> => ({
    'paid-plan': dir => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); },
    ...Object.fromEntries(panelTrials.slice(0, count).map((entry, i) => [`paid-slice-${i + 1}-a1`, (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      const result: SliceResult = { version: 1, tier: 'periodic', sliceIndex: i + 1, sliceCount: 3, attempt: 1, finishedAt: Date.now(), outcomes: [{
        files: [entry.file], status: outcome, exitCode: outcome === 'passed' ? 0 : 1, elapsedMs: 1, executedTests: 1, skippedTests: 0, inputKey,
        trial: { case: panelKey.split('#')[1]!, trial: i + 1, kind: plan.kind, panel: plan.panel, quarantined: plan.quarantined,
          outcome, ...(outcome === 'failed' ? { failure_class: 'assertion' as const } : {}), cost_usd: 0, duration_ms: 1 } as never,
      }] };
      fs.writeFileSync(path.join(dir, `slice-${i + 1}.json`), JSON.stringify(result));
    }])),
  });

  test('a completed failing panel publishes its negative, so an older whole PASS panel is not reused', () => {
    expect(panelTrials.length).toBe(plan.panel.n);
    const store = path.join(scratch, 'eng5-store');
    writePanelReceipt(store, { schema: 1, key: inputKey, case: panelKey.split('#')[1]!, kind: plan.kind, panel: plan.panel,
      source: { runId: '100/1', revision: SHA, completedAt: Date.now() - 60_000 },
      trials: Array.from({ length: plan.panel.n }, (_, i) => ({ trial: i + 1, outcome: 'passed' as const })) });
    collect(store, fakeGh({ runs: [run(300, 'completed', 'cancelled')], artifacts: { 300: slices('failed', plan.panel.n) } }));
    expect(fs.existsSync(path.join(store, `${inputKey}.fail.json`))).toBe(true);
    expect(selectPlanReceipts(store, path.join(scratch, 'eng5-plan')).blocked).toEqual([`${inputKey}.panel.json`]);
  });

  test('a partial panel publishes nothing and gets no pass credit', () => {
    const store = path.join(scratch, 'eng5-partial');
    collect(store, fakeGh({ runs: [run(300, 'completed', 'cancelled')], artifacts: { 300: slices('passed', plan.panel.n - 1) } }));
    expect(fs.readdirSync(store).filter(name => name !== 'recovery.json')).toEqual([]);
  });
});

describe('recovery never fails the run (CEO-34)', () => {
  test('a rate limit degrades to no recovered receipts with the reset time; reuse stays off', () => {
    const store = path.join(scratch, 'rate-limit');
    const result = collect(store, fakeGh({ runs: [], failList: 'gh: API rate limit exceeded for installation. reset 1791100000 (HTTP 403)' }));
    expect(result.checkpoint.degraded).toContain('GitHub API rate limit (resets at 2026-');
    expect(result.lines[0]).toContain('executes unreduced');
    expect(recoveryDecision(store)).toMatchObject({ reuse: false });
    expect(recoveryDecision(store).reason).toContain('rerun the job after the reset');
  });

  test('a foreign head repository is rejected and never downloaded', () => {
    const store = path.join(scratch, 'foreign');
    const gh = fakeGh({ runs: [run(300, 'completed', 'cancelled', { head_repository: { full_name: 'fork/gstack' } })] });
    const result = collect(store, gh);
    expect(result.lines).toContain('rejected run 300: head repository fork/gstack is not garrytan/gstack');
    expect(gh.calls.some(c => c[0] === 'run')).toBe(false);
    expect(recoveryDecision(store).reuse).toBe(true);
  });

  test('another PR, another event and this run itself are ignored', () => {
    const gh = fakeGh({ runs: [run(300, 'completed', 'cancelled', { pull_requests: [{ number: 7 }] }),
      run(301, 'completed', 'cancelled', { event: 'workflow_dispatch' }), run(500, 'in_progress', null)] });
    expect(collect(path.join(scratch, 'ignored'), gh).checkpoint).toMatchObject({ unresolved: [], recovered: 0 });
    expect(gh.calls.length).toBe(1);
  });

  test('an exhausted download budget leaves the run unresolved instead of advancing past it', () => {
    const store = path.join(scratch, 'budget');
    const time = clock();
    const gh = fakeGh({ runs: [run(300, 'completed', 'cancelled')], artifacts: { 300: { 'paid-slice-1-a1': () => {} } } });
    const slow: GhRunner = (args, timeoutMs) => { if (args[0] === 'api' && args.some(a => a.endsWith('/artifacts'))) time.sleep(61_000); return gh(args, timeoutMs); };
    const result = collect(store, slow, time);
    expect(result.checkpoint.unresolved).toEqual([{ runId: '300', reason: 'the 60 s download budget ran out' }]);
    expect(result.checkpoint.processed).not.toContain('300');
  });

  test('a missing checkpoint (recovery job absent or failed) turns reuse off with its reason', () => {
    const store = path.join(scratch, 'no-checkpoint');
    fs.mkdirSync(store, { recursive: true });
    expect(recoveryDecision(store)).toEqual({ reuse: false, reason: expect.stringContaining('receipt recovery unavailable') });
    expect(readCheckpoint(store)).toBeNull();
  });

  test('every gh failure names its next step', () => {
    expect(ghFailureReason('HTTP 401: Bad credentials')).toContain('gh auth status');
    expect(ghFailureReason('spawnSync gh ETIMEDOUT')).toContain('rerun the job');
    expect(ghFailureReason('HTTP 502 bad gateway')).toContain('gh failed: HTTP 502');
  });
});

describe('dispatch reads PR receipts read-only (ENG-8)', () => {
  test('completed runs of the PR are merged from their artifacts, never from the cache', () => {
    const store = path.join(scratch, 'dispatch');
    const key = 'c'.repeat(64);
    const gh = fakeGh({ runs: [run(300, 'completed', 'success'), run(310, 'in_progress', null)], artifacts: { 300: {
      'paid-plan': dir => passReceipt(path.join(dir, 'store'), key, Date.now() - 1_000),
      'report-verdict-a1': dir => fs.mkdirSync(path.join(dir, 'paid-report', 'report-receipts'), { recursive: true }),
    } } });
    const result = collect(store, gh, { mode: 'dispatch', selfRunId: 900 });
    expect(result.checkpoint.mode).toBe('dispatch');
    expect(fs.existsSync(path.join(store, `${key}.json`))).toBe(true);
    expect(gh.calls.filter(c => c[0] === 'run').map(c => c[2])).toEqual(['300']);
  });
});
