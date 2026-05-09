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
