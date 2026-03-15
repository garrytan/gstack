const chrome = require('chrome-cookies-secure');
const path = require('path');
const { chromium } = require('playwright');
const os = require('os');

/**
 * Gstack-Setup-Browser-Cookies for Gemini CLI
 * Refined with help from Codex to preserve all cookie metadata and fix path-scoping issues.
 */

const rawUrl = process.argv[2];

if (!rawUrl) {
  console.error("Usage: node setup-cookies.js <url>");
  process.exit(1);
}

let targetUrl = rawUrl;
if (!rawUrl.includes('://')) {
  targetUrl = 'https://' + rawUrl;
}
const targetOrigin = new URL(targetUrl).origin;
const isLocalhost = targetOrigin.includes('localhost') || targetOrigin.includes('127.0.0.1');

const userDataDir = path.join(os.homedir(), '.gstack', 'gemini-browser-data');

async function main() {
  process.stderr.write(`[gstack-setup-browser-cookies] Extracting Chrome cookies for ${targetOrigin}...\n`);

  if (isLocalhost) {
     process.stderr.write(`[gstack-setup-browser-cookies] Localhost detected. Initializing persistent session...\n`);
     const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
     await context.close();
     process.stderr.write(`[gstack-setup-browser-cookies] Session ready for ${targetOrigin}.\n`);
     process.exit(0);
  }

  // format: 'puppeteer' returns full cookie objects
  chrome.getCookies(targetOrigin, 'puppeteer', async function(err, cookies) {
    if (err) {
      process.stderr.write(`[gstack-setup-browser-cookies] Failed: ${err.message}\n`);
      process.exit(1);
    }

    if (!cookies || cookies.length === 0) {
      process.stderr.write(`[gstack-setup-browser-cookies] No cookies found for ${targetOrigin}.\n`);
      process.exit(0);
    }

    process.stderr.write(`[gstack-setup-browser-cookies] Found ${cookies.length} cookies. Importing into Playwright...\n`);

    const context = await chromium.launchPersistentContext(userDataDir, { headless: true });

    try {
      const safeCookies = cookies.map(c => {
        // Carry over all attributes to preserve persistence, security, and scope
        const cookie = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: c.sameSite || 'Lax'
        };

        // Playwright expects expires as a Unix timestamp in seconds
        if (typeof c.expires === 'number') {
            cookie.expires = c.expires > 9999999999 ? Math.floor(c.expires / 1000) : c.expires;
        } else if (c.expires) {
            const parsed = Math.floor(new Date(c.expires).getTime() / 1000);
            if (!isNaN(parsed)) cookie.expires = parsed;
        }

        return cookie;
      });

      await context.addCookies(safeCookies);
      process.stderr.write(`[gstack-setup-browser-cookies] Success: ${safeCookies.length} cookies imported.\n`);
    } catch (e) {
      process.stderr.write(`[gstack-setup-browser-cookies] Error: ${e.message}\n`);
      process.exitCode = 1;
    } finally {
      await context.close();
    }
  });
}

main();