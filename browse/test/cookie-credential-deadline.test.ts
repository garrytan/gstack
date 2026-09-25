import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CookieImportError, importCookies } from '../src/cookie-import-browser';

let home: string;
let homedir: ReturnType<typeof spyOn>;
let platform: PropertyDescriptor;
let spawn: typeof Bun.spawn;

function fixture(encrypted: Buffer, hostPlatform: 'darwin' | 'linux' | 'win32' = 'darwin') {
  const folder = hostPlatform === 'darwin' ? 'Library/Application Support/Dia/User Data/Default'
    : hostPlatform === 'linux' ? '.config/chromium/Default' : 'AppData/Local/Chromium/User Data/Default';
  const dir = path.join(home, folder);
  fs.mkdirSync(dir, { recursive: true });
  expect(fs.realpathSync(dir).startsWith(fs.realpathSync(home) + path.sep)).toBe(true);
  const db = new Database(path.join(dir, 'Cookies'));
  db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
  db.run("INSERT INTO cookies VALUES ('.fixture.test', 'session', '', ?, '/', 0, 1, 1, 0, 1)", [encrypted]);
  db.close();
}

function cbcCookie(password: string, prefix = 'v10') {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', prefix === 'v11' ? 1 : 1003, 16, 'sha1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), cipher.update(Buffer.concat([Buffer.alloc(32), Buffer.from('fixture-value')])), cipher.final()]);
}

function pipe(content?: string): { stream: ReadableStream<Uint8Array>; close(): void; cancelled(): boolean } {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (content) controller.enqueue(Buffer.from(content));
    },
    cancel() { cancelled = true; },
  });
  return { stream, close: () => controller.close(), cancelled: () => cancelled };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-credential-deadline-'));
  homedir = spyOn(os, 'homedir').mockReturnValue(home);
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  spawn = Bun.spawn;
});

