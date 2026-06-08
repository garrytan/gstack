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
import * as fs from 'fs';
import * as path from 'path';
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

describe('generateAskUserFormat — 5+ option split rule (slim inline + docs pointer)', () => {
  const out = generateAskUserFormat(makeCtx());

  // 5 highest-signal pins. The full rule lives in
  // docs/askuserquestion-split.md; this contract only checks what the
  // inline subsection MUST surface so the agent can act without
  // reading the docs file for routine 5-option splits.

  test('forbids dropping options to fit the 4-option cap', () => {
    expect(out).toMatch(/caps every call at \*\*4 options\*\*/);
    expect(out).toMatch(/NEVER\s+drop, merge, or silently defer/);
  });

  test('names the Include / Defer / Cut / Hold buckets', () => {
    expect(out).toMatch(/A\) Include/);
    expect(out).toMatch(/B\) Defer/);
    expect(out).toMatch(/C\) Cut/);
    expect(out).toMatch(/D\) Hold/);
  });

  test('specifies D<N>.k child numbering and D<N>.final summary', () => {
    expect(out).toContain('D<N>.k');
    expect(out).toContain('D<N>.final');
  });

  test('AUTO_DECIDE is gated at runtime, not just collision-resistance', () => {
    expect(out).toContain('bin/gstack-question-preference');
    expect(out).toContain('*-split-*');
    expect(out).toContain('never AUTO_DECIDE-eligible');
  });

  test('points to docs/askuserquestion-split.md for the full rule', () => {
    expect(out).toContain('docs/askuserquestion-split.md');
    expect(out).toMatch(/Read on demand when N>4/);
  });

  test('regression: orphan "12." prefix removed from CJK rule', () => {
    expect(out).not.toContain('12. **Non-ASCII');
    expect(out).toContain('**Non-ASCII characters');
  });
});

describe('generateAskUserFormat — runtime-failure prose fallback', () => {
  const out = generateAskUserFormat(makeCtx());

  test('documents the unavailable/failed subsection', () => {
    expect(out).toMatch(/When AskUserQuestion is unavailable or a call fails/i);
  });

  test('carves out the auto-decide denial as NOT a failure', () => {
    expect(out).toContain('[plan-tune auto-decide]');
    expect(out).toMatch(/NOT a failure/i);
    // and explicitly: do not fall back to prose on an auto-decide denial
    expect(out).toMatch(/Do NOT[\s\S]{0,40}fall back to prose|never prose/i);
  });

  test('retries the errored call exactly once before degrading', () => {
    expect(out).toMatch(/retry the SAME call \*\*once\*\*|retry the same call.*once/i);
    // idempotency guard against double-prompting
    expect(out).toMatch(/double-prompt|no answer could have surfaced/i);
  });

  test('branches on SESSION_KIND: spawned / headless / interactive', () => {
    expect(out).toContain('SESSION_KIND');
    expect(out).toMatch(/`spawned`[\s\S]*auto-choose/);
    expect(out).toMatch(/`headless`[\s\S]*BLOCKED/);
    expect(out).toMatch(/`interactive`[\s\S]*prose fallback/);
    // empty/absent SESSION_KIND degrades to interactive
    expect(out).toMatch(/empty\/absent[\s\S]{0,40}interactive/i);
  });

  // The mandatory triad the user explicitly required for the plain-text output.
  test('prose fallback mandates the triad: issue ELI10', () => {
    expect(out).toMatch(/ELI10 of the issue itself/i);
  });

  test('prose fallback mandates the triad: per-choice Completeness score', () => {
    expect(out).toMatch(/Completeness scores per choice/i);
    expect(out).toMatch(/Completeness: X\/10.*EACH choice|on EACH choice/i);
  });

  test('prose fallback mandates the triad: recommendation + (recommended) marker', () => {
    expect(out).toMatch(/Recommendation: <choice> because/);
    expect(out).toMatch(/\(recommended\)`? marker on that choice/);
  });

  test('prose fallback is one paragraph per choice, not a bare bullet list', () => {
    expect(out).toMatch(/ONE paragraph per choice/i);
    expect(out).toMatch(/never a bare bullet list/i);
  });

  test('prose fallback tells the user to reply with a letter, then STOP', () => {
    expect(out).toMatch(/reply with a letter/i);
    expect(out).toMatch(/STOP and wait/i);
  });

  // OV2: the former "tool_use, not prose" assertions must carry the qualifier so the
  // fallback is not self-contradicting. Guards against the instruction collision
  // silently returning on a future edit.
  test('OV2: the Format line qualifies "not prose" with the fallback exception', () => {
    expect(out).toMatch(/must be sent as tool_use, not prose — unless the documented failure fallback/);
  });

  test('OV2: the self-check "not writing prose" line carries the fallback qualifier', () => {
    expect(out).toMatch(/not writing prose — unless the documented failure fallback applies/);
  });
});

describe('CQ2 — cross-file invariant: auto-decide prefix matches the hook', () => {
  const out = generateAskUserFormat(makeCtx());
  const hookSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'hosts', 'claude', 'hooks', 'question-preference-hook.ts'),
    'utf-8',
  );

  test('the hook actually emits the [plan-tune auto-decide] prefix', () => {
    expect(hookSrc).toContain('[plan-tune auto-decide]');
  });

  test('the resolver references the exact same prefix the hook emits', () => {
    // If a future edit reworded the hook reason, this catches the drift: the prose
    // fallback would stop recognizing the auto-decide denial as not-a-failure.
    const PREFIX = '[plan-tune auto-decide]';
    expect(hookSrc.includes(PREFIX) && out.includes(PREFIX)).toBe(true);
  });
});
