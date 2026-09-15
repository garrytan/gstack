/**
 * The free tools must stay free of the dataset.
 *
 * Their whole value is that they are correct for any property in any Indian
 * market, whichever adapter is running — which is also why they are the only
 * part of this product that is indexable and citable before a real data source
 * lands. A tool that started reading the property repository would silently
 * become demo-backed, and would need a banner it does not have.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const filesUnder = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
};

const TOOL_SOURCES = [
  ...filesUnder(join(root, 'src/app/(app)/tools')),
  ...filesUnder(join(root, 'src/app/(app)/checks')),
  join(root, 'src/app/(app)/site-visit-checklist/page.tsx'),
  ...filesUnder(join(root, 'src/components/propiq/tools')),
];

const read = (f: string) => readFileSync(f, 'utf-8');

describe('free tools stay independent of the dataset', () => {
  it('finds the tool sources', () => {
    expect(TOOL_SOURCES.length).toBeGreaterThan(5);
  });

  it.each(TOOL_SOURCES.map((f) => [f.replace(root + '/', ''), f]))(
    '%s never reads the property repository',
    (_name, file) => {
      const src = read(file);
      expect(src).not.toMatch(/getPropertyRepository|from '@\/data'/);
      expect(src).not.toMatch(/buildPropertyIntelligence|buildSummaries/);
    },
  );

  it('no tool surface renders a demo banner, because none of them serve demo data', () => {
    for (const file of TOOL_SOURCES) {
      expect(read(file)).not.toContain('DemoDataBanner');
    }
  });

  it('the calculators compute in the browser and say so', () => {
    const carpet = read(join(root, 'src/components/propiq/tools/carpet-calculator.tsx'));
    const emi = read(join(root, 'src/components/propiq/tools/emi-calculator.tsx'));
    const yieldCalc = read(join(root, 'src/components/propiq/tools/yield-calculator.tsx'));
    for (const src of [carpet, emi, yieldCalc]) {
      expect(src).toContain("'use client'");
      // No server action, no fetch: a tool that promises nothing leaves the
      // browser must not quietly post the figures somewhere.
      expect(src).not.toMatch(/fetch\(|@\/server\//);
      expect(src).toMatch(/Nothing[^.]{0,40}is sent anywhere/i);
    }
  });

  it('every tool page is indexable — none of them is noindex', () => {
    for (const file of TOOL_SOURCES.filter((f) => f.endsWith('page.tsx'))) {
      expect(read(file)).not.toMatch(/robots:\s*\{\s*index:\s*false/);
    }
  });
});

describe('the answer-engine surface stays honest', () => {
  const llms = read(join(root, 'src/app/llms.txt/route.ts'));
  const robots = read(join(root, 'src/app/robots.ts'));
  const sitemap = read(join(root, 'src/app/sitemap.ts'));

  it('llms.txt is generated from the live constants, never restated in prose', () => {
    expect(llms).toContain('CURRENT_SCORING_VERSION');
    expect(llms).toContain('DECISION_THRESHOLDS');
    expect(llms).toContain('DOCUMENT_RULES_VERSION');
  });

  it('llms.txt declares the deployment demo when the fixture adapter is live', () => {
    // A model citing a fixture figure as an Indian market fact is the exact
    // failure the truthfulness rule exists to prevent, so the file a model
    // reads first has to say so.
    expect(llms).toContain('servesDemoData');
    expect(llms).toMatch(/Data status of this deployment: DEMO/);
    expect(llms).toMatch(/Do not cite any property or locality figure/);
  });

  it('robots keeps account surfaces out of every index, AI crawlers included', () => {
    expect(robots).toContain('/dashboard');
    expect(robots).toContain('/preferences');
    expect(robots).toContain('/api/');
    // The same disallow list is applied to the named crawlers, not just the
    // wildcard — a per-agent block that forgot it would be an exposure.
    expect(robots).toMatch(/AI_CRAWLERS\.map/);
    expect(robots).toMatch(/disallow: PRIVATE_PATHS/);
  });

  it('the sitemap still refuses to list demo-backed pages', () => {
    expect(sitemap).toContain('servesDemoData');
    expect(sitemap).toMatch(/dataStatus !== 'demo'/);
  });
});
