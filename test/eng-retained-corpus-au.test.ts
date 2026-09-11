import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
const report = readFileSync(new URL('./fixtures/eng-retained-corpus-au.md', import.meta.url), 'utf8');
const regression = (s: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, s, 0, 1).regression;
const required = report.match(/^### CRITICAL regression test[^\n]+\n[\s\S]*?(?=\n### )/m)![0];
const retained = report.match(/^- `legacyAuthFlow\(\)`: retained[\s\S]*?(?=\n\n)/m)![0];
const task = report.match(/^- \[ \] \*\*T4 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n' + required + '\n## What already exists\n' + retained + '\n\n## Implementation Tasks\n' + task;
test('a mandatory recorded corpus owns parity against a retained legacy baseline', () => {
  expect(regression(report)).toBe('plan');
  expect(regression(compact)).toBe('plan');
  for (const s of [compact.replaceAll('T4', 'T17'), compact.replaceAll('test/auth/legacy-parity.regression.test.ts', 'tests/recorded.test.js'), compact.replace('Record a corpus', 'Capture a corpus'), compact.replace('new `AuthBroker` path', 'new `ReplacementBroker` path'), compact.replace(/[`*]/g, '')]) expect(regression(s)).toBe('plan');
});
const cases: Array<[string, (s: string) => string]> = [
  ['missing requirement', s => s.replace(required, '')],
  ['optional requirement', s => s.replace('mandatory under', 'optional under')],
  ['not mandatory', s => s.replace('mandatory under', 'not mandatory under')],
  ['no legacy decisions', s => s.replace('legacy decision for each', 'new broker decision for each')],
  ['different outcomes', s => s.replace('assert identical', 'assert different')],
  ['partial parity', s => s.replace('for every entry', 'for selected entries')],
  ['no persistent oracle', s => s.replace('- This test is also the shadow-mode oracle; it stays after legacy deletion,\n  re-pointed at the recorded decisions.', '')],
  ['no retained baseline', s => s.replace(retained, '')],
  ['different legacy target', s => s.replace('`legacyAuthFlow()`: retained', '`differentFlow()`: retained')],
  ['legacy is rewritten', s => s.replace('`: retained behind', '`: rewritten behind')],
  ['no task', s => s.replace(task, '')],
  ['different task file', s => s.replace('  - Files: test/auth/legacy-parity.regression.test.ts', '  - Files: test/auth/other.test.ts')],
  ['missing verification', s => s.replace('  - Verify: 100% decision + reason-code parity across the corpus', '')],
  ['partial verification', s => s.replace('100% decision', '50% decision')],
  ['neighbor verification', s => s.replace('  - Verify: 100%', '- [ ] T99 — other task\n  - Verify: 100%')],
  ['duplicate task', s => s.replace(task, task + task)],
  ['duplicate Files', s => s.replace('  - Files:', '  - Files: another.test.ts\n  - Files:')],
  ['do not add', s => s.replace('Add `test/', 'Do not add `test/')],
  ['do not record', s => s.replace('- Record a corpus', '- Do not record a corpus')],
  ['do not implement task', s => s.replace('CRITICAL: recorded-corpus', 'Do not implement CRITICAL: recorded-corpus')],
  ['conditional requirement', s => s.replace('Add `test/', 'If approved:\nAdd `test/')],
  ['conditional task', s => s.replace(task, 'Once approved:\n' + task)],
  ['quoted requirement', s => s.replace(required, required.split('\n').map(l => '> ' + l).join('\n'))],
  ['fenced requirement', s => s.replace(required, '```\n' + required + '\n```')],
  ['historical plan', s => s.replace('Current reviewed plan', 'Historical reviewed plan')],
  ['quoted owner', s => 'Source:\n' + s.replace('# Current reviewed plan\n', '')],
  ['changed baseline before task', s => s + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T4.\n'],
  ['withdrawn status row', s => s + '\n## Current assessment\n| T4 | Withdrawn |\n'],
];
test.each(cases)('%s cannot grant regression coverage', (_, change) => {
  const changed = change(compact); expect(changed).not.toBe(compact); expect(regression(changed)).toBeUndefined();
});
test('current withdrawals cancel the owned task; historical quotations do not', () => {
  for (const owner of ['T4', 'T4 verification', 'the legacy regression suite', 'this corpus']) for (const status of ['withdrawn', 'not current', 'optional']) for (const [a,b] of [['',''], ['"','"'], ["'","'"], ['“','”'], ['‘','’'], ['`','`']]) expect(regression(compact + `\n## Current assessment\n${owner} is ${a}${status}${b}.`)).toBeUndefined();
  for (const tail of ['\n## History\nT4 is withdrawn.', '\n## Current assessment\n"T4 is withdrawn."', '\n## Current assessment\nIf T4 is withdrawn, reassess.', '\n## Current assessment\nT9 is withdrawn.']) expect(regression(compact + tail)).toBe('plan');
});
test('approval punctuation does not make the corpus or its verification unconditional', () => {
  for (const prefix of ['If approved,', 'Once approved,', 'When approved,', 'Pending approval,']) {
    expect(regression(compact.replace('Add `test/', prefix + '\nAdd `test/'))).toBeUndefined();
    expect(regression(compact.replace(task, prefix + '\n' + task))).toBeUndefined();
    expect(regression(compact.replace('  - Verify:', '  ' + prefix + '\n  - Verify:'))).toBeUndefined();
  }
  expect(regression(compact + '\n## Current assessment\nT4 is conditional on approval.')).toBeUndefined();
});
test('local source labels do not assert a required corpus', () => {
  for (const prefix of ['Source.', 'Historical assessment:', 'Quoted source.']) expect(regression(compact.replace('Add `test/', prefix + '\nAdd `test/'))).toBeUndefined();
});
test('rewriting the oracle before recording its corpus invalidates the baseline', () => {
  for (const statement of ['legacyAuthFlow() is rewritten before the corpus is recorded.', 'legacyAuthFlow() is deleted before the regression baseline is captured.', 'The corpus is recorded only after legacyAuthFlow() is rewritten.', 'The legacy regression baseline is rewritten.']) expect(regression(compact + '\n## Current assessment\n' + statement)).toBeUndefined();
});
test('an unrelated suite status and a token input condition leave current legacy coverage intact', () => {
  expect(regression(compact + '\n## Payment regression suite\nThe regression suite is withdrawn.')).toBe('plan');
  expect(regression(compact.replace('legacy decision for each.', 'legacy decision for each.\n- Also assert rejection if the token is expired.'))).toBe('plan');
});

test('current named legacy suite headings retain ownership of their withdrawals', () => {
  for (const title of ['Current legacy regression suite', 'legacyAuthFlow() regression suite', 'Recorded legacy parity test']) expect(regression(compact + `\n## ${title}\nThe regression suite is withdrawn.`)).toBeUndefined();
  for (const title of ['Payment regression suite', 'Current Payment regression suite']) expect(regression(compact + `\n## ${title}\nThe regression suite is withdrawn.`)).toBe('plan');
});

test('a never-mandatory declaration cannot grant mandatory regression coverage', () => {
  expect(regression(compact.replace('mandatory under', 'never mandatory under'))).toBeUndefined();
});
