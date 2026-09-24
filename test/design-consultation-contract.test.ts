import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateDesignOutsideVoices, generateOverusedFonts, generateDesignShotgunLoop, generateTasteProfile, generateDesignMdCheck, generateDesignSetup } from '../scripts/resolvers/design';
import { generateBrowseFallback } from '../scripts/resolvers/browse';
import { generateAsideSetup, generateAsideResearch } from '../scripts/resolvers/aside';
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
    expect(preparation.includes('Claude Code has no tools, git or path access')).toBe(host === 'codex');
    expect(preparation).toContain('including actual plan/spec/source');
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
  expect(section).not.toContain('## Approved Design Direction');
  expect(section).toContain('approved mockup paths/tokens into Phase 6\'s "## Proposed DESIGN.md" plan section');
  expect(section).toContain('Its Q-final approval governs saving that content');
  expect(section).toContain('Only A permits the writes below');
  expect(generateOverusedFonts(context('claude'))).toContain('font-verification fallback');
  expect(generateOverusedFonts(context('claude', 'design-shotgun'))).not.toContain('font-verification fallback');
  const loop = generateDesignShotgunLoop(context('claude'));
  expect(loop).toContain('Read captured stderr for the startup marker');
  expect(loop).toContain('a PID is not readiness');
});


test('consultation drafts before independent dispatch and compares completed input at Q2', () => {
  const root = readFileSync(new URL('../design-consultation/SKILL.md.tmpl', import.meta.url), 'utf8');
  const section = readFileSync(new URL('../design-consultation/sections/proposal-and-preview.md.tmpl', import.meta.url), 'utf8');
  expect(root).not.toContain('{{DESIGN_OUTSIDE_VOICES}}');
  expect(root).not.toContain('Draft your own direction');
  expect(root.indexOf('{{SECTION:proposal-and-preview}}')).toBeGreaterThan(root.indexOf('## Phase 2: Research'));
  const ordered = ['### Your Design Knowledge', '**Choosing faces:', '{{OVERUSED_FONTS}}', '{{DESIGN_SLOP_BULLETS}}', 'Draft your own direction', '{{DESIGN_OUTSIDE_VOICES}}', '**AskUserQuestion Q2'];
  for (let i = 0; i < ordered.length; i++) {
    expect(section.indexOf(ordered[i])).toBeGreaterThan(i === 0 ? -1 : section.indexOf(ordered[i - 1]));
  }
  expect(section).toContain("Keep that draft out of both reviewers' prompts");
  expect(root).toContain('The optional outside-voices choice below still applies');
  const question = section.slice(section.indexOf('**AskUserQuestion Q2'), section.indexOf('## Phase 4'));
  expect(question).toContain('completed/unavailable/skipped voices');
  expect(question).toContain('agreements, differences, ideas adopted and product-specific reasons');
  expect(question).toContain('omit comparisons if none completed');
  expect(section).toContain('Do not count agreement as a vote or invent a missing proposal');
  expect(section).toContain('Verify any newly suggested fonts before adopting them');
  expect(section).toContain('label old proposals stale');
});

