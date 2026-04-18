/**
 * Question Registry — typed schema for AskUserQuestion invocations across gstack.
 *
 * Purpose
 * -------
 * Every AskUserQuestion invocation is tagged with a stable question_id that maps
 * to an entry in this registry. The registry is the substrate /plan-tune builds on:
 * - Logging (question-log.jsonl) tags events with a registered id
 * - Per-question preferences (question-preferences.json) are keyed by registered id
 * - One-way door safety is declared here, not inferred from prose summaries
 * - The psychographic signal map (scripts/psychographic-signals.ts) maps id → dimension delta
 *
 * Not every AskUserQuestion in gstack needs a registry entry right away. Skills
 * often craft questions dynamically at runtime — the agent generates an ad-hoc id
 * of the form `{skill}-{slug}` for those. The /plan-tune skill surfaces frequently-
 * firing ad-hoc ids as candidates for registry promotion.
 *
 * v1 coverage target: the ~30-50 most-common recurring question categories across
 * ship, review, office-hours, plan-ceo-review, plan-eng-review, plan-design-review,
 * plan-devex-review, qa, investigate, and land-and-deploy. One-way doors 100%.
 *
 * Adding a new entry
 * ------------------
 * 1. Pick a kebab-case id of the form `{skill}-{what-it-asks-about}`.
 * 2. Classify `door_type`:
 *    - `one-way` for destructive ops, architecture/data-model forks,
 *      scope-adds > 1 day CC effort, security/compliance choices.
 *      ALWAYS asked regardless of user preference.
 *    - `two-way` for everything else (can be auto-decided by explicit preference).
 * 3. Pick the `category` that describes the question's shape.
 * 4. Add an optional `signal_key` if this question's answer should nudge a
 *    specific psychographic dimension. The signal map in scripts/psychographic-
 *    signals.ts uses (id, user_choice) to look up the dimension delta.
 * 5. `options` is a short list of stable option keys. UI labels can vary; keys
 *    must stay the same so preferences survive wording changes.
 * 6. Run `bun test test/plan-tune.test.ts` to verify format + uniqueness.
 */

export type QuestionCategory =
  | 'approval'         // proceed/stop gate (e.g., "approve this plan?")
  | 'clarification'    // need more info to proceed
  | 'routing'          // which path to take (modes, strategies)
  | 'cherry-pick'      // opt-in scope decision (add/defer/skip)
  | 'feedback-loop';   // inline tune: prompt, iteration feedback

export type DoorType = 'one-way' | 'two-way';

/**
 * Stable keys for the most-common user choice patterns. UI labels can vary
 * (e.g., "Add to plan" vs "Include in scope"); the stored choice is the key.
 * Skills may emit custom keys for uncategorizable questions — those still log
 * but don't get psychographic signal attribution.
 */
export type StandardOption =
  | 'accept'
  | 'reject'
  | 'defer'
  | 'skip'
  | 'investigate'
  | 'approve'
  | 'deny'
  | 'expand'
  | 'hold'
  | 'reduce'
  | 'selective'
  | 'fix-now'
  | 'fix-later'
  | 'ack-and-ship'
  | 'false-positive'
  | 'continue'
  | 'rerun'
  | 'stop';

export interface QuestionDef {
  /** Stable kebab-case id: `{skill}-{semantic-description}` */
  id: string;
  /** Skill that owns this question (must match a gstack skill directory name) */
  skill: string;
  /** Shape of the question */
  category: QuestionCategory;
  /** Safety classification. one-way is ALWAYS asked regardless of preference */
  door_type: DoorType;
  /** Stable option keys (skills may emit keys outside this list; those are logged but untagged) */
  options?: StandardOption[] | string[];
  /** Optional key into scripts/psychographic-signals.ts for dimension attribution */
  signal_key?: string;
  /** One-line description for docs and /plan-tune profile output */
  description: string;
}

/**
 * QUESTIONS — initial v1 coverage of recurring question categories.
 * Grouped by skill for readability. Maintained by hand.
 *
 * When adding new skills or question types, extend this object. The CI lint
 * test/plan-tune.test.ts verifies format, uniqueness, and required fields.
 */
