import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
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
});
