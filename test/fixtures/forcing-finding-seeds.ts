/**
 * Per-skill draft-plan seeds engineered to surface at least one
 * review-phase finding in the corresponding plan-* review skill.
 *
 * Used by gate-tier finding-floor tests
 * (test/skill-e2e-plan-{eng,ceo,design,devex}-finding-floor.test.ts) as
 * the minimum-cost regression for the May 2026 transcript bug:
 *   "/plan-eng-review reviewed a real PR diff, wrote a multi-section
 *    review plan to ~/.claude/plans/ and called ExitPlanMode without
 *    ever firing AskUserQuestion."
 *
 * Each seed is small and pre-loaded with one obvious finding the
 * matching skill cannot honestly miss. Floor tests assert
 * `reviewCount >= 1` — i.e., the model fired at least one review-phase
 * AUQ before reaching plan_ready / completion_summary / ceiling.
 *
 * Each seed includes the standard "write your plan-mode plan to /tmp/…"
 * preamble that the existing periodic finding-count fixtures use, so
 * the agent has a concrete plan-file target. The /tmp path is unique
 * per skill to avoid collisions if floor tests run in parallel.
 *
 * For a deeper [N-1, N+2] count band assertion, see the periodic
 * test/skill-e2e-plan-{X}-finding-count.test.ts fixtures.
 */

export const FORCING_FLOOR_ENG = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-eng-floor.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Add request-id propagation across services',
  '',
  '## Architecture',
  "We'll roll a custom UUIDv7 generator inline in each service rather than",
  "use Node's crypto.randomUUID() built-in. Same shape, but we want full",
  'control over the entropy source for "future flexibility" — no concrete',
  'reason yet.',
].join('\n');

export const FORCING_FLOOR_CEO = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-ceo-floor.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Launch a "developer-friendly" pricing tier',
  '',
  '## Goal',
  'Increase developer adoption.',
  '',
  '## Success metric',
  'More signups.',
  '',
  '## Premise',
  "We haven't talked to any developers about whether the current pricing",
  'is actually a barrier. The team agreed it "feels like" it should be cheaper.',
].join('\n');

export const FORCING_FLOOR_DESIGN = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-design-floor.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Marketing landing page',
  '',
  '## Layout',
  'All headings, taglines, and body copy will be center-aligned for a',
  '"clean modern look." The hero h1 sits 8px above the subhead with no',
  'breathing room; the CTA button is the same visual weight as a',
  'secondary "Learn more" link directly beside it.',
].join('\n');

export const FORCING_FLOOR_DEVEX = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-devex-floor.md (use Edit/Write to that exact path).',
  '',
  '# Plan: SDK quickstart docs',
  '',
  '## Onboarding flow',
  'Step 1: clone the repo.',
  'Step 2: install bun manually if not present.',
  'Step 3: copy .env.example to .env and fill in 8 environment variables.',
  'Step 4: run database migrations against your local Postgres.',
  'Step 5: start the dev server.',
  'Step 6: open the docs in a separate tab.',
  'Step 7: register an API key by emailing the team.',
  'Step 8: paste the key into your .env, restart the server, then make',
  'your first SDK call.',
  '',
  'No quickstart command, no hosted sandbox, no copy-pasteable curl example.',
].join('\n');

/**
 * Multi-finding batching regression seed (periodic tier).
 *
 * Mirrors the May 2026 transcript bug shape: 4 distinct non-trivial findings
 * spread across plan-eng-review's standard sections (Architecture, Code
 * Quality, Tests, Performance). Each finding is independent — there is no
 * legitimate reason to batch them into a single AskUserQuestion.
 *
 * Used by test/skill-e2e-plan-eng-multi-finding-batching.test.ts to assert
 * the agent fires >= 3 review-phase AUQs (i.e., does NOT batch them into a
 * "## Decisions to confirm" section + ExitPlanMode). Floor of 3 (not 4) is
 * the [N-1] tolerance from the existing finding-count band convention.
 */
