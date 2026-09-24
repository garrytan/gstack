import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { BrowserManager } from '../src/browser-manager';
import { getCookieProfiles, parseCookieImportArgs, runCookieImport } from '../src/cookie-import-operation';
import { generatePickerCode, handleCookiePickerRoute, hasActivePicker } from '../src/cookie-picker-routes';
import { handleReadCommand } from '../src/read-commands';
import { handleWriteCommand } from '../src/write-commands';
import * as importer from '../src/cookie-import-browser';

let home: string;
let homeMock: ReturnType<typeof spyOn>;
let currentUrl: string;
let page: any;
let context: any;
let session: any;
let bm: BrowserManager;
let cdp: any;

function installProfile(name = 'Default', domain = '.example.test', badCookie = false) {
  const dir = path.join(home, '.config/chromium', name);
  fs.mkdirSync(dir, { recursive: true });
  expect(fs.realpathSync(dir).startsWith(fs.realpathSync(home) + path.sep)).toBe(true);
  const db = new Database(path.join(dir, 'Cookies'));
  db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER)');
  db.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, 0, 1, 1, 0, 1)', [domain, 'session', 'synthetic-session', Buffer.alloc(0), '/']);
  if (badCookie) db.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, 0, 1, 1, 0, 1)', [domain, 'broken', '', Buffer.from('v20synthetic'), '/']);
  db.close();
}

async function route(method: string, pathname: string, body?: unknown, cookie?: string) {
  const url = new URL('http://127.0.0.1:9470/cookie-picker' + pathname);
  let pickerInstance = '';
  if (cookie) {
    const document = await handleCookiePickerRoute(new URL(url.origin + '/cookie-picker'), new Request(url.origin + '/cookie-picker', {
      headers: { Cookie: cookie },
    }), bm, 'fixture');
    const html = await document.text();
    pickerInstance = JSON.parse(html.match(/<script id="picker-config" type="application\/json">(.*?)<\/script>/s)![1]).pickerInstance;
  }
  return handleCookiePickerRoute(url, new Request(url, {
    method,
    headers: cookie ? { Cookie: cookie, Origin: url.origin, 'Content-Type': 'application/json', 'X-Gstack-Picker-Instance': pickerInstance } : { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bm, 'fixture');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-op-'));
  homeMock = spyOn(os, 'homedir').mockReturnValue(home);
  currentUrl = 'https://example.test/protected';
  const cdpEvents = new EventEmitter();
  const pageEvents = new EventEmitter();
  const frame = {};
  cdp = {
    on: cdpEvents.on.bind(cdpEvents), off: cdpEvents.off.bind(cdpEvents), detach: mock(async () => {}),
    send: mock(async (method: string, params: any) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'fixture-frame' } } };
      if (method === 'Runtime.enable') return {};
      if (method === 'Page.createIsolatedWorld') {
        cdpEvents.emit('Runtime.executionContextCreated', { context: { name: params.worldName, id: 7, uniqueId: 'fixture-world', auxData: { frameId: 'fixture-frame', isDefault: false } } });
        return { executionContextId: 7 };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 100 } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'cleared' } };
      throw new Error('Unexpected protocol method');
    }),
  };
  context = { addCookies: mock(async () => {}), clearCookies: mock(async () => {}),
    browser: () => ({ browserType: () => ({ name: () => 'chromium' }) }), newCDPSession: mock(async () => cdp) };
  page = {
    url: () => currentUrl,
    isClosed: () => false,
    context: () => context,
    evaluate: mock(async () => 'cleared'),
    reload: mock(async () => { throw new Error('Should not reload'); }),
    mainFrame: () => frame, on: pageEvents.on.bind(pageEvents), off: pageEvents.off.bind(pageEvents),
  };
  session = { getPage: () => page, getFrame: () => null, getActiveFrameOrPage: () => page };
  bm = new BrowserManager();
  spyOn(bm, 'getActiveSession').mockReturnValue(session);
});

