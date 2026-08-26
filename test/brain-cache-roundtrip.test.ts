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

describe('brain-cache malformed _meta.json (#1879)', () => {
  function seedMeta(content: string): void {
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, '_meta.json'), content);
  }

  test('cmdInvalidate does not throw when last_refresh is missing', async () => {
    const mod = await importCache();
    // Valid JSON object, but no last_refresh map — the original crash.
    seedMeta(JSON.stringify({ schema_version: '0.0.1', endpoint_hash: 'x' }));
    expect(() => mod.cmdInvalidate('product', 'helsinki')).not.toThrow();
  });

  test('cmdGet does not throw on null / array / primitive _meta.json', async () => {
    const mod = await importCache();
    for (const bad of ['null', '[]', '"a string"', '42']) {
      seedMeta(bad);
      expect(() => mod.cmdGet('product', 'helsinki')).not.toThrow();
    }
  });

  test('missing schema_version is treated as a mismatch (forces rebuild, not trust)', async () => {
    const mod = await importCache();
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'product.md'), '# stale-no-schema\n');
    // No schema_version field — must NOT be trusted as a warm hit.
    seedMeta(JSON.stringify({ endpoint_hash: mod.detectEndpointHash(), last_refresh: { product: Date.now() } }));
    const result = mod.cmdGet('product', 'helsinki');
    // Brain unreachable in test → rebuild path runs; must not be a trusted warm hit.
    expect(['missing', 'cold-refreshed', 'stale-fallback']).toContain(result.state);
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

  // #2499: project-scoped registrations (.projects["/path"].mcpServers.gbrain)
  // were never read — two different project-scoped brains both hashed to
  // 'local', so switching between them never invalidated the cache.
  test('detectEndpointHash resolves a project-scoped gbrain URL for a cwd inside the project (#2499)', async () => {
    const mod = await importCache();
    const cj = join(TMP_HOME, 'claude.json');
    writeFileSync(cj, JSON.stringify({
      projects: {
        '/w/repo': { mcpServers: { gbrain: { type: 'http', url: 'https://a.example/mcp' } } },
      },
    }));
    const inside = mod.detectEndpointHash(cj, '/w/repo/src/deep');
    expect(inside).not.toBe('local');
    expect(inside).toHaveLength(8);
    // Path-boundary check: /w/repo2 is NOT inside /w/repo.
    expect(mod.detectEndpointHash(cj, '/w/repo2')).toBe('local');
  });

  test('detectEndpointHash prefers the nearest-ancestor project entry (#2499)', async () => {
    const mod = await importCache();
    const cj = join(TMP_HOME, 'claude.json');
    writeFileSync(cj, JSON.stringify({
      projects: {
        '/w/repo': { mcpServers: { gbrain: { url: 'https://outer.example/mcp' } } },
        '/w/repo/nested': { mcpServers: { gbrain: { url: 'https://inner.example/mcp' } } },
      },
    }));
    const inner = mod.detectEndpointHash(cj, '/w/repo/nested/sub');
    const outer = mod.detectEndpointHash(cj, '/w/repo/other');
    expect(inner).not.toBe(outer); // two brains → two hashes (the docstring scenario)
    expect(inner).not.toBe('local');
    expect(outer).not.toBe('local');
  });

  test('detectEndpointHash prefers project-local scope over user scope (#2392 wave)', async () => {
    // Empirically verified against claude 2.1.233 with hermetic fixtures:
    // `claude mcp get gbrain` reports "Scope: Local config" when both scopes
    // define the server — project-local WINS. The old pin here encoded the
    // opposite (user-first) assumption, which mis-hashed endpoints whenever
    // the two scopes disagreed.
    const mod = await importCache();
    const cj = join(TMP_HOME, 'claude.json');
    writeFileSync(cj, JSON.stringify({
      mcpServers: { gbrain: { url: 'https://user.example/mcp' } },
      projects: {
        '/w/repo': { mcpServers: { gbrain: { url: 'https://proj.example/mcp' } } },
      },
    }));
    const conflictHash = mod.detectEndpointHash(cj, '/w/repo');
    // Same file minus the USER entry → identical hash proves project scope won.
    writeFileSync(cj, JSON.stringify({
      projects: {
        '/w/repo': { mcpServers: { gbrain: { url: 'https://proj.example/mcp' } } },
      },
    }));
    expect(mod.detectEndpointHash(cj, '/w/repo')).toBe(conflictHash);
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
  }, 30000);
  // ^ 30s: the schema-mismatch rebuild refreshes EVERY per-project entity,
  // each spawning the real gbrain CLI (no mock here). With an unreachable
  // brain each spawn runs to its own timeout, and under machine load the
  // stack exceeds bun's 5s default — observed at 5.2-5.4s on a loaded box,
  // identically on pre-fix binaries (load flake, not a code regression).
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
