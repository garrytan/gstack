import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isProcessAlive } from '../src/error-handling';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const BROWSE_BIN = path.join(ROOT, 'browse', 'dist', process.platform === 'win32' ? 'browse.exe' : 'browse');

function runBrowse(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(BROWSE_BIN, args, {
    env,
    encoding: 'utf-8',
    timeout: 45_000,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

describe.skipIf(!fs.existsSync(BROWSE_BIN))('browse stop lifecycle', () => {
  test('returns success, removes state, kills the original daemon, and does not start a replacement', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stop-lifecycle-'));
    const stateFile = path.join(tmp, '.gstack', 'browse.json');
    const env = {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_PARENT_PID: '0',
      GSTACK_HOME: path.join(tmp, 'gstack-home'),
    };
    let originalPid: number | undefined;

    try {
      const status = runBrowse(['status'], env);
      expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(0);
      expect(fs.existsSync(stateFile)).toBe(true);
      originalPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
      expect(isProcessAlive(originalPid!)).toBe(true);

      const stopped = runBrowse(['stop'], env);
      expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      expect(stopped.stdout).toContain('Server stopped');
      expect(stopped.stderr).not.toContain('Server crashed twice');
      expect(stopped.stderr).not.toContain('Server connection lost. Restarting');

      expect(await waitUntil(() => !fs.existsSync(stateFile))).toBe(true);
      expect(await waitUntil(() => !isProcessAlive(originalPid!))).toBe(true);
      await Bun.sleep(300);
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      if (fs.existsSync(stateFile)) {
        const currentPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
        if (isProcessAlive(currentPid)) {
          try { process.kill(currentPid); } catch {}
        }
      } else if (originalPid && isProcessAlive(originalPid)) {
        try { process.kill(originalPid); } catch {}
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('restart replaces the daemon and leaves the new server healthy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-restart-lifecycle-'));
    const stateFile = path.join(tmp, '.gstack', 'browse.json');
    const env = {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_PARENT_PID: '0',
      GSTACK_HOME: path.join(tmp, 'gstack-home'),
    };
    let originalPid: number | undefined;

    try {
      const status = runBrowse(['status'], env);
      expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(0);
      originalPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;

      const restarted = runBrowse(['restart'], env);
      expect(restarted.status, `${restarted.stdout}\n${restarted.stderr}`).toBe(0);
      expect(restarted.stdout).toContain('Restarting');
      expect(await waitUntil(() => {
        if (!fs.existsSync(stateFile)) return false;
        const nextPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
        return nextPid !== originalPid && isProcessAlive(nextPid);
      })).toBe(true);
      expect(await waitUntil(() => !isProcessAlive(originalPid!))).toBe(true);

      const healthy = runBrowse(['status'], env);
      expect(healthy.status, `${healthy.stdout}\n${healthy.stderr}`).toBe(0);
    } finally {
      if (fs.existsSync(stateFile)) {
        const currentPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
        if (isProcessAlive(currentPid)) {
          try { process.kill(currentPid); } catch {}
        }
      }
      if (originalPid && isProcessAlive(originalPid)) {
        try { process.kill(originalPid); } catch {}
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
