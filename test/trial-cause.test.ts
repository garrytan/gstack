/**
 * failure_cause (plan 0.2): the pure failureCauseOf() precedence table, the
 * session observer's liveness and structured refusal/API-error facts, and
 * replays of stored census evidence. failure_class is never an output here:
 * verdicts keep reading it unchanged.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FAILURE_CAUSES, failureCauseOf, failureDetailOf, type FailureCauseFacts, type SessionCauseFacts } from './helpers/eval-store';
import { SessionObserver, readSessionLedger, type SessionLedgerRow } from './helpers/session-ledger';
import { STALL_WINDOW_MS } from './helpers/eval-budgets';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';
import { createFakePtyDriver } from './helpers/pty/fake-session';
import { runAgentSdkTest, __resetSemaphoreForTests, type QueryProvider } from './helpers/agent-sdk-runner';
import { runRecordedCodexEval } from './helpers/codex-eval';
import { classifyTrialShard } from '../scripts/test-paid-shards';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'trial-cause');
const thinking = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'thinking-captures-37198445662.json'), 'utf8'));
const replays = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'replays.json'), 'utf8'));

type Timed = [number, any];
/** Decode one compact capture line: `<ms> s <kind>[:<delta>]`, `a[*] <id>:<tool>,...`, `u <id>,...`, `y <subtype>`, `r`. */
function decode(line: string): Timed {
  const [ms, code, arg = ''] = line.split(' ');
  const at = Number(ms);
  if (code === 's') {
    const [type, delta] = arg.split(':');
    return [at, { type: 'stream_event', event: { type, ...(delta ? { delta: { type: delta } } : {}) } }];
  }
  if (code === 'a' || code === 'a*') {
    const content = arg ? arg.split(',').map(t => { const [id, name] = t.split(':'); return { type: 'tool_use', id, name }; }) : [];
    return [at, { type: 'assistant', ...(code === 'a*' ? { parent_tool_use_id: 'parent' } : {}), message: { content } }];
  }
  if (code === 'u') return [at, { type: 'user', message: { content: arg ? arg.split(',').map(id => ({ type: 'tool_result', tool_use_id: id })) : [] } }];
  if (code === 'y') return [at, { type: 'system', subtype: arg }];
  return [at, { type: 'result', subtype: 'success' }];
}

function observe(events: Timed[], endAt: number, hooks: { permissionAt?: number } = {}) {
  const observer = new SessionObserver(0);
  for (const [at, event] of events) {
    if (hooks.permissionAt !== undefined && at > hooks.permissionAt) { observer.permission(1); hooks.permissionAt = undefined; }
    observer.observe(event, at);
  }
  if (hooks.permissionAt !== undefined) observer.permission(1);
  return { observer, liveness: observer.summary(endAt) };
}

const timedOutSession = (liveness: SessionCauseFacts['liveness']): SessionCauseFacts => ({ key: 'claude-p:x#1', end: 'session_timeout', elapsed_ms: 600_000, budget_ms: 600_000, liveness });
const causeOf = (facts: Partial<FailureCauseFacts>) => failureCauseOf({ failure_class: 'assertion', ...facts }, STALL_WINDOW_MS);

