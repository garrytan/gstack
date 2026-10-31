/**
 * Static pins for the Windows free lane (plan → one shard per windows-latest
 * job → Linux verify) and the dispatch-only native qualification campaigns
 * that moved out of it.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFreeTestFiles, createFreeCiPlan, curateWindowsSafe, parseCliOptions, validateFreeCiPlan } from '../scripts/test-free-shards';
import { windowsCurationLine } from '../scripts/lib/free-ci-health';
import { KNOWN_WINDOWS_SAFE, WINDOWS_PROBE_SAFE } from '../scripts/lib/windows-curation';

const root = path.resolve(import.meta.dir, '..');
const load = (file: string) => Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as any;
const windows = load('windows-free-tests.yml');
const native = load('native-qualification.yml');

/**
 * Ratchet: the Windows-safe subset may not silently shrink. If you deleted or
 * intentionally excluded Windows-safe tests, lower this floor to the printed
 * count in the same PR and say why; when the count grows, raise it.
 */
const WINDOWS_CURATED_FLOOR = 638;

test('the Windows lane plans, runs one strict shard per job and verifies every result', () => {
  expect(Object.keys(windows.on).sort()).toEqual(['pull_request', 'push', 'workflow_call', 'workflow_dispatch']);
  expect(windows.on.push).toEqual({ branches: ['main'] });
  expect(Object.keys(windows.on.workflow_dispatch.inputs)).toEqual(['record_durations', 'windows_jobs']);
  expect(Object.keys(windows.on.workflow_call.inputs)).toEqual(['record_durations']);
  const plan = windows.jobs['windows-plan'];
  expect(plan['runs-on']).toBe('ubuntu-24.04');
  const planStep = plan.steps.find((step: any) => step.id === 'plan');
  expect(planStep.run).toContain('--windows-only --ci-plan "$RUNNER_TEMP/windows-plan.json" --shards 6');
  expect(planStep.env.GSTACK_FREE_TEST_DURATIONS).toBe('scripts/free-test-durations-windows.json');
  const shard = windows.jobs['windows-free-shard'];
  expect(shard['runs-on']).toBe('windows-latest');
  expect(shard.needs).toBe('windows-plan');
  expect(shard.strategy).toEqual({ 'fail-fast': false, matrix: '${{ fromJSON(needs.windows-plan.outputs.matrix) }}' });
  const run = shard.steps.find((step: any) => step.name === 'Run Windows-safe shard');
  expect(run.run).toStartWith('bun run test:windows --ci-run "$RUNNER_TEMP/windows-plan.json" --shard ${{ matrix.shard }} --result ');
  expect(run.env.GSTACK_FREE_RETRY_FLAKY).toBe('1');
  expect(shard.steps.find((step: any) => step.name === 'Upload strict shard result').if).toBe('always()');
  const aggregate = windows.jobs['windows-free-tests'];
  expect(aggregate.if).toBe('${{ always() && !inputs.record_durations }}');
  expect(plan.if).toBe('${{ !inputs.record_durations }}');
  expect(aggregate.needs).toEqual(['windows-plan', 'windows-free-shard']);
  expect(aggregate.steps.at(-1).run).toContain('--windows-only --ci-verify "$RUNNER_TEMP/windows-plan.json" --results ');
});

