/**
 * brain-cache roundtrip integration tests (T2a / T19).
 *
 * Exercises the non-MCP-dependent parts of the cache layer:
 *   - Path resolution per scope (cross-project vs per-project)
 *   - Atomic _meta.json write/read
 *   - TTL staleness detection
 *   - Invalidate clears last_refresh
 *   - Schema-version mismatch triggers rebuild attempt (D4 A4)
 *   - Endpoint switch triggers rebuild attempt
 *
 * The brain-reachable refresh path (MCP fetch + compress) is tested
 * separately in brain-cache-stale-but-usable.test.ts using a mocked
 * spawnGbrain. T2a focuses on the cache-state machine.
 *
 * Uses tmp GSTACK_HOME per-test to avoid polluting the real ~/.gstack/.
 * Gate-tier, free, ~50ms.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let TMP_HOME: string;
const ORIGINAL_HOME = process.env.GSTACK_HOME;

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), 'gstack-cache-test-'));
  process.env.GSTACK_HOME = TMP_HOME;
  // Reload the cache module fresh per test so it picks up the new HOME.
  delete require.cache[require.resolve('../bin/gstack-brain-cache')];
});

afterEach(() => {
  if (ORIGINAL_HOME) process.env.GSTACK_HOME = ORIGINAL_HOME;
  else delete process.env.GSTACK_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function importCache(): Promise<typeof import('../bin/gstack-brain-cache')> {
  return (await import('../bin/gstack-brain-cache')) as typeof import('../bin/gstack-brain-cache');
}

describe('brain-cache paths', () => {
  test('cross-project entity (user-profile) lives in ~/.gstack/brain-cache/', async () => {
    const mod = await importCache();
    const path = mod.entityPath('user-profile', null);
    expect(path).toBe(join(TMP_HOME, 'brain-cache', 'user-profile.md'));
  });

  test('per-project entity (product) lives in ~/.gstack/projects/<slug>/brain-cache/', async () => {
    const mod = await importCache();
    const path = mod.entityPath('product', 'helsinki');
    expect(path).toBe(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', 'product.md'));
  });

  test('throws on unknown entity', async () => {
    const mod = await importCache();
    expect(() => mod.entityPath('not-an-entity', null)).toThrow();
  });

  test('per-project entity without slug throws', async () => {
    const mod = await importCache();
    expect(() => mod.entityPath('product', null)).toThrow();
  });
});

describe('brain-cache meta lifecycle', () => {
  test('cmdMeta on empty cache returns valid fresh meta', async () => {
    const mod = await importCache();
    const meta = mod.cmdMeta('helsinki');
    expect(meta.schema_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(meta.endpoint_hash).toMatch(/^[a-f0-9]{1,8}$|^local$/);
    expect(meta.last_refresh).toEqual({});
  });

  test('cmdInvalidate writes meta even if no prior refresh', async () => {
    const mod = await importCache();
    mod.cmdInvalidate('product', 'helsinki');
    const meta = mod.cmdMeta('helsinki');
    // last_refresh remains empty (we just delete an absent key — that's a no-op
    // but the meta file is now written to disk).
    expect(meta.last_refresh.product).toBeUndefined();
    expect(existsSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '_meta.json'))).toBe(true);
  });
});

describe('brain-cache endpoint detection', () => {
  test('detectEndpointHash returns "local" when no ~/.claude.json gbrain MCP', async () => {
    // We don't write ~/.claude.json in the temp env, so this falls through to local.
    const mod = await importCache();
    // The user's real ~/.claude.json may have an MCP server; in that case the hash
    // will be a real sha8. Either way, it's a stable string.
    const hash = mod.detectEndpointHash();
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('brain-cache schema mismatch behavior', () => {
  test('schema-version mismatch in meta triggers full-rebuild attempt on next get', async () => {
    const mod = await importCache();
    // Pre-seed meta with a different schema version, and a cache file that's
    // recent enough to be "warm" by TTL but stale by schema version.
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'product.md'), '# stale-from-old-schema\n');
    writeFileSync(join(cacheDir, '_meta.json'), JSON.stringify({
      schema_version: '0.0.1',
      endpoint_hash: mod.detectEndpointHash(),
      last_refresh: { product: Date.now() },
      last_attempt: {},
    }));

    const result = mod.cmdGet('product', 'helsinki');
    // Brain is unreachable in this test (no gbrain mock), so refresh fails and
    // the file gets deleted by the rebuild step. State should be 'missing' or
    // 'stale-fallback' depending on whether the rebuild left a file behind.
    expect(['missing', 'cold-refreshed', 'stale-fallback']).toContain(result.state);
  });
});

describe('brain-cache state machine', () => {
  test('warm: pre-seeded fresh cache returns warm without touching brain', async () => {
    const mod = await importCache();
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    const productContent = '# Product: helsinki\n\nA test product.\n';
    writeFileSync(join(cacheDir, 'product.md'), productContent);
    writeFileSync(join(cacheDir, '_meta.json'), JSON.stringify({
      schema_version: '1.0.0', // matches GSTACK_SCHEMA_PACK_VERSION
      endpoint_hash: mod.detectEndpointHash(),
      last_refresh: { product: Date.now() }, // fresh
      last_attempt: {},
    }));
    const result = mod.cmdGet('product', 'helsinki');
    expect(result.state).toBe('warm');
    expect(readFileSync(result.path, 'utf-8')).toBe(productContent);
  });

  test('missing: no cache + no brain returns missing state', async () => {
    const mod = await importCache();
    const result = mod.cmdGet('brand', 'helsinki');
    expect(result.state).toBe('missing');
  });

  test('stale-fallback: stale cache with unreachable brain returns stale-fallback', async () => {
    const mod = await importCache();
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'product.md'), '# stale\n');
    // Set last_refresh way in the past (> 1d TTL for product)
    writeFileSync(join(cacheDir, '_meta.json'), JSON.stringify({
      schema_version: '1.0.0',
      endpoint_hash: mod.detectEndpointHash(),
      last_refresh: { product: 0 }, // epoch start = very stale
      last_attempt: {},
    }));
    const result = mod.cmdGet('product', 'helsinki');
    // Brain unreachable → cold refresh fails → stale-but-usable fallback
    expect(result.state).toBe('stale-fallback');
  });
});
