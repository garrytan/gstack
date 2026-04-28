/**
 * Opus 4.7 model overlay — gate-tier assertions on the pacing directive.
 *
 * v1.6.4.0 regressed plan-review cadence because the Opus 4.7 overlay
 * carried a "Batch your questions" directive that physically rendered
 * above the skill-level pacing rule. Opus 4.7 read top-to-bottom,
 * absorbed batching as the ambient default, and stopped honoring the
 * plan-review STOP directives.
 *
 * v1.7.0.0 replaces that block with "Pace questions to the skill" —
 * one-question-at-a-time is now the default when the skill contains
 * STOP directives; batching becomes the explicit exception.
 *
 * This test asserts:
 * - The new "Pace questions" directive is present
 * - The old "Batch your questions" directive is gone
 * - The AUTO_DECIDE-compatible language survives (subordination, skill wins)
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

describe('Opus 4.7 overlay — pacing directive', () => {
  test('raw opus-4-7.md contains "Pace questions to the skill"', () => {
    const raw = fs.readFileSync(
      path.join(ROOT, 'model-overlays/opus-4-7.md'),
      'utf-8',
    );
    expect(raw).toContain('Pace questions to the skill');
  });

  test('raw opus-4-7.md does NOT contain "Batch your questions" directive', () => {
    const raw = fs.readFileSync(
      path.join(ROOT, 'model-overlays/opus-4-7.md'),
      'utf-8',
    );
    expect(raw).not.toContain('**Batch your questions.**');
  });

  test('resolved overlay output contains "Pace questions to the skill"', () => {
    const out = generateModelOverlay(makeCtx('opus-4-7'));
    expect(out).toContain('Pace questions to the skill');
  });

  test('resolved overlay inherits from claude base (INHERIT:claude)', () => {
    const out = generateModelOverlay(makeCtx('opus-4-7'));
    // The claude base contributes the subordination wrapper + Todo discipline
    expect(out).toContain('Todo-list discipline');
    expect(out).toContain('subordinate');
  });

  test('resolved overlay says skill STOP directives trigger one-per-turn pacing', () => {
    const out = generateModelOverlay(makeCtx('opus-4-7'));
    expect(out).toMatch(/STOP\. AskUserQuestion/);
    expect(out).toMatch(/pace one question per turn|one question per turn/i);
  });

  test('resolved overlay requires AskUserQuestion as tool_use', () => {
    const out = generateModelOverlay(makeCtx('opus-4-7'));
    expect(out).toContain('tool_use');
  });

  test('resolved overlay flags "obvious fix" findings still need user approval', () => {
    const out = generateModelOverlay(makeCtx('opus-4-7'));
    expect(out).toMatch(/obvious fix/i);
    expect(out).toMatch(/user approval/i);
  });

  test('resolved overlay keeps Effort-match / Literal interpretation nudges', () => {
    const out = generateModelOverlay(makeCtx('opus-4-7'));
    expect(out).toContain('Effort-match the step');
    expect(out).toContain('Literal interpretation awareness');
  });

  test('claude overlay (no INHERIT chain) does not carry the pacing directive', () => {
    // Claude is the default overlay; opus-4-7 inherits FROM claude.
    // The pacing directive belongs to opus-4-7 only.
    const out = generateModelOverlay(makeCtx('claude'));
    expect(out).not.toContain('Pace questions to the skill');
  });
});
