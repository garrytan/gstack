/**
 * cso security-guidance preservation test (v1.45.0.0 T6).
 *
 * The cso skill carries load-bearing security prose: OWASP Top 10 mappings,
 * STRIDE threat-model phrasing, "do not auto-fix without user approval"
 * gates. Codex 2nd-pass critique #9: "cso exemption too broad ... should
 * still get resolver dedup, catalog trim, sectioning if safe, and targeted
 * evals around must-not-miss checks."
 *
 * This test pins the must-not-miss checks. cso gets the same resolver gate
 * (T2), jargon dedup (T3), and catalog trim (T4) as every other skill — but
 * its security-guidance body content stays intact. Future compression work
 * that would strip this content fails CI here.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const CSO_SKILL = path.join(REPO_ROOT, 'cso', 'SKILL.md');

const MUST_PRESERVE_PHRASES = [
  // OWASP / STRIDE positioning
  'OWASP',
  'STRIDE',
  // Mode discipline
  'daily',
  'comprehensive',
  // Severity language
  'confidence',
  // Active verification requirement (codex critique: "active verification")
  'verif', // covers "verify", "verification", "verified"
];

const MUST_PRESERVE_HEADINGS = [
  '## Preamble',  // from PREAMBLE resolver
];

describe('cso skill preserves load-bearing security guidance', () => {
  test('cso/SKILL.md exists and is non-trivial', () => {
    expect(fs.existsSync(CSO_SKILL)).toBe(true);
    const content = fs.readFileSync(CSO_SKILL, 'utf-8');
    // cso is a content-heavy security skill; under 30 KB suggests stripping went too far.
    expect(content.length).toBeGreaterThan(30_000);
  });

  test('cso preserves required security phrases (case-insensitive)', () => {
    const content = fs.readFileSync(CSO_SKILL, 'utf-8').toLowerCase();
    const missing: string[] = [];
    for (const phrase of MUST_PRESERVE_PHRASES) {
      if (!content.includes(phrase.toLowerCase())) missing.push(phrase);
    }
    if (missing.length > 0) {
      throw new Error(
        `cso/SKILL.md is missing required security phrases: ${missing.join(', ')}. ` +
        `These are load-bearing for the skill's audit posture. If you intentionally ` +
        `removed them, update this test with the new phrasing.`,
      );
    }
  });

  test('cso preserves required headings', () => {
    const content = fs.readFileSync(CSO_SKILL, 'utf-8');
    for (const heading of MUST_PRESERVE_HEADINGS) {
      expect(content).toContain(heading);
    }
  });

  test('cso catalog trim landed (frontmatter description ≤ 200 chars)', () => {
    const content = fs.readFileSync(CSO_SKILL, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const fm = fmMatch![1];
    const descMatch = fm.match(/^description:\s+(.+)$/m);
    expect(descMatch).not.toBeNull();
    const desc = descMatch![1].trim();
    expect(desc.length).toBeLessThanOrEqual(200);
    expect(desc).toContain('(gstack)');
  });

  test('cso routing prose moved to "## When to invoke" body section', () => {
    const content = fs.readFileSync(CSO_SKILL, 'utf-8');
    expect(content).toContain('## When to invoke this skill');
  });
});
