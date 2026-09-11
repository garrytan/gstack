import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { releaseRuntimeBinding, resolveRegisteredRuntimeBinding } from '../lib/validator-runtime';

const ROOT = path.resolve(import.meta.dir, '..');
const WRITER = path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-metadata-')); roots.push(root);
  const interpreter = fs.realpathSync(Bun.which('python3')!);
  const info = fs.statSync(interpreter);
  const probe = spawnSync(interpreter, ['-S', '-c', 'import platform;print(platform.python_version())'], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', PYTHONNOUSERSITE: '1' },
  });
  expect(probe.status, probe.stderr).toBe(0);
  fs.mkdirSync(path.join(root, 'purelib'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'platlib'), { mode: 0o700 });
  const runtimes = Object.fromEntries(['harness_test_python', 'cdo_preview_python'].map(runtime_id => [runtime_id, {
    runtime_id, realpath: interpreter, owner_uid: info.uid, mode: info.mode & 0o777,
    sha256: new Bun.CryptoHasher('sha256').update(fs.readFileSync(interpreter)).digest('hex'),
    version: probe.stdout.trim(), purelib: path.join(root, 'purelib'), platlib: path.join(root, 'platlib'), packages: {},
  }]));
  const manifest = path.join(root, '.ecpe-installed-runtime.json');
  const value = { schema: 'ecpe.gstack-runtime.v1', execution_environment: { runtimes } };
  fs.writeFileSync(manifest, JSON.stringify(value) + '\n', { mode: 0o600 });
  return { root, manifest, value };
}

describe.skipIf(process.platform === 'win32')('setup preserves registered validator runtimes', () => {
  test('routine manifest refresh preserves both registered Python validators and keeps them resolvable', () => {
    const f = fixture();
    const result = spawnSync(process.execPath, [WRITER, '--output', f.manifest], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.manifest, 'utf8')).execution_environment).toEqual(f.value.execution_environment);
    for (const runtimeId of ['harness_test_python', 'cdo_preview_python'] as const) {
      const binding = resolveRegisteredRuntimeBinding({
        repositoryRoot: f.root, runtimeId, manifestPath: f.manifest, sourceRoots: [], binding: { mode: 'argv0' }, argv: ['python', '--version'],
      });
      try { expect(binding.interpreter).toBe(f.value.execution_environment.runtimes[runtimeId].realpath); }
      finally { releaseRuntimeBinding(binding); }
    }
  });

  test('a staged source registry merges validated destination registrations with destination precedence', () => {
    const source = fixture(), destination = fixture();
    const sourceValue: any = source.value;
    const destinationValue: any = destination.value;
    delete destinationValue.execution_environment.runtimes.cdo_preview_python;
    fs.writeFileSync(destination.manifest, JSON.stringify(destinationValue) + '\n');
    const result = spawnSync(process.execPath, [WRITER, '--output', source.manifest,
      '--runtime-metadata-from', destination.manifest], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(source.manifest, 'utf8')).execution_environment.runtimes).toEqual({
      harness_test_python: destinationValue.execution_environment.runtimes.harness_test_python,
      cdo_preview_python: sourceValue.execution_environment.runtimes.cdo_preview_python,
    });
  });

  for (const invalid of ['digest', 'libraries', 'packages', 'unknown-runtime', 'malformed-runtimes', 'malformed-json'] as const) {
    test(`refuses to replace an existing manifest with ${invalid} runtime metadata`, () => {
      const f = fixture();
      const value: any = f.value;
      if (invalid === 'digest') value.execution_environment.runtimes.harness_test_python.sha256 = '0'.repeat(64);
      if (invalid === 'libraries') fs.chmodSync(path.join(f.root, 'purelib'), 0o777);
      if (invalid === 'packages') value.execution_environment.runtimes.harness_test_python.packages = { bad: { version: '1', fingerprint: 'unattested' } };
      if (invalid === 'unknown-runtime') value.execution_environment.runtimes.extra_python = value.execution_environment.runtimes.harness_test_python;
      if (invalid === 'malformed-runtimes') value.execution_environment.runtimes = [];
      const before = invalid === 'malformed-json' ? '{invalid\n' : JSON.stringify(value) + '\n';
      fs.writeFileSync(f.manifest, before);
      const result = spawnSync(process.execPath, [WRITER, '--output', f.manifest], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('registered_runtime_');
      expect(fs.readFileSync(f.manifest, 'utf8')).toBe(before);
    });
  }
});
