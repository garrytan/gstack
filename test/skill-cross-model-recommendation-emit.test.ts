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
  test('codex/SKILL.md.tmpl Step 2A (review) requires a synthesis Recommendation', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md.tmpl'), 'utf-8');
    const step2a = sliceBetween(tmpl, '## Step 2A:', '## Step 2B:');
    expect(step2a, 'Step 2A section not found in codex template').not.toBe('');
    expect(step2a).toMatch(/Synthesis recommendation \(REQUIRED\)/);
    expect(step2a).toMatch(/Recommendation:\s*<action>\s*because/);
  });

  test('codex/SKILL.md.tmpl Step 2B (challenge) requires a synthesis Recommendation', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md.tmpl'), 'utf-8');
    const step2b = sliceBetween(tmpl, '## Step 2B:', '## Step 2C:');
    expect(step2b, 'Step 2B section not found in codex template').not.toBe('');
    expect(step2b).toMatch(/Synthesis recommendation \(REQUIRED\)/);
    expect(step2b).toMatch(/Recommendation:\s*<action>\s*because/);
  });

  test('codex/SKILL.md.tmpl Step 2C (consult) requires a synthesis Recommendation', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md.tmpl'), 'utf-8');
    const step2c = sliceBetween(tmpl, '## Step 2C:', '## Model & Reasoning');
    expect(step2c, 'Step 2C section not found in codex template').not.toBe('');
    expect(step2c).toMatch(/Synthesis recommendation \(REQUIRED\)/);
    expect(step2c).toMatch(/Recommendation:\s*<action>\s*because/);
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
