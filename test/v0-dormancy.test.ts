/**
 * V0 dormancy — negative tests.
 *
 * V1 keeps V0's psychographic machinery (5D dimensions + 8 archetypes + signal map)
 * in code but explicitly does not surface it in default-mode skill output. This test
 * enforces the maintenance boundary: if these strings ever appear in a generated
 * tier-≥2 SKILL.md's normal (default-mode) content, V0 machinery has leaked.
 *
 * Exceptions (explicitly allowed): SKILL.md files for skills that legitimately discuss
 * V0 machinery:
 *   - plan-tune/ — the conversational inspection skill for /plan-tune
 *   - office-hours/ — sets the declared profile
 * For these, V0 vocabulary is load-bearing and must appear.
 *
 * All other tier-≥2 skills: 5D dim names + archetype names must NOT appear.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const FORBIDDEN_5D_DIMS = [
  'scope_appetite',
  'risk_tolerance',
  'detail_preference',
  'architecture_care',
  // `autonomy` is too common a word to forbid in arbitrary skill output.
];

const FORBIDDEN_ARCHETYPE_NAMES = [
  'Cathedral Builder',
  'Ship-It Pragmatist',
  'Deep Craft',
  'Taste Maker',
  'Solo Operator',
  // `Consultant`, `Wedge Hunter`, `Builder-Coach` — some may appear in prose
  // naturally; check the strictly-V0-unique phrases first.
];

// Skills that legitimately reference V0 psychographic vocabulary.
const ALLOWED_SKILLS_WITH_V0_VOCAB = new Set([
  'plan-tune',
  'office-hours',
]);

function discoverTier2PlusSkillMds(): Array<{ skillName: string; mdPath: string }> {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });
  const results: Array<{ skillName: string; mdPath: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'test') continue;
    const mdPath = path.join(ROOT, e.name, 'SKILL.md');
    const tmplPath = path.join(ROOT, e.name, 'SKILL.md.tmpl');
    if (!fs.existsSync(mdPath) || !fs.existsSync(tmplPath)) continue;
    // Check tier via frontmatter
    const tmpl = fs.readFileSync(tmplPath, 'utf-8');
    const tierMatch = tmpl.match(/preamble-tier:\s*(\d+)/);
    const tier = tierMatch ? parseInt(tierMatch[1], 10) : 4;
    if (tier < 2) continue;
    results.push({ skillName: e.name, mdPath });
  }
  return results;
}

describe('V0 dormancy in default-mode skill output', () => {
  const skills = discoverTier2PlusSkillMds();

  for (const { skillName, mdPath } of skills) {
    if (ALLOWED_SKILLS_WITH_V0_VOCAB.has(skillName)) continue;

    test(`${skillName}/SKILL.md contains no V0 psychographic dimension names`, () => {
      const content = fs.readFileSync(mdPath, 'utf-8');
      for (const dim of FORBIDDEN_5D_DIMS) {
        expect(content).not.toContain(dim);
      }
    });

    test(`${skillName}/SKILL.md contains no V0 archetype names`, () => {
      const content = fs.readFileSync(mdPath, 'utf-8');
      for (const archetype of FORBIDDEN_ARCHETYPE_NAMES) {
        expect(content).not.toContain(archetype);
      }
    });
  }

  test('at least 5 tier-≥2 skills were checked (sanity)', () => {
    expect(skills.length).toBeGreaterThanOrEqual(5);
  });
});
