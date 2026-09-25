import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { chromium, errors, type Browser, type BrowserContext, type Page } from 'playwright';
import { CookieImportError } from '../src/cookie-import-browser';
import { clearCookieTargetStorage, validateCookieAuthOptions, validateCookieStorageSupport, verifyCookieAuthentication } from '../src/cookie-auth-verification';

const identity = 'Synthetic Account 472';
const options = { identitySelector: '.identity', expectedIdentity: identity, timeoutMs: 400 };
const unitOrigin = 'https://fixture.test';
const credentialUrl = new URL(unitOrigin);
credentialUrl.username = 'fixture-user';
credentialUrl.password = 'fixture';
credentialUrl.searchParams.set('token', 'synthetic-token');

function mockPage() {
  const evaluateAll = mock(async () => 'verified');
  const request = { url: () => `${unitOrigin}/protected`, redirectedFrom: () => null };
  const events = new EventEmitter();
  const frame = {};
  const storage = { engine: 'chromium', now: 100, deadline: 0, origin: unitOrigin, url: request.url(),
    localClear: mock(() => {}), sessionClear: mock(() => {}), nativeNow: mock(() => storage.now) };
  const cdpEvents = new EventEmitter();
  const cdp = {
    on: cdpEvents.on.bind(cdpEvents),
    off: cdpEvents.off.bind(cdpEvents),
    detach: mock(async () => {}),
    send: mock(async (method: string, params?: any): Promise<any> => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'fixture-frame' } } };
      if (method === 'Page.createIsolatedWorld') {
        cdpEvents.emit('Runtime.executionContextCreated', { context: { name: params.worldName, id: 7,
          uniqueId: 'fixture-unique-world', auxData: { frameId: 'fixture-frame', isDefault: false } } });
        return { executionContextId: 7 };
      }
      if (method === 'Runtime.evaluate') return { result: { value: storage.nativeNow() } };
      if (method === 'Runtime.callFunctionOn') {
        const arg = params.arguments[0].value;
        storage.deadline = arg.deadline;
        const value = runInNewContext(`(${params.functionDeclaration})(arg)`, { arg,
          performance: { now: storage.nativeNow }, Date: { now: () => 0 },
          location: { origin: storage.origin, href: storage.url },
          localStorage: { clear: storage.localClear }, sessionStorage: { clear: storage.sessionClear },
        });
        return { result: { value } };
      }
      return {};
    }),
  };
  const context = {
    browser: () => ({ browserType: () => ({ name: () => storage.engine }) }),
    newCDPSession: mock(async () => cdp),
  };
  const page = {
    isClosed: mock(() => false),
    url: mock(() => `${unitOrigin}/protected`),
    reload: mock(async () => ({ status: () => 200, url: request.url, request: () => request })),
    locator: mock(() => ({ filter: () => ({ evaluateAll }) })),
    evaluate: mock(async () => 'cleared'),
    context: () => context,
    mainFrame: () => frame,
    on: events.on.bind(events),
    off: events.off.bind(events),
  };
  return { page: page as unknown as Page, calls: page, evaluateAll, storage, cdp, context, events, frame, cdpEvents };
}

