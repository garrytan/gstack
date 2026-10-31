/**
 * /health Step 1 moved onto gstack-checks detect --for health (GST-116 PR 2). The acceptance bar: every check the old
 * Step 1 found is still found. The old shell block is frozen verbatim in test/fixtures/health-detect-legacy.sh; each
 * fixture repo runs both under the same PATH and HOME, and every legacy (category, command) pair must appear in the
 * detector's DIMENSION lines.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HEALTH_DIMENSIONS, healthDimensions } from '../lib/checks';
import { runScriptSync } from '../lib/script-invocation';
import { BIN } from './helpers/pregate-fixture';

const LEGACY = path.join(import.meta.dir, 'fixtures', 'health-detect-legacy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-detect-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stubs = path.join(tmp, 'stubs');
fs.mkdirSync(stubs);
for (const tool of ['knip', 'shellcheck', 'gbrain']) {
  fs.writeFileSync(path.join(stubs, tool), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(stubs, tool), 0o755);
}
const gbrainHome = path.join(tmp, 'home-gbrain');
fs.mkdirSync(path.join(gbrainHome, '.gbrain'), { recursive: true });
fs.writeFileSync(path.join(gbrainHome, '.gbrain', 'config.json'), '{}\n');
const bareHome = path.join(tmp, 'home-bare');
fs.mkdirSync(bareHome);

const PKG = JSON.stringify({ name: 'fx', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { knip: '^5.0.0' } });
const FIXTURES: Record<string, Record<string, string>> = {
  empty: {},
  tsconfig: { 'tsconfig.json': '{}' },
  'biome-json': { 'biome.json': '{}' },
  'biome-jsonc': { 'biome.jsonc': '{}' },
  'eslint-flat': { 'eslint.config.mjs': 'export default [];' },
  'eslintrc-json': { '.eslintrc.json': '{}' },
  'eslintrc-bare': { '.eslintrc': '{}' },
  'pyproject-ruff-pytest': { 'pyproject.toml': '[tool.ruff]\n[tool.pytest.ini_options]\n' },
  'pyproject-pylint': { 'pyproject.toml': '[tool.pylint]\n' },
  'pylintrc-only': { '.pylintrc': '[MASTER]\n' },
  'package-test-knip': { 'package.json': PKG },
  cargo: { 'Cargo.toml': '[package]\nname = "fx"\n' },
  go: { 'go.mod': 'module fx\n' },
  'shell-scripts-dir': { 'scripts/build.sh': 'echo hi\n' },
  'shell-root-and-bin': { 'run.sh': 'echo hi\n', 'bin/tool.sh': 'echo hi\n' },
  everything: { 'tsconfig.json': '{}', 'biome.json': '{}', 'eslint.config.js': '', 'pyproject.toml': 'ruff pytest\n', 'package.json': PKG, 'Cargo.toml': '', 'go.mod': 'module fx\n', 'scripts/a.sh': '' },
};

function repo(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, 'repos', name);
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const NORMALIZE: Record<string, string> = { 'gbrain doctor --json (wrapped in timeout 5s)': 'timeout 5s gbrain doctor --json' };
const pairs = (lines: Array<[string, string]>) => lines.map(([d, c]) => `${d}: ${c}`).sort();

function legacy(dir: string, env: NodeJS.ProcessEnv): string[] {
  const r = spawnSync('bash', [LEGACY], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
  expect(r.status).toBe(0);
  return pairs(r.stdout.split('\n').flatMap(line => {
    const m = /^(TYPECHECK|LINT|TEST|DEADCODE|SHELL|GBRAIN): (.+)$/.exec(line);
    return m ? [[m[1].toLowerCase(), NORMALIZE[m[2]] ?? m[2]] as [string, string]] : [];
  }));
}

function detector(dir: string, env: NodeJS.ProcessEnv): { found: string[]; none: string[] } {
  const r = runScriptSync(BIN('gstack-checks'), ['detect', '--for', 'health'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  expect(r.status).toBe(0);
  const lines = (r.stdout ?? '').split('\n').filter(Boolean).map(line => /^DIMENSION (\S+) (.+?)  \((.*)\)$/.exec(line)!);
  expect(lines.every(Boolean)).toBe(true);
  return { found: pairs(lines.filter(m => m[2] !== 'none').map(m => [m[1], m[2]])), none: lines.filter(m => m[2] === 'none').map(m => m[1]) };
}

const ENVS = {
  'tools on PATH, gbrain configured': { PATH: `${stubs}${path.delimiter}${process.env.PATH}`, HOME: gbrainHome },
  'machine PATH, no gbrain config': { PATH: process.env.PATH, HOME: bareHome },
};

describe('/health detection: no check lost (GST-116 PR 2)', () => {
  // Value: protects=/health still finds every tool its old Step 1 shell block found; fails_when=a ported rule drops a
  //   category or command (knip, shellcheck, gbrain, a lint or test rule) for any fixture; why_new=/health moved onto the
  //   detector in this change; seam=the frozen legacy block run beside the bin; no_claim=that the found tools succeed
  for (const [envName, envVars] of Object.entries(ENVS)) {
    test(`every legacy line is found: ${envName}`, () => {
      const env = { ...process.env, ...envVars };
      let legacyTotal = 0;
      for (const [name, files] of Object.entries(FIXTURES)) {
        const dir = repo(name, files);
        const old = legacy(dir, env);
        const now = detector(dir, env);
        legacyTotal += old.length;
        expect({ name, lost: old.filter(p => !now.found.includes(p)) }).toEqual({ name, lost: [] });
        expect(new Set([...now.found.map(p => p.split(':')[0]), ...now.none])).toEqual(new Set(HEALTH_DIMENSIONS));
      }
      expect(legacyTotal).toBeGreaterThan(20);
    });
  }

  // Value: protects=the matrix exercises knip, shellcheck and gbrain, not just the manifest rules; fails_when=a stub stops
  //   being found so the no-loss comparison above runs with those categories empty; why_new=new fixture; seam=none
  test('the stubbed run covers every category on both sides', () => {
    const env = { ...process.env, ...ENVS['tools on PATH, gbrain configured'] };
    const dir = repo('everything', FIXTURES.everything);
    expect(new Set(legacy(dir, env).map(p => p.split(':')[0]))).toEqual(new Set(HEALTH_DIMENSIONS));
    expect(detector(dir, env).none).toEqual([]);
  });

  // Value: protects=a Health Stack section wins row for row, test rows included, and nothing is auto-detected beside it;
  //   fails_when=health mode drops the test row /verify leaves to pregate, or mixes manifest detection in; why_new=keepTests
  //   is new; seam=none
  test('a Health Stack section is returned as written', () => {
    const dir = repo('health-stack', { 'tsconfig.json': '{}', 'CLAUDE.md': '# x\n\n## Health Stack\n\n- typecheck: tsc --noEmit -p app\n- test: bun test\n- deadcode: knip --production\n- shell: shellcheck *.sh scripts/*.sh\n\n## Other\n' });
    const d = healthDimensions(dir, { PATH: stubs, HOME: gbrainHome });
    expect(d.checks.map(c => [c.dimension, c.command])).toEqual([['typecheck', 'tsc --noEmit -p app'], ['test', 'bun test'], ['deadcode', 'knip --production'], ['shell', 'shellcheck *.sh scripts/*.sh']]);
    expect(d.missing).toEqual([{ dimension: 'lint', reason: 'not in the CLAUDE.md Health Stack section' }, { dimension: 'gbrain', reason: 'not in the CLAUDE.md Health Stack section' }]);
  });

  // Value: protects=a 'tests' row and repeated keys count as present, so Step 2 never skips a category it runs;
  //   fails_when=the -N suffix or tests→test normalization regresses and a listed category also prints none; why_new=new; seam=none
  test('a tests row and repeated keys are not reported missing', () => {
    const dir = repo('health-stack-dupes', { 'CLAUDE.md': '## Health Stack\n\n- tests: bun test\n- lint: eslint .\n- lint: biome check .\n' });
    const d = healthDimensions(dir, { PATH: '', HOME: bareHome });
    expect(d.checks.map(c => c.dimension)).toEqual(['tests', 'lint', 'lint-2']);
    expect(d.missing.map(m => m.dimension)).toEqual(['typecheck', 'deadcode', 'shell', 'gbrain']);
  });

  // Value: protects=--for is accepted only as detect --for health; fails_when=run --for health falls through into the run
  //   path, or a missing or unknown mode is accepted; why_new=new flag; seam=the bin
  test('--for is refused outside detect --for health', () => {
    for (const args of [['run', '--for', 'health'], ['detect', '--for'], ['detect', '--for', 'verify']]) {
      const r = runScriptSync(BIN('gstack-checks'), args, { cwd: tmp, encoding: 'utf8', timeout: 30_000 });
      expect(r.status).toBe(64);
      expect(r.stderr ?? '').toContain('Usage: gstack-checks');
    }
  });

  // Value: protects=a Health Stack keeps shell syntax, an empty section still turns auto-detection off, and detection runs
  //   where /health runs (a monorepo package); fails_when=backticks inside a command are stripped (a failing checker becomes
  //   a lookup), a section with no rows falls through to auto-detection, or the bin detects from the git top-level;
  //   why_new=review pass 1 outside voice; seam=the bin from a subdirectory
  test('Health Stack bytes, an empty section, and the working directory', () => {
    const tick = String.fromCharCode(96);
    const subst = healthDimensions(repo('hs-subst', { 'CLAUDE.md': `## Health Stack\n\n- test: test "$(${tick}command -v false${tick})" = x\n- lint: ${tick}eslint .${tick}\n` }), { PATH: '', HOME: bareHome });
    expect(subst.checks.map(c => c.command)).toEqual([`test "$(${tick}command -v false${tick})" = x`, 'eslint .']);
    const empty = healthDimensions(repo('hs-empty', { 'tsconfig.json': '{}', 'CLAUDE.md': '## Health Stack\n\nNo health tools are configured.\n' }), { PATH: stubs, HOME: gbrainHome });
    expect(empty.checks).toEqual([]);
    expect(empty.missing.map(m => m.dimension)).toEqual([...HEALTH_DIMENSIONS]);
    const mono = repo('monorepo', { 'tsconfig.json': '{}', 'packages/app/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
    expect(spawnSync('git', ['init', '-q'], { cwd: mono, timeout: 30_000 }).status).toBe(0);
    const env = { ...process.env, PATH: process.env.PATH, HOME: bareHome };
    const pkg = detector(path.join(mono, 'packages', 'app'), env);
    expect(pkg.found).toContain('test: vitest run');
    expect(pkg.none).toContain('typecheck');
    const noHome = repo('no-home', { '.gbrain/config.json': '{}' });
    expect(healthDimensions(noHome, { PATH: stubs, HOME: '' }).checks.map(c => c.dimension)).not.toContain('gbrain');
  });

  // Value: protects=an unavailable category says why, so Step 2 records SKIPPED with a reason; fails_when=a none line
  //   loses its reason or shellcheck's two causes collapse; why_new=new output; seam=none
  test('none lines name the reason', () => {
    const empty = healthDimensions(repo('empty', {}), { PATH: '', HOME: bareHome });
    expect(empty.checks).toEqual([]);
    expect(empty.missing.find(m => m.dimension === 'shell')?.reason).toBe('shellcheck is not on PATH');
    const noScripts = healthDimensions(repo('tsconfig', FIXTURES.tsconfig), { PATH: stubs, HOME: bareHome });
    expect(noScripts.missing.find(m => m.dimension === 'shell')?.reason).toBe('no *.sh file in the root, scripts/ or bin/');
    expect(noScripts.missing.find(m => m.dimension === 'gbrain')?.reason).toBe('gbrain is not on PATH or ~/.gbrain/config.json is absent');
  });
});
