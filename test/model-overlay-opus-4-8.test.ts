/**
 * Opus 4.8 model overlay — gate-tier assertions on the pacing directive.
 *
 * opus-4-8 mirrors opus-4-7's Opus-4.x family nudges: it inherits the claude
 * base and adds effort-matching, skill-paced questions (one-per-turn when the
 * skill carries STOP directives), and complete-scope literal execution.
 *
 * This test asserts:
 * - The "Pace questions to the skill" directive is present
 * - The old "Batch your questions" directive is absent
 * - The AUTO_DECIDE-compatible language survives (subordination, skill wins)
 * - The claude base is inherited (INHERIT:claude)
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateModelOverlay } from '../scripts/resolvers/model-overlay';

function makeCtx(model: string): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 2,
    model,
  };
}

const ROOT = path.resolve(__dirname, '..');

describe('Opus 4.8 overlay — pacing directive', () => {
  test('raw opus-4-8.md contains "Pace questions to the skill"', () => {
    const raw = fs.readFileSync(
      path.join(ROOT, 'model-overlays/opus-4-8.md'),
      'utf-8',
    );
    expect(raw).toContain('Pace questions to the skill');
  });

  test('raw opus-4-8.md does NOT contain "Batch your questions" directive', () => {
    const raw = fs.readFileSync(
      path.join(ROOT, 'model-overlays/opus-4-8.md'),
      'utf-8',
    );
    expect(raw).not.toContain('**Batch your questions.**');
  });

  test('resolved overlay output contains "Pace questions to the skill"', () => {
    const out = generateModelOverlay(makeCtx('opus-4-8'));
    expect(out).toContain('Pace questions to the skill');
  });

  test('resolved overlay inherits from claude base (INHERIT:claude)', () => {
    const out = generateModelOverlay(makeCtx('opus-4-8'));
    // The claude base contributes the subordination wrapper + Todo discipline
    expect(out).toContain('Todo-list discipline');
    expect(out).toContain('subordinate');
  });

  test('resolved overlay says skill STOP directives trigger one-per-turn pacing', () => {
    const out = generateModelOverlay(makeCtx('opus-4-8'));
    expect(out).toMatch(/STOP\. AskUserQuestion/);
    expect(out).toMatch(/pace one question per turn|one question per turn/i);
  });

  test('resolved overlay requires AskUserQuestion as tool_use', () => {
    const out = generateModelOverlay(makeCtx('opus-4-8'));
    expect(out).toContain('tool_use');
  });

  test('resolved overlay flags "obvious fix" findings still need user approval', () => {
    const out = generateModelOverlay(makeCtx('opus-4-8'));
    expect(out).toMatch(/obvious fix/i);
    expect(out).toMatch(/user approval/i);
  });

  test('resolved overlay keeps Effort-match / Literal interpretation nudges', () => {
    const out = generateModelOverlay(makeCtx('opus-4-8'));
    expect(out).toContain('Effort-match the step');
    expect(out).toContain('Literal interpretation awareness');
  });

  test('claude overlay (no INHERIT chain) does not carry the pacing directive', () => {
    // Claude is the default overlay; opus-4-8 inherits FROM claude.
    // The pacing directive belongs to the opus-4-x overlays only.
    const out = generateModelOverlay(makeCtx('claude'));
    expect(out).not.toContain('Pace questions to the skill');
  });
});
