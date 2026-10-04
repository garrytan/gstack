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
    'test/skill-e2e-bws.test.ts', 'test/skill-e2e-deploy.test.ts#benchmark-workflow', 'test/skill-e2e-deploy.test.ts#canary-workflow',
    'test/skill-e2e-design.test.ts#design-review-detector-shim-dom', 'test/skill-e2e-diagram.test.ts', 'test/skill-e2e-qa-workflow.test.ts',
  ]);
  // The case-sharded design file runs only its one selected cookie case.
  expect(manifest.entries.filter(entry => entry.file.startsWith('test/skill-e2e-design.test.ts#') && entry.status === 'skipped-by-diff').length).toBeGreaterThan(0);
});

test('the existing quality and behavior phases retain their complete separate shard census', () => {
  const quality = manifestFor('quality');
  const behavior = manifestFor('behavior');
  const qualityFiles = quality.entries.filter(entry => entry.status === 'planned').map(entry => entry.file);
  const behaviorFiles = behavior.entries.filter(entry => entry.status === 'planned').map(entry => entry.file);
  expect(quality.evalsAll).toBe(true);
  expect(behavior.evalsAll).toBe(true);
  expect(qualityFiles).toHaveLength(1);
  // 44 files: first-task-scaffold registers no gate case, and six files whose
  // computed names hold only periodic cases (four plan, QA and routing files
  // plus the design-risk and iOS-demo safety-rule evals), so the gate lane skips
  // them; the eight case-sharded files contribute one shard per gate case.
  expect(new Set(behaviorFiles.map(file => file.split('#')[0])).size).toBe(44);
  expect(behaviorFiles).toHaveLength(76);
  expect(behaviorFiles).toEqual(expect.arrayContaining([
    ...['review-exploratory-small-cli', 'ship-exploratory-small-cli', 'ship-exploratory-unavailable',
      'ship-exploratory-plan-checks', 'ship-exploratory-late-input'].map(id => `test/skill-e2e-qa-callers.test.ts#${id}`),
    'test/skill-e2e-qa-functional-fix.test.ts',
    'test/skill-e2e-qa-functional.test.ts',
    'test/skill-e2e-ship-skip.test.ts',
  ]));
  expect(qualityFiles.every(file => file.startsWith('test/skill-llm-eval'))).toBe(true);
  expect(behaviorFiles.every(file => !qualityFiles.includes(file))).toBe(true);
});
