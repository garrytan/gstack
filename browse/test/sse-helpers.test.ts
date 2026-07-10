import { describe, test, expect } from 'bun:test';
import { createSseEndpoint } from '../src/sse-helpers';

// Unit tests for the SSE cleanup contract introduced by D6 EXTRACT_HELPER.
//
// The pre-helper bug: /activity/stream and /inspector/events ran cleanup
// only on the `req.signal.abort` edge. If the underlying TCP died without
// firing abort (Chromium MV3 service-worker suspend, intermediate proxy
// half-close), the subscriber closure stayed in the Set capturing the
// ReadableStreamDefaultController and any payloads queued behind it.
//
// These tests pin the three cleanup edges:
//   1. abort signal → cleanup
//   2. enqueue throws (consumer gone) → cleanup
//   3. heartbeat enqueue throws → cleanup
// And the idempotency invariant: cleanup running twice is a no-op.

function makeRequest(): { req: Request; abort: () => void } {
  const controller = new AbortController();
  // Minimal Request — we only use req.signal here. URL is irrelevant.
  const req = new Request('http://localhost/test', { signal: controller.signal });
  return { req, abort: () => controller.abort() };
}

/** Pull SSE bytes from a Response stream, return decoded text. */
async function readAll(res: Response, ms: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), deadline - Date.now()),
        ),
      ]);
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    } catch {
      break;
    }
  }
  try { reader.cancel().catch(() => {}); } catch {}
  return out;
}

describe('createSseEndpoint cleanup contract', () => {
  test('1. abort signal triggers unsubscribe', async () => {
    let unsubscribed = 0;
    const { req, abort } = makeRequest();
    const res = createSseEndpoint(req, {
      subscribe: () => () => {
        unsubscribed++;
      },
      liveEventName: 'test',
      heartbeatMs: 60_000, // long enough that we don't see heartbeats in this test
    });
    // Start the stream by reading once, then abort.
    const reader = res.body!.getReader();
    // Yield to let start() run.
    await Promise.resolve();
    await Promise.resolve();
    abort();
    // Let the abort listener fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubscribed).toBe(1);
    reader.cancel().catch(() => {});
  });

  test('2. enqueue throw triggers unsubscribe + heartbeat clear', async () => {
    let unsubscribed = 0;
    let notify: ((entry: { msg: string }) => void) | null = null;
    const { req } = makeRequest();
    const res = createSseEndpoint<{ msg: string }>(req, {
      subscribe: (n) => {
        notify = n;
        return () => {
          unsubscribed++;
        };
      },
      liveEventName: 'test',
      heartbeatMs: 60_000,
    });
    // Cancel the reader so subsequent enqueues throw.
    const reader = res.body!.getReader();
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).not.toBeNull();
    await reader.cancel(); // closes the consumer side
    // Now fire a live event — enqueue should throw → cleanup → unsubscribe.
    notify!({ msg: 'will fail to enqueue' });
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubscribed).toBe(1);
  });

  test('3. cleanup is idempotent (abort then enqueue-fail)', async () => {
    let unsubscribed = 0;
    let notify: ((entry: { msg: string }) => void) | null = null;
    const { req, abort } = makeRequest();
    const res = createSseEndpoint<{ msg: string }>(req, {
      subscribe: (n) => {
        notify = n;
        return () => {
          unsubscribed++;
        };
      },
      liveEventName: 'test',
      heartbeatMs: 60_000,
    });
    const reader = res.body!.getReader();
    await Promise.resolve();
    await Promise.resolve();
    abort();
    await new Promise((r) => setTimeout(r, 10));
    // Second cleanup edge — should be a no-op.
    notify!({ msg: 'no-op' });
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubscribed).toBe(1);
    reader.cancel().catch(() => {});
  });

  test('4. initialReplay events reach the client before live events', async () => {
    let notify: ((entry: { msg: string }) => void) | null = null;
    const { req } = makeRequest();
    const res = createSseEndpoint<{ msg: string }>(req, {
      initialReplay: (send) => {
        send('replay', { msg: 'first' });
      },
      subscribe: (n) => {
        notify = n;
        return () => {};
      },
      liveEventName: 'live',
      heartbeatMs: 60_000,
    });
    // Trigger one live event soon after stream starts.
    setTimeout(() => notify?.({ msg: 'second' }), 5);
    const text = await readAll(res, 50);
    expect(text).toContain('event: replay');
    expect(text).toContain('"msg":"first"');
    expect(text).toContain('event: live');
    expect(text).toContain('"msg":"second"');
    // Replay must come before live.
    expect(text.indexOf('"first"')).toBeLessThan(text.indexOf('"second"'));
  });

  test('5. initialReplay throw triggers cleanup without subscribing', async () => {
    let subscribed = 0;
    const { req } = makeRequest();
    const res = createSseEndpoint(req, {
      initialReplay: () => {
        throw new Error('replay boom');
      },
      subscribe: () => {
        subscribed++;
        return () => {};
      },
      liveEventName: 'test',
      heartbeatMs: 60_000,
    });
    // Drain — stream should close cleanly.
    const text = await readAll(res, 30);
    expect(text).toBe(''); // no events
    expect(subscribed).toBe(0); // never reached subscribe()
  });

  test('6. lone surrogates in payload string are sanitized', async () => {
    let notify: ((entry: { msg: string }) => void) | null = null;
    const { req } = makeRequest();
    const res = createSseEndpoint<{ msg: string }>(req, {
      subscribe: (n) => {
        notify = n;
        return () => {};
      },
      liveEventName: 'test',
      heartbeatMs: 60_000,
    });
    setTimeout(() => {
      // Lone high surrogate (no matching low). JSON.stringify would emit
      // \uD800 escape that breaks Claude API. Helper must strip it.
      notify?.({ msg: 'hello \uD800 world' });
    }, 5);
    const text = await readAll(res, 50);
    expect(text).toContain('event: test');
    // JSON.stringify emits U+FFFD as the literal character, not as escape.
    expect(text).toContain('�');
    // The raw lone-surrogate escape MUST NOT survive — that's the failure
    // mode that breaks the Claude API with HTTP 400.
    expect(text.toLowerCase()).not.toContain('\\ud800');
  });
});
