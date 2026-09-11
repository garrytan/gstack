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

const inlineRequired = `# Current reviewed plan
## Required tests
- **CRITICAL regression (T4)** \`auth/legacy-parity.test.ts\`:
  Record legacyAuthFlow() outputs before any change. Run the same fixtures
  against the new path; assert identical session shape and identical rejection class.
- **Other test** unrelated.test.ts: tests another feature.
## Implementation Tasks
- [ ] **T4 (P1)** — auth/tests — Regression: pin legacyAuthFlow() behavior
  - Files: auth/legacy-parity.test.ts
  - Verify: suite green on legacy before any refactor commit; green on both paths before rollout
## Verification
1. Run T4 against the untouched legacy path and commit the fixtures first.
2. Land the replacement and run T4 on both paths.
`;
test('inline required regression binds its own task, baseline and same-fixture parity', () => {
  expect(regression(inlineRequired)).toBe('plan');
  expect(regression(inlineRequired.replaceAll('T4', 'T17').replaceAll('auth/legacy-parity.test.ts', 'spec/old-path.test.ts'))).toBe('plan');
  expect(regression(inlineRequired.replace('CRITICAL regression', 'MANDATORY characterization').replace('Record', 'Capture')
    .replace('Run the same', 'Replay the same').replace('identical session shape', 'matching outputs')
    .replace('suite green on legacy', 'tests pass on the legacy path').replace('untouched', 'unmodified'))).toBe('plan');
  for (const change of [
    (s: string) => s.replace('CRITICAL regression', 'Optional regression'),
    (s: string) => s.replace('CRITICAL regression', 'CRITICAL regression withdrawn'),
    (s: string) => s.replace('## Required tests', '## Historical required tests'),
    (s: string) => s.replace('  Record', '  If approved, record'),
    (s: string) => s.replace('outputs before', 'behavior after'),
    (s: string) => s.replace('same fixtures', 'different fixtures'),
    (s: string) => s.replace('new path', 'unrelated path'),
    (s: string) => s.replace('identical rejection class', 'unspecified behavior'),
    (s: string) => s.replace('  - Files: auth/legacy-parity.test.ts', '  - Files: auth/other.test.ts'),
    (s: string) => s.replace('green on legacy before', 'red on legacy before'),
    (s: string) => s.replace('green on both paths', 'green on new path'),
    (s: string) => s.replace('untouched legacy', 'rewritten legacy'),
    (s: string) => s.replace('1. Run T4', '1. Run T9'),
    (s: string) => s + '\n## Current status\nT4 is "withdrawn".\n',
    (s: string) => s + '\n## Current status\nChange T4 assertions to match the new behavior.\n',
    (s: string) => s.split('\n').map(line => '> ' + line).join('\n'),
  ]) expect(regression(change(inlineRequired))).toBeUndefined();
});

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

// Verbatim owned rule, T1 and ordered verification from the failed AZ report.
const orderedRuleReport = "# Current reviewed plan\n\n### REGRESSION RULE — CRITICAL, no approval needed (skill iron rule)\n\nPLAN.md:27-28 rewrites `legacyAuthFlow()` with no regression test;\nPLAN.md:14-16 excluded it from coverage. That is modified existing behavior\nwith no covering test. **Before** the rewrite, add\n`legacyAuthFlow.characterization.test.ts` capturing current outputs for:\nvalid token, expired token, wrong tenant, wrong audience, revoked token,\nIDP unavailable. The rewrite must pass the same suite unchanged.\n\n## Implementation Tasks\n- [ ] **T1 (P1, human: ~half day / CC: ~15min)** — legacyAuthFlow — Write characterization suite for 6 prior behaviors BEFORE rewrite\n  - Surfaced by: Test review — REGRESSION RULE, PLAN.md:27-28 and 14-16\n  - Files: `legacyAuthFlow.characterization.test.ts`\n  - Verify: suite green on current code; green again after rewrite\n\n## Verification (end to end)\n1. Run T1's characterization suite on unmodified code: green.\n2. Implement T2-T6; run unit suites: green, no shared-state ordering flakes (run with shuffled order).\n3. Run T7 E2E: A/B isolation, suspend-mid-mint denial, double-submit consistency all green.\n4. Re-run T1 after the rewrite: green, unchanged.\n";