afterEach(() => {
  Bun.spawn = spawn;
  Object.defineProperty(process, 'platform', platform);
  homedir.mockRestore();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('credential subprocess whole-operation deadline', () => {
  for (const held of ['stdout', 'stderr'] as const) {
    test(`rejects an exited Keychain process when ${held} remains open`, async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
      fixture(Buffer.from('v10synthetic'));
      const stdout = pipe(held === 'stdout' ? 'fixture-password' : undefined);
      const stderr = pipe(held === 'stderr' ? 'private-error-detail' : undefined);
      if (held !== 'stdout') stdout.close();
      if (held !== 'stderr') stderr.close();
      let killed = 0;
      Bun.spawn = (() => ({ exited: Promise.resolve(0), stdout: stdout.stream, stderr: stderr.stream, kill() { killed++; } })) as typeof Bun.spawn;
      let expire: (() => void) | undefined;
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback: any) => { expire = callback; return 19 as any; });
      try {
        const result = importCookies('dia', ['fixture.test']);
        expect(expire).toBeFunction();
        expire!();
        await expect(result).rejects.toMatchObject({ code: 'keychain_timeout', action: 'retry' });
        expect(killed).toBe(1);
        expect(held === 'stdout' ? stdout.cancelled() : stderr.cancelled()).toBe(true);
      } finally {
        timer.mockRestore();
      }
    });
  }

  test('bounds a process that never exits', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    fixture(Buffer.from('v10synthetic'));
    const stdout = pipe();
    const stderr = pipe();
    let killed = 0;
    Bun.spawn = (() => ({ exited: new Promise<number>(() => {}), stdout: stdout.stream, stderr: stderr.stream, kill() { killed++; } })) as typeof Bun.spawn;
    let expire: (() => void) | undefined;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback: any) => { expire = callback; return 20 as any; });
    try {
      const result = importCookies('dia', ['fixture.test']);
      expect(expire).toBeFunction();
      expire!();
      await expect(result).rejects.toMatchObject({ code: 'keychain_timeout' });
      expect(killed).toBe(1);
      expect(stdout.cancelled()).toBe(true);
      expect(stderr.cancelled()).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });

  test('caps credential output and does not expose it in errors', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    fixture(Buffer.from('v10synthetic'));
    const privateValue = 'private-credential-output';
    let killed = 0;
    Bun.spawn = (() => ({ exited: Promise.resolve(0), stdout: new Blob([privateValue.repeat(4_000)]).stream(),
      stderr: new Blob([]).stream(), kill() { killed++; } })) as typeof Bun.spawn;
    let error: any;
    try { await importCookies('dia', ['fixture.test']); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CookieImportError);
    expect(error.code).toBe('keychain_error');
    expect(error.message).not.toContain(privateValue);
    expect(killed).toBe(1);
  });

  test('preserves Keychain success and denied/nonexistent policy', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    fixture(cbcCookie('fixture-password'));
    for (const [code, stderr, expected] of [[0, '', 'fixture-value'], [1, 'user canceled private-detail', 'keychain_denied'], [1, 'could not be found private-detail', 'keychain_not_found']] as const) {
      Bun.spawn = (() => ({ exited: Promise.resolve(code), stdout: new Blob([code ? '' : 'fixture-password\n']).stream(),
        stderr: new Blob([stderr]).stream(), kill() { throw new Error('Unexpected kill'); } })) as typeof Bun.spawn;
      if (!code) expect((await importCookies('dia', ['fixture.test'])).cookies[0].value).toBe(expected);
      else await expect(importCookies('dia', ['fixture.test'])).rejects.toMatchObject({ code: expected });
    }
  });

  test('preserves Linux secret lookup through concurrent pipe draining', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    fixture(cbcCookie('test-linux-secret', 'v11'), 'linux');
    Bun.spawn = (() => ({ exited: Promise.resolve(0), stdout: new Blob(['test-linux-secret\n']).stream(),
      stderr: new Blob([]).stream(), kill() { throw new Error('Unexpected kill'); } })) as typeof Bun.spawn;
    expect((await importCookies('chromium', ['fixture.test'])).cookies[0].value).toBe('fixture-value');
  });

  test('bounds a Linux secret lookup with an exited child and inherited pipe', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    fixture(cbcCookie('fixture-other-password', 'v11'), 'linux');
    const stdout = pipe();
    const stderr = pipe();
    stderr.close();
    let killed = 0;
    Bun.spawn = (() => ({ exited: Promise.resolve(0), stdout: stdout.stream, stderr: stderr.stream,
      kill() { killed++; } })) as typeof Bun.spawn;
    let expire: (() => void) | undefined;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback: any) => { expire = callback; return 22 as any; });
    try {
      const result = importCookies('chromium', ['fixture.test']);
      expect(expire).toBeFunction();
      expire!();
      expect(await result).toMatchObject({ count: 0, failed: 1 });
      expect(killed).toBe(1);
      expect(stdout.cancelled()).toBe(true);
    } finally { timer.mockRestore(); }
  });

  test('bounds DPAPI stdout and preserves successful extraction without exposing input', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const key = Buffer.alloc(32, 0x42);
    const nonce = Buffer.alloc(12, 0x22);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([Buffer.from('v10'), nonce, cipher.update('fixture-value'), cipher.final(), cipher.getAuthTag()]);
    fixture(encrypted, 'win32');
    fs.writeFileSync(path.join(home, 'AppData/Local/Chromium/User Data/Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIsynthetic').toString('base64') } }));
    const stdout = pipe(key.toString('base64'));
    const stderr = pipe();
    let sent = '';
    let killed = 0;
    Bun.spawn = (() => ({ exited: Promise.resolve(0), stdout: stdout.stream, stderr: stderr.stream,
      stdin: { write(value: string) { sent = value; }, end() {} }, kill() { killed++; } })) as typeof Bun.spawn;
    let expire: (() => void) | undefined;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback: any) => { expire = callback; return 21 as any; });
    try {
      const result = importCookies('chromium', ['fixture.test']);
      expect(sent).toBe(Buffer.from('synthetic').toString('base64'));
      expect(expire).toBeFunction();
      expire!();
      await expect(result).rejects.toMatchObject({ code: 'keychain_timeout' });
      expect(killed).toBe(1);
    } finally { timer.mockRestore(); }
    Bun.spawn = (() => ({ exited: Promise.resolve(0), stdout: new Blob([key.toString('base64')]).stream(),
      stderr: new Blob([]).stream(), stdin: { write(value: string) { sent = value; }, end() {} }, kill() { throw new Error('Unexpected kill'); } })) as typeof Bun.spawn;
    expect((await importCookies('chromium', ['fixture.test'])).cookies[0].value).toBe('fixture-value');
  });

  test('Node polyfill replay streams work with the bundled importer and a synthetic credential child', () => {
    const bundle = path.join(home, 'importer.mjs');
    const build = spawnSync(process.execPath, ['build', path.resolve(import.meta.dir, '../src/cookie-import-browser.ts'), '--target=node', '--outfile', bundle], { encoding: 'utf8', timeout: 30_000 });
    expect(build.status).toBe(0);
    const node = Bun.which('node')!;
    const polyfill = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs');
    const nodeFixture = path.join(home, 'node-fixture');
    fs.mkdirSync(nodeFixture);
    const dir = path.join(nodeFixture, 'Library/Application Support/Dia/User Data/Default');
    fs.mkdirSync(dir, { recursive: true });
    expect(fs.realpathSync(dir).startsWith(fs.realpathSync(nodeFixture) + path.sep)).toBe(true);
    const db = new Database(path.join(dir, 'Cookies'));
    db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
    db.run("INSERT INTO cookies VALUES ('.fixture.test', 'session', '', ?, '/', 0, 1, 1, 0, 1)", [cbcCookie('fixture-node-password')]);
    db.close();
    const result = spawnSync(node, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      require(process.argv[1]);
      const original = Bun.spawn;
      Bun.spawn = (_command, options) => original([process.execPath, '-e', 'console.log("fixture-node-password")'], options);
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const { importCookies } = await import(process.argv[2]);
      const result = await importCookies('dia', ['fixture.test']);
      console.log(JSON.stringify({ count: result.count, value: result.cookies[0]?.value }));
    `, polyfill, pathToFileURL(bundle).href], { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: nodeFixture, USERPROFILE: nodeFixture, NODE_NO_WARNINGS: '1' } });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ count: 1, value: 'fixture-value' });
  });
});
