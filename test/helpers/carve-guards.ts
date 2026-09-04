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
 *   - test/carve-section-loading.test.ts    (T2, periodic) → requiredReads + scenario
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
   */
  behavioral: 'plan' | 'prompt' | 'external';
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
      'greptile.md',
      'adversarial.md',
      'changelog.md',
      'pr-body.md',
    ],
    requiredReads: ['review-army.md', 'changelog.md'],
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
      //   imperative   → Step 17 handoff line
      //   3rd person   → hoisted doc-sync invariant
      // Matching is case-sensitive String.includes — "dispatching the" does NOT
      // contain "dispatch the" — so update anchors in lockstep with any
      // touchpoint rewording.
      mustStayInSkeleton: [
        'v$NEW_VERSION',
        'gstack-pr-title-rewrite',
        'dispatching the /document-release subagent to sync docs',
        'dispatch the /document-release subagent to sync docs',
        'dispatches the /document-release subagent',
      ],
      // ...while the full create/update procedure stays carved into pr-body.md
      // (out of the skeleton, present in the union). Asserts BOTH PR paths
      // survive: the create path and the idempotent update path. The Step 18
      // dispatch imperative stays carved too — pasting that literal into the
      // skeleton (correctly) fails this guard; the skeleton speaks of "the
      // /document-release subagent", never the carved imperative.
      mustMoveToSection: [
        'gh pr create --base',
        'gh pr edit --title',
        'Dispatch /document-release as a subagent',
      ],
      // ship is operational (multi-STOP, not a plan review); no single post-STOP gate.
      gateAfterStop: undefined,
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-ship-section-loading.test.ts',
    maxSkeletonBytes: 77_650, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 77_236
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
    maxSizeRatio: 1.22,
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
    maxSkeletonBytes: 76_000, // + v1.78 AUQ objectivity + v1.79 foreground-dispatch sweep (merged); measured 75_586
    minUnionBytes: 123_600, // token-reduction Phases 1-2 (v1.69.x branch): preamble bash -> bin/gstack-skill-start, onboarding -> gated emission; measured union 137,346
    mustContain: ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'],
    // Default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose replacing the smaller opt-in question) lands this ~5.2% over baseline.
    maxSizeRatio: 1.08,
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
    maxSkeletonBytes: 54_200, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 53_773
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
    maxSizeRatio: 1.12, // measured 1.103
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
    maxSkeletonBytes: 73_800, // + v1.78 AUQ objectivity + v1.79 foreground-dispatch sweep (merged); measured 73_398
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
    maxSkeletonBytes: 65_900, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 65_486
    minUnionBytes: 99_700, // token-reduction Phases 1-2 (v1.69.x branch); measured union 110,833
    mustContain: ['developer experience', 'Getting Started'],
    // Default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose replacing the smaller opt-in question) lands this ~5.7% over baseline.
    maxSizeRatio: 1.08,
  },
  'office-hours': {
    skill: 'office-hours',
    expectedSections: ['design-and-handoff.md', 'phase-2a-startup-diagnostic.md', 'phase-2b-builder-brainstorm.md'],
    // Phase sections are mode-exclusive (a session runs exactly one of 2A/2B),
    // so only the always-reached design/handoff section is a deterministic read.
    requiredReads: ['design-and-handoff.md'],
    scenario:
      'Run office hours for this product idea through to the end: have the diagnostic conversation, explore alternatives, then write the design doc and run the relationship handoff (Phases 5-6).',
    staticInvariants: {
      mustStayInSkeleton: [],
      mustMoveToSection: ['### The Six Forcing Questions', '### Pushback Patterns', 'Anti-Sycophancy Rules', 'Wild exemplar'],
      mustPrecedeStop: ['**Mode mapping:**'],
      gateAfterStop: '## Section self-check',
    },
    behavioral: 'prompt',
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble,
    // plus the P1 office-hours closing handoff (AUQ that launches the next skill).
    // v1.65 merge: provisional larger-of-both-waves budget; re-measured below.
    // Fork port wave 2: the third-party web-actions contract sits inline
    // (judgment must be visible before the workflow directs the user to a
    // vendor site), plus the #703 dual-write + repo-doc-preference block and
    // the #538 opt-out + D1 evidence directive — ratio 1.104 measured.
    // #2499 project-scope MCP jq in the brain-sync block grew every tier-2+
    // skeleton ~1.5KB (entry resolution emitted once per SKILL.md).
    maxSkeletonBytes: 73_450, // + v1.78 AUQ objectivity + v1.79 foreground-dispatch sweep (merged); measured 73_040
    minUnionBytes: 115_800, // Phase 4 wave 4; measured union 118,175
    mustContain: ['design doc', 'problem statement'],
    maxSizeRatio: 1.12,
  },
  'document-release': {
    skill: 'document-release',
    expectedSections: ['release-body.md'],
    requiredReads: ['release-body.md'],
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
      'The user gave product context (a B2B analytics dashboard for ops teams) and declined the research phase. Skip browser/design tool setup. Proceed to build the complete design-system proposal, then write DESIGN.md. Produce the proposal and the DESIGN.md content.',
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
    maxSkeletonBytes: 53_750, // + v1.78 AUQ objectivity + v1.79 foreground-dispatch sweep (merged); measured 53_342
    minUnionBytes: 65_000, // token-reduction Phases 1-2 (v1.69.x branch): preamble bash -> bin/gstack-skill-start, onboarding -> gated emission; measured union 72,252
    mustContain: ['Typography', 'Color', 'Aesthetic Direction'],
    // Cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback ~2KB +
    // the cross-session decision-memory nudge) lands this carved skeleton just over
    // the strict 1.05; headroom for the shared preamble additions.
    // v1.64+v1.65 merge sums both waves' preamble growth; measured 1.073.
    maxSizeRatio: 1.08,
  },
  cso: {
    skill: 'cso',
    expectedSections: ['audit-phases.md'],
    requiredReads: ['audit-phases.md'],
    scenario:
      'Run a security audit on this repository in --owasp mode (OWASP Top 10 only). Resolve the mode, do the Phase 0 stack detection and Phase 1 attack-surface census, then run the scoped audit phases and produce the findings report. Skip any step that needs network access.',
    staticInvariants: {
      // Dispatch + always-run + FP-filtering phases are ALWAYS loaded (security).
      mustStayInSkeleton: [
        '## Arguments',
        '## Mode Resolution',
        '### Phase 0',
        '### Phase 1',
        '### Phase 12',
        '### Phase 13',
        '### Phase 14',
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
    behavioral: 'prompt',
    // +Conductor AUQ-default-prose rule + one-way/continuation safety in the
    // always-loaded AskUserQuestion Format section.
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble.
    maxSkeletonBytes: 58_800, // + v1.78 AUQ objectivity + v1.79 foreground-dispatch sweep (merged); measured 58_364
    minUnionBytes: 64_200, // token-reduction Phases 1-2 (v1.69.x branch); measured union 71,379
    mustContain: ['OWASP', 'STRIDE', 'daily', 'comprehensive', 'verif'],
    // cso keeps its mode-dispatch + FP-filtering phases always-loaded, so the
    // cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback ~2KB + the
    // decision-memory nudge) lands it just over 1.05; headroom for the shared additions.
    // v1.64+v1.65 merge sums both waves' preamble growth; measured 1.073.
    maxSizeRatio: 1.08,
  },
  // ── Token-reduction Phase 4 wave 1 (v1.69.x branch) ──────────────────────
  review: {
    skill: 'review',
    expectedSections: ['plan-completion.md', 'review-army.md', 'adversarial.md'],
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
    maxSkeletonBytes: 59_150, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 58_722
    minUnionBytes: 89_000, // Phase 4 wave 1; measured union 93,357
    mustContain: ['confidence', 'P1', 'P2', 'Review Army', 'adversarial'],
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
        'UNDER_CODEX',
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
    maxSkeletonBytes: 59_300, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 58_867
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
        'gh pr merge --squash --auto --delete-branch',
        'DEPLOY INFRASTRUCTURE VALIDATION',
      ],
      gateAfterStop: undefined, // operational skill
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 62_450, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 62_021
    minUnionBytes: 91_000, // Phase 4 wave 1; estimated union ~94.9KB
    mustContain: ['readiness', 'merge', 'canary', 'revert', 'staging'],
  },
  // ── Token-reduction Phase 4 wave 2 (v1.69.x branch) ──────────────────────
  autoplan: {
    skill: 'autoplan',
    expectedSections: ['ceo-phase.md', 'design-phase.md', 'eng-phase.md', 'dx-phase.md', 'tasks-aggregator.md'],
    requiredReads: ['ceo-phase.md', 'eng-phase.md', 'tasks-aggregator.md'],
    scenario:
      'Run the /autoplan pipeline against the plan in PLAN.md. Codex and subagent tools are unavailable — note both voices unavailable (single-reviewer mode) and keep going. The plan has no UI scope and no developer-facing scope, so Phase 2 and Phase 2.5 are skipped (do not read their sections). Execute Phase 1 (CEO) and Phase 3 (Eng) at full depth, run the Phase 4 aggregator step, and produce the Final Approval Gate summary as the report.',
    staticInvariants: {
      mustStayInSkeleton: [
        '## The 6 Decision Principles',
        '## Sequential Execution — MANDATORY',
        '## Decision Classification',
        '## Filesystem Boundary — Codex Prompts',
        '## Phase 0.5: Codex auth + version preflight',
        '## Pre-Gate Verification',
        '## Phase 2: Design Review (conditional — skip if no UI scope)',
        '## Phase 2.5: DX Review (conditional — skip if no developer-facing scope)',
        '- Scope gate (the plan under review is already the target)',
      ],
      mustPrecedeStop: ['## The 6 Decision Principles', '## Sequential Execution — MANDATORY', '## Decision Classification'],
      mustMoveToSection: [
        'CEO DUAL VOICES — CONSENSUS TABLE:',
        'CODEX SAYS (design — UX challenge)',
        'ENG DUAL VOICES — CONSENSUS TABLE:',
        'DX DUAL VOICES — CONSENSUS TABLE:',
        '## Implementation Tasks aggregator',
      ],
      gateAfterStop: 'AskUserQuestion options:',
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-autoplan-chain.test.ts', // phase-complete markers live ONLY in sections — its assertions ARE section-read proof
    maxSkeletonBytes: 65_100, // + v1.78 AUQ objectivity + #2745 broken-install preflight arm + outside-voice honest labeling; measured 64_668
    minUnionBytes: 85_000, // measured union 86,926
    mustContain: ['6 Decision Principles', 'TASTE DECISION', 'USER CHALLENGE', 'consensus', 'Restore Point'],
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
        'gh issue create --title',
        'PIN_SHA=$(git rev-parse HEAD)',
      ],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 57_100, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 56_697
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
    expectedSections: ['test-bootstrap.md', 'qa-patterns.md'],
    requiredReads: ['qa-patterns.md'],
    scenario:
      'Walk /qa in SIMULATION — do not launch a browser, run any $B command, or execute bash; treat the working tree as clean, the tier as Quick, and the target app as http://localhost:3000 with a small feature-branch diff touching one page. Skip the test-framework bootstrap (assume CLAUDE.md documents the test command). Read each pointed section before doing its step, then produce the QA plan as the report: the mode you selected and why, the Phase 1-6 steps you would run, and a worked health-score computation from the rubric. Do NOT use AskUserQuestion.',
    staticInvariants: {
      mustStayInSkeleton: [
        '## Setup',
        '## SETUP (run this check BEFORE any browse command)',
        '## Phases 1-6: QA Baseline',
        '## Phase 7: Triage',
        '## Phase 8: Fix Loop',
        '8e.5. Regression Test',
        'WTF-LIKELIHOOD',
        '## Additional Rules (qa-specific)',
        '## Output Structure',
      ],
      mustPrecedeStop: ['## Setup'],
      mustMoveToSection: [
        '## Test Framework Bootstrap',
        'BOOTSTRAP_DECLINED',
        '## Health Score Rubric',
        '### Diff-aware (automatic when on a feature branch with no URL)',
        'Never refuse to use the browser',
      ],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 52_550, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 52_150
    minUnionBytes: 69_500, // measured union 70,385
    mustContain: ['bug', 'browse', 'fix', 'Health Score Rubric', 'regression'],
  },
  browse: {
    skill: 'browse',
    expectedSections: ['command-list.md'],
    requiredReads: ['command-list.md'],
    scenario:
      'QA a static page: before driving it, plan the full audit — enumerate which browse commands and snapshot flags you would use, including extraction/tab/dialog commands beyond the Most-Used table, reading the full command reference first. Do not launch the browser or run any $B command; produce the command plan as the report.',
    staticInvariants: {
      mustStayInSkeleton: ['## SETUP', '## Core QA Patterns', '## CSS Inspector', '## Most-Used Commands'],
      mustPrecedeStop: ['## SETUP'],
      mustMoveToSection: ['## Full Command List', '## Snapshot Flags', '### Navigation'],
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    maxSkeletonBytes: 27_500, // Phase 4 wave 3; measured 26,875
    minUnionBytes: 39_500, // measured union 41,115
    // 'BEGIN/END UNTRUSTED EXTERNAL' pins the untrusted-content warning; the full
    // envelope phrase wraps across lines in the rendered blockquote, so the
    // contiguous-substring check needs the single-line prefix form.
    mustContain: ['BEGIN/END UNTRUSTED EXTERNAL', 'snapshot -i', '@e refs', 'deviceScaleFactor', 'handoff'],
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
    expectedSections: ['doctrine.md', 'pretext-patterns.md'],
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
    maxSkeletonBytes: 52_900, // + v1.78 AUQ spawned-trigger objectivity (explicit declaration + interactive fence); measured 52_492
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
    maxSkeletonBytes: 53_100, // + v1.78 AUQ objectivity + v1.79 foreground-dispatch sweep (merged); measured 52_685
    minUnionBytes: 53_200, // Phase 4 wave 4; measured union 54,290
    mustContain: ["Don't make me think", "Users scan, they don't read", 'trunk test', '44px minimum'],
  },
};

/** Sorted carved-skill names. Consumers derive their lists from this — no parallel lists. */
export const CARVED_SKILLS: readonly string[] = Object.freeze(
  Object.keys(CARVE_GUARDS).sort(),
);