describe('failureCauseOf precedence', () => {
  const stalled = { partial: true, max_request_silence_ms: STALL_WINDOW_MS + 10_000, silence_started_ms: 40_000, silence_after: 'thinking_delta' };
  const rows: Array<[string, Partial<FailureCauseFacts>]> = [
    ['contract', { failure_class: 'contract', error: 'CONTRACT: no write', sessions: [{ end: 'api_error', evidence: 'API Error: 500' }] }],
    ['pre_turn_infra', { failure_class: 'infra', exit_reason: 'timeout_startup', sessions: [{ end: 'refusal' }] }],
    ['api_error', { sessions: [{ end: 'refusal', evidence: 'refusal at turn 2' }, { end: 'api_error', evidence: 'API Error: Connection lost mid-response.' }] }],
    ['refusal', { sessions: [timedOutSession(stalled), { end: 'refusal', evidence: 'refusal at turn 3 (model_refusal_no_fallback) — reasoning_extraction' }] }],
    ['provider_stall', { failure_class: 'timeout', exit_reason: 'timeout', sessions: [timedOutSession(stalled)] }],
    ['session_timeout', { failure_class: 'timeout', exit_reason: 'timeout', sessions: [timedOutSession({ partial: false, max_request_silence_ms: 0 }), { end: 'observer_timeout' }] }],
    ['observer_timeout', { sessions: [{ end: 'observer_timeout' }] }],
    ['assertion', { exit_reason: 'success', error: 'expect(received).toBe(expected)' }],
    ['unknown', { failure_class: 'timeout', error: 'shard wall reached' }],
  ];

  test('one row per cause, in precedence order, and nothing else', () => {
    expect(rows.map(([cause]) => cause)).toEqual([...FAILURE_CAUSES]);
    expect(FAILURE_CAUSES).not.toContain('detector');
  });

  test.each(rows)('%s', (cause, facts) => {
    expect(causeOf(facts).cause).toBe(cause as any);
  });

  test('evidence is one bounded line naming what was observed', () => {
    expect(causeOf(rows[4]![1]).evidence).toBe('no stream event for 130s from 40s (last: thinking_delta); model request in flight, no tool outstanding');
    expect(causeOf({ exit_reason: 'success' }).evidence).toBe('session completed; check failed');
    const long = causeOf({ failure_class: 'contract', error: `CONTRACT: ${'x'.repeat(1000)}\nsecond line @team` });
    expect(long.evidence!.length).toBeLessThanOrEqual(300);
    expect(long.evidence).not.toContain('second line');
  });

  test('a stall needs partial messages and a session that did not complete', () => {
    const quiet = { partial: false, max_request_silence_ms: 0 };
    expect(causeOf({ failure_class: 'timeout', sessions: [timedOutSession(quiet)] }).cause).toBe('session_timeout');
    const recovered = { key: 'k', end: 'completed', liveness: { partial: true, max_request_silence_ms: STALL_WINDOW_MS * 2 } };
    expect(causeOf({ sessions: [recovered] }).cause).toBe('assertion');
  });
});