afterEach(() => {
  homeMock.mockRestore();
  const now = Date.now;
  Date.now = () => now() + 300_000 + 3_600_000 + 1;
  try { hasActivePicker(); } finally { Date.now = now; }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('cookie picker mutation origin policy', () => {
  for (const action of ['import', 'remove']) {
    for (const origin of [undefined, 'null', 'http://127.0.0.1:9988', 'http://localhost:9470', 'https://attacker.test']) {
      test(`${action} rejects session mutation from ${origin ?? 'missing origin'} before touching the target`, async () => {
        installProfile();
        const code = generatePickerCode({ target: { page, url: currentUrl } });
        const exchanged = await route('GET', `?code=${code}`);
        const cookie = exchanged.headers.get('set-cookie')!;
        const url = new URL(`http://127.0.0.1:9470/cookie-picker/${action}`);
        const response = await handleCookiePickerRoute(url, new Request(url, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-site', ...(origin === undefined ? {} : { Origin: origin }) },
          body: JSON.stringify({ browser: 'Chromium', profile: 'Default', domains: ['example.test'], clearStorage: true }),
        }), bm, 'fixture');
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('invalid_origin');
        expect(context.addCookies).not.toHaveBeenCalled();
        expect(context.clearCookies).not.toHaveBeenCalled();
        expect(cdp.send).not.toHaveBeenCalled();
      });
    }

    test(`${action} accepts the real picker origin and preserves bearer authorization without browser headers`, async () => {
      installProfile();
      const code = generatePickerCode({ target: { page, url: currentUrl } });
      const exchanged = await route('GET', `?code=${code}`);
      const cookie = exchanged.headers.get('set-cookie')!;
      const body = { browser: 'Chromium', profile: 'Default', domains: ['example.test'], clearStorage: true };
      expect((await route('POST', `/${action}`, body, cookie)).status).toBe(200);
      expect((await route('POST', `/${action}`, body)).status).toBe(200);
      if (action === 'import') {
        expect(context.addCookies).toHaveBeenCalledTimes(2);
        expect(cdp.send.mock.calls.filter(([method]: [string]) => method === 'Runtime.callFunctionOn')).toHaveLength(2);
      } else {
        expect(context.clearCookies).toHaveBeenCalledTimes(2);
      }
    });
  }
});

describe('cookie import argument and selection policy', () => {
  test('parses flag values independently from the browser position', () => {
    expect(parseCookieImportArgs(['--domain', '.EXAMPLE.TEST', 'chromium', '--profile', 'Profile 2'])).toEqual({ browser: 'chromium', domains: ['example.test'], profile: 'Profile 2' });
    expect(parseCookieImportArgs(['--domain', 'example.test'])).toEqual({ browser: 'comet', domains: ['example.test'] });
  });

  test('rejects missing duplicate unknown and incompatible options', () => {
    for (const args of [['--domain'], ['--profile', '--all'], ['--unknown'], ['chrome', 'edge'], ['--all', '--domain', 'example.test'], ['--all', '--clear-storage'], ['--all', '--all']]) {
      expect(() => parseCookieImportArgs(args)).toThrow();
    }
  });

  test('recommends a unique domain match without overriding explicit profiles', async () => {
    installProfile();
    installProfile('Profile 2', '.other.test');
    expect((await getCookieProfiles('chromium', ['example.test'])).recommendedProfile).toBe('Default');
    const result = await runCookieImport({ browser: 'chromium', profile: 'Profile 2', domains: ['other.test'] }, { page, url: currentUrl }, () => {});
    expect(result.profile).toBe('Profile 2');
  });

  test('does not guess among matching or unreadable profiles', async () => {
    installProfile();
    installProfile('Profile 2');
    expect((await getCookieProfiles('chromium', ['example.test'])).recommendedProfile).toBeUndefined();
    await expect(runCookieImport({ browser: 'chromium', domains: ['example.test'] }, { page, url: currentUrl }, () => {})).rejects.toMatchObject({ code: 'profile_required' });
    fs.writeFileSync(path.join(home, '.config/chromium/Profile 2/Cookies'), 'not a database');
    const profiles = await getCookieProfiles('chromium', ['example.test']);
    expect(profiles.recommendedProfile).toBeUndefined();
    expect(profiles.profiles.find(profile => profile.name === 'Profile 2')?.unavailable).toBe(true);
  });
});

describe('registered import callers', () => {
  test('picker applies cookies and activates the actual downstream JS-origin guard', async () => {
    installProfile();
    const response = await route('POST', '/import', { browser: 'chromium', profile: 'Default', domains: ['example.test'] });
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.imported).toBe(1);
    expect(receipt.verification.reason).toBe('not_requested');
    expect(bm.getCookieImportedDomains().has('.example.test')).toBe(true);
    expect(context.addCookies).toHaveBeenCalledTimes(1);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
    currentUrl = 'https://unrelated.test/';
    await expect(handleReadCommand('js', ['document.cookie'], session, bm)).rejects.toThrow('JS execution blocked');
  });

  test('direct command imports both domain spellings and preserves the domain guard', async () => {
    installProfile();
    const result = await handleWriteCommand('cookie-import-browser', ['--domain', 'example.test', 'chromium'], session, bm);
    expect(result).toContain('Imported 1 cookies');
    expect(result).toContain('Authentication: not_requested');
    expect(bm.hasCookieImports()).toBe(true);
    await expect(handleWriteCommand('cookie-import-browser', ['chromium', '--domain', 'other.test'], session, bm)).rejects.toMatchObject({ code: 'target_mismatch' });
  });

  test('returns partial and zero receipts without exposing cookie values', async () => {
    installProfile('Default', '.example.test', true);
    const response = await route('POST', '/import', { browser: 'chromium', profile: 'Default', domains: ['example.test'] });
    const text = await response.text();
    const receipt = JSON.parse(text);
    expect(receipt.outcome).toBe('partial');
    expect(receipt.imported).toBe(1);
    expect(receipt.failed).toBe(1);
    expect(text).not.toContain('synthetic-session');
    const empty = await route('POST', '/import', { browser: 'chromium', profile: 'Default', domains: ['missing.test'] });
    expect(await empty.json()).toMatchObject({ imported: 0, outcome: 'empty' });
  });

  test('native fallback cannot erase unresolved source-cookie failures', async () => {
    installProfile();
    const db = new Database(path.join(home, '.config/chromium/Default/Cookies'));
    db.run("UPDATE cookies SET value = '', encrypted_value = ?", [Buffer.from('v20synthetic')]);
    db.close();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const native = spyOn(importer, 'importCookiesViaCdp').mockResolvedValue({ cookies: [], count: 0, failed: 0, domainCounts: {} });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = await runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'] }, { page, url: currentUrl }, () => {});
      expect(native).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ imported: 0, failed: 1, outcome: 'failed', failureReasons: { native_unrecovered: 1 } });
      expect(context.addCookies).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      native.mockRestore();
    }
  });

  test('all-domain mode requires explicit consent and never resets storage', async () => {
    installProfile();
    const result = await handleWriteCommand('cookie-import-browser', ['chromium', '--profile', 'Default', '--all'], session, bm);
    expect(result).toContain('Used --all');
    expect(page.evaluate).not.toHaveBeenCalled();
    await expect(handleWriteCommand('cookie-import-browser', ['chromium', '--all', '--clear-storage'], session, bm)).rejects.toMatchObject({ code: 'bad_request' });
  });

  test('preflights requested verification before importing or resetting', async () => {
    installProfile();
    await expect(runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'], verifyAuth: true, clearStorage: true }, { page, url: currentUrl }, () => {})).rejects.toMatchObject({ code: 'verification_not_configured' });
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test('rejects unsupported reset before reading profiles or applying cookies', async () => {
    context.browser = () => ({ browserType: () => ({ name: () => 'firefox' }) });
    await expect(runCookieImport({ browser: 'chromium', domains: ['example.test'], clearStorage: true }, { page, url: currentUrl }, () => {})).rejects.toMatchObject({ code: 'storage_reset_unsupported' });
    expect(context.addCookies).not.toHaveBeenCalled();
    expect(context.newCDPSession).not.toHaveBeenCalled();
  });

  test('ordinary imports on other target engines remain available', async () => {
    installProfile();
    context.browser = () => ({ browserType: () => ({ name: () => 'webkit' }) });
    const result = await runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'] }, { page, url: currentUrl }, () => {});
    expect(result.imported).toBe(1);
    expect(context.newCDPSession).not.toHaveBeenCalled();
  });

  test('zero import never resets or reports verified', async () => {
    installProfile();
    currentUrl = 'https://empty.example.test/';
    const result = await runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['empty.example.test'], verifyAuth: true }, { page, url: currentUrl }, () => {}, { identitySelector: '.identity', expectedIdentity: 'Synthetic' });
    expect(result.imported).toBe(0);
    expect(result.verification.verified).toBe(false);
    expect(page.reload).not.toHaveBeenCalled();
  });

  test('explicit reset precedes application and reports later application failure', async () => {
    installProfile();
    context.addCookies.mockImplementation(async () => { throw new Error('synthetic-sensitive-error'); });
    const result = await runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'], clearStorage: true }, { page, url: currentUrl }, domains => bm.trackCookieImportDomains(domains));
    expect(cdp.send.mock.calls.filter(([method]: [string]) => method === 'Runtime.callFunctionOn')).toHaveLength(1);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reset: 'cleared', imported: 0, outcome: 'failed' });
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-error');
    expect(bm.hasCookieImports()).toBe(true);
  });

  test('rejects a target switch during the import before a reset', async () => {
    installProfile();
    const pending = runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'], clearStorage: true }, { page, url: currentUrl }, () => {});
    currentUrl = 'https://other.test/';
    await expect(pending).rejects.toMatchObject({ code: 'target_changed' });
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(context.addCookies).not.toHaveBeenCalled();
  });

  test('serializes context mutations instead of replaying duplicate imports', async () => {
    installProfile();
    const blocked = Promise.withResolvers<void>();
    context.addCookies.mockImplementation(() => blocked.promise);
    const first = runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'] }, { page, url: currentUrl }, () => {});
    await expect(runCookieImport({ browser: 'chromium', profile: 'Default', domains: ['example.test'] }, { page, url: currentUrl }, () => {})).rejects.toMatchObject({ code: 'import_busy' });
    blocked.resolve();
    expect((await first).imported).toBe(1);
    expect(context.addCookies).toHaveBeenCalledTimes(1);
  });

  test('picker session retains its captured destination instead of the newly active page', async () => {
    installProfile();
    const code = generatePickerCode({ target: { page, url: currentUrl } });
    const exchange = await route('GET', '?code=' + code);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0];
    const otherAdd = mock(async () => {});
    spyOn(bm, 'getActiveSession').mockReturnValue({ getPage: () => ({ context: () => ({ addCookies: otherAdd }), url: () => 'https://other.test/' }) } as any);
    const response = await route('POST', '/import', { browser: 'chromium', profile: 'Default', domains: ['example.test'] }, cookie);
    expect((await response.json()).imported).toBe(1);
    expect(context.addCookies).toHaveBeenCalledTimes(1);
    expect(otherAdd).not.toHaveBeenCalled();
  });

  test('one-time picker codes last five minutes and fail at the expiry boundary', async () => {
    const now = Date.now;
    const start = now();
    const code = generatePickerCode();
    Date.now = () => start + 299_999;
    try { expect((await route('GET', '?code=' + code)).status).toBe(302); } finally { Date.now = now; }
    const expired = generatePickerCode();
    Date.now = () => now() + 300_000;
    try { expect((await route('GET', '?code=' + expired)).status).toBe(403); } finally { Date.now = now; }
  });
});
