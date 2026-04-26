/**
 * Unit tests for test/helpers/agent-sdk-runner.ts.
 *
 * Runs in free `bun test` (no API calls). Uses a stub QueryProvider to
 * simulate SDK event streams — happy path, rate-limit retries across all
 * three shapes, persistent failure, non-retryable error, options
 * propagation, concurrency cap.
 *
 * Also covers validateFixtures() rejections.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  SDKMessage,
  Options,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import {
  runAgentSdkTest,
  toSkillTestResult,
  firstTurnParallelism,
  isRateLimitThrown,
  isRateLimitResult,
  isRateLimitEvent,
  RateLimitExhaustedError,
  __resetSemaphoreForTests,
  type QueryProvider,
  type AgentSdkResult,
} from '../test/helpers/agent-sdk-runner';
import {
  validateFixtures,
  fanoutPass,
  type OverlayFixture,
} from '../test/fixtures/overlay-nudges';

// ---------------------------------------------------------------------------
// Stub SDK event builders
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function uuid(): string {
  return `00000000-0000-0000-0000-${String(++uuidCounter).padStart(12, '0')}`;
}

function systemInit(model = 'claude-opus-4-7', version = '2.1.117'): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: version,
    cwd: '/tmp/x',
    tools: ['Read'],
    mcp_servers: [],
    model,
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: uuid(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function assistantTurn(
  blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }>,
): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: 'test-session',
    message: {
      id: 'msg_' + uuid(),
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: blocks.map((b) => ({ ...b })),
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    },
  } as unknown as SDKMessage;
}

function resultSuccess(cost = 0.01, turns = 1): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 50,
    is_error: false,
    num_turns: turns,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: cost,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {},
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function resultRateLimit(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 100,
    duration_api_ms: 50,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {},
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    errors: ['rate limit exceeded (429)'],
    uuid: uuid(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

function rateLimitEvent(): SDKMessage {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
    },
    uuid: uuid(),
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Stub query provider
// ---------------------------------------------------------------------------

interface StubConfig {
  /** One event stream per call. Exhausted calls throw. */
  streams: SDKMessage[][];
  /** Throw this error on the Nth call (0-indexed). */
  throwAt?: number;
  throwError?: unknown;
  /** Track calls for assertions. */
  calls: Array<{ prompt: string; options: Options | undefined; startedAt: number; endedAt?: number }>;
}

function makeStubProvider(config: StubConfig): QueryProvider {
  let callIdx = -1;
  const provider: QueryProvider = (params) => {
    callIdx++;
    const idx = callIdx;
    const startedAt = Date.now();
    const prompt = typeof params.prompt === 'string' ? params.prompt : '<iterable>';
    config.calls.push({ prompt, options: params.options, startedAt });

    if (config.throwAt !== undefined && idx === config.throwAt) {
      const err = config.throwError ?? new Error('stub throw');
      // Return an async generator that throws on first next().
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        throw err;
      })();
      return gen as unknown as Query;
    }

    const stream = config.streams[idx];
    if (!stream) {
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        throw new Error(`stub has no stream for call ${idx}`);
      })();
      return gen as unknown as Query;
    }

    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      try {
        for (const ev of stream) {
          yield ev;
        }
      } finally {
        config.calls[idx]!.endedAt = Date.now();
      }
    })();
    return gen as unknown as Query;
  };
  return provider;
}

const BASE_OPTS = {
  systemPrompt: '',
  userPrompt: 'test prompt',
  workingDirectory: '/tmp/test-dir',
  maxRetries: 3,
};

