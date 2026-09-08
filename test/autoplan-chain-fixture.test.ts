import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const root = resolve(import.meta.dir, '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const fixture = 'test/fixtures/plans/autoplan-dashboard.md';

test('the chain fixture retains the complete original UI/API scope', () => {
  const original = read('test/fixtures/plans/ui-heavy-feature.md');
  const complete = read(fixture);
  expect(complete.startsWith(original + '\n')).toBe(true);
  // This supplements dependency facts; it does not supply a completed review,
  // prescribe its decisions, or pre-build the feature exercised by the chain.
  expect(complete).not.toMatch(/Phase \d|GSTACK REVIEW REPORT|AUTO-DECIDE|all findings resolved/i);
  expect(complete).toContain('there are no dashboard-specific tests yet');
  expect(complete).toContain('not completed work');
});

test('the new fixture is isolated to the chain and its selection dependencies', () => {
  expect(read('test/skill-e2e-autoplan-chain.test.ts')).toContain("'plans', 'autoplan-dashboard.md'");
  expect(read('test/skill-e2e-plan-design-with-ui.test.ts')).toContain("'plans', 'ui-heavy-feature.md'");
  for (const file of [fixture, 'test/autoplan-chain-fixture.test.ts']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
  }
  expect(selectTests(['test/fixtures/plans/ui-heavy-feature.md'], E2E_TOUCHFILES).selected)
    .toEqual(['plan-design-with-ui-scope']);
});
