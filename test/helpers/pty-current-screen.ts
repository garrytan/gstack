import type { Terminal } from 'xterm';

let TerminalClass: typeof Terminal | undefined;

function terminalClass(): typeof Terminal {
  if (TerminalClass) return TerminalClass;
  // xterm 5.3 detects Node by navigator's absence. Bun provides navigator
  // without a DOM, so select the package's Node path during synchronous load.
  // No await or fake document/window: restore the exact descriptors even if
  // loading fails. Its public buffer API works without Terminal.open().
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const self = Object.getOwnPropertyDescriptor(globalThis, 'self');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    if (typeof globalThis.self === 'undefined') Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
    TerminalClass = (require('xterm') as { Terminal: typeof Terminal }).Terminal;
    return TerminalClass;
  } finally {
    if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
    else delete (globalThis as any).navigator;
    if (self) Object.defineProperty(globalThis, 'self', self);
    else delete (globalThis as any).self;
  }
}

export interface PtyScreenSnapshot {
  /** Absolute bytes fed through this snapshot's write barrier, not raw JS string indices. */
  inputOffset: number;
  cols: number;
  rows: number;
  bufferType: 'normal' | 'alternate';
  lines: Array<{ text: string; wrapped: boolean }>;
  text: string;
  /** Contiguous dim/inverse text cells, captured at the same write barrier. */
  styledText: Array<{ row: number; start: number; text: string; dim: boolean; inverse: boolean }>;
}

/** Test-only current-screen projection. Never writes input to a PTY. */
export class PtyCurrentScreen {
  private terminal: Terminal | null = null;
  private offset = 0;
  private closed: Error | null = null;
  private pending = new Set<(error: Error) => void>();
  private readonly cols: number;
  private readonly rows: number;
  private readonly flushTimeoutMs: number;

  constructor(options: { cols?: number; rows?: number; flushTimeoutMs?: number } = {}) {
    this.cols = options.cols ?? 120;
    this.rows = options.rows ?? 40;
    this.flushTimeoutMs = options.flushTimeoutMs ?? 1000;
    if (![this.cols, this.rows].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Screen dimensions must be positive integers');
    if (!Number.isFinite(this.flushTimeoutMs) || this.flushTimeoutMs <= 0) throw new Error('Screen flush timeout must be finite and positive');
  }

  get inputOffset(): number { return this.offset; }

  private getTerminal(): Terminal {
    if (this.closed) throw this.closed;
    if (!this.terminal) this.terminal = new (terminalClass())({ cols: this.cols, rows: this.rows, scrollback: 0 });
    return this.terminal;
  }

  /** Byte chunks preserve decoder state across split UTF-8 characters.
   * Strings are encoded once; offsets always count UTF-8 bytes. */
  feed(data: string | Uint8Array): number {
    const terminal = this.getTerminal();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const offset = this.offset + bytes.byteLength;
    if (!Number.isSafeInteger(offset)) throw new Error('Screen input offset exceeded the safe integer range');
    try { terminal.write(bytes); }
    catch (cause) {
      this.close(new Error('Screen input could not be decoded'));
      throw cause;
    }
    this.offset = offset;
    return offset;
  }

  /** Capture inside the callback, before later queued writes can change the
   * screen. The returned offset lets callers compare with their input epoch;
   * it does not itself establish native question ownership or acknowledgement. */
  snapshot(): Promise<PtyScreenSnapshot> {
    const terminal = this.getTerminal();
    const inputOffset = this.offset;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: Error, value?: PtyScreenSnapshot) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(fail);
        if (error) reject(error);
        else resolve(value!);
      };
      const fail = (error: Error) => finish(error);
      const timer = setTimeout(() => this.close(new Error(`Screen flush did not complete within ${this.flushTimeoutMs}ms`)), this.flushTimeoutMs);
      this.pending.add(fail);
      try {
        terminal.write('', () => {
          if (done || this.closed) return;
          try {
            const buffer = terminal.buffer.active;
            const styledText: PtyScreenSnapshot['styledText'] = [];
            const lines = Array.from({ length: terminal.rows }, (_, row) => {
              const line = buffer.getLine(buffer.baseY + row);
              let start = 0, previous = '';
              for (let col = 0; col <= terminal.cols; col++) {
                const cell = col < terminal.cols ? line?.getCell(col) : undefined;
                const key = cell && (cell.getChars() || cell.getWidth() === 0)
                  ? `${Number(!!cell.isDim())}${Number(!!cell.isInverse())}` : '';
                if (key === previous) continue;
                if (previous && previous !== '00') styledText.push({ row, start,
                  text: line!.translateToString(false, start, col), dim: previous[0] === '1', inverse: previous[1] === '1' });
                start = col; previous = key;
              }
              return { text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false };
            });
            finish(undefined, { inputOffset, cols: terminal.cols, rows: terminal.rows,
              bufferType: buffer.type, lines, text: lines.map(line => line.text).join('\n'), styledText });
          } catch (cause) {
            this.close(cause instanceof Error ? cause : new Error(String(cause)));
          }
        });
      } catch (cause) {
        this.close(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  /** The caller must flush before coordinating this with the actual PTY.
   * Resizing changes geometry only; it contributes no output or input epoch. */
  resize(cols: number, rows: number): void {
    if (![cols, rows].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Screen dimensions must be positive integers');
    if (this.pending.size) throw new Error('Cannot resize while a screen snapshot is pending');
    try { this.getTerminal().resize(cols, rows); }
    catch (cause) { this.close(cause instanceof Error ? cause : new Error(String(cause))); throw cause; }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const fail of [...this.pending]) fail(error);
    this.terminal?.dispose();
  }

  dispose(): void { this.close(new Error('Screen projection is disposed')); }
}
