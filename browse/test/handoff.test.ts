/**
 * Tests for handoff/resume commands — headless-to-headed browser switching.
 *
 * Unit tests cover saveState/restoreState, failure tracking, and edge cases.
 * Integration tests cover the full handoff flow with real Playwright browsers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager, type BrowserState } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

// ─── Unit Tests: Failure Tracking (no browser needed) ────────────

describe('failure tracking', () => {
  test('getFailureHint returns null when below threshold', () => {
    const tracker = new BrowserManager();
    tracker.incrementFailures();
    tracker.incrementFailures();
    expect(tracker.getFailureHint()).toBeNull();
  });

  test('getFailureHint returns hint after 3 consecutive failures', () => {
    const tracker = new BrowserManager();
    tracker.incrementFailures();
    tracker.incrementFailures();
    tracker.incrementFailures();
    const hint = tracker.getFailureHint();
    expect(hint).not.toBeNull();
    expect(hint).toContain('handoff');
    expect(hint).toContain('3');
  });

  test('hint suppressed when already headed', () => {
    const tracker = new BrowserManager();
    (tracker as any).isHeaded = true;
    tracker.incrementFailures();
    tracker.incrementFailures();
    tracker.incrementFailures();
    expect(tracker.getFailureHint()).toBeNull();
  });

  test('resetFailures clears the counter', () => {
    const tracker = new BrowserManager();
    tracker.incrementFailures();
    tracker.incrementFailures();
    tracker.incrementFailures();
    expect(tracker.getFailureHint()).not.toBeNull();
    tracker.resetFailures();
    expect(tracker.getFailureHint()).toBeNull();
  });

  test('getIsHeaded returns false by default', () => {
    const tracker = new BrowserManager();
    expect(tracker.getIsHeaded()).toBe(false);
  });
});

// ─── Unit Tests: State Save/Restore (shared browser) ─────────────

describe('saveState', () => {
  test('captures cookies and page URLs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['testcookie=testvalue'], bm);

    const state = await bm.saveState();

    expect(state.cookies.length).toBeGreaterThan(0);
    expect(state.cookies.some(c => c.name === 'testcookie')).toBe(true);
    expect(state.pages.length).toBeGreaterThanOrEqual(1);
    expect(state.pages.some(p => p.url.includes('/basic.html'))).toBe(true);
  }, 15000);

  test('captures localStorage and sessionStorage', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    await page.evaluate(() => {
      localStorage.setItem('lsKey', 'lsValue');
      sessionStorage.setItem('ssKey', 'ssValue');
    });

    const state = await bm.saveState();
    const activePage = state.pages.find(p => p.isActive);

    expect(activePage).toBeDefined();
    expect(activePage!.storage).not.toBeNull();
    expect(activePage!.storage!.localStorage).toHaveProperty('lsKey', 'lsValue');
    expect(activePage!.storage!.sessionStorage).toHaveProperty('ssKey', 'ssValue');
  }, 15000);

  test('captures multiple tabs', async () => {
    while (bm.getTabCount() > 1) {
      await bm.closeTab();
    }
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleMetaCommand('newtab', [baseUrl + '/form.html'], bm, () => {});

    const state = await bm.saveState();
    expect(state.pages.length).toBe(2);
    const activePage = state.pages.find(p => p.isActive);
    expect(activePage).toBeDefined();
    expect(activePage!.url).toContain('/form.html');

    await bm.closeTab();
  }, 15000);
});

describe('restoreState', () => {
  test('state survives recreateContext round-trip', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['restored=yes'], bm);

    const stateBefore = await bm.saveState();
    expect(stateBefore.cookies.some(c => c.name === 'restored')).toBe(true);

    await bm.recreateContext();

    const stateAfter = await bm.saveState();
    expect(stateAfter.cookies.some(c => c.name === 'restored')).toBe(true);
    expect(stateAfter.pages.length).toBeGreaterThanOrEqual(1);
  }, 30000);
});

// ─── Unit Tests: Handoff Edge Cases ──────────────────────────────

describe('handoff edge cases', () => {
  test('handoff when already headed returns no-op', async () => {
    (bm as any).isHeaded = true;
    const result = await bm.handoff('test');
    expect(result).toContain('Already in headed mode');
    (bm as any).isHeaded = false;
  }, 10000);

  test('resume clears refs and resets failures', () => {
    bm.incrementFailures();
    bm.incrementFailures();
    bm.incrementFailures();
    bm.resume();
    expect(bm.getFailureHint()).toBeNull();
    expect(bm.getRefCount()).toBe(0);
  });

  test('resume without prior handoff works via meta command', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('resume', [], bm, () => {});
    expect(result).toContain('RESUMED');
  }, 15000);
});

// ─── Integration Tests: Full Handoff Flow ────────────────────────
// Each handoff test creates its own BrowserManager since handoff swaps the browser.
// These tests run sequentially (one browser at a time) to avoid resource issues.

describe('handoff integration', () => {
  test('full handoff: cookies preserved, headed mode active, commands work', async () => {
    const hbm = new BrowserManager();
    await hbm.launch();

    try {
      // Set up state
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
      await handleWriteCommand('cookie', ['handoff_test=preserved'], hbm);

      // Handoff
      const result = await hbm.handoff('Testing handoff');
      expect(result).toContain('HANDOFF:');
      expect(result).toContain('Testing handoff');
      expect(result).toContain('resume');
      expect(hbm.getIsHeaded()).toBe(true);

      // Verify cookies survived
      const { handleReadCommand } = await import('../src/read-commands');
      const cookiesResult = await handleReadCommand('cookies', [], hbm);
      expect(cookiesResult).toContain('handoff_test');

      // Verify commands still work
      const text = await handleReadCommand('text', [], hbm);
      expect(text.length).toBeGreaterThan(0);

      // Resume
      const resumeResult = await handleMetaCommand('resume', [], hbm, () => {});
      expect(resumeResult).toContain('RESUMED');
    } finally {
      await hbm.close();
    }
  }, 45000);

  test('multi-tab handoff preserves all tabs', async () => {
    const hbm = new BrowserManager();
    await hbm.launch();

    try {
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
      await handleMetaCommand('newtab', [baseUrl + '/form.html'], hbm, () => {});
      expect(hbm.getTabCount()).toBe(2);

      await hbm.handoff('multi-tab test');
      expect(hbm.getTabCount()).toBe(2);
      expect(hbm.getIsHeaded()).toBe(true);
    } finally {
      await hbm.close();
    }
  }, 45000);

  test('handoff meta command joins args as message', async () => {
    const hbm = new BrowserManager();
    await hbm.launch();

    try {
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
      const result = await handleMetaCommand('handoff', ['CAPTCHA', 'stuck'], hbm, () => {});
      expect(result).toContain('CAPTCHA stuck');
    } finally {
      await hbm.close();
    }
  }, 45000);
});