describe('liveness on real thinking captures (Claude Code 2.1.284, census 37198445662)', () => {
  test('the seven partial-message sessions never reach the stall window', () => {
    expect(thinking.sessions).toHaveLength(7);
    for (const session of thinking.sessions) {
      const events: Timed[] = session.events.map(decode);
      const { liveness } = observe(events, events.at(-1)![0]);
      expect(liveness.partial).toBe(true);
      expect(liveness.max_request_silence_ms, session.case).toBeLessThan(STALL_WINDOW_MS);
      expect(causeOf({ failure_class: 'timeout', sessions: [timedOutSession(liveness)] }).cause).toBe('session_timeout');
    }
  });

  const base: Timed[] = thinking.sessions.find((s: any) => s.case === '/review army consensus').events.map(decode);
  const SILENCE = STALL_WINDOW_MS + 10_000;
  const cutAfter = (pick: (event: any, i: number) => boolean) => {
    const at = base.findIndex(([, e], i) => i > 20 && pick(e, i));
    expect(at).toBeGreaterThan(0);
    return base.slice(0, at + 1);
  };

  test('synthetic positive: a 130 s silence inside a model message is a provider stall', () => {
    const events = cutAfter(e => e.type === 'stream_event' && e.event.delta?.type === 'thinking_delta');
    const { liveness } = observe(events, events.at(-1)![0] + SILENCE);
    expect(liveness.max_request_silence_ms).toBe(SILENCE);
    expect(liveness.silence_after).toBe('thinking_delta');
    expect(causeOf({ failure_class: 'timeout', exit_reason: 'timeout', sessions: [timedOutSession(liveness)] }).cause).toBe('provider_stall');
  });

  test('controls: hung tool, hook, permission prompt, subagent and long thinking are not stalls', () => {
    const toolOpen = cutAfter(e => e.type === 'assistant' && e.message.content.length > 0);
    const hook: Timed[] = [...cutAfter(e => e.type === 'user'), [0, { type: 'system', subtype: 'hook_started' }]];
    hook[hook.length - 1]![0] = hook[hook.length - 2]![0];
    const subagent: Timed[] = [[0, { type: 'stream_event', event: { type: 'message_start' } }],
      [1000, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent' }] } }],
      [1500, { type: 'stream_event', event: { type: 'message_stop' } }],
      [2000, { type: 'assistant', parent_tool_use_id: 'agent', message: { content: [{ type: 'tool_use', id: 'child', name: 'Bash' }] } }]];
    const thinkingLong: Timed[] = [[0, { type: 'stream_event', event: { type: 'message_start' } }],
      ...Array.from({ length: 40 }, (_, i): Timed => [(i + 1) * 9_000, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }])];
    const permission = cutAfter(e => e.type === 'user');
    for (const [name, events, hooks] of [['hung tool', toolOpen, {}], ['hook', hook, {}], ['subagent', subagent, {}],
      ['long thinking', thinkingLong, {}], ['permission', permission, { permissionAt: permission.at(-1)![0] }]] as const) {
      // Long thinking runs 360 s of deltas 9 s apart and ends at the next one; the others go silent for 130 s.
      const { liveness } = observe(events as Timed[], (events as Timed[]).at(-1)![0] + (name === 'long thinking' ? 9_000 : SILENCE), { ...hooks });
      expect(liveness.max_request_silence_ms, name).toBeLessThan(STALL_WINDOW_MS);
      expect(causeOf({ failure_class: 'timeout', sessions: [timedOutSession(liveness)] }).cause, name).toBe('session_timeout');
    }
  });
});

describe('replays of stored census evidence', () => {
  const byCase = (run: string, c: string, trial = 1) => replays.cases.find((r: any) => r.run === run && r.case === c && r.trial === trial);

  test.each([1, 2])('37195203538 plan-ceo-review-format-approach t%d is a refusal from the structured stream', trial => {
    const r = byCase('37195203538', 'plan-ceo-review-format-approach', trial);
    const { observer } = observe(r.events, r.events.at(-1)[0]);
    const verdict = observer.verdict()!;
    expect(verdict.end).toBe('refusal');
    expect(verdict.evidence).toMatch(/^refusal at turn \d+ \(model_refusal_no_fallback\) — reasoning_extraction$/);
    const cause = causeOf({ exit_reason: r.exit_reason, error: r.error, sessions: [{ key: 'k', end: verdict.end, evidence: verdict.evidence }] });
    expect(cause.cause).toBe('refusal');
  });

  test('a tool result quoting refusal text is not a refusal', () => {
    const observer = new SessionObserver(0);
    observer.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read' }] } }, 1);
    observer.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't',
      content: "API Error: Fable 5.1's safeguards flagged this message. Claude Code can't respond to this message." }] } }, 2);
    observer.observe({ type: 'result', subtype: 'success', is_error: false, result: 'Quoted the refusal text from docs.' }, 3);
    expect(observer.verdict()).toBeNull();
  });

  test('37186854666 shared-libs-review-revalidation ran without partial messages, so it is a session timeout', () => {
    const r = byCase('37186854666', 'shared-libs-review-revalidation');
    const { liveness } = observe(r.events, r.duration_ms);
    expect(liveness.partial).toBe(false);
    expect(liveness.max_request_silence_ms).toBe(0);
    expect(causeOf({ failure_class: r.failure_class, exit_reason: r.exit_reason, error: r.error }).cause).toBe('session_timeout');
    // Through the record builder the trial shard uses: failure_class stays timeout, the cause is the session timeout.
    expect(classifyTrialShard({ status: 'failed', executedTests: 1, skippedTests: 0, elapsedMs: r.duration_ms }, r.case, 1,
      { kind: 'rule', panel: { n: 1, k: 1 }, quarantined: false }, { records: [{ passed: false, exit_reason: r.exit_reason, error: r.error }], contract: null }))
      .toMatchObject({ outcome: 'failed', failure_class: 'timeout', failure_cause: 'session_timeout', error: 'Error: Claude Code process aborted by user' });
    expect(causeOf({ failure_class: r.failure_class, exit_reason: r.exit_reason, error: r.error,
      sessions: [{ key: 'agent-sdk:x#1', end: 'session_timeout', elapsed_ms: r.duration_ms, budget_ms: 300_000, liveness }] }).cause).toBe('session_timeout');
  });

  test.each([['37174266054', 'plan-eng-review-artifact'], ['37176837432', 'auto-decide-preserved']])('%s %s is an observer timeout', (run, c) => {
    const r = byCase(run, c);
    expect(r.failure_class).toBe('assertion');
    expect(causeOf({ failure_class: r.failure_class, exit_reason: r.exit_reason, error: r.error }).cause).toBe('observer_timeout');
  });
});

