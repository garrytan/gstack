/**
 * Behavior tests for the `tunnel revoke` / `tunnel agents` CLI subcommands.
 *
 * Three harness shapes:
 *  1. No/dead daemon — scratch BROWSE_STATE_FILE, no processes (the
 *     stop-dead-daemon.test.ts pattern): tunnel must exit 0 WITHOUT booting
 *     a daemon (#2254 — tokens are memory-only, a dead daemon has nothing
 *     to revoke).
 *  2. Live daemon — real server subprocess with BROWSE_HEADLESS_SKIP=1
 *     (the pair-agent-e2e.test.ts pattern): the full revoke + verify loop.
 *  3. Stub daemon — a test-local Bun.serve behind a hand-written state file
 *     with an ALIVE pid (this test process). Pins the version-skew net (an
 *     OLD daemon with the first-match revoke bug returns 200 while /agents
 *     keeps listing the agent) and the unreachable-daemon branch. The pid
 *     decides the dead-daemon vs unreachable branch, so stubs MUST carry an
 *     alive pid.
 */

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '../..');
const SERVER_ENTRY = path.join(ROOT, 'browse/src/server.ts');

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

function writeStateFile(stateFile: string, pid: number, port: number): void {
  fs.writeFileSync(stateFile, JSON.stringify({
    pid,
    port,
    token: 'fake-root-token',
    startedAt: new Date().toISOString(),
    serverPath: '',
    mode: 'launched' as const,
  }, null, 2));
}

