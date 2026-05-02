/**
 * Fixture-based sanity test for judgeRecommendation.
 *
 * Replaces the original "manually inject bad text into a captured file
 * and revert the SKILL template" sabotage step with deterministic
 * negative coverage: hand-graded good/bad recommendation strings, asserted
 * against the same threshold the production E2E tests use (>= 4).
 *
 * Costs ~$0.04 per run (4 Haiku calls + 3 deterministic-only fixtures).
 * Touchfile-gated to test/helpers/llm-judge.ts so it fires on rubric
 * tweaks but not every test run. Runs only under EVALS=1 with an API key.
 */

import { expect } from 'bun:test';
import { judgeRecommendation } from './helpers/llm-judge';
import { describeIfSelected, testIfSelected } from './helpers/e2e-helpers';

// Fixtures wrap a realistic AskUserQuestion shape so the judge sees the menu
// as context. The because-clause is what gets graded.
function buildAUQ(recommendation: string): string {
  return `D1 — Where should the retrieval smarts live?
ELI10: Two ways to ship the retrieval layer that powers cross-skill memory. The choice changes who else can use it and how fast we ship V1.
Stakes if we pick wrong: V1 ships months later, OR every other agent has to rebuild the same logic.
${recommendation}
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Server-side (gbrain ships the smarts)
  ✅ Reusable across every agent that calls gbrain — Codex, Cursor, etc.
  ❌ Cross-repo work; gbrain release tied to gstack release; slower V1
B) Client-side (gstack ships the smarts) (recommended)
  ✅ Ships entirely in gstack — no gbrain release dependency; faster V1
  ❌ Every other agent has to rebuild the same logic; multi-call overhead
C) Hybrid — V1 client-side, V1.5 promotes to gbrain
  ✅ Ships V1 value without cross-repo coordination; clear migration path
  ❌ Two-phase shipping; V1.5 risks slipping if priorities shift
Net: optimize for V1 ship velocity vs long-term agent reusability.`;
}

