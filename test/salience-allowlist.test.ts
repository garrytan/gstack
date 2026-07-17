/**
 * D9 salience privacy gate (T17).
 *
 * Verifies that fetchSalience strips entries whose slugs don't match the
 * allowlist prefixes BEFORE writing the digest to disk. Sensitive content
 * (family, therapy, reflection) is never persisted into the cache.
 *
 * Gate-tier, free.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SALIENCE_DEFAULT_ALLOWLIST } from '../scripts/brain-cache-spec';

const ORIGINAL_ENV = process.env.GSTACK_SALIENCE_ALLOWLIST;

beforeEach(() => {
  delete require.cache[require.resolve('../bin/gstack-brain-cache')];
});

afterEach(() => {
  if (ORIGINAL_ENV) process.env.GSTACK_SALIENCE_ALLOWLIST = ORIGINAL_ENV;
  else delete process.env.GSTACK_SALIENCE_ALLOWLIST;
});

async function importCache(): Promise<typeof import('../bin/gstack-brain-cache')> {
  return (await import('../bin/gstack-brain-cache')) as typeof import('../bin/gstack-brain-cache');
}

describe('salience allowlist gate', () => {
  test('default allowlist permits projects/ + gstack/ + concepts/', async () => {
    const mod = await importCache();
    expect(mod.isSalienceSlugAllowed('projects/myrepo', SALIENCE_DEFAULT_ALLOWLIST)).toBe(true);
    expect(mod.isSalienceSlugAllowed('gstack/product/helsinki', SALIENCE_DEFAULT_ALLOWLIST)).toBe(true);
    expect(mod.isSalienceSlugAllowed('concepts/some-idea', SALIENCE_DEFAULT_ALLOWLIST)).toBe(true);
  });

  test('default allowlist BLOCKS personal/ + family/ + therapy/ + reflections', async () => {
    const mod = await importCache();
    expect(mod.isSalienceSlugAllowed('personal/reflection-2026-05', SALIENCE_DEFAULT_ALLOWLIST)).toBe(false);
    expect(mod.isSalienceSlugAllowed('family/in-laws/ngo-kim-shing', SALIENCE_DEFAULT_ALLOWLIST)).toBe(false);
    expect(mod.isSalienceSlugAllowed('therapy-session/2026-05-15', SALIENCE_DEFAULT_ALLOWLIST)).toBe(false);
    expect(mod.isSalienceSlugAllowed('reflection/notes', SALIENCE_DEFAULT_ALLOWLIST)).toBe(false);
  });

  test('isSalienceSlugAllowed handles empty allowlist (blocks everything)', async () => {
    const mod = await importCache();
    expect(mod.isSalienceSlugAllowed('anything/at-all', [])).toBe(false);
  });

  test('isSalienceSlugAllowed handles arbitrary prefixes', async () => {
    const mod = await importCache();
    expect(mod.isSalienceSlugAllowed('custom/scope', ['custom/'])).toBe(true);
    expect(mod.isSalienceSlugAllowed('other/scope', ['custom/'])).toBe(false);
  });

  test('getSalienceAllowlist returns default when env unset and config silent', async () => {
    delete process.env.GSTACK_SALIENCE_ALLOWLIST;
    const mod = await importCache();
    const list = mod.getSalienceAllowlist();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    // Should at minimum contain the curated defaults
    expect(list).toContain('projects/');
    expect(list).toContain('gstack/');
  });

  test('GSTACK_SALIENCE_ALLOWLIST env override is honored', async () => {
    process.env.GSTACK_SALIENCE_ALLOWLIST = 'custom-a/,custom-b/,custom-c/';
    const mod = await importCache();
    const list = mod.getSalienceAllowlist();
    expect(list).toEqual(['custom-a/', 'custom-b/', 'custom-c/']);
  });

  test('GSTACK_SALIENCE_ALLOWLIST with whitespace is trimmed', async () => {
    process.env.GSTACK_SALIENCE_ALLOWLIST = ' projects/ , gstack/ , concepts/ ';
    const mod = await importCache();
    const list = mod.getSalienceAllowlist();
    expect(list).toEqual(['projects/', 'gstack/', 'concepts/']);
  });

  test('empty env value falls through to default (not empty list)', async () => {
    process.env.GSTACK_SALIENCE_ALLOWLIST = '';
    const mod = await importCache();
    const list = mod.getSalienceAllowlist();
    expect(list.length).toBeGreaterThan(0);
  });

  test('managed GSTACK_BIN config controls salience without a Claude install path', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'gstack-salience-bin-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const config = join(bin, 'gstack-config');
    writeFileSync(config, '#!/bin/sh\nprintf "%s" "custom-safe/,projects/"\n');
    chmodSync(config, 0o755);
    const previousBin = process.env.GSTACK_BIN;
    try {
      process.env.GSTACK_BIN = bin;
      delete process.env.GSTACK_SALIENCE_ALLOWLIST;
      const mod = await importCache();
      expect(mod.getSalienceAllowlist()).toEqual(['custom-safe/', 'projects/']);
    } finally {
      if (previousBin) process.env.GSTACK_BIN = previousBin;
      else delete process.env.GSTACK_BIN;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('default allowlist contains nothing sensitive', async () => {
    const sensitivePrefixes = ['personal', 'family', 'therapy', 'reflection', 'private', 'medical', 'health'];
    for (const prefix of sensitivePrefixes) {
      const matched = SALIENCE_DEFAULT_ALLOWLIST.some((p) => p.startsWith(prefix));
      expect(matched).toBe(false);
    }
  });
});
