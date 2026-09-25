/**
 * Chromium browser cookie import — read and decrypt cookies from real browsers
 *
 * Supports macOS, Linux, and Windows Chromium-based browsers.
 * Pure logic module — no Playwright dependency, no HTTP concerns.
 *
 * Decryption pipeline:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ 1. Resolve the cookie DB from the browser profile dir           │
 *   │    - macOS: ~/Library/Application Support/<browser>/<profile>   │
 *   │    - Linux: ~/.config/<browser>/<profile>                       │
 *   │                                                                  │
 *   │ 2. Derive the AES key                                            │
 *   │    - macOS v10: Keychain password, PBKDF2(..., iter=1003)       │
 *   │    - Linux v10: "peanuts", PBKDF2(..., iter=1)                  │
 *   │    - Linux v11: libsecret/secret-tool password, iter=1          │
 *   │                                                                  │
 *   │ 3. For each cookie with encrypted_value starting with "v10"/     │
 *   │    "v11":                                                        │
 *   │    - Ciphertext = encrypted_value[3:]                           │
 *   │    - IV = 16 bytes of 0x20 (space character)                    │
 *   │    - Plaintext = AES-128-CBC-decrypt(key, iv, ciphertext)       │
 *   │    - Remove PKCS7 padding                                       │
 *   │    - Skip first 32 bytes of Chromium cookie metadata            │
 *   │    - Remaining bytes = cookie value (UTF-8)                     │
 *   │                                                                  │
 *   │ 4. If encrypted_value is empty but `value` field is set,        │
 *   │    use value directly (unencrypted cookie)                      │
 *   │                                                                  │
 *   │ 5. Chromium epoch: microseconds since 1601-01-01                │
 *   │    Unix seconds = (epoch - 11644473600000000) / 1000000         │
 *   │                                                                  │
 *   │ 6. sameSite: 0→"None", 1→"Lax", 2→"Strict", else→"Lax"        │
 *   └──────────────────────────────────────────────────────────────────┘
 */

import { openCookieDatabase } from './cookie-database';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isIP } from 'node:net';

// ─── Types ──────────────────────────────────────────────────────

export interface BrowserInfo {
  name: string;
  dataDir: string; // primary storage dir (retained for compatibility with existing callers/tests)
  keychainService: string;
  aliases: string[];
  linuxDataDir?: string;
  linuxApplication?: string;
  windowsDataDir?: string;
}

export interface ProfileEntry {
  name: string;         // e.g. "Default", "Profile 1", "Profile 3"
  displayName: string;  // human-friendly name from Preferences, or falls back to dir name
}

export interface DomainEntry {
  domain: string;
  count: number;
}

