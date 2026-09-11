import { expect, test } from 'bun:test';
import { E2E_TOUCHFILES } from './helpers/touchfiles';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
// Minimal verbatim public requirements/tasks/verification from the two failed
// September 11 Eng runs. Replays diagnose the oracle; they do not credit those runs.
const reports: string[] = [
  "# Current reviewed plan\n\n### REGRESSION RULE (mandatory, no decision needed)\n\n`legacyAuthFlow()` is existing behavior being rewritten with no existing test\non the changed path. **CRITICAL:** add\n`test/auth/legacyAuthFlow.regression.test` before any rewrite. It records\nthe observable outcomes (status, reason code, cache side effects) of\n`legacyAuthFlow()` for a fixture matrix (valid, expired, wrong issuer, wrong\naudience, revoked, suspended tenant, malformed) and asserts `AuthBroker`\nproduces identical outcomes on the same fixtures.\n\n## Implementation Tasks\n- [ ] **T4 (P1, human: ~4h / CC: ~10min)** — tests — CRITICAL regression test pinning legacyAuthFlow() behavior\n  - Surfaced by: Test review REGRESSION RULE — PLAN.md:27-28\n  - Files: test/auth/legacyAuthFlow.regression.test\n  - Verify: passes against legacy before any rewrite; passes against AuthBroker after\n\n## Verification\n1. Write T4 first and run it against the untouched `legacyAuthFlow()`; it must pass before any other change.\n",
  "# Current reviewed plan\n\n### CRITICAL: regression suite for `legacyAuthFlow()` (regression rule, mandatory)\n\n`test/auth/legacyAuthFlow.regression.test.ts`. Captures current behavior\nbefore any rewrite: every success path, every error path, cache interactions,\nand the invalidation hooks it triggers. Runs against the flag-off path after\nthe refactor. This is the highest-priority test in the plan.\n\n## Implementation Tasks\n- [ ] **T4 (P1, human: ~4 hr / CC: ~15 min)** — legacyAuthFlow — CRITICAL regression suite for prior behavior\n  - Surfaced by: Test review REGRESSION RULE — PLAN.md:14-16, 27-28\n  - Files: `test/auth/legacyAuthFlow.regression.test.ts`\n  - Verify: suite green before and after the refactor on the flag-off path\n\n## Verification\n1. Run the regression suite (T4) against the current `legacyAuthFlow()` before touching it; it must be green on the unmodified code.\n"
];
const regression = (plan: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, plan, 0, 1).regression;

