/**
 * Skill coverage matrix CI gate (v1.45.0.0 T1).
 *
 * Asserts every skill on disk has an entry in SKILL_COVERAGE with at
 * least one gate-tier test. The detailed per-skill structural checks
 * live in test/skill-coverage-floor.test.ts; this file is the matrix-
 * level gate that surfaces "skill added but eval not registered" cleanly.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { SKILL_COVERAGE, type SkillCoverage } from './skill-coverage-matrix';
import { skillCensus } from './helpers/skill-census';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

// Canonical walk (skill-census.ts). This file and skill-coverage-floor
// previously hand-rolled two DIFFERENT walks (one skipped node_modules/docs/
// test, one didn't) — exactly the divergence class the census exists to kill.
function discoverSkills(): string[] {
  return skillCensus(REPO_ROOT).authoredSkills;
}

describe('skill coverage matrix', () => {
  test('SKILL_COVERAGE is exported and non-empty', () => {
    expect(typeof SKILL_COVERAGE).toBe('object');
    expect(Object.keys(SKILL_COVERAGE).length).toBeGreaterThan(0);
  });

  test('every entry has the right shape', () => {
    const missingGate: string[] = [];
    for (const [skill, coverage] of Object.entries(SKILL_COVERAGE)) {
      expect(Array.isArray(coverage.gate)).toBe(true);
      expect(Array.isArray(coverage.periodic)).toBe(true);
      if (!coverage.gate || coverage.gate.length === 0) missingGate.push(skill);
      for (const p of [...coverage.gate, ...coverage.periodic]) {
        expect(typeof p).toBe('string');
        expect(p.startsWith('test/')).toBe(true);
        expect(p.endsWith('.test.ts')).toBe(true);
      }
    }
    if (missingGate.length > 0) {
      throw new Error(
        `Skills with no gate-tier eval: ${missingGate.join(', ')}. ` +
        `Eval-first foundation requires at least one CI-blocking check per skill.`,
      );
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
