import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { bunIsolationArgs } from './bun-isolation';
import { constants as osConstants } from 'node:os';
import { initializeWindowsReviewJob } from './claude-code-windows-job';

const MAX_MS = 2_147_483_647;
class QaDeadlineError extends Error {}
const QA_DEADLINE_USAGE = 'gstack-qa-deadline start FILE SECONDS [EARLIER_UTC] | status FILE | run FILE -- COMMAND ARGS...';
type QaCommandResult = { exitCode: number; signal: NodeJS.Signals | null; completed: boolean };
type Emit = (stream: 'stdout' | 'stderr', receipt: Record<string, unknown>, completion?: QaCommandResult) => void;

export interface QaDeadline {
  version: 1;
  startedAt: string;
  deadlineAt: string;
  budgetMs: number;
}

function utc(value: unknown): number {
  if (typeof value !== 'string') throw new QaDeadlineError('Invalid UTC timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new QaDeadlineError('Invalid UTC timestamp');
  const canonical = new Date(ms).toISOString();
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) throw new QaDeadlineError('Invalid UTC timestamp');
  return ms;
}

function checkedPath(file: string): string {
  if (!file || file.includes('\0') || file.split(/[\\/]/).some(part => part === '..')) {
    throw new QaDeadlineError('Invalid deadline path');
  }
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep);
  if (!parts.at(-1)) throw new QaDeadlineError('Invalid deadline path');
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
      throw new QaDeadlineError('Invalid deadline path');
    }
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index === parts.length - 1) break;
      throw new QaDeadlineError('Deadline parent directory is unavailable');
    }
    if (stat.isSymbolicLink()) throw new QaDeadlineError('Symlinked deadline paths are forbidden');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new QaDeadlineError('Invalid deadline parent directory');
  }
  return absolute;
}

export function startQaDeadline(file: string, seconds: string, earlierUtc?: string): QaDeadline {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(seconds)) throw new QaDeadlineError('Invalid deadline duration');
  const [whole, fraction = ''] = seconds.split('.');
  const budgetMs = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > MAX_MS) throw new QaDeadlineError('Invalid deadline duration');
  const started = Date.now();
  const earlier = earlierUtc === undefined ? Infinity : utc(earlierUtc);
  const state: QaDeadline = {
    version: 1,
    startedAt: new Date(started).toISOString(),
    deadlineAt: new Date(Math.min(started + budgetMs, earlier)).toISOString(),
    budgetMs,
  };
  const target = checkedPath(file);
  const temporary = path.join(path.dirname(target), `.qa-deadline-${randomUUID()}`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(state) + '\n');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o400);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, target);
  } catch {
    throw new QaDeadlineError('Cannot create deadline receipt; it must not already exist');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.rmSync(temporary, { force: true });
  }
  return state;
}

