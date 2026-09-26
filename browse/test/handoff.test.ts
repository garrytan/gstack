/**
 * Tests for handoff/resume commands — headless-to-headed browser switching.
 *
 * Unit tests cover saveState/restoreState, failure tracking, and edge cases.
 * Integration tests cover the full handoff flow with real Playwright browsers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager, type BrowserState } from '../src/browser-manager';
import { handleWriteCommand as _handleWriteCommand } from '../src/write-commands';
import { handleMetaCommand } from '../src/meta-commands';
import { spawnXvfb, pickFreeDisplay, isOurXvfb, type XvfbHandle } from '../src/xvfb';

// Per-FILE Chromium profile: this file launches an in-process persistent
// context (BrowserManager.launch()), and sharing a profile dir with the
// long-lived browse daemon a sibling file may have spawned kills one side's
// Chromium (ProcessSingleton on user-data-dir). Scoped via hooks, never
// module scope (see test/gstack-home-module-scope.test.ts's rationale).
const ORIGINAL_CHROMIUM_PROFILE = process.env.CHROMIUM_PROFILE;
let CHROMIUM_PROFILE_DIR: string | undefined;
beforeAll(() => {
  CHROMIUM_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-profile-'));
  process.env.CHROMIUM_PROFILE = CHROMIUM_PROFILE_DIR;
});


afterAll(() => {
  if (ORIGINAL_CHROMIUM_PROFILE === undefined) delete process.env.CHROMIUM_PROFILE;
  else process.env.CHROMIUM_PROFILE = ORIGINAL_CHROMIUM_PROFILE;
  if (CHROMIUM_PROFILE_DIR) { try { fs.rmSync(CHROMIUM_PROFILE_DIR, { recursive: true, force: true }); } catch {} }
});


const handleWriteCommand = (cmd: string, args: string[], b: BrowserManager) =>
  _handleWriteCommand(cmd, args, b.getActiveSession(), b);

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { testServer.server.stop(true); } catch {}  // force-close keep-alives — a lingering Chromium connection otherwise blocks stop() forever
  // Close only this file's own browser — never process.exit(): bun test runs
  // all files in one process, so a delayed exit kills the whole suite
  // (see test/no-suicide-exit.test.ts). close() can hang when the browser
  // already died, and its internal 5s timeout ties bun's 5s hook timeout —
  // so race it at 3s and abandon; the child is reaped at process exit.
  try { await Promise.race([bm?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
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

// Headed-mode launch is broken on current macOS (the rebrand invalidates the
// Chrome-for-Testing bundle signature and XProtect kills the relaunch —
// #2242, #2554, #2138). These three integration tests drive a real headed
// handoff and fail ~5s in on any darwin box. They stay ENABLED on Linux CI.
// Un-skip when the browse-daemon lifecycle wave lands the signature fix.
const HEADED_BROKEN_ON_DARWIN = process.platform === 'darwin';

describe('handoff integration', () => {
  test.skipIf(process.platform !== 'linux')('restore failure after candidate assignment leaves the original manager and pages usable', async () => {
    const displayNum = pickFreeDisplay();
    expect(displayNum).not.toBeNull();
    const display = await spawnXvfb(displayNum!);
    const originalDisplay = process.env.DISPLAY;
    process.env.DISPLAY = display.display;
    const hbm = new BrowserManager();
    let originalBrowser: any;
    try {
      await hbm.launch();
      originalBrowser = (hbm as any).browser;
      const originalContext = (hbm as any).context;
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
      await hbm.newTab(baseUrl + '/form.html', 'owner-control');
      const oldPage = hbm.getPage();
      const oldSession = hbm.getActiveSession();
      const oldTabs = (hbm as any).pages;
      const oldOwnership = new Map((hbm as any).tabOwnership);
      const oldNextId = (hbm as any).nextTabId;
      let promoted = 0;
      hbm.onHeadedPromotion = () => { promoted++; };
      const restore = hbm.restoreState.bind(hbm);
      hbm.restoreState = async (state) => {
        await restore(state);
        expect((hbm as any).context).not.toBe(originalContext);
        expect(hbm.getPage()).not.toBe(oldPage);
        throw new Error('injected after actual restore');
      };
      const result = await hbm.handoff('rollback control');
      expect(result).toContain('injected after actual restore');
      expect((hbm as any).context).toBe(originalContext);
      expect(hbm.getPage()).toBe(oldPage);
      expect(hbm.getActiveSession()).toBe(oldSession);
      expect((hbm as any).pages).toBe(oldTabs);
      expect((hbm as any).tabOwnership).toEqual(oldOwnership);
      expect((hbm as any).nextTabId).toBe(oldNextId);
      expect(hbm.getConnectionMode()).toBe('launched');
      expect(hbm.getIsHeaded()).toBe(false);
      expect(promoted).toBe(0);
      expect(await hbm.isHealthy()).toBe(true);
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
      expect(hbm.getPage().url()).toBe(baseUrl + '/basic.html');
      expect(isOurXvfb(display.pid, display.startTime)).toBe(true);
    } finally {
      await hbm.close();
      await originalBrowser?.close().catch(() => {});
      expect(isOurXvfb(display.pid, display.startTime)).toBe(true);
      display.close();
      if (originalDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = originalDisplay;
    }
  }, 30000);

  test.skipIf(HEADED_BROKEN_ON_DARWIN)('full handoff: cookies preserved, headed mode active, commands work', async () => {
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

  test.skipIf(HEADED_BROKEN_ON_DARWIN)('multi-tab handoff preserves all tabs', async () => {
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

  test.skipIf(HEADED_BROKEN_ON_DARWIN)('handoff meta command joins args as message', async () => {
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

describe.skipIf(process.platform !== 'linux')('lazy owned display lifecycle', () => {
  let savedEnv: NodeJS.ProcessEnv;
  let root: string;
  let hbm: BrowserManager;
  const displays = () => {
    const result = Bun.spawnSync(['ps', '--ppid', String(process.pid), '-o', 'comm='], {
      stdout: 'pipe', stderr: 'pipe', timeout: 2000,
    });
    return result.stdout.toString().split('\n').filter(line => line.trim() === 'Xvfb').length;
  };

  beforeEach(async () => {
    savedEnv = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-handoff-display-'));
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.BROWSE_HEADED;
    process.env.CHROMIUM_PROFILE = path.join(root, 'profile');
    hbm = new BrowserManager();
    await hbm.launch();
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
  });

  afterEach(async () => {
    await hbm?.close();
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'BROWSE_HEADED', 'CHROMIUM_PROFILE', 'PATH']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }, 15000);

  test('ordinary headless commands allocate no display', async () => {
    await hbm.newTab(baseUrl + '/form.html');
    expect(hbm.getXvfbHandle()).toBeNull();
    expect(displays()).toBe(0);
    expect(await hbm.isHealthy()).toBe(true);
  }, 15000);

  test('shutdown cleans a display that finishes allocation after teardown starts', async () => {
    const allocation = hbm.ensureHeadedDisplay();
    const outcome = allocation.then(() => 'resolved', error => String(error));
    await hbm.close();
    expect(await outcome).toContain('Browser is shutting down');
    expect(hbm.getXvfbHandle()).toBeNull();
    expect(displays()).toBe(0);
  }, 15000);

  test('concurrent promotion owns one display, preserves commands, and cleans it on shutdown', async () => {
    expect(displays()).toBe(0);
    const results = await Promise.all([hbm.handoff('one promotion'), hbm.handoff('same promotion')]);
    expect(results[0]).toBe(results[1]);
    expect(results[0]).toContain('Off-screen Xvfb');
    expect(results[0]).toContain('separate remote desktop');
    const handle = hbm.getXvfbHandle()!;
    expect(handle).not.toBeNull();
    expect(isOurXvfb(handle.pid, handle.startTime)).toBe(true);
    expect(displays()).toBe(1);
    expect(process.env.DISPLAY).toBeUndefined();
    await hbm.newTab(baseUrl + '/form.html');
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
    expect(hbm.getPage().url()).toBe(baseUrl + '/basic.html');
    expect(await hbm.getPage().evaluate(() => typeof (window as any).chrome?.runtime?.sendMessage)).toBe('undefined');
    expect(await handleMetaCommand('resume', [], hbm, () => {})).toContain('RESUMED');
    expect(await hbm.handoff('again')).toContain('Already in headed mode');
    expect(displays()).toBe(1);
    await hbm.close();
    expect(hbm.getXvfbHandle()).toBeNull();
    expect(isOurXvfb(handle.pid, handle.startTime)).toBe(false);
  }, 30000);

  for (const phase of ['before launch', 'after restore'] as const) {
    test(`failure ${phase} rolls back and releases only the allocated display`, async () => {
      const oldPage = hbm.getPage();
      const oldContext = (hbm as any).context;
      const oldSession = hbm.getActiveSession();
      let handle: XvfbHandle | null = null;
      const ensure = hbm.ensureHeadedDisplay.bind(hbm);
      hbm.ensureHeadedDisplay = async () => { await ensure(); handle = hbm.getXvfbHandle(); };
      if (phase === 'before launch') {
        process.env.CHROMIUM_PROFILE = path.join(root, 'not-a-directory');
        fs.writeFileSync(process.env.CHROMIUM_PROFILE, 'fixture');
      } else {
        const restore = hbm.restoreState.bind(hbm);
        hbm.restoreState = async (state) => {
          await restore(state);
          expect((hbm as any).context).not.toBe(oldContext);
          throw new Error('injected after restore');
        };
      }
      let promotions = 0;
      hbm.onHeadedPromotion = () => { promotions++; };
      const result = await hbm.handoff('failure control');
      expect(result).toStartWith('ERROR:');
      expect(handle).not.toBeNull();
      expect(isOurXvfb(handle!.pid, handle!.startTime)).toBe(false);
      expect(hbm.getXvfbHandle()).toBeNull();
      expect(hbm.getPage()).toBe(oldPage);
      expect(hbm.getActiveSession()).toBe(oldSession);
      expect((hbm as any).context).toBe(oldContext);
      expect(hbm.getConnectionMode()).toBe('launched');
      expect(hbm.getIsHeaded()).toBe(false);
      expect(promotions).toBe(0);
      expect(await hbm.isHealthy()).toBe(true);
      await handleWriteCommand('goto', [baseUrl + '/form.html'], hbm);
      expect(hbm.getPage().url()).toBe(baseUrl + '/form.html');
    }, 30000);
  }

  for (const phase of ['capture', 'restore'] as const) {
    test(`shutdown cancels stalled ${phase} without a late promotion`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalBrowser = (hbm as any).browser;
      const oldPage = hbm.getPage();
      (hbm as any).closeRaceMs = 100;
      let handle: XvfbHandle | null = null;
      let promotions = 0;
      hbm.onHeadedPromotion = () => { promotions++; };
      if (phase === 'capture') {
        const save = hbm.saveState.bind(hbm);
        hbm.saveState = async () => {
          const state = await save();
          entered.resolve();
          await release.promise;
          return state;
        };
      } else {
        const restore = hbm.restoreState.bind(hbm);
        hbm.restoreState = async (state) => {
          await restore(state);
          handle = hbm.getXvfbHandle();
          entered.resolve();
          await release.promise;
        };
      }
      const promotion = hbm.handoff('stalled renderer');
      await entered.promise;
      const closing = hbm.close();
      try {
        expect(await Promise.race([closing.then(() => true), Bun.sleep(2000).then(() => false)])).toBe(true);
        expect(oldPage.isClosed()).toBe(true);
        if (handle) expect(isOurXvfb(handle.pid, handle.startTime)).toBe(false);
      } finally {
        release.resolve();
        await promotion.catch(() => {});
        await closing;
        await originalBrowser.close().catch(() => {});
      }
      expect(promotions).toBe(0);
      expect((hbm as any).browser).toBeNull();
      expect(hbm.getXvfbHandle()).toBeNull();
    }, 30000);
  }

  test('rollback retains original tab close and navigation events during candidate restore', async () => {
    const remainingPage = hbm.getPage();
    const remainingSession = hbm.getActiveSession();
    remainingSession.setRefMap(new Map([['e1', { locator: remainingPage.locator('body'), role: 'document', name: '' }]]));
    await hbm.newTab(baseUrl + '/form.html');
    const closingPage = hbm.getPage();
    const restore = hbm.restoreState.bind(hbm);
    hbm.restoreState = async (state) => {
      await restore(state);
      await closingPage.close();
      await remainingPage.goto(baseUrl + '/form.html');
      throw new Error('rollback after original tab events');
    };
    expect(await hbm.handoff('event rollback')).toContain('rollback after original tab events');
    expect(hbm.getTabCount()).toBe(1);
    expect(hbm.getPage()).toBe(remainingPage);
    expect(hbm.getActiveSession()).toBe(remainingSession);
    expect(hbm.getRefCount()).toBe(0);
    expect(await hbm.isHealthy()).toBe(true);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], hbm);
  }, 30000);

});