test('an iron-rule declaration and ordered task verification establish the mandatory baseline',()=>{
 expect(regression(orderedRuleReport)).toBe('plan');
 for(const change of [(s:string)=>s.replaceAll('T1','T17'),(s:string)=>s.replaceAll('legacyAuthFlow.characterization.test.ts','spec/legacy-golden.test.ts'),(s:string)=>s.replace(/[`*]/g,''),
  (s:string)=>s+'\n## History\nT1 is withdrawn.\n',(s:string)=>s+'\n## Current assessment\n"T1 is withdrawn."\n',(s:string)=>s+'\n## Payment regression suite\nThe regression suite is withdrawn.\n'])expect(regression(change(orderedRuleReport))).toBe('plan');
});
test('the ordered baseline stays owned, required, and unchanged across the rewrite',()=>{
 for(const [before,after] of [
  ['no approval needed','optional if approved'],['skill iron rule','hypothetical example'],['legacyAuthFlow','otherAuthFlow'],
  ['**Before** the rewrite','After the rewrite'],['capturing current outputs','capturing expected outputs'],
  ['The rewrite must pass the same suite unchanged.','The rewrite may update the expectations.'],
  ['suite green on current code; green again after rewrite','suite green on changed code; green again after rewrite'],
  ['suite green on current code','suite is not green on current code'],['green again after rewrite','not green again after rewrite'],
  ['on unmodified code: green.','on unmodified code: not green.'],['after the rewrite: green, unchanged.','after the rewrite: failing, unchanged.'],
  ['1. Run T1','1. Run T9'],['on unmodified code: green','on changed code: green'],['1. Run ','1. If approved, Run '],
  ['4. Re-run T1','4. Re-run T9'],['green, unchanged.','green, with updated expectations.'],
  ['## Implementation Tasks\n','## Implementation Tasks\nSource:\n'],['## Implementation Tasks\n','## Implementation Tasks\nOnce approved,\n'],
  ['PLAN.md:27-28','Source:\nPLAN.md:27-28'],['Current reviewed plan','Historical reviewed plan'],
 ]){const changed=orderedRuleReport.replaceAll(before!,after!);expect(changed).not.toBe(orderedRuleReport);expect(regression(changed)).toBeUndefined();}
 for(const change of [(s:string)=>s.replace(/^  - Files: .*$/m,'  - Files: different.test.ts'),(s:string)=>s.replace(/^1\. .*$/m,''),
  (s:string)=>s.replace(/^1\. .*$/m,'1. Rewrite legacyAuthFlow() before recording T1.'),(s:string)=>s.replace(/^(1\. )(.*)$/m,'$1"$2"'),
  (s:string)=>s.replace(/^4\. .*$/m,''),(s:string)=>s.split('\n').map(l=>'> '+l).join('\n'),(s:string)=>'```\n'+s+'\n```',
  (s:string)=>s+'\n## Current assessment\nT1 is withdrawn.\n',(s:string)=>s+'\n## Current assessment\nT1 verification is "optional".\n',
  (s:string)=>s+'\n## Current assessment\nDo not run T1.\n',(s:string)=>s+'\n## Current assessment\nlegacyAuthFlow() is rewritten before T1.\n',
  (s:string)=>s+'\n## Current assessment\nUpdate T1 assertions.\n']){const changed=change(orderedRuleReport);expect(changed).not.toBe(orderedRuleReport);expect(regression(changed)).toBeUndefined();}
});

test('required regression relations survive heading, task and verification paraphrases',()=>{
 const changed=orderedRuleReport.replace('REGRESSION RULE — CRITICAL, no approval needed (skill iron rule)','Required characterization baseline')
  .replace('The rewrite must pass the same suite unchanged.','The same suite must remain green unchanged after the rewrite.')
  .replace('Write characterization suite for 6 prior behaviors BEFORE rewrite','Add characterization tests for existing outputs')
  .replace('suite green on current code; green again after rewrite','current implementation passes; after the rewrite the suite passes again')
  .replace("1. Run T1's characterization suite on unmodified code: green.",'1) Execute characterization task T1 against untouched code; it must pass.')
  .replace('4. Re-run T1 after the rewrite: green, unchanged.','4) Execute the same T1 tests unchanged after the refactor; they must pass.');
 expect(regression(changed)).toBe('plan');
});
