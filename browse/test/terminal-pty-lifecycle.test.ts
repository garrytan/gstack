import { describe, expect, test } from 'bun:test';
import {
  createPtyLifecycle, disposePtyProcess, ptyCompletionReason,
  PTY_SHUTDOWN_GRACE_MS, type PtyCompletion,
} from '../src/terminal-pty-lifecycle';

function clock() {
  const pending = new Set<() => void>();
  const delays: number[] = [];
  return {
    pending, delays,
    schedule(callback: () => void, delay: number) {
      delays.push(delay);
      pending.add(callback);
      return { cancel() { pending.delete(callback); } };
    },
    expire() {
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
  };
}

function fixture() {
  const time = clock();
  const events: string[] = [];
  const completions: PtyCompletion[] = [];
  const lifecycle = createPtyLifecycle({
    schedule: time.schedule,
    onData(chunk) { events.push(chunk.toString()); },
    onComplete(result) { completions.push(result); events.push('CLOSE'); },
  });
  return { time, events, completions, lifecycle };
}

describe('PTY process exit and output completion', () => {
  test('child exit precedes final output: preserve executed result before close', () => {
    const f = fixture();
    const typed = "printf 'hello-%s-world\\n' pty\nexit\n";
    expect(typed).not.toContain('hello-pty-world');
    f.lifecycle.data(Buffer.from(typed));
    f.lifecycle.exited(0, null);
    expect(f.completions).toEqual([]);
    expect(f.time.delays).toEqual([PTY_SHUTDOWN_GRACE_MS]);
    f.lifecycle.data(Buffer.from('hello-pty-world\r\n'));
    expect(f.events.join('')).toContain('hello-pty-world');
    expect(f.events).not.toContain('CLOSE');
    f.lifecycle.readerEnded(0, null);
    expect(f.events).toEqual([typed, 'hello-pty-world\r\n', 'CLOSE']);
    expect(f.completions[0]).toEqual({
      process: { exitCode: 0, signal: null, waitFailed: false },
      reader: { code: 0, signal: null },
      drainTimedOut: false, exitTimedOut: false, outputComplete: true,
    });
    expect(f.time.pending.size).toBe(0);
  });

  test('reader can finish first; retain later nonzero child diagnostics', () => {
    const f = fixture();
    f.lifecycle.data(Buffer.from('command failed\r\n'));
    f.lifecycle.readerEnded(0, null);
    expect(f.completions).toEqual([]);
    f.lifecycle.exited(23, null);
    expect(f.completions[0].process?.exitCode).toBe(23);
    expect(f.completions[0].outputComplete).toBe(true);
    expect(ptyCompletionReason(f.completions[0])).toBe('pty exited (code 23)');
    expect(f.time.pending.size).toBe(0);
  });

  test('reader error is separate from successful child exit and remains uncertain output', () => {
    const f = fixture();
    f.lifecycle.exited(0, null);
    f.lifecycle.data(Buffer.from('real output'));
    f.lifecycle.readerEnded(1, null);
    // Explicit Terminal.close() can report EOF again; preserve the first status.
    f.lifecycle.readerEnded(0, null);
    expect(f.completions).toHaveLength(1);
    expect(f.completions[0].process?.exitCode).toBe(0);
    expect(f.completions[0].reader?.code).toBe(1);
    expect(f.completions[0].outputComplete).toBeNull();
    expect(ptyCompletionReason(f.completions[0])).toBe('pty exited');
    expect(f.events).toEqual(['real output', 'CLOSE']);
  });

  test('post-exit deadline rejects incomplete capture and preserves signal status', () => {
    const f = fixture();
    f.lifecycle.data(Buffer.from('partial'));
    f.lifecycle.exited(143, 'SIGTERM');
    f.lifecycle.exited(0, null);
    f.time.expire();
    const result = f.completions[0];
    expect(result.process).toEqual({ exitCode: 143, signal: 'SIGTERM', waitFailed: false });
    expect(result.reader).toBeNull();
    expect(result.drainTimedOut).toBe(true);
    expect(result.outputComplete).toBe(false);
    expect(ptyCompletionReason(result)).toBe('pty exited (SIGTERM)');
    f.lifecycle.data(Buffer.from('late'));
    f.lifecycle.readerEnded(0, null);
    f.time.expire();
    expect(f.events).toEqual(['partial', 'CLOSE']);
    expect(f.completions).toHaveLength(1);
  });

  test('reader failure before a stuck process has a bounded wait for exit', () => {
    const f = fixture();
    f.lifecycle.readerEnded(1, null);
    f.time.expire();
    expect(f.time.delays).toEqual([PTY_SHUTDOWN_GRACE_MS]);
    expect(f.completions[0]).toEqual({
      process: null, reader: { code: 1, signal: null },
      drainTimedOut: false, exitTimedOut: true, outputComplete: null,
    });
  });

  test('process wait rejection remains failure after reader completion', () => {
    const f = fixture();
    f.lifecycle.exited(null, null, true);
    f.lifecycle.readerEnded(0, null);
    expect(f.completions[0].process?.waitFailed).toBe(true);
    expect(f.completions[0].process?.exitCode).toBeNull();
    expect(ptyCompletionReason(f.completions[0])).toBe('pty process wait failed');
  });

  test('explicit disposal cancels draining and ignores close-generated EOF or late data', () => {
    const f = fixture();
    f.lifecycle.exited(0, null);
    f.lifecycle.dispose();
    f.lifecycle.readerEnded(0, null);
    f.lifecycle.data(Buffer.from('late'));
    f.time.expire();
    expect(f.time.pending.size).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.completions).toEqual([]);
  });

  test('detached output and completion route to the current attachment', () => {
    const time = clock();
    const original: string[] = [];
    const replacement: string[] = [];
    const replay: string[] = [];
    let attached: string[] | null = original;
    const lifecycle = createPtyLifecycle({
      schedule: time.schedule,
      onData(chunk) { replay.push(chunk.toString()); attached?.push(chunk.toString()); },
      onComplete() { attached?.push('CLOSE'); },
    });
    attached = null;
    lifecycle.exited(0, null);
    lifecycle.data(Buffer.from('final while detached'));
    expect(original).toEqual([]);
    attached = replacement;
    replacement.push(...replay);
    lifecycle.readerEnded(0, null);
    expect(replacement).toEqual(['final while detached', 'CLOSE']);
    expect(original).toEqual([]);
  });
});

