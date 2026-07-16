import { describe, test, expect, beforeEach } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { subscribe } from '../src/activity';

// Tests for the tab-count guardrail. Each threshold fires exactly once per
// upward crossing and re-arms when the count drops back below. The toast
// UX lives in the sidebar; this exercises the server-side audit-trail
// invariant that an activity entry is emitted at each crossing.

interface CapturedEntry {
  type: string;
  command?: string;
  error?: string;
  tabs?: number;
}

function captureGuardrailEntries(): { entries: CapturedEntry[]; unsubscribe: () => void } {
  const entries: CapturedEntry[] = [];
  const unsubscribe = subscribe((entry) => {
    if (entry.command === 'tab-guardrail') {
      entries.push({
        type: entry.type,
        command: entry.command,
        error: entry.error,
        tabs: entry.tabs,
      });
    }
  });
  return { entries, unsubscribe };
}

/** Drive the guardrail by writing directly into the manager's pages map. */
async function setTabCount(bm: BrowserManager, n: number): Promise<void> {
  // Reach into private state via index access — test-only manipulation that
  // avoids spinning up a real Chromium just to verify the threshold math.
  const inner = bm as unknown as {
    pages: Map<number, unknown>;
    checkTabGuardrails: () => void;
    recheckTabGuardrailsOnClose: () => void;
  };
  inner.pages.clear();
  for (let i = 0; i < n; i++) inner.pages.set(i, { fakeTab: true });
  // Drive whichever direction matches the count change.
  inner.checkTabGuardrails();
  inner.recheckTabGuardrailsOnClose();
  // emitActivity dispatches subscribers via queueMicrotask, so let the
  // microtask queue drain before the test assertion runs.
  await new Promise((r) => setTimeout(r, 0));
}

describe('tab-count guardrail', () => {
  let bm: BrowserManager;
  let capture: ReturnType<typeof captureGuardrailEntries>;

  beforeEach(() => {
    bm = new BrowserManager();
    capture = captureGuardrailEntries();
  });

  test('1. no entry fires under the soft threshold', async () => {
    await setTabCount(bm, 10);
    await setTabCount(bm, 49);
    expect(capture.entries).toEqual([]);
    capture.unsubscribe();
  });

  test('2. soft threshold (50) fires exactly once on upward crossing', async () => {
    await setTabCount(bm, 49);
    await setTabCount(bm, 50);
    await setTabCount(bm, 51);
    await setTabCount(bm, 60);
    expect(capture.entries.length).toBe(1);
    expect(capture.entries[0].tabs).toBe(50);
    expect(capture.entries[0].error).toContain('crossed 50');
    capture.unsubscribe();
  });

  test('3. hard threshold (200) fires exactly once on upward crossing', async () => {
    await setTabCount(bm, 199);
    await setTabCount(bm, 200);
    await setTabCount(bm, 201);
    await setTabCount(bm, 220);
    // 0 → 199 fired the soft threshold; 199 → 200 fires the hard one once.
    const hardEntries = capture.entries.filter((e) => e.error?.includes('crossed 200'));
    expect(hardEntries.length).toBe(1);
    expect(hardEntries[0].tabs).toBe(200);
    capture.unsubscribe();
  });

  test('4. both thresholds fire in order when count jumps from 0 → 250', async () => {
    await setTabCount(bm, 250);
    expect(capture.entries.length).toBe(2);
    expect(capture.entries[0].error).toContain('crossed 50');
    expect(capture.entries[1].error).toContain('crossed 200');
    capture.unsubscribe();
  });

  test('5. soft threshold re-arms when tab count drops below it', async () => {
    await setTabCount(bm, 60);
    expect(capture.entries.length).toBe(1);
    await setTabCount(bm, 30);
    await setTabCount(bm, 55);
    expect(capture.entries.length).toBe(2);
    expect(capture.entries[1].error).toContain('crossed 50');
    capture.unsubscribe();
  });

  test('6. hard threshold re-arms when tab count drops below it', async () => {
    await setTabCount(bm, 210);
    const beforeReArm = capture.entries.filter((e) => e.error?.includes('crossed 200')).length;
    expect(beforeReArm).toBe(1);
    await setTabCount(bm, 150);
    await setTabCount(bm, 220);
    const afterReArm = capture.entries.filter((e) => e.error?.includes('crossed 200')).length;
    expect(afterReArm).toBe(2);
    capture.unsubscribe();
  });
});
