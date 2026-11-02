#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * investigate-gate — /investigate's opt-in reproduce-first gate (GST-938 plan v3).
 * Declared in investigate/SKILL.md.tmpl frontmatter, so Claude Code registers it
 * only after /investigate runs. Every event is a no-op unless the config key
 * `investigate_gates` is `true` (lib/investigate-gate.ts gatesEnabled).
 *
 *   PreToolUse Edit|Write|NotebookEdit  deny a tracked non-test edit until a
 *                                       reproduction is bound or the escape logged
 *   PreToolUse Bash                     add --session to gstack-investigate-step
 *                                       calls; deny obvious Bash writes to source
 *   PostToolUse(Failure) Bash           record command, exit, tail and source delta;
 *                                       a source change before binding is a bypass
 *
 * FAIL-OPEN: a crash, bad payload or busy lock allows the call and logs to
 * hook-errors.log. The gate measures a habit; it is not a security boundary.
 */
import {
  bashSourceWrite, currentInvestigation, denyReason, exitFromPayload, fingerprintDelta, gatesEnabled, HELPER,
  isBackground, isTrackedSource, openInvestigation, outputTail, repoTop, sourceFingerprint, statePath, unlocked, withState,
} from '../../../lib/investigate-gate';
import { logHookError } from './hook-log';

const STDIN_DEADLINE_MS = 500;

interface Payload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: unknown;
  is_interrupt?: unknown;
}

function readStdinBounded(ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.destroy();
      resolve(buf);
    };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
      try { JSON.parse(buf); done(); } catch { /* keep reading */ }
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function emit(obj: object): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function deny(reason: string): void {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

/** Insert --session after each helper call that lacks one, so the record-only bin knows its session. */
export function withSession(command: string, session: string): string | null {
  if (!command.includes(HELPER) || /--session(\s|=)/.test(command)) return null;
  const quoted = /^[A-Za-z0-9._-]+$/.test(session) ? session : `'${session.replace(/'/g, "'\\''")}'`;
  return command.replace(new RegExp(`(\\S*${HELPER})(?=\\s|$)`, 'g'), `$1 --session ${quoted}`);
}

function handle(p: Payload): void {
  const event = p.hook_event_name ?? '';
  const session = p.session_id ?? '';
  const cwd = p.cwd || process.cwd();
  const input = p.tool_input ?? {};
  if (!session || !gatesEnabled()) return;
  const top = repoTop(cwd);
  if (!top) return;
  const now = new Date().toISOString();
  withState(statePath(top, session), top, session, (state) => {
    const inv = currentInvestigation(state) ?? (state.investigations.length === 0 ? openInvestigation(state, now) : undefined);
    if (event === 'PreToolUse' && p.tool_name !== 'Bash') {
      const file = String(input.file_path ?? input.notebook_path ?? '');
      if (!file || unlocked(inv) || !isTrackedSource(top, cwd, file)) return;
      inv!.denials++;
      deny(denyReason(file));
      return;
    }
    if (event === 'PreToolUse') {
      const command = String(input.command ?? '');
      const rewritten = withSession(command, session);
      if (rewritten) {
        emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, command: rewritten } } });
        return;
      }
      if (unlocked(inv)) return;
      const why = bashSourceWrite(command, (f) => isTrackedSource(top, cwd, f));
      if (!why) return;
      inv!.denials++;
      deny(denyReason(why));
      return;
    }
    if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && p.tool_name === 'Bash' && inv) {
      const command = String(input.command ?? '');
      const delta = fingerprintDelta(inv.baseline, sourceFingerprint(top));
      const prior = inv.runs.length ? inv.runs[inv.runs.length - 1].delta : [];
      inv.runs.push({ ts: now, command, exit: exitFromPayload(event, p), background: isBackground(command, input.run_in_background === true), tail: outputTail(event, p), delta });
      if (!inv.hypothesis && delta.join('\0') !== prior.join('\0') && delta.length > 0) {
        inv.bypasses.push({ ts: now, kind: 'bash-edit', detail: `${command.slice(0, 200)} changed ${delta.join(', ')}` });
      }
    }
  });
}

async function main(): Promise<void> {
  try {
    const raw = await readStdinBounded(STDIN_DEADLINE_MS);
    if (!raw.trim()) return;
    handle(JSON.parse(raw) as Payload);
  } catch (err) {
    logHookError('investigate-gate', err instanceof Error ? err.message : String(err));
  }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
