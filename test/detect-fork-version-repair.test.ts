import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'detect-fork-version-repair.ts');

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if ((result.status ?? -1) !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function writeProject(
  cwd: string,
  options: {
    version: string;
    packageVersion?: string;
    forkRule?: boolean;
    changelog: string;
  },
) {
  writeFileSync(cwd + '/VERSION', `${options.version}\n`);
  writeFileSync(
    cwd + '/package.json',
    `${JSON.stringify({ name: 'gstack-test', version: options.packageVersion ?? options.version }, null, 2)}\n`,
  );
  writeFileSync(
    cwd + '/CLAUDE.md',
    options.forkRule === false
      ? '# gstack\n'
      : '# gstack\n\n## Fork versioning rule\n\nKeep fork-local skill releases out of top-level metadata.\n',
  );
  writeFileSync(cwd + '/CHANGELOG.md', options.changelog);
}

function releaseHeader(version: string) {
  return `## [${version}] - 2026-05-06\n\n### Changed\n\n- Entry for ${version}.\n\n`;
}

function changelog(versions: string[]) {
  return `# Changelog\n\n${versions.map(releaseHeader).join('')}`;
}

function setupRepo(options: {
  forkRule?: boolean;
  packageVersion?: string;
  prChangelog?: string;
}) {
  const repo = mkdtempSync(join(tmpdir(), 'fork-version-repair-test-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);

  writeProject(repo, {
    version: '1.26.7.0',
    changelog: changelog(['1.26.7.0', '1.26.6.0', '1.26.5.0', '1.26.4.0', '1.26.3.0']),
  });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  git(repo, ['checkout', '-b', 'repair']);
  writeProject(repo, {
    version: '1.26.3.0',
    packageVersion: options.packageVersion,
    forkRule: options.forkRule,
    changelog: options.prChangelog ?? changelog(['1.26.3.0']),
  });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'repair']);

  return repo;
}

function runDetector(repo: string) {
  const result = spawnSync('bun', ['run', SCRIPT, 'main', '1.26.7.0', '1.26.3.0'], {
    cwd: repo,
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? '').trim(),
    stderr: result.stderr ?? '',
  };
}

describe('detect-fork-version-repair', () => {
  test('current rollback shape returns true', () => {
    const repo = setupRepo({});
    try {
      const result = runDetector(repo);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('true');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('missing fork rule returns false', () => {
    const repo = setupRepo({ forkRule: false });
    try {
      const result = runDetector(repo);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('false');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('package version mismatch returns false', () => {
    const repo = setupRepo({ packageVersion: '1.26.4.0' });
    try {
      const result = runDetector(repo);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('false');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('changelog with added release header returns false', () => {
    const repo = setupRepo({
      prChangelog: changelog(['1.26.8.0', '1.26.3.0']),
    });
    try {
      const result = runDetector(repo);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('false');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
