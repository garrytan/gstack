import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRegisteredRuntimeBinding, resolveRuntimeBinding } from '../lib/validator-runtime';
import { canRevokeReads } from './helpers/fs-caps';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function runtime() { const root = mkdtempSync(join(tmpdir(), 'validator-runtime-')); roots.push(root); mkdirSync(join(root, '.venv/bin'), { recursive: true }); mkdirSync(join(root, 'src')); const py = join(root, '.venv/bin/python'); writeFileSync(py, '#!/bin/sh\nexit 0\n'); chmodSync(py, 0o700); writeFileSync(join(root, 'requirements.lock'), 'pytest==8.4.0\n'); return { root, py }; }

describe('validator runtime binding', () => {
  test('selects one contained executable and owns protected environment values', () => {
    const { root, py } = runtime();
    const result = resolveRuntimeBinding({ repositoryRoot: root, interpreterRelpath: '.venv/bin/python', lockfiles: ['requirements.lock'], sourceRoots: ['src'], binding: { mode: 'env', name: 'PYTHON_BIN' }, argv: ['scripts/validate.sh'] });
    expect(result.interpreter).toBe(realpathSync(py)); expect(result.environment.PYTHON_BIN).toBe(result.wrapper); expect(result.environment.PYTEST_ADDOPTS).toBe('-p no:cacheprovider'); expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  test('rejects traversal, shell argv, reserved env names, and missing inputs before spawn', () => {
    const { root } = runtime();
    expect(() => resolveRuntimeBinding({ repositoryRoot: root, interpreterRelpath: '../python', lockfiles: ['requirements.lock'], sourceRoots: ['src'], binding: { mode: 'env', name: 'PYTHONPATH' }, argv: ['bash', '-lc', 'x'] })).toThrow();
    expect(() => resolveRuntimeBinding({ repositoryRoot: root, interpreterRelpath: '.venv/bin/python', lockfiles: ['missing.lock'], sourceRoots: ['src'], binding: { mode: 'argv0' }, argv: ['python'] })).toThrow('runtime_input_missing');
  });

  test.each(['directory', 'unreadable'] as const)('rejects %s registered runtime paths with a stable attestation error', (kind) => {
    if (kind === 'unreadable' && !canRevokeReads()) return;
    const { root, py } = runtime();
    const interpreter = realpathSync(kind === 'directory' ? root : py);
    if (kind === 'unreadable') chmodSync(interpreter, 0o100);
    const info = lstatSync(interpreter);
    const manifest = join(root, 'runtime.json');
    writeFileSync(manifest, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', execution_environment: { runtimes: { harness_test_python: { runtime_id: 'harness_test_python', realpath: interpreter, owner_uid: info.uid, mode: info.mode & 0o777, sha256: '0'.repeat(64), version: '3.11.0', purelib: root, platlib: root, packages: {} } } } }));
    try {
      expect(() => resolveRegisteredRuntimeBinding({ repositoryRoot: root, runtimeId: 'harness_test_python', manifestPath: manifest, sourceRoots: ['src'], binding: { mode: 'argv0' }, argv: ['python'] })).toThrow('registered_runtime_attestation_failed');
    } finally {
      if (kind === 'unreadable') chmodSync(interpreter, 0o700);
    }
  });

  test('accepts only an attested registered Python runtime and binds its library paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'registered-runtime-')); roots.push(root);
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'purelib')); mkdirSync(join(root, 'platlib'));
    // macOS's sealed-system Python and Git launchers can share an inode.
    // Bun 1.3.13 may resolve one to the other's path after an unrelated read.
    // Attest our own regular file, while still executing the real Python.
    const launcher = join(root, 'python');
    writeFileSync(launcher, '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', { mode: 0o700 });
    const interpreter = realpathSync(launcher);
    const info = lstatSync(interpreter);
    const sha256 = new Bun.CryptoHasher('sha256').update(readFileSync(interpreter)).digest('hex');
    const manifest = join(root, 'runtime.json');
    // Derive the version from the selected runtime so the fixture works with
    // the Python version installed on this host.
    const versionProbe = Bun.spawnSync(
      [interpreter, '-S', '-c', 'import platform;print(platform.python_version())'],
      { timeout: 10_000 },
    );
    expect(versionProbe.exitCode).toBe(0);
    const version = versionProbe.stdout.toString().trim();
    writeFileSync(manifest, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', execution_environment: { runtimes: { harness_test_python: { runtime_id: 'harness_test_python', realpath: interpreter, owner_uid: info.uid, mode: info.mode & 0o777, sha256, version, purelib: join(root, 'purelib'), platlib: join(root, 'platlib'), packages: {} } } } }));
    // Reproduce the system-stub cache pressure between registration and use.
    readFileSync('/usr/bin/git');
    const result = resolveRegisteredRuntimeBinding({ repositoryRoot: root, runtimeId: 'harness_test_python', manifestPath: manifest, sourceRoots: ['src'], binding: { mode: 'argv0' }, argv: ['python', '-m', 'unittest'] });
    expect(result.interpreter).toBe(interpreter);
    expect(result.argv[0]).toBe(result.wrapper);
    expect(result.environment.PYTHONPATH).toContain(join(root, 'src'));
    expect(result.environment.PYTHONPATH).toContain(join(root, 'purelib'));
    chmodSync(join(root, 'purelib'), 0o777);
    expect(() => resolveRegisteredRuntimeBinding({ repositoryRoot: root, runtimeId: 'harness_test_python', manifestPath: manifest, sourceRoots: ['src'], binding: { mode: 'argv0' }, argv: ['python'] })).toThrow('registered_runtime_attestation_failed');
    chmodSync(join(root, 'purelib'), 0o700);
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"packages":{}', '"packages":{"pytest":{"version":"9.0.3"}}'));
    expect(() => resolveRegisteredRuntimeBinding({ repositoryRoot: root, runtimeId: 'harness_test_python', manifestPath: manifest, sourceRoots: ['src'], binding: { mode: 'argv0' }, argv: ['python'] })).toThrow('registered_runtime_manifest_invalid');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"packages":{"pytest":{"version":"9.0.3"}}', '"packages":{}'));
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(sha256, '0'.repeat(64)));
    expect(() => resolveRegisteredRuntimeBinding({ repositoryRoot: root, runtimeId: 'harness_test_python', manifestPath: manifest, sourceRoots: ['src'], binding: { mode: 'argv0' }, argv: ['python'] })).toThrow('registered_runtime_attestation_failed');
  });
});
