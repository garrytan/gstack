/**
 * Tests for cookie-picker route handler
 *
 * Tests the HTTP glue layer directly with mock BrowserManager objects.
 * Verifies that all routes return valid JSON (not HTML) with correct CORS headers.
 */

import { describe, test, expect } from 'bun:test';
import { handleCookiePickerRoute } from '../src/cookie-picker-routes';

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

function makeReq(method: string, body?: any): Request {
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request('http://127.0.0.1:9470', opts);
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
      const req = new Request('http://127.0.0.1:9450', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:9450');
    });
  });

  describe('JSON responses (not HTML)', () => {
    test('GET /cookie-picker/browsers returns JSON', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/browsers');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('browsers');
      expect(Array.isArray(body.browsers)).toBe(true);
    });

    test('GET /cookie-picker/domains without browser param returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/domains');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm);

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
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body.code).toBe('bad_request');
    });

    test('POST /cookie-picker/import missing browser field returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/import');
      const req = makeReq('POST', { domains: ['.example.com'] });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('missing_param');
    });

    test('POST /cookie-picker/import missing domains returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/import');
      const req = makeReq('POST', { browser: 'Chrome' });

      const res = await handleCookiePickerRoute(url, req, bm);

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
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    test('POST /cookie-picker/remove missing domains returns JSON error', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/remove');
      const req = makeReq('POST', {});

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('missing_param');
    });

    test('GET /cookie-picker/imported returns JSON with domain list', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/imported');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      const body = await res.json();
      expect(body).toHaveProperty('domains');
      expect(body).toHaveProperty('totalDomains');
      expect(body).toHaveProperty('totalCookies');
    });
  });

  describe('routing', () => {
    test('GET /cookie-picker returns HTML', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
    });

    test('unknown path returns 404', async () => {
      const { bm } = mockBrowserManager();
      const url = makeUrl('/cookie-picker/nonexistent');
      const req = new Request('http://127.0.0.1:9470', { method: 'GET' });

      const res = await handleCookiePickerRoute(url, req, bm);

      expect(res.status).toBe(404);
    });
  });
});
