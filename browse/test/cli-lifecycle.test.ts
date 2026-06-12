import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function cliEnv(stateFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.BROWSE_STATE_FILE = stateFile;
  return env;
}

function runCli(args: string[], stateFile: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = path.resolve(__dirname, '../src/cli.ts');
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', cliPath, ...args], {
      timeout: 15_000,
      env: cliEnv(stateFile),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('CLI lifecycle commands', () => {
  test('status with no state does not start a daemon', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cli-lifecycle-'));
    const stateFile = path.join(dir, 'browse.json');
    try {
      const result = await runCli(['status'], stateFile);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Status: stopped');
      expect(result.stderr).not.toContain('Starting server');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test('status on a dead state file does not start a daemon', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cli-lifecycle-'));
    const stateFile = path.join(dir, 'browse.json');
    try {
      fs.writeFileSync(stateFile, JSON.stringify({
        port: 1,
        token: 'fake',
        pid: 999999,
      }));

      const result = await runCli(['status'], stateFile);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Status: stopped');
      expect(result.stdout).toContain('Reason: daemon is not responding');
      expect(result.stderr).not.toContain('Starting server');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
