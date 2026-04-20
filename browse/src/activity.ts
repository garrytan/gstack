/**
 * Activity streaming — real-time feed of browse commands for the Chrome extension Side Panel
 *
 * Architecture:
 *   handleCommand() ──► emitActivity(command_start)
 *                   ──► emitActivity(command_end)
 *   wirePageEvents() ──► emitActivity(navigation)
 *
 *   GET /activity/stream?after=ID ──► SSE via ReadableStream
 *   GET /activity/history?limit=N ──► REST fallback
 *
 * Privacy: filterArgs() redacts passwords, auth tokens, and sensitive query params.
 * Backpressure: subscribers notified via queueMicrotask (never blocks command path).
 * Gap detection: client sends ?after=ID, server detects if ring buffer overflowed.
 */

import { CircularBuffer } from './buffers';

// ─── Types ──────────────────────────────────────────────────────

export interface ActivityEntry {
  id: number;
  timestamp: number;
  type: 'command_start' | 'command_end' | 'navigation' | 'error';
  command?: string;
  args?: string[];
  url?: string;
  duration?: number;
  status?: 'ok' | 'error';
  error?: string;
  result?: string;
  tabs?: number;
  mode?: string;
  clientId?: string;
}

// ─── Buffer & Subscribers ───────────────────────────────────────

const BUFFER_CAPACITY = 1000;
const activityBuffer = new CircularBuffer<ActivityEntry>(BUFFER_CAPACITY);
let nextId = 1;

type ActivitySubscriber = (entry: ActivityEntry) => void;
const subscribers = new Set<ActivitySubscriber>();

// ─── Privacy Filtering ─────────────────────────────────────────

const SENSITIVE_COMMANDS = new Set(['fill', 'type', 'cookie', 'header']);
const SENSITIVE_PARAM_PATTERN = /\b(password|token|secret|key|auth|bearer|api[_-]?key)\b/i;

/**
 * Redact sensitive data from command args before streaming.
 */
export function filterArgs(command: string, args: string[]): string[] {
  if (!args || args.length === 0) return args;

  // fill: redact the value (last arg) for password-type fields
  if (command === 'fill' && args.length >= 2) {
    const selector = args[0];
    // If the selector suggests a password field, redact the value
    if (/password|passwd|secret|token/i.test(selector)) {
      return [selector, '[REDACTED]'];
    }
    return args;
  }

  // header: redact Authorization and other sensitive headers
  if (command === 'header' && args.length >= 1) {
    const headerLine = args[0];
    if (/^(authorization|x-api-key|cookie|set-cookie)/i.test(headerLine)) {
      const colonIdx = headerLine.indexOf(':');
      if (colonIdx > 0) {
        return [headerLine.substring(0, colonIdx + 1) + '[REDACTED]'];
      }
    }
    return args;
  }

  // cookie: redact cookie values
  if (command === 'cookie' && args.length >= 1) {
    const cookieStr = args[0];
    const eqIdx = cookieStr.indexOf('=');
    if (eqIdx > 0) {
      return [cookieStr.substring(0, eqIdx + 1) + '[REDACTED]'];
    }
    return args;
  }

  // type: always redact (could be a password field)
  if (command === 'type') {
    return ['[REDACTED]'];
  }

  // URL args: redact sensitive query params
  return args.map(arg => {
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      try {
        const url = new URL(arg);
        let redacted = false;
        for (const key of url.searchParams.keys()) {
          if (SENSITIVE_PARAM_PATTERN.test(key)) {
            url.searchParams.set(key, '[REDACTED]');
            redacted = true;
          }
        }
        return redacted ? url.toString() : arg;
      } catch {
        return arg;
      }
    }
    return arg;
  });
}

/**
 * Truncate result text for streaming (max 200 chars).
 */
function truncateResult(result: string | undefined): string | undefined {
  if (!result) return undefined;
  if (result.length <= 200) return result;
  return result.substring(0, 200) + '...';
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Emit an activity event. Backpressure-safe: subscribers notified asynchronously.
 */
export function emitActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): ActivityEntry {
  const full: ActivityEntry = {
    ...entry,
    id: nextId++,
    timestamp: Date.now(),
    args: entry.args ? filterArgs(entry.command || '', entry.args) : undefined,
    result: truncateResult(entry.result),
  };
  activityBuffer.push(full);

  // Notify subscribers asynchronously — never block the command path
  for (const notify of subscribers) {
    queueMicrotask(() => {
      try { notify(full); } catch { /* subscriber error — don't crash */ }
    });
  }

  return full;
}

/**
 * Subscribe to live activity events. Returns unsubscribe function.
 */
export function subscribe(fn: ActivitySubscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Get recent activity entries after the given cursor ID.
 * Returns entries and gap info if the buffer has overflowed.
 */
export function getActivityAfter(afterId: number): {
  entries: ActivityEntry[];
  gap: boolean;
  gapFrom?: number;
  availableFrom?: number;
  totalAdded: number;
} {
  const total = activityBuffer.totalAdded;
  const allEntries = activityBuffer.toArray();

  if (afterId === 0) {
    return { entries: allEntries, gap: false, totalAdded: total };
  }

  // Check for gap: if afterId is too old and has been evicted
  const oldestId = allEntries.length > 0 ? allEntries[0].id : nextId;
  if (afterId < oldestId) {
    return {
      entries: allEntries,
      gap: true,
      gapFrom: afterId + 1,
      availableFrom: oldestId,
      totalAdded: total,
    };
  }

  // Filter to entries after the cursor
  const filtered = allEntries.filter(e => e.id > afterId);
  return { entries: filtered, gap: false, totalAdded: total };
}

/**
 * Get the N most recent activity entries.
 */
export function getActivityHistory(limit: number = 50): {
  entries: ActivityEntry[];
  totalAdded: number;
} {
  const allEntries = activityBuffer.toArray();
  const sliced = limit < allEntries.length ? allEntries.slice(-limit) : allEntries;
  return { entries: sliced, totalAdded: activityBuffer.totalAdded };
}

/**
 * Get subscriber count (for debugging/health).
 */
export function getSubscriberCount(): number {
  return subscribers.size;
}
