import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { generatePickerCode, handleCookiePickerRoute, hasActivePicker } from '../src/cookie-picker-routes';
import * as importer from '../src/cookie-import-browser';
import * as operation from '../src/cookie-import-operation';
import * as auth from '../src/cookie-auth-verification';

const origin = 'http://127.0.0.1:9470';
let bm: any;
let context: any;
let reads: ReturnType<typeof spyOn>[];
let reset: ReturnType<typeof spyOn>;
let verify: ReturnType<typeof spyOn>;
let previousSelector: string | undefined;
let previousIdentity: string | undefined;

function page(url: string) {
  return { url: () => url, isClosed: () => false, context: () => context } as any;
}

async function request(path: string, cookie?: string, instance?: string, body?: unknown, bearer?: string) {
  const url = new URL(origin + '/cookie-picker' + path);
  return handleCookiePickerRoute(url, new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(instance ? { 'X-Gstack-Picker-Instance': instance } : {}),
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bm, 'fixture-bearer');
}

async function open(target: any) {
  const code = generatePickerCode({ target: { page: target, url: target.url() } });
  const exchanged = await request('?code=' + code);
  expect(exchanged.status).toBe(302);
  const cookie = exchanged.headers.get('set-cookie')!.split(';')[0];
  const response = await request('', cookie);
  expect(response.status).toBe(200);
  const html = await response.text();
  const config = JSON.parse(html.match(/<script id="picker-config" type="application\/json">(.*?)<\/script>/s)![1]);
  return { cookie, config, html, code };
}

beforeEach(() => {
  previousSelector = process.env.GSTACK_COOKIE_AUTH_SELECTOR;
  previousIdentity = process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY;
  process.env.GSTACK_COOKIE_AUTH_SELECTOR = '#fixture-identity';
  process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY = 'Synthetic account';
  context = { addCookies: mock(async () => {}), clearCookies: mock(async () => {}),
    browser: () => ({ browserType: () => ({ name: () => 'chromium' }) }) };
  bm = { getActiveSession: () => ({ getPage: () => page('https://example.test/current') }), trackCookieImportDomains: mock(() => {}) };
  reads = [
    spyOn(importer, 'findInstalledBrowsers').mockReturnValue([{ name: 'Chromium', aliases: ['chromium'] }] as any),
    spyOn(operation, 'getCookieProfiles').mockResolvedValue({ profiles: [{ name: 'Default', displayName: 'Synthetic' }], recommendedProfile: 'Default' }),
    spyOn(importer, 'listDomains').mockReturnValue({ browser: 'Chromium', domains: [{ domain: '.example.test', count: 1 }] }),
    spyOn(importer, 'importCookies').mockResolvedValue({ cookies: [{ name: 'fixture', value: 'synthetic', domain: '.example.test', path: '/',
      expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }], count: 1, failed: 0, domainCounts: { '.example.test': 1 } }),
  ];
  reset = spyOn(auth, 'clearCookieTargetStorage').mockResolvedValue(undefined);
  verify = spyOn(auth, 'verifyCookieAuthentication').mockResolvedValue({ verified: true, reason: 'verified' });
});

afterEach(() => {
  mock.restore();
  if (previousSelector === undefined) delete process.env.GSTACK_COOKIE_AUTH_SELECTOR;
  else process.env.GSTACK_COOKIE_AUTH_SELECTOR = previousSelector;
  if (previousIdentity === undefined) delete process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY;
  else process.env.GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY = previousIdentity;
  const now = Date.now;
  Date.now = () => now() + 3_900_001;
  try { hasActivePicker(); } finally { Date.now = now; }
});

describe('cookie picker document binding', () => {
  test('renders independent instance identifiers without exposing authentication credentials', async () => {
    const first = await open(page('https://example.test/a'));
    const second = await open(page('https://example.test/b'));
    for (const picker of [first, second]) {
      expect(picker.config.pickerInstance).toMatch(/^[0-9a-f-]{36}$/);
      expect(picker.html).not.toContain(picker.cookie.slice('gstack_picker='.length));
      expect(picker.html).not.toContain(picker.code);
      expect(picker.html).not.toContain('fixture-bearer');
    }
    expect(first.config.pickerInstance).not.toBe(second.config.pickerInstance);
  });

  test('missing and forged instance headers fail before discovery or import', async () => {
    const picker = await open(page('https://example.test/a'));
    for (const instance of [undefined, 'forged', picker.cookie.slice('gstack_picker='.length)]) {
      for (const [path, payload] of [['/browsers'], ['/import', { browser: 'Chromium', profile: 'Default', domains: ['example.test'], clearStorage: true, verifyAuth: true }]] as const) {
        const response = await request(path, picker.cookie, instance, payload);
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('picker_changed');
      }
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  test('a rendered instance identifier never authorizes an unauthenticated request', async () => {
    const picker = await open(page('https://example.test/a'));
    for (const cookie of [undefined, 'gstack_picker=' + picker.config.pickerInstance]) {
      const response = await request('/browsers', cookie, picker.config.pickerInstance);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  test('bearer authorization ignores an unrelated cookie and stale picker identifier', async () => {
    const first = await open(page('https://example.test/a'));
    const second = await open(page('https://example.test/b'));
    const current = page('https://example.test/current');
    bm.getActiveSession = () => ({ getPage: () => current });
    const response = await request('/import', second.cookie, first.config.pickerInstance,
      { browser: 'Chromium', profile: 'Default', domains: ['example.test'], clearStorage: true, verifyAuth: true }, 'fixture-bearer');
    expect(response.status).toBe(200);
    expect(reset).toHaveBeenCalledWith(current, 'https://example.test');
    expect(verify).toHaveBeenCalledWith(current, { identitySelector: '#fixture-identity', expectedIdentity: 'Synthetic account' }, 'https://example.test');
  });

  for (const [scenario, firstUrl, secondUrl] of [
    ['same-host different-port origins', 'https://example.test:8443/a', 'https://example.test:9443/b'],
    ['same-origin different tabs', 'https://example.test/a', 'https://example.test/b'],
  ]) {
    test(`rejects an old window before reads or mutations for ${scenario}`, async () => {
      const first = await open(page(firstUrl));
      const target = page(secondUrl);
      const second = await open(target);
      const body = { browser: 'Chromium', profile: 'Default', domains: ['example.test'], clearStorage: true, verifyAuth: true };
      const calls: Array<[string, unknown?]> = [['/browsers'], ['/profiles?browser=Chromium'], ['/domains?browser=Chromium&profile=Default'],
        ['/imported'], ['/import', body], ['/remove', { domains: ['example.test'] }]];
      for (const [path, payload] of calls) {
        const response = await request(path, second.cookie, first.config.pickerInstance, payload);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'picker_changed', error: expect.stringContaining('Reopen') });
      }
      for (const read of reads) expect(read).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(context.addCookies).not.toHaveBeenCalled();
      expect(context.clearCookies).not.toHaveBeenCalled();
      expect(first.config.targetOrigin).toBe(new URL(firstUrl).origin);
      for (const [path, payload] of calls) {
        expect((await request(path, second.cookie, second.config.pickerInstance, payload)).status).toBe(200);
      }
      for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
      expect(reset).toHaveBeenCalledWith(target, new URL(secondUrl).origin);
      expect(verify).toHaveBeenCalledWith(target, { identitySelector: '#fixture-identity', expectedIdentity: 'Synthetic account' }, new URL(secondUrl).origin);
      expect(context.addCookies).toHaveBeenCalledTimes(1);
      expect(context.clearCookies).toHaveBeenCalledTimes(1);
    });
  }
});
