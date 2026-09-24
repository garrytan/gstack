import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findInstalledBrowsers, importCookies, listProfiles, cookieDomainMatches, CookieImportError, normalizeCookieDomain, withCookieReadRetry } from '../src/cookie-import-browser';

let home: string;
let oldHome: string | undefined;
let oldUserProfile: string | undefined;
let spawn: typeof Bun.spawn;
let homeMock: ReturnType<typeof spyOn>;

function profile(dir: string, name: string, cookieDomain = '.example.test') {
  const target = path.join(home, dir, name);
  fs.mkdirSync(target, { recursive: true });
  expect(fs.realpathSync(target).startsWith(fs.realpathSync(home) + path.sep)).toBe(true);
  const db = new Database(path.join(target, 'Cookies'));
  db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
  db.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, 0, 1, 1, 0, 1)', [cookieDomain, 'fixture', 'synthetic-value', Buffer.alloc(0), '/']);
  db.close();
  return target;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-wave-'));
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  homeMock = spyOn(os, 'homedir').mockReturnValue(home);
  spawn = Bun.spawn;
  Bun.spawn = ((command: string[]) => {
    if (!['secret-tool', 'security'].includes(command[0])) throw new Error('Unexpected fixture subprocess');
    return { stdout: new Blob(['fixture-password']).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0), kill() {} };
  }) as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = spawn;
  homeMock.mockRestore();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('cookie import reliability', () => {
  test('discovers Dia with only a numbered macOS profile', () => {
    profile('Library/Application Support/Dia/User Data', 'Profile 2');
    expect(findInstalledBrowsers().map(browser => browser.name)).toContain('Dia');
    expect(listProfiles('dia')[0].name).toBe('Profile 2');
  });

  test('prefers current Local State names and sorts profile numbers naturally', () => {
    const root = '.config/chromium';
    for (const name of ['Profile 10', 'Profile 2', 'Default']) {
      const dir = profile(root, name);
      fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({ profile: { name: 'Old name' } }));
    }
    fs.writeFileSync(path.join(home, root, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Current name' } } } }));
    expect(listProfiles('chromium')).toEqual([
      { name: 'Default', displayName: 'Old name' },
      { name: 'Profile 2', displayName: 'Current name' },
      { name: 'Profile 10', displayName: 'Old name' },
    ]);
  });

  test('malformed metadata preserves the directory identity', () => {
    const dir = profile('.config/chromium', 'Default');
    fs.writeFileSync(path.join(home, '.config/chromium/Local State'), '{');
    fs.writeFileSync(path.join(dir, 'Preferences'), '{');
    expect(listProfiles('chromium')).toEqual([{ name: 'Default', displayName: 'Default' }]);
  });

  test('bare and dotted domain selection import the same stored row without widening scope', async () => {
    const dir = profile('.config/chromium', 'Default');
    const db = new Database(path.join(dir, 'Cookies'));
    db.run("INSERT INTO cookies VALUES ('evil-example.test', 'other', 'synthetic-other', x'', '/', 0, 1, 1, 0, 1)");
    db.close();
    for (const domain of ['example.test', '.example.test', 'EXAMPLE.TEST.']) {
      const result = await importCookies('chromium', [domain]);
      expect(result.count).toBe(1);
      expect(result.cookies[0].domain).toBe('.example.test');
    }
  });

  test('reports partial decrypt reasons without error or cookie values', async () => {
    const dir = profile('.config/chromium', 'Default');
    const db = new Database(path.join(dir, 'Cookies'));
    db.run("INSERT INTO cookies VALUES ('.example.test', 'broken', '', ?, '/', 0, 1, 1, 0, 1)", [Buffer.from('v20synthetic')]);
    db.close();
    const result = await importCookies('chromium', ['example.test']);
    expect(result.count).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failureReasons).toEqual({ unsupported_encryption: 1 });
  });

  test('domain counts do not inherit object prototype properties', async () => {
    profile('.config/chromium', 'Default', 'constructor');
    const result = await importCookies('chromium', ['constructor']);
    expect(result.count).toBe(1);
    expect(result.domainCounts.constructor).toBe(1);
    expect(JSON.stringify(result.domainCounts)).toBe('{"constructor":1}');
  });

  test('domain matching preserves host-only boundaries and rejects malformed input', () => {
    expect(cookieDomainMatches('app.example.test', '.example.test')).toBe(true);
    expect(cookieDomainMatches('app.example.test', 'example.test')).toBe(false);
    expect(cookieDomainMatches('evil-example.test', '.example.test')).toBe(false);
    expect(normalizeCookieDomain('.EXAMPLE.TEST.')).toBe('example.test');
    expect(normalizeCookieDomain('service_name.example.test')).toBe('service_name.example.test');
    expect(normalizeCookieDomain('-service.example.test')).toBe('-service.example.test');
    expect(normalizeCookieDomain('::1')).toBe('[::1]');
    expect(normalizeCookieDomain('[0:0:0:0:0:0:0:1]')).toBe('[::1]');
    expect(cookieDomainMatches('[::1]', '[::1]')).toBe(true);
    for (const domain of ['', 'https://example.test', 'example.test/path', 'user@example.test', '..example.test', 'example.test:80', '*.example.test']) {
      expect(() => normalizeCookieDomain(domain)).toThrow(CookieImportError);
    }
  });

  for (const domain of ['service_name.example.test', '[::1]', '-service.example.test']) {
    test(`imports the Chromium-supported hostname ${domain}`, async () => {
      profile('.config/chromium', 'Default', domain);
      const result = await importCookies('chromium', [domain]);
      expect(result.count).toBe(1);
      expect(result.cookies[0].domain).toBe(domain);
    });
  }

  test('does not automatically retry permission denial or corrupt databases', async () => {
    for (const code of ['keychain_denied', 'keychain_timeout', 'db_corrupt']) {
      let attempts = 0;
      await expect(withCookieReadRetry(() => {
        attempts++;
        throw new CookieImportError('Safe fixture error', code, 'retry');
      })).rejects.toThrow('Safe fixture error');
      expect(attempts).toBe(1);
    }
  });

  test('normalizes adapter failures without exposing database error text', async () => {
    for (const [source, expected] of [['SQLITE_CORRUPT', 'db_corrupt'], ['SQLITE_READONLY', 'db_permission'], ['SQLITE_ERROR', 'db_read_error']]) {
      let caught: any;
      try { await withCookieReadRetry(() => { throw Object.assign(new Error('synthetic-private-db-detail'), { code: source }); }); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(CookieImportError);
      expect(caught.code).toBe(expected);
      expect(caught.message).not.toContain('synthetic-private-db-detail');
    }
  });

  test('actual Keychain denial is sanitized, never repeated, and clears its deadline', async () => {
    const dir = profile('Library/Application Support/Dia/User Data', 'Default');
    const db = new Database(path.join(dir, 'Cookies'));
    db.run("UPDATE cookies SET value = '', encrypted_value = ?", [Buffer.from('v10synthetic-encrypted-row')]);
    db.close();
    let requests = 0;
    Bun.spawn = ((command: string[]) => {
      expect(command).toEqual(['security', 'find-generic-password', '-s', 'Dia Safe Storage', '-w']);
      requests++;
      return { stdout: new Blob([]).stream(), stderr: new Blob(['user canceled synthetic-private-detail']).stream(), exited: Promise.resolve(1), kill() {} };
    }) as typeof Bun.spawn;
    const timer = spyOn(globalThis, 'setTimeout').mockReturnValue(123 as any);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    try {
      let error: any;
      try { await withCookieReadRetry(() => importCookies('dia', ['example.test'])); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(CookieImportError);
      expect(error.code).toBe('keychain_denied');
      expect(error.message).not.toContain('synthetic-private-detail');
      expect(requests).toBe(1);
      expect(clear).toHaveBeenCalledWith(123);
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });

  test('bounds transient database retries to three attempts', async () => {
    let attempts = 0;
    await expect(withCookieReadRetry(() => {
      attempts++;
      throw new CookieImportError('Locked', 'db_locked', 'retry');
    })).rejects.toThrow('Locked');
    expect(attempts).toBe(3);
  });
});
