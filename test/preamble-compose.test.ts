/**
 * Preamble composition order — gate-tier test.
 *
 * Asserts that the AskUserQuestion Format section renders BEFORE the
 * Model-Specific Behavioral Patch section in tier-≥2 preamble output.
 * This order is load-bearing: Opus 4.7 reads top-to-bottom and absorbs
 * the first pacing directive it hits. v1.6.4.0 regressed plan-review
 * cadence because the overlay rendered first with "Batch your questions"
 * as the ambient default.
 *
 * If someone later reorders `scripts/resolvers/preamble.ts` so Overlay
 * comes before Format, this test catches it before the next model
 * migration can silently re-break the plan-review pacing.
 */
import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generatePreamble } from '../scripts/resolvers/preamble';

function makeCtx(
  host: 'claude' | 'codex',
  tier: 1 | 2 | 3 | 4,
  model?: string,
): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host,
    paths: HOST_PATHS[host],
    preambleTier: tier,
    ...(model ? { model } : {}),
  };
}

describe('Preamble composition order', () => {
  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (tier 2, claude)', () => {
    const out = generatePreamble(makeCtx('claude', 2, 'claude'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (tier 2, opus-4-7)', () => {
    const out = generatePreamble(makeCtx('claude', 2, 'opus-4-7'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (tier 3)', () => {
    const out = generatePreamble(makeCtx('claude', 3, 'opus-4-7'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('AskUserQuestion Format renders before Model-Specific Behavioral Patch (codex host)', () => {
    const out = generatePreamble(makeCtx('codex', 2, 'opus-4-7'));
    const formatIdx = out.indexOf('## AskUserQuestion Format');
    const overlayIdx = out.indexOf('## Model-Specific Behavioral Patch');
    expect(formatIdx).toBeLessThan(overlayIdx);
  });

  test('tier 1 preamble does NOT include AskUserQuestion Format (but MAY include overlay)', () => {
    const out = generatePreamble(makeCtx('claude', 1));
    expect(out).not.toContain('## AskUserQuestion Format');
  });
});
