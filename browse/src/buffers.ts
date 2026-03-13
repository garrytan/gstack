/**
 * Shared buffers and types — extracted to break circular dependency
 * between server.ts and browser-manager.ts
 *
 * CircularBuffer<T>: O(1) insert ring buffer with fixed capacity.
 *
 *   ┌───┬───┬───┬───┬───┬───┐
 *   │ 3 │ 4 │ 5 │   │ 1 │ 2 │  capacity=6, head=4, size=5
 *   └───┴───┴───┴───┴─▲─┴───┘
 *                      │
 *                    head (oldest entry)
 *
 *   push() writes at (head+size) % capacity, O(1)
 *   toArray() returns entries in insertion order, O(n)
 *   totalAdded keeps incrementing past capacity (flush cursor)
 */

// ─── CircularBuffer ─────────────────────────────────────────

export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private _size: number = 0;
  private _totalAdded: number = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: T): void {
    const index = (this.head + this._size) % this.capacity;
    this.buffer[index] = entry;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      // Buffer full — advance head (overwrites oldest)
      this.head = (this.head + 1) % this.capacity;
    }
    this._totalAdded++;
  }

  /** Return entries in insertion order (oldest first) */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity] as T);
    }
    return result;
  }

  /** Return the last N entries (most recent first → reversed to oldest first) */
  last(n: number): T[] {
    const count = Math.min(n, this._size);
    const result: T[] = [];
    const start = (this.head + this._size - count) % this.capacity;
    for (let i = 0; i < count; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  get length(): number {
    return this._size;
  }

  get totalAdded(): number {
    return this._totalAdded;
  }

  clear(): void {
    this.head = 0;
    this._size = 0;
    // Don't reset totalAdded — flush cursor depends on it
  }

  /** Get entry by index (0 = oldest) — used by network response matching */
  get(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.buffer[(this.head + index) % this.capacity];
  }

  /** Set entry by index (0 = oldest) — used by network response matching */
  set(index: number, entry: T): void {
    if (index < 0 || index >= this._size) return;
    this.buffer[(this.head + index) % this.capacity] = entry;
  }
}

// ─── Entry Types ────────────────────────────────────────────

export interface LogEntry {
  timestamp: number;
  level: string;
  text: string;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  size?: number;
}

export interface DialogEntry {
  timestamp: number;
  type: string;        // 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string;
  defaultValue?: string;
  action: string;      // 'accepted' | 'dismissed'
  response?: string;   // text provided for prompt
}

// ─── Buffer Instances ───────────────────────────────────────

const HIGH_WATER_MARK = 50_000;

export const consoleBuffer = new CircularBuffer<LogEntry>(HIGH_WATER_MARK);
export const networkBuffer = new CircularBuffer<NetworkEntry>(HIGH_WATER_MARK);
export const dialogBuffer = new CircularBuffer<DialogEntry>(HIGH_WATER_MARK);

// ─── Convenience add functions ──────────────────────────────

export function addConsoleEntry(entry: LogEntry) {
  consoleBuffer.push(entry);
}

export function addNetworkEntry(entry: NetworkEntry) {
  networkBuffer.push(entry);
}

export function addDialogEntry(entry: DialogEntry) {
  dialogBuffer.push(entry);
}
