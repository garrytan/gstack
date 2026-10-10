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
  'ship-skipped-queued-finding': [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts', 'bin/gstack-codex-probe','bin/gstack-state-root.sh', 'lib/state-root.ts', 'package.json', 'bun.lock', '.github/docker/Dockerfile.ci',
    'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/index.ts',
    'scripts/resolvers/types.ts', 'scripts/gen-skill-docs.ts', 'scripts/host-config.ts',
    'scripts/discover-skills.ts', 'hosts/claude.ts', 'hosts/index.ts', 'hosts/define-host.ts',
    'ship/sections/review-army.md*', 'ship/sections/adversarial.md*', 'ship/sections/manifest.json',
    'review/checklist.md', 'bin/gstack-review-log', 'bin/gstack-review-read', 'bin/gstack-wtree',
    'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-config', 'bin/gstack-brain-enqueue',
    'lib/review-evidence.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts',
    'test/helpers/ship-skip-actor.ts',  
    'test/helpers/scratch-repo.ts',
    'test/skill-e2e-ship-skip.test.ts', 'test/helpers/shared-libs-eval-fixture.ts',
    'test/helpers/agent-sdk-runner.ts', 'test/helpers/hermetic-env.ts',
    'test/helpers/e2e-gate.ts', 'test/helpers/eval-budgets.ts'
  ],
  'investigate-owned-completion': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'investigate/**', 'freeze/**', 'guard/**', 'unfreeze/**', 'careful/bin/hook-extract.sh', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/workflow-boundaries-fixture.ts',  'test/skill-e2e-investigate-owned-completion.test.ts', 'test/helpers/e2e-gate.ts'],
  'investigate-owned-abort': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'investigate/**', 'freeze/**', 'guard/**', 'unfreeze/**', 'careful/bin/hook-extract.sh', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/workflow-boundaries-fixture.ts',  'test/skill-e2e-investigate-owned-termination.test.ts', 'test/helpers/e2e-gate.ts'],
  'investigate-owned-ending-error': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'investigate/**', 'freeze/**', 'guard/**', 'unfreeze/**', 'careful/bin/hook-extract.sh', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/workflow-boundaries-fixture.ts',  'test/skill-e2e-investigate-owned-termination.test.ts', 'test/helpers/e2e-gate.ts'],
  'shared-libs-review-path-eligibility': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'review/**', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'lib/review-evidence.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'bin/gstack-wtree', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs-paths.test.ts', 'test/helpers/shared-libs-path-fixture.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-index-flags-*.json',   'test/fixtures/shared-libs-resolved-reads-public.json', 'test/helpers/shared-libs-review-start-evidence.ts'],
  'shared-libs-review-index-flags': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'review/**', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'lib/review-evidence.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'bin/gstack-wtree', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs-paths.test.ts', 'test/helpers/shared-libs-path-fixture.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-index-flags-*.json',  'test/fixtures/shared-libs-paths-max-turns-public.json',  'test/fixtures/shared-libs-resolved-reads-public.json', 'test/helpers/shared-libs-review-start-evidence.ts'],
  'shared-libs-review-prior-coverage': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'review/**', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'lib/review-evidence.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'bin/gstack-wtree', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs-paths.test.ts', 'test/helpers/shared-libs-path-fixture.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-index-flags-*.json',   'test/fixtures/shared-libs-resolved-reads-public.json', 'test/helpers/shared-libs-review-start-evidence.ts'],
  'shared-libs-codex-read-only': [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts','deslop-shared-libs/**', 'bin/gstack-safe-git', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/shared-libs-eval-fixture.ts', 'test/helpers/codex-session-runner.ts', 'test/helpers/skill-fixture.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/eval-budgets.ts', 'test/codex-e2e-shared-libs.test.ts',  'test/helpers/e2e-gate.ts', 'hosts/codex.ts', 'hosts/define-host.ts', 'scripts/resolvers/constants.ts', 'test/fixtures/shared-libs-readonly-substitution-ci16358.json', 'test/helpers/agent-sdk-runner.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/outside-voice-steps.ts'],
  // Shared-code audit and scoped review lifecycle
  'shared-libs-read-only': ['deslop-shared-libs/**', 'bin/gstack-safe-git', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs.test.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-readonly-substitution-ci16358.json', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/shared-libs-review-start-evidence.ts', 'test/helpers/shared-libs-path-fixture.ts'],
  'shared-libs-unsupported-git': ['deslop-shared-libs/**', 'bin/gstack-safe-git', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs.test.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-readonly-substitution-ci16358.json', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/shared-libs-review-start-evidence.ts', 'test/helpers/shared-libs-path-fixture.ts'],
  'shared-libs-review-lifecycle': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'deslop-shared-libs/**', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'review/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'lib/review-evidence.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'bin/gstack-wtree', 'test/skill-e2e-shared-libs.test.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-index-flags-*.json', 'test/helpers/shared-libs-path-fixture.ts',  'test/fixtures/shared-libs-lifecycle-r59-stage-scope-public.json',  'test/helpers/shared-libs-review-start-evidence.ts'],
  'shared-libs-review-revalidation': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'deslop-shared-libs/**', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'review/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'lib/review-evidence.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'bin/gstack-wtree', 'test/skill-e2e-shared-libs.test.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/helpers/shared-libs-review-start-evidence.ts',  'test/fixtures/shared-libs-review-start-public.json',  'test/fixtures/shared-libs-revalidation-max-turns-public.json', 'test/fixtures/shared-libs-index-flags-*.json',  'test/helpers/shared-libs-path-fixture.ts' ],
  'shared-libs-opportunity-judgment': ['deslop-shared-libs/**', 'bin/gstack-safe-git', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs-periodic.test.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/llm-judge.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-readonly-substitution-ci16358.json', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/shared-libs-plan-actor.ts', 'test/helpers/shared-libs-plan-excerpt.ts'],
  'shared-libs-pr-coverage': ['deslop-shared-libs/**', 'bin/gstack-safe-git', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'test/skill-e2e-shared-libs-periodic.test.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/llm-judge.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts', 'test/fixtures/shared-libs-readonly-substitution-ci16358.json', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/shared-libs-plan-actor.ts', 'test/helpers/shared-libs-plan-excerpt.ts'],
  'shared-libs-plan-callers': ['test/helpers/shared-libs-plan-actor.ts',  'scripts/resolvers/confidence.ts', 'test/helpers/shared-libs-plan-excerpt.ts',  'scripts/resolvers/preamble/generate-ask-user-format.ts', 'deslop-shared-libs/**', 'scripts/resolvers/shared-libs.ts', 'scripts/resolvers/index.ts', 'test/helpers/shared-libs-eval-fixture.ts',  'plan-eng-review/**', 'test/skill-e2e-shared-libs-periodic.test.ts',   'test/fixtures/plan-scope-recovery-av.json',  'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts',  'test/helpers/e2e-gate.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/llm-judge.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts'],
  'ship-docsync-missing-marker': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-missing-asset': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-launch-failure': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-timeout-unsettled': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-late-result': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-stale-before': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-stale-after': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-recovery': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'test/helpers/docsync-*.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'bin/gstack-context-recovery'],
  'review-exploratory-small-cli': ['bin/gstack-qa-evidence', 'lib/qa-evidence.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',    'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',   'review/**', 'ship/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-callers-fixture.ts', 'test/helpers/qa-functional-observer.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/qa-functional-fixture.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/session-runner.ts',  'test/skill-e2e-qa-callers.test.ts', 'scripts/resolvers/testing.ts', 'test/helpers/skill-census.ts'],
  'ship-exploratory-small-cli': ['bin/gstack-qa-evidence', 'lib/qa-evidence.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',    'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',   'review/**', 'ship/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-callers-fixture.ts', 'test/helpers/qa-functional-observer.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/qa-functional-fixture.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/session-runner.ts',  'test/skill-e2e-qa-callers.test.ts', 'scripts/resolvers/testing.ts', 'test/helpers/skill-census.ts'],
  'ship-exploratory-unavailable': ['bin/gstack-qa-evidence', 'lib/qa-evidence.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',    'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',   'review/**', 'ship/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-callers-fixture.ts', 'test/helpers/qa-functional-observer.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/qa-functional-fixture.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/session-runner.ts',  'test/skill-e2e-qa-callers.test.ts', 'scripts/resolvers/testing.ts', 'test/helpers/skill-census.ts'],
  'ship-exploratory-plan-checks': ['bin/gstack-qa-evidence', 'lib/qa-evidence.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',    'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',   'review/**', 'ship/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-callers-fixture.ts', 'test/helpers/qa-functional-observer.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/qa-functional-fixture.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/session-runner.ts',  'test/skill-e2e-qa-callers.test.ts', 'scripts/resolvers/testing.ts', 'test/helpers/skill-census.ts'],
  'ship-exploratory-late-input': ['bin/gstack-qa-evidence', 'lib/qa-evidence.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',    'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',   'review/**', 'ship/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-callers-fixture.ts', 'test/helpers/qa-functional-observer.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/qa-functional-fixture.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/session-runner.ts',  'test/skill-e2e-qa-callers.test.ts', 'scripts/resolvers/testing.ts', 'test/helpers/skill-census.ts'],
  'qa-functional-cli-report': ['bin/gstack-qa-evidence', 'bin/gstack-qa-deadline', 'lib/qa-evidence.ts', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',      'qa/**', 'qa-only/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/fixtures/qa-functional-cli-learning-ci-36516246523.json', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/skill-fixture.ts', 'test/skill-e2e-qa-functional.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'qa-functional-webhook-report': ['bin/gstack-qa-evidence', 'bin/gstack-qa-deadline', 'lib/qa-evidence.ts', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',      'qa/**', 'qa-only/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/fixtures/qa-webhook-r85-checkpoints.json', 'test/fixtures/qa-functional-ci-36505065023.json', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/skill-fixture.ts', 'test/skill-e2e-qa-functional.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'qa-functional-cli-fix': ['bin/gstack-qa-evidence', 'bin/gstack-qa-deadline', 'lib/qa-evidence.ts', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',      'qa/**', 'qa-only/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/skill-fixture.ts', 'test/skill-e2e-qa-functional-fix.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'qa-functional-webhook-fix': ['bin/gstack-qa-evidence', 'bin/gstack-qa-deadline', 'lib/qa-evidence.ts', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts', 'lib/fs-atomic.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-evidence.ts',      'qa/**', 'qa-only/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/qa-functional-*.ts', 'test/helpers/qa-checkpoint-evidence.ts',  'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/skill-fixture.ts', 'test/skill-e2e-qa-functional-fix.test.ts', 'test/helpers/office-hours-attempt.ts'],
  // Browse core (+ test-server dependency)
  'browse-basic':    ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-bws.test.ts'],
  'browse-snapshot': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-bws.test.ts'],

  // Aside-driven browsing skills — live E2E against the Aside AI browser, the
  // primary browser (test/skill-e2e-aside.test.ts self-skips without a running Aside)
  'aside-browse-basic':  ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'browse/**', 'scripts/resolvers/browse.ts', 'scripts/resolvers/aside.ts', 'browse/test/test-server.ts', 'browse/test/fixtures/basic.html', 'test/helpers/aside-available.ts', 'test/skill-e2e-aside.test.ts', 'test/helpers/e2e-gate.ts'],
  'aside-browse-flow':   ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'browse/**', 'scripts/resolvers/browse.ts', 'scripts/resolvers/aside.ts', 'browse/test/test-server.ts', 'browse/test/fixtures/forms.html', 'test/helpers/aside-available.ts', 'test/skill-e2e-aside.test.ts', 'test/helpers/e2e-gate.ts'],
  'aside-qa-quick': [ 'qa/**', 'scripts/resolvers/browse.ts', 'scripts/resolvers/aside.ts', 'browse/test/test-server.ts', 'browse/test/fixtures/basic.html', 'test/helpers/aside-available.ts', 'test/skill-e2e-aside.test.ts', 'test/helpers/e2e-gate.ts'],
  'aside-scrape-json':   [ 'scrape/**', 'scripts/resolvers/aside.ts', 'browse/test/test-server.ts', 'browse/test/fixtures/basic.html', 'test/helpers/aside-available.ts', 'test/skill-e2e-aside.test.ts', 'test/helpers/e2e-gate.ts'],
  'aside-canary-quick':  [ 'canary/**', 'scripts/resolvers/aside.ts', 'browse/test/test-server.ts', 'browse/test/fixtures/basic.html', 'test/helpers/aside-available.ts', 'test/skill-e2e-aside.test.ts', 'test/helpers/e2e-gate.ts'],

  // Hermetic isolation canaries (hermetic-env.ts is also a GLOBAL touchfile;
  // these entries exist so the canaries themselves stay tier-classified)
  'hermetic-canary':   [ 'test/helpers/hermetic-env.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-hermetic-canary.test.ts', 'lib/conductor-env-shim.ts'],
  'hermetic-sentinel': [ 'test/helpers/hermetic-env.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-hermetic-canary.test.ts', 'lib/conductor-env-shim.ts'],
  // Real pinned-claude journals (SessionStart hook, /compact, --fork-session) through the /autoplan guard's reader.
  'autoplan-journal-drift': ['lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts', 'lib/claude-bin.ts', '.github/docker/Dockerfile.ci', 'test/skill-e2e-autoplan-journal-drift.test.ts'],
  // Live PTY phase boundary on the pinned Claude Code through /autoplan's own hook block (ENG-18).
  'autoplan-guard-pty': ['autoplan/bin/phase-publication-hook.ts', 'autoplan/bin/owned-read.ts', 'autoplan/bin/phase-publication-hook', 'autoplan/bin/guard-reasons.ts', 'autoplan/bin/guard-log.ts', 'autoplan/SKILL.md', 'autoplan/SKILL.md.tmpl', 'scripts/resolvers/composition.ts', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts', 'autoplan/bin/guard-journal.ts', 'lib/autoplan-phase-publication.ts', 'lib/state-root.ts', 'bin/gstack-autoplan-snapshot.ts', '.github/docker/Dockerfile.ci', 'test/helpers/autoplan-guard-pty.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/hermetic-env.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts', 'test/skill-e2e-autoplan-guard-pty.test.ts'],
  // A resumed session whose journal is padded past 100 MiB before its compact boundary enters Phase 1 through the guard (CEO-15).
  'autoplan-long-session': ['autoplan/bin/phase-publication-hook.ts', 'autoplan/bin/owned-read.ts', 'autoplan/bin/phase-publication-hook', 'autoplan/bin/guard-reasons.ts', 'autoplan/bin/guard-log.ts', 'autoplan/bin/guard-journal.ts', 'autoplan/SKILL.md', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts', 'bin/gstack-autoplan-snapshot.ts', '.github/docker/Dockerfile.ci', 'test/helpers/autoplan-guard-pty.ts', 'test/helpers/journal-padding.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts', 'test/skill-e2e-autoplan-long-session.test.ts'],
  // Latest published Claude Code (not the pin): Agent/Read hook payloads vs their journal records, with the guard's own comparison.
  'autoplan-schema-canary': ['autoplan/bin/phase-publication-hook.ts', 'autoplan/bin/owned-read.ts', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts', 'lib/claude-bin.ts', 'test/helpers/schema-canary.ts', 'test/skill-e2e-autoplan-schema-canary.test.ts'],

  // P4 first-run scaffold (activation lift) — the detection binary end-to-end
  // through the real runner, plus the script wiring that gates + maps it
  // (token-reduction Phase 2: generate-first-run-guidance.ts was deleted; the
  // gate + token→tip map live in bin/gstack-skill-start's emission layer).

  // SKILL.md setup + preamble (depend on ROOT SKILL.md + gen-skill-docs)
  'skillmd-setup-discovery':  [ 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-relink', 'SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],
  'skillmd-no-local-binary':  [ 'SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],
  'skillmd-outside-git':      [ 'SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-bws.test.ts'],

  'operational-learning':     ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'scripts/resolvers/preamble.ts', 'bin/gstack-learnings-log', 'test/skill-e2e-bws.test.ts'],

  // QA (+ test-server dependency). /qa drives Aside first (the resolver) and
  // the browse binary as fallback (browse/src), so both are deps.
  'qa-quick': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',    'qa/**', 'scripts/resolvers/browse.ts', 'scripts/resolvers/aside.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-qa-workflow.test.ts', 'test/helpers/aside-available.ts', 'test/fixtures/qa-only-browser-probe.ts', 'test/helpers/bootstrap-retention.ts', 'test/helpers/qa-browser-deadline-evidence.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-only-cleanup.ts'],
  'qa-b6-static': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'qa/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval.html', 'test/fixtures/qa-eval-ground-truth.json', 'test/skill-e2e-qa-bugs.test.ts',  'test/helpers/aside-available.ts'],
  'qa-b7-spa': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'qa/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-spa.html', 'test/fixtures/qa-eval-spa-ground-truth.json', 'test/skill-e2e-qa-bugs.test.ts',  'test/helpers/aside-available.ts'],
  'qa-b8-checkout': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'qa/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-checkout.html', 'test/fixtures/qa-eval-checkout-ground-truth.json', 'test/skill-e2e-qa-bugs.test.ts',  'test/helpers/aside-available.ts'],
  'qa-only-no-fix': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/qa-only-cleanup.ts',  'test/helpers/qa-checkpoint-evidence.ts',  'test/fixtures/qa-only-observation-public.json', 'test/fixtures/qa-only-charter-public.json', 'test/fixtures/qa-only-browser-probe.ts', 'browse/test/fixtures/qa-only.html',  'test/helpers/qa-browser-deadline-evidence.ts',  'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',      'qa-only/**', 'qa/sections/**', 'qa/templates/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-qa-workflow.test.ts', 'test/helpers/aside-available.ts', 'test/helpers/bootstrap-retention.ts', 'test/helpers/qa-evidence-producer.ts'],
  'qa-fix-loop': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-qa-deadline', 'lib/qa-deadline.ts', 'lib/claude-code-windows-job.ts',    'qa/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'browse/test/test-server.ts', 'test/skill-e2e-qa-workflow.test.ts',
     'test/helpers/aside-available.ts', 'test/fixtures/qa-only-browser-probe.ts', 'test/helpers/bootstrap-retention.ts', 'test/helpers/qa-browser-deadline-evidence.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-only-cleanup.ts'],
  'qa-bootstrap':   ['test/helpers/bootstrap-retention.ts',     'qa/**', 'ship/**', 'test/skill-e2e-qa-workflow.test.ts',
    'scripts/resolvers/testing.ts', 'test/helpers/aside-available.ts', 'test/fixtures/qa-only-browser-probe.ts', 'test/helpers/qa-browser-deadline-evidence.ts', 'test/helpers/qa-checkpoint-evidence.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-only-cleanup.ts'],

  // Review
  'review-sql-injection':     [ 'review/**', 'test/fixtures/review-eval-vuln.rb', 'test/skill-e2e-review.test.ts',
      'test/fixtures/review-browse-error-ci-36516246523.json', 'test/fixtures/fake-impeccable.ts', 'test/helpers/fake-impeccable.ts'],
  'review-enum-completeness': [ 'review/**', 'test/fixtures/review-eval-enum*.rb', 'test/skill-e2e-review.test.ts', 
     'test/fixtures/fake-impeccable.ts', 'test/helpers/fake-impeccable.ts'],
  'review-base-branch':       [ 'review/**', 'test/skill-e2e-review-attribution.test.ts'],
  'review-gate-integrity':    [ 'review/**', 'lib/gate-diff/**', 'bin/gstack-gate-diff', 'scripts/resolvers/gate-scan.ts',
      'scripts/gate-diff-calibrate.ts', 'test/fixtures/gate-diff/**', 'test/helpers/gate-diff-repo.ts',
      'scripts/question-registry.ts', 'test/skill-e2e-gate-integrity.test.ts', 'test/helpers/skill-fixture.ts'],
  'review-design-lite':       ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'review/**', 'test/fixtures/review-eval-design-slop.*', 'test/helpers/fake-impeccable.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/impeccable-detect-sample.json', 'lib/design-catalog.ts', 'lib/design-detect-contract.ts', 'bin/gstack-design-detect.ts', 'scripts/resolvers/design-checklist.ts', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review.test.ts'
    
  ],

  // Review Army (specialist dispatch)
  'review-army-migration-safety': [ 'review/**', 'test/fixtures/review-army-migration.sql', 'scripts/resolvers/review-army.ts', 'bin/gstack-diff-scope', 'test/skill-e2e-review-army.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'review-army-perf-n-plus-one':  [ 'review/**', 'scripts/resolvers/review-army.ts', 'bin/gstack-diff-scope', 'test/skill-e2e-review-army.test.ts',   'test/fixtures/review-n-plus-one-dispatch.json', 'test/fixtures/review-army-n-plus-one.rb', 'test/helpers/office-hours-attempt.ts'],
  'review-army-delivery-audit':   [ 'review/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'review-army-quality-score':    [ 'review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts',  'test/helpers/office-hours-attempt.ts'],
  'review-army-json-findings':    [ 'review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'review-army-red-team':         [ 'review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts',
    'test/helpers/office-hours-attempt.ts'  
  ],
  'review-army-simplification':   [ 'review/**', 'scripts/resolvers/review-army.ts', 'test/fixtures/review-army-overbuild.js', 'test/fixtures/review-army-lean-complete.js', 'test/skill-e2e-review-army.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'review-army-simplification-precision': [ 'review/**', 'scripts/resolvers/review-army.ts', 'test/fixtures/review-army-overbuild.js', 'test/fixtures/review-army-lean-complete.js', 'test/skill-e2e-review-army.test.ts', 'test/helpers/office-hours-attempt.ts'],
  'review-army-consensus':        [ 'review/**', 'scripts/resolvers/review-army.ts', 'test/skill-e2e-review-army.test.ts', 
     'test/helpers/office-hours-attempt.ts'],

  // Office Hours
  'office-hours-forcing-energy':  [ 'office-hours/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-office-hours.test.ts', 
    'test/helpers/office-hours-attempt.ts' 
  ],
  'office-hours-builder-wildness': [ 'office-hours/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-office-hours.test.ts', 
    'test/helpers/office-hours-attempt.ts' 
  ],

  // Plan reviews
  'plan-ceo-review':                  [  'plan-ceo-review/**', 'test/skill-e2e-plan.test.ts', 'test/helpers/workflow-excerpt.ts',
    'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/tasks-section.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],
  'plan-ceo-review-selective':        [  'plan-ceo-review/**', 'test/skill-e2e-plan.test.ts', 'test/helpers/workflow-excerpt.ts',
    'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/tasks-section.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],
  'plan-ceo-review-expansion-energy': [  'plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'test/fixtures/mode-posture/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan.test.ts', 'test/helpers/workflow-excerpt.ts',
    'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/tasks-section.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],
  'plan-eng-review':           [ 
    
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/**', 'test/skill-e2e-plan.test.ts', 'test/helpers/workflow-excerpt.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],
  'plan-eng-review-artifact':  [ 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/pty/**', 'test/helpers/pty/auq.ts', 'test/helpers/pty/binary.ts', 'test/helpers/pty/boundaries.ts', 'test/helpers/pty/classify.ts', 'test/helpers/pty/fake-session.ts', 'test/helpers/pty/judge.ts', 'test/helpers/pty/launch.ts', 'test/helpers/pty/plan-native.ts', 'test/helpers/pty/runners/counting.ts', 'test/helpers/pty/runners/floor.ts', 'test/helpers/pty/runners/observation.ts', 'test/helpers/pty/screen.ts', 'test/helpers/pty/session.ts', 'test/helpers/skill-census.ts', 
    
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/**', 'test/skill-e2e-plan-eng-artifact.test.ts', 'test/helpers/plan-eng-artifact-fixture.ts', 'test/helpers/plan-eng-resume.ts', 'test/fixtures/plan-eng-artifact-resume-37174266054.json', 'test/helpers/workflow-excerpt.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],
  'plan-eng-review-artifact-full':  [ 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/pty/**', 'test/helpers/pty/auq.ts', 'test/helpers/pty/binary.ts', 'test/helpers/pty/boundaries.ts', 'test/helpers/pty/classify.ts', 'test/helpers/pty/fake-session.ts', 'test/helpers/pty/judge.ts', 'test/helpers/pty/launch.ts', 'test/helpers/pty/plan-native.ts', 'test/helpers/pty/runners/counting.ts', 'test/helpers/pty/runners/floor.ts', 'test/helpers/pty/runners/observation.ts', 'test/helpers/pty/screen.ts', 'test/helpers/pty/session.ts', 'test/helpers/skill-census.ts', 
    
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/**', 'test/skill-e2e-plan-eng-artifact-full.test.ts', 'test/helpers/plan-eng-artifact-fixture.ts', 'test/helpers/workflow-excerpt.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],
  'plan-review-report':        [ 
    
    'test/helpers/office-hours-attempt.ts', 
     'test/fixtures/plan-review-report-public.json',
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-plan.test.ts', 'test/helpers/workflow-excerpt.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-completion.ts', 'test/helpers/workflow-judge-input.ts'],

  // Plan-mode smoke tests — gate-tier safety regression tests. Each test file
  // contains TWO test cases as of v1.21: the baseline plan-mode case and the
  // AskUserQuestion-blocked regression case (--disallowedTools AskUserQuestion
  // parameterized — the flag set Conductor uses by default). Touchfiles
  // include question-tuning.ts and generate-ask-user-format.ts because the
  // AUTO_DECIDE preamble injection lives there and changes can flip the
  // regression test outcome between 'asked' and 'auto_decided'.
  'plan-ceo-review-plan-mode':    ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/plan-count-fixture.ts',
    
    
    'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',

    "test/fixtures/plan-scope-target-aw.json",

     'test/fixtures/auto-decide-saved-ai.json', 'test/fixtures/auto-decide-retry-ai.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-plan-ceo-plan-mode.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-scope-selection.ts',  'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json',  'test/fixtures/auto-decide-structured-77.json', 'test/helpers/auto-decision-state.ts',  'test/fixtures/auto-decide-state-cab3.json', 'bin/gstack-question-log', 'bin/gstack-question-preference',   'test/helpers/fake-plan-seed.ts', 'test/helpers/plan-seed-submission.ts',  'test/fixtures/plan-seed-cli.ts', 'test/fixtures/native-auto-decide-ag.json',  'test/fixtures/eng-seeded-completion-ai.json', 'test/helpers/plan-count-pending-exit.ts',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**',
    
     'test/fixtures/design-scope-announcement-ao.json',
    'test/fixtures/design-scope-declaration-ak.json',
    
    "test/fixtures/eng-option-b-scope-al.json",
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'scripts/resolvers/tasks-section.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'bin/gstack-context-recovery'],
  'plan-eng-review-plan-mode':    ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',
    
    'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',

     'test/fixtures/autoplan-public-narration-ad.json',
    'test/helpers/plan-count-transcript.ts',  'test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json', 
    'scripts/resolvers/learnings.ts',
    "test/fixtures/plan-scope-target-aw.json",

    
    "test/fixtures/plan-scope-recovery-av.json",  
     'test/fixtures/auto-decide-saved-ai.json', 'test/fixtures/auto-decide-retry-ai.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-plan-eng-plan-mode.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-scope-selection.ts',  'test/fixtures/design-plan-scope-ag.json',  'test/fixtures/design-scope-selection-aj.json', 'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json',  'test/fixtures/auto-decide-structured-77.json', 'test/helpers/auto-decision-state.ts',  'test/fixtures/auto-decide-state-cab3.json', 'bin/gstack-question-log', 'bin/gstack-question-preference',   'test/helpers/fake-plan-seed.ts', 'test/fixtures/native-auto-decide-ag.json',  'test/fixtures/eng-seeded-completion-ai.json', 'test/helpers/plan-count-pending-exit.ts',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**',
    
     'test/fixtures/design-scope-announcement-ao.json',
    'test/fixtures/design-scope-declaration-ak.json',
    
    "test/fixtures/eng-option-b-scope-al.json",

     "scripts/resolvers/preamble/generate-preamble-bash.ts",
     'test/fixtures/pty-companion-cli.ts', 'test/helpers/plan-seed-submission.ts',  'test/fixtures/plan-seed-cli.ts', 'test/helpers/owned-claude-transcript.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'scripts/resolvers/testing.ts', 'test/helpers/plan-mode-evidence.ts',  'lib/redact-engine.ts', 'lib/redact-patterns.ts',  'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'bin/gstack-context-recovery'],
  // PTY plan-mode smoke (whole file); the SDK plan-edit case below owns plan-design-review-plan-mode.
  'plan-design-review-plan-mode-smoke': [
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',
    
    'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',

     'test/fixtures/autoplan-public-narration-ad.json',
    'test/helpers/plan-count-transcript.ts',  'test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json', 
    'test/helpers/office-hours-attempt.ts',  'lib/eval-model.ts', 
    
    "test/fixtures/plan-scope-target-aw.json",

    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json",
     'test/fixtures/auto-decide-saved-ai.json', 'test/fixtures/auto-decide-retry-ai.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-design-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-plan-design-plan-mode.test.ts', 'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-scope-selection.ts',  'test/fixtures/design-plan-scope-ag.json',  'test/fixtures/design-scope-selection-aj.json', 'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json',  'test/fixtures/auto-decide-structured-77.json', 'test/helpers/auto-decision-state.ts',  'test/fixtures/auto-decide-state-cab3.json', 'bin/gstack-question-log', 'bin/gstack-question-preference',   'test/helpers/fake-plan-seed.ts', 'test/fixtures/native-auto-decide-ag.json',  'test/fixtures/eng-seeded-completion-ai.json', 'test/helpers/plan-count-pending-exit.ts',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**',
    
     'test/fixtures/design-scope-announcement-ao.json',
    'test/fixtures/design-scope-declaration-ak.json',
    
    "test/fixtures/eng-option-b-scope-al.json",
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts",
     'test/fixtures/pty-companion-cli.ts', 'test/helpers/plan-seed-submission.ts',  'test/fixtures/plan-seed-cli.ts', 'test/helpers/owned-claude-transcript.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/plan-mode-evidence.ts',  'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'bin/gstack-context-recovery'],
  // SDK plan-edit case in test/skill-e2e-design.test.ts (claude -p edits plan.md).
  'plan-design-review-plan-mode': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'plan-design-review/**', 'scripts/gen-skill-docs.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/design.ts',
    'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts',
    'lib/eval-model.ts', 'test/skill-e2e-design.test.ts',
    'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts', 'test/helpers/pty/**'],
  'plan-devex-review-plan-mode':  ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',

    "test/fixtures/plan-scope-target-aw.json",

     'test/fixtures/auto-decide-saved-ai.json', 'test/fixtures/auto-decide-retry-ai.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-plan-devex-plan-mode.test.ts', 'test/helpers/plan-mode-evidence.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-scope-selection.ts',  'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json',  'test/fixtures/auto-decide-structured-77.json', 'test/helpers/auto-decision-state.ts',  'test/fixtures/auto-decide-state-cab3.json', 'bin/gstack-question-log', 'bin/gstack-question-preference',   'test/helpers/fake-plan-seed.ts', 'test/helpers/plan-seed-submission.ts',  'test/fixtures/plan-seed-cli.ts', 'test/fixtures/native-auto-decide-ag.json',  'test/fixtures/eng-seeded-completion-ai.json', 'test/helpers/plan-count-pending-exit.ts',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**',
    
     'test/fixtures/design-scope-announcement-ao.json',
    'test/fixtures/design-scope-declaration-ak.json',
    
    "test/fixtures/eng-option-b-scope-al.json",
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'bin/gstack-context-recovery'],
  // Covers ceo (preamble misfire) + eng/design (scope-gate bypass must not
  // fire outside plan mode) + the named-target exception case. 4 PTY runs;
  // in CI these run CONCURRENT with the rest of the pty-plan-smoke suite
  // (--max-concurrency, no retries), so worst-case cost is one pass of
  // each, sharing the API budget with sibling tests — not the
  // sequential ~+10min a local read suggests.
  'plan-mode-no-op':              ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-design-doc-find', 'scripts/resolvers/design-doc-discovery.ts', 'scripts/resolvers/spec-review.ts', 'plan-devex-review/**', 'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',

    'scripts/resolvers/learnings.ts',
    "test/fixtures/plan-scope-target-aw.json",

    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", 
     'test/fixtures/auto-decide-saved-ai.json', 'test/fixtures/auto-decide-retry-ai.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-plan-mode-no-op.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-scope-selection.ts',  'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json',  'test/fixtures/auto-decide-structured-77.json', 'test/helpers/auto-decision-state.ts',  'test/fixtures/auto-decide-state-cab3.json', 'bin/gstack-question-log', 'bin/gstack-question-preference',   'test/helpers/fake-plan-seed.ts', 'test/fixtures/native-auto-decide-ag.json',  'test/fixtures/eng-seeded-completion-ai.json', 'test/helpers/plan-count-pending-exit.ts',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**',
    
     'test/fixtures/design-scope-announcement-ao.json',
    'test/fixtures/design-scope-declaration-ak.json',
    
    "test/fixtures/eng-option-b-scope-al.json",
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts",
     'test/fixtures/pty-companion-cli.ts', 'test/helpers/plan-seed-submission.ts',  'test/fixtures/plan-seed-cli.ts', 'test/helpers/owned-claude-transcript.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts',  'scripts/resolvers/tasks-section.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'bin/gstack-context-recovery'],

  // v1.21+ AskUserQuestion-blocked regression tests — Conductor launches
  // claude with `--disallowedTools AskUserQuestion --permission-mode default`
  // (verified via `ps`); skills must still surface user-decisions through a
  // fallback path (mcp__conductor__AskUserQuestion or plan-file flow) rather
  // than silently auto-deciding. Parameterized regression test cases live
  // INSIDE the existing 4 plan-X-review-plan-mode test files (covered
  // transitively by the entries above). Two new standalone files exist for
  // skills with no prior plan-mode test:
  'office-hours-auto-mode':       ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',
  'test/fixtures/native-auto-decide-ag.json', 'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json', 'bin/gstack-skill-start', 'bin/gstack-skill-end', 'office-hours/**', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-office-hours-auto-mode.test.ts', 'test/helpers/plan-mode-evidence.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt',
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/pty-screen.ts', 'bin/gstack-context-recovery'],
  'office-hours-phase4-fork':     ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-skill-start', 'bin/gstack-skill-end', 'office-hours/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/question-tuning.ts', 'test/helpers/llm-judge.ts', 'test/skill-e2e-office-hours-phase4.test.ts', 'bin/gstack-context-recovery' ],
  'llm-judge-recommendation':     ['codex/**', 'test/helpers/llm-judge.ts', 'test/llm-judge-recommendation.test.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'codex/SKILL.md.tmpl', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts'],
  // v1.21+ AUTO_DECIDE preserve eval (periodic). Verifies the Tool resolution
  // fix doesn't trip the legitimate /plan-tune opt-in path: when the user has
  // written a never-ask preference, AUQ should still auto-decide rather than
  // surfacing the question. Touches the question-tuning + preference
  // infrastructure plus the resolvers that own the AUTO_DECIDE preamble.
  'auto-decide-preserved':        ['bin/gstack-ceo-mode-handoff', 'test/fixtures/auto-decide-handoff-line-e354.json', 'test/fixtures/auto-decide-handoff-before-log-37182865432.json', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',
    
    'test/fixtures/auto-decide-recommendation-361c.json',
    
    'test/fixtures/auto-decide-target-361c.json',

     'test/fixtures/autoplan-public-narration-ad.json',
    'test/fixtures/auto-decide-completed-mode-f359.json',
    'test/helpers/plan-count-transcript.ts',  'test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json', 
     'test/fixtures/auto-decide-saved-ai.json', 'test/fixtures/auto-decide-retry-ai.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'bin/gstack-session-kind', 'scripts/resolvers/question-tuning.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'plan-ceo-review/**', 'bin/gstack-question-preference', 'bin/gstack-config', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'hosts/claude/hooks/question-preference-hook.ts', 'lib/bin-context.ts', 'lib/remote-identity.ts', 'hosts/claude/hooks/spawned-directive.ts', 'lib/is-conductor.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-auto-decide-preserved.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/native-auto-decide.ts',  'test/fixtures/auto-decide-current-declaration-6aef.json',  'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json',  'test/fixtures/auto-decide-structured-77.json', 'test/helpers/auto-decision-state.ts',  'test/fixtures/auto-decide-state-cab3.json', 'bin/gstack-question-log',   'test/helpers/fake-plan-seed.ts', 'test/helpers/plan-seed-submission.ts',  'test/fixtures/plan-seed-cli.ts', 'test/fixtures/native-auto-decide-ag.json',  'test/fixtures/eng-seeded-completion-ai.json', 'test/helpers/plan-count-pending-exit.ts',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**',
    
    'test/helpers/plan-count-fixture.ts', 
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',  'test/fixtures/auto-decide-mode-selector-749df.json', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/ceo-finding-fixture.ts',  'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',     'scripts/resolvers/tasks-section.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'hosts/claude/hooks/hook-log.ts', 'bin/gstack-context-recovery'],

  // Conductor → prose decision brief (Conductor signal makes prose the default;
  // the PreToolUse hook denies the flaky tool). Touches the resolver that owns
  // the Conductor rule, the preamble signal, the hook, and the detection helper.

  // Native question capture and interactive workflow probes.
  'auq-format-gate':                           [ 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'test/helpers/llm-judge.ts', 'test/skill-e2e-ask-user-question-format-compliance.test.ts',
     
    'test/helpers/agent-sdk-runner.ts', 
    'test/helpers/auq-native-capture.ts', 'test/helpers/hermetic-env.ts',
    'test/helpers/eval-store.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts',
     
    'scripts/resolvers/tasks-section.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'plan-ceo-mode-routing':       ['bin/gstack-ceo-mode-handoff', 
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',
    
    

     'test/fixtures/ceo-expansion-pacing-fb10.json', 'test/helpers/ceo-hold-posture-review.ts',  'test/fixtures/ceo-hold-proof-fb10.json', 'test/helpers/plan-review-decisions.ts',  'test/helpers/llm-judge.ts', 'lib/eval-model.ts',
    'test/fixtures/ceo-hold-preservation-f359.json',
    'test/fixtures/ceo-expansion-complete-inventory-6f.json',
    'test/fixtures/ceo-expansion-posture-kind-dacc.json',
    'test/fixtures/ceo-expansion-pause-6714.json',
     'test/fixtures/ceo-mode-pending-submit.json',
     "test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json", 

     "test/fixtures/ceo-mode-colon-at.json", 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/helpers/ceo-mode-option.ts',  'test/fixtures/ceo-expansion-disposition-77.json',   'test/helpers/plan-count-transcript.ts',  'test/fixtures/autoplan-public-narration-ad.json',  'test/helpers/plan-count-fixture.ts',   'test/fixtures/ceo-prerequisite-n-call.json', 'test/fixtures/eng-prerequisite-77.json', 'test/skill-e2e-plan-ceo-mode-routing.test.ts',  'test/fixtures/ceo-hold-posture-l.json',  'test/fixtures/ceo-mode-labels-l.json',  'test/fixtures/ceo-checkbox-l.screen.txt',  'test/fixtures/ceo-mode-prerequisite-o-calls.json', 'test/fixtures/ceo-mode-prerequisite-q-call.json',  'test/fixtures/ceo-preview-u-call.json', 'test/fixtures/ceo-preview-u-screen.txt',  'test/fixtures/design-preview-v-screen.txt',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/fixtures/ceo-mode-preview-aa-screen.txt', 'test/fixtures/ceo-count-mode-preview-aa-screen.txt',  'test/fixtures/ceo-expansion-auq-ac.json', 'test/helpers/plan-count-pending-question.ts',    'test/fixtures/ceo-barless-submit-ac.json',  'test/fixtures/pending-question-completion-ad.json',  'test/fixtures/ceo-mode-posture-ad.json',  'test/fixtures/ceo-mode-full-ad.json',  'test/fixtures/ceo-prerequisite-ad-v2.json',  'test/fixtures/ceo-hold-posture-ag.json',
     "test/fixtures/ceo-hold-commitment-ar.json",
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',  'test/helpers/ceo-finding-fixture.ts',   'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/owned-claude-transcript.ts',    'scripts/resolvers/tasks-section.ts',
    'test/fixtures/ceo-expansion-pacing-77.json', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts'],
  'plan-design-with-ui-scope':   [ 'design/src/variants.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/pty-screen.ts',
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',
     'test/fixtures/autoplan-public-narration-ad.json',
    'test/helpers/plan-count-fixture.ts', 
     'test/fixtures/ceo-prerequisite-n-call.json', 'test/fixtures/eng-prerequisite-77.json',
    'test/helpers/plan-count-transcript.ts',  'test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json', 
      
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json",'plan-design-review/**', 'test/fixtures/plans/ui-heavy-feature.md', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/skill-e2e-plan-design-with-ui.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',  'test/helpers/ceo-finding-fixture.ts', 'test/helpers/plan-review-cases.ts', 'test/helpers/plan-review-board-feedback.ts',  'test/fixtures/design-board-questions.json', 'test/fixtures/design-outside-voices-question.json', 'design/src/daemon-state.ts', 'design/src/daemon.ts', 'design/test/daemon-tests-fixtures.ts', 'design/src/daemon-client.ts', 'test/helpers/owned-claude-transcript.ts',     'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'scripts/resolvers/preamble/generate-ask-user-format.ts', 'bin/gstack-paths', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts'],
  'tpa-present':                 [ 'scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts', 'test/helpers/third-party-actions.ts',
     'lib/eval-model.ts'
  ],
  'tpa-absent-linux':            [ 'scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts', 'test/helpers/third-party-actions.ts',
     'lib/eval-model.ts'
  ],
  'tpa-broken':                  [ 'scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts', 'test/helpers/third-party-actions.ts',
     'lib/eval-model.ts'
  ],
  'tpa-absent-darwin':           [ 'scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts', 'test/helpers/third-party-actions.ts',
     'lib/eval-model.ts'
  ],
  'tpa-apple-ban':               [ 'scripts/resolvers/third-party-actions.ts', 'ship/SKILL.md.tmpl', 'ship/sections/apple-release.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-third-party-actions.test.ts', 'test/helpers/third-party-actions.ts',
     'lib/eval-model.ts'
  ],
  'ship-measure-seeded-flake': ['ship/**', 'scripts/ship-measure.ts', 'scripts/lib/measure-bar.ts', 'scripts/test-free-shards.ts', 'scripts/lib/shard-engine.ts', 'scripts/lib/paid-select.ts', 'scripts/lib/free-home-guard.ts', 'bin/gstack-config', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/testing.ts', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-ship-measure-loop.test.ts', 'test/helpers/ship-measure-seeded-fixture.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/skill-fixture.ts'],
  'ship-section-loading':        [ 'ship/**', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts',  'test/skill-e2e-ship-section-loading.test.ts',
      'scripts/resolvers/testing.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'plan-ceo-section-loading':    [
    'test/fixtures/ceo-fill-lifetime.json', 'plan-ceo-review/**',  'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts',  'test/helpers/ceo-section-loading-fixture.ts', 'test/helpers/ceo-stale-fill-decision.ts',  'test/skill-e2e-plan-ceo-review-section-loading.test.ts', 'test/fixtures/ceo-section-loading-l-report.md', 'test/fixtures/ceo-section-loading-q-report.md', 'test/fixtures/ceo-section-r-rejected-report.md', 'test/fixtures/ceo-section-s-trace-report.md', 'test/fixtures/ceo-section-u-report.md', 'test/fixtures/ceo-section-y-report.md', 'test/fixtures/ceo-section-aa-report.md',  'test/fixtures/sdk-stale-table-ad-v3.json',  'test/fixtures/sdk-ordering-ae.json',  'test/fixtures/sdk-columnar-af.json',  'test/fixtures/sdk-order-b-ag.json',  'test/fixtures/sdk-schedule-continuation-ah.json',  'test/fixtures/sdk-original-order-ai.json',  'test/fixtures/sdk-compact-sequence-aj.json',
     "test/fixtures/sdk-reported-coordination-ar.md",  "test/fixtures/sdk-ordered-schedule-ar.md",
     'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/tasks-section.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  // Data-driven behavioral guard for the 'plan'/'prompt' carves: one case per
  // skill in test/carve-section-loading.test.ts (case-sharded, W5a). Each case
  // selects on its own skill directory; the registry, helper, harness and
  // sections.ts select every case.
  'carve-section-loading-browse': ['browse/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-codex': ['codex/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-design-consultation': ['design-consultation/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-design-html': ['design-html/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-design-shotgun': ['design-shotgun/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-document-release': ['document-release/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-land-and-deploy': ['land-and-deploy/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-plan-design-review': ['plan-design-review/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-plan-devex-review': ['plan-devex-review/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-plan-eng-review': ['plan-eng-review/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'scripts/resolvers/learnings.ts', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'scripts/resolvers/testing.ts', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-qa': ['qa/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-retro': ['retro/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-review': ['review/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-setup-gbrain': ['setup-gbrain/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'carve-section-loading-spec': ['spec/**', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue', 'test/fixtures/autoplan-amend-input-77.json', 'test/fixtures/autoplan-phase-handoff-6714.json', 'test/fixtures/plan-scope-recovery-av.json', 'test/fixtures/design-scope-checkpoint-at.json', 'scripts/resolvers/composition.ts', 'autoplan/**', 'test/helpers/carve-guards.ts', 'scripts/resolvers/sections.ts', 'scripts/resolvers/redact-doc.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/auq-sdk-capture.ts', 'test/helpers/session-runner.ts', 'bin/gstack-autoplan-snapshot.ts', 'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json', 'scripts/resolvers/preamble/generate-preamble-bash.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'test/carve-section-loading.test.ts', 'test/helpers/carve-section-case.ts', 'test/fixtures/design-html-section-complete.md', 'test/helpers/carve-plan-fixture.ts', 'test/fixtures/carve-existing-repository/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/llm-judge.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],

  // Per-finding AskUserQuestion count + review-report-at-bottom assertion.
  // Each test drives its skill end-to-end; touchfiles include preamble +
  // completion-status resolvers because they affect question cadence and
  // terminal output (the regression surface this test catches).

  // Gate-tier reviewCount-floor counterparts. Catch the May 2026 transcript
  // bug (model wrote a plan-mode plan and ExitPlanMode'd without firing any
  // review-phase AskUserQuestion). Uses runPlanSkillFloorCheck — minimal
  // "did agent fire ANY AUQ?" observer that exits early on first non-permission
  // numbered-option render. ~1-3 min typical wall time per test, ~$2-6 total.
  'plan-eng-finding-floor':      ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/pty-screen.ts',
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',  'test/fixtures/plan-create-prepublication-491.json',  'test/fixtures/plan-create-combined-permission-70b.json', 'test/fixtures/plan-floor-quote-70b.json',
    
    'test/fixtures/plan-create-permission-361c.json',
    'test/helpers/plan-floor-review.ts',
    
    'test/fixtures/plan-floor-routing-361c.json',

    'test/fixtures/ceo-report-permission-fb10.json',  'test/fixtures/plan-floor-permission-fb10.json', 'test/helpers/plan-count-file-permission.ts',  'test/fixtures/plan-edit-cropped-permission-1579.json',  'test/fixtures/plan-count-permission-target-ad-v2.json',  'test/fixtures/design-crop-gutter-ap.json',  'test/fixtures/plan-count-crop-ak.json',  'test/fixtures/plan-count-long-edit-0bcd.json',  'test/fixtures/plan-count-cropped-wrap-6714.json',
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-eng-finding-floor.test.ts',  'test/fixtures/eng-batching-t-calls.json',  'test/fixtures/eng-scope-y-calls.json',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt',  'test/fixtures/eng-binding-z-calls.json',  'test/fixtures/eng-binding-retry-z-calls.json', 'test/helpers/plan-floor-target.ts',  'test/helpers/plan-count-fixture.ts',  'test/helpers/plan-count-artifacts.ts', 
     "test/fixtures/eng-injected-export-aq.json",  "test/fixtures/eng-library-hooks-aq.json",

     "scripts/resolvers/preamble/generate-preamble-bash.ts",
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'scripts/resolvers/testing.ts',  'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'bin/gstack-context-recovery'],
  'plan-ceo-finding-floor':      ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/pty-screen.ts',
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',  'test/fixtures/plan-create-prepublication-491.json',  'test/fixtures/plan-create-combined-permission-70b.json', 'test/fixtures/plan-floor-quote-70b.json',
    
    'test/fixtures/plan-create-permission-361c.json',
    'test/helpers/plan-floor-review.ts',
    
    'test/fixtures/plan-floor-routing-361c.json',

    'test/fixtures/ceo-report-permission-fb10.json',  'test/fixtures/plan-floor-permission-fb10.json', 'test/helpers/plan-count-file-permission.ts',  'test/fixtures/plan-edit-cropped-permission-1579.json',  'test/fixtures/plan-count-permission-target-ad-v2.json',  'test/fixtures/design-crop-gutter-ap.json',  'test/fixtures/plan-count-crop-ak.json',  'test/fixtures/plan-count-long-edit-0bcd.json',  'test/fixtures/plan-count-cropped-wrap-6714.json', 'bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-ceo-finding-floor.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-floor-target.ts',  'test/helpers/plan-count-fixture.ts',  'test/helpers/plan-count-artifacts.ts', 
     
       
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'scripts/resolvers/tasks-section.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'bin/gstack-context-recovery'],
  'plan-design-finding-floor':   ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/pty-screen.ts',
    
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',  'test/fixtures/plan-create-prepublication-491.json',  'test/fixtures/plan-create-combined-permission-70b.json', 'test/fixtures/plan-floor-quote-70b.json',
    
    'test/fixtures/plan-create-permission-361c.json',
    'test/helpers/plan-floor-review.ts',
    
    'test/fixtures/plan-floor-routing-361c.json',

    'test/fixtures/ceo-report-permission-fb10.json',  'test/fixtures/plan-floor-permission-fb10.json', 'test/helpers/plan-count-file-permission.ts',  'test/fixtures/plan-edit-cropped-permission-1579.json',  'test/fixtures/plan-count-permission-target-ad-v2.json',  'test/fixtures/design-crop-gutter-ap.json',  'test/fixtures/plan-count-crop-ak.json',  'test/fixtures/plan-count-long-edit-0bcd.json',  'test/fixtures/plan-count-cropped-wrap-6714.json',
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json",'bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-design-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-design-finding-floor.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-floor-target.ts',  'test/helpers/plan-count-fixture.ts',  'test/helpers/plan-count-artifacts.ts', 
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts",
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/ceo-finding-fixture.ts',   'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'bin/gstack-context-recovery'],
  'plan-devex-finding-floor':    ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/pty-screen.ts',
     'test/fixtures/plan-floor-dx-custom-491.json', 'test/fixtures/plan-floor-dx-editor-hint.json',
    
    'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',  'test/fixtures/plan-create-prepublication-491.json',  'test/fixtures/plan-create-combined-permission-70b.json', 'test/fixtures/plan-floor-quote-70b.json', 'test/fixtures/plan-floor-product-type-70b.json',
    
    'test/fixtures/plan-create-permission-361c.json',
    'test/helpers/plan-floor-review.ts',
    
    'test/fixtures/plan-floor-routing-361c.json',

    'test/fixtures/ceo-report-permission-fb10.json',  'test/fixtures/plan-floor-permission-fb10.json', 'test/helpers/plan-count-file-permission.ts',  'test/fixtures/plan-edit-cropped-permission-1579.json',  'test/fixtures/plan-count-permission-target-ad-v2.json',  'test/fixtures/design-crop-gutter-ap.json',  'test/fixtures/plan-count-crop-ak.json',  'test/fixtures/plan-count-long-edit-0bcd.json',  'test/fixtures/plan-count-cropped-wrap-6714.json','bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-devex-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json', 'test/helpers/hermetic-skill-runtime.ts',  'test/helpers/pty-trust-dialog.ts',  'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-devex-finding-floor.test.ts',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt', 'test/helpers/plan-floor-target.ts',  'test/helpers/plan-count-fixture.ts',  'test/helpers/plan-count-artifacts.ts', 
     'test/fixtures/pty-companion-cli.ts', 'lib/fs-atomic.ts',    'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'bin/gstack-context-recovery'],

  // Multi-finding batching regression — periodic tier complement to the
  // gate-tier finding-floor. Catches the May 2026 transcript shape where
  // a model fires one AUQ then batches the rest into a "## Decisions to
  // confirm" plan write. runPlanSkillFloorCheck cannot detect that shape
  // (it exits on first AUQ); runPlanSkillCounting can.
  'plan-eng-multi-finding-batching': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',  'test/fixtures/plan-create-prepublication-491.json',  'test/fixtures/plan-create-combined-permission-70b.json',
    
    'test/fixtures/plan-create-permission-361c.json',
    
    

    'test/fixtures/ceo-report-permission-fb10.json',
      
    
    
    'test/fixtures/eng-batching-prefixed-ledger-f359.json',
     'test/fixtures/eng-batching-saved-ledger-b176.json',
     'test/fixtures/review-count-markdown-6f.json',
     'test/fixtures/plan-count-long-edit-0bcd.json', 
    'test/fixtures/plan-count-cropped-wrap-6714.json',
    'test/fixtures/eng-batching-expanded-ledger-6714.json',
    'test/fixtures/eng-native-review-identities-6714.json',
    
     'test/fixtures/eng-batching-native-8525.json',
     'test/fixtures/eng-batching-saved-ledger-dacc.json',
    'scripts/resolvers/learnings.ts',
    'test/helpers/eng-seeded-coverage.ts',     'test/fixtures/eng-a689-retry-public.json', 
    
     "test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json", 

    
    "test/fixtures/plan-scope-recovery-av.json",
     "test/fixtures/batching-permission-at.json",
     "test/fixtures/eng-declared-retry-at.json",  'test/fixtures/design-crop-gutter-ap.json',  'bin/gstack-config', 'bin/gstack-skill-start', 'bin/gstack-skill-end', 'plan-eng-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**', 'test/helpers/hermetic-skill-runtime.ts',   'test/helpers/pty-trust-dialog.ts',  'test/helpers/plan-count-transcript.ts',  'test/fixtures/autoplan-public-narration-ad.json', 'test/helpers/plan-count-pending-exit.ts',   'test/helpers/plan-count-artifacts.ts',  'test/helpers/eval-store.ts', 'test/helpers/plan-count-fixture.ts',      'test/fixtures/ceo-prerequisite-n-call.json', 'test/fixtures/eng-prerequisite-77.json', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-eng-multi-finding-batching.test.ts',  'test/fixtures/ceo-checkbox-l.screen.txt',  'test/fixtures/eng-devex-s-first-calls.json', 'test/fixtures/eng-devex-s-retry-calls.json', 'test/helpers/plan-count-file-permission.ts',  'test/fixtures/plan-edit-cropped-permission-1579.json',  'test/fixtures/plan-count-edit-permission-t.json',  'test/fixtures/eng-batching-t-calls.json',  'test/fixtures/ceo-preview-u-call.json', 'test/fixtures/ceo-preview-u-screen.txt', 'test/fixtures/design-preview-v-screen.txt',  'test/fixtures/plan-count-owned-permission-v.json', 'test/fixtures/ceo-questionless-w-native.json',  'test/fixtures/eng-scope-y-calls.json',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt',  'test/fixtures/eng-binding-z-calls.json',  'test/fixtures/eng-binding-retry-z-calls.json',  'test/fixtures/plan-count-permission-ac.json', 'test/fixtures/plan-count-permission-ad.json', 'test/fixtures/plan-count-permission-ae.json', 'test/fixtures/plan-count-permission-target-ad-v2.json',  'test/fixtures/eng-count-ad-v2.json',  'test/fixtures/eng-first-category-af.json',   'test/fixtures/plan-count-permission-ah.json',  
    
    'test/fixtures/plan-count-crop-ak.json',
    
    'test/fixtures/plan-count-quoted-frame-ak.json',
     "test/fixtures/eng-injected-export-aq.json",  "test/fixtures/eng-library-hooks-aq.json",
     "test/fixtures/eng-declarative-as.json", "test/helpers/eng-cache-writer-decision.ts",  "test/fixtures/eng-cache-writes-as.json",

     "scripts/resolvers/preamble/generate-preamble-bash.ts",
     'test/fixtures/pty-companion-cli.ts',   'lib/fs-atomic.ts', 'test/helpers/owned-claude-transcript.ts',    'test/fixtures/webfetch-permission.json',  'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',  'test/helpers/ceo-finding-fixture.ts',     'test/helpers/plan-review-decisions.ts',  'test/helpers/plan-review-cases.ts',  'test/helpers/llm-judge.ts', 'lib/eval-model.ts', 'test/skill-e2e-plan-decision-classification.test.ts', 'test/fixtures/plan-decision-classification.ts',  'scripts/resolvers/testing.ts', 'test/fixtures/eng-file-permission-repaint.json', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'bin/gstack-context-recovery'],
  'plan-ceo-split-overflow': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'lib/claude-public-transcript.ts', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts',  'test/fixtures/plan-create-prepublication-491.json',  'test/fixtures/plan-create-combined-permission-70b.json',
    
    'test/fixtures/plan-create-permission-361c.json',
    
    
    'test/fixtures/ceo-split-padding-361c-public.json',
    'test/fixtures/ceo-split-edit-permission-361c-public.json',

    'test/fixtures/ceo-report-permission-fb10.json',
     'test/fixtures/plan-count-long-edit-0bcd.json', 
    'test/fixtures/plan-count-cropped-wrap-6714.json',
    
     "test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json", 
  'test/fixtures/design-crop-gutter-ap.json', 'bin/gstack-config', 'plan-ceo-review/**', 'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'bin/gstack-question-preference', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**',  'test/fixtures/design-ui-boxed-question.json',  'test/helpers/pty-screen.ts',   'test/fixtures/pty-screen/**', 'test/helpers/hermetic-skill-runtime.ts',   'test/helpers/pty-trust-dialog.ts',  'test/helpers/plan-count-transcript.ts',  'test/fixtures/autoplan-public-narration-ad.json', 'test/helpers/plan-count-pending-exit.ts',   'test/helpers/plan-count-artifacts.ts',  'test/helpers/eval-store.ts', 'test/helpers/plan-count-fixture.ts',      'test/fixtures/ceo-prerequisite-n-call.json', 'test/fixtures/eng-prerequisite-77.json', 'test/fixtures/forcing-finding-seeds.ts', 'test/skill-e2e-plan-ceo-split-overflow.test.ts',  'test/fixtures/ceo-checkbox-l.screen.txt', 'test/helpers/plan-count-file-permission.ts',  'test/fixtures/plan-edit-cropped-permission-1579.json',  'test/fixtures/plan-count-edit-permission-t.json',  'test/fixtures/plan-count-owned-permission-v.json', 'test/fixtures/ceo-questionless-w-native.json',  'test/fixtures/eng-d2-truncated-border-0bcd.json',   'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json', 'test/fixtures/ceo-approach-z-call.json', 'test/fixtures/ceo-approach-z-screen.txt',  'test/fixtures/plan-count-permission-ac.json', 'test/fixtures/plan-count-permission-ad.json', 'test/fixtures/plan-count-permission-ae.json', 'test/fixtures/plan-count-permission-target-ad-v2.json', 'test/fixtures/plan-count-permission-ah.json',
    
    'test/fixtures/plan-count-crop-ak.json',
    
    'test/fixtures/plan-count-quoted-frame-ak.json',
    'docs/askuserquestion-split.md',  'bin/gstack-slug', 'bin/gstack-remote-identity.sh',   'test/fixtures/pty-companion-cli.ts',   'lib/fs-atomic.ts', 'test/helpers/ceo-finding-fixture.ts',  'test/helpers/owned-claude-transcript.ts',    'test/fixtures/webfetch-permission.json',  'test/helpers/plan-skill-questions.ts', 'test/fixtures/eng-auq-validation-error.json', 'test/fixtures/bash-directory-permission.json', 'test/fixtures/design-tasks-bash-permission.json',  'test/fixtures/read-permission.json',  'test/fixtures/ceo-split-e5-numbered-description-491.json',  'test/helpers/plan-skill-question-events.ts',  'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts',     'test/helpers/plan-review-decisions.ts',  'test/helpers/plan-review-cases.ts',  'test/helpers/llm-judge.ts', 'lib/eval-model.ts', 'test/skill-e2e-plan-decision-classification.test.ts', 'test/fixtures/plan-decision-classification.ts',  'test/helpers/ceo-split-question-policy.ts', 'test/fixtures/ceo-split-actor-6aef.json', 'test/helpers/ceo-mode-option.ts',   'test/fixtures/ceo-split-collection-0bcd.json',  'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/tasks-section.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts'],

  // /setup-gbrain Path 4 (Remote MCP) — happy + bad-token end-to-end via
  // Agent SDK. Gate-tier (deterministic stub server, fixed inputs); fires
  // when the skill template, the verify helper, the artifacts-init helper,
  // or the detect script changes.
  'setup-gbrain-remote':          ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/setup-gbrain-sandbox.ts', 'test/helpers/office-hours-attempt.ts',  'test/helpers/eval-store.ts', 'test/helpers/e2e-helpers.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'lib/eval-model.ts','setup-gbrain/sections/brain-init.md.tmpl', 'setup-gbrain/sections/claude-md-persist.md.tmpl', 'setup-gbrain/sections/manifest.json', 'test/helpers/setup-gbrain-fixture.ts', 'setup-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-mcp-verify', 'bin/gstack-artifacts-init', 'bin/gstack-gbrain-detect', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-setup-gbrain-remote.test.ts',
     'test/helpers/e2e-gate.ts'],
  'setup-gbrain-bad-token':       ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'setup-gbrain/sections/brain-init.md.tmpl', 'setup-gbrain/sections/manifest.json', 'test/helpers/setup-gbrain-fixture.ts', 'setup-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-mcp-verify', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-setup-gbrain-bad-token.test.ts',
     'test/helpers/setup-gbrain-sandbox.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/setup-gbrain-fixture-command.ts',  'bin/gstack-gbrain-detect', 'lib/gbrain-local-status.ts', 'lib/gbrain-exec.ts', 'bin/gstack-gbrain-lib.sh', 'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'test/helpers/office-hours-attempt.ts',  'test/helpers/e2e-gate.ts'],
  // v1.34.0.0 split-engine Path 4 + Step 4.5 Yes (local PGLite for code).
  // Periodic-tier per codex #12 (AgentSDK harness is non-deterministic).
  // Fires when the setup-gbrain template, install/verify/init helpers, or
  // the agent-sdk-runner harness changes.
  'setup-gbrain-path4-local-pglite': [ 'lib/memory-ingest-landing.ts', 'bin/gstack-memory-ingest.ts', 'bin/gstack-gbrain-sync.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'setup-gbrain/sections/brain-init.md.tmpl', 'setup-gbrain/sections/claude-md-persist.md.tmpl', 'setup-gbrain/sections/manifest.json', 'test/helpers/setup-gbrain-fixture.ts', 'setup-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-mcp-verify', 'bin/gstack-gbrain-install', 'bin/gstack-gbrain-detect', 'lib/gbrain-local-status.ts', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-setup-gbrain-path4-local-pglite.test.ts', 
     'test/helpers/setup-gbrain-sandbox.ts', 'lib/redact-engine.ts', 'lib/redact-patterns.ts', 'test/helpers/setup-gbrain-fixture-command.ts',  'lib/gbrain-exec.ts', 'bin/gstack-gbrain-lib.sh', 'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'test/helpers/office-hours-attempt.ts',  'test/helpers/e2e-gate.ts'],

  // AskUserQuestion format regression (RECOMMENDATION + Completeness: N/10)
  // Fires when either template OR the two preamble resolvers change.
  'plan-ceo-review-format-mode':      [  'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts', 'test/helpers/plan-format-kind-note.ts',
    'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/tasks-section.ts'
  ],
  'plan-ceo-review-format-approach':  [  'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts', 'test/helpers/plan-format-kind-note.ts',
    'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/tasks-section.ts'
  ],
  'plan-eng-review-format-coverage':  [ 
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts', 'test/helpers/plan-format-kind-note.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts' 
  ],
  'plan-eng-review-format-kind':      [ 
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/helpers/llm-judge.ts', 'test/skill-e2e-plan-format.test.ts', 'test/helpers/plan-format-kind-note.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts' 
  ],

  // v1.7.0.0 Pros/Cons format cadence + format + negative-escape evals.
  // Dependencies: same as format-mode + the 4 plan-review templates + overlay.
  // All periodic-tier (non-deterministic Opus 4.7 behavior).
  'plan-ceo-review-prosons-cadence':  [ 'test/helpers/prosons-posture.ts', 
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts',  'scripts/resolvers/tasks-section.ts'
  ],
  'plan-review-prosons-format':       [ 'test/helpers/prosons-posture.ts', 
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts',  'scripts/resolvers/tasks-section.ts'
  ],
  'plan-review-prosons-hardstop-neg': [ 'test/helpers/prosons-posture.ts',  'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts',
    'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/tasks-section.ts'
  ],
  'plan-review-prosons-neutral-neg':  [  'test/helpers/prosons-posture.ts', 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble.ts', 'model-overlays/opus-4-7.md', 'test/skill-e2e-plan-prosons.test.ts',
    'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/tasks-section.ts'
  ],

  // Expanded coverage (CT3) — 6 non-plan-review skills inherit Pros/Cons via preamble

  // /plan-tune (v1 observational)
  'plan-tune-inspect':         ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'plan-tune/**', 'scripts/question-registry.ts', 'scripts/psychographic-signals.ts', 'scripts/one-way-doors.ts', 'bin/gstack-question-log', 'bin/gstack-question-preference', 'bin/gstack-developer-profile', 'test/skill-e2e-plan-tune.test.ts'],

  // /plan-tune cathedral (T16 — 5 E2E scenarios, all gate per D12)

  // Ship
  'ship-managed-hook-refresh': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'bin/gstack-redact', 'bin/gstack-config', 'scripts/gen-skill-docs.ts',
    'test/helpers/ship-hook-actor.ts',  
    'test/helpers/workflow-excerpt.ts', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-ship-hook-refresh.test.ts',
     'test/helpers/e2e-gate.ts'],
  'ship-unmanaged-hook-consent': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'bin/gstack-redact', 'bin/gstack-config', 'scripts/gen-skill-docs.ts',
    'test/helpers/ship-hook-actor.ts',  
    'test/helpers/workflow-excerpt.ts', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-ship-hook-consent.test.ts',
     'test/helpers/e2e-gate.ts'],
  'ship-local-hook-preservation': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'bin/gstack-redact', 'bin/gstack-config', 'scripts/gen-skill-docs.ts',
    'test/helpers/ship-hook-actor.ts',  
    'test/helpers/workflow-excerpt.ts', 'test/helpers/agent-sdk-runner.ts', 'test/skill-e2e-ship-hook-consent.test.ts',
     'test/helpers/e2e-gate.ts'],
  'ship-base-branch': [ 'bin/gstack-version-bump','bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'bin/gstack-repo-mode', 'test/skill-e2e-review-attribution.test.ts',
    'scripts/resolvers/testing.ts'
  ],
  'ship-local-workflow': [ 'test/helpers/outside-voice-evidence.ts', 'bin/gstack-version-bump', 'ship/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-workflow.test.ts',
    'scripts/resolvers/testing.ts', 'test/fixtures/coverage-audit-fixture.ts', 'test/helpers/coverage-audit.ts', 'test/helpers/coverage-audit-evidence.ts', 'test/helpers/office-hours-attempt.ts'],
  'review-dashboard-via': [ 'ship/**', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'codex/**', 'autoplan/**', 'land-and-deploy/**', 'test/skill-e2e-review-attribution.test.ts',
    'scripts/resolvers/testing.ts'
  ],

  // Retro
  'retro':             ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-retro-metrics', 'retro/**', 'test/skill-e2e-retro.test.ts'],
  'retro-base-branch': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-retro-metrics', 'retro/**', 'test/skill-e2e-retro.test.ts'],

  // CSO
  'cso-full-audit':   ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'cso/**', 'lib/cso/**', 'lib/redact-engine.ts', 'lib/redact-patterns.ts',   'test/skill-e2e-cso.test.ts'],
  'cso-diff-mode':    ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'cso/**', 'lib/cso/**', 'lib/redact-engine.ts', 'lib/redact-patterns.ts',   'test/skill-e2e-cso.test.ts'],
  'cso-infra-scope':  ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'cso/**', 'lib/cso/**', 'lib/redact-engine.ts', 'lib/redact-patterns.ts',   'test/skill-e2e-cso.test.ts'],

  // Learnings
  'learnings-show': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'learn/**', 'bin/gstack-learnings-search', 'bin/gstack-learnings-log', 'scripts/resolvers/learnings.ts', 'test/skill-e2e-learnings.test.ts'],
  // W1 safety-rule evals (test/helpers/safety-rules.ts registry; E3).
  'safety-design-risk-stop': ['design-review/**', 'scripts/resolvers/browse.ts', 'scripts/resolvers/testing.ts', 'lib/aside-render.ts', 'test/skill-e2e-safety-design-risk.test.ts', 'test/helpers/browser-available.ts', 'test/helpers/aside-available.ts', 'test/helpers/safety-rules.ts', 'test/helpers/skill-fixture.ts', 'test/helpers/llm-judge.ts'],
  'safety-codex-boundary': ['scripts/resolvers/outside-voice-steps.ts', 'review/**', 'scripts/resolvers/constants.ts', 'test/skill-e2e-safety-codex-boundary.test.ts', 'test/helpers/codex-boundary-evidence.ts', 'test/helpers/safety-rules.ts', 'test/helpers/pricing.ts', 'test/helpers/e2e-gate.ts'],
  'safety-codex-consult-embed': ['codex/**', 'bin/gstack-codex-probe', 'bin/gstack-paths', 'scripts/resolve-codex-generation-model.ts', 'test/skill-e2e-safety-codex-consult.test.ts', 'test/helpers/safety-rules.ts', 'test/helpers/skill-fixture.ts'],
  'safety-ios-demo-ui-only': ['ios-qa/**', 'test/skill-e2e-safety-ios-demo.test.ts', 'test/helpers/ios-stub-state-server.ts', 'test/helpers/safety-rules.ts', 'test/helpers/skill-fixture.ts'],
  'safety-pair-agent-block': ['pair-agent/**', 'browse/src/cli.ts', 'test/skill-e2e-safety-pair-agent.test.ts', 'test/helpers/safety-rules.ts', 'test/helpers/skill-fixture.ts'],
  'safety-ship-stale-evidence': ['ship/SKILL.md.tmpl', 'ship/SKILL.md', 'bin/gstack-evidence', 'bin/gstack-wtree', 'test/skill-e2e-safety-ship-evidence.test.ts', 'test/helpers/safety-rules.ts', 'test/helpers/skill-fixture.ts', 'test/helpers/llm-judge.ts'],

  // Session Intelligence (timeline, context recovery, /context-save + /context-restore)
  'timeline-event-flow':            ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'bin/gstack-timeline-log', 'bin/gstack-timeline-read', 'test/skill-e2e-session-intelligence.test.ts'],
  'context-recovery-artifacts':     ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'scripts/resolvers/preamble.ts', 'bin/gstack-timeline-log', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'learn/**', 'test/skill-e2e-session-intelligence.test.ts', 'bin/gstack-context-recovery'],
  'context-save-writes-file':       ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'context-save/**', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'test/skill-e2e-session-intelligence.test.ts'],
  'context-restore-loads-latest':   ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'context-restore/**', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'test/skill-e2e-session-intelligence.test.ts'],

  // Context skills E2E (live-fire, Skill-tool routing path) — see
  // test/skill-e2e-context-skills.test.ts. These are periodic-tier because
  // each one spawns claude -p and costs ~$0.20-$0.40. Collectively they
  // verify the thing the /checkpoint → /context-save rename was for.
  'context-save-routing':                  [ 'context-save/**', 'scripts/resolvers/preamble.ts', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-save-then-restore-roundtrip':   ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'context-save/**', 'context-restore/**', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-restore-fragment-match':        [ 'context-restore/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-restore-provenance-order':      ['context-save/**', 'context-restore/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-restore-empty-state':           [ 'context-restore/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-restore-list-delegates':        [ 'context-restore/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-restore-legacy-compat':         [ 'context-restore/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-save-list-current-branch':      [ 'context-save/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],
  'context-save-list-all-branches':        [ 'context-save/**', 'test/skill-e2e-context-skills.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts'],

  // Document-release
  'document-release': [ 'test/helpers/outside-voice-evidence.ts', 'bin/gstack-version-bump', 'document-release/**', 'test/skill-e2e-workflow.test.ts', 'test/fixtures/coverage-audit-fixture.ts', 'test/helpers/coverage-audit.ts', 'test/helpers/coverage-audit-evidence.ts', 'test/helpers/office-hours-attempt.ts'],

  // Codex (Claude E2E — tests /codex skill via Claude)
  'codex-review': [ 'test/helpers/outside-voice-evidence.ts', 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts', 'codex/**', 'test/skill-e2e-workflow.test.ts', 'test/fixtures/coverage-audit-fixture.ts', 'test/helpers/coverage-audit.ts', 'test/helpers/coverage-audit-evidence.ts', 'test/helpers/office-hours-attempt.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts', 'scripts/resolvers/constants.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/outside-voice-steps.ts'],

  // Codex E2E (tests skills via Codex CLI + worktree)
  // E6: live Codex multi-block install (setup --host codex into a fresh CODEX_HOME; /learn's later block)
  'codex-multiblock-live': ['test/codex-e2e-multiblock-live.test.ts', 'test/helpers/codex-multiblock.ts', 'test/helpers/codex-eval.ts',
    'test/helpers/codex-session-runner.ts', 'test/helpers/hermetic-env.ts', 'setup', 'bin/gstack-bun-version.sh', 'hosts/codex.ts', 'scripts/gen-skill-docs.ts',
    'scripts/resolvers/runtime-root.ts', 'scripts/resolvers/preamble/**', 'scripts/resolvers/constants.ts', 'learn/**',
    'bin/gstack-learnings-search', 'bin/gstack-learnings-log', 'bin/gstack-slug', 'test/helpers/e2e-gate.ts'],
  // E5: design binary's default OpenAI models, live
  'design-model-smoke': ['test/skill-e2e-design-model-smoke.test.ts', 'test/helpers/e2e-gate.ts', 'design/src/models.ts',
    'design/src/receipted-fetch.ts', 'design/scripts/live-model-check.ts'],
  'codex-discover-skill':  [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts', 'setup', 'bin/gstack-bun-version.sh','codex/**', 'scripts/gen-skill-docs.ts', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts', 'test/codex-e2e.test.ts',
    'test/helpers/codex-eval.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts', 'scripts/resolvers/constants.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/outside-voice-steps.ts'
  ],
  'codex-review-findings': [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts','review/**', 'scripts/gen-skill-docs.ts', 'codex/**', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts', 'test/codex-e2e.test.ts',
    'test/helpers/codex-eval.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts', 'scripts/resolvers/constants.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/outside-voice-steps.ts'
  ],
  // Formerly keyless periodic files (W1b): registered so an edit selects its own case instead of restoring the full PR gate.
  'auq-consistency': [ 'test/skill-e2e-auq-consistency.test.ts', 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts',
    'test/helpers/auq-sdk-capture.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/llm-judge.ts', 'test/helpers/e2e-gate.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts',
    'scripts/resolvers/tasks-section.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts',
  ],
  'auq-verbose-vs-carved-ab': [ 'test/skill-e2e-auq-verbose-vs-carved-ab.test.ts', 'test/fixtures/auq-pre-cut-plan-ceo-review-SKILL.md', 'plan-ceo-review/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/preamble/generate-completeness-section.ts', 'scripts/resolvers/preamble.ts',
    'test/helpers/auq-sdk-capture.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/llm-judge.ts', 'test/helpers/e2e-gate.ts', 'lib/claude-bin.ts', 'lib/eval-model.ts',
    'scripts/resolvers/tasks-section.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts',
  ],
  'codex-recommendation-substance': [ 'test/codex-e2e-recommendation-substance.test.ts', 'codex/**', 'test/helpers/codex-session-runner.ts', 'test/helpers/llm-judge.ts', 'test/helpers/e2e-gate.ts',
    'lib/outside-review-result.ts', 'lib/gate-outcomes.ts', 'scripts/gen-skill-docs.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts'
  ],

  // Real cross-harness workflow dispatch and independent seeded-defect detection.
  'outside-voice-codex-to-claude-code': [ 'lib/gate-outcomes.ts',
    'review/**', 'claude-code/**', 'hosts/codex.ts', 'hosts/define-host.ts',
    'scripts/gen-skill-docs.ts', 'scripts/resolvers/index.ts', 'scripts/resolvers/outside-voice.ts',
    'scripts/resolvers/constants.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts',
    'bin/gstack-claude-code', 'lib/claude-code.ts', 'lib/claude-code-windows-job.ts', 'lib/claude-bin.ts', 'lib/outside-review-result.ts', 'test/helpers/codex-session-runner.ts',
    'test/helpers/skill-fixture.ts', 'test/helpers/outside-voice-fixture.ts',  'test/helpers/outside-voice-evidence.ts',   'test/fixtures/outside-async-task-m-events.json', 'test/skill-e2e-outside-voice.test.ts',
    'test/helpers/outside-voice-receipt.ts', 
     'test/helpers/e2e-gate.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts'],
  'outside-voice-claude-code-to-codex': [ 'lib/gate-outcomes.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'review/**', 'codex/**', 'hosts/claude.ts', 'hosts/define-host.ts',
    'scripts/gen-skill-docs.ts', 'scripts/resolvers/index.ts', 'scripts/resolvers/outside-voice.ts',
    'scripts/resolvers/constants.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts',
    'bin/gstack-codex-probe', 'lib/outside-review-result.ts', 'test/helpers/session-runner.ts',
     'test/fixtures/outside-background-ai.json',
    'test/helpers/skill-fixture.ts', 'test/helpers/outside-voice-fixture.ts',  'test/helpers/outside-voice-evidence.ts',   'test/fixtures/outside-async-task-m-events.json', 'test/skill-e2e-outside-voice.test.ts', 'test/helpers/codex-session-runner.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/outside-voice-receipt.ts', 'scripts/resolve-codex-generation-model.ts'],

  // Disabled means no extra plan review, including a native Agent fallback.
  'outside-plan-disabled-no-fallback': [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/fixtures/disabled-retained-record.json',
    'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",
     "test/fixtures/disabled-dated-record-at.json",
    'plan-eng-review/**', 'plan-ceo-review/**', 'hosts/claude.ts', 'hosts/define-host.ts',
    'scripts/gen-skill-docs.ts', 'scripts/resolvers/index.ts', 'scripts/resolvers/sections.ts',
    'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/constants.ts',
    'bin/gstack-config', 'bin/gstack-codex-probe', 'bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'bin/gstack-wtree', 'bin/gstack-brain-enqueue', 'test/helpers/session-runner.ts',
    'test/helpers/hermetic-env.ts', 'test/helpers/skill-fixture.ts', 'test/helpers/outside-voice-evidence.ts',
    'test/helpers/disabled-plan-review-fixture.ts', 
    'test/skill-e2e-outside-plan-disabled.test.ts', 'test/fixtures/disabled-plan-attribution-ad-v2.json',
    "test/fixtures/disabled-historical-line-aq.json",

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts", 'test/helpers/e2e-gate.ts', 'scripts/resolve-codex-generation-model.ts'],

  // GPT-5.6 Sol scope-termination E2E (Codex CLI, full generated investigate skill)
  'codex-sol-scope-termination': ['model-overlays/gpt-5.6-sol.md', 'scripts/models.ts', 'scripts/resolvers/model-overlay.ts', 'scripts/resolvers/preamble/**', 'investigate/**', 'test/helpers/codex-session-runner.ts', 'test/codex-e2e-sol-scope.test.ts',
    'test/helpers/codex-eval.ts', 'test/helpers/sol-skill-fixture.ts', 'bin/gstack-codex-probe', 'scripts/resolve-codex-generation-model.ts', 'scripts/resolvers/constants.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/outside-voice-steps.ts', 'bin/gstack-context-recovery'
  ],

  // Gemini E2E — smoke test only (Gemini gets lost in worktrees on complex tasks)


  // Coverage audit (shared fixture) + triage + gates
  'ship-coverage-audit': [ 'test/helpers/outside-voice-evidence.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', "test/fixtures/coverage-audit-aw.json",

    
    "test/fixtures/coverage-checkbox-tail-av.json",
    'test/helpers/coverage-audit-evidence.ts',
    
    'test/fixtures/ship-coverage-audit-af.json','ship/**', 'test/fixtures/coverage-audit-fixture.ts', 'bin/gstack-repo-mode', 'test/skill-e2e-workflow.test.ts',
     "test/fixtures/coverage-shell-display-aq.json", "test/fixtures/coverage-audit-sed-context.json",
    'test/helpers/coverage-audit.ts', 'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/testing.ts'
  ],
  'review-coverage-audit': [
    'test/fixtures/coverage-audit-ci-diagrams.json',
    
    "test/fixtures/coverage-audit-aw.json",

    
    "test/fixtures/coverage-checkbox-tail-av.json",
     "test/fixtures/coverage-audit-shell-legend-at.json",'review/**', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-coverage-audit.test.ts', 'test/helpers/coverage-audit-evidence.ts',  'test/fixtures/coverage-audit-ae.json',  'test/fixtures/coverage-audit-af.json',
     "test/fixtures/coverage-shell-display-aq.json", "test/fixtures/coverage-audit-sed-context.json",
     "test/fixtures/coverage-diagram-legend-as.json",
    'test/helpers/coverage-audit.ts', 'test/helpers/office-hours-attempt.ts' 
  ],
  // Test value bar behavior (weak paths, low-value findings, report-only sweep)
  'ship-coverage-value': ['ship/**', 'scripts/resolvers/testing.ts', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-test-value.test.ts', 'test/helpers/test-value-fixture.ts', 'scripts/resolvers/test-value.ts', 'test/helpers/office-hours-attempt.ts', 'lib/eval-model.ts'],
  'review-test-value': ['review/**', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-test-value.test.ts', 'test/helpers/test-value-fixture.ts', 'scripts/resolvers/test-value.ts', 'test/helpers/office-hours-attempt.ts', 'lib/eval-model.ts'],
  'test-audit-report-only': ['test-audit/**', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-test-value.test.ts', 'test/helpers/test-value-fixture.ts', 'scripts/resolvers/test-value.ts', 'test/helpers/office-hours-attempt.ts', 'lib/eval-model.ts'],
  'plan-eng-coverage-audit': [
    'scripts/resolvers/learnings.ts',
    'test/fixtures/coverage-audit-ci-diagrams.json',
    
    "test/fixtures/coverage-audit-aw.json",

    
    "test/fixtures/coverage-checkbox-tail-av.json",
    
    "test/fixtures/plan-scope-recovery-av.json",
     "test/fixtures/coverage-audit-shell-legend-at.json", 'plan-eng-review/**', 'test/fixtures/coverage-audit-fixture.ts', 'test/skill-e2e-coverage-audit.test.ts', 'test/helpers/coverage-audit-evidence.ts',  'test/fixtures/coverage-audit-ae.json',  'test/fixtures/coverage-audit-af.json',
     "test/fixtures/coverage-shell-display-aq.json", "test/fixtures/coverage-audit-sed-context.json",
     "test/fixtures/coverage-diagram-legend-as.json",

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'test/helpers/coverage-audit.ts', 'test/helpers/office-hours-attempt.ts',  'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts' 
  ],
  'ship-triage': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'bin/gstack-repo-mode', 'test/skill-e2e-triage.test.ts', 'test/helpers/ship-triage-labels.ts',
    'scripts/resolvers/testing.ts'
  ],
  'ship-docsync-completion': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/docsync-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/gen-skill-docs.ts', 'scripts/resolvers/testing.ts', 'test/helpers/qa-checkpoint-evidence.ts',    'test/helpers/qa-functional-observer.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-fixture.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-current': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/docsync-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/gen-skill-docs.ts', 'scripts/resolvers/testing.ts', 'test/helpers/qa-checkpoint-evidence.ts',    'test/helpers/qa-functional-observer.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-fixture.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-failure': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/docsync-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/gen-skill-docs.ts', 'scripts/resolvers/testing.ts', 'test/helpers/qa-checkpoint-evidence.ts',    'test/helpers/qa-functional-observer.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-fixture.ts', 'bin/gstack-context-recovery'],
  'ship-docsync-store': ['bin/gstack-docs-candidate', 'bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/**', 'document-release/**', 'test/skill-e2e-ship-docsync.test.ts', 'test/helpers/docsync-*.ts', 'test/helpers/session-runner.ts', 'test/helpers/hermetic-env.ts', 'bin/gstack-skill-start', 'bin/gstack-session-kind', 'scripts/resolvers/sections.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/gen-skill-docs.ts', 'scripts/resolvers/testing.ts', 'test/helpers/qa-checkpoint-evidence.ts',    'test/helpers/qa-functional-observer.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-fixture.ts', 'bin/gstack-context-recovery'],
  // #2733 behavioral proof: the JSON contract survives a firing gate inside a
  // spawned-marked subagent. Deps name every behavior under test — the
  // session-kind override, the skill-start gates, both hooks + the shared
  // directive, and the AUQ prose rule — so changing any of them selects it.
  'docsync-spawned': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'ship/sections/pr-body.md',
    'document-release/**',
    'ship/sections/documentation.md',
    'ship/sections/documentation.md.tmpl',
    'test/helpers/docsync-*.ts',
    'bin/gstack-session-kind',
    'bin/gstack-skill-start',
    'hosts/claude/hooks/question-preference-hook.ts', 'lib/bin-context.ts', 'lib/remote-identity.ts',
    'hosts/claude/hooks/auq-error-fallback-hook.ts',
    'hosts/claude/hooks/spawned-directive.ts',
    'scripts/resolvers/preamble/generate-ask-user-format.ts',
    'test/skill-e2e-docsync-spawned.test.ts', 'test/helpers/qa-checkpoint-evidence.ts',    'test/helpers/qa-functional-observer.ts',  'test/helpers/e2e-gate.ts', 'test/helpers/qa-evidence-producer.ts', 'test/helpers/qa-functional-fixture.ts', 'hosts/claude/hooks/hook-log.ts', 'bin/gstack-context-recovery'],

  // Design
  'design-consultation-core':       [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts', 'bin/gstack-codex-probe', 'design/src/variants.ts', 'design-consultation/**', 'lib/design-catalog.ts', 'lib/design-md.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/llm-judge.ts', 'test/skill-e2e-design.test.ts', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'design-consultation/sections/**',  'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-consultation-existing':   [ 'design-consultation/**', 'lib/design-md.ts', 'bin/gstack-design-md.ts', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-consultation-research':   [ 'design-consultation/**', 'scripts/resolvers/aside.ts', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts', 'test/helpers/skill-fixture.ts',  'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'design-consultation/sections/**',  'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-consultation-preview':    [ 'design/src/variants.ts', 'design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts',  'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'plan-design-review-no-ui-scope': [
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json",'plan-design-review/**', 'lib/design-catalog.ts', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-review-fix':              ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'design-review/**', 'scripts/resolvers/aside.ts', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'lib/design-catalog.ts', 'browse/src/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-design.test.ts',
    'scripts/resolvers/testing.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/fake-impeccable.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  // Design detector (user-installed impeccable engine) through the fake engine shim: source mode on a diff and DOM mode on a served page.
  'design-review-detector-shim':    ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'design-review/**', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'lib/design-catalog.ts', 'lib/design-detect-contract.ts', 'lib/dom-dump-script.ts', 'lib/dom-dump.js', 'bin/gstack-design-detect.ts', 'test/helpers/fake-impeccable.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/impeccable-detect-sample.json', 'test/fixtures/review-eval-design-slop.*', 'test/skill-e2e-design.test.ts',
    'scripts/resolvers/testing.ts', 'test/helpers/aside-available.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-review-detector-shim-dom': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'design-review/**', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'lib/design-detect-contract.ts', 'lib/dom-dump-script.ts', 'lib/dom-dump.js', 'bin/gstack-design-detect.ts', 'browse/src/**', 'test/helpers/fake-impeccable.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/impeccable-detect-sample.json', 'test/fixtures/review-eval-design-slop.*', 'test/skill-e2e-design.test.ts',
    'scripts/resolvers/testing.ts', 'test/helpers/aside-available.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-review-plugin-handoff': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'design-review/**', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/testing.ts', 'lib/design-catalog.ts', 'lib/design-detect-contract.ts', 'bin/gstack-design-detect.ts', 'test/helpers/hermetic-env.ts', 'test/helpers/fake-impeccable.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/impeccable-detect-sample.json', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/skill-e2e-design.test.ts', 'test/helpers/aside-available.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],
  'design-html-slop-gate':          ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'design-html/**', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'lib/design-detect-contract.ts', 'bin/gstack-design-detect.ts', 'test/helpers/fake-impeccable.ts', 'test/fixtures/fake-impeccable.ts', 'test/fixtures/impeccable-detect-sample.json', 'test/skill-e2e-design.test.ts', 'test/fixtures/review-eval-design-slop.html', 'test/fixtures/review-eval-design-slop.css', 'test/helpers/aside-available.ts', 'test/helpers/llm-judge.ts', 'test/helpers/office-hours-attempt.ts'],

  // /diagram (diagram-render bundle consumers). Triplet = deterministic
  // functional (gate); authoring quality = LLM-judged benchmark (periodic).
  // Both render the triplet through gstack-render (lib/aside-render.ts +
  // bin/gstack-render.ts): Aside when it is running, the browse daemon
  // otherwise — so both engines are deps. Triplet = deterministic functional
  // (gate); authoring quality = LLM-judged benchmark (periodic).
  'diagram-triplet':            ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'diagram/**', 'lib/diagram-render/**', 'lib/aside-render.ts', 'bin/gstack-render.ts', 'test/helpers/aside-available.ts', 'browse/src/**', 'test/skill-e2e-diagram.test.ts', 'test/helpers/llm-judge.ts'],
  'diagram-authoring-quality':  ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'diagram/**', 'lib/diagram-render/**', 'lib/aside-render.ts', 'bin/gstack-render.ts', 'test/helpers/aside-available.ts', 'browse/src/**', 'test/helpers/llm-judge.ts', 'test/skill-e2e-diagram.test.ts'],

  // gstack-upgrade
  'gstack-upgrade-happy-path': [ 'test/helpers/outside-voice-evidence.ts', 'setup', 'bin/gstack-bun-version.sh', 'bin/gstack-relink', 'bin/gstack-session-update', 'gstack-upgrade/**', 'test/skill-e2e-workflow.test.ts', 'test/fixtures/coverage-audit-fixture.ts', 'test/helpers/coverage-audit.ts', 'test/helpers/coverage-audit-evidence.ts', 'test/helpers/office-hours-attempt.ts'],

  // Deploy skills
  'land-and-deploy-workflow':      [ 'bin/gstack-version-bump', 'land-and-deploy/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-deploy.test.ts'],
  'land-and-deploy-first-run':     ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'land-and-deploy/**', 'scripts/gen-skill-docs.ts', 'bin/gstack-slug', 'bin/gstack-remote-identity.sh', 'test/skill-e2e-deploy.test.ts'],
  'land-and-deploy-review-gate':   ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'land-and-deploy/**', 'bin/gstack-review-read', 'test/skill-e2e-deploy.test.ts'],
  'canary-workflow':               ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'canary/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'test/skill-e2e-deploy.test.ts'],
  'benchmark-workflow':            ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'benchmark/**', 'scripts/resolvers/aside.ts', 'browse/src/**', 'test/skill-e2e-deploy.test.ts'],
  'setup-deploy-workflow':         [ 'setup-deploy/**', 'scripts/gen-skill-docs.ts', 'test/skill-e2e-deploy.test.ts'],


  // Autoplan
  'autoplan-dual-voice': [ 'lib/outside-review-result.ts', 'lib/gate-outcomes.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'test/helpers/hermetic-env.ts',
    'test/helpers/autoplan-dual-voice-evidence.ts', 
    'test/fixtures/autoplan-dual-false-positive-6bd.json',
    'test/helpers/autoplan-method-read-audit.ts', 
    'test/fixtures/autoplan-method-read-aa-events.json',
    'test/helpers/outside-voice-evidence.ts',  
    'test/fixtures/outside-async-task-m-events.json',
     'test/fixtures/autoplan-amend-input-77.json',
     'test/fixtures/autoplan-phase-handoff-6714.json','scripts/resolvers/learnings.ts', 'scripts/resolvers/preamble/generate-completion-status.ts', 'scripts/resolvers/preamble/generate-preamble-bash.ts',  'test/fixtures/plan-scope-recovery-av.json',   'test/fixtures/design-scope-checkpoint-at.json',  'scripts/resolvers/composition.ts',   'autoplan/**', 'lib/claude-journal-records.ts', 'lib/claude-owned-journal.ts', 'codex/**', 'bin/gstack-codex-probe', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/design.ts', 'test/skill-e2e-autoplan-dual-voice.test.ts', 'bin/gstack-autoplan-snapshot.ts',    'test/fixtures/autoplan/t-ceo-omitted-obligations.json', 'test/fixtures/autoplan/u-ceo-original-loss.json', 'test/fixtures/autoplan/v-ceo-dangling-references.json',
    'scripts/resolvers/design-doc-discovery.ts', 'bin/gstack-design-doc-find', 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**', 'plan-devex-review/**', 'scripts/resolvers/testing.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts',  'scripts/resolvers/tasks-section.ts', 'test/helpers/autoplan-phase-observer.ts', 'scripts/resolve-codex-generation-model.ts', 'scripts/resolvers/constants.ts'],

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
    'test/skill-e2e-skillify.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts', 'test/helpers/skill-body-narration.ts'
  ],
  'scrape-prototype-path': [
    'scrape/**', 'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
    'test/skill-e2e-skillify.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts', 'test/helpers/skill-body-narration.ts'
  ],
  'skillify-happy-path': [
    'skillify/**', 'scrape/**', 'browse/src/browser-skill-write.ts',
    'browse/src/browser-skills.ts', 'browse/src/browser-skill-commands.ts',
    'test/skill-e2e-skillify.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts', 'test/helpers/skill-body-narration.ts'
  ],
  'skillify-provenance-refusal': [
    'skillify/**', 'browse/src/browser-skill-write.ts',
    'test/skill-e2e-skillify.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts', 'test/helpers/skill-body-narration.ts'
  ],
  'skillify-approval-reject': [
    'skillify/**', 'scrape/**', 'browse/src/browser-skill-write.ts',
    'test/skill-e2e-skillify.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts', 'test/helpers/skill-body-narration.ts'
  ],

  // Skill routing — journey-stage tests (depend on ALL skill descriptions)
  'journey-ideation':       [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-plan-eng':       [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-debug':          [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-qa':             [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-code-review':    [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-ship':           [ 'bin/gstack-version-bump',
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-docs':           [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-retro':          [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-design-system':  [ 'design/src/variants.ts',
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
  'journey-visual-qa':      [
    
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],

  // Opus 4.7 behavior evals — keys match testName: values in the test file.
  // Routing sub-tests use template literal `routing-${c.name}` testNames,
  // which the touchfile completeness scanner skips; they inherit selection
  // from the file-level touchfile entry via GLOBAL_TOUCHFILES.

  // Overlay efficacy harness (SDK) — measures whether overlay nudges change
  // behavior under @anthropic-ai/claude-agent-sdk (closer to real Claude Code
  // than `claude -p`). testNames in the file are template literals so the
  // completeness scanner doesn't require them; these entries exist for
  // diff-based selection accuracy.

  // /ios-qa — agent flow E2E. Daemon + stub StateServer + codegen
  // exercised end-to-end. The no-device path is gate-tier; the with-device
  // path requires GSTACK_HAS_IOS_DEVICE=1 and is periodic-tier.
  // Swift-build invariant test — requires the Swift toolchain. Compiles the
  // fixture SPM package + runs the XCTest suite that validates the real
  // Swift StateServer implementation (loopback bind, boot token rotation,
  // session lock). Periodic-tier — Swift build is heavier than TS unit tests.
  // Real-device path — only runs with GSTACK_HAS_IOS_DEVICE=1 + a paired
  // iPhone. Validates the CoreDevice agent + iOS SDK toolchain. Periodic-tier.
  'ios-qa-device':    ['ios-qa/templates/**', 'test/fixtures/ios-qa/FixtureApp/**', 'test/skill-e2e-ios-device.test.ts'],

  // /spec end-to-end via PTY — exercises the full Phase 1→5 pipeline
  // including --execute spawn. Periodic-tier — paid + non-deterministic.

  // /office-hours brain-writeback path under fake gbrain CLI (v1.50.0.0
  // T7). Drives /office-hours with a regenerated SKILL.md that has the
  // compressed GBRAIN_SAVE_RESULTS block + a fake gbrain on PATH; asserts
  // the agent calls `gbrain put office-hours/<slug>` with valid YAML
  // frontmatter. Touched by anything that changes resolver output, gen
  // pipeline, detection helper, refresh subcommand, or the on-demand
  // docs the resolver points to.
  'office-hours-brain-writeback': [ 'lib/memory-ingest-landing.ts', 'bin/gstack-memory-ingest.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'office-hours/sections/**',
    'scripts/resolvers/gbrain.ts',
    'scripts/gen-skill-docs.ts',
    'bin/gstack-gbrain-detect',
    'bin/gstack-config',
    'office-hours/SKILL.md.tmpl',
    'docs/gbrain-write-surfaces.md',
    'test/fixtures/office-hours-brain-writeback/**',
    'test/skill-e2e-office-hours-brain-writeback.test.ts',
    'test/helpers/office-hours-attempt.ts'  
  ],

  // gbrain CLI real round-trip against a local PGLite store (v1.50.0.0
  // T11). Proves the gbrain CLI persistence contract gstack relies on —
  // a `gbrain put` followed by `gbrain get` returns the body. Skips if
  // VOYAGE_API_KEY is unset OR gbrain CLI not on PATH. Touched by the
  // resolver (which emits the CLI shape) and the test itself.
  'gbrain-roundtrip-local': [ 'lib/memory-ingest-landing.ts', 'bin/gstack-memory-ingest.ts', 'bin/gstack-gbrain-sync.ts',
    'scripts/resolvers/gbrain.ts',
    'test/skill-e2e-gbrain-roundtrip-local.test.ts'
  ],
  'sync-gbrain-read-ready': [ 'lib/memory-ingest-landing.ts', 'bin/gstack-memory-ingest.ts', 'bin/gstack-gbrain-sync.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'sync-gbrain/SKILL.md.tmpl', 'sync-gbrain/SKILL.md', 'bin/gstack-gbrain-read-capability.ts', 'lib/gbrain-exec.ts', 'test/helpers/sync-gbrain-readiness-fixture.ts', 'test/helpers/sync-gbrain-readiness-verdict.ts', 'test/skill-e2e-sync-gbrain-readiness.test.ts', 'test/helpers/e2e-gate.ts'],
  'sync-gbrain-read-unknown': [ 'lib/memory-ingest-landing.ts', 'bin/gstack-memory-ingest.ts', 'bin/gstack-gbrain-sync.ts','bin/gstack-state-root.sh', 'lib/state-root.ts', 'sync-gbrain/SKILL.md.tmpl', 'sync-gbrain/SKILL.md', 'bin/gstack-gbrain-read-capability.ts', 'lib/gbrain-exec.ts', 'test/helpers/sync-gbrain-readiness-fixture.ts', 'test/helpers/sync-gbrain-readiness-verdict.ts', 'test/skill-e2e-sync-gbrain-readiness.test.ts', 'test/helpers/e2e-gate.ts'],

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
    'ship/SKILL.md', 'test/helpers/e2e-gate.ts'],
  'arm-benchmark-crud-endpoint': [
    'scripts/resolvers/preamble/generate-search-before-building.ts',
    'scripts/resolvers/preamble/generate-voice-directive.ts',
    'test/fixtures/arm-benchmark/**',
    'test/helpers/llm-judge.ts',
    'test/helpers/arm-benchmark-harness.ts',
    'test/skill-e2e-arm-benchmark.test.ts',
    'ship/SKILL.md', 'test/helpers/e2e-gate.ts'],
  'arm-benchmark-bugfix-decoys': [
    'scripts/resolvers/preamble/generate-search-before-building.ts',
    'scripts/resolvers/preamble/generate-voice-directive.ts',
    'test/fixtures/arm-benchmark/**',
    'test/helpers/llm-judge.ts',
    'test/helpers/arm-benchmark-harness.ts',
    'test/skill-e2e-arm-benchmark.test.ts',
    'ship/SKILL.md', 'test/helpers/e2e-gate.ts'],

  'office-hours-section-loading': [ 'office-hours/**', 'bin/gstack-office-hours-review', 'lib/office-hours-review.ts', 'lib/fs-atomic.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/carve-guards.ts', 'test/helpers/auq-sdk-capture.ts',  'test/helpers/office-hours-completion.ts', 'test/helpers/llm-judge.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-office-hours-section-loading.test.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'office-hours-design-draft': [ 'office-hours/**', 'lib/office-hours-review.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/sections.ts', 'scripts/gen-skill-docs.ts', 'test/helpers/carve-guards.ts', 'test/helpers/auq-sdk-capture.ts',  'test/helpers/office-hours-completion.ts', 'test/helpers/llm-judge.ts', 'test/helpers/session-runner.ts', 'test/skill-e2e-office-hours-design-draft.test.ts', 'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts', 'test/helpers/auto-decision-state.ts', 'test/helpers/autoplan-artifact-digest.ts', 'test/helpers/autoplan-artifact-permission.ts', 'test/helpers/autoplan-artifact-recorder.ts', 'test/helpers/capture-parity-baseline.ts', 'test/helpers/claude-pty-runner.ts', 'test/helpers/pty/**', 'test/helpers/dx-selected-navigation.ts', 'test/helpers/e2e-gate.ts', 'test/helpers/eng-cache-writer-decision.ts', 'test/helpers/hermetic-skill-runtime.ts', 'test/helpers/native-auto-decide.ts', 'test/helpers/owned-claude-transcript.ts', 'test/helpers/parity-harness.ts', 'test/helpers/plan-count-artifacts.ts', 'test/helpers/plan-count-file-permission.ts', 'test/helpers/plan-count-fixture.ts', 'test/helpers/plan-count-pending-exit.ts', 'test/helpers/plan-count-pending-question.ts', 'test/helpers/plan-count-transcript.ts', 'test/helpers/plan-floor-review.ts', 'test/helpers/plan-floor-target.ts', 'test/helpers/plan-scope-selection.ts', 'test/helpers/plan-seed-submission.ts', 'test/helpers/plan-skill-question-events.ts', 'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/plan-skill-questions.ts', 'test/helpers/pty-screen.ts', 'test/helpers/pty-trust-dialog.ts', 'test/helpers/skill-census.ts'],
  'plan-devex-peer-comparison-classification': [
    
    
'test/skill-e2e-plan-devex-peer-comparison-classification.test.ts', 'test/fixtures/devex-peer-comparison-classification.ts',  'test/helpers/plan-review-decisions.ts',  'test/helpers/plan-review-cases.ts',  'test/helpers/llm-judge.ts', 'lib/eval-model.ts', 'test/helpers/e2e-helpers.ts', 'test/helpers/eval-store.ts', 'test/helpers/eval-budgets.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'docs/askuserquestion-split.md', 'plan-devex-review/SKILL.md.tmpl', 'plan-devex-review/sections/review-sections.md.tmpl'],
  'plan-decision-classification': [
    
    
'test/skill-e2e-plan-decision-classification.test.ts', 'test/fixtures/plan-decision-classification.ts',  'test/helpers/plan-review-decisions.ts',  'test/helpers/plan-review-cases.ts',  'test/helpers/llm-judge.ts', 'lib/eval-model.ts', 'test/helpers/e2e-helpers.ts', 'test/helpers/eval-store.ts', 'test/helpers/eval-budgets.ts', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'docs/askuserquestion-split.md', 'plan-ceo-review/SKILL.md.tmpl', 'plan-ceo-review/sections/review-sections.md.tmpl', 'scripts/resolvers/tasks-section.ts'],
  'health-reporting': ['health/**', 'test/skill-e2e-health.test.ts', 'test/helpers/health-eval-fixture.ts', 'test/helpers/e2e-gate.ts'],
  'overlay-harness-claude-dedicated-tools-vs-bash': ['model-overlays/**', 'test/fixtures/overlay-nudges.ts', 'test/helpers/agent-sdk-runner.ts',  'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash.test.ts', 'test/helpers/overlay-measurement.ts', 'test/helpers/overlay-workspace.ts', 'test/helpers/overlay-attempt.ts',  'test/helpers/overlay-case.ts', 'test/helpers/overlay-case-policy.ts', 'test/helpers/overlay-lifecycle.ts',     'test/fixtures/overlay-admission-child.ts', 'test/helpers/e2e-gate.ts'],
  'overlay-harness-opus-4-7-effort-match-trivial': ['model-overlays/**', 'test/fixtures/overlay-nudges.ts', 'test/helpers/agent-sdk-runner.ts',  'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-overlay-harness-opus-4-7-effort-match-trivial.test.ts', 'test/helpers/overlay-measurement.ts', 'test/helpers/overlay-workspace.ts', 'test/helpers/overlay-attempt.ts',  'test/helpers/overlay-case.ts', 'test/helpers/overlay-case-policy.ts', 'test/helpers/overlay-lifecycle.ts',     'test/fixtures/overlay-admission-child.ts', 'test/helpers/e2e-gate.ts'],
  'overlay-harness-opus-4-7-literal-interpretation': ['model-overlays/**', 'test/fixtures/overlay-nudges.ts', 'test/helpers/agent-sdk-runner.ts',  'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-overlay-harness-opus-4-7-literal-interpretation.test.ts', 'test/helpers/overlay-measurement.ts', 'test/helpers/overlay-workspace.ts', 'test/helpers/overlay-attempt.ts',  'test/helpers/overlay-case.ts', 'test/helpers/overlay-case-policy.ts', 'test/helpers/overlay-lifecycle.ts',     'test/fixtures/overlay-admission-child.ts', 'test/helpers/e2e-gate.ts'],
  'overlay-harness-claude-dedicated-tools-vs-bash-sonnet': ['model-overlays/**', 'test/fixtures/overlay-nudges.ts', 'test/helpers/agent-sdk-runner.ts',  'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash-sonnet.test.ts', 'test/helpers/overlay-measurement.ts', 'test/helpers/overlay-workspace.ts', 'test/helpers/overlay-attempt.ts',  'test/helpers/overlay-case.ts', 'test/helpers/overlay-case-policy.ts', 'test/helpers/overlay-lifecycle.ts',     'test/fixtures/overlay-admission-child.ts', 'test/helpers/e2e-gate.ts'],
  'overlay-harness-claude-dedicated-tools-vs-bash-opus-5-5': ['model-overlays/**', 'test/fixtures/overlay-nudges.ts', 'test/helpers/agent-sdk-runner.ts',  'scripts/resolvers/model-overlay.ts', 'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash-opus-5-5.test.ts', 'test/helpers/overlay-measurement.ts', 'test/helpers/overlay-workspace.ts', 'test/helpers/overlay-attempt.ts',  'test/helpers/overlay-case.ts', 'test/helpers/overlay-case-policy.ts', 'test/helpers/overlay-lifecycle.ts',     'test/fixtures/overlay-admission-child.ts', 'test/helpers/e2e-gate.ts'],
  'journey-negatives':      [
    

    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json", '*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-routing-e2e.test.ts', 'bin/gstack-skill-start', 'test/helpers/shipped-skill-routing.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts"
  ],
};

/**
 * E2E test tiers — 'gate' blocks PRs, 'periodic' runs weekly/on-demand,
 * 'marathon' keeps full start-to-finish flows in a non-blocking lane only.
 * Must have exactly the same keys as E2E_TOUCHFILES.
 */
export const E2E_TIERS: Record<string, 'gate' | 'periodic' | 'marathon'> = {
  'ship-skipped-queued-finding': 'gate',
  'investigate-owned-completion': 'gate',
  'investigate-owned-abort': 'gate',
  'investigate-owned-ending-error': 'gate',
  'shared-libs-review-path-eligibility': 'gate',
  'shared-libs-review-index-flags': 'gate',
  'shared-libs-review-prior-coverage': 'gate',
  'shared-libs-codex-read-only': 'periodic',
  'shared-libs-read-only': 'gate',
  'shared-libs-unsupported-git': 'gate',
  'shared-libs-review-lifecycle': 'gate',
  'shared-libs-review-revalidation': 'gate',
  'shared-libs-opportunity-judgment': 'periodic',
  'shared-libs-pr-coverage': 'periodic',
  'shared-libs-plan-callers': 'periodic',
  // Browse core — gate (if browse breaks, everything breaks)
  'browse-basic': 'gate',
  'browse-snapshot': 'gate',

  // Aside-driven browsing — periodic (external app: the Aside browser; the
  // file self-gates on 'periodic' and skips without a live Aside)
  'aside-browse-basic': 'periodic',
  'aside-browse-flow': 'periodic',
  'aside-qa-quick': 'periodic',
  'aside-scrape-json': 'periodic',
  'aside-canary-quick': 'periodic',

  // Hermetic isolation — gate (deterministic env/config assertions; if the
  // clean room breaks, every other eval's signal is contaminated)
  'hermetic-canary': 'gate',
  'hermetic-sentinel': 'gate',
  'autoplan-journal-drift': 'periodic',
  'autoplan-schema-canary': 'periodic',
  'autoplan-guard-pty': 'gate',
  'autoplan-long-session': 'periodic',

  // SKILL.md setup — gate (if setup breaks, no skill works)
  'skillmd-setup-discovery': 'gate',
  'skillmd-no-local-binary': 'gate',
  'skillmd-outside-git': 'gate',
  'operational-learning': 'gate',

  // P4 first-run scaffold — periodic (onboarding, non-safety, model-touched marker)

  // QA — gate for functional, periodic for quality/benchmarks
  'qa-quick': 'gate',
  'qa-b6-static': 'periodic',
  'qa-b7-spa': 'periodic',
  'qa-b8-checkout': 'periodic',
  'qa-only-no-fix': 'gate',     // CRITICAL guardrail: Edit tool forbidden
  'qa-fix-loop': 'periodic',
  'qa-bootstrap': 'gate',
  'review-exploratory-small-cli': 'gate',
  'ship-exploratory-small-cli': 'gate',
  'ship-exploratory-unavailable': 'gate',
  'ship-exploratory-plan-checks': 'gate',
  'ship-exploratory-late-input': 'gate',
  'qa-functional-cli-report': 'gate',
  'qa-functional-webhook-report': 'gate',
  'qa-functional-cli-fix': 'gate',
  'qa-functional-webhook-fix': 'gate',

  // Review — gate for functional/guardrails, periodic for quality
  'review-sql-injection': 'gate',     // Security guardrail
  'review-enum-completeness': 'gate',
  'review-base-branch': 'gate',
  'review-gate-integrity': 'gate',    // Gate findings reach the human; never auto-fixed
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
  // Brain-writeback E2E — periodic per cost (claude -p) + non-deterministic
  // (model interprets the gbrain instruction). Matches nearby
  // setup-gbrain-path4-* tier classification.
  'office-hours-brain-writeback': 'periodic',
  // GBrain CLI round-trip — periodic per Voyage embedding cost (~$0.001/run)
  // and external-API-dependency (skips cleanly if VOYAGE_API_KEY unset).
  'gbrain-roundtrip-local': 'periodic',
  'sync-gbrain-read-ready': 'periodic',
  'sync-gbrain-read-unknown': 'periodic',
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
  'plan-ceo-review-expansion-energy': 'periodic',  // Demoted from gate (2026-08 audit): Opus generator + subjective 2-axis >=4/5 LLM-judge threshold in the merge lane — the exact class siblings were demoted for (a +21-line preamble change once flipped the score). CLAUDE.md's own rule: Opus model test -> periodic.
  'plan-eng-review': 'periodic',
  'plan-eng-review-artifact': 'periodic',  // Checkpoint: resumes at Test review from a real Scope Challenge ledger
  'plan-eng-review-artifact-full': 'marathon',  // Full fresh /plan-eng-review through Test review (498 s pass; 595 s timeouts at 600 s before Test review)
  'plan-eng-coverage-audit': 'gate',
  'ship-coverage-value': 'gate',
  'review-test-value': 'gate',
  'test-audit-report-only': 'gate',
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
  'plan-design-review-plan-mode-smoke': 'periodic',
  'plan-devex-review-plan-mode': 'gate',
  'plan-mode-no-op': 'gate',
  // v1.21+ auto-mode regression tests
  'office-hours-auto-mode': 'gate',
  'auto-decide-preserved': 'periodic',

  // Real-PTY E2E batch — tier classification:
  //   gate: cheap, deterministic, run on every PR
  //   periodic: long-running or expensive (>$3/run), run weekly
  'auq-format-gate':                         'gate',       // ~$0.50/run, native SDK question capture, single skill probe
  'plan-ceo-mode-routing':     'periodic',   // ~$3/run, deep navigation through 8-12 prior AskUserQuestions
  'plan-design-with-ui-scope': 'gate',       // ~$0.80/run
// ~$3/run, real /ship in plan mode
  'tpa-present':               'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-absent-linux':          'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-broken':                'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-absent-darwin':         'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts
  'tpa-apple-ban':             'gate',       // consent/credential safety guardrail; deterministic shims + grep asserts

  'ship-measure-seeded-flake': 'periodic', // free stub evals; real /ship measure loop (A6)
  'ship-section-loading':      'periodic',   // ~$3/run, real /ship; asserts section reads
  'plan-ceo-section-loading':  'periodic',   // ~$3-5/run, real /plan-ceo-review; asserts section read
  'carve-section-loading-browse': 'periodic',
  'carve-section-loading-codex': 'periodic',
  'carve-section-loading-design-consultation': 'periodic',
  'carve-section-loading-design-html': 'periodic',
  'carve-section-loading-design-shotgun': 'periodic',
  'carve-section-loading-document-release': 'periodic',
  'carve-section-loading-land-and-deploy': 'periodic',
  'carve-section-loading-plan-design-review': 'periodic',
  'carve-section-loading-plan-devex-review': 'periodic',
  'carve-section-loading-plan-eng-review': 'periodic',
  'carve-section-loading-qa': 'periodic',
  'carve-section-loading-retro': 'periodic',
  'carve-section-loading-review': 'periodic',
  'carve-section-loading-setup-gbrain': 'periodic',
  'carve-section-loading-spec': 'periodic',
// ~$8/run, full native CEO → Design → DX → Eng sequence; outside disabled

  // Per-finding count + review-report-at-bottom — periodic because each
  // run drives a full skill end-to-end (~25 min, ~$5/run). Sequential
  // execution during calibration; concurrent opt-in only after measured
  // comparison agrees (plan §D15).
  'plan-eng-finding-floor':    'periodic',  // stochastic ask-first (see plan-mode-handshake note); periodic
  'plan-ceo-finding-floor':    'gate',
  'plan-design-finding-floor': 'periodic',  // stochastic ask-first (see plan-mode-handshake note); periodic
  'plan-devex-finding-floor':  'gate',
  'plan-eng-multi-finding-batching': 'periodic',
  'plan-ceo-split-overflow': 'marathon', // Full /plan-ceo-review through split overflow (504–1188 s on 2.1.251)

  // Privacy gate for gstack-brain-sync — periodic (non-deterministic LLM call,
  // costs ~$0.30-$0.50 per run, not needed on every commit)

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

  // Session Intelligence — gate for data flow, periodic for agent integration
  'timeline-event-flow': 'gate',                   // Binary data flow (no LLM needed)
  'context-recovery-artifacts': 'gate',            // Preamble reads seeded artifacts
  'context-save-writes-file': 'gate',              // /context-save writes a file
  'context-restore-loads-latest': 'gate',          // Cross-branch newest-by-filename restore

  // Context skills live-fire — periodic (each test spawns claude -p, ~$0.20-$0.40)
  'context-save-routing': 'periodic',              // Proves /context-save routes via Skill tool
  'context-save-then-restore-roundtrip': 'periodic', // Full cycle in one session
  'context-restore-fragment-match': 'periodic',    // /context-restore <fragment>
  'context-restore-provenance-order': 'periodic',  // #3004 Next steps / Verify first, 3-trial panel
  'context-restore-empty-state': 'periodic',       // Graceful zero-saves message
  'context-restore-list-delegates': 'periodic',    // /context-restore list redirect
  'context-restore-legacy-compat': 'periodic',     // Pre-rename files still load
  'context-save-list-current-branch': 'periodic',  // Default branch filter
  'context-save-list-all-branches': 'periodic',    // --all flag

  // Ship — gate (end-to-end ship path)
  'ship-base-branch': 'gate',
  'ship-local-workflow': 'gate',
  'ship-managed-hook-refresh': 'gate',
  'ship-unmanaged-hook-consent': 'gate',
  'ship-local-hook-preservation': 'gate',
  'ship-coverage-audit': 'gate',
  'ship-triage': 'gate',
  'ship-docsync-missing-marker': 'gate',
  'ship-docsync-missing-asset': 'gate',
  'ship-docsync-launch-failure': 'gate',
  'ship-docsync-timeout-unsettled': 'gate',
  'ship-docsync-late-result': 'gate',
  'ship-docsync-stale-before': 'gate',
  'ship-docsync-stale-after': 'gate',
  'ship-docsync-recovery': 'gate',
  'ship-docsync-completion': 'gate',
  'ship-docsync-current': 'gate',
  'ship-docsync-failure': 'gate',
  'ship-docsync-store': 'gate',
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
  // W1 safety-rule evals.
  'safety-design-risk-stop': 'periodic',
  'safety-codex-boundary': 'periodic',
  'safety-codex-consult-embed': 'gate',
  'safety-ios-demo-ui-only': 'periodic',
  'safety-pair-agent-block': 'gate',
  'safety-ship-stale-evidence': 'gate',

  // Document-release — gate (CHANGELOG guardrail)
  'document-release': 'gate',

  // Codex — periodic (Opus, requires codex CLI)
  'codex-review': 'periodic',

  // Multi-AI — periodic (require external CLIs)
  'codex-multiblock-live': 'periodic',
  'design-model-smoke': 'periodic',
  'codex-discover-skill': 'periodic',
  'codex-review-findings': 'periodic',
  'auq-consistency': 'periodic',
  'auq-verbose-vs-carved-ab': 'periodic',
  'codex-recommendation-substance': 'periodic',
  'outside-voice-codex-to-claude-code': 'periodic',
  'outside-voice-claude-code-to-codex': 'periodic',
  'outside-plan-disabled-no-fallback': 'periodic',
  'codex-sol-scope-termination': 'periodic',

  // Design — gate for cheap functional, periodic for Opus/quality
  'design-consultation-core': 'periodic',
  'design-consultation-existing': 'periodic',
  'design-consultation-research': 'periodic',  // D2a demotion 2026-08: the two most expensive gate tests ($0.91/304s)
  'design-consultation-preview': 'periodic',   // D2a demotion 2026-08 ($0.89/481s)
  'plan-design-review-no-ui-scope': 'gate',
  'design-review-fix': 'periodic',
  'design-review-detector-shim': 'gate',       // deterministic sentinels from the fake engine (source mode on a diff)
  'design-review-detector-shim-dom': 'gate',   // same shim, DOM mode through the browse binary's dump; self-skips when the binary is absent
  'design-review-plugin-handoff': 'gate',
  'design-html-slop-gate': 'periodic',         // one-pass gate behavior is a judgment call on a fake engine's fixed output

  // /diagram — triplet is deterministic functional (gstack-render falls back
  // to the browse daemon, so CI runs it); judge is a quality benchmark
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

  // Browser-skills Phase 2a — skillify keys gate (D1/D3 contracts must not
  // silently break). The two scrape keys are periodic: /scrape is Aside-first
  // and its fallback no longer prescribes the `$B skill list` / `skill run`
  // match + prototype flow the tests assert, so a pass rides on prompt
  // compliance (non-deterministic). Flip back to gate when scrape's fallback
  // carries the browser-skills flow again.
  'scrape-match-path': 'periodic',
  'scrape-prototype-path': 'periodic',
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

  // Overlay efficacy harness (SDK, paid) — periodic only

  // /ios-qa daemon + codegen. Demoted gate -> periodic (2026-08 audit): the
  // gate declaration was never executable in CI — the file sits in
  // PERIODIC_CI_EXCLUDE ("not a CI runner capability"), but that exclusion
  // only applies at tier=periodic, so the gate lane planned a HOLLOW shard
  // on every Linux PR. Periodic keeps it in the weekly census on capable
  // hosts; re-promote if a macOS runner lands (flagged decision in the
  // test-infra overhaul plan).
  // Swift toolchain only, no device required, but heavier than TS unit tests.
  // Requires a real connected + paired iPhone. Manual-trigger only.
  'ios-qa-device': 'periodic',
  // /spec end-to-end PTY pipeline (paid, non-deterministic — periodic-tier).

  // WS2 arm benchmark — periodic: full build-shaped agentic workflows, paid,
  // non-deterministic by construction (research instrument, not a gate).
  'arm-benchmark-native-overbuild': 'periodic',
  'arm-benchmark-crud-endpoint': 'periodic',
  'arm-benchmark-bugfix-decoys': 'periodic',
  'office-hours-section-loading': 'marathon', // Full startup design/review/approval workflow (1–3 real review rounds, ~20 min)
  'office-hours-design-draft': 'periodic', // Same interview through the design-creating Write (~5 min)
  'plan-decision-classification': 'periodic',
  'plan-devex-peer-comparison-classification': 'periodic',
  'health-reporting': 'periodic',
  'overlay-harness-claude-dedicated-tools-vs-bash': 'periodic',
  'overlay-harness-opus-4-7-effort-match-trivial': 'periodic',
  'overlay-harness-opus-4-7-literal-interpretation': 'periodic',
  'overlay-harness-claude-dedicated-tools-vs-bash-sonnet': 'periodic',
  'overlay-harness-claude-dedicated-tools-vs-bash-opus-5-5': 'periodic',
  'journey-negatives': 'periodic',
};

/**
 * LLM-judge test touchfiles — keyed by test description string.
 */
export const LLM_JUDGE_TOUCHFILES: Record<string, string[]> = {
  'review/SKILL.md workflow': ['review/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-army.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'scripts/resolvers/sections.ts', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts'],
  'setup-browser-cookies/SKILL.md workflow': ['setup-browser-cookies/SKILL.md.tmpl', 'setup-browser-cookies/SKILL.md', 'BROWSER.md', 'test/helpers/cookie-workflow-judge-input.ts',  'test/helpers/cookie-workflow-manual-review.ts',  'test/helpers/manual-judge-review-fixture.ts', '.github/cookie-workflow-manual-review.json', 'test/helpers/workflow-judge-input.ts', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts'],
  'browse/SKILL.md reference':        ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'browse/sections/**', 'browse/SKILL.md', 'browse/SKILL.md.tmpl', 'browse/src/**', 'test/skill-llm-eval.test.ts', 'SKILL.md', 'SKILL.md.tmpl', 'gstack/llms.txt', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts', 'test/helpers/workflow-judge-input.ts'],
  'setup block':                      ['browse/SKILL.md', 'browse/SKILL.md.tmpl', 'scripts/resolvers/aside.ts', 'scripts/resolvers/browse.ts', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts', 'test/helpers/workflow-judge-input.ts'],
  'qa/SKILL.md workflow':             ['qa/**', 'qa/sections/**', 'qa/SKILL.md', 'qa/SKILL.md.tmpl', 'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts', 'test/helpers/workflow-judge-input.ts', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts'],
  'qa/SKILL.md health rubric':        ['qa/sections/**', 'qa/SKILL.md', 'qa/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts', 'test/helpers/workflow-judge-input.ts'],
  'qa/SKILL.md anti-refusal':         ['qa/sections/**', 'qa/SKILL.md', 'qa/SKILL.md.tmpl', 'qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts', 'test/helpers/workflow-judge-input.ts'],
  'cross-skill greptile consistency': ['review/SKILL.md', 'review/SKILL.md.tmpl', 'ship/SKILL.md', 'ship/SKILL.md.tmpl', 'review/greptile-triage.md', 'retro/SKILL.md', 'retro/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts', 'test/helpers/workflow-judge-input.ts'],

  // Ship & Release
  'ship/SKILL.md workflow':               ['ship/SKILL.md', 'ship/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',   'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts',
       'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts',
    'scripts/resolvers/testing.ts', 'ship/sections/**', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/review-army.ts',  'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'document-release/SKILL.md workflow':   ['document-release/**', 'document-release/SKILL.md', 'document-release/SKILL.md.tmpl', 'scripts/resolvers/sections.ts', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],

  // Plan Reviews
  'plan-ceo-review/SKILL.md modes':       ['plan-ceo-review/sections/**', 'plan-ceo-review/SKILL.md', 'plan-ceo-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts',
    'scripts/resolvers/preamble/generate-ask-user-format.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'plan-eng-review/SKILL.md sections':    [
     'scripts/resolvers/gbrain.ts',
    'scripts/resolvers/learnings.ts',
    
    "test/fixtures/plan-scope-recovery-av.json",  'plan-eng-review/SKILL.md', 'plan-eng-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts',
     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'scripts/resolvers/testing.ts', 'plan-eng-review/sections/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts',  'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],

  // /spec authored-spec quality (paid LLM-judge — periodic-tier).
  'plan-design-review/SKILL.md passes':   [
    
    "test/fixtures/plan-scope-recovery-av.json",
    "test/fixtures/design-scope-checkpoint-at.json",'plan-design-review/SKILL.md', 'plan-design-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts',
    

     "scripts/resolvers/preamble/generate-preamble-bash.ts", "scripts/resolvers/preamble/generate-completion-status.ts",
    'plan-design-review/sections/**', 'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/design.ts', 'scripts/resolvers/review-dashboard.ts', 'scripts/resolvers/plan-gates.ts', 'scripts/resolvers/spec-review.ts', 'scripts/resolvers/outside-voice-steps.ts', 'scripts/resolvers/review-scope.ts', 'scripts/resolvers/outside-voice.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],

  // Design skills
  'design-review/SKILL.md fix loop':      ['design-review/SKILL.md', 'design-review/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'design-consultation/SKILL.md research': ['design-consultation/SKILL.md', 'design-consultation/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'scripts/resolvers/design.ts', 'scripts/resolvers/outside-voice.ts', 'design-consultation/sections/**',  'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],

  // Deploy skills
  'land-and-deploy/SKILL.md workflow':    ['land-and-deploy/SKILL.md', 'land-and-deploy/SKILL.md.tmpl', 'land-and-deploy/sections/**', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'canary/SKILL.md monitoring loop':      ['canary/SKILL.md', 'canary/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'benchmark/SKILL.md perf collection':   ['benchmark/SKILL.md', 'benchmark/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'setup-deploy/SKILL.md platform setup': ['setup-deploy/SKILL.md', 'setup-deploy/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],

  // Other skills
  'retro/SKILL.md instructions':          ['retro/sections/**', 'retro/SKILL.md', 'retro/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'qa-only/SKILL.md workflow':            ['qa-only/**', 'qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl', 'qa/**', 'scripts/resolvers/qa.ts', 'scripts/resolvers/utility.ts', 'scripts/resolvers/sections.ts', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'gstack-upgrade/SKILL.md upgrade flow': ['gstack-upgrade/SKILL.md', 'gstack-upgrade/SKILL.md.tmpl', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/helpers/workflow-excerpt.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts'],
  'sync-gbrain/SKILL.md read-only readiness': ['bin/gstack-state-root.sh', 'lib/state-root.ts', 'sync-gbrain/SKILL.md', 'sync-gbrain/SKILL.md.tmpl', 'bin/gstack-gbrain-read-capability.ts', 'test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-input.ts', 'test/helpers/workflow-judge-cache.ts',  'scripts/eval-input-cache.ts',   'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts'],

  // Voice directive
  'voice directive tone':                 ['scripts/resolvers/preamble.ts', 'review/SKILL.md', 'review/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts', 'test/skill-llm-eval.test.ts', 'test/fixtures/eval-baselines.json', 'test/helpers/cookie-workflow-judge-input.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/helpers/llm-judge.ts', 'test/helpers/workflow-excerpt.ts', 'test/helpers/workflow-judge-cache.ts', 'test/helpers/workflow-judge-input.ts'],
};

/**
 * Changes to any of these files trigger ALL tests (both E2E and LLM-judge).
 *
 * Keep this list minimal — only files that genuinely affect every test.
 * Scoped dependencies (gen-skill-docs, llm-judge, test-server, worktree,
 * codex/gemini session runners) belong in individual test entries instead.
 */
export const GLOBAL_TOUCHFILES = [
  'scripts/test-strict-output.ts',
  'scripts/lib/shard-engine.ts',     // The shard engine test-strict-output.ts re-exports (moved there in the W2 refactor)
  // Canonical paid execution and its shared time allocations affect every paid test.
  'scripts/test-paid-shards.ts',
  'scripts/lib/paid-cases.ts',       // Case/trial shard keys, plan and report moved out of test-paid-shards.ts
  'scripts/lib/paid-plan.ts',
  'scripts/lib/paid-report.ts',
  'scripts/lib/published-text.ts',   // Sanitizes every model-written string paid-report publishes
  'scripts/test-pr-profile.ts',
  'test/helpers/eval-budgets.ts',

  'test/helpers/session-runner.ts',  // All E2E tests use this runner
  'test/helpers/session-ledger.ts',  // Every runner appends its session facts here
  'test/helpers/auq-substance-panel.ts', // auq-matrix's substance panel; the case has no map key
  'test/helpers/session-drain-policy.ts',
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

/**
 * Eval kind per live case (every E2E_TIERS and LLM_JUDGE_TOUCHFILES key).
 * The kind fixes the trial policy before the run (EVAL_POLICY in
 * periodic-exclude-data.ts):
 *   rule     - one trial; any failed assertion fails the verdict. The default.
 *   behavior - a panel of independent trials, PASS at the policy majority;
 *              needs a BEHAVIOR_WHY entry naming the tolerated deviation.
 *   judge    - an LLM-judge score of a static input, sampled as a panel.
 * Reclassification is a reviewed diff, never a runtime switch.
 *
 * auq-matrix-<skill> (no map key, template-literal ids) stays `rule`: one
 * capture per skill, one trial. C4 (approved 2026-10-04): recommendation
 * substance is scored by a 3-sample judgePanel mean on the single capture,
 * threshold 4 unchanged; was a single judge sample and red in 6 of 24
 * censuses (37182865432 in the wave set); diagnostic run on wave/d-followups:
 * 6/6 skills, panels [5,5,5].
 */
export const E2E_KINDS: Record<string, 'rule' | 'behavior' | 'judge'> = {
  'ship-skipped-queued-finding': 'rule',
  'investigate-owned-completion': 'rule',
  'investigate-owned-abort': 'rule',
  'investigate-owned-ending-error': 'rule',
  'shared-libs-review-path-eligibility': 'rule',
  'shared-libs-review-index-flags': 'rule',
  'shared-libs-review-prior-coverage': 'rule',
  'shared-libs-codex-read-only': 'rule',
  'shared-libs-read-only': 'rule',
  'shared-libs-unsupported-git': 'rule',
  'shared-libs-review-lifecycle': 'rule',
  'shared-libs-review-revalidation': 'rule',
  'shared-libs-opportunity-judgment': 'behavior',
  'shared-libs-pr-coverage': 'rule',
  'shared-libs-plan-callers': 'rule',
  'browse-basic': 'rule',
  'browse-snapshot': 'rule',
  'aside-browse-basic': 'rule',
  'aside-browse-flow': 'rule',
  'aside-qa-quick': 'rule',
  'aside-scrape-json': 'rule',
  'aside-canary-quick': 'rule',
  'hermetic-canary': 'rule',
  'hermetic-sentinel': 'rule',
  'autoplan-journal-drift': 'rule',
  'autoplan-schema-canary': 'rule',
  'autoplan-guard-pty': 'rule',
  'autoplan-long-session': 'rule',
  'skillmd-setup-discovery': 'rule',
  'skillmd-no-local-binary': 'rule',
  'skillmd-outside-git': 'rule',
  'operational-learning': 'rule',
  'qa-quick': 'rule',
  'qa-b6-static': 'rule',
  'qa-b7-spa': 'rule',
  'qa-b8-checkout': 'rule',
  'qa-only-no-fix': 'rule',
  'qa-fix-loop': 'rule',
  'qa-bootstrap': 'rule',
  'review-exploratory-small-cli': 'rule',
  'ship-exploratory-small-cli': 'rule',
  'ship-exploratory-unavailable': 'rule',
  'ship-exploratory-plan-checks': 'rule',
  'ship-exploratory-late-input': 'rule',
  'qa-functional-cli-report': 'rule',
  'qa-functional-webhook-report': 'rule',
  'qa-functional-cli-fix': 'rule',
  'qa-functional-webhook-fix': 'rule',
  'review-sql-injection': 'rule',
  'review-enum-completeness': 'rule',
  'review-base-branch': 'rule',
  'review-gate-integrity': 'rule',
  'review-design-lite': 'behavior',
  'review-coverage-audit': 'rule',
  'review-dashboard-via': 'rule',
  'review-army-migration-safety': 'rule',
  'review-army-perf-n-plus-one': 'rule',
  'review-army-delivery-audit': 'rule',
  'review-army-quality-score': 'rule',
  'review-army-json-findings': 'rule',
  'review-army-red-team': 'behavior',
  'review-army-consensus': 'behavior',
  'review-army-simplification': 'behavior',
  'review-army-simplification-precision': 'behavior',
  'office-hours-brain-writeback': 'behavior',
  'gbrain-roundtrip-local': 'rule',
  'sync-gbrain-read-ready': 'rule',
  'sync-gbrain-read-unknown': 'rule',
  'office-hours-forcing-energy': 'behavior',
  'office-hours-builder-wildness': 'behavior',
  'plan-ceo-review': 'rule',
  'plan-ceo-review-selective': 'rule',
  'plan-ceo-review-expansion-energy': 'behavior',
  'plan-eng-review': 'rule',
  'plan-eng-review-artifact': 'rule',
  'plan-eng-review-artifact-full': 'rule',
  'plan-eng-coverage-audit': 'rule',
  'plan-review-report': 'rule',
  'plan-ceo-review-plan-mode': 'rule',
  'plan-eng-review-plan-mode': 'rule',
  'plan-design-review-plan-mode': 'rule',
  'plan-design-review-plan-mode-smoke': 'rule',
  'ship-coverage-value': 'rule',
  'review-test-value': 'rule',
  'test-audit-report-only': 'rule',
  'plan-devex-review-plan-mode': 'rule',
  'plan-mode-no-op': 'rule',
  'office-hours-auto-mode': 'rule',
  'auto-decide-preserved': 'rule',
  'auq-format-gate': 'rule',
  'plan-ceo-mode-routing': 'rule',
  'plan-design-with-ui-scope': 'rule',
  'tpa-present': 'rule',
  'tpa-absent-linux': 'rule',
  'tpa-broken': 'rule',
  'tpa-absent-darwin': 'rule',
  'tpa-apple-ban': 'rule',
  'ship-measure-seeded-flake': 'behavior',
  'ship-section-loading': 'rule',
  'plan-ceo-section-loading': 'rule',
  'carve-section-loading-browse': 'rule',
  'carve-section-loading-codex': 'rule',
  'carve-section-loading-design-consultation': 'rule',
  'carve-section-loading-design-html': 'rule',
  'carve-section-loading-design-shotgun': 'rule',
  'carve-section-loading-document-release': 'rule',
  'carve-section-loading-land-and-deploy': 'rule',
  'carve-section-loading-plan-design-review': 'rule',
  'carve-section-loading-plan-devex-review': 'rule',
  'carve-section-loading-plan-eng-review': 'rule',
  'carve-section-loading-qa': 'rule',
  'carve-section-loading-retro': 'rule',
  'carve-section-loading-review': 'rule',
  'carve-section-loading-setup-gbrain': 'rule',
  'carve-section-loading-spec': 'rule',
  'plan-eng-finding-floor': 'rule',
  'plan-ceo-finding-floor': 'rule',
  'plan-design-finding-floor': 'rule',
  'plan-devex-finding-floor': 'rule',
  'plan-eng-multi-finding-batching': 'rule',
  'plan-ceo-split-overflow': 'rule',
  'setup-gbrain-remote': 'rule',
  'setup-gbrain-bad-token': 'rule',
  'setup-gbrain-path4-local-pglite': 'rule',
  'plan-ceo-review-format-mode': 'behavior',
  'plan-ceo-review-format-approach': 'behavior',
  'plan-eng-review-format-coverage': 'behavior',
  'plan-eng-review-format-kind': 'behavior',
  'office-hours-phase4-fork': 'behavior',
  'llm-judge-recommendation': 'judge',
  'plan-ceo-review-prosons-cadence': 'behavior',
  'plan-review-prosons-format': 'behavior',
  'plan-review-prosons-hardstop-neg': 'behavior',
  'plan-review-prosons-neutral-neg': 'behavior',
  'plan-tune-inspect': 'rule',
  'timeline-event-flow': 'rule',
  'context-recovery-artifacts': 'rule',
  'context-save-writes-file': 'rule',
  'context-restore-loads-latest': 'rule',
  'context-save-routing': 'rule',
  'context-save-then-restore-roundtrip': 'rule',
  'context-restore-fragment-match': 'rule',
  'context-restore-provenance-order': 'behavior',
  'context-restore-empty-state': 'rule',
  'context-restore-list-delegates': 'rule',
  'context-restore-legacy-compat': 'rule',
  'context-save-list-current-branch': 'rule',
  'context-save-list-all-branches': 'rule',
  'ship-base-branch': 'rule',
  'ship-local-workflow': 'rule',
  'ship-managed-hook-refresh': 'rule',
  'ship-unmanaged-hook-consent': 'rule',
  'ship-local-hook-preservation': 'rule',
  'ship-coverage-audit': 'rule',
  'ship-triage': 'rule',
  'ship-docsync-missing-marker': 'rule',
  'ship-docsync-missing-asset': 'rule',
  'ship-docsync-launch-failure': 'rule',
  'ship-docsync-timeout-unsettled': 'rule',
  'ship-docsync-late-result': 'rule',
  'ship-docsync-stale-before': 'rule',
  'ship-docsync-stale-after': 'rule',
  'ship-docsync-recovery': 'rule',
  'ship-docsync-completion': 'rule',
  'ship-docsync-current': 'rule',
  'ship-docsync-failure': 'rule',
  'ship-docsync-store': 'rule',
  'docsync-spawned': 'rule',
  'retro': 'rule',
  'retro-base-branch': 'rule',
  'cso-full-audit': 'rule',
  'cso-diff-mode': 'rule',
  'cso-infra-scope': 'rule',
  'learnings-show': 'rule',
  // W1 safety-rule evals.
  'safety-design-risk-stop': 'rule',
  'safety-codex-boundary': 'rule',
  'safety-codex-consult-embed': 'rule',
  'safety-ios-demo-ui-only': 'rule',
  'safety-pair-agent-block': 'rule',
  'safety-ship-stale-evidence': 'rule',
  'document-release': 'rule',
  'codex-review': 'rule',
  'codex-multiblock-live': 'rule',
  'design-model-smoke': 'rule',
  'codex-discover-skill': 'rule',
  'codex-review-findings': 'rule',
  'auq-consistency': 'rule',
  'auq-verbose-vs-carved-ab': 'rule',
  'codex-recommendation-substance': 'rule',
  'outside-voice-codex-to-claude-code': 'rule',
  'outside-voice-claude-code-to-codex': 'rule',
  'outside-plan-disabled-no-fallback': 'rule',
  'codex-sol-scope-termination': 'rule',
  'design-consultation-core': 'rule',
  'design-consultation-existing': 'rule',
  'design-consultation-research': 'rule',
  'design-consultation-preview': 'rule',
  'plan-design-review-no-ui-scope': 'rule',
  'design-review-fix': 'rule',
  'design-review-detector-shim': 'rule',
  'design-review-detector-shim-dom': 'rule',
  'design-review-plugin-handoff': 'rule',
  'design-html-slop-gate': 'behavior',
  'diagram-triplet': 'rule',
  'diagram-authoring-quality': 'rule',
  'gstack-upgrade-happy-path': 'rule',
  'land-and-deploy-workflow': 'rule',
  'land-and-deploy-first-run': 'rule',
  'land-and-deploy-review-gate': 'rule',
  'canary-workflow': 'rule',
  'benchmark-workflow': 'rule',
  'setup-deploy-workflow': 'rule',
  'autoplan-dual-voice': 'rule',
  'benchmark-providers-live': 'rule',
  'scrape-match-path': 'behavior',
  'scrape-prototype-path': 'behavior',
  'skillify-happy-path': 'rule',
  'skillify-provenance-refusal': 'rule',
  'skillify-approval-reject': 'rule',
  'journey-ideation': 'rule',
  'journey-plan-eng': 'rule',
  'journey-debug': 'rule',
  'journey-qa': 'rule',
  'journey-code-review': 'rule',
  'journey-ship': 'rule',
  'journey-docs': 'rule',
  'journey-retro': 'rule',
  'journey-design-system': 'rule',
  'journey-visual-qa': 'rule',
  'ios-qa-device': 'rule',
  'arm-benchmark-native-overbuild': 'rule',
  'arm-benchmark-crud-endpoint': 'rule',
  'arm-benchmark-bugfix-decoys': 'rule',
  'office-hours-section-loading': 'rule',
  'office-hours-design-draft': 'rule',
  'plan-decision-classification': 'rule',
  'plan-devex-peer-comparison-classification': 'rule',
  'health-reporting': 'rule',
  'overlay-harness-claude-dedicated-tools-vs-bash': 'rule',
  'overlay-harness-opus-4-7-effort-match-trivial': 'rule',
  'overlay-harness-opus-4-7-literal-interpretation': 'rule',
  'overlay-harness-claude-dedicated-tools-vs-bash-sonnet': 'rule',
  'overlay-harness-claude-dedicated-tools-vs-bash-opus-5-5': 'rule',
  'journey-negatives': 'rule',
  'review/SKILL.md workflow': 'judge',
  'setup-browser-cookies/SKILL.md workflow': 'judge',
  'browse/SKILL.md reference': 'judge',
  'setup block': 'judge',
  'qa/SKILL.md workflow': 'judge',
  'qa/SKILL.md health rubric': 'judge',
  'qa/SKILL.md anti-refusal': 'judge',
  'cross-skill greptile consistency': 'judge',
  'ship/SKILL.md workflow': 'judge',
  'document-release/SKILL.md workflow': 'judge',
  'plan-ceo-review/SKILL.md modes': 'judge',
  'plan-eng-review/SKILL.md sections': 'judge',
  'plan-design-review/SKILL.md passes': 'judge',
  'design-review/SKILL.md fix loop': 'judge',
  'design-consultation/SKILL.md research': 'judge',
  'land-and-deploy/SKILL.md workflow': 'judge',
  'canary/SKILL.md monitoring loop': 'judge',
  'benchmark/SKILL.md perf collection': 'judge',
  'setup-deploy/SKILL.md platform setup': 'judge',
  'retro/SKILL.md instructions': 'judge',
  'qa-only/SKILL.md workflow': 'judge',
  'gstack-upgrade/SKILL.md upgrade flow': 'judge',
  'sync-gbrain/SKILL.md read-only readiness': 'judge',
  'voice directive tone': 'judge',
};

/**
 * One-line tolerance for every behavior-kind case: why an occasional
 * deviation is acceptable product behavior. Keys equal the behavior ids of
 * E2E_KINDS; values are non-empty.
 */
export const BEHAVIOR_WHY: Record<string, string> = {
  'ship-measure-seeded-flake':
    "How the live model words its classification and fix can vary run to run; measuring before fixing, re-measuring at target and running the gate once after stay assertions, and answering only the spend question is a contract.",
  'shared-libs-opportunity-judgment':
    "Whether a candidate extraction is worth recommending is a judgment call; the read-only invariant stays a contract.",
  'context-restore-provenance-order':
    "How the live model lays out the two Remaining Work groups can drift run to run; never executing a seeded step and never leapfrogging the unverified first item stay contracts.",
  'review-design-lite':
    "How many of the seven design-lite checklist items the live review flags varies run to run; the fake-engine rows it must carry stay strict.",
  'review-army-red-team':
    "Whether the red-team lens surfaces on a small diff is a live model choice, not a contract.",
  'review-army-consensus':
    "Multi-specialist agreement on the planted SQL finding is a quality benchmark that tolerates an occasional miss.",
  'review-army-simplification':
    "Flagging the planted unnecessary structure is an advisory-lens quality judgment.",
  'review-army-simplification-precision':
    "Staying silent on a lean diff is a false-flag noise benchmark; an occasional advisory is acceptable noise.",
  'office-hours-forcing-energy':
    "The Q3 posture is scored by a live judge on generated prose; a single flat phrasing is tolerable.",
  'office-hours-builder-wildness':
    "Builder-mode creativity is scored by a live judge on generated prose; one conservative riff is tolerable.",
  'office-hours-brain-writeback':
    "The model's interpretation of the gbrain writeback instruction (page shape, tags) varies; no secret or safety step rides on it.",
  'office-hours-phase4-fork':
    "Phase 4 asks the model to invent 2-3 architectures; surfacing the fork with its reasoning is open-ended generation.",
  'plan-ceo-review-expansion-energy':
    "Expansion framing is scored by a live judge on generated proposals; one flat proposal set is tolerable.",
  'plan-ceo-review-format-mode':
    "Mode-question wording (Completeness line vs kind note) is live formatting of one AskUserQuestion.",
  'plan-ceo-review-format-approach':
    "Approach-menu Completeness wording is live formatting of one AskUserQuestion.",
  'plan-eng-review-format-coverage':
    "Coverage-issue Completeness wording is live formatting of one AskUserQuestion.",
  'plan-eng-review-format-kind':
    "Kind-note wording is live formatting of one AskUserQuestion.",
  'plan-ceo-review-prosons-cadence':
    "Pros/Cons cadence on a hard-stop question is live formatting; either the escape or the full block is accepted.",
  'plan-review-prosons-format':
    "The full Pros/Cons block (counts of pros and cons, labels) is live formatting of one question.",
  'plan-review-prosons-hardstop-neg':
    "Not using the hard-stop escape on an ordinary decision is live formatting of one question.",
  'plan-review-prosons-neutral-neg':
    "Avoiding neutral posture and naming a because-reason is live formatting of one question.",
  'design-html-slop-gate':
    "How many scan passes the one-pass slop gate takes on a fake engine's fixed output is a judgment call.",
  'scrape-match-path':
    "The /scrape fallback no longer prescribes the browser-skills match flow, so taking it is prompt compliance.",
  'scrape-prototype-path':
    "The /scrape fallback no longer prescribes the prototype flow, so taking it is prompt compliance.",
};
