/**
 * pregate/supervise — how a test-tier command runs (Lane C, GBRA-95): its
 * own process group, stdout and stderr appended to a log file (no pipes, so
 * a backgrounded grandchild holding the output can never keep the check
 * waiting), supervised asynchronously. A stall is no log growth for
 * `stallMs`; the deadline is the check's `--timeout`. Either kills the whole
 * process group (SIGTERM, then SIGKILL after a grace period) and the run is
 * incomplete. After a normal exit the group's leftover members are killed.
 *
 * Progress: a runner with a progress adapter (`bun test`: its `<file>:`
 * headers) reports `PREGATE_TEST: <n>/<total> <file> start|pass|fail <s>`
 * per file; a run of one file reports it from the launch itself for any
 * runner. Without either, only heartbeats: a line after each `heartbeatMs`
 * with no progress line; with `lastLine` it names the last line the command printed.
 *
 * Platforms: POSIX signals the negative pid (the group `detached` creates
 * with setsid). Windows has no process groups here: the kill is
 * `taskkill /T /F` on the shell's tree, which misses a descendant that was
 * reparented or started detached.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { bashCommandInvocation } from '../script-invocation';

export type ProgressAdapter = 'bun';
export const PROGRESS_ADAPTERS: Record<ProgressAdapter, RegExp> = { bun: /(?:^|[\s;&|(])bun\s+test\b/ };

export interface Counter { done: number; total: number }

export interface SuperviseOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: string;
  /** Absolute epoch ms when the run is killed as timed out. */
  deadline: number;
  /** No log growth for this long kills the group; 0 disables. */
  stallMs: number;
  heartbeatMs?: number;
  graceMs?: number;
  pollMs?: number;
  label: string;
  files?: readonly string[];
  adapter?: ProgressAdapter | null;
  counter?: Counter;
  /** Heartbeats name the command's last output line (the remote gate, which has no per-file progress). */
  lastLine?: boolean;
  progress: (line: string) => void;
}

export interface Supervised {
  outcome: 'exited' | 'timeout' | 'stalled' | 'spawn-failed';
  exit: number | null;
  signal: string | null;
  /** Byte range of this run's output in the log. */
  start: number;
  end: number;
  lastFile: string | null;
  /** Whether the progress adapter saw a test file start in the runner's own output (a single file is marked started by the supervisor, which proves nothing). */
  observedStart: boolean;
  error?: string;
  ms: number;
}

const ACTIVE = new Set<number>();

/** SIGKILL every supervised process group still running (the CLI's SIGINT/SIGTERM handler, before it exits). */
export function cancelActive(): number {
  const pids = [...ACTIVE];
  for (const pid of pids) killGroup(pid, 'SIGKILL');
  ACTIVE.clear();
  return pids.length;
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 15_000, windowsHide: true });
    return;
  }
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

/** The adapter that reads per-file progress from this runner's output, or null when it has none. */
export function adapterFor(command: string): ProgressAdapter | null {
  for (const [name, re] of Object.entries(PROGRESS_ADAPTERS)) if (re.test(command)) return name as ProgressAdapter;
  return null;
}

/** The last `bytes` of the log range as text. */
export function readRange(log: string, start: number, end: number, bytes = 4 * 1024 * 1024): string {
  const from = Math.max(start, end - bytes);
  if (end <= from) return '';
  const fd = fs.openSync(log, 'r');
  try { const buf = Buffer.alloc(end - from); fs.readSync(fd, buf, 0, buf.length, from); return buf.toString('utf8'); }
  finally { fs.closeSync(fd); }
}

