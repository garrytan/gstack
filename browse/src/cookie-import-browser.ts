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

import { Database } from 'bun:sqlite';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TEMP_DIR } from './platform';

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

      profiles.push({ name: entry.name, displayName });
    }

    // Found profiles on this platform — no need to check others
    if (profiles.length > 0) break;
  }

  return profiles;
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

  const browser = resolveBrowser(browserName);
  const match = getBrowserMatch(browser, profile);
  const derivedKeys = await getDerivedKeys(match);
  const db = openDb(match.dbPath, browser.name);

  try {
    const now = chromiumNow();
    // Parameterized query — no SQL injection
    const placeholders = domains.map(() => '?').join(',');
    const rows = db.query(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, has_expires, samesite
       FROM cookies
       WHERE host_key IN (${placeholders})
         AND (has_expires = 0 OR expires_utc > ?)
       ORDER BY host_key, name`
    ).all(...domains, now) as RawCookie[];

    const cookies: PlaywrightCookie[] = [];
    let failed = 0;
    const domainCounts: Record<string, number> = {};

    for (const row of rows) {
      try {
        const value = decryptCookieValue(row, derivedKeys, match.platform);
        const cookie = toPlaywrightCookie(row, value);
        cookies.push(cookie);
        domainCounts[row.host_key] = (domainCounts[row.host_key] || 0) + 1;
      } catch {
        failed++;
      }
    }

    return { cookies, count: cookies.length, failed, domainCounts };
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

function openDb(dbPath: string, browserName: string): Database {
  // On Windows, Chrome holds exclusive WAL locks even when we open readonly.
  // The readonly open may "succeed" but return empty results because the WAL
  // (where all actual data lives) can't be replayed. Always use the copy
  // approach on Windows so we can open read-write and process the WAL.
  if (process.platform === 'win32') {
    return openDbFromCopy(dbPath, browserName);
  }
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: any) {
    if (err.message?.includes('SQLITE_BUSY') || err.message?.includes('database is locked')) {
      return openDbFromCopy(dbPath, browserName);
    }
    if (err.message?.includes('SQLITE_CORRUPT') || err.message?.includes('malformed')) {
      throw new CookieImportError(
        `Cookie database for ${browserName} is corrupt`,
        'db_corrupt',
      );
    }
    throw err;
  }
}

function openDbFromCopy(dbPath: string, browserName: string): Database {
  // Use os.tmpdir() instead of hardcoded /tmp for cross-platform support (#708)
  const tmpPath = path.join(os.tmpdir(), `browse-cookies-${browserName.toLowerCase()}-${crypto.randomUUID()}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
    // Also copy WAL and SHM if they exist (for consistent reads)
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, tmpPath + '-wal');
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, tmpPath + '-shm');

    const db = new Database(tmpPath, { readonly: true });
    // Schedule cleanup after the DB is closed
    const origClose = db.close.bind(db);
    db.close = () => {
      origClose();
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
      try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
    };
    return db;
  } catch {
    // Clean up on failure
    try { fs.unlinkSync(tmpPath); } catch {}
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
    const reason = err instanceof Error ? `: ${err.message}` : '';
    throw new CookieImportError(
      `Cannot read Local State for ${browser.name} at ${localStatePath}${reason}`,
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
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  proc.stdin.write(encryptedBytes.toString('base64'));
  proc.stdin.end();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new CookieImportError('DPAPI decryption timed out', 'keychain_timeout', 'retry'));
    }, 10_000),
  );

  try {
    const exitCode = await Promise.race([proc.exited, timeout]);
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new CookieImportError(`DPAPI decryption failed: ${stderr.trim()}`, 'keychain_error');
    }
    return Buffer.from(stdout.trim(), 'base64');
  } catch (err) {
    if (err instanceof CookieImportError) throw err;
    throw new CookieImportError(
      `DPAPI decryption failed: ${(err as Error).message}`,
      'keychain_error',
    );
  }
}

