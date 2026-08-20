/**
 * #2254: `browse stop` against a daemon that isn't running must report
 * success and exit 0 — WITHOUT starting a daemon just to stop it. The old
 * flow routed stop through ensureServer(), which booted a fresh daemon +
 * Chromium (multi-second, resource churn) and then shut it down — or
 * crash-restarted on a stale state file.
 *
 * Integration pattern follows busy-daemon-recovery.test.ts: a scratch
 * BROWSE_STATE_FILE + a real spawned CLI.
 */

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { isProcessAlive } from '../src/error-handling';

function runCli(args: string[], env: Record<string, string>, timeoutMs = 30_000):
  Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = path.resolve(import.meta.dir, '../src/cli.ts');
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', cliPath, ...args], { timeout: timeoutMs, env });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function baseEnv(stateFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.BROWSE_STATE_FILE = stateFile;
  return env;
}

/** Grab a port that is definitely closed (bind, read, release). */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') { reject(new Error('bad address')); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

describe('#2254 stop on a dead daemon', () => {
  test('no daemon state at all → exit 0, nothing spawned', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-stop-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['stop'], baseEnv(stateFile));

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('nothing to stop');
      // The load-bearing half: NO daemon was started to serve the stop —
      // a spawned daemon would have written the state file.
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(result.stderr).not.toContain('Starting server');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('stale state (dead pid + closed port) → exit 0, state cleaned, nothing spawned', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-stop-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      // A pid that is certainly not alive and a port nothing listens on.
      const port = await closedPort();
      fs.writeFileSync(stateFile, JSON.stringify({
        pid: 2147483646,
        port,
        token: 'stale-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      }, null, 2));

      const result = await runCli(['stop'], baseEnv(stateFile));

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('nothing to stop');
      // Stale state cleaned, and no daemon spawned to replace it.
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(result.stderr).not.toContain('Starting server');
      expect(result.stderr).not.toContain('Restarting');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('stop --force-restart on a LIVE daemon', () => {
  test('kills it directly — never boots a fresh daemon just to stop it', async () => {
    // A live-but-BUSY daemon: the pid is alive but nothing answers /health.
    // Pre-fix, stop --force-restart fell through to ensureServer(), whose
    // force-restart path killed the daemon and then STARTED a fresh one
    // (daemon + Chromium) so sendCommand('stop') could stop it again —
    // exactly what gstack-upgrade Step 4.8 triggers on a stale-busy daemon.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-stop-force-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    // Portable long-lived child standing in for the wedged daemon process.
    const wedged = spawn('bun', ['-e', 'await Bun.sleep(300000)'], { stdio: 'ignore' });
    try {
      const port = await closedPort();
      fs.writeFileSync(stateFile, JSON.stringify({
        pid: wedged.pid,
        port,
        token: 'busy-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      }, null, 2));

      const result = await runCli(['stop', '--force-restart'], baseEnv(stateFile));

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Daemon stopped (forced');
      // The load-bearing half: NO fresh daemon was booted to serve the stop.
      // A spawned daemon would have re-written the state file.
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(result.stderr).not.toContain('Starting server');
      expect(result.stdout + result.stderr).not.toContain('Restarting');
      // And the live pid is actually gone.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && isProcessAlive(wedged.pid!)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(isProcessAlive(wedged.pid!)).toBe(false);
    } finally {
      try { wedged.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
