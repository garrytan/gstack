/**
 * skill-gates — what the opt-in enforcement hooks share (GST-1461): the
 * GSTACK_GATE marker line, the per-session record that counts markers, the
 * session lock, the hook output shapes and the fail-open runner.
 *
 *   marker  GSTACK_GATE <hook> <event> session=<sid> [k=v ...]
 *   record  $GSTACK_STATE_ROOT/skill-gates/<session>/record.json (0600, atomic)
 *   trace   $GSTACK_STATE_ROOT/hooks/<hook>.log (one line per marker)
 *
 * A hook error never blocks and never goes unrecorded: runGateHook catches
 * every throw and its own deadline, writes an \`error code=<CODE>\` marker to the
 * record, the trace, stderr and the transcript (systemMessage), and exits 0.
 * Docs: docs/skill-gates.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteSync } from './fs-atomic';
import { resolveStateRoot } from './state-root';
import { appendHookTrace, readStdinBounded, type TraceHook } from './skill-route';

export type GateHook = 'investigate-gate' | 'ceo-review-gate';
export type GateEvent = 'fired' | 'blocked' | 'released' | 'observed' | 'exhausted' | 'skipped' | 'error';
export const GATE_DOC = 'docs/skill-gates.md';
export const DEADLINE_MS = 5000;
/** The most GSTACK_SKILL_GATE_DEADLINE_MS can set; a larger value is clamped to it. */
export const DEADLINE_MAX_MS = 20_000;
const STDIN_CAP_BYTES = 1024 * 1024;
const STDIN_DEADLINE_MS = 500;
const LOCK_WAIT_MS = 3000;
/** What a hook needs beyond its deadline: Bun startup before the timer starts, and the GATE_TIMEOUT marker write, which can wait out the session lock. */
export const HOOK_MARGIN_MS = LOCK_WAIT_MS + 2000;
/**
 * The timeout, in seconds, on every gate hook registration (gstack-skill-gates
 * settings, and ./setup through `gstack-skill-gates hook-timeout`). Claude Code
 * kills a hook at its timeout and lets the stop or call through with no marker,
 * so the registration must outlive the longest deadline plus the margin.
 */
export const HOOK_TIMEOUT_S = Math.ceil((DEADLINE_MAX_MS + HOOK_MARGIN_MS) / 1000);

/** The hook's deadline: GSTACK_SKILL_GATE_DEADLINE_MS when positive, clamped to DEADLINE_MAX_MS, else DEADLINE_MS. */
export function deadlineFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.GSTACK_SKILL_GATE_DEADLINE_MS);
  return ms > 0 ? Math.min(ms, DEADLINE_MAX_MS) : DEADLINE_MS;
}
const LOCK_STALE_MS = 30_000;
const SESSION_DIRS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

let deadlineAt = Number.POSITIVE_INFINITY;
let deadlineMs = DEADLINE_MS;
/** Throw GATE_TIMEOUT once the hook's deadline has passed; returns the milliseconds left. Sync work (git calls) checks this, since the timer cannot fire during it. */
export function remainingMs(): number {
  const left = deadlineAt - Date.now();
  if (left <= 0) throw new GateError('GATE_TIMEOUT', `timed out after ${deadlineMs} ms`);
  return left;
}

/** A failure with a code from docs/skill-gates.md#error-codes. */
export class GateError extends Error {
  constructor(readonly code: string, why: string) { super(why); }
}

export const cleanSessionId = (sid: string) => sid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
const markerValue = (v: string | number) => String(v).replace(/\s+/g, '_').slice(0, 240);

export function gateMarker(hook: GateHook, event: GateEvent, sessionId: string, fields: Record<string, string | number> = {}): string {
  return ['GSTACK_GATE', hook, event, `session=${cleanSessionId(sessionId)}`, ...Object.entries(fields).map(([k, v]) => `${k}=${markerValue(v)}`)].join(' ');
}

export interface GateRun {
  skill: string;
  load_line: number;
  fired_at: string;
  released_at?: string;
  cause?: string;
  /** the output file that met the gate (ceo-review-gate) */
  file?: string;
  /** the subagent transcript's basename, for a run gated at SubagentStop */
  agent?: string;
  blocked: number;
  observed: number;
  exhausted_at?: string;
}
export interface GateHookRecord { runs: Record<string, GateRun>; errors: Array<{ at: string; code: string; why: string }>; skipped: Record<string, string> }
export interface GateRecord { version: 1; session_id: string; transcript_path: string; hooks: Partial<Record<GateHook, GateHookRecord>> }

export function gatesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateRoot(env), 'skill-gates');
}
export function sessionDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(gatesRoot(env), cleanSessionId(sessionId));
}
export const recordPath = (sessionId: string, env: NodeJS.ProcessEnv = process.env) => path.join(sessionDir(sessionId, env), 'record.json');

export function readGateRecord(file: string, sessionId: string): GateRecord {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, session_id: sessionId, transcript_path: '', hooks: {} };
    throw new GateError('GATE_STATE', `cannot read ${file} (${(e as Error).message})`);
  }
  try {
    const rec = JSON.parse(text);
    if (rec?.version !== 1 || typeof rec.hooks !== 'object' || rec.hooks === null) throw new Error('not a version 1 record');
    return rec as GateRecord;
  } catch (e) {
    throw new GateError('GATE_STATE', `corrupt record ${file} (${(e as Error).message})`);
  }
}