export function readQaDeadline(file: string): QaDeadline {
  const target = checkedPath(file);
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1) throw new Error();
    const state = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!state || Object.keys(state).sort().join(',') !== 'budgetMs,deadlineAt,startedAt,version'
      || state.version !== 1 || !Number.isSafeInteger(state.budgetMs) || state.budgetMs <= 0 || state.budgetMs > MAX_MS
      || utc(state.deadlineAt) > utc(state.startedAt) + state.budgetMs) throw new Error();
    return state;
  } catch {
    throw new QaDeadlineError('Missing or malformed deadline receipt');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function qaDeadlineStatus(state: QaDeadline) {
  const now = Date.now();
  if (now < utc(state.startedAt)) throw new QaDeadlineError('Clock moved before deadline start; refusing dispatch');
  const remainingMs = Math.max(0, utc(state.deadlineAt) - now);
  return { ...state, observedAt: new Date(now).toISOString(), remainingMs, expired: remainingMs === 0 };
}

export interface QaCommandCapture {
  write(stream: 'stdout' | 'stderr', chunk: Buffer): void;
  complete(result: QaCommandResult): void;
  spawn?: { cwd?: string; env?: Record<string, string> };
}

export async function runQaDeadlineCommand(file: string, command: string, args: string[], emit: Emit, capture?: QaCommandCapture): Promise<number> {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new QaDeadlineError('Process containment is unavailable on this platform');
  let status = qaDeadlineStatus(readQaDeadline(file));
  if (status.expired) {
    emit('stderr', { event: 'expired', ...status });
    return 124;
  }
  if (process.platform === 'win32') {
    try { await initializeWindowsReviewJob(); } catch { throw new QaDeadlineError('Windows process containment is unavailable; no command was started'); }
  }
  status = qaDeadlineStatus(readQaDeadline(file));
  if (status.expired) {
    emit('stderr', { event: 'expired', ...status });
    return 124;
  }
  return new Promise<number>(resolve => {
    status = qaDeadlineStatus(status);
    if (status.expired) {
      emit('stderr', { event: 'expired', ...status });
      resolve(124);
      return;
    }
    let outcome: number | undefined;
    let settled = false;
    const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true,
      cwd: capture?.spawn?.cwd, env: capture?.spawn?.env });
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') outcome = 2;
      }
    };
    const finish = (code: number, signal: NodeJS.Signals | null = null, completed = false) => {
      const finishedAt = Date.now();
      if (settled) return;
      settled = true;
      if (outcome === undefined && finishedAt >= utc(status.deadlineAt)) outcome = 124;
      clearTimeout(timer);
      kill();
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.off('SIGHUP', hangup);
      process.off('exit', kill);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const completion = { exitCode: outcome ?? code, signal, completed: completed && outcome === undefined && signal === null };
      emit('stderr', { event: 'finished', observedAt: new Date(finishedAt).toISOString(),
        deadlineAt: status.deadlineAt, timedOut: outcome === 124, exitCode: outcome ?? code }, completion);
      capture?.complete(completion);
      resolve(outcome ?? code);
    };
    const stop = (code: number) => { if (settled) return; outcome ??= code; kill(); finish(code); };
    const interrupt = () => stop(130);
    const terminate = () => stop(143);
    const hangup = () => stop(129);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    process.on('SIGHUP', hangup);
    process.on('exit', kill);
    const timer = setTimeout(() => stop(124), Math.max(1, utc(status.deadlineAt) - Date.now()));
    child.once('error', () => finish(127));
    child.once('exit', (code, signal) => {
      if (!capture) finish(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1), signal, true);
      else if (!settled) kill();
    });
    if (capture) {
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]!.on('data', chunk => {
          if (settled) return;
          try { capture.write(stream, chunk); } catch { stop(2); }
        });
        child[stream]!.once('error', () => stop(2));
      }
      child.once('close', (code, signal) => finish(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1), signal,
        child.stdout!.readableEnded && child.stderr!.readableEnded));
    }
    emit('stderr', { event: 'started', ...status });
  });
}

async function runWindowsWorker(args: string[], emit: Emit): Promise<number> {
  const status = qaDeadlineStatus(readQaDeadline(args[1]));
  if (status.expired) {
    emit('stderr', { event: 'expired', ...status });
    return 124;
  }
  return runQaWindowsWorker(args, emit, path.resolve(import.meta.dir, '../bin/gstack-qa-deadline'), 'qa-deadline-receipt');
}

