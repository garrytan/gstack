import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyRepoWithoutGit(dest: string): void {
  fs.cpSync(ROOT, dest, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return top !== '.git' && top !== 'node_modules' && top !== '.agents';
    },
  });

  const nodeModulesSrc = path.join(ROOT, 'node_modules');
  const nodeModulesDest = path.join(dest, 'node_modules');
  fs.symlinkSync(
    nodeModulesSrc,
    nodeModulesDest,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

function runSetup(cwd: string, homeDir: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', ['./setup', '--host', 'codex'], {
    cwd,
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf-8',
    timeout: 120_000,
  });
}

describe('setup --host codex smoke', () => {
  test('global install creates Codex runtime root and generated skills', () => {
    const repoDir = makeTempDir('gstack-codex-global-repo-');
    const homeDir = makeTempDir('gstack-codex-global-home-');

    try {
      copyRepoWithoutGit(repoDir);
      const result = runSetup(repoDir, homeDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('gstack ready (codex).');

      const runtimeRoot = path.join(homeDir, '.codex', 'skills', 'gstack');
      const reviewSkill = path.join(homeDir, '.codex', 'skills', 'gstack-review', 'SKILL.md');

      expect(fs.existsSync(path.join(runtimeRoot, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(runtimeRoot, 'browse', 'dist'))).toBe(true);
      expect(fs.existsSync(path.join(reviewSkill))).toBe(true);
      expect(fs.lstatSync(path.join(homeDir, '.codex', 'skills', 'gstack-review')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120_000);

  test('repo-local install writes generated skills next to .agents checkout only', () => {
    const projectDir = makeTempDir('gstack-codex-local-project-');
    const homeDir = makeTempDir('gstack-codex-local-home-');
    const repoDir = path.join(projectDir, '.agents', 'skills', 'gstack');

    try {
      fs.mkdirSync(path.dirname(repoDir), { recursive: true });
      copyRepoWithoutGit(repoDir);
      const result = runSetup(repoDir, homeDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('gstack ready (codex).');

      const localSkill = path.join(projectDir, '.agents', 'skills', 'gstack-review', 'SKILL.md');
      const localSidecar = path.join(projectDir, '.agents', 'skills', 'gstack', 'bin');
      const globalSkill = path.join(homeDir, '.codex', 'skills', 'gstack-review');

      expect(fs.existsSync(localSkill)).toBe(true);
      expect(fs.existsSync(localSidecar)).toBe(true);
      expect(fs.existsSync(globalSkill)).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }, 120_000);
});
