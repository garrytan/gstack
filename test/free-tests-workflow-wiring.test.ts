/**
 * Static tripwire for .github/workflows/free-tests.yml — the Linux free-suite
 * lane. Pins the three properties that made the lane worth having:
 *
 *   1. It invokes the CANONICAL runner (bun run test:free), not a raw
 *      `bun test <dirs>` glob — the runner owns TEST_ROOTS and strict-output
 *      classification, so a truncated run can't report green.
 *   2. It is SECRETLESS where code runs: free tests make no API calls, and
 *      keeping keys out means fork PRs get real signal here. The one allowed
 *      `secrets.` reference is TRUNK_API_TOKEN in the learning-only
 *      trunk-dynamic-ci observer, which checks out and runs nothing of the
 *      PR's and no job depends on; any other reference is a regression. The
 *      detection-only Trunk uploader runs after the run, in trunk-flaky-tests.yml.
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
import {
  DEFAULT_WALL_TIMEOUT_MS, FLAKY_RETRY_CAP, ciPlanMatrix, collectFreeTestFiles, createFreeCiPlan,
  loadFreeTestDurations, wallTimeoutForPackedShard, wallTimeoutForShard,
} from '../scripts/test-free-shards';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github', 'workflows', 'free-tests.yml');

describe('free-tests workflow wiring', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow exists and invokes the canonical runner', () => {
    expect(source).toContain('bun run test:free');
    expect(source).not.toMatch(/run:\s*bun test\s/);
  });

  test('secretless: no secrets reach the free lane', () => {
    const jobs = (Bun.YAML.parse(source) as any).jobs;
    expect(source.match(/secrets\s*(?:\.|\[)\s*['"]?[A-Za-z0-9_-]*|toJSON\(\s*secrets\b/gi)).toEqual(['secrets.TRUNK_API_TOKEN']);
    expect(jobs['trunk-dynamic-ci'].env).toEqual({ TRUNK_API_TOKEN: '${{ secrets.TRUNK_API_TOKEN }}' });
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('OPENAI_API_KEY');
  });

  // Value: protects=GST-1400's learning-only contract: Trunk Dynamic CI observes free-suite and macos-named-regressions on same-repository pull requests and can never skip, gate or fail anything; fails_when=a job needs or reads the observer, it re-exports outputs, checks out or runs PR code beside the token, gains token scopes, loses its fail-open settings, runs on forks or non-PR events, or the action is unpinned; seam=.github/workflows/free-tests.yml; no_claim=what Trunk recommends
  test('trunk-dynamic-ci is a learning-only observer: pinned, scope-less, fail-open, read by no job', () => {
    const jobs = (Bun.YAML.parse(source) as any).jobs;
    const trunk = jobs['trunk-dynamic-ci'];
    expect(trunk.if).toBe("github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository");
    expect(trunk.permissions).toEqual({});
    expect(trunk['continue-on-error']).toBe(true);
    expect(trunk['timeout-minutes']).toBe(5);
    expect(trunk.outputs).toBeUndefined();
    expect(trunk.needs).toBeUndefined();
    expect(trunk.steps).toHaveLength(1);
    const [step] = trunk.steps;
    expect(step.uses).toBe('trunk-io/dynamic-ci@5bcddbf3615c2b032c21eed1b514c91164bda4a8');
    expect(step.run).toBeUndefined();
    expect(step.if).toBe("env.TRUNK_API_TOKEN != ''");
    expect(step['continue-on-error']).toBe(true);
    expect(step['timeout-minutes']).toBe(3);
    expect(step.env).toEqual({ TRUNK_DISABLE_TELEMETRY: 'true' });
    expect(step.with).toEqual({ token: '${{ env.TRUNK_API_TOKEN }}', 'job-keys': 'free-suite,macos-named-regressions', 'github-token': '', 'enable-annotation': 'true' });
    for (const key of step.with['job-keys'].split(',')) expect(jobs[key], key).toBeDefined();
    for (const name of Object.keys(jobs).filter(n => n !== 'trunk-dynamic-ci')) {
      expect([name, [jobs[name].needs ?? []].flat()]).not.toEqual([name, expect.arrayContaining(['trunk-dynamic-ci'])]);
      expect([name, JSON.stringify(jobs[name])]).not.toEqual([name, expect.stringMatching(/trunk|dynamic-ci/i)]);
    }
  });

  // Value: protects=GST-1859's detection-only contract: Trunk Flaky Tests receives every free-suite shard's JUnit, failures included, and can never quarantine, skip, gate or fail anything, while the token never shares a job with pull-request code; fails_when=the suite stops writing or uploading JUnit, the uploader job checks out or runs code, gains token scopes, is needed or read by any job, loses fail-open or its token skip, turns quarantine on, runs on forks, or either action is unpinned; seam=.github/workflows/free-tests.yml; no_claim=what Trunk flags
  test('trunk-flaky-tests.yml is a detection-only uploader after the run: pinned, read-only token, fail-open, quarantine off, never on forks', () => {
    const jobs = (Bun.YAML.parse(source) as any).jobs;
    const suite = jobs['free-suite'];
    expect(suite.steps.find((step: any) => step.name === 'Run free suite').run).toContain('--junit-dir "$RUNNER_TEMP/free-junit"');
    const keep = suite.steps.find((step: any) => step.name === 'Upload shard JUnit reports');
    expect(keep.if).toBe('always()');
    expect(keep.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(keep.with).toEqual({ name: 'free-junit-${{ matrix.shard }}', path: '${{ runner.temp }}/free-junit/*.xml', 'if-no-files-found': 'ignore', 'retention-days': 7 });
    const quick = jobs['quick-bun-default'].steps as any[];
    const quickRun = quick.findIndex(step => step.name === 'Run the quick free tier on the install-default Bun');
    expect(quick[quickRun].env).toEqual({ GSTACK_FREE_RETRY_FLAKY: '1', GSTACK_FLAKE_LEDGER: '${{ runner.temp }}/flake-ledger.jsonl' });
    expect(quick[quickRun].run).toBe('xvfb-run -a bun run test:quick --junit-dir "$RUNNER_TEMP/quick-junit"');
    const quickLedger = quick.find(step => step.with?.name === 'flake-ledger-quick');
    expect(quick.indexOf(quickLedger)).toBeGreaterThan(quickRun);
    expect(quickLedger.if).toBe('always()');
    expect(quickLedger.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(quickLedger.with).toEqual({ name: 'flake-ledger-quick', path: '${{ runner.temp }}/flake-ledger.jsonl', 'if-no-files-found': 'ignore', 'retention-days': 90 });
    const quickJunit = quick.find(step => step.with?.name === 'quick-junit');
    expect(quick.indexOf(quickJunit)).toBeGreaterThan(quickRun);
    expect(quickJunit.if).toBe('always()');
    expect(quickJunit.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(quickJunit.with).toEqual({ name: 'quick-junit', path: '${{ runner.temp }}/quick-junit/*.xml', 'if-no-files-found': 'ignore', 'retention-days': 7 });
    for (const name of Object.keys(jobs)) expect([name, /TRUNK_ORG_API_TOKEN|analytics-uploader|download-artifact[^"]*"[^}]*free-junit-\*/.test(JSON.stringify(jobs[name]))]).toEqual([name, false]);

    const upSource = fs.readFileSync(path.resolve(import.meta.dir, '..', '.github', 'workflows', 'trunk-flaky-tests.yml'), 'utf-8');
    const up = Bun.YAML.parse(upSource) as any;
    expect(up.on).toEqual({ workflow_run: { workflows: ['Free Tests'], types: ['completed'] } });
    expect(up.permissions).toEqual({});
    expect(Object.keys(up.jobs)).toEqual(['trunk-flaky-tests']);
    expect(upSource.match(/secrets\s*(?:\.|\[)\s*['"]?[A-Za-z0-9_-]*|toJSON\(\s*secrets\b/gi)).toEqual(['secrets.TRUNK_ORG_API_TOKEN']);
    expect(upSource).not.toContain('pull_request_target');
    const flaky = up.jobs['trunk-flaky-tests'];
    expect(flaky.if).toBe("github.event.workflow_run.conclusion != 'skipped' && ((github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main') || github.event.workflow_run.event == 'workflow_dispatch' || (github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.full_name == github.repository))");
    expect(flaky['runs-on']).toBe('ubuntu-24.04');
    expect(flaky.permissions).toEqual({ actions: 'read' });
    expect(flaky.env).toEqual({ TRUNK_ORG_API_TOKEN: '${{ secrets.TRUNK_ORG_API_TOKEN }}' });
    expect(flaky['continue-on-error']).toBe(true);
    expect(flaky['timeout-minutes']).toBe(10);
    expect(flaky.outputs).toBeUndefined();
    expect(flaky.needs).toBeUndefined();
    expect(flaky.steps).toHaveLength(4);
    const [downloadShards, downloadQuick, uploadShards, uploadQuick] = flaky.steps;
    for (const step of flaky.steps) {
      expect(step.run).toBeUndefined();
      expect(step.uses.startsWith('actions/checkout@')).toBe(false);
      expect(step['continue-on-error']).toBe(true);
    }
    const fromRun = { 'run-id': '${{ github.event.workflow_run.id }}', 'github-token': '${{ github.token }}' };
    for (const download of [downloadShards, downloadQuick]) {
      expect(download.if).toBe("env.TRUNK_ORG_API_TOKEN != ''");
      expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    }
    expect(downloadShards.with).toEqual({ pattern: 'free-junit-*', path: '${{ github.workspace }}/free-junit', ...fromRun });
    expect(downloadQuick.with).toEqual({ name: 'quick-junit', path: '${{ github.workspace }}/quick-junit', ...fromRun });
    const uploaded = (dir: string) => ({
      'junit-paths': `\${{ github.workspace }}/${dir}/**/*.xml`,
      'org-slug': 'garry-tan',
      token: '${{ env.TRUNK_ORG_API_TOKEN }}',
      'test-collection-id': '7yDVXXE3',
      'cli-version': '0.17.0',
      'use-cache': 'false',
      quarantine: 'false',
      'use-uncloned-repo': 'true',
      'github-token': '',
      'gh-repo-url': '${{ github.server_url }}/${{ github.repository }}',
      'gh-repo-head-sha': '${{ github.event.workflow_run.head_sha }}',
      'gh-repo-head-branch': '${{ github.event.workflow_run.head_branch }}',
    });
    for (const [upload, dir] of [[uploadShards, 'free-junit'], [uploadQuick, 'quick-junit']] as const) {
      expect(upload.if).toBe(`env.TRUNK_ORG_API_TOKEN != '' && hashFiles('${dir}/**/*.xml') != ''`);
      expect(upload.uses).toBe('trunk-io/analytics-uploader@9886de74a788c450c793109577a4d97bfb3e799f');
      expect(upload['timeout-minutes']).toBe(5);
    }
    expect(uploadShards.with).toEqual(uploaded('free-junit'));
    expect(uploadQuick.with).toEqual({ ...uploaded('quick-junit'), variant: 'bun-default' });
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
    expect(suite.needs).toEqual(['free-plan', 'reuse', 'docs-scope']);
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
        expect(step.run.trim(), name).toBe('if [ "$SYSTEM_PACKAGES" = success ]; then npx playwright install chromium; else npx playwright install --with-deps chromium; fi');
        expect(step.env, name).toEqual({ SYSTEM_PACKAGES: '${{ steps.apt_offline.outcome }}' });
      }
      expect(steps[install]['continue-on-error'], name).toBe(true);
      const offline = steps.find((step: any) => step.id === 'apt_offline');
      const failOpen = [offline, steps[install], steps.find((step: any) => step.name === (name === 'free-suite' ? 'Upload shard JUnit reports' : "Upload the quick tier's JUnit reports"))];
      expect(steps.filter((step: any) => step['continue-on-error']), name).toEqual(failOpen);
    }
  });

  test('system packages are cached per runner image and Playwright version, and apt waits for a killed attempt\'s lock (2026-11-19, run 44485949701)', () => {
    const jobs = (Bun.YAML.parse(source) as any).jobs;
    for (const name of ['free-suite', 'quick-bun-default']) {
      const steps = jobs[name].steps;
      const at = (pred: (step: any) => boolean) => steps.findIndex(pred);
      const config = at((step: any) => step.run?.includes('/etc/apt/apt.conf.d/90gstack-ci'));
      const base = at((step: any) => step.id === 'apt_base');
      const restore = at((step: any) => step.id === 'apt_cache');
      const offline = at((step: any) => step.id === 'apt_offline');
      const install = at((step: any) => step.id === 'playwright_install');
      const xvfb = at((step: any) => step.name === 'Install Xvfb + X11 utilities + gate tools');
      const keep = at((step: any) => step.id === 'apt_keep');
      const save = keep + 1;
      expect(steps[config].run, name).toContain('DPkg::Lock::Timeout "240";');
      expect(steps[config].run, name).toContain('APT::Keep-Downloaded-Packages "true";');
      expect(steps[base].run, name).toContain("dpkg-query -W -f='${binary:Package}=${Version}\\n' | sha256sum");
      expect(steps[restore].uses, name).toStartWith('actions/cache/restore@');
      expect(steps[base].env, name).toEqual({ PLAYWRIGHT_VERSION: '${{ steps.playwright.outputs.version }}' });
      expect(steps[base].run, name).toContain('echo "cache_key=linux-apt-debs-$(');
      expect(steps[base].run, name).toContain(')-playwright-$PLAYWRIGHT_VERSION" >> "$GITHUB_OUTPUT"');
      expect(steps[restore].with, name).toEqual({ path: '~/.cache/gstack-apt-debs', key: '${{ steps.apt_base.outputs.cache_key }}' });
      expect(steps[offline].if, name).toBe("steps.apt_cache.outputs.cache-hit == 'true'");
      expect(steps[offline].run, name).toBe('sudo dpkg -i "$HOME"/.cache/gstack-apt-debs/*.deb');
      expect(steps[keep].if, name).toBe("steps.apt_cache.outputs.cache-hit != 'true'");
      expect(steps[keep].run, name).toContain('cp /var/cache/apt/archives/*.deb ~/.cache/gstack-apt-debs/');
      expect(steps[save].uses, name).toStartWith('actions/cache/save@');
      expect(steps[save].if, name).toBe("steps.apt_keep.outputs.save == 'true'");
      expect(steps[save].with, name).toEqual({ path: '~/.cache/gstack-apt-debs', key: '${{ steps.apt_cache.outputs.cache-primary-key }}' });
      expect([config, base, restore, offline, install], name).toEqual([config, base, restore, offline, install].sort((a, b) => a - b));
      expect(config, name).toBeGreaterThan(-1);
      expect(xvfb, name).toBeGreaterThan(install);
      expect(keep, name).toBe(xvfb + 1);
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
    expect(workflow.env.FREE_SUITE_RUNNER).toMatch(/^ubicloud-standard-(2|4|8|16)$/);
    expect(workflow.env.FREE_SUITE_SHARDS).toMatch(/^[1-9][0-9]?$/);
    expect(planner.outputs.runner).toBe('${{ steps.plan.outputs.runner }}');
    expect(workflow.jobs['free-suite']['runs-on']).toBe('${{ needs.free-plan.outputs.runner }}');
    expect(workflow.env.FREE_SUITE_JOBS).toMatch(/^[1-8]$/);
    expect(plan.env).toEqual({ RUNNER_OVERRIDE: '${{ inputs.free_runner }}', SHARDS_OVERRIDE: '${{ inputs.free_shards }}', JOBS_OVERRIDE: '${{ inputs.free_jobs }}' });
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
        env: { ...process.env, ...workflow.env, RUNNER_OVERRIDE: '', SHARDS_OVERRIDE: '', JOBS_OVERRIDE: '', ...overrides,
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
      expect(unset.args).toContain(`--shards ${workflow.env.FREE_SUITE_SHARDS} --shard-jobs ${workflow.env.FREE_SUITE_JOBS}`);
      const override = resolve({ RUNNER_OVERRIDE: 'ubicloud-standard-4', SHARDS_OVERRIDE: '16', JOBS_OVERRIDE: '3' });
      expect(override.status).toBe(0);
      expect(override.outputs.runner).toBe('ubicloud-standard-4');
      expect(override.args).toContain('--shards 16 --shard-jobs 3');
      const refusals: Record<string, string>[] = [{ RUNNER_OVERRIDE: 'ubuntu-24.04' }, { RUNNER_OVERRIDE: 'ubicloud-standard-8 x' }, { SHARDS_OVERRIDE: '0' }, { SHARDS_OVERRIDE: '41' }, { SHARDS_OVERRIDE: '16; true' },
        { JOBS_OVERRIDE: '0' }, { JOBS_OVERRIDE: '9' }, { JOBS_OVERRIDE: '2; true' }, { JOBS_OVERRIDE: '-1' }];
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
  test('every free-suite job timeout covers its shard\'s runner wall, flaky retry and setup (#3850)', () => {
    // GitHub must never kill a free-suite job before the runner's own wall can
    // name the hung file and its flaky-retry pass can run: that kill uploads no
    // result and leaves red CI with no attribution. The job timeout therefore
    // follows the real plan for the committed duration seed and the live
    // FREE_SUITE_SHARDS / FREE_SUITE_JOBS, never a hand-picked number.
    const workflow = Bun.YAML.parse(source) as any;
    const setupSeconds = Number(workflow.env.FREE_SUITE_SETUP_SECONDS);
    expect(Number.isInteger(setupSeconds) && setupSeconds > 0).toBe(true);
    const plan = createFreeCiPlan(collectFreeTestFiles(), Number(workflow.env.FREE_SUITE_SHARDS),
      loadFreeTestDurations() ?? {}, 'wiring', Number(workflow.env.FREE_SUITE_JOBS), setupSeconds);
    const declared = workflow.jobs['free-suite']['timeout-minutes'];
    const emitted = ciPlanMatrix(plan, setupSeconds);
    if (!('include' in emitted)) throw new Error('the CI matrix carries no per-shard timeouts');
    const short = plan.shards.flatMap(shard => {
      const neededMs = wallTimeoutForPackedShard(shard.predictedMs, DEFAULT_WALL_TIMEOUT_MS, shard.files.length)
        + wallTimeoutForShard(FLAKY_RETRY_CAP) + setupSeconds * 1000;
      const minutes = declared === '${{ matrix.timeout_minutes }}'
        ? emitted.include.find(entry => entry.shard === shard.shard)?.timeout_minutes ?? 0
        : Number(declared);
      return minutes * 60_000 >= neededMs ? [] : [`shard ${shard.shard}: ${minutes} min < ${Math.ceil(neededMs / 1000)} s`];
    });
    expect(short).toEqual([]);
    const planStep = workflow.jobs['free-plan'].steps.find((step: any) => step.id === 'plan');
    expect(planStep.run).toContain('--job-setup-seconds "$FREE_SUITE_SETUP_SECONDS"');
  });
});
