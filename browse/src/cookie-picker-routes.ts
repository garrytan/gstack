/**
 * Cookie picker route handler — HTTP + Playwright glue
 *
 * Handles all /cookie-picker/* routes. Imports from cookie-import-browser.ts
 * (decryption) and cookie-picker-ui.ts (HTML generation).
 *
 * Routes (no auth — localhost-only, accepted risk):
 *   GET  /cookie-picker              → serves the picker HTML page
 *   GET  /cookie-picker/browsers     → list installed browsers
 *   GET  /cookie-picker/domains      → list domains + counts for a browser
 *   POST /cookie-picker/import       → decrypt + import cookies to Playwright
 *   POST /cookie-picker/remove       → clear cookies for domains
 *   GET  /cookie-picker/imported     → currently imported domains + counts
 */

import type { BrowserManager } from './browser-manager';
import { findInstalledBrowsers, listDomains, importCookies, CookieImportError, type PlaywrightCookie } from './cookie-import-browser';
import { getCookiePickerHTML } from './cookie-picker-ui';

// ─── State ──────────────────────────────────────────────────────
// Tracks which domains were imported via the picker.
// /imported only returns cookies for domains in this Set.
// /remove clears from this Set.
const importedDomains = new Set<string>();
const importedCounts = new Map<string, number>();

// ─── JSON Helpers ───────────────────────────────────────────────

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': `http://127.0.0.1:${parseInt(url.port, 10) || 9400}`,
    },
  });
}

function errorResponse(message: string, code: string, status = 400, action?: string): Response {
  return jsonResponse({ error: message, code, ...(action ? { action } : {}) }, status);
}

// ─── Route Handler ──────────────────────────────────────────────

export async function handleCookiePickerRoute(
  url: URL,
  req: Request,
  bm: BrowserManager,
): Promise<Response> {
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': `http://127.0.0.1:${parseInt(url.port, 10) || 9400}`,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    // GET /cookie-picker — serve the picker UI
    if (pathname === '/cookie-picker' && req.method === 'GET') {
      const port = parseInt(url.port, 10) || 9400;
      const html = getCookiePickerHTML(port);
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // GET /cookie-picker/browsers — list installed browsers
    if (pathname === '/cookie-picker/browsers' && req.method === 'GET') {
      const browsers = findInstalledBrowsers();
      return jsonResponse({
        browsers: browsers.map(b => ({
          name: b.name,
          aliases: b.aliases,
        })),
      });
    }

    // GET /cookie-picker/domains?browser=<name> — list domains + counts
    if (pathname === '/cookie-picker/domains' && req.method === 'GET') {
      const browserName = url.searchParams.get('browser');
      if (!browserName) {
        return errorResponse("Missing 'browser' parameter", 'missing_param');
      }
      const result = listDomains(browserName);
      return jsonResponse({
        browser: result.browser,
        domains: result.domains,
      });
    }

    // POST /cookie-picker/import — decrypt + import to Playwright session
    if (pathname === '/cookie-picker/import' && req.method === 'POST') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return errorResponse('Invalid JSON body', 'bad_request');
      }

      const { browser, domains } = body;
      if (!browser) return errorResponse("Missing 'browser' field", 'missing_param');
      if (!domains || !Array.isArray(domains) || domains.length === 0) {
        return errorResponse("Missing or empty 'domains' array", 'missing_param');
      }

      // Decrypt cookies from the browser DB
      const result = await importCookies(browser, domains);

      if (result.cookies.length === 0) {
        return jsonResponse({
          imported: 0,
          failed: result.failed,
          domainCounts: {},
          message: result.failed > 0
            ? `All ${result.failed} cookies failed to decrypt`
            : 'No cookies found for the specified domains',
        });
      }

      // Add to Playwright context
      const page = bm.getPage();
      await page.context().addCookies(result.cookies);

      // Track what was imported
      for (const domain of Object.keys(result.domainCounts)) {
        importedDomains.add(domain);
        importedCounts.set(domain, (importedCounts.get(domain) || 0) + result.domainCounts[domain]);
      }

      console.log(`[cookie-picker] Imported ${result.count} cookies for ${Object.keys(result.domainCounts).length} domains`);

      return jsonResponse({
        imported: result.count,
        failed: result.failed,
        domainCounts: result.domainCounts,
      });
    }

    // POST /cookie-picker/remove — clear cookies for domains
    if (pathname === '/cookie-picker/remove' && req.method === 'POST') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return errorResponse('Invalid JSON body', 'bad_request');
      }

      const { domains } = body;
      if (!domains || !Array.isArray(domains) || domains.length === 0) {
        return errorResponse("Missing or empty 'domains' array", 'missing_param');
      }

      const page = bm.getPage();
      const context = page.context();
      for (const domain of domains) {
        await context.clearCookies({ domain });
        importedDomains.delete(domain);
        importedCounts.delete(domain);
      }

      console.log(`[cookie-picker] Removed cookies for ${domains.length} domains`);

      return jsonResponse({
        removed: domains.length,
        domains,
      });
    }

    // GET /cookie-picker/imported — currently imported domains + counts
    if (pathname === '/cookie-picker/imported' && req.method === 'GET') {
      const entries: Array<{ domain: string; count: number }> = [];
      for (const domain of importedDomains) {
        entries.push({ domain, count: importedCounts.get(domain) || 0 });
      }
      entries.sort((a, b) => b.count - a.count);

      return jsonResponse({
        domains: entries,
        totalDomains: entries.length,
        totalCookies: entries.reduce((sum, e) => sum + e.count, 0),
      });
    }

    return new Response('Not found', { status: 404 });
  } catch (err: any) {
    if (err instanceof CookieImportError) {
      return errorResponse(err.message, err.code, 400, err.action);
    }
    console.error(`[cookie-picker] Error: ${err.message}`);
    return errorResponse(err.message || 'Internal error', 'internal_error', 500);
  }
}
