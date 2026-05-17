#!/usr/bin/env bun
/**
 * camera-watch — convert "phone uploaded a reference photo" into a stdout
 * notification the cad-coder skill / Claude Code harness can react to.
 *
 * The Python upload server (cad-coder/zeroentropy/server.py) accepts JPEGs at
 * POST /camera/upload?session=ABCD and stores them at $CAD_CAMERA_DIR/<CODE>.jpg
 * (default /tmp/cad-reference/<CODE>.jpg). This watcher prints a single line
 * per upload so that an agent running it with `run_in_background: true` gets
 * notified by the harness as soon as a photo arrives — no user message needed.
 *
 * Two modes, transparent to the caller:
 *   1. HTTP long-poll against /camera/wait. Wakes within milliseconds of an
 *      upload because the FastAPI handler signals an asyncio.Event.
 *   2. Filesystem polling on $CAD_CAMERA_DIR. Used when the HTTP server is
 *      unreachable or --no-http is set. Works even if the server is down.
 *
 * Usage:
 *   bun cad-coder/scripts/camera-watch.ts --session ABCD --once
 *   bun cad-coder/scripts/camera-watch.ts --session ABCD --json --timeout-s 120
 *
 * Output (per upload):
 *   text:  IMAGE_RECEIVED session=ABCD path=/tmp/cad-reference/ABCD.jpg size=12345 received_at=2026-05-16T17:20:00.000Z
 *   json:  {"event":"image_received","session":"ABCD","path":"...","size":12345,"received_at":"..."}
 *
 * On --timeout-s expiry with no upload (text mode):
 *   IMAGE_TIMEOUT session=ABCD waited_s=120
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export type CameraWatchOptions = {
  session: string;
  dir: string;
  serverUrl: string | null;
  intervalMs: number;
  timeoutS: number;
  json: boolean;
  once: boolean;
  sinceMtime: number;
  longPollSeconds: number;
};

export type CameraEvent = {
  event: 'image_received';
  session: string;
  path: string;
  size: number;
  receivedAt: string; // ISO 8601
  receivedAtUnix: number;
};

export type TimeoutEvent = {
  event: 'timeout';
  session: string;
  waitedSeconds: number;
};

export type WatcherOutput = CameraEvent | TimeoutEvent;

const DEFAULT_DIR = process.env.CAD_CAMERA_DIR || '/tmp/cad-reference';
const DEFAULT_SERVER_URL = process.env.CAD_CAMERA_SERVER_URL || 'http://127.0.0.1:8000';
const DEFAULT_INTERVAL_MS = Number(process.env.CAD_CAMERA_INTERVAL_MS || 1500);
const DEFAULT_LONG_POLL_SECONDS = 30;

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function parseArgs(argv: string[]): CameraWatchOptions {
  const options: CameraWatchOptions = {
    session: process.env.CAD_CAMERA_SESSION || 'DEFAULT',
    dir: DEFAULT_DIR,
    serverUrl: DEFAULT_SERVER_URL,
    intervalMs: DEFAULT_INTERVAL_MS,
    timeoutS: 0,
    json: false,
    once: false,
    sinceMtime: 0,
    longPollSeconds: DEFAULT_LONG_POLL_SECONDS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--session') options.session = next();
    else if (arg === '--dir') options.dir = resolve(expandHome(next()));
    else if (arg === '--server-url') options.serverUrl = next();
    else if (arg === '--no-http') options.serverUrl = null;
    else if (arg === '--interval-ms') options.intervalMs = Number(next());
    else if (arg === '--timeout-s') options.timeoutS = Number(next());
    else if (arg === '--since-mtime') options.sinceMtime = Number(next());
    else if (arg === '--long-poll-s') options.longPollSeconds = Number(next());
    else if (arg === '--json') options.json = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9]{1,16}$/.test(options.session)) {
    throw new Error(`Invalid session code: ${options.session} (1–16 alphanumerics)`);
  }
  options.session = options.session.toUpperCase();

  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 100) {
    throw new Error(`Invalid --interval-ms: ${options.intervalMs} (min 100)`);
  }
  if (!Number.isFinite(options.timeoutS) || options.timeoutS < 0) {
    throw new Error(`Invalid --timeout-s: ${options.timeoutS} (must be >= 0)`);
  }
  if (!Number.isFinite(options.longPollSeconds) || options.longPollSeconds < 1 || options.longPollSeconds > 600) {
    throw new Error(`Invalid --long-poll-s: ${options.longPollSeconds} (1-600)`);
  }
  if (!Number.isFinite(options.sinceMtime) || options.sinceMtime < 0) {
    throw new Error(`Invalid --since-mtime: ${options.sinceMtime}`);
  }

  return options;
}

export function printHelp(): void {
  console.log(`cad-coder camera-watch

Watch for new reference-photo uploads and emit one stdout line per upload.
Designed to be launched with run_in_background:true so the Claude Code harness
notifies the agent the moment a photo arrives — no user message required.

Usage:
  bun cad-coder/scripts/camera-watch.ts [options]

Options:
  --session <code>      Phone session code (1-16 alphanumerics). Default: DEFAULT.
  --dir <path>          Camera storage directory. Default: $CAD_CAMERA_DIR or /tmp/cad-reference.
  --server-url <url>    Long-poll target. Default: $CAD_CAMERA_SERVER_URL or http://127.0.0.1:8000.
  --no-http             Skip HTTP entirely; pure filesystem polling.
  --interval-ms <n>     FS-mode poll interval. Default: 1500 ms.
  --long-poll-s <n>     Per-request long-poll window. Default: 30 s.
  --timeout-s <n>       Exit with 'timeout' line after N seconds total. 0 = run forever. Default: 0.
  --since-mtime <ts>    Only fire for files newer than this Unix timestamp.
  --json                Emit JSON lines instead of text.
  --once                Exit 0 after the first event (image_received OR timeout).
`);
}

export function formatEvent(evt: WatcherOutput, asJson: boolean): string {
  if (asJson) return JSON.stringify(evt);
  if (evt.event === 'image_received') {
    return `IMAGE_RECEIVED session=${evt.session} path=${evt.path} size=${evt.size} received_at=${evt.receivedAt}`;
  }
  return `IMAGE_TIMEOUT session=${evt.session} waited_s=${evt.waitedSeconds}`;
}

function imagePath(dir: string, session: string): string {
  return join(dir, `${session}.jpg`);
}

/** Read the on-disk state for a session (or null if no file). */
export function readFsState(dir: string, session: string): { path: string; size: number; mtime: number } | null {
  const path = imagePath(dir, session);
  if (!existsSync(path)) {
    // Maybe present with a different extension or case-quirk; do a directory scan
    // as a small belt-and-suspenders against image_type changes (server uses .jpg today).
    if (existsSync(dir)) {
      const upper = session.toUpperCase();
      for (const entry of readdirSync(dir)) {
        if (!entry.toUpperCase().startsWith(`${upper}.`)) continue;
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (!st.isFile()) continue;
          return { path: full, size: st.size, mtime: st.mtimeMs / 1000 };
        } catch {
          // ignore unreadable entries
        }
      }
    }
    return null;
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { path, size: st.size, mtime: st.mtimeMs / 1000 };
  } catch {
    return null;
  }
}

