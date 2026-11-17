/**
 * The office-hours founder-resource pool moved out of the prompt into
 * lib/founder-resources.ts, served by bin/gstack-founder-resources. These
 * pins prove the lookup returns exactly what the prompt carried and that the
 * closing still dedups and stops when every resource has been shown.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { FOUNDER_RESOURCES, renderChosen, renderIndex, renderPool, resourceUrl } from '../lib/founder-resources';

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'founder-resources-pool.txt'), 'utf-8');
const SECTION = fs.readFileSync(path.join(ROOT, 'office-hours', 'sections', 'design-and-handoff.md'), 'utf-8');

describe('founder-resource pool', () => {
  test('renders byte-for-byte the pool the prompt carried inline', () => {
    expect(renderPool()).toBe(FIXTURE);
  });

  test('ids run 1..34 and every URL is distinct', () => {
    expect(FOUNDER_RESOURCES.map(r => r.id)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
    expect(new Set(FOUNDER_RESOURCES.map(resourceUrl)).size).toBe(34);
  });

  test('index leaves out shown URLs and counts only pool hits', () => {
    const shown = [resourceUrl(FOUNDER_RESOURCES[0]!), 'https://not-in-pool.example'];
    const out = renderIndex(shown);
    expect(out).toContain('RESOURCES_SHOWN_COUNT: 1');
    expect(out).toContain('RESOURCES: 33 not yet shown');
    expect(out).not.toMatch(/^1\. /m);
    expect(out).toMatch(/^2\. \[GARRY TAN VIDEOS\] "Unconventional Advice for Founders" \(48 min, Stanford\)$/m);
    expect(out).not.toContain('https://');
  });

  test('index says exhausted once every resource has been shown', () => {
    const out = renderIndex(FOUNDER_RESOURCES.map(resourceUrl));
    expect(out).toContain('RESOURCES_SHOWN_COUNT: 34');
    expect(out.trim().endsWith('RESOURCES: exhausted')).toBe(true);
  });

  test('show prints the chosen entries in full and names unknown ids', () => {
    const { text, unknown } = renderChosen([25, 2, 99]);
    expect(unknown).toEqual([99]);
    expect(text).toBe(renderPool([FOUNDER_RESOURCES[1]!, FOUNDER_RESOURCES[24]!]));
    expect(text).toContain('https://paulgraham.com/greatwork.html');
  });
});

describe('office-hours closing uses the lookup', () => {
  test('the pool is no longer inlined in the generated section', () => {
    for (const r of FOUNDER_RESOURCES) expect(SECTION).not.toContain(resourceUrl(r));
  });

  test('opt-out check, then index, then show', () => {
    const gate = SECTION.indexOf('gstack-config get founder_resources');
    const index = SECTION.indexOf('gstack-founder-resources index');
    const show = SECTION.indexOf('gstack-founder-resources show');
    expect(gate).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(gate);
    expect(show).toBeGreaterThan(index);
    expect(SECTION).toContain('RESOURCES: exhausted');
  });
});
