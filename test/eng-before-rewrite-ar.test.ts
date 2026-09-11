import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

// Exact acknowledged public report; the paid attempt remains failed.
const report = readFileSync(new URL('./fixtures/eng-before-rewrite-ar.md', import.meta.url), 'utf8');
const declaration = report.match(/^### REGRESSION RULE \(mandatory, no decision required\)\n[\s\S]*?(?=\n### )/m)![0];
const task = report.match(/^- \[ \] \*\*T1 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n## Tests (reviewed)\n\n' + declaration +
  '\n## Implementation Tasks\n' + task + '\n## GSTACK REVIEW REPORT\n| Eng Review | complete |\n';
const check = (text: string) => evaluateEngSeedCoverage({ status: 'ready', calls: [], assistantMessages: [] }, text, 0, 1);

const negative: Array<[string, (text: string) => string]> = [
  ['missing mandatory declaration', s => s.replace(declaration, '')],
  ['optional declaration', s => s.replace('mandatory, no decision required', 'optional, decision pending')],
  ['historical owner', s => s.replace('## Tests (reviewed)', '## Historical tests')],
  ['quoted source ancestor', s => '# Source excerpt\n' + s.replace('# Current reviewed plan\n', '')],
  ['source declaration prefix', s => s.replace('`legacyAuthFlow()` is', 'Source excerpt:\n`legacyAuthFlow()` is')],
  ['conditional declaration', s => s.replace('`legacyAuthFlow()` is', 'If approved, `legacyAuthFlow()` is')],
  ['quoted declaration', s => s.replace(declaration, declaration.split('\n').map(line => '> ' + line).join('\n'))],
  ['fenced declaration', s => s.replace(declaration, '```\n' + declaration + '\n```')],
  ['literal declaration', s => s.replace(declaration, declaration.replace(/`/g, '').split('\n').map(line => '`' + line + '`').join('\n'))],
  ['wrong legacy target', s => s.replaceAll('legacyAuthFlow', 'anotherFlow')],
  ['capture after rewrite', s => s.replace('before any rewrite, record', 'after the rewrite, record')],
  ['proposed outputs', s => s.replace('the exact output', 'the proposed output')],
  ['no required flag-on rerun', s => s.replace('The new path must pass', 'The new path might pass')],
  ['different rerun suite', s => s.replace('pass the same suite', 'pass a different suite')],
  ['missing baseline task', s => s.replace(task, '')],
  ['historical task section', s => s.replace('## Implementation Tasks', '## Historical Implementation Tasks')],
  ['conditional task', s => s.replace(task, 'If approved:\n' + task)],
  ['source task', s => s.replace(task, 'Source excerpt:\n' + task)],
  ['quoted task', s => s.replace(task, task.split('\n').map(line => '> ' + line).join('\n'))],
  ['another test file', s => s.replace('  - Files: tests/auth/legacyAuthFlow.regression.test.ts', '  - Files: tests/auth/anotherFlow.regression.test.ts')],
  ['missing baseline verification', s => s.replace('  - Verify: suite green on current code; green again with flag on after rewrite', '')],
  ['modified baseline', s => s.replace('suite green on current code;', 'suite green on rewritten code;')],
  ['missing flag-on verification', s => s.replace('; green again with flag on after rewrite', '')],
  ['source verification', s => s.replace('  - Verify:', '  Source:\n  - Verify:')],
  ['conditional verification', s => s.replace('  - Verify:', '  If approved:\n  - Verify:')],
  ['assuming verification', s => s.replace('  - Verify:', '  Assuming approval,\n  - Verify:')],
  ['verification from neighboring task', s => s.replace('  - Verify:', '- [ ] T2 — tests/auth — Another test suite\n  - Verify:')],
  ['duplicate task identities', s => s.replace(task, task + task)],
  ['cancelled task', s => s + '\n## Current assessment\nT1 is withdrawn.\n'],
  ['quoted task status', s => s + '\n## Current assessment\nT1 verification is "withdrawn".\n'],
  ['cancelled legacy suite', s => s + '\n## Current assessment\nThe legacy regression suite is "withdrawn".\n'],
  ['cancelled baseline verification', s => s.replace(task, task + '  Correction: this baseline verification is withdrawn.\n')],
  ['quoted baseline status', s => s.replace(task, task + '  Correction: this baseline verification is "withdrawn".\n')],
  ['superseded baseline verification', s => s.replace(task, task + '  Correction: this baseline verification is "superseded".\n')],
  ['baseline verification no longer current', s => s.replace(task, task + '  Correction: this baseline verification is not current.\n')],
  ['verification waits for approval', s => s.replace('  - Verify:', '  Once approved:\n  - Verify:')],
  ['verification depends on approval', s => s.replace('  - Verify:', '  When approved:\n  - Verify:')],
  ['verification has approval pending', s => s.replace('  - Verify:', '  Pending approval:\n  - Verify:')],
  ['bare source owns the following sections', s => 'Source:\n\n' + s.replace('# Current reviewed plan\n', '')],
  ['current task withdrawal row', s => s + '\n## Current assessment\n| T1 | Withdrawn |\n'],
  ['quoted current task withdrawal value', s => s + '\n## Current assessment\n| T1 | "Withdrawn" |\n'],
  ['baseline changes before task', s => s + '\n## Current assessment\nlegacyAuthFlow() is modified before T1.\n'],
];

describe('mandatory characterization binds the current baseline and same-file rerun', () => {
  test('the exact acknowledged report supplies regression coverage, without inventing native decisions', () => {
    expect(createHash('sha256').update(report).digest('hex')).toBe('7e4c56d66f98b9ccea54b7427ec2dbbca89adfc6407f0fedf2017801eafada99');
    expect(check(report)).toMatchObject({regression: 'plan', ok: false,
      missing: ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp']});
    expect(check(compact).regression).toBe('plan');
  });

  test('formatting and current task numbering do not affect the obligation', () => {
    expect(check(compact.replaceAll('T1', 'T21')).regression).toBe('plan');
    expect(check(compact.replace(/\n(?=[a-z])/g, ' ')).regression).toBe('plan');
    expect(check(compact.replaceAll('tests/auth', 'test/login')).regression).toBe('plan');
  });

  test('quoted history and a separate suite cannot cancel the current legacy obligation', () => {
    expect(check(compact + '\n## History\n"T1 is withdrawn."\n').regression).toBe('plan');
    expect(check(compact + '\n## Payment regression suite\nThe regression suite is withdrawn.\n').regression).toBe('plan');
    expect(check(compact + '\n## Historical task status\n| T1 | Withdrawn |\n').regression).toBe('plan');
    expect(check(compact + '\n## Current task status\n| T9 | Withdrawn |\n').regression).toBe('plan');
    expect(check('Source:\n\n' + compact).regression).toBe('plan');
  });

  test.each(negative)('%s supplies no mandatory legacy baseline', (_, change) => {
    const altered = change(compact);
    expect(altered).not.toBe(compact);
    expect(check(altered).regression).toBeUndefined();
  });

  test('new artifacts select only the existing Eng owner', () => {
    for (const file of ['test/eng-before-rewrite-ar.test.ts', 'test/fixtures/eng-before-rewrite-ar.md'])
      expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  });
});
