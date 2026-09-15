import { expect, test } from 'bun:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createNativeReviewState } from './helpers/plan-count-fixture';
import { getHermeticDirs } from './helpers/hermetic-env';
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


test('native sequencing config reaches the real CLI reader without changing shared state', () => {
  const shared = getHermeticDirs().gstackHome;
  const before = readFileSync(resolve(shared, 'config.yaml'), 'utf8');
  const first = createNativeReviewState();
  const second = createNativeReviewState();
  try {
    expect(first.env.GSTACK_HOME).not.toBe(shared);
    expect(first.env.GSTACK_HOME).not.toBe(second.env.GSTACK_HOME);
    expect(first.env.GSTACK_STATE_ROOT).toBe(first.env.GSTACK_HOME);
    const result = spawnSync('bash', [resolve(root, 'bin/gstack-config'), 'get', 'codex_reviews'], {
      cwd: root, env: { ...process.env, ...first.env }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('disabled');
    for (const marker of readdirSync(shared).filter(name => name === '.activated' ||
      /^\..*(?:-seen|-prompted|-shown)$/.test(name) || name.startsWith('.feature-prompted-'))) {
      expect(readFileSync(resolve(first.env.GSTACK_HOME!, marker), 'utf8'))
        .toBe(readFileSync(resolve(shared, marker), 'utf8'));
    }
    first.cleanup();
    first.cleanup();
    expect(existsSync(first.env.GSTACK_HOME!)).toBe(false);
    expect(existsSync(second.env.GSTACK_HOME!)).toBe(true);
    expect(readFileSync(resolve(shared, 'config.yaml'), 'utf8')).toBe(before);
  } finally {
    first.cleanup();
    second.cleanup();
  }
  expect(existsSync(second.env.GSTACK_HOME!)).toBe(false);
});

test('the UI/API chain requires all four native phases and registers its config dependency', () => {
  const source = read('test/skill-e2e-autoplan-chain.test.ts');
  const plan = read(fixture);
  expect(plan).toContain('## UI Scope');
  expect(plan).toContain('New REST endpoint `GET /api/dashboard`');
  expect(source).toContain('env: nativeState.env');
  expect(source).toContain('if (!ceo || !design || !dx || !eng)');
  expect(source).toContain('expect(ceo.ts).toBeLessThan(design.ts)');
  expect(source).toContain('expect(design.ts).toBeLessThan(dx.ts)');
  expect(source).toContain('expect(dx.ts).toBeLessThan(eng.ts)');
  expect(source).toContain('nativeState?.cleanup()');
  for (const file of ['test/helpers/plan-count-fixture.ts', 'test/plan-count-fixture.test.ts', 'bin/gstack-config']) {
    expect(E2E_TOUCHFILES['autoplan-chain-pty']).toContain(file);
    expect(selectTests([file], E2E_TOUCHFILES).selected).toContain('autoplan-chain-pty');
  }
});
