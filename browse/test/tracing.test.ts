/**
 * Per-session tracing tests (agent-browser U8). Launch-free: drives a fake
 * context's tracing API to assert state transitions and guard errors.
 */

import { describe, it, expect } from 'bun:test';

import { BrowserManager } from '../src/browser-manager';

function bmWithTracingContext() {
  const bm = new BrowserManager();
  const calls: { started: boolean; stopPath?: string } = { started: false };
  (bm as any).cur.context = {
    tracing: {
      start: async () => { calls.started = true; },
      stop: async (opts: { path: string }) => { calls.stopPath = opts.path; },
    },
  };
  return { bm, calls };
}

describe('U8 per-session tracing', () => {
  it('starts and stops tracing, tracking session state', async () => {
    const { bm, calls } = bmWithTracingContext();
    expect(bm.isTracing()).toBe(false);
    await bm.startTracing();
    expect(bm.isTracing()).toBe(true);
    expect(calls.started).toBe(true);
    await bm.stopTracing('/tmp/t.zip');
    expect(bm.isTracing()).toBe(false);
    expect(calls.stopPath).toBe('/tmp/t.zip');
  });

  it('start is idempotent (no double-start)', async () => {
    const { bm } = bmWithTracingContext();
    await bm.startTracing();
    await bm.startTracing(); // no throw
    expect(bm.isTracing()).toBe(true);
  });

  it('throws when the session has no context', async () => {
    const bm = new BrowserManager();
    await expect(bm.startTracing()).rejects.toThrow(/no browser context/i);
  });

  it('throws when stopping without starting', async () => {
    const { bm } = bmWithTracingContext();
    await expect(bm.stopTracing('/tmp/x.zip')).rejects.toThrow(/not active/i);
  });
});
