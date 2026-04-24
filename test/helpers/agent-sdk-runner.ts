/**
 * Claude Agent SDK wrapper for the overlay-efficacy harness.
 *
 * This sits alongside session-runner.ts (which drives `claude -p` as a
 * subprocess) but runs the model via the published @anthropic-ai/claude-agent-sdk
 * instead. The SDK exposes the same harness primitives Claude Code itself uses,
 * so overlay-driven behavior change is measured against a closer approximation
 * of real Claude Code than the `claude -p` subprocess path provides.
 *
 * Explicit design rules (from plan review):
 *   - Use SDK-exported SDKMessage types. No `| unknown` union collapse.
 *   - Permission surface is explicit: bypassPermissions + settingSources:[] +
 *     disallowedTools inverse. Without these, the SDK inherits user settings,
 *     project .claude/, and local hooks, and arms are no longer comparable.
 *   - Binary pinning via pathToClaudeCodeExecutable. Resolve with `which claude`
 *     at setup time; the SDK would otherwise use its bundled binary.
 *   - 3-shape rate-limit detection: thrown error, result-message error subtype,
 *     mid-stream SDKRateLimitEvent. All three recover on retry.
 *   - On retry, caller resets workspace via a setupWorkspace callback so
 *     partial Bash side-effects don't contaminate the next attempt.
 *   - Process-level semaphore caps concurrent queries across all callers in
 *     the same bun-test process. Composes with bun's own --concurrent flag.
 */

import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type PermissionMode,
  type SettingSource,
  type Options,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { SkillTestResult } from './session-runner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSdkResult {
  /** Full raw event stream for forensic recovery. */
  events: SDKMessage[];
  /** Assistant-typed subset, in order. */
  assistantTurns: SDKAssistantMessage[];
  /** Flat tool-call list, in order of emission. */
  toolCalls: Array<{ tool: string; input: unknown; output: string }>;
  /** Concatenated assistant text, newline-joined. */
  output: string;
  /** 'success' | 'error_during_execution' | 'error_max_turns' | ... */
  exitReason: string;
  turnsUsed: number;
  durationMs: number;
  firstResponseMs: number;
  maxInterTurnMs: number;
  costUsd: number;
  model: string;
  sdkVersion: string;
  /** claude_code_version from the SDK's system/init event (authoritative). */
  sdkClaudeCodeVersion: string;
  /** Path to the claude binary we pinned. */
  resolvedBinaryPath: string;
  /** browse-error pattern scan for SkillTestResult parity. Always empty here. */
  browseErrors: string[];
}

/** Signature matching `query()` from the SDK. DI hook for unit tests. */
export type QueryProvider = typeof query;

/** Subset of SDK Options['systemPrompt'] we support. */
export type SystemPromptOption =
  | string
  | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean };

export interface RunAgentSdkOptions {
  /**
   * System prompt surface.
   *   - bare string "" -> omit entirely (SDK default: no system prompt)
   *   - bare string "...text..." -> REPLACE default with given text (use sparingly)
   *   - { type:'preset', preset:'claude_code' } -> use Claude Code default
   *   - { type:'preset', preset:'claude_code', append: "..." } -> default + append
   *
   * For overlay-efficacy measurement, the preset+append pattern is the right
   * one: it measures "does adding overlay text to the REAL Claude Code system
   * prompt change behavior" rather than "does the overlay alone (stripped of
   * base scaffolding) change behavior".
   */
  systemPrompt: SystemPromptOption;
  userPrompt: string;
  workingDirectory: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
  settingSources?: SettingSource[];
  env?: Record<string, string>;
  pathToClaudeCodeExecutable?: string;
  testName?: string;
  runId?: string;
  fixtureId?: string;
  queryProvider?: QueryProvider;
  /** Max 429 retries per call. Default 3. */
  maxRetries?: number;
  /**
   * Caller provides this when retry should reset the workspace. The harness
   * invokes it with a fresh dir after a rate-limit failure. When omitted,
   * retries reuse the original workingDirectory (fine for read-only tests).
   */
  onRetry?: (freshDir: string) => void;
  /**
   * Optional canUseTool callback. When supplied, the harness flips
   * permissionMode from 'bypassPermissions' to 'default' so the SDK actually
   * routes tool-use approval decisions through the callback. Without this
   * flip, bypassPermissions short-circuits the callback and tests that want
   * to assert on AskUserQuestion content silently pass without asserting.
   *
   * Callback contract matches the SDK: fires on every tool-use approval
   * request and on AskUserQuestion invocations. For non-AskUserQuestion
   * tools that tests don't care about, use `passThroughNonAskUserQuestion`
   * to auto-allow them.
   */
  canUseTool?: CanUseTool;
}

