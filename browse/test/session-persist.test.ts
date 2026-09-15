/**
 * Opt-in session-state persistence (#778, #2193, #1128, #1129).
 *
 * Pins the leg of the browser-lifecycle contract that had no coverage:
 * "shut down without losing live session state." Pre-fix, the headless
 * daemon used non-persistent chromium.launch() with zero storage
 * persistence — any crash or binary-version auto-restart silently lost all
 * auth. These tests fail on the old tree (module absent, no wiring).
 *
 * Suites:
 *   1. Pure serialize/deserialize/filter units (free, instant).
 *   2. Real-Chromium round-trip: cookie + localStorage survive a full
 *      manager teardown + relaunch via persist/restore.
 *   3. Static wiring tripwire: server.ts restores at launch, snapshots at
 *      shutdown, and the gate is BROWSE_PERSIST_STATE (default off).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { canRevokeWrites } from '../../test/helpers/fs-caps';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  serializeSessionState, deserializeSessionState, filterSessionCookies,
  isSessionPersistEnabled, persistSessionState, restoreSessionState,
} from '../src/session-persist';
import type { BrowserState } from '../src/browser-manager';

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


const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-persist-'));
afterAll(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('session-persist units', () => {
  test('config gate: default off, exactly "1" enables', () => {
    expect(isSessionPersistEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isSessionPersistEnabled({ BROWSE_PERSIST_STATE: '0' } as any)).toBe(false);
    expect(isSessionPersistEnabled({ BROWSE_PERSIST_STATE: 'true' } as any)).toBe(false);
    expect(isSessionPersistEnabled({ BROWSE_PERSIST_STATE: '1' } as any)).toBe(true);
  });

  test('serialize strips loadedHtml/owner, keeps cookies + storage', () => {
    const state: BrowserState = {
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' } as any],
      pages: [{
        url: 'https://example.com/app',
        isActive: true,
        storage: { localStorage: { k: 'v' }, sessionStorage: {} },
        loadedHtml: '<script>evil</script>',
        loadedHtmlWaitUntil: 'load',
        owner: 'agent-1',
      }],
    };
    const raw = serializeSessionState(state);
    expect(raw).not.toContain('loadedHtml');
    expect(raw).not.toContain('evil');
    expect(raw).not.toContain('owner');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.cookies[0].name).toBe('sid');
    expect(parsed.pages[0].storage.localStorage.k).toBe('v');
  });

  test('deserialize rejects corrupt JSON, wrong version, missing arrays', () => {
    expect(deserializeSessionState('not json{')).toBeNull();
    expect(deserializeSessionState('{"version":99,"cookies":[],"pages":[]}')).toBeNull();
    expect(deserializeSessionState('{"version":1,"cookies":{}}')).toBeNull();
  });

  test('deserialize strips loadedHtml/owner even if tampered onto disk', () => {
    const raw = JSON.stringify({
      version: 1,
      cookies: [],
      pages: [{ url: 'https://x.com', isActive: true, storage: null, loadedHtml: '<h1>x</h1>', owner: 'evil' }],
    });
    const state = deserializeSessionState(raw)!;
    expect((state.pages[0] as any).loadedHtml).toBeUndefined();
    expect((state.pages[0] as any).owner).toBeUndefined();
  });

  test('cookie filter drops malformed + internal-network domains', () => {
    const kept = filterSessionCookies([
      { name: 'ok', value: 'v', domain: 'example.com' },
      { name: 'ok2', value: 'v', domain: '.example.com' }, // leading-dot public domain kept
      { name: 'bad1', value: 'v', domain: 'localhost' },
      { name: 'bad2', value: 'v', domain: '.corp.internal' },
      { name: 'bad3', value: 'v', domain: '169.254.169.254' },
      { name: 'bad4', value: 'v', domain: '169.254.1.2' }, // whole link-local block, not just metadata
      { name: 'bad5', value: 'v', domain: '127.0.0.1' }, // IPv4 loopback literal
      { name: 'bad6', value: 'v', domain: '.127.0.0.1' }, // leading-dot loopback variant
      { name: 'bad7', value: 'v', domain: '::1' }, // IPv6 loopback
      { name: 'bad8', value: 'v', domain: '[::1]' }, // bracketed IPv6 loopback
      { name: 'bad9', value: 42, domain: 'example.com' },
      null,
    ]);
    expect(kept.map((c: any) => c.name)).toEqual(['ok', 'ok2']);
  });

  test('restoreSessionState: missing file → null, corrupt file → quarantined to .corrupt', async () => {
    const bmNeverCalled = { closeAllPages() { throw new Error('must not restore'); } } as any;
    expect(await restoreSessionState(bmNeverCalled, path.join(tmpRoot, 'nope.json'))).toBeNull();
    const corrupt = path.join(tmpRoot, 'corrupt.json');
    fs.writeFileSync(corrupt, '{oops');
    expect(await restoreSessionState(bmNeverCalled, corrupt)).toBeNull();
    expect(fs.existsSync(corrupt)).toBe(false); // moved aside, won't block every future launch
    expect(fs.existsSync(`${corrupt}.corrupt`)).toBe(true); // forensic artifact kept (R3)
  });

  test('persistSessionState is a no-op in headed mode (profile owns state)', async () => {
    const file = path.join(tmpRoot, 'headed.json');
    const bm = {
      getConnectionMode: () => 'headed',
      saveState() { throw new Error('must not snapshot headed session'); },
    } as any;
    await persistSessionState(bm, file);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('persist writes atomically: no .tmp left behind, file parses', async () => {
    const file = path.join(tmpRoot, 'atomic.json');
    const state: BrowserState = {
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com' } as any],
      pages: [{ url: 'https://example.com', isActive: true, storage: null }],
    };
    const bm = { getConnectionMode: () => 'launched', saveState: async () => state } as any;
    await persistSessionState(bm, file);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false); // staged copy renamed away
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.cookies[0].name).toBe('sid');
  });

  test('a failed snapshot write preserves the previous good snapshot', async () => {
    // chmod-based read-only dirs don't bind on Windows or when running as root.
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    const dir = path.join(tmpRoot, 'ro');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'session-state.json');
    const goodState: BrowserState = {
      cookies: [],
      pages: [{ url: 'https://good.example', isActive: true, storage: null }],
    };
    const bm = { getConnectionMode: () => 'launched', saveState: async () => goodState } as any;
    await persistSessionState(bm, file);
    fs.chmodSync(dir, 0o500); // next .tmp write throws EACCES mid-persist
    try {
      await expect(persistSessionState(bm, file)).rejects.toThrow();
      // The crash-mid-write scenario the feature exists to survive: the
      // previous good snapshot is untouched and still parses.
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(parsed.pages[0].url).toBe('https://good.example');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('session-persist round-trip (real Chromium)', () => {
  test('cookie + localStorage + URL survive teardown → relaunch; loopback cookies dropped', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const { startTestServer } = await import('./test-server');
    const { server, url } = startTestServer(0);
    const stateFile = path.join(tmpRoot, 'roundtrip.json');

    const bm1 = new BrowserManager();
    await bm1.launch();
    try {
      const page = bm1.getPage();
      await page.goto(`${url}/basic.html`, { waitUntil: 'domcontentloaded' });
      // Real-site cookie: set on the context for a non-loopback domain (the
      // restore hygiene filter deliberately drops loopback/link-local
      // domains, so a 127.0.0.1 test-server cookie can't stand in for it).
      await page.context().addCookies([
        { name: 'session_marker', value: 'alive-after-restart', domain: 'example.com', path: '/' },
      ]);
      await page.evaluate(() => {
        document.cookie = 'loopback_marker=must-be-dropped; path=/'; // 127.0.0.1 host cookie
        localStorage.setItem('auth_marker', 'still-logged-in');
      });
      await persistSessionState(bm1, stateFile);
    } finally {
      await bm1.close();
    }

    // File on disk is owner-only (cookies are secrets).
    if (process.platform !== 'win32') {
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    }

    const bm2 = new BrowserManager();
    await bm2.launch();
    try {
      const restored = await restoreSessionState(bm2, stateFile);
      expect(restored).not.toBeNull();
      expect(restored!.pages.length).toBe(1); // counts derivable without a saveState() round-trip
      // Hygiene filter applied at restore: the real-site cookie survives,
      // the loopback cookie does not.
      expect(restored!.cookies.map((c: any) => c.name)).toEqual(['session_marker']);
      const page = bm2.getPage();
      expect(page.url()).toContain('/basic.html');
      const marker = await page.evaluate(() => ({
        cookie: document.cookie,
        auth: localStorage.getItem('auth_marker'),
      }));
      expect(marker.cookie).not.toContain('loopback_marker'); // dropped by isInternalCookieDomain
      expect(marker.auth).toBe('still-logged-in');
      const restoredCookies = await page.context().cookies('https://example.com');
      expect(restoredCookies.map((c) => `${c.name}=${c.value}`)).toContain('session_marker=alive-after-restart');
    } finally {
      await bm2.close();
      server.stop(true);
    }
  }, 60_000);
});

describe('server wiring (static tripwire)', () => {
  const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'server.ts'), 'utf-8');

  test('start() restores and schedules interval snapshots behind the gate', () => {
    expect(SERVER_SRC).toContain('isSessionPersistEnabled()');
    expect(SERVER_SRC).toContain('restoreSessionState(browserManager');
    expect(SERVER_SRC).toContain('sessionPersistIntervalMs()');
  });

  test('start() restores in the background AFTER the port binds (CLI readiness must not wait)', () => {
    // Restore re-creates tabs with up-to-15s goto timeouts; the CLI gives up
    // at 8s. A restore that runs before Bun.serve() makes every $B command
    // report "Server failed to start" on one slow saved URL.
    const serveAt = SERVER_SRC.indexOf('const server = Bun.serve(');
    const restoreAt = SERVER_SRC.indexOf('restoreSessionState(browserManager');
    expect(serveAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(serveAt);
  });

  test('interval snapshots carry an in-flight guard (no overlapping persists)', () => {
    expect(SERVER_SRC).toContain('persistInFlight');
  });

  test('interval ticks are gated on isShuttingDown (belt half of the shutdown ordering fix)', () => {
    // A tick that fires during browser teardown snapshots a degraded state
    // (zero tabs) over the good final snapshot. The handle-clear in shutdown()
    // is the suspenders; this gate is the belt for a tick already scheduled.
    const tickerAt = SERVER_SRC.indexOf('sessionPersistInterval = setInterval(');
    expect(tickerAt).toBeGreaterThan(-1);
    const tickerBlock = SERVER_SRC.slice(tickerAt, tickerAt + 500);
    expect(tickerBlock).toContain('if (isShuttingDown) return;');
  });

  test('shutdown() clears the persist ticker BEFORE the final snapshot (suspenders half)', () => {
    const shutdownStart = SERVER_SRC.indexOf('async function shutdown(');
    const clearAt = SERVER_SRC.indexOf('clearInterval(sessionPersistInterval)', shutdownStart);
    const persistAt = SERVER_SRC.indexOf('persistSessionState(cfgBrowserManager', shutdownStart);
    expect(clearAt).toBeGreaterThan(shutdownStart);
    expect(persistAt).toBeGreaterThan(clearAt);
  });

  test('shutdown() takes a final snapshot BEFORE closing the browser', () => {
    const shutdownStart = SERVER_SRC.indexOf('async function shutdown(');
    const persistAt = SERVER_SRC.indexOf('persistSessionState(cfgBrowserManager', shutdownStart);
    const closeAt = SERVER_SRC.indexOf('await cfgBrowserManager.close()', shutdownStart);
    expect(persistAt).toBeGreaterThan(shutdownStart);
    expect(closeAt).toBeGreaterThan(persistAt);
  });

  test('shutdown() snapshot is deadlined — a wedged page.evaluate cannot hang shutdown', () => {
    const shutdownStart = SERVER_SRC.indexOf('async function shutdown(');
    const closeAt = SERVER_SRC.indexOf('await cfgBrowserManager.close()', shutdownStart);
    const raceAt = SERVER_SRC.indexOf('Promise.race', shutdownStart);
    expect(raceAt).toBeGreaterThan(shutdownStart);
    expect(raceAt).toBeLessThan(closeAt);
  });
});
