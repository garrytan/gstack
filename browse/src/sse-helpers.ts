// SSE endpoint helper — shared cleanup contract for stream endpoints.
//
// Pre-helper, /activity/stream and /inspector/events implemented the same
// pattern in parallel and both leaked subscribers when enqueue failed
// without a corresponding abort signal (e.g. Chromium MV3 service-worker
// suspend dropped the TCP without an abort edge). The subscriber closure
// stayed in the Set, capturing the ReadableStreamDefaultController plus
// any payloads queued behind it. Over a multi-day sidebar session this
// compounded into multi-MB of retained controllers per dead connection.
//
// Centralizing the cleanup contract here means any future SSE endpoint
// inherits the invariant — cleanup runs on abort, enqueue failure, AND
// heartbeat failure, exactly once, regardless of which edge fires first.

import { stripLoneSurrogates } from './sanitize';

/**
 * JSON.stringify replacer that strips lone UTF-16 surrogates from string
 * values before they get escape-encoded. Pair with stringify when the
 * consumer will JSON.parse the payload back into JS strings (SSE clients
 * do this). Required at every SSE egress that ships page-content-derived
 * fields — see CLAUDE.md "Unicode sanitization at server egress".
 */
function sanitizeReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? stripLoneSurrogates(value) : value;
}

/** Send an SSE event. Handles JSON encoding + lone-surrogate sanitization. */
export type SseSender = (event: string, data: unknown) => void;

export interface SseEndpointConfig<T> {
  /**
   * Optional. Runs once after the stream opens, before subscribing for live
   * events. Use for initial event replay (activity gap detection, history
   * burst) or a current-state snapshot (inspector). The `send` helper
   * handles JSON encoding with sanitizeReplacer and SSE framing; pass
   * any event name and any payload object.
   */
  initialReplay?: (send: SseSender) => void;

  /**
   * Subscribe to the live event source. Receives a `notify` callback;
   * returns an unsubscribe function. The callback routes through the
   * helper's safeEnqueue + cleanup-on-throw, so a dead consumer ends up
   * removed from the subscriber set on the very next event (instead of
   * waiting for an abort that may never fire).
   */
  subscribe: (notify: (entry: T) => void) => () => void;

  /**
   * SSE event name for live events. `data: <JSON.stringify(entry)>\n\n`
   * is wrapped automatically. /activity/stream uses 'activity';
   * /inspector/events uses 'inspector'.
   */
  liveEventName: string;

  /** Heartbeat interval in ms. Default: 15000. */
  heartbeatMs?: number;
}

/**
 * Build a streaming Response that owns the cleanup contract:
 *   - safeEnqueue catches enqueue throws → cleanup
 *   - 15s heartbeat catches dead peers; failure → cleanup
 *   - req.signal abort → cleanup
 *   - cleanup is idempotent (clearInterval + unsubscribe + try close)
 */
export function createSseEndpoint<T>(
  req: Request,
  config: SseEndpointConfig<T>,
): Response {
  const heartbeatMs = config.heartbeatMs ?? 15000;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let cleanedUp = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe !== null) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Expected: stream already closed by the consumer.
        }
      };

      const send: SseSender = (event, data) => {
        if (cleanedUp) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data, sanitizeReplacer)}\n\n`,
            ),
          );
        } catch {
          // Consumer disconnected mid-write. Tear down so this subscriber
          // doesn't sit in the set forever.
          cleanup();
        }
      };

      // Initial replay (caller-provided).
      if (config.initialReplay) {
        try {
          config.initialReplay(send);
        } catch {
          cleanup();
          return;
        }
        if (cleanedUp) return;
      }

      // Subscribe for live events.
      unsubscribe = config.subscribe((entry) => {
        send(config.liveEventName, entry);
      });

      // Heartbeat keeps NAT boxes and proxies from dropping idle SSE,
      // and serves as a liveness probe: an enqueue failure here is the
      // cheapest way to learn the consumer is gone without waiting for
      // an abort signal that may never arrive.
      heartbeat = setInterval(() => {
        if (cleanedUp) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          cleanup();
        }
      }, heartbeatMs);

      req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