export interface ImportResult {
  cookies: PlaywrightCookie[];
  count: number;
  failed: number;
  domainCounts: Record<string, number>;
  failureReasons?: Record<string, number>;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export class CookieImportError extends Error {
  constructor(
    message: string,
    public code: string,
    public action?: 'retry',
  ) {
    super(message);
    this.name = 'CookieImportError';
  }
}

type BrowserPlatform = 'darwin' | 'linux' | 'win32';

interface BrowserMatch {
  browser: BrowserInfo;
  platform: BrowserPlatform;
  dbPath: string;
}

// ─── Browser Registry ───────────────────────────────────────────
// Hardcoded — NEVER interpolate user input into shell commands.

const BROWSER_REGISTRY: BrowserInfo[] = [
  { name: 'Comet',    dataDir: 'Comet/',                      keychainService: 'Comet Safe Storage',          aliases: ['comet', 'perplexity'] },
  { name: 'Chrome',   dataDir: 'Google/Chrome/',             keychainService: 'Chrome Safe Storage',         aliases: ['chrome', 'google-chrome', 'google-chrome-stable'], linuxDataDir: 'google-chrome/', linuxApplication: 'chrome', windowsDataDir: 'Google/Chrome/User Data/' },
  { name: 'Chromium', dataDir: 'chromium/',                  keychainService: 'Chromium Safe Storage',       aliases: ['chromium'], linuxDataDir: 'chromium/', linuxApplication: 'chromium', windowsDataDir: 'Chromium/User Data/' },
  { name: 'Arc',      dataDir: 'Arc/User Data/',             keychainService: 'Arc Safe Storage',            aliases: ['arc'] },
  { name: 'Dia',      dataDir: 'Dia/User Data/',             keychainService: 'Dia Safe Storage',            aliases: ['dia'] },
  { name: 'Brave',    dataDir: 'BraveSoftware/Brave-Browser/', keychainService: 'Brave Safe Storage',        aliases: ['brave'], linuxDataDir: 'BraveSoftware/Brave-Browser/', linuxApplication: 'brave', windowsDataDir: 'BraveSoftware/Brave-Browser/User Data/' },
  { name: 'Edge',     dataDir: 'Microsoft Edge/',            keychainService: 'Microsoft Edge Safe Storage', aliases: ['edge'], linuxDataDir: 'microsoft-edge/', linuxApplication: 'microsoft-edge', windowsDataDir: 'Microsoft/Edge/User Data/' },
];

// ─── Key Cache ──────────────────────────────────────────────────
// Cache derived AES keys per browser. First import per browser does
// Keychain + PBKDF2. Subsequent imports reuse the cached key.

const keyCache = new Map<string, Buffer>();

// ─── Public API ─────────────────────────────────────────────────

/**
 * Find which browsers are installed (have a cookie DB on disk in any profile).
 */
export function findInstalledBrowsers(): BrowserInfo[] {
  return BROWSER_REGISTRY.filter(browser => {
    // Check Default profile on any platform
    if (findBrowserMatch(browser, 'Default') !== null) return true;
    // Check numbered profiles (Profile 1, Profile 2, etc.)
    for (const platform of getSearchPlatforms()) {
      const dataDir = getDataDirForPlatform(browser, platform);
      if (!dataDir) continue;
      const browserDir = path.join(getBaseDir(platform), dataDir);
      try {
        const entries = fs.readdirSync(browserDir, { withFileTypes: true });
        if (entries.some(e => {
          if (!e.isDirectory() || !e.name.startsWith('Profile ')) return false;
          const profileDir = path.join(browserDir, e.name);
          return fs.existsSync(path.join(profileDir, 'Cookies'))
            || (platform === 'win32' && fs.existsSync(path.join(profileDir, 'Network', 'Cookies')));
        })) return true;
      } catch {}
    }
    return false;
  });
}

export function listSupportedBrowserNames(): string[] {
  const hostPlatform = getHostPlatform();
  return BROWSER_REGISTRY
    .filter(browser => hostPlatform ? getDataDirForPlatform(browser, hostPlatform) !== null : true)
    .map(browser => browser.name);
}

/**
 * List available profiles for a browser.
 */
export function listProfiles(browserName: string): ProfileEntry[] {
  const browser = resolveBrowser(browserName);
  const profiles: ProfileEntry[] = [];

  // Scan each supported platform for profile directories
  for (const platform of getSearchPlatforms()) {
    const dataDir = getDataDirForPlatform(browser, platform);
    if (!dataDir) continue;
    const browserDir = path.join(getBaseDir(platform), dataDir);
    if (!fs.existsSync(browserDir)) continue;

    let profileNames: Record<string, { name?: unknown }> = {};
    try {
      profileNames = JSON.parse(fs.readFileSync(path.join(browserDir, 'Local State'), 'utf-8'))?.profile?.info_cache ?? {};
    } catch {}

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(browserDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== 'Default' && !entry.name.startsWith('Profile ')) continue;
      // Chrome 80+ on Windows stores cookies under Network/Cookies
      const cookieCandidates = platform === 'win32'
        ? [path.join(browserDir, entry.name, 'Network', 'Cookies'), path.join(browserDir, entry.name, 'Cookies')]
        : [path.join(browserDir, entry.name, 'Cookies')];
      if (!cookieCandidates.some(p => fs.existsSync(p))) continue;

      // Avoid duplicates if the same profile appears on multiple platforms
      if (profiles.some(p => p.name === entry.name)) continue;

      // Try to read display name from Preferences.
      // Prefer account email — signed-in Chrome profiles often have generic
      // names like "Person 2" while the email is far more readable.
      let displayName = entry.name;
      try {
        const prefsPath = path.join(browserDir, entry.name, 'Preferences');
        if (fs.existsSync(prefsPath)) {
          const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
          const email = prefs?.account_info?.[0]?.email;
          if (email && typeof email === 'string') {
            displayName = email;
          } else {
            const profileName = prefs?.profile?.name;
            if (profileName && typeof profileName === 'string') {
              displayName = profileName;
            }
          }
        }
      } catch {
        // Ignore — fall back to directory name
      }

      const currentName = profileNames?.[entry.name]?.name;
      if (typeof currentName === 'string' && currentName.trim()) displayName = currentName.trim();

      profiles.push({ name: entry.name, displayName });
    }

    // Found profiles on this platform — no need to check others
    if (profiles.length > 0) break;
  }

