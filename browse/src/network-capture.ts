/**
 * Network response body capture — SizeCappedBuffer + capture lifecycle.
 *
 * Architecture:
 *   page.on('response') listener → filter by URL pattern → store body
 *   SizeCappedBuffer: evicts oldest entries when total size exceeds cap
 *   Export: writes JSONL file (one response per line)
 *
 * Memory management:
 *   - 50MB total buffer cap (configurable)
 *   - 5MB per-entry body cap (larger responses stored as metadata only)
 *   - Binary responses stored as base64
 *   - Text responses stored as-is
 */

import * as fs from 'fs';
import type { Response as PlaywrightResponse } from 'playwright';

export interface CapturedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  timestamp: number;
  size: number;
  bodyTruncated: boolean;
}

const MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB total
const MAX_ENTRY_SIZE = 5 * 1024 * 1024;   // 5MB per response body

export class SizeCappedBuffer {
  private entries: CapturedResponse[] = [];
  private totalSize = 0;
  private readonly maxSize: number;

  constructor(maxSize = MAX_BUFFER_SIZE) {
    this.maxSize = maxSize;
  }

  push(entry: CapturedResponse): void {
    // Evict oldest entries until we have room
    while (this.entries.length > 0 && this.totalSize + entry.size > this.maxSize) {
      const evicted = this.entries.shift()!;
      this.totalSize -= evicted.size;
    }
    this.entries.push(entry);
    this.totalSize += entry.size;
  }

  toArray(): CapturedResponse[] {
    return [...this.entries];
  }

  get length(): number {
    return this.entries.length;
  }

  get byteSize(): number {
    return this.totalSize;
  }

  clear(): void {
    this.entries = [];
    this.totalSize = 0;
  }

  /** Export to JSONL file. */
  exportToFile(filePath: string): number {
    const lines = this.entries.map(e => JSON.stringify(e));
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    return this.entries.length;
  }

  /** Summary of captured responses (URL, status, size). */
  summary(): string {
    if (this.entries.length === 0) return 'No captured responses.';
    const lines = this.entries.map((e, i) =>
      `  [${i + 1}] ${e.status} ${e.url.slice(0, 100)} (${Math.round(e.size / 1024)}KB${e.bodyTruncated ? ', truncated' : ''})`
    );
    return `${this.entries.length} responses (${Math.round(this.totalSize / 1024)}KB total):\n${lines.join('\n')}`;
  }
}

/** Global capture state. */
let captureBuffer = new SizeCappedBuffer();
let captureActive = false;
let captureFilter: RegExp | null = null;
let captureListener: ((response: PlaywrightResponse) => Promise<void>) | null = null;

export function isCaptureActive(): boolean {
  return captureActive;
}

export function getCaptureBuffer(): SizeCappedBuffer {
  return captureBuffer;
}

/** Create the response listener function. */
function createResponseListener(filter: RegExp | null): (response: PlaywrightResponse) => Promise<void> {
  return async (response: PlaywrightResponse) => {
    const url = response.url();
    if (filter && !filter.test(url)) return;

    // Skip non-content responses (redirects, 204, etc.)
    const status = response.status();
    if (status === 204 || status === 301 || status === 302 || status === 304) return;

    const contentType = response.headers()['content-type'] || '';
    let body = '';
    let bodySize = 0;
    let truncated = false;

    try {
      const rawBody = await response.body();
      bodySize = rawBody.length;

      if (bodySize > MAX_ENTRY_SIZE) {
        truncated = true;
        body = '';
      } else if (contentType.includes('json') || contentType.includes('text') || contentType.includes('xml') || contentType.includes('html')) {
        body = rawBody.toString('utf-8');
      } else {
        body = rawBody.toString('base64');
      }
    } catch {
      // Response body may be unavailable (e.g., streaming, aborted)
      body = '';
      truncated = true;
    }

    const entry: CapturedResponse = {
      url,
      status,
      headers: response.headers(),
      body,
      contentType,
      timestamp: Date.now(),
      size: bodySize,
      bodyTruncated: truncated,
    };

    captureBuffer.push(entry);
  };
}

/** Start capturing response bodies. */
export function startCapture(filterPattern?: string): { filter: string | null } {
  captureFilter = filterPattern ? new RegExp(filterPattern) : null;
  captureActive = true;
  captureListener = createResponseListener(captureFilter);
  return { filter: filterPattern || null };
}

/** Get the active listener (to attach to page). */
export function getCaptureListener(): ((response: PlaywrightResponse) => Promise<void>) | null {
  return captureListener;
}

/** Stop capturing. */
export function stopCapture(): { count: number; sizeKB: number } {
  captureActive = false;
  captureListener = null;
  return {
    count: captureBuffer.length,
    sizeKB: Math.round(captureBuffer.byteSize / 1024),
  };
}

/** Clear the capture buffer. */
export function clearCapture(): void {
  captureBuffer.clear();
}

/** Export captured responses to JSONL file. */
export function exportCapture(filePath: string): number {
  return captureBuffer.exportToFile(filePath);
}
