/**
 * Static guard for cross-model synthesis recommendation emit instructions.
 *
 * v1.25.1.0+ extended the AskUserQuestion recommendation-quality coverage
 * to cross-model skills (/codex review/challenge/consult, the Claude
 * adversarial subagent, and the Codex adversarial pass). Each surface MUST
 * tell the model to end its synthesis with a canonical
 *   `Recommendation: <action> because <reason>`
 * line so judgeRecommendation can grade it (see test/llm-judge-recommendation
 * for the rubric exercise).
 *
 * Free, deterministic, single-purpose: if any contributor edits these
 * templates and removes the emit instruction, this test trips before the
 * change reaches a paid eval. The runtime grading still happens via
 * judgeRecommendation when the skills run for real; this test just pins the
 * source of truth.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('cross-model synthesis emit instructions', () => {
  // The three codex modes are carved into codex/sections/*-mode.md.tmpl (T9);
  // each mode section must still carry its own emit instruction so the rule is
  // in context when that (mutually exclusive) mode's section is loaded.
  const CODEX_MODE_SECTIONS: Array<[string, string]> = [
    ['review-mode.md.tmpl', '## Step 2A:'],
    ['challenge-mode.md.tmpl', '## Step 2B:'],
    ['consult-mode.md.tmpl', '## Step 2C:'],
  ];

  for (const [file, heading] of CODEX_MODE_SECTIONS) {
    test(`codex/sections/${file} requires a synthesis Recommendation`, () => {
      const tmpl = fs.readFileSync(path.join(ROOT, 'codex', 'sections', file), 'utf-8');
      expect(tmpl, `${file} lost its ${heading} heading`).toContain(heading);
      expect(tmpl).toMatch(/Synthesis recommendation \(REQUIRED\)/);
      expect(tmpl).toMatch(/Recommendation:\s*<action>\s*because/);
    });
  }

  test('codex/SKILL.md.tmpl skeleton keeps the always-loaded synthesis rule', () => {
    // The AUQ safety net (test/auq-format-always-loaded.test.ts) requires the
    // canonical rule in the ALWAYS-LOADED skeleton, not only in the on-demand
    // mode sections — a question can fire before any section is read.
    const tmpl = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md.tmpl'), 'utf-8');
    expect(tmpl).toMatch(/Synthesis recommendation \(REQUIRED\)/);
    expect(tmpl).toMatch(/Recommendation:\s*<action>\s*because/);
  });

  test('scripts/resolvers/review.ts Claude adversarial subagent prompt requires Recommendation', () => {
    const resolver = fs.readFileSync(path.join(ROOT, 'scripts', 'resolvers', 'review.ts'), 'utf-8');
    // The Claude subagent prompt must instruct the model to emit a final
    // canonical Recommendation line.
    expect(resolver).toMatch(/Claude adversarial subagent[\s\S]+?Recommendation:\s*<action>\s*because/);
  });

  test('scripts/resolvers/review.ts Codex adversarial command requires Recommendation', () => {
    const resolver = fs.readFileSync(path.join(ROOT, 'scripts', 'resolvers', 'review.ts'), 'utf-8');
    // The codex exec command's prompt string must include the emit
    // instruction. Match within the codex adversarial section.
    expect(resolver).toMatch(/Codex adversarial challenge[\s\S]+?Recommendation:\s*<action>\s*because/);
  });
});

function sliceBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  const end = text.indexOf(endMarker, start + startMarker.length);
  return end > start ? text.slice(start, end) : text.slice(start);
}