describe('PTY disposal owns its original process', () => {
  function child() {
    let resolve!: (code: number) => void;
    const signals: string[] = [];
    const proc = {
      pid: 42, exitCode: null as number | null, signalCode: null as string | null,
      killed: false, closes: 0,
      exited: new Promise<number>(r => { resolve = r; }),
      terminal: { close() { proc.closes++; } },
      kill(signal: string) { proc.killed = true; signals.push(signal); },
    };
    return { proc, signals, resolve };
  }

  test('SIGINT does not prove exit; deadline kills only the captured child after replacement', () => {
    const time = clock();
    const old = child();
    const replacement = child();
    const session = { proc: old.proc };
    disposePtyProcess(session.proc, time.schedule);
    session.proc = replacement.proc;
    expect(old.proc.closes).toBe(1);
    expect(old.proc.killed).toBe(true);
    expect(old.signals).toEqual(['SIGINT']);
    expect(time.delays).toEqual([PTY_SHUTDOWN_GRACE_MS]);
    time.expire();
    expect(old.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(replacement.signals).toEqual([]);
    expect(replacement.proc.closes).toBe(0);
  });

  test('observed child exit cancels escalation', async () => {
    const time = clock();
    const old = child();
    disposePtyProcess(old.proc, time.schedule);
    old.resolve(0);
    await old.proc.exited;
    expect(time.pending.size).toBe(0);
    time.expire();
    expect(old.signals).toEqual(['SIGINT']);
  });

  test('already exited child closes its terminal without sending another signal', () => {
    const time = clock();
    const old = child();
    old.proc.exitCode = 7;
    disposePtyProcess(old.proc, time.schedule);
    expect(old.proc.closes).toBe(1);
    expect(old.signals).toEqual([]);
    expect(time.pending.size).toBe(0);
  });
});
