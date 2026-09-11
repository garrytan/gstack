import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTrustedLocalBase } from '../lib/project-identity';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], { timeout: 30_000,
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function localRepository(configureBase: boolean): { root: string; project: string; head: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-local-base-'));
  roots.push(root);
  const project = path.join(root, 'local');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "local"
path = "local"
kind = "repository"
remote_required = false
active = true
${configureBase ? 'trusted_base_ref = "refs/heads/main"' : ''}
`);
  return { root, project, head: git(project, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('review local-only trusted base', () => {
  test('freezes only the reviewed fully-qualified local ref and equality-checks target SHA', () => {
    const fixture = localRepository(true);
    expect(resolveTrustedLocalBase(fixture.project)).toEqual({
      registry_id: 'local',
      trusted_base_ref: 'refs/heads/main',
      target_sha: fixture.head,
    });
    expect(() => resolveTrustedLocalBase(fixture.project, '0'.repeat(40))).toThrow('local_trusted_base_target_mismatch');
  });

  test('never substitutes caller HEAD when trusted_base_ref is absent', () => {
    const fixture = localRepository(false);
    expect(() => resolveTrustedLocalBase(fixture.project, fixture.head)).toThrow('local_trusted_base_unconfigured');
  });
});
