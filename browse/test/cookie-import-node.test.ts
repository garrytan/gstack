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

  test('Node server build does not stub away the database', () => {
    const script = readFileSync(path.resolve(import.meta.dir, '../scripts/build-node-server.sh'), 'utf8');
    expect(script).not.toContain('const Database = null');
  });
});