export function supervise(o: SuperviseOptions): Promise<Supervised> {
  const heartbeatMs = o.heartbeatMs ?? 60_000;
  const graceMs = o.graceMs ?? 5_000;
  const pollMs = o.pollMs ?? 250;
  const counter = o.counter ?? { done: 0, total: o.files?.length ?? 0 };
  const files = new Set(o.files ?? []);
  const single = o.files?.length === 1 ? o.files[0]! : null;
  const adapter = single ? null : (o.adapter ?? null);
  const started = Date.now();
  fs.appendFileSync(o.log, `$ ${o.command}\n`);
  const start = fs.statSync(o.log).size;
  let size = start;
  let readAt = start;
  let partial = '';
  let lastGrowth = started;
  let lastProgress = started;
  let current: { file: string; at: number; failed: boolean } | null = null;
  let lastFile: string | null = null;
  let observedStart = false;
  const emit = (line: string) => { lastProgress = Date.now(); o.progress(line); };
  const startFile = (file: string) => { current = { file, at: Date.now(), failed: false }; lastFile = file; emit(`PREGATE_TEST: ${counter.done + 1}/${counter.total} ${file} start`); };
  const finishFile = (failed?: boolean) => {
    if (!current) return;
    counter.done += 1;
    emit(`PREGATE_TEST: ${counter.done}/${counter.total} ${current.file} ${(failed ?? current.failed) ? 'fail' : 'pass'} ${((Date.now() - current.at) / 1000).toFixed(1)}`);
    current = null;
  };
  const readNew = () => {
    if (!adapter || size <= readAt) return;
    const text = partial + readRange(o.log, readAt, size, size - readAt);
    readAt = size;
    const lines = text.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const header = /^(?:::group::)?(\S.*):$/.exec(line);
      if (header && files.has(header[1]!)) { observedStart = true; finishFile(); startFile(header[1]!); continue; }
      if (/^\s*\d+\s+pass$/.test(line) || /^Ran \d+ tests? across/.test(line) || /^\s*\d+\s+tests? failed:?$/.test(line)) { finishFile(); continue; }
      if (current && /^\(fail\)\s/.test(line)) current.failed = true;
    }
  };

  return new Promise(resolve => {
    let fd: number;
    try { fd = fs.openSync(o.log, 'a'); }
    catch (e: any) { resolve({ outcome: 'spawn-failed', exit: null, signal: null, start, end: start, lastFile: null, observedStart: false, error: e.message, ms: 0 }); return; }
    const inv = bashCommandInvocation(`set -o pipefail; ${o.command}`);
    if (!inv.ok) {
      fs.closeSync(fd);
      resolve({ outcome: 'spawn-failed', exit: null, signal: null, start, end: start, lastFile: null, observedStart: false, error: inv.error, ms: Date.now() - started });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(inv.cmd, inv.argv, { cwd: o.cwd, env: o.env, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e: any) {
      fs.closeSync(fd);
      resolve({ outcome: 'spawn-failed', exit: null, signal: null, start, end: start, lastFile: null, observedStart: false, error: e.message, ms: Date.now() - started });
      return;
    }
    fs.closeSync(fd);
    if (single) startFile(single);
    let outcome: Supervised['outcome'] | null = null;
    let settled = false;
    let escalate: ReturnType<typeof setTimeout> | null = null;
    const stop = (why: Supervised['outcome']) => {
      if (outcome || !child.pid) return;
      outcome = why;
      killGroup(child.pid, 'SIGTERM');
      escalate = setTimeout(() => killGroup(child.pid!, 'SIGKILL'), graceMs);
    };
    const finish = (exit: number | null, signal: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (escalate) clearTimeout(escalate);
      if (child.pid) { ACTIVE.delete(child.pid); if (process.platform !== 'win32') killGroup(child.pid, 'SIGKILL'); }
      try { size = fs.statSync(o.log).size; } catch { /* log removed */ }
      readNew();
      const done: Supervised['outcome'] = error ? 'spawn-failed' : (outcome ?? 'exited');
      if (current) finishFile(done !== 'exited' || exit !== 0 ? true : undefined);
      resolve({ outcome: done, exit: done === 'exited' ? exit : null, signal, start, end: size, lastFile, observedStart, error, ms: Date.now() - started });
    };
    const timer = setInterval(() => {
      const now = Date.now();
      let grown = size;
      try { grown = fs.statSync(o.log).size; } catch { /* log removed */ }
      if (grown > size) { size = grown; lastGrowth = now; readNew(); }
      if (outcome) return;
      if (now >= o.deadline) { stop('timeout'); return; }
      if (o.stallMs > 0 && now - lastGrowth >= o.stallMs) { stop('stalled'); return; }
      if (now - lastProgress < heartbeatMs) return;
      let last: string | undefined;
      if (o.lastLine) {
        try { last = readRange(o.log, start, size, 4096).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r\n?|\n/).map(l => l.replace(/[\x00-\x1f\x7f]/g, '').trim()).filter(Boolean).at(-1); }
        catch { /* log removed */ }
      }
      emit(`PREGATE_HEARTBEAT: ${o.label} running ${Math.round((now - started) / 1000)}s; last file ${lastFile ?? 'none reported'}; log ${size - start} bytes, last growth ${Math.round((now - lastGrowth) / 1000)}s ago (${o.log})${last ? `; last output: ${last.slice(0, 160)}` : ''}`);
    }, pollMs);
    if (child.pid) ACTIVE.add(child.pid);
    child.on('error', e => finish(null, null, e.message));
    child.on('exit', (code, signal) => finish(code, signal));
  });
}