describeIfSelected('judgeRecommendation rubric sanity', ['llm-judge-recommendation'], () => {
  testIfSelected('llm-judge-recommendation', async () => {
    // Run all 7 fixtures sequentially in one test entry so the eval-store sees
    // a single result; individual assertions surface as failed expectations.

    // SUBSTANCE 5: option-specific reason that contrasts an alternative.
    const good5 = await judgeRecommendation(buildAUQ(
      'Recommendation: Choose C because hybrid ships V1 in gstack-only without blocking on cross-repo gbrain coordination, and locks the migration path before other agents take a hard dependency.',
    ));
    expect(good5.present).toBe(true);
    expect(good5.commits).toBe(true);
    expect(good5.has_because).toBe(true);
    expect(
      good5.reason_substance,
      `expected >=4 for option-specific cross-alternative reason; got ${good5.reason_substance}: ${good5.reasoning}`,
    ).toBeGreaterThanOrEqual(4);

    // SUBSTANCE 4: concrete option-specific reason without alternative comparison.
    const good4 = await judgeRecommendation(buildAUQ(
      'Recommendation: Choose B because client-side composition uses MCP tools that already exist in gstack and avoids any gbrain release dependency for V1.',
    ));
    expect(good4.present).toBe(true);
    expect(
      good4.reason_substance,
      `expected >=4 for concrete option-specific reason; got ${good4.reason_substance}: ${good4.reasoning}`,
    ).toBeGreaterThanOrEqual(4);

    // SUBSTANCE ~1: boilerplate.
    const bad1 = await judgeRecommendation(buildAUQ(
      'Recommendation: Choose B because it is better.',
    ));
    expect(bad1.present).toBe(true);
    expect(bad1.has_because).toBe(true);
    expect(
      bad1.reason_substance,
      `expected <4 for boilerplate "because it is better"; got ${bad1.reason_substance}: ${bad1.reasoning}`,
    ).toBeLessThan(4);

    // SUBSTANCE ~3: generic.
    const bad3 = await judgeRecommendation(buildAUQ(
      'Recommendation: Choose B because it is faster.',
    ));
    expect(bad3.present).toBe(true);
    expect(bad3.has_because).toBe(true);
    expect(
      bad3.reason_substance,
      `expected <4 for generic "because it is faster"; got ${bad3.reason_substance}: ${bad3.reasoning}`,
    ).toBeLessThan(4);

    // NO BECAUSE: missing causal connective.
    const noBecause = await judgeRecommendation(buildAUQ(
      'Recommendation: Choose B (it has the best tradeoffs).',
    ));
    expect(noBecause.present).toBe(true);
    expect(noBecause.has_because).toBe(false);
    expect(noBecause.reason_substance).toBe(1);

    // NO RECOMMENDATION: line missing entirely.
    const noRec = await judgeRecommendation(`D1 — Where should the smarts live?
ELI10: ...
Pros / cons:
A) Server-side
B) Client-side
Net: ...`);
    expect(noRec.present).toBe(false);
    expect(noRec.has_because).toBe(false);
    expect(noRec.reason_substance).toBe(1);

    // CROSS-MODEL synthesis recommendations: when /codex or the Claude
    // adversarial subagent emit a synthesis Recommendation line, it follows
    // the same canonical shape and is graded by the same rubric. These
    // fixtures pin the v1.25.1.0+ cross-model-skill emit format documented
    // in codex/SKILL.md.tmpl Steps 2A/2B/2C and scripts/resolvers/review.ts.
    // Substance-5 cross-model fixtures explicitly compare against an
    // alternative (a different finding, a different recommended action, or
    // no-fix vs fix). The same rubric the AskUserQuestion judge uses applies:
    // strong reasons name a tradeoff distinguishing the chosen action from
    // at least one alternative. Cross-model synthesis has implicit
    // alternatives — different findings, different fix orders, ship-vs-fix —
    // so the same shape applies.
    const crossModelCases = [
      [
        'codex-review good',
        'Recommendation: Fix the SQL injection at users_controller.rb:42 first because its auth-bypass blast radius is higher than the LFI Codex also flagged, and the parameterized-query fix is three lines vs the LFI session-handling rewrite.',
        true,  // expect substance >= 4
      ],
      [
        'adversarial good',
        'Recommendation: Fix the unbounded retry loop at queue.ts:78 because it DoSes the worker pool under sustained 429s, which is higher-blast-radius than the timing leak Codex also flagged that only touches a debug endpoint.',
        true,
      ],
      [
        'consult good',
        'Recommendation: Adopt the sharding approach Codex suggested because it eliminates the head-of-line blocking the current writer-pool has, while the cache-layer alternative Codex also floated still has a single-writer hot path.',
        true,
      ],
      // SUBSTANCE ~1-2: boilerplate cross-model synthesis.
      [
        'cross-model boilerplate',
        'Recommendation: Look at the findings because adversarial review found things.',
        false, // expect substance < 4
      ],
      [
        'cross-model generic',
        'Recommendation: Ship as-is because the diff is fine.',
        false,
      ],
    ] as Array<[string, string, boolean]>;
    for (const [label, text, shouldPass] of crossModelCases) {
      const score = await judgeRecommendation(text);
      expect(score.present, `[cross-model:${label}] present should be true`).toBe(true);
      expect(score.has_because, `[cross-model:${label}] has_because should be true`).toBe(true);
      if (shouldPass) {
        expect(
          score.reason_substance,
          `[cross-model:${label}] expected substance >=4; got ${score.reason_substance}: ${score.reasoning}`,
        ).toBeGreaterThanOrEqual(4);
      } else {
        expect(
          score.reason_substance,
          `[cross-model:${label}] expected substance <4; got ${score.reason_substance}: ${score.reasoning}`,
        ).toBeLessThan(4);
      }
    }

    // HEDGING: each alternate in the hedging regex is exercised separately.
    // Most are no-because forms that short-circuit the LLM call entirely (the
    // judge skips Haiku when has_because is false). The "either B or C
    // because..." form does call Haiku, but cost is bounded — total <$0.02.
    const hedgeForms = [
      ['either B or C',          'Recommendation: Choose either B or C because both ship faster than A.'],
      ['depends on traffic',     'Recommendation: A depends on traffic — pick B if read-heavy.'],
      ['depending on the team',  'Recommendation: depending on the team, A or B is fine.'],
      ['if X then Y',            'Recommendation: if low-traffic then A, otherwise B because both work.'],
      ['or maybe',               'Recommendation: A or maybe B because both ship in V1.'],
      ['whichever fits',         'Recommendation: whichever fits the team — A or B both work.'],
    ];
    for (const [label, text] of hedgeForms) {
      const score = await judgeRecommendation(buildAUQ(text));
      expect(score.present, `[hedge:${label}] present should be true`).toBe(true);
      expect(
        score.commits,
        `[hedge:${label}] expected commits=false; got ${score.commits}. text="${text}"`,
      ).toBe(false);
    }
  }, 240_000);
});
