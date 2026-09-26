import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findInstalledBrowsers, importCookies, listDomains, listProfiles, listSupportedBrowserNames, cookieDomainMatches, CookieImportError, normalizeCookieDomain, withCookieReadRetry } from '../src/cookie-import-browser';

let home: string;
let oldHome: string | undefined;
let oldUserProfile: string | undefined;
let oldAppData: string | undefined;
let platform: PropertyDescriptor;
let spawn: typeof Bun.spawn;
let homeMock: ReturnType<typeof spyOn>;
let extraDirs: string[] = [];

type CookieRow = { domain: string; name: string; value?: string; encrypted?: Buffer };

function tempRoot(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  extraDirs.push(dir);
  return dir;
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTarget = fs.realpathSync(target);
  expect(resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)).toBe(true);
}

function writeCookies(root: string, directory: string, rows: CookieRow[]): string {
  const target = path.join(root, directory);
  fs.mkdirSync(target, { recursive: true });
  assertInside(root, target);
  const db = new Database(path.join(target, 'Cookies'));
  db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
  for (const row of rows) {
    db.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, 0, 1, 1, 0, 1)', [row.domain, row.name, row.value ?? '', row.encrypted ?? Buffer.alloc(0), '/']);
  }
  db.close();
  return target;
}

function writeDpapiState(root: string, browserDir: string, material: Buffer): void {
  const target = path.join(root, browserDir);
  fs.mkdirSync(target, { recursive: true });
  assertInside(root, target);
  const encryptedKey = Buffer.concat([Buffer.from('DPAPI'), material]).toString('base64');
  fs.writeFileSync(path.join(target, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }));
}

function windowsV10Cookie(key: Buffer, plaintext: string): Buffer {
  const nonce = Buffer.alloc(12, 0x24);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, ciphertext, cipher.getAuthTag()]);
}

