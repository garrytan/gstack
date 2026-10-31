/**
 * Static tripwire for .github/workflows/free-tests.yml — the Linux free-suite
 * lane. Pins the three properties that made the lane worth having:
 *
 *   1. It invokes the CANONICAL runner (bun run test:free), not a raw
 *      `bun test <dirs>` glob — the runner owns TEST_ROOTS and strict-output
 *      classification, so a truncated run can't report green.
 *   2. It is SECRETLESS: free tests make no API calls, and keeping keys out
 *      means fork PRs get real signal here. Any `secrets.` reference is a
 *      regression.
 *   3. It triggers on `pull_request` (never `pull_request_target`, which
 *      would hand a fork PR the base repo's context).
 *
 * Same wiring-tripwire class as test/hermetic-wiring.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'node:child_process';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github', 'workflows', 'free-tests.yml');

describe('free-tests workflow wiring', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow exists and invokes the canonical runner', () => {
    expect(source).toContain('bun run test:free');
    expect(source).not.toMatch(/run:\s*bun test\s/);
  });

  test('secretless: no secrets reach the free lane', () => {
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('OPENAI_API_KEY');
  });

  test('pull_request trigger, never pull_request_target', () => {
    expect(source).toContain('pull_request:');
    expect(source).not.toContain('pull_request_target');
  });

  test('the isolated matrix consumes one plan and the required aggregate verifies all receipts', () => {
    const workflow = Bun.YAML.parse(source) as any;
    const planner = workflow.jobs['free-plan'];
    const suite = workflow.jobs['free-suite'];
    const aggregate = workflow.jobs['free-tests'];
    expect(planner.steps.find((step: any) => step.id === 'plan').run).toContain('--ci-plan');
    expect(suite.needs).toBe('free-plan');
    expect(suite.strategy.matrix).toBe('${{ fromJSON(needs.free-plan.outputs.matrix) }}');
    expect(suite.strategy['fail-fast']).toBe(false);
    expect(suite.strategy['max-parallel']).toBe(20);
    expect(suite.steps.find((step: any) => step.name === 'Run free suite').run).toContain('--ci-run');
    expect(suite.steps.find((step: any) => step.name === 'Upload strict shard result').if).toBe('always()');
    expect(aggregate.if).toBe('always()');
    expect(aggregate.needs).toContain('free-suite');
    expect(aggregate.steps.some((step: any) => step.run?.includes('--ci-verify'))).toBe(true);
    expect(aggregate.needs).toContain('typecheck');
    const gate = aggregate.steps.find((step: any) => step.env?.TYPECHECK_RESULT);
    expect(gate.env.TYPECHECK_RESULT).toBe('${{ needs.typecheck.result }}');
    expect(gate.run).toContain('test "$TYPECHECK_RESULT" = success');
    const typecheck = workflow.jobs.typecheck.steps.map((step: any) => step.run).filter(Boolean);
    expect(typecheck).toEqual(expect.arrayContaining(['bun run typecheck', 'bun run typecheck:test', 'bun run format:cso:check']));
    expect(source).not.toContain('--quick');
  });

  test('zsh is installed so the bash+zsh portability arms run instead of skipping (#2669)', () => {
    const suite = (Bun.YAML.parse(source) as any).jobs['free-suite'];
    const apt = suite.steps.find((step: any) => step.name === 'Install Xvfb + X11 utilities + gate tools').run;
    expect(apt.split(/\s+/)).toContain('zsh');
    const ubicloud = fs.readFileSync(path.resolve(import.meta.dir, '..', 'scripts', 'ubicloud', 'setup-free-suite.sh'), 'utf-8');
    const ubicloudApt = ubicloud.match(/apt-get install(?:[^\n]*\\\n)*[^\n]*/)![0];
    expect(ubicloudApt.split(/\s+/)).toContain('zsh');
  });

  test('the aggregate summarizes every shard flake ledger before strict verification (W7a)', () => {
    const steps = (Bun.YAML.parse(source) as any).jobs['free-tests'].steps;
    const download = steps.findIndex((step: any) => step.with?.pattern === 'flake-ledger-*');
    const summary = steps.findIndex((step: any) => step.run?.includes('scripts/test-health-report.ts flake-summary "$RUNNER_TEMP/flake-ledgers" >> "$GITHUB_STEP_SUMMARY"'));
    const verify = steps.findIndex((step: any) => step.run?.includes('--ci-verify'));
    expect(steps[download].with.path).toBe('${{ runner.temp }}/flake-ledgers');
    expect(steps[download].with['merge-multiple']).toBeUndefined();
    expect(download).toBeLessThan(summary);
    expect(summary).toBeLessThan(verify);
  });

  test('the plan job runs the seed ratchet against the merge-base with full history', () => {
    const planner = (Bun.YAML.parse(source) as any).jobs['free-plan'];
    expect(planner.steps[0].with['fetch-depth']).toBe(0);
    const ratchet = planner.steps.find((step: any) => step.name?.startsWith('Seed growth ratchet'));
    expect(ratchet.run).toContain('GSTACK_FREE_SEED_BASE="$(git merge-base HEAD origin/main)"');
    expect(ratchet.run).toContain('test/free-seed-ratchet.test.ts');
  });

  test('flake telemetry stays wired: retry flag, single-writer ledger, unconditional artifact', () => {
    // WS1: a timing flake must not red the required lane, but every
    // flaky-pass must be recorded and uploaded — a green run is exactly when
    // the evidence matters. Removing any of these silently returns flakes to
    // either merge-blocking (flag off) or invisibility (ledger/artifact off).
    expect(source).toMatch(/GSTACK_FREE_RETRY_FLAKY:\s*"1"/);
    expect(source).toMatch(/GSTACK_FLAKE_LEDGER:\s*\$\{\{ runner\.temp \}\}\/flake-ledger\.jsonl/);
    expect(source).toContain('name: flake-ledger');
    expect(source).toMatch(/name: Upload flake ledger\s*\n\s*if: always\(\)/);
  });

  test.skipIf(!Bun.which('bash'))('a recovered retry retains its original detailed spool', () => {
    const steps = (Bun.YAML.parse(source) as any).jobs['free-suite'].steps;
    const probe = steps.find((step: any) => step.id === 'flake_spool');
    const upload = steps.find((step: any) => step.with?.name === 'free-test-shard-logs-${{ matrix.shard }}');
    expect(probe.if).toBe('always()');
    expect(upload.if).toBe("failure() || steps.flake_spool.outputs.present == 'true'");
    expect(upload.with.path).toBe('.context/free-test-logs/gstack-free-test-*.log');
    expect(upload.with['include-hidden-files']).toBe(true);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free spool '));
    const output = path.join(directory, 'step-output');
    const ledger = path.join(directory, 'flake-ledger.jsonl');
    try {
      for (const contents of [null, '', '{"kind":"flaky-pass","file":"test/example.test.ts"}\n']) {
        if (contents !== null) fs.writeFileSync(ledger, contents);
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-e', '-c', probe.run], {
          // Git Bash accepts C:/... paths; native backslashes are not shell paths.
          env: { ...process.env, RUNNER_TEMP: directory.split(path.sep).join('/'),
            GITHUB_OUTPUT: output.split(path.sep).join('/') },
          encoding: 'utf8', timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(output, 'utf8')).toBe(contents ? 'present=true\n' : '');
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('every Linux Playwright install has a version-keyed browser cache, 5-minute attempts and one retry of the install alone (run 39641712129)', () => {
    const jobs = (Bun.YAML.parse(source) as any).jobs;
    const installing = Object.keys(jobs).filter(name => jobs[name].steps.some((step: any) => step.run?.includes('playwright install --with-deps')));
    expect(installing.sort()).toEqual(['free-suite', 'quick-bun-default']);
    for (const name of installing) {
      const steps = jobs[name].steps;
      const version = steps.findIndex((step: any) => step.id === 'playwright');
      const cache = steps.findIndex((step: any) => step.with?.path === '~/.cache/ms-playwright');
      const install = steps.findIndex((step: any) => step.id === 'playwright_install');
      const retry = steps.findIndex((step: any) => step.if === "steps.playwright_install.outcome == 'failure'");
      expect(steps[version].run, name).toContain('require("playwright-core/package.json").version');
      expect(steps[cache].with.key, name).toBe('linux-playwright-chromium-${{ steps.playwright.outputs.version }}');
      expect(steps[cache].with['restore-keys'], name).toBeUndefined();
      expect(version, name).toBeLessThan(cache);
      expect(cache, name).toBeLessThan(install);
      expect(retry, name).toBe(install + 1);
      for (const step of [steps[install], steps[retry]]) {
        expect(step['timeout-minutes'], name).toBe(5);
        expect(step.run, name).toBe('npx playwright install --with-deps chromium');
      }
      expect(steps[install]['continue-on-error'], name).toBe(true);
      expect(steps.filter((step: any) => step['continue-on-error']), name).toEqual([steps[install]]);
    }
  });

  test('test jobs give PR and dispatch runs the local main that push runs get from checkout (#3237)', () => {
    const jobs = (Bun.YAML.parse(source) as any).jobs;
    for (const name of ['free-suite', 'quick-bun-default']) {
      const [checkout, guard] = jobs[name].steps;
      expect(checkout.uses, name).toStartWith('actions/checkout@');
      expect(guard.if, name).toBe("github.ref != 'refs/heads/main'");
      expect(guard.run, name).toBe('git checkout -q -B main');
    }
  });

  test.skipIf(!Bun.which('bash'))('free-plan resolves the one runner and shard constant for every event, and validates dispatch overrides', () => {
    const workflow = Bun.YAML.parse(source) as any;
    const planner = workflow.jobs['free-plan'];
    const plan = planner.steps.find((step: any) => step.id === 'plan');
    expect(workflow.env.FREE_SUITE_RUNNER).toMatch(/^ubicloud-standard-(2|4|8)$/);
    expect(workflow.env.FREE_SUITE_SHARDS).toMatch(/^[1-9][0-9]?$/);
    expect(planner.outputs.runner).toBe('${{ steps.plan.outputs.runner }}');
    expect(workflow.jobs['free-suite']['runs-on']).toBe('${{ needs.free-plan.outputs.runner }}');
    expect(plan.env).toEqual({ RUNNER_OVERRIDE: '${{ inputs.free_runner }}', SHARDS_OVERRIDE: '${{ inputs.free_shards }}' });
    expect(plan.run).not.toContain('${{');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free plan '));
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$RUNNER_TEMP/bun-args"\necho \'{"shard":[1]}\'\n', { mode: 0o755 });
    const toShell = (p: string) => p.split(path.sep).join('/');
    const resolve = (overrides: Record<string, string>) => {
      const output = path.join(directory, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['-c', plan.run], {
        env: { ...process.env, ...workflow.env, RUNNER_OVERRIDE: '', SHARDS_OVERRIDE: '', ...overrides,
          PATH: `${toShell(bin)}:${process.env.PATH}`, RUNNER_TEMP: toShell(directory),
          GITHUB_OUTPUT: toShell(output), GITHUB_STEP_SUMMARY: toShell(path.join(directory, 'summary')) },
        encoding: 'utf8', timeout: 5000,
      });
      const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2)));
      const args = fs.existsSync(path.join(directory, 'bun-args')) ? fs.readFileSync(path.join(directory, 'bun-args'), 'utf8') : '';
      fs.rmSync(path.join(directory, 'bun-args'), { force: true });
      return { status: result.status, outputs, args };
    };
    try {
      const unset = resolve({});
      expect(unset.status).toBe(0);
      expect(unset.outputs.runner).toBe(workflow.env.FREE_SUITE_RUNNER);
      expect(unset.args).toContain(`--shards ${workflow.env.FREE_SUITE_SHARDS}`);
      const override = resolve({ RUNNER_OVERRIDE: 'ubicloud-standard-4', SHARDS_OVERRIDE: '16' });
      expect(override.status).toBe(0);
      expect(override.outputs.runner).toBe('ubicloud-standard-4');
      expect(override.args).toContain('--shards 16');
      const refusals: Record<string, string>[] = [{ RUNNER_OVERRIDE: 'ubuntu-24.04' }, { RUNNER_OVERRIDE: 'ubicloud-standard-8 x' }, { SHARDS_OVERRIDE: '0' }, { SHARDS_OVERRIDE: '41' }, { SHARDS_OVERRIDE: '16; true' }];
      for (const bad of refusals) {
        const refused = resolve(bad);
        expect(refused.status, JSON.stringify(bad)).not.toBe(0);
        expect(refused.outputs.runner, JSON.stringify(bad)).toBeUndefined();
        expect(refused.args, JSON.stringify(bad)).toBe('');
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('every shard reports its peak memory and minimum free disk, even when the suite fails', () => {
    const steps = (Bun.YAML.parse(source) as any).jobs['free-suite'].steps;
    const start = steps.findIndex((step: any) => step.name === 'Start the memory and disk sampler');
    const suite = steps.findIndex((step: any) => step.name === 'Run free suite');
    const report = steps.findIndex((step: any) => step.name === 'Report peak memory and minimum free disk');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(suite);
    expect(report).toBeGreaterThan(suite);
    expect(steps[report].if).toBe('always()');
    expect(steps[report].run).toContain('RESOURCES: peak_used_mib=');
  });

  test('least-privilege token: contents read-only, credentials not persisted', () => {
    // The job executes PR-controlled code (install lifecycle scripts + the
    // suite itself). A default-grant GITHUB_TOKEN persisted into .git/config
    // by checkout would hand that code whatever the repo default allows.
    expect(source).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(source).toMatch(/persist-credentials:\s*false/);
  });
});
