/**
 * Schema-version cache migration (D4 A4 / T19).
 *
 * When gstack-core@1.x.y bumps and the cached _meta.json records an older
 * schema_version, the cache layer triggers a FULL rebuild for the affected
 * scope (not just delete-the-stale-file). Verifies the rebuild path is
 * invoked AND the cache files for that scope are wiped before refresh.
 *
 * Gate-tier, free, ~50ms.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Per-test timeout: schema-mismatch path triggers a full-scope rebuild, which
// fans out to refreshEntity for each of 7 per-project entities. Each refresh
// shells out to gbrain with a 10s internal timeout. Total worst case ~70s.
// We allow 60s here to give the test room without flaking on a slow brain.
const SLOW_TIMEOUT = 60_000;
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GSTACK_SCHEMA_PACK_VERSION } from '../scripts/brain-cache-spec';

let TMP_HOME: string;
const ORIGINAL_HOME = process.env.GSTACK_HOME;

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), 'gstack-schema-test-'));
  process.env.GSTACK_HOME = TMP_HOME;
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

describe('schema-version cache migration (D4 A4)', () => {
  test('cache file with mismatched schema_version triggers wipe-and-rebuild attempt', { timeout: SLOW_TIMEOUT }, async () => {
    const mod = await importCache();
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    const stalePath = join(cacheDir, 'product.md');
    writeFileSync(stalePath, '# stale-from-old-schema\n');
    writeFileSync(join(cacheDir, '_meta.json'), JSON.stringify({
      schema_version: '0.5.0', // old version
      endpoint_hash: 'local',
      last_refresh: { product: Date.now() }, // fresh by TTL
      last_attempt: {},
    }));

    // cmdGet should detect schema mismatch and try to rebuild. Since brain is
    // unreachable in the test env, the rebuild fails and the stale file is
    // gone (wiped during the rebuild attempt).
    mod.cmdGet('product', 'helsinki'); // triggers wipe-and-rebuild attempt

    // After rebuild attempt with unreachable brain, the stale file is wiped
    // and _meta.json shows the current schema_version.
    expect(existsSync(stalePath)).toBe(false);
    const newMeta = JSON.parse(readFileSync(join(cacheDir, '_meta.json'), 'utf-8'));
    expect(newMeta.schema_version).toBe(GSTACK_SCHEMA_PACK_VERSION);
  });

  test('matching schema_version + fresh TTL is warm hit (no rebuild)', { timeout: SLOW_TIMEOUT }, async () => {
    const mod = await importCache();
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    const productPath = join(cacheDir, 'product.md');
    writeFileSync(productPath, '# fresh content\n');
    writeFileSync(join(cacheDir, '_meta.json'), JSON.stringify({
      schema_version: GSTACK_SCHEMA_PACK_VERSION,
      endpoint_hash: mod.detectEndpointHash(),
      last_refresh: { product: Date.now() },
      last_attempt: {},
    }));

    const result = mod.cmdGet('product', 'helsinki');
    expect(result.state).toBe('warm');
    expect(readFileSync(result.path, 'utf-8')).toBe('# fresh content\n');
  });

  test('rebuild wipes ALL files in scope, not just the one being read', { timeout: SLOW_TIMEOUT }, async () => {
    const mod = await importCache();
    const cacheDir = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'product.md'), '# stale product\n');
    writeFileSync(join(cacheDir, 'brand.md'), '# stale brand\n');
    writeFileSync(join(cacheDir, 'developer-persona.md'), '# stale persona\n');
    writeFileSync(join(cacheDir, '_meta.json'), JSON.stringify({
      schema_version: '0.5.0',
      endpoint_hash: 'local',
      last_refresh: { product: Date.now(), brand: Date.now(), 'developer-persona': Date.now() },
      last_attempt: {},
    }));

    mod.cmdGet('product', 'helsinki'); // triggers wipe-and-rebuild attempt

    // All per-project files wiped (rebuild attempt cleared the scope)
    expect(existsSync(join(cacheDir, 'product.md'))).toBe(false);
    expect(existsSync(join(cacheDir, 'brand.md'))).toBe(false);
    expect(existsSync(join(cacheDir, 'developer-persona.md'))).toBe(false);
  });
});