describe('cookie auth configuration and bounded operations', () => {
  for (const [index, invalid] of [undefined, {}, { identitySelector: '.identity' }, { expectedIdentity: identity },
    { identitySelector: ' ', expectedIdentity: identity }, { identitySelector: '.identity', expectedIdentity: '\n\t' },
    { identitySelector: 7, expectedIdentity: identity }, { identitySelector: '.identity', expectedIdentity: [] }].entries()) {
    test(`rejects incomplete configuration case ${index + 1}`, () => {
      try {
        validateCookieAuthOptions(invalid as any);
        throw new Error('Expected configuration rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(CookieImportError);
        expect((error as CookieImportError).code).toBe('verification_not_configured');
        expect(String(error)).not.toContain(identity);
      }
    });
  }

  for (const timeoutMs of [0, -1, NaN, Infinity, '200']) {
    test(`rejects invalid timeout ${String(timeoutMs)}`, async () => {
      const { page, calls } = mockPage();
      expect(() => validateCookieAuthOptions({ ...options, timeoutMs } as any)).toThrow(CookieImportError);
      expect(await verifyCookieAuthentication(page, { ...options, timeoutMs } as any, unitOrigin))
        .toEqual({ verified: false, reason: 'invalid_configuration' });
      expect(calls.reload).not.toHaveBeenCalled();
    });
  }

  test('requires explicit configuration without reloading or touching storage', async () => {
    const { page, calls } = mockPage();
    expect(await verifyCookieAuthentication(page, {}, unitOrigin)).toEqual({ verified: false, reason: 'not_configured' });
    expect(calls.reload).not.toHaveBeenCalled();
    expect(calls.evaluate).not.toHaveBeenCalled();
    expect(calls.locator).not.toHaveBeenCalled();
  });

  test('caps an oversized requested timeout at fifteen seconds', async () => {
    const { page, calls } = mockPage();
    expect((await verifyCookieAuthentication(page, { ...options, timeoutMs: 60_000 }, unitOrigin)).verified).toBe(true);
    expect(calls.reload.mock.calls[0][0].timeout).toBeGreaterThan(0);
    expect(calls.reload.mock.calls[0][0].timeout).toBeLessThanOrEqual(15_000);
  });

  test('does not run assertions after a timed-out reload eventually resolves', async () => {
    const { page, calls, evaluateAll } = mockPage();
    let release!: (response: any) => void;
    calls.reload.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const result = await verifyCookieAuthentication(page, { ...options, timeoutMs: 30 }, unitOrigin);
    expect(result).toEqual({ verified: false, reason: 'timeout' });
    release({ status: () => 200 });
    await Promise.resolve();
    await Promise.resolve();
    expect(evaluateAll).not.toHaveBeenCalled();
    expect(calls.locator).not.toHaveBeenCalled();
  });

  for (const stage of ['reload', 'selector']) {
    test(`classifies Playwright's ${stage} timeout before the outer timer expires`, async () => {
      const { page, calls, evaluateAll } = mockPage();
      const fail = async () => { throw new errors.TimeoutError(`${credentialUrl.href} ${identity}`); };
      if (stage === 'reload') calls.reload.mockImplementation(fail);
      else evaluateAll.mockImplementation(fail);
      const clock = spyOn(performance, 'now').mockReturnValue(0);
      try {
        const result = await verifyCookieAuthentication(page, options, unitOrigin);
        expect(result).toEqual({ verified: false, reason: 'timeout', ...(stage === 'selector' ? { status: 200 } : {}) });
        expect(JSON.stringify(result)).not.toContain(identity);
        expect(JSON.stringify(result)).not.toContain(credentialUrl.href);
      } finally {
        clock.mockRestore();
      }
    });
  }

  test('does not classify generic error text or a copied name as a Playwright timeout', async () => {
    const { page, calls } = mockPage();
    calls.reload.mockImplementation(async () => { throw Object.assign(new Error('synthetic timeout exceeded'), { name: 'TimeoutError' }); });
    expect(await verifyCookieAuthentication(page, options, unitOrigin)).toEqual({ verified: false, reason: 'verification_failed' });
  });

  test('shares one deadline between reload and the identity assertion', async () => {
    const { page, calls, evaluateAll } = mockPage();
    const response = await calls.reload();
    let now = 0;
    let expire!: () => void;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, timeout: number) => {
      expect(timeout).toBe(100);
      expire = callback;
      return 1;
    }) as any);
    try {
      calls.reload.mockImplementation(async () => {
        now = 70;
        return response;
      });
      evaluateAll.mockImplementation(() => new Promise(() => {}));
      const result = verifyCookieAuthentication(page, { ...options, timeoutMs: 100 }, unitOrigin);
      await Promise.resolve();
      expect(evaluateAll).toHaveBeenCalledTimes(1);
      now = 100;
      expire();
      expect(await result).toEqual({ verified: false, reason: 'timeout', status: 200 });
      expect(timer).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
      clock.mockRestore();
    }
  });

  test('returns only safe reasons for secret-bearing reload and selector failures', async () => {
    for (const stage of ['reload', 'selector']) {
      const { page, calls, evaluateAll } = mockPage();
      const fail = async () => { throw new Error(`${credentialUrl.href} ${identity}`); };
      if (stage === 'reload') calls.reload.mockImplementation(fail);
      else evaluateAll.mockImplementation(fail);
      const result = await verifyCookieAuthentication(page, options, unitOrigin);
      expect(result.reason).toBe('verification_failed');
      expect(JSON.stringify(result)).not.toMatch(/synthetic-token|fixture|Synthetic Account/);
    }
  });

  test('requires a successful reload response even with a positive assertion', async () => {
    const { page, calls, evaluateAll } = mockPage();
    calls.reload.mockImplementation(async () => null as any);
    expect(await verifyCookieAuthentication(page, options, unitOrigin)).toEqual({ verified: false, reason: 'no_response' });
    expect(evaluateAll).not.toHaveBeenCalled();
  });

  test('rejects a closed or changed target before reload', async () => {
    for (const state of ['closed', 'changed']) {
      const { page, calls } = mockPage();
      if (state === 'closed') calls.isClosed.mockReturnValue(true);
      else calls.url.mockReturnValue('https://other.test/protected');
      expect((await verifyCookieAuthentication(page, options, unitOrigin)).reason).toBe(`target_${state}`);
      expect(calls.reload).not.toHaveBeenCalled();
    }
  });

  for (const expectedOrigin of ['about:blank', 'file:///tmp/fixture', 'data:text/html,fixture', 'invalid',
    'https://fixture.test/path', credentialUrl.href, 'https://fixture.test/?token=synthetic-token']) {
    test(`rejects a non-origin target ${expectedOrigin.split(':')[0]}`, async () => {
      const { page, calls } = mockPage();
      expect(await verifyCookieAuthentication(page, options, expectedOrigin)).toEqual({ verified: false, reason: 'invalid_target' });
      expect(await clearCookieTargetStorage(page, expectedOrigin).then(() => null, error => error)).toMatchObject({ code: 'invalid_target' });
      expect(calls.evaluate).not.toHaveBeenCalled();
      expect(calls.reload).not.toHaveBeenCalled();
    });
  }

  test('storage reset sanitizes even a typed exception with a secret-bearing message', async () => {
    const { page, cdp } = mockPage();
    cdp.send.mockImplementation(async () => {
      throw new CookieImportError(`synthetic-token ${identity}`, 'target_changed');
    });
    try {
      await clearCookieTargetStorage(page, unitOrigin);
      throw new Error('Expected reset failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieImportError);
      expect((error as CookieImportError).code).toBe('storage_reset_failed');
      expect(String(error)).not.toMatch(/synthetic-token|Synthetic Account/);
    }
  });

  test('a reset dispatched after its timeout does no destructive work', async () => {
    const { page, cdp, storage } = mockPage();
    let runLate!: () => void;
    let expire!: () => void;
    const dispatched = Promise.withResolvers<void>();
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      expire = callback;
      return 1;
    }) as any);
    const send = cdp.send.getMockImplementation()!;
    cdp.send.mockImplementation(async (method, params) => {
      if (method !== 'Runtime.callFunctionOn') return send(method, params);
      return new Promise(resolve => {
        runLate = () => {
          storage.now = params.arguments[0].value.deadline;
          resolve(send(method, params));
        };
        dispatched.resolve();
      });
    });
    try {
      const reset = clearCookieTargetStorage(page, unitOrigin);
      await dispatched.promise;
      expire();
      expect(await reset.then(() => null, error => error)).toMatchObject({ code: 'storage_reset_timeout' });
      runLate();
      await Promise.resolve();
      expect(storage.localClear).not.toHaveBeenCalled();
      expect(storage.sessionClear).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  test('does not clear session storage if the local-storage operation consumed the deadline', async () => {
    const { page, storage } = mockPage();
    storage.nativeNow.mockImplementation(() => storage.localClear.mock.calls.length ? storage.deadline : storage.now);
    expect(await clearCookieTargetStorage(page, unitOrigin).then(() => null, error => error)).toMatchObject({ code: 'storage_reset_timeout' });
    expect(storage.localClear).toHaveBeenCalledTimes(1);
    expect(storage.sessionClear).not.toHaveBeenCalled();
  });

  for (const engine of ['firefox', 'webkit']) {
    test(`rejects reset support before protocol work on ${engine} without disabling authentication checks`, async () => {
      const { page, storage, context, calls } = mockPage();
      storage.engine = engine;
      expect(() => validateCookieStorageSupport(page)).toThrow(CookieImportError);
      expect(await clearCookieTargetStorage(page, unitOrigin).then(() => null, error => error)).toMatchObject({ code: 'storage_reset_unsupported' });
      expect(context.newCDPSession).not.toHaveBeenCalled();
      expect(calls.evaluate).not.toHaveBeenCalled();
      expect((await verifyCookieAuthentication(page, options, unitOrigin)).verified).toBe(true);
    });
  }

  test('Chromium support preflight is side-effect free', () => {
    const { page, context, calls, cdp } = mockPage();
    validateCookieStorageSupport(page);
    expect(context.newCDPSession).not.toHaveBeenCalled();
    expect(cdp.send).not.toHaveBeenCalled();
    expect(calls.evaluate).not.toHaveBeenCalled();
    expect(calls.reload).not.toHaveBeenCalled();
  });

  for (const phase of ['attachment', 'Page.getFrameTree', 'Runtime.enable', 'Page.createIsolatedWorld', 'Runtime.evaluate']) {
    test(`does not dispatch destructive work when timeout wins during ${phase}`, async () => {
      const { page, cdp, context, storage } = mockPage();
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let expire!: () => void;
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
        expire = callback;
        return 1;
      }) as any);
      const send = cdp.send.getMockImplementation()!;
      if (phase === 'attachment') context.newCDPSession.mockImplementation(async () => {
        reached.resolve();
        await release.promise;
        return cdp;
      });
      else cdp.send.mockImplementation(async (method, params) => {
        if (method === phase) { reached.resolve(); await release.promise; }
        return send(method, params);
      });
      try {
        const reset = clearCookieTargetStorage(page, unitOrigin);
        await reached.promise;
        expire();
        expect(await reset.then(() => null, error => error)).toMatchObject({ code: 'storage_reset_timeout' });
        release.resolve();
        for (let tick = 0; tick < 10; tick++) await Promise.resolve();
        expect(cdp.send.mock.calls.some(([method]) => method === 'Runtime.callFunctionOn')).toBe(false);
        expect(storage.localClear).not.toHaveBeenCalled();
        expect(storage.sessionClear).not.toHaveBeenCalled();
        expect(cdp.detach).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        timer.mockRestore();
      }
    });
  }

  test('calibrates a conservative isolated deadline using host time after the clock response', async () => {
    const { page, cdp, storage } = mockPage();
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const send = cdp.send.getMockImplementation()!;
    cdp.send.mockImplementation(async (method, params) => {
      const result = await send(method, params);
      if (method === 'Runtime.evaluate') { now = 4_000; storage.now = 4_100; }
      return result;
    });
    try {
      await clearCookieTargetStorage(page, unitOrigin);
      const sample = cdp.send.mock.calls.find(([method]) => method === 'Runtime.evaluate')![1];
      const mutation = cdp.send.mock.calls.find(([method]) => method === 'Runtime.callFunctionOn')![1];
      expect(mutation.arguments[0].value.deadline).toBe(11_100);
      expect(sample.uniqueContextId).toBe('fixture-unique-world');
      expect(mutation.uniqueContextId).toBe(sample.uniqueContextId);
      expect(mutation.executionContextId).toBeUndefined();
      expect(storage.localClear).toHaveBeenCalledTimes(1);
      expect(storage.sessionClear).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  test('does not let pending CDP detach prolong the reported timeout', async () => {
    const { page, cdp, storage, events, cdpEvents } = mockPage();
    const detaching = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let expire!: () => void;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      expire = callback;
      return 1;
    }) as any);
    cdp.detach.mockImplementation(async () => { detaching.resolve(); await release.promise; });
    try {
      const reset = clearCookieTargetStorage(page, unitOrigin);
      await detaching.promise;
      expire();
      expect(await reset.then(() => null, error => error)).toMatchObject({ code: 'storage_reset_timeout' });
      expect(storage.localClear).toHaveBeenCalledTimes(1);
      expect(storage.sessionClear).toHaveBeenCalledTimes(1);
      expect(events.listenerCount('framenavigated')).toBe(0);
      expect(cdpEvents.listenerCount('Runtime.executionContextCreated')).toBe(0);
    } finally {
      release.resolve();
      timer.mockRestore();
    }
  });

  test('aborts same-URL target navigation before destructive dispatch', async () => {
    const { page, cdp, storage, events, frame } = mockPage();
    const reset = clearCookieTargetStorage(page, unitOrigin);
    events.emit('framenavigated', frame);
    expect(await reset.then(() => null, error => error)).toMatchObject({ code: 'target_changed' });
    expect(cdp.send.mock.calls.some(([method]) => method === 'Runtime.callFunctionOn')).toBe(false);
    expect(storage.localClear).not.toHaveBeenCalled();
    expect(storage.sessionClear).not.toHaveBeenCalled();
  });

  for (const event of ['framenavigated', 'close']) {
    test(`settles ${event} cancellation without waiting for a stalled CDP operation`, async () => {
      const { page, cdp, events, frame, storage } = mockPage();
      const reached = Promise.withResolvers<void>();
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (method, params) => {
        if (method === 'Runtime.callFunctionOn') { reached.resolve(); return new Promise(() => {}); }
        return send(method, params);
      });
      const reset = clearCookieTargetStorage(page, unitOrigin);
      await reached.promise;
      events.emit(event, frame);
      expect(await reset.then(() => null, error => error)).toMatchObject({ code: 'target_changed' });
      expect(storage.localClear).not.toHaveBeenCalled();
      expect(storage.sessionClear).not.toHaveBeenCalled();
      expect(cdp.detach).toHaveBeenCalledTimes(1);
    });
  }

  for (const changed of ['origin', 'url']) {
    test(`checks the captured ${changed} inside the isolated destructive operation`, async () => {
      const { page, cdp, storage } = mockPage();
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation(async (method, params) => {
        if (method === 'Runtime.callFunctionOn') storage[changed] = changed === 'origin' ? 'https://other.test' : `${unitOrigin}/other-path`;
        return send(method, params);
      });
      expect(await clearCookieTargetStorage(page, unitOrigin).then(() => null, error => error)).toMatchObject({ code: 'target_changed' });
      expect(storage.localClear).not.toHaveBeenCalled();
      expect(storage.sessionClear).not.toHaveBeenCalled();
    });
  }
});