export const FORCING_BATCHING_ENG = [
  'Please review this plan thoroughly. As you go, write your plan-mode plan to /tmp/gstack-test-plan-eng-batching.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Add background job retry framework',
  '',
  '## Architecture',
  "We'll roll a custom exponential-backoff scheduler inline in each worker",
  "rather than use the existing job library's built-in retry hooks. Same",
  'shape as the library version, but we want full control over the curve.',
  '',
  '## Code quality',
  'The retry envelope (compute delay, log attempt, dispatch) is duplicated',
  'across 5 worker files with copy-pasted bodies. We will leave the',
  'duplication for now and refactor "later."',
  '',
  '## Tests',
  'The existing `processWebhookJob()` flow gets rewritten as part of this',
  'change. No regression test for the prior at-most-once delivery guarantee',
  'is planned.',
  '',
  '## Performance',
  'On every retry we re-fetch the full job payload from the database, then',
  'iterate the payload to recompute the dependency graph. Could cache the',
  'graph on the first attempt; not planned.',
].join('\n');

/**
 * Split-overflow regression seed (periodic tier).
 *
 * Catches the original failure mode the user complained about: when the
 * agent has 5+ options for ONE conceptual decision, it must split into N
 * sequential AskUserQuestion calls (or batch into compatible ≤4-groups),
 * NOT drop an option arbitrarily to fit Conductor's 4-option cap.
 *
 * Fixture shape: 5 independent platform-integration candidates for ONE
 * scope decision. Each is independent (no dependencies between them) so
 * the natural compliant shape is a per-option split chain at parent D<N>.
 *
 * Used by test/skill-e2e-plan-ceo-split-overflow.test.ts to assert the
 * agent fires >= 4 review-phase AUQs (floor uses the standard [N-1]
 * tolerance band, accounting for one expected scope-reduction-or-merge
 * call before the per-option chain begins).
 *
 * Pre-fix behavior: agent fires 1 AUQ with 4 options, "trims" the 5th
 * via prose ("E5 is the largest lift and a natural follow-up; moving to
 * TODOs without asking"). That's the bug. Floor of 4 detects it.
 */
export const FORCING_SPLIT_OVERFLOW_CEO = [
  'Please review this plan and help me decide scope. Write your plan-mode plan to /tmp/gstack-test-plan-ceo-split-overflow.md (use Edit/Write to that exact path).',
  '',
  '# Plan: Pick which chat-platform integrations to ship this quarter',
  '',
  'We have engineering bandwidth for at most 2-3 integrations this quarter.',
  'I need your help deciding which to prioritize. Below are 5 candidates,',
  'each fully independent of the others (no shared infrastructure, no',
  'dependencies between them). For each, the user can independently decide:',
  'include in this scope, defer to next quarter, or cut entirely.',
  '',
  '## E1) Slack — DM bot for incident alerts',
  'Build cost: ~2 weeks. Existing Slack auth flow we can reuse. High user',
  'demand (top customer request in Q2 survey, ~40% of asks).',
  '',
  '## E2) Discord — guild bot for community channels',
  'Build cost: ~3 weeks. Greenfield integration, no existing auth. Medium',
  'demand (~15% of asks, but loud community).',
  '',
  '## E3) Microsoft Teams — webhook + bot framework',
  'Build cost: ~4 weeks. Enterprise customers specifically asked for this.',
  'Highest revenue impact per user but smallest user count (~5% of asks).',
  '',
  '## E4) Telegram — bot API integration',
  'Build cost: ~1 week. Simplest API surface. Low strategic value but',
  'cheap win (~8% of asks, mostly from international users).',
  '',
  '## E5) Mattermost — REST plugin',
  'Build cost: ~2 weeks. Self-hosted enterprise users. Niche but locked-in',
  'segment (~3% of asks but all from high-ARR accounts).',
  '',
  'Please walk me through each candidate and help me decide include/defer/cut',
  'per option. I want individual decisions per candidate, not a bundled pick.',
].join('\n');
