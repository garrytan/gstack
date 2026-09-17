import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRunManifest, collectPaidTestFiles, type PaidRunManifest, type SliceResult } from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
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
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(fixture, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'test/helpers'), path.join(fixture, 'test/helpers'), { recursive: true });
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
            files: [entry.file], status: 'passed', exitCode: 0, elapsedMs: 1, executedTests: 1, skippedTests: 0,
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
      const red = run(['--report', reportDir], tier);
      expect(red.status).toBe(1);
      expect(red.stderr).toContain(`${failed.outcomes[0].files[0]}: failed`);

      fs.writeFileSync(manifestPath, '{');
      const corrupt = run(['--report', reportDir], tier);
      expect(corrupt.status).toBe(1);
    });
  }
});