  return profiles.sort((a, b) => a.name === b.name ? 0 : a.name === 'Default' ? -1 : b.name === 'Default' ? 1 : a.name.localeCompare(b.name, 'en', { numeric: true }));
}

export function normalizeCookieDomain(domain: string): string {
  if (typeof domain !== 'string' || !domain || domain.length > 254 || /[\s\/@?#\\*]/.test(domain)) {
    throw new CookieImportError('Invalid cookie domain', 'bad_request');
  }
  let host = domain.replace(/^\./, '').replace(/\.$/, '');
  if (isIP(host) === 6) host = '[' + host + ']';
  try {
    if (host.includes(':') && (!host.startsWith('[') || !host.endsWith(']') || isIP(host.slice(1, -1)) !== 6)) throw new Error();
    const url = new URL('http://' + host);
    if (!url.hostname || url.hostname.length > 253 || url.port || url.pathname !== '/' || url.hostname.split('.').some(label => !label)) throw new Error();
    return url.hostname;
  } catch {
    throw new CookieImportError('Invalid cookie domain', 'bad_request');
  }
}

export function cookieDomainMatches(hostname: string, cookieDomain: string): boolean {
  const host = normalizeCookieDomain(hostname);
  const domain = normalizeCookieDomain(cookieDomain);
  const address = isIP(domain.startsWith('[') ? domain.slice(1, -1) : domain);
  return host === domain || (!address && cookieDomain.startsWith('.') && host.endsWith('.' + domain));
}

export async function withCookieReadRetry<T>(operation: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      if (attempt < 2 && ['db_locked', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(err?.code)) {
        await new Promise(resolve => setTimeout(resolve, [150, 500][attempt]));
        continue;
      }
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(err?.code)) throw new CookieImportError('Cookie database is busy. Close the source browser and retry.', 'db_locked', 'retry');
      if (err?.code === 'SQLITE_CORRUPT') throw new CookieImportError('Cookie database is corrupt', 'db_corrupt');
      if (err?.code === 'SQLITE_READONLY') throw new CookieImportError('Cookie database access was denied', 'db_permission');
      if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_')) throw new CookieImportError('Cookie database could not be read', 'db_read_error');
      throw err;
    }
  }
}

/**
 * List unique cookie domains + counts from a browser's DB. No decryption.
 */
export function listDomains(browserName: string, profile = 'Default'): { domains: DomainEntry[]; browser: string } {
  const browser = resolveBrowser(browserName);
  const match = getBrowserMatch(browser, profile);
  const db = openDb(match.dbPath, browser.name);
  try {
    const now = chromiumNow();
    const rows = db.query(
      `SELECT host_key AS domain, COUNT(*) AS count
       FROM cookies
       WHERE has_expires = 0 OR expires_utc > ?
       GROUP BY host_key
       ORDER BY count DESC`
    ).all(now) as DomainEntry[];
    return { domains: rows, browser: browser.name };
  } finally {
    db.close();
  }
}

/**
 * Decrypt and return Playwright-compatible cookies for specific domains.
 */