function eventFromFs(state: { path: string; size: number; mtime: number }, session: string): CameraEvent {
  return {
    event: 'image_received',
    session,
    path: state.path,
    size: state.size,
    receivedAt: new Date(state.mtime * 1000).toISOString(),
    receivedAtUnix: state.mtime,
  };
}

type WaitResult =
  | { kind: 'image_received'; event: CameraEvent }
  | { kind: 'timeout' }
  | { kind: 'unavailable' };

async function httpWaitOnce(
  options: CameraWatchOptions,
  since: number,
  signal: AbortSignal,
): Promise<WaitResult> {
  if (!options.serverUrl) return { kind: 'unavailable' };
  const url = new URL('/camera/wait', options.serverUrl);
  url.searchParams.set('session', options.session);
  url.searchParams.set('since', String(since));
  url.searchParams.set('timeout_s', String(options.longPollSeconds));
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return { kind: 'unavailable' };
    const body = (await response.json()) as Record<string, unknown>;
    if (body.status === 'image_received') {
      const receivedAtUnix = Number(body.received_at) || 0;
      return {
        kind: 'image_received',
        event: {
          event: 'image_received',
          session: String(body.session ?? options.session),
          path: String(body.path ?? ''),
          size: Number(body.size_bytes ?? 0),
          receivedAt: new Date(receivedAtUnix * 1000).toISOString(),
          receivedAtUnix,
        },
      };
    }
    if (body.status === 'timeout') return { kind: 'timeout' };
    return { kind: 'unavailable' };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    return { kind: 'unavailable' };
  }
}

