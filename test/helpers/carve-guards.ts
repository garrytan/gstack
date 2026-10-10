/**
 * Canonical carved-skill guard registry — the single source of truth for which
 * skills are carved (skeleton SKILL.md + on-demand sections/*.md) and what each
 * carve must guarantee.
 *
 * PURE LEAF DATA MODULE (codex outside-voice #1, refined-plan pass): this file
 * has NO runtime imports — `import type` only. parity-harness.ts and
 * skill-size-budget.test.ts derive their carved-skill lists FROM here (no
 * parallel hand-maintained lists), so a runtime import back into either of them
 * would create a cycle. Keep it data.
 *
 * Consumers:
 *   - test/carve-section-ordering.test.ts   (E2, gate)  → staticInvariants
 *   - test/carve-section-loading-*.test.ts    (T2, periodic) → requiredReads + scenario
 *   - test/carve-guard-completeness.test.ts (E1, gate)  → the set must equal the
 *                                                          filesystem carved set
 *   - test/carve-guards-negative.test.ts    (ET1, gate) → injects a broken fixture
 *   - test/helpers/parity-harness.ts        → sectioned/maxSkeletonBytes/minBytes/mustContain
 *   - test/skill-size-budget.test.ts        → SECTIONS_EXTRACTED = CARVED_SKILLS
 *
 * Adding a carve = add one entry here (atomically, in the same commit as the
 * skeleton + manifest + sections — codex #4 — so E1's bidirectional parity never
 * false-positives mid-commit).
 */

/** Static (skeleton-shape) invariants the per-PR ordering guard (E2) asserts. */
export interface CarveStaticInvariants {
  /**
   * Substrings that MUST remain in the always-loaded skeleton. Empty = skip
   * (the skill has no distinctive pre-STOP anchor worth pinning beyond the
   * universal STOP/section-index checks E2 already runs).
   */
  mustStayInSkeleton: string[];
  /**
   * Substrings that MUST appear in the skeleton BEFORE the first STOP-Read
   * (earliest-use, codex #6). For cso: mode-dispatch directives (## Arguments,
   * ## Mode Resolution) must be resolved before any section is read — a dispatch
   * directive stranded after the STOP can't govern which sections to read.
   * Empty/undefined = skip (most skills).
   */
  mustPrecedeStop?: string[];
  /**
   * Substrings that MUST be in the union (skeleton + sections) but MUST NOT be in
   * the skeleton — i.e. the heavy body that the carve relocated. Empty = skip.
   */
  mustMoveToSection: string[];
  /**
   * If set, this marker must appear in the skeleton AFTER the last STOP-Read
   * directive (e.g. the EXIT PLAN MODE GATE that fires once section work returns).
   * Undefined = the skill has no post-STOP gate (operational/conversational carve).
   */
  gateAfterStop?: string;
}

export interface CarveGuard {
  skill: string;
  /** Section .md filenames the manifest lists and the skeleton must STOP-Read. */
  expectedSections: string[];
  /**
   * Sections the behavioral test (T2) asserts the agent actually Read when driven
   * by `scenario`. A non-empty subset of expectedSections — the ones the scenario
   * is built to require. The registry owns this so "registered ⇒ asserted" is
   * structural (codex #2), not policed.
   */
  requiredReads: string[];
  /**
   * Fixture prompt that drives a real `claude -p` run down the STOP-Read path for
   * this skill (codex #7). The behavioral test asserts the run reached the STOP
   * (read requiredReads), not merely that nothing was read.
   */
  scenario: string;
  staticInvariants: CarveStaticInvariants;
  /**
   * How the behavioral guard (T2) exercises this skill:
   *  - 'plan'     → write a PLAN.md fixture, run the review against it
   *  - 'prompt'   → no fixture file; the scenario prompt alone drives the run
   *  - 'external' → covered by a dedicated bespoke test (complex fixtures, e.g.
   *                 ship's git/VERSION/CHANGELOG state). The data-driven loop
   *                 skips it; E1 asserts `externalTest` exists instead.
   *  - 'none'     → no behavioral guard; the static invariants still apply.
   */
  behavioral: 'plan' | 'prompt' | 'external' | 'none';
  /** Required when behavioral === 'external': path (repo-relative) to the dedicated test. */
  externalTest?: string;
  /** Parity: max bytes for the always-loaded skeleton (asserts the carve shrank it). */
  maxSkeletonBytes: number;
  /** Parity: min bytes for the skeleton+sections union (total behavior preserved). */
  minUnionBytes: number;
  /** Parity: content phrases the union must preserve. */
  mustContain: string[];
  /**
   * Parity: optional per-skill override for the union size-growth ceiling vs the
   * v1.53.0.0 baseline (default 1.05). Bumped only when a deliberate cross-cutting
   * preamble feature legitimately grows a smaller carved skeleton past 5%.
   */
  maxSizeRatio?: number;
}

