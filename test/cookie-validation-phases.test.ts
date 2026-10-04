import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
// Retired with the finished validation_phase dispatch (W8f, CEO-24): the
// evals.yml inline subset planner and its two pins (cookie-behavior plans
// eight dependent cases; quality/behavior split the census) are deleted.
// Guarantee withdrawn: that one-off repair validation is complete; branch
// validation now dispatches evals.yml with evals_all (or eval:bg:pr).

test('curated Windows and native qualification use the same pinned Node runtime', () => {
  const windows = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/windows-free-tests.yml'), 'utf8')) as any;
  for (const job of ['windows-free-tests', 'cookie-native-qualification']) {
    const setup = windows.jobs[job].steps.find((step: any) => step.uses?.startsWith('actions/setup-node@'));
    expect(setup.with['node-version']).toBe('24.18.0');
    expect(setup.if).toBeUndefined();
  }
});

test('Windows retains complete shard logs on successful and failed runs', () => {
  const windows = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/windows-free-tests.yml'), 'utf8')) as any;
  const upload = windows.jobs['windows-free-tests'].steps.find((step: any) => step.with?.name === 'windows-free-test-shard-logs');
  expect(upload.if).toBe('always()');
  expect(upload.with.path.trim().split('\n')).toEqual([
    '.context/free-test-logs/gstack-free-test-*.log',
    '${{ runner.temp }}/gstack-free-test-*.log',
  ]);
  expect(upload.with['include-hidden-files']).toBe(true);
});

test('focused Windows diagnostics include the repaired lock and close cases without default-profile qualification', () => {
  const windows = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/windows-free-tests.yml'), 'utf8')) as any;
  const run = windows.jobs['windows-free-tests'].steps.find((step: any) => step.name === 'Run focused native launch and credential diagnostics').run;
  const pattern = run.match(/--test-name-pattern '([^']+)'/)?.[1];
  expect(pattern).toBeDefined();
  const selected = new RegExp(pattern);
  for (const name of ['native Windows launch diagnostics > observer', 'native Windows process qualification > a locked real Edge profile leaves its existing owner alive',
    'native Windows process qualification > real Edge synthetic profile: normal-close', 'native Windows process qualification > real Edge synthetic profile: stalled-close']) expect(selected.test(name)).toBe(true);
  expect(selected.test('native Windows process qualification > an exclusively created default Edge profile persists v20')).toBe(false);
});

test('Dia comparison uses separate pinned runtime jobs and retains diagnostic failures', () => {
  const windows = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/windows-free-tests.yml'), 'utf8')) as any;
  const job = windows.jobs['dia-native-qualification'];
  expect(job['runs-on']).toBe('macos-15');
  expect(job.strategy['fail-fast']).toBe(false);
  expect(job.strategy.matrix.runtime).toContain('["bun","node"]');
  expect(job.strategy.matrix.runtime).toContain('inputs.dia_launch_comparison');
  const node = job.steps.find((step: any) => step.uses?.startsWith('actions/setup-node@'));
  expect(node.with).toEqual({ 'node-version': '24.18.0', architecture: 'arm64' });
  const comparison = job.steps.find((step: any) => step.name === 'Compare protected native Dia launch without qualification credit');
  expect(comparison.run).toContain('--launch-comparison "$COMPARISON_RUNTIME"');
  expect(comparison['continue-on-error']).toBeUndefined();
  const upload = job.steps.find((step: any) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload.if).toBe('always()');
  expect(upload.with.name).toContain("format('dia-launch-comparison-{0}', matrix.runtime)");
  expect(windows.jobs['windows-free-tests'].if).toContain('!inputs.dia_launch_comparison');
  expect(windows.jobs['cookie-native-qualification'].if).toContain('!inputs.dia_launch_comparison');
});

test('Dia GUI readiness is an exclusive, single-job diagnostic without browser installation or launch', () => {
  const windows = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/windows-free-tests.yml'), 'utf8')) as any;
  const job = windows.jobs['dia-native-qualification'];
  const input = windows.on.workflow_dispatch.inputs.dia_gui_readiness;
  expect(input).toMatchObject({ type: 'boolean', default: false });
  expect(job.if).toContain('inputs.dia_gui_readiness');
  expect(job.strategy.matrix.runtime).toContain('inputs.dia_launch_comparison && !inputs.dia_gui_readiness');
  for (const name of ['windows-free-tests', 'cookie-native-qualification']) {
    expect(windows.jobs[name].if).toContain('!inputs.dia_gui_readiness');
  }
  const probe = job.steps.find((step: any) => step.name === 'Inspect GUI readiness without browser or Keychain access');
  expect(probe.if).toBe('inputs.dia_gui_readiness');
  expect(probe.run).toEndWith('.github/scripts/run-dia-native-qualification.ts --gui-readiness-only');
  expect(probe.env).toEqual({ GSTACK_DIA_NATIVE_QUALIFY: '1' });
  const excluded = job.steps.filter((step: any) => step.uses?.startsWith('actions/setup-node@')
    || ['Install pinned dependencies', 'Install the synthetic destination browser', 'Qualify native Dia discovery, decryption, and import',
      'Compare protected native Dia launch without qualification credit'].includes(step.name));
  expect(excluded).toHaveLength(5);
  for (const step of excluded) expect(step.if).toContain('!inputs.dia_gui_readiness');
  const upload = job.steps.find((step: any) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload.if).toBe('always()');
  expect(upload.with.name).toContain("inputs.dia_gui_readiness && 'dia-gui-readiness'");
  expect(upload.with.path).toBe('${{ runner.temp }}/dia-native-qualification.json');
});

test('the actual GUI readiness selection guard refuses conflicting or malformed mode inputs', () => {
  const windows = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/windows-free-tests.yml'), 'utf8')) as any;
  const steps = windows.jobs['dia-native-qualification'].steps;
  const guard = steps.find((step: any) => step.name === 'Validate GUI readiness selection');
  expect(guard.if).toBe('inputs.dia_gui_readiness');
  expect(guard.env.OTHER_DIA_MODES).toBe('${{ inputs.dia_native_only || inputs.dia_launch_comparison || inputs.native_diagnostics_only }}');
  expect(steps.indexOf(guard)).toBeLessThan(steps.findIndex((step: any) => step.name === 'Install pinned dependencies'));
  const script = guard.run.match(/ -e '\n([\s\S]*)\n'\s*$/)?.[1];
  expect(script).toBeDefined();
  for (const input of ['false', 'true', '', 'unknown']) {
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', script!], {
      cwd: root, env: { ...process.env, OTHER_DIA_MODES: input }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(input === 'false' ? 0 : 1);
    expect(result.stderr.includes('must be selected alone')).toBe(input !== 'false');
  }
});
