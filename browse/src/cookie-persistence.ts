/**
 * Cookie persistence — auto-save/load cookies across browse sessions.
 *
 * Imported cookies are saved to ~/.gstack/saved-cookies.json after every
 * import/remove operation. On ephemeral context creation, saved cookies
 * are auto-loaded so the user doesn't have to re-run /setup-browser-cookies.
 *
 * File format: { version: 1, savedAt: ISO string, cookies: PlaywrightCookie[] }
 * Permissions: 0o600 (cookies contain session tokens)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext, Cookie } from 'playwright';

const PERSIST_DIR = path.join(process.env.HOME || '/tmp', '.gstack');
const PERSIST_PATH = path.join(PERSIST_DIR, 'saved-cookies.json');

// Cookies older than 30 days are considered stale and skipped on load.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface PersistedCookieFile {
  version: number;
  savedAt: string;
  cookies: Cookie[];
}

/**
 * Persist all cookies from the browser context to disk.
 * Call after any cookie import or removal.
 */
export async function persistCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    const data: PersistedCookieFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      cookies,
    };
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    // Atomic write: write to tmp then rename
    const tmpPath = PERSIST_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, PERSIST_PATH);
    console.log(`[browse] Persisted ${cookies.length} cookies to ${PERSIST_PATH}`);
  } catch (err: any) {
    console.warn(`[browse] Could not persist cookies: ${err.message}`);
  }
}

/**
 * Load persisted cookies and add them to the browser context.
 * Call after creating an ephemeral context.
 * Returns the number of cookies loaded, or 0 if none.
 */
export async function loadPersistedCookies(context: BrowserContext): Promise<number> {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return 0;

    const raw = fs.readFileSync(PERSIST_PATH, 'utf-8');
    const data: PersistedCookieFile = JSON.parse(raw);

    if (data.version !== 1 || !Array.isArray(data.cookies)) return 0;

    // Skip if the file is too old or has an invalid date
    if (data.savedAt) {
      const ageMs = Date.now() - new Date(data.savedAt).getTime();
      if (isNaN(ageMs) || ageMs > MAX_AGE_MS) {
        console.warn(`[browse] Saved cookies are stale or have an invalid date — skipping auto-load. Re-import to refresh.`);
        return 0;
      }
    }

    // Filter out expired cookies (expires === -1 means session cookie, keep those)
    const now = Date.now() / 1000;
    const valid = data.cookies.filter(c =>
      c.expires === -1 || c.expires > now
    );

    if (valid.length === 0) return 0;

    await context.addCookies(valid);
    console.log(`[browse] Auto-loaded ${valid.length} persisted cookies from previous session`);
    return valid.length;
  } catch (err: any) {
    console.warn(`[browse] Could not load persisted cookies: ${err.message}`);
    return 0;
  }
}
