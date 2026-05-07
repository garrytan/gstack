/**
 * gstack-artifacts-url — URL canonicalization helper.
 *
 * Centralizes HTTPS↔SSH conversion so callers don't each string-mangle. Per
 * codex Finding #10: store one canonical form (HTTPS) and derive all others.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const URL_BIN = path.join(ROOT, 'bin', 'gstack-artifacts-url');

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(URL_BIN, args, { encoding: 'utf-8' });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

describe('gstack-artifacts-url', () => {
  test('--to ssh from canonical https', () => {
    const r = run(['--to', 'ssh', 'https://github.com/garrytan/gstack-artifacts-garrytan']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('git@github.com:garrytan/gstack-artifacts-garrytan.git');
  });

  test('--to ssh from https-with-.git', () => {
    const r = run(['--to', 'ssh', 'https://github.com/garrytan/gstack-artifacts-garrytan.git']);
    expect(r.stdout).toBe('git@github.com:garrytan/gstack-artifacts-garrytan.git');
  });

  test('--to https is idempotent on https input', () => {
    const r = run(['--to', 'https', 'https://github.com/garrytan/gstack-artifacts-garrytan']);
    expect(r.stdout).toBe('https://github.com/garrytan/gstack-artifacts-garrytan');
  });

  test('--to https from git@host:owner/repo.git', () => {
    const r = run(['--to', 'https', 'git@github.com:garrytan/gstack-artifacts-garrytan.git']);
    expect(r.stdout).toBe('https://github.com/garrytan/gstack-artifacts-garrytan');
  });

  test('--to https from ssh:// scheme (gitlab self-hosted style)', () => {
    const r = run(['--to', 'https', 'ssh://git@gitlab.example.org/team/gstack-artifacts-team.git']);
    expect(r.stdout).toBe('https://gitlab.example.org/team/gstack-artifacts-team');
  });

  test('--host extracts hostname from any form', () => {
    expect(run(['--host', 'https://github.com/x/y']).stdout).toBe('github.com');
    expect(run(['--host', 'git@gitlab.com:x/y.git']).stdout).toBe('gitlab.com');
    expect(run(['--host', 'ssh://git@gitlab.example.org/x/y.git']).stdout).toBe('gitlab.example.org');
  });

  test('--owner-repo extracts the path segment', () => {
    expect(run(['--owner-repo', 'https://github.com/garrytan/gstack-artifacts-garrytan']).stdout)
      .toBe('garrytan/gstack-artifacts-garrytan');
    expect(run(['--owner-repo', 'git@github.com:team/gstack-artifacts-team.git']).stdout)
      .toBe('team/gstack-artifacts-team');
  });

  test('rejects unrecognized URL form with exit 3', () => {
    const r = run(['--to', 'ssh', 'not a url']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('unrecognized URL form');
  });

  test('rejects missing args with exit 2', () => {
    expect(run([]).code).toBe(2);
    expect(run(['--to']).code).toBe(2);
    expect(run(['--to', 'ssh']).code).toBe(2);
  });

  test('rejects unknown --to target', () => {
    const r = run(['--to', 'svn', 'https://github.com/x/y']);
    expect(r.code).toBe(2);
  });

  test('round-trip: https → ssh → https is identity', () => {
    const original = 'https://github.com/garrytan/gstack-artifacts-garrytan';
    const ssh = run(['--to', 'ssh', original]).stdout;
    const back = run(['--to', 'https', ssh]).stdout;
    expect(back).toBe(original);
  });
});
