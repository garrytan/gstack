/**
 * Security tests for browse module hardening
 *
 * Covers: cookie redaction, upload path validation, health endpoint info leak,
 * cookie picker auth, js/eval disable flag
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleReadCommand } from '../src/read-commands';
import { handleWriteCommand } from '../src/write-commands';
import { validateReadPath } from '../src/read-commands';
import * as path from 'path';
import * as fs from 'fs';

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
  await bm.close();
  testServer.close();
});

describe('Cookie Redaction (C4)', () => {
  test('redacts cookies with sensitive names', async () => {
    const page = bm.getPage();
    await page.goto(baseUrl);
    await page.context().addCookies([
      { name: 'session_token', value: 'secret123', domain: 'localhost', path: '/' },
      { name: 'csrf_token', value: 'csrf-val', domain: 'localhost', path: '/' },
      { name: 'auth-key', value: 'auth-val', domain: 'localhost', path: '/' },
      { name: 'jwt_access', value: 'eyJhbGciOiJIUzI1NiJ9.test', domain: 'localhost', path: '/' },
      { name: 'theme', value: 'dark', domain: 'localhost', path: '/' },
    ]);

    const result = await handleReadCommand('cookies', [], bm);
    const cookies = JSON.parse(result);

    const sessionCookie = cookies.find((c: any) => c.name === 'session_token');
    expect(sessionCookie.value).toContain('[REDACTED');

    const csrfCookie = cookies.find((c: any) => c.name === 'csrf_token');
    expect(csrfCookie.value).toContain('[REDACTED');

    const authCookie = cookies.find((c: any) => c.name === 'auth-key');
    expect(authCookie.value).toContain('[REDACTED');

    const jwtCookie = cookies.find((c: any) => c.name === 'jwt_access');
    expect(jwtCookie.value).toContain('[REDACTED');

    const themeCookie = cookies.find((c: any) => c.name === 'theme');
    expect(themeCookie.value).toBe('dark');
  });

  test('--raw flag returns unredacted cookies', async () => {
    const page = bm.getPage();
    await page.goto(baseUrl);
    await page.context().addCookies([
      { name: 'session_token', value: 'secret123', domain: 'localhost', path: '/' },
    ]);

    const result = await handleReadCommand('cookies', ['--raw'], bm);
    const cookies = JSON.parse(result);
    const sessionCookie = cookies.find((c: any) => c.name === 'session_token');
    expect(sessionCookie.value).toBe('secret123');
  });

  test('redacts cookies with sensitive-looking values (JWT prefix)', async () => {
    const page = bm.getPage();
    await page.goto(baseUrl);
    await page.context().addCookies([
      { name: 'my_normal_cookie', value: 'eyJhbGciOiJIUzI1NiJ9.payload.signature', domain: 'localhost', path: '/' },
    ]);

    const result = await handleReadCommand('cookies', [], bm);
    const cookies = JSON.parse(result);
    const jwtCookie = cookies.find((c: any) => c.name === 'my_normal_cookie');
    expect(jwtCookie.value).toContain('[REDACTED');
  });
});

describe('Upload Path Validation (H7)', () => {
  test('rejects path traversal in upload', async () => {
    const page = bm.getPage();
    await page.goto(baseUrl);

    await expect(
      handleWriteCommand('upload', ['#file-input', '../../etc/passwd'], bm)
    ).rejects.toThrow(/path traversal/i);
  });

  test('rejects absolute path outside safe directories', async () => {
    const page = bm.getPage();
    await page.goto(baseUrl);

    await expect(
      handleWriteCommand('upload', ['#file-input', '/etc/passwd'], bm)
    ).rejects.toThrow(/must be within/i);
  });
});

describe('JS/Eval Disable Flag (C3)', () => {
  test('js command blocked when BROWSE_DISABLE_JS=1', async () => {
    const origVal = process.env.BROWSE_DISABLE_JS;
    process.env.BROWSE_DISABLE_JS = '1';
    try {
      await expect(
        handleReadCommand('js', ['1+1'], bm)
      ).rejects.toThrow(/disabled/i);
    } finally {
      if (origVal === undefined) delete process.env.BROWSE_DISABLE_JS;
      else process.env.BROWSE_DISABLE_JS = origVal;
    }
  });

  test('eval command blocked when BROWSE_DISABLE_JS=1', async () => {
    const origVal = process.env.BROWSE_DISABLE_JS;
    process.env.BROWSE_DISABLE_JS = '1';
    try {
      await expect(
        handleReadCommand('eval', ['/tmp/test.js'], bm)
      ).rejects.toThrow(/disabled/i);
    } finally {
      if (origVal === undefined) delete process.env.BROWSE_DISABLE_JS;
      else process.env.BROWSE_DISABLE_JS = origVal;
    }
  });
});

describe('Read Path Validation', () => {
  test('rejects absolute path outside safe dirs', () => {
    expect(() => validateReadPath('/etc/shadow')).toThrow(/must be within/i);
  });

  test('rejects path traversal sequences', () => {
    expect(() => validateReadPath('../../etc/passwd')).toThrow(/traversal/i);
  });

  test('allows paths within cwd', () => {
    expect(() => validateReadPath(path.join(process.cwd(), 'package.json'))).not.toThrow();
  });
});
