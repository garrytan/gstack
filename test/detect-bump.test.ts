/**
 * scripts/detect-bump.ts — VERSION-pair → bump level, used by CI's version-gate.
 *
 * Zero coverage before this file even though CI depends on it: the gate re-runs
 * the version util with the level detect-bump reports, so a wrong answer here
 * makes the gate compare against a version /ship never produced and fails the
 * PR with a confusing diff. The module is a CLI with no exports, so it is
 * exercised through spawn (same pattern as design-flag-utils' wrapper tests).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'detect-bump.ts');

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', [SCRIPT, ...args], { encoding: 'utf-8', cwd: ROOT });
  return { status: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '' };
}

describe('detect-bump levels', () => {
  test('first differing slot is the level', () => {
    expect(run('1.61.0.0', '2.0.0.0').stdout).toBe('major');
    expect(run('1.61.0.0', '1.62.0.0').stdout).toBe('minor');
    expect(run('1.61.0.0', '1.61.1.0').stdout).toBe('patch');
    expect(run('1.61.0.0', '1.61.0.1').stdout).toBe('micro');
  });

  test('a higher differing slot outranks lower ones', () => {
    // Every slot differs → major, not micro.
    expect(run('1.1.1.1', '2.2.2.2').stdout).toBe('major');
    expect(run('1.1.1.1', '1.2.2.2').stdout).toBe('minor');
    expect(run('1.1.1.1', '1.1.2.2').stdout).toBe('patch');
  });

  test('direction-agnostic — a downgrade reports the same level', () => {
    expect(run('2.0.0.0', '1.61.0.0').stdout).toBe('major');
    expect(run('1.61.0.1', '1.61.0.0').stdout).toBe('micro');
  });

  test('identical versions default to patch', () => {
    expect(run('1.61.0.0', '1.61.0.0').stdout).toBe('patch');
  });

  test('surrounding whitespace is tolerated (VERSION files end in a newline)', () => {
    expect(run(' 1.61.0.0\n', '1.62.0.0 ').stdout).toBe('minor');
  });

  test('numeric comparison is slot-wise, not lexical', () => {
    expect(run('1.9.0.0', '1.10.0.0').stdout).toBe('minor');
    expect(run('1.61.9.0', '1.61.10.0').stdout).toBe('patch');
  });

  test('malformed versions fall back to patch rather than failing the gate', () => {
    expect(run('1.61.0', '1.62.0').stdout).toBe('patch');
    expect(run('1.61.0.0', 'v1.62.0.0').stdout).toBe('patch');
    expect(run('not-a-version', '1.61.0.0').stdout).toBe('patch');
  });

  test('exits 0 on success with a single bare word on stdout', () => {
    const r = run('1.61.0.0', '1.61.1.0');
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toEqual(['patch']);
  });
});

describe('detect-bump usage errors', () => {
  test('missing both args exits 2 with usage on stderr', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: detect-bump');
    expect(r.stdout).toBe('');
  });

  test('missing the target arg exits 2', () => {
    expect(run('1.61.0.0').status).toBe(2);
  });

  test('empty-string args exit 2 instead of printing a bogus level', () => {
    expect(run('', '1.61.0.0').status).toBe(2);
    expect(run('1.61.0.0', '').status).toBe(2);
  });
});
