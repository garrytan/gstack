import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';

// Exact public report from AQ's acknowledged final Write (SHA256 3cd54533…);
// the original paid attempt failed. These pure checks do not revise its result.
const report = readFileSync(new URL('./fixtures/eng-staged-regression-aq.md', import.meta.url), 'utf8');
const check = (plan: string) => evaluateEngSeedCoverage({
  status: 'ready', calls: [], assistantMessages: [],
} as any, plan, 0, Date.now());
const baseline = report.match(/^- \[ \] \*\*T1 .*\n(?:  .*(?:\n|$))*/m)![0];
const parity = report.match(/^- \[ \] \*\*T8 .*\n(?:  .*(?:\n|$))*/m)![0];
const declaration = report.match(/^### REGRESSION \(CRITICAL, mandatory\)\n[\s\S]*?(?=\n### )/m)![0];

const negative: Array<[string, (s: string) => string]> = [
  ['missing mandatory declaration', s => s.replace(declaration, '')],
  ['optional declaration', s => s.replace('### REGRESSION (CRITICAL, mandatory)', '### REGRESSION (optional)')],
  ['quoted declaration', s => s.replace(declaration, declaration.split('\n').map(line => '> ' + line).join('\n'))],
  ['fenced declaration', s => s.replace(declaration, '```\n' + declaration + '\n```')],
  ['historical implementation tasks', s => s.replace('## Implementation Tasks', '## Historical Implementation Tasks')],
  ['missing baseline task', s => s.replace(baseline, '')],
  ['source-only baseline', s => s.replace(baseline, 'Source excerpt:\n' + baseline)],
  ['bare source baseline', s => s.replace(baseline, 'Source:\n' + baseline)],
  ['earlier assessment baseline', s => s.replace(baseline, 'Earlier review assessment:\n' + baseline)],
  ['source-only verification', s => s.replace('  - Verify: suite green against unmodified legacy path', '  Source:\n  - Verify: suite green against unmodified legacy path')],
  ['assuming baseline verification', s => s.replace('  - Verify: suite green against unmodified legacy path', '  Assuming approval,\n  - Verify: suite green against unmodified legacy path')],
  ['provided parity verification', s => s.replace('  - Verify: T1 suite green with flag on and off', '  Provided approval,\n  - Verify: T1 suite green with flag on and off')],
  ['conditional baseline', s => s.replace('Write characterization (regression)', 'If approved, write characterization (regression)')],
  ['baseline recorded after rewrite', s => s.replace('prior behavior before any rewrite', 'prior behavior after the rewrite')],
  ['baseline is the new implementation', s => s.replace('suite green against unmodified legacy path', 'suite green against new implementation')],
  ['unverified baseline', s => s.replace('suite green against unmodified legacy path; 8 cases recorded as oracle', 'suite planned; oracle pending')],
  ['missing parity task', s => s.replace(parity, '')],
  ['parity of the wrong task', s => s.replace('T1 characterization tests pass against both paths', 'T2 characterization tests pass against both paths')],
  ['parity verification references another suite', s => s.replace('T1 suite green with flag on and off', 'T2 suite green with flag on and off')],
  ['parity runs on only one path', s => s.replace('T1 suite green with flag on and off', 'T1 suite green with flag on')],
  ['duplicate baseline identity', s => s.replace(parity, baseline + parity)],
  ['inconsistent captured cases', s => s.replace('8 cases recorded as oracle', '7 cases recorded as oracle')],
  ['foreign test target', s => s.replaceAll('legacyAuthFlow', 'anotherFlow')],
  ['nonincreasing release stages', s => s.replaceAll('PR2', 'PR1')],
  ['cancelled baseline', s => s + '\n## Current assessment\nT1 is cancelled.\n'],
  ['quoted cancellation of the current baseline', s => s + '\n## Current assessment\nT1 is "withdrawn".\n'],
  ['superseded parity', s => s + '\n## Current assessment\nT8 is "superseded".\n'],
  ['baseline changed first', s => s + '\n## Current assessment\nlegacyAuthFlow() is modified before T1 records the baseline.\n'],
  ['parity rerun revoked', s => s + '\n## Current assessment\nT8 no longer reruns T1.\n'],
  ['legacy suite withdrawn', s => s + '\n## Current assessment\nThe legacy regression suite is withdrawn.\n'],
  ['quoted legacy suite withdrawn', s => s + '\n## Current assessment\nThe legacy regression suite is "withdrawn".\n'],
  ['baseline verification superseded', s => s.replace(baseline, baseline + '  Correction: this baseline verification is "superseded".\n')],
  ['legacy requirement withdrawn', s => s + '\n## Current legacy regression assessment\nThe legacy characterization requirement is no longer required.\n'],
  ['parity will not run baseline', s => s.replace(parity, parity + '  Correction: T8 will not run T1.\n')],
];

describe('staged legacy characterization binds its unchanged baseline and later parity', () => {
  test('the exact acknowledged report supplies the regression obligation only', () => {
    expect(check(report)).toMatchObject({ regression: 'plan', ok: false,
      missing: ['complexity', 'shared-cache', 'swallowed-errors', 'sequential-idp'] });
  });

  test('task and release numbers can vary while preserving the same references', () => {
    const renamed = report.replace(/\bT(\d+)\b/g, (_, n) => `T${Number(n) + 20}`)
      .replace(/\bPR(\d+)\b/g, (_, n) => `PR${Number(n) + 3}`);
    expect(check(renamed).regression).toBe('plan');
  });

  test('quoted historical cancellation and a foreign suite do not cancel these current tasks', () => {
    for (const suffix of [
      '\n## History\n"T1 is withdrawn. legacyAuthFlow() is modified before T1."',
      '\n## Payment regression suite\nThe regression suite is withdrawn.',
    ]) expect(check(report + suffix).regression).toBe('plan');
  });

  test.each(negative)('%s cannot establish the legacy baseline', (_, change) => {
    expect(check(change(report)).regression).toBeUndefined();
  });
});
