/**
 * Skill coverage floor — gate-tier, free, runs every PR.
 *
 * Phase 0 of the cathedral parity-eval suite: structural-compliance smoke
 * test that covers every gstack skill with file-IO assertions. The intent
 * is "every skill ships with at least one CI-blocking check" — even when
 * a skill doesn't (yet) have a behavioral E2E test, this floor catches
 * frontmatter regressions, missing generated header, empty/trivial bodies,
 * and dangling SKILL.md.tmpl-without-SKILL.md mismatches.
 *
 * Pairs with test/skill-coverage-matrix.ts (the registry) and
 * test/parity-suite.test.ts (the content-invariant suite). Together,
 * v1.45.0.0 ships with: floor (this file) + matrix (registry CI gate)
 * + invariants (content per skill family) + size budget. That's the
 * eval-first foundation the v2.0.0.0 sections/ work builds on.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { SKILL_COVERAGE } from './skill-coverage-matrix';
import { skillCensus } from './helpers/skill-census';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

function readSkillMd(skill: string): string | null {
  const p = path.join(REPO_ROOT, skill, 'SKILL.md');
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

// Registry-completeness assertions ("every skill on disk is registered",
// "every entry has a gate test") live in test/skill-coverage-matrix.test.ts —
// they were duplicated here with a DIFFERENT hand-rolled directory walk, which
// is the divergence class test/helpers/skill-census.ts exists to kill. This
// file owns the per-skill structural compliance checks only.

describe('skill-coverage-floor: every skill passes structural compliance', () => {
  const skills = skillCensus(REPO_ROOT).authoredSkills;

  test('every gate-tier test path referenced in registry exists on disk', () => {
    const missing: string[] = [];
    for (const [skill, coverage] of Object.entries(SKILL_COVERAGE)) {
      for (const testPath of [...coverage.gate, ...coverage.periodic]) {
        const fullPath = path.join(REPO_ROOT, testPath);
        if (!fs.existsSync(fullPath)) {
          missing.push(`${skill} → ${testPath}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(`Registry references missing test files:\n  ${missing.join('\n  ')}`);
    }
  });

  // Per-skill structural compliance (file IO only, no LLM)
  for (const skill of skills) {
    describe(`skill: ${skill}`, () => {
      test('SKILL.md exists', () => {
        const content = readSkillMd(skill);
        expect(content).not.toBeNull();
      });

      test('frontmatter is well-formed and contains name + description', () => {
        const content = readSkillMd(skill)!;
        expect(content.startsWith('---\n')).toBe(true);
        const fmEnd = content.indexOf('\n---', 4);
        expect(fmEnd).toBeGreaterThan(0);
        const fm = content.slice(4, fmEnd);
        // name: ...
        expect(/^name:\s*\S/m.test(fm)).toBe(true);
        // description: ... (either inline or block form)
        expect(/^description:\s*(\S|\|)/m.test(fm)).toBe(true);
      });

      test('frontmatter description fits the catalog-trim contract', () => {
        const content = readSkillMd(skill)!;
        const fmEnd = content.indexOf('\n---', 4);
        const fm = content.slice(4, fmEnd);
        // Inline form: description: <one line>
        const inlineMatch = fm.match(/^description:\s+(.+)$/m);
        // Block form: description: |\n  multiline
        const blockMatch = fm.match(/^description:\s*\|/m);
        if (inlineMatch) {
          // Catalog-trimmed: should be ≤ 250 chars
          expect(inlineMatch[1].length).toBeLessThanOrEqual(250);
        } else if (blockMatch) {
          // Block form is acceptable for small skills (under-120-chars baseline
          // didn't trigger catalog trim). No size cap here; the parity-suite
          // and size-budget tests handle bytes.
        } else {
          throw new Error(`${skill}: description field is not in inline or block form`);
        }
      });

      test('generated header present (only edit .tmpl, not .md)', () => {
        const content = readSkillMd(skill)!;
        expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
      });

      test('body is non-trivial (≥ 200 bytes after frontmatter)', () => {
        const content = readSkillMd(skill)!;
        const fmEnd = content.indexOf('\n---', 4);
        const body = content.slice(fmEnd + 5).trim();
        expect(body.length).toBeGreaterThanOrEqual(200);
      });

      test('no unresolved {{TEMPLATE}} placeholders leaked into output', () => {
        const content = readSkillMd(skill)!;
        const leaks = content.match(/\{\{[A-Z_]+(?::[^}]+)?\}\}/g);
        if (leaks) {
          throw new Error(
            `${skill}: ${leaks.length} unresolved placeholder(s) in generated SKILL.md: ${leaks.slice(0, 3).join(', ')}${leaks.length > 3 ? ', ...' : ''}`,
          );
        }
      });
    });
  }
});
