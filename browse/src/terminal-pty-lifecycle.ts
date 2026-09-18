/** Existing PTY shutdown grace, also bounds waiting for exit/reader completion. */
export const PTY_SHUTDOWN_GRACE_MS = 3000;

export interface PtyProcessExit {
  exitCode: number | null;
  signal: string | null;
  waitFailed: boolean;
}

export interface PtyReaderEnd {
  code: number;
  signal: string | null;
}

export interface PtyCompletion {
  process: PtyProcessExit | null;
  reader: PtyReaderEnd | null;
  drainTimedOut: boolean;
  exitTimedOut: boolean;
  /** null: Bun reported an I/O status without enough detail to prove loss/EOF. */
  outputComplete: boolean | null;
}

interface Timer {
  cancel(): void;
}

function scheduleDeadline(callback: () => void, delayMs: number): Timer {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export interface PtyLifecycleOptions {
  onData(chunk: Buffer): void;
  onComplete(completion: PtyCompletion): void;
  /** An injectable timer keeps ordering/deadline tests independent of wall time. */
  schedule?: (callback: () => void, delayMs: number) => Timer;
}

/**
 * Process exit does not drain a Bun.Terminal. Continue forwarding until the
 * reader finishes; bound the missing half of completion by the shutdown grace.
 * Bun 1.3.13 Terminal.zig reports reader 0=EOF / 1=I/O error (no errno), not
 * the child's exit code. In particular, never turn reader 1 into clean EOF.
 */
export function createPtyLifecycle(options: PtyLifecycleOptions) {
  let processExit: PtyProcessExit | null = null;
  let readerEnd: PtyReaderEnd | null = null;
  let stopped = false;
  let timer: Timer | null = null;
  const schedule = options.schedule ?? scheduleDeadline;

  function finish() {
    if (stopped) return;
    stopped = true;
    timer?.cancel();
    timer = null;
    options.onComplete({
      process: processExit,
      reader: readerEnd,
      drainTimedOut: readerEnd === null,
      exitTimedOut: processExit === null,
      outputComplete: readerEnd === null ? false
        : readerEnd.code === 0 && readerEnd.signal === null ? true : null,
    });
  }

  function changed() {
    if (processExit && readerEnd) finish();
    else if (!timer) timer = schedule(finish, PTY_SHUTDOWN_GRACE_MS);
  }

  return {
    data(chunk: Buffer) {
      if (!stopped && !readerEnd) options.onData(chunk);
    },
    exited(exitCode: number | null, signal: string | null, waitFailed = false) {
      if (stopped || processExit) return;
      processExit = { exitCode, signal, waitFailed };
      changed();
    },
    readerEnded(code: number, signal: string | null) {
      if (stopped || readerEnd) return;
      readerEnd = { code, signal };
      changed();
    },
    dispose() {
      // Must precede Terminal.close(): explicit close itself calls reader EOF.
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}

export type PtyLifecycle = ReturnType<typeof createPtyLifecycle>;

interface OwnedPtyProcess {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  exited: Promise<number>;
  terminal?: { close(): void };
  kill(signal: string): unknown;
}

/** Call only after cancelling the lifecycle: Terminal.close() can report EOF. */
export function disposePtyProcess(
  proc: OwnedPtyProcess | null,
  schedule = scheduleDeadline,
): void {
  try { proc?.terminal?.close(); } catch {}
  if (!proc?.pid || proc.exitCode != null || proc.signalCode != null) return;
  let exited = false;
  let timer: Timer | null = null;
  proc.exited.then(() => {
    exited = true;
    timer?.cancel();
  }, () => {});
  try { proc.kill('SIGINT'); } catch {}
  // `killed` only proves a signal was sent. Retain this exact process object,
  // never a mutable session.proc that could now refer to a replacement child.
  timer = schedule(() => {
    if (!exited) {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }, PTY_SHUTDOWN_GRACE_MS);
}

/** Transport close 1000 means this session ended, not that its child succeeded. */
export function ptyCompletionReason(completion: PtyCompletion): string {
  const child = completion.process;
  if (child?.waitFailed) return 'pty process wait failed';
  if (child?.signal) return `pty exited (${child.signal})`;
  if (child && child.exitCode !== null && child.exitCode !== 0) {
    return `pty exited (code ${child.exitCode})`;
  }
  if (completion.drainTimedOut) return 'pty output drain timed out';
  if (completion.exitTimedOut) return 'pty process exit timed out';
  // Reader status 1 also occurs on ordinary Linux PTY shutdown. Retain it in
  // the completion record, without asserting either clean EOF or output loss.
  return 'pty exited';
}
