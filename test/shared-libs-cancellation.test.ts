import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { __resetSemaphoreForTests, runAgentSdkTest, passThroughNonAskUserQuestion } from './helpers/agent-sdk-runner';
import { createSharedInteractiveToolHandler } from './helpers/shared-libs-eval-fixture';
import { SESSION_DRAIN_GRACE_MS } from './helpers/session-drain-policy';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, GLOBAL_TOUCHFILES, selectTests } from './helpers/touchfiles';

const source = fs.readFileSync(path.join(import.meta.dir, 'helpers/shared-libs-eval-fixture.ts'), 'utf8');
const native = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs.test.ts'), 'utf8');
const transpile = (text: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(text);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
afterEach(() => __resetSemaphoreForTests(3));

test('shared drain policy retains global selection', () => {
  for (const table of [E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES]) {
    expect(selectTests(['test/helpers/session-drain-policy.ts'], table, GLOBAL_TOUCHFILES).selected.sort())
      .toEqual(selectTests(['test/helpers/session-runner.ts'], table, GLOBAL_TOUCHFILES).selected.sort());
    expect(selectTests(['test/helpers/session-drain-policy.ts'], table, GLOBAL_TOUCHFILES).selected.sort())
      .toEqual(Object.keys(table).sort());
  }
});

function harness(options: { drainOnClose?: boolean; refuse?: boolean } = {}) {
  __resetSemaphoreForTests(3);
  let now = 0, nextTimer = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const starts: Array<{ prompt: string; at: number; controller: AbortController; close: number; finish: () => void }> = [];
  const diagnostics = new Map<string, string>();
  const removed: string[] = [], settled: any[] = [], rows: any[] = [];
  const fakeFs = {
    mkdirSync() {}, readFileSync: () => '',
    writeFileSync: (file: string, text: string) => { diagnostics.set(file, text); },
    appendFileSync: (file: string, text: string) => { diagnostics.set(file, (diagnostics.get(file) ?? '') + text); },
    rmSync: (file: string) => { removed.push(file); },
  };
  const provider = { query: (args: any) => {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const start = { prompt: args.prompt, at: now, controller: args.options.abortController, close: 0, finish };
    starts.push(start);
    return {
      close: () => { start.close++; if (options.drainOnClose) finish(); },
      async *[Symbol.asyncIterator]() {
        if (options.refuse) {
          try { await args.options.canUseTool('AskUserQuestion', { questions: [] }); } catch {}
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'retained public progress' }] } };
        await done;
        yield { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1 };
      },
    };
  } };
  const accumulator = source.slice(source.indexOf('export interface SharedCaptureAttempt {'), source.indexOf('\nexport interface SharedLibsFixture {'))
    .replace('export class SharedCaptureAccumulator', 'class SharedCaptureAccumulator');
  let interactive = source.slice(source.indexOf('export async function runSharedInteractive('))
    .replace('export async function', 'async function');
  for (const [module, replacement] of [['./agent-sdk-runner', 'sdk'], ['@anthropic-ai/claude-agent-sdk', 'provider'], ['./eval-budgets', 'budgets']]) {
    expect(interactive.split(`await import('${module}')`)).toHaveLength(2);
    interactive = interactive.replace(`await import('${module}')`, replacement);
  }
  const context = vm.createContext({ fs: fakeFs, path, AbortController, SESSION_DRAIN_GRACE_MS,
    performance: { now: () => now }, Date: { now: () => now },
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    SHARED_LIBS_ROOT: '/virtual/shared', SHARED_INTERACTIVE_MAX_TURNS: 30,
    createSharedInteractiveToolHandler, installSourceShims() {}, readRequests: () => [],
    sdk: { runAgentSdkTest, passThroughNonAskUserQuestion, resolveClaudeBinary: () => '/fake/never-spawned' },
    provider, budgets: { CAPTURE_MS },
  });
  vm.runInContext(transpile(accumulator + '\n' + interactive) + '\nglobalThis.api = { SharedCaptureAccumulator, runSharedInteractive };', context);
  const { SharedCaptureAccumulator, runSharedInteractive } = context.api;
  const captures = new SharedCaptureAccumulator();
  const capture = async (label: string, attempt: any) => {
    try { return await runSharedInteractive({ root: `/virtual/${label}`, repo: '/virtual', env: {} }, label, label, 'skip', { attempt }); }
    finally { settled.push(label); }
  };
  const entry = (name: string) => ({ name, suite: 'shared-libs', tier: 'e2e', passed: true, duration_ms: 1, cost_usd: 0 });
  const group = (name = 'normal', count = 4, timeout = CAPTURE_LONG_MS) => captures.runAttempt(name,
    Array.from({ length: count }, (_, i) => String(i)), timeout, async (attempt: any) => {
      const results = await Promise.allSettled(Array.from({ length: count }, async (_, i) => {
        await capture(`${name}-${i}`, attempt); attempt.add(String(i), entry(name));
      }));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
  let registered!: () => Promise<void>;
  const registration = native.slice(native.indexOf("  test('shared-libs-review-revalidation'"), native.lastIndexOf('\n});'));
  const record = native.slice(native.indexOf('async function recordCapture('), native.indexOf('\nfunction assertReadOnly('));
  const deps = { captures, fs: fakeFs, path, expect, CAPTURE_LONG_MS,
    test: (name: string, callback: () => Promise<void>, timeout: number) => {
      expect(name).toBe('shared-libs-review-revalidation'); expect(timeout).toBe(CAPTURE_LONG_MS); registered = callback;
    },
    createSharedLibsFixture: (label: string) => ({ root: `/virtual/${label}`, repo: '/virtual', env: {} }),
    seedReviewSources() {}, fixtureWrite() {}, installNormalizingFilter() {}, seedSkippedAdvisory: async () => ({ evidence_paths: [] }),
    fixtureWorkingTree: () => 'same', fixtureGit() {}, reviewLifecycleInstructions: () => '',
    seedPathReviewPrerequisites: () => ({ input: '' }), checkPathReviewPrerequisites: () => ({ settled: true }),
    reviewRevalidationPrompt: (f: any) => f.root,
    runSharedInteractive: async (...args: any[]) => {
      try { return await runSharedInteractive(...args); } finally { settled.push(args[0].root); }
    },
  };
  new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps; ${transpile(record + registration)}`)(deps);
  return { starts, timers, diagnostics, removed, settled, captures, capture, group, entry, registered,
    get now() { return now; },
    async to(target: number) {
      expect(target).toBeGreaterThanOrEqual(now);
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = target; await flush();
    },
    async finalize(collector = true) {
      await captures.finalize(collector ? { addTest: (row: any) => rows.push(row), finalize: async () => {} } : null);
      return rows;
    },
  };
}

test('registered revalidation never admits the stale fourth after delayed abort drainage', async () => {
  const h = harness();
  let ended = false;
  h.registered().then(() => { ended = true; }, () => { ended = true; });
  await flush();
  expect(h.starts).toHaveLength(3);
  await h.to(CAPTURE_MS);
  expect(h.starts.every(start => start.controller.signal.aborted)).toBe(true);
  await h.to(CAPTURE_LONG_MS - SESSION_DRAIN_GRACE_MS);
  expect(h.starts.map(start => start.close)).toEqual([1, 1, 1]);
  expect(h.settled).toHaveLength(1);
  await h.to(600002);
  for (const start of h.starts) start.finish();
  await flush();
  expect(h.starts).toHaveLength(3);
  expect(h.removed).toHaveLength(4);
  expect(h.settled).toHaveLength(4);
  expect(h.timers.size).toBe(0);
  expect(ended).toBe(false);
  expect([...h.diagnostics.values()].some(text => text.includes('retained public progress'))).toBe(true);
  const normal = h.group('permit-control', 3);
  await flush(); expect(h.starts).toHaveLength(6);
  for (const start of h.starts.slice(3)) start.finish();
  await normal;
  const rows = await h.finalize();
  expect(rows.map(row => row.passed)).toEqual([false, true]);
  expect(rows[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
});

test.each(['superseded', 'finalized', 'finalized-null'] as const)('%s cancels active and queued work and consumes late errors', async reason => {
  const h = harness();
  let ended = false;
  h.group('old').then(() => { ended = true; }, () => { ended = true; });
  await flush(); await h.to(100000);
  if (reason === 'superseded') await h.captures.runAttempt('old', ['done'], CAPTURE_LONG_MS, async (attempt: any) => {
    attempt.add('done', h.entry('old'));
  });
  else await h.finalize(reason !== 'finalized-null');
  await flush();
  expect(h.starts).toHaveLength(3);
  expect(h.starts.every(start => start.controller.signal.aborted && start.close === 1)).toBe(true);
  expect(h.settled).toHaveLength(1);
  for (const start of h.starts) start.finish();
  await flush();
  expect(h.settled).toHaveLength(4);
  expect(ended).toBe(false);
  expect(h.timers.size).toBe(0);
  const rows = await h.finalize();
  if (reason !== 'finalized-null') expect(rows.map(row => row.passed)).toEqual(reason === 'superseded' ? [false, true] : [false]);
});

test('admission uses remaining monotonic time and never resets the attempt deadline', async () => {
  const h = harness();
  h.group().catch(() => {});
  await flush(); await h.to(400000);
  h.starts[0].finish(); await flush();
  expect(h.starts).toHaveLength(4);
  expect(h.starts[3].at).toBe(400000);
  expect([...h.timers.values()].filter(timer => timer.at === 595000)).toHaveLength(2);
  await h.to(595000);
  expect(h.starts[3].controller.signal.aborted).toBe(true);
  expect(h.starts[3].close).toBe(1);
  for (const start of h.starts) start.finish();
  await flush(); expect(h.timers.size).toBe(0);
  expect((await h.finalize())[0].passed).toBe(false);
});

test('normal two-wave completion releases permits, clears timers and retains a passing attempt', async () => {
  const h = harness();
  const pending = h.group();
  await flush(); await h.to(290000);
  for (const start of h.starts) start.finish();
  await flush(); expect(h.starts).toHaveLength(4);
  await h.to(580000); h.starts[3].finish();
  await pending;
  expect(h.timers.size).toBe(0);
  expect(h.starts.every(start => !start.controller.signal.aborted && start.close === 0)).toBe(true);
  const followup = h.group('followup', 3);
  await flush(); expect(h.starts).toHaveLength(7);
  for (const start of h.starts.slice(4)) start.finish();
  await followup;
  expect((await h.finalize()).map(row => row.passed)).toEqual([true, true]);
});

test('cooperative SDK close settles work inside the reserved drain interval', async () => {
  const h = harness({ drainOnClose: true });
  h.group().catch(() => {});
  await flush(); await h.to(CAPTURE_LONG_MS - SESSION_DRAIN_GRACE_MS);
  expect(h.settled).toHaveLength(4);
  expect(h.starts).toHaveLength(3);
  expect(h.timers.size).toBe(0);
  expect(h.now).toBeLessThan(CAPTURE_LONG_MS);
  expect((await h.finalize())[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
});

test('refusal aborts the runner controller and retains diagnostics despite nominal provider success', async () => {
  const h = harness({ refuse: true });
  const controller = new AbortController();
  const pending = h.capture('refused', { signal: controller.signal, remainingMs: () => CAPTURE_MS });
  const outcome = pending.catch(error => error);
  await flush(); expect(h.starts[0].controller.signal.aborted).toBe(true);
  h.starts[0].finish();
  const error = await outcome;
  expect(error.message).toContain('No questions supplied');
  expect(error.sharedCapture.result.exitReason).toBe('actor_contract');
  expect(error.sharedCapture.result.events).toHaveLength(2);
  expect(h.diagnostics.get(error.sharedCapture.diagnostic + '.failure.json')).toContain('actor_contract');
  expect(h.timers.size).toBe(0);
});

test('expired admission creates no provider and releases its SDK permit', async () => {
  const h = harness();
  await expect(h.capture('expired', { signal: new AbortController().signal, remainingMs: () => 0 }))
    .rejects.toThrow('expired before admission');
  expect(h.starts).toHaveLength(0);
  expect(h.timers.size).toBe(0);
  const control = h.group('permit-control', 3);
  await flush(); expect(h.starts).toHaveLength(3);
  for (const start of h.starts) start.finish();
  await control;
});

test('CLI capture passes the owned signal and clamps work inside the original registration', async () => {
  const start = source.indexOf('export async function runSharedCapture(');
  let body = source.slice(start, source.indexOf('\nexport type SharedQuestionSelector', start)).replace('export async function', 'async function');
  body = body.replace("await import('./session-runner')", 'deps.runner').replace("await import('./eval-budgets')", 'deps.budgets');
  const calls: any[] = [], controller = new AbortController();
  const capture = new Function('deps', `const readRequests = () => []; ${transpile(body)} return runSharedCapture;`)({
    runner: { runSkillTest: async (options: any) => { calls.push(options); return {}; } }, budgets: { CAPTURE_MS },
  });
  for (const remaining of [123, 400000]) await capture({ root: '/fixture', repo: '/fixture/repo', env: {} }, 'cli', 'prompt',
    { signal: controller.signal, remainingMs: () => remaining });
  expect(calls.map(call => call.timeout)).toEqual([123, CAPTURE_MS]);
  expect(calls.every(call => call.signal === controller.signal)).toBe(true);
});