/**
 * Pass-through helper: auto-allows any tool_use that isn't AskUserQuestion.
 * Most plan-mode handshake tests only care about the handshake AskUserQuestion;
 * every other tool (Read, Grep, Bash, Write, Edit, ExitPlanMode) should just
 * run. Compose with a test-specific AskUserQuestion handler:
 *
 *   canUseTool: async (toolName, input, options) => {
 *     if (toolName === 'AskUserQuestion') {
 *       // custom assertions + canned answer
 *       return { behavior: 'allow', updatedInput: { questions: input.questions, answers: {...} } };
 *     }
 *     return passThroughNonAskUserQuestion(toolName, input);
 *   }
 */
export function passThroughNonAskUserQuestion(
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'allow'; updatedInput: Record<string, unknown> } {
  // SDK requires an allow response to include updatedInput — pass the original
  // input through unchanged so the tool runs as the model intended.
  void toolName;
  return { behavior: 'allow', updatedInput: input };
}

export class RateLimitExhaustedError extends Error {
  readonly attempts: number;
  constructor(attempts: number, cause?: unknown) {
    super(`rate limit exhausted after ${attempts} attempts`);
    this.name = 'RateLimitExhaustedError';
    this.attempts = attempts;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Process-level semaphore for API concurrency
// ---------------------------------------------------------------------------

/**
 * Bounded token bucket. Shared across all runAgentSdkTest calls in this
 * process so that bun's --concurrent flag does not compound with in-test
 * concurrency to blow past Anthropic's rate limits.
 *
 * Default capacity 3. Override via GSTACK_SDK_MAX_CONCURRENCY env var.
 */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];
  constructor(capacity: number) {
    this.available = capacity;
  }
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
  /** For tests. Returns tokens currently in-flight. */
  inFlight(): number {
    // Not introspectable from outside without tracking; approximate.
    return this.queue.length;
  }
}

const DEFAULT_SDK_CONCURRENCY = Number(process.env.GSTACK_SDK_MAX_CONCURRENCY ?? 3);
let _apiSemaphore: Semaphore | null = null;
function getApiSemaphore(): Semaphore {
  if (!_apiSemaphore) _apiSemaphore = new Semaphore(DEFAULT_SDK_CONCURRENCY);
  return _apiSemaphore;
}

/** Test-only. Resets the process-level semaphore. */
export function __resetSemaphoreForTests(capacity: number): void {
  _apiSemaphore = new Semaphore(capacity);
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

/** True if `err` looks like a rate-limit thrown from the SDK. */
export function isRateLimitThrown(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as { message?: string }).message ?? '';
  const name = (err as { name?: string }).name ?? '';
  const status = (err as { status?: number }).status;
  return (
    status === 429 ||
    /rate.?limit|429|too many requests/i.test(msg) ||
    /RateLimit/i.test(name)
  );
}

/** True if a SDKResultMessage is a rate-limit-shaped error. */
export function isRateLimitResult(msg: SDKMessage): boolean {
  if (msg.type !== 'result') return false;
  const r = msg as SDKResultMessage;
  if (r.subtype === 'success') return false;
  // subtype === 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | ...
  if (r.subtype !== 'error_during_execution') return false;
  const errs = (r as { errors?: string[] }).errors ?? [];
  return errs.some((e) => /rate.?limit|429|too many requests/i.test(e));
}

/** True if mid-stream SDKRateLimitEvent indicates a blocking rate-limit. */
export function isRateLimitEvent(msg: SDKMessage): boolean {
  if (msg.type !== 'rate_limit_event') return false;
  const info = (msg as { rate_limit_info?: { status?: string } }).rate_limit_info;
  return info?.status === 'rejected';
}

/**
 * True if `err` is the SDK's "max turns reached" throw. Some SDK versions
 * raise this as an exception from the generator instead of emitting a
 * result message with subtype='error_max_turns'. We treat it as terminal-
 * but-recoverable: record what we collected and continue, rather than
 * failing the whole run.
 */
export function isMaxTurnsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as { message?: string }).message ?? '';
  return /reached maximum number of turns|max.?turns/i.test(msg);
}

// ---------------------------------------------------------------------------
// Version resolution (cached)
// ---------------------------------------------------------------------------

let _sdkVersionCache: string | null = null;
function resolveSdkVersion(): string {
  if (_sdkVersionCache) return _sdkVersionCache;
  try {
    const pkgPath = require.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    _sdkVersionCache = pkg.version ?? 'unknown';
  } catch {
    _sdkVersionCache = 'unknown';
  }
  return _sdkVersionCache;
}