async function withEvalDir<T>(run: (dir: string) => Promise<T>): Promise<{ value: T; rows: SessionLedgerRow[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-cause-ledger-'));
  const saved = { dir: process.env.GSTACK_EVAL_DIR, run: process.env.EVALS_RUN_ID, id: process.env.GSTACK_EVAL_CASE_ID };
  process.env.GSTACK_EVAL_DIR = dir;
  delete process.env.EVALS_RUN_ID; delete process.env.GSTACK_EVAL_CASE_ID;
  try {
    const value = await run(dir);
    return { value, rows: readSessionLedger(dir) };
  } finally {
    for (const [key, name] of [['dir', 'GSTACK_EVAL_DIR'], ['run', 'EVALS_RUN_ID'], ['id', 'GSTACK_EVAL_CASE_ID']] as const) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('one fixture per runner writes the ledger the classifier reads', () => {
  test('PTY: the captured API Error idle turn records api_error with its panel line', async () => {
    const captures = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'pty-idle-turn-end.json'), 'utf8'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-cause-pty-'));
    try {
      const { value: obs, rows } = await withEvalDir(async () => {
        const fake = createFakePtyDriver({ frames: [{ screen: 'Claude Code\n> ' }, { onInput: '/plan-eng-review\r', screen: captures.apiErrorIdle.visible }], configDir });
        return runPlanSkillObservation({ skillName: 'plan-eng-review', inPlanMode: false, model: 'fake-model', driver: fake.driver,
          extraArgs: ['--disallowedTools', 'AskUserQuestion'], requireProseEvidence: true, timeoutMs: 300_000 });
      });
      expect(obs.outcome).toBe('timeout');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runner: 'pty', budget_ms: 300_000, end: 'api_error', evidence: '●API Error: Connection lost mid-response. The response above may be incomplete.' });
      expect(causeOf({ error: obs.summary, sessions: rows }).cause).toBe('api_error');
    } finally { fs.rmSync(configDir, { recursive: true, force: true }); }
  });

  test('Agent SDK: an abort at the armed budget is a session timeout; partial-message silence is a stall', async () => {
    __resetSemaphoreForTests(4);
    const hangingQuery = (events: any[]): QueryProvider => ((args: any) => {
      const signal: AbortSignal = args.options.abortController.signal;
      const iterator = (async function* () {
        for (const event of events) yield event;
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user')), { once: true }));
      })();
      setTimeout(() => args.options.abortController.abort(), 400);
      return Object.assign(iterator, { close: () => {} });
    }) as unknown as QueryProvider;
    const run = (events: any[]) => withEvalDir(() => runAgentSdkTest({ systemPrompt: '', userPrompt: 'x', workingDirectory: os.tmpdir(), maxRetries: 0,
      testName: 'sdk-fixture', sessionBudgetMs: 400, streamLiveness: true, queryProvider: hangingQuery(events) }).catch(error => error));
    const quiet = await run([{ type: 'system', subtype: 'init' }]);
    expect(quiet.rows).toEqual([expect.objectContaining({ key: 'agent-sdk:sdk-fixture#1', runner: 'agent-sdk', budget_ms: 400, end: 'session_timeout',
      liveness: expect.objectContaining({ partial: false }) })]);
    expect(causeOf({ failure_class: 'timeout', exit_reason: 'timeout', sessions: quiet.rows }).cause).toBe('session_timeout');
    const streaming = await run([{ type: 'system', subtype: 'init' }, { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }]);
    expect(streaming.rows[0]!.liveness).toMatchObject({ partial: true, silence_after: 'thinking_delta' });
    expect(failureCauseOf({ failure_class: 'timeout', sessions: streaming.rows }, 300).cause).toBe('provider_stall');
    expect(failureCauseOf({ failure_class: 'timeout', sessions: streaming.rows }, STALL_WINDOW_MS).cause).toBe('session_timeout');
  });

  test('Codex: an expired budget is a session timeout', async () => {
    const { rows } = await withEvalDir(() => runRecordedCodexEval({ name: 'codex-fixture', suite: 's', budgetMs: 50, drainGraceMs: 10,
      run: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      validate: () => {}, record: () => {} }).catch(() => undefined));
    expect(rows).toEqual([expect.objectContaining({ key: 'codex:codex-fixture#1', runner: 'codex', budget_ms: 50, end: 'session_timeout' })]);
    expect(causeOf({ failure_class: 'assertion', exit_reason: 'timeout', sessions: rows }).cause).toBe('session_timeout');
  });
});

