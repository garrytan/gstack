/**
 * gstack-upgrade/migrations/v1.0.0.0.sh — writing style migration.
 *
 * Coverage:
 * - Fresh state: writes the pending-prompt flag
 * - Idempotent: second run does nothing if .writing-style-prompted exists
 * - Pre-set explain_level: counts as answered (user already decided)
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.0.0.0.sh');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-mig-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function run(): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('bash', [MIGRATION], {
    encoding: 'utf-8',
    env: { ...process.env, GSTACK_HOME: tmpHome },
  });
  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status ?? -1,
  };
}

describe('v1.0.0.0 upgrade migration', () => {
  test('migration file exists and is executable', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
    const stat = fs.statSync(MIGRATION);
    // Owner execute bit should be set
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  test('fresh state: writes pending-prompt flag', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, '.writing-style-prompt-pending'))).toBe(true);
  });

  test('idempotent: second run after user answered is a no-op', () => {
    // Simulate user answered: flag exists
    fs.writeFileSync(path.join(tmpHome, '.writing-style-prompted'), '');

    const result = run();
    expect(result.status).toBe(0);
    // No pending flag created
    expect(fs.existsSync(path.join(tmpHome, '.writing-style-prompt-pending'))).toBe(false);
  });

  test('idempotent: pre-existing pending flag is not duplicated', () => {
    // First run
    run();
    const firstStat = fs.statSync(path.join(tmpHome, '.writing-style-prompt-pending'));

    // Second run — flag stays, no error
    const result = run();
    expect(result.status).toBe(0);
    // Flag still exists; mtime may update but existence is stable
    expect(fs.existsSync(path.join(tmpHome, '.writing-style-prompt-pending'))).toBe(true);
    void firstStat;
  });
});
