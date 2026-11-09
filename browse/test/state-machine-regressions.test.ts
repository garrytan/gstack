import { afterEach, expect, test } from 'bun:test';
import type { Response as PlaywrightResponse } from 'playwright';
import { clearCapture, getCaptureBuffer, getCaptureListener, isCaptureActive, startCapture, stopCapture } from '../src/network-capture';
import { createSseEndpoint } from '../src/sse-helpers';

afterEach(() => { stopCapture(); clearCapture(); });
function response(body: Promise<Buffer> = Promise.resolve(Buffer.from('ok'))): PlaywrightResponse {
  return { url: () => 'https://example.test/data', status: () => 200,
    headers: () => ({ 'content-type': 'text/plain' }), body: () => body } as unknown as PlaywrightResponse;
}
for (const transition of ['stop', 'restart', 'clear'] as const) {
  test(`pending response cannot cross ${transition}`, async () => {
    startCapture();
    let resolve!: (value: Buffer) => void;
    const pending = getCaptureListener()!(response(new Promise(r => { resolve = r; })));
    if (transition === 'stop') stopCapture();
    if (transition === 'restart') startCapture();
    if (transition === 'clear') clearCapture();
    resolve(Buffer.from('old'));
    await pending;
    expect(getCaptureBuffer().length).toBe(0);
    if (transition !== 'stop') {
      await getCaptureListener()!(response());
      expect(getCaptureBuffer().length).toBe(1);
    }
  });
}
test('stale listener cannot start work after stop; invalid filter preserves active session', async () => {
  startCapture();
  const listener = getCaptureListener()!;
  expect(() => startCapture('[')).toThrow();
  expect(isCaptureActive()).toBe(true);
  expect(getCaptureListener()).toBe(listener);
  await listener(response());
  expect(stopCapture().count).toBe(1);
  await listener(response());
  expect(getCaptureBuffer().length).toBe(1);
});
test('SSE cancellation releases subscription immediately and once', async () => {
  const abort = new AbortController();
  let released = 0;
  const res = createSseEndpoint(new Request('http://localhost', { signal: abort.signal }), {
    subscribe: () => () => { released++; }, liveEventName: 'test',
  });
  await res.body!.cancel();
  expect(released).toBe(1);
  abort.abort();
  expect(released).toBe(1);
});
test('already aborted SSE request never subscribes or replays', async () => {
  const abort = new AbortController(); abort.abort();
  let subscribed = 0, replayed = 0;
  const res = createSseEndpoint(new Request('http://localhost', { signal: abort.signal }), {
    initialReplay: () => { replayed++; },
    subscribe: () => { subscribed++; return () => {}; }, liveEventName: 'test',
  });
  await res.body!.cancel();
  expect(subscribed).toBe(0);
  expect(replayed).toBe(0);
});
test('abort during subscribe releases returned disposer exactly once', async () => {
  const abort = new AbortController(); let released = 0;
  const res = createSseEndpoint(new Request('http://localhost', { signal: abort.signal }), {
    subscribe: () => { abort.abort(); return () => { released++; }; }, liveEventName: 'test',
  });
  await res.body!.cancel();
  expect(released).toBe(1);
});