async function getMacKeychainPassword(service: string): Promise<string> {
  // Use async Bun.spawn with timeout to avoid blocking the event loop.
  // macOS may show an Allow/Deny dialog that blocks until the user responds.
  const proc = Bun.spawn(
    ['security', 'find-generic-password', '-s', service, '-w'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new CookieImportError(
        `macOS is waiting for Keychain permission. Look for a dialog asking to allow access to "${service}".`,
        'keychain_timeout',
        'retry',
      ));
    }, 10_000),
  );

  try {
    const exitCode = await Promise.race([proc.exited, timeout]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

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
        `Could not read Keychain: ${stderr.trim()}`,
        'keychain_error',
        'retry',
      );
    }

    return stdout.trim();
  } catch (err) {
    if (err instanceof CookieImportError) throw err;
    throw new CookieImportError(
      `Could not read Keychain: ${(err as Error).message}`,
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
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error('timeout'));
      }, timeoutMs),
    );

    const exitCode = await Promise.race([proc.exited, timeout]);
    const stdout = await new Response(proc.stdout).text();
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


// ─── CDP-based Cookie Extraction (Windows v20 fallback) ────────
// When App-Bound Encryption (v20) is detected, we launch Chrome headless
// with remote debugging and extract cookies via the DevTools Protocol.
// This only works when Chrome is NOT already running (profile lock).

