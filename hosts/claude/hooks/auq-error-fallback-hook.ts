#!/usr/bin/env bun
/**
 * PostToolUse hook for AskUserQuestion — runtime reliability layer for the
 * AUQ-failure prose fallback (OV3:B).
 *
 * When an AskUserQuestion call returns an explicit error, this hook injects
 * `additionalContext` tailored to the session kind. Conductor returns structured
 * `CONDUCTOR_ASK_USER_QUESTION_*` errors with a retryable flag; the generic Claude
 * SDK `[Tool result missing due to internal error]` placeholder is deliberately
 * ignored because it does not prove that popup delivery failed.
 *
 * DEFENSIVE / INERT-IF-UNSUPPORTED: it is unverified whether Claude Code invokes
 * PostToolUse hooks when an MCP tool returns a transport/missing-result error (we
 * could not force that Conductor-internal failure in a harness — see
 * docs/spikes/claude-code-hook-mutation.md §"PostToolUse on tool error"). If the
 * platform does NOT fire the hook on that path, this is simply never invoked — no
 * harm; the prompt-level fallback in generate-ask-user-format.ts still covers it.
 * On a SUCCESSFUL AskUserQuestion (a real answer), the hook defers (no output).
 *
 * Triggered by ~/.claude/settings.json (registered by `setup` next to
 * question-log-hook):
 *   PostToolUse matcher "(AskUserQuestion|mcp__.*__AskUserQuestion)"
 *
 * Invariants:
 *   - Always exits 0. A failing hook MUST NOT block the user's session.
 *   - Never triggers on a successful answer (would corrupt a normal AUQ).
 *   - Errors land in ~/.gstack/hook-errors.log.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

interface HookStdin {
  session_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  cwd?: string;
}

export type ResponseOutcome =
  | 'success'
  | 'cancelled'
  | 'ambiguous-placeholder'
  | 'retryable-error'
  | 'non-retryable-error';

export interface ResponseClassification {
  outcome: ResponseOutcome;
  code?: string;
}

const SDK_MISSING_RESULT_RE = /^\[?tool result missing due to internal error\]?\.?$/i;
const CONDUCTOR_CODE_RE = /CONDUCTOR_ASK_USER_QUESTION_[A-Z_]+/;
const RETRYABLE_CONDUCTOR_CODES = new Set([
  'CONDUCTOR_ASK_USER_QUESTION_DELIVERY_FAILED',
  'CONDUCTOR_ASK_USER_QUESTION_MALFORMED_ANSWERS',
  'CONDUCTOR_ASK_USER_QUESTION_ANSWER_COUNT_MISMATCH',
]);

function stateRoot(): string {
  return (
    process.env.GSTACK_STATE_ROOT ||
    process.env.GSTACK_HOME ||
    path.join(os.homedir(), '.gstack')
  );
}

function logHookError(msg: string): void {
  try {
    const sr = stateRoot();
    fs.mkdirSync(sr, { recursive: true });
    fs.appendFileSync(
      path.join(sr, 'hook-errors.log'),
      `${new Date().toISOString()} auq-error-fallback-hook: ${msg}\n`,
    );
  } catch {
    // last-resort swallow
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 2000);
  });
}

/** No-op output — let the tool result stand untouched. */
function defer(): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse' } }),
  );
  process.exit(0);
}

function inject(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
    }),
  );
  process.exit(0);
}

