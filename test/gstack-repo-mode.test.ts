/**
 * Project-slug consistency for gstack-repo-mode.
 *
 * These are end-to-end reproductions of #2212. Each case is a real local Git
 * workspace which predates its public GitHub origin: gstack-slug caches the
 * local directory name, then the origin is added. repo-mode must write its
 * cache next to that canonical project state, not beside a newly derived
 * owner-repo slug.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const REPO_MODE_BIN = path.join(ROOT, 'bin', 'gstack-repo-mode');
const SLUG_BIN = path.join(ROOT, 'bin', 'gstack-slug');

type CommandResult = { stdout: string; stderr: string; status: number };

function run(command: string, args: string[], cwd: string, home: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function git(args: string[], cwd: string, home: string) {
  const result = run('git', args, cwd, home);
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
}

function slugFrom(output: string): string {
  const line = output.split('\n').find((entry) => entry.startsWith('SLUG='));
  expect(line).toBeDefined();
  return line!.slice('SLUG='.length);
}

const publicWorkspaces = [
  { name: 'react-local-history', origin: 'https://github.com/facebook/react.git' },
  { name: 'next-local-history', origin: 'https://github.com/vercel/next.js.git' },
  { name: 'kubernetes-local-history', origin: 'https://github.com/kubernetes/kubernetes.git' },
];

describe('gstack-repo-mode cached slug consistency (#2212)', () => {
  for (const workspace of publicWorkspaces) {
    test(`${workspace.origin} keeps its pre-origin project cache`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-home-'));
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-workspaces-'));
      const project = path.join(root, workspace.name);

      try {
        fs.mkdirSync(project);
        git(['init', '-b', 'main'], project, home);
        git(['config', 'user.name', 'gstack regression test'], project, home);
        git(['config', 'user.email', 'test@gstack.dev'], project, home);

        // This workspace existed and used gstack before it adopted GitHub.
        const initialSlug = slugFrom(run(SLUG_BIN, [], project, home).stdout);
        expect(initialSlug).toBe(workspace.name);

        // Five commits make repo-mode perform its real classification path.
        for (let commit = 1; commit <= 5; commit += 1) {
          fs.writeFileSync(path.join(project, `commit-${commit}.txt`), String(commit));
          git(['add', '.'], project, home);
          git(['commit', '-m', `commit ${commit}`], project, home);
        }
        git(['remote', 'add', 'origin', workspace.origin], project, home);

        const mode = run(REPO_MODE_BIN, [], project, home);
        expect(mode.status, mode.stderr).toBe(0);
        expect(mode.stdout.trim()).toBe('REPO_MODE=solo');

        // Canonical slug stays the pre-origin basename; remote-derived twin must not appear.
        const projectsDir = path.join(home, '.gstack', 'projects');
        const canonicalCache = path.join(projectsDir, initialSlug, 'repo-mode.json');
        expect(fs.existsSync(canonicalCache)).toBe(true);
        expect(fs.readdirSync(projectsDir)).toEqual([initialSlug]);

        // Slug remains sanitized even when the remote URL would otherwise diverge.
        expect(initialSlug).toMatch(/^[a-zA-Z0-9._-]+$/);
        expect(slugFrom(run(SLUG_BIN, [], project, home).stdout)).toBe(initialSlug);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('still treats a workspace without origin as unknown', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-home-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-local-only-'));
    try {
      git(['init', '-b', 'main'], project, home);
      const mode = run(REPO_MODE_BIN, [], project, home);
      expect(mode.status, mode.stderr).toBe(0);
      expect(mode.stdout.trim()).toBe('REPO_MODE=unknown');
      expect(fs.existsSync(path.join(home, '.gstack', 'projects'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test('subdir invocation still writes under the git-root cached slug', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-subdir-'));
    const project = path.join(root, 'nested-history');
    const nested = path.join(project, 'packages', 'app');
    try {
      fs.mkdirSync(nested, { recursive: true });
      git(['init', '-b', 'main'], project, home);
      git(['config', 'user.name', 'gstack regression test'], project, home);
      git(['config', 'user.email', 'test@gstack.dev'], project, home);

      const initialSlug = slugFrom(run(SLUG_BIN, [], project, home).stdout);
      expect(initialSlug).toBe('nested-history');

      for (let commit = 1; commit <= 5; commit += 1) {
        fs.writeFileSync(path.join(project, `commit-${commit}.txt`), String(commit));
        git(['add', '.'], project, home);
        git(['commit', '-m', `commit ${commit}`], project, home);
      }
      git(['remote', 'add', 'origin', 'https://github.com/facebook/react.git'], project, home);

      const mode = run(REPO_MODE_BIN, [], nested, home);
      expect(mode.status, mode.stderr).toBe(0);
      expect(mode.stdout.trim()).toBe('REPO_MODE=solo');

      const projectsDir = path.join(home, '.gstack', 'projects');
      expect(fs.existsSync(path.join(projectsDir, initialSlug, 'repo-mode.json'))).toBe(true);
      expect(fs.readdirSync(projectsDir)).toEqual([initialSlug]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('sanitizes unusual origin URLs via gstack-slug before mkdir', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-home-'));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'grepo-weird-url-'));
    try {
      git(['init', '-b', 'main'], project, home);
      git(['config', 'user.name', 'gstack regression test'], project, home);
      git(['config', 'user.email', 'test@gstack.dev'], project, home);

      for (let commit = 1; commit <= 5; commit += 1) {
        fs.writeFileSync(path.join(project, `commit-${commit}.txt`), String(commit));
        git(['add', '.'], project, home);
        git(['commit', '-m', `commit ${commit}`], project, home);
      }
      // Free-form remote URL with characters outside [a-zA-Z0-9._-]
      git(['remote', 'add', 'origin', 'https://example.com/org/my repo (v2).git'], project, home);

      const mode = run(REPO_MODE_BIN, [], project, home);
      expect(mode.status, mode.stderr).toBe(0);
      expect(mode.stdout.trim()).toBe('REPO_MODE=solo');

      const projects = fs.readdirSync(path.join(home, '.gstack', 'projects'));
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatch(/^[a-zA-Z0-9._-]+$/);
      expect(projects[0]).not.toMatch(/[ ()]/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
