/**
 * Section TemplateContext parity (v2 plan T9 / Codex consult absorbed-refinement #1).
 *
 * Section generation must use the SAME TemplateContext as the parent skill —
 * crucially the same skillName, so resolver `appliesTo` gating + tier behave
 * identically. If a section resolved with skillName "sections" (the bug
 * processSectionTemplate guards against), gated resolvers like ADVERSARIAL_STEP /
 * CONFIDENCE_CALIBRATION would render empty.
 *
 * We assert on the GENERATED section output: gated resolver content is present and
 * no placeholder is left unresolved. That can only be true if the parent ctx
 * (skillName=ship) drove the resolve.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SHIP_SECTIONS = path.join(ROOT, 'ship', 'sections');

function readSection(file: string): string {
  return fs.readFileSync(path.join(SHIP_SECTIONS, file), 'utf-8');
}

describe('section TemplateContext parity (skillName pinned to parent)', () => {
  test('no generated section has unresolved {{PLACEHOLDER}} tokens', () => {
    for (const md of fs.readdirSync(SHIP_SECTIONS).filter(f => f.endsWith('.md') && !f.endsWith('.md.tmpl'))) {
      const content = readSection(md);
      const unresolved = content.match(/\{\{[A-Z_]+(?::[^}]+)?\}\}/g);
      expect({ md, unresolved }).toEqual({ md, unresolved: null });
    }
  });

  test('adversarial section rendered the ADVERSARIAL_STEP resolver (proves ship ctx)', () => {
    const content = readSection('adversarial.md');
    // The codex filesystem-boundary line only appears when ADVERSARIAL_STEP resolves.
    expect(content).toContain('Do NOT read or execute any files under');
    expect(content.length).toBeGreaterThan(500);
  });

  test('review-army section rendered CONFIDENCE_CALIBRATION + REVIEW_ARMY (gated resolvers)', () => {
    const content = readSection('review-army.md');
    expect(content).toContain('Confidence Calibration');
    expect(content).toContain('confidence score');
  });

  test('tests section rendered TEST_BOOTSTRAP + TEST_FAILURE_TRIAGE', () => {
    const content = readSection('tests.md');
    expect(content).toContain('Test Failure Ownership Triage');
  });

  test('changelog section rendered CHANGELOG_WORKFLOW', () => {
    const content = readSection('changelog.md');
    expect(content).toContain('CHANGELOG');
    expect(content.length).toBeGreaterThan(300);
  });
});
