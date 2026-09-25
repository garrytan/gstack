import { describe, expect, test } from 'bun:test';
import { E2E_TIERS, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES, selectTests } from './helpers/touchfiles';
import { OVERLAY_FIXTURES } from './fixtures/overlay-nudges';

describe('periodic fixture dependencies select their behavioral cases', () => {
  const cases: Array<[string, string[]]> = [
    ['test/ceo-expansion-pacing-native.test.ts', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-expansion-pacing-fb10.json', ['plan-ceo-mode-routing']],
    ['test/helpers/ceo-hold-posture-review.ts', ['plan-ceo-mode-routing']],
    ['test/ceo-hold-posture-review.test.ts', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-hold-proof-fb10.json', ['plan-ceo-mode-routing']],
    ['test/eng-semantic-terminal.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-fb10-count-public.json', ['plan-eng-finding-count']],
    ['test/fixtures/autoplan-home-phase-entry-fb10.json', ['autoplan-chain-pty']],
    ['test/eng-error-flow-seed.test.ts', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-69193-count-public.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-e366-count-public.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/ceo-current-decision-record.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-current-decision-cdd-public.json', ['plan-ceo-finding-count']],
    ['test/fixtures/eng-count-c6fc-public.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-cdd-regression-task.json', ['plan-eng-finding-count']],
    ['test/eng-resolution-block-position.test.ts', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/eng-initial-selector-043a.test.ts', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-initial-selector-043a.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-a689-count-public.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-a689-retry-public.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-neutral-seed-749df.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-paired-suite-749df.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/auto-decide-mode-selector-749df.json', ['auto-decide-preserved']],
    ['test/eng-count-owned-outcomes.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-count-owned-outcomes-f359.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-batching-prefixed-ledger-f359.json', ['plan-eng-multi-finding-batching']],
    ['test/fixtures/ceo-hold-preservation-f359.json', ['plan-ceo-mode-routing']],
    ['test/ceo-native-fields-f359.test.ts', ['plan-ceo-finding-count']],
    ['test/ceo-conditional-option-facts.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-conditional-option-facts-c6fc.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-native-fields-f359.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-plain-fields-f359.json', ['plan-ceo-finding-count']],
    ['test/eng-task-pause-navigation-f359.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-task-pause-navigation-f359.json', ['plan-eng-finding-count']],
    ['test/fixtures/auto-decide-completed-mode-f359.json', ['auto-decide-preserved']],
    ['test/fixtures/ceo-onboarding-packet-90f.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-baseline-alternatives-90f.json', ['plan-ceo-finding-count']],
    ['test/fixtures/eng-structure-choice-90f.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-idp-choice-90f.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-legacy-declaration-90f.json', ['plan-eng-finding-count']],
    ['test/fixtures/design-completion-envelope-90f.json', ['plan-design-finding-count']],
    ['test/eng-native-seed-contract.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-native-seed-contract-6f.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-native-packets-b955.json', ['plan-eng-finding-count']],
    ['test/review-count-markdown.test.ts', ['plan-eng-finding-count', 'plan-design-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/review-count-markdown-6f.json', ['plan-eng-finding-count', 'plan-design-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/eng-current-native-seeds.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-current-native-seeds-6714.json', ['plan-eng-finding-count']],
    ['test/fixtures/ceo-recorded-decisions-67147822.json', ['plan-ceo-finding-count']],
    ['test/fixtures/eng-batching-expanded-ledger-6714.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-native-review-identities-6714.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/design-count-current-pass.test.ts', ['plan-design-finding-count']],
    ['test/fixtures/design-count-current-pass.json', ['plan-design-finding-count']],
    ['test/eng-test-plan-edit-approval.test.ts', ['autoplan-chain-pty', 'plan-eng-finding-count']],
    ['test/fixtures/eng-test-plan-edit-dacc.json', ['autoplan-chain-pty', 'plan-eng-finding-count']],
    ['test/fixtures/eng-test-plan-edit-cli.js', ['autoplan-chain-pty', 'plan-eng-finding-count']],
    ['test/autoplan-owned-state.test.ts', ['autoplan-chain-pty']],
    ['test/autoplan-artifact-windows-argv.test.ts', ['autoplan-chain-pty', 'plan-eng-finding-count']],
    ['test/fixtures/eng-current-choice-cab3.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-completed-navigation-cab3.json', ['plan-eng-finding-count']],
    ['test/autoplan-dual-voice-fixture.test.ts', ['autoplan-dual-voice']],
    ['test/helpers/autoplan-dual-voice-evidence.ts', ['autoplan-dual-voice']],
    ['test/autoplan-dual-voice-evidence.test.ts', ['autoplan-dual-voice']],
    ['test/fixtures/autoplan-dual-false-positive-6bd.json', ['autoplan-dual-voice']],
    ['test/helpers/autoplan-method-read-audit.ts', ['autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-phase-entry-alias-f359.json', ['autoplan-chain-pty']],
    ['test/fixtures/autoplan-method-read-aa-events.json', ['autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/helpers/outside-voice-evidence.ts', ['autoplan-dual-voice', 'outside-plan-disabled-no-fallback',
      'outside-voice-claude-code-to-codex', 'outside-voice-codex-to-claude-code']],
    ['test/fixtures/outside-async-task-m-events.json', ['autoplan-dual-voice',
      'outside-voice-claude-code-to-codex', 'outside-voice-codex-to-claude-code']],
    ['test/fixtures/devex-journey-evidence-cab3.json', ['plan-devex-finding-count']],
    ['test/autoplan-phase-handoff.test.ts', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/autoplan-amend-input.test.ts', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-amend-input-77.json', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-phase-handoff-6714.json', ['carve-section-loading', 'autoplan-chain-pty', 'autoplan-dual-voice']],
    ['test/fixtures/autoplan-owned-state-edit.json', ['autoplan-chain-pty']],
    ['test/eng-finding-retry-budget.test.ts', ['plan-ceo-finding-count', 'plan-ceo-split-overflow', 'plan-design-finding-count', 'plan-devex-finding-count', 'plan-eng-finding-count', 'plan-eng-multi-finding-batching', 'autoplan-chain-pty']],
    ['test/design-count-native-8525.test.ts', ['plan-design-finding-count']],
    ['test/fixtures/design-count-native-8525.json', ['plan-design-finding-count']],
    ['test/fixtures/design-phase-entry-77.json', ['plan-design-finding-count']],
    ['test/fixtures/ceo-expansion-pacing-77.json', ['plan-ceo-mode-routing']],
    ['test/eng-published-navigation.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-published-navigation.json', ['plan-eng-finding-count']],
    ['test/fixtures/eng-6aef-count-public.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/disabled-retained-record.json', ['outside-plan-disabled-no-fallback']],
    ['test/ceo-native-ledger-replay.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-native-ledger-8525.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-option-metadata-list-6f6730f4.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-zero-test-absence-6f6730f4.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-recorded-decisions-dacc95ea.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-expansion-posture-kind-dacc.json', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-expansion-pause-6714.json', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-expansion-complete-inventory-6f.json', ['plan-ceo-mode-routing']],
    ['test/ceo-mode-pending-submit.test.ts', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-mode-pending-submit.json', ['plan-ceo-mode-routing']],
    ['test/fixtures/ceo-fill-lifetime.json', ['plan-ceo-section-loading']],
    ['test/fixtures/eng-current-ledger-seeds.json', ['plan-eng-finding-count']],
    ['test/eng-batching-native-replay.test.ts', ['plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-batching-native-8525.json', ['plan-eng-multi-finding-batching']],
    ['test/eng-batching-saved-ledger.test.ts', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/fixtures/eng-batching-saved-ledger-dacc.json', ['plan-eng-finding-count', 'plan-eng-multi-finding-batching']],
    ['test/plan-design-sdk-fixture.test.ts', ['plan-design-review-plan-mode']],
    ['test/design-count-native-issue-fields.test.ts', ['plan-design-finding-count']],
    ['test/fixtures/design-count-native-issue-fields.json', ['plan-design-finding-count']],
    ['test/helpers/ceo-payment-findings.ts', ['plan-ceo-finding-count']],
    ['test/ceo-payment-findings.test.ts', ['plan-ceo-finding-count']],
    ['test/ceo-source-attribution.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-source-attribution-6aef.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-current-record-6aef.json', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-payment-ledger-decisions.json', ['plan-ceo-finding-count']],
    ['test/setup-gbrain-remote-caller.test.ts', ['setup-gbrain-remote']],
    ['test/skill-fixture.test.ts', ['journey-ideation', 'journey-plan-eng', 'journey-debug', 'journey-qa', 'journey-code-review', 'journey-ship', 'journey-docs', 'journey-retro', 'journey-design-system', 'journey-visual-qa']],
    ['test/office-hours-writeback-env.test.ts', ['office-hours-brain-writeback']],
    ['test/review-army-budget.test.ts', ['review-army-red-team', 'review-army-consensus']],
    ['test/helpers/setup-gbrain-sandbox.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', 'setup-gbrain-remote']],
    ['test/helpers/setup-gbrain-fixture-command.ts', ['setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite']],
    ['test/fixtures/autoplan-caller.fixture.test.ts', ['autoplan-chain-pty']],
    ['test/gstack-paths.test.ts', ['autoplan-chain-pty', 'carve-section-loading', 'design-html-slop-gate']],
    ['test/gstack-brain-context-load.test.ts', ['autoplan-chain-pty', 'plan-ceo-section-loading']],
    ['test/autoplan-permission-viewport.test.ts', ['autoplan-chain-pty']],
    ['test/fixtures/autoplan-settings-overwrite.json', ['autoplan-chain-pty']],
    ['test/fixtures/eng-file-permission-repaint.json', ['plan-eng-multi-finding-batching']],
    ['test/helpers/carve-section-case.ts', ['carve-section-loading']],
    ['test/helpers/carve-plan-fixture.ts', ['carve-section-loading']],
    ['test/carve-plan-fixture.test.ts', ['carve-section-loading']],
    ['test/fixtures/carve-existing-repository/src/repository.ts', ['carve-section-loading']],
    ['test/fixtures/carve-existing-repository/README.md', ['carve-section-loading']],
    ['test/fixtures/carve-existing-repository/example.ts', ['carve-section-loading']],
    ['test/helpers/eng-finding-fixture.ts', ['plan-eng-finding-count']],
    ['test/eng-finding-fixture.test.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-existing-auth/legacy-auth.ts', ['plan-eng-finding-count']],
    ['test/fixtures/eng-existing-auth/package.json', ['plan-eng-finding-count']],
    ['test/codex-carve-fixture.test.ts', ['carve-section-loading']],
    ['test/design-html-section-completion.test.ts', ['carve-section-loading']],
    ['test/fixtures/design-html-section-complete.md', ['carve-section-loading']],
    ['test/plan-design-floor-fixture.test.ts', ['plan-design-finding-floor']],
    ['test/devex-finding-fixture.test.ts', ['plan-devex-finding-count']],
    ['test/fixtures/devex-checkpoint-todos.json', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/README.md', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/docs/getting-started.md', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/docs/feedback.md', ['plan-devex-finding-count']],
    ['test/fixtures/devex-existing-sdk/docs/reference-v1.md', ['plan-devex-finding-count']],
    ['test/design-finding-fixture.test.ts', ['plan-design-finding-count']],
    ['test/helpers/hermetic-env.test.ts', ['plan-ceo-split-overflow']],
    ['test/helpers/ceo-split-question-policy.ts', ['plan-ceo-split-overflow']],
    ['test/ceo-split-question-policy.test.ts', ['plan-ceo-split-overflow']],
    ['test/ceo-split-collection.test.ts', ['plan-ceo-split-overflow']],
    ['test/fixtures/ceo-split-collection-0bcd.json', ['plan-ceo-split-overflow']],
    ['test/fixtures/ceo-split-actor-6aef.json', ['plan-ceo-split-overflow']],
    ['test/helpers/ceo-mode-option.ts', ['plan-ceo-mode-routing', 'plan-ceo-finding-count', 'plan-ceo-split-overflow']],
    ['docs/askuserquestion-split.md', ['plan-ceo-split-overflow', 'plan-decision-classification', 'plan-devex-peer-comparison-classification']],
    ['test/resolver-ask-user-format.test.ts', ['plan-ceo-split-overflow']],
    ['test/skill-e2e-plan-ceo-finding-count.test.ts', ['plan-ceo-finding-count']],
    ['test/section-capture-native-tools.test.ts', ['ship-section-loading', 'plan-ceo-section-loading', 'office-hours-section-loading', 'carve-section-loading']],
    ['test/helpers/ceo-paired-fixture.ts', ['plan-ceo-finding-count']],
    ['test/ceo-paired-payment-fixture.test.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/ceo-paired-option-values.json', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/src/payment.ts', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/contract.test.ts.fixture', ['plan-ceo-finding-count']],
    ['test/fixtures/paired-payment/README.md', ['plan-ceo-finding-count']],
    ...['README.md', 'platform.ts', 'existing-invoice-handler.ts', 'schema.sql', 'contract.test.ts.fixture'].map((file): [string, string[]] =>
      [`test/fixtures/ceo-existing-payment/${file}`, ['plan-ceo-finding-count']]),
    ...['test/fixtures/webfetch-permission.json', 'test/plan-skill-webfetch-permission.test.ts'].map((file): [string, string[]] => [file,
      ['plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
        'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow'],
    ]),
    ['test/helpers/plan-mode-evidence.ts', ['plan-design-review-plan-mode', 'plan-eng-review-plan-mode']],
    ['test/plan-mode-evidence.test.ts', ['plan-design-review-plan-mode', 'plan-eng-review-plan-mode']],
    ...['test/helpers/autoplan-phase-order.ts', 'test/autoplan-phase-observation.test.ts'].map((file): [string, string[]] => [file,
      ['autoplan-chain-pty', 'plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
        'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow'],
    ]),
    ...['overlay-measurement', 'overlay-workspace', 'overlay-attempt', 'overlay-case', 'overlay-case-policy', 'overlay-lifecycle'].map((helper): [string, string[]] => [
      `test/helpers/${helper}.ts`, OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`),
    ]),
  ];

  for (const file of ['test/overlay-sdk-cancel-eof.test.ts', 'test/overlay-recording-order.test.ts', 'test/paid-overlay-scheduling.test.ts', 'test/fixtures/overlay-admission-child.ts']) {
    cases.push([file, OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`)]);
  }

  for (const fixture of OVERLAY_FIXTURES) {
    cases.push([`test/skill-e2e-overlay-harness-${fixture.id}.test.ts`, [`overlay-harness-${fixture.id}`]]);
  }

  test('SDK runner changes retain the native gate and existing periodic consumers', () => {
    const periodic = ['brain-privacy-gate', 'setup-gbrain-remote', 'setup-gbrain-bad-token',
      'setup-gbrain-path4-local-pglite', ...OVERLAY_FIXTURES.map(fixture => `overlay-harness-${fixture.id}`)];
    const result = selectTests(['test/agent-sdk-runner.test.ts'], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(['auq-format-gate', ...periodic].sort());
    expect(E2E_TIERS['auq-format-gate']).toBe('gate');
    for (const id of periodic) expect(E2E_TIERS[id]).toBe('periodic');
  });

  for (const [file, expected] of cases) {
    test(file, () => {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.reason).toBe('diff');
      expect(result.selected.sort()).toEqual([...expected].sort());
      for (const id of expected) expect(E2E_TIERS[id]).toBe('periodic');
    });
  }
});

test('Eng section local review helpers select their carve evaluation', () => {
  for (const file of ['bin/gstack-review-log', 'bin/gstack-review-read', 'lib/review-evidence.ts',
    'bin/gstack-slug', 'bin/gstack-wtree', 'bin/gstack-config', 'bin/gstack-brain-enqueue']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected).toContain('carve-section-loading');
  }
  expect(E2E_TIERS['carve-section-loading']).toBe('periodic');
});

test('offering source lookup dependencies select all four gate audits', () => {
  const expected = ['codex-offered-office-hours', 'codex-offered-ceo-review',
    'codex-offered-design-review', 'codex-offered-eng-review'].sort();
  for (const file of ['test/helpers/codex-offering-fixture.ts', 'test/codex-offering-fixture.test.ts',
    'test/fixtures/codex-offering-cdd-public.json', 'test/fixtures/codex-offering-timeout-public.json', 'test/helpers/workflow-judge-input.ts',
    'test/workflow-judge-input.test.ts', 'test/helpers/workflow-excerpt.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
    for (const id of expected) expect(E2E_TIERS[id]).toBe('gate');
  }
  for (const file of ['test/helpers/codex-offering-fixture.ts', 'test/codex-offering-fixture.test.ts',
    'test/fixtures/codex-offering-cdd-public.json', 'test/fixtures/codex-offering-timeout-public.json']) {
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});

test('shared attempt regressions select periodic callers and the gate report case', () => {
  const periodic = ['plan-design-review-plan-mode', 'office-hours-forcing-energy', 'office-hours-builder-wildness', 'office-hours-brain-writeback', 'plan-ceo-review-format-mode', 'plan-ceo-review-format-approach', 'plan-eng-review-format-coverage', 'plan-eng-review-format-kind', 'plan-ceo-review-prosons-cadence', 'plan-review-prosons-format', 'plan-review-prosons-hardstop-neg', 'plan-review-prosons-neutral-neg', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', 'setup-gbrain-remote', 'review-army-red-team'];
  const result = selectTests(['test/office-hours-attempt.test.ts'], E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  expect(result.selected.sort()).toEqual([...periodic, 'plan-review-report'].sort());
  for (const id of periodic) expect(E2E_TIERS[id]).toBe('periodic');
  expect(E2E_TIERS['plan-review-report']).toBe('gate');
});

test('decision-log CLI and validator select the demonstrated DX consumer without global or quality fanout', () => {
  for (const file of ['bin/gstack-decision-log', 'lib/gstack-decision.ts']) {
    const selected = selectTests([file], E2E_TOUCHFILES);
    expect(selected.reason).toBe('diff');
    expect(selected.selected).toEqual(['plan-devex-finding-count']);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  expect(E2E_TIERS['plan-devex-finding-count']).toBe('periodic');
});

test('native fixture dependencies include the migrated auto-decision and seeded CEO smoke callers', () => {
  const expected = [
    'auto-decide-preserved', 'autoplan-chain-pty',
    'plan-ceo-finding-count', 'plan-ceo-finding-floor', 'plan-ceo-mode-routing', 'plan-ceo-review-plan-mode', 'plan-ceo-split-overflow',
    'plan-design-finding-count', 'plan-design-finding-floor', 'plan-design-with-ui-scope',
    'plan-devex-finding-count', 'plan-devex-finding-floor',
    'plan-eng-finding-count', 'plan-eng-finding-floor', 'plan-eng-multi-finding-batching',
  ];
  for (const file of ['test/helpers/plan-count-fixture.ts', 'test/plan-count-fixture.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  expect(E2E_TIERS['auto-decide-preserved']).toBe('periodic');
  expect(E2E_TIERS['plan-ceo-review-plan-mode']).toBe('gate');
});

test('shared native input dependencies select every PTY consumer without changing tiers', () => {
  const expected = selectTests(['test/helpers/claude-pty-runner.ts'], E2E_TOUCHFILES).selected.sort();
  expect(expected).toHaveLength(22);
  expect(expected.filter(id => E2E_TIERS[id] === 'gate')).toHaveLength(7);
  expect(expected.filter(id => E2E_TIERS[id] === 'periodic')).toHaveLength(15);
  for (const file of ['test/plan-count-design-ui-recovery.test.ts', 'test/fixtures/design-ui-boxed-question.json', 'test/pty-workspace-trust.test.ts', 'test/fixtures/pty-companion-cli.ts', 'test/helpers/pty-current-screen.ts', 'test/pty-current-screen.test.ts', 'test/fixtures/native-viewport.ts',
    'test/helpers/plan-skill-questions.ts', 'test/plan-skill-questions.test.ts', 'test/fixtures/design-tasks-bash-permission.json', 'test/fixtures/eng-auq-validation-error.json',
    'test/helpers/plan-skill-question-events.ts', 'test/plan-skill-question-events.test.ts',
    'test/helpers/plan-skill-question-hook-scope.ts', 'test/helpers/skill-census.ts', 'test/plan-skill-question-hook-scope.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
});


test('seed submission dependencies select every seeded caller with its existing tier', () => {
  const expected = ['auto-decide-preserved', 'conductor-prose', 'plan-ceo-review-plan-mode',
    'plan-design-review-plan-mode', 'plan-devex-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-mode-no-op'];
  for (const file of ['test/helpers/fake-plan-seed.ts', 'test/helpers/plan-seed-submission.ts', 'test/plan-seed-submission.test.ts', 'test/fixtures/plan-seed-cli.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(expected);
  }
  expect(expected.map(id => E2E_TIERS[id])).toEqual(['periodic', 'periodic', 'gate', 'periodic', 'gate', 'periodic', 'gate']);
});

test('task emission source selects CEO completion consumers', () => {
  const selected = selectTests(['scripts/resolvers/tasks-section.ts'], E2E_TOUCHFILES);
  expect(selected.reason).toBe('diff');
  for (const id of [
    'plan-ceo-finding-count', 'plan-ceo-finding-floor', 'plan-ceo-split-overflow',
    'plan-ceo-section-loading', 'plan-ceo-review-plan-mode', 'autoplan-chain-pty',
  ]) expect(selected.selected).toContain(id);
  expect(selectTests(['scripts/resolvers/tasks-section.ts'], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
});

test('review report resolver selects every periodic completion consumer', () => {
  const required = [
    'plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
    'plan-devex-finding-count', 'plan-ceo-split-overflow', 'autoplan-chain-pty',
    'carve-section-loading', 'plan-ceo-section-loading', 'plan-eng-multi-finding-batching',
  ];
  const result = selectTests(['scripts/resolvers/review.ts'], E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  for (const id of required) {
    expect(result.selected).toContain(id);
    expect(E2E_TIERS[id]).toBe('periodic');
  }
});


test('shared plan question source selects every generated review consumer', () => {
  const source = 'scripts/resolvers/preamble/generate-ask-user-format.ts';
  const renders = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review']
    .map(skill => `${skill}/SKILL.md`);
  for (const map of [E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES]) {
    const expected = selectTests(renders, map);
    const actual = selectTests([source], map);
    expect(expected.reason).toBe('diff');
    expect(actual.reason).toBe('diff');
    expect(expected.selected.length).toBeGreaterThan(0);
    expect(expected.selected.filter(id => !actual.selected.includes(id))).toEqual([]);
  }
});


test('Eng approval-rule source and free contract controls select every declared Eng consumer', () => {
  const expected = [
      'plan-eng-review',
      'plan-eng-review-artifact',
      'plan-review-report',
      'plan-eng-review-plan-mode',
      'plan-mode-no-op',
      'conductor-prose',
      'carve-section-loading',
      'autoplan-chain-pty',
      'plan-eng-finding-count',
      'plan-eng-finding-floor',
      'plan-eng-multi-finding-batching',
      'plan-eng-review-format-coverage',
      'plan-eng-review-format-kind',
      'plan-ceo-review-prosons-cadence',
      'plan-review-prosons-format',
      'codex-offered-eng-review',
      'codex-plan-eng-format-coverage',
      'codex-plan-eng-format-kind',
      'plan-eng-coverage-audit',
      'autoplan-dual-voice'
  ];
  for (const file of ['plan-eng-review/sections/review-sections.md.tmpl', 'scripts/resolvers/review.ts', 'test/plan-review-cases.test.ts']) {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    for (const id of expected) expect(result.selected, `${file}: ${id}`).toContain(id);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toContain('plan-eng-review/SKILL.md sections');
  }
});

// This actor is used by the bounded native Design UI case, not the optional
// outside-review evaluations. Its captured inputs must select that same case.
test('Design native-only actor capture selects its gate case', () => {
  const result = selectTests(['test/fixtures/design-outside-voices-question.json'], E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  expect(result.selected).toEqual(['plan-design-with-ui-scope']);
  expect(E2E_TIERS['plan-design-with-ui-scope']).toBe('gate');
});


test('native compact-boundary ancestry selects every consuming callback', () => {
  const expected = [
    'plan-ceo-mode-routing', 'autoplan-chain-pty', 'plan-ceo-finding-count',
    'plan-eng-finding-count', 'plan-design-finding-count', 'plan-devex-finding-count',
    'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow',
    'plan-design-with-ui-scope', 'plan-design-review-plan-mode', 'plan-eng-review-plan-mode',
    'auto-decide-preserved', 'conductor-prose',
  ].sort();
  for (const file of ['test/helpers/plan-count-transcript.ts', 'test/plan-count-session-cwd.test.ts']) {
    const selected = selectTests([file], E2E_TOUCHFILES);
    expect(selected.reason).toBe('diff');
    expect(selected.selected.sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('same-plan expansion disposition replay selects the existing mode helper consumers', () => {
  for (const dependency of ['test/ceo-mode-expansion-disposition.test.ts', 'test/fixtures/ceo-expansion-disposition-77.json']) {
    expect([...selectTests([dependency], E2E_TOUCHFILES).selected].sort()).toEqual(['plan-ceo-finding-count', 'plan-ceo-mode-routing']);
    expect(selectTests([dependency], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('structured auto-decision evidence selects every native observer', () => {
  const expected = ['auto-decide-preserved', 'conductor-prose', 'plan-ceo-review-plan-mode',
    'plan-design-review-plan-mode', 'plan-devex-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-mode-no-op'];
  for (const file of ['test/auto-decide-structured.test.ts', 'test/fixtures/auto-decide-structured-77.json',
    'test/helpers/auto-decision-state.ts', 'test/auto-decision-state.test.ts', 'test/fixtures/auto-decide-state-cab3.json']) {
    expect([...selectTests([file], E2E_TOUCHFILES).selected].sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  for (const file of ['bin/gstack-question-log', 'bin/gstack-question-preference']) {
    const producers = selectTests([file], E2E_TOUCHFILES).selected;
    for (const id of expected) expect(producers).toContain(id);
  }
});


test('explanatory native mode evidence selects all observers with their existing tiers', () => {
  const expected = ['auto-decide-preserved', 'conductor-prose', 'office-hours-auto-mode',
    'plan-ceo-review-plan-mode', 'plan-design-review-plan-mode', 'plan-devex-review-plan-mode',
    'plan-eng-review-plan-mode', 'plan-mode-no-op'];
  for (const file of ['test/helpers/native-auto-decide.ts', 'test/auto-decide-current-declaration.test.ts',
    'test/fixtures/auto-decide-current-declaration-6aef.json', 'test/auto-decide-explanatory-mode.test.ts',
    'test/fixtures/auto-decide-explanatory-mode-043a.json', 'test/fixtures/auto-decide-explanatory-mode-749df.json']) {
    expect([...selectTests([file], E2E_TOUCHFILES).selected].sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  expect(expected.map(id => E2E_TIERS[id])).toEqual([
    'periodic', 'periodic', 'gate', 'gate', 'periodic', 'gate', 'periodic', 'gate',
  ]);
});

// The workflow judge includes all carved sections, including those outside the
// entrypoint marker window (readWorkflowJudgeInput).
test('CEO carved sections select the judge that consumes their complete content', () => {
  for (const file of [
    'plan-ceo-review/sections/review-sections.md.tmpl',
    'plan-ceo-review/sections/review-sections.md',
  ]) {
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected)
      .toEqual(['plan-ceo-review/SKILL.md modes']);
  }
});


test('file supervision regression selects all affected callers with their existing tiers', () => {
  const gate = [
    'codex-offered-ceo-review', 'codex-offered-design-review', 'codex-offered-eng-review',
    'codex-offered-office-hours', 'office-hours-spec-review', 'plan-ceo-finding-floor',
    'plan-ceo-review-benefits', 'plan-devex-finding-floor', 'plan-mode-no-op', 'plan-review-report',
  ];
  const periodic = [
    'auto-decide-preserved', 'codex-plan-ceo-format-approach', 'codex-plan-ceo-format-mode',
    'codex-plan-eng-format-coverage', 'codex-plan-eng-format-kind', 'plan-ceo-mode-routing',
    'plan-ceo-review', 'plan-ceo-review-expansion-energy', 'plan-ceo-review-format-approach',
    'plan-ceo-review-format-mode', 'plan-ceo-review-prosons-cadence', 'plan-ceo-review-selective',
    'plan-design-finding-floor', 'plan-eng-finding-floor', 'plan-eng-review', 'plan-eng-review-artifact',
    'plan-eng-review-format-coverage', 'plan-eng-review-format-kind', 'plan-eng-review-plan-mode',
    'plan-review-prosons-format', 'plan-review-prosons-hardstop-neg', 'plan-review-prosons-neutral-neg',
  ];
  const changed = ['test/paid-retry-supervision.test.ts'];
  const result = selectTests(changed, E2E_TOUCHFILES);
  expect(result.reason).toBe('diff');
  expect(result.selected.sort()).toEqual([...gate, ...periodic].sort());
  for (const id of gate) expect(E2E_TIERS[id]).toBe('gate');
  for (const id of periodic) expect(E2E_TIERS[id]).toBe('periodic');
  expect(selectTests(changed, LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
});

test('floor permissions and large-report fixtures select their actual consumers', () => {
  const floors = ['plan-ceo-finding-floor', 'plan-eng-finding-floor', 'plan-design-finding-floor', 'plan-devex-finding-floor'];
  for (const file of ['test/plan-floor-permission.test.ts', 'test/fixtures/plan-floor-permission-fb10.json'])
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual([...floors].sort());
  const filePermissionConsumers = selectTests(['test/helpers/plan-count-file-permission.ts'], E2E_TOUCHFILES).selected;
  expect(filePermissionConsumers.sort()).toEqual([...floors, 'plan-ceo-finding-count', 'plan-eng-finding-count',
    'plan-design-finding-count', 'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow'].sort());
  expect(selectTests(['test/fixtures/ceo-report-permission-fb10.json'], E2E_TOUCHFILES).selected.sort())
    .toEqual(filePermissionConsumers);
  expect(E2E_TIERS['plan-ceo-finding-floor']).toBe('gate');
  expect(E2E_TIERS['plan-devex-finding-floor']).toBe('gate');
  expect(E2E_TIERS['plan-eng-finding-floor']).toBe('periodic');
  expect(E2E_TIERS['plan-design-finding-floor']).toBe('periodic');
});

// These existing permission checks now also serve gate floor actors.
for (const file of ['test/plan-count-cropped-wrap.test.ts', 'test/fixtures/plan-count-cropped-wrap-6714.json']) {
  test(file, () => {
    const gate = ['plan-ceo-finding-floor', 'plan-devex-finding-floor'];
    const periodic = ['plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count',
      'plan-devex-finding-count', 'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow',
      'plan-eng-finding-floor', 'plan-design-finding-floor'];
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual([...gate, ...periodic].sort());
    for (const id of gate) expect(E2E_TIERS[id]).toBe('gate');
    for (const id of periodic) expect(E2E_TIERS[id]).toBe('periodic');
  });
}


// Shared harness repairs must select every existing consumer, including gate floors.
const nativeRepairDependencies = [
  {
    "name": "AUTO mode declarations",
    "files": [
      "test/auto-decide-recommendation-scope.test.ts",
      "test/fixtures/auto-decide-recommendation-361c.json",
      "test/auto-decide-target-identity.test.ts",
      "test/fixtures/auto-decide-target-361c.json"
    ],
    "owners": [
      "plan-ceo-review-plan-mode",
      "plan-eng-review-plan-mode",
      "plan-design-review-plan-mode",
      "plan-devex-review-plan-mode",
      "plan-mode-no-op",
      "office-hours-auto-mode",
      "auto-decide-preserved",
      "conductor-prose"
    ]
  },
  {
    "name": "owned cropped Create previews",
    "files": [
      "test/plan-create-permission.test.ts",
      "test/fixtures/plan-create-permission-361c.json"
    ],
    "owners": [
      "plan-ceo-finding-count",
      "plan-eng-finding-count",
      "plan-design-finding-count",
      "plan-devex-finding-count",
      "plan-eng-finding-floor",
      "plan-ceo-finding-floor",
      "plan-design-finding-floor",
      "plan-devex-finding-floor",
      "plan-eng-multi-finding-batching",
      "plan-ceo-split-overflow"
    ]
  },
  {
    "name": "native selection defaults",
    "files": [
      "test/plan-review-native-default.test.ts",
      "test/fixtures/eng-omitted-select-361c.json"
    ],
    "owners": [
      "plan-ceo-mode-routing",
      "plan-ceo-finding-count",
      "plan-eng-finding-count",
      "plan-design-finding-count",
      "plan-devex-finding-count",
      "plan-eng-multi-finding-batching",
      "plan-ceo-split-overflow",
      "plan-devex-peer-comparison-classification",
      "plan-decision-classification"
    ]
  },
  {
    "name": "split native question and report permission",
    "files": [
      "test/fixtures/ceo-split-padding-361c-public.json",
      "test/fixtures/ceo-split-edit-permission-361c-public.json"
    ],
    "owners": [
      "plan-ceo-split-overflow"
    ]
  },
  {
    "name": "finding-qualified floors",
    "files": [
      "test/helpers/plan-floor-review.ts",
      "test/plan-floor-review.test.ts",
      "test/fixtures/plan-floor-routing-361c.json"
    ],
    "owners": [
      "plan-ceo-finding-floor",
      "plan-eng-finding-floor",
      "plan-design-finding-floor",
      "plan-devex-finding-floor"
    ]
  },
  {
    "name": "complete long native Edit panes",
    "files": [
      "test/plan-count-long-edit.test.ts",
      "test/fixtures/plan-count-long-edit-0bcd.json"
    ],
    "owners": [
      "plan-ceo-finding-count",
      "plan-eng-finding-count",
      "plan-design-finding-count",
      "plan-devex-finding-count",
      "plan-eng-finding-floor",
      "plan-ceo-finding-floor",
      "plan-design-finding-floor",
      "plan-devex-finding-floor",
      "plan-eng-multi-finding-batching",
      "plan-ceo-split-overflow"
    ]
  },
  {
    "name": "native border on truncated questions",
    "files": [
      "test/plan-count-truncated-border.test.ts",
      "test/fixtures/eng-d2-truncated-border-0bcd.json"
    ],
    "owners": [
      "plan-ceo-review-plan-mode",
      "plan-eng-review-plan-mode",
      "plan-design-review-plan-mode",
      "plan-devex-review-plan-mode",
      "plan-mode-no-op",
      "office-hours-auto-mode",
      "auto-decide-preserved",
      "conductor-prose",
      "plan-ceo-mode-routing",
      "plan-design-with-ui-scope",
      "ship-idempotency-pty",
      "autoplan-chain-pty",
      "plan-ceo-finding-count",
      "plan-eng-finding-count",
      "plan-design-finding-count",
      "plan-devex-finding-count",
      "plan-eng-finding-floor",
      "plan-ceo-finding-floor",
      "plan-design-finding-floor",
      "plan-devex-finding-floor",
      "plan-eng-multi-finding-batching",
      "plan-ceo-split-overflow"
    ]
  }
];
for (const group of nativeRepairDependencies) {
  test(`native repair dependencies: ${group.name}`, () => {
    for (const file of group.files) {
      const selected = selectTests([file], E2E_TOUCHFILES);
      expect(selected.reason).toBe('diff');
      expect(selected.selected.sort()).toEqual([...group.owners].sort());
      expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
    }
  });
}
test('native repair dependencies preserve every original tier', () => {
  expect(E2E_TIERS).toMatchObject({
  "plan-ceo-review-plan-mode": "gate",
  "plan-eng-review-plan-mode": "periodic",
  "plan-design-review-plan-mode": "periodic",
  "plan-devex-review-plan-mode": "gate",
  "plan-mode-no-op": "gate",
  "office-hours-auto-mode": "gate",
  "auto-decide-preserved": "periodic",
  "conductor-prose": "periodic",
  "plan-ceo-finding-count": "periodic",
  "plan-eng-finding-count": "periodic",
  "plan-design-finding-count": "periodic",
  "plan-devex-finding-count": "periodic",
  "plan-eng-finding-floor": "periodic",
  "plan-ceo-finding-floor": "gate",
  "plan-design-finding-floor": "periodic",
  "plan-devex-finding-floor": "gate",
  "plan-eng-multi-finding-batching": "periodic",
  "plan-ceo-split-overflow": "periodic",
  "plan-ceo-mode-routing": "periodic",
  "plan-devex-peer-comparison-classification": "periodic",
  "plan-decision-classification": "periodic"
});
});


// These dependency edges do not create new paid identities. Reuse of unchanged
// model inputs is qualified separately before a paid run.
test('promoted public transcript decoder keeps its actual callers selected', () => {
  const expected = [
    'plan-eng-review-plan-mode',
    'plan-design-review-plan-mode',
    'auto-decide-preserved',
    'conductor-prose',
    'plan-ceo-mode-routing',
    'plan-design-with-ui-scope',
    'autoplan-chain-pty',
    'plan-ceo-finding-count',
    'plan-eng-finding-count',
    'plan-design-finding-count',
    'plan-devex-finding-count',
    'plan-eng-multi-finding-batching',
    'plan-ceo-split-overflow',
    'plan-ceo-finding-floor',
    'plan-eng-finding-floor',
    'plan-design-finding-floor',
    'plan-devex-finding-floor',
  ];
  expect(selectTests(['lib/claude-public-transcript.ts'], E2E_TOUCHFILES).selected.sort())
    .toEqual(expected.sort());
  expect(selectTests(['lib/claude-public-transcript.ts'], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
});

test('Autoplan publication libraries and captured hook controls select the native chain', () => {
  for (const file of [
    'lib/autoplan-phase-publication.ts',
    'test/autoplan-publication-guard.test.ts',
    'test/autoplan-publication-hook.test.ts',
    'test/autoplan-publication-generation.test.ts',
    'test/fixtures/autoplan-publication-boundary-361c.json',
    'test/fixtures/autoplan-phase-consumption-491.json',
  ]) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
  // Preserve the existing autoplan/** edges; native hook controls select only
  // the chain, while a skill file change can select the existing broad owners.
  expect(selectTests(['autoplan/bin/phase-publication-hook.ts'], E2E_TOUCHFILES).selected.sort())
    .toEqual(selectTests(['autoplan/SKILL.md'], E2E_TOUCHFILES).selected.sort());
  expect(E2E_TIERS['autoplan-chain-pty']).toBe('periodic');
});

test('combined Create captures select the existing owned file-permission consumers', () => {
  const expected = [
    'plan-ceo-finding-count',
    'plan-eng-finding-count',
    'plan-design-finding-count',
    'plan-devex-finding-count',
    'plan-eng-finding-floor',
    'plan-ceo-finding-floor',
    'plan-design-finding-floor',
    'plan-devex-finding-floor',
    'plan-eng-multi-finding-batching',
    'plan-ceo-split-overflow',
  ];
  for (const file of ['test/plan-create-combined-permission.test.ts',
    'test/fixtures/plan-create-combined-permission-70b.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual([...expected].sort());
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});

test('floor quotation evidence selects four assessors and product-type evidence selects only DX', () => {
  const floors = [
    'plan-ceo-finding-floor',
    'plan-eng-finding-floor',
    'plan-design-finding-floor',
    'plan-devex-finding-floor',
  ];
  expect(selectTests(['test/fixtures/plan-floor-quote-70b.json'], E2E_TOUCHFILES).selected.sort())
    .toEqual([...floors].sort());
  expect(selectTests(['test/fixtures/plan-floor-product-type-70b.json'], E2E_TOUCHFILES).selected)
    .toEqual(['plan-devex-finding-floor']);
  for (const file of ['test/plan-floor-review.test.ts', 'test/plan-floor-permission.test.ts'])
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual([...floors].sort());
  for (const file of ['test/fixtures/plan-floor-quote-70b.json', 'test/fixtures/plan-floor-product-type-70b.json'])
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  expect(E2E_TIERS['plan-ceo-finding-floor']).toBe('gate');
  expect(E2E_TIERS['plan-devex-finding-floor']).toBe('gate');
  expect(E2E_TIERS['plan-design-finding-floor']).toBe('periodic');
  expect(E2E_TIERS['plan-eng-finding-floor']).toBe('periodic');
});

test('DX custom setup transport selects its existing floor case without quality resampling', () => {
  for (const file of ['test/plan-floor-dx-actor.test.ts', 'test/fixtures/plan-floor-dx-custom-491.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-devex-finding-floor']);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('numbered native-menu captures select the existing parser consumers', () => {
  const expected = Object.entries(E2E_TOUCHFILES)
    .filter(([, files]) => files.includes('test/plan-skill-questions.test.ts'))
    .map(([id]) => id).sort();
  expect(expected).toHaveLength(22);
  for (const file of ['test/pty-numbered-option-indent-native.test.ts',
    'test/fixtures/ceo-split-e5-numbered-description-491.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('pending native Write captures select the existing owned-permission consumers', () => {
  const expected = Object.entries(E2E_TOUCHFILES)
    .filter(([, files]) => files.includes('test/plan-create-combined-permission.test.ts'))
    .map(([id]) => id).sort();
  expect(expected).toHaveLength(10);
  for (const file of ['test/plan-create-prepublication.test.ts',
    'test/fixtures/plan-create-prepublication-491.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(expected);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});

test('the declared engineering actor selects its existing count case', () => {
  for (const file of ['test/helpers/eng-count-question-policy.ts',
    'test/eng-count-question-policy.test.ts', 'test/fixtures/eng-count-actor-491.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-eng-finding-count']);
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  }
});


test('stderr lifecycle regression selects runtime consumers without a quality-map edge', () => {
  const expected = [
    'browse-basic', 'browse-snapshot', 'aside-browse-basic', 'aside-browse-flow', 'aside-qa-quick',
    'aside-scrape-json', 'aside-canary-quick', 'hermetic-canary', 'hermetic-sentinel', 'first-task-scaffold',
    'skillmd-setup-discovery', 'skillmd-no-local-binary', 'skillmd-outside-git', 'session-awareness', 'operational-learning',
    'qa-quick', 'qa-b6-static', 'qa-b7-spa', 'qa-b8-checkout', 'qa-only-no-fix',
    'qa-fix-loop', 'qa-bootstrap', 'review-sql-injection', 'review-enum-completeness', 'review-base-branch',
    'review-design-lite', 'review-army-migration-safety', 'review-army-perf-n-plus-one', 'review-army-delivery-audit', 'review-army-quality-score',
    'review-army-json-findings', 'review-army-red-team', 'review-army-simplification', 'review-army-simplification-precision', 'review-army-consensus',
    'office-hours-spec-review', 'office-hours-forcing-energy', 'office-hours-builder-wildness', 'plan-ceo-review', 'plan-ceo-review-selective',
    'plan-ceo-review-benefits', 'plan-ceo-review-expansion-energy', 'plan-eng-review', 'plan-eng-review-artifact', 'plan-review-report',
    'plan-design-review-plan-mode', 'office-hours-phase4-fork', 'auq-format-gate', 'tpa-present', 'tpa-absent-linux',
    'tpa-broken', 'tpa-absent-darwin', 'tpa-apple-ban', 'ship-section-loading', 'plan-ceo-section-loading',
    'carve-section-loading', 'setup-gbrain-remote', 'setup-gbrain-bad-token', 'setup-gbrain-path4-local-pglite', 'plan-ceo-review-format-mode',
    'plan-ceo-review-format-approach', 'plan-eng-review-format-coverage', 'plan-eng-review-format-kind', 'plan-ceo-review-prosons-cadence', 'plan-review-prosons-format',
    'plan-review-prosons-hardstop-neg', 'plan-review-prosons-neutral-neg', 'plan-tune-inspect', 'codex-offered-office-hours', 'codex-offered-ceo-review',
    'codex-offered-design-review', 'codex-offered-eng-review', 'ship-base-branch', 'ship-local-workflow', 'review-dashboard-via',
    'retro', 'retro-base-branch', 'cso-full-audit', 'cso-diff-mode', 'cso-infra-scope',
    'learnings-show', 'timeline-event-flow', 'context-recovery-artifacts', 'context-save-writes-file', 'context-restore-loads-latest',
    'context-save-routing', 'context-save-then-restore-roundtrip', 'context-restore-fragment-match', 'context-restore-empty-state', 'context-restore-list-delegates',
    'context-restore-legacy-compat', 'context-save-list-current-branch', 'context-save-list-all-branches', 'document-release', 'codex-review',
    'outside-voice-codex-to-claude-code', 'outside-voice-claude-code-to-codex', 'outside-plan-disabled-no-fallback', 'ship-coverage-audit', 'review-coverage-audit',
    'plan-eng-coverage-audit', 'ship-triage', 'ship-docsync', 'docsync-spawned', 'design-consultation-core',
    'design-consultation-existing', 'design-consultation-research', 'design-consultation-preview', 'plan-design-review-no-ui-scope', 'design-review-fix',
    'design-review-detector-shim', 'design-review-detector-shim-dom', 'design-review-plugin-handoff', 'design-html-slop-gate', 'diagram-triplet', 'diagram-authoring-quality',
    'gstack-upgrade-happy-path', 'land-and-deploy-workflow', 'land-and-deploy-first-run', 'land-and-deploy-review-gate', 'canary-workflow',
    'benchmark-workflow', 'setup-deploy-workflow', 'autoplan-dual-voice', 'scrape-match-path', 'scrape-prototype-path',
    'skillify-happy-path', 'skillify-provenance-refusal', 'skillify-approval-reject', 'journey-ideation', 'journey-plan-eng',
    'journey-debug', 'journey-qa', 'journey-code-review', 'journey-ship', 'journey-docs',
    'journey-retro', 'journey-design-system', 'journey-visual-qa', 'fanout-arm-overlay-on', 'fanout-arm-overlay-off',
    'office-hours-brain-writeback', 'arm-benchmark-native-overbuild', 'arm-benchmark-crud-endpoint', 'arm-benchmark-bugfix-decoys', 'office-hours-section-loading',
  ];
  const file = 'test/session-runner-stream-lifecycle.test.ts';
  expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(expected.sort());
  expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
});


test('collection completion lifecycle selects the existing native counter consumers', () => {
  const selected = selectTests(['test/plan-count-collection-completion.test.ts'], E2E_TOUCHFILES);
  expect(selected.reason).toBe('diff');
  expect(selected.selected.length).toBeGreaterThan(0);
  expect(selected.selected.sort()).toEqual(
    selectTests(['test/plan-count-timeout.test.ts'], E2E_TOUCHFILES).selected.sort());
  expect(selectTests(['test/plan-count-collection-completion.test.ts'], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
});

for (const file of ['test/plan-count-cross-cwd-ancestry.test.ts', 'test/fixtures/plan-count-cross-cwd-ancestry-0bcd.json']) {
  test(`${file} selects native cwd continuation consumers`, () => {
    const selected = selectTests([file], E2E_TOUCHFILES);
    expect(selected.reason).toBe('diff');
    expect(selected.selected.sort()).toEqual([
      'auto-decide-preserved', 'autoplan-chain-pty', 'conductor-prose',
      'plan-ceo-finding-count', 'plan-ceo-mode-routing', 'plan-ceo-split-overflow',
      'plan-design-finding-count', 'plan-design-review-plan-mode', 'plan-design-with-ui-scope',
      'plan-devex-finding-count', 'plan-eng-finding-count', 'plan-eng-multi-finding-batching',
      'plan-eng-review-plan-mode',
    ].sort());
    expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
  });
}


test('native clipped regressions retain the existing parser and owned-permission selection', () => {
  for (const [dependency, count, files] of [
    ['test/helpers/claude-pty-runner.ts', 22, [
      'test/plan-count-clipped-elision.test.ts', 'test/fixtures/eng-d1-clipped-elision-1579.json', 'test/fixtures/eng-d2-planning-prelude-4d.json',
    ]],
    ['test/helpers/plan-count-file-permission.ts', 10, [
      'test/plan-edit-cropped-permission.test.ts', 'test/fixtures/plan-edit-cropped-permission-1579.json',
    ]],
  ] as const) {
    const expected = selectTests([dependency], E2E_TOUCHFILES).selected.sort();
    expect(expected).toHaveLength(count);
    for (const file of files) {
      expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(expected);
      expect(selectTests([file], LLM_JUDGE_TOUCHFILES).selected).toEqual([]);
    }
  }
});