export function resolveClaudeBinary(): string | null {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Execute a single SDK query with retries. Returns a typed result.
 *
 * The retry loop treats 429 as recoverable and any other error as fatal.
 * Exponential backoff: 1s, 2s, 4s. After maxRetries failures, throws
 * RateLimitExhaustedError so the caller can decide what to do with the run.
 */
export async function runAgentSdkTest(
  opts: RunAgentSdkOptions,
): Promise<AgentSdkResult> {
  const sem = getApiSemaphore();
  const maxRetries = opts.maxRetries ?? 3;
  const queryImpl: QueryProvider = opts.queryProvider ?? query;
  const model = opts.model ?? 'claude-opus-4-7';

  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt <= maxRetries) {
    await sem.acquire();
    const startMs = Date.now();

    // Hoisted so the max-turns catch branch can synthesize a result from
    // whatever we captured before the SDK threw.
    const events: SDKMessage[] = [];
    const assistantTurns: SDKAssistantMessage[] = [];
    const toolCalls: Array<{ tool: string; input: unknown; output: string }> = [];
    const assistantTextParts: string[] = [];
    let firstResponseMs = 0;
    let lastEventMs = startMs;
    let maxInterTurnMs = 0;
    let systemInitVersion = 'unknown';
    let rateLimited: unknown = null;
    let terminalResult: SDKResultMessage | null = null;

    try {
      // When canUseTool is supplied, the SDK must route tool-use approval
      // decisions through the callback. bypassPermissions short-circuits
      // that. Flip to 'default' mode so canUseTool actually fires. Tests
      // that want AskUserQuestion interception without this flip would
      // silently auto-pass — the exact testability gap D14/D4-eng fix.
      const hasCanUseTool = typeof opts.canUseTool === 'function';
      const resolvedPermissionMode: PermissionMode =
        opts.permissionMode ?? (hasCanUseTool ? 'default' : 'bypassPermissions');

      // When canUseTool is supplied, ensure AskUserQuestion is in the allowed
      // tools list. Without it, Claude can't invoke AskUserQuestion at all
      // and the callback never has a chance to fire on it.
      const baseTools = opts.allowedTools ?? ['Read', 'Glob', 'Grep', 'Bash'];
      const resolvedTools =
        hasCanUseTool && !baseTools.includes('AskUserQuestion')
          ? [...baseTools, 'AskUserQuestion']
          : baseTools;

      const sdkOpts: Options = {
        model,
        cwd: opts.workingDirectory,
        maxTurns: opts.maxTurns ?? 5,
        tools: resolvedTools,
        disallowedTools: opts.disallowedTools,
        allowedTools: resolvedTools,
        permissionMode: resolvedPermissionMode,
        allowDangerouslySkipPermissions: resolvedPermissionMode === 'bypassPermissions',
        settingSources: opts.settingSources ?? [],
        env: opts.env,
        pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
        ...(hasCanUseTool ? { canUseTool: opts.canUseTool } : {}),
      };
      // Empty bare string means "omit entirely" (SDK runs with no override).
      // Any object or non-empty string is passed through.
      if (typeof opts.systemPrompt === 'object' || opts.systemPrompt !== '') {
        sdkOpts.systemPrompt = opts.systemPrompt;
      }

      const q = queryImpl({
        prompt: opts.userPrompt,
        options: sdkOpts,
      });

      for await (const ev of q) {
        const now = Date.now();
        if (firstResponseMs === 0) firstResponseMs = now - startMs;
        const interTurn = now - lastEventMs;
        if (interTurn > maxInterTurnMs) maxInterTurnMs = interTurn;
        lastEventMs = now;

        events.push(ev);

        if (ev.type === 'system' && (ev as SDKSystemMessage).subtype === 'init') {
          systemInitVersion =
            (ev as SDKSystemMessage).claude_code_version ?? 'unknown';
        } else if (ev.type === 'assistant') {
          const am = ev as SDKAssistantMessage;
          assistantTurns.push(am);
          const content = am.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<
              | { type: 'text'; text?: string }
              | { type: 'tool_use'; name?: string; input?: unknown }
              | { type: string }
            >) {
              if (block.type === 'text') {
                const t = (block as { text?: string }).text;
                if (t) assistantTextParts.push(t);
              } else if (block.type === 'tool_use') {
                const tb = block as { name?: string; input?: unknown };
                toolCalls.push({
                  tool: tb.name ?? 'unknown',
                  input: tb.input ?? {},
                  output: '',
                });
              }
            }
          }
        } else if (isRateLimitEvent(ev)) {
          rateLimited = new Error(
            `mid-stream rate limit: ${JSON.stringify(
              (ev as { rate_limit_info?: unknown }).rate_limit_info,
            )}`,
          );
        } else if (ev.type === 'result') {
          terminalResult = ev as SDKResultMessage;
          if (isRateLimitResult(ev)) {
            rateLimited = new Error(
              `result-message rate limit: ${((ev as { errors?: string[] }).errors ?? []).join('; ')}`,
            );
          }
        }
      }

      if (rateLimited) {
        throw rateLimited;
      }
      if (!terminalResult) {
        throw new Error('query stream ended without a result event');
      }

      const durationMs = Date.now() - startMs;
      const costUsd =
        (terminalResult as { total_cost_usd?: number }).total_cost_usd ?? 0;
      const turnsUsed =
        (terminalResult as { num_turns?: number }).num_turns ??
        assistantTurns.length;
      const exitReason =
        (terminalResult as { subtype?: string }).subtype ?? 'unknown';

      return {
        events,
        assistantTurns,
        toolCalls,
        output: assistantTextParts.join('\n'),
        exitReason,
        turnsUsed,
        durationMs,
        firstResponseMs,
        maxInterTurnMs,
        costUsd,
        model,
        sdkVersion: resolveSdkVersion(),
        sdkClaudeCodeVersion: systemInitVersion,
        resolvedBinaryPath: opts.pathToClaudeCodeExecutable ?? 'sdk-default',
        browseErrors: [],
      };
    } catch (err) {
      lastErr = err;

      // "Max turns reached" is the SDK's way of saying "this session ran
      // out of turns." It's thrown from the generator instead of emitted
      // as a result message. Treat as a successful-but-capped trial: the
      // assistant turns we collected are real and carry a metric. Record
      // them with exitReason='error_max_turns' rather than failing the
      // whole run.
      if (isMaxTurnsError(err)) {
        const durationMs = Date.now() - startMs;
        return {
          events,
          assistantTurns,
          toolCalls,
          output: assistantTextParts.join('\n'),
          exitReason: 'error_max_turns',
          turnsUsed: assistantTurns.length,
          durationMs,
          firstResponseMs,
          maxInterTurnMs,
          costUsd: 0, // unknown from thrown-error path
          model,
          sdkVersion: resolveSdkVersion(),
          sdkClaudeCodeVersion: systemInitVersion,
          resolvedBinaryPath: opts.pathToClaudeCodeExecutable ?? 'sdk-default',
          browseErrors: [],
        };
      }

      const isRetryable = isRateLimitThrown(err);
      if (!isRetryable || attempt >= maxRetries) {
        if (isRetryable) {
          throw new RateLimitExhaustedError(attempt + 1, err);
        }
        throw err;
      }
      attempt++;
      // backoff: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      // Let caller reset workspace since prior attempt may have partially
      // mutated files via Bash.
      if (opts.onRetry) {
        opts.onRetry(opts.workingDirectory);
      }
    } finally {
      sem.release();
    }
  }

  throw new RateLimitExhaustedError(attempt + 1, lastErr);
}

