import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRunManifest } from '../scripts/test-paid-shards';

const root = path.resolve(import.meta.dir, '..');
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookie-phase-')));
const workflow = Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/evals.yml'), 'utf8')) as any;
const command = workflow.jobs['plan-slices'].steps.find((step: any) => step.name === 'Emit validation-phase manifest').run;
const body = command.match(/^bun --no-install -e '\n([\s\S]*)\n'\s*$/)?.[1];
if (!body) throw new Error('Validation planner script was not found');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function manifestFor(phase: string) {
  const output = path.join(scratch, phase);
  const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-e', body!.replaceAll('/tmp/paid-plan', output.replaceAll('\\', '/'))], {
    cwd: root, env: { ...process.env, VALIDATION_PHASE: phase, EVALS_TIER: 'gate', EVALS_ALL: '1' }, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return parseRunManifest(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
}

test('the actual CI cookie repair planner executes only eight dependent cases without judges or run-all', () => {
  const manifest = manifestFor('cookie-behavior');
  expect(manifest.profile).toBe('full');
  expect(manifest.evalsAll).toBe(false);
  expect(manifest.selection).toEqual({ e2e: ['browse-basic', 'browse-snapshot', 'qa-quick', 'qa-only-no-fix', 'design-review-detector-shim-dom', 'diagram-triplet', 'canary-workflow', 'benchmark-workflow'], judges: [] });
  expect(manifest.entries.filter(entry => entry.status === 'planned').map(entry => entry.file).sort()).toEqual([
    'test/skill-e2e-bws.test.ts', 'test/skill-e2e-deploy.test.ts', 'test/skill-e2e-design.test.ts', 'test/skill-e2e-diagram.test.ts', 'test/skill-e2e-qa-workflow.test.ts',
  ]);
});

test('the existing quality and behavior phases retain their complete separate shard census', () => {
  const quality = manifestFor('quality');
  const behavior = manifestFor('behavior');
  const qualityFiles = quality.entries.filter(entry => entry.status === 'planned').map(entry => entry.file);
  const behaviorFiles = behavior.entries.filter(entry => entry.status === 'planned').map(entry => entry.file);
  expect(quality.evalsAll).toBe(true);
  expect(behavior.evalsAll).toBe(true);
  expect(qualityFiles).toHaveLength(2);
  expect(behaviorFiles).toHaveLength(52);
  expect(qualityFiles.every(file => file.startsWith('test/skill-llm-eval'))).toBe(true);
  expect(behaviorFiles.every(file => !qualityFiles.includes(file))).toBe(true);
});

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
  expect(upload.with.path).toBe('${{ runner.temp }}/gstack-free-test-*.log');
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
