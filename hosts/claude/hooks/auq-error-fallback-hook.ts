#!/usr/bin/env bun
/**
 * PostToolUse hook for AskUserQuestion — runtime reliability layer for the
 * AUQ-failure prose fallback (OV3:B).
 *
 * When an AskUserQuestion call comes back as an ERROR / missing result (the
 * Conductor MCP bug returns `[Tool result missing due to internal error]`), this
 * hook injects `additionalContext` reminding the model of the failure-fallback
 * rule, tailored to the session kind. It does NOT render the prose itself — the
 * model still emits it. The hook only guarantees the reminder fires at the moment
 * of failure, instead of relying on the model noticing the error result and
 * recalling the echoed SESSION_KIND.
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
import { spawnSync } from 'child_process';

interface HookStdin {
  tool_name?: string;
  tool_response?: unknown;
  cwd?: string;
}

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

/**
 * Decide whether the tool_response is an ERROR / missing result rather than a
 * real answer. Conservative: only flag clear failure shapes, so a successful
 * AskUserQuestion (which carries the user's choice) is never misread as failure.
 */
export function isErrorResponse(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  if (typeof response === 'string') {
    const s = response.trim();
    if (s === '') return true;
    // Match ONLY the specific missing-result sentinel phrase, not any string that
    // merely contains "error" — a real answer like "Investigate the internal error"
    // must NOT trigger the fallback. (Codex review finding.)
    return /tool result missing/i.test(s);
  }
  if (typeof response === 'object') {
    const rec = response as Record<string, unknown>;
    // Structured flag must be the boolean true — not the substring "is_error" inside
    // a serialized success payload like '{"is_error": false}'.
    if (rec.is_error === true || rec.isError === true) return true;
    if (typeof rec.error === 'string' && rec.error.trim() !== '') return true;
    // Some hosts wrap the payload as { content: "..." } or { content: [{text}] }.
    const content = rec.content;
    if (typeof content === 'string') return /tool result missing/i.test(content);
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (typeof c === 'string' ? c : (c as Record<string, unknown>)?.text ?? ''))
        .join(' ');
      return /tool result missing/i.test(text);
    }
  }
  return false;
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
export function directiveFor(kind: 'spawned' | 'headless' | 'interactive'): string {
  const lead =
    'The AskUserQuestion call did not return a usable answer (error / missing result). ' +
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
      return (
        lead +
        'SESSION_KIND=interactive — render the decision as a PROSE message now: a clear ELI10 of the issue, ' +
        'then a Recommendation line, then ONE paragraph per choice carrying its `(recommended)` marker, its ' +
        '`Completeness: X/10`, and 2-4 sentences of reasoning. Tell the user to reply with a letter, then STOP. ' +
        '(Retry the call once first only if no answer could have surfaced.)'
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

  if (!isErrorResponse(stdin.tool_response)) return defer();

  inject(directiveFor(sessionKind(stdin.cwd)));
}

// Only run the stdin→stdout pipeline when executed as a hook, not when imported
// by the unit test (which exercises the exported pure functions).
if (import.meta.main) {
  main().catch((e) => {
    logHookError(`main crash: ${(e as Error).message}`);
    defer();
  });
}