export const QUESTIONS = {
  // -----------------------------------------------------------------------
  // /ship — pre-landing review, deploy, PR creation
  // -----------------------------------------------------------------------
  'ship-release-pipeline-missing': {
    id: 'ship-release-pipeline-missing',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'defer', 'skip'],
    signal_key: 'distribution-care',
    description: "New artifact added without CI/CD release pipeline — add now, defer to TODOs, or skip?",
  },
  'ship-test-failure-triage': {
    id: 'ship-test-failure-triage',
    skill: 'ship',
    category: 'approval',
    door_type: 'one-way',
    options: ['fix-now', 'investigate', 'ack-and-ship'],
    signal_key: 'test-discipline',
    description: "Failing tests detected — fix before shipping or investigate root cause?",
  },
  'ship-pre-landing-review-fix': {
    id: 'ship-pre-landing-review-fix',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['fix-now', 'skip'],
    signal_key: 'code-quality-care',
    description: "Pre-landing review flagged an issue — fix now or ship as-is?",
  },
  'ship-greptile-comment-valid': {
    id: 'ship-greptile-comment-valid',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['fix-now', 'ack-and-ship', 'false-positive'],
    signal_key: 'code-quality-care',
    description: "Greptile flagged a valid issue — fix, ack and ship, or mark false positive?",
  },
  'ship-greptile-comment-false-positive': {
    id: 'ship-greptile-comment-false-positive',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['reply', 'fix-anyway', 'ignore'],
    description: "Greptile comment looks like a false positive — reply to explain, fix anyway, or ignore silently?",
  },
  'ship-todos-create': {
    id: 'ship-todos-create',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    description: "No TODOS.md found — create a skeleton file now?",
  },
  'ship-todos-reorganize': {
    id: 'ship-todos-reorganize',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    signal_key: 'detail-preference',
    description: "TODOS.md doesn't follow the recommended structure — reorganize now?",
  },
  'ship-changelog-voice-polish': {
    id: 'ship-changelog-voice-polish',
    skill: 'ship',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    signal_key: 'detail-preference',
    description: "CHANGELOG entry could be polished for voice — apply edits?",
  },
  'ship-version-bump-tier': {
    id: 'ship-version-bump-tier',
    skill: 'ship',
    category: 'routing',
    door_type: 'two-way',
    options: ['major', 'minor', 'patch'],
    description: "Version bump: major, minor, or patch?",
  },

  // -----------------------------------------------------------------------
  // /review — pre-landing code review
  // -----------------------------------------------------------------------
  'review-finding-fix': {
    id: 'review-finding-fix',
    skill: 'review',
    category: 'approval',
    door_type: 'two-way',
    options: ['fix-now', 'ack-and-ship', 'false-positive'],
    signal_key: 'code-quality-care',
    description: "Review finding — fix now, ack and ship, or false positive?",
  },
  'review-sql-safety': {
    id: 'review-sql-safety',
    skill: 'review',
    category: 'approval',
    door_type: 'one-way',
    options: ['fix-now', 'investigate'],
    description: "Potential SQL injection / unsafe query — fix or investigate further?",
  },
  'review-llm-trust-boundary': {
    id: 'review-llm-trust-boundary',
    skill: 'review',
    category: 'approval',
    door_type: 'one-way',
    options: ['fix-now', 'investigate'],
    description: "LLM trust boundary violation — fix before merge?",
  },

  // -----------------------------------------------------------------------
  // /office-hours — YC diagnostic + builder brainstorm
  // -----------------------------------------------------------------------
  'office-hours-mode-goal': {
    id: 'office-hours-mode-goal',
    skill: 'office-hours',
    category: 'routing',
    door_type: 'two-way',
    options: ['startup', 'intrapreneur', 'hackathon', 'oss-research', 'learning', 'fun'],
    signal_key: 'session-mode',
    description: "What's your goal with this session? (Sets mode: startup vs builder)",
  },
  'office-hours-premise-confirm': {
    id: 'office-hours-premise-confirm',
    skill: 'office-hours',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'reject'],
    description: "Premise check — agree or disagree?",
  },
  'office-hours-cross-model-run': {
    id: 'office-hours-cross-model-run',
    skill: 'office-hours',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    description: "Want a second-opinion cross-model review of your brainstorm?",
  },
  'office-hours-landscape-privacy-gate': {
    id: 'office-hours-landscape-privacy-gate',
    skill: 'office-hours',
    category: 'approval',
    door_type: 'one-way',
    options: ['accept', 'skip'],
    description: "Run a web search for landscape awareness? (Sends generalized terms to search provider.)",
  },
  'office-hours-approach-choose': {
    id: 'office-hours-approach-choose',
    skill: 'office-hours',
    category: 'routing',
    door_type: 'two-way',
    options: ['minimal', 'ideal', 'creative'],
    signal_key: 'scope-appetite',
    description: "Which implementation approach? (minimal viable vs ideal architecture vs creative lateral)",
  },
  'office-hours-design-doc-approve': {
    id: 'office-hours-design-doc-approve',
    skill: 'office-hours',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'revise', 'restart'],
    description: "Approve the design doc, revise sections, or start over?",
  },

  // -----------------------------------------------------------------------
  // /plan-ceo-review — scope & strategy
  // -----------------------------------------------------------------------
  'plan-ceo-review-mode': {
    id: 'plan-ceo-review-mode',
    skill: 'plan-ceo-review',
    category: 'routing',
    door_type: 'two-way',
    options: ['expand', 'selective', 'hold', 'reduce'],
    signal_key: 'scope-appetite',
    description: "Review mode: push scope up, cherry-pick expansions, hold scope, or cut to minimum?",
  },
  'plan-ceo-review-expansion-proposal': {
    id: 'plan-ceo-review-expansion-proposal',
    skill: 'plan-ceo-review',
    category: 'cherry-pick',
    door_type: 'two-way',
    options: ['accept', 'defer', 'skip'],
    signal_key: 'scope-appetite',
    description: "Scope expansion proposal — add to plan, defer to TODOs, or skip?",
  },
  'plan-ceo-review-premise-revise': {
    id: 'plan-ceo-review-premise-revise',
    skill: 'plan-ceo-review',
    category: 'approval',
    door_type: 'one-way',
    options: ['revise', 'hold'],
    description: "Cross-model challenged an agreed premise — revise or keep?",
  },
  'plan-ceo-review-outside-voice': {
    id: 'plan-ceo-review-outside-voice',
    skill: 'plan-ceo-review',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    description: "Get an outside-voice second opinion on the plan?",
  },
  'plan-ceo-review-promote-to-docs': {
    id: 'plan-ceo-review-promote-to-docs',
    skill: 'plan-ceo-review',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'keep-local', 'skip'],
    description: "Promote the CEO plan to docs/designs/ in the repo?",
  },

  // -----------------------------------------------------------------------
  // /plan-eng-review — architecture & tests (required gate)
  // -----------------------------------------------------------------------
  'plan-eng-review-arch-finding': {
    id: 'plan-eng-review-arch-finding',
    skill: 'plan-eng-review',
    category: 'approval',
    door_type: 'one-way',
    options: ['fix-now', 'defer', 'accept-risk'],
    signal_key: 'architecture-care',
    description: "Architecture finding — fix, defer, or accept the risk?",
  },
  'plan-eng-review-scope-reduce': {
    id: 'plan-eng-review-scope-reduce',
    skill: 'plan-eng-review',
    category: 'routing',
    door_type: 'two-way',
    options: ['reduce', 'hold'],
    signal_key: 'scope-appetite',
    description: "Plan touches 8+ files — reduce scope or hold?",
  },
  'plan-eng-review-test-gap': {
    id: 'plan-eng-review-test-gap',
    skill: 'plan-eng-review',
    category: 'approval',
    door_type: 'two-way',
    options: ['add-test', 'defer', 'skip'],
    signal_key: 'test-discipline',
    description: "Test gap identified — add now, defer, or skip?",
  },
  'plan-eng-review-outside-voice': {
    id: 'plan-eng-review-outside-voice',
    skill: 'plan-eng-review',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    description: "Get an outside-voice second opinion on the plan?",
  },
  'plan-eng-review-todo-add': {
    id: 'plan-eng-review-todo-add',
    skill: 'plan-eng-review',
    category: 'cherry-pick',
    door_type: 'two-way',
    options: ['accept', 'skip', 'build-now'],
    description: "Proposed TODO item — add to TODOs, skip, or build in this PR?",
  },

  // -----------------------------------------------------------------------
  // /plan-design-review — UI/UX plan audit
  // -----------------------------------------------------------------------
  'plan-design-review-mode': {
    id: 'plan-design-review-mode',
    skill: 'plan-design-review',
    category: 'routing',
    door_type: 'two-way',
    options: ['expand', 'polish', 'triage'],
    signal_key: 'design-care',
    description: "Design review depth: expand for competitive edge, polish every touchpoint, or triage critical gaps?",
  },
  'plan-design-review-fix': {
    id: 'plan-design-review-fix',
    skill: 'plan-design-review',
    category: 'approval',
    door_type: 'two-way',
    options: ['fix-now', 'defer', 'skip'],
    signal_key: 'design-care',
    description: "Design issue flagged — fix now, defer to TODOs, or skip?",
  },

  // -----------------------------------------------------------------------
  // /plan-devex-review — developer experience plan audit
  // -----------------------------------------------------------------------
  'plan-devex-review-persona': {
    id: 'plan-devex-review-persona',
    skill: 'plan-devex-review',
    category: 'clarification',
    door_type: 'two-way',
    description: "Who is your target developer? (Determines persona for review.)",
  },
  'plan-devex-review-mode': {
    id: 'plan-devex-review-mode',
    skill: 'plan-devex-review',
    category: 'routing',
    door_type: 'two-way',
    options: ['expand', 'polish', 'triage'],
    signal_key: 'devex-care',
    description: "DX review depth: expand for competitive advantage, polish every touchpoint, or triage critical gaps?",
  },
  'plan-devex-review-friction-fix': {
    id: 'plan-devex-review-friction-fix',
    skill: 'plan-devex-review',
    category: 'approval',
    door_type: 'two-way',
    options: ['fix-now', 'defer', 'skip'],
    signal_key: 'devex-care',
    description: "Friction point in the developer journey — fix now, defer, or skip?",
  },

  // -----------------------------------------------------------------------
  // /qa — QA testing
  // -----------------------------------------------------------------------
  'qa-bug-fix-scope': {
    id: 'qa-bug-fix-scope',
    skill: 'qa',
    category: 'approval',
    door_type: 'two-way',
    options: ['fix-now', 'defer', 'skip'],
    signal_key: 'code-quality-care',
    description: "Bug found during QA — fix now, defer, or skip?",
  },
  'qa-tier': {
    id: 'qa-tier',
    skill: 'qa',
    category: 'routing',
    door_type: 'two-way',
    options: ['quick', 'standard', 'deep'],
    description: "QA tier: quick (critical/high only), standard (+medium), or deep (+low)?",
  },

  // -----------------------------------------------------------------------
  // /investigate — root-cause debugging
  // -----------------------------------------------------------------------
  'investigate-hypothesis-confirm': {
    id: 'investigate-hypothesis-confirm',
    skill: 'investigate',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'reject', 'refine'],
    description: "Root-cause hypothesis — accept, reject, or refine before proceeding to fix?",
  },
  'investigate-fix-apply': {
    id: 'investigate-fix-apply',
    skill: 'investigate',
    category: 'approval',
    door_type: 'one-way',
    options: ['accept', 'reject'],
    description: "Apply the proposed fix?",
  },

  // -----------------------------------------------------------------------
  // /land-and-deploy — merge + deploy + verify
  // -----------------------------------------------------------------------
  'land-and-deploy-merge-confirm': {
    id: 'land-and-deploy-merge-confirm',
    skill: 'land-and-deploy',
    category: 'approval',
    door_type: 'one-way',
    options: ['accept', 'reject'],
    description: "Merge this PR to base branch?",
  },
  'land-and-deploy-rollback': {
    id: 'land-and-deploy-rollback',
    skill: 'land-and-deploy',
    category: 'approval',
    door_type: 'one-way',
    options: ['accept', 'reject'],
    description: "Canary detected regressions — roll back the deploy?",
  },

  // -----------------------------------------------------------------------
  // /cso — security audit
  // -----------------------------------------------------------------------
  'cso-global-scan-approval': {
    id: 'cso-global-scan-approval',
    skill: 'cso',
    category: 'approval',
    door_type: 'one-way',
    options: ['accept', 'deny'],
    description: "Run a global security scan? (Scans files outside this branch.)",
  },
  'cso-finding-fix': {
    id: 'cso-finding-fix',
    skill: 'cso',
    category: 'approval',
    door_type: 'one-way',
    options: ['fix-now', 'defer', 'accept-risk'],
    description: "Security finding — fix, defer to TODOs, or accept the risk?",
  },

  // -----------------------------------------------------------------------
  // /gstack-upgrade — version upgrade
  // -----------------------------------------------------------------------
  'gstack-upgrade-inline': {
    id: 'gstack-upgrade-inline',
    skill: 'gstack-upgrade',
    category: 'approval',
    door_type: 'two-way',
    options: ['yes-upgrade', 'always-auto', 'not-now', 'never-ask'],
    description: "Upgrade gstack now? (Also: always auto-upgrade, snooze, or disable the prompt.)",
  },

  // -----------------------------------------------------------------------
  // Preamble one-time prompts (telemetry, proactive, routing)
  // -----------------------------------------------------------------------
  'preamble-telemetry-consent': {
    id: 'preamble-telemetry-consent',
    skill: 'preamble',
    category: 'approval',
    door_type: 'two-way',
    options: ['community', 'anonymous', 'off'],
    description: "Share usage data with gstack? community (recommended) / anonymous / off",
  },
  'preamble-proactive-behavior': {
    id: 'preamble-proactive-behavior',
    skill: 'preamble',
    category: 'approval',
    door_type: 'two-way',
    options: ['on', 'off'],
    description: "Let gstack proactively suggest skills based on conversation context?",
  },
  'preamble-routing-injection': {
    id: 'preamble-routing-injection',
    skill: 'preamble',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'decline'],
    description: "Add gstack skill routing rules to CLAUDE.md?",
  },
  'preamble-vendored-migration': {
    id: 'preamble-vendored-migration',
    skill: 'preamble',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'keep-vendored'],
    description: "This repo has vendored gstack (deprecated) — migrate to team mode?",
  },
  'preamble-completeness-intro': {
    id: 'preamble-completeness-intro',
    skill: 'preamble',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    description: "Open the Boil-the-Lake essay in your browser? (one-time intro)",
  },
  'preamble-cross-project-learnings': {
    id: 'preamble-cross-project-learnings',
    skill: 'preamble',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'reject'],
    description: "Enable cross-project learnings search? (local only, helpful for solo devs)",
  },

  // -----------------------------------------------------------------------
  // /plan-tune — the skill itself
  // -----------------------------------------------------------------------
  'plan-tune-enable-setup': {
    id: 'plan-tune-enable-setup',
    skill: 'plan-tune',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'skip'],
    description: "Question tuning is off — enable it and set up your profile?",
  },
  'plan-tune-declared-dimension': {
    id: 'plan-tune-declared-dimension',
    skill: 'plan-tune',
    category: 'clarification',
    door_type: 'two-way',
    description: "Self-declaration question (one per dimension during /plan-tune setup)",
  },
  'plan-tune-confirm-mutation': {
    id: 'plan-tune-confirm-mutation',
    skill: 'plan-tune',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'reject'],
    description: "Confirm profile change before writing (user sovereignty gate for free-form edits)",
  },

  // -----------------------------------------------------------------------
  // /autoplan — sequential auto-review
  // -----------------------------------------------------------------------
  'autoplan-taste-decision': {
    id: 'autoplan-taste-decision',
    skill: 'autoplan',
    category: 'approval',
    door_type: 'two-way',
    options: ['accept', 'override', 'investigate'],
    description: "Autoplan surfaced a taste decision at the final gate — accept, override, or investigate?",
  },
  'autoplan-user-challenge': {
    id: 'autoplan-user-challenge',
    skill: 'autoplan',
    category: 'approval',
    door_type: 'one-way',
    options: ['accept', 'reject', 'revise'],
    description: "Both models agree your direction should change — accept, reject, or revise the plan?",
  },
} as const satisfies Record<string, QuestionDef>;

