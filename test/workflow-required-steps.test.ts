/**
 * Required workflow steps (C1 follow-up, 2026-10-04). The qa workflow judge
 * passed a /qa bundle with "Phase 10: Report" removed and the review judge
 * passed /review with "Step 3: Get the diff" removed, so the judges do not
 * cover a missing step. This deterministic check does: every pinned step or
 * phase heading of the judged workflow skills must still be in the generated
 * SKILL.md or section file, in order. The pinned list was derived from the
 * templates' step headings; a new step heading must be added to it.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const PINNED = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'workflow-required-steps.json'), 'utf8')) as {
  skills: Record<string, Record<string, string[]>>;
};
const STEP = /^#{2,4} (?:(?:Step|Phase|Section) \d+[A-Za-z0-9.]*|Phases \d+-\d+|\d+[A-Za-z]?(?:\.\d+)?\.)[ :].*$/;

/** Heading lines outside code fences. */
function headings(text: string): string[] {
  let fence = false;
  return text.split('\n').flatMap(line => {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return []; }
    return !fence && /^#{2,4} /.test(line) ? [line.trim()] : [];
  });
}

/** Missing or out-of-order required steps, each named. */
function missingSteps(skill: string, file: string, text: string, required: readonly string[]): string[] {
  const found = headings(text);
  const problems: string[] = [];
  let last = -1;
  for (const step of required) {
    const at = found.indexOf(step, last + 1);
    if (at < 0) problems.push(found.includes(step) ? `${skill}/${file}: step out of order: "${step}"` : `${skill}/${file}: missing required step "${step}"`);
    else last = at;
  }
  return problems;
}

const read = (skill: string, file: string) => fs.readFileSync(path.join(ROOT, skill, file), 'utf8');

describe('judged workflow skills keep their required steps', () => {
  for (const [skill, files] of Object.entries(PINNED.skills)) {
    test(`${skill}: every pinned step is present in order`, () => {
      const problems = Object.entries(files).flatMap(([file, steps]) => missingSteps(skill, file, read(skill, file), steps));
      expect(problems).toEqual([]);
    });

    test(`${skill}: every step heading is pinned`, () => {
      const pinnedFiles = new Set(Object.keys(files));
      const sectionFiles = fs.existsSync(path.join(ROOT, skill, 'sections'))
        ? fs.readdirSync(path.join(ROOT, skill, 'sections')).filter(f => f.endsWith('.md')).map(f => `sections/${f}`) : [];
      const unpinned = ['SKILL.md', ...sectionFiles].flatMap(file => headings(read(skill, file))
        .filter(h => STEP.test(h) && !(pinnedFiles.has(file) && files[file]!.includes(h)))
        .map(h => `${skill}/${file}: "${h}" (add it to test/fixtures/workflow-required-steps.json)`));
      expect(unpinned).toEqual([]);
    });
  }

  test('the C1 control defects are reported by step name', () => {
    const qa = read('qa', 'SKILL.md');
    expect(missingSteps('qa', 'SKILL.md', qa.replace('## Phase 10: Report', '## Report'), PINNED.skills.qa!['SKILL.md']!))
      .toEqual(['qa/SKILL.md: missing required step "## Phase 10: Report"']);
    const review = read('review', 'SKILL.md');
    expect(missingSteps('review', 'SKILL.md', review.replace(/^## Step 3: Get the diff$/m, ''), PINNED.skills.review!['SKILL.md']!))
      .toEqual(['review/SKILL.md: missing required step "## Step 3: Get the diff"']);
    const fenced = review.replace(/^(## Step 3: Get the diff)$/m, '```\n$1\n```');
    expect(missingSteps('review', 'SKILL.md', fenced, PINNED.skills.review!['SKILL.md']!)).toHaveLength(1);
  });
});
