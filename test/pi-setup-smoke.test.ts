import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

function expectExists(filePath: string) {
  expect(existsSync(filePath), filePath).toBe(true);
}

describe('Pi setup smoke', () => {
  test('installs generated skills, runtime sidecars, and extension into an isolated HOME', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'gstack-pi-home-'));
    try {
      const result = Bun.spawnSync(['./setup', '--host', 'pi', '--quiet'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          HOME: home,
          CI: '1',
        },
      });

      const stderr = result.stderr.toString();
      const stdout = result.stdout.toString();
      expect(result.exitCode, `${stderr}\n${stdout}`).toBe(0);

      const piAgent = path.join(home, '.pi', 'agent');
      expectExists(path.join(piAgent, 'skills', 'gstack-review', 'SKILL.md'));
      expectExists(path.join(piAgent, 'skills', 'gstack-qa', 'SKILL.md'));
      expectExists(path.join(piAgent, 'skills', 'gstack-ship', 'SKILL.md'));
      expectExists(path.join(piAgent, 'skills', 'gstack', 'browse', 'dist', 'browse'));
      expectExists(path.join(piAgent, 'skills', 'gstack', 'review', 'checklist.md'));
      expectExists(path.join(piAgent, 'extensions', 'gstack', 'index.ts'));

      const extension = lstatSync(path.join(piAgent, 'extensions', 'gstack'));
      expect(extension.isSymbolicLink() || extension.isDirectory()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('preserves pre-existing unmanaged Pi runtime roots', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'gstack-pi-home-'));
    try {
      const unmanagedRoot = path.join(home, '.pi', 'agent', 'skills', 'gstack');
      const sentinel = path.join(unmanagedRoot, 'SKILL.md');
      mkdirSync(unmanagedRoot, { recursive: true });
      writeFileSync(sentinel, 'user-managed runtime root\n');

      const result = Bun.spawnSync(['./setup', '--host', 'pi', '--quiet'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          HOME: home,
          CI: '1',
        },
      });

      const stderr = result.stderr.toString();
      const stdout = result.stdout.toString();
      expect(result.exitCode, `${stderr}\n${stdout}`).toBe(0);
      expect(stderr).toContain('preserving existing unmanaged Pi runtime root');
      expect(readFileSync(sentinel, 'utf-8')).toBe('user-managed runtime root\n');
      expectExists(path.join(home, '.pi', 'agent', 'skills', 'gstack-review', 'SKILL.md'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('preserves pre-existing unmanaged symlinked Pi runtime roots', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'gstack-pi-home-'));
    const customRoot = mkdtempSync(path.join(tmpdir(), 'gstack-pi-custom-'));
    try {
      const piSkills = path.join(home, '.pi', 'agent', 'skills');
      const runtimeLink = path.join(piSkills, 'gstack');
      const sentinel = path.join(customRoot, 'SKILL.md');
      mkdirSync(piSkills, { recursive: true });
      writeFileSync(sentinel, 'custom symlink runtime root\n');
      symlinkSync(customRoot, runtimeLink);

      const result = Bun.spawnSync(['./setup', '--host', 'pi', '--quiet'], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          HOME: home,
          CI: '1',
        },
      });

      const stderr = result.stderr.toString();
      const stdout = result.stdout.toString();
      expect(result.exitCode, `${stderr}\n${stdout}`).toBe(0);
      expect(stderr).toContain('preserving existing unmanaged Pi runtime root');
      expect(lstatSync(runtimeLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(sentinel, 'utf-8')).toBe('custom symlink runtime root\n');
      expectExists(path.join(home, '.pi', 'agent', 'skills', 'gstack-review', 'SKILL.md'));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(customRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