export type RegisteredQuestionId = keyof typeof QUESTIONS;

/**
 * Runtime lookup — returns undefined for ad-hoc question_ids (not registered).
 * Ad-hoc ids still log; they just don't get psychographic signal attribution.
 */
export function getQuestion(id: string): QuestionDef | undefined {
  return (QUESTIONS as Record<string, QuestionDef>)[id];
}

/** Get all registered one-way door question ids (used by sensitivity checker) */
export function getOneWayDoorIds(): Set<string> {
  return new Set(
    Object.values(QUESTIONS as Record<string, QuestionDef>)
      .filter((q) => q.door_type === 'one-way')
      .map((q) => q.id),
  );
}

/** All registered question ids, for CI completeness checks */
export function getAllRegisteredIds(): Set<string> {
  return new Set(Object.keys(QUESTIONS));
}

/** Registry stats, for /plan-tune stats */
export function getRegistryStats() {
  const all = Object.values(QUESTIONS as Record<string, QuestionDef>);
  const bySkill: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let oneWay = 0;
  let twoWay = 0;
  for (const q of all) {
    bySkill[q.skill] = (bySkill[q.skill] ?? 0) + 1;
    byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
    if (q.door_type === 'one-way') oneWay++;
    else twoWay++;
  }
  return {
    total: all.length,
    one_way: oneWay,
    two_way: twoWay,
    by_skill: bySkill,
    by_category: byCategory,
  };
}