export async function importCookies(
  browserName: string,
  domains: string[],
  profile = 'Default',
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };

  const selectedDomains = [...new Set(domains.flatMap(domain => {
    const normalized = normalizeCookieDomain(domain);
    return [normalized, '.' + normalized];
  }))];
  const browser = resolveBrowser(browserName);
  const match = getBrowserMatch(browser, profile);
  const db = openDb(match.dbPath, browser.name);

  try {
    const now = chromiumNow();
    // Parameterized query — no SQL injection
    const placeholders = selectedDomains.map(() => '?').join(',');
    const rows = db.query(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, has_expires, samesite
       FROM cookies
       WHERE host_key IN (${placeholders})
         AND (has_expires = 0 OR expires_utc > ?)
       ORDER BY host_key, name`
    ).all(...selectedDomains, now) as RawCookie[];

    const needsKey = rows.some(row => !row.value && row.encrypted_value.length > 0 && Buffer.from(row.encrypted_value).subarray(0, 3).toString() !== 'v20');
    const derivedKeys = needsKey ? await getDerivedKeys(match) : new Map<string, Buffer>();

    const cookies: PlaywrightCookie[] = [];
    let failed = 0;
    const domainCounts: Record<string, number> = Object.create(null);
    const failureReasons: Record<string, number> = {};

    for (const row of rows) {
      try {
        const value = decryptCookieValue(row, derivedKeys, match.platform);
        const cookie = toPlaywrightCookie(row, value);
        cookies.push(cookie);
        domainCounts[row.host_key] = (domainCounts[row.host_key] || 0) + 1;
      } catch (err) {
        failed++;
        const reason = err instanceof CookieImportError && err.code === 'v20_encryption' ? 'unsupported_encryption' : 'decryption_failed';
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      }
    }

    return { cookies, count: cookies.length, failed, domainCounts, failureReasons };
  } finally {
    db.close();
  }
}

// ─── Internal: Browser Resolution ───────────────────────────────

function resolveBrowser(nameOrAlias: string): BrowserInfo {
  const needle = nameOrAlias.toLowerCase().trim();
  const found = BROWSER_REGISTRY.find(b =>
    b.aliases.includes(needle) || b.name.toLowerCase() === needle
  );
  if (!found) {
    const supported = BROWSER_REGISTRY.flatMap(b => b.aliases).join(', ');
    throw new CookieImportError(
      `Unknown browser '${nameOrAlias}'. Supported: ${supported}`,
      'unknown_browser',
    );
  }
  return found;
}

function validateProfile(profile: string): void {
  if (/[/\\]|\.\./.test(profile) || /[\x00-\x1f]/.test(profile)) {
    throw new CookieImportError(
      `Invalid profile name: '${profile}'`,
      'bad_request',
    );
  }
}

function getHostPlatform(): BrowserPlatform | null {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p as BrowserPlatform;
  return null;
}

function getSearchPlatforms(): BrowserPlatform[] {
  const current = getHostPlatform();
  const order: BrowserPlatform[] = [];
  if (current) order.push(current);
  for (const platform of ['darwin', 'linux', 'win32'] as BrowserPlatform[]) {
    if (!order.includes(platform)) order.push(platform);
  }
  return order;
}

function getDataDirForPlatform(browser: BrowserInfo, platform: BrowserPlatform): string | null {
  if (platform === 'darwin') return browser.dataDir;
  if (platform === 'linux') return browser.linuxDataDir || null;
  return browser.windowsDataDir || null;
}

function getBaseDir(platform: BrowserPlatform): string {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local');
  return path.join(os.homedir(), '.config');
}

function findBrowserMatch(browser: BrowserInfo, profile: string): BrowserMatch | null {
  validateProfile(profile);
  for (const platform of getSearchPlatforms()) {
    const dataDir = getDataDirForPlatform(browser, platform);
    if (!dataDir) continue;
    const baseProfile = path.join(getBaseDir(platform), dataDir, profile);
    // Chrome 80+ on Windows stores cookies under Network/Cookies; fall back to Cookies
    const candidates = platform === 'win32'
      ? [path.join(baseProfile, 'Network', 'Cookies'), path.join(baseProfile, 'Cookies')]
      : [path.join(baseProfile, 'Cookies')];
    for (const dbPath of candidates) {
      try {
        if (fs.existsSync(dbPath)) {
          return { browser, platform, dbPath };
        }
      } catch {}
    }
  }
  return null;
}

function getBrowserMatch(browser: BrowserInfo, profile: string): BrowserMatch {
  const match = findBrowserMatch(browser, profile);
  if (match) return match;

  const attempted = getSearchPlatforms()
    .map(platform => {
      const dataDir = getDataDirForPlatform(browser, platform);
      return dataDir ? path.join(getBaseDir(platform), dataDir, profile, 'Cookies') : null;
    })
    .filter((entry): entry is string => entry !== null);

  throw new CookieImportError(
    `${browser.name} is not installed (no cookie database at ${attempted.join(' or ')})`,
    'not_installed',
  );
}

// ─── Internal: SQLite Access ────────────────────────────────────

function openDb(dbPath: string, browserName: string): ReturnType<typeof openCookieDatabase> {
  // On Windows, Chrome holds exclusive WAL locks even when we open readonly.
  // The readonly open may "succeed" but return empty results because the WAL
  // (where all actual data lives) can't be replayed. Always use the copy
  // approach on Windows so we can open read-write and process the WAL.
  if (process.platform === 'win32') {
    return openDbFromCopy(dbPath, browserName);
  }
  try {
    return openCookieDatabase(dbPath);
  } catch (err: any) {
    if (err?.code === 'sqlite_unavailable') throw new CookieImportError(err.message, 'sqlite_unavailable');
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(err?.code)) {
      return openDbFromCopy(dbPath, browserName);
    }
    if (err?.code === 'SQLITE_CORRUPT') {
      throw new CookieImportError(
        `Cookie database for ${browserName} is corrupt`,
        'db_corrupt',
      );
    }
    throw new CookieImportError('Cookie database could not be read', 'db_read_error');
  }
}

function openDbFromCopy(dbPath: string, browserName: string): ReturnType<typeof openCookieDatabase> {
  // Use os.tmpdir() instead of hardcoded /tmp for cross-platform support (#708)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-cookies-'));
  const tmpPath = path.join(tmpDir, 'Cookies');
  try {
    fs.chmodSync(tmpDir, 0o700);
    fs.copyFileSync(dbPath, tmpPath);
    fs.chmodSync(tmpPath, 0o600);
    // Also copy WAL and SHM if they exist (for consistent reads)
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, tmpPath + '-wal');
      fs.chmodSync(tmpPath + '-wal', 0o600);
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, tmpPath + '-shm');
      fs.chmodSync(tmpPath + '-shm', 0o600);
    }

    const db = openCookieDatabase(tmpPath);
    // Schedule cleanup after the DB is closed
    const origClose = db.close.bind(db);
    db.close = () => {
      try { origClose(); } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    };
    return db;
  } catch (err: any) {
    // Clean up on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (err?.code === 'sqlite_unavailable') throw new CookieImportError(err.message, 'sqlite_unavailable');
    if (err?.code === 'SQLITE_CORRUPT') throw new CookieImportError('Cookie database is corrupt', 'db_corrupt');
    if (err?.code === 'EACCES' || err?.code === 'EPERM') throw new CookieImportError('Cookie database access denied', 'db_permission');
    if (err?.code === 'ENOENT') throw new CookieImportError('Cookie database no longer exists', 'db_missing');
    if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|EBUSY/.test(String(err?.code) + String(err?.message))) {
      throw new CookieImportError('Cookie database could not be read', 'db_read_error');
    }
    throw new CookieImportError(
      `Cookie database is locked (${browserName} may be running). Try closing ${browserName} first.`,
      'db_locked',
      'retry',
    );
  }
}

// ─── Internal: Keychain Access (async, 10s timeout) ─────────────

function deriveKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

function getCachedDerivedKey(cacheKey: string, password: string, iterations: number): Buffer {
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const derived = deriveKey(password, iterations);
  keyCache.set(cacheKey, derived);
  return derived;
}

async function getDerivedKeys(match: BrowserMatch): Promise<Map<string, Buffer>> {
  if (match.platform === 'darwin') {
    const password = await getMacKeychainPassword(match.browser.keychainService);
    return new Map([
      ['v10', getCachedDerivedKey(`darwin:${match.browser.keychainService}:v10`, password, 1003)],
    ]);
  }

  if (match.platform === 'win32') {
    const key = await getWindowsAesKey(match.browser);
    return new Map([['v10', key]]);
  }

  const keys = new Map<string, Buffer>();
  keys.set('v10', getCachedDerivedKey('linux:v10', 'peanuts', 1));

  const linuxPassword = await getLinuxSecretPassword(match.browser);
  if (linuxPassword) {
    keys.set(
      'v11',
      getCachedDerivedKey(`linux:${match.browser.keychainService}:v11`, linuxPassword, 1),
    );
  }
  return keys;
}

async function getWindowsAesKey(browser: BrowserInfo): Promise<Buffer> {
  const cacheKey = `win32:${browser.keychainService}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const platform = 'win32' as const;
  const dataDir = getDataDirForPlatform(browser, platform);
  if (!dataDir) throw new CookieImportError(`No Windows data dir for ${browser.name}`, 'not_installed');

  const localStatePath = path.join(getBaseDir(platform), dataDir, 'Local State');
  let localState: any;
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
  } catch (err) {
    throw new CookieImportError(
      `Cannot read Local State for ${browser.name}`,
      'keychain_error',
    );
  }

  const encryptedKeyB64: string = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new CookieImportError(
      `No encrypted key in Local State for ${browser.name}`,
      'keychain_not_found',
    );
  }

  // The stored value is base64(b"DPAPI" + dpapi_encrypted_bytes) — strip the 5-byte prefix
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64').slice(5);
  const key = await dpapiDecrypt(encryptedKey);
  keyCache.set(cacheKey, key);
  return key;
}

