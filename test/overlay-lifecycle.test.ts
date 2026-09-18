import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runOverlayCaseLifecycle } from './helpers/overlay-lifecycle';
import { runOverlayTrial, captureOverlayQueryAttempts, type OverlayTrialOutcome } from './helpers/overlay-attempt';
import { runAgentSdkTest, __resetSemaphoreForTests, type QueryProvider, type AgentSdkResult } from './helpers/agent-sdk-runner';
import { OVERLAY_FIXTURES, higherIsBetter20Pct, type OverlayFixture } from './fixtures/overlay-nudges';
import { OVERLAY_CONTRACT, OVERLAY_CASE_FILES, OVERLAY_CASE_WORK_MS, OVERLAY_RECORD_GRACE_MS, OVERLAY_CASE_OUTER_MS, OVERLAY_MIN_FILE_WALL_MS } from './helpers/overlay-case-policy';
import { isPaidTestFile } from './helpers/paid-test-set';
import { selectPaidTestFiles } from '../scripts/test-paid-shards';

const fixture: OverlayFixture = { id: 'free-lifecycle', overlayPath: 'model-overlays/opus-4-7.md', model: 'claude-opus-4-7', trials: 3, concurrency: 1, setupWorkspace: () => {}, userPrompt: 'Test', metric: () => 3, pass: higherIsBetter20Pct, comparison: { direction: 'higher_is_better', minimum: 0, maximum: 3 } };
const sample = (metric = 3): OverlayTrialOutcome => ({ passed: true, taskCorrect: metric === 3, metric, exitReason: 'success' });
const sdkResult = (): AgentSdkResult => ({ events: [{ type: 'result', subtype: 'success' }] as AgentSdkResult['events'], assistantTurns: [], toolCalls: [], output: 'done', exitReason: 'success', turnsUsed: 1, durationMs: 1, firstResponseMs: 1, maxInterTurnMs: 0, costUsd: .01, model: 'test', sdkVersion: 'test', sdkClaudeCodeVersion: 'test', resolvedBinaryPath: 'test', browseErrors: [] });

