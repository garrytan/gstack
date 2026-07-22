/**
 * Tests for watch mode state machine in BrowserManager.
 *
 * Pure unit tests — no browser needed. Just instantiate BrowserManager
 * and test the watch state methods (startWatch, stopWatch, addWatchSnapshot,
 * isWatching).
 *
 * watch stop only ever displayed the latest snapshot, so the manager keeps
 * just the last snapshot + a count rather than retaining every 5s capture.
 */

import { describe, test, expect } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';

describe('watch mode — state machine', () => {
  test('isWatching returns false by default', () => {
    const bm = new BrowserManager();
    expect(bm.isWatching()).toBe(false);
  });

  test('startWatch sets isWatching to true', () => {
    const bm = new BrowserManager();
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
  });

  test('stopWatch clears isWatching and returns count + last snapshot', () => {
    const bm = new BrowserManager();
    bm.startWatch();
    bm.addWatchSnapshot('snapshot-1');
    bm.addWatchSnapshot('snapshot-2');

    const result = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(result.count).toBe(2);
    expect(result.last).toBe('snapshot-2');
  });

  test('stopWatch returns correct duration (approximately)', async () => {
    const bm = new BrowserManager();
    bm.startWatch();

    // Wait ~50ms to get a measurable duration
    await new Promise(resolve => setTimeout(resolve, 50));

    const result = bm.stopWatch();
    // Duration should be at least 40ms (allowing for timer imprecision)
    expect(result.duration).toBeGreaterThanOrEqual(40);
    // And less than 5 seconds (sanity check)
    expect(result.duration).toBeLessThan(5000);
  });

  test('addWatchSnapshot only retains the latest snapshot + count', () => {
    const bm = new BrowserManager();
    bm.startWatch();

    bm.addWatchSnapshot('page A content');
    bm.addWatchSnapshot('page B content');
    bm.addWatchSnapshot('page C content');

    const result = bm.stopWatch();
    expect(result.count).toBe(3);
    expect(result.last).toBe('page C content');
  });

  test('stopWatch resets state for next cycle', () => {
    const bm = new BrowserManager();

    // First cycle
    bm.startWatch();
    bm.addWatchSnapshot('first-cycle-snapshot');
    const result1 = bm.stopWatch();
    expect(result1.count).toBe(1);
    expect(result1.last).toBe('first-cycle-snapshot');

    // Second cycle — should start fresh
    bm.startWatch();
    const result2 = bm.stopWatch();
    expect(result2.count).toBe(0);
    expect(result2.last).toBeNull();
  });

  test('multiple start/stop cycles work correctly', () => {
    const bm = new BrowserManager();

    // Cycle 1
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
    bm.addWatchSnapshot('snap-1');
    const r1 = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(r1.count).toBe(1);
    expect(r1.last).toBe('snap-1');

    // Cycle 2
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
    bm.addWatchSnapshot('snap-2a');
    bm.addWatchSnapshot('snap-2b');
    const r2 = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(r2.count).toBe(2);
    expect(r2.last).toBe('snap-2b');

    // Cycle 3 — no snapshots added
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
    const r3 = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(r3.count).toBe(0);
    expect(r3.last).toBeNull();
  });

  test('stopWatch clears watchInterval if set', () => {
    const bm = new BrowserManager();
    bm.startWatch();

    // Simulate an interval being set (as the server does)
    bm.watchInterval = setInterval(() => {}, 100000);
    expect(bm.watchInterval).not.toBeNull();

    bm.stopWatch();
    expect(bm.watchInterval).toBeNull();
  });

  test('stopWatch without startWatch returns empty results', () => {
    const bm = new BrowserManager();

    // Calling stopWatch without startWatch should not throw
    const result = bm.stopWatch();
    expect(result.count).toBe(0);
    expect(result.last).toBeNull();
    expect(result.duration).toBeLessThanOrEqual(Date.now()); // duration = now - 0
    expect(bm.isWatching()).toBe(false);
  });
});
