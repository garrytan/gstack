import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

// Exact public Write acknowledged in the first AS attempt. The paid failure
// stays failed; this fixture verifies only the report's mandatory baseline.
const report = readFileSync(new URL('./fixtures/eng-mandatory-baseline-as.md', import.meta.url), 'utf8');
const declaration = report.match(/^### CRITICAL — regression \(mandatory, REGRESSION RULE\)\n[\s\S]*?(?=\n### )/m)![0];
const task = report.match(/^- \[ \] \*\*T5 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n## Tests\n\n' + declaration + '\n## Implementation Tasks\n' + task;
const check = (text: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, text, 0, 1);

const negative: Array<[string, (s: string) => string]> = [
  ['missing declaration', s => s.replace(declaration, '')],
  ['optional heading', s => s.replace('mandatory, REGRESSION RULE', 'optional, REGRESSION RULE')],
  ['historical owner', s => s.replace('## Tests', '## Historical tests')],
  ['source ancestor', s => '# Source excerpt\n' + s.replace('# Current reviewed plan\n', '')],
  ['bare source introduction', s => 'Source:\n\n' + s.replace('# Current reviewed plan\n', '')],
  ['conditional declaration', s => s.replace('`legacyAuthFlow()` is', 'If approved, `legacyAuthFlow()` is')],
  ['source declaration', s => s.replace('`legacyAuthFlow()` is', 'Source:\n`legacyAuthFlow()` is')],
  ['quoted declaration', s => s.replace(declaration, declaration.split('\n').map(l => '> ' + l).join('\n'))],
  ['fenced declaration', s => s.replace(declaration, '```\n' + declaration + '\n```')],
  ['literal declaration', s => s.replace(declaration, declaration.replace(/`/g, '').split('\n').map(l => '`' + l + '`').join('\n'))],
  ['quoted declaration sentence', s => s.replace('Before any rewrite:', '"Before any rewrite:').replace('inputs. This suite', 'inputs." This suite')],
  ['wrong legacy target', s => s.replaceAll('legacyAuthFlow', 'otherAuthFlow')],
  ['capture after rewrite', s => s.replace('Before any rewrite:', 'After the rewrite:')],
  ['proposed outputs', s => s.replace('records current', 'records proposed')],
  ['new path only', s => s.replace('against the legacy path now', 'against the new path now')],
  ['optional assertion', s => s.replace('records current', 'may record current')],
  ['missing baseline task', s => s.replace(task, '')],
  ['historical task owner', s => s.replace('## Implementation Tasks', '## Historical Implementation Tasks')],
  ['conditional task', s => s.replace(task, 'If approved:\n' + task)],
  ['source task', s => s.replace(task, 'Source:\n' + task)],
  ['quoted task', s => s.replace(task, task.split('\n').map(l => '> ' + l).join('\n'))],
  ['wrong file', s => s.replace('  - Files: tests/auth/legacyAuthFlow.characterization.test.ts', '  - Files: tests/auth/other.test.ts')],
  ['missing same-file binding', s => s.replace('  - Files: tests/auth/legacyAuthFlow.characterization.test.ts\n', '')],
  ['wrong task subject', s => s.replace('suite for `legacyAuthFlow()` current behavior', 'suite for `otherAuthFlow()` current behavior')],
  ['missing verification', s => s.replace('  - Verify: suite green against unmodified legacy before any other task merges', '')],
  ['changed baseline', s => s.replace('against unmodified legacy', 'against modified legacy')],
  ['baseline after merge', s => s.replace('before any other task merges', 'after every other task merges')],
  ['missing before-merge gate', s => s.replace(' before any other task merges', '')],
  ['neighboring verification', s => s.replace('  - Verify:', '- [ ] T6 — tests/auth — Another suite\n  - Verify:')],
  ['duplicate task identity', s => s.replace(task, task + task)],
  ...['Source:', 'If approved:', 'Assuming approval,', 'Provided approval,', 'Once approved:', 'When approved:', 'Pending approval:'].map(prefix =>
    [`verification owner ${prefix}`, (s: string) => s.replace('  - Verify:', `  ${prefix}\n  - Verify:`)] as [string, (s: string) => string]),
  ...['withdrawn', 'superseded', 'optional', 'not current', 'no longer current', 'no longer required'].flatMap(status => [
    [`current T5 ${status}`, (s: string) => s + `\n## Current assessment\nT5 is ${status}.\n`],
    [`quoted T5 ${status}`, (s: string) => s + `\n## Current assessment\nT5 is "${status}".\n`],
    [`baseline ${status}`, (s: string) => s.replace(task, task + `  This baseline verification is "${status}".\n`)],
  ] as Array<[string, (s: string) => string]>),
  ['current status row', s => s + '\n## Current assessment\n| T5 | Withdrawn |\n'],
  ['quoted status row', s => s + '\n## Current assessment\n| T5 | "Withdrawn" |\n'],
  ['withdrawn legacy suite', s => s + '\n## Current assessment\nThe legacy characterization suite is "withdrawn".\n'],
  ['declaration withdrawn', s => s.replace(declaration, declaration + '\nThis suite is withdrawn.\n')],
  ['baseline changed before task', s => s + '\n## Current assessment\nlegacyAuthFlow() is modified before T5.\n'],
];

describe('mandatory legacy baseline before any other task merges', () => {
  test('the exact acknowledged report requires the baseline without inventing native decisions', () => {
    expect(createHash('sha256').update(report).digest('hex')).toBe('60620ddd798a567423087731775557848c260a82080e9eceb1367a9bb9fc5d23');
    expect(check(report)).toMatchObject({ regression: 'plan', ok: false,
      missing: ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp'] });
    expect(check(compact).regression).toBe('plan');
  });
  test('task numbering, test paths, markup and line wrapping do not change the obligation', () => {
    for (const altered of [compact.replaceAll('T5', 'T31'), compact.replaceAll('tests/auth', 'test/login'),
      compact.replaceAll('legacyAuthFlow.characterization.test.ts', 'prior-behavior.test.js'),
      compact.replace(/[`*]/g, ''), compact.replace(/\n(?=[a-z])/g, ' ')])
      expect(check(altered).regression).toBe('plan');
  });
  test('this baseline does not require an invented same-suite flag-on rerun', () => {
    const baselineOnly = compact.replace(/ and moves to\n`AuthBroker` when the flag is removed \(TODO 1\)/, '');
    expect(baselineOnly).not.toBe(compact);
    expect(check(baselineOnly).regression).toBe('plan');
  });
  test('historical quotations, unrelated suite statuses and future completion do not withdraw the baseline', () => {
    for (const addition of ['\n## History\n"T5 is withdrawn."', '\n## History\n> T5 is withdrawn.',
      '\n## Historical task status\n| T5 | Withdrawn |', '\n## Current assessment\n| T9 | Withdrawn |',
      '\n## Payment regression suite\nThe regression suite is withdrawn.',
      '\n## Current assessment\nIf T5 is withdrawn, reopen the rollout decision.'])
      expect(check(compact + addition).regression).toBe('plan');
    expect(check('Source:\n\n' + compact).regression).toBe('plan');
  });
  test.each(negative)('%s supplies no mandatory baseline', (_, change) => {
    const altered = change(compact); expect(altered).not.toBe(compact); expect(check(altered).regression).toBeUndefined();
  });
  test('new regression artifacts select only the existing Eng owner', () => {
    for (const file of ['test/eng-mandatory-baseline-as.test.ts', 'test/fixtures/eng-mandatory-baseline-as.md'])
      expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  });
});
