// Allowlist file at ~/.gstack/ios-qa-allowlist.json. The single source of
// truth for who can call what at which capability tier.
//
// Self-service mint over tailnet ONLY succeeds for identities present in the
// allowlist. Owner-granted mint (CLI on the Mac) is what writes new entries
// to the allowlist. Self-service mint NEVER auto-allowlists.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { Allowlist, AllowlistEntry, Capability } from './types';
import { capabilityCovers } from './types';

export function defaultAllowlistPath(): string {
  return process.env.GSTACK_IOS_ALLOWLIST_PATH
    ?? join(homedir(), '.gstack', 'ios-qa-allowlist.json');
}

export async function loadAllowlist(path: string = defaultAllowlistPath()): Promise<Allowlist> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') {
      return { version: 1, entries: [] };
    }
    throw err;
  }
  // Empty-file path (mktemp default, partial write, manual `: > file`): treat
  // as "no entries yet" rather than a parse error. The first grant will fill
  // it in atomically via saveAllowlist.
  if (raw.trim() === '') {
    return { version: 1, entries: [] };
  }
  const parsed = JSON.parse(raw) as Allowlist;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('invalid_allowlist');
  }
  return parsed;
}

export async function saveAllowlist(allowlist: Allowlist, path: string = defaultAllowlistPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(allowlist, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Look up an identity in the allowlist. Returns the entry if present AND
 * not expired. Lookup is exact-match on canonicalized identity.
 */
export function findEntry(allowlist: Allowlist, identity: string): AllowlistEntry | null {
  const now = Date.now();
  for (const entry of allowlist.entries) {
    if (entry.identity !== identity) continue;
    if (entry.expires_at) {
      const exp = Date.parse(entry.expires_at);
      if (Number.isFinite(exp) && exp < now) continue;
    }
    return entry;
  }
  return null;
}

/**
 * Check whether an identity has at least the requested capability tier.
 * Returns false on missing/expired entries OR insufficient tier.
 */
export function hasCapability(allowlist: Allowlist, identity: string, need: Capability): boolean {
  const entry = findEntry(allowlist, identity);
  if (!entry) return false;
  return entry.capabilities.some(c => capabilityCovers(c, need));
}

/**
 * Owner-granted mint path. Adds (or upgrades) an allowlist entry.
 */
export async function grantIdentity(opts: {
  identity: string;
  capability: Capability;
  ttlSeconds?: number | null; // null/undefined = no expiry
  note?: string;
  path?: string;
}): Promise<Allowlist> {
  const path = opts.path ?? defaultAllowlistPath();
  const allowlist = await loadAllowlist(path);
  const existingIdx = allowlist.entries.findIndex(e => e.identity === opts.identity);
  const expiresAt = opts.ttlSeconds && opts.ttlSeconds > 0
    ? new Date(Date.now() + opts.ttlSeconds * 1000).toISOString()
    : null;
  const newEntry: AllowlistEntry = {
    identity: opts.identity,
    capabilities: [opts.capability],
    expires_at: expiresAt,
    note: opts.note,
  };
  if (existingIdx >= 0) {
    allowlist.entries[existingIdx] = newEntry;
  } else {
    allowlist.entries.push(newEntry);
  }
  await saveAllowlist(allowlist, path);
  return allowlist;
}

/**
 * Revoke an identity from the allowlist.
 */
export async function revokeIdentity(identity: string, path: string = defaultAllowlistPath()): Promise<Allowlist> {
  const allowlist = await loadAllowlist(path);
  allowlist.entries = allowlist.entries.filter(e => e.identity !== identity);
  await saveAllowlist(allowlist, path);
  return allowlist;
}