describe('tunnel subcommand parsing', () => {
  test('bare tunnel / unknown sub / empty name / extra args → usage, exit 1', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-usage-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      for (const args of [
        ['tunnel'],
        ['tunnel', 'rotate'],
        ['tunnel', 'revoke'],
        ['tunnel', 'revoke', ''],
        ['tunnel', 'revoke', 'a', 'b'],
        ['tunnel', 'agents', 'extra'],
      ]) {
        const result = await runCli(args, baseEnv(stateFile));
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('usage: browse tunnel');
      }
      // Arg errors must never boot a daemon.
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// pair-agent scope-flag misuse shares this file's subprocess harness: like
// tunnel, the validation must run pre-server, so "no daemon spawned" is the
// load-bearing assertion.
describe('pair-agent scope-flag validation (pre-server)', () => {
  test('bare --restrict → exit 1 usage error, NO daemon spawned (was: silent FULL grant)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-restrict-bare-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['pair-agent', '--restrict'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--restrict needs a scope list');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('--restrict=read (equals form) → exit 1, NO daemon spawned', async () => {
    // Regression: hasFlag/parseFlag are exact-token matches, so the equals
    // form sailed past validatePairAgentFlags AND handlePairAgent's parse —
    // the user asked for a read-only sandbox and silently got FULL access.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-restrict-eq-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['pair-agent', '--restrict=read'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--restrict takes a space-separated value');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('--restrict swallowing the next flag → exit 1, NO daemon spawned', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-restrict-flag-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['pair-agent', '--restrict', '--client', 'bob'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--restrict needs a scope list');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('--restrict "read,control" → exit 1 pointing at --control, NO daemon spawned', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-restrict-ctl-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['pair-agent', '--restrict', 'read,control'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Re-run with --control');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('--client root → exit 1 reserved-name error, NO daemon spawned', async () => {
    // `root` is the sentinel that bypasses every scope/domain/rate/tab check;
    // the CLI must reject it pre-server (the daemon also 400s it as defense-in-depth).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-client-root-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['pair-agent', '--client', 'root'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('reserved');
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('tunnel against no daemon (#2254 — never boot one)', () => {
  test('revoke → exit 0, "No daemon running", nothing spawned', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-dead-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      const result = await runCli(['tunnel', 'revoke', 'ghost'], baseEnv(stateFile));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No daemon running');
      // A spawned daemon would have written the state file.
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('agents → exit 0; stale state (dead pid + closed port) is NOT mutated — cleanup stays stop\'s job', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-stale-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      writeStateFile(stateFile, 2147483646, await closedPort());
      const before = fs.readFileSync(stateFile, 'utf-8');
      const result = await runCli(['tunnel', 'agents'], baseEnv(stateFile));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No daemon running');
      expect(fs.readFileSync(stateFile, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('tunnel against a live daemon (HTTP only, no browser)', () => {
  test('pair → connect → revoke: verified gone, token 401s; agents lists pending keys', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-live-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const port = 20000 + Math.floor(Math.random() * 20000);
    const daemon = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        BROWSE_HEADLESS_SKIP: '1',
        BROWSE_PORT: String(port),
        BROWSE_STATE_FILE: stateFile,
        BROWSE_PARENT_PID: '0',
        BROWSE_IDLE_TIMEOUT: '600000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
          ready = resp.ok;
        } catch { /* not ready yet */ }
        if (!ready) await new Promise(r => setTimeout(r, 200));
      }
      expect(ready).toBe(true);
      const rootToken = (JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { token: string }).token;

      // Pair + connect a session, plus a second pending setup key.
      const pair = async () => {
        const resp = await fetch(`${baseUrl}/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootToken}` },
          body: JSON.stringify({ clientId: 'cli-agent' }),
        });
        return (await resp.json() as { setup_key: string }).setup_key;
      };
      const key1 = await pair();
      const connectResp = await fetch(`${baseUrl}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_key: key1 }),
      });
      const { token: scopedToken } = await connectResp.json() as { token: string };
      await pair(); // pending key

      // tunnel agents shows the session AND the pending key.
      const list = await runCli(['tunnel', 'agents'], baseEnv(stateFile));
      expect(list.code).toBe(0);
      expect(list.stdout).toContain('cli-agent');
      expect(list.stdout).toContain('(pending setup key)');

      // Unknown name → truthful failure with the active list.
      const miss = await runCli(['tunnel', 'revoke', 'nobody'], baseEnv(stateFile));
      expect(miss.code).toBe(1);
      expect(miss.stderr).toContain('No paired agent named "nobody"');
      expect(miss.stderr).toContain('cli-agent');

      // The real revoke: counted, verified, and the token actually dies.
      const revoke = await runCli(['tunnel', 'revoke', 'cli-agent'], baseEnv(stateFile));
      expect(revoke.code).toBe(0);
      expect(revoke.stdout).toContain('Revoked "cli-agent" (3 tokens)');
      expect(revoke.stdout).toContain('Verified: not in the active agent list.');
      const post = await fetch(`${baseUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scopedToken}` },
        body: JSON.stringify({ command: 'status', args: [] }),
      });
      expect(post.status).toBe(401);

      const empty = await runCli(['tunnel', 'agents'], baseEnv(stateFile));
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain('No paired agents.');

      // Regression: handleTunnel used to trim() the name, but clientIds are
      // stored verbatim — a space-padded agent became unrevocable by the
      // documented kill switch (trimmed DELETE 404'd while the grant lived).
      const padPair = await fetch(`${baseUrl}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootToken}` },
        body: JSON.stringify({ clientId: ' padded' }),
      });
      expect(padPair.status).toBe(200);
      const padRevoke = await runCli(['tunnel', 'revoke', ' padded'], baseEnv(stateFile));
      expect(padRevoke.code).toBe(0);
      expect(padRevoke.stdout).toContain('Verified: not in the active agent list.');
    } finally {
      try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('tunnel against a lying or unreachable daemon (stub harness)', () => {
  test('old daemon 200s the DELETE but keeps listing the agent → "Revocation incomplete", exit 1', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-skew-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    // Old daemons answer {revoked} with no tokens_deleted — this also pins
    // the "(count unknown)" print (never undefined/NaN).
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'DELETE' && url.pathname.startsWith('/token/')) {
          return Response.json({ revoked: 'mallory' });
        }
        if (url.pathname === '/agents') {
          return Response.json({
            agents: [{ clientId: 'mallory', scopes: ['read'], expiresAt: null, commandCount: 1, createdAt: '' }],
          });
        }
        return Response.json({ status: 'healthy' });
      },
    });
    try {
      writeStateFile(stateFile, process.pid, stub.port);
      const result = await runCli(['tunnel', 'revoke', 'mallory'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('count unknown');
      expect(result.stderr).toContain('Revocation incomplete: "mallory" is still listed');
    } finally {
      stub.stop(true);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('DELETE succeeds but /agents errors → "could not verify", exit 1 (never a silent success)', async () => {
    // Regression pin: a revoke whose verification read fails must NOT report
    // clean success — the whole point of the re-read is proving the deletion.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-noverify-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'DELETE' && url.pathname.startsWith('/token/')) {
          return Response.json({ revoked: 'mallory', tokens_deleted: 1 });
        }
        if (url.pathname === '/agents') {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ status: 'healthy' });
      },
    });
    try {
      writeStateFile(stateFile, process.pid, stub.port);
      const result = await runCli(['tunnel', 'revoke', 'mallory'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Revoked, but could not verify against the agent list.');
    } finally {
      stub.stop(true);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('DELETE returns 500 → "Revoke failed" with the body error, exit 1', async () => {
    // Regression pin: a non-404 HTTP failure must surface the daemon's error,
    // not fall through to a success print.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-500-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'DELETE' && url.pathname.startsWith('/token/')) {
          return Response.json({ error: 'registry exploded' }, { status: 500 });
        }
        return Response.json({ status: 'healthy' });
      },
    });
    try {
      writeStateFile(stateFile, process.pid, stub.port);
      const result = await runCli(['tunnel', 'revoke', 'mallory'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Revoke failed: registry exploded');
    } finally {
      stub.stop(true);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('tunnel agents with a broken /agents → "Could not read the agent list", exit 1', async () => {
    // Regression pin: a 500 from /agents must not render as "No paired
    // agents." — an unreadable list is not an empty list.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-agents500-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const stub = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/agents') {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ status: 'healthy' });
      },
    });
    try {
      writeStateFile(stateFile, process.pid, stub.port);
      const result = await runCli(['tunnel', 'agents'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Could not read the agent list');
      expect(result.stdout).not.toContain('No paired agents.');
    } finally {
      stub.stop(true);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('alive pid but unreachable port → "Could not reach daemon", exit 1 (NOT "no daemon")', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-tunnel-unreach-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    try {
      // Alive pid (this test process) is what routes to the fetch-failure
      // branch; a dead pid + dead port would be the exit-0 "no daemon" path.
      writeStateFile(stateFile, process.pid, await closedPort());
      const result = await runCli(['tunnel', 'revoke', 'anyone'], baseEnv(stateFile));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Could not reach daemon');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
