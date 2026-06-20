/**
 * Network routing (`$B route`) tests.
 *
 * No real browser: the URL matcher is a pure function, and BrowserManager's
 * route methods are exercised against a fake BrowserContext/Route so the whole
 * suite runs on any platform (Playwright's Chromium can't drive under Bun on
 * Windows — see CLAUDE.md). We capture the catch-all dispatcher that
 * applyRoutes() installs, then invoke it with stub Route objects and assert it
 * aborts / fulfills / continues per the registered rules.
 */

import { describe, it, expect } from 'bun:test';
import { BrowserManager, matchesRoutePattern } from '../src/browser-manager';

describe('matchesRoutePattern', () => {
  it('matches a *.ext suffix glob', () => {
    expect(matchesRoutePattern('*.png', 'https://x.com/a/b/logo.png')).toBe(true);
    expect(matchesRoutePattern('*.png', 'https://x.com/a/b/logo.js')).toBe(false);
  });

  it('treats a leading ** the same as * (any prefix)', () => {
    expect(matchesRoutePattern('**/api/*', 'https://x.com/v1/api/me')).toBe(true);
    expect(matchesRoutePattern('*/api/*', 'https://x.com/api/me')).toBe(true);
  });

  it('matches a substring wildcard (tracker domains)', () => {
    expect(matchesRoutePattern('*doubleclick*', 'https://ad.doubleclick.net/x')).toBe(true);
    expect(matchesRoutePattern('*doubleclick*', 'https://example.com/x')).toBe(false);
  });

  it('? matches exactly one character', () => {
    expect(matchesRoutePattern('https://x.com/?', 'https://x.com/a')).toBe(true);
    expect(matchesRoutePattern('https://x.com/?', 'https://x.com/ab')).toBe(false);
  });

  it('matches an exact URL with no wildcards', () => {
    expect(matchesRoutePattern('https://x.com/api/me', 'https://x.com/api/me')).toBe(true);
    expect(matchesRoutePattern('https://x.com/api/me', 'https://x.com/api/you')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern (no injection)', () => {
    // The '.' and '+' are literal, not regex operators.
    expect(matchesRoutePattern('a.b+c', 'aXbXXXc')).toBe(false);
    expect(matchesRoutePattern('a.b+c', 'a.b+c')).toBe(true);
  });
});

// Minimal stand-ins for Playwright's BrowserContext + Route so we can drive the
// dispatcher without launching Chromium.
function fakeContext() {
  let dispatcher: ((route: any) => Promise<void>) | null = null;
  let unrouted = false;
  return {
    handle: () => dispatcher,
    wasUnrouted: () => unrouted,
    route: (_glob: string, h: (route: any) => Promise<void>) => { dispatcher = h; },
    unroute: async (_glob: string, _h: any) => { unrouted = true; },
  };
}

function fakeRoute(url: string) {
  const calls = { continue: 0, abort: 0, fulfill: [] as any[] };
  return {
    calls,
    request: () => ({ url: () => url }),
    continue: async () => { calls.continue++; },
    abort: async () => { calls.abort++; },
    fulfill: async (opts: any) => { calls.fulfill.push(opts); },
  };
}

describe('BrowserManager route rules', () => {
  it('stores rules and reports them via getRouteRules (as a copy)', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*.png', action: 'block' });
    const rules = bm.getRouteRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: '*.png', action: 'block' });
    // Mutating the returned copy must not affect internal state.
    rules[0].pattern = 'mutated';
    expect(bm.getRouteRules()[0].pattern).toBe('*.png');
  });

  it('applyRoutes is a no-op when there are no rules', async () => {
    const bm = new BrowserManager();
    const ctx = fakeContext();
    await bm.applyRoutes(ctx as any);
    expect(ctx.handle()).toBeNull();
  });

  it('dispatcher aborts blocked requests and continues others', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*.png', action: 'block' });
    const ctx = fakeContext();
    await bm.applyRoutes(ctx as any);
    const handler = ctx.handle()!;
    expect(handler).toBeTruthy();

    const png = fakeRoute('https://x.com/logo.png');
    await handler(png);
    expect(png.calls.abort).toBe(1);
    expect(png.calls.continue).toBe(0);

    const js = fakeRoute('https://x.com/app.js');
    await handler(js);
    expect(js.calls.continue).toBe(1);
    expect(js.calls.abort).toBe(0);
  });

  it('dispatcher fulfills stubbed requests with status/content-type/body', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*/api/me', action: 'stub', status: 418, contentType: 'text/plain', body: 'tea' });
    const ctx = fakeContext();
    await bm.applyRoutes(ctx as any);
    const handler = ctx.handle()!;

    const api = fakeRoute('https://x.com/api/me');
    await handler(api);
    expect(api.calls.fulfill).toHaveLength(1);
    expect(api.calls.fulfill[0]).toEqual({ status: 418, contentType: 'text/plain', body: 'tea' });
  });

  it('stub defaults to 200 / application/json / empty body', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*/api/*', action: 'stub' });
    const ctx = fakeContext();
    await bm.applyRoutes(ctx as any);
    const handler = ctx.handle()!;

    const api = fakeRoute('https://x.com/api/anything');
    await handler(api);
    expect(api.calls.fulfill[0]).toEqual({ status: 200, contentType: 'application/json', body: '' });
  });

  it('first matching rule wins (insertion order)', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*/api/*', action: 'stub', body: 'first' });
    await bm.addRouteRule({ pattern: '*', action: 'block' });
    const ctx = fakeContext();
    await bm.applyRoutes(ctx as any);
    const handler = ctx.handle()!;

    const api = fakeRoute('https://x.com/api/me');
    await handler(api);
    expect(api.calls.fulfill[0].body).toBe('first');
    expect(api.calls.abort).toBe(0);
  });

  it('clearRoutes with a pattern removes only matching rules', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*.png', action: 'block' });
    await bm.addRouteRule({ pattern: '*.css', action: 'block' });
    const removed = await bm.clearRoutes('*.png');
    expect(removed).toBe(1);
    expect(bm.getRouteRules().map(r => r.pattern)).toEqual(['*.css']);
  });

  it('clearRoutes with no pattern removes everything and reports the count', async () => {
    const bm = new BrowserManager();
    await bm.addRouteRule({ pattern: '*.png', action: 'block' });
    await bm.addRouteRule({ pattern: '*.css', action: 'block' });
    const removed = await bm.clearRoutes();
    expect(removed).toBe(2);
    expect(bm.getRouteRules()).toHaveLength(0);
  });
});