async function dpapiDecrypt(encryptedBytes: Buffer): Promise<Buffer> {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$stdin = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [System.Convert]::FromBase64String($stdin)',
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    'Write-Output ([System.Convert]::ToBase64String($dec))',
  ].join('; ');

  const proc = Bun.spawn(['powershell', '-NoProfile', '-Command', script], {
    windowsHide: true,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    proc.stdin.write(encryptedBytes.toString('base64'));
    proc.stdin.end();
    const { exitCode, stdout } = await readCredentialProcess(proc, 10_000, () =>
      new CookieImportError('DPAPI decryption timed out', 'keychain_timeout', 'retry'));
    if (exitCode !== 0) {
      throw new CookieImportError('DPAPI decryption failed', 'keychain_error');
    }
    return Buffer.from(stdout.trim(), 'base64');
  } catch (err) {
    if (err instanceof CookieImportError) throw err;
    throw new CookieImportError(
      'DPAPI decryption failed',
      'keychain_error',
    );
  }
}

async function readCredentialProcess(
  proc: { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; kill(): void },
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes).toString('utf8');
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error('Credential process output exceeded the limit');
      chunks.push(value);
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([proc.exited, read(readers[0]), read(readers[1])]), timeout,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    try { proc.kill(); } catch {}
    for (const reader of readers) {
      try { void reader.cancel().catch(() => {}); } catch {}
    }
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

