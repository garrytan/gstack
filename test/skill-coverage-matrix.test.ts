/**
 * Skill coverage matrix CI gate (v1.45.0.0 T1).
 *
 * Asserts every skill on disk has an entry in SKILL_COVERAGE with at
 * least one gate-tier test. The detailed per-skill structural checks
 * live in test/skill-coverage-floor.test.ts; this file is the matrix-
 * level gate that surfaces "skill added but eval not registered" cleanly.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { SKILL_COVERAGE, type SkillCoverage } from './skill-coverage-matrix';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

function discoverSkills(): string[] {
  return fs.readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .filter(e => fs.existsSync(path.join(REPO_ROOT, e.name, 'SKILL.md')))
    .map(e => e.name)
    .sort();
}

describe('skill coverage matrix', () => {
  test('SKILL_COVERAGE is exported and non-empty', () => {
    expect(typeof SKILL_COVERAGE).toBe('object');
    expect(Object.keys(SKILL_COVERAGE).length).toBeGreaterThan(0);
  });

  test('every entry has the right shape', () => {
    for (const [skill, coverage] of Object.entries(SKILL_COVERAGE)) {
      expect(Array.isArray(coverage.gate)).toBe(true);
      expect(Array.isArray(coverage.periodic)).toBe(true);
      expect(coverage.gate.length).toBeGreaterThan(0);
      for (const p of [...coverage.gate, ...coverage.periodic]) {
        expect(typeof p).toBe('string');
        expect(p.startsWith('test/')).toBe(true);
        expect(p.endsWith('.test.ts')).toBe(true);
      }
    }
  });

  test('every skill on disk has a registry entry', () => {
    const skills = discoverSkills();
    const missing: string[] = [];
    for (const s of skills) {
      if (!SKILL_COVERAGE[s]) missing.push(s);
    }
    if (missing.length > 0) {
      throw new Error(
        `Skills on disk missing from SKILL_COVERAGE: ${missing.join(', ')}. ` +
        `Add an entry to test/skill-coverage-matrix.ts with at least ` +
        `'test/skill-coverage-floor.test.ts' in gate[].`,
      );
    }
  });

  test('no registry entry references a skill that does not exist on disk', () => {
    const skills = new Set(discoverSkills());
    const orphans: string[] = [];
    for (const skill of Object.keys(SKILL_COVERAGE)) {
      if (!skills.has(skill)) orphans.push(skill);
    }
    if (orphans.length > 0) {
      throw new Error(
        `Registry references skills not on disk: ${orphans.join(', ')}. ` +
        `Remove from SKILL_COVERAGE or restore the skill directory.`,
      );
    }
  });
});
