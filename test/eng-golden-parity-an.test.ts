import { expect, test } from 'bun:test';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import fixture from './fixtures/eng-golden-parity-an.json';
const times = fixture.calls.map(call => Date.parse(call.answeredAt));
const check = (plan = fixture.compact) => evaluateEngSeedCoverage(
  { status: 'ready', calls: fixture.calls, assistantMessages: [] }, plan, Math.min(...times) - 1, Math.max(...times) + 1);

test('exact golden requirement binds current outputs, the same task and untouched baseline to flag-off parity', () => {
  expect(check().ok).toBe(true);
  expect(check().regression).toBe('plan');
});

const negative: Array<[string, (plan: string) => string]> = [
  ['source ancestor', s => '# Source excerpt\n' + s],
  ['historical owner', s => s.replace('### Test requirements', '### Historical test requirements')],
  ['source declaration prefix', s => s.replace(fixture.declaration, 'Source:\n' + fixture.declaration)],
  ['earlier declaration prefix', s => s.replace(fixture.declaration, 'Earlier review assessment:\n' + fixture.declaration)],
  ['conditional declaration', s => s.replace(fixture.declaration, 'If approved:\n' + fixture.declaration)],
  ['quoted declaration', s => s.replace(fixture.declaration, fixture.declaration.split('\n').map(line => '> ' + line).join('\n'))],
  ['literal declaration', s => s.replace(fixture.declaration, '~~~\n' + fixture.declaration + '~~~\n')],
  ['optional regression requirement', s => s.replace('REGRESSION RULE, no approval needed', 'optional regression suggestion')],
  ['different characterization target', s => s.replaceAll('legacyAuthFlow', 'anotherFlow')],
  ['unlinked declared task', s => s.replace('(T3, REGRESSION RULE', '(T8, REGRESSION RULE')],
  ['unlinked ordering task', s => s.replace('(T3)** — pin', '(T8)** — pin')],
  ['unlinked task file', s => s.replace('  - Files: auth/legacyAuthFlow.regression.test.ts', '  - Files: auth/anotherFlow.regression.test.ts')],
  ['missing golden oracle', s => s.replace('These tests are the parity oracle', 'These tests are not the parity oracle')],
  ['conditional parity', s => s.replace('These tests are the parity oracle', 'If approved, these tests are the parity oracle')],
  ['modified baseline', s => s.replace('against unmodified legacy code', 'against modified legacy code')],
  ['reversed baseline ordering', s => s.replace('before any refactor commit', 'after the refactor commit')],
  ['future outputs', s => s.replace('pin current outputs', 'pin proposed outputs')],
  ['reversed capture ordering', s => s.replace('before any other code moves', 'after the other code moves')],
  ['source ordering prefix', s => s.replace(fixture.ordering, 'Source excerpt:\n' + fixture.ordering)],
  ['conditional task prefix', s => s.replace(fixture.task, 'If approved:\n' + fixture.task)],
  ['source task prefix', s => s.replace(fixture.task, 'Source:\n' + fixture.task)],
  ['source baseline verification', s => s.replace('  - Verify: six', '  Source:\n  - Verify: six')],
  ['conditional baseline verification', s => s.replace('  - Verify: six', '  If approved:\n  - Verify: six')],
  ['withdrawn same task', s => s + '\n## Final assessment\nT3 is withdrawn.\n'],
  ['withdrawn same verification', s => s + '\n## Final assessment\nT3 verification is withdrawn.\n'],
  ['directly quoted verification withdrawal', s => s + '\n## Final assessment\nT3 verification is "withdrawn".\n'],
  ['current golden suite cancelled', s => s + '\n## Final assessment\nThe legacy golden tests are cancelled.\n'],
  ['legacy modified before baseline', s => s + '\n## Final assessment\nlegacyAuthFlow() is modified before T3.\n'],
  ['owned test requirement withdrawn', s => s.replace(fixture.declaration, fixture.declaration + 'These tests are withdrawn.\n')],
  ['owned baseline withdrawn', s => s.replace(fixture.task, fixture.task + '  Correction: this baseline verification is withdrawn.\n')],
  ['quoted owned baseline withdrawal', s => s.replace(fixture.task, fixture.task + '  Correction: this baseline verification is "withdrawn".\n')],
  ['quoted legacy golden cancellation', s => s + '\n## Final assessment\nThe legacy golden tests are "cancelled".\n'],
  ['owned requirement not current', s => s.replace(fixture.declaration, fixture.declaration + 'This requirement is not current.\n')],
];
test.each(negative)('%s cannot supply a current unchanged oracle', (_, change) => {
  const plan = change(fixture.compact);
  expect(plan).not.toBe(fixture.compact);
  expect(check(plan).regression).toBeUndefined();
});

test('same-task renumbering, harmless quoted history and unrelated suite preserve the oracle', () => {
  expect(check(fixture.compact.replaceAll('T3', 'T8')).ok).toBe(true);
  expect(check(fixture.compact + '\n## Notes\nOld note: "T3 verification is withdrawn."\n').ok).toBe(true);
  expect(check(fixture.compact + '\n## Payment regression suite\nThe regression suite is withdrawn.\n').ok).toBe(true);
  expect(check(fixture.compact.replace(fixture.declaration, 'Old note: "Source:"\n' + fixture.declaration)).ok).toBe(true);
});

test('new regression artifacts select only the existing Eng owner and its dependency list stays dense', () => {
  for (const path of ['test/eng-golden-parity-an.test.ts', 'test/fixtures/eng-golden-parity-an.json'])
    expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  const row = E2E_TOUCHFILES['plan-eng-finding-count'];
  for (let index = 0; index < row.length; index++) {
    expect(Object.hasOwn(row, index)).toBe(true);
    expect(typeof row[index]).toBe('string');
  }
});
