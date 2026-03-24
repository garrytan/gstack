/**
 * Security tests for gstack-config key validation and telemetry SESSION_ID sanitization
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BIN = path.resolve(__dirname, '../bin/gstack-config');
const TELEMETRY_BIN = path.resolve(__dirname, '../bin/gstack-telemetry-log');

function runScript(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('bash', [cmd, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('gstack-config key validation (H1)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('rejects key with regex metacharacters', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
    const result = await runScript(BIN, ['set', '.*', 'evil'], {
      GSTACK_STATE_DIR: tmpDir,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('must match');
  });

  test('rejects key with shell metacharacters', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
    const result = await runScript(BIN, ['set', 'key;rm -rf /', 'val'], {
      GSTACK_STATE_DIR: tmpDir,
    });
    expect(result.code).not.toBe(0);
  });

  test('rejects key with forward slashes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
    const result = await runScript(BIN, ['set', 'key/../../etc', 'val'], {
      GSTACK_STATE_DIR: tmpDir,
    });
    expect(result.code).not.toBe(0);
  });

  test('accepts valid alphanumeric key', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
    const result = await runScript(BIN, ['set', 'telemetry', 'off'], {
      GSTACK_STATE_DIR: tmpDir,
    });
    expect(result.code).toBe(0);

    const getResult = await runScript(BIN, ['get', 'telemetry'], {
      GSTACK_STATE_DIR: tmpDir,
    });
    expect(getResult.stdout.trim()).toBe('off');
  });

  test('accepts key with hyphens and underscores', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
    const result = await runScript(BIN, ['set', 'skip_eng_review', 'true'], {
      GSTACK_STATE_DIR: tmpDir,
    });
    expect(result.code).toBe(0);
  });
});

describe('telemetry SESSION_ID sanitization (H4)', () => {
  let tmpDir: string;
  let gstackDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('strips path traversal characters from session ID', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-'));
    gstackDir = path.resolve(__dirname, '..');

    const maliciousSessionId = '../../../../etc/passwd';
    const result = await runScript(TELEMETRY_BIN, [
      '--skill', 'test',
      '--duration', '1',
      '--outcome', 'success',
      '--session-id', maliciousSessionId,
    ], {
      GSTACK_STATE_DIR: tmpDir,
      GSTACK_DIR: gstackDir,
    });

    expect(result.code).toBe(0);
    expect(fs.existsSync('/etc/.pending-')).toBe(false);

    const pendingFiles = fs.readdirSync(path.join(tmpDir, 'analytics')).filter(f => f.startsWith('.pending-'));
    for (const f of pendingFiles) {
      expect(f).not.toContain('..');
      expect(f).not.toContain('/');
    }
  });
});
