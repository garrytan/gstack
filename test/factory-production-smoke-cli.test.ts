import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-factory-smoke');

function runSmokeCli(args: readonly string[] = []) {
  return Bun.spawnSync([BIN, ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
}

function tempWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'factory-smoke-cli-'));
}

describe('factory production smoke CLI', () => {
  test('prints a human-readable summary and exits zero when only S11 is deferred', () => {
    const result = runSmokeCli();
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Factory production-readiness smoke: pass');
    expect(stdout).toContain('Required checks: pass');
    expect(stdout).toContain('10 pass, 0 fail, 1 deferred');
    expect(stdout).toContain('S11-web-health [deferred]');
    expect(stdout).toContain('Deferred gates remain open and are not counted as pass.');
  });

  test('prints JSON summary for machine callers', () => {
    const result = runSmokeCli(['--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');

    const summary = JSON.parse(result.stdout.toString());
    expect(summary.status).toBe('pass');
    expect(summary.allRequiredPassed).toBe(true);
    expect(summary.hasDeferredGates).toBe(true);
    expect(summary.failCount).toBe(0);
    expect(summary.deferredCount).toBe(1);
    expect(summary.checks.map((check: { id: string }) => check.id)).toContain('S11-web-health');
    expect(summary.checks.find((check: { id: string }) => check.id === 'S11-web-health').status).toBe('deferred');
  });

  test('uses a caller-provided absolute work directory', () => {
    const workDir = tempWorkDir();
    try {
      const result = runSmokeCli(['--work-dir', workDir]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe('');
      expect(existsSync(path.join(workDir, 'facade-status'))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('rejects relative work directories and unknown options', () => {
    const relative = runSmokeCli(['--work-dir', 'relative-dir']);
    expect(relative.exitCode).toBe(1);
    expect(relative.stderr.toString()).toContain('absolute');

    const unknown = runSmokeCli(['--surprise']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr.toString()).toContain('Unknown option: --surprise');
  });

  test('help output documents direct bin invocation without package script edits', () => {
    const result = runSmokeCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Usage: bin/gstack-factory-smoke');
    expect(result.stdout.toString()).toContain('without package manifest edits');
  });
});