// ---------------------------------------------------------------------------
// Legacy shape mapper
// ---------------------------------------------------------------------------

/**
 * Adapt AgentSdkResult to the legacy SkillTestResult shape so helpers that
 * expect the old `claude -p` output (extractToolSummary, etc) work unchanged.
 */
export function toSkillTestResult(r: AgentSdkResult): SkillTestResult {
  // Cost estimate: use SDK's authoritative cost; back-compute chars.
  // session-runner.ts:30 requires inputChars/outputChars/estimatedTokens.
  // These are rough; real consumers of CostEstimate use cost + turns.
  const outputChars = r.output.length;
  const inputChars = 0; // unknown from SDK path; not used for pass/fail
  const estimatedTokens = Math.round((inputChars + outputChars) / 4);

  // Build a flat transcript list mimicking the NDJSON shape:
  // parseNDJSON emits [{ type: 'assistant', message: {...} }, ...].
  // Use the SDK's assistantTurns directly since their shape matches.
  const transcript: unknown[] = r.events.slice();

  return {
    toolCalls: r.toolCalls,
    browseErrors: r.browseErrors,
    exitReason: r.exitReason,
    duration: r.durationMs,
    output: r.output,
    costEstimate: {
      inputChars,
      outputChars,
      estimatedTokens,
      estimatedCost: r.costUsd,
      turnsUsed: r.turnsUsed,
    },
    transcript,
    model: r.model,
    firstResponseMs: r.firstResponseMs,
    maxInterTurnMs: r.maxInterTurnMs,
  };
}

// ---------------------------------------------------------------------------
// Metric helpers (re-exported for fixtures)
// ---------------------------------------------------------------------------

/**
 * Count `tool_use` blocks in the first assistant turn of an SDK result.
 * Returns 0 if there is no first turn or no content array.
 *
 * This is the core "fanout" metric. A turn with N tool_use blocks = N
 * parallel tool invocations.
 */
export function firstTurnParallelism(firstTurn: SDKAssistantMessage | undefined): number {
  if (!firstTurn) return 0;
  const content = firstTurn.message?.content;
  if (!Array.isArray(content)) return 0;
  return (content as Array<{ type: string }>).filter((b) => b.type === 'tool_use').length;
}
