#!/usr/bin/env -S bun --no-env-file --config=/dev/null
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
 * Slug resolution (#3103): the fast path reads the slug in-process, from
 * GSTACK_PROJECT_SLUG or gstack-slug's versioned cache entry
 * (readVersionedSlugCache, the question-preference hook's reader); every skill
 * preamble runs gstack-slug, so a project that used gstack is a hit. On a
 * miss the hook spawns a detached copy of itself (`--repair <cwd>`) and
 * returns: through Git Bash on Windows, gstack-slug alone took 2.2-2.8 s, past
 * the 2 s budget, so the old synchronous spawn timed out on every Stop and
 * repaired nothing. The child runs gstack-slug with a long timeout (which
 * writes the cache) and repairs. Every repair, foreground or child, holds an
 * exclusive TTL lock in the state root, so one runs at a time. A per-cwd miss
 * marker keeps a directory gstack-slug cannot resolve from spawning a child
 * on every turn. windowsHide keeps both spawns from opening a console window.
 *
 * Correlation limits, on purpose: the preamble's session id is a shell-local
 * "$$-epoch", not the Claude session id this hook receives, so entries can't
 * be attributed to THIS session specifically. Closing every dangling entry in
 * the project is the repair semantics #2553 asks for; a concurrent session
 * mid-skill in the same project may get its entry closed early, which shows
 * up as a traceable source:"stop-hook" completion rather than a silent leak.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runBin } from './spawn-bin';
import { resolveStateRoot } from '../../../lib/state-root';
import { bunIsolationArgs } from '../../../lib/bun-isolation';
import { readVersionedSlugCache } from '../../../lib/bin-context';
import { logHookError as sharedLogHookError } from './hook-log';

const DEADLINE_MS = 2000;
/** A host may keep stdin open after its payload (#3628); never wait for EOF past this. */
const STDIN_DEADLINE_MS = 500;
const REPAIR_SLUG_TIMEOUT_MS = 30_000;
const LOCK_TTL_MS = 60_000;
const MISS_TTL_MS = 5 * 60_000;
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

function logHookError(msg: string): void {
  sharedLogHookError('timeline-stop-hook', msg);
}

interface TimelineEntry {
  skill?: string;
  event?: string;
  session?: string;
  branch?: string;
  ts?: string;
}

function stateDir(): string {
  return path.join(resolveStateRoot(), 'timeline-stop-hook');
}

function lockPath(): string {
  return path.join(stateDir(), 'repair.lock');
}

function isFresh(file: string, ttlMs: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/** Exclusive create; a lock older than LOCK_TTL_MS belongs to a dead repair and is taken over. */
function acquireRepairLock(): boolean {
  const lock = lockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || isFresh(lock, LOCK_TTL_MS)) return false;
      try {
        fs.unlinkSync(lock);
      } catch {
        // another process took it over first; the retry decides
      }
    }
  }
  return false;
}

function releaseRepairLock(): void {
  try {
    if (fs.readFileSync(lockPath(), 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath());
  } catch {
    // already gone
  }
}

function withRepairLock(fn: () => void): void {
  if (!acquireRepairLock()) return; // a repair is running; the next Stop picks up whatever it left
  try {
    fn();
  } finally {
    releaseRepairLock();
  }
}

/** GSTACK_PROJECT_SLUG, sanitized as gstack-slug does; an unusable pin is ignored. */
function slugOverride(): string | undefined {
  const slug = (process.env.GSTACK_PROJECT_SLUG || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return slug && slug !== '.' && slug !== '..' ? slug : undefined;
}

/** The Stop payload: returns at EOF, at the first complete JSON object, or at the deadline. */
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
      try {
        JSON.parse(buf);
        done();
      } catch {
        // incomplete payload: keep reading until EOF or the deadline
      }
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function readStopCwd(): Promise<string> {
  try {
    const stdin = await readStdinBounded(STDIN_DEADLINE_MS);
    if (stdin.trim()) {
      const payload = JSON.parse(stdin) as { cwd?: string };
      if (payload.cwd && fs.existsSync(payload.cwd)) return payload.cwd;
    }
  } catch {
    // Bad/absent stdin: fall through with process.cwd() — repair is still valid.
  }
  return process.cwd();
}

/**
 * Cache miss: hand the slow resolve to a detached copy of this hook and return
 * now. Skipped while a repair holds the lock, and for MISS_TTL_MS after the
 * last spawn for this cwd (the marker is written before the spawn, so a child
 * that fails to resolve is not respawned every turn).
 */
function spawnRepair(cwd: string): void {
  if (isFresh(lockPath(), LOCK_TTL_MS)) return;
  const marker = path.join(stateDir(), 'miss', createHash('sha256').update(cwd).digest('hex').slice(0, 16));
  if (isFresh(marker, MISS_TTL_MS)) return;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${cwd}\n`);
  const child = spawn(process.execPath, [...bunIsolationArgs(), fileURLToPath(import.meta.url), '--repair', cwd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => logHookError(`could not start the background repair: ${err.message}`));
  child.unref();
}

/** The detached child: resolve the slug with gstack-slug (which writes the cache), then repair. */
function backgroundRepair(cwd: string): void {
  withRepairLock(() => {
    const r = runBin('gstack-slug', [], { cwd, encoding: 'utf8', timeout: REPAIR_SLUG_TIMEOUT_MS, windowsHide: true });
    const slug = (r.stdout ?? '').toString().match(/^SLUG=([A-Za-z0-9._-]+)$/m)?.[1];
    if (!slug) {
      const why = r.error ? (r.error as NodeJS.ErrnoException).code ?? r.error.message : `exit ${r.status}`;
      logHookError(`could not resolve project slug for ${cwd} (gstack-slug: ${why}) — nothing repaired; retried after ${MISS_TTL_MS / 60_000} min`);
      return;
    }
    repairTimeline(slug, startedAt + LOCK_TTL_MS);
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === '--repair' && process.argv[3]) {
    backgroundRepair(process.argv[3]);
    return;
  }
  const cwd = await readStopCwd();
  const slug = slugOverride() ?? readVersionedSlugCache(resolveStateRoot(), cwd);
  if (!slug) {
    spawnRepair(cwd);
    return;
  }
  withRepairLock(() => repairTimeline(slug, startedAt + DEADLINE_MS));
}

/**
 * Append a completion for every dangling "started" in the project's timeline.
 * `deadline` (epoch ms) is re-checked before the write: the foreground hook's
 * 2 s budget, or for the background child the lock TTL, so a write never lands
 * after the lock could have been taken over.
 */
function repairTimeline(slug: string, deadline: number): void {
  const timelinePath = path.join(resolveStateRoot(), 'projects', slug, 'timeline.jsonl');
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

  if (Date.now() > deadline) {
    logHookError('time budget exhausted before write — skipped (fail-open)');
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

main()
  .catch((err) => logHookError(`unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
  .finally(() => process.exit(0));