test.skipIf(!Bun.which('bash'))('windows-plan passes the one sub-shard constant, or a validated dispatch override, to --shard-jobs', () => {
  const planStep = windows.jobs['windows-plan'].steps.find((step: any) => step.id === 'plan');
  expect(windows.env.WINDOWS_FREE_JOBS).toMatch(/^[1-4]$/);
  expect(planStep.env.JOBS_OVERRIDE).toBe('${{ inputs.windows_jobs }}');
  expect(planStep.run).not.toContain('${{');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'windows plan '));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$RUNNER_TEMP/bun-args"\necho \'{"shard":[1]}\'\n', { mode: 0o755 });
  const toShell = (p: string) => p.split(path.sep).join('/');
  const resolve = (override: string) => {
    rmSync(path.join(directory, 'bun-args'), { force: true });
    const result = spawnSync('bash', ['-c', planStep.run], {
      env: { ...process.env, ...windows.env, JOBS_OVERRIDE: override, PATH: `${toShell(bin)}:${process.env.PATH}`, RUNNER_TEMP: toShell(directory),
        GITHUB_OUTPUT: toShell(path.join(directory, 'output')), GITHUB_STEP_SUMMARY: toShell(path.join(directory, 'summary')) },
      encoding: 'utf8', timeout: 5000,
    });
    return { status: result.status, args: existsSync(path.join(directory, 'bun-args')) ? readFileSync(path.join(directory, 'bun-args'), 'utf8') : '' };
  };
  try {
    expect(resolve('')).toEqual({ status: 0, args: expect.stringContaining(`--shards 6 --shard-jobs ${windows.env.WINDOWS_FREE_JOBS}`) });
    expect(resolve('2')).toEqual({ status: 0, args: expect.stringContaining('--shards 6 --shard-jobs 2') });
    for (const bad of ['0', '5', '2; true', 'x']) {
      const refused = resolve(bad);
      expect(refused.status, bad).not.toBe(0);
      expect(refused.args, bad).toBe('');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a Windows CI plan binds the curated file set, so it never verifies as the full Linux suite', () => {
  for (const argv of [['--windows-only', '--ci-plan', 'p.json'], ['--windows-only', '--ci-run', 'p.json', '--shard', '1', '--result', 'r.json'], ['--windows-only', '--ci-verify', 'p.json', '--results', 'd']]) {
    expect(parseCliOptions(argv).windowsOnly).toBe(true);
  }
  const all = collectFreeTestFiles(root);
  const { safe } = curateWindowsSafe(all, root);
  const plan = createFreeCiPlan(safe, 6, {}, 'rev');
  expect(() => validateFreeCiPlan(plan, safe, 'rev')).not.toThrow();
  expect(() => validateFreeCiPlan(plan, all, 'rev')).toThrow('CI plan must cover every free file exactly once');
  expect(() => validateFreeCiPlan(createFreeCiPlan(all, 6, {}, 'rev'), safe, 'rev')).toThrow('CI plan must cover every free file exactly once');
});

test('a record_durations dispatch times each Windows-safe file alone and uploads the Windows seed', () => {
  const job = windows.jobs['windows-record-durations'];
  expect(job.if).toBe('${{ inputs.record_durations }}');
  expect(job['runs-on']).toBe('windows-latest');
  const record = job.steps.find((step: any) => step.name === 'Time every Windows-safe file alone');
  expect(record.run).toBe('set -o pipefail\nbun run test:windows --record-durations --wall-timeout 1200 2>&1 | tee "$RUNNER_TEMP/record.log"\n');
  expect(record.env.GSTACK_FREE_TEST_DURATIONS).toBeUndefined();
  const rename = job.steps.find((step: any) => step.name === 'Name the recording as the Windows seed');
  expect(rename.if).toBe("always() && steps.record.outcome != 'skipped'");
  expect(rename.run).toContain('grep -q \'wrote [0-9]* durations to\' "$RUNNER_TEMP/record.log" || {');
  expect(rename.run).toContain('cp scripts/free-test-durations.json "$RUNNER_TEMP/free-test-durations-windows.json"');
  const logs = job.steps.find((step: any) => step.name === 'Upload full recording logs');
  expect(logs.if).toBe('always()');
  expect(logs.with['include-hidden-files']).toBe(true);
  expect(job.steps.at(-1).with.name).toBe('free-test-durations-windows');
  expect(job.steps.at(-1).if).toBe("always() && steps.seed.outcome == 'success'");
});

test('Windows shards use the pinned Node runtime and retain complete logs on every run', () => {
  const steps = windows.jobs['windows-free-shard'].steps;
  const node = steps.find((step: any) => step.uses?.startsWith('actions/setup-node@'));
  expect(node.with['node-version']).toBe('24.18.0');
  expect(node.if).toBeUndefined();
  const upload = steps.find((step: any) => step.name === 'Upload full shard logs');
  expect(upload.if).toBe('always()');
  expect(upload.with.path.trim().split('\n')).toEqual([
    '.context/free-test-logs/gstack-free-test-*.log',
    '${{ runner.temp }}/gstack-free-test-*.log',
  ]);
  expect(upload.with['include-hidden-files']).toBe(true);
});

