/**
 * ship/DRIVER.md resolvers (GSTA-167 PR 5): the compact entry a parent agent
 * reads to run an unattended /ship, instead of ship/SKILL.md plus its sections.
 * The phases live in ship/DRIVER.md.tmpl; this file owns the one list a reader
 * must trust most: which heading each STOP sends the parent to. test/ship-driver.test.ts
 * resolves every anchor against the generated files.
 */
import type { ResolverFn } from './types';

/** Each STOP (or read-when line) a driver run can meet, and the one heading it reads, relative to <root>/ship/. */
export const SHIP_DRIVER_STOPS: Array<{ when: string; read: string }> = [
  { when: '`merge conflicts`', read: 'SKILL.md#step-3-merge-the-base-branch-before-tests' },
  { when: '`NEXT: carry route`', read: 'SKILL.md#step-1-pre-flight' },
  { when: '`DISTRIBUTION: candidates=`', read: 'SKILL.md#step-2-distribution-pipeline-check' },
  { when: '`APPLE:` with a store ask', read: 'sections/apple-release.md#apple-app-store-release' },
  { when: '`pregate fail` or `incomplete`', read: 'sections/tests.md#step-5-run-tests-on-merged-code' },
  { when: 'a failed or zero-run lane', read: 'sections/tests.md#test-failure-ownership-triage' },
  { when: 'a red eval or a failed free-suite shard', read: 'sections/measure.md#measure-then-fix-loop-a-red-paid-eval-or-a-failed-free-suite-shard' },
  { when: 'Greptile found', read: 'sections/greptile-early.md#step-65-early-greptile-pr-after-the-free-tests-pass' },
  { when: 'coverage below target, a failed audit', read: 'sections/test-coverage.md#step-7-test-coverage-audit' },
  { when: 'plan items NOT DONE or UNVERIFIABLE', read: 'sections/plan-completion.md#gate-logic' },
  { when: '`NEXT: stop`', read: 'sections/review-army.md#decide-whether-to-repeat-step-9' },
  { when: 'a `REVIEW_SCOPE_*` refusal, the review-log row', read: 'sections/review-army.md#step-94-fix-first-and-persistence' },
  { when: 'a required probe not passed', read: 'sections/review-army.md#step-921-exploratory-qa-before-fix-first' },
  { when: 'native adversarial incomplete, queued fixes', read: 'sections/adversarial.md#finish-the-adversarial-phase' },
  { when: 'Step 11.5 mismatch', read: 'SKILL.md#step-115-bind-the-reviews' },
  { when: 'a `version` STOP', read: 'SKILL.md#step-12-version-bump-auto-decide' },
  { when: '`Documentation: blocked` or a `DOCS_CAP:` over', read: 'sections/documentation.md#blocked-recovery' },
  { when: 'finish: changed since review', read: 'SKILL.md#2-choose-the-change-route' },
  { when: 'finish: documentation inputs changed', read: 'SKILL.md#3-resolve-documentation-freshness' },
  { when: 'finish: build, lane or pregate STOP', read: 'SKILL.md#4-verify-the-frozen-candidate' },
  { when: 'a push STOP', read: 'SKILL.md#step-17-push' },
  { when: 'unattended, no open PR at HEAD', read: 'sections/handoff.md#step-18-h-handoff-without-a-pr-automation-lanes' },
  { when: 'a receipt write or `gstack-post` refusal', read: 'sections/pr-body.md#compose-the-body-then-publish-through-gstack-post' },
  { when: '`verdict=stop` or `DELEGATE:`', read: 'sections/budget-handoff.md#budget-and-context-handoff-read-when-a-cap-is-set-or-verdictdelegate-prints' },
  { when: '`QUEUE_RECEIPT_STALE`', read: '../docs/ship-policy.md#ship-before-ready' },
];

export const generateShipDriverStops: ResolverFn = () =>
  SHIP_DRIVER_STOPS.map(s => `- ${s.when}: \`${s.read}\``).join('\n');
