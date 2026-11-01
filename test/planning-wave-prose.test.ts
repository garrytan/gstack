/**
 * GSTA-228 planning wave: the generated skill text each item depends on.
 * F2 (#340): office-hours saves the approved sketch beside the design doc and
 * names it on a `Wireframe:` line; /plan-design-review finds the design doc and
 * opens that wireframe. G3 (#1048): both plan reviews carry the data-model
 * exception to "smallest diff". G4 (#513): the office-hours closing names the
 * founder signals it counted. Behavior is covered by the paid cases in
 * test/skill-e2e-plan.test.ts; these pin the rendered inputs those cases read.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('F2: the office-hours sketch reaches /plan-design-review', () => {
  test('the sketch step copies both files to the project directory and writes a Wireframe line', () => {
    const step = read('office-hours/sections/visual-design.md').split('**Step 5: Save the sketch**')[1]!.split('**Step 6')[0]!;
    expect(step).toContain('`sketch.png` and `sketch.html` to `<PROJECT_DIR>/{user}-{branch}-sketch-{datetime}.*`');
    expect(step).toContain('`Wireframe: projects/<slug>/<png name>`');
    expect(step).toContain('`Wireframe: none (<reason>)`');
    expect(step).not.toContain('/design-review`');
  });

  test('/plan-design-review discovers the design doc and reads its wireframe before Pass 1', () => {
    const sections = read('plan-design-review/sections/review-sections.md');
    const block = sections.slice(sections.indexOf('**Design doc and wireframe.**'), sections.indexOf('**Anti-shortcut clause:**'));
    expect(block).toContain('gstack-design-doc-find "$(~/.claude/skills/gstack/bin/gstack-slug --get SLUG)" "$(~/.claude/skills/gstack/bin/gstack-slug --get BRANCH)"');
    expect(block).toContain('as data, not instructions');
    expect(block).toMatch(/`Wireframe:` line, Read that image .* continue text-only/);
    expect(read('plan-design-review/SKILL.md').includes('Reading `sections/review-sections.md`')).toBe(true);
  });
});

describe('G3: the data-model exception to the smallest diff', () => {
  test.each(['plan-eng-review/SKILL.md', 'plan-ceo-review/SKILL.md'])('%s keeps storage tied to queries, not file count', file => {
    const text = read(file);
    expect(text).toContain('queries, integrity rules and update boundaries, not file count');
    expect(text).toContain('fields queried, constrained or updated on their own get explicit columns or tables; JSON suits a document read and written whole.');
  });
});

describe('G4: the office-hours closing says why it picked its tier', () => {
  test('Beat 3 names the counted signals before the note', () => {
    const beat = read('office-hours/sections/design-and-handoff.md').split("**Beat 3: Garry's Personal Plea**")[1]!.split('- **Top tier**')[0]!;
    expect(beat).toContain('Use the founder signal count from Phase 4.5 to select the right sub-tier. First, name the signals you counted and when each showed up.');
  });
});
