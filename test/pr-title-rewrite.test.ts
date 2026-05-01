import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const HELPER = path.join(import.meta.dir, '..', 'bin', 'gstack-pr-title-rewrite.sh');

function rewrite(version: string, title: string): { stdout: string; status: number; stderr: string } {
  const r = spawnSync(HELPER, [version, title], { encoding: 'utf-8' });
  return { stdout: (r.stdout ?? '').trimEnd(), status: r.status ?? -1, stderr: r.stderr ?? '' };
}

describe('gstack-pr-title-rewrite', () => {
  test('already correct: no change', () => {
    const r = rewrite('1.2.3.4', 'v1.2.3.4 feat: foo');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('v1.2.3.4 feat: foo');
  });

  test('different version prefix: replaces it', () => {
    expect(rewrite('1.2.3.5', 'v1.2.3.4 feat: foo').stdout).toBe('v1.2.3.5 feat: foo');
  });

  test('different prefix length (3-part vs 4-part): replaces it', () => {
    expect(rewrite('1.2.3.4', 'v1.2.3 feat: foo').stdout).toBe('v1.2.3.4 feat: foo');
  });

  test('no version prefix: prepends', () => {
    expect(rewrite('1.2.3.4', 'feat: foo').stdout).toBe('v1.2.3.4 feat: foo');
  });

  test('does not mistake plain words for a prefix', () => {
    expect(rewrite('1.2.3.4', 'version 5 feature').stdout).toBe('v1.2.3.4 version 5 feature');
  });

  test('does not strip a single-segment prefix like v1', () => {
    expect(rewrite('1.2.3.4', 'v1 feat: foo').stdout).toBe('v1.2.3.4 v1 feat: foo');
  });

  test('errors on missing args', () => {
    const r = spawnSync(HELPER, ['1.2.3.4'], { encoding: 'utf-8' });
    expect(r.status).not.toBe(0);
  });

  test('rejects malformed VERSION with shell metacharacters', () => {
    expect(rewrite('1.*.*.*', 'feat: foo').status).toBe(2);
    expect(rewrite('1.2.3.4; rm -rf /', 'feat: foo').status).toBe(2);
  });

  test('idempotent: applying twice yields the same result', () => {
    const once = rewrite('1.2.3.4', 'feat: foo').stdout;
    const twice = rewrite('1.2.3.4', once).stdout;
    expect(twice).toBe(once);
  });
});