describe('cookie authentication and storage with isolated Chromium profiles', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;
  let otherServer: ReturnType<typeof Bun.serve>;
  let origin: string;
  let otherOrigin: string;
  let releaseSlowResponse: (() => void) | undefined;

  beforeAll(async () => {
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    const positive = `<div class="identity">${identity}</div>`;
    otherServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (new URL(request.url).pathname === '/back') return Response.redirect(`${origin}/identity`, 302);
      return html(positive);
    } });
    otherOrigin = `http://127.0.0.1:${otherServer.port}`;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/slow') return new Promise<Response>(resolve => {
        releaseSlowResponse = () => resolve(html(positive));
      });
      if (url.pathname === '/protected') {
        if (!request.headers.get('cookie')?.includes('fixture_session=approved')) return Response.redirect(`${origin}/login`, 302);
        return html(positive);
      }
      if (url.pathname === '/public-login') return html('<form><input name="email"><button>Sign in</button></form>');
      if (url.pathname === '/wrong') return html(`<div class="identity">${identity} extra account</div>`);
      if (url.pathname === '/normalized') return html('<div class="identity">\n Synthetic   Account\n 472 </div>');
      if (url.pathname === '/hidden') return html(`<div class="identity" hidden>${identity}</div>`);
      if (url.pathname === '/duplicate') return html(positive + positive);
      if (url.pathname === '/one-visible') return html(positive + `<div class="identity" hidden>${identity}</div>`);
      if (url.pathname === '/hidden-child') return html(`<div class="identity">${identity}<span hidden>not visible</span></div>`);
      if (url.pathname === '/delayed') return html(`<script>setTimeout(() => document.body.innerHTML = ${JSON.stringify(positive)}, 100)</script>`);
      if (url.pathname === '/login' && url.searchParams.has('continue')) return Response.redirect(`${origin}/identity`, 302);
      if (url.pathname === '/login-hop') return Response.redirect(`${origin}/login?continue=1`, 302);
      if (url.pathname === '/redirect-cross') return Response.redirect(`${otherOrigin}/identity`, 302);
      if (url.pathname === '/roundtrip') return Response.redirect(`${otherOrigin}/back`, 302);
      if (url.pathname.startsWith('/status/')) return html(positive, Number(url.pathname.split('/')[2]));
      return html(positive);
    } });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await context?.close();
  });

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    otherServer?.stop(true);
  });

  test('verifies a reloaded protected page only with an exact visible identity and synthetic session', async () => {
    await context.addCookies([{ name: 'fixture_session', value: 'approved', url: origin }]);
    await page.goto(`${origin}/protected`);
    expect(await verifyCookieAuthentication(page, options, origin)).toEqual({ verified: true, reason: 'verified', status: 200 });
  });

  for (const path of ['/normalized', '/one-visible', '/hidden-child', '/delayed']) {
    test(`accepts one normalized visible identity at ${path}`, async () => {
      await page.goto(`${origin}${path}`);
      const result = await verifyCookieAuthentication(page, { ...options, expectedIdentity: ` \n${identity} `, timeoutMs: 1000 }, origin);
      expect(result).toEqual({ verified: true, reason: 'verified', status: 200 });
      expect(JSON.stringify(result)).not.toContain(identity);
    });
  }

  for (const [path, reason] of [
    ['/wrong', 'identity_mismatch'], ['/hidden', 'identity_missing'], ['/duplicate', 'identity_ambiguous'],
    ['/public-login', 'identity_missing'], ['/login', 'login_redirect'], ['/sign-in', 'login_redirect'],
    ['/account/LOGIN', 'login_redirect'], ['/login-hop', 'login_redirect'],
  ]) {
    test(`rejects ${path} with a safe ${reason} result`, async () => {
      await page.goto(`${origin}${path === '/login-hop' ? '/identity' : path}`);
      if (path === '/login-hop') await page.evaluate(() => history.replaceState({}, '', '/login-hop'));
      const result = await verifyCookieAuthentication(page, options, origin);
      expect(result.verified).toBe(false);
      expect(result.reason).toBe(reason);
      expect(JSON.stringify(result)).not.toMatch(/Synthetic Account|127\.0\.0\.1/);
    });
  }

  test('rejects an unauthenticated 200 login redirect even when login markup contains the expected identity', async () => {
    await context.addCookies([{ name: 'fixture_session', value: 'approved', url: origin }]);
    await page.goto(`${origin}/protected`);
    await context.clearCookies();
    expect((await verifyCookieAuthentication(page, options, origin)).reason).toBe('login_redirect');
  });

  for (const status of [401, 403, 500, 503]) {
    test(`rejects HTTP ${status} even with a positive identity`, async () => {
      await page.goto(`${origin}/status/${status}`);
      expect(await verifyCookieAuthentication(page, options, origin)).toEqual({ verified: false, reason: 'http_error', status });
    });
  }

  test('rejects a cross-origin redirect and a redirect that comes back to the original origin', async () => {
    for (const destination of ['/redirect-cross', '/roundtrip']) {
      await page.goto(`${origin}/identity`);
      await page.evaluate(path => history.replaceState({}, '', path), destination);
      expect((await verifyCookieAuthentication(page, options, origin)).reason).toBe('target_changed');
    }
  });

  test('rejects same-origin navigation during a delayed identity assertion', async () => {
    await page.goto(`${origin}/public-login`);
    const evaluateAll = page.locator.bind(page);
    const locator = spyOn(page, 'locator').mockImplementation((selector: string) => {
      const value = evaluateAll(selector);
      const filter = value.filter.bind(value);
      spyOn(value, 'filter').mockImplementation((filterOptions: any) => {
        const filtered = filter(filterOptions);
        const evaluate = filtered.evaluateAll.bind(filtered);
        spyOn(filtered, 'evaluateAll').mockImplementation(async (...args: any[]) => {
          await page.goto(`${origin}/identity`);
          return evaluate(...args as [any, any]);
        });
        return filtered;
      });
      return value;
    });
    try {
      expect((await verifyCookieAuthentication(page, options, origin)).reason).toBe('target_changed');
    } finally {
      locator.mockRestore();
    }
  });

  test('times out an actual Chromium reload without asserting a login', async () => {
    await page.goto(`${origin}/identity`);
    await page.evaluate(() => history.replaceState({}, '', '/slow'));
    try {
      expect(await verifyCookieAuthentication(page, { ...options, timeoutMs: 100 }, origin))
        .toEqual({ verified: false, reason: 'timeout' });
    } finally {
      releaseSlowResponse?.();
    }
  });

  test('sanitizes invalid selector errors and handles a closed target', async () => {
    await page.goto(`${origin}/identity`);
    const result = await verifyCookieAuthentication(page, { ...options, identitySelector: '[synthetic-token' }, origin);
    expect(result.reason).toBe('verification_failed');
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    await page.close();
    expect((await verifyCookieAuthentication(page, options, origin)).reason).toBe('target_closed');
    expect(await clearCookieTargetStorage(page, origin).then(() => null, error => error)).toMatchObject({ code: 'target_closed' });
  });

  test('preserves all storage during an explicit authentication check', async () => {
    await page.goto(`${origin}/identity`);
    await page.evaluate(() => {
      localStorage.setItem('local', 'original');
      sessionStorage.setItem('session', 'original');
    });
    expect((await verifyCookieAuthentication(page, options, origin)).verified).toBe(true);
    expect(await page.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')]))
      .toEqual(['original', 'original']);
  });

  test('clears only exact-origin local storage and target-tab session storage', async () => {
    const sibling = await context.newPage();
    const other = await context.newPage();
    const otherHost = await context.newPage();
    const independentProfile = await browser.newContext();
    try {
      const independent = await independentProfile.newPage();
      const pages = [page, sibling, other, otherHost, independent];
      await Promise.all(pages.map((tab, index) => tab.goto(index === 2 ? `${otherOrigin}/identity`
        : index === 3 ? `http://localhost:${server.port}/identity` : `${origin}/identity`)));
      for (const tab of pages) await tab.evaluate(() => {
        localStorage.setItem('local', 'original');
        sessionStorage.setItem('session', 'original');
      });
      await clearCookieTargetStorage(page, origin);
      const storage = await Promise.all(pages.map(tab => tab.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')])));
      expect(storage).toEqual([[null, null], [null, 'original'], ['original', 'original'], ['original', 'original'], ['original', 'original']]);
    } finally {
      await independentProfile.close();
    }
  });

  test('rejects a different scheme, host, or port without clearing storage', async () => {
    await page.goto(`${origin}/identity`);
    await page.evaluate(() => localStorage.setItem('local', 'original'));
    for (const expectedOrigin of [origin.replace('http:', 'https:'), otherOrigin, `http://localhost:${server.port}`]) {
      expect(await clearCookieTargetStorage(page, expectedOrigin).then(() => null, error => error)).toMatchObject({ code: 'target_changed' });
      expect(await page.evaluate(() => localStorage.getItem('local'))).toBe('original');
    }
  });

  test('checks target origin and URL inside the storage operation after dispatch races', async () => {
    for (const destination of [`${otherOrigin}/identity`, `${origin}/other-path`]) {
      const target = await context.newPage();
      await target.goto(`${origin}/identity`);
      const other = await context.newPage();
      await other.goto(destination);
      await other.evaluate(() => {
        localStorage.setItem('local', 'original');
        sessionStorage.setItem('session', 'original');
      });
      const connect = context.newCDPSession.bind(context);
      let navigation: Promise<void> | undefined;
      const raced = spyOn(context, 'newCDPSession').mockImplementation(async attachedTarget => {
        const session = await connect(attachedTarget);
        const send = session.send.bind(session);
        spyOn(session, 'send').mockImplementation(async (method: any, params: any) => {
          if (method === 'Runtime.callFunctionOn') {
            navigation = (async () => {
              await target.goto(destination);
              await target.evaluate(() => sessionStorage.setItem('session', 'original'));
            })();
            await navigation;
          }
          return send(method, params);
        });
        return session;
      });
      try {
        const error = await clearCookieTargetStorage(target, origin).then(() => null, error => error);
        expect(error).toMatchObject({ code: 'target_changed' });
        expect(navigation).toBeDefined();
        await navigation;
      } finally {
        raced.mockRestore();
      }
      expect(await target.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')])).toEqual(['original', 'original']);
      await target.close();
      await other.close();
    }
  });

  test('reports a partial reset safely when session storage clearing fails', async () => {
    await page.goto(`${origin}/identity`);
    await page.evaluate(() => {
      localStorage.setItem('local', 'original');
      sessionStorage.setItem('session', 'original');
      Object.defineProperty(sessionStorage, 'clear', { value() { throw new Error('synthetic-token'); } });
    });
    const connect = context.newCDPSession.bind(context);
    const failing = spyOn(context, 'newCDPSession').mockImplementation(async target => {
      const session = await connect(target);
      const send = session.send.bind(session);
      spyOn(session, 'send').mockImplementation(async (method: any, params: any) => {
        if (method === 'Runtime.callFunctionOn') await send('Runtime.evaluate', {
          uniqueContextId: params.uniqueContextId,
          expression: "Object.defineProperty(sessionStorage, 'clear', { value() { throw new Error('synthetic-token'); } })",
          returnByValue: true, silent: true,
        });
        return send(method, params);
      });
      return session;
    });
    try {
      await clearCookieTargetStorage(page, origin);
      throw new Error('Expected reset failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieImportError);
      expect((error as CookieImportError).code).toBe('storage_reset_failed');
      expect(String(error)).not.toContain('synthetic-token');
    } finally {
      failing.mockRestore();
    }
    expect(await page.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')])).toEqual([null, 'original']);
  });

  test('uses a native isolated clock despite main-world Date and performance tampering', async () => {
    await page.goto(`${origin}/identity`);
    await page.evaluate(() => {
      localStorage.setItem('local', 'original');
      sessionStorage.setItem('session', 'original');
      Date.now = () => 0;
      Object.defineProperty(performance, 'now', { value: () => 0 });
      Object.defineProperty(performance, 'timeOrigin', { value: 0 });
    });
    await clearCookieTargetStorage(page, origin);
    expect(await page.evaluate(() => [Date.now(), performance.now(), performance.timeOrigin])).toEqual([0, 0, 0]);
    expect(await page.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')])).toEqual([null, null]);
  });

  test('a real late isolated dispatch cannot clear storage after the host timeout even with forged page clocks', async () => {
    await page.goto(`${origin}/identity`);
    await page.evaluate(() => {
      localStorage.setItem('local', 'original');
      sessionStorage.setItem('session', 'original');
      Date.now = () => 0;
      Object.defineProperty(performance, 'now', { value: () => 0 });
      Object.defineProperty(performance, 'timeOrigin', { value: 0 });
    });
    const connect = context.newCDPSession.bind(context);
    const observer = await connect(page);
    await observer.send('Runtime.enable');
    const tree = await observer.send('Page.getFrameTree');
    await observer.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'gstack-cookie-storage-reset', grantUniveralAccess: false });
    const dispatched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<any>();
    let delayedParameters: any;
    const delaying = spyOn(context, 'newCDPSession').mockImplementation(async target => {
      const session = await connect(target);
      const send = session.send.bind(session);
      spyOn(session, 'send').mockImplementation(async (method: any, params: any) => {
        if (method === 'Runtime.callFunctionOn') {
          delayedParameters = params;
          dispatched.resolve();
          return release.promise;
        }
        return send(method, params);
      });
      return session;
    });
    try {
      const reset = clearCookieTargetStorage(page, origin);
      await dispatched.promise;
      expect(await reset.then(() => null, error => error)).toMatchObject({ code: 'storage_reset_timeout' });
      expect(await page.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')])).toEqual(['original', 'original']);
      const late = await observer.send('Runtime.callFunctionOn', delayedParameters);
      expect(late.result.value).toBe('storage_reset_timeout');
      expect(await page.evaluate(() => [Date.now(), performance.now(), performance.timeOrigin])).toEqual([0, 0, 0]);
      expect(await page.evaluate(() => [localStorage.getItem('local'), sessionStorage.getItem('session')])).toEqual(['original', 'original']);
      release.resolve(late);
    } finally {
      release.resolve({ result: { value: 'storage_reset_timeout' } });
      delaying.mockRestore();
      await observer.detach();
    }
  }, 25_000);
});