test(`the curated Windows-safe subset holds its floor of ${WINDOWS_CURATED_FLOOR} files`, () => {
  const curation = curateWindowsSafe(collectFreeTestFiles(root), root);
  const line = windowsCurationLine(curation);
  console.log(`[windows-curation] ${line}`);
  if (curation.safe.length < WINDOWS_CURATED_FLOOR) {
    throw new Error(`${line}: below the floor of ${WINDOWS_CURATED_FLOOR}. Fix: run \`bun run test:windows --list\` to see each exclusion reason; `
      + 'port newly excluded files (os.tmpdir(), explicit bash argv) or add a reasoned KNOWN_WINDOWS_SAFE entry in scripts/test-free-shards.ts; '
      + `if the shrink is intentional, lower WINDOWS_CURATED_FLOOR in test/windows-native-workflows.test.ts to ${curation.safe.length} and say why in the PR.`);
  }
});

test('every force-included Windows file is a real free test listed once', () => {
  const census = new Set(collectFreeTestFiles(root));
  const forced = [...KNOWN_WINDOWS_SAFE.map(entry => entry.file), ...WINDOWS_PROBE_SAFE];
  expect(forced.filter(file => !census.has(file))).toEqual([]);
  expect(new Set(forced).size).toBe(forced.length);
});

test('native qualification is dispatch-only with one exclusive mode per run', () => {
  expect(Object.keys(native.on)).toEqual(['workflow_dispatch']);
  const mode = native.on.workflow_dispatch.inputs.mode;
  expect(mode).toMatchObject({ type: 'choice', required: true });
  expect(mode.options).toEqual(['cookie-native', 'windows-native-diagnostics']);
  expect(native.permissions).toEqual({ contents: 'read' });
  expect(native.jobs['cookie-native-qualification'].if).toBe("inputs.mode == 'cookie-native'");
  expect(native.jobs['windows-native-diagnostics'].if).toBe("inputs.mode == 'windows-native-diagnostics'");
  for (const job of ['cookie-native-qualification', 'windows-native-diagnostics']) {
    const setup = native.jobs[job].steps.find((step: any) => step.uses?.startsWith('actions/setup-node@'));
    expect(setup.with['node-version']).toBe('24.18.0');
    expect(setup.if).toBeUndefined();
  }
});

test('the removed Dia qualification harness has no mode and no scripts', () => {
  expect(Object.keys(native.jobs)).toEqual(['cookie-native-qualification', 'windows-native-diagnostics']);
  for (const file of [path.join(import.meta.dir, '..', '.github/scripts', 'dia-gui-readiness.c'), path.join(import.meta.dir, '..', '.github/scripts', 'dia-launch-driver.mjs'),
    path.join(import.meta.dir, '..', '.github/scripts', 'qualify-dia-macos.ts'), path.join(import.meta.dir, '..', '.github/scripts', 'run-dia-native-qualification.ts')]) expect(existsSync(file)).toBe(false);
});

test('focused Windows diagnostics include the repaired lock and close cases without default-profile qualification', () => {
  const run = native.jobs['windows-native-diagnostics'].steps.find((step: any) => step.name === 'Run focused native launch and credential diagnostics').run;
  const pattern = run.match(/--test-name-pattern '([^']+)'/)?.[1];
  expect(pattern).toBeDefined();
  const selected = new RegExp(pattern);
  for (const name of ['native Windows launch diagnostics > observer', 'native Windows process qualification > a locked real Edge profile leaves its existing owner alive',
    'native Windows process qualification > real Edge synthetic profile: normal-close', 'native Windows process qualification > real Edge synthetic profile: stalled-close']) expect(selected.test(name)).toBe(true);
  expect(selected.test('native Windows process qualification > an exclusively created default Edge profile persists v20')).toBe(false);
});
