/**
 * #2219 IRON RULE regression tests (E5): an alive daemon pid is NEVER
 * auto-killed. Killing a live daemon loses the session's tabs, cookies, and
 * logins — strictly worse than a slow command. Only an explicit
 * --force-restart may replace a live daemon.
 *
 * Integration legs follow the busy-daemon-recovery.test.ts pattern: a fake
 * HTTP daemon + a live `sleep` child standing in for the daemon PID, wired
 * through BROWSE_STATE_FILE. Unit legs pin the pure decision function.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { isProcessAlive } from '../src/error-handling';
import { decideDaemonRestart, HEALTH_PROBE_TOTAL_BUDGET_MS } from '../src/cli';

// ─── Unit: the pure restart decision (decision 9 / F10) ──────────────────

describe('decideDaemonRestart (pure)', () => {
  test('healthy after probe → retry against the SAME daemon', () => {
    expect(decideDaemonRestart({ pidAlive: true, healthyAfterProbe: true, forceRestart: false }))
      .toBe('retry-command');
    // Even with --force-restart in hand, a healthy daemon is retried, not killed.
    expect(decideDaemonRestart({ pidAlive: true, healthyAfterProbe: true, forceRestart: true }))
      .toBe('retry-command');
  });

  test('IRON RULE: alive + unhealthy + no flag → report busy, never kill', () => {
    expect(decideDaemonRestart({ pidAlive: true, healthyAfterProbe: false, forceRestart: false }))
      .toBe('report-busy');
  });

  test('alive + unhealthy + explicit --force-restart → force-restart', () => {
    expect(decideDaemonRestart({ pidAlive: true, healthyAfterProbe: false, forceRestart: true }))
      .toBe('force-restart');
  });

  test('dead pid → restart, with or without the flag', () => {
    expect(decideDaemonRestart({ pidAlive: false, healthyAfterProbe: false, forceRestart: false }))
      .toBe('restart-dead');
    expect(decideDaemonRestart({ pidAlive: false, healthyAfterProbe: false, forceRestart: true }))
      .toBe('restart-dead');
  });

  test('probe budget is ~8s (F10) — long enough for heavy-page busy windows', () => {
    expect(HEALTH_PROBE_TOTAL_BUDGET_MS).toBeGreaterThanOrEqual(7_000);
    expect(HEALTH_PROBE_TOTAL_BUDGET_MS).toBeLessThanOrEqual(10_000);
  });
});

// ─── Integration: real spawned CLI vs fake daemons ───────────────────────

/** A daemon whose /health always answers healthy but never serves /command. */
async function startHealthyDaemon(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake daemon: bad address');
  return { port: addr.port, close: () => new Promise((r) => server.close(() => r())) };
}

/** A WEDGED daemon: alive socket, but /health always answers unhealthy. */
async function startWedgedDaemon(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'wedged' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake daemon: bad address');
  return { port: addr.port, close: () => new Promise((r) => server.close(() => r())) };
}

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

let pidChild: ChildProcess | null = null;
afterEach(() => { pidChild?.kill('SIGKILL'); pidChild = null; });

