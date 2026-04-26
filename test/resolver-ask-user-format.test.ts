/**
 * AskUserQuestion Format resolver — gate-tier assertions on the generated
 * Pros/Cons format directive block.
 *
 * v1.7.0.0 introduces Pros/Cons decision-brief formatting:
 * - D<N> numbered header
 * - ELI10 paragraph
 * - Stakes-if-we-pick-wrong line
 * - Recommendation line (mandatory, even for neutral posture)
 * - Pros/Cons block with ✅/❌ per option, min 2 pros + 1 con, ≥40 char bullets
 * - Net: synthesis line
 *
 * This test pins the format contract so a future edit to the resolver
 * can't silently drop a rule. If the resolver stops emitting one of
 * these tokens, bun test catches it in milliseconds instead of waiting
 * for the weekly periodic eval to notice.
 */
import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';

function makeCtx(): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 2,
  };
}

describe('generateAskUserFormat — v1.7.0.0 Pros/Cons format', () => {
  const out = generateAskUserFormat(makeCtx());

  test('includes AskUserQuestion Format header', () => {
    expect(out).toContain('## AskUserQuestion Format');
  });

  test('documents D-numbered header requirement', () => {
    expect(out).toContain('D<N>');
    expect(out).toMatch(/first question in a skill invocation is `D1`/i);
  });

  test('documents ELI10 requirement', () => {
    expect(out).toContain('ELI10');
    expect(out).toMatch(/plain English.*16-year-old/);
  });

  test('documents Stakes-if-we-pick-wrong line', () => {
    expect(out).toContain('Stakes if we pick wrong');
  });

  test('documents mandatory Recommendation line', () => {
    expect(out).toContain('Recommendation: <choice>');
    expect(out).toMatch(/Recommendation.*ALWAYS|Recommendation \(ALWAYS\)/);
  });

  test('documents Pros / cons block header', () => {
    expect(out).toContain('Pros / cons:');
  });

  test('documents ✅ pro markers with min count + min length rule', () => {
    expect(out).toContain('✅');
    expect(out).toMatch(/[Mm]inimum 2 pros/);
    expect(out).toMatch(/40 characters|≥40 chars/);
  });

  test('documents ❌ con markers with min count rule', () => {
    expect(out).toContain('❌');
    expect(out).toMatch(/1 con per option|minimum.*1 con/i);
  });

  test('documents hard-stop escape with exact phrase', () => {
    // "No cons — this is a hard-stop choice" may span a line break in the
    // rendered resolver text; match across whitespace collapses.
    expect(out).toMatch(/No cons\s+—\s+this is a\s+hard-stop choice/);
  });

  test('documents neutral-posture escape preserving (recommended) label', () => {
    // CT1 resolution: (recommended) label STAYS on default option to preserve
    // AUTO_DECIDE contract. Neutrality expressed in prose only.
    expect(out).toMatch(/taste call/i);
    // `s` flag makes . match newlines — the label + STAYS phrase spans a line break
    expect(out).toMatch(/\(recommended\)[\s\S]*STAYS|STAYS[\s\S]*\(recommended\)/);
    expect(out).toMatch(/AUTO_DECIDE/);
  });

  test('documents Net line for closing synthesis', () => {
    expect(out).toMatch(/^Net:/m);
    expect(out).toMatch(/synthesis|tradeoff/i);
  });

  test('documents Completeness scoring rules (coverage vs kind)', () => {
    expect(out).toContain('Completeness');
    expect(out).toMatch(/10 = complete/);
    expect(out).toMatch(/options differ in kind, not coverage/);
  });

  test('documents tool_use mandate (rule 11)', () => {
    expect(out).toMatch(/tool_use/);
    // "not a question" spans a newline in the rendered text
    expect(out).toMatch(/not a[\s\S]*question|not[\s\S]*interactive/i);
  });

  test('includes self-check before emitting', () => {
    expect(out).toContain('Self-check before emitting');
    expect(out).toMatch(/D<N> header present/);
    expect(out).toMatch(/Net line closes/);
  });

  test('documents D-numbering as model-level not runtime state', () => {
    // Codex finding #4 caveat: D-numbering is a prompt wish, not a system
    // guarantee. TemplateContext has no counter. This check pins the caveat.
    expect(out).toMatch(/model-level instruction|not a runtime counter|count your own/i);
  });

  test('per-skill override guidance preserved', () => {
    expect(out).toMatch(/Per-skill instructions may add/);
  });
});
