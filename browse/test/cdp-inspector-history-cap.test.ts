import { describe, test, expect, beforeEach } from 'bun:test';
import type { Page } from 'playwright';
import {
  __testInternals,
  undoModification,
} from '../src/cdp-inspector';

// Regression tests for the modificationHistory cap (D6 / smoking gun #2).
// Pre-cap, the module-scoped array grew unbounded across the session. Cap is
// 200 entries, oldest evicted on push past the cap. undoModification reports
// "evicted at the cap" in the error message so a user who asks for a
// no-longer-available index understands what happened (instead of seeing the
// pre-cap "No modification at index 500" with no context).

const { pushModification, MOD_HISTORY_CAP, getRawHistory, getTotalPushed, resetForTest } = __testInternals;

function fakeMod(id: number) {
  return {
    selector: `#node-${id}`,
    property: 'color',
    oldValue: 'red',
    newValue: 'blue',
    source: 'inline' as const,
    timestamp: id,
    method: 'setProperty' as 'setProperty',
  };
}

beforeEach(() => {
  resetForTest();
});

describe('modificationHistory cap', () => {
  test('1. push under cap keeps every entry', () => {
    for (let i = 0; i < 50; i++) pushModification(fakeMod(i));
    expect(getRawHistory().length).toBe(50);
    expect(getTotalPushed()).toBe(50);
    expect(getRawHistory()[0].timestamp).toBe(0);
    expect(getRawHistory()[49].timestamp).toBe(49);
  });

  test('2. push exactly cap keeps every entry', () => {
    for (let i = 0; i < MOD_HISTORY_CAP; i++) pushModification(fakeMod(i));
    expect(getRawHistory().length).toBe(MOD_HISTORY_CAP);
    expect(getTotalPushed()).toBe(MOD_HISTORY_CAP);
    expect(getRawHistory()[0].timestamp).toBe(0);
  });

  test('3. push past cap evicts oldest, keeps length at cap', () => {
    const total = MOD_HISTORY_CAP + 50;
    for (let i = 0; i < total; i++) pushModification(fakeMod(i));
    expect(getRawHistory().length).toBe(MOD_HISTORY_CAP);
    expect(getTotalPushed()).toBe(total);
    // Oldest 50 dropped — entry that was #0 is gone; new oldest is #50.
    expect(getRawHistory()[0].timestamp).toBe(50);
    expect(getRawHistory()[MOD_HISTORY_CAP - 1].timestamp).toBe(total - 1);
  });

  test('4. resetForTest clears both buffer and totalPushed', () => {
    for (let i = 0; i < 10; i++) pushModification(fakeMod(i));
    resetForTest();
    expect(getRawHistory().length).toBe(0);
    expect(getTotalPushed()).toBe(0);
  });
});

describe('undoModification eviction-aware error', () => {
  // Stub Page: undoModification throws before any await when idx is out of
  // range, so the stub never actually gets called.
  const stubPage = {} as unknown as Page;

  test('5. out-of-range BEFORE any eviction → no evicted note', async () => {
    for (let i = 0; i < 5; i++) pushModification(fakeMod(i));
    await expect(undoModification(stubPage, 99)).rejects.toThrow(
      'No modification at index 99. History has 5 entries.',
    );
  });

  test('6. out-of-range AFTER eviction → message names the evicted count', async () => {
    const total = MOD_HISTORY_CAP + 73;
    for (let i = 0; i < total; i++) pushModification(fakeMod(i));
    // 273 pushed, 200 in buffer, 73 evicted. Ask for idx=400 (above buffer).
    await expect(undoModification(stubPage, 400)).rejects.toThrow(
      `No modification at index 400. History has ${MOD_HISTORY_CAP} entries ` +
      `(most recent ${MOD_HISTORY_CAP} only — 73 earlier entries evicted at the cap).`,
    );
  });

  test('7. negative explicit index throws cleanly (no NaN propagation)', async () => {
    for (let i = 0; i < 10; i++) pushModification(fakeMod(i));
    await expect(undoModification(stubPage, -1)).rejects.toThrow(
      'No modification at index -1.',
    );
  });
});