export async function runQaWindowsWorker(args: string[], emit: Emit, entrypoint: string, messageType: string,
  captureFiles?: { stdout: number; stderr: number }): Promise<number> {
  try { await initializeWindowsReviewJob(); } catch { throw new QaDeadlineError('Windows process containment is unavailable; no command was started'); }
  return new Promise<number>(resolve => {
    const worker = spawn(process.execPath, [...bunIsolationArgs(), ...process.execArgv, entrypoint, '--receipt-worker', ...args], {
      stdio: ['inherit', captureFiles?.stdout ?? 'inherit', captureFiles?.stderr ?? 'inherit', 'ipc'], windowsHide: true,
    });
    const kill = () => { worker.kill('SIGKILL'); };
    process.on('exit', kill);
    worker.on('message', (message: any) => {
      if (message?.type === messageType && ['stdout', 'stderr'].includes(message.stream)
        && message.receipt && typeof message.receipt === 'object') emit(message.stream, message.receipt, message.completion);
      if (message?.type === messageType && Number.isSafeInteger(message.seq)) {
        try { worker.send({ type: `${messageType}-ack`, seq: message.seq }, () => {}); } catch {}
      }
    });
    worker.once('error', () => {
      process.off('exit', kill);
      emit('stderr', { event: 'error', message: 'Cannot start deadline worker' });
      resolve(2);
    });
    worker.once('close', (code, signal) => {
      process.off('exit', kill);
      resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 2));
    });
  });
}

export async function withQaReceiptOutput(receiptWorker: boolean, messageType: string, format: (receipt: Record<string, unknown>) => string,
  run: (emit: Emit) => Promise<number>): Promise<number> {
  const output = {
    stdout: fs.createWriteStream('', { fd: 1, autoClose: false }),
    stderr: fs.createWriteStream('', { fd: 2, autoClose: false }),
  };
  const writes: Promise<void>[] = [];
  const acks = new Map<number, () => void>();
  if (receiptWorker) process.on('message', (message: any) => {
    if (message?.type === `${messageType}-ack`) acks.get(message.seq)?.();
  });
  let writeFailed = false;
  const failed = () => { writeFailed = true; };
  output.stdout.on('error', failed);
  output.stderr.on('error', failed);
  const emit: Emit = (stream, receipt, completion) => {
    writes.push(new Promise<void>(resolve => {
      const done = (error?: Error | null) => { if (error) writeFailed = true; resolve(); };
      try {
        if (receiptWorker) {
          const seq = writes.length;
          acks.set(seq, () => { acks.delete(seq); resolve(); });
          process.send!({ type: messageType, seq, stream, receipt, ...(completion ? { completion } : {}) }, (error?: Error | null) => { if (error) done(error); });
        }
        else output[stream].write(format(receipt), done);
      } catch { writeFailed = true; resolve(); }
    }));
  };
  try { return await run(emit); }
  finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(writes),
      new Promise<void>(resolve => { timer = setTimeout(() => { writeFailed = true; resolve(); }, 5000); }),
    ]);
    clearTimeout(timer);
    if (writeFailed) return 2;
  }
}

export async function qaDeadlineMain(args: string[], receiptWorker = false): Promise<number> {
  return withQaReceiptOutput(receiptWorker, 'qa-deadline-receipt', receipt => '\nQA_DEADLINE ' + JSON.stringify({ guard: 'qa-deadline', ...receipt }) + '\n', async emit => {
    try {
      const [action, file, ...rest] = args;
      if (action === '--help' && args.length === 1) {
        emit('stdout', { event: 'help', usage: QA_DEADLINE_USAGE });
        return 0;
      }
      if (action === 'start' && file && (rest.length === 1 || rest.length === 2)) {
        const status = qaDeadlineStatus(startQaDeadline(file, rest[0], rest[1]));
        emit('stdout', { event: 'start', ...status });
        return status.expired ? 124 : 0;
      }
      if (action === 'status' && file && rest.length === 0) {
        const status = qaDeadlineStatus(readQaDeadline(file));
        emit('stdout', { event: 'status', ...status });
        return status.expired ? 124 : 0;
      }
      if (action === 'run' && file && rest[0] === '--' && rest[1]) {
        if (process.platform === 'win32' && !receiptWorker) return await runWindowsWorker(args, emit);
        return await runQaDeadlineCommand(file, rest[1], rest.slice(2), emit);
      }
      throw new QaDeadlineError(`Usage: ${QA_DEADLINE_USAGE}`);
    } catch (error) {
      emit('stderr', { event: 'error', message: error instanceof QaDeadlineError ? error.message : 'Deadline guard failed' });
      return 2;
    }
  });
}