// Reset semaphore before each test that depends on fresh capacity.
function freshSem(cap = 10): void {
  __resetSemaphoreForTests(cap);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runAgentSdkTest — happy path', () => {
  test('collects events, assistantTurns, toolCalls, and result fields', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [
        [
          systemInit(),
          assistantTurn([
            { type: 'text', text: 'reading files' },
            { type: 'tool_use', name: 'Read', input: { path: 'a.txt' } },
            { type: 'tool_use', name: 'Read', input: { path: 'b.txt' } },
          ]),
          assistantTurn([{ type: 'text', text: 'done' }]),
          resultSuccess(0.05, 2),
        ],
      ],
      calls: [],
    };
    const result = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
    });

    expect(result.events.length).toBe(4);
    expect(result.assistantTurns.length).toBe(2);
    expect(result.toolCalls.length).toBe(2);
    expect(result.toolCalls[0]!.tool).toBe('Read');
    expect(result.output).toContain('reading files');
    expect(result.output).toContain('done');
    expect(result.exitReason).toBe('success');
    expect(result.turnsUsed).toBe(2);
    expect(result.costUsd).toBe(0.05);
    expect(result.sdkClaudeCodeVersion).toBe('2.1.117');
    expect(result.model).toBe('claude-opus-4-7');
    expect(result.firstResponseMs).toBeGreaterThanOrEqual(0);
  });

  test('first-turn parallelism: 3 tool_use blocks in first assistant turn', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [
        [
          systemInit(),
          assistantTurn([
            { type: 'tool_use', name: 'Read', input: { path: 'a' } },
            { type: 'tool_use', name: 'Read', input: { path: 'b' } },
            { type: 'tool_use', name: 'Read', input: { path: 'c' } },
          ]),
          resultSuccess(),
        ],
      ],
      calls: [],
    };
    const result = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
    });
    expect(firstTurnParallelism(result.assistantTurns[0])).toBe(3);
  });

  test('first-turn parallelism: 0 when first turn is text-only', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [
        [
          systemInit(),
          assistantTurn([{ type: 'text', text: 'thinking' }]),
          resultSuccess(),
        ],
      ],
      calls: [],
    };
    const result = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
    });
    expect(firstTurnParallelism(result.assistantTurns[0])).toBe(0);
  });

  test('first-turn parallelism: 0 when no first turn', () => {
    expect(firstTurnParallelism(undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Options propagation
// ---------------------------------------------------------------------------

describe('runAgentSdkTest — options propagation', () => {
  test('systemPrompt, model, cwd, allowedTools, disallowedTools, permissionMode, settingSources, env, pathToClaudeCodeExecutable reach query()', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    await runAgentSdkTest({
      systemPrompt: 'you are a test overlay',
      userPrompt: 'go',
      workingDirectory: '/tmp/spec-dir',
      model: 'claude-opus-4-7',
      maxTurns: 7,
      allowedTools: ['Read', 'Glob'],
      disallowedTools: ['Bash', 'Write'],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      env: { ANTHROPIC_API_KEY: 'fake' },
      pathToClaudeCodeExecutable: '/fake/path/claude',
      queryProvider: makeStubProvider(stub),
    });

    const opts = stub.calls[0]!.options!;
    expect(opts.systemPrompt).toBe('you are a test overlay');
    expect(opts.model).toBe('claude-opus-4-7');
    expect(opts.cwd).toBe('/tmp/spec-dir');
    expect(opts.maxTurns).toBe(7);
    expect(opts.tools).toEqual(['Read', 'Glob']);
    expect(opts.allowedTools).toEqual(['Read', 'Glob']);
    expect(opts.disallowedTools).toEqual(['Bash', 'Write']);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.env).toEqual({ ANTHROPIC_API_KEY: 'fake' });
    expect(opts.pathToClaudeCodeExecutable).toBe('/fake/path/claude');
  });

  test('empty systemPrompt means no systemPrompt option passed', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
    });
    // systemPrompt is undefined when empty string passed (so SDK uses no override)
    expect(stub.calls[0]!.options!.systemPrompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canUseTool extension (D10 CEO / D4 eng)
// ---------------------------------------------------------------------------

describe('runAgentSdkTest — canUseTool extension', () => {
  test('permissionMode flips to "default" when canUseTool is supplied', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
      canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    });
    const opts = stub.calls[0]!.options!;
    expect(opts.permissionMode).toBe('default');
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
  });

  test('permissionMode stays "bypassPermissions" when canUseTool is NOT supplied', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
    });
    const opts = stub.calls[0]!.options!;
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
  });

  test('canUseTool callback reaches the SDK options', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    const cb = async (_toolName: string, input: Record<string, unknown>) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    });
    await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
      canUseTool: cb,
    });
    const opts = stub.calls[0]!.options! as Options & { canUseTool?: unknown };
    expect(typeof opts.canUseTool).toBe('function');
  });

  test('AskUserQuestion is auto-added to allowedTools when canUseTool is supplied', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    await runAgentSdkTest({
      ...BASE_OPTS,
      allowedTools: ['Read', 'Grep'], // explicitly omits AskUserQuestion
      queryProvider: makeStubProvider(stub),
      canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    });
    const opts = stub.calls[0]!.options!;
    expect(opts.allowedTools).toContain('AskUserQuestion');
    expect(opts.tools).toContain('AskUserQuestion');
  });

  test('AskUserQuestion is NOT auto-added when canUseTool is absent', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()]],
      calls: [],
    };
    await runAgentSdkTest({
      ...BASE_OPTS,
      allowedTools: ['Read', 'Grep'],
      queryProvider: makeStubProvider(stub),
    });
    const opts = stub.calls[0]!.options!;
    expect(opts.allowedTools).not.toContain('AskUserQuestion');
  });

  test('passThroughNonAskUserQuestion helper returns allow+updatedInput', async () => {
    const { passThroughNonAskUserQuestion } = await import('../test/helpers/agent-sdk-runner');
    const result = passThroughNonAskUserQuestion('Read', { file_path: '/tmp/x' });
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ file_path: '/tmp/x' });
  });
});

