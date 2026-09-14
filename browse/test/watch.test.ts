/**
 * Tests for watch mode state machine in BrowserManager.
 *
 * Pure unit tests — no browser needed. Just instantiate BrowserManager
 * and test the watch state methods (startWatch, stopWatch, addWatchSnapshot,
 * isWatching).
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

  test('stopWatch clears isWatching and returns snapshots', () => {
    const bm = new BrowserManager();
    bm.startWatch();
    bm.addWatchSnapshot('snapshot-1');
    bm.addWatchSnapshot('snapshot-2');

    const result = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(result.snapshots).toEqual(['snapshot-1', 'snapshot-2']);
    expect(result.snapshots.length).toBe(2);
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

  test('addWatchSnapshot stores snapshots', () => {
    const bm = new BrowserManager();
    bm.startWatch();

    bm.addWatchSnapshot('page A content');
    bm.addWatchSnapshot('page B content');
    bm.addWatchSnapshot('page C content');

    const result = bm.stopWatch();
    expect(result.snapshots.length).toBe(3);
    expect(result.snapshots[0]).toBe('page A content');
    expect(result.snapshots[1]).toBe('page B content');
    expect(result.snapshots[2]).toBe('page C content');
  });

  test('stopWatch resets snapshots for next cycle', () => {
    const bm = new BrowserManager();

    // First cycle
    bm.startWatch();
    bm.addWatchSnapshot('first-cycle-snapshot');
    const result1 = bm.stopWatch();
    expect(result1.snapshots.length).toBe(1);

    // Second cycle — should start fresh
    bm.startWatch();
    const result2 = bm.stopWatch();
    expect(result2.snapshots.length).toBe(0);
  });

  test('multiple start/stop cycles work correctly', () => {
    const bm = new BrowserManager();

    // Cycle 1
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
    bm.addWatchSnapshot('snap-1');
    const r1 = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(r1.snapshots).toEqual(['snap-1']);

    // Cycle 2
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
    bm.addWatchSnapshot('snap-2a');
    bm.addWatchSnapshot('snap-2b');
    const r2 = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(r2.snapshots).toEqual(['snap-2a', 'snap-2b']);

    // Cycle 3 — no snapshots added
    bm.startWatch();
    expect(bm.isWatching()).toBe(true);
    const r3 = bm.stopWatch();
    expect(bm.isWatching()).toBe(false);
    expect(r3.snapshots).toEqual([]);
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
    expect(result.snapshots).toEqual([]);
    expect(result.duration).toBeLessThanOrEqual(Date.now()); // duration = now - 0
    expect(bm.isWatching()).toBe(false);
  });
});
