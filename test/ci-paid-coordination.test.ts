import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRunManifest, collectPaidTestFiles, type PaidRunManifest, type SliceResult } from '../scripts/test-paid-shards';
import { STRICT_RETRY_CASE_BUDGETS } from './helpers/eval-budgets';
import { manualReviewFixture } from './helpers/manual-judge-review-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = {
  needs?: string | string[];
  if?: string;
  container?: unknown;
  permissions: Record<string, string>;
  steps: Step[];
};
const workflows = ['evals.yml', 'evals-periodic.yml'].map(name => ({
  name,
  jobs: (Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8')) as {
    jobs: Record<string, Job>;
  }).jobs,
}));

describe('paid CI coordination stays off the eval image', () => {
  test('the actual planner and reporter load from a checkout without installed packages', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-offline-'));
    const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 5_000 });
    expect(listed.status, listed.stderr).toBe(0);
    try {
      for (const relative of listed.stdout.split('\0').filter(Boolean)) {
        const source = path.join(ROOT, relative);
        const destination = path.join(directory, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        expect(fs.realpathSync(path.dirname(destination)).startsWith(fs.realpathSync(directory) + path.sep)
          || fs.realpathSync(path.dirname(destination)) === fs.realpathSync(directory)).toBe(true);
        if (fs.lstatSync(source).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
        else fs.copyFileSync(source, destination);
      }
      const env = { ...process.env, ANTHROPIC_API_KEY: undefined, EVALS: undefined, EVALS_ALL: undefined,
        EVALS_PROFILE: 'pr', EVALS_TIER: 'gate' };
      for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'Seed offline planner fixture'], ['checkout', '-b', 'fixture-head']]) {
        const git = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
        expect(git.status, git.stderr).toBe(0);
      }
      fs.appendFileSync(path.join(directory, '.github/workflows/evals.yml'), '\n');
      const report = path.join(directory, 'report');
      const plan = spawnSync(process.execPath, ['--no-install', 'run', 'scripts/test-paid-shards.ts', '--tier', 'gate',
        '--emit-plan', path.join(report, 'manifest.json'), '--slices', '6'], { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
      expect(plan.status, plan.stdout + plan.stderr).toBe(0);
      const manifest = JSON.parse(fs.readFileSync(path.join(report, 'manifest.json'), 'utf8'));
      expect(manifest.sliceCount).toBe(6);
      expect(manifest.entries.some((entry: any) => entry.status === 'planned')).toBe(true);
      const reconcile = spawnSync(process.execPath, ['--no-install', 'run', 'scripts/test-paid-shards.ts', '--tier', 'gate',
        '--report', report], { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
      expect(reconcile.status, reconcile.stdout + reconcile.stderr).toBe(1);
      expect(reconcile.stdout).toContain('report: 0/6 slices');
      expect(reconcile.stderr.match(/slice \d\/6 reported NO result/g)).toHaveLength(6);
      expect(reconcile.stderr).not.toContain('Cannot find module');
      expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(false);
      const provider = spawnSync(process.execPath, ['--no-install', '-e', 'import "./test/helpers/llm-judge.ts"'],
        { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
      expect(provider.status).toBe(1);
      expect(provider.stderr).toContain("Cannot find module '@anthropic-ai/sdk'");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);

  for (const { name, jobs } of workflows) {
    test(`${name}: planning is independent of image startup and has no dependency install`, () => {
      const planner = jobs['plan-slices'];
      expect(planner.needs).toBeUndefined();
      expect(planner.container).toBeUndefined();
      expect(planner.permissions).toEqual({ contents: 'read' });
      const checkout = planner.steps.find(step => step.uses?.startsWith('actions/checkout@'))!;
      expect(checkout.with?.['persist-credentials']).toBe(false);
      if (name === 'evals.yml') expect(checkout.with?.['fetch-depth']).toBe(0);
      const setup = planner.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'))!;
      expect(setup.with?.['bun-version']).toBe('1.4.0');
      expect(JSON.stringify(planner)).not.toMatch(/secrets\.|restore-deps|bun install|bun run build/);
      expect(planner.steps.find(step => step.run?.includes('--emit-plan'))?.run).toContain('bun --no-install run');
    });

    test(`${name}: executors still require both prerequisites and consume the image`, () => {
      const executor = jobs['eval-slices'];
      expect(executor.needs).toEqual(['build-image', 'plan-slices']);
      expect(JSON.stringify(executor.container)).toContain('needs.build-image.outputs.image-tag');
      if (name === 'evals.yml') {
        expect(executor.if).toBe("always() && needs.build-image.result == 'success' && needs.plan-slices.result == 'success'");
      } else {
        expect(executor.if).toBeUndefined();
      }
      expect(executor.steps.some(step => step.run === 'bun run build')).toBe(true);
      expect(executor.steps.some(step => step.uses === './.github/actions/restore-deps')).toBe(true);
    });

    test(`${name}: report still reconciles failed executors without installing dependencies`, () => {
      const report = jobs[name === 'evals.yml' ? 'slices-report' : 'report'];
      expect(report.container).toBeUndefined();
      expect(report.needs).toContain('plan-slices');
      expect(report.needs).toContain('eval-slices');
      expect(report.if).toBe("always() && needs.plan-slices.result == 'success'");
      expect(JSON.stringify(report.steps)).not.toMatch(/restore-deps|bun install/);
      expect(report.steps.find(step => step.run?.includes('--report'))?.run).toContain('bun --no-install run');
      if (name === 'evals.yml') expect(report.permissions).toEqual({ contents: 'read' });
    });

    test(`${name}: failure logs include the hidden spool directory without uploading the rest of the cache`, () => {
      const logs = jobs['eval-slices'].steps.find(step => step.with?.name === 'paid-slice-${{ matrix.slice }}-logs');
      expect(logs?.uses).toStartWith('actions/upload-artifact@');
      expect(logs?.if).toBe('failure()');
      expect(logs?.with?.['include-hidden-files']).toBe(true);
      expect(String(logs?.with?.path).trim().split('\n')).toEqual([
        '/home/runner/.cache/gstack-paid-shard-*.log',
        '/tmp/gstack-paid-shard-*.log',
      ]);
      expect(Object.values(jobs).flatMap(job => job.steps).filter(step => step.with?.['include-hidden-files']))
        .toEqual([logs]);
    });
  }

  test('PR planning preserves the fork and Dependabot trust boundaries without the needs chain', () => {
    expect(workflows[0].jobs['plan-slices'].if).toBe(
      "github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)",
    );
  });
});

describe('dependency-free CI planner and report execution', () => {
  let fixture: string;

  beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-paid-coordination-'));
    const sourceOnly = { recursive: true, filter: (file: string) => path.basename(file) !== 'node_modules' };
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(fixture, 'scripts'), sourceOnly);
    fs.cpSync(path.join(ROOT, 'test/helpers'), path.join(fixture, 'test/helpers'), sourceOnly);
    expect(fs.readFileSync(path.join(fixture, 'test/helpers/llm-judge.ts'), 'utf8'))
      .toBe(fs.readFileSync(path.join(ROOT, 'test/helpers/llm-judge.ts'), 'utf8'));
    fs.cpSync(path.join(ROOT, 'lib'), path.join(fixture, 'lib'), sourceOnly);
    expect(fs.existsSync(path.join(fixture, 'lib/diagram-render/node_modules'))).toBe(false);
    fs.mkdirSync(path.join(fixture, '.github'), { recursive: true });
    for (const file of ['.github/cookie-workflow-manual-review.json', 'setup-browser-cookies/SKILL.md', 'BROWSER.md']) {
      fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(fixture, file));
    }
    for (const file of collectPaidTestFiles()) {
      fs.copyFileSync(path.join(ROOT, file), path.join(fixture, file));
    }
  });

  afterAll(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  function run(args: string[], tier: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['--no-install', 'run', 'scripts/test-paid-shards.ts', '--tier', tier, ...args], {
      cwd: fixture,
      env: { PATH: '', HOME: fixture, EVALS_ALL: '1', EVALS_TIER: tier, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  test('diff-selected host planning matches the same checkout with no installed dependencies', () => {
    const git = Bun.which('git')!;
    const gitDir = spawnSync(git, ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
    expect(gitDir.status).toBe(0);
    const manifestPath = path.join(fixture, 'diff-manifest.json');
    const env = { EVALS_ALL: '', EVALS_BASE: 'HEAD' };
    const planned = run(['--emit-plan', manifestPath, '--slices', '6'], 'gate', {
      ...env,
      PATH: path.dirname(git),
      GIT_DIR: gitDir.stdout.trim(),
      GIT_WORK_TREE: ROOT,
    });
    expect(planned.status, planned.stderr).toBe(0);
    const manifest: PaidRunManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest).toEqual(buildRunManifest({ tier: 'gate', sliceCount: 6, evalsAll: false, env }));
    expect(manifest.evalsAll).toBe(false);
  });

  for (const tier of ['gate', 'periodic'] as const) {
    test(`${tier}: host planner preserves the complete manifest and report fails closed`, () => {
      const sliceCount = tier === 'gate' ? 6 : 7;
      const dedicatedAutoplanSlice = tier === 'periodic';
      const reportDir = path.join(fixture, tier);
      const manifestPath = path.join(reportDir, 'manifest.json');
      const planned = run([
        '--emit-plan', manifestPath, '--slices', String(sliceCount),
        ...(dedicatedAutoplanSlice ? ['--autoplan-slice'] : []),
      ], tier);
      expect(planned.error).toBeUndefined();
      expect(planned.status, planned.stderr).toBe(0);
      const manifest: PaidRunManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest).toEqual(buildRunManifest({
        tier, sliceCount, dedicatedAutoplanSlice, evalsAll: true, env: { EVALS_ALL: '1' },
      }));
      expect(manifest.entries.filter(entry => entry.status === 'planned').length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(fixture, 'node_modules'))).toBe(false);
      for (let sliceIndex = 1; sliceIndex <= sliceCount; sliceIndex++) {
        const result: SliceResult = {
          version: 1, tier, sliceIndex, sliceCount,
          outcomes: manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === sliceIndex).map(entry => ({
            files: [entry.file], status: 'passed', exitCode: 0, elapsedMs: 1,
            executedTests: STRICT_RETRY_CASE_BUDGETS.find(budget => budget.file === entry.file)?.cases ?? 1,
            skippedTests: 0,
            ...(entry.budget ? { budget: entry.budget } : {}),
          })),
        };
        fs.writeFileSync(path.join(reportDir, `slice-${sliceIndex}.json`), JSON.stringify(result));
      }
      const clean = run(['--report', reportDir], tier);
      expect(clean.status, clean.stderr).toBe(0);
      expect(clean.stdout).toContain('every planned shard accounted and passed');

      const lastSlice = path.join(reportDir, `slice-${sliceCount}.json`);
      const saved = fs.readFileSync(lastSlice, 'utf8');
      fs.rmSync(lastSlice);
      const missing = run(['--report', reportDir], tier);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`slice ${sliceCount}/${sliceCount} reported NO result`);

      const failed: SliceResult = JSON.parse(saved);
      expect(failed.outcomes.length).toBeGreaterThan(0);
      failed.outcomes[0].status = 'failed';
      failed.outcomes[0].exitCode = 1;
      fs.writeFileSync(lastSlice, JSON.stringify(failed));
      fs.writeFileSync(path.join(reportDir, 'retry-results.json'), JSON.stringify({
        tests: [
          { name: 'recovered', passed: false }, { name: 'recovered', passed: true },
          { name: 'exhausted', passed: false }, { name: 'exhausted', passed: false },
          { name: 'regressed', passed: true }, { name: 'regressed', passed: false },
        ],
        flaky_retries: ['recovered', 'exhausted', 'regressed'].map(name => ({ name, attempts: 2 })),
      }));
      const red = run(['--report', reportDir], tier);
      expect(red.status).toBe(1);
      expect(red.stderr).toContain(`${failed.outcomes[0].files[0]}: failed`);
      expect(red.stdout).toContain('3 executed, 0 reused; 1 passed, 2 failed, 0 manual accepted (unscored; no score-cache credit) (6 attempt records from 1 collectors)');
      expect(red.stdout).toContain('3 cases with multiple attempts this run:');
      expect(red.stdout).not.toMatch(/passed only on retry|not blocking/);

      fs.writeFileSync(manifestPath, '{');
      const corrupt = run(['--report', reportDir], tier);
      expect(corrupt.status).toBe(1);
    });
  }

  test('report verifies every manual claim against current source, preserves attempts, and never masks a failed shard', () => {
    const reportDir = path.join(fixture, 'manual-report');
    const manifestPath = path.join(reportDir, 'manifest.json');
    const planned = run(['--emit-plan', manifestPath, '--slices', '1'], 'gate');
    expect(planned.status, planned.stderr).toBe(0);
    const manifest: PaidRunManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const slice: SliceResult = {
      version: 1, tier: 'gate', sliceIndex: 1, sliceCount: 1,
      outcomes: manifest.entries.filter(entry => entry.status === 'planned').map(entry => ({
        files: [entry.file], status: 'passed', exitCode: 0, elapsedMs: 1,
        executedTests: STRICT_RETRY_CASE_BUDGETS.find(budget => budget.file === entry.file)?.cases ?? 1,
        skippedTests: 0, ...(entry.budget ? { budget: entry.budget } : {}),
      })),
    };
    const slicePath = path.join(reportDir, 'slice-1.json');
    const collectorPath = path.join(reportDir, 'judge-results.json');
    const summaryPath = path.join(reportDir, 'collector-outcomes.json');
    const receipt = manualReviewFixture(ROOT);
    const write = (tests: unknown[]) => fs.writeFileSync(collectorPath, JSON.stringify({
      total_tests: tests.length, tier: 'llm-judge', shard: 1, total_cost_usd: 0,
      tests, flaky_retries: [{ name: receipt.name, attempts: tests.length }],
    }));
    fs.writeFileSync(slicePath, JSON.stringify(slice));
    write([{ ...receipt, passed: true }, receipt]);
    const historical = run(['--report', reportDir], 'gate');
    expect(historical.status).toBe(1);
    expect(historical.stderr).toContain('attempt 1: Malformed manual-review claim');
    expect(fs.existsSync(summaryPath)).toBe(false);

    write([{ ...receipt, manual_review: { ...receipt.manual_review, refusal: {
      ...receipt.manual_review!.refusal, response_id: '',
    } } }, receipt]);
    const malformed = run(['--report', reportDir], 'gate');
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('attempt 1: Malformed manual-review claim');

    write([{ ...receipt, manual_review: undefined, passed: false }, receipt]);
    const forgedFirstAttempt = run(['--report', reportDir], 'gate');
    expect(forgedFirstAttempt.status).toBe(1);
    expect(forgedFirstAttempt.stderr).toContain('attempt 2: manual review is only valid on the first case attempt');
    expect(fs.existsSync(summaryPath)).toBe(false);
    write([receipt, { ...receipt, attempt: 2 }]);
    const retriedManual = run(['--report', reportDir], 'gate');
    expect(retriedManual.status).toBe(1);
    expect(retriedManual.stderr).toContain('attempt 2: Malformed manual-review claim');
    expect(fs.existsSync(summaryPath)).toBe(false);

    write([receipt]);
    const secondCollector = path.join(reportDir, 'other-results.json');
    fs.writeFileSync(secondCollector, JSON.stringify({ total_tests: 1, tests: [receipt] }));
    const duplicateCollector = run(['--report', reportDir], 'gate');
    expect(duplicateCollector.status).toBe(1);
    expect(duplicateCollector.stderr).toContain('duplicate manual-review claim');
    expect(fs.existsSync(summaryPath)).toBe(false);
    fs.rmSync(secondCollector);

    write([receipt, { name: 'automated', suite: 'other', passed: true, execution: 'reused' }]);
    const clean = run(['--report', reportDir], 'gate');
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('1 passed, 0 failed, 1 manual accepted (unscored; no score-cache credit) (2 attempt records');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.totals).toEqual({ executed: 1, reused: 1, passed: 1, failed: 0,
      manual_accepted: 1, attempts: 2, total: 2, flaky: 1 });
    expect(summary.files[0]).toMatchObject({ file: 'judge-results.json', total: 2, manual_accepted: 1, passed: 1 });
    expect(JSON.parse(fs.readFileSync(collectorPath, 'utf8')).tests[0]).toEqual(receipt);

    const browserPath = path.join(fixture, 'BROWSER.md');
    const browserSource = fs.readFileSync(browserPath, 'utf8');
    fs.writeFileSync(browserPath, browserSource.replace('#### Choosing a source and checking sign-in',
      '#### Choosing a source and checking sign-in\nchanged approved source'));
    const sourceDrift = run(['--report', reportDir], 'gate');
    expect(sourceDrift.status).toBe(1);
    expect(sourceDrift.stderr).toContain('does not match current source and approval');
    expect(fs.existsSync(summaryPath)).toBe(false);
    fs.writeFileSync(browserPath, browserSource);

    write([receipt, { name: 'unapproved', passed: false, execution: 'executed' }]);
    const failedCollector = run(['--report', reportDir], 'gate');
    expect(failedCollector.status).toBe(1);
    expect(failedCollector.stderr).toContain('1 unapproved final collector failure(s)');
    expect(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).totals).toMatchObject({ failed: 1, manual_accepted: 1 });

    write([receipt, { passed: true }]);
    const missingName = run(['--report', reportDir], 'gate');
    expect(missingName.status).toBe(1);
    expect(missingName.stderr).toContain('attempt 2: malformed collector entry (name/passed required)');
    expect(fs.existsSync(summaryPath)).toBe(false);
    write([receipt, { name: 'malformed', passed: 'true' }]);
    const malformedPassed = run(['--report', reportDir], 'gate');
    expect(malformedPassed.status).toBe(1);
    expect(malformedPassed.stderr).toContain('attempt 2: malformed collector entry (name/passed required)');
    expect(fs.existsSync(summaryPath)).toBe(false);

    write([receipt, { name: 'automated', suite: 'other', passed: true, execution: 'reused' }]);

    slice.outcomes[0].status = 'failed';
    slice.outcomes[0].exitCode = 1;
    fs.writeFileSync(slicePath, JSON.stringify(slice));
    const failedShard = run(['--report', reportDir], 'gate');
    expect(failedShard.status).toBe(1);
    expect(failedShard.stderr).toContain(`${slice.outcomes[0].files[0]}: failed`);
    expect(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).totals.manual_accepted).toBe(1);

    const stale = structuredClone(receipt);
    stale.manual_review!.approval.prompt_sha256 = '0'.repeat(64);
    write([stale]);
    const mismatched = run(['--report', reportDir], 'gate');
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain('attempt 1: Malformed manual-review claim');
    expect(fs.existsSync(summaryPath)).toBe(false);
  });
});
