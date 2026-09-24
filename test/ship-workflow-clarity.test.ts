import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAdversarialStep, generateCrossReviewDedup } from '../scripts/resolvers/review';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { outsideVoicePreflight } from '../scripts/resolvers/outside-voice';
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

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: ship dispatch distinguishes gathering findings from authorizing completion', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const ship = generateReviewArmy(ctx);
  if (host === 'codex') {
    expect(ship).toBe('');
    return;
  }
  expect(ship).toContain('collect successful results through Step 9.3');
  expect(ship).toContain('Step 9.4 then persists the incomplete pass and STOPs before Step 10');
  expect(ship).not.toContain('Specialists are additive');
  expect(generateReviewArmy({ ...ctx, skillName: 'review' })).toContain('Specialists are additive');
});

test.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s: adversarial outcomes have one per-attempt persistence procedure', host => {
  const text = generateAdversarialStep({ host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] });
  expect(text).toContain('Execution failures do not block shipping; findings still follow the approval and convergence gates');
  expect(text).not.toContain('This is informational — it never blocks shipping');
  expect(text).toContain('either `DIFF_TOTAL >= 200` or the user explicitly requested the structured review');
  expect(text).toContain('`DIFF_TOTAL < 200` and no explicit structured-review request exists');
  const persist = text.slice(text.indexOf('### Persist the review result'), text.indexOf('### Cross-model synthesis'));
  expect(persist.match(/gstack-review-log /g)).toHaveLength(1);
  expect(persist).toContain('one record per source/phase/attempt');
  expect(persist).toContain('including after a started pass fails');
  expect(persist).toContain('An unstarted, disabled or skipped pass has no token');
  expect(persist).toContain('Substitute fields from this record\'s own outcome, never another pass');
  expect(persist).toContain('Missing coverage never earns `pass`');
  expect(persist).toContain('Preserve reported modelUsage; unknown model identity stays unknown');
  expect(persist).not.toContain('Retain the historical review-log skill ID');
});

test.each(['claude', 'codex'] as const)('%s: opt-in preflight actually emits the same own-harness mode as other callers', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const optIn = outsideVoicePreflight(ctx, { disabledBehavior: 'opt-in' });
  const fence = optIn.match(/```bash\n([\s\S]*?)\n```/)![1];
  const mode = host === 'codex' ? 'under_current_harness' : 'under_codex';
  const env = { ...process.env, CODEX_THREAD_ID: '', CODEX_SANDBOX: '', CLAUDECODE: '',
    GSTACK_ACTIVE_HOST: host === 'codex' ? 'claude' : 'codex' };
  const result = Bun.spawnSync(['bash', '-c', fence], { env, timeout: 10_000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`CODEX_MODE: ${mode}`);
  expect(result.stderr.toString()).toContain('no outside process started');
  expect(outsideVoicePreflight(ctx, { disabledBehavior: 'codex-only' })).toContain(mode);
});

test('ship audit data contracts define failure and undetermined-coverage conversions', () => {
  const audit = read('sections/plan-completion.md');
  const root = read('SKILL.md');
  expect(audit).toContain('"error":null');
  expect(audit).toContain('If the audit cannot complete, set `error` to the failure reason');
  expect(audit).toContain('A non-null `error`');
  expect(read('sections/test-coverage.md')).toContain('Use null for an undetermined or skipped coverage percentage, not zero');
  expect(root).toContain('map `null` to -1 for this metrics record only');
  expect(root).toContain('below-target or undetermined coverage follows Step 7\'s decision gate');
  expect(root).toContain('gstack-decision-search --scope repo --query "Ship <currentVersion>" --json');
  expect(root).toContain('use the level only from an exact-version');
  expect(root).toContain('unless the user\'s explicit version policy already delegates those decisions');
});

test('shared-code snapshot verification names a raw blob read and preserves fail-closed eligibility', () => {
  const text = generateCrossReviewDedup({ host: 'claude', skillName: 'ship', tmplPath: '', paths: HOST_PATHS.claude });
  const check = text.slice(text.indexOf('4. Verify EVERY evidence path'), text.indexOf('5. Call pure'));
  expect(check.indexOf('**Path:**')).toBeLessThan(check.indexOf('**Git transformations:**'));
  expect(check.indexOf('**Git transformations:**')).toBeLessThan(check.indexOf('**Bytes:**'));
  expect(check).toContain('cat-file blob "$WTREE:$EVIDENCE_PATH"');
  expect(check).toContain('Check the Git command\'s exit status separately');
  expect(check).toContain('Do not compare against HEAD or create a replacement snapshot');
  for (const required of ['symlink targets/ancestors', 'submodules', 'ignored/outside files',
    'working-tree-encoding', 'core.autocrlf', 'assume-unchanged', 'skip-worktree',
    'sparse index entries', 'snapshot_covered_paths']) expect(check).toContain(required);
  expect(text).toContain('Suppress only when ALL eligibility checks passed and the helper returns true');
});