test('mandatory named regression suites bind the task to an untouched baseline', () => {
  for (const report of reports) {
    expect(regression(report)).toBe('plan');
    for (const change of [
      (s: string) => s.replaceAll('T4', 'T17'),
      (s: string) => s.replaceAll('test/auth/legacyAuthFlow.regression.test', 'specs/old-auth.test'),
      (s: string) => s.replaceAll('AuthBroker', 'ReplacementBroker'),
      (s: string) => s.replace(/[`*]/g, ''),
      (s: string) => s + '\n## Future cleanup\nAfter 100% rollout for two weeks, delete legacyAuthFlow() and replace the parity test with a behavioral test.\n',
      (s: string) => s + '\n## History\nT4 is withdrawn.\n',
      (s: string) => s + '\n## Current assessment\n"T4 is withdrawn."\n',
      (s: string) => s + '\n## Payment regression suite\nThe regression suite is withdrawn.\n',
      (s: string) => s + '\n## Current assessment\nAfter committing the green baseline, run T4 after rewriting legacyAuthFlow().\n',
      (s: string) => s.replace('before any rewrite:', 'before any rewrite: A token receives success if accepted by legacyAuthFlow(). Rejected inputs receive the recorded error.'),
    ]) expect(regression(change(report))).toBe('plan');
  }
});

const controls: Array<[string, (s: string) => string]> = [
  ['missing declaration', s => s.replace(/### [\s\S]*?(?=## Implementation Tasks)/, '')],
  ['optional declaration', s => s.replaceAll('mandatory', 'optional')],
  ['never mandatory', s => s.replaceAll('mandatory', 'never mandatory')],
  ['missing legacy subject', s => s.replaceAll('legacyAuthFlow', 'otherAuthFlow')],
  ['no baseline capture', s => s.replace(/records|Captures/g, 'describes')],
  ['late baseline', s => s.replaceAll('before any rewrite', 'after any rewrite')],
  ['missing task', s => s.replace(/- \[ \] \*\*T4 [\s\S]*?(?=## Verification)/, '')],
  ['different task file', s => s.replace(/  - Files: .*/, '  - Files: test/other.test.ts')],
  ['missing verification', s => s.replace(/  - Verify: .*/, '')],
  ['missing baseline step', s => s.replace(/^1\. .*$/m, '')],
  ['rewritten baseline', s => s.replace(/untouched|unmodified/g, 'rewritten')],
  ['wrong task in baseline', s => s.replace(/^(1\. .*)T4/m, '$1T9')],
  ['quoted report', s => s.split('\n').map(l => '> ' + l).join('\n')],
  ['quoted baseline', s => s.replace(/^(1\. )(.*)$/m, '$1"$2"')],
  ['quoted declaration', s => s.replace(/(### [^\n]+\n)([\s\S]*?)(?=\n## Implementation Tasks)/, '$1"$2"')],
  ['fenced report', s => '```\n' + s + '\n```'],
  ['historical report', s => s.replace('Current reviewed plan', 'Historical reviewed plan')],
  ['source declaration', s => s.replace(/(### [^\n]+\n)/, '$1Source:\n')],
  ['conditional declaration', s => s.replace(/(### [^\n]+\n)/, '$1If approved,\n')],
  ['conditional task', s => s.replace('## Implementation Tasks\n', '## Implementation Tasks\nOnce approved,\n')],
  ['source task', s => s.replace('## Implementation Tasks\n', '## Implementation Tasks\nSource:\n')],
  ['explicit cancelled task', s => s + '\n## Current assessment\nDo not run T4.\n'],
  ['withdrawn task', s => s + '\n## Current assessment\nT4 is withdrawn.\n'],
  ['withdrawn verification', s => s + '\n## Current assessment\nT4 verification is optional.\n'],
  ['withdrawn legacy suite', s => s + '\n## Current assessment\nThe legacy regression suite is not required.\n'],
  ['quoted status', s => s + '\n## Current assessment\nT4 is "withdrawn".\n'],
  ['changed before baseline', s => s + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T4.\n'],
  ['conditional mandatory heading', s => s.replace('mandatory', 'mandatory if approved')],
  ['conditional numbered baseline', s => s.replace(/^1\. /m, '1. Once approved, ')],
  ['conditional verification line', s => s.replace('  - Verify: ', '  - Verify: If approved, ')],
  ['hypothetical baseline', s => s + '\n## Current assessment\nT4 baseline verification is hypothetical.\n'],
  ['current post-rewrite instruction', s => s + '\n## Current assessment\nRun T4 only after rewriting legacyAuthFlow().\n'],
  ['post-rewrite baseline row', s => s.replace(/^1\. .*$/m, '1. Rewrite legacyAuthFlow() first, then run T4 against the unmodified legacyAuthFlow() snapshot; it must be green before rollout.')],
];
test.each(controls)('%s cannot provide mandatory regression coverage', (_, change) => {
  for (const report of reports) {
    const changed = change(report);
    expect(changed).not.toBe(report);
    expect(regression(changed)).toBeUndefined();
  }
});

test('the regression evidence test selects its existing Eng workflow', () => {
  expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes('test/eng-scheduled-regression.test.ts')).map(([name]) => name)).toEqual(['plan-eng-finding-count']);
});
