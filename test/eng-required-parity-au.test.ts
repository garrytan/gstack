import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
const report = readFileSync(new URL('./fixtures/eng-required-parity-au.md', import.meta.url), 'utf8');
const regression = (plan: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, plan, 0, 1).regression;
const required = report.match(/^### Required tests[^\n]+\n[\s\S]*?(?=\n## )/m)![0];
const baseline = report.match(/^- \[ \] \*\*T4 .*\n(?:  .*(?:\n|$))*/m)![0];
const parity = report.match(/^- \[ \] \*\*T6 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n' + required + '\n## Implementation Tasks\n' + baseline + parity;

test('the acknowledged required-test oracle owns its unchanged baseline and separate parity task', () => {
  expect(createHash('sha256').update(report).digest('hex')).toBe('8c4b2ea61293a0f8a3b78e6e30017065e5b6dc2211cd95262d0a1c63a0947189');
  expect(regression(report)).toBe('plan');
  expect(regression(compact)).toBe('plan');
  for (const text of [compact.replaceAll('T4', 'T14').replaceAll('T6', 'T16'), compact.replaceAll('legacyAuthFlow.regression.test.ts', 'tests/prior-auth.test.js'), compact.replaceAll('auth-parity.test.ts', 'tests/parity.test.js'), compact.replaceAll('Pin current behavior', 'Capture current behavior'), compact.replaceAll('pinning current', 'capturing current'), compact.replaceAll('unmodified legacyAuthFlow()', 'untouched legacyAuthFlow()'), compact.replace(/[`*]/g, '')]) expect(regression(text)).toBe('plan');
});
const negatives: Array<[string, (value: string) => string]> = [
  ['declaration missing', t => t.replace(required, '')],
  ['mandatory declaration optional', t => t.replace('regression rule, mandatory, no decision needed', 'regression rule, optional')],
  ['no protected legacy target', t => t.replace('`legacyAuthFlow()` before any change:', '`otherFlow()` before any change:')],
  ['capture after change', t => t.replace('`legacyAuthFlow()` before any change:', '`legacyAuthFlow()` after any change:')],
  ['no parity oracle', t => t.replace('This is\nthe oracle for the parity suite', 'This is\nunrelated to the parity suite')],
  ['different parity outcomes', t => t.replace('assert identical\noutcome', 'assert different\noutcome')],
  ['only one path', t => t.replace('both paths (flag off, flag on)', 'only the new path (flag on)')],
  ['baseline task missing', t => t.replace(baseline, '')],
  ['baseline task renamed inconsistently', t => t.replace('current legacyAuthFlow() behavior', 'current otherFlow() behavior')],
  ['task file mismatch', t => t.replace('  - Files: legacyAuthFlow.regression.test.ts', '  - Files: another.test.ts')],
  ['parity task missing', t => t.replace(parity, '')],
  ['parity file mismatch', t => t.replace('  - Files: auth-parity.test.ts', '  - Files: another.test.ts')],
  ['parity task one path', t => t.replace('through flag-off and flag-on paths', 'through only flag-on path')],
  ['parity verification missing', t => t.replace('  - Verify: suite green for every row; becomes the exit criterion for TODO 1', '')],
  ['modified baseline', t => t.replace('unmodified legacyAuthFlow()', 'rewritten legacyAuthFlow()')],
  ['baseline verification missing', t => t.replace('  - Verify: test passes against unmodified legacyAuthFlow() first', '')],
  ['baseline verification neighbor', t => t.replace('  - Verify: test passes', '- [ ] T99 — other — Unrelated test\n  - Verify: test passes')],
  ['duplicate baseline task', t => t.replace(baseline, baseline + baseline)],
  ['duplicate baseline file', t => t.replace('  - Files: legacyAuthFlow.regression.test.ts', '  - Files: legacyAuthFlow.regression.test.ts\n  - Files: another.test.ts')],
  ['historical ancestor', t => t.replace('# Current reviewed plan', '# Historical reviewed plan')],
  ['source owner', t => 'Source:\n' + t.replace('# Current reviewed plan\n', '')],
  ['quoted requirements', t => t.replace(required, required.split('\n').map(l => '> ' + l).join('\n'))],
  ['fenced requirements', t => t.replace(required, '```\n' + required + '\n```')],
  ...['If approved:', 'Once approved:', 'When approved:', 'Pending approval:', 'Source:'].flatMap(prefix => [
    ['conditional baseline ' + prefix, (t: string) => t.replace(baseline, prefix + '\n' + baseline)],
    ['conditional verification ' + prefix, (t: string) => t.replace('  - Verify: test passes', '  ' + prefix + '\n  - Verify: test passes')],
    ['conditional requirement ' + prefix, (t: string) => t.replace('**CRITICAL (', prefix + '\n**CRITICAL (')],
  ] as Array<[string, (t: string) => string]>),
  ['changed legacy before baseline', t => t + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T4.\n'],
  ['current task status row', t => t + '\n## Current assessment\n| T4 | Withdrawn |\n'],
];
test.each(negatives)('%s does not supply baseline coverage', (_, change) => {
  const changed = change(compact); expect(changed).not.toBe(compact); expect(regression(changed)).toBeUndefined();
});
test('owned current scalar statuses cancel; whole quoted history and foreign tasks do not', () => {
  for (const owner of ['T4', 'T6', 'T4 baseline verification', 'the legacy regression suite']) for (const status of ['withdrawn', 'not current', 'no longer current', 'optional']) for (const [open, close] of [['',''], ['"','"'], ["'","'"], ['“','”'], ['‘','’'], ['`','`']]) {
    expect(regression(compact + `\n## Current assessment\n**${owner}** is ${open}${status}${close}.`), `${owner} ${open}${status}${close}`).toBeUndefined();
  }
  for (const tail of ['\n## History\n"T4 is withdrawn."', "\n## History\n'T4 is withdrawn.'", '\n## Current assessment\n"T4 is withdrawn."', '\n## Current assessment\nIf T4 is withdrawn, reconsider rollout.', '\n## Current assessment\nT9 is withdrawn.', '\n## Payment regression suite\nThe regression suite is withdrawn.']) expect(regression(compact + tail), tail).toBe('plan');
});
test('new controls select only the engineering finding-count workflow', () => {
  for (const file of ['test/eng-required-parity-au.test.ts', 'test/fixtures/eng-required-parity-au.md']) expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name)).toEqual(['plan-eng-finding-count']);
});

test('own declaration and baseline verification currentness survives scalar quote normalization', () => {
  for (const status of ['withdrawn', 'no longer current', 'proposed']) for (const [open, close] of [['',''], ['"','"'], ["'","'"], ['“','”'], ['‘','’'], ['`','`']]) {
    const tail = `This verification is ${open}${status}${close}.`;
    for (const boundary of ['\n  ', '; ']) expect(regression(compact.replace('unmodified legacyAuthFlow() first', 'unmodified legacyAuthFlow() first' + boundary + tail))).toBeUndefined();
    expect(regression(compact.replace('What\nbreaks without it:', `This requirement is ${open}${status}${close}. What\nbreaks without it:`))).toBeUndefined();
  }
});


test('owned baseline and parity tasks may share a file and assert conditional input behavior', () => {
  for (const value of [
    compact.replaceAll('auth-parity.test.ts', 'legacyAuthFlow.regression.test.ts'),
    compact.replace('What\nbreaks without it:', 'The regression suite must assert rejection if the token is expired. What\nbreaks without it:'),
    compact.replace('  - Files: legacyAuthFlow.regression.test.ts', '  - Cases: Assert rejection if the token is expired.\n  - Files: legacyAuthFlow.regression.test.ts'),
    compact.replace('What\nbreaks without it:', 'If the token is expired, assert rejection. What\nbreaks without it:'),
  ]) expect(regression(value)).toBe('plan');
});

test('mandatory status and owned actions stay affirmative while approval conditions stay unowned', () => {
  for (const negation of ['not mandatory', 'never mandatory', 'no longer mandatory']) {
    expect(regression(compact.replace('regression rule, mandatory, no decision needed', 'regression rule, ' + negation))).toBeUndefined();
  }
  for (const prefix of ['Do not write the ', "Don't write the ", 'Never add the ']) {
    expect(regression(compact.replace('— legacyAuthFlow — CRITICAL regression test', '— legacyAuthFlow — ' + prefix + 'CRITICAL regression test'))).toBeUndefined();
  }
  for (const prefix of ['Do not implement the ', "Don't implement the ", 'Never add the ']) {
    expect(regression(compact.replace('— tests — Table-driven parity suite', '— tests — ' + prefix + 'table-driven parity suite'))).toBeUndefined();
  }
  for (const prefix of ['If authorized:', 'Unless approved:', 'Assuming approval:', 'Provided approval:', 'If requested:']) {
    expect(regression(compact.replace('**CRITICAL (', prefix + '\n**CRITICAL ('))).toBeUndefined();
    expect(regression(compact.replace(baseline, prefix + '\n' + baseline))).toBeUndefined();
    expect(regression(compact.replace('  - Verify: test passes', '  ' + prefix + '\n  - Verify: test passes'))).toBeUndefined();
  }
});

test('conditional input acceptance is behavior; approval of the owned work is conditional scope', () => {
  for (const condition of [
    'If the token is accepted, assert the correct tenant.',
    'When the token is authorized, assert its tenant scope.',
    'If the token is rejected, assert the error response.',
  ]) expect(regression(compact.replace('What\nbreaks without it:', condition + ' What\nbreaks without it:'))).toBe('plan');
  for (const condition of [
    'If accepted:', 'Once authorized:', 'Pending acceptance:',
    'If the requirement is accepted:', 'When this work is approved:', 'If the reviewer approves:',
  ]) {
    expect(regression(compact.replace('**CRITICAL (', condition + '\n**CRITICAL ('))).toBeUndefined();
    expect(regression(compact.replace(baseline, condition + '\n' + baseline))).toBeUndefined();
  }
});

test('required capture and parity declarations must affirm their own action after the named file', () => {
  for (const command of ['Do not pin', "Don't capture", 'Never record']) {
    expect(regression(compact.replace('Pin current behavior', command + ' current behavior'))).toBeUndefined();
  }
  for (const command of ['Do not use one', "Don't use one", 'Never use the same']) {
    expect(regression(compact.replace('One fixture table', command + ' fixture table'))).toBeUndefined();
  }
  expect(regression(compact.replace('What\nbreaks without it:', 'The old review said "Do not pin current behavior." What\nbreaks without it:'))).toBe('plan');
  expect(regression(compact.replace('suite green for every row;', 'suite green for every row; old guidance said "Do not use one fixture table";'))).toBe('plan');
});