export function writeGateRecord(file: string, rec: GateRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteSync(file, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    throw new GateError('GATE_STATE', `cannot write ${file} (${(e as Error).message})`);
  }
}

export function hookRecord(rec: GateRecord, hook: GateHook): GateHookRecord {
  const h = rec.hooks[hook] ?? { runs: {}, errors: [], skipped: {} };
  h.skipped ??= {};
  rec.hooks[hook] = h;
  return h;
}

/** Run fn holding the session's O_EXCL lock; a lock older than LOCK_STALE_MS (a killed hook) is taken over. */
export function withSessionLock<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'lock');
  const start = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new GateError('GATE_STATE', `cannot take ${lock} (${(e as Error).message})`);
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new GateError('GATE_LOCKED', `${lock} held for over ${LOCK_WAIT_MS} ms`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Delete session dirs untouched for SESSION_DIRS_KEPT_MS (they hold copies of dirty source files). Best effort. */
export function pruneSessionDirs(keep: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const root = gatesRoot(env);
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (dir === keep) continue;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > SESSION_DIRS_KEPT_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* raced with another session */ }
    }
  } catch { /* no root yet */ }
}

/** One marker: a trace line, and the marker text for the transcript. */
export function note(hook: GateHook, event: GateEvent, sessionId: string, fields: Record<string, string | number> = {}): string {
  appendHookTrace(hook as TraceHook, sessionId, { event, ...fields }, event === 'error');
  return gateMarker(hook, event, sessionId, fields);
}

export type HookOutput = Record<string, unknown>;
export const systemMessage = (lines: string[]): HookOutput | undefined => (lines.length ? { systemMessage: lines.join('\n') } : undefined);
export const denyTool = (reason: string, extra: string[] = []): HookOutput =>
  ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }, ...(extra.length ? { systemMessage: extra.join('\n') } : {}) });
export const blockWith = (reason: string, extra: string[] = []): HookOutput => ({ decision: 'block', reason, ...(extra.length ? { systemMessage: extra.join('\n') } : {}) });

export interface GatePayload { raw: Record<string, unknown>; sessionId: string; transcriptPath: string; event: string; cwd: string }

/**
 * The hook entry point: switch check, bounded stdin, payload shape, deadline,
 * then handler. Any GateError or throw becomes an error marker and exit 0.
 */
export async function runGateHook(hook: GateHook, isOn: () => boolean, handler: (p: GatePayload) => HookOutput | undefined): Promise<void> {
  let sessionId = 'unknown';
  let done = false;
  const fail = (code: string, why: string) => {
    if (done) return;
    done = true;
    const marker = note(hook, 'error', sessionId, { code, why });
    try {
      if (sessionId !== 'unknown') {
        const file = recordPath(sessionId);
        withSessionLock(path.dirname(file), () => {
          const rec = readGateRecord(file, sessionId);
          hookRecord(rec, hook).errors.push({ at: new Date().toISOString(), code, why });
          writeGateRecord(file, rec);
        });
      }
    } catch { /* the trace and stderr still carry it */ }
    process.stderr.write(`${marker} (stop and edits allowed; see ${GATE_DOC}#${code.toLowerCase().replace(/_/g, '-')})\n`);
    process.stdout.write(JSON.stringify({ systemMessage: marker }));
  };
  deadlineMs = deadlineFromEnv();
  deadlineAt = Date.now() + deadlineMs;
  const timer = setTimeout(() => { fail('GATE_TIMEOUT', `timed out after ${deadlineMs} ms`); process.exit(0); }, deadlineMs);
  try {
    if (!isOn()) return;
    const stdin = await readStdinBounded(STDIN_CAP_BYTES, STDIN_DEADLINE_MS);
    if (stdin.overCap) throw new GateError('GATE_BAD_PAYLOAD', `hook payload over ${STDIN_CAP_BYTES} bytes`);
    let raw: unknown;
    try { raw = JSON.parse(stdin.text); } catch { throw new GateError('GATE_BAD_PAYLOAD', 'hook payload is not JSON'); }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new GateError('GATE_BAD_PAYLOAD', 'hook payload is not a JSON object');
    const p = raw as Record<string, unknown>;
    if (typeof p.session_id !== 'string' || !p.session_id) throw new GateError('GATE_BAD_PAYLOAD', 'payload has no session_id');
    sessionId = p.session_id;
    if (typeof p.transcript_path !== 'string' || !p.transcript_path) throw new GateError('GATE_BAD_PAYLOAD', 'payload has no transcript_path');
    const out = handler({ raw: p, sessionId, transcriptPath: p.transcript_path, event: String(p.hook_event_name ?? ''), cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd() });
    if (done) return;
    done = true;
    if (out) await new Promise<void>(resolve => process.stdout.write(JSON.stringify(out), () => resolve()));
  } catch (e) {
    if (e instanceof GateError) fail(e.code, e.message);
    else fail('GATE_UNEXPECTED', `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}