describe('#2219 iron rule (CLI integration)', () => {
  test('healthy daemon SURVIVES `browse connect` — refused with guidance, no kill', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-iron-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const daemon = await startHealthyDaemon();
    try {
      pidChild = spawn('sleep', ['60'], { stdio: 'ignore' });
      const daemonPid = pidChild.pid!;
      const stateContent = {
        pid: daemonPid,
        port: daemon.port,
        token: 'iron-rule-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      };
      fs.writeFileSync(stateFile, JSON.stringify(stateContent, null, 2));

      const result = await runCli(['connect'], baseEnv(stateFile));

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('healthy daemon is already running');
      expect(result.stderr).toContain('--force-restart');
      // THE IRON RULE: the daemon process was not killed.
      expect(isProcessAlive(daemonPid)).toBe(true);
      // And the state file was not clobbered.
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8'))).toEqual(stateContent);
    } finally {
      await daemon.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('pair-agent over a live headless daemon WITHOUT --force-restart → daemon survives, notice printed, no headed relaunch', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-iron-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const daemon = await startHealthyDaemon();
    try {
      pidChild = spawn('sleep', ['60'], { stdio: 'ignore' });
      const daemonPid = pidChild.pid!;
      const stateContent = {
        pid: daemonPid,
        port: daemon.port,
        token: 'iron-rule-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      };
      fs.writeFileSync(stateFile, JSON.stringify(stateContent, null, 2));

      // Exit code is NOT asserted: the fake daemon answers /pair with
      // non-JSON so handlePairAgent fails later — the iron rule under test
      // is everything that happens BEFORE that: no kill, no headed relaunch.
      const result = await runCli(['pair-agent'], baseEnv(stateFile));

      // The consent notice: live session named, opt-in flag named.
      expect(result.stderr).toContain('continuing against it');
      expect(result.stderr).toContain('--force-restart');
      // No headed relaunch was attempted.
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain('Opening GStack Browser');
      // THE IRON RULE: the daemon process was not killed.
      expect(isProcessAlive(daemonPid)).toBe(true);
      // And the state file was not clobbered.
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8'))).toEqual(stateContent);
    } finally {
      await daemon.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('wedged-alive daemon + plain command → busy report + nonzero exit, NO kill', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-iron-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const daemon = await startWedgedDaemon();
    try {
      pidChild = spawn('sleep', ['120'], { stdio: 'ignore' });
      const daemonPid = pidChild.pid!;
      fs.writeFileSync(stateFile, JSON.stringify({
        pid: daemonPid,
        port: daemon.port,
        token: 'iron-rule-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      }, null, 2));

      const result = await runCli(['status'], baseEnv(stateFile));

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Daemon busy');
      expect(result.stderr).toContain('--force-restart');
      // Never killed, never restarted.
      expect(isProcessAlive(daemonPid)).toBe(true);
      expect(result.stderr).not.toContain('Restarting');
    } finally {
      await daemon.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 45_000);

  test('wedged-alive daemon + --force-restart IS killed (explicit consent path)', async () => {
    // Unix lanes only: the consent path must boot a REAL replacement daemon
    // to answer the command, which the secretless/browserless Windows lane
    // cannot do (no Chromium install), and the teardown relies on setsid
    // process-group semantics Windows lacks. The Windows-relevant half of
    // the iron rule — busy → refusal, never an implicit kill — runs above.
    if (process.platform === 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-iron-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const daemon = await startWedgedDaemon();
    try {
      pidChild = spawn('sleep', ['120'], { stdio: 'ignore' });
      const daemonPid = pidChild.pid!;
      fs.writeFileSync(stateFile, JSON.stringify({
        pid: daemonPid,
        port: daemon.port,
        token: 'iron-rule-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      }, null, 2));

      // `status` with --force-restart: the wedged "daemon" must be killed and
      // a REAL daemon started in its place.
      const result = await runCli(['--force-restart', 'status'], baseEnv(stateFile), 60_000);

      // The wedged pid was killed — the explicit consent path.
      expect(isProcessAlive(daemonPid)).toBe(false);
      expect(result.stderr).toContain('--force-restart');
      // The replacement daemon answered the command.
      expect(result.code).toBe(0);
    } finally {
      // Kill the REAL daemon's whole PROCESS GROUP, not just its pid.
      // startServer spawns the daemon detached (setsid — its own group
      // leader), so a bare SIGKILL on the pid orphans its Chromium child,
      // which then squats memory for the REST of the suite (~100 files) —
      // enough pressure on a loaded box for the OS to kill a LATER test's
      // in-process Chromium, whose disconnect handler process.exit(1)s the
      // whole bun run mid-suite with no summary.
      try {
        const newState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (newState?.pid && isProcessAlive(newState.pid)) {
          try {
            process.kill(-newState.pid, 'SIGKILL'); // group: daemon + Chromium
          } catch {
            process.kill(newState.pid, 'SIGKILL'); // fallback: pid only
          }
        }
      } catch { /* state file gone — nothing started */ }
      await daemon.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);
});
