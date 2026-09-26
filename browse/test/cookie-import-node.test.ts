import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookie-node-')));
const bundle = path.join(root, 'importer.mjs');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required for importer runtime coverage');

beforeAll(() => {
  const build = spawnSync(process.execPath, ['build', path.resolve(import.meta.dir, '../src/cookie-import-browser.ts'), '--target=node', '--outfile', bundle], {
    encoding: 'utf8', timeout: 30_000,
  });
  expect(build.status).toBe(0);
  const profile = path.join(root, '.config/chromium/Default');
  mkdirSync(profile, { recursive: true });
  expect(realpathSync(profile).startsWith(root + path.sep)).toBe(true);
  const dbPath = path.join(profile, 'Cookies');
  const database = new Database(dbPath);
  database.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
  database.run("INSERT INTO cookies VALUES ('.fixture.test', 'synthetic', 'fixture-value', x'', '/', 0, 0, 1, 0, 1)");
  database.close();
  const windows = path.join(root, 'AppData/Local/Chromium/User Data/Default');
  mkdirSync(windows, { recursive: true });
  expect(realpathSync(windows).startsWith(root + path.sep)).toBe(true);
  copyFileSync(dbPath, path.join(windows, 'Cookies'));

  const writePlain = (directory: string, domain: string, name: string, value: string) => {
    mkdirSync(directory, { recursive: true });
    expect(realpathSync(directory).startsWith(root + path.sep)).toBe(true);
    const database = new Database(path.join(directory, 'Cookies'));
    database.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
    database.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 1)', [domain, name, value, Buffer.alloc(0), '/']);
    database.close();
  };
  writePlain(path.join(root, 'OperaRoaming/Opera Software/Opera Stable/Default/Network'), '.opera.fixture', 'opera-cookie', 'opera-plaintext');
  writePlain(path.join(root, 'OperaRoaming/Opera Software/Opera Stable/User Data/Default/Network'), '.opera.fixture', 'opera-cookie', 'user-data-decoy');
  writePlain(path.join(root, 'OperaRoaming/Opera Software/Opera GX Stable/Profile 2/Network'), '.gx.fixture', 'gx-cookie', 'gx-plaintext');
  writePlain(path.join(root, 'AppData/Local/Opera Software/Opera Stable/Default/Network'), '.opera.fixture', 'opera-cookie', 'local-decoy');
  writePlain(path.join(root, 'AppData/Local/Opera Software/Opera GX Stable/Default/Network'), '.gx.fixture', 'gx-cookie', 'local-gx-decoy');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('actual Node importer runtime', () => {
  test('lists and imports cookies through the bundled production module', () => {
    const child = spawnSync(node!, ['--input-type=module', '-e', `
      const { listDomains, importCookies } = await import(process.argv[1]);
      const domains = listDomains('chromium');
      const result = await importCookies('chromium', ['fixture.test']);
      console.log(JSON.stringify({ domains, count: result.count, failed: result.failed, scope: Object.keys(result.domainCounts), cookieName: result.cookies[0]?.name }));
    `, pathToFileURL(bundle).href], {
      encoding: 'utf8', timeout: 15_000,
      env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData/Local'), TEMP: root, TMP: root, NODE_NO_WARNINGS: '1', PATH: path.dirname(node!), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ domains: { browser: 'Chromium', domains: [{ domain: '.fixture.test', count: 1 }] }, count: 1, failed: 0, scope: ['.fixture.test'], cookieName: 'synthetic' });
  });

  // Path and SQLite coverage for the bundled module. This does not exercise Windows DPAPI.
  test('discovers and imports plaintext Opera and Opera GX cookies through the bundled module', () => {
    const child = spawnSync(node!, ['--input-type=module', '-e', `
      const { findInstalledBrowsers, listDomains, listProfiles, listSupportedBrowserNames, importCookies } = await import(process.argv[1]);
      const opera = await importCookies('opera', ['opera.fixture']);
      const gx = await importCookies('Opera GX', ['gx.fixture'], 'Profile 2');
      const skipped = await importCookies('opera', ['gx.fixture']);
      console.log(JSON.stringify({
        platform: process.platform,
        discovered: findInstalledBrowsers().map(browser => browser.name).sort(),
        supported: listSupportedBrowserNames(),
        operaDomains: listDomains('opera').domains.map(entry => entry.domain).sort(),
        gxProfiles: listProfiles('opera-gx').map(profile => profile.name),
        gxDomains: listDomains('opera-gx', 'Profile 2').domains.map(entry => entry.domain),
        opera: { count: opera.count, failed: opera.failed, name: opera.cookies[0]?.name, value: opera.cookies[0]?.value },
        gx: { count: gx.count, failed: gx.failed, name: gx.cookies[0]?.name, value: gx.cookies[0]?.value },
        skipped: skipped.count,
      }));
    `, pathToFileURL(bundle).href], {
      encoding: 'utf8', timeout: 15_000,
      env: {
        HOME: root, USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData/Local'),
        APPDATA: path.join(root, 'OperaRoaming'), TEMP: root, TMP: root, NODE_NO_WARNINGS: '1',
        PATH: path.dirname(node!), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    const parsed = JSON.parse(child.stdout);
    expect(parsed.discovered).toEqual(expect.arrayContaining(['Opera', 'Opera GX']));
    expect(parsed.platform === 'win32'
      ? parsed.supported.includes('Opera') && parsed.supported.includes('Opera GX')
      : !parsed.supported.includes('Opera') && !parsed.supported.includes('Opera GX')).toBe(true);
    expect(parsed.operaDomains).toEqual(['.opera.fixture']);
    expect(parsed.gxProfiles).toEqual(['Profile 2']);
    expect(parsed.gxDomains).toEqual(['.gx.fixture']);
    expect(parsed.opera).toEqual({ count: 1, failed: 0, name: 'opera-cookie', value: 'opera-plaintext' });
    expect(parsed.gx).toEqual({ count: 1, failed: 0, name: 'gx-cookie', value: 'gx-plaintext' });
    expect(parsed.skipped).toBe(0);
  });

  test('Node server build does not stub away the database', () => {
    const script = readFileSync(path.resolve(import.meta.dir, '../scripts/build-node-server.sh'), 'utf8');
    expect(script).not.toContain('const Database = null');
  });
});
