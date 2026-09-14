import { describe, test, expect } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { networkBuffer } from '../src/buffers';

// Reproducer for the body-materialization leak fixed in the D10
// USE_CDP_EVENT_BATCHED commit. Pre-fix, the wirePageEvents
// `requestfinished` listener called `await res.body()` just to read
// `.length`, allocating the full response body into a Bun Buffer on
// every request — multi-GB/hour of churn on long-lived headed
// Chromium with media-heavy pages.
//
// What this test pins:
//   - The handler calls Playwright's structured req.sizes() API
//     (which pulls from Network.loadingFinished without
//     materializing the body).
//   - The handler NEVER calls res.body(), even though a fake response
//     exposes the method.
//   - networkBuffer entries are still populated with the right size.
//
// What this test does NOT cover:
//   - A real Chromium burst measuring peak Bun RSS during concurrent
//     fetches. That's a periodic-tier test (browse/test/
//     memory-leak-reproducer-e2e.test.ts, deferred — see TODOS).
//   - Per-tab JS heap growth on the Chromium side. Outside Bun's
//     visibility entirely.
//
// Wall clock target: < 1 second. Gate tier.

interface CallCounters {
  sizes: number;
  body: number;
}

function makeFakeReq(url: string, responseBodySize: number, counters: CallCounters) {
  return {
    url: () => url,
    sizes: async () => {
      counters.sizes++;
      return {
        requestBodySize: 0,
        requestHeadersSize: 100,
        responseBodySize,
        responseHeadersSize: 200,
      };
    },
    method: () => 'GET',
    response: async () => ({
      url: () => url,
      status: () => 200,
      body: async () => {
        // If THIS runs, the leak is back. Allocate a real Buffer so a
        // future reviewer reading the failing assertion sees what
        // pre-fix code was doing on every request.
        counters.body++;
        return Buffer.alloc(responseBodySize);
      },
    }),
  };
}

interface ListenerMap {
  [event: string]: Array<(arg: unknown) => void>;
}

function makeFakePage() {
  const listeners: ListenerMap = {};
  return {
    on(event: string, fn: (arg: unknown) => void): void {
      (listeners[event] ||= []).push(fn);
    },
    emit(event: string, arg: unknown): void {
      for (const fn of listeners[event] || []) fn(arg);
    },
    listenerCount(event: string): number {
      return (listeners[event] || []).length;
    },
  };
}

describe('memory-leak reproducer: requestfinished does not materialize bodies', () => {
  test('burst of 200 requestfinished events calls req.sizes() but never res.body()', async () => {
    const bm = new BrowserManager();
    const page = makeFakePage();

    // wirePageEvents is private — access via the same indexed pattern the
    // tab-guardrail test uses to drive private methods.
    const wirePageEvents = (
      bm as unknown as { wirePageEvents: (p: unknown) => void }
    ).wirePageEvents.bind(bm);
    wirePageEvents(page);

    // Seed networkBuffer with 200 request entries via the existing
    // page.on('request') handler so the requestfinished backward-scan
    // has something to match against.
    const startLen = networkBuffer.length;
    for (let i = 0; i < 200; i++) {
      page.emit('request', {
        url: () => `https://example.invalid/asset/${i}`,
        method: () => 'GET',
      });
    }

    // Fire 200 requestfinished events concurrently. Each notional response
    // is 1 MB — pre-fix this would allocate 200 MB of Buffer. With the fix,
    // not one byte of body content is allocated.
    const counters: CallCounters = { sizes: 0, body: 0 };
    const reqs = Array.from({ length: 200 }, (_, i) =>
      makeFakeReq(`https://example.invalid/asset/${i}`, 1024 * 1024, counters),
    );
    for (const req of reqs) page.emit('requestfinished', req);

    // Drain the async handler chain — wirePageEvents.requestfinished is
    // async; each emit kicks off a microtask that awaits req.sizes().
    await new Promise((r) => setTimeout(r, 50));
    // One more tick in case of cascading microtasks.
    await new Promise((r) => setTimeout(r, 0));

    // Every event hit req.sizes().
    expect(counters.sizes).toBeGreaterThanOrEqual(200);
    // The actual leak fix: res.body() is NEVER called.
    expect(counters.body).toBe(0);
    // And the size data still made it into networkBuffer.
    const populated = Array.from({ length: networkBuffer.length }, (_, i) =>
      networkBuffer.get(i),
    )
      .filter((e) => e && e.url?.startsWith('https://example.invalid/asset/'))
      .filter((e) => typeof e?.size === 'number' && e.size > 0).length;
    expect(populated).toBeGreaterThanOrEqual(200);
    // Sanity: the seed didn't double-count from a previous run.
    expect(networkBuffer.length).toBeGreaterThan(startLen);
  });
});
