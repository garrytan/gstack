/**
 * `state save|load` must carry localStorage (#778 follow-on).
 *
 * #778 ("auth state is lost across separate invocations") was closed by the
 * opt-in session-persistence path, which does persist per-tab storage. The
 * MANUAL path — `browse state save <name>` / `state load <name>` — kept
 * writing cookies and URLs only, behind a comment reading "not localStorage —
 * breaks on load-before-navigate".
 *
 * That reasoning no longer holds: BrowserManager.restoreState navigates each
 * tab to its saved URL FIRST and applies storage after, so there is no
 * load-before-navigate window. Meanwhile the omission silently broke every
 * token-in-localStorage login — Supabase, Firebase, most SPA auth keeps its
 * session there, not in a cookie. `state load` restored hundreds of cookies,
 * printed a success line, and handed back a signed-OUT browser with no error
 * anywhere. The failure surfaced much later as an unexplained redirect to a
 * sign-in page.
 *
 * Suites:
 *   1. sanitizeTabStorage units — the shared disk-shape validator.
 *   2. Real-Chromium round-trip through handleMetaCommand: localStorage
 *      written before `state save` is readable after `state load`.
 *   3. Backward compatibility: a pre-fix file (no `storage` key) still loads.
 *
 * These fail on the old tree: suite 1's module export is absent, and suites
 * 2/3 get `null` storage back.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sanitizeTabStorage } from '../src/session-persist';

// Per-FILE Chromium profile, for the same reason session-persist.test.ts
// isolates one: sharing a profile dir with a sibling file's daemon kills one
// side's Chromium via ProcessSingleton on user-data-dir.
const ORIGINAL_CHROMIUM_PROFILE = process.env.CHROMIUM_PROFILE;
const ORIGINAL_STATE_FILE = process.env.BROWSE_STATE_FILE;
let CHROMIUM_PROFILE_DIR: string | undefined;
let tmpRoot: string;

beforeAll(() => {
  CHROMIUM_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-state-ls-profile-'));
  process.env.CHROMIUM_PROFILE = CHROMIUM_PROFILE_DIR;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-state-ls-'));
  // resolveConfig() derives stateDir from BROWSE_STATE_FILE's parent, so this
  // keeps `state save` inside the tmp tree instead of the real ~/.gstack.
  process.env.BROWSE_STATE_FILE = path.join(tmpRoot, 'browse.json');
});

afterAll(() => {
  if (ORIGINAL_CHROMIUM_PROFILE === undefined) delete process.env.CHROMIUM_PROFILE;
  else process.env.CHROMIUM_PROFILE = ORIGINAL_CHROMIUM_PROFILE;
  if (ORIGINAL_STATE_FILE === undefined) delete process.env.BROWSE_STATE_FILE;
  else process.env.BROWSE_STATE_FILE = ORIGINAL_STATE_FILE;
  if (CHROMIUM_PROFILE_DIR) { try { fs.rmSync(CHROMIUM_PROFILE_DIR, { recursive: true, force: true }); } catch {} }
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
});

describe('sanitizeTabStorage (units)', () => {
  test('null for anything that is not an object', () => {
    expect(sanitizeTabStorage(null)).toBeNull();
    expect(sanitizeTabStorage(undefined)).toBeNull();
    expect(sanitizeTabStorage('nope')).toBeNull();
    expect(sanitizeTabStorage(42)).toBeNull();
  });

  test('keeps string entries in both stores', () => {
    const out = sanitizeTabStorage({
      localStorage: { 'sb-proj-auth-token': '{"access_token":"x"}' },
      sessionStorage: { tab: '1' },
    });
    expect(out!.localStorage['sb-proj-auth-token']).toBe('{"access_token":"x"}');
    expect(out!.sessionStorage.tab).toBe('1');
  });

  test('drops non-string values rather than coercing them', () => {
    // The restore path hands this straight to localStorage.setItem inside
    // page.evaluate. A tampered file must not get an object or a function
    // stringified into the page's storage.
    const out = sanitizeTabStorage({
      localStorage: { good: 'v', num: 1, obj: { a: 1 }, nil: null },
      sessionStorage: null,
    });
    expect(Object.keys(out!.localStorage)).toEqual(['good']);
    expect(out!.sessionStorage).toEqual({});
  });

  test('a missing store becomes an empty object, never undefined', () => {
    const out = sanitizeTabStorage({});
    expect(out).toEqual({ localStorage: {}, sessionStorage: {} });
  });
});

describe('state save|load round-trip (real Chromium)', () => {
  test('localStorage written before save is readable after load', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const { handleMetaCommand } = await import('../src/meta-commands');
    const { startTestServer } = await import('./test-server');
    const { server, url } = startTestServer(0);
    const noop = async () => {};

    const bm1 = new BrowserManager();
    await bm1.launch();
    try {
      const page = bm1.getPage();
      await page.goto(`${url}/basic.html`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.setItem('auth_marker', 'still-logged-in');
      });
      const saved = await handleMetaCommand('state', ['save', 'rt'], bm1, noop);
      // The success line names the localStorage count: a "0 localStorage keys"
      // reading is the visible tell that a login cannot be restored from this
      // file, instead of that showing up later as a sign-in redirect.
      expect(saved).toContain('1 localStorage keys');
    } finally {
      await bm1.close();
    }

    const statePath = path.join(tmpRoot, 'browse-states', 'rt.json');
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(onDisk.pages[0].storage.localStorage.auth_marker).toBe('still-logged-in');
    if (process.platform !== 'win32') {
      // The file now carries auth tokens, not just cookies. Owner-only matters more.
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    }

    const bm2 = new BrowserManager();
    await bm2.launch();
    try {
      const loaded = await handleMetaCommand('state', ['load', 'rt'], bm2, noop);
      expect(loaded).toContain('1 localStorage keys');
      const page = bm2.getPage();
      const marker = await page.evaluate(() => localStorage.getItem('auth_marker'));
      expect(marker).toBe('still-logged-in');
    } finally {
      await bm2.close();
      server.stop(true);
    }
  }, 60_000);

  test('a pre-fix state file with no storage key still loads', async () => {
    const { BrowserManager } = await import('../src/browser-manager');
    const { handleMetaCommand } = await import('../src/meta-commands');
    const noop = async () => {};

    // Exactly what `state save` wrote before this change: no `storage` anywhere.
    const dir = path.join(tmpRoot, 'browse-states');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'oldshape.json'), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      cookies: [],
      pages: [{ url: '', isActive: true }],
    }));

    const bm = new BrowserManager();
    await bm.launch();
    try {
      const loaded = await handleMetaCommand('state', ['load', 'oldshape'], bm, noop);
      expect(loaded).toContain('0 localStorage keys');
    } finally {
      await bm.close();
    }
  }, 60_000);
});