function closedStream(content = ''): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (content) controller.enqueue(Buffer.from(content));
      controller.close();
    },
  });
}

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
  extraDirs = [];
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  oldAppData = process.env.APPDATA;
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.APPDATA;
  homeMock = spyOn(os, 'homedir').mockReturnValue(home);
  spawn = Bun.spawn;
  Bun.spawn = ((command: string[]) => {
    if (!['secret-tool', 'security'].includes(command[0])) throw new Error('Unexpected fixture subprocess');
    return { stdout: new Blob(['fixture-password']).stream(), stderr: new Blob([]).stream(), exited: Promise.resolve(0), kill() {} };
  }) as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = spawn;
  Object.defineProperty(process, 'platform', platform);
  homeMock.mockRestore();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
  for (const dir of extraDirs) fs.rmSync(dir, { recursive: true, force: true });
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

  test('lists Opera only on Windows and keeps other families on their current roots', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    expect(listSupportedBrowserNames()).toEqual(['Chrome', 'Chromium', 'Brave', 'Edge', 'Opera', 'Opera GX']);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    expect(listSupportedBrowserNames()).toEqual(['Comet', 'Chrome', 'Chromium', 'Arc', 'Dia', 'Brave', 'Edge']);
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    expect(listSupportedBrowserNames()).toEqual(['Chrome', 'Chromium', 'Brave', 'Edge']);
  });

  test('discovers Opera and Opera GX from an overridden roaming root and ignores Local and User Data decoys', async () => {
    const roaming = tempRoot('cookie-opera-appdata-');
    process.env.APPDATA = roaming;
    writeCookies(roaming, path.join('Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'opera-chosen' },
      { domain: '.other.test', name: 'skip', value: 'opera-other' },
    ]);
    writeCookies(roaming, path.join('Opera Software', 'Opera Stable', 'User Data', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'user-data-decoy' },
    ]);
    writeCookies(roaming, path.join('Opera Software', 'Opera GX Stable', 'Profile 1', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'gx-chosen' },
    ]);
    writeCookies(home, path.join('AppData', 'Local', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'local-decoy' },
    ]);
    writeCookies(home, path.join('AppData', 'Local', 'Opera Software', 'Opera Stable', 'Profile 9', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'local-profile-decoy' },
    ]);
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'home-roaming-decoy' },
    ]);
    writeCookies(home, path.join('AppData', 'Local', 'Opera Software', 'Opera GX Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'local-gx-decoy' },
    ]);
    writeCookies(roaming, path.join('Opera Software', 'Opera Stable', 'Guest Profile', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'guest-decoy' },
    ]);

    expect(findInstalledBrowsers().map(browser => browser.name)).toEqual(expect.arrayContaining(['Opera', 'Opera GX']));
    for (const alias of ['opera', 'OPERA', 'Opera']) {
      expect(listProfiles(alias).map(profile => profile.name)).toEqual(['Default']);
    }
    for (const alias of ['opera-gx', 'Opera GX', 'opera gx', 'OPERA GX']) {
      expect(listProfiles(alias)).toEqual([{ name: 'Profile 1', displayName: 'Profile 1' }]);
    }
    const listed = listDomains('opera');
    expect(listed.browser).toBe('Opera');
    expect(listed.domains.map(entry => `${entry.domain}:${entry.count}`).sort()).toEqual(['.chosen.test:1', '.other.test:1']);
    const imported = await importCookies('opera', ['chosen.test']);
    expect(imported.count).toBe(1);
    expect(imported.failed).toBe(0);
    expect(imported.cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain }))).toEqual([
      { name: 'keep', value: 'opera-chosen', domain: '.chosen.test' },
    ]);
    const gx = await importCookies('opera-gx', ['chosen.test'], 'Profile 1');
    expect(gx.cookies.map(cookie => cookie.value)).toEqual(['gx-chosen']);
    expect((await importCookies('Opera', ['other.test'])).cookies.map(cookie => cookie.value)).toEqual(['opera-other']);
  });

  test('uses the synthetic roaming home when APPDATA is unset, empty, or blank', async () => {
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'fallback-opera' },
    ]);
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera GX Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'fallback-gx' },
    ]);
    writeCookies(home, path.join('AppData', 'Local', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'local-decoy' },
    ]);
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = value;
      expect((await importCookies('opera', ['chosen.test'])).cookies[0].value).toBe('fallback-opera');
      expect((await importCookies('opera-gx', ['chosen.test'])).cookies[0].value).toBe('fallback-gx');
    }
  });

  test('keeps Chrome, Chromium, Edge, and Brave on the Local root when APPDATA is overridden', async () => {
    const roaming = tempRoot('cookie-local-root-');
    process.env.APPDATA = roaming;
    const cases = [
      ['chrome', path.join('AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default'), path.join('Google', 'Chrome', 'User Data', 'Default')],
      ['chromium', path.join('AppData', 'Local', 'Chromium', 'User Data', 'Default'), path.join('Chromium', 'User Data', 'Default')],
      ['brave', path.join('AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default'), path.join('BraveSoftware', 'Brave-Browser', 'User Data', 'Default')],
      ['edge', path.join('AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default'), path.join('Microsoft', 'Edge', 'User Data', 'Default')],
    ] as const;
    for (const [alias, localDir, roamingDir] of cases) {
      writeCookies(home, localDir, [{ domain: '.chosen.test', name: 'keep', value: `${alias}-local` }]);
      writeCookies(roaming, roamingDir, [{ domain: '.chosen.test', name: 'keep', value: `${alias}-roaming-decoy` }]);
      expect((await importCookies(alias, ['chosen.test'])).cookies[0].value).toBe(`${alias}-local`);
    }
    expect(findInstalledBrowsers().map(browser => browser.name)).toEqual(expect.arrayContaining(['Chrome', 'Chromium', 'Brave', 'Edge']));
  });

  test('prefers current Opera Local State names for a numbered profile with no Default', () => {
    const root = path.join(home, 'AppData', 'Roaming', 'Opera Software', 'Opera Stable');
    for (const name of ['Profile 10', 'Profile 2']) {
      const dir = writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', name, 'Network'), [
        { domain: '.chosen.test', name: 'keep', value: 'numbered' },
      ]);
      fs.writeFileSync(path.join(dir, '..', 'Preferences'), JSON.stringify({ profile: { name: 'Old name' } }));
    }
    fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Current Opera name' } } } }));
    expect(listProfiles('opera')).toEqual([
      { name: 'Profile 2', displayName: 'Current Opera name' },
      { name: 'Profile 10', displayName: 'Old name' },
    ]);
    expect(findInstalledBrowsers().map(browser => browser.name)).toContain('Opera');
    expect(listProfiles('opera').some(profile => profile.name === 'Default')).toBe(false);
  });

  test('malformed Opera metadata preserves the directory identity', () => {
    const dir = writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera GX Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'gx-plain' },
    ]);
    fs.writeFileSync(path.join(home, 'AppData', 'Roaming', 'Opera Software', 'Opera GX Stable', 'Local State'), '{');
    fs.writeFileSync(path.join(dir, '..', 'Preferences'), '{');
    expect(listProfiles('opera-gx')).toEqual([{ name: 'Default', displayName: 'Default' }]);
  });

  test('reports missing Opera browsers and profiles and rejects profile traversal', () => {
    let error: any;
    try { listDomains('opera'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CookieImportError);
    expect(error.code).toBe('not_installed');
    expect(error.message).toContain(path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable'));
    expect(error.message).not.toContain(path.join('AppData', 'Local'));
    expect(error.message).not.toContain('User Data');
    expect(error.message).not.toContain('fixture-secret-sentinel');

    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'present' },
    ]);
    try { listDomains('Opera GX', 'Profile 8'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CookieImportError);
    expect(error.code).toBe('not_installed');
    expect(error.message).toContain('Opera GX');
    expect(error.message).not.toContain('fixture-secret-sentinel');

    expect(() => listDomains('opera', '../etc')).toThrow(/Invalid profile/);
    expect(() => listDomains('opera-gx', 'Default/../../etc')).toThrow(/Invalid profile/);
    expect(() => listDomains('Opera GX', 'Profile\x001')).toThrow(/Invalid profile/);
    expect(() => listDomains('opera', 'Default\\Network')).toThrow(/Invalid profile/);
  });

  test('prefers Network/Cookies and still falls back to a profile-level Cookies file', async () => {
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Default'), [
      { domain: '.chosen.test', name: 'keep', value: 'profile-level' },
    ]);
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'network-level' },
    ]);
    expect((await importCookies('opera', ['chosen.test'])).cookies.map(cookie => cookie.value)).toEqual(['network-level']);

    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera GX Stable', 'Default'), [
      { domain: '.chosen.test', name: 'keep', value: 'profile-fallback' },
    ]);
    expect((await importCookies('opera-gx', ['chosen.test'])).cookies.map(cookie => cookie.value)).toEqual(['profile-fallback']);
  });

  test('does not treat historical browser-root Opera cookie files as profiles', () => {
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable'), [
      { domain: '.chosen.test', name: 'keep', value: 'root-cookies' },
    ]);
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'root-network' },
    ]);
    expect(findInstalledBrowsers().map(browser => browser.name)).not.toContain('Opera');
    expect(listProfiles('opera')).toEqual([]);
    let error: any;
    try { listDomains('opera'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CookieImportError);
    expect(error.code).toBe('not_installed');
  });

  test('reports v20 rows as unsupported encryption without invoking native extraction', async () => {
    writeCookies(home, path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'plain', value: 'visible-value' },
      { domain: '.chosen.test', name: 'bound', value: '', encrypted: Buffer.from('v20synthetic') },
    ]);
    let spawns = 0;
    Bun.spawn = ((command: string[]) => {
      spawns++;
      throw new Error(`unexpected subprocess ${command[0]}`);
    }) as typeof Bun.spawn;
    const result = await importCookies('opera', ['chosen.test']);
    expect(spawns).toBe(0);
    expect(result.count).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failureReasons).toEqual({ unsupported_encryption: 1 });
    expect(result.cookies.map(cookie => cookie.value)).toEqual(['visible-value']);
    expect(JSON.stringify(result)).not.toContain('v20synthetic');
  });

  test('decrypts distinct Opera and Opera GX v10 keys and preserves typed key failures', async () => {
    const sentinel = 'fixture-secret-sentinel';
    const operaKey = Buffer.alloc(32, 0x31);
    const gxKey = Buffer.alloc(32, 0x32);
    const operaMaterial = Buffer.from('opera-dpapi-material');
    const gxMaterial = Buffer.from('gx-dpapi-material');
    const operaPlaintext = 'opera-session-value';
    const gxPlaintext = 'gx-session-value';
    const operaRoot = path.join('AppData', 'Roaming', 'Opera Software', 'Opera Stable');
    const gxRoot = path.join('AppData', 'Roaming', 'Opera Software', 'Opera GX Stable');
    writeCookies(home, path.join(operaRoot, 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', encrypted: windowsV10Cookie(operaKey, operaPlaintext) },
      { domain: '.other.test', name: 'skip', encrypted: windowsV10Cookie(operaKey, 'opera-other-value') },
    ]);
    writeCookies(home, path.join(gxRoot, 'Profile 1', 'Network'), [
      { domain: '.chosen.test', name: 'keep', encrypted: windowsV10Cookie(gxKey, gxPlaintext) },
    ]);
    writeCookies(home, path.join('AppData', 'Local', 'Opera Software', 'Opera Stable', 'Default', 'Network'), [
      { domain: '.chosen.test', name: 'keep', value: 'local-decoy' },
    ]);
    fs.writeFileSync(path.join(home, operaRoot, 'Local State.bak'), sentinel);
    writeDpapiState(home, path.join('AppData', 'Local', 'Opera Software', 'Opera Stable'), Buffer.from('local-decoy-material'));

    let error: any;
    try { await importCookies('opera', ['chosen.test']); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CookieImportError);
    expect(error.code).toBe('keychain_error');
    expect(error.message).toBe('Cannot read Local State for Opera');
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain(operaPlaintext);
    expect(error.message).not.toContain(operaMaterial.toString());

    writeDpapiState(home, gxRoot, gxMaterial);
    Bun.spawn = ((command: string[]) => {
      expect(command[0]).toBe('powershell');
      expect(command).toContain('-NoProfile');
      return {
        stdin: { write(_value: string) {}, end() {} },
        stdout: closedStream(),
        stderr: closedStream(sentinel),
        exited: Promise.resolve(1),
        kill() {},
      };
    }) as typeof Bun.spawn;
    try { await importCookies('opera-gx', ['chosen.test'], 'Profile 1'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CookieImportError);
    expect(error.code).toBe('keychain_error');
    expect(error.message).toBe('DPAPI decryption failed');
    expect(error.message).not.toContain(sentinel);
    expect(error.message).not.toContain(gxPlaintext);
    expect(error.message).not.toContain(gxMaterial.toString());
    expect(error.message).not.toContain(gxKey.toString('base64'));

    writeDpapiState(home, operaRoot, operaMaterial);
    const submitted: string[] = [];
    const keys = new Map<string, Buffer>([
      [operaMaterial.toString('base64'), operaKey],
      [gxMaterial.toString('base64'), gxKey],
    ]);
    Bun.spawn = ((command: string[]) => {
      expect(command[0]).toBe('powershell');
      expect(command).toContain('-NoProfile');
      let pending = '';
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      return {
        stdin: {
          write(value: string) { pending += value; },
          end() {
            submitted.push(pending);
            const key = keys.get(pending);
            controller.enqueue(Buffer.from((key ?? Buffer.alloc(0)).toString('base64')));
            controller.close();
          },
        },
        stdout,
        stderr: closedStream(),
        exited: Promise.resolve(0),
        kill() { throw new Error('Unexpected kill'); },
      };
    }) as typeof Bun.spawn;
    const opera = await importCookies('opera', ['chosen.test']);
    const gx = await importCookies('Opera GX', ['chosen.test'], 'Profile 1');
    expect(submitted).toEqual([operaMaterial.toString('base64'), gxMaterial.toString('base64')]);
    expect(opera.failed).toBe(0);
    expect(gx.failed).toBe(0);
    expect(opera.cookies.map(cookie => cookie.value)).toEqual([operaPlaintext]);
    expect(gx.cookies.map(cookie => cookie.value)).toEqual([gxPlaintext]);
    expect((await importCookies('opera', ['other.test'])).cookies.map(cookie => cookie.value)).toEqual(['opera-other-value']);
  });
});