test('optional browser research has one unavailable branch and reuses its readiness probe', () => {
  const ctx = context('claude');
  const fallback = generateBrowseFallback(ctx);
  expect(fallback).toContain('Do not offer or run a build');
  expect(fallback).toContain('skip Phase 2 Step 2; Step 1 still uses WebSearch');
  expect(fallback).not.toContain('OK to proceed?');
  expect(generateBrowseFallback(context('claude', 'qa'))).toContain('OK to proceed?');
  const research = generateAsideResearch(ctx);
  expect(research).toContain('Reuse the Phase 0 BROWSER SETUP result');
  expect((generateAsideSetup(ctx) + research).match(/console\.log\("ASIDE_READY /g)).toHaveLength(1);
  expect(research.toLowerCase()).toContain('read-only: do not sign in, submit, or change anything');
  expect(research).toContain('Sanitize every query before it leaves the machine');
});

test('existing-system choices reach their matching final format without early writes', () => {
  const root = readFileSync(new URL('../design-consultation/SKILL.md.tmpl', import.meta.url), 'utf8');
  const section = readFileSync(new URL('../design-consultation/sections/proposal-and-preview.md.tmpl', import.meta.url), 'utf8');
  expect(root).toContain('**Cancel:** STOP the skill now, with no file changes or further probes');
  expect(root).toContain('**Update:** carry the existing decisions into Q1 as constraints');
  expect(root).toContain('**Start fresh:** set aside prior visual choices');
  expect(root).toContain('All conversion, marker and design writes wait for Q-final');
  const format = generateDesignMdCheck(context('claude'));
  expect(format).toContain('convert`, without `--write`');
  expect(format).toContain('After Q-final approval outside plan mode');
  expect(format).toContain('In plan mode, record the chosen format in Proposed DESIGN.md instead');
  expect(section).toContain('Never convert a kept file just to make validation say spec');
  expect(section).toContain('Any subsequent token, font or direction change invalidates that approval');
  expect(section).toContain('E) Skip the preview — proceed to Phase 6\'s Q-final, not straight to writing');
});

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: only Update with DESIGN.md enters the entire format-check block', host => {
  const root = readFileSync(new URL('../design-consultation/SKILL.md.tmpl', import.meta.url), 'utf8');
  const format = generateDesignMdCheck(context(host));
  const gate = format.indexOf('**Update-only gate:**');
  const command = format.indexOf('```bash');
  const end = format.indexOf('**End of Update-only format check.**');
  expect(gate).toBeGreaterThan(-1);
  expect(command).toBeGreaterThan(gate);
  expect(end).toBeGreaterThan(format.indexOf('**A) Convert**'));
  expect(format.slice(gate, command)).toContain('Only **Update** with DESIGN.md enters this block (command and all result branches)');
  expect(format.slice(gate, command)).toContain('**Start fresh**, **No existing file**, or a lone design-system.md: skip to **Gather product context from the codebase**');
  expect(format.slice(gate, command)).toContain('**Cancel** has already stopped the skill');
  expect(root.indexOf('**Gather product context from the codebase:**')).toBeGreaterThan(root.indexOf('{{DESIGN_MD_CHECK}}'));
  expect(root).toContain('**Cancel:** STOP the skill now, with no file changes or further probes');
  expect(generateDesignMdCheck(context(host, 'design-review'), ['calibrate'])).not.toContain('Update-only');
});

test('design command guidance carries session, extraction and quality-check side effects', () => {
  const setup = generateDesignSetup(context('claude'));
  const section = readFileSync(new URL('../design-consultation/sections/proposal-and-preview.md.tmpl', import.meta.url), 'utf8');
  expect(setup).toContain('$D extract --image /absolute/path.png');
  expect(setup).toContain('automatically update DESIGN.md');
  expect(setup).toContain('`variants` returns `paths` but creates no session');
  expect(section).toContain('`pass: false` means regenerate');
  expect(section).toContain('`pass: true` with an unavailable/skipped warning is missing automated coverage');
  expect(section).toContain('run it only in a fresh non-repository scratch directory');
  expect(section).toContain('Empty arrays, an "Unable to extract" mood or command failure');
  for (const command of (section + generateDesignShotgunLoop(context('claude'))).matchAll(/\$D iterate[^`\n]+/g)) {
    expect(command[0]).toContain('--session');
  }
});

test('board feedback distinguishes sessionless regeneration, final choice and missing input', () => {
  const loop = generateDesignShotgunLoop(context('claude'));
  const examples = [...loop.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
  expect(examples.find(value => value.regenerated === false)).toMatchObject({ preferred: 'A' });
  expect(examples.find(value => value.regenerated === true)).toMatchObject({ regenerateAction: 'more_like_B' });
  expect(loop).toContain('it does not emit a required `remixSpec`');
  expect(loop).toContain('Archive this round\'s feedback files');
  expect(loop).toContain('revisions regenerate; a final choice needs summary confirmation');
  expect(loop).toContain('never infer approval from a missing file');
  expect(loop).toContain('publishes to a persistent daemon, opens the board and exits');
  expect(loop).toContain('Re-run the quality check and visual self-gate on every new image');
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
  expect(text).toContain('Nonzero exit or no readiness marker: show each variant inline');
  expect(text).not.toContain('$D serve');
  expect(text).not.toContain('POLLING FALLBACK');
  expect(text).toContain('Exit 0 with `BOARD_URL` means the daemon is serving');
  const fallback = text.slice(text.indexOf('**SERVER FALLBACK:**'), text.indexOf('**After receiving feedback'));
  expect(fallback).not.toContain('In that case');
  expect(fallback).not.toContain('means the daemon is serving');
  expect(fallback).toContain('The comparison board server failed to start');
});
