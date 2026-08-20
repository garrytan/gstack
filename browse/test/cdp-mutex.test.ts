import { describe, it, expect } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';

describe('Two-tier CDP mutex (Codex T7)', () => {
  it('per-tab acquire returns a release fn that unlocks subsequent acquires', async () => {
    const bm = new BrowserManager();
    const release = await bm.acquireTabLock(1, 1000);
    expect(typeof release).toBe('function');
    release();
    // Second acquire on same tab must succeed quickly.
    const release2 = await bm.acquireTabLock(1, 100);
    release2();
  });

  it('per-tab serializes operations on the same tab', async () => {
    const bm = new BrowserManager();
    const events: string[] = [];
    async function op(label: string, holdMs: number) {
      const release = await bm.acquireTabLock(1, 5000);
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, holdMs));
      events.push(`${label}:end`);
      release();
    }
    await Promise.all([op('A', 80), op('B', 10), op('C', 10)]);
    // A's start happens before A's end, then B starts, then B ends, then C.
    // Strict A→B→C ordering with no interleaving.
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end']);
  });

  it('cross-tab tab locks DO run in parallel (no serialization)', async () => {
    const bm = new BrowserManager();
    const events: string[] = [];
    async function op(tabId: number, label: string, holdMs: number) {
      const release = await bm.acquireTabLock(tabId, 5000);
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, holdMs));
      events.push(`${label}:end`);
      release();
    }
    await Promise.all([op(1, 'tab1', 50), op(2, 'tab2', 50)]);
    // Both start before either ends — interleaved.
    const startsBeforeAnyEnd = events.slice(0, 2).every((e) => e.endsWith(':start'));
    expect(startsBeforeAnyEnd).toBe(true);
  });

  it('global lock blocks all tab locks; tab locks block global lock', async () => {
    const bm = new BrowserManager();
    const events: string[] = [];

    async function tabOp(tabId: number, label: string, holdMs: number) {
      const release = await bm.acquireTabLock(tabId, 5000);
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, holdMs));
      events.push(`${label}:end`);
      release();
    }
    async function globalOp(label: string, holdMs: number) {
      const release = await bm.acquireGlobalCdpLock(5000);
      events.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, holdMs));
      events.push(`${label}:end`);
      release();
    }

    // Tab1 starts first (holds 80ms). Global queues behind. Tab2 queues behind global.
    const tab1 = tabOp(1, 'tab1', 80);
    await new Promise((r) => setTimeout(r, 10)); // ensure tab1 started first
    const global = globalOp('global', 30);
    const tab2 = tabOp(2, 'tab2', 10);
    await Promise.all([tab1, global, tab2]);

    // tab1 must end before global starts (global waits for tab1)
    const tab1End = events.indexOf('tab1:end');
    const globalStart = events.indexOf('global:start');
    expect(tab1End).toBeGreaterThan(-1);
    expect(globalStart).toBeGreaterThan(tab1End);

    // global must end before tab2 starts (tab2 was queued after global)
    const globalEnd = events.indexOf('global:end');
    const tab2Start = events.indexOf('tab2:start');
    expect(tab2Start).toBeGreaterThan(globalEnd);
  });

  it('acquire timeout fires CDPMutexAcquireTimeout (no silent hang)', async () => {
    const bm = new BrowserManager();
    // Hold the tab lock indefinitely for this test.
    const heldRelease = await bm.acquireTabLock(1, 1000);
    // Try to acquire with a tiny timeout — must throw.
    await expect(bm.acquireTabLock(1, 50)).rejects.toThrow(/CDPMutexAcquireTimeout/);
    heldRelease();
  });

  it('acquire timeout error names the tab id', async () => {
    const bm = new BrowserManager();
    const heldRelease = await bm.acquireTabLock(7, 1000);
    try {
      await bm.acquireTabLock(7, 30);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('tab 7');
      expect(e.message).toContain('30ms');
    }
    heldRelease();
  });

  it('global lock acquire timeout fires CDPMutexAcquireTimeout', async () => {
    const bm = new BrowserManager();
    const heldRelease = await bm.acquireGlobalCdpLock(1000);
    await expect(bm.acquireGlobalCdpLock(30)).rejects.toThrow(/CDPMutexAcquireTimeout/);
    heldRelease();
  });
});
