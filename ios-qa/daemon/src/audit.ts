// Audit + attempts logging. Reuses the same rotation primitives as
// browse/src/tunnel-denial-log.ts (10MB rotation, 5 generations).

import { mkdir, appendFile, stat, rename, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { AuditRow, AttemptRow } from './types';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_GENS = 5;

export function defaultAuditPath(): string {
  return process.env.GSTACK_IOS_AUDIT_PATH
    ?? join(homedir(), '.gstack', 'security', 'ios-qa-audit.jsonl');
}

export function defaultAttemptsPath(): string {
  return process.env.GSTACK_IOS_ATTEMPTS_PATH
    ?? join(homedir(), '.gstack', 'security', 'attempts.jsonl');
}

let _saltCache: string | null = null;

async function loadDeviceSalt(): Promise<string> {
  if (_saltCache) return _saltCache;
  const path = join(homedir(), '.gstack', 'security', 'device-salt');
  try {
    _saltCache = (await readFile(path, 'utf-8')).trim();
  } catch {
    // No salt; generate ephemeral. Real install writes one via /setup.
    const { randomBytes } = await import('crypto');
    _saltCache = randomBytes(32).toString('hex');
  }
  return _saltCache!;
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (s.size < MAX_BYTES) return;
  } catch {
    return; // file doesn't exist yet
  }
  // Rotate: path → path.1 → path.2 → ... → path.MAX_GENS
  for (let i = MAX_GENS - 1; i >= 0; i--) {
    const src = i === 0 ? path : `${path}.${i}`;
    const dst = `${path}.${i + 1}`;
    try {
      await rename(src, dst);
    } catch {
      // best-effort
    }
  }
}

export async function writeAudit(row: AuditRow, path: string = defaultAuditPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(path);
  await appendFile(path, JSON.stringify(row) + '\n', { mode: 0o600 });
}

export async function writeAttempt(opts: {
  rawIdentity: string;
  endpoint: string;
  reason: AttemptRow['reason'];
  path?: string;
}): Promise<void> {
  const salt = await loadDeviceSalt();
  const hash = createHash('sha256').update(salt + ':' + opts.rawIdentity).digest('hex').slice(0, 16);
  const row: AttemptRow = {
    ts: new Date().toISOString(),
    identity_canon: hash,
    endpoint: opts.endpoint,
    reason: opts.reason,
  };
  const path = opts.path ?? defaultAttemptsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(path);
  await appendFile(path, JSON.stringify(row) + '\n', { mode: 0o600 });
}

// Sanitize-replacer for JSON responses — mirrors browse's sanitize-replacer.ts.
// Strips lone UTF-16 surrogate halves that would otherwise reach the
// Anthropic API as \uD800-style escapes and trigger 400.
export function sanitizeReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Replace lone high surrogates not followed by low surrogates, and lone
  // low surrogates not preceded by high surrogates.
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}
