/**
 * Tests for opt-in automatic cookie persistence (auto-cookie-persist.ts).
 *
 * Unit tests cover the cookie filter (persistent-only, expiry, internal-network,
 * allowlist), the content hash, the mkdir-atomic lock (acquire / contend /
 * stale-reclaim / release), and the atomic-write helper. A Playwright
 * round-trip test proves a persistent __Host- cookie is saved and restored via
 * newContext({ storageState }), and that session/expired cookies are excluded.
 *
 * Static-grep tests pin the load-bearing wiring in server.ts / browser-manager.ts
 * (opt-in gate, no-save-on-crash-path, shutdown flush before close) so a refactor
 * can't silently regress them.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Cookie } from 'playwright';
import { chromium } from 'playwright';
import type { BrowseConfig } from '../src/config';
import {
  isAutoCookiePersistEnabled,
  parseDomainAllowlist,
  filterPersistableCookies,
  cookieSetHash,
  computeProfileId,
  acquireLock,
  releaseLock,
  loadAutoCookieState,
  saveAutoCookieState,
} from '../src/auto-cookie-persist';
import { writeSecureFileAtomic } from '../src/file-permissions';

const META = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const BM = fs.readFileSync(path.join(import.meta.dir, '../src/browser-manager.ts'), 'utf-8');

function tmpConfig(): BrowseConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cookie-'));
  const stateDir = path.join(dir, '.gstack');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    projectDir: dir,
    stateDir,
    stateFile: path.join(stateDir, 'browse.json'),
    consoleLog: '', networkLog: '', dialogLog: '', auditLog: '',
  };
}

const future = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
function cookie(over: Partial<Cookie> = {}): Cookie {
  return {
    name: 'c', value: 'v', domain: 'example.com', path: '/',
    expires: future, httpOnly: true, secure: true, sameSite: 'Lax', ...over,
  } as Cookie;
}

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('opt-in gate', () => {
  test('enabled only for truthy flag values', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(isAutoCookiePersistEnabled({ BROWSE_AUTO_COOKIE_PERSIST: v })).toBe(true);
    }
    for (const v of [undefined, '', '0', 'false', 'no', 'off']) {
      expect(isAutoCookiePersistEnabled({ BROWSE_AUTO_COOKIE_PERSIST: v as any })).toBe(false);
    }
  });

  test('loadAutoCookieState returns null when disabled', () => {
    const cfg = tmpConfig();
    delete process.env.BROWSE_AUTO_COOKIE_PERSIST;
    expect(loadAutoCookieState(cfg)).toBeNull();
  });

  test('saveAutoCookieState is a no-op when disabled', async () => {
    const cfg = tmpConfig();
    delete process.env.BROWSE_AUTO_COOKIE_PERSIST;
    const res = await saveAutoCookieState(cfg, null, null);
    expect(res.wrote).toBe(false);
    expect(fs.existsSync(path.join(cfg.stateDir, 'browse-auto-cookies'))).toBe(false);
  });
});

describe('cookie filter', () => {
  test('keeps persistent, drops session cookies', () => {
    const kept = filterPersistableCookies([cookie(), cookie({ name: 's', expires: -1 })], null);
    expect(kept.map(c => c.name)).toEqual(['c']);
  });

  test('drops already-expired cookies', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const kept = filterPersistableCookies([cookie({ name: 'old', expires: past }), cookie()], null);
    expect(kept.map(c => c.name)).toEqual(['c']);
  });

  test('rejects internal-network domains', () => {
    const kept = filterPersistableCookies([
      cookie({ name: 'lh', domain: 'localhost' }),
      cookie({ name: 'meta', domain: '169.254.169.254' }),
      cookie({ name: 'int', domain: 'foo.internal' }),
      cookie({ name: 'ok', domain: 'example.com' }),
    ], null);
    expect(kept.map(c => c.name)).toEqual(['ok']);
  });

  test('applies host allowlist incl. leading-wildcard + apex', () => {
    const cookies = [
      cookie({ name: 'a', domain: 'example.com' }),
      cookie({ name: 'b', domain: 'sub.example.com' }),
      cookie({ name: 'c', domain: 'other.com' }),
    ];
    const kept = filterPersistableCookies(cookies, ['*.example.com']);
    expect(kept.map(c => c.name).sort()).toEqual(['a', 'b']); // apex + subdomain, not other.com
  });

  test('parseDomainAllowlist splits and lowercases; empty ⇒ null', () => {
    expect(parseDomainAllowlist({ BROWSE_AUTO_COOKIE_DOMAINS: 'A.com, *.B.com' }))
      .toEqual(['a.com', '*.b.com']);
    expect(parseDomainAllowlist({ BROWSE_AUTO_COOKIE_DOMAINS: '' })).toBeNull();
    expect(parseDomainAllowlist({})).toBeNull();
  });
});

describe('content hash', () => {
  test('order-independent', () => {
    const a = cookie({ name: 'a', domain: 'a.com' });
    const b = cookie({ name: 'b', domain: 'b.com' });
    expect(cookieSetHash([a, b])).toBe(cookieSetHash([b, a]));
  });
  test('changes when a value changes', () => {
    const a = cookie({ name: 'a', value: '1' });
    const a2 = cookie({ name: 'a', value: '2' });
    expect(cookieSetHash([a])).not.toBe(cookieSetHash([a2]));
  });
});

describe('atomic write helper', () => {
  test('writes content and leaves no temp file', () => {
    const cfg = tmpConfig();
    const f = path.join(cfg.stateDir, 'atomic.json');
    writeSecureFileAtomic(f, JSON.stringify({ ok: 1 }));
    expect(JSON.parse(fs.readFileSync(f, 'utf-8'))).toEqual({ ok: 1 });
    const leftovers = fs.readdirSync(cfg.stateDir).filter(n => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('workspace lock', () => {
  test('acquire, contend (same process re-acquire fails), release', () => {
    const cfg = tmpConfig();
    expect(acquireLock(cfg)).toBe(true);
    // Second acquire while a live pid (this process) owns it → refused.
    expect(acquireLock(cfg)).toBe(false);
    releaseLock(cfg);
    // After release the dir is gone and we can re-acquire.
    expect(acquireLock(cfg)).toBe(true);
    releaseLock(cfg);
  });

  test('reclaims a lock owned by a dead pid', () => {
    const cfg = tmpConfig();
    const lockDir = path.join(cfg.stateDir, 'browse-auto-cookies', `${computeProfileId(cfg)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    // PID 2^31-1 is not a live process → stale, reclaimable.
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483646, startedAt: 'x' }));
    expect(acquireLock(cfg)).toBe(true);
    releaseLock(cfg);
  });
});

describe('save → load round-trip (real Playwright)', () => {
  test('persistent __Host- cookie survives; session/expired excluded', async () => {
    process.env.BROWSE_AUTO_COOKIE_PERSIST = '1';
    delete process.env.BROWSE_AUTO_COOKIE_DOMAINS;
    const cfg = tmpConfig();
    const origin = 'https://luseed.example.com';
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies([
        { name: '__Host-lsd', value: 'tok.raw', url: origin, httpOnly: true, secure: true, sameSite: 'Lax', expires: future },
        { name: 'authjs.session-token', value: 'sess', url: origin, httpOnly: true, secure: true, sameSite: 'Lax', expires: future },
        { name: 'ephem', value: 'x', url: origin, httpOnly: false, secure: true, sameSite: 'Lax' }, // session
      ]);
      const res = await saveAutoCookieState(cfg, ctx, null);
      await ctx.close();
      expect(res.wrote).toBe(true);
      expect(res.count).toBe(2); // ephem (session) filtered out

      const loaded = loadAutoCookieState(cfg);
      expect(loaded).not.toBeNull();
      const names = loaded!.cookies.map(c => c.name).sort();
      expect(names).toEqual(['__Host-lsd', 'authjs.session-token']);

      // The restored storageState actually rehydrates a fresh context.
      const ctx2 = await browser.newContext({ storageState: loaded! });
      const back = await ctx2.cookies();
      await ctx2.close();
      expect(back.some(c => c.name === '__Host-lsd')).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('unchanged cookie set skips the second write (hash short-circuit)', async () => {
    process.env.BROWSE_AUTO_COOKIE_PERSIST = '1';
    const cfg = tmpConfig();
    const origin = 'https://luseed.example.com';
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: '__Host-lsd', value: 'tok', url: origin, httpOnly: true, secure: true, sameSite: 'Lax', expires: future }]);
      const first = await saveAutoCookieState(cfg, ctx, null);
      expect(first.wrote).toBe(true);
      const second = await saveAutoCookieState(cfg, ctx, first.hash);
      expect(second.wrote).toBe(false); // identical set → no write
      await ctx.close();
    } finally {
      await browser.close();
    }
  });
});

describe('BrowserManager.launch() integration (real browser + real daemon config)', () => {
  test('launch() restores a persisted __Host- cookie into the fresh context', async () => {
    process.env.BROWSE_AUTO_COOKIE_PERSIST = '1';
    delete process.env.BROWSE_AUTO_COOKIE_DOMAINS;
    const cfg = tmpConfig();
    // launch() calls resolveConfig() internally, which honors BROWSE_STATE_FILE —
    // point it at this isolated workspace.
    process.env.BROWSE_STATE_FILE = cfg.stateFile;

    // Pre-seed the auto-state file exactly as a prior daemon's shutdown flush
    // would have (persistent __Host- cookie for an https origin).
    const origin = 'https://luseed.example.com';
    const browser0 = await chromium.launch({ headless: true });
    const seedCtx = await browser0.newContext();
    await seedCtx.addCookies([
      { name: '__Host-lsd', value: 'device.token', url: origin, httpOnly: true, secure: true, sameSite: 'Lax', expires: future },
    ]);
    const wrote = await saveAutoCookieState(cfg, seedCtx, null);
    await seedCtx.close();
    await browser0.close();
    expect(wrote.wrote).toBe(true);

    // Launch a real BrowserManager against the same workspace — it should load
    // the file and seed the new context, simulating a daemon restart.
    const { BrowserManager } = await import('../src/browser-manager');
    const bm = new BrowserManager();
    try {
      await bm.launch();
      const ctx = bm.getContext();
      expect(ctx).not.toBeNull();
      const cookies = await ctx!.cookies();
      expect(cookies.some(c => c.name === '__Host-lsd' && c.value === 'device.token')).toBe(true);
    } finally {
      await bm.close();
    }
  }, 30_000); // real browser launch can take >5s (matches handoff integration timing)
});

describe('wiring (static)', () => {
  test('save is gated on the opt-in flag at daemon start', () => {
    expect(META).toContain('isAutoCookiePersistEnabled()');
    expect(META).toContain('acquireAutoCookieLock(config)');
  });

  test('final checkpoint runs in shutdown BEFORE the browser closes', () => {
    const shutIdx = META.indexOf('async function shutdown(');
    const flushIdx = META.indexOf('await autoCookieCheckpoint();', shutIdx);
    const closeIdx = META.indexOf('await cfgBrowserManager.close();', shutIdx);
    expect(flushIdx).toBeGreaterThan(shutIdx);
    expect(closeIdx).toBeGreaterThan(flushIdx); // flush precedes close
  });

  test('crash path (emergencyCleanup) does NOT checkpoint cookies', () => {
    const start = META.indexOf('function emergencyCleanup()');
    const end = META.indexOf('\n}', start);
    const body = META.slice(start, end);
    expect(body).not.toContain('autoCookieCheckpoint');
    expect(body).not.toContain('saveAutoCookieState');
  });

  test('launch() seeds the context from persisted cookies before newContext', () => {
    const loadIdx = BM.indexOf('loadAutoCookieState(cfg)');
    const newCtxIdx = BM.indexOf('this.context = await this.browser.newContext(contextOptions);');
    expect(loadIdx).toBeGreaterThan(0);
    expect(newCtxIdx).toBeGreaterThan(loadIdx); // restore assigned into contextOptions before use
  });
});
