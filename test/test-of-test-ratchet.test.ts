/**
 * Recurrence ratchet for tests that exercise only test code.
 *
 * A free test counts when none of its direct imports reaches a repo file outside
 * `test/` and it names no `bin/` path, SKILL.md or `.tmpl` template: it tests a
 * helper or a replayed capture, not product code. It also counts when it reads a
 * paid test file's source and slices it, whatever else it imports: that tests the
 * paid harness's own code out of context. The 2026-09 audit left the files below;
 * a new one fails here with its path and a suggested owner test.
 * AGENTS.md: "do not add one spelling or glyph per paid failure".
 */
import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { isPaidTestFile } from './helpers/paid-test-set';
import { directSpecifiers, resolveRepoSpecifier } from './helpers/resolve-repo-path';

const ROOT = path.resolve(import.meta.dir, '..');

/** Recorded after workstream D. Add a path only with a one-line reason comment, reviewed in the diff. */
const BASELINE = [
  'test/anthropic-preflight.test.ts',
  'test/artifacts-init-migration.test.ts',
  'test/autoplan-artifact-recorder.test.ts',
  'test/autoplan-artifact-windows-argv.test.ts',
  'test/autoplan-edit-digests-al.test.ts',
  'test/autoplan-owned-state.test.ts',
  'test/autoplan-pending-artifact.test.ts',
  'test/autoplan-pending-question.test.ts',
  'test/autoplan-phase-observer.test.ts',
  'test/autoplan-public-narration.test.ts',
  'test/bootstrap-retention-shard.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/bootstrap-retention.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/bootstrap-session-lifecycle.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/build-script-shell-compat.test.ts',
  'test/builder-profile.test.ts',
  'test/bun-subprocess-fd-lifetime.test.ts',
  'test/carve-guard-completeness.test.ts',
  'test/carve-plan-fixture.test.ts',
  'test/carve-section-ordering.test.ts',
  'test/ceo-barless-submit.test.ts',
  'test/ceo-count-ad-v2.test.ts',
  'test/ceo-expansion-auq.test.ts',
  'test/ceo-expansion-pacing-native.test.ts',
  'test/ceo-hold-posture-review.test.ts',
  'test/ceo-mode-expansion-disposition.test.ts',
  'test/ceo-mode-labels-native.test.ts',
  'test/ceo-mode-option.test.ts', // slices test/skill-e2e-plan-ceo-mode-routing.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/ceo-mode-pending-submit.test.ts',
  'test/ceo-mode-posture-native.test.ts',
  'test/ceo-mode-prerequisite.test.ts',
  'test/ceo-posture-packet.test.ts',
  'test/ceo-section-loading-fixture.test.ts',
  'test/ceo-split-collection.test.ts',
  'test/ceo-split-question-policy.test.ts',
  'test/ceo-stale-fill-decision.test.ts', // replays census reports against the paid CEO section-loading case's structured checker
  'test/changed-files-union.test.ts',
  'test/claude-provider-keychain.test.ts',
  'test/codex-carve-fixture.test.ts',
  'test/codex-eval-recording.test.ts',
  'test/codex-resume-flag-semantics.test.ts',
  'test/cookie-workflow-judge-input.test.ts', // slices test/skill-llm-eval.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/cso-ntfs-fixture.test.ts',
  'test/cso-windows-build-contract.test.ts',
  'test/dependency-security.test.ts',
  'test/deps-smoke.test.ts',
  'test/design-completion-handoff-scored.test.ts',
  'test/design-daemon-windows-identity.test.ts',
  'test/design-detector-source-fixture.test.ts', // slices test/skill-e2e-design.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/design-html-section-completion.test.ts',
  'test/devex-peer-comparison-calibration.test.ts',
  'test/diagram-render-drift.test.ts',
  'test/disabled-dated-record-at.test.ts',
  'test/docsync-atomic-writes.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/docsync-child-marker.test.ts', // replays a PR-lane capture against the paid ship-docsync case's child-marker check
  'test/docsync-command-grammar.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/docsync-nested-writes.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/dx-selected-navigation-ap.test.ts',
  'test/eng-batching-current-ledger.test.ts',
  'test/eng-batching-native-replay.test.ts',
  'test/eng-batching-saved-ledger.test.ts',
  'test/eng-count-question-policy.test.ts',
  'test/eng-devex-s-count.test.ts',
  'test/eng-first-review.test.ts',
  'test/eng-published-navigation.test.ts',
  'test/eng-resolution-block-position.test.ts',
  'test/eng-seeded-completion-ai.test.ts',
  'test/eng-seeded-coverage.test.ts',
  'test/eng-semantic-terminal.test.ts',
  'test/eng-test-plan-edit-approval.test.ts',
  'test/eval-list-cli.test.ts',
  'test/extension-pty-inject-invariant.test.ts',
  'test/gbrain-source-worktree-advance.test.ts',
  'test/gbrain-sync-voyage-code-3-integration.test.ts',
  'test/gstack-gbrain-source-wireup.test.ts',
  'test/gstack-home-module-scope.test.ts',
  'test/gstack-upgrade-migration-v1_17_0_0.test.ts',
  'test/gstack-upgrade-migration-v1_37_0_0.test.ts',
  'test/gstack-upgrade-migration-v1_40_0_0.test.ts',
  'test/gstack-upgrade-migration-v1_78_0_0.test.ts',
  'test/helpers-unit.test.ts',
  'test/helpers/budget-override.test.ts',
  'test/helpers/capture-parity-baseline.test.ts',
  'test/helpers/claude-pty-runner.auq.unit.test.ts', // W4: moved from claude-pty-runner.unit.test.ts (exempt via its design SKILL.md.tmpl read), split along the pty/ module seams
  'test/helpers/claude-pty-runner.launch.unit.test.ts', // W4: moved from claude-pty-runner.unit.test.ts (exempt via its design SKILL.md.tmpl read), split along the pty/ module seams
  'test/helpers/claude-pty-runner.plan-native.unit.test.ts', // W4: moved from claude-pty-runner.unit.test.ts (exempt via its design SKILL.md.tmpl read), split along the pty/ module seams
  'test/helpers/claude-pty-runner.runners.unit.test.ts', // W4 fake-driver regressions: the PTY harness is itself the subject (plan-mode paid evals stand on it)
  'test/helpers/claude-pty-runner.scope-gate-floor.unit.test.ts',
  'test/helpers/claude-pty-runner.screen.unit.test.ts', // W4: moved from claude-pty-runner.unit.test.ts (exempt via its design SKILL.md.tmpl read), split along the pty/ module seams
  'test/helpers/e2e-gate.unit.test.ts',
  'test/helpers/eval-store.test.ts',
  'test/helpers/hermetic-env.test.ts',
  'test/helpers/run-bin.test.ts',
  'test/helpers/session-runner.test.ts',
  'test/helpers/sync-command-capture.test.ts',
  'test/hooks-windows-paths.test.ts',
  'test/ios-debug-bridge-release-guard.test.ts',
  'test/ios-qa-stateserver-hardening.test.ts',
  'test/ios-qa-swift-build.test.ts',
  'test/jargon-list.test.ts',
  'test/llm-judge-frontier.test.ts',
  'test/llm-judge-stream.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/memory-cache-injection.test.ts',
  'test/module-size-ratchet.test.ts', // ratchet (c) source scanner (W2): measures product modules as text; its counter is test tooling
  'test/native-auto-decide-pty.test.ts',
  'test/no-suicide-exit.test.ts',
  'test/outside-voice-fixture.test.ts',
  'test/overlay-measurement.test.ts',
  'test/overlay-recording-order.test.ts',
  'test/overlay-sdk-cancel-eof.test.ts',
  'test/paid-orphan-tripwire.test.ts',
  'test/paid-shard-settlement.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/parity-baseline-integrity.test.ts',
  'test/parity-suite.test.ts',
  'test/pending-question-completion.test.ts',
  'test/plan-count-artifacts.test.ts',
  'test/plan-count-checkbox.test.ts',
  'test/plan-count-clipped-elision.test.ts',
  'test/plan-count-collection-completion.test.ts',
  'test/plan-count-completion.test.ts',
  'test/plan-count-cropped-wrap.test.ts',
  'test/plan-count-dx-handoff.test.ts',
  'test/plan-count-empty-review.test.ts',
  'test/plan-count-file-permission.test.ts',
  'test/plan-count-history.test.ts',
  'test/plan-count-long-edit.test.ts',
  'test/plan-count-native-input.test.ts',
  'test/plan-count-owned-permission.test.ts',
  'test/plan-count-pending-exit.test.ts',
  'test/plan-count-prerequisite.test.ts',
  'test/plan-count-preview-footer.test.ts',
  'test/plan-count-timeout.test.ts',
  'test/plan-count-transcript.test.ts',
  'test/plan-count-truncated-border.test.ts',
  'test/plan-count-truncated-question.test.ts',
  'test/plan-create-combined-permission.test.ts',
  'test/plan-create-permission.test.ts',
  'test/plan-create-prepublication.test.ts',
  'test/plan-design-sdk-fixture.test.ts', // slices test/skill-e2e-design.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/plan-edit-cropped-permission.test.ts',
  'test/plan-eng-resume.test.ts', // harness owner for the plan-eng-review-artifact checkpoint: proves its resume point before paid spend
  'test/plan-floor-dx-actor.test.ts',
  'test/plan-floor-review.test.ts',
  'test/plan-mode-evidence.test.ts',
  'test/plan-pending-question-pty.test.ts',
  'test/plan-seed-submission.test.ts',
  'test/plan-skill-read-permission.test.ts',
  'test/plan-skill-webfetch-permission.test.ts',
  'test/pty-askuserquestion-single-line.test.ts',
  'test/pty-numbered-option-indent-native.test.ts',
  'test/pty-option-selection.test.ts',
  'test/pty-output-wake.test.ts',
  'test/pty-screen-session.test.ts',
  'test/pty-screen-supervision.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/pty-screen-unicode-ap.test.ts',
  'test/pty-screen.test.ts',
  'test/pty-skill-seeding-wiring.test.ts',
  'test/pty-trust-dialog.test.ts',
  'test/qa-checkpoint-evidence.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/qa-fix-loop-fixture.test.ts',
  'test/qa-functional-evidence.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/qa-functional-fixture.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/qa-functional-observer-atomic.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/qa-functional-observer.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/qa-supervision-selection.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/question-log-hook.test.ts',
  'test/readme-throughput.test.ts',
  'test/review-army-budget.test.ts',
  'test/review-consensus-lifecycle.test.ts',
  'test/review-count-markdown.test.ts',
  'test/review-enum-lifecycle.test.ts',
  'test/review-n-plus-one-contract.test.ts',
  'test/review-quality-provenance.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/session-runner-browse-errors.test.ts', // slices test/skill-e2e-review.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/session-runner-stream-lifecycle.test.ts',
  'test/session-runner-timeout.test.ts',
  'test/setup-browser-hint.test.ts',
  'test/setup-bun-cmd-and-pipe-bugs.test.ts',
  'test/setup-conductor-worktree.test.ts',
  'test/setup-playwright-platform.test.ts',
  'test/setup-sections-linking.test.ts',
  'test/shared-libs-cancellation.test.ts', // landed in v1.91.7.0 before this ratchet: harness owner for its functional-QA/docsync paid evals
  'test/shared-libs-checker-interface-evidence.test.ts', // slices test/skill-e2e-shared-libs.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/shared-libs-fixture.test.ts', // slices test/skill-e2e-shared-libs-periodic.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/shared-libs-plan-actor.test.ts',
  'test/shared-libs-revalidation-prompt.test.ts', // slices test/skill-e2e-shared-libs.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/shared-libs-review-start-evidence.test.ts', // slices test/skill-e2e-shared-libs.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/shared-libs-source-reads.test.ts', // slices test/skill-e2e-shared-libs-paths.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/shared-libs-stage-actor.test.ts', // slices test/skill-e2e-shared-libs.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/ship-coverage-audit-af.test.ts', // slices test/skill-e2e-workflow.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/ship-section-fixture.test.ts',
  'test/skill-budget-regression.test.ts',
  'test/skill-fixture.test.ts', // slices test/skill-routing-e2e.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/skill-parser.test.ts',
  'test/spawnsync-timeout-tripwire.test.ts',
  'test/tasks-section-jq.test.ts',
  'test/test-free-shards-capture.test.ts',
  'test/timeline.test.ts',
  'test/workflow-judge-cache.test.ts', // slices test/skill-llm-eval.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
  'test/workflow-judge-input.test.ts', // slices test/skill-llm-eval.test.ts source (recorded 2026-10 when the ratchet learned paid-source slicing)
];

