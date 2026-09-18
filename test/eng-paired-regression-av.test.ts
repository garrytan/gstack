import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

// Public excerpts from the acknowledged first AV Engineering plan. The rule,
// table and task retain their original section owners and exact wording.
const plan = readFileSync(new URL('./fixtures/eng-paired-regression-av.md', import.meta.url), 'utf8');
const regression = (text: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, text, 0, 1).regression;
const task = plan.slice(plan.indexOf('- [ ] **T4'));

test('a required legacy fixture baseline and its same-fixture parity test share one owned task', () => {
  expect(regression(plan)).toBe('plan');
  for (const value of [plan.replaceAll('T4', 'T17'), plan.replaceAll('AuthBroker', 'TenantBroker'), plan.replaceAll('test/auth/', 'checks/'), plan.replace(/[`*]/g, ''), plan.replace('record\n', 'capture\n')]) expect(regression(value)).toBe('plan');
});

const negatives: Array<[string, (text: string) => string]> = [
  ['optional rule', t => t.replace('mandatory, no decision required', 'optional, no decision required')],
  ['different legacy target', t => t.replace('`legacyAuthFlow()` outputs', '`differentFlow()` outputs')],
  ['no baseline', t => t.replace('before any rewrite begins', 'after the rewrite begins')],
  ['different parity fixture', t => t.replace('the same fixtures', 'a different set of fixtures')],
  ['no parity agreement', t => t.replace('identical results', 'approximate results')],
  ['no task', t => t.replace(task, '')],
  ['no regression table row', t => t.replace(/^\| `test\/auth\/legacyAuthFlow.*\n/m, '')],
  ['no parity table row', t => t.replace(/^\| `test\/auth\/parity.*\n/m, '')],
  ['foreign table target', t => t.replace('legacy and AuthBroker agree', 'legacy and AnotherBroker agree')],
  ['foreign task target', t => t.replace('parity test against AuthBroker', 'parity test against AnotherBroker')],
  ['wrong task file', t => t.replace('  - Files: `test/auth/legacyAuthFlow.regression.test.ts`', '  - Files: `test/auth/another.test.ts`')],
  ['no task verification', t => t.replace('  - Verify: both suites green before and after the rewrite', '')],
  ['post-rewrite verification only', t => t.replace('green before and after', 'green after')],
  ['verification belongs to another task', t => t.replace('  - Verify:', '- [ ] T99 — unrelated — Another task\n  - Verify:')],
  ['duplicate task identity', t => t + task],
  ['duplicate Files field', t => t.replace('  - Files:', '  - Files: different.test.ts\n  - Files:')],
  ['historical parent', t => t.replace('# Plan:', '# Historical plan:')],
  ['fenced plan', t => '```markdown\n' + t + '\n```'],
  ['quoted plan', t => t.split('\n').map(line => '> ' + line).join('\n')],
  ['current task withdrawn', t => t + '\n## Current assessment\nT4 is withdrawn.'],
  ['current task deferred', t => t + '\n## Current assessment\nT4 is deferred.'],
  ['current task explicitly cancelled', t => t + '\n## Current assessment\nDo not run T4.'],
  ['current legacy suite explicitly cancelled', t => t + '\n## Current assessment\nDo not run the legacy regression suite.'],
  ['current legacy suite withdrawn', t => t + '\n## Current assessment\nThe legacy regression suite is withdrawn.'],
  ['current task status row', t => t + '\n## Current assessment\n| T4 | Withdrawn |'],
  ['legacy changed before baseline', t => t + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T4.'],
];
test.each(negatives)('%s cannot provide baseline coverage', (_, change) => {
  const value = change(plan); expect(value).not.toBe(plan); expect(regression(value)).toBeUndefined();
});

test('approval and source frames do not turn proposals into current required work', () => {
  for (const frame of ['Source:', 'Historical example:', 'If approved:', 'Once authorized:', 'Provided approval:', 'Pending acceptance:']) {
    for (const at of ['**REGRESSION RULE', '| `test/auth/legacyAuthFlow', '- [ ] **T4', '  - Verify:']) {
      expect(regression(plan.replace(at, frame + '\n' + at)), frame + ' at ' + at).toBeUndefined();
    }
  }
});

test('owned status overrides earlier claims without treating quoted history as current', () => {
  for (const owner of ['T4', 'T4 baseline verification', 'The legacy regression suite']) {
    for (const status of ['withdrawn', 'deferred', 'optional', 'not current', 'no longer required']) {
      for (const quote of ['', '"', "'", '`']) {
        expect(regression(plan + `\n## Current assessment\n${owner} is ${quote}${status}${quote}.`)).toBeUndefined();
      }
    }
  }
  for (const note of ['"T4 is withdrawn."', "'T4 is withdrawn.'", 'If T4 is withdrawn, reconsider rollout.', 'T99 is withdrawn.', 'Do not run T99.', '"Do not run T4."', 'If the token is accepted, assert its tenant scope.']) expect(regression(plan + '\n## Current assessment\n' + note)).toBe('plan');
  for (const note of ['This verification is withdrawn.', 'This verification is `no longer current`.']) expect(regression(plan.replace('both suites green before and after the rewrite', 'both suites green before and after the rewrite; ' + note))).toBeUndefined();
});

test('the fixture and controls select only Engineering finding count', () => {
  for (const file of ['test/eng-paired-regression-av.test.ts', 'test/fixtures/eng-paired-regression-av.md']) expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name)).toEqual(['plan-eng-finding-count']);
});
