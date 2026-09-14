#!/usr/bin/env bun
/**
 * Stop hook: close dangling "started" timeline entries (#2553).
 *
 * The preamble writes {"skill":X,"event":"started",...} at every skill start;
 * the completion write lives in prose at the END of the skill workflow and is
 * unenforceable — an interrupted session, a context blowout, or an agent that
 * simply stops leaves started > completed forever, and the leak is
 * unrepairable after the fact. This hook runs on Claude Code's Stop event and
 * appends event:"completed" (outcome "unknown", source "stop-hook") for every
 * "started" entry in the project's timeline that has no matching "completed".
 *
 * FAIL-OPEN CONTRACT (F5) — a telemetry repair must never block a session:
 *   - ALWAYS exits 0, whatever happens (corrupt timeline, missing file, bad
 *     stdin, unreadable slug). Errors go to ~/.gstack/hook-errors.log,
 *     best-effort.
 *   - Internal time budget (~2s): work is bounded up front — the timeline is
 *     skipped entirely over a size cap, only the last TAIL_WINDOW_BYTES are
 *     read and parsed (P3: this hook runs on EVERY Stop event machine-wide,
 *     and a full read+parse scaled to the cap at ~100-300ms/turn), and the
 *     deadline is re-checked before the write. Claude Code's own hook
 *     timeout is the outer belt.
 *   - Append-only: never rewrites timeline.jsonl.
 *   - Tail-window semantics: a dangling "started" older than the last 256KB
 *     of appends belongs to a session long gone — beyond repair interest.
 *     A "completed" is always appended AFTER its "started", so any started
 *     inside the window has its completion inside the window too: the window
 *     can never fabricate a dangling entry, and idempotency holds.
 *
 * Correlation limits, on purpose: the preamble's session id is a shell-local
 * "$$-epoch", not the Claude session id this hook receives, so entries can't
 * be attributed to THIS session specifically. Closing every dangling entry in
 * the project is the repair semantics #2553 asks for; a concurrent session
 * mid-skill in the same project may get its entry closed early, which shows
 * up as a traceable source:"stop-hook" completion rather than a silent leak.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBin } from './spawn-bin';

const DEADLINE_MS = 2000;
const MAX_TIMELINE_BYTES = 10 * 1024 * 1024;
const TAIL_WINDOW_BYTES = 256 * 1024;
const startedAt = Date.now();

/**
 * Read only the last TAIL_WINDOW_BYTES of the timeline (P3). When the window
 * starts mid-file, the first (partial) line is discarded — its entry is
 * outside the window by definition. Throws on I/O errors; the caller owns
 * the fail-open handling.
 */
function readTimelineTail(timelinePath: string, size: number): string {
  const fd = fs.openSync(timelinePath, 'r');
  try {
    const offset = Math.max(0, size - TAIL_WINDOW_BYTES);
    const length = size - offset;
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, offset);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function stateRoot(): string {
  return process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack');
}

function logHookError(msg: string): void {
  try {
    const root = stateRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(
      path.join(root, 'hook-errors.log'),
      `${new Date().toISOString()} timeline-stop-hook: ${msg}\n`,
    );
  } catch {
    // best-effort; never block the session because logging failed
  }
}

interface TimelineEntry {
  skill?: string;
  event?: string;
  session?: string;
  branch?: string;
  ts?: string;
}

function main(): void {
  let cwd = process.cwd();
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) {
      const payload = JSON.parse(stdin) as { cwd?: string };
      if (payload.cwd && fs.existsSync(payload.cwd)) cwd = payload.cwd;
    }
  } catch {
    // Bad/absent stdin: fall through with process.cwd() — repair is still valid.
  }

  // Resolve the project slug the same way the preamble did (GSTACK_PROJECT_SLUG
  // override, project-root walk, remote-derived slug).
  let slug = '';
  try {
    const r = runBin('gstack-slug', [], { cwd, encoding: 'utf8', timeout: DEADLINE_MS });
    const m = (r.stdout ?? '').toString().match(/^SLUG=([A-Za-z0-9._-]+)$/m);
    if (m) slug = m[1];
  } catch {
    // fall through
  }
  if (!slug) {
    logHookError('could not resolve project slug — nothing repaired');
    return;
  }

  const timelinePath = path.join(stateRoot(), 'projects', slug, 'timeline.jsonl');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(timelinePath);
  } catch {
    return; // no timeline — nothing to repair
  }
  if (stat.size === 0) return;
  if (stat.size > MAX_TIMELINE_BYTES) {
    logHookError(`timeline over size cap (${stat.size} bytes) — skipped (fail-open)`);
    return;
  }

  let raw: string;
  try {
    raw = readTimelineTail(timelinePath, stat.size);
  } catch (err) {
    logHookError(`could not read timeline: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Corrupt LINES are skipped individually; a fully corrupt file repairs nothing.
  //
  // COUNT started vs completed per key rather than treating completed as a
  // set: keys are not unique per run — legacy entries with no session field
  // all share the bare-skill key, and the preamble's "$$-epoch" session ids
  // can collide within the same second. With set semantics, a key where one
  // run completed and another dangles was NEVER repaired (the lone
  // completion masked every dangler forever). Closing the count DIFFERENCE
  // repairs exactly the open runs and stays idempotent: the appended
  // completions balance the counts, so the next Stop appends nothing.
  const startedCount = new Map<string, number>();
  const firstStarted = new Map<string, TimelineEntry>();
  const completedCount = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: TimelineEntry;
    try {
      entry = JSON.parse(line) as TimelineEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry.skill !== 'string') continue;
    const key = `${entry.skill}\u0000${entry.session ?? ''}`;
    if (entry.event === 'started') {
      startedCount.set(key, (startedCount.get(key) ?? 0) + 1);
      if (!firstStarted.has(key)) firstStarted.set(key, entry);
    }
    if (entry.event === 'completed') {
      completedCount.set(key, (completedCount.get(key) ?? 0) + 1);
    }
  }

  const dangling: Array<[string, TimelineEntry]> = [];
  for (const [key, count] of startedCount) {
    const open = count - (completedCount.get(key) ?? 0);
    const entry = firstStarted.get(key);
    if (!entry) continue;
    for (let i = 0; i < open; i++) dangling.push([key, entry]);
  }
  if (dangling.length === 0) return;

  if (Date.now() - startedAt > DEADLINE_MS) {
    logHookError('internal 2s budget exhausted before write — skipped (fail-open)');
    return;
  }

  const now = new Date().toISOString();
  const lines = dangling
    .map(([, entry]) =>
      JSON.stringify({
        skill: entry.skill,
        event: 'completed',
        ...(entry.branch ? { branch: entry.branch } : {}),
        outcome: 'unknown',
        source: 'stop-hook',
        ...(entry.session ? { session: entry.session } : {}),
        ts: now,
      }),
    )
    .join('\n');
  try {
    fs.appendFileSync(timelinePath, lines + '\n');
  } catch (err) {
    logHookError(`could not append completions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  main();
} catch (err) {
  logHookError(`unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
process.exit(0);
