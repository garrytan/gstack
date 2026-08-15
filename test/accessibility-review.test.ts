import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { validateSkill } from './helpers/skill-parser';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_PATH = path.join(ROOT, 'accessibility-review', 'SKILL.md');

function readSkill(): string {
  return fs.readFileSync(SKILL_PATH, 'utf-8');
}

describe('accessibility-review skill', () => {
  test('uses valid browse commands and snapshot flags', () => {
    const result = validateSkill(SKILL_PATH);
    expect(result.invalid).toHaveLength(0);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('targets WCAG 2.2 AA and requires manual verification', () => {
    const skill = readSkill();
    expect(skill).toContain('WCAG 2.2 Level AA');
    expect(skill).toContain('Never claim WCAG conformance from automated checks alone.');
    expect(skill).toContain('Verify every automated candidate manually before reporting it.');
  });

  test('supports report-only mode without edits', () => {
    const skill = readSkill();
    expect(skill).toContain('Skip this phase entirely in `--report-only` mode.');
    expect(skill).toContain('In report-only mode, do not edit source code or tests.');
  });

  test('covers keyboard, semantics, and visual accessibility', () => {
    const skill = readSkill();
    expect(skill).toContain('## Phase 3: Keyboard and Focus Testing');
    expect(skill).toContain('## Phase 4: Screen-Reader Semantics');
    expect(skill).toContain('## Phase 5: Visual, Responsive, and Cognitive Checks');
  });
});
