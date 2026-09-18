import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
const report = readFileSync(new URL('./fixtures/eng-blocking-baseline-at.md', import.meta.url), 'utf8');
const declaration = report.match(/^### REGRESSION[^\n]+\n[\s\S]*?(?=\n### )/m)![0];
const ordered = report.match(/^## Implementation steps \(ordered\)\n[\s\S]*?(?=\n## )/m)![0];
const task = report.match(/^- \[ \] \*\*T1 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n## Tests\n\n' + declaration + '\n' + ordered + '\n## Implementation Tasks\n' + task;
const check = (text: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, text, 0, 1);

test('the exact acknowledged report supplies a mandatory current-code baseline', () => {
  expect(createHash('sha256').update(report).digest('hex')).toBe('0b1c69727fc89ae972bc023cc5677b90708507356084c65dc18b979906521d98');
  expect(check(report)).toMatchObject({ regression: 'plan', ok: false,
    missing: ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp'] });
  expect(check(compact).regression).toBe('plan');
});

test('task IDs, paths and markup can change while the same baseline stays required', () => {
  for (const value of [compact.replaceAll('T1', 'T31'), compact.replaceAll('tests/auth/legacyAuthFlow.regression', 'test/login/prior-behavior.test.ts'),
    compact.replace(/[`*]/g, ''), compact.replace('capture the current behavior', 'record the current behavior')]) {
    expect(check(value).regression).toBe('plan');
  }
});

const negatives: Array<[string, (text: string) => string]> = [
  ['missing declaration', text => text.replace(declaration, '')],
  ['optional heading', text => text.replace('CRITICAL, mandatory under', 'CRITICAL, optional under')],
  ['historical owner', text => text.replace('## Tests', '## Historical Tests')],
  ['source ancestor', text => '# Source excerpt\n' + text.replace('# Current reviewed plan\n', '')],
  ['bare source owner', text => 'Source:\n\n' + text.replace('# Current reviewed plan\n', '')],
  ['quoted declaration', text => text.replace(declaration, declaration.split('\n').map(line => '> ' + line).join('\n'))],
  ['fenced declaration', text => text.replace(declaration, '```\n' + declaration + '\n```')],
  ['inline literal declaration', text => text.replace(declaration, declaration.replace(/`/g, '').split('\n').map(line => '`' + line + '`').join('\n'))],
  ['conditional requirement', text => text.replace('**T1 is a blocking requirement:**', 'If approved, **T1 is a blocking requirement:**')],
  ['proposed baseline', text => text.replace('capture the current behavior', 'capture the proposed behavior')],
  ['capture after change', text => text.replace('before any rewrite, capture', 'after the rewrite, capture')],
  ['wrong legacy target', text => text.replaceAll('legacyAuthFlow', 'otherAuthFlow')],
  ['missing accepted tokens', text => text.replace('every accepted token shape, ', '')],
  ['missing rejected tokens', text => text.replace('every rejected token shape, ', '')],
  ['missing errors', text => text.replace('every error response, ', '')],
  ['parity targets unrelated module', text => text.replace('against the `AuthBroker` path', 'against the `OtherBroker` path')],
  ['parity permits differences', text => text.replace('must produce identical outcomes', 'may produce different outcomes')],
  ['missing ordered baseline', text => text.replace(ordered, '')],
  ['historical ordering', text => text.replace('## Implementation steps (ordered)', '## Historical implementation steps (ordered)')],
  ['wrong ordered task', text => text.replace('1. **T1** Characterization', '1. **T99** Characterization')],
  ['changed first', text => text.replace('Green on current code before anything else changes.', 'Green on changed code after everything else changes.')],
  ['parallel baseline', text => text.replace('Green on current code before anything else changes.', 'Run in parallel with the rewrite.')],
  ['new-path-only baseline', text => text.replace('Green on current code before anything else changes.', 'Green on AuthBroker after rewriting legacy code.')],
  ['missing task', text => text.replace(task, '')],
  ['historical task owner', text => text.replace('## Implementation Tasks', '## Historical Implementation Tasks')],
  ['wrong owned task', text => text.replace(task, task.replace('**T1 ', '**T99 '))],
  ['duplicate task', text => text.replace(task, task + task)],
  ['missing verification', text => text.replace('  - Verify: suite green on current code; later green on both flag states', '')],
  ['post-rewrite verification only', text => text.replace('suite green on current code; later green on both flag states', 'suite green only after the rewrite')],
  ['neighboring verification', text => text.replace('  - Verify:', '- [ ] T99 — tests — Another suite\n  - Verify:')],
  ['missing task files', text => text.replace(/^  - Files: .+$/m, '')],
  ...['Source:', 'If approved:', 'Assuming approval,', 'Provided approval,', 'Once approved:', 'When approved:', 'Pending approval:'].flatMap(prefix => [
    [`conditional task ${prefix}`, (text: string) => text.replace(task, prefix + '\n' + task)],
    [`conditional verification ${prefix}`, (text: string) => text.replace('  - Verify:', '  ' + prefix + '\n  - Verify:')],
  ] as Array<[string, (text: string) => string]>),
  ...['withdrawn', 'declined', 'optional', 'superseded', 'not current', 'no longer current'].flatMap(status => [
    [`current T1 ${status}`, (text: string) => text + `\n## Current assessment\nT1 baseline requirement is ${status}.\n`],
    [`quoted T1 ${status}`, (text: string) => text + `\n## Current assessment\nT1 baseline requirement is "${status}".\n`],
  ] as Array<[string, (text: string) => string]>),
  ['status table', text => text + '\n## Current assessment\n| T1 | Withdrawn |\n'],
  ['baseline changed first correction', text => text + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T1.\n'],
];

test.each(negatives)('%s supplies no required legacy baseline', (_, change) => {
  const altered = change(compact);
  expect(altered).not.toBe(compact);
  expect(check(altered).regression).toBeUndefined();
});

test('quoted history and another suite cannot withdraw this required baseline', () => {
  for (const tail of ['\n## History\n"T1 baseline requirement is withdrawn."', '\n## History\n> T1 baseline requirement is withdrawn.',
    '\n## Historical task status\n| T1 | Withdrawn |', '\n## Current assessment\n| T9 | Withdrawn |',
    '\n## Payment regression suite\nThe regression suite is withdrawn.', '\n## Current assessment\nIf T1 is withdrawn, reopen the decision.']) {
    expect(check(compact + tail).regression).toBe('plan');
  }
});

test('the regression and exact report select only the Eng finding-count workflow', () => {
  for (const file of ['test/eng-blocking-baseline-at.test.ts', 'test/fixtures/eng-blocking-baseline-at.md']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name))
      .toEqual(['plan-eng-finding-count']);
  }
});
