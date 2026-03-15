/**
 * Shared types, utilities, and DB helpers for cookie import modules.
 *
 * Used by both cookie-import-browser.ts (macOS) and cookie-import-browser-win.ts (Windows).
 * Pure logic — no platform-specific code here.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface BrowserInfoBase {
  name: string;
  aliases: string[];
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

export interface RawCookie {
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

// ─── Chromium Epoch ─────────────────────────────────────────────

const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;

export function chromiumNow(): bigint {
  return BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET;
}

export function chromiumEpochToUnix(epoch: number | bigint, hasExpires: number): number {
  if (hasExpires === 0 || epoch === 0 || epoch === 0n) return -1;
  const epochBig = BigInt(epoch);
  const unixMicro = epochBig - CHROMIUM_EPOCH_OFFSET;
  return Number(unixMicro / 1000000n);
}

// ─── Cookie Mapping ─────────────────────────────────────────────

export function mapSameSite(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}

export function toPlaywrightCookie(row: RawCookie, value: string): PlaywrightCookie {
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

// ─── Profile Validation ─────────────────────────────────────────

export function validateProfile(profile: string): void {
  if (/[/\\]|\.\./.test(profile) || /[\x00-\x1f]/.test(profile)) {
    throw new CookieImportError(
      `Invalid profile name: '${profile}'`,
      'bad_request',
    );
  }
}

// ─── DB Copy Helper ─────────────────────────────────────────────

/**
 * Open a SQLite database, falling back to a temp copy if locked.
 * The DatabaseClass parameter allows using either bun:sqlite or better-sqlite3.
 */
export function openDbWithCopy<T>(
  dbPath: string,
  browserName: string,
  DatabaseClass: any,
  openOpts?: any,
): T {
  try {
    return new DatabaseClass(dbPath, openOpts ?? { readonly: true });
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
      return openDbFromCopy(dbPath, browserName, DatabaseClass, openOpts);
    }
    if (msg.includes('SQLITE_CORRUPT') || msg.includes('malformed')) {
      throw new CookieImportError(
        `Cookie database for ${browserName} is corrupt`,
        'db_corrupt',
      );
    }
    // Windows: Chrome holds an exclusive lock — no copy workaround available
    if (msg.includes('SQLITE_CANTOPEN') || msg.includes('unable to open')) {
      if (process.platform === 'win32') {
        throw new CookieImportError(
          `Cannot open ${browserName} cookie database — ${browserName} has an exclusive lock. ` +
          `Close all ${browserName} windows (including system tray) and try again.`,
          'db_locked',
          'retry',
        );
      }
      return openDbFromCopy(dbPath, browserName, DatabaseClass, openOpts);
    }
    throw err;
  }
}

function openDbFromCopy<T>(
  dbPath: string,
  browserName: string,
  DatabaseClass: any,
  openOpts?: any,
): T {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `browse-cookies-${browserName.toLowerCase()}-${crypto.randomUUID()}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.copyFileSync(walPath, tmpPath + '-wal');
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, tmpPath + '-shm');

    const db: any = new DatabaseClass(tmpPath, openOpts ?? { readonly: true });
    const origClose = db.close.bind(db);
    db.close = () => {
      origClose();
      try { fs.unlinkSync(tmpPath); } catch {}
      try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
      try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
    };
    return db as T;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new CookieImportError(
      `Cookie database is locked (${browserName} may be running). Try closing ${browserName} first.`,
      'db_locked',
      'retry',
    );
  }
}
