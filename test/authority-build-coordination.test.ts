import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const FAULTS = path.join(import.meta.dir, 'helpers/authority-build-fs-faults.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-build-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(ROOT, 'scripts/build-authority-bundles.ts'), path.join(root, 'scripts/build-authority-bundles.ts'));
  fs.symlinkSync(path.join(ROOT, 'scripts/authority'), path.join(root, 'scripts/authority'));
  fs.symlinkSync(path.join(ROOT, 'lib'), path.join(root, 'lib'));
  for (const name of ['gstack-next-version', 'gstack-pr-title-rewrite', 'gstack-version-bump']) {
    fs.symlinkSync(path.join(ROOT, 'bin', name), path.join(root, 'bin', name));
  }
  return root;
}

function run(root: string, env: Record<string, string> = {}, timeout = 30_000) {
  return Bun.spawnSync([process.execPath, '--preload', FAULTS, 'scripts/build-authority-bundles.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
    timeout,
  });
}

function seedAuthority(root: string, value = 'previous-authority'): void {
  const authority = path.join(root, 'dist/authority');
  fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'sentinel'), value);
}

describe('authority bundle build coordination', () => {
  test('retains crash-recoverable build locking on native Windows', () => {
    const root = fixture();
    const result = run(root, { GSTACK_TEST_AUTHORITY_NATIVE_WINDOWS: '1' });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(fs.existsSync(path.join(root, 'dist/authority/manifest.json'))).toBe(true);
  });

  test('recovers a stale owner record left by a crashed builder', async () => {
    const root = fixture();
    const lock = path.join(root, 'dist/.authority-build.lock');
    const child = Bun.spawn([process.execPath, '--preload', FAULTS, 'scripts/build-authority-bundles.ts'], {
      cwd: root,
      env: { ...process.env, GSTACK_TEST_AUTHORITY_SWAP_DELAY_MS: '1000' },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(lock) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.existsSync(lock)).toBe(true);
    child.kill('SIGKILL');
    await child.exited;

    const recovered = run(root, {}, 5_000);
    expect(recovered.exitCode, recovered.stderr.toString()).toBe(0);
    expect(fs.existsSync(path.join(root, 'dist/authority/manifest.json'))).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  }, 15_000);

  test('publishes a parseable owner record and does not steal a live build', async () => {
    const root = fixture();
    const lock = path.join(root, 'dist/.authority-build.lock');
    const first = Bun.spawn([process.execPath, '--preload', FAULTS, 'scripts/build-authority-bundles.ts'], {
      cwd: root,
      env: { ...process.env, GSTACK_TEST_AUTHORITY_SWAP_DELAY_MS: '750' },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(lock) && Date.now() < deadline) await Bun.sleep(10);
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    expect(owner).toMatchObject({ schema: 'ecpe.authority-build-lock.v1', pid: first.pid });
    expect(owner.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(owner.created_at).toISOString()).toBe(owner.created_at);

    const second = Bun.spawn([process.execPath, '--preload', FAULTS, 'scripts/build-authority-bundles.ts'], {
      cwd: root,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  }, 15_000);

  test('restores the previous authority when installing the staged directory fails', () => {
    const root = fixture();
    seedAuthority(root);
    const failed = run(root, { GSTACK_TEST_FAIL_AUTHORITY_INSTALL_RENAME: '1' });

    expect(failed.exitCode).not.toBe(0);
    expect(fs.readFileSync(path.join(root, 'dist/authority/sentinel'), 'utf8')).toBe('previous-authority');
    expect(fs.readdirSync(path.join(root, 'dist')).filter((name) => name.startsWith('.authority-retired-'))).toEqual([]);
  });

  test('retains the previous authority backup when both install and rollback renames fail', () => {
    const root = fixture();
    seedAuthority(root);
    const failed = run(root, {
      GSTACK_TEST_FAIL_AUTHORITY_INSTALL_RENAME: '1',
      GSTACK_TEST_FAIL_AUTHORITY_ROLLBACK_RENAME: '1',
    });

    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr.toString()).toContain('authority_bundle_swap_rollback_failed:backup_retained:');
    const backups = fs.readdirSync(path.join(root, 'dist')).filter((name) => name.startsWith('.authority-retired-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'dist', backups[0], 'sentinel'), 'utf8')).toBe('previous-authority');
  });
});