function roots() { return fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-lifecycle-free-')); }
function opts(dir: string, provider: QueryProvider, signal: AbortSignal) { return { systemPrompt: '', userPrompt: 'test', workingDirectory: dir, queryProvider: provider, signal }; }

test('every fixture owns one paid wrapper; public models/trials/concurrency/turn caps and walls are preserved', () => {
  expect(Object.values(OVERLAY_CASE_FILES).sort()).toEqual(OVERLAY_FIXTURES.map(f => f.id).sort());
  for (const [file, id] of Object.entries(OVERLAY_CASE_FILES)) {
    const source = fs.readFileSync(path.join(import.meta.dir, '..', file), 'utf8');
    expect(source).toContain(`registerOverlayCase('${id}')`);
    expect([...source.matchAll(/registerOverlayCase\('/g)]).toHaveLength(1);
    expect(isPaidTestFile(file)).toBe(true);
  }
  expect(isPaidTestFile('test/overlay-lifecycle.test.ts')).toBe(false);
  expect(OVERLAY_FIXTURES.every(f => f.trials === 10 && f.concurrency === 3)).toBe(true);
  expect(OVERLAY_FIXTURES.map(f => f.maxTurns ?? 5)).toEqual([15,8,15,15,8,15]);
  expect(OVERLAY_FIXTURES.map(f => f.model)).toEqual([...Array(3).fill('claude-opus-4-7'), ...Array(3).fill('claude-sonnet-4-6')]);
  expect([OVERLAY_CASE_WORK_MS, OVERLAY_RECORD_GRACE_MS, OVERLAY_CASE_OUTER_MS, OVERLAY_MIN_FILE_WALL_MS]).toEqual([1_800_000, 5_000, 1_810_000, 1_830_000]);
});

test('the paid file selector includes all overlay wrappers only in the periodic tier', () => {
  const files = Object.keys(OVERLAY_CASE_FILES).sort();
  const root = path.resolve(import.meta.dir, '..');
  const periodic = selectPaidTestFiles(files, 'periodic', root);
  const gate = selectPaidTestFiles(files, 'gate', root);
  expect(periodic.selected).toEqual(files);
  expect(periodic.excluded).toEqual([]);
  expect(gate.selected).toEqual([]);
  expect(gate.excluded.map(entry => entry.file)).toEqual(files);
});

test('normal attempts record all measurements then one aggregate after cleanup', async () => {
  const records: string[] = [];
  let cleaned = false;
  const result = await runOverlayCaseLifecycle({ fixture, workMs: 1000, graceMs: 30,
    execute: async arm => sample(arm === 'overlay-on' ? 3 : 2),
    recordTrial: (arm, index, outcome) => { expect(outcome.passed).toBe(true); records.push(`${arm}-${index}`); },
    recordAggregate: summary => { expect(cleaned).toBe(true); expect(summary.passed).toBe(true); records.push('aggregate'); },
    cleanup: async () => { cleaned = true; },
  });
  expect(result.startedTrials).toBe(6);
  expect(result.contract).toEqual(OVERLAY_CONTRACT);
  expect(new Set(records).size).toBe(7);
});

test('deadline records each started trial and aggregate once despite ignored abort and late completion', async () => {
  const completions: Array<(outcome: OverlayTrialOutcome) => void> = [];
  const records: string[] = [];
  let invocations = 0; let aborted = 0;
  const started = Date.now();
  const result = await runOverlayCaseLifecycle({ fixture, workMs: 20, graceMs: 15,
    execute: (_arm, _index, signal) => { invocations++; signal.addEventListener('abort', () => aborted++); return new Promise(resolve => completions.push(resolve)); },
    recordTrial: (arm, index, outcome) => { expect(outcome.exitReason).toBe('timeout'); records.push(`${arm}-${index}`); },
    recordAggregate: summary => { expect(summary.timedOut).toBe(true); records.push('aggregate'); }, cleanup: async () => {},
  });
  expect(Date.now() - started).toBeLessThan(500);
  expect(result).toMatchObject({ passed: false, timedOut: true, cleanupIncomplete: true, startedTrials: 2, plannedTrials: 6 });
  expect(aborted).toBe(2); expect(records).toHaveLength(3);
  completions.forEach(resolve => resolve(sample()));
  await Bun.sleep(10);
  expect(invocations).toBe(2); expect(records).toHaveLength(3);
});

test('an expired case starts no trials and still records its failed aggregate', async () => {
  let records = 0;
  const summary = await runOverlayCaseLifecycle({ fixture, workMs: 0, graceMs: 5, execute: async () => { throw new Error('must not start'); }, recordTrial: () => { throw new Error('must not record unstarted trial'); }, recordAggregate: () => { records++; }, cleanup: async () => {} });
  expect(summary).toMatchObject({ passed: false, timedOut: true, startedTrials: 0 }); expect(records).toBe(1);
});

test('deadline cleanup waits for aborted workers final writes within the same grace', async () => {
  const dir = roots();
  const workspaces: string[] = [];
  const records: string[] = [];
  let settled = 0;
  let settledAtCleanup = -1;
  try {
    const summary = await runOverlayCaseLifecycle({ fixture, workMs: 20, graceMs: 500,
      execute: async (arm, _index, signal) => {
        const workspace = path.join(dir, arm); workspaces.push(workspace);
        fs.mkdirSync(workspace);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        await Bun.sleep(10);
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(workspace, 'last-tool-write'), 'cancelled tool settled');
        settled++;
        return sample();
      },
      recordTrial: (arm, index, outcome) => { expect(outcome.exitReason).toBe('timeout'); records.push(`${arm}-${index}`); },
      recordAggregate: () => records.push('aggregate'),
      cleanup: async () => {
        settledAtCleanup = settled;
        await Promise.all(workspaces.map(workspace => fs.promises.rm(workspace, { recursive: true, force: true })));
      },
    });
    expect(summary).toMatchObject({ passed: false, timedOut: true, cleanupIncomplete: false, startedTrials: 2 });
    expect(summary.errors).toEqual([]);
    expect(settledAtCleanup).toBe(2);
    expect(workspaces.every(workspace => !fs.existsSync(workspace))).toBe(true);
    expect(records).toHaveLength(3);
    expect(new Set(records).size).toBe(3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workers that outlive grace cannot start cleanup after the aggregate', async () => {
  const completions: Array<(outcome: OverlayTrialOutcome) => void> = [];
  let cleanups = 0; let records = 0;
  const summary = await runOverlayCaseLifecycle({ fixture, workMs: 10, graceMs: 10,
    execute: () => new Promise(resolve => completions.push(resolve)),
    recordTrial: () => { records++; }, recordAggregate: () => { records++; },
    cleanup: async () => { cleanups++; },
  });
  expect(summary).toMatchObject({ passed: false, timedOut: true, cleanupIncomplete: true });
  expect(cleanups).toBe(0);
  completions.forEach(resolve => resolve(sample()));
  await Bun.sleep(10);
  expect(cleanups).toBe(0);
  expect(records).toBe(3);
});

test('cleanup errors after worker settlement retain their cause and fail the aggregate', async () => {
  const summary = await runOverlayCaseLifecycle({ fixture, workMs: 1000, graceMs: 100,
    execute: async arm => sample(arm === 'overlay-on' ? 3 : 2),
    recordTrial: () => {}, recordAggregate: () => {},
    cleanup: async () => { throw new Error('owned cleanup cause'); },
  });
  expect(summary).toMatchObject({ passed: false, timedOut: false, cleanupIncomplete: true });
  expect(summary.errors).toEqual(['cleanup failed: owned cleanup cause']);
});

test('late SDK completion cannot run metric/assertion/snapshot validation', async () => {
  const dir = roots();
  const completions: Array<(result: AgentSdkResult) => void> = [];
  let metrics = 0; let validations = 0; let records = 0;
  try {
    await runOverlayCaseLifecycle({ fixture, workMs: 15, graceMs: 5,
      execute: (_arm, _index, _signal, active, deadlineAt) => runOverlayTrial({ fixture: { ...fixture, metric: () => { metrics++; return 3; }, verify: () => { validations++; } }, directory: dir, isActive: active, deadlineAt, invoke: () => new Promise(resolve => completions.push(resolve)), record: () => {} }),
      recordTrial: () => { records++; }, recordAggregate: () => { records++; }, cleanup: async () => {},
    });
    completions.forEach(resolve => resolve(sdkResult())); await Bun.sleep(10);
    expect(metrics).toBe(0); expect(validations).toBe(0); expect(records).toBe(3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('partial completion remains visible and never becomes a partial-arm pass', async () => {
  const recorded: OverlayTrialOutcome[] = [];
  const summary = await runOverlayCaseLifecycle({ fixture, workMs: 20, graceMs: 5,
    execute: async (arm, index, signal) => { if (index === 0) return sample(arm === 'overlay-on' ? 3 : 2); await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); return sample(); },
    recordTrial: (_arm, _index, outcome) => recorded.push(outcome), recordAggregate: () => {}, cleanup: async () => {},
  });
  expect(summary).toMatchObject({ passed: false, timedOut: true, startedTrials: 4 });
  expect(recorded.filter(outcome => outcome.passed)).toHaveLength(2);
  expect(recorded.filter(outcome => outcome.exitReason === 'timeout')).toHaveLength(2);
});

test('cleanup that ignores the grace does not hang or produce a later aggregate', async () => {
  let aggregates = 0;
  const started = Date.now();
  const summary = await runOverlayCaseLifecycle({ fixture, workMs: 1000, graceMs: 10, execute: async arm => sample(arm === 'overlay-on' ? 3 : 2), recordTrial: () => {}, recordAggregate: () => { aggregates++; }, cleanup: () => new Promise(() => {}) });
  expect(Date.now() - started).toBeLessThan(500); expect(summary.cleanupIncomplete).toBe(true); expect(summary.passed).toBe(false); expect(aggregates).toBe(1);
});

test('recording failures are explicit and never reattempt a trial record', async () => {
  let trials = 0; let aggregates = 0;
  const summary = await runOverlayCaseLifecycle({ fixture, workMs: 1000, graceMs: 10, execute: async arm => sample(arm === 'overlay-on' ? 3 : 2), recordTrial: () => { trials++; throw new Error('disk failed'); }, recordAggregate: () => { aggregates++; }, cleanup: async () => {} });
  expect(summary.passed).toBe(false); expect(summary.errors).toHaveLength(6); expect(trials).toBe(6); expect(aggregates).toBe(1);
});

test('SDK abort closes a fake executable and retains its native partial stream', async () => {
  const dir = roots(); const controller = new AbortController(); let closed = 0; let child: ReturnType<typeof Bun.spawn> | undefined;
  const provider = (() => {
    child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const stream = (async function* () {
      yield { type: 'assistant', message: { id: 'A', content: [{ type: 'text', text: 'started' }] } };
      await child!.exited;
    })();
    Object.assign(stream, { close: () => { closed++; child!.kill('SIGKILL'); } });
    return stream;
  }) as unknown as QueryProvider;
  try {
    const running = runAgentSdkTest(opts(dir, captureOverlayQueryAttempts(dir, 'fake-executable', provider), controller.signal));
    await Bun.sleep(20); controller.abort(new Error('case deadline'));
    await expect(running).rejects.toThrow('case deadline');
    await child!.exited;
    expect(closed).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'fake-executable-sdk-attempt-1.jsonl'), 'utf8')).toContain('started');
    expect(fs.existsSync(path.join(dir, 'fake-executable-sdk-attempt-1.json'))).toBe(true);
  } finally { child?.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SDK abort interrupts rate-limit backoff without reset or another paid attempt', async () => {
  const dir = roots(); const controller = new AbortController(); let calls = 0; let resets = 0;
  const provider = (() => { calls++; return (async function* () { throw Object.assign(new Error('429 limited'), { status: 429 }); })(); }) as unknown as QueryProvider;
  try {
    const started = Date.now();
    const running = runAgentSdkTest({ ...opts(dir, provider, controller.signal), onRetry: () => { resets++; } });
    await Bun.sleep(20); controller.abort(new Error('stop backoff'));
    await expect(running).rejects.toThrow('stop backoff');
    expect(Date.now() - started).toBeLessThan(500); expect(calls).toBe(1); expect(resets).toBe(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('queued SDK cancellations never invoke a provider or strand semaphore permits', async () => {
  __resetSemaphoreForTests(3);
  const dir = roots(); const controllers = Array.from({ length: 5 }, () => new AbortController());
  let calls = 0;
  const provider = (({ options }) => {
    calls++;
    return (async function* () { await new Promise<void>((_, reject) => options!.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted')))); })();
  }) as QueryProvider;
  try {
    const running = controllers.map(controller => runAgentSdkTest(opts(dir, provider, controller.signal)).catch(error => error));
    await Bun.sleep(10); expect(calls).toBe(3);
    controllers[3].abort(new Error('queued')); controllers[4].abort(new Error('queued'));
    await Promise.all(running.slice(3)); expect(calls).toBe(3);
    controllers.slice(0,3).forEach(controller => controller.abort(new Error('active')));
    await Promise.all(running);
    const successful = (() => (async function* () { yield { type: 'result', subtype: 'success', num_turns: 0, total_cost_usd: 0 }; })()) as unknown as QueryProvider;
    expect((await runAgentSdkTest(opts(dir, successful, new AbortController().signal))).exitReason).toBe('success');
  } finally { controllers.forEach(controller => controller.abort()); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an already-aborted SDK call never acquires work or invokes the provider', async () => {
  const dir = roots(); const controller = new AbortController(); controller.abort(new Error('already canceled'));
  let calls = 0;
  try {
    const provider = (() => { calls++; throw new Error('must not invoke'); }) as QueryProvider;
    await expect(runAgentSdkTest(opts(dir, provider, controller.signal))).rejects.toThrow('already canceled');
    expect(calls).toBe(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancellation during synchronous query construction still closes the returned query', async () => {
  const dir = roots(); const controller = new AbortController(); let closed = 0;
  const provider = (() => {
    controller.abort(new Error('startup canceled'));
    const stream = (async function* () {})();
    Object.assign(stream, { close: () => { closed++; } });
    return stream;
  }) as unknown as QueryProvider;
  try {
    await expect(runAgentSdkTest(opts(dir, provider, controller.signal))).rejects.toThrow('startup canceled');
    expect(closed).toBe(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