function responseText(response: unknown): string {
  if (typeof response === 'string') return response.trim();
  if (!response || typeof response !== 'object') return '';
  const rec = response as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.error === 'string') parts.push(rec.error);
  if (typeof rec.content === 'string') parts.push(rec.content);
  if (Array.isArray(rec.content)) {
    for (const item of rec.content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object') {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('\n').trim();
}

/** Classify the result without confusing SDK bookkeeping with a host failure. */
export function classifyResponse(response: unknown): ResponseClassification {
  if (response === null || response === undefined) return { outcome: 'non-retryable-error' };

  const text = responseText(response);
  if (text === '') {
    if (typeof response === 'string') return { outcome: 'non-retryable-error' };
  }

  if (SDK_MISSING_RESULT_RE.test(text)) return { outcome: 'ambiguous-placeholder' };
  if (/^User responses:/i.test(text)) return { outcome: 'success' };

  const code = text.match(CONDUCTOR_CODE_RE)?.[0];
  if (code === 'CONDUCTOR_ASK_USER_QUESTION_USER_CANCELLED') {
    return { outcome: 'cancelled', code };
  }
  if (code) {
    const retryable = RETRYABLE_CONDUCTOR_CODES.has(code) && /Retryable:\s*yes/i.test(text);
    return { outcome: retryable ? 'retryable-error' : 'non-retryable-error', code };
  }

  if (response && typeof response === 'object') {
    const rec = response as Record<string, unknown>;
    if (rec.is_error === true || rec.isError === true) return { outcome: 'non-retryable-error' };
    if (typeof rec.error === 'string' && rec.error.trim() !== '') {
      return { outcome: 'non-retryable-error' };
    }
  }

  return { outcome: 'success' };
}

export function isErrorResponse(response: unknown): boolean {
  const outcome = classifyResponse(response).outcome;
  return outcome === 'retryable-error' || outcome === 'non-retryable-error';
}

function retryMarker(stdin: HookStdin): string | undefined {
  if (!stdin.session_id || stdin.tool_input === undefined) return undefined;
  const digest = createHash('sha256')
    .update(`${stdin.tool_name || ''}\n${stableJson(stdin.tool_input)}`)
    .digest('hex')
    .slice(0, 20);
  return path.join(stateRoot(), 'sessions', stdin.session_id, `.auq-retry-${digest}`);
}

/** Canonical JSON keeps a semantically identical retry on the same marker even
 * when the SDK/model emits object keys in a different order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Returns true exactly once for a given session + question payload. */
function claimRetry(stdin: HookStdin): boolean {
  const marker = retryMarker(stdin);
  if (!marker) return false;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    const fd = fs.openSync(marker, 'wx');
    fs.writeFileSync(fd, `${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'EEXIST') logHookError(`retry marker failed: ${(e as Error).message}`);
    return false;
  }
}

function clearRetry(stdin: HookStdin): void {
  const marker = retryMarker(stdin);
  if (!marker) return;
  try {
    fs.rmSync(marker, { force: true });
  } catch (e) {
    logHookError(`retry marker cleanup failed: ${(e as Error).message}`);
  }
}

/** Resolve SESSION_KIND via the shared helper (same classification the preamble
 *  echoes). Falls back to 'interactive' (degrade-safe) on any failure. */
export function sessionKind(cwd?: string): 'spawned' | 'headless' | 'interactive' {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const bin = path.resolve(here, '..', '..', '..', 'bin', 'gstack-session-kind');
    const res = spawnSync(bin, [], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
    });
    const out = (res.stdout || '').trim();
    if (out === 'spawned' || out === 'headless' || out === 'interactive') return out;
  } catch (e) {
    logHookError(`sessionKind failed: ${(e as Error).message}`);
  }
  return 'interactive';
}

/** The directive injected per session kind. Exported for unit testing. */
export function directiveFor(
  kind: 'spawned' | 'headless' | 'interactive',
  action: 'retry' | 'fallback' = 'fallback',
  code?: string,
): string {
  const codeNote = code ? ` (${code})` : '';
  const lead =
    `The AskUserQuestion call returned an explicit error${codeNote}. ` +
    'Per the AskUserQuestion failure-fallback rule: ';
  switch (kind) {
    case 'spawned':
      return (
        lead +
        'SESSION_KIND=spawned — auto-choose the recommended option per the Spawned session block. ' +
        'Do not emit prose, do not BLOCK.'
      );
    case 'headless':
      return (
        lead +
        'SESSION_KIND=headless — report `BLOCKED — AskUserQuestion unavailable` and stop; no human can answer.'
      );
    case 'interactive':
    default:
      if (action === 'retry') {
        return (
          lead +
          'SESSION_KIND=interactive — retry the SAME AskUserQuestion exactly once with identical ' +
          'questions and plain-string options. Do not emit prose yet. If the retry returns `User responses`, ' +
          'resume the workflow exactly once. If it fails again, follow the prose fallback from the next hook result.'
        );
      }
      return (
        lead +
        'SESSION_KIND=interactive — render the decision as a PROSE message now: a clear ELI10 of the issue, ' +
        'then a Recommendation line, then ONE paragraph per choice carrying its `(recommended)` marker, its ' +
        '`Completeness: X/10`, and 2-4 sentences of reasoning. Tell the user to reply with a letter, then STOP. ' +
        'Do not call AskUserQuestion again for this decision.'
      );
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return defer();

  let stdin: HookStdin;
  try {
    stdin = JSON.parse(raw);
  } catch (e) {
    logHookError(`stdin parse failed: ${(e as Error).message}`);
    return defer();
  }

  const toolName = stdin.tool_name || '';
  if (toolName !== 'AskUserQuestion' && !/^mcp__.+__AskUserQuestion$/.test(toolName)) {
    return defer();
  }

  const classification = classifyResponse(stdin.tool_response);
  if (classification.outcome === 'success' || classification.outcome === 'cancelled') {
    clearRetry(stdin);
    return defer();
  }
  if (classification.outcome === 'ambiguous-placeholder') return defer();

  const kind = sessionKind(stdin.cwd);
  const action =
    classification.outcome === 'retryable-error' && kind === 'interactive' && claimRetry(stdin)
      ? 'retry'
      : 'fallback';
  inject(directiveFor(kind, action, classification.code));
}

// Only run the stdin→stdout pipeline when executed as a hook, not when imported
// by the unit test (which exercises the exported pure functions).
if (import.meta.main) {
  main().catch((e) => {
    logHookError(`main crash: ${(e as Error).message}`);
    defer();
  });
}