describe('failureDetailOf (Bun 1.4.0 matcher shapes)', () => {
  test.each([
    ['expect(received).toBe(expected)\n\nExpected: "b"\nReceived: "a"\n', { expected: '"b"', received: '"a"' }],
    ['expect(received).toContain(expected)\n\nExpected to contain: "xyz"\nReceived: "hello world"\n', { expected: '"xyz"', received: '"hello world"' }],
    ['expect(received).not.toMatch(expected)\n\nExpected substring or pattern: not /taste/\nReceived: "taste call"\n', { expected: 'not /taste/', received: '"taste call"' }],
    ['expect(received).toEqual(expected)\n\n  {\n-   "a": 2,\n+   "a": 1,\n  }\n\n- Expected  - 1\n+ Received  + 1\n', { expected: '"a": 2,', received: '"a": 1,' }],
  ])('%#', (message, detail) => {
    expect(failureDetailOf(message)).toEqual(detail);
  });

  test('the live message shape on this Bun matches the fixtures', () => {
    let message = '';
    try { expect('a').toBe('b'); } catch (error) { message = (error as Error).message; }
    expect(failureDetailOf(message)).toEqual({ expected: '"b"', received: '"a"' });
  });

  test('a judge red names each failing dimension, its mean, sample count and a rationale', () => {
    const detail = failureDetailOf('expect(received).toBeGreaterThanOrEqual(expected)\n\nExpected: >= 4\nReceived: 3.6666666666666665\n', {
      judge_scores: { clarity: 3.6666666666666665, completeness: 4.333333333333333, actionability: 3.6666666666666665 },
      judge_reasoning: '[sample 1] Thorough. Clarity suffers from extreme density. Two actionability concerns: the budget is infeasible.\n[sample 2] Fine.\n[sample 3] Ok.',
    });
    expect(detail).toEqual({ judge: [
      { dimension: 'clarity', mean: 3.67, threshold: 4, samples: 3, rationale: 'Clarity suffers from extreme density.' },
      { dimension: 'actionability', mean: 3.67, threshold: 4, samples: 3, rationale: 'Two actionability concerns: the budget is infeasible.' },
    ] });
  });
});