const CHROME_PATHS_WIN = [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

const EDGE_PATHS_WIN = [
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

function findBrowserExe(browserName: string): string | null {
  const candidates = browserName.toLowerCase().includes('edge') ? EDGE_PATHS_WIN : CHROME_PATHS_WIN;
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isBrowserRunning(browserName: string): Promise<boolean> {
  const exe = browserName.toLowerCase().includes('edge') ? 'msedge.exe' : 'chrome.exe';
  return new Promise((resolve) => {
    const proc = Bun.spawn(['tasklist', '/FI', `IMAGENAME eq ${exe}`, '/NH'], {
      stdout: 'pipe', stderr: 'pipe',
    });
    proc.exited.then(async () => {
      const out = await new Response(proc.stdout).text();
      resolve(out.toLowerCase().includes(exe));
    }).catch(() => resolve(false));
  });
}

/**
 * Extract cookies via Chrome DevTools Protocol. Launches Chrome headless with
 * remote debugging on the user's real profile directory. Requires Chrome to be
 * closed first (profile lock).
 *
 * v20 App-Bound Encryption binds decryption keys to the original user-data-dir
 * path, so a temp copy of the profile won't work — Chrome silently discards
 * cookies it can't decrypt. We must use the real profile.
 */
export async function importCookiesViaCdp(
  browserName: string,
  domains: string[],
  profile = 'Default',
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };
  if (process.platform !== 'win32') {
    throw new CookieImportError('CDP extraction is only needed on Windows', 'not_supported');
  }

  const browser = resolveBrowser(browserName);
  const exePath = findBrowserExe(browser.name);
  if (!exePath) {
    throw new CookieImportError(
      `Cannot find ${browser.name} executable. Install it or use /connect-chrome.`,
      'not_installed',
    );
  }

  if (await isBrowserRunning(browser.name)) {
    throw new CookieImportError(
      `${browser.name} is running. Close it first so we can launch headless with your profile, or use /connect-chrome to control your real browser directly.`,
      'browser_running',
      'retry',
    );
  }

  // Must use the real user data dir — v20 ABE keys are path-bound
  const dataDir = getDataDirForPlatform(browser, 'win32');
  if (!dataDir) throw new CookieImportError(`No Windows data dir for ${browser.name}`, 'not_installed');
  const userDataDir = path.join(getBaseDir('win32'), dataDir);

  // Launch Chrome headless with remote debugging on the real profile.
  //
  // Security posture of the debug port:
  //   - Chrome binds --remote-debugging-port to 127.0.0.1 by default. The
  //     port is NOT exposed to the network. Baseline threat: a local
  //     process running as the same user can connect.
  //   - Port is randomized in [9222, 9321] to avoid collisions with other
  //     Chrome-based tools. Not cryptographic — security relies on
  //     same-user-access baseline, not port secrecy.
  //   - Chrome is always killed in the finally block below (even on crash).
  //
  // KNOWN NON-GOAL (tracked as a separate hardening task for the next
  // security wave):
  //   On Windows 10.15+ with App-Bound Encryption (v20) enabled, a
  //   same-user process that opens the cookie DB directly cannot decrypt
  //   v20 values — the DPAPI context is bound to the browser process.
  //   The CDP port bypasses that: `Network.getAllCookies` runs inside the
  //   browser, so any same-user process that connects to the debug port
  //   before we kill Chrome could exfiltrate decrypted v20 cookies.
  //   Fix direction: switch to `--remote-debugging-pipe` so the CDP
  //   transport is a parent/child stdio pipe, not TCP. Requires
  //   restructuring the extractCookiesViaCdp WebSocket client; deferred
  //   to a follow-up because the transport swap is non-trivial and the
  //   baseline threat is still "attacker already has same-user access."
  //
  // Debugging note: if this path starts failing after a Chrome update,
  // check the Chrome version logged below — Chrome's ABE key format (v20)
  // or /json/list shape can change between major versions.
  const debugPort = 9222 + Math.floor(Math.random() * 100);
  const chromeProc = Bun.spawn([
    exePath,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--no-default-browser-check',
  ], { stdout: 'pipe', stderr: 'pipe' });

  // Wait for Chrome to start, then find a page target's WebSocket URL.
  // Network.getAllCookies is only available on page targets, not browser.
  let wsUrl: string | null = null;
  const startTime = Date.now();
  let loggedVersion = false;
  while (Date.now() - startTime < 15_000) {
    try {
      // One-time version log for future diagnostics when Chrome changes v20 format.
      if (!loggedVersion) {
        try {
          const versionResp = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
          if (versionResp.ok) {
            const v = await versionResp.json() as { Browser?: string };
            console.log(`[cookie-import] CDP fallback: ${browser.name} ${v.Browser || 'unknown version'}`);
            loggedVersion = true;
          }
        } catch {}
      }
      const resp = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (resp.ok) {
        const targets = await resp.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find(t => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (!wsUrl) {
    chromeProc.kill();
    throw new CookieImportError(
      `${browser.name} headless did not start within 15s`,
      'cdp_timeout',
      'retry',
    );
  }

  try {
    // Connect via CDP WebSocket
    const cookies = await extractCookiesViaCdp(wsUrl, domains);

    const domainCounts: Record<string, number> = {};
    for (const c of cookies) {
      domainCounts[c.domain] = (domainCounts[c.domain] || 0) + 1;
    }

    return { cookies, count: cookies.length, failed: 0, domainCounts };
  } finally {
    chromeProc.kill();
  }
}

async function extractCookiesViaCdp(wsUrl: string, domains: string[]): Promise<PlaywrightCookie[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new CookieImportError('CDP cookie extraction timed out', 'cdp_timeout'));
    }, 10_000);

    ws.onopen = () => {
      // Enable Network domain first, then request all cookies
      ws.send(JSON.stringify({ id: msgId++, method: 'Network.enable' }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(String(event.data));

      // After Network.enable succeeds, request all cookies
      if (data.id === 1 && !data.error) {
        ws.send(JSON.stringify({ id: msgId, method: 'Network.getAllCookies' }));
        return;
      }

      if (data.id === msgId && data.result?.cookies) {
        clearTimeout(timeout);
        ws.close();

        // Normalize domain matching: domains like ".example.com" match "example.com" and vice versa
        const domainSet = new Set<string>();
        for (const d of domains) {
          domainSet.add(d);
          domainSet.add(d.startsWith('.') ? d.slice(1) : '.' + d);
        }

        const matched: PlaywrightCookie[] = [];
        for (const c of data.result.cookies as CdpCookie[]) {
          if (!domainSet.has(c.domain)) continue;
          matched.push({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            expires: c.expires === -1 ? -1 : c.expires,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: cdpSameSite(c.sameSite),
          });
        }
        resolve(matched);
      } else if (data.id === msgId && data.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new CookieImportError(
          `CDP error: ${data.error.message}`,
          'cdp_error',
        ));
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new CookieImportError(
        `CDP WebSocket error: ${(err as any).message || 'unknown'}`,
        'cdp_error',
      ));
    };
  });
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite: string;
}

function cdpSameSite(value: string): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 'Strict': return 'Strict';
    case 'Lax': return 'Lax';
    case 'None': return 'None';
    default: return 'Lax';
  }
}

/**
 * Check if a browser's cookie DB contains v20 (App-Bound) encrypted cookies.
 * Quick check — reads a small sample, no decryption attempted.
 */
export function hasV20Cookies(browserName: string, profile = 'Default'): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const browser = resolveBrowser(browserName);
    const match = getBrowserMatch(browser, profile);
    const db = openDb(match.dbPath, browser.name);
    try {
      const rows = db.query('SELECT encrypted_value FROM cookies LIMIT 10').all() as Array<{ encrypted_value: Buffer | Uint8Array }>;
      return rows.some(row => {
        const ev = Buffer.from(row.encrypted_value);
        return ev.length >= 3 && ev.slice(0, 3).toString('utf-8') === 'v20';
      });
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
