import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const repo = path.resolve(import.meta.dir, '..');
const bin = path.join(repo, 'bin', 'gstack-canary-monitor');

describe('gstack-canary-monitor', () => {
  test('prints help', () => {
    const r = spawnSync(bin, ['--help'], { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: gstack-canary-monitor');
  });

  test('prints deterministic plan without browse', () => {
    const r = spawnSync(bin, ['https://example.com', '--duration', '5m', '--pages', '/,/docs', '--plan'], { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.url).toBe('https://example.com');
    expect(plan.mode).toBe('monitor');
    expect(plan.duration_s).toBe(300);
    expect(plan.pages_raw).toBe('/,/docs');
  });

  test('rejects invalid duration', () => {
    const r = spawnSync(bin, ['https://example.com', '--duration', '31m', '--plan'], { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('duration must be 1m..30m');
  });
});