async function getMacKeychainPassword(service: string): Promise<string> {
  // Use async Bun.spawn with timeout to avoid blocking the event loop.
  // macOS may show an Allow/Deny dialog that blocks until the user responds.
  const proc = Bun.spawn(
    ['security', 'find-generic-password', '-s', service, '-w'],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  );

  try {
    const { exitCode, stdout, stderr } = await readCredentialProcess(proc, 10_000, () =>
      new CookieImportError(
        `macOS is waiting for Keychain permission. Look for a dialog asking to allow access to "${service}".`,
        'keychain_timeout',
        'retry',
      ));

    if (exitCode !== 0) {
      // Distinguish denied vs not found vs other
      const errText = stderr.trim().toLowerCase();
      if (errText.includes('user canceled') || errText.includes('denied') || errText.includes('interaction not allowed')) {
        throw new CookieImportError(
          `Keychain access denied. Click "Allow" in the macOS dialog for "${service}".`,
          'keychain_denied',
          'retry',
        );
      }
      if (errText.includes('could not be found') || errText.includes('not found')) {
        throw new CookieImportError(
          `No Keychain entry for "${service}". Is this a Chromium-based browser?`,
          'keychain_not_found',
        );
      }
      throw new CookieImportError(
        'Could not read Keychain',
        'keychain_error',
        'retry',
      );
    }

    return stdout.trim();
  } catch (err) {
    if (err instanceof CookieImportError) throw err;
    throw new CookieImportError(
      'Could not read Keychain',
      'keychain_error',
      'retry',
    );
  }
}

