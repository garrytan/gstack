import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { getCookiePickerHTML } from '../src/cookie-picker-ui';

type PickerOptions = NonNullable<Parameters<typeof getCookiePickerHTML>[1]>;
type ApiRequest = { path: string; method: string; browser: string | null; profile: string | null; pickerInstance: string | null; body?: any };

describe('rendered cookie picker', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let options: PickerOptions;
  let requests: ApiRequest[];
  let handler: (request: ApiRequest) => Response | Promise<Response> | undefined;
  let profiles: Record<string, { profiles: { name: string; displayName: string; unavailable?: boolean }[]; recommendedProfile?: string }>;
  let browsers: { name: string; aliases?: string[] }[];
  let imported: { domain: string; count: number }[];
  let errors: string[];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/cookie-picker') return new Response(getCookiePickerHTML(server.port!, options), { headers: { 'Content-Type': 'text/html' } });
      if (!url.pathname.startsWith('/cookie-picker/')) return new Response(null, { status: 204 });
      const record = { path: url.pathname.slice('/cookie-picker'.length), method: request.method,
        browser: url.searchParams.get('browser'), profile: url.searchParams.get('profile'),
        pickerInstance: request.headers.get('X-Gstack-Picker-Instance'),
        ...(request.method === 'POST' ? { body: await request.json() } : {}) };
      requests.push(record);
      const response = handler(record);
      if (response) return response;
      if (record.path === '/browsers') return Response.json({ browsers });
      if (record.path === '/imported') return Response.json({ domains: imported });
      if (record.path === '/profiles') return Response.json(profiles[record.browser!] || { profiles: [] });
      if (record.path === '/domains') return Response.json({ domains: [{ domain: '.' + record.browser!.toLowerCase() + '-' + record.profile!.toLowerCase().replaceAll(' ', '-') + '.test', count: 4 }] });
      if (record.path === '/import') return Response.json({ browser: record.body.browser, profile: record.body.profile,
        imported: 2, failed: 0, domainCounts: Object.fromEntries(record.body.domains.map((domain: string) => [domain, 2])),
        failureReasons: {}, outcome: 'imported', message: 'Cookies copied.', reset: 'not_requested',
        verification: { verified: false, reason: 'not_requested' } });
      if (record.path === '/remove') return Response.json({ removed: record.body.domains.length });
      return Response.json({ error: 'Fixture route unavailable' }, { status: 404 });
    } });
    origin = `http://127.0.0.1:${server.port}`;
  });

  beforeEach(async () => {
    options = {};
    requests = [];
    imported = [];
    handler = () => undefined;
    browsers = [{ name: 'Chrome', aliases: ['chrome', 'google-chrome', 'google-chrome-stable'] }, { name: 'Dia', aliases: ['dia'] }];
    profiles = {
      Chrome: { profiles: [{ name: 'Default', displayName: 'Personal' }, { name: 'Profile 1', displayName: 'Personal' }], recommendedProfile: 'Default' },
      Dia: { profiles: [{ name: 'Profile 1', displayName: 'Work' }, { name: 'Profile 2', displayName: 'Work' }], recommendedProfile: 'Profile 2' },
    };
    errors = [];
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
  });

  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function openPicker() {
    await page.goto(`${origin}/cookie-picker`);
    await page.locator('.pill').first().waitFor();
  }

  test('sends the rendered instance on every discovery and mutation request', async () => {
    options = { pickerInstance: 'synthetic-picker-instance' };
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    await page.getByRole('button', { name: 'Remove .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Removed imported cookies' }).waitFor();
    expect([...new Set(requests.map(request => request.path))].sort()).toEqual(['/browsers', '/domains', '/import', '/imported', '/profiles', '/remove']);
    expect(requests.every(request => request.pickerInstance === options.pickerInstance)).toBe(true);
  });

  test('a stale picker fails with actionable reopen guidance instead of a success receipt', async () => {
    options = { pickerInstance: 'stale-picker-instance' };
    handler = request => request.path === '/import'
      ? Response.json({ code: 'picker_changed', error: 'Reopen the picker.' }, { status: 403 }) : undefined;
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Reopen the picker from the intended page before continuing.' }).waitFor();
    expect(await page.getByRole('status').textContent()).toContain('Authentication was not verified.');
    expect(await page.locator('#imported-domains').textContent()).toContain('No cookies imported yet');
  });

  test('preserves default storage and leaves verification disabled without a bound target', async () => {
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).waitFor();
    for (const selector of ['#clear-storage', '#verify-auth']) {
      expect(await page.locator(selector).isChecked()).toBe(false);
      expect(await page.locator(selector).isDisabled()).toBe(true);
    }
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(requests.find(request => request.path === '/import')?.body).toEqual({ browser: 'Chrome', profile: 'Default',
      domains: ['.chrome-default.test'], clearStorage: false, verifyAuth: false });
    expect(await page.getByRole('status').textContent()).toContain('Storage preserved. Authentication not checked.');
    expect(await page.getByRole('status').isVisible()).toBe(true);
  });

  test('does not enable verification or storage reset merely because a target and assertion exist', async () => {
    options = { targetOrigin: 'https://target.test', verificationAvailable: true };
    await openPicker();
    expect(await page.locator('#target-origin').textContent()).toBe('https://target.test');
    for (const selector of ['#clear-storage', '#verify-auth']) {
      expect(await page.locator(selector).isChecked()).toBe(false);
      expect(await page.locator(selector).isEnabled()).toBe(true);
    }
  });

  test('prechecks only explicitly requested options and supports keyboard changes', async () => {
    options = { targetOrigin: 'https://target.test', verificationAvailable: true, clearStorage: true, verifyAuth: true };
    await openPicker();
    for (const selector of ['#clear-storage', '#verify-auth']) {
      expect(await page.locator(selector).isChecked()).toBe(true);
      await page.locator(selector).focus();
      await page.keyboard.press('Space');
      expect(await page.locator(selector).isChecked()).toBe(false);
    }
    const add = page.getByRole('button', { name: 'Import .chrome-default.test', exact: true });
    await add.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(requests.find(request => request.path === '/import')?.body.verifyAuth).toBe(false);
    expect(requests.find(request => request.path === '/import')?.body.clearStorage).toBe(false);
    expect(await page.getByRole('button', { name: 'Reimport .chrome-default.test', exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
  });

  for (const targetOrigin of [undefined, 'about:blank', 'javascript:alert(1)']) {
    test(`disables explicit mutation options for an unavailable target ${String(targetOrigin).split(':')[0]}`, async () => {
      options = { targetOrigin, clearStorage: true, verifyAuth: true, verificationAvailable: true };
      await openPicker();
      expect(await page.locator('#clear-storage').isChecked()).toBe(false);
      expect(await page.locator('#verify-auth').isChecked()).toBe(false);
      expect(await page.locator('#clear-storage').isDisabled()).toBe(true);
      expect(await page.locator('#verify-auth').isDisabled()).toBe(true);
    });
  }

  test('disables verification without configuration even when requested', async () => {
    options = { targetOrigin: 'https://target.test', verifyAuth: true };
    await openPicker();
    expect(await page.locator('#verify-auth').isDisabled()).toBe(true);
    expect(await page.locator('#verify-auth').isChecked()).toBe(false);
    expect(await page.locator('#clear-storage').isEnabled()).toBe(true);
  });

  test('keeps reset disabled on unsupported targets without disabling import', async () => {
    options = { targetOrigin: 'https://target.test', clearStorage: true, storageResetAvailable: false };
    await openPicker();
    expect(await page.locator('#clear-storage').isDisabled()).toBe(true);
    expect(await page.locator('#clear-storage').isChecked()).toBe(false);
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(requests.find(request => request.path === '/import')?.body.clearStorage).toBe(false);
    expect(await page.locator('#clear-storage').isDisabled()).toBe(true);
  });

  test('requires explicit selection among ambiguous profiles and shows directory discriminators', async () => {
    delete profiles.Chrome.recommendedProfile;
    await openPicker();
    await page.getByRole('status').filter({ hasText: 'No unambiguous profile' }).waitFor();
    expect(await page.locator('.profile-pill.active').count()).toBe(0);
    expect(await page.locator('.profile-pill').allTextContents()).toEqual(['Personal (Default)', 'Personal (Profile 1)']);
    expect(requests.filter(request => request.path === '/domains')).toHaveLength(0);
    expect(await page.locator('#btn-import-all').isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Personal (Profile 1)', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Import .chrome-profile-1.test', exact: true }).waitFor();
    expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 1');
    expect(await page.locator('.profile-pill.active').getAttribute('aria-pressed')).toBe('true');
  });

  test('does not guess a sole profile when the server cannot recommend it', async () => {
    profiles.Chrome = { profiles: [{ name: 'Default', displayName: 'Personal', unavailable: true }] };
    await openPicker();
    await page.getByRole('status').filter({ hasText: 'No unambiguous profile' }).waitFor();
    expect(await page.locator('.profile-pill').textContent()).toContain('could not inspect');
    expect(requests.filter(request => request.path === '/domains')).toHaveLength(0);
  });

  test('uses the explicit profile only for its matching browser before painting the active pill', async () => {
    options = { browser: 'chrome', profile: 'Profile 1' };
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-profile-1.test', exact: true }).waitFor();
    expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 1');
    await page.getByRole('button', { name: 'Dia', exact: true }).click();
    await page.getByRole('button', { name: 'Import .dia-profile-2.test', exact: true }).waitFor();
    expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 2');
  });

  test('recognizes supported browser aliases and binds the explicit profile to the canonical browser', async () => {
    options = { browser: 'GOOGLE-CHROME', profile: 'Profile 1' };
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-profile-1.test', exact: true }).waitFor();
    expect(await page.locator('.pill.active').textContent()).toBe('Chrome');
    expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 1');
    await page.getByRole('button', { name: 'Dia', exact: true }).click();
    await page.getByRole('button', { name: 'Import .dia-profile-2.test', exact: true }).waitFor();
    expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 2');
    await page.getByRole('button', { name: 'Chrome', exact: true }).click();
    await page.getByRole('button', { name: 'Import .chrome-profile-1.test', exact: true }).waitFor();
    expect(requests.filter(request => request.path === '/profiles').map(request => request.browser)).toEqual(['Chrome', 'Dia', 'Chrome']);
  });

  test('does not interpret a browser alias substring as an installed browser', async () => {
    options = { browser: 'google' };
    await openPicker();
    await page.getByRole('status').filter({ hasText: 'requested browser is unavailable' }).waitFor();
    expect(await page.locator('.pill.active').count()).toBe(0);
    expect(requests.filter(request => request.path === '/profiles')).toHaveLength(0);
  });

  test('does not silently replace a missing explicit profile or browser', async () => {
    options = { browser: 'Chrome', profile: 'Missing' };
    await openPicker();
    await page.getByRole('status').filter({ hasText: 'requested profile is unavailable' }).waitFor();
    expect(requests.filter(request => request.path === '/domains')).toHaveLength(0);
    options = { browser: 'Missing browser', profile: 'Default' };
    await openPicker();
    await page.getByRole('status').filter({ hasText: 'requested browser is unavailable' }).waitFor();
    expect(await page.locator('.pill.active').count()).toBe(0);
  });

  for (const earlierFirst of [true, false]) {
    test(`ignores stale profile responses when the earlier request returns ${earlierFirst ? 'first' : 'last'}`, async () => {
      const chrome = Promise.withResolvers<Response>();
      const dia = Promise.withResolvers<Response>();
      const chromeSeen = Promise.withResolvers<void>();
      const diaSeen = Promise.withResolvers<void>();
      handler = request => {
        if (request.path !== '/profiles') return;
        if (request.browser === 'Chrome') { chromeSeen.resolve(); return chrome.promise; }
        diaSeen.resolve(); return dia.promise;
      };
      await openPicker();
      await chromeSeen.promise;
      await page.getByRole('button', { name: 'Dia', exact: true }).click();
      await diaSeen.promise;
      if (earlierFirst) {
        const response = page.waitForResponse(response => response.url().includes('/profiles?browser=Chrome'));
        chrome.resolve(Response.json(profiles.Chrome));
        await response;
        expect(await page.locator('.profile-pill.active').count()).toBe(0);
      }
      dia.resolve(Response.json(profiles.Dia));
      await page.getByRole('button', { name: 'Import .dia-profile-2.test', exact: true }).waitFor();
      if (!earlierFirst) {
        const response = page.waitForResponse(response => response.url().includes('/profiles?browser=Chrome'));
        chrome.resolve(Response.json(profiles.Chrome));
        await response;
      }
      expect(await page.locator('.pill.active').textContent()).toBe('Dia');
      expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 2');
      expect(requests.filter(request => request.path === '/domains').map(request => request.browser)).toEqual(['Dia']);
    });
  }

  for (const earlierFirst of [true, false]) {
    test(`ignores stale domain responses when the earlier request returns ${earlierFirst ? 'first' : 'last'}`, async () => {
      const first = Promise.withResolvers<Response>();
      const second = Promise.withResolvers<Response>();
      const firstSeen = Promise.withResolvers<void>();
      const secondSeen = Promise.withResolvers<void>();
      handler = request => {
        if (request.path !== '/domains') return;
        if (request.profile === 'Default') { firstSeen.resolve(); return first.promise; }
        secondSeen.resolve(); return second.promise;
      };
      await openPicker();
      await firstSeen.promise;
      await page.getByRole('button', { name: 'Personal (Profile 1)', exact: true }).click();
      await secondSeen.promise;
      if (earlierFirst) {
        const response = page.waitForResponse(response => response.url().includes('&profile=Default'));
        first.resolve(Response.json({ domains: [{ domain: '.stale.test', count: 4 }] }));
        await response;
        expect(await page.locator('.btn-add').count()).toBe(0);
      }
      second.resolve(Response.json({ domains: [{ domain: '.current.test', count: 2 }] }));
      await page.getByRole('button', { name: 'Import .current.test', exact: true }).waitFor();
      if (!earlierFirst) {
        const response = page.waitForResponse(response => response.url().includes('&profile=Default'));
        first.resolve(Response.json({ domains: [{ domain: '.stale.test', count: 4 }] }));
        await response;
      }
      expect(await page.locator('#source-domains .domain-name').allTextContents()).toEqual(['.current.test']);
      expect(await page.locator('.profile-pill.active').getAttribute('data-profile')).toBe('Profile 1');
    });
  }

  for (const outcome of ['partial', 'empty', 'failed']) {
    test(`reports an HTTP-200 ${outcome} receipt persistently rather than as silent success`, async () => {
      handler = request => request.path === '/import' ? Response.json({ imported: outcome === 'partial' ? 2 : 0, failed: 3,
        domainCounts: outcome === 'partial' ? { '.chrome-default.test': 2 } : {}, failureReasons: { unsupported_encryption: 3 },
        outcome, message: 'Synthetic import receipt.', reset: outcome === 'failed' ? 'failed' : 'not_requested', verification: { verified: false, reason: 'not_requested' } }) : undefined;
      await openPicker();
      await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Synthetic import receipt.' }).waitFor();
      const status = await page.getByRole('status').textContent();
      expect(status).toContain(outcome === 'partial' ? 'Partial import.' : outcome === 'empty' ? 'No cookies imported.' : 'Import failed.');
      expect(status).toContain('3 failed.');
      expect(status).toContain('unsupported encryption: 3.');
      expect(status).toContain('Authentication not checked.');
      expect(await page.getByRole('status').getAttribute('class')).toContain(outcome === 'failed' ? 'error' : 'warning');
      expect(await page.locator('.btn-add.imported').count()).toBe(0);
      expect(await page.locator('#imported-domains .domain-name').count()).toBe(outcome === 'partial' ? 1 : 0);
      expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
    });
  }

  test('sets imported counts on explicit reimport rather than adding them again', async () => {
    imported = [{ domain: '.chrome-default.test', count: 6 }];
    await openPicker();
    await page.getByRole('button', { name: 'Reimport .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(await page.locator('#imported-domains .domain-count').textContent()).toBe('2');
    await page.getByRole('button', { name: 'Reimport .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(await page.locator('#imported-domains .domain-count').textContent()).toBe('2');
    expect(requests.filter(request => request.path === '/import')).toHaveLength(2);
  });

  test('serializes imports, disables source switches, and does not repeat POSTs on double submit', async () => {
    options = { targetOrigin: 'https://target.test', verificationAvailable: true };
    imported = [{ domain: '.already.test', count: 1 }];
    const result = Promise.withResolvers<Response>();
    const seen = Promise.withResolvers<void>();
    handler = request => { if (request.path === '/import') { seen.resolve(); return result.promise; } };
    await openPicker();
    const add = page.getByRole('button', { name: 'Import .chrome-default.test', exact: true });
    await add.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
    await seen.promise;
    expect(await page.getByRole('button', { name: 'Dia', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Personal (Profile 1)', exact: true }).isDisabled()).toBe(true);
    for (const selector of ['#btn-import-all', '#clear-storage', '#verify-auth', '#search', '.btn-trash']) expect(await page.locator(selector).isDisabled()).toBe(true);
    await page.locator('#btn-import-all').evaluate((element: HTMLButtonElement) => element.click());
    await page.getByRole('button', { name: 'Dia', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
    expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
    result.resolve(Response.json({ imported: 1, failed: 0, domainCounts: { '.chrome-default.test': 1 }, outcome: 'imported', reset: 'not_requested', verification: { verified: false, reason: 'not_requested' } }));
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(await page.locator('.pill.active').textContent()).toBe('Chrome');
    expect(await page.getByRole('button', { name: 'Dia', exact: true }).isEnabled()).toBe(true);
    expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
  });

  test('serializes removal with imports and retains counts on a failed removal', async () => {
    imported = [{ domain: '.already.test', count: 1 }];
    const result = Promise.withResolvers<Response>();
    const seen = Promise.withResolvers<void>();
    handler = request => { if (request.path === '/remove') { seen.resolve(); return result.promise; } };
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove .already.test', exact: true }).click();
    await seen.promise;
    expect(await page.locator('.btn-add').isDisabled()).toBe(true);
    await page.locator('.btn-add').evaluate((element: HTMLButtonElement) => element.click());
    expect(requests.filter(request => request.path === '/import')).toHaveLength(0);
    result.resolve(Response.json({ error: 'synthetic-private-error' }, { status: 500 }));
    await page.getByRole('status').filter({ hasText: 'Cookie removal did not complete.' }).waitFor();
    expect(await page.locator('#imported-domains .domain-count').textContent()).toBe('1');
    expect(await page.getByRole('status').textContent()).not.toContain('synthetic-private-error');
    expect(requests.filter(request => request.path === '/remove')).toHaveLength(1);
  });

  test('reports mutation errors without replaying the POST or exposing raw errors', async () => {
    handler = request => request.path === '/import' ? Response.json({ error: 'synthetic-private-error', action: 'retry' }, { status: 503 }) : undefined;
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Import did not complete' }).waitFor();
    expect(await page.getByRole('status').textContent()).not.toContain('synthetic-private-error');
    expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
    expect(await page.locator('.btn-add').isEnabled()).toBe(true);
  });

  for (const [code, guidance] of [
    ['keychain_denied', 'Allow access in the OS permission prompt or settings'],
    ['keychain_timeout', 'Check for a pending OS permission prompt'],
    ['keychain_error', 'Check the OS credential store'],
    ['db_locked', 'Close the source browser, then retry manually'],
    ['db_corrupt', 'Choose another profile or sign in manually'],
    ['db_permission', 'Check source-profile permissions'],
    ['db_read_error', 'Cookie data could not be read from this profile'],
    ['sqlite_unavailable', 'Node.js 22.13 or newer with built-in SQLite enabled'],
    ['storage_reset_unsupported', 'Storage reset requires a Chromium target'],
    ['profile_required', 'Choose a source profile explicitly'],
    ['target_changed', 'Reopen the picker from the intended HTTP(S) page'],
    ['target_closed', 'The captured target is closed'],
    ['target_mismatch', 'Select its cookie domain or reopen the picker'],
    ['not_supported', 'Native cookie import is unsupported'],
    ['native_profile_unsupported', 'This browser profile does not support native cookie extraction'],
    ['native_unqualified', 'process ownership and cleanup are not qualified'],
    ['native_cleanup_failed', 'Inspect the source browser before any manual retry'],
    ['native_supervision_failed', 'Native browser supervision could not start'],
    ['native_timeout', 'Native cookie extraction timed out'],
    ['browser_running', 'Close it yourself before retrying'],
  ]) {
    test(`shows actionable allowlisted ${code} guidance without server prose or automatic replay`, async () => {
      handler = request => request.path === '/import' ? Response.json({ code, action: 'retry',
        error: '<img src=x onerror="window.errorXss=1"> synthetic-private-error' }, { status: 400 }) : undefined;
      await openPicker();
      await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Import did not complete' }).waitFor();
      expect(await page.getByRole('status').textContent()).toContain(guidance);
      expect(await page.getByRole('status').textContent()).not.toContain('synthetic-private-error');
      expect(await page.locator('img').count()).toBe(0);
      expect(await page.evaluate(() => (window as any).errorXss)).toBeUndefined();
      expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
      expect(await page.locator('.btn-add').isEnabled()).toBe(true);
    });
  }

  for (const code of ['unknown_private_code', '__proto__', '<img src=x onerror="window.errorXss=1">']) {
    test(`uses safe generic guidance for an unallowlisted error code ${code.startsWith('<') ? 'markup' : code}`, async () => {
      handler = request => request.path === '/import' ? Response.json({ code, error: 'synthetic-private-error' }, { status: 400 }) : undefined;
      await openPicker();
      await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Import did not complete' }).waitFor();
      expect(await page.getByRole('status').textContent()).toContain('Inspect the source and destination before retrying');
      expect(await page.getByRole('status').textContent()).not.toContain(code);
      expect(await page.getByRole('status').textContent()).not.toContain('synthetic-private-error');
      expect(await page.locator('img').count()).toBe(0);
    });
  }

  for (const path of ['/profiles', '/domains']) {
    test(`preserves safe actionable guidance on ${path} read failures`, async () => {
      handler = request => request.path === path ? Response.json({ code: 'db_locked', error: 'synthetic-private-error' }, { status: 400 }) : undefined;
      await openPicker();
      await page.getByRole('status').filter({ hasText: 'source cookie database is busy' }).waitFor();
      expect(await page.getByRole('status').textContent()).toContain('Close the source browser, then retry manually');
      expect(await page.getByRole('status').textContent()).not.toContain('synthetic-private-error');
      expect(requests.filter(request => request.path === path)).toHaveLength(1);
    });
  }

  test('permits a deliberate manual retry after permission recovery without replaying automatically', async () => {
    handler = request => request.path === '/import' ? Response.json({ code: 'keychain_denied', action: 'retry', error: 'synthetic-private-error' }, { status: 400 }) : undefined;
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Keychain access was denied' }).waitFor();
    expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
    handler = () => undefined;
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(requests.filter(request => request.path === '/import')).toHaveLength(2);
  });

  test('imports the visible filtered domains in one request with explicit target options', async () => {
    options = { targetOrigin: 'https://target.test', verificationAvailable: true };
    handler = request => request.path === '/domains' ? Response.json({ domains: [{ domain: '.one.test', count: 3 }, { domain: '.two.test', count: 2 }, { domain: '.other.invalid', count: 1 }] }) : undefined;
    await openPicker();
    await page.getByRole('button', { name: 'Import .one.test', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search cookie domains' }).fill('.test');
    await page.locator('#clear-storage').check();
    await page.locator('#verify-auth').check();
    await page.getByRole('button', { name: 'Import All (2)', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(requests.filter(request => request.path === '/import')).toHaveLength(1);
    expect(requests.find(request => request.path === '/import')?.body).toEqual({ browser: 'Chrome', profile: 'Default', domains: ['.one.test', '.two.test'], clearStorage: true, verifyAuth: true });
    expect(await page.getByRole('status').textContent()).toContain('Authentication not verified');
  });

  for (const importedCount of [0, 2]) {
    test(`requires a requested positive check and nonzero import before verified (${importedCount} imported)`, async () => {
      options = { targetOrigin: 'https://target.test', verifyAuth: true, verificationAvailable: true, clearStorage: true };
      handler = request => request.path === '/import' ? Response.json({ imported: importedCount, failed: 0, domainCounts: {}, outcome: importedCount ? 'imported' : 'empty', reset: 'cleared', verification: { verified: true, reason: 'verified' } }) : undefined;
      await openPicker();
      await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Storage cleared for' }).waitFor();
      expect(await page.getByRole('status').textContent()).toContain(importedCount ? 'Authentication verified on the captured target.' : 'Authentication not verified.');
    });
  }

  test('does not claim verification for an unrequested check even if a response says verified', async () => {
    options = { targetOrigin: 'https://target.test', verificationAvailable: true };
    handler = request => request.path === '/import' ? Response.json({ imported: 2, failed: 0, domainCounts: {}, outcome: 'imported', verification: { verified: true } }) : undefined;
    await openPicker();
    await page.getByRole('button', { name: 'Import .chrome-default.test', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(await page.getByRole('status').textContent()).toContain('Authentication not checked.');
    expect(await page.getByRole('status').textContent()).not.toContain('Authentication verified');
  });

  test('escapes script configuration, profile attributes, domain attributes, and status text', async () => {
    const payload = '\"\'><img src=x onerror="window.fixtureXss=1"></script><script>window.fixtureXss=1</script>';
    options = { browser: payload, profile: payload, targetOrigin: 'https://target.test' };
    browsers = [{ name: payload }];
    profiles = { [payload]: { profiles: [{ name: payload, displayName: payload }] } };
    handler = request => request.path === '/domains' ? Response.json({ domains: [{ domain: payload, count: 1 }] })
      : request.path === '/import' ? Response.json({ imported: 1, failed: 0, domainCounts: { [payload]: 1 }, outcome: 'imported', message: payload }) : undefined;
    await openPicker();
    await page.locator('.btn-add').waitFor();
    expect(await page.locator('.profile-pill').getAttribute('data-profile')).toBe(payload);
    expect(await page.locator('.btn-add').getAttribute('data-domain')).toBe(payload);
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fixtureXss)).toBeUndefined();
    await page.locator('.btn-add').click();
    await page.getByRole('status').filter({ hasText: 'Cookies imported.' }).waitFor();
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fixtureXss)).toBeUndefined();
    expect(requests.find(request => request.path === '/import')?.body.profile).toBe(payload);
    expect(await page.locator('.btn-trash').getAttribute('data-domain')).toBe(payload);
  });

  test('serializes only a safe target origin, never credentials, path, or query data', async () => {
    const target = new URL('https://target.test/private-path?fixture-token=private-value');
    target.username = 'fixture-user';
    target.password = 'fixture';
    options = { targetOrigin: target.href };
    const html = getCookiePickerHTML(server.port!, options);
    expect(html).not.toContain('fixture-user');
    expect(html).not.toContain('private-path');
    expect(html).not.toContain('private-value');
    await openPicker();
    expect(await page.locator('#target-origin').textContent()).toBe('https://target.test');
    expect(await page.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });
});