export const CARVE_GUARDS: Record<string, CarveGuard> = {
  ship: {
    skill: 'ship',
    expectedSections: [
      'apple-release.md',
      'tests.md',
      'test-coverage.md',
      'plan-completion.md',
      'review-army.md',
      'shared-code-reuse.md',
      'greptile.md',
      'adversarial.md',
      'changelog.md',
      'documentation.md',
      'pr-body.md',
    ],
    requiredReads: ['review-army.md', 'changelog.md', 'documentation.md'],
    scenario:
      'This is a FRESH version-changing ship: the branch has a real code change, VERSION still equals the base version (needs a bump), and CHANGELOG.md needs a new entry. Follow the skill flow for a version-changing ship: run the pre-landing review and prepare the CHANGELOG entry. Produce the ship plan / review report. Do NOT actually commit, push, or open a PR.',
    staticInvariants: {
      // The PR-title-version invariant MUST stay always-loaded: the v1.54.0.0
      // carve stranded it in pr-body.md and PRs started landing with bare titles
      // (CI backstop: test/pr-title-sync-workflow-safety.test.ts).
      // Same carve also stranded the Step 18 /document-release dispatch out of
      // sight — the skeleton never named it and the handoff "got lost" (#2666
      // follow-up). Three NON-OVERLAPPING anchors pin the restored visibility,
      // one per touchpoint (no anchor is a substring of another, so each is
      // independently enforced — a subsumed anchor adds zero enforcement):
      //   gerund form  → manifest trigger (renders 2x: section index + STOP)
      //   mandatory handoff → Step 17 handoff line
      //   3rd person   → hoisted doc-sync invariant
      // Matching is case-sensitive String.includes — "dispatching the" does NOT
      // contain "dispatch the" — so update anchors in lockstep with any
      // touchpoint rewording.
      mustStayInSkeleton: [
        'The pr-body section prepares the title from that result',
        '## Step 14.5: Documentation audit (every ship)',
        'No documentation writer runs after push',
        'dispatches the /document-release subagent',
      ],
      // ...while the full create/update procedure stays carved into pr-body.md
      // (out of the skeleton, present in the union). Asserts BOTH PR paths
      // survive: the create path and the idempotent update path, both posted
      // through gstack-post, and the version-prefixed title preparation that
      // moved into the section with them (Oct 7 wave B4). The Step 18
      // dispatch imperative stays carved too — pasting that literal into the
      // skeleton (correctly) fails this guard; the skeleton speaks of "the
      // /document-release subagent", never the carved imperative.
      mustMoveToSection: [
        'gstack-post pr-create --base',
        'gstack-post pr-title',
        'gstack-pr-title-rewrite.sh <new-version> --stdin',
        'Dispatch /document-release as a subagent',
      ],
      // ship is operational (multi-STOP, not a plan review); no single post-STOP gate.
      gateAfterStop: undefined,
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-ship-section-loading.test.ts',
    maxSkeletonBytes: 79_300, // + v2.0 {{ASIDE_RESEARCH}} (Aside first, WebSearch fallback); measured 78_275
    minUnionBytes: 181_000, // token-reduction Phases 1-2 (v1.69.x branch); measured union 201,464
    mustContain: ['VERSION', 'CHANGELOG', 'review', 'merge', 'PR'],
    // v1.58.5.0: pre-push-guard install (#2077) stacks on the shared first-run-guidance preamble.
    // Fork port wave 2: multi-ecosystem test-detection evidence (Django/JVM
    // markers, test-file census — e3259078 port) + the #1079 gh pr edit REST
    // fallback grew the union to 1.090x; the third-party web-actions
    // contract (consent-gated browser drive for API-key registration etc.)
    // adds ~2.3KB inline judgment, measured 1.103x. The Apple release
    // adapter (14.8KB carved section, 21 live releases of judgment — the
    // wave's headline capability) grows the union to 1.195x. Deliberate:
    // the section is on-demand (loads only for Apple store targets), so
    // per-invocation cost for non-iOS ships is one manifest line.
    maxSizeRatio: 1.5700, // Shared advisory identity/dedup + critical-severity validation: 248,065 union bytes / 187,706 baseline = 1.3216 (2026-09-17). + test value bar in the lazy Step 7 section (value cards, weak paths, gate table, base control, machine checks; ~13.6KB): measured 1.396 (2026-09-29). + W1 guarded state-root resolution (`eval gstack-paths; : "${GSTACK_STATE_ROOT:?…}"`) in the Context Recovery preamble, the eureka log and each state-writing bash block; measured 1.401 (2026-09-30). + the shared QA review step's plan-check timing rule (plan checks and their revalidation run on --timeout-ms after smoke expiry); measured 1.4022 (2026-09-30). + the shared TEST_BOOTSTRAP owned-change undo rules (s03 H1-H3, M1) and the value-bar coverage wording (s03 M2/M3); measured 1.4044 (2026-10-02). + severe fix wave ship-review lane: G1 NO_VERSION dispatch, title and CHANGELOG arms (versionless repos ship without inventing a version), F1 parent-side plan binding before the audit dispatch (binding, docs/designs candidates, exact not-run line) and D3's data-not-instructions line; +2,126 union bytes, measured 1.4135 (2026-10-03). + INV-1 consumer lines (outside review `unverified`/`unavailable` is missing coverage in the readiness note and PR body); measured 1.4148 (2026-10-03). + v1.91.19.0 severe fix wave: verdict-form outside-review callers with sandbox preflight and first-use notice (INV-1/B1/Q2), P0/P1 gate and unverified wording, bound-plan discovery (F1), visible LEARNINGS failures (B5), carved external pointers; measured 267,752 / 187,706 = 1.4264 (2026-10-03). + v1.91.18.0 (#3023) merged into the v1.91.19.0 wave; measured 267,874 / 187,706 = 1.4271 (2026-10-04). + Oct 6 fix wave: quota_exhausted preflight branch (#3051) and quoted-heredoc issue template (#3046); measured 268,199 / 187,706 = 1.4288 (2026-10-06). + Step 10's inline no-PR check before the Greptile dispatch (#3020); measured 268,655 / 187,706 = 1.4313 (2026-10-06). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); measured 275,422 / 187,706 = 1.4673 (2026-10-06). Combined Oct 6 wave head (B free-text files + D measure loop + A rework): measured 280,363 / 187,706 = 1.4936 (2026-10-06). + gate-once push rule (no second paid gate after a CI push); measured 280,573 / 187,706 = 1.4947 (2026-10-06). + the measurement bar's decision step (exit-code branches for MEETS, MEETS-qualified, needs-classify with the qualifying and fix-round classes, EXTEND once; the measure prose was tightened to offset most of it); measured 281,058 / 187,706 = 1.4973 (2026-10-06). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; measured 281,438 / 187,706 = 1.4994 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; measured 281,556 / 187,706 = 1.5000 (2026-10-07). + Oct 7 wave B4: /ship publishes through gstack-post (title prepared in a file in the pr-body section, compose block plus gstack-post exit-code branches replacing the two scans); measured 281,894 / 187,706 = 1.5018 (2026-10-07). + B2 early Greptile PR (lazy Step 6.5 section: detect, public-repo consent, push, provisional title file, open; Step 10's bounded wait; the stop-leaves-the-draft rule); measured 286,626 / 187,706 = 1.5270 (2026-10-07). B3, the classifier, B4 and B2 merged: measured 287,128 / 187,706 = 1.5297 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site; measured 281,370 / 187,706 = 1.4990 (2026-10-07). Merged with the guard area: measured 287,440 / 187,706 = 1.5313 (2026-10-07). + Oct 8 wave: the defensive-security framing and fixture summary mode reach the security specialist and the Red Team (stated once in the dispatch, referenced by the Red Team); measured 288,783 / 187,706 = 1.5385 (2026-10-08). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); plus Step 7's implementer dispatch rules and Step 8's parent-computed ACCEPTANCE_EDITED check (W5/W7); measured 294,075 / 187,706 = 1.5667 (2026-10-10).
  },
  'plan-ceo-review': {
    skill: 'plan-ceo-review',
    expectedSections: ['review-sections.md'],
    requiredReads: ['review-sections.md'],
    scenario:
      'Review the plan in PLAN.md. Hold the current scope (HOLD SCOPE mode) — do not challenge or expand scope. Run the full CEO review and produce the review report.',
    staticInvariants: {
      mustStayInSkeleton: ['## Step 0: Nuclear Scope Challenge'],
      mustMoveToSection: ['### Section 1: Architecture Review', '## Mode Quick Reference'],
      gateAfterStop: 'EXIT PLAN MODE GATE',
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-plan-ceo-review-section-loading.test.ts',
    // v1.65 merge: provisional larger-of-both-waves budget; re-measured below.
        // Fork port wave 2 (#703): the repo-doc-preference block in the design
    // check grew every plan-review skeleton ~0.7KB. Measured values noted.
    maxSkeletonBytes: 80_850, // + depth-specific output and 0H/0I feasibility boundary clarity + the Aside probe's failure reason; measured 80,111. + W1 guarded state-root resolution (`eval gstack-paths; : "${GSTACK_STATE_ROOT:?…}"`) in the Context Recovery preamble, the eureka log and each state-writing bash block; measured 80,649 (2026-09-30); + the same guard in the CEO spec-review metrics block; measured 80,812 (2026-09-30).
    minUnionBytes: 123_600, // token-reduction Phases 1-2 (v1.69.x branch): preamble bash -> bin/gstack-skill-start, onboarding -> gated emission; measured union 137,346
    mustContain: ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'],
    // Default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose replacing the smaller opt-in question) lands this ~5.2% over baseline.
    maxSizeRatio: 1.081, // + the Aside probe's failure reason; measured 1.0803
  },
  'plan-eng-review': {
    skill: 'plan-eng-review',
    expectedSections: ['review-sections.md'],
    requiredReads: ['review-sections.md'],
    scenario:
      'Review the plan in PLAN.md. Accept the current scope. Run the full engineering review (architecture, code quality, tests, performance) and produce the review report.',
    staticInvariants: {
      mustStayInSkeleton: ['### Step 0: Scope Challenge'],
      mustMoveToSection: ['### 1. Architecture review'],
      gateAfterStop: 'EXIT PLAN MODE GATE',
    },
    behavioral: 'plan',
    // v1.2.0 activation lift (shared first-run-guidance preamble) + #2077 ask-first scope gate.
    // +~1 KB: plan-mode auto-select-B scope-gate exceptions (2026-08).
    // v1.65 merge: provisional larger-of-both-waves budget; re-measured below.
        // Fork port wave 2 (#703): the repo-doc-preference block in the design
    // check grew every plan-review skeleton ~0.7KB. Measured values noted.
    // #2499 project-scope MCP jq in the brain-sync block grew every tier-2+
    // skeleton ~1.5KB (entry resolution emitted once per SKILL.md).
    maxSkeletonBytes: 57_800, // Scoped reuse entry guidance; measured 57,549 bytes (2026-09-16). Shared rubric remains in the existing section.
    minUnionBytes: 99_800, // token-reduction Phases 1-2 (v1.69.x branch); measured union 110,910
    mustContain: ['Architecture', 'Code Quality', 'Test', 'Performance'],
    // Cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback + the
    // decision-memory nudge + the v1.57.4.0 Boil-the-Ocean rename) plus the
    // default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose, replacing the smaller opt-in question) land this at ~6.6% over the
    // v1.53.0.0 baseline. Headroom for those intentional additions.
    // 1.08 → 1.10: the scope-gate exceptions block (+ its adversarial-review
    // hardening: host-anchored mode signal, precedence, passing-mention
    // guards) and the plan-mode preamble reword land the union at 1.092.
    maxSizeRatio: 1.1870, // + clarity rules for saved decisions/setup gates + the Aside probe's failure reason; measured 1.1504. + test value bar and Tests to Retire in the lazy Test review section (~2.6KB); measured 1.168 + W1 guarded state-root resolution (`eval gstack-paths; : "${GSTACK_STATE_ROOT:?…}"`) in the Context Recovery preamble, the eureka log and each state-writing bash block; measured 1.173 (2026-09-30). + v1.91.12.0 merge of #2999 (headless rule: a disallowed question tool never qualifies) with #3002; measured 1.1741 (2026-10-01). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); measured 146,905 / 124,597 = 1.1790 (2026-10-06). Combined Oct 6 wave head (A and B): measured 147,524 / 124,597 = 1.1840 (2026-10-06). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; measured 147,693 / 124,597 = 1.1854 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; measured 147,752 / 124,597 = 1.1858 (2026-10-07). + fix wave PR D: the prerequisite offer is skipped in spawned/headless sessions (#1958); measured 147,864 / 124,597 = 1.1867 (2026-10-07).
  },
  'plan-design-review': {
    skill: 'plan-design-review',
    expectedSections: ['review-sections.md'],
    requiredReads: ['review-sections.md'],
    scenario:
      'Review the plan in PLAN.md for design and UX. Accept the current scope. Run the full design review passes and produce the review report.',
    staticInvariants: {
      mustStayInSkeleton: [],
      mustMoveToSection: ['### Pass 1: Information Architecture'],
      gateAfterStop: 'EXIT PLAN MODE GATE',
    },
    behavioral: 'plan',
    // +Conductor AUQ-default-prose rule + one-way/continuation safety in the
    // always-loaded AskUserQuestion Format section.
    // v1.2.0 activation lift (shared first-run-guidance preamble) + #2077 ask-first scope gate.
    // +~1.3 KB: plan-mode auto-select-B scope-gate exceptions (2026-08).
    // Fork port wave 2 (D1): evidence directive adds ~0.45KB to every
    // tier-2+ skeleton (measured 89,184). Main's v1.64.0.0 adds ~340 B more
    // (telemetry --error-message/--failed-step preamble prose, PR #769).
    // Budget covers the sum of both waves.
    maxSkeletonBytes: 85_600, // Harness-aware outside voice: validated dispatch and provenance. + v1.91.19.0 wave: design --version probe (B4) and verdict-form outside voice (INV-1) on top of v1.91.17.0's round accounting (#3022); measured 80,443 (2026-10-03). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); skeleton measured 84,669 (2026-10-06). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; skeleton measured 84,804 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; skeleton measured 84,863 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site; skeleton measured 84,748 (2026-10-07). Merged with the guard area: measured skeleton 84,945 (2026-10-07). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); skeleton measured 85,446 (2026-10-10).
    minUnionBytes: 99_200, // token-reduction Phases 1-2 (v1.69.x branch); measured union 110,293
    mustContain: ['design', 'visual'],
    maxSizeRatio: 1.12, // D1 1.104 + main's ~0.008
  },
  'plan-devex-review': {
    skill: 'plan-devex-review',
    expectedSections: ['review-sections.md'],
    requiredReads: ['review-sections.md'],
    scenario:
      'Review the plan in PLAN.md for developer experience. Accept the current scope. Run the full DX review passes and produce the review report.',
    staticInvariants: {
      mustStayInSkeleton: [],
      mustMoveToSection: ['### Pass 1: Getting Started Experience'],
      gateAfterStop: 'EXIT PLAN MODE GATE',
    },
    behavioral: 'plan',
    // +Conductor AUQ-default-prose rule + one-way/destructive prose safety +
    // continuation protocol in the always-loaded AskUserQuestion Format section.
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble.
        // Fork port wave 2 (#703): the repo-doc-preference block in the design
    // check grew every plan-review skeleton ~0.7KB. Measured values noted.
    // #2499 project-scope MCP jq in the brain-sync block grew every tier-2+
    // skeleton ~1.5KB (entry resolution emitted once per SKILL.md).
    maxSkeletonBytes: 68_550, // + v2.0 {{ASIDE_RESEARCH}} (Aside first, WebSearch fallback) + the Aside probe's failure reason; measured 68_544
    minUnionBytes: 99_700, // token-reduction Phases 1-2 (v1.69.x branch); measured union 110,833
    mustContain: ['developer experience', 'Getting Started'],
    // Default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose replacing the smaller opt-in question) lands this ~5.7% over baseline.
    maxSizeRatio: 1.08,
  },
  'office-hours': {
    skill: 'office-hours',
    expectedSections: ['design-and-handoff.md', 'phase-2a-startup-diagnostic.md', 'phase-2b-builder-brainstorm.md'],
    // This fixture fixes startup mode; both its diagnostic and closing must run.
    requiredReads: ['phase-2a-startup-diagnostic.md', 'design-and-handoff.md'],
    scenario: `Run office hours in STARTUP mode through the diagnostic, premise challenge,
alternatives, design document, spec review, approval, and relationship closing.
This is a synthetic interview fixture, not a supplied implementation plan.

Product idea: RosterCheck, a simpler way for adult craft-class organizers to turn
registrations from two CSV exports into a correct printable check-in list.

Use these founder answers for the diagnostic conversation. Challenge them, but do
not invent customers, quotes, payments, or usage, or present proposed requirements
as established founder answers. Anything not established below is unknown and can
remain an open question or an assignment.
- I run weekend ceramics workshops and can code. I have two weeks of evenings,
  a $100 budget, and no team. There is no product or existing implementation.
- I interviewed seven independent workshop organizers. Three shared redacted
  sample exports and two asked to try a pilot at their next event. Nobody has
  paid, committed to a price, or used a prototype. Interest is not proven demand.
- Lee, the owner/instructor at Clay Room, is the first pilot candidate. Lee runs
  classes of 10-30 adults and combines marketplace bookings with direct bookings
  recorded in a spreadsheet. Lee said: "I just want to know nobody's missing
  when I print the list." One booking was missed last month; no refund or lost
  revenue has been established.
- Today Lee copies the two exports into a spreadsheet, sorts names, checks
  duplicates manually, and prints it. Lee reports about 30 minutes per event.
  I have not watched this unaided or timed it myself; that baseline is unverified.
- The initial pilot can use manual CSV exports for one organizer/event at a
  time. Ambiguous duplicates need a human decision, never silent merging.
  No provider API, payments, automatic emails, customer accounts, or hosted
  customer data in this pilot. Keep attendee data local to the organizer.
- Success to test: a correct list in under five minutes at three pilot events,
  with every source booking accounted for and discrepancies checked by Lee.
  Willingness to pay and repeat usage are unknown. The seven interview contacts
  are my only distribution channel; no invented acquisition metrics.

Use the available Agent tool for the independent opinion and spec review when
the workflow calls for them. The independent opinion is read-only. The spec
reviewer may use Write only for the exact JSON verdict path assigned by prepare;
all other reviewer mutations remain prohibited. An automated test is not a reason
to skip them. This fixture checks separate real tool calls: obtain the independent
opinion on RosterCheck before writing the design, then have a reviewer read the
written design. A self-authored "second opinion" is not a subagent result.
Keep the normal revision/convergence rules and report any unresolved concerns
honestly. Save the design to docs/designs/roster-check.md in this fixture;
keep all artifacts inside the fixture. After the review, choose the recommended
design approval and mark the design APPROVED before the relationship closing.
Include the assignment and concise "Spec Review" and "Handoff" sections in the
final REPORT.md with the review disposition and next-skill recommendation.
In "Spec Review", write one terminal field, "Disposition: COMPLETED",
"Disposition: CONCERNS_RECORDED", or "Disposition: UNREVIEWED", followed by what
happened (including unresolved concerns or a failed review attempt, if any).
The user has already answered the final handoff choice: "Not now — I'll run a
review later." Complete the office-hours closing, then stop;
do not launch the downstream skill or open a browser.`,
    staticInvariants: {
      mustStayInSkeleton: [],
      mustMoveToSection: ['### The Six Forcing Questions', '### Pushback Patterns', 'Anti-Sycophancy Rules', 'Wild exemplar'],
      mustPrecedeStop: ['**Mode mapping:**'],
      gateAfterStop: '## Section self-check',
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-office-hours-section-loading.test.ts',
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble,
    // plus the P1 office-hours closing handoff (AUQ that launches the next skill).
    // v1.65 merge: provisional larger-of-both-waves budget; re-measured below.
    // Fork port wave 2: the third-party web-actions contract sits inline
    // (judgment must be visible before the workflow directs the user to a
    // vendor site), plus the #703 dual-write + repo-doc-preference block and
    // the #538 opt-out + D1 evidence directive — ratio 1.104 measured.
    // #2499 project-scope MCP jq in the brain-sync block grew every tier-2+
    // skeleton ~1.5KB (entry resolution emitted once per SKILL.md).
    maxSkeletonBytes: 95_500, // Office-hours + sketch outside voices include host guards and completion checks. + v1.91.19.0 wave: Q<N> open-question prose form (#2729, approved Q3), DESIGN_READY --version probe (B4), Aside ~/.local/bin fallback (E7), verdict-form outside voice (INV-1), plus v1.91.17.0's round accounting (#3022) merged in; measured 89,684 (2026-10-03). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); skeleton measured 92,590 (2026-10-06). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; skeleton measured 92,869 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; skeleton measured 92,930 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site; skeleton measured 92,756 (2026-10-07). Merged with the guard area: measured skeleton 93,099 (2026-10-07). + fix wave PR D: the Phase 4.5 builder-profile read before the session log (#2801) and the pre-telemetry design-doc check (#1049); measured skeleton 94,877 (2026-10-07). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); skeleton measured 95,354 (2026-10-10).
    minUnionBytes: 115_800, // Phase 4 wave 4; measured union 118,175
    mustContain: ['design doc', 'problem statement'],
    maxSizeRatio: 1.1760, // + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); measured 149,758 / 131,110 = 1.1422 (2026-10-06). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; measured 150,037 / 131,110 = 1.1444 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; measured 150,098 / 131,110 = 1.1448 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site; measured 150,011 / 131,110 = 1.1442 (2026-10-07). Merged with the guard area: measured 150,354 / 131,110 = 1.1468 (2026-10-07). + fix wave PR D: builder-profile read before the session log with Phase 6 using the carried values (#2801), the inline design doc before approval (#879) and the pre-telemetry design-doc check (#1049); measured 153,206 / 131,110 = 1.1685 (2026-10-07). + empty LAST_ASSIGNMENT/LAST_PROJECT guards in the welcome_back and regular greetings (backfilled profiles); measured 153,469 / 131,110 = 1.1705 (2026-10-08). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); measured 153,946 / 131,110 = 1.1742 (2026-10-10).
  },
  'document-release': {
    skill: 'document-release',
    expectedSections: ['audit-scope.md', 'release-body.md'],
    requiredReads: ['audit-scope.md', 'release-body.md'],
    scenario:
      'A PR has shipped a new CLI flag and touched README.md and CHANGELOG.md. Skip the git pre-flight shell commands (assume the diff adds --new-flag and updates those two docs). Run the documentation workflow: build the coverage map, then audit the docs, apply updates, and polish the CHANGELOG voice. Produce the documentation health summary.',
    staticInvariants: {
      mustStayInSkeleton: ['## Step 1: Pre-flight', '## Step 1.5: Coverage Map'],
      mustMoveToSection: ['## Step 2: Per-File Documentation Audit', '## Step 5: CHANGELOG Voice Polish'],
      // Operational skill (no plan-mode review gate).
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    // +Conductor AUQ-default-prose rule + one-way/continuation safety in the
    // always-loaded AskUserQuestion Format section.
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble.
    maxSkeletonBytes: 41_000, // + v1.78 AUQ objectivity + v1.79 spawned contract incl. echo-failure tie-breaker; measured 40_575
    minUnionBytes: 56_700, // token-reduction Phases 1-2 (v1.69.x branch): preamble bash -> bin/gstack-skill-start, onboarding -> gated emission; measured union 63,018
    mustContain: ['CHANGELOG', 'Diataxis', 'coverage'],
    // Two intentional additions stack on this small skill: the AUQ-failure prose
    // fallback (v1.57.2.0, ~2KB to every preamble) AND the new default-on Codex
    // documentation-review section (codexPreflight + prompt + apply-gate, carved
    // into release-body so the SKELETON stays under maxSkeletonBytes). On a ~55KB
    // baseline that whole new capability is ~18.6% of union bytes. The doc review
    // is a deliberate new feature, not preamble creep; the union ceiling is raised
    // to match while the skeleton budget (50_000) still holds the always-loaded
    // cost flat.
    maxSizeRatio: 1.20,
  },
  'design-consultation': {
    skill: 'design-consultation',
    expectedSections: ['proposal-and-preview.md'],
    requiredReads: ['proposal-and-preview.md'],
    scenario:
      'The user gave product context (a B2B analytics dashboard for ops teams), declined the research phase and declined the optional outside design voices. Skip browser/design tool setup. Proceed to build the complete design-system proposal, then write DESIGN.md and its CLAUDE.md guidance.',
    staticInvariants: {
      mustStayInSkeleton: ['## Phase 0: Pre-checks', '## Phase 1: Product Context', '## Phase 2: Research'],
      mustMoveToSection: ['## Phase 3: The Complete Proposal', '## Phase 6: Write DESIGN.md'],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    // +Conductor AUQ-default-prose rule + one-way/continuation safety in the
    // always-loaded AskUserQuestion Format section.
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble.
    // v1.65 merge: provisional larger-of-both-waves budget; re-measured below.
    // v1.64.1.0: shared-preamble prose from the two parallel v1.64 waves lands
    // the skeleton at 69,022 B; +~1 KB headroom.
    maxSkeletonBytes: 72_500, // Outside review + upstream DESIGN.md format check; merged render 72,175 bytes.
    minUnionBytes: 65_000, // token-reduction Phases 1-2 (v1.69.x branch): preamble bash -> bin/gstack-skill-start, onboarding -> gated emission; measured union 72,252
    mustContain: ['Typography', 'Color', 'Aesthetic Direction'],
    // Cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback ~2KB +
    // the cross-session decision-memory nudge) lands this carved skeleton just over
    // the strict 1.05; headroom for the shared preamble additions.
    // v1.64+v1.65 merge sums both waves' preamble growth; measured 1.073.
    // + W1 guarded state-root resolution in the Context Recovery preamble, the
    // eureka log, the office-hours lookup and the taste-profile read; measured
    // 1.0834 (2026-09-30). + named design-direction defaults to avoid in the native
    // subagent prompt (s02 H4a); measured 1.0911 (2026-10-02).
    maxSizeRatio: 1.1560, // + v1.91.19.0 wave: design --version probe (B4), taste-profile load (F3), verdict-form outside voice (INV-1), plus v1.91.17.0's round accounting and board/approval blocks (#3022) merged in; measured 100,446 / 90,375 = 1.1114 (2026-10-03). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); measured 103,384 / 90,375 = 1.1439 (2026-10-06). + Oct 7 wave B6: Aside rules 1, 4, 6 and 7 (offer a target-origin tab before openTab, a second sign-in wall means a tab- or URL-bound session, no early-return hint, fast [ok without the sentinel is an abort); measured 103,576 / 90,375 = 1.1461 (2026-10-07). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; measured 103,522 / 90,375 = 1.1455 (2026-10-07). Both merged: measured 103,726 / 90,375 = 1.1477 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site; measured 103,466 / 90,375 = 1.1449 (2026-10-07). Merged with the guard area: measured 103,804 / 90,375 = 1.1486 (2026-10-07). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); measured 104,281 / 90,375 = 1.1539 (2026-10-10).
  },
  cso: {
    skill: 'cso',
    expectedSections: ['audit-phases.md'],
    requiredReads: ['audit-phases.md'],
    scenario:
      'Run a security audit on this repository in --owasp mode (OWASP Top 10 only). Resolve the mode, do the Phase 0 stack detection and Phase 1 attack-surface census, then run the scoped audit phases and produce the findings report. Skip any step that needs network access.',
    staticInvariants: {
      // Dispatch, trusted execution, evidence/proof, reporting and recovery stay always loaded.
      mustStayInSkeleton: [
        '## Arguments',
        '## Mode Resolution',
        '### Phase 0',
        '### Phase 1',
        '### Phase 12',
        '### Phase 13',
        '### Phase 14',
        '**Private startup.**',
        'CSO evidence rubric',
        'identical security assertion',
      ],
      // Earliest-use: mode must be resolvable before any section is read (codex #6).
      mustPrecedeStop: ['## Arguments', '## Mode Resolution'],
      // Scope-dependent audit detail moved to the section.
      mustMoveToSection: [
        '### Phase 2: Secrets Archaeology',
        '### Phase 9: OWASP Top 10 Assessment',
        '### Phase 10: STRIDE Threat Model',
      ],
      gateAfterStop: undefined,
    },
    // v3 requires a trusted helper and private state, absent from generic prompt fixtures.
    // The full-audit E2E asserts actual section loading alongside report/proof behavior.
    behavioral: 'external',
    externalTest: 'test/skill-e2e-cso.test.ts',
    maxSkeletonBytes: 18_000,
    minUnionBytes: 30_000, // v3 deliberately removes the shared export/startup preamble.
    mustContain: ['OWASP', 'STRIDE', 'daily', 'comprehensive', 'verif'],
    // Existing baseline comparison remains an upper bound; absolute limits above
    // preserve the compact controller and its complete domain reference.
    maxSizeRatio: 1.08,
  },
  // ── Token-reduction Phase 4 wave 1 (v1.69.x branch) ──────────────────────
  review: {
    skill: 'review',
    expectedSections: ['plan-completion.md', 'review-army.md', 'shared-code-reuse.md', 'adversarial.md'],
    requiredReads: ['plan-completion.md', 'review-army.md'],
    scenario:
      "The working tree has a real diff against the base branch (assume Step 1's git checks passed; the diff implements the PLAN.md cache layer). Run the /review flow: the scope-drift and plan-completion deep pass against PLAN.md, then the critical pass, then the Review Army specialist dispatch — apply the specialist checklists yourself instead of launching subagents. Produce the review report. Do NOT commit, push, or create a PR.",
    staticInvariants: {
      mustStayInSkeleton: [
        '## Step 0: Detect platform and base branch',
        '## Step 1: Check branch',
        '## Step 1.5: Scope Drift Detection',
        '## Step 4: Critical pass (core review)',
        '## Confidence Calibration',
        '## Step 5: Fix-First Review',
        '## Important Rules',
        'Persist Eng Review result',
      ],
      mustPrecedeStop: ['## Step 0: Detect platform and base branch'],
      mustMoveToSection: [
        'Plan File Discovery',
        'MULTI-SPECIALIST CONFIRMED',
        'Cross-model synthesis',
        'codex review --base',
      ],
      gateAfterStop: undefined, // operational multi-STOP skill, like ship
    },
    behavioral: 'plan',
    maxSkeletonBytes: 75_500, // Shared-code identity/skip/action rules + critical-severity validation; measured 74,493 (2026-09-17). + v1.91.12.0 merge of #2999 (review clarity repairs: await reads, research alongside dispatch, /review deadline and setup authority, findings sources) with #3002 (guarded state-root lines, plan-check checkpoints); each fit alone; measured 74,881 (2026-10-01). + Oct 8 wave: shared voice directive bans "load-bearing" and adds the reply-language rule, offset by tightening the bounded closer (net +17 bytes per tier-2+ skill); measured 74,884 (2026-10-08). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); skeleton measured 75,344 (2026-10-10).
    minUnionBytes: 89_000, // Phase 4 wave 1; measured union 93,357
    mustContain: ['confidence', 'P1', 'P2', 'Review Army', 'adversarial'],
    maxSizeRatio: 1.2400, // Shared-code feature + critical-severity validation: 128,042 union bytes / 108,523 baseline = 1.1799; preserves content floors. + v1.91.12.0 merge of #2999 (above, plus plan-completion fallback intent and specialist checklist-by-path) with #3002; measured 1.1843 (2026-10-01). + v1.91.19.0 wave: verdict-form Codex callers with sandbox preflight (INV-1/B1), P0/P1 structured gate (B1b), bound-plan discovery and data-not-instructions guard (F1/D3), visible LEARNINGS failures (B5); measured 129,941 / 108,523 = 1.1974 (2026-10-03). + v1.91.18.0 (#3023) merged into the v1.91.19.0 wave; measured 130,025 / 108,523 = 1.1981 (2026-10-04). + Oct 6 fix wave: quota_exhausted preflight branch (#3051); measured 130,359 / 108,523 = 1.2012 (2026-10-06). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); measured 131,314 / 108,523 = 1.2100 (2026-10-06). Combined Oct 6 wave head (A and B): measured 131,966 / 108,523 = 1.2160 (2026-10-06). + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; measured 132,199 / 108,523 = 1.2182 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; measured 132,258 / 108,523 = 1.2187 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site; measured 132,233 / 108,523 = 1.2185 (2026-10-07). Merged with the guard area: measured 132,522 / 108,523 = 1.2211 (2026-10-07). + Oct 8 wave: the defensive-security framing and fixture summary mode reach the security specialist and the Red Team (stated once in the dispatch, referenced by the Red Team); measured 133,902 / 108,523 = 1.2339 (2026-10-08). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); measured 134,383 / 108,523 = 1.2383 (2026-10-10).
  },
  codex: {
    skill: 'codex',
    expectedSections: ['review-mode.md', 'challenge-mode.md', 'consult-mode.md'],
    requiredReads: ['review-mode.md', 'consult-mode.md'],
    scenario:
      "Run the /codex skill twice: first Review mode against this branch's diff (produce the GATE verdict), then Consult mode with the follow-up 'is the strongest finding worth fixing before ship?'. Follow the Step 1 dispatch and read each selected mode's section before executing it; if the codex CLI is unavailable, still walk the mode instructions and report what you would run.",
    staticInvariants: {
      mustStayInSkeleton: [
        '## Step 1: Detect mode',
        '## Filesystem Boundary',
        'Synthesis recommendation (REQUIRED)',
        'Recommendation: <action> because',
        'If the runtime guard reports a harness mismatch, stop.',
      ],
      mustPrecedeStop: ['## Step 1: Detect mode', '## Filesystem Boundary'],
      mustMoveToSection: [
        'The gate FAILS CLOSED',
        'Think like an attacker and a chaos engineer',
        'codex exec resume',
      ],
      gateAfterStop: 'EXIT PLAN MODE GATE',
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 59_850, // + v1.78 AUQ spawned-trigger objectivity; generated Codex overlay measured 59,307 + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); skeleton measured 59,700 (2026-10-10).
    minUnionBytes: 83_400, // Phase 4 wave 1; measured union 84,304
    mustContain: ['GATE: PASS', 'CROSS-MODEL ANALYSIS', 'codex exec resume', 'sandbox_mode="read-only"', 'mktemp'],
    maxSizeRatio: 1.06, // measured 1.040 vs the v1.64.1.0 parity baseline
  },
  'land-and-deploy': {
    skill: 'land-and-deploy',
    expectedSections: ['first-run-validation.md', 'readiness-gate.md', 'merge-and-deploy.md'],
    requiredReads: ['readiness-gate.md', 'merge-and-deploy.md'],
    scenario:
      'This project has a confirmed prior /land-and-deploy run (treat the Step 1.5 check as CONFIRMED). A PR exists for this branch and CI is green. Simulate — do not run gh or actually merge: run the pre-merge readiness gate and produce the readiness report, then walk the merge and deploy-strategy steps, stating which merge path and deploy strategy you would take. Do NOT use AskUserQuestion.',
    staticInvariants: {
      mustStayInSkeleton: [
        'land-deploy-confirmed',
        '## Step 3.4: VERSION drift detection',
        '## Step 6: Wait for deploy',
      ],
      mustPrecedeStop: ['land-deploy-confirmed'],
      mustMoveToSection: [
        'PRE-MERGE READINESS REPORT',
        'gh pr merge "$MERGE_FLAG" --auto --delete-branch',
        'DEPLOY INFRASTRUCTURE VALIDATION',
      ],
      gateAfterStop: undefined, // operational skill
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 74_500, // + Aside browser contract for Step 7 canary ({{ASIDE_SETUP}}); measured 73_523
    maxSizeRatio: 1.1080, // + v1.81 Aside contract + gstack-browser fallback block; measured 1.077. + both untrusted-content marker formats in the browser fallback (W7f) + the readiness gate's project test command and live eval-store paths (s06 H6/H7); measured 1.1076 (2026-10-02). Re-measured 1.0943 (2026-10-03); cap = measured + 0.005 headroom. + Oct 7 wave B6: Aside rules 1, 4, 6 and 7 (offer a target-origin tab before openTab, a second sign-in wall means a tab- or URL-bound session, no early-return hint, fast [ok without the sentinel is an abort); measured 115,226 / 104,578 = 1.1018 (2026-10-07). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); measured 115,697 / 104,578 = 1.1063 (2026-10-10).
    minUnionBytes: 91_000, // Phase 4 wave 1; estimated union ~94.9KB
    mustContain: ['readiness', 'merge', 'canary', 'revert', 'staging'],
  },
  // ── Token-reduction Phase 4 wave 2 (v1.69.x branch) ──────────────────────
  autoplan: {
    skill: 'autoplan',
    expectedSections: ['ceo-phase.md', 'design-phase.md', 'eng-phase.md', 'dx-phase.md', 'phase-close.md', 'tasks-aggregator.md'],
    requiredReads: ['ceo-phase.md', 'eng-phase.md', 'phase-close.md', 'tasks-aggregator.md'],
    scenario:
      'Run the /autoplan pipeline against the plan in PLAN.md. Codex and subagent tools are unavailable — note both voices unavailable (single-reviewer mode) and keep going. The plan has no UI scope and no developer-facing scope, so Phase 2 and Phase 2.5 are skipped (do not read their sections). Execute Phase 1 (CEO) and Phase 3 (Eng) at full depth, run the Phase 4 aggregator step, and produce the Final Approval Gate summary as the report.',
    staticInvariants: {
      mustStayInSkeleton: [
        '## The 6 Decision Principles',
        '## Sequential Execution — MANDATORY',
        '## Decision Classification',
        '## Filesystem Boundary — Codex Prompts',
        '## Phase 0.5: Outside reviewer preflight',
        '## Pre-Gate Verification',
        '## Phase 2: Design Review (conditional — skip if no UI scope)',
        '## Phase 2.5: DX Review (conditional — skip if no developer-facing scope)',
        '- Scope gate (the plan under review is already the target)',
      ],
      mustPrecedeStop: ['## The 6 Decision Principles', '## Sequential Execution — MANDATORY', '## Decision Classification'],
      mustMoveToSection: [
        'CEO DUAL VOICES — CONSENSUS TABLE:',
        'Codex SAYS (design — UX challenge)',
        'ENG DUAL VOICES — CONSENSUS TABLE:',
        'DX DUAL VOICES — CONSENSUS TABLE:',
        '## Implementation Tasks aggregator',
      ],
      gateAfterStop: 'AskUserQuestion options:',
    },
    // The retired skill-e2e-autoplan-chain was its only section-read proof.
    behavioral: 'none',
    maxSkeletonBytes: 70_000, // Phase-specific outside coverage, native fallback, and harness guard.
    minUnionBytes: 85_000, // measured union 86,926
    mustContain: ['6 Decision Principles', 'TASTE DECISION', 'USER CHALLENGE', 'consensus', 'Restore Point'],
    maxSizeRatio: 1.1355, // Four validated outside invocations replace raw CLI calls; phases keep independent coverage. + Oct 7 wave B3: the Codex probe runs as a command (select-model capture lines, check-sandbox/probe-model/run-with-timeout subcommands) instead of being sourced; measured 114,297 / 101,979 = 1.1208 (2026-10-07). + Oct 7 wave CEO-28/DX-11: review prompts ask for a severity per finding and design proposals use the proposal gate; measured 114,533 / 101,979 = 1.1231 (2026-10-07). + Oct 7 wave guard (CEO-20): conditional `run_in_background` request plus the background-run recovery at each foreground dispatch site, and phase-close publishing each report with the `true autoplan-published <phase>` no-op before the next phase entry in a later message (CEO-1); measured 114,320 / 101,979 = 1.1210 (2026-10-07). Merged with the guard area: measured 115,149 / 101,979 = 1.1291 (2026-10-07). + Oct 8 wave (permission cards after a background reviewer): Step 1 puts RESTORE_PATH, and so every phase artifact, in the project's git-excluded `.gstack/tmp/autoplan/`, which Claude Code reads without a card after the skill turn ends; measured 115,270 / 101,979 = 1.1303 (2026-10-08). + fix wave PR D: the prerequisite offer is skipped in spawned/headless sessions (#1958); measured 115,267 / 101,979 = 1.1303 (2026-10-07). Both merged: measured 115,126 / 101,979 = 1.1289 (2026-10-08). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); measured 115,603 / 101,979 = 1.1336 (2026-10-10).
  },
  spec: {
    skill: 'spec',
    expectedSections: ['gate-and-file.md'],
    requiredReads: ['gate-and-file.md'],
    scenario:
      "The user already completed Phases 1-4 of /spec for the request 'add a --json output flag to the CLI status command'. Treat the five Phase 1 answers, the scope lock, and the technical interrogation as settled, and the Phase 4 draft as CONFIRMED by the user. Continue from that point in file-only mode (--no-execute is set): run the Phase 4.5 sequence and Phase 5, simulating every external command (codex, gh, the redaction bin) by stating what you would run and the expected outcome instead of executing it. Do NOT use AskUserQuestion.",
    staticInvariants: {
      mustStayInSkeleton: [
        'HARD GATE',
        '### Phase 1: Understand the "Why"',
        '### Phase 3: Technical Interrogation',
        '### Phase 4: Draft Review',
        'gstack-issue-guard',
        '## Issue Structure Templates',
      ],
      mustPrecedeStop: ['## Flag Reference', '### Phase 1: Understand the "Why"'],
      mustMoveToSection: [
        '<<<USER_SPEC>>>',
        'SEMANTIC_REVIEW: clean',
        'gstack-post issue-create',
        'PIN_SHA=$(git rev-parse HEAD)',
      ],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 58_400, // + v2.0 {{ASIDE_RESEARCH}} (Aside first, WebSearch fallback); measured 57_356
    minUnionBytes: 64_500, // measured union 67,430
    mustContain: ['HARD GATE', 'dedupe', 'quality gate', 'acceptance criteria', 'archive'],
  },
  'setup-gbrain': {
    skill: 'setup-gbrain',
    expectedSections: ['engine-remediation.md', 'brain-init.md', 'transcript-gate.md', 'claude-md-persist.md'],
    requiredReads: ['brain-init.md', 'claude-md-persist.md'],
    scenario:
      "Walk /setup-gbrain in SIMULATION — do not execute any bash, install anything, or register MCP; for each step state the exact commands you WOULD run. Treat Step 1 detect as: gbrain_on_path=false, gbrain_local_status=missing-config, no shortcut flags. Treat Path 3 (PGLite local) as already picked at Step 2 — do not use AskUserQuestion. Walk Steps 3, 4 (Path 3 init), 5, 5a, and 8: read each step's pointed section before doing it, and write out the exact CLAUDE.md block Step 8 would persist. Skip Steps 6, 7, 7.5, 9, 9.5, and 10. End with a one-paragraph setup summary.",
    staticInvariants: {
      mustStayInSkeleton: [
        '## Step 2: Pick a path (AskUserQuestion)',
        '## Step 1: Detect current state',
        'gbrain_mcp_mode=remote-http',
        'claude mcp add --scope user --transport http gbrain',
        'SKIP entirely on Path 4 (Remote MCP)',
        '<YOUR_TOKEN>',
      ],
      mustPrecedeStop: ['## Step 1: Detect current state'],
      mustMoveToSection: [
        '### Path 1 (Supabase, existing URL)',
        'read_secret_to_env GBRAIN_MCP_TOKEN',
        'Mode: remote-http',
        'gstack-memory-ingest.ts --probe',
      ],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 60_450, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 60_013
    minUnionBytes: 78_300, // measured union 79,139
    mustContain: ['PGLite', 'Supabase', 'claude mcp add', 'read_secret_to_env', 'pooler'],
    maxSizeRatio: 1.07, // measured 1.051 vs the branch monolith: index + stubs + 4 STOP pointers
  },
  // ── Token-reduction Phase 4 wave 3 (v1.69.x branch) ──────────────────────
  qa: {
    skill: 'qa',
    expectedSections: ['scope.md', 'browser-setup.md', 'exploratory.md', 'system-functional.md', 'browser-verify.md', 'test-bootstrap.md', 'qa-patterns.md'],
    requiredReads: ['scope.md', 'browser-setup.md', 'exploratory.md', 'qa-patterns.md'],
    scenario:
      'Walk /qa in SIMULATION — do not launch a browser, run any aside command, or execute bash; treat the working tree as clean, the tier as Quick, and the target app as http://localhost:3000 with a small feature-branch diff touching one page. Skip the test-framework bootstrap (assume CLAUDE.md documents the test command). Read each pointed section before doing its step, then produce the QA plan as the report: the mode you selected and why, the Phase 1-6 steps you would run, and a worked health-score computation from the rubric. Do NOT use AskUserQuestion.',
    staticInvariants: {
      mustStayInSkeleton: [
        '## Setup',
        '## Phases 1-6: QA Baseline',
        '## Phase 7: Triage',
        '## Phase 8: Fix Loop',
        '8e.5. Regression Test',
        '### 8f. Self-Regulation',
        '## Additional Rules (qa-specific)',
        '## Output Structure',
      ],
      mustPrecedeStop: ['## Setup'],
      mustMoveToSection: [
        '## Test Framework Bootstrap',
        'BOOTSTRAP_DECLINED',
        '### Select the surface before setup',
        '## BROWSER SETUP (Aside',
        '## Health Score Rubric',
        '### Diff-aware (automatic when on a feature branch with no URL)',
        'Never refuse to use the browser',
      ],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 63_500, // + v2.0 {{ASIDE_SETUP}}/{{BROWSE_FALLBACK}} (replaces the browse setup block); measured 61_253
    maxSizeRatio: 1.1385, // + v1.81 Aside contract + gstack-browser fallback block (1.080 on v1.91.7.0) + the shared test value bar at 8a.5 ({{TEST_VALUE_BAR:qa}}); measured 1.094 + W1 guarded state-root resolution (`eval gstack-paths; : "${GSTACK_STATE_ROOT:?…}"`) in the Context Recovery preamble, the eureka log and each state-writing bash block; measured 1.101 (2026-09-30) + v1.91.12.0 merge of #2999 (await scope/method Reads, capture --after checkpoints, browser-only empty evidence list) with #3002; measured 1.1028 (2026-10-01). + both untrusted-content marker formats in the browser fallback (W7f); measured 1.1035 (2026-10-02). Re-measured 1.1038 after the W8 probe-loop renames (2026-10-03); the cap already matches. + the annotate-every-capture and superseded rule before materialize (a ship-exploratory-late-input run published evidence that omitted older-snapshot captures); measured 1.1064 (2026-10-03). + v1.91.18.0 (#3023) merged into the v1.91.19.0 wave; measured 93,282 / 84,049 = 1.1099 (2026-10-04). + reliability follow-ups C2 (judge-named gaps after trimming the added wording: feasible 180 s Browser Quick, PROBE_DIR's source line, stop goes to the §4 report, written JSON keeps full card values; lane S's {user}/timing fields); measured 93,311 / 84,049 = 1.11020 (2026-10-04). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); measured 94,486 / 84,049 = 1.1242 (2026-10-06). + Oct 7 wave B6: Aside rules 1, 4, 6 and 7 (offer a target-origin tab before openTab, a second sign-in wall means a tab- or URL-bound session, no early-return hint, fast [ok without the sentinel is an abort); measured 94,681 / 84,049 = 1.1265 (2026-10-07). + Oct 8 wave: shared voice directive bans "load-bearing" and adds the reply-language rule, offset by tightening the bounded closer (net +17 bytes per tier-2+ skill); measured 94,736 / 84,049 = 1.12715 (2026-10-08). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); plus the no_claim card field in {{TEST_VALUE_BAR:qa}}; measured 95,512 / 84,049 = 1.1364 (2026-10-10).
    minUnionBytes: 69_500, // measured union 70,385
    // 'aside repl' pins the Aside contract; '$B goto' pins the fallback block in the always-loaded skeleton.
    mustContain: ['bug', 'aside repl', '$B goto', 'fix', 'Health Score Rubric', 'regression'],
  },
  'qa-only': {
    skill: 'qa-only',
    expectedSections: ['exploratory.md'],
    requiredReads: ['exploratory.md'],
    scenario:
      'Walk /qa-only for an isolated CLI fixture using its declared native commands. Read installed scope, exploratory and functional resources; never read browser setup or DX instructions. Report contract outcomes and proposed tests without changing product, tests or Git. Do not use AskUserQuestion.',
    staticInvariants: {
      mustStayInSkeleton: ['## Request Parameters', 'Never fix bugs or write product tests', '## Output'],
      mustPrecedeStop: ['## Request Parameters'],
      mustMoveToSection: ['# Shared exploratory QA'],
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-qa-functional.test.ts',
    maxSkeletonBytes: 45_000,
    minUnionBytes: 40_000,
    mustContain: ['contract', 'Never fix bugs', 'edit-then-restore', 'test_stub'],
  },
  browse: {
    skill: 'browse',
    expectedSections: ['command-list.md'],
    requiredReads: ['command-list.md'],
    scenario:
      'QA a static page: before driving it, plan the full audit — enumerate which browser steps you would run (the aside repl shapes, and the $B commands and snapshot flags the fallback would need), including extraction/tab/dialog commands beyond the basics, reading the full command reference first. Do not launch any browser or run any aside/$B command; produce the plan as the report.',
    staticInvariants: {
      // Aside is the primary browser: the skeleton carries the Aside contract;
      // the $B command reference + snapshot flags are the carved section.
      mustStayInSkeleton: ['## BROWSER SETUP (Aside'],
      mustPrecedeStop: ['## BROWSER SETUP (Aside'],
      mustMoveToSection: ['## Full Command List', '## Snapshot Flags', '### Navigation'],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 34_400, // + v2.0 {{ASIDE_SETUP}}/{{BROWSE_FALLBACK}} skeleton + the STOP-Read pointer; measured 29_986 + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); skeleton measured 32,532 (2026-10-06). + Oct 7 wave B6: Aside rules 1, 4, 6 and 7 (offer a target-origin tab before openTab, a second sign-in wall means a tab- or URL-bound session, no early-return hint, fast [ok without the sentinel is an abort), and the cookbook's silent-failure list and signed-in-tab recipe (the rule details live here, not in every browsing skill); skeleton measured 34,047 (2026-10-07). + Oct 8 wave: the tier-1 voice directive bans "load-bearing" and adds the reply-language rule (tier 1 has no closer to tighten: +158 bytes); skeleton measured 34,209 (2026-10-08). + Honest Work W4: the DONE line's final-consumed-inputs wording (tier 1 gets no kernel: +87 bytes); skeleton measured 34,297 (2026-10-10).
    minUnionBytes: 36_000, // skeleton + command-list section (14,240); measured union ~38.5 KB
    // 'BEGIN/END UNTRUSTED EXTERNAL' pins the untrusted-content warning in the
    // command reference; 'aside repl' pins the Aside contract in the skeleton.
    mustContain: ['BEGIN/END UNTRUSTED EXTERNAL', 'snapshot -i', '@e refs', 'aside repl'],
  },
  retro: {
    skill: 'retro',
    expectedSections: ['report-format.md'],
    requiredReads: ['report-format.md'],
    scenario:
      'Run the repo-scoped weekly retrospective for the last 7 days on this repo. There is no origin remote — proceed with the local branch per the guard disclosure rules. The gstack-retro-metrics script is not installed, so follow the degraded path (compute the metrics manually with git). Skip any AskUserQuestion calls — this is non-interactive. Produce the full narrative retrospective report.',
    staticInvariants: {
      mustStayInSkeleton: ['gstack-retro-metrics', '### Step 2: Compute Metrics', '### Step 13: Save Retro History'],
      mustPrecedeStop: ['### Step 2: Compute Metrics'],
      mustMoveToSection: ['## Engineering Retro: [date range]', '### Team Breakdown', 'Plan Completion This Period'],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 73_450, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 73_059
    minUnionBytes: 66_000, // measured union 73,496
    mustContain: ['retrospective', '45-minute gap', 'Ship of the week', 'Praise'],
  },

  // ── Token-reduction Phase 4 wave 4 (v1.69.x branch): design doctrine carve ──
  // (D3A: read-on-demand doctrine, requiredReads-guarded + loading eval)
  'design-html': {
    skill: 'design-html',
    expectedSections: ['doctrine.md', 'pretext-patterns.md', 'detector-install-offer.md'],
    requiredReads: ['doctrine.md', 'pretext-patterns.md'],
    scenario:
      'Walk /design-html in SIMULATION — do not run bash, start servers, launch a browser, or take screenshots. Treat Step 0 as already resolved: no CEO plan, no approved mockup, no variants, no DESIGN.md, no prior finalized.html — freeform mode (Case C option D), screen name "pricing", the user wants a pricing page for a developer-tools SaaS (dark, dense, three tiers, monospace-leaning). Do NOT use AskUserQuestion — proceed with the stated assumptions. Read each pointed section before doing its step, then execute Steps 1-3: produce the implementation spec, state the chosen Pretext tier and why, and generate the complete Pretext-native HTML — include the HTML in your report instead of writing files. Stop there: skip Step 3.5, Step 4, and Step 5.',
    staticInvariants: {
      mustStayInSkeleton: [
        '## Step 0: Input Detection',
        '## Step 2: Smart Pretext API Routing',
        '### HTML Generation',
        'AI slop blacklist',
        '## Step 4: Preview + Refinement Loop',
        '## Important Rules',
      ],
      mustPrecedeStop: ['## DESIGN SETUP'],
      mustMoveToSection: [
        '### The Three Laws of Usability',
        '### The Goodwill Reservoir',
        '### Pretext Wiring Patterns',
        '### Pretext API Reference',
      ],
      gateAfterStop: undefined, // operational skill, no plan-mode gate
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 55_850, // measured 55,262 (2026-09-09): the detector install offer pointer + its sections-table row (the brief itself lives in sections/detector-install-offer.md); before that 54,545 for the review-cycle trust prose, the Slop Gate's Decisions-Log clause, and the blacklist header's override sentence + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); skeleton measured 55,709 (2026-10-10).
    minUnionBytes: 57_500, // Phase 4 wave 4; measured union 58,682
    mustContain: ["Don't make me think", "Users scan, they don't read", 'The Goodwill Reservoir', 'PRETEXT API CHEATSHEET', 'Pattern 3: Text around obstacles'],
  },
  'design-shotgun': {
    skill: 'design-shotgun',
    expectedSections: ['doctrine.md'],
    requiredReads: ['doctrine.md'],
    scenario:
      'Walk /design-shotgun in SIMULATION — do not run bash, launch a browser, call the design binary, or spawn agents. Treat Step 0 as NO_PREVIOUS_SESSIONS and Step 1 context as fully gathered: a landing page for an open-source CLI tool, audience = developers evaluating it from a GitHub README link, no DESIGN.md, no taste profile or prior approved.json (Step 2 finds nothing). Do NOT use AskUserQuestion — proceed with the stated assumptions. Read each pointed section before doing its step, then run Step 3a at full depth: write three distinct variant concepts with their full variant-specific generation briefs, apply the anti-convergence check, and produce the concept list plus briefs as the report. Stop before Step 3b.',
    staticInvariants: {
      mustStayInSkeleton: [
        '## Step 0: Session Detection',
        '## Step 2: Taste Memory',
        'Anti-convergence directive',
        '### Step 3b: Concept Confirmation',
        '## Important Rules',
      ],
      mustPrecedeStop: ['## DESIGN SETUP'],
      mustMoveToSection: [
        '### The Three Laws of Usability',
        '### The Goodwill Reservoir',
        "Users scan, they don't read",
      ],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 57_500, // + v2.0 preamble growth (merged); measured 52_962 + v1.91.19.0 wave: design --version probe (B4) and taste profile (F3) on top of v1.91.17.0's claim-based staging and round accounting (#3022); measured 55,168 (2026-10-03). + Oct 6 fix wave A3/CEO-12: free text reaches commands only through agent-written mktemp files (mktemp block, write rule, path rebuild and refusal at each posting, prompt and brief site); skeleton measured 56,880 (2026-10-06). + Honest Work W4: the preamble's Claims Need Evidence kernel (five bullets replacing the one-directive form, +~450 bytes per tier-2+ skill) and the DONE line's final-consumed-inputs wording (+~90 bytes per skill); skeleton measured 57,335 (2026-10-10).
    minUnionBytes: 53_200, // Phase 4 wave 4; measured union 54,290
    mustContain: ["Don't make me think", "Users scan, they don't read", 'trunk test', '44px minimum'],
  },
};

/** Sorted carved-skill names. Consumers derive their lists from this — no parallel lists. */
export const CARVED_SKILLS: readonly string[] = Object.freeze(
  Object.keys(CARVE_GUARDS).sort(),
);