async function getLinuxSecretPassword(browser: BrowserInfo): Promise<string | null> {
  const attempts: string[][] = [
    ['secret-tool', 'lookup', 'Title', browser.keychainService],
  ];

  if (browser.linuxApplication) {
    attempts.push(
      ['secret-tool', 'lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', browser.linuxApplication],
      ['secret-tool', 'lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password', 'application', browser.linuxApplication],
    );
  }

  for (const cmd of attempts) {
    const password = await runPasswordLookup(cmd, 3_000);
    if (password) return password;
  }

  return null;
}

async function runPasswordLookup(cmd: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const { exitCode, stdout } = await readCredentialProcess(proc, timeoutMs, () => new Error('timeout'));
    if (exitCode !== 0) return null;

    const password = stdout.trim();
    return password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

// ─── Internal: Cookie Decryption ────────────────────────────────

interface RawCookie {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer | Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number;
  is_httponly: number;
  has_expires: number;
  samesite: number;
}

function decryptCookieValue(row: RawCookie, keys: Map<string, Buffer>, platform: BrowserPlatform): string {
  // Prefer unencrypted value if present
  if (row.value && row.value.length > 0) return row.value;

  const ev = Buffer.from(row.encrypted_value);
  if (ev.length === 0) return '';

  const prefix = ev.slice(0, 3).toString('utf-8');

  // Chrome 127+ on Windows uses App-Bound Encryption (v20) — cannot be decrypted
  // outside the Chrome process. Caller should fall back to CDP extraction.
  if (prefix === 'v20') throw new CookieImportError(
    'Cookie uses App-Bound Encryption (v20). Use CDP extraction instead.',
    'v20_encryption',
  );

  const key = keys.get(prefix);
  if (!key) throw new Error(`No decryption key available for ${prefix} cookies`);

  if (platform === 'win32' && prefix === 'v10') {
    // Windows: AES-256-GCM — structure: v10(3) + nonce(12) + ciphertext + tag(16)
    const nonce = ev.slice(3, 15);
    const tag = ev.slice(ev.length - 16);
    const ciphertext = ev.slice(15, ev.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce) as crypto.DecipherGCM;
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  // macOS / Linux: AES-128-CBC — structure: v10/v11(3) + ciphertext
  const ciphertext = ev.slice(3);
  const iv = Buffer.alloc(16, 0x20); // 16 space characters
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Chromium prefixes encrypted cookie payloads with 32 bytes of metadata.
  if (plaintext.length <= 32) return '';
  return plaintext.slice(32).toString('utf-8');
}

function toPlaywrightCookie(row: RawCookie, value: string): PlaywrightCookie {
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    expires: chromiumEpochToUnix(row.expires_utc, row.has_expires),
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite: mapSameSite(row.samesite),
  };
}

// ─── Internal: Chromium Epoch Conversion ────────────────────────

const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;

function chromiumNow(): bigint {
  // Current time in Chromium epoch (microseconds since 1601-01-01)
  return BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET;
}

function chromiumEpochToUnix(epoch: number | bigint, hasExpires: number): number {
  if (hasExpires === 0 || epoch === 0 || epoch === 0n) return -1; // session cookie
  const epochBig = BigInt(epoch);
  const unixMicro = epochBig - CHROMIUM_EPOCH_OFFSET;
  return Number(unixMicro / 1000000n);
}

function mapSameSite(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}


export async function importCookiesViaCdp(
  browserName: string,
  domains: string[],
  profile = 'Default',
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };
  if (process.platform !== 'win32') throw new CookieImportError('Native extraction is only supported on Windows', 'not_supported');
  const browser = resolveBrowser(browserName);
  validateProfile(profile);
  const dataDir = getDataDirForPlatform(browser, 'win32');
  if (!dataDir) throw new CookieImportError('This browser is not supported on Windows', 'not_supported');
  const { importNativeCookies } = await import('./cookie-import-native');
  const cookies = await importNativeCookies({
    browserName: browser.name,
    userDataDir: path.join(getBaseDir('win32'), dataDir),
    profile,
    domains: [...new Set(domains.flatMap(domain => {
      const normalized = normalizeCookieDomain(domain);
      return [normalized, '.' + normalized];
    }))],
  });
  const domainCounts: Record<string, number> = Object.create(null);
  for (const cookie of cookies) domainCounts[cookie.domain] = (domainCounts[cookie.domain] || 0) + 1;
  return { cookies, count: cookies.length, failed: 0, domainCounts };
}