// ---------------------------------------------------------------------------
// Rate-limit retry (three shapes)
// ---------------------------------------------------------------------------

describe('runAgentSdkTest — rate-limit retry', () => {
  test('retryable on thrown 429-shaped error, then succeeds on 2nd attempt', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [
        // call 0: throws (handled via throwAt below)
        [],
        // call 1: success
        [systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()],
      ],
      throwAt: 0,
      throwError: Object.assign(new Error('429 too many requests'), { status: 429 }),
      calls: [],
    };
    const result = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
      maxRetries: 2,
    });
    expect(result.exitReason).toBe('success');
    expect(stub.calls.length).toBe(2);
  });

  test('retryable on result-message rate-limit, then succeeds', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [
        [systemInit(), resultRateLimit()],
        [systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()],
      ],
      calls: [],
    };
    const result = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
      maxRetries: 2,
    });
    expect(result.exitReason).toBe('success');
    expect(stub.calls.length).toBe(2);
  });

  test('retryable on mid-stream SDKRateLimitEvent, then succeeds', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [
        [systemInit(), rateLimitEvent()],
        [systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()],
      ],
      calls: [],
    };
    const result = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
      maxRetries: 2,
    });
    expect(result.exitReason).toBe('success');
    expect(stub.calls.length).toBe(2);
  });

  test('onRetry callback is invoked between attempts', async () => {
    freshSem();
    const resets: string[] = [];
    const stub: StubConfig = {
      streams: [
        [],
        [systemInit(), assistantTurn([{ type: 'text', text: 'ok' }]), resultSuccess()],
      ],
      throwAt: 0,
      throwError: Object.assign(new Error('429'), { status: 429 }),
      calls: [],
    };
    await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
      maxRetries: 2,
      onRetry: (dir) => resets.push(dir),
    });
    expect(resets.length).toBe(1);
    expect(resets[0]).toBe('/tmp/test-dir');
  });

  test('persistent 429 throws RateLimitExhaustedError after maxRetries', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[], [], [], []], // 4 empty streams; throw on each
      calls: [],
    };
    // Every call throws:
    let callCount = 0;
    const alwaysThrowProvider: QueryProvider = (params) => {
      callCount++;
      stub.calls.push({
        prompt: typeof params.prompt === 'string' ? params.prompt : '',
        options: params.options,
        startedAt: Date.now(),
      });
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        throw Object.assign(new Error('429 always'), { status: 429 });
      })();
      return gen as unknown as Query;
    };

    let caught: unknown = null;
    try {
      await runAgentSdkTest({
        ...BASE_OPTS,
        queryProvider: alwaysThrowProvider,
        maxRetries: 2,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitExhaustedError);
    expect((caught as RateLimitExhaustedError).attempts).toBe(3); // initial + 2 retries
    expect(callCount).toBe(3);
  });

  test('non-429 error is NOT retried, propagates immediately', async () => {
    __resetSemaphoreForTests(10);
    let callCount = 0;
    const throwOnce: QueryProvider = () => {
      callCount++;
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        throw new Error('generic auth failure');
      })();
      return gen as unknown as Query;
    };
    let caught: unknown = null;
    try {
      await runAgentSdkTest({
        ...BASE_OPTS,
        queryProvider: throwOnce,
        maxRetries: 3,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('generic auth failure');
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit detectors (unit)
// ---------------------------------------------------------------------------

describe('rate-limit detectors', () => {
  test('isRateLimitThrown matches status 429, message, name', () => {
    expect(isRateLimitThrown(Object.assign(new Error('boom'), { status: 429 }))).toBe(true);
    expect(isRateLimitThrown(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitThrown(new Error('rate-limit exceeded'))).toBe(true);
    expect(isRateLimitThrown(Object.assign(new Error('x'), { name: 'RateLimitError' }))).toBe(true);
    expect(isRateLimitThrown(new Error('auth failed'))).toBe(false);
    expect(isRateLimitThrown(null)).toBe(false);
  });

  test('isRateLimitResult matches error_during_execution with 429-shaped errors', () => {
    expect(isRateLimitResult(resultRateLimit())).toBe(true);
    expect(isRateLimitResult(resultSuccess())).toBe(false);
  });

  test('isRateLimitEvent matches rate_limit_event with status=rejected', () => {
    expect(isRateLimitEvent(rateLimitEvent())).toBe(true);
    expect(isRateLimitEvent(resultSuccess())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semaphore concurrency cap
// ---------------------------------------------------------------------------

describe('runAgentSdkTest — concurrency', () => {
  test('process-level semaphore caps concurrent queries', async () => {
    __resetSemaphoreForTests(2);
    let inFlight = 0;
    let peakInFlight = 0;
    const slowStub: QueryProvider = () => {
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        inFlight++;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        yield systemInit();
        await new Promise((r) => setTimeout(r, 30));
        yield assistantTurn([{ type: 'text', text: 'ok' }]);
        yield resultSuccess();
        inFlight--;
      })();
      return gen as unknown as Query;
    };

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runAgentSdkTest({
          ...BASE_OPTS,
          userPrompt: `trial-${i}`,
          queryProvider: slowStub,
        }),
      ),
    );

    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(peakInFlight).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// toSkillTestResult shape
// ---------------------------------------------------------------------------

describe('toSkillTestResult', () => {
  test('produces a SkillTestResult-shaped object', async () => {
    freshSem();
    const stub: StubConfig = {
      streams: [[systemInit(), assistantTurn([{ type: 'text', text: 'hi' }]), resultSuccess(0.02, 1)]],
      calls: [],
    };
    const r = await runAgentSdkTest({
      ...BASE_OPTS,
      queryProvider: makeStubProvider(stub),
    });
    const s = toSkillTestResult(r);
    expect(s.toolCalls).toBeArray();
    expect(s.browseErrors).toBeArray();
    expect(s.exitReason).toBe('success');
    expect(s.duration).toBeNumber();
    expect(s.output).toBe('hi');
    expect(s.costEstimate.estimatedCost).toBe(0.02);
    expect(s.costEstimate.turnsUsed).toBe(1);
    expect(s.model).toBe('claude-opus-4-7');
    expect(s.firstResponseMs).toBeNumber();
    expect(s.maxInterTurnMs).toBeNumber();
    expect(s.transcript).toBeArray();
  });
});

// ---------------------------------------------------------------------------
// Fixture validator
// ---------------------------------------------------------------------------

describe('validateFixtures', () => {
  function base(overrides: Partial<OverlayFixture> = {}): OverlayFixture {
    return {
      id: 'test-fixture',
      overlayPath: 'model-overlays/opus-4-7.md',
      model: 'claude-opus-4-7',
      trials: 10,
      setupWorkspace: () => {},
      userPrompt: 'go',
      metric: () => 0,
      pass: fanoutPass,
      ...overrides,
    };
  }

  test('passes for a valid fixture', () => {
    expect(() => validateFixtures([base()])).not.toThrow();
  });

  test('rejects empty id', () => {
    expect(() => validateFixtures([base({ id: '' })])).toThrow(/id must be/);
  });

  test('rejects id with uppercase or unsafe chars', () => {
    expect(() => validateFixtures([base({ id: 'Test_Fixture' })])).toThrow(/id must be/);
  });

  test('rejects duplicate ids', () => {
    expect(() => validateFixtures([base(), base()])).toThrow(/duplicate fixture id/);
  });

  test('rejects non-integer trials', () => {
    expect(() => validateFixtures([base({ trials: 3.5 })])).toThrow(/trials must be/);
  });

  test('rejects trials < 3', () => {
    expect(() => validateFixtures([base({ trials: 2 })])).toThrow(/trials must be/);
  });

  test('rejects concurrency < 1', () => {
    expect(() => validateFixtures([base({ concurrency: 0 })])).toThrow(/concurrency must be/);
  });

  test('rejects non-integer concurrency', () => {
    expect(() => validateFixtures([base({ concurrency: 2.5 })])).toThrow(/concurrency must be/);
  });

  test('rejects empty model', () => {
    expect(() => validateFixtures([base({ model: '' })])).toThrow(/model must be/);
  });

  test('rejects empty userPrompt', () => {
    expect(() => validateFixtures([base({ userPrompt: '' })])).toThrow(/userPrompt must be/);
  });

  test('rejects absolute overlayPath', () => {
    expect(() => validateFixtures([base({ overlayPath: '/etc/passwd' })])).toThrow(/overlayPath must be/);
  });

  test("rejects overlayPath containing '..'", () => {
    expect(() =>
      validateFixtures([base({ overlayPath: '../outside/file.md' })]),
    ).toThrow(/overlayPath must be/);
  });

  test('rejects missing overlay file', () => {
    expect(() =>
      validateFixtures([base({ overlayPath: 'model-overlays/nonexistent.md' })]),
    ).toThrow(/overlay file not found/);
  });

  test('rejects non-function setupWorkspace', () => {
    expect(() =>
      validateFixtures([base({ setupWorkspace: 'not a function' as unknown as (d: string) => void })]),
    ).toThrow(/setupWorkspace must be a function/);
  });

  test('rejects non-function metric', () => {
    expect(() =>
      validateFixtures([base({ metric: null as unknown as (r: AgentSdkResult) => number })]),
    ).toThrow(/metric must be a function/);
  });

  test('rejects non-function pass', () => {
    expect(() =>
      validateFixtures([base({ pass: undefined as unknown as OverlayFixture['pass'] })]),
    ).toThrow(/pass must be a function/);
  });
});

// ---------------------------------------------------------------------------
// fanoutPass predicate
// ---------------------------------------------------------------------------

describe('fanoutPass predicate', () => {
  test('accepts mean lift >= 0.5 AND >=3/10 overlay trials >= 2', () => {
    const overlay = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
    const off = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(fanoutPass({ overlay, off })).toBe(true);
  });

  test('rejects when mean lift < 0.5', () => {
    const overlay = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const off = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(fanoutPass({ overlay, off })).toBe(false);
  });

  test('rejects when mean lift >= 0.5 but <3 overlay trials emit >=2', () => {
    // Mean overlay = 1.2, off = 0.0, lift 1.2 but only 2 trials at >=2
    const overlay = [2, 2, 1, 1, 1, 1, 1, 1, 1, 1];
    const off = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(fanoutPass({ overlay, off })).toBe(false);
  });
});
