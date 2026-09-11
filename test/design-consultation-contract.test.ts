import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateDesignOutsideVoices, generateOverusedFonts, generateDesignShotgunLoop, generateTasteProfile } from '../scripts/resolvers/design';
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
    expect(text).toContain('otherwise \"none\"');
    expect(text).toContain('run the command twice: one record for each voice, including any unavailable voice');
    expect(text).toContain('Both records carry the actual CLI outcome');
    expect(text).toContain('every completed proposal (two, one, or none)');
    expect(text).toContain('Do not choose a direction here');
    expect(text).toContain('Q2 compares these proposals with your earlier draft');
    expect(text).not.toContain('continuing with primary review');
    expect(text).not.toContain('[single-model]');
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


test('consultation drafts before independent dispatch and compares completed input at Q2', () => {
  const root = readFileSync(new URL('../design-consultation/SKILL.md.tmpl', import.meta.url), 'utf8');
  const section = readFileSync(new URL('../design-consultation/sections/proposal-and-preview.md.tmpl', import.meta.url), 'utf8');
  expect(root.indexOf('Draft your own direction')).toBeLessThan(root.indexOf('{{DESIGN_OUTSIDE_VOICES}}'));
  expect(root.indexOf('{{DESIGN_OUTSIDE_VOICES}}')).toBeLessThan(root.indexOf('{{SECTION:proposal-and-preview}}'));
  expect(root).toContain("Keep that draft out of both reviewers' prompts");
  expect(root).toContain('The optional outside-voices choice below still applies');
  const question = section.slice(section.indexOf('**AskUserQuestion Q2'), section.indexOf('### Your Design Knowledge'));
  expect(question).toContain('completed/unavailable/skipped voices');
  expect(question).toContain('agreements, differences, ideas adopted and product-specific reasons');
  expect(question).toContain('omit comparisons if none completed');
  expect(section).toContain('Do not count agreement as a vote or invent a missing proposal');
});

test('taste context has defined count and bounded legacy and malformed-profile fallbacks', () => {
  const text = generateTasteProfile(context('claude'));
  expect(text).not.toContain('SESSION_COUNT');
  expect(text).not.toContain('head -200');
  expect(text).toContain('Count retained sessions (at most 50, not lifetime)');
  expect(text).toContain('malformed/unreadable uses the legacy fallback');
  expect(text).toContain('Glob `~/.gstack/projects/$SLUG/designs/**/approved.json`');
  expect(text).toContain('Read the five newest');
  expect(text).toContain('No usable files: continue without a taste profile');
  expect(text).toContain('never infer fonts/colors from variant letters');
  expect(text).toContain('do not rewrite the file while reading');
});

test('board fallback names the same launch command and does not poll a failed server', () => {
  const text = generateDesignShotgunLoop(context('claude'));
  expect(text).toContain('$D compare --images');
  expect(text).toContain('Nonzero exit or no readiness marker: use the fallback below');
  expect(text).not.toContain('$D serve');
  expect(text).not.toContain('POLLING FALLBACK');
  expect(text).toContain('Exit 0 with `BOARD_URL` means the daemon is serving');
});
