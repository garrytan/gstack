import { expect, test } from 'bun:test';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const ptyIds = [
  'plan-ceo-review-plan-mode', 'plan-eng-review-plan-mode', 'plan-design-review-plan-mode-smoke',
  'plan-devex-review-plan-mode', 'plan-mode-no-op', 'office-hours-auto-mode',
  'auto-decide-preserved', 'plan-ceo-mode-routing', 'plan-design-with-ui-scope', 'plan-eng-finding-floor',
  // The two formerly keyless AUQ probes (W1b) import the same SDK capture helper as auq-format-gate, which reaches the PTY runner.
  'auq-format-gate', 'auq-consistency', 'auq-verbose-vs-carved-ab', ...['browse', 'codex', 'design-consultation', 'design-html', 'design-shotgun', 'document-release', 'investigate', 'land-and-deploy',
    'plan-design-review', 'plan-devex-review', 'plan-eng-review', 'qa', 'retro', 'review', 'setup-gbrain', 'spec'].map(skill => `carve-section-loading-${skill}`),
  'office-hours-section-loading', 'office-hours-design-draft', 'plan-ceo-section-loading', 'ship-section-loading',
  'plan-ceo-finding-floor', 'plan-design-finding-floor', 'plan-devex-finding-floor',
  'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow', 'plan-eng-review-artifact', 'plan-eng-review-artifact-full',
  // The /autoplan guard's live cases drive the same PTY runner (Oct 7 wave).
  'autoplan-guard-pty', 'autoplan-long-session',
].sort();

test('PTY supervision controls select every current runner consumer', () => {
  expect(selectTests(['test/helpers/claude-pty-runner.ts'], E2E_TOUCHFILES).selected.sort()).toEqual(ptyIds);
});

test('screen changes also select UI and all finding-floor consumers', () => {
  expect(selectTests(['test/helpers/pty-screen.ts'], E2E_TOUCHFILES).selected.sort()).toEqual(ptyIds);
});

test.each(['test/helpers/bootstrap-retention.ts'])('%s selects the actual bootstrap contract', file => {
  expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(['qa-bootstrap', 'qa-fix-loop', 'qa-only-no-fix', 'qa-quick']);
});
