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
      mustStayInSkeleton: ['v$NEW_VERSION', 'gstack-pr-title-rewrite'],
      // ...while the full create/update procedure stays carved into pr-body.md
      // (out of the skeleton, present in the union). Asserts BOTH PR paths
      // survive: the create path and the idempotent update path.
      mustMoveToSection: ['gh pr create --base', 'gh pr edit --title'],
      // ship is operational (multi-STOP, not a plan review); no single post-STOP gate.
      gateAfterStop: undefined,
    },
    behavioral: 'external',
    externalTest: 'test/skill-e2e-ship-section-loading.test.ts',
    maxSkeletonBytes: 90_000,
    minUnionBytes: 120_000,
    mustContain: ['VERSION', 'CHANGELOG', 'review', 'merge', 'PR'],
    // v1.58.5.0: pre-push-guard install (#2077) stacks on the shared first-run-guidance preamble.
    maxSizeRatio: 1.08,
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
    maxSkeletonBytes: 90_000,
    minUnionBytes: 80_000,
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
    maxSkeletonBytes: 67_000,
    minUnionBytes: 70_000,
    mustContain: ['Architecture', 'Code Quality', 'Test', 'Performance'],
    // Cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback + the
    // decision-memory nudge + the v1.57.4.0 Boil-the-Ocean rename) plus the
    // default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose, replacing the smaller opt-in question) land this at ~6.6% over the
    // v1.53.0.0 baseline. Headroom for those intentional additions.
    maxSizeRatio: 1.08,
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
    maxSkeletonBytes: 88_000,
    minUnionBytes: 70_000,
    mustContain: ['design', 'visual'],
    maxSizeRatio: 1.07,
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
    maxSkeletonBytes: 80_000,
    minUnionBytes: 70_000,
    mustContain: ['developer experience', 'Getting Started'],
    // Default-on Codex outside-voice (codexPreflight block + CODEX_MODE branch
    // prose replacing the smaller opt-in question) lands this ~5.7% over baseline.
    maxSizeRatio: 1.08,
  },
  'office-hours': {
    skill: 'office-hours',
    expectedSections: ['design-and-handoff.md'],
    requiredReads: ['design-and-handoff.md'],
    scenario:
      'Run office hours for this product idea through to the end: have the diagnostic conversation, explore alternatives, then write the design doc and run the relationship handoff (Phases 5-6).',
    staticInvariants: {
      mustStayInSkeleton: [],
      mustMoveToSection: [],
      // office-hours is conversational; the design-doc/handoff section has no
      // post-STOP review gate in the skeleton.
      gateAfterStop: undefined,
    },
    behavioral: 'prompt',
    // v1.2.0 activation lift: first-run-guidance section in the shared preamble,
    // plus the P1 office-hours closing handoff (AUQ that launches the next skill).
    maxSkeletonBytes: 98_000,
    minUnionBytes: 70_000,
    mustContain: ['design doc', 'problem statement'],
    maxSizeRatio: 1.07,
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
    maxSkeletonBytes: 56_000,
    minUnionBytes: 55_000,
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
    maxSkeletonBytes: 69_000,
    minUnionBytes: 72_000,
    mustContain: ['Typography', 'Color', 'Aesthetic Direction'],
    // Cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback ~2KB +
    // the cross-session decision-memory nudge) lands this carved skeleton just over
    // the strict 1.05; headroom for the shared preamble additions.
    maxSizeRatio: 1.07,
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
    maxSkeletonBytes: 75_000,
    minUnionBytes: 72_000,
    mustContain: ['OWASP', 'STRIDE', 'daily', 'comprehensive', 'verif'],
    // cso keeps its mode-dispatch + FP-filtering phases always-loaded, so the
    // cross-cutting preamble growth (v1.57.2.0 AUQ-failure prose fallback ~2KB + the
    // decision-memory nudge) lands it just over 1.05; headroom for the shared additions.
    maxSizeRatio: 1.07,
  },
};

/** Sorted carved-skill names. Consumers derive their lists from this — no parallel lists. */
export const CARVED_SKILLS: readonly string[] = Object.freeze(
  Object.keys(CARVE_GUARDS).sort(),
);
