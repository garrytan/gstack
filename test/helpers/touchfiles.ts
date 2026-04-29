/**
 * Diff-based test selection for E2E and LLM-judge evals.
 *
 * Each test declares which source files it depends on ("touchfiles").
 * The test runner checks `git diff` and only runs tests whose
 * dependencies were modified. Override with EVALS_ALL=1 to run everything.
 */

import { spawnSync } from 'child_process';

// --- Glob matching ---

/**
 * Match a file path against a glob pattern.
 * Supports:
 *   ** — match any number of path segments
 *   *  — match within a single segment (no /)
 */
export function matchGlob(file: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(file);
}

// --- Touchfile maps ---

/**
 * E2E test touchfiles — keyed by testName (the string passed to runSkillTest).
 * Each test lists the file patterns that, if changed, require the test to run.
 */
export const E2E_TOUCHFILES: Record<string, string[]> = {
  // Browse core (+ test-server dependency)
  'browse-basic':    ['browse/src/**', 'browse/test/test-server.ts'],
  'browse-snapshot': ['browse/src/**', 'browse/test/test-server.ts'],

  // SKILL.md setup + preamble (depend on ROOT SKILL.md + gen-skill-docs)
  'skillmd-setup-discovery':  ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'skillmd-no-local-binary':  ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'skillmd-outside-git':      ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],

  'session-awareness':        ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'operational-learning':     ['scripts/resolvers/preamble.ts', 'bin/gstack-learnings-log'],

  // QA (+ test-server dependency)
  'qa-quick':       ['qa/**', 'browse/src/**', 'browse/test/test-server.ts'],
  'qa-b6-static':   ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval.html', 'test/fixtures/qa-eval-ground-truth.json'],
  'qa-b7-spa':      ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-spa.html', 'test/fixtures/qa-eval-spa-ground-truth.json'],
  'qa-b8-checkout': ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-checkout.html', 'test/fixtures/qa-eval-checkout-ground-truth.json'],
  'qa-only-no-fix': ['qa-only/**', 'qa/templates/**'],
  'qa-fix-loop':    ['qa/**', 'browse/src/**', 'browse/test/test-server.ts'],
  'qa-bootstrap':   ['qa/**', 'ship/**'],

  // Review
  'review-sql-injection':     ['review/**', 'test/fixtures/review-eval-vuln.rb'],
  'review-enum-completeness': ['review/**', 'test/fixtures/review-eval-enum*.rb'],
  'review-base-branch':       ['review/**'],
  'review-design-lite':       ['review/**', 'test/fixtures/review-eval-design-slop.*'],

  // Review Army (specialist dispatch)
  'review-army-migration-safety': ['review/**', 'scripts/resolvers/review-army.ts', 'bin/gstack-diff-scope'],
  'review-army-perf-n-plus-one':  ['review/**', 'scripts/resolvers/review-army.ts', 'bin/gstack-diff-scope'],
  'review-army-delivery-audit':   ['review/**', 'scripts/resolvers/review.ts', 'scripts/resolvers/review-army.ts'],
  'review-army-quality-score':    ['review/**', 'scripts/resolvers/review-army.ts'],
  'review-army-json-findings':    ['review/**', 'scripts/resolvers/review-army.ts'],
  'review-army-red-team':         ['review/**', 'scripts/resolvers/review-army.ts'],
  'review-army-consensus':        ['review/**', 'scripts/resolvers/review-army.ts'],

  // Office Hours
  'office-hours-spec-review':     ['office-hours/**', 'scripts/gen-skill-docs.ts'],
  'office-hours-forcing-energy':  ['office-hours/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts'],
  'office-hours-builder-wildness': ['office-hours/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts'],

  // Plan reviews
  'plan-ceo-review':                  ['plan-ceo-review/**'],
  'plan-ceo-review-selective':        ['plan-ceo-review/**'],
  'plan-ceo-review-benefits':         ['plan-ceo-review/**', 'scripts/gen-skill-docs.ts'],
  'plan-ceo-review-expansion-energy': ['plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts'],
  'plan-eng-review':           ['plan-eng-review/**'],
  'plan-eng-review-artifact':  ['plan-eng-review/**'],
  'plan-review-report':        ['plan-eng-review/**', 'scripts/gen-skill-docs.ts'],

  // Plan-mode smoke tests — gate-tier safety regression tests. Each fires when
  // any of: the interactive skill's template, the plan-mode resolver
  // (completion-status owns generatePlanModeInfo), preamble composition, or
  // the real-PTY runner (which the tests now use instead of the SDK harness)
  // change.
  'plan-ceo-review-plan-mode':    ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],
  'plan-eng-review-plan-mode':    ['plan-eng-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],
  'plan-design-review-plan-mode': ['plan-design-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],
  'plan-devex-review-plan-mode':  ['plan-devex-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],
  'plan-mode-no-op':              ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],

  // Real-PTY E2E batch (#6 new tests on the harness).
  // Each one tests behavior the SDK harness can't observe (rendered TTY,
  // numbered-option lists, multi-phase ordering, idempotency state echo).
  'ask-user-question-format-pty':              ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],
  'plan-ceo-mode-routing':       ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts'],
  'plan-design-with-ui-scope':   ['plan-design-review/**', 'test/fixtures/plans/ui-heavy-feature.md', 'test/helpers/claude-pty-runner.ts'],
  'budget-regression-pty':       ['test/helpers/eval-store.ts', 'test/skill-budget-regression.test.ts'],
  'ship-idempotency-pty':        ['ship/**', 'bin/gstack-next-version', 'lib/worktree.ts', 'test/helpers/claude-pty-runner.ts'],
  'autoplan-chain-pty':          ['autoplan/**', 'plan-ceo-review/**', 'plan-design-review/**', 'plan-eng-review/**', 'plan-devex-review/**', 'test/fixtures/plans/ui-heavy-feature.md', 'test/helpers/claude-pty-runner.ts'],
  'e2e-harness-audit':            ['plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/claude-pty-runner.ts'],
  'brain-privacy-gate':           ['scripts/resolvers/preamble/generate-brain-sync-block.ts', 'scripts/resolvers/preamble.ts', 'bin/gstack-brain-sync', 'bin/gstack-brain-init', 'bin/gstack-config', 'test/helpers/agent-sdk-runner.ts'],

  // AskUserQuestion format regression (RECOMMENDATION + Completeness: N/10)
  // Fires when either template OR the two preamble resolvers change.
  'plan-ceo-review-format-mode':      ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'plan-ceo-review-format-approach':  ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'plan-eng-review-format-coverage':  ['plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'plan-eng-review-format-kind':      ['plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],

  // v1.7.0.0 Pros/Cons format cadence + format + negative-escape evals.
  // Dependencies: same as format-mode + the 4 plan-review templates + overlay.
  // All periodic-tier (non-deterministic Opus 4.7 behavior).
  'plan-ceo-review-prosons-cadence':  ['plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'plan-review-prosons-format':       ['plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'plan-review-prosons-hardstop-neg': ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'plan-review-prosons-neutral-neg':  ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],

  // Expanded coverage (CT3) — 6 non-plan-review skills inherit Pros/Cons via preamble
  'ship-prosons-format':              ['ship/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'office-hours-prosons-format':      ['office-hours/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'investigate-prosons-format':       ['investigate/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'qa-prosons-format':                ['qa/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'review-prosons-format':            ['review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'design-review-prosons-format':     ['design-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],
  'document-release-prosons-format':  ['document-release/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md'],

  // /plan-tune (v1 observational)
  'plan-tune-inspect':         ['plan-tune/**', 'scripts/question-registry.ts', 'scripts/psychographic-signals.ts', 'scripts/one-way-doors.ts', 'bin/gstack-question-log', 'bin/gstack-question-preference', 'bin/gstack-developer-profile'],

  // Codex offering verification
  'codex-offered-office-hours':  ['office-hours/**', 'scripts/gen-skill-docs.ts'],
  'codex-offered-ceo-review':    ['plan-ceo-review/**', 'scripts/gen-skill-docs.ts'],
  'codex-offered-design-review': ['plan-design-review/**', 'scripts/gen-skill-docs.ts'],
  'codex-offered-eng-review':    ['plan-eng-review/**', 'scripts/gen-skill-docs.ts'],

  // Ship
  'ship-base-branch': ['ship/**', 'bin/gstack-repo-mode'],
  'ship-local-workflow': ['ship/**', 'scripts/gen-skill-docs.ts'],
  'review-dashboard-via': ['ship/**', 'scripts/resolvers/review.ts', 'codex/**', 'autoplan/**', 'land-and-deploy/**'],
  'ship-plan-completion': ['ship/**', 'scripts/gen-skill-docs.ts'],
  'ship-plan-verification': ['ship/**', 'scripts/gen-skill-docs.ts'],

  // Retro
  'retro':             ['retro/**'],
  'retro-base-branch': ['retro/**'],

  // Global discover
  'global-discover':   ['bin/gstack-global-discover.ts', 'test/global-discover.test.ts'],

  // CSO
  'cso-full-audit':   ['cso/**'],
  'cso-diff-mode':    ['cso/**'],
  'cso-infra-scope':  ['cso/**'],

  // Learnings
  'learnings-show': ['learn/**', 'bin/gstack-learnings-search', 'bin/gstack-learnings-log', 'scripts/resolvers/learnings.ts'],

  // Session Intelligence (timeline, context recovery, /context-save + /context-restore)
  'timeline-event-flow':            ['bin/gstack-timeline-log', 'bin/gstack-timeline-read'],
  'context-recovery-artifacts':     ['scripts/resolvers/preamble.ts', 'bin/gstack-timeline-log', 'bin/gstack-slug', 'learn/**'],
  'context-save-writes-file':       ['context-save/**', 'bin/gstack-slug'],
  'context-restore-loads-latest':   ['context-restore/**', 'bin/gstack-slug'],

  // Context skills E2E (live-fire, Skill-tool routing path) — see
  // test/skill-e2e-context-skills.test.ts. These are periodic-tier because
  // each one spawns claude -p and costs ~$0.20-$0.40. Collectively they
  // verify the thing the /checkpoint → /context-save rename was for.
  'context-save-routing':                  ['context-save/**', 'scripts/resolvers/preamble.ts'],
  'context-save-then-restore-roundtrip':   ['context-save/**', 'context-restore/**', 'bin/gstack-slug'],
  'context-restore-fragment-match':        ['context-restore/**'],
  'context-restore-empty-state':           ['context-restore/**'],
  'context-restore-list-delegates':        ['context-restore/**'],
  'context-restore-legacy-compat':         ['context-restore/**'],
  'context-save-list-current-branch':      ['context-save/**'],
  'context-save-list-all-branches':        ['context-save/**'],

  // Document-release
  'document-release': ['document-release/**'],

  // Codex (Claude E2E — tests /codex skill via Claude)
  'codex-review': ['codex/**'],

  // Codex E2E (tests skills via Codex CLI + worktree)
  'codex-discover-skill':  ['codex/**', '.agents/skills/**', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts'],
  'codex-review-findings': ['review/**', '.agents/skills/gstack-review/**', 'codex/**', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts'],

  // Gemini E2E — smoke test only (Gemini gets lost in worktrees on complex tasks)
  'gemini-smoke':  ['.agents/skills/**', 'test/helpers/gemini-session-runner.ts', 'lib/worktree.ts'],


  // Coverage audit (shared fixture) + triage + gates
  'ship-coverage-audit': ['ship/**', 'test/fixtures/coverage-audit-fixture.ts', 'bin/gstack-repo-mode'],
  'review-coverage-audit': ['review/**', 'test/fixtures/coverage-audit-fixture.ts'],
  'plan-eng-coverage-audit': ['plan-eng-review/**', 'test/fixtures/coverage-audit-fixture.ts'],
  'ship-triage': ['ship/**', 'bin/gstack-repo-mode'],

  // Plan completion audit + verification
  'ship-plan-completion': ['ship/**', 'scripts/gen-skill-docs.ts'],
  'ship-plan-verification': ['ship/**', 'qa-only/**', 'scripts/gen-skill-docs.ts'],
  'ship-idempotency':       ['ship/**', 'scripts/resolvers/utility.ts'],
  'review-plan-completion': ['review/**', 'scripts/gen-skill-docs.ts'],

  // Design
  'design-consultation-core':       ['design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/helpers/llm-judge.ts'],
  'design-consultation-existing':   ['design-consultation/**', 'scripts/gen-skill-docs.ts'],
  'design-consultation-research':   ['design-consultation/**', 'scripts/gen-skill-docs.ts'],
  'design-consultation-preview':    ['design-consultation/**', 'scripts/gen-skill-docs.ts'],
  'plan-design-review-plan-mode':   ['plan-design-review/**', 'scripts/gen-skill-docs.ts'],
  'plan-design-review-no-ui-scope': ['plan-design-review/**', 'scripts/gen-skill-docs.ts'],
  'design-review-fix':              ['design-review/**', 'browse/src/**', 'scripts/gen-skill-docs.ts'],

  // Design Shotgun
  'design-shotgun-path':            ['design-shotgun/**', 'design/src/**', 'scripts/resolvers/design.ts'],
  'design-shotgun-session':         ['design-shotgun/**', 'scripts/resolvers/design.ts'],
  'design-shotgun-full':            ['design-shotgun/**', 'design/src/**', 'browse/src/**'],

  // gstack-upgrade
  'gstack-upgrade-happy-path': ['gstack-upgrade/**'],

  // Deploy skills
  'land-and-deploy-workflow':      ['land-and-deploy/**', 'scripts/gen-skill-docs.ts'],
  'land-and-deploy-first-run':     ['land-and-deploy/**', 'scripts/gen-skill-docs.ts', 'bin/gstack-slug'],
  'land-and-deploy-review-gate':   ['land-and-deploy/**', 'bin/gstack-review-read'],
  'canary-workflow':               ['canary/**', 'browse/src/**'],
  'benchmark-workflow':            ['benchmark/**', 'browse/src/**'],
  'setup-deploy-workflow':         ['setup-deploy/**', 'scripts/gen-skill-docs.ts'],

  // Sidebar agent
  'sidebar-navigate':              ['browse/src/server.ts', 'browse/src/sidebar-agent.ts', 'browse/src/sidebar-utils.ts', 'extension/**'],
  'sidebar-url-accuracy':          ['browse/src/server.ts', 'browse/src/sidebar-agent.ts', 'browse/src/sidebar-utils.ts', 'extension/background.js'],
  'sidebar-css-interaction':       ['browse/src/server.ts', 'browse/src/sidebar-agent.ts', 'browse/src/write-commands.ts', 'browse/src/read-commands.ts', 'browse/src/cdp-inspector.ts', 'extension/**'],

  // Autoplan
  'autoplan-core':  ['autoplan/**', 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**'],
  'autoplan-dual-voice': ['autoplan/**', 'codex/**', 'bin/gstack-codex-probe', 'scripts/resolvers/review.ts', 'scripts/resolvers/design.ts'],

  // Multi-provider benchmark adapters — live API smoke against real claude/codex/gemini CLIs
  'benchmark-providers-live': ['bin/gstack-model-benchmark', 'test/helpers/providers/**', 'test/helpers/benchmark-runner.ts', 'test/helpers/pricing.ts'],

  // Browser-skills Phase 2a — /scrape + /skillify (v1.19.0.0). Gate-tier
  // E2E covers the D1 (provenance guard), D3 (atomic write) contracts plus
  // the basic loop. Shared deps: both skill templates, the D3 helper, the
  // Phase 1 runtime, and the bundled hackernews-frontpage reference (the
  // match-path test relies on it).
  'scrape-match-path': [
    'scrape/**', 'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
    'browser-skills/hackernews-frontpage/**',
  ],
  'scrape-prototype-path': [
    'scrape/**', 'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
  ],
  'skillify-happy-path': [
    'skillify/**', 'scrape/**', 'browse/src/browser-skill-write.ts',
    'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
  ],
  'skillify-provenance-refusal': [
    'skillify/**', 'browse/src/browser-skill-write.ts',
  ],
  'skillify-approval-reject': [
    'skillify/**', 'scrape/**', 'browse/src/browser-skill-write.ts',
  ],

  // Skill routing — journey-stage tests (depend on ALL skill descriptions)
  'journey-ideation':       ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-plan-eng':       ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-debug':          ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-qa':             ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-code-review':    ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-ship':           ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-docs':           ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-retro':          ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-design-system':  ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-visual-qa':      ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],

  // Opus 4.7 behavior evals — keys match testName: values in the test file.
  // Routing sub-tests use template literal `routing-${c.name}` testNames,
  // which the touchfile completeness scanner skips; they inherit selection
  // from the file-level touchfile entry via GLOBAL_TOUCHFILES.
  'fanout-arm-overlay-on':
    ['model-overlays/claude.md', 'model-overlays/opus-4-7.md', 'scripts/models.ts', 'scripts/resolvers/model-overlay.ts'],
  'fanout-arm-overlay-off':
    ['model-overlays/claude.md', 'model-overlays/opus-4-7.md', 'scripts/models.ts', 'scripts/resolvers/model-overlay.ts'],

  // Overlay efficacy harness (SDK) — measures whether overlay nudges change
  // behavior under @anthropic-ai/claude-agent-sdk (closer to real Claude Code
  // than `claude -p`). testNames in the file are template literals so the
  // completeness scanner doesn't require them; these entries exist for
  // diff-based selection accuracy.
  'overlay-harness-opus-4-7-fanout-toy': [
    'model-overlays/**',
    'test/fixtures/overlay-nudges.ts',
    'test/helpers/agent-sdk-runner.ts',
    'scripts/resolvers/model-overlay.ts',
  ],
  'overlay-harness-opus-4-7-fanout-realistic': [
    'model-overlays/**',
    'test/fixtures/overlay-nudges.ts',
    'test/helpers/agent-sdk-runner.ts',
    'scripts/resolvers/model-overlay.ts',
  ],
};

/**
 * E2E test tiers — 'gate' blocks PRs, 'periodic' runs weekly/on-demand.
 * Must have exactly the same keys as E2E_TOUCHFILES.
 */
export const E2E_TIERS: Record<string, 'gate' | 'periodic'> = {
  // Browse core — gate (if browse breaks, everything breaks)
  'browse-basic': 'gate',
  'browse-snapshot': 'gate',

  // SKILL.md setup — gate (if setup breaks, no skill works)
  'skillmd-setup-discovery': 'gate',
  'skillmd-no-local-binary': 'gate',
  'skillmd-outside-git': 'gate',
  'session-awareness': 'gate',
  'operational-learning': 'gate',

  // QA — gate for functional, periodic for quality/benchmarks
  'qa-quick': 'gate',
  'qa-b6-static': 'periodic',
  'qa-b7-spa': 'periodic',
  'qa-b8-checkout': 'periodic',
  'qa-only-no-fix': 'gate',     // CRITICAL guardrail: Edit tool forbidden
  'qa-fix-loop': 'periodic',
  'qa-bootstrap': 'gate',

  // Review — gate for functional/guardrails, periodic for quality
  'review-sql-injection': 'gate',     // Security guardrail
  'review-enum-completeness': 'gate',
  'review-base-branch': 'gate',
  'review-design-lite': 'periodic',   // 4/7 threshold is subjective
  'review-coverage-audit': 'gate',
  'review-plan-completion': 'gate',
  'review-dashboard-via': 'gate',

  // Review Army — gate for core functionality, periodic for multi-specialist
  'review-army-migration-safety': 'gate',   // Specialist activation guardrail
  'review-army-perf-n-plus-one': 'gate',    // Specialist activation guardrail
  'review-army-delivery-audit': 'gate',     // Delivery integrity guardrail
  'review-army-quality-score': 'gate',      // Score computation
  'review-army-json-findings': 'gate',      // JSON schema compliance
  'review-army-red-team': 'periodic',       // Multi-agent coordination
  'review-army-consensus': 'periodic',      // Multi-specialist agreement

  // Office Hours
  'office-hours-spec-review': 'gate',
  'office-hours-forcing-energy': 'gate',       // V1.1 mode-posture regression gate (Sonnet generator)
  'office-hours-builder-wildness': 'gate',     // V1.1 mode-posture regression gate (Sonnet generator)

  // Plan reviews — gate for cheap functional, periodic for Opus quality
  'plan-ceo-review': 'periodic',
  'plan-ceo-review-selective': 'periodic',
  'plan-ceo-review-benefits': 'gate',
  'plan-ceo-review-expansion-energy': 'gate',  // V1.1 mode-posture regression gate (Opus generator, Sonnet judge)
  'plan-eng-review': 'periodic',
  'plan-eng-review-artifact': 'periodic',
  'plan-eng-coverage-audit': 'gate',
  'plan-review-report': 'gate',

  // Plan-mode handshake — deterministic safety regression, gate-tier
  'plan-ceo-review-plan-mode': 'gate',
  'plan-eng-review-plan-mode': 'gate',
  'plan-design-review-plan-mode': 'gate',
  'plan-devex-review-plan-mode': 'gate',
  'plan-mode-no-op': 'gate',
  'e2e-harness-audit': 'gate',

  // Real-PTY E2E batch — tier classification:
  //   gate: cheap, deterministic, run on every PR
  //   periodic: long-running or expensive (>$3/run), run weekly
  'ask-user-question-format-pty':            'gate',       // ~$0.50/run, single skill probe
  'plan-ceo-mode-routing':     'periodic',   // ~$3/run, deep navigation through 8-12 prior AskUserQuestions
  'plan-design-with-ui-scope': 'gate',       // ~$0.80/run
  'budget-regression-pty':     'gate',       // free, library-only assertion
  'ship-idempotency-pty':      'periodic',   // ~$3/run, real /ship in plan mode
  'autoplan-chain-pty':        'periodic',   // ~$8/run, all 3 phases sequential

  // Privacy gate for gstack-brain-sync — periodic (non-deterministic LLM call,
  // costs ~$0.30-$0.50 per run, not needed on every commit)
  'brain-privacy-gate': 'periodic',

  // AskUserQuestion format regression — periodic (Opus 4.7 non-deterministic benchmark)
  'plan-ceo-review-format-mode': 'periodic',
  'plan-ceo-review-format-approach': 'periodic',
  'plan-eng-review-format-coverage': 'periodic',
  'plan-eng-review-format-kind': 'periodic',

  // v1.7.0.0 Pros/Cons format — cadence + negative-escape evals (all periodic)
  'plan-ceo-review-prosons-cadence': 'periodic',
  'plan-review-prosons-format': 'periodic',
  'plan-review-prosons-hardstop-neg': 'periodic',
  'plan-review-prosons-neutral-neg': 'periodic',

  // CT3 expanded coverage — non-plan-review skills inheriting Pros/Cons (all periodic)
  'ship-prosons-format': 'periodic',
  'office-hours-prosons-format': 'periodic',
  'investigate-prosons-format': 'periodic',
  'qa-prosons-format': 'periodic',
  'review-prosons-format': 'periodic',
  'design-review-prosons-format': 'periodic',
  'document-release-prosons-format': 'periodic',

  // /plan-tune — gate (core v1 DX promise: plain-English intent routing)
  'plan-tune-inspect': 'gate',

  // Codex offering verification
  'codex-offered-office-hours': 'gate',
  'codex-offered-ceo-review': 'gate',
  'codex-offered-design-review': 'gate',
  'codex-offered-eng-review': 'gate',

  // Session Intelligence — gate for data flow, periodic for agent integration
  'timeline-event-flow': 'gate',                   // Binary data flow (no LLM needed)
  'context-recovery-artifacts': 'gate',            // Preamble reads seeded artifacts
  'context-save-writes-file': 'gate',              // /context-save writes a file
  'context-restore-loads-latest': 'gate',          // Cross-branch newest-by-filename restore

  // Context skills live-fire — periodic (each test spawns claude -p, ~$0.20-$0.40)
  'context-save-routing': 'periodic',              // Proves /context-save routes via Skill tool
  'context-save-then-restore-roundtrip': 'periodic', // Full cycle in one session
  'context-restore-fragment-match': 'periodic',    // /context-restore <fragment>
  'context-restore-empty-state': 'periodic',       // Graceful zero-saves message
  'context-restore-list-delegates': 'periodic',    // /context-restore list redirect
  'context-restore-legacy-compat': 'periodic',     // Pre-rename files still load
  'context-save-list-current-branch': 'periodic',  // Default branch filter
  'context-save-list-all-branches': 'periodic',    // --all flag

  // Ship — gate (end-to-end ship path)
  'ship-base-branch': 'gate',
  'ship-local-workflow': 'gate',
  'ship-coverage-audit': 'gate',
  'ship-triage': 'gate',
  'ship-plan-completion': 'gate',
  'ship-plan-verification': 'gate',
  'ship-idempotency': 'periodic',

  // Retro — gate for cheap branch detection, periodic for full Opus retro
  'retro': 'periodic',
  'retro-base-branch': 'gate',

  // Global discover
  'global-discover': 'gate',

  // CSO — gate for security guardrails, periodic for quality
  'cso-full-audit': 'gate',      // Hardcoded secrets detection
  'cso-diff-mode': 'gate',
  'cso-infra-scope': 'periodic',

  // Learnings — gate (functional guardrail: seeded learnings must appear)
  'learnings-show': 'gate',

  // Document-release — gate (CHANGELOG guardrail)
  'document-release': 'gate',

  // Codex — periodic (Opus, requires codex CLI)
  'codex-review': 'periodic',

  // Multi-AI — periodic (require external CLIs)
  'codex-discover-skill': 'periodic',
  'codex-review-findings': 'periodic',
  'gemini-smoke': 'periodic',

  // Design — gate for cheap functional, periodic for Opus/quality
  'design-consultation-core': 'periodic',
  'design-consultation-existing': 'periodic',
  'design-consultation-research': 'gate',
  'design-consultation-preview': 'gate',
  'plan-design-review-plan-mode': 'periodic',
  'plan-design-review-no-ui-scope': 'gate',
  'design-review-fix': 'periodic',
  'design-shotgun-path': 'gate',
  'design-shotgun-session': 'gate',
  'design-shotgun-full': 'periodic',

  // gstack-upgrade
  'gstack-upgrade-happy-path': 'gate',

  // Deploy skills
  'land-and-deploy-workflow': 'gate',
  'land-and-deploy-first-run': 'gate',
  'land-and-deploy-review-gate': 'gate',
  'canary-workflow': 'gate',
  'benchmark-workflow': 'gate',
  'setup-deploy-workflow': 'gate',

  // Sidebar agent
  'sidebar-navigate': 'periodic',
  'sidebar-url-accuracy': 'periodic',
  'sidebar-css-interaction': 'periodic',

  // Autoplan — periodic (not yet implemented)
  'autoplan-core': 'periodic',
  'autoplan-dual-voice': 'periodic',

  // Multi-provider benchmark — periodic (requires external CLIs + auth, paid)
  'benchmark-providers-live': 'periodic',

  // Browser-skills Phase 2a — gate (D1/D3 contracts must not silently break)
  'scrape-match-path': 'gate',
  'scrape-prototype-path': 'gate',
  'skillify-happy-path': 'gate',
  'skillify-provenance-refusal': 'gate',
  'skillify-approval-reject': 'gate',

  // Skill routing — periodic (LLM routing is non-deterministic)
  'journey-ideation': 'periodic',
  'journey-plan-eng': 'periodic',
  'journey-debug': 'periodic',
  'journey-qa': 'periodic',
  'journey-code-review': 'periodic',
  'journey-ship': 'periodic',
  'journey-docs': 'periodic',
  'journey-retro': 'periodic',
  'journey-design-system': 'periodic',
  'journey-visual-qa': 'periodic',

  // Opus 4.7 overlay evals — periodic (non-deterministic LLM behavior + Opus cost)
  'fanout-arm-overlay-on': 'periodic',
  'fanout-arm-overlay-off': 'periodic',

  // Overlay efficacy harness (SDK, paid) — periodic only
  'overlay-harness-opus-4-7-fanout-toy': 'periodic',
  'overlay-harness-opus-4-7-fanout-realistic': 'periodic',
};

/**
 * LLM-judge test touchfiles — keyed by test description string.
 */
export const LLM_JUDGE_TOUCHFILES: Record<string, string[]> = {
  'command reference table':          ['SKILL.md', 'SKILL.md.tmpl', 'browse/src/commands.ts'],
  'snapshot flags reference':         ['SKILL.md', 'SKILL.md.tmpl', 'browse/src/snapshot.ts'],
  'browse/SKILL.md reference':        ['browse/SKILL.md', 'browse/SKILL.md.tmpl', 'browse/src/**'],
  'setup block':                      ['SKILL.md', 'SKILL.md.tmpl'],
  'regression vs baseline':           ['SKILL.md', 'SKILL.md.tmpl', 'browse/src/commands.ts', 'test/fixtures/eval-baselines.json'],
  'qa/SKILL.md workflow':             ['qa/SKILL.md', 'qa/SKILL.md.tmpl'],
  'qa/SKILL.md health rubric':        ['qa/SKILL.md', 'qa/SKILL.md.tmpl'],
  'qa/SKILL.md anti-refusal':         ['qa/SKILL.md', 'qa/SKILL.md.tmpl', 'qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl'],
  'cross-skill greptile consistency': ['review/SKILL.md', 'review/SKILL.md.tmpl', 'ship/SKILL.md', 'ship/SKILL.md.tmpl', 'review/greptile-triage.md', 'retro/SKILL.md', 'retro/SKILL.md.tmpl'],
  'baseline score pinning':           ['SKILL.md', 'SKILL.md.tmpl', 'test/fixtures/eval-baselines.json'],

  // Ship & Release
  'ship/SKILL.md workflow':               ['ship/SKILL.md', 'ship/SKILL.md.tmpl'],
  'document-release/SKILL.md workflow':   ['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'],

  // Plan Reviews
  'plan-ceo-review/SKILL.md modes':       ['plan-ceo-review/SKILL.md', 'plan-ceo-review/SKILL.md.tmpl'],
  'plan-eng-review/SKILL.md sections':    ['plan-eng-review/SKILL.md', 'plan-eng-review/SKILL.md.tmpl'],
  'plan-design-review/SKILL.md passes':   ['plan-design-review/SKILL.md', 'plan-design-review/SKILL.md.tmpl'],

  // Design skills
  'design-review/SKILL.md fix loop':      ['design-review/SKILL.md', 'design-review/SKILL.md.tmpl'],
  'design-consultation/SKILL.md research': ['design-consultation/SKILL.md', 'design-consultation/SKILL.md.tmpl'],

  // Office Hours
  'office-hours/SKILL.md spec review':    ['office-hours/SKILL.md', 'office-hours/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'office-hours/SKILL.md design sketch':  ['office-hours/SKILL.md', 'office-hours/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],

  // Deploy skills
  'land-and-deploy/SKILL.md workflow':    ['land-and-deploy/SKILL.md', 'land-and-deploy/SKILL.md.tmpl'],
  'canary/SKILL.md monitoring loop':      ['canary/SKILL.md', 'canary/SKILL.md.tmpl'],
  'benchmark/SKILL.md perf collection':   ['benchmark/SKILL.md', 'benchmark/SKILL.md.tmpl'],
  'setup-deploy/SKILL.md platform setup': ['setup-deploy/SKILL.md', 'setup-deploy/SKILL.md.tmpl'],

  // Other skills
  'retro/SKILL.md instructions':          ['retro/SKILL.md', 'retro/SKILL.md.tmpl'],
  'qa-only/SKILL.md workflow':            ['qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl'],
  'gstack-upgrade/SKILL.md upgrade flow': ['gstack-upgrade/SKILL.md', 'gstack-upgrade/SKILL.md.tmpl'],

  // Voice directive
  'voice directive tone':                 ['scripts/resolvers/preamble.ts', 'review/SKILL.md', 'review/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
};

/**
 * Changes to any of these files trigger ALL tests (both E2E and LLM-judge).
 *
 * Keep this list minimal — only files that genuinely affect every test.
 * Scoped dependencies (gen-skill-docs, llm-judge, test-server, worktree,
 * codex/gemini session runners) belong in individual test entries instead.
 */
export const GLOBAL_TOUCHFILES = [
  'test/helpers/session-runner.ts',  // All E2E tests use this runner
  'test/helpers/eval-store.ts',      // All E2E tests store results here
  'test/helpers/touchfiles.ts',      // Self-referential — reclassifying wrong is dangerous
];

// --- Base branch detection ---

/**
 * Detect the base branch by trying refs in order.
 * Returns the first valid ref, or null if none found.
 */
export function detectBaseBranch(cwd: string): string | null {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const result = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd, stdio: 'pipe', timeout: 3000,
    });
    if (result.status === 0) return ref;
  }
  return null;
}

/**
 * Get list of files changed between base branch and HEAD.
 */
export function getChangedFiles(baseBranch: string, cwd: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
    cwd, stdio: 'pipe', timeout: 5000,
  });
  if (result.status !== 0) return [];
  return result.stdout.toString().trim().split('\n').filter(Boolean);
}

// --- Test selection ---

/**
 * Select tests to run based on changed files.
 *
 * Algorithm:
 * 1. If any changed file matches a global touchfile → run ALL tests
 * 2. Otherwise, for each test, check if any changed file matches its patterns
 * 3. Return selected + skipped lists with reason
 */
export function selectTests(
  changedFiles: string[],
  touchfiles: Record<string, string[]>,
  globalTouchfiles: string[] = GLOBAL_TOUCHFILES,
): { selected: string[]; skipped: string[]; reason: string } {
  const allTestNames = Object.keys(touchfiles);

  // Global touchfile hit → run all
  for (const file of changedFiles) {
    if (globalTouchfiles.some(g => matchGlob(file, g))) {
      return { selected: allTestNames, skipped: [], reason: `global: ${file}` };
    }
  }

  // Per-test matching
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const [testName, patterns] of Object.entries(touchfiles)) {
    const hit = changedFiles.some(f => patterns.some(p => matchGlob(f, p)));
    (hit ? selected : skipped).push(testName);
  }

  return { selected, skipped, reason: 'diff' };
}