export type Watcher = {
  options: CameraWatchOptions;
  /** Single iteration that resolves with the next event (or null on abort). */
  next(): Promise<WatcherOutput | null>;
};

export function createWatcher(options: CameraWatchOptions, abortSignal?: AbortSignal): Watcher {
  // Track the last upload we have already reported so re-uploads on the same
  // session fire a fresh event but a stale file at startup does not.
  let lastReportedMtime = options.sinceMtime;
  const startedAt = Date.now();
  // HTTP mode is disabled once we've seen it fail in this watcher instance.
  let httpAvailable = options.serverUrl !== null;

  // Ensure the dir exists so readdirSync doesn't throw in fresh sandboxes.
  if (!existsSync(options.dir)) mkdirSync(options.dir, { recursive: true });

  const checkBudget = (): number | null => {
    if (options.timeoutS === 0) return null;
    const remaining = options.timeoutS - (Date.now() - startedAt) / 1000;
    return remaining;
  };

  async function next(): Promise<WatcherOutput | null> {
    while (true) {
      if (abortSignal?.aborted) return null;

      // Always do a cheap FS check first. Catches uploads that happened while
      // the watcher was sleeping, and works even with the HTTP server down.
      const fsState = readFsState(options.dir, options.session);
      if (fsState && fsState.mtime > lastReportedMtime) {
        lastReportedMtime = fsState.mtime;
        return eventFromFs(fsState, options.session);
      }

      const budget = checkBudget();
      if (budget !== null && budget <= 0) {
        const waitedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
        return { event: 'timeout', session: options.session, waitedSeconds };
      }

      if (httpAvailable) {
        const slice = Math.min(
          options.longPollSeconds,
          budget === null ? options.longPollSeconds : Math.max(1, Math.ceil(budget)),
        );
        const sliceOptions = { ...options, longPollSeconds: slice };
        try {
          const result = await httpWaitOnce(sliceOptions, lastReportedMtime, abortSignal ?? new AbortController().signal);
          if (result.kind === 'image_received') {
            // Only emit if strictly newer than what we've reported. The server
            // semantics already gate on `since`, but the FS-mode check above
            // might have raced ahead — defend either way.
            if (result.event.receivedAtUnix > lastReportedMtime) {
              lastReportedMtime = result.event.receivedAtUnix;
              return result.event;
            }
            // Fall through to next iteration.
            continue;
          }
          if (result.kind === 'timeout') {
            // Loop will re-check FS + overall budget. Keeps long total timeouts
            // working without holding a single HTTP request open the whole time.
            continue;
          }
          if (result.kind === 'unavailable') {
            httpAvailable = false;
            // Fall through to FS polling.
          }
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return null;
          httpAvailable = false;
        }
      }

      // FS-polling fallback.
      const sleepMs = Math.max(100, options.intervalMs);
      const cappedSleep = budget === null ? sleepMs : Math.min(sleepMs, Math.max(50, budget * 1000));
      await sleepWithAbort(cappedSleep, abortSignal);
    }
  }

  return { options, next };
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) return resolvePromise();
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolvePromise();
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runWatcher(options: CameraWatchOptions, signal?: AbortSignal): Promise<number> {
  const watcher = createWatcher(options, signal);
  let timedOutOnce = false;
  while (true) {
    const evt = await watcher.next();
    if (evt === null) return 0; // aborted
    console.log(formatEvent(evt, options.json));
    if (evt.event === 'timeout') {
      timedOutOnce = true;
      if (options.once) return 0;
      // Loop continues — but checkBudget will keep returning <= 0, so we'd
      // emit timeout in a tight loop. Exit instead to avoid spamming.
      return 0;
    }
    if (options.once) return 0;
  }
  // unreachable, but TS likes a final return
  void timedOutOnce;
  return 0;
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const code = await runWatcher(options, controller.signal);
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
