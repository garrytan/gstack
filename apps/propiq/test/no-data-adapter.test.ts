/**
 * The no-source adapter.
 *
 * A public deployment with no property database has no Indian property facts.
 * The original guard handled that by refusing to boot, which meant eleven of
 * thirty-seven routes returned 500 and four more returned a misleading 200 —
 * the free tools, the methodology and the marketing pages went down with the
 * data-backed ones, none of which need a database.
 *
 * `none` is the honest middle: serve everything that needs no dataset, and say
 * plainly that there is no dataset rather than showing "no results", which
 * tells a buyer their filters were too narrow.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asId } from '@/domain/shared/types';
import type { LocalityId, PropertyId } from '@/domain/shared/types';
import { EmptyPropertyRepository } from '@/data/empty/adapter';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

describe('EmptyPropertyRepository', () => {
  const repo = new EmptyPropertyRepository();

  it('declares itself as serving no data and no demo data', () => {
    expect(repo.servesNoData).toBe(true);
    expect(repo.servesDemoData).toBe(false);
    expect(repo.adapterName).toBe('none');
  });

  it('returns an empty page rather than falling back to fixtures', async () => {
    const page = await repo.search({ pageSize: 48 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it('resolves every lookup to undefined or empty', async () => {
    expect(await repo.getById(asId<PropertyId>('prop-nm-3a'))).toBeUndefined();
    expect(await repo.getLocalityBySlug('whitefield')).toBeUndefined();
    expect(await repo.getLocality(asId<LocalityId>('loc-whitefield'))).toBeUndefined();
    expect(await repo.listLocalities()).toEqual([]);
    expect(await repo.getManyByIds([asId<PropertyId>('prop-nm-3a')])).toEqual([]);
    expect(await repo.getComparables(asId<PropertyId>('prop-nm-3a'))).toEqual([]);
    expect(await repo.getAlternatives(asId<PropertyId>('prop-nm-3a'))).toEqual([]);
  });

  it('never imports the fixture dataset', () => {
    // The whole point: the alternative to real data is silence, not invented
    // data wearing a badge.
    const source = read('src/data/empty/adapter.ts');
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.join('\n')).not.toMatch(/fixtures|DEMO_/);
    expect(source).not.toMatch(/DEMO_PROPERTIES|DEMO_LOCALITIES|DEMO_DEVELOPERS/);
  });
});

describe('adapter resolution', () => {
  const env = read('src/lib/env.ts');

  it('still refuses fixture data in production', () => {
    expect(env).toMatch(/PROPIQ_DATA_ADAPTER=fixture is not permitted when NODE_ENV=production/);
  });

  it('defaults to none in production and fixture in development', () => {
    expect(env).toMatch(/NODE_ENV === 'production' \? 'none' : 'fixture'/);
  });

  it('routes the none adapter to the empty repository', () => {
    const index = read('src/data/index.ts');
    expect(index).toMatch(/PROPIQ_DATA_ADAPTER === 'none'/);
    expect(index).toMatch(/new EmptyPropertyRepository\(\)/);
  });
});

describe('no-source disclosure', () => {
  it('distinguishes no source from no results on every data-backed surface', () => {
    for (const page of [
      'src/app/page.tsx',
      'src/app/(app)/search/page.tsx',
      'src/app/(app)/localities/page.tsx',
      'src/app/(app)/developers/page.tsx',
    ]) {
      expect(read(page), `${page} must disclose an unconfigured source`).toMatch(
        /servesNoData|NoDataNotice/,
      );
    }
  });

  it('tells a model reading llms.txt that there is nothing to cite', () => {
    const route = read('src/app/llms.txt/route.ts');
    expect(route).toMatch(/NO PROPERTY DATA/);
    expect(route).toMatch(/servesNoData/);
    // The LIVE claim must not be reachable when no records are served.
    expect(route.indexOf('NO PROPERTY DATA')).toBeLessThan(route.indexOf('deployment: LIVE'));
  });

  it('drives the search shortcuts from real coverage, not a hardcoded list', () => {
    // A fixed "Popular: Whitefield, Hebbal…" row claims coverage the deployment
    // may not have.
    // The search lives in the hero now; the invariant is unchanged — the
    // shortcut row is fed from the dataset, and is empty when there isn't one.
    expect(read('src/app/page.tsx')).toMatch(/<HeroSection[\s\S]{0,120}localities=\{/);
    expect(read('src/components/site/hero-search.tsx')).toMatch(/localities\.length > 0/);
  });
});
