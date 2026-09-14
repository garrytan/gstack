/**
 * Unit coverage for discoverSectionTemplates — the section-discovery half of the
 * v2 plan T9 pipeline. Drives it against a temp fixture tree so it doesn't
 * depend on which skills have been carved in the real repo.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverSectionTemplates } from '../scripts/discover-skills';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sections-disc-'));
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } });

// ship/ has two section templates + a non-template file; review/ has none;
// hidden + node_modules dirs must be skipped by the shared subdirs() filter.
fs.mkdirSync(path.join(root, 'ship', 'sections'), { recursive: true });
fs.writeFileSync(path.join(root, 'ship', 'SKILL.md.tmpl'), '---\nname: ship\n---\nbody');
fs.writeFileSync(path.join(root, 'ship', 'sections', 'version-bump.md.tmpl'), 'bump');
fs.writeFileSync(path.join(root, 'ship', 'sections', 'changelog.md.tmpl'), 'changelog');
fs.writeFileSync(path.join(root, 'ship', 'sections', 'manifest.json'), '{}'); // not a .md.tmpl
fs.mkdirSync(path.join(root, 'review'), { recursive: true });
fs.writeFileSync(path.join(root, 'review', 'SKILL.md.tmpl'), '---\nname: review\n---\nbody');
fs.mkdirSync(path.join(root, 'node_modules', 'sections'), { recursive: true });
fs.writeFileSync(path.join(root, 'node_modules', 'sections', 'x.md.tmpl'), 'nope');

describe('discoverSectionTemplates', () => {
  const found = discoverSectionTemplates(root);

  test('finds only *.md.tmpl files inside <skill>/sections/', () => {
    expect(found.map(f => f.tmpl)).toEqual([
      'ship/sections/changelog.md.tmpl',
      'ship/sections/version-bump.md.tmpl',
    ]);
  });

  test('strips .tmpl for the output path and records the owning skill dir', () => {
    const bump = found.find(f => f.tmpl.endsWith('version-bump.md.tmpl'))!;
    expect(bump.output).toBe('ship/sections/version-bump.md');
    expect(bump.skillDir).toBe('ship');
  });

  test('ignores non-template files (manifest.json) and skipped dirs (node_modules)', () => {
    expect(found.some(f => f.tmpl.includes('manifest.json'))).toBe(false);
    expect(found.some(f => f.tmpl.includes('node_modules'))).toBe(false);
  });

  test('returns deterministic (sorted) order', () => {
    const tmpls = found.map(f => f.tmpl);
    expect([...tmpls].sort()).toEqual(tmpls);
  });

  test('skills without a sections/ dir contribute nothing', () => {
    expect(found.some(f => f.skillDir === 'review')).toBe(false);
  });
});
