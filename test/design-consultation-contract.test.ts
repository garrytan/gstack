import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateDesignOutsideVoices, generateOverusedFonts, generateDesignShotgunLoop } from '../scripts/resolvers/design';
import { outsideVoiceInvocation } from '../scripts/resolvers/outside-voice';
import { validateOutsideReview } from '../lib/outside-review-result';

const context = (host: string, skillName = 'design-consultation'): TemplateContext => ({ host, skillName, tmplPath: `${skillName}/SKILL.md.tmpl`, paths: HOST_PATHS[host] });
for (const { name: host } of ALL_HOST_CONFIGS) {
  test(`${host}: proposal prompt requests the same completion marker that dispatch validates`, () => {
    const text = generateDesignOutsideVoices(context(host));
    const prompt = text.match(/"(Given this product context, propose a complete design direction:[\s\S]*?)"\n/)!;
    expect(prompt).not.toBeNull();
    expect(prompt[1]).toContain('Recommendation: <direction> because <product-specific reason>');
    expect(validateOutsideReview('Recommendation: use a compact triage table because operators compare many incident rows.', 'review').completed).toBe(true);
    expect(validateOutsideReview('A compact table sounds nice.', 'review').completed).toBe(false);
    const preparation = outsideVoiceInvocation(context(host), { timeoutMs: 300000, purpose: 'design-direction' });
    expect(preparation).toContain('missing Recommendation marker');
    expect(preparation).not.toMatch(/severity|no.findings|clean\/PASS/i);
    expect(text).toContain('outside_status="unavailable"');
    expect(text).toContain('If a voice did not complete, omit the source field');
    expect(text).toContain('every completed proposal (two, one, or none)');
  });
}

test('creative wording leaves the review and scoring gates intact', () => {
  const ctx = context('codex');
  expect(outsideVoiceInvocation(ctx, { timeoutMs: 300000 })).toContain('explicit no-findings rationale');
  expect(outsideVoiceInvocation(ctx, { timeoutMs: 300000, gate: 'structured' })).toContain('severity-tagged findings');
  expect(outsideVoiceInvocation(ctx, { timeoutMs: 300000, gate: 'spec' })).toContain('SCORE: N');
});

test('preview paths retain verified fonts and select their own token source', () => {
  const section = readFileSync(new URL('../design-consultation/sections/proposal-and-preview.md.tmpl', import.meta.url), 'utf8');
  expect(section).toContain('Skipping competitive research does not waive font verification');
  expect(section).toContain('mark font selection as pending verification');
  expect(section).toContain('defer the preview until fonts can be verified');
  expect(section).toContain("For Path B, use the approved HTML preview's CSS values");
  expect(section).toContain('Only Path A invokes `$D extract`');
  expect(generateOverusedFonts(context('claude'))).toContain('font-verification fallback');
  expect(generateOverusedFonts(context('claude', 'design-shotgun'))).not.toContain('font-verification fallback');
  const loop = generateDesignShotgunLoop(context('claude'));
  expect(loop).toContain('Read captured stderr for the startup marker');
  expect(loop).toContain('a PID is not readiness');
});
