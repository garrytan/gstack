import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { generatePickerCode, handleCookiePickerRoute, hasActivePicker } from '../src/cookie-picker-routes';

for (const sameOrigin of [false, true]) {
  test(`two real picker windows cannot reset the other ${sameOrigin ? 'same-origin tab' : 'same-host different-port origin'}`, async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'picker-binding-'));
    const profile = path.join(home, '.config/chromium/Default');
    mkdirSync(profile, { recursive: true });
    expect(realpathSync(profile).startsWith(realpathSync(home) + path.sep)).toBe(true);
    const database = new Database(path.join(profile, 'Cookies'));
    database.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
    database.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, 0, 0, 1, 0, 1)', ['127.0.0.1', 'fixture', 'synthetic', Buffer.alloc(0), '/']);
    database.close();
    const serveTarget = () => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const authenticated = (request.headers.get('cookie') ?? '').split(';').some(value => value.trim() === 'fixture=synthetic');
      return new Response(authenticated ? '<div id="fixture-identity">Synthetic account</div>' : '<div>Not signed in</div>', {
        headers: { 'Content-Type': 'text/html' }, status: authenticated ? 200 : 401,
      });
    } });
    const firstServer = serveTarget();
    const secondServer = sameOrigin ? firstServer : serveTarget();
    let browser: Browser | undefined;
    let picker: ReturnType<typeof Bun.serve> | undefined;
    let homeMock: ReturnType<typeof spyOn> | undefined;
    const selector = process.env.GSTACK_COOKIE_AUTH_SELECTOR;
    const identity = process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY;
    try {
      browser = await chromium.launch({ headless: true });
      homeMock = spyOn(os, 'homedir').mockReturnValue(home);
      process.env.GSTACK_COOKIE_AUTH_SELECTOR = '#fixture-identity';
      process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY = 'Synthetic account';
      const destination = await browser.newContext();
      destination.setDefaultTimeout(5_000);
      const targetA = await destination.newPage();
      const targetB = await destination.newPage();
      await targetA.goto(`http://127.0.0.1:${firstServer.port}/a`);
      await targetB.goto(`http://127.0.0.1:${secondServer.port}/b`);
      for (const target of [targetA, targetB]) {
        await target.evaluate(() => { localStorage.setItem('keep', 'preserved'); sessionStorage.setItem('keep', 'preserved'); });
      }
      const bm = { getActiveSession: () => ({ getPage: () => targetA }), trackCookieImportDomains() {} } as any;
      picker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => handleCookiePickerRoute(new URL(request.url), request, bm) });
      const pickerOrigin = `http://127.0.0.1:${picker.port}`;
      const client = await browser.newContext();
      client.setDefaultTimeout(5_000);
      const windowA = await client.newPage();
      const windowB = await client.newPage();
      const importButton = /^(?:Import|Reimport) 127\.0\.0\.1$/;
      const errors: string[] = [];
      for (const window of [windowA, windowB]) window.on('pageerror', error => errors.push(error.message));
      const open = async (window: typeof windowA, target: typeof targetA) => {
        const code = generatePickerCode({ browser: 'Chromium', target: { page: target, url: target.url() } });
        await window.goto(pickerOrigin + '/cookie-picker?code=' + code);
        await window.getByRole('button', { name: importButton }).waitFor();
        await window.locator('#clear-storage').check();
        await window.locator('#verify-auth').check();
      };
      await open(windowA, targetA);
      await open(windowB, targetB);
      await windowA.getByRole('button', { name: importButton }).click();
      await windowA.getByRole('status').filter({ hasText: 'Reopen the picker from the intended page before continuing.' }).waitFor();
      for (const target of [targetA, targetB]) {
        expect(await target.evaluate(() => [localStorage.getItem('keep'), sessionStorage.getItem('keep')])).toEqual(['preserved', 'preserved']);
      }
      expect(await destination.cookies()).toEqual([]);
      expect(await targetA.locator('#fixture-identity').count()).toBe(0);
      expect(await targetB.locator('#fixture-identity').count()).toBe(0);
      await windowB.getByRole('button', { name: importButton }).click();
      await windowB.getByRole('status').filter({ hasText: 'Authentication verified on the captured target.' }).waitFor();
      expect(await targetB.evaluate(() => [localStorage.getItem('keep'), sessionStorage.getItem('keep')])).toEqual([null, null]);
      expect(await targetA.evaluate(() => [localStorage.getItem('keep'), sessionStorage.getItem('keep')])).toEqual([sameOrigin ? null : 'preserved', 'preserved']);
      expect(await targetB.locator('#fixture-identity').innerText()).toBe('Synthetic account');
      expect(await targetA.locator('#fixture-identity').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      homeMock?.mockRestore();
      if (selector === undefined) delete process.env.GSTACK_COOKIE_AUTH_SELECTOR;
      else process.env.GSTACK_COOKIE_AUTH_SELECTOR = selector;
      if (identity === undefined) delete process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY;
      else process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY = identity;
      await browser?.close();
      picker?.stop(true);
      firstServer.stop(true);
      if (!sameOrigin) secondServer.stop(true);
      const now = Date.now;
      Date.now = () => now() + 3_900_001;
      try { hasActivePicker(); } finally { Date.now = now; }
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
}
