/**
 * Touchfile maps — the DATA half of diff-based test selection.
 *
 * LITERALS ONLY. This file must contain zero import statements and zero
 * executable logic: no function calls, no spreads, no template literals —
 * just string / array / Record literals. That property is load-bearing:
 * map-diff selection evaluates OLD git versions of this file standalone to
 * diff the maps across commits, which only works while the file stays pure,
 * importable data. test/touchfiles-facade.test.ts enforces this with a
 * comment-and-string-stripping tripwire.
 *
 * The selection logic (matchGlob, detectBaseBranch, getChangedFiles,
 * selectTests) lives in ./test-selection.ts. Import sites should keep using
 * the ./touchfiles facade, which re-exports both halves.
 */

// --- Touchfile maps ---

/**
 * E2E test touchfiles — keyed by testName (the string passed to runSkillTest).
 * Each test lists the file patterns that, if changed, require the test to run.
 */
export const E2E_TOUCHFILES: Record<string, string[]> = {
  // Browse core (+ test-server dependency)
  'browse-basic':    ['browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-bws.test.ts'],
  'browse-snapshot': ['browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-bws.test.ts'],

  // Hermetic isolation canaries (hermetic-env.ts is also a GLOBAL touchfile;
  // these entries exist so the canaries themselves stay tier-classified)
  'hermetic-canary':   ['test/helpers/hermetic-env.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-hermetic-canary.test.ts', 'lib/conductor-env-shim.ts'],
  'hermetic-sentinel': ['test/helpers/hermetic-env.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-hermetic-canary.test.ts', 'lib/conductor-env-shim.ts'],

  // P4 first-run scaffold (activation lift) — the detection binary end-to-end
  // through the real runner, plus the script wiring that gates + maps it
  // (token-reduction Phase 2: generate-first-run-guidance.ts was deleted; the
  // gate + token→tip map live in bin/gstack-skill-start's emission layer).
  'first-task-scaffold': ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'bin/gstack-first-task-detect', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'test/skill-e2e-first-task-scaffold.test.ts', 'test/helpers/session-runner.ts'],

  // SKILL.md setup + preamble (depend on ROOT SKILL.md + gen-skill-docs)
  'skillmd-setup-discovery':  ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],
  'skillmd-no-local-binary':  ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],
  'skillmd-outside-git':      ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],

  'session-awareness':        ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],
  'operational-learning':     ['scripts/resolvers/preamble.ts', 'bin/gstack-learnings-log', 'test/skill-e2e-bws.test.ts'],

  // QA (+ test-server dependency)
  'qa-quick':       ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-qa-workflow.test.ts'],
  'qa-b6-static':   ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval.html', 'test/fixtures/qa-eval-ground-truth.json', 'test/skill-e2e-qa-bugs.test.ts'],
  'qa-b7-spa':      ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-spa.html', 'test/fixtures/qa-eval-spa-ground-truth.json', 'test/skill-e2e-qa-bugs.test.ts'],
  'qa-b8-checkout': ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-checkout.html', 'test/fixtures/qa-eval-checkout-ground-truth.json', 'test/skill-e2e-qa-bugs.test.ts'],
  'qa-only-no-fix': ['qa-only/**', 'qa/templates/**', 'test/skill-e2e-qa-workflow.test.ts'],
  'qa-fix-loop':    ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-qa-workflow.test.ts'],
  'qa-bootstrap':   ['qa/**', 'ship/**', 'test/skill-e2e-qa-workflow.test.ts'],

  // Review
  'review-sql-injection':     ['review/**', 'test/fixtures/review-eval-vuln.rb', 'test/skill-e2e-review.test.ts'],
  'review-enum-completeness': ['review/**', 'test/fixtures/review-eval-enum*.rb', 'test/skill-e2e-review.test.ts'],
  'review-base-branch':       ['review/**', 'test/skill-e2e-review-attribution.test.ts'],
  'review-design-lite':       ['review/**', 'test/fixtures/review-eval-design-slop.*', 'test/skill-e2e-review.test.ts'],

  // Review Army (specialist dispatch)
  'review-army-migration-safety': ['review/**', 'scripts/resolvers/review-army.ts', 'bin/gstack-diff-scope', 'test/skill-e2e-review-army.test.ts'],
  'review-army-perf-n-plus-one':  ['review/**', 'scripts/resolvers/review-army.ts', 'bin/gstack-diff-scope', 'test/skill-e2e-review-army.test.ts'],
  'review-army-delivery-audit':   ['review/**', 'scripts/resolvers/review.ts', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts'],
  'review-army-quality-score':    ['review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts'],
  'review-army-json-findings':    ['review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts'],
  'review-army-red-team':         ['review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts'],
  'review-army-simplification':   ['review/**', 'scripts/resolvers/review-army.ts', 'test/fixtures/review-army-overbuild.js', 'test/fixtures/review-army-lean-complete.js', 'test/skill-e2e-review-army.test.ts'],
  'review-army-simplification-precision': ['review/**', 'scripts/resolvers/review-army.ts', 'test/fixtures/review-army-overbuild.js', 'test/fixtures/review-army-lean-complete.js', 'test/skill-e2e-review-army.test.ts'],
  'review-army-consensus':        ['review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts'],

  // Office Hours
  'office-hours-spec-review':     ['office-hours/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],
  'office-hours-forcing-energy':  ['office-hours/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-office-hours.test.ts'],
  'office-hours-builder-wildness': ['office-hours/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-office-hours.test.ts'],

  // Plan reviews
  'plan-ceo-review':                  ['plan-ceo-review/**', 'test/skill-e2e-plan.test.ts'],
  'plan-ceo-review-selective':        ['plan-ceo-review/**', 'test/skill-e2e-plan.test.ts'],
  'plan-ceo-review-benefits':         ['plan-ceo-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],
  'plan-ceo-review-expansion-energy': ['plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan.test.ts'],
  'plan-eng-review':           ['plan-eng-review/**', 'test/skill-e2e-plan.test.ts'],
  'plan-eng-review-artifact':  ['plan-eng-review/**', 'test/skill-e2e-plan.test.ts'],
  'plan-review-report':        ['plan-eng-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],

  // Plan-mode smoke tests — gate-tier safety regression tests. Each test file
  // contains TWO test cases as of v1.21: the baseline plan-mode case and the
  // AskUserQuestion-blocked regression case (--disallowedTools AskUserQuestion
  // parameterized — the flag set Conductor uses by default). Touchfiles
  // include question-tuning.ts and generate-ask-user-format.ts because the
  // AUTO_DECIDE preamble injection lives there and changes can flip the
  // regression test outcome between 'asked' and 'auto_decided'.
  'plan-ceo-review-plan-mode':    ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-ceo-plan-mode.test.ts'],
  'plan-eng-review-plan-mode':    ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-eng-plan-mode.test.ts'],
  'plan-design-review-plan-mode': ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-design-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-design-plan-mode.test.ts', 'test/skill-e2e-design.test.ts'],
  'plan-devex-review-plan-mode':  ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-devex-plan-mode.test.ts'],
  // Covers ceo (preamble misfire) + eng/design (scope-gate bypass must not
  // fire outside plan mode) + the named-target exception case. 4 PTY runs;
  // in CI these run CONCURRENT with the rest of the pty-plan-smoke suite
  // (--max-concurrency + --retry 1), so worst-case cost is ~2x a single
  // pass of each, sharing the API budget with sibling tests — not the
  // sequential ~+10min a local read suggests.
  'plan-mode-no-op':              ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-mode-no-op.test.ts'],

  // v1.21+ AskUserQuestion-blocked regression tests — Conductor launches
  // claude with `--disallowedTools AskUserQuestion --permission-mode default`
  // (verified via `ps`); skills must still surface user-decisions through a
  // fallback path (mcp__conductor__AskUserQuestion or plan-file flow) rather
  // than silently auto-deciding. Parameterized regression test cases live
  // INSIDE the existing 4 plan-X-review-plan-mode test files (covered
  // transitively by the entries above). Two new standalone files exist for
  // skills with no prior plan-mode test:
  'office-hours-auto-mode':       ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'office-hours/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-office-hours-auto-mode.test.ts'],
  'office-hours-phase4-fork':     ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'office-hours/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/question-tuning.ts', 'test/helpers/llm-judge.ts', 'test/skill-e2e-office-hours-phase4.test.ts'],
  'llm-judge-recommendation':     ['codex/**', 'test/helpers/llm-judge.ts', 'test/llm-judge-recommendation.test.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'codex/SKILL.md.tmpl', 'scripts/resolvers/review.ts'],
  // v1.21+ AUTO_DECIDE preserve eval (periodic). Verifies the Tool resolution
  // fix doesn't trip the legitimate /plan-tune opt-in path: when the user has
  // written a never-ask preference, AUQ should still auto-decide rather than
  // surfacing the question. Touches the question-tuning + preference
  // infrastructure plus the resolvers that own the AUTO_DECIDE preamble.
  'auto-decide-preserved':        ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'bin/gstack-session-kind', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'plan-ceo-review/**', 'bin/gstack-question-preference', 'bin/gstack-config', 'bin/gstack-slug', 'hosts/claude/hooks/question-preference-hook.ts', 'hosts/claude/hooks/spawned-directive.ts', 'lib/is-conductor.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-auto-decide-preserved.test.ts'],

  // Conductor → prose decision brief (Conductor signal makes prose the default;
  // the PreToolUse hook denies the flaky tool). Touches the resolver that owns
  // the Conductor rule, the preamble signal, the hook, and the detection helper.
  'conductor-prose':              ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'bin/gstack-session-kind', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble.ts', 'plan-eng-review/**', 'hosts/claude/hooks/question-preference-hook.ts', 'hosts/claude/hooks/spawned-directive.ts', 'lib/is-conductor.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-conductor-prose.test.ts'],

  // Real-PTY E2E batch (#6 new tests on the harness).
  // Each one tests behavior the SDK harness can't observe (rendered TTY,
  // numbered-option lists, multi-phase ordering, idempotency state echo).
  'auq-format-gate':                           ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'test/helpers/llm-judge.ts', 'test/skill-e2e-ask-user-question-format-compliance.test.ts'],
  'plan-ceo-mode-routing':       ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-ceo-mode-routing.test.ts'],
  'plan-design-with-ui-scope':   ['plan-design-review/**', 'test/fixtures/plans/ui-heavy-feature.md', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-design-with-ui.test.ts'],
  'ship-idempotency-pty':        ['ship/**', 'bin/gstack-next-version', 'bin/gstack-version-bump', 'scripts/resolvers/sections.ts', 'lib/worktree.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-ship-idempotency.test.ts'],
  'tpa-present':                 ['scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts'],
  'tpa-absent-linux':            ['scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts'],
  'tpa-broken':                  ['scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts'],
  'tpa-absent-darwin':           ['scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts'],
  'tpa-apple-ban':               ['scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts'],
  'ship-section-loading':        ['ship/**', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-ship-section-loading.test.ts'],
  'plan-ceo-section-loading':    ['plan-ceo-review/**', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-plan-ceo-review-section-loading.test.ts'],
  // Data-driven behavioral guard for the 'plan'/'prompt' carves (eng, design,
  // devex, office-hours + future PR2 carves). One file iterating CARVE_GUARDS;
  // the selector sets GSTACK_CARVE_SKILL=<name> to scope cost to the changed
  // skill (D-CODEX A). Touching the registry/helper or sections.ts runs all.
  'carve-section-loading':       ['design-html/**', 'design-shotgun/**', 'qa/**', 'browse/**', 'retro/**', 'autoplan/**', 'spec/**', 'setup-gbrain/**', 'review/**', 'codex/**', 'land-and-deploy/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'office-hours/**', 'document-release/**', 'design-consultation/**', 'cso/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'test/carve-section-loading.test.ts'],
  'autoplan-chain-pty':          ['autoplan/**', 'plan-ceo-review/**', 'plan-design-review/**', 'plan-eng-review/**', 'plan-devex-review/**', 'test/fixtures/plans/ui-heavy-feature.md', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-autoplan-chain.test.ts'],

  // Per-finding AskUserQuestion count + review-report-at-bottom assertion.
  // Each test drives its skill end-to-end; touchfiles include preamble +
  // completion-status resolvers because they affect question cadence and
  // terminal output (the regression surface this test catches).
  'plan-ceo-finding-count':      ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-ceo-finding-count.test.ts'],
  'plan-eng-finding-count':      ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-eng-finding-count.test.ts'],
  'plan-design-finding-count':   ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-design-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-design-finding-count.test.ts'],
  'plan-devex-finding-count':    ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-devex-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/helpers/claude-pty-runner.ts', 'test/skill-e2e-plan-devex-finding-count.test.ts'],

  // Gate-tier reviewCount-floor counterparts. Catch the May 2026 transcript
  // bug (model wrote a plan-mode plan and ExitPlanMode'd without firing any
  // review-phase AskUserQuestion). Uses runPlanSkillFloorCheck — minimal
  // "did agent fire ANY AUQ?" observer that exits early on first non-permission
  // numbered-option render. ~1-3 min typical wall time per test, ~$2-6 total.
  'plan-eng-finding-floor':      ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-eng-finding-floor.test.ts'],
  'plan-ceo-finding-floor':      ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-ceo-finding-floor.test.ts'],
  'plan-design-finding-floor':   ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-design-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-design-finding-floor.test.ts'],
  'plan-devex-finding-floor':    ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-devex-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-devex-finding-floor.test.ts'],

  // Multi-finding batching regression — periodic tier complement to the
  // gate-tier finding-floor. Catches the May 2026 transcript shape where
  // a model fires one AUQ then batches the rest into a "## Decisions to
  // confirm" plan write. runPlanSkillFloorCheck cannot detect that shape
  // (it exits on first AUQ); runPlanSkillCounting can.
  'plan-eng-multi-finding-batching': ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review.ts', 'test/helpers/claude-pty-runner.ts', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-eng-multi-finding-batching.test.ts'],
  'plan-ceo-split-overflow': ['plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'bin/gstack-question-preference', 'test/helpers/claude-pty-runner.ts', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-ceo-split-overflow.test.ts'],
  'brain-privacy-gate':           ['bin/gstack-skill-start', 'bin/gstack-skill-end', 'scripts/resolvers/preamble/generate-brain-sync-block.ts', 'scripts/resolvers/preamble.ts', 'bin/gstack-brain-sync', 'bin/gstack-artifacts-init', 'bin/gstack-config', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-brain-privacy-gate.test.ts'],

  // /setup-gbrain Path 4 (Remote MCP) — happy + bad-token end-to-end via
  // Agent SDK. Gate-tier (deterministic stub server, fixed inputs); fires
  // when the skill template, the verify helper, the artifacts-init helper,
  // or the detect script changes.
  'setup-gbrain-remote':          ['setup-gbrain/sections/brain-init.md.tmpl', 'setup-gbrain/sections/claude-md-persist.md.tmpl', 'setup-gbrain/sections/manifest.json', 'test/helpers/setup-gbrain-fixture.ts', 'setup-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-mcp-verify', 'bin/gstack-artifacts-init', 'bin/gstack-gbrain-detect', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-setup-gbrain-remote.test.ts'],
  'setup-gbrain-bad-token':       ['setup-gbrain/sections/brain-init.md.tmpl', 'setup-gbrain/sections/manifest.json', 'test/helpers/setup-gbrain-fixture.ts', 'setup-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-mcp-verify', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-setup-gbrain-bad-token.test.ts'],
  // v1.34.0.0 split-engine Path 4 + Step 4.5 Yes (local PGLite for code).
  // Periodic-tier per codex #12 (AgentSDK harness is non-deterministic).
  // Fires when the setup-gbrain template, install/verify/init helpers, or
  // the agent-sdk-runner harness changes.
  'setup-gbrain-path4-local-pglite': ['setup-gbrain/sections/brain-init.md.tmpl', 'setup-gbrain/sections/claude-md-persist.md.tmpl', 'setup-gbrain/sections/manifest.json', 'test/helpers/setup-gbrain-fixture.ts', 'setup-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-mcp-verify', 'bin/gstack-gbrain-install', 'bin/gstack-gbrain-detect', 'lib/gbrain-local-status.ts', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-setup-gbrain-path4-local-pglite.test.ts'],

  // AskUserQuestion format regression (RECOMMENDATION + Completeness: N/10)
  // Fires when either template OR the two preamble resolvers change.
  'plan-ceo-review-format-mode':      ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts'],
  'plan-ceo-review-format-approach':  ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts'],
  'plan-eng-review-format-coverage':  ['plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts'],
  'plan-eng-review-format-kind':      ['plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts'],

  // v1.7.0.0 Pros/Cons format cadence + format + negative-escape evals.
  // Dependencies: same as format-mode + the 4 plan-review templates + overlay.
  // All periodic-tier (non-deterministic Opus 4.7 behavior).
  'plan-ceo-review-prosons-cadence':  ['plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts'],
  'plan-review-prosons-format':       ['plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts'],
  'plan-review-prosons-hardstop-neg': ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts'],
  'plan-review-prosons-neutral-neg':  ['plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts'],

  // Expanded coverage (CT3) — 6 non-plan-review skills inherit Pros/Cons via preamble

  // /plan-tune (v1 observational)
  'plan-tune-inspect':         ['plan-tune/**', 'scripts/question-registry.ts', 'scripts/psychographic-signals.ts', 'scripts/one-way-doors.ts', 'bin/gstack-question-log', 'bin/gstack-question-preference', 'bin/gstack-developer-profile', 'test/skill-e2e-plan-tune.test.ts'],

  // /plan-tune cathedral (T16 — 5 E2E scenarios, all gate per D12)
  'plan-tune-hook-capture':      ['hosts/claude/hooks/**', 'bin/gstack-question-log', 'bin/gstack-developer-profile', 'plan-tune/**', 'test/skill-e2e-plan-tune-cathedral.test.ts'],
  'plan-tune-enforcement':       ['hosts/claude/hooks/**', 'bin/gstack-question-preference', 'scripts/question-registry.ts', 'test/skill-e2e-plan-tune-cathedral.test.ts'],
  'plan-tune-annotation':        ['hosts/claude/hooks/**', 'scripts/declared-annotation.ts', 'scripts/psychographic-signals.ts', 'scripts/question-registry.ts', 'test/skill-e2e-plan-tune-cathedral.test.ts'],
  'plan-tune-codex-import':      ['bin/gstack-codex-session-import', 'bin/gstack-question-log', 'docs/spikes/codex-session-format.md', 'test/skill-e2e-plan-tune-cathedral.test.ts'],
  'plan-tune-dream-cycle':       ['bin/gstack-distill-free-text', 'bin/gstack-distill-apply', 'hosts/claude/hooks/**', 'plan-tune/**', 'test/skill-e2e-plan-tune-cathedral.test.ts'],

  // Codex offering verification
  'codex-offered-office-hours':  ['office-hours/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],
  'codex-offered-ceo-review':    ['plan-ceo-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],
  'codex-offered-design-review': ['plan-design-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],
  'codex-offered-eng-review':    ['plan-eng-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts'],

  // Ship
  'ship-base-branch': ['ship/**', 'bin/gstack-repo-mode', 'test/skill-e2e-review-attribution.test.ts'],
  'ship-local-workflow': ['ship/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-workflow.test.ts'],
  'review-dashboard-via': ['ship/**', 'scripts/resolvers/review.ts', 'codex/**', 'autoplan/**', 'land-and-deploy/**', 'test/skill-e2e-review-attribution.test.ts'],

  // Retro
  'retro':             ['bin/gstack-retro-metrics', 'retro/**', 'test/skill-e2e-retro.test.ts'],
  'retro-base-branch': ['bin/gstack-retro-metrics', 'retro/**', 'test/skill-e2e-retro.test.ts'],

  // CSO
  'cso-full-audit':   ['cso/**', 'test/skill-e2e-cso.test.ts'],
  'cso-diff-mode':    ['cso/**', 'test/skill-e2e-cso.test.ts'],
  'cso-infra-scope':  ['cso/**', 'test/skill-e2e-cso.test.ts'],

  // Learnings
  'learnings-show': ['learn/**', 'bin/gstack-learnings-search', 'bin/gstack-learnings-log', 'scripts/resolvers/learnings.ts', 'test/skill-e2e-learnings.test.ts'],

  // Session Intelligence (timeline, context recovery, /context-save + /context-restore)
  'timeline-event-flow':            ['bin/gstack-timeline-log', 'bin/gstack-timeline-read', 'test/skill-e2e-session-intelligence.test.ts'],
  'context-recovery-artifacts':     ['scripts/resolvers/preamble.ts', 'bin/gstack-timeline-log', 'bin/gstack-slug', 'learn/**', 'test/skill-e2e-session-intelligence.test.ts'],
  'context-save-writes-file':       ['context-save/**', 'bin/gstack-slug', 'test/skill-e2e-session-intelligence.test.ts'],
  'context-restore-loads-latest':   ['context-restore/**', 'bin/gstack-slug', 'test/skill-e2e-session-intelligence.test.ts'],

  // Context skills E2E (live-fire, Skill-tool routing path) — see
  // test/skill-e2e-context-skills.test.ts. These are periodic-tier because
  // each one spawns claude -p and costs ~$0.20-$0.40. Collectively they
  // verify the thing the /checkpoint → /context-save rename was for.
  'context-save-routing':                  ['context-save/**', 'scripts/resolvers/preamble.ts', 'test/skill-e2e-context-skills.test.ts'],
  'context-save-then-restore-roundtrip':   ['context-save/**', 'context-restore/**', 'bin/gstack-slug', 'test/skill-e2e-context-skills.test.ts'],
  'context-restore-fragment-match':        ['context-restore/**', 'test/skill-e2e-context-skills.test.ts'],
  'context-restore-empty-state':           ['context-restore/**', 'test/skill-e2e-context-skills.test.ts'],
  'context-restore-list-delegates':        ['context-restore/**', 'test/skill-e2e-context-skills.test.ts'],
  'context-restore-legacy-compat':         ['context-restore/**', 'test/skill-e2e-context-skills.test.ts'],
  'context-save-list-current-branch':      ['context-save/**', 'test/skill-e2e-context-skills.test.ts'],
  'context-save-list-all-branches':        ['context-save/**', 'test/skill-e2e-context-skills.test.ts'],

  // Document-release
  'document-release': ['document-release/**', 'test/skill-e2e-workflow.test.ts'],

  // Codex (Claude E2E — tests /codex skill via Claude)
  'codex-review': ['codex/**', 'test/skill-e2e-workflow.test.ts'],

  // Codex E2E (tests skills via Codex CLI + worktree)
  'codex-discover-skill':  ['codex/**', 'scripts/gen-skill-docs.ts', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts', 'test/codex-e2e.test.ts'],
  'codex-review-findings': ['review/**', 'scripts/gen-skill-docs.ts', 'codex/**', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts', 'test/codex-e2e.test.ts'],

  // GPT-5.6 Sol scope-termination E2E (Codex CLI, full generated investigate skill)
  'codex-sol-scope-termination': ['model-overlays/gpt-5.6-sol.md', 'scripts/models.ts', 'scripts/resolvers/model-overlay.ts', 'scripts/resolvers/preamble/**', 'investigate/**', 'test/helpers/codex-session-runner.ts', 'test/codex-e2e-sol-scope.test.ts'],

  // Gemini E2E — smoke test only (Gemini gets lost in worktrees on complex tasks)
  'gemini-smoke':  ['scripts/gen-skill-docs.ts', 'test/helpers/gemini-session-runner.ts', 'lib/worktree.ts', 'test/gemini-e2e.test.ts'],


  // Coverage audit (shared fixture) + triage + gates
  'ship-coverage-audit': ['ship/**', 'test/fixtures/coverage-audit-fixture.ts', 'bin/gstack-repo-mode', 'test/skill-e2e-workflow.test.ts'],
  'review-coverage-audit': ['review/**', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-coverage-audit.test.ts'],
  'plan-eng-coverage-audit': ['plan-eng-review/**', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-coverage-audit.test.ts'],
  'ship-triage': ['ship/**', 'bin/gstack-repo-mode', 'test/skill-e2e-triage.test.ts'],
  'ship-docsync': ['ship/**', 'document-release/**', 'scripts/gen-skill-docs.ts', 'scripts/resolvers/sections.ts', 'test/skill-e2e-ship-docsync.test.ts'],
  // #2733 behavioral proof: the JSON contract survives a firing gate inside a
  // spawned-marked subagent. Deps name every behavior under test — the
  // session-kind override, the skill-start gates, both hooks + the shared
  // directive, and the AUQ prose rule — so changing any of them selects it.
  'docsync-spawned': [
    'document-release/**',
    'ship/sections/pr-body.md',
    'bin/gstack-session-kind',
    'bin/gstack-skill-start',
    'hosts/claude/hooks/question-preference-hook.ts',
    'hosts/claude/hooks/auq-error-fallback-hook.ts',
    'hosts/claude/hooks/spawned-directive.ts',
    'scripts/resolvers/preamble/generate-ask-user-format.ts',
    'test/skill-e2e-docsync-spawned.test.ts',
  ],

  // Design
  'design-consultation-core':       ['design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/helpers/llm-judge.ts', 'test/skill-e2e-design.test.ts'],
  'design-consultation-existing':   ['design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts'],
  'design-consultation-research':   ['design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts'],
  'design-consultation-preview':    ['design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts'],
  'plan-design-review-no-ui-scope': ['plan-design-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts'],
  'design-review-fix':              ['design-review/**', 'browse/src/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts'],

  // /diagram (diagram-render bundle consumers). Triplet = deterministic
  // functional (gate); authoring quality = LLM-judged benchmark (periodic).
  'diagram-triplet':            ['diagram/**', 'lib/diagram-render/**', 'browse/src/write-commands.ts', 'browse/src/read-commands.ts', 'test/skill-e2e-diagram.test.ts'],
  'diagram-authoring-quality':  ['diagram/**', 'lib/diagram-render/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-diagram.test.ts'],

  // gstack-upgrade
  'gstack-upgrade-happy-path': ['gstack-upgrade/**', 'test/skill-e2e-workflow.test.ts'],

  // Deploy skills
  'land-and-deploy-workflow':      ['land-and-deploy/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-deploy.test.ts'],
  'land-and-deploy-first-run':     ['land-and-deploy/**', 'scripts/gen-skill-docs.ts', 'bin/gstack-slug', 'test/skill-e2e-deploy.test.ts'],
  'land-and-deploy-review-gate':   ['land-and-deploy/**', 'bin/gstack-review-read', 'test/skill-e2e-deploy.test.ts'],
  'canary-workflow':               ['canary/**', 'browse/src/**', 'test/skill-e2e-deploy.test.ts'],
  'benchmark-workflow':            ['benchmark/**', 'browse/src/**', 'test/skill-e2e-deploy.test.ts'],
  'setup-deploy-workflow':         ['setup-deploy/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-deploy.test.ts'],


  // Autoplan
  'autoplan-dual-voice': ['autoplan/**', 'codex/**', 'bin/gstack-codex-probe', 'scripts/resolvers/review.ts', 'scripts/resolvers/design.ts', 'test/skill-e2e-autoplan-dual-voice.test.ts'],

  // Multi-provider benchmark adapters — live API smoke against real claude/codex/gemini CLIs
  'benchmark-providers-live': ['bin/gstack-model-benchmark', 'test/helpers/providers/**', 'test/helpers/benchmark-runner.ts', 'test/helpers/pricing.ts', 'test/skill-e2e-benchmark-providers.test.ts'],

  // Browser-skills Phase 2a — /scrape + /skillify (v1.19.0.0). Gate-tier
  // E2E covers the D1 (provenance guard), D3 (atomic write) contracts plus
  // the basic loop. Shared deps: both skill templates, the D3 helper, the
  // Phase 1 runtime, and the bundled hackernews-frontpage reference (the
  // match-path test relies on it).
  'scrape-match-path': [
    'scrape/**', 'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
    'browser-skills/hackernews-frontpage/**',
    'test/skill-e2e-skillify.test.ts',
  ],
  'scrape-prototype-path': [
    'scrape/**', 'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
    'test/skill-e2e-skillify.test.ts',
  ],
  'skillify-happy-path': [
    'skillify/**', 'scrape/**', 'browse/src/browser-skill-write.ts',
    'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
    'test/skill-e2e-skillify.test.ts',
  ],
  'skillify-provenance-refusal': [
    'skillify/**', 'browse/src/browser-skill-write.ts',
    'test/skill-e2e-skillify.test.ts',
  ],
  'skillify-approval-reject': [
    'skillify/**', 'scrape/**', 'browse/src/browser-skill-write.ts',
    'test/skill-e2e-skillify.test.ts',
  ],

  // Skill routing — journey-stage tests (depend on ALL skill descriptions)
  'journey-ideation':       ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-plan-eng':       ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-debug':          ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-qa':             ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-code-review':    ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-ship':           ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-docs':           ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-retro':          ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-design-system':  ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],
  'journey-visual-qa':      ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts'],

  // Opus 4.7 behavior evals — keys match testName: values in the test file.
  // Routing sub-tests use template literal `routing-${c.name}` testNames,
  // which the touchfile completeness scanner skips; they inherit selection
  // from the file-level touchfile entry via GLOBAL_TOUCHFILES.
  'fanout-arm-overlay-on':
    ['model-overlays/claude.md', 'model-overlays/opus-4-7.md', 'scripts/models.ts', 'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-opus-47.test.ts'],
  'fanout-arm-overlay-off':
    ['model-overlays/claude.md', 'model-overlays/opus-4-7.md', 'scripts/models.ts', 'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-opus-47.test.ts'],

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
    'test/skill-e2e-overlay-harness.test.ts',
  ],
  'overlay-harness-opus-4-7-fanout-realistic': [
    'model-overlays/**',
    'test/fixtures/overlay-nudges.ts',
    'test/helpers/agent-sdk-runner.ts',
    'scripts/resolvers/model-overlay.ts',
    'test/skill-e2e-overlay-harness.test.ts',
  ],

  // /ios-qa — agent flow E2E. Daemon + stub StateServer + codegen
  // exercised end-to-end. The no-device path is gate-tier; the with-device
  // path requires GSTACK_HAS_IOS_DEVICE=1 and is periodic-tier.
  'ios-qa-e2e':       ['ios-qa/**', 'ios-fix/**', 'ios-design-review/**', 'ios-clean/**', 'ios-sync/**', 'test/skill-e2e-ios.test.ts'],
  // Swift-build invariant test — requires the Swift toolchain. Compiles the
  // fixture SPM package + runs the XCTest suite that validates the real
  // Swift StateServer implementation (loopback bind, boot token rotation,
  // session lock). Periodic-tier — Swift build is heavier than TS unit tests.
  'ios-qa-swift-build': ['ios-qa/templates/**', 'test/fixtures/ios-qa/FixtureApp/**', 'test/skill-e2e-ios-swift-build.test.ts'],
  // Real-device path — only runs with GSTACK_HAS_IOS_DEVICE=1 + a paired
  // iPhone. Validates the CoreDevice agent + iOS SDK toolchain. Periodic-tier.
  'ios-qa-device':    ['ios-qa/templates/**', 'test/fixtures/ios-qa/FixtureApp/**', 'test/skill-e2e-ios-device.test.ts'],

  // /spec end-to-end via PTY — exercises the full Phase 1→5 pipeline
  // including --execute spawn. Periodic-tier — paid + non-deterministic.
  'spec-execute':     ['spec/**', 'test/skill-e2e-spec-execute.test.ts'],

  // /office-hours brain-writeback path under fake gbrain CLI (v1.50.0.0
  // T7). Drives /office-hours with a regenerated SKILL.md that has the
  // compressed GBRAIN_SAVE_RESULTS block + a fake gbrain on PATH; asserts
  // the agent calls `gbrain put office-hours/<slug>` with valid YAML
  // frontmatter. Touched by anything that changes resolver output, gen
  // pipeline, detection helper, refresh subcommand, or the on-demand
  // docs the resolver points to.
  'office-hours-brain-writeback': ['office-hours/sections/**', 
    'scripts/resolvers/gbrain.ts',
    'scripts/gen-skill-docs.ts',
    'bin/gstack-gbrain-detect',
    'bin/gstack-config',
    'office-hours/SKILL.md.tmpl',
    'docs/gbrain-write-surfaces.md',
    'test/fixtures/office-hours-brain-writeback/**',
    'test/skill-e2e-office-hours-brain-writeback.test.ts',
  ],

  // gbrain CLI real round-trip against a local PGLite store (v1.50.0.0
  // T11). Proves the gbrain CLI persistence contract gstack relies on —
  // a `gbrain put` followed by `gbrain get` returns the body. Skips if
  // VOYAGE_API_KEY is unset OR gbrain CLI not on PATH. Touched by the
  // resolver (which emits the CLI shape) and the test itself.
  'gbrain-roundtrip-local': [
    'scripts/resolvers/gbrain.ts',
    'test/skill-e2e-gbrain-roundtrip-local.test.ts',
  ],

  // WS2 arm benchmark — with-skill vs without-skill agentic arms scored on
  // the git diff left behind (research instrument, never a release gate).
  // Fires when the behavioral layer under test (reuse ladder + bounded
  // closer resolvers), the judge, the fixtures, or the harness change.
  'arm-benchmark-native-overbuild': [
    'scripts/resolvers/preamble/generate-search-before-building.ts',
    'scripts/resolvers/preamble/generate-voice-directive.ts',
    'test/fixtures/arm-benchmark/**',
    'test/helpers/llm-judge.ts',
    'test/helpers/arm-benchmark-harness.ts',
    'test/skill-e2e-arm-benchmark.test.ts',
    'ship/SKILL.md',
  ],
  'arm-benchmark-crud-endpoint': [
    'scripts/resolvers/preamble/generate-search-before-building.ts',
    'scripts/resolvers/preamble/generate-voice-directive.ts',
    'test/fixtures/arm-benchmark/**',
    'test/helpers/llm-judge.ts',
    'test/helpers/arm-benchmark-harness.ts',
    'test/skill-e2e-arm-benchmark.test.ts',
    'ship/SKILL.md',
  ],
  'arm-benchmark-bugfix-decoys': [
    'scripts/resolvers/preamble/generate-search-before-building.ts',
    'scripts/resolvers/preamble/generate-voice-directive.ts',
    'test/fixtures/arm-benchmark/**',
    'test/helpers/llm-judge.ts',
    'test/helpers/arm-benchmark-harness.ts',
    'test/skill-e2e-arm-benchmark.test.ts',
    'ship/SKILL.md',
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

  // Hermetic isolation — gate (deterministic env/config assertions; if the
  // clean room breaks, every other eval's signal is contaminated)
  'hermetic-canary': 'gate',
  'hermetic-sentinel': 'gate',

  // SKILL.md setup — gate (if setup breaks, no skill works)
  'skillmd-setup-discovery': 'gate',
  'skillmd-no-local-binary': 'gate',
  'skillmd-outside-git': 'gate',
  'session-awareness': 'gate',
  'operational-learning': 'gate',

  // P4 first-run scaffold — periodic (onboarding, non-safety, model-touched marker)
  'first-task-scaffold': 'periodic',

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
  'review-dashboard-via': 'gate',

  // Review Army — gate for core functionality, periodic for multi-specialist
  'review-army-migration-safety': 'gate',   // Specialist activation guardrail
  'review-army-perf-n-plus-one': 'gate',    // Specialist activation guardrail
  'review-army-delivery-audit': 'gate',     // Delivery integrity guardrail
  'review-army-quality-score': 'gate',      // Score computation
  'review-army-json-findings': 'gate',      // JSON schema compliance
  'review-army-red-team': 'periodic',       // Multi-agent coordination
  'review-army-consensus': 'periodic',      // Multi-specialist agreement
  'review-army-simplification': 'periodic', // Advisory lens quality benchmark
  'review-army-simplification-precision': 'periodic', // False-flag noise benchmark

  // Office Hours
  'office-hours-spec-review': 'gate',
  // Brain-writeback E2E — periodic per cost (claude -p) + non-deterministic
  // (model interprets the gbrain instruction). Matches nearby
  // setup-gbrain-path4-* tier classification.
  'office-hours-brain-writeback': 'periodic',
  // GBrain CLI round-trip — periodic per Voyage embedding cost (~$0.001/run)
  // and external-API-dependency (skips cleanly if VOYAGE_API_KEY unset).
  'gbrain-roundtrip-local': 'periodic',
  'office-hours-forcing-energy': 'periodic',   // D2a demotion 2026-08: posture score, periodic-grade signal (sibling precedent at office-hours-tone)
  // 'office-hours-builder-wildness' retiered to periodic in v1.32 contributor
  // wave: this is an LLM-judge creativity score (axis_a ≥4 on a "wildness"
  // posture). Per CLAUDE.md tier-classification rules, non-deterministic
  // quality benchmarks belong in periodic, not gate. The wave's +21-line
  // CJK preamble cascade (#1205) pushed the score from 5/5 → 3/3 on the
  // same /office-hours BUILDER prompt — same model, same fixture — proving
  // the bar is sensitive to preamble-byte changes that have nothing to do
  // with the test's intent (creativity, not preamble compliance).
  'office-hours-builder-wildness': 'periodic',

  // Plan reviews — gate for cheap functional, periodic for Opus quality
  'plan-ceo-review': 'periodic',
  'plan-ceo-review-selective': 'periodic',
  'plan-ceo-review-benefits': 'gate',
  'plan-ceo-review-expansion-energy': 'periodic',  // Demoted from gate (2026-08 audit): Opus generator + subjective 2-axis >=4/5 LLM-judge threshold in the merge lane — the exact class siblings were demoted for (a +21-line preamble change once flipped the score). CLAUDE.md's own rule: Opus model test -> periodic.
  'plan-eng-review': 'periodic',
  'plan-eng-review-artifact': 'periodic',
  'plan-eng-coverage-audit': 'gate',
  'plan-review-report': 'gate',

  // Plan-mode handshake. plan-ceo/plan-devex ask-first reliably (gate-tier);
  // plan-eng/plan-design run a long explore/audit before their first
  // AskUserQuestion, so whether they reach a terminal outcome within the 300s
  // budget hinges on stochastic ask-first compliance (~50-67%/run measured).
  // Per the "non-deterministic -> periodic" tiering rule they are periodic:
  // the hardened ask-first gate + the collapsed-form detector lifted them from
  // always-failing to mostly-passing, but they are not deterministic gates.
  'plan-ceo-review-plan-mode': 'gate',
  'plan-eng-review-plan-mode': 'periodic',
  'plan-design-review-plan-mode': 'periodic',
  'plan-devex-review-plan-mode': 'gate',
  'plan-mode-no-op': 'gate',
  // v1.21+ auto-mode regression tests
  'office-hours-auto-mode': 'gate',
  'auto-decide-preserved': 'periodic',
  'conductor-prose': 'periodic',

  // Real-PTY E2E batch — tier classification:
  //   gate: cheap, deterministic, run on every PR
  //   periodic: long-running or expensive (>$3/run), run weekly
  'auq-format-gate':                         'gate',       // ~$0.50/run, SDK capture, single skill probe
  'plan-ceo-mode-routing':     'periodic',   // ~$3/run, deep navigation through 8-12 prior AskUserQuestions
  'plan-design-with-ui-scope': 'gate',       // ~$0.80/run
  'ship-idempotency-pty':      'periodic',   // ~$3/run, real /ship in plan mode
  'tpa-present':               'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-absent-linux':          'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-broken':                'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-absent-darwin':         'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-apple-ban':             'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts

  'ship-section-loading':      'periodic',   // ~$3/run, real /ship; asserts section reads
  'plan-ceo-section-loading':  'periodic',   // ~$3-5/run, real /plan-ceo-review; asserts section read
  'carve-section-loading':     'periodic',   // ~$1-2/skill, data-driven; GSTACK_CARVE_SKILL scopes to one
  'autoplan-chain-pty':        'periodic',   // ~$8/run, all 3 phases sequential

  // Per-finding count + review-report-at-bottom — periodic because each
  // run drives a full skill end-to-end (~25 min, ~$5/run). Sequential
  // execution during calibration; concurrent opt-in only after measured
  // comparison agrees (plan §D15).
  'plan-ceo-finding-count':    'periodic',
  'plan-eng-finding-count':    'periodic',
  'plan-design-finding-count': 'periodic',
  'plan-devex-finding-count':  'periodic',
  'plan-eng-finding-floor':    'periodic',  // stochastic ask-first (see plan-mode-handshake note); periodic
  'plan-ceo-finding-floor':    'gate',
  'plan-design-finding-floor': 'periodic',  // stochastic ask-first (see plan-mode-handshake note); periodic
  'plan-devex-finding-floor':  'gate',
  'plan-eng-multi-finding-batching': 'periodic',
  'plan-ceo-split-overflow': 'periodic',

  // Privacy gate for gstack-brain-sync — periodic (non-deterministic LLM call,
  // costs ~$0.30-$0.50 per run, not needed on every commit)
  'brain-privacy-gate': 'periodic',

  // /setup-gbrain Path 4 (Remote MCP) — periodic-tier. The stub HTTP
  // server is deterministic but the model's interpretation of "follow
  // Path 4 only" is not — assertions on which steps the model ran are
  // flaky. The deterministic gate-tier coverage for Path 4 lives in
  // test/setup-gbrain-path4-structure.test.ts (free, <200ms). These
  // E2E tests stay available for on-demand verification of the live
  // model's behavior against a stub MCP server.
  'setup-gbrain-remote': 'periodic',
  'setup-gbrain-bad-token': 'periodic',
  'setup-gbrain-path4-local-pglite': 'periodic',

  // AskUserQuestion format regression — periodic (Opus 4.7 non-deterministic benchmark)
  'plan-ceo-review-format-mode': 'periodic',
  'plan-ceo-review-format-approach': 'periodic',
  'plan-eng-review-format-coverage': 'periodic',
  'plan-eng-review-format-kind': 'periodic',

  // Office-hours Phase 4 silent-auto-decide regression — periodic (Phase 4
  // requires the agent to invent 2-3 architectures, more open-ended than the
  // 4 plan-format cases above). Reclassify to gate if it turns out stable.
  'office-hours-phase4-fork': 'periodic',
  // judgeRecommendation rubric sanity (fixture-based, ~$0.04/run via Haiku)
  'llm-judge-recommendation': 'periodic',

  // v1.7.0.0 Pros/Cons format — cadence + negative-escape evals (all periodic)
  'plan-ceo-review-prosons-cadence': 'periodic',
  'plan-review-prosons-format': 'periodic',
  'plan-review-prosons-hardstop-neg': 'periodic',
  'plan-review-prosons-neutral-neg': 'periodic',

  // CT3 expanded coverage — non-plan-review skills inheriting Pros/Cons (all periodic)

  // /plan-tune — gate (core v1 DX promise: plain-English intent routing)
  'plan-tune-inspect': 'gate',

  // /plan-tune cathedral (T16 per D12 — all gate)
  'plan-tune-hook-capture': 'gate',
  'plan-tune-enforcement': 'gate',
  'plan-tune-annotation': 'gate',
  'plan-tune-codex-import': 'gate',
  'plan-tune-dream-cycle': 'gate',

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
  'ship-docsync': 'gate',
  'docsync-spawned': 'gate',   // #2733 JSON-contract-through-a-firing-gate proof (deterministic safety)
  // (merge note: main's side also re-added ship-plan-completion /
  // ship-plan-verification here — phantom keys with no declaring test,
  // deleted by the census-integrity commit; the reverse invariant in
  // test/touchfiles.test.ts now fails the suite if they come back.)

  // Retro — gate for cheap branch detection, periodic for full Opus retro
  'retro': 'periodic',
  'retro-base-branch': 'gate',

  // CSO — gate for security guardrails, periodic for quality
  'cso-full-audit': 'periodic',  // D2a demotion 2026-08: 250s/$0.57 full audit; cso targeted tests stay gate
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
  'codex-sol-scope-termination': 'periodic',
  'gemini-smoke': 'periodic',

  // Design — gate for cheap functional, periodic for Opus/quality
  'design-consultation-core': 'periodic',
  'design-consultation-existing': 'periodic',
  'design-consultation-research': 'periodic',  // D2a demotion 2026-08: the two most expensive gate tests ($0.91/304s)
  'design-consultation-preview': 'periodic',   // D2a demotion 2026-08 ($0.89/481s)
  'plan-design-review-no-ui-scope': 'gate',
  'design-review-fix': 'periodic',

  // /diagram — triplet is deterministic functional, judge is a quality benchmark
  'diagram-triplet': 'gate',
  'diagram-authoring-quality': 'periodic',

  // gstack-upgrade
  'gstack-upgrade-happy-path': 'gate',

  // Deploy skills
  'land-and-deploy-workflow': 'gate',
  'land-and-deploy-first-run': 'gate',
  'land-and-deploy-review-gate': 'gate',
  'canary-workflow': 'gate',
  'benchmark-workflow': 'gate',
  'setup-deploy-workflow': 'gate',


  // Autoplan — periodic (not yet implemented)
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

  // /ios-qa daemon + codegen. Demoted gate -> periodic (2026-08 audit): the
  // gate declaration was never executable in CI — the file sits in
  // PERIODIC_CI_EXCLUDE ("not a CI runner capability"), but that exclusion
  // only applies at tier=periodic, so the gate lane planned a HOLLOW shard
  // on every Linux PR. Periodic keeps it in the weekly census on capable
  // hosts; re-promote if a macOS runner lands (flagged decision in the
  // test-infra overhaul plan).
  'ios-qa-e2e': 'periodic',
  // Swift toolchain only, no device required, but heavier than TS unit tests.
  'ios-qa-swift-build': 'periodic',
  // Requires a real connected + paired iPhone. Manual-trigger only.
  'ios-qa-device': 'periodic',
  // /spec end-to-end PTY pipeline (paid, non-deterministic — periodic-tier).
  'spec-execute': 'periodic',

  // WS2 arm benchmark — periodic: full build-shaped agentic workflows, paid,
  // non-deterministic by construction (research instrument, not a gate).
  'arm-benchmark-native-overbuild': 'periodic',
  'arm-benchmark-crud-endpoint': 'periodic',
  'arm-benchmark-bugfix-decoys': 'periodic',
};

/**
 * LLM-judge test touchfiles — keyed by test description string.
 */
export const LLM_JUDGE_TOUCHFILES: Record<string, string[]> = {
  'command reference table':          ['browse/sections/**', 'SKILL.md', 'SKILL.md.tmpl', 'browse/src/commands.ts', 'test/skill-llm-eval.test.ts'],
  'snapshot flags reference':         ['browse/sections/**', 'SKILL.md', 'SKILL.md.tmpl', 'browse/src/snapshot.ts', 'test/skill-llm-eval.test.ts'],
  'browse/SKILL.md reference':        ['browse/sections/**', 'browse/SKILL.md', 'browse/SKILL.md.tmpl', 'browse/src/**', 'test/skill-llm-eval.test.ts'],
  'setup block':                      ['SKILL.md', 'SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'regression vs baseline':           ['browse/sections/**', 'SKILL.md', 'SKILL.md.tmpl', 'browse/src/commands.ts', 'test/fixtures/eval-baselines.json', 'test/skill-llm-eval.test.ts'],
  'qa/SKILL.md workflow':             ['qa/sections/**', 'qa/SKILL.md', 'qa/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'qa/SKILL.md health rubric':        ['qa/sections/**', 'qa/SKILL.md', 'qa/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'qa/SKILL.md anti-refusal':         ['qa/sections/**', 'qa/SKILL.md', 'qa/SKILL.md.tmpl', 'qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'cross-skill greptile consistency': ['review/SKILL.md', 'review/SKILL.md.tmpl', 'ship/SKILL.md', 'ship/SKILL.md.tmpl', 'review/greptile-triage.md', 'retro/SKILL.md', 'retro/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'baseline score pinning':           ['browse/sections/**', 'SKILL.md', 'SKILL.md.tmpl', 'test/fixtures/eval-baselines.json', 'test/skill-llm-eval.test.ts'],

  // Ship & Release
  'ship/SKILL.md workflow':               ['ship/SKILL.md', 'ship/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'document-release/SKILL.md workflow':   ['document-release/SKILL.md', 'document-release/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],

  // Plan Reviews
  'plan-ceo-review/SKILL.md modes':       ['plan-ceo-review/SKILL.md', 'plan-ceo-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'plan-eng-review/SKILL.md sections':    ['plan-eng-review/SKILL.md', 'plan-eng-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],

  // /spec authored-spec quality (paid LLM-judge — periodic-tier).
  'plan-design-review/SKILL.md passes':   ['plan-design-review/SKILL.md', 'plan-design-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],

  // Design skills
  'design-review/SKILL.md fix loop':      ['design-review/SKILL.md', 'design-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'design-consultation/SKILL.md research': ['design-consultation/SKILL.md', 'design-consultation/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],

  // Deploy skills
  'land-and-deploy/SKILL.md workflow':    ['land-and-deploy/SKILL.md', 'land-and-deploy/SKILL.md.tmpl', 'land-and-deploy/sections/**', 'test/skill-llm-eval.test.ts'],
  'canary/SKILL.md monitoring loop':      ['canary/SKILL.md', 'canary/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'benchmark/SKILL.md perf collection':   ['benchmark/SKILL.md', 'benchmark/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'setup-deploy/SKILL.md platform setup': ['setup-deploy/SKILL.md', 'setup-deploy/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],

  // Other skills
  'retro/SKILL.md instructions':          ['retro/sections/**', 'retro/SKILL.md', 'retro/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'qa-only/SKILL.md workflow':            ['qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],
  'gstack-upgrade/SKILL.md upgrade flow': ['gstack-upgrade/SKILL.md', 'gstack-upgrade/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts'],

  // Voice directive
  'voice directive tone':                 ['scripts/resolvers/preamble.ts', 'review/SKILL.md', 'review/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-llm-eval.test.ts'],
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
  'test/helpers/hermetic-env.ts',    // Changes every E2E child's environment
  'test/helpers/eval-store.ts',      // All E2E tests store results here
  'test/helpers/test-selection.ts',  // Selection logic itself — a bug here mis-selects every test
  'test/helpers/touchfiles.ts',      // The facade is executable selection-path code; an edit must run everything (it should never change, so the cost is ~zero)
  'test/helpers/e2e-helpers.ts',     // Shared harness every paid test imports (selection wiring, preflight, describeIfSelected) — an edit here changes every test's behavior
  'test/helpers/paid-test-set.ts',   // Paid-vs-free classification — an edit moves files between suites
  'test/helpers/skill-fixture.ts',   // SKILL.md fixture extraction — reshapes the skill content most E2E suites read
  // NOTE: this file (touchfiles-data.ts) is deliberately NOT a global
  // touchfile. Changes to it route through map-diff selection in
  // test-selection.ts: the old git version is evaluated and the maps are
  // diffed per key, so a data-only edit runs just the affected tests.
  // Map-diff fails CLOSED — any error on that path still runs everything.
];
