/**
 * Section manifest ↔ filesystem consistency (v2 plan T9 / Phase C orphan check).
 *
 * Implements the 3-tier orphan classification from v2_PLAN.md:
 *  - generated orphan  (sections/X.md with no sections/X.md.tmpl)  → FAIL
 *  - hand-edited generated file (X.md missing the AUTO-GENERATED header) → FAIL
 *  - manifest orphan   (sections/X.md.tmpl not listed in manifest)  → WARN (v2.0)
 *
 * Also pins the PASSIVE-manifest contract (CM2 / v2_PLAN.md:663): manifest entries
 * carry only id/file/title/trigger — no machine predicate (applies_when/required_for).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SHIP_SECTIONS = path.join(ROOT, 'ship', 'sections');
const manifest = JSON.parse(fs.readFileSync(path.join(SHIP_SECTIONS, 'manifest.json'), 'utf-8'));

const sectionTmpls = fs.readdirSync(SHIP_SECTIONS).filter(f => f.endsWith('.md.tmpl'));
const sectionMds = fs.readdirSync(SHIP_SECTIONS).filter(f => f.endsWith('.md') && !f.endsWith('.md.tmpl'));

describe('section manifest ↔ filesystem consistency', () => {
  test('manifest parses with skill + sections array', () => {
    expect(manifest.skill).toBe('ship');
    expect(Array.isArray(manifest.sections)).toBe(true);
    expect(manifest.sections.length).toBeGreaterThan(0);
  });

  test('every manifest entry has a .md.tmpl source AND a generated .md', () => {
    for (const s of manifest.sections) {
      expect(fs.existsSync(path.join(SHIP_SECTIONS, `${s.file}.tmpl`))).toBe(true);
      expect(fs.existsSync(path.join(SHIP_SECTIONS, s.file))).toBe(true);
    }
  });

  test('manifest is PASSIVE — no applies_when / required_for predicate (CM2)', () => {
    for (const s of manifest.sections) {
      expect(s).not.toHaveProperty('applies_when');
      expect(s).not.toHaveProperty('required_for');
      // The allowed passive shape:
      expect(typeof s.id).toBe('string');
      expect(typeof s.file).toBe('string');
      expect(typeof s.title).toBe('string');
      expect(typeof s.trigger).toBe('string');
    }
  });

  test('no generated orphan: every sections/X.md has a sections/X.md.tmpl → FAIL', () => {
    const orphans = sectionMds.filter(md => !sectionTmpls.includes(`${md}.tmpl`));
    expect(orphans).toEqual([]);
  });

  test('no hand-edited generated file: every sections/X.md has the AUTO-GENERATED header → FAIL', () => {
    for (const md of sectionMds) {
      const head = fs.readFileSync(path.join(SHIP_SECTIONS, md), 'utf-8').slice(0, 120);
      expect(head).toContain('AUTO-GENERATED');
    }
  });

  test('manifest orphan check (WARN in v2.0): every .md.tmpl is listed', () => {
    const listed = new Set(manifest.sections.map((s: { file: string }) => `${s.file}.tmpl`));
    const unlisted = sectionTmpls.filter(t => !listed.has(t));
    if (unlisted.length > 0) {
      // v2_PLAN.md: WARN now, FAIL in v2.1. Surface, don't fail the build yet.
      // eslint-disable-next-line no-console
      console.warn(`[section-manifest] manifest orphan(s) (not in manifest.json): ${unlisted.join(', ')}`);
    }
    expect(unlisted.length).toBeLessThanOrEqual(unlisted.length); // always passes; WARN only
  });

  test('section ids are unique', () => {
    const ids = manifest.sections.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
