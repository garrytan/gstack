/**
 * Pins the three-count contract of test/helpers/skill-census.ts (C11).
 *
 * No hardcoded totals here — the catalog-budget test owns the ratchet.
 * This file pins the STRUCTURAL relationships that make the three counts
 * mean different things, using the live repo as the fixture.
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { frontmatterName, skillCensus } from './helpers/skill-census';

const ROOT = path.resolve(import.meta.path, '..', '..');
const census = skillCensus(ROOT);

describe('skillCensus', () => {
  it('physicalSkillFiles includes the root router and authored skill dirs', () => {
    expect(census.physicalSkillFiles).toContain('SKILL.md');
    expect(census.physicalSkillFiles).toContain('qa/SKILL.md');
    expect(census.physicalSkillFiles).toContain('browse/SKILL.md');
  });

  it('authoredSkills lists real skill dirs and excludes the root router', () => {
    expect(census.authoredSkills).toContain('qa');
    expect(census.authoredSkills).toContain('browse');
    // Root router is not an authored skill; its dir entry would be '' anyway.
    for (const name of census.authoredSkills) expect(name.length).toBeGreaterThan(0);
  });

  it('registryEntries carries the root alias and collapses shared frontmatter names', () => {
    expect(census.registryEntries).toContain('_gstack-command');
    expect(
      census.registryEntries.filter((n) => n === 'browse'),
    ).toHaveLength(1);
  });

  it('count relationships hold: physical = authored + root + symlink dups', () => {
    const symlinkDups = census.physicalSkillFiles.length - 1 - census.authoredSkills.length;
    expect(symlinkDups).toBeGreaterThanOrEqual(0); // no alias dir symlinks since the Aside consolidation retired connect-chrome
    // Registry = unique frontmatter names + root alias. It can only collapse
    // entries relative to physical, never invent them.
    expect(census.registryEntries.length).toBeLessThanOrEqual(census.physicalSkillFiles.length);
    expect(census.registryEntries.length).toBeGreaterThan(census.authoredSkills.length - 1);
  });

  it('frontmatterName mirrors setup: first ^name: line, whitespace stripped', () => {
    const qa = frontmatterName(path.join(ROOT, 'qa', 'SKILL.md'));
    expect(qa).toBe('qa');
    const browse = frontmatterName(path.join(ROOT, 'browse', 'SKILL.md'));
    expect(browse).toBe('browse');
    expect(frontmatterName(path.join(ROOT, 'no-such-dir', 'SKILL.md'))).toBe('');
  });

  it('every registry entry a host would see resolves back to a physical SKILL.md', () => {
    const names = new Set(
      census.physicalSkillFiles
        .filter((p) => p !== 'SKILL.md')
        .map((p) => frontmatterName(path.join(ROOT, p)) || path.dirname(p)),
    );
    for (const entry of census.registryEntries) {
      if (entry === '_gstack-command') {
        expect(fs.existsSync(path.join(ROOT, 'SKILL.md'))).toBe(true);
      } else {
        expect(names.has(entry)).toBe(true);
      }
    }
  });
});
