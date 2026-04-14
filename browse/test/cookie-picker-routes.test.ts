/**
 * Tests for cookie-picker route handler
 *
 * Tests the HTTP glue layer directly with mock BrowserManager objects.
 * Verifies auth (one-time code exchange, session cookies, Bearer tokens),
 * CORS headers, and JSON response formats.
 */

import { describe, test, expect } from 'bun:test';
import { handleCookiePickerRoute, generatePickerCode } from '../src/cookie-picker-routes';

// ─── Mock BrowserManager ──────────────────────────────────────

function mockBrowserManager() {
  const addedCookies: any[] = [];
  const clearedDomains: string[] = [];
  return {
    bm: {
      getPage: () => ({
        context: () => ({
          addCookies: (cookies: any[]) => { addedCookies.push(...cookies); },
          clearCookies: (opts: { domain: string }) => { clearedDomains.push(opts.domain); },
        }),
      }),
    } as any,
    addedCookies,
    clearedDomains,
  };
}

function makeUrl(path: string, port = 9470): URL {
  return new URL(`http://127.0.0.1:${port}${path}`);
}

function makeReq(method: string, body?: any, headers?: Record<string, string>): Request {
  const opts: RequestInit = { method, headers: { ...headers } };
  if (body) {
    opts.body = JSON.stringify(body);
    (opts.headers as any)['Content-Type'] = 'application/json';
  }
  return new Request('http://127.0.0.1:9470', opts);
}

/** Helper: exchange a one-time code and return the session cookie value. */
async function getSessionCookie(bm: any, authToken: string): Promise<string> {
  const code = generatePickerCode();
  const url = makeUrl(`/cookie-picker?code=${code}`);
  const req = new Request('http://127.0.0.1:9470', { method: 'GET' });
  const res = await handleCookiePickerRoute(url, req, bm, authToken);
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('Set-Cookie') || '';
  const match = setCookie.match(/gstack_picker=([^;]+)/);
  expect(match).not.toBeNull();
  return match![1];
}

// ─── Tests ──────────────────────────────────────────────────────

describe('cookie-picker-routes', () => {
  describe('CORS', () => {
    test('OPTIONS returns 204 with correct CORS headers', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/browsers');
      const req = new Request('http://127.0.0.1:9470', { method: 'OPTIONS' });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:9470');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    test('JSON responses include correct CORS origin with port', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/browsers', 9450);
      const req = new Request('http://127.0.0.1:9450', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-token' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:9450');
    });
  });

  describe('JSON responses (with auth)', () => {
    test('GET /cookie-picker/browsers returns JSON', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/browsers');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-token' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('browsers');
      expect(Array.isArray(body.browsers)).toBe(true);
    });

    test('GET /cookie-picker/domains without browser param returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/domains');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-token' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'missing_param');
    });

    test('POST /cookie-picker/import with invalid JSON returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/import');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'POST',
        body: 'not json',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body.code).toBe('bad_request');
    });

    test('POST /cookie-picker/import missing browser field returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/import');
      const req = makeReq('POST', { domains: ['.example.com'] }, { 'Authorization': 'Bearer test-token' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('missing_param');
    });

    test('POST /cookie-picker/import missing domains returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/import');
      const req = makeReq('POST', { browser: 'Chrome' }, { 'Authorization': 'Bearer test-token' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('missing_param');
    });

    test('POST /cookie-picker/remove with invalid JSON returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/remove');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'POST',
        body: '{bad',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    test('POST /cookie-picker/remove missing domains returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/remove');
      const req = makeReq('POST', {}, { 'Authorization': 'Bearer test-token' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('missing_param');
    });

    test('GET /cookie-picker/imported returns JSON with domain list', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/imported');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-token' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('domains');
      expect(body).toHaveProperty('totalDomains');
      expect(body).toHaveProperty('totalCookies');
    });
  });

  describe('routing', () => {
    test('unknown path returns 404 (with auth)', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/nonexistent');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-token' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(404);
    });
  });

  describe('one-time code exchange', () => {
    test('valid code returns 302 redirect with session cookie', async () => {
      const { bm } = mockBrowserManager();
      const code = generatePickerCode();
      const url = makeUrl(`/cookie-picker?code=${code}`);
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/cookie-picker');
      const setCookie = res.headers.get('Set-Cookie') || '';
      expect(setCookie).toContain('gstack_picker=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Path=/cookie-picker');
      expect(setCookie).toContain('Max-Age=3600');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    test('code cannot be reused', async () => {
      const { bm } = mockBrowserManager();
      const code = generatePickerCode();
      const url = makeUrl(`/cookie-picker?code=${code}`);

      // First use: success
      const req1 = new Request('http://127.0.0.1:9470', { method: 'GET' });
      const res1 = await handleCookiePickerRoute(url, req1, bm, 'test-token');
      expect(res1.status).toBe(302);

      // Second use: rejected
      const req2 = new Request('http://127.0.0.1:9470', { method: 'GET' });
      const res2 = await handleCookiePickerRoute(url, req2, bm, 'test-token');
      expect(res2.status).toBe(403);
    });

    test('invalid code returns 403', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker?code=not-a-valid-code');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(403);
    });

    test('GET /cookie-picker without code or session returns 403', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(403);
    });
  });

  describe('session cookie auth', () => {
    test('valid session cookie grants HTML access', async () => {
      const { bm } = mockBrowserManager();
      const session = await getSessionCookie(bm, 'test-token');

      const url = makeUrl('/cookie-picker');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Cookie': `gstack_picker=${session}` },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
    });

    test('HTML response does NOT contain auth token', async () => {
      const { bm } = mockBrowserManager();
      const authToken = 'super-secret-auth-token-12345';
      const session = await getSessionCookie(bm, authToken);

      const url = makeUrl('/cookie-picker');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Cookie': `gstack_picker=${session}` },
      });

      const res = await handleCookiePickerRoute(url, req, bm, authToken);
      const html = await res.text();

      expect(html).not.toContain(authToken);
      expect(html).not.toContain('AUTH_TOKEN');
    });

    test('data routes accept session cookie', async () => {
      const { bm } = mockBrowserManager();
      const session = await getSessionCookie(bm, 'test-token');

      const url = makeUrl('/cookie-picker/browsers');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Cookie': `gstack_picker=${session}` },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('browsers');
    });

    test('invalid session cookie returns 403 for HTML', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Cookie': 'gstack_picker=fake-session' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-token');

      expect(res.status).toBe(403);
    });
  });

  describe('auth gate security', () => {
    test('GET /cookie-picker/browsers returns 401 without auth', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/browsers');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-secret-token');

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    test('POST /cookie-picker/import returns 401 without auth', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/import');
      const req = makeReq('POST', { browser: 'Chrome', domains: ['.example.com'] });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-secret-token');

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    test('GET /cookie-picker/browsers works with valid Bearer auth', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/browsers');
      const req = new Request('http://127.0.0.1:9470', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-secret-token' },
      });

      const res = await handleCookiePickerRoute(url, req, bm, 'test-secret-token');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('browsers');
    });
  });
});