function freeTests(): string[] {
  return ['test', 'test/helpers'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir)).map(name => `${dir}/${name}`))
    .filter(file => file.endsWith('.test.ts') && !isPaidTestFile(file)).sort();
}

/** Variables bound to `readFileSync(<paid test file>)` that the file then cuts with `.slice(`. */
function slicedPaidSources(source: string): string[] {
  const bound = [...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=[^;\n]*\breadFileSync\([^;\n]*?(['"`])(?:\.\/|test\/)?([\w.-]+\.test\.ts)\2/g)]
    .filter(match => isPaidTestFile(`test/${match[3]}`)).map(match => match[1]!);
  return [...new Set(bound)].filter(name => new RegExp(`\\b${name}\\.slice\\(`).test(source));
}

function testsOnlyTestCode(file: string): { counted: boolean; helper?: string } {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const targets = directSpecifiers(source).map(specifier => resolveRepoSpecifier(ROOT, file, specifier)).filter(Boolean) as string[];
  const helper = targets.find(target => target.startsWith('test/helpers/') && !target.endsWith('.test.ts'));
  if (slicedPaidSources(source).length) return { counted: true, helper };
  if (targets.some(target => !target.startsWith('test/') && !target.startsWith('node_modules/'))) return { counted: false };
  if (/(['"`])[^'"`\n]*(?:\bbin\/|SKILL\.md|CLAUDE\.md|\.tmpl)[^'"`\n]*\1/.test(source)) return { counted: false };
  if (/(['"`])(?:\.\/)?\.github\b[^'"`\n]*\1|(['"`])bin\2\s*,\s*(?:(['"`])[\w.-]+\3|[A-Za-z_$])/.test(source)) return { counted: false };
  // A repo script run or read by path (`scripts/gen-skill-docs.ts`, `path.join(ROOT, 'setup')`) is product code too.
  if (/(['"`])(?:\.\/)?scripts\/[\w./-]+\1|ROOT\s*,\s*(['"`])setup\2/.test(source)) return { counted: false };
  return { counted: true, helper };
}

function suggestedOwner(helper?: string): string {
  if (!helper) return 'the owner test of the production module it should import';
  const candidates = [helper.replace(/^test\/helpers\/(.+)\.ts$/, 'test/$1.test.ts'), helper.replace(/\.ts$/, '.test.ts'), helper.replace(/\.ts$/, '.unit.test.ts')];
  return candidates.find(candidate => fs.existsSync(path.join(ROOT, candidate))) ?? `the test that owns ${helper}`;
}

test('no new test exercises only test code', () => {
  const listed = new Set(BASELINE);
  const added = freeTests().map(file => ({ file, ...testsOnlyTestCode(file) }))
    .filter(entry => entry.counted && !listed.has(entry.file));
  expect(added.map(entry => entry.file), added.length ? [
    `${added.length} test file(s) over the baseline: ${added.map(entry => entry.file).join(', ')}.`,
    'They import only test/ code, so they test a helper or a replayed capture rather than product code.',
    ...added.map(entry => `Fix: add the case as a row in ${suggestedOwner(entry.helper)}, or import the production module under test.`),
    'A file that slices a paid test\'s source: export the code it needs from a test/helpers module both files import, and test that.',
    'If the file is genuinely needed, add its path to BASELINE in test/test-of-test-ratchet.test.ts with a one-line reason.',
    'AGENTS.md: do not add one spelling or glyph per paid failure.',
  ].join('\n') : '').toEqual([]);
});

test('every baseline entry is still a test file', () => {
  const stale = BASELINE.filter(file => !fs.existsSync(path.join(ROOT, file)));
  expect(stale, stale.map(file => `remove ${file} from the baseline`).join('\n')).toEqual([]);
});

test('paid-source slicing counts; reading paths or importing the paid file does not', () => {
  const read = (file: string) => `const source = fs.readFileSync(path.join(ROOT, '${file}.test.ts'), 'utf8');`;
  expect(slicedPaidSources(`${read('skill-e2e-shared-libs')}\nconst body = source.slice(source.indexOf('async function'));`)).toEqual(['source']);
  expect(slicedPaidSources(`${read('test/skill-llm-eval')}\nexpect(source).toContain('judge');`)).toEqual([]);
  expect(slicedPaidSources(`${read('gen-skill-docs')}\nsource.slice(0, 10);`)).toEqual([]);
  expect(slicedPaidSources("await import(path.join(root, 'test/skill-e2e-ship-docsync' + '.test.ts'));")).toEqual([]);
});
