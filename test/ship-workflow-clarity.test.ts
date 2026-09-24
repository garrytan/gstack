import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAdversarialStep } from '../scripts/resolvers/review';
import { HOST_PATHS } from '../scripts/resolvers/types';

const read = (file: string) => readFileSync(new URL(`../ship/${file}`, import.meta.url), 'utf8');

test('missing dispatched coverage is persisted and stopped before any zero-fix completion', () => {
  const review = read('sections/review-army.md');
  const branches = review.slice(review.indexOf('take the first matching branch'), review.indexOf('5. Output summary'));
  expect(branches.indexOf('If a dispatched specialist or Red Team failed')).toBeGreaterThanOrEqual(0);
  expect(branches.indexOf('If fixes were applied')).toBeGreaterThan(branches.indexOf('STOP before Step 10'));
  expect(branches).toContain('`status:"unavailable"`, `completed:false` and `converged:false`');
  expect(review).toContain('Pre-Landing Review: INCOMPLETE');
  expect(branches).toContain('new Step 9 pass');
  expect(branches).toContain('Intentionally gated or host-unsupported reviewers were not dispatched');
  expect(review).toContain('Continue to Step 10 only after a completed, converged review is persisted');
});

test('external-comment fixes refresh tests and mandatory review without repeating prior decisions', () => {
  const section = read('sections/greptile.md');
  const finish = section.slice(section.indexOf('**After all comments are resolved:**'));
  expect(finish.indexOf('run Step 5')).toBeGreaterThan(-1);
  expect(finish.indexOf('repeat Step 9')).toBeGreaterThan(finish.indexOf('run Step 5'));
  expect(finish.indexOf('before continuing to Step 11')).toBeGreaterThan(finish.indexOf('repeat Step 9'));
  expect(finish).toContain('do not repeat unchanged comment decisions');
  expect(finish).toContain('If no fixes were applied, continue to Step 11');
});

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: late adversarial fixes have a bounded return path and preserve approvals', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const text = generateAdversarialStep(ctx);
  const finish = text.slice(text.indexOf('### Step 11 completion and late-fix loop'));
  expect(finish).toContain('Step 9.4 items 1–3');
  expect(finish).toContain('Do not ask again for a Step 11 P1 fix already approved');
  expect(finish).toMatch(/commit only the fixed files[\s\S]*Run Step 5[\s\S]*repeat Step 9 from a fresh start token[\s\S]*return directly to Step 11/);
  expect(finish).toContain('third cycle still changes code');
  expect(finish).toContain('record non-convergence and STOP');
  expect(finish).toContain('A zero-fix cycle continues to Step 12');
  expect(text).toContain('retain the acknowledged findings and failed gate');
  expect(finish).toContain('unavailable or waived coverage is never reported as a clean completed pass');
  const standalone = generateAdversarialStep({ ...ctx, skillName: 'review' });
  expect(standalone).not.toContain('Step 11 completion');
  expect(standalone).toContain('If A: address the findings. Re-run the same shared structured invocation and diff scope to verify.');
});

test('existing release levels have an explicit recovery rule, not implicit rebump approval', () => {
  const root = read('SKILL.md');
  const version = root.slice(root.indexOf('## Step 12:'), root.indexOf('## Step 14:'));
  expect(version).toContain('first changed major/minor/patch/micro component supplies `BUMP_LEVEL`');
  expect(version).toContain('a missing fourth component is zero');
  expect(version).toContain('This recovers the level, not permission to bump again');
  expect(version).toContain('Only approval changes the existing version');
});

test('distribution setup asks for unknown targets and cannot release before review', () => {
  const root = read('SKILL.md');
  const distribution = root.slice(root.indexOf('## Step 2:'), root.indexOf('## Step 3:'));
  expect(distribution).toContain('Ask for the intended distribution target if it is unknown');
  expect(distribution).toContain('do not invent a registry or credentials');
  expect(distribution).toContain('Include the new workflow in the tests and review below');
  expect(distribution).toContain('Do not publish a release during `/ship`');
});
