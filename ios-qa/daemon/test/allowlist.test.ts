// Allowlist tests — codex flagged identity canonicalization gaps.

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadAllowlist,
  findEntry,
  hasCapability,
  grantIdentity,
  revokeIdentity,
  saveAllowlist,
} from '../src/allowlist';

let tmpDir: string;
let listPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ios-qa-allowlist-'));
  listPath = join(tmpDir, 'allowlist.json');
});

describe('Allowlist', () => {
  test('loadAllowlist returns empty on missing file', async () => {
    const list = await loadAllowlist(listPath);
    expect(list).toEqual({ version: 1, entries: [] });
  });

  test('saveAllowlist writes mode 0600 JSON', async () => {
    await saveAllowlist({
      version: 1,
      entries: [{ identity: 'user@example.com', capabilities: ['observe'], expires_at: null }],
    }, listPath);
    expect(existsSync(listPath)).toBe(true);
    const raw = readFileSync(listPath, 'utf-8');
    expect(JSON.parse(raw).entries[0].identity).toBe('user@example.com');
  });

  test('findEntry matches exact identity', async () => {
    const list = {
      version: 1 as const,
      entries: [{ identity: 'user@example.com', capabilities: ['mutate' as const], expires_at: null }],
    };
    expect(findEntry(list, 'user@example.com')?.identity).toBe('user@example.com');
    expect(findEntry(list, 'USER@example.com')).toBeNull(); // exact-match only
    expect(findEntry(list, 'unknown@example.com')).toBeNull();
  });

  test('findEntry skips expired entries', async () => {
    const list = {
      version: 1 as const,
      entries: [
        { identity: 'expired', capabilities: ['observe' as const], expires_at: new Date(Date.now() - 60_000).toISOString() },
      ],
    };
    expect(findEntry(list, 'expired')).toBeNull();
  });

  test('findEntry accepts future expiry', async () => {
    const list = {
      version: 1 as const,
      entries: [
        { identity: 'future', capabilities: ['observe' as const], expires_at: new Date(Date.now() + 60_000).toISOString() },
      ],
    };
    expect(findEntry(list, 'future')?.identity).toBe('future');
  });

  test('hasCapability is tier-aware', async () => {
    const list = {
      version: 1 as const,
      entries: [
        { identity: 'restore-user', capabilities: ['restore' as const], expires_at: null },
        { identity: 'observe-user', capabilities: ['observe' as const], expires_at: null },
      ],
    };
    expect(hasCapability(list, 'restore-user', 'observe')).toBe(true);
    expect(hasCapability(list, 'restore-user', 'interact')).toBe(true);
    expect(hasCapability(list, 'restore-user', 'mutate')).toBe(true);
    expect(hasCapability(list, 'restore-user', 'restore')).toBe(true);
    expect(hasCapability(list, 'observe-user', 'observe')).toBe(true);
    expect(hasCapability(list, 'observe-user', 'interact')).toBe(false);
    expect(hasCapability(list, 'observe-user', 'mutate')).toBe(false);
    expect(hasCapability(list, 'observe-user', 'restore')).toBe(false);
  });

  test('grantIdentity adds a new entry', async () => {
    await grantIdentity({
      identity: 'new@example.com',
      capability: 'interact',
      path: listPath,
    });
    const list = await loadAllowlist(listPath);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]!.identity).toBe('new@example.com');
    expect(list.entries[0]!.capabilities).toContain('interact');
  });

  test('grantIdentity upgrades an existing entry', async () => {
    await grantIdentity({ identity: 'u', capability: 'observe', path: listPath });
    await grantIdentity({ identity: 'u', capability: 'restore', path: listPath });
    const list = await loadAllowlist(listPath);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]!.capabilities).toContain('restore');
  });

  test('grantIdentity with ttl sets expires_at', async () => {
    await grantIdentity({ identity: 'u', capability: 'observe', ttlSeconds: 3600, path: listPath });
    const list = await loadAllowlist(listPath);
    const exp = Date.parse(list.entries[0]!.expires_at!);
    expect(exp).toBeGreaterThan(Date.now());
    expect(exp).toBeLessThan(Date.now() + 3700 * 1000);
  });

  test('revokeIdentity removes the entry', async () => {
    await grantIdentity({ identity: 'u', capability: 'observe', path: listPath });
    await revokeIdentity('u', listPath);
    const list = await loadAllowlist(listPath);
    expect(list.entries).toHaveLength(0);
  });

  // Codex-flagged identity canonicalization variants — verify the matcher
  // works for each.
  test('user identity, tagged node, node key, expired node all canonicalize distinctly', async () => {
    const list = {
      version: 1 as const,
      entries: [
        { identity: 'alice@example.com', capabilities: ['observe' as const], expires_at: null },
        { identity: 'tag:ci', capabilities: ['mutate' as const], expires_at: null },
        { identity: 'node:abcdef0123', capabilities: ['observe' as const], expires_at: null },
        { identity: 'bob@example.com', capabilities: ['observe' as const], expires_at: new Date(Date.now() - 1000).toISOString() },
      ],
    };
    expect(hasCapability(list, 'alice@example.com', 'observe')).toBe(true);
    expect(hasCapability(list, 'tag:ci', 'mutate')).toBe(true);
    expect(hasCapability(list, 'node:abcdef0123', 'observe')).toBe(true);
    expect(hasCapability(list, 'bob@example.com', 'observe')).toBe(false); // expired
    expect(hasCapability(list, 'tag:CI', 'mutate')).toBe(false); // case-sensitive — canonicalize before lookup
  });
});

import { afterEach } from 'bun:test';
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
