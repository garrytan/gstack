/**
 * D2: integration test for daemon-mismatch refuse.
 *
 * Stubs a healthy-looking state file with a known configHash, spins up a
 * tiny HTTP listener that answers /health (so the CLI's health check
 * passes), then runs the actual cli.ts binary with a different --proxy
 * value (different configHash). Asserts exit 1 and the disconnect hint
 * in stderr.
 *
 * This catches integration regressions that the unit tests on
 * extractGlobalFlags can't see — specifically the wiring between
 * extractGlobalFlags → ensureServer → state-file diff comparison.
 */

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';

async function startFakeHealthServer(token: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', token }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake server: bad address');
  return {
    port: addr.port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function runCli(args: string[], env: Record<string, string>, timeoutMs = 10000): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = path.resolve(__dirname, '../src/cli.ts');
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', cliPath, ...args], {
      timeout: timeoutMs,
      env,
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('D2 daemon-mismatch refuse (CLI integration)', () => {
  test('refuses when existing daemon has different configHash', async () => {
    // Set up a fake healthy daemon with a config-hash that won't match.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-mismatch-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const fakeServer = await startFakeHealthServer('fake-token');

    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid, // alive (current bun process); health check is what really gates this
      port: fakeServer.port,
      token: 'fake-token',
      startedAt: new Date().toISOString(),
      serverPath: '',
      mode: 'launched',
      configHash: 'aaaaaaaaaaaaaaaa', // 16-char hex; won't match new --proxy hash
    }, null, 2));

    const cliEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cliEnv[k] = v;
    }
    cliEnv.BROWSE_STATE_FILE = stateFile;

    try {
      const result = await runCli(
        ['--proxy', 'socks5://example.com:1080', 'status'],
        cliEnv,
      );
      expect(result.code).toBe(1);
      expect(result.stderr.toLowerCase()).toMatch(/different config|mismatch|browse disconnect/);
    } finally {
      await fakeServer.close();
      try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15000);

  test('refuses when existing plain daemon meets a --proxy invocation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-mismatch-plain-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const fakeServer = await startFakeHealthServer('fake-token');

    // Plain daemon (no configHash) — represents the existing-default case.
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid,
      port: fakeServer.port,
      token: 'fake-token',
      startedAt: new Date().toISOString(),
      serverPath: '',
      mode: 'launched',
    }, null, 2));

    const cliEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cliEnv[k] = v;
    }
    cliEnv.BROWSE_STATE_FILE = stateFile;

    try {
      const result = await runCli(
        ['--headed', 'status'],
        cliEnv,
      );
      expect(result.code).toBe(1);
      expect(result.stderr.toLowerCase()).toMatch(/without --proxy|browse disconnect/);
    } finally {
      await fakeServer.close();
      try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15000);

  test('reuses existing daemon when configHash matches', async () => {
    // A successful match: build a fake daemon with the SAME configHash the
    // CLI would compute for `--proxy socks5://reuse.example:1080`.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-match-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const fakeServer = await startFakeHealthServer('fake-token');

    const { computeConfigHash } = await import('../src/proxy-config');
    const matchingHash = computeConfigHash({
      proxyUrl: 'socks5://reuse.example:1080',
      headed: false,
    });

    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid,
      port: fakeServer.port,
      token: 'fake-token',
      startedAt: new Date().toISOString(),
      serverPath: '',
      mode: 'launched',
      configHash: matchingHash,
    }, null, 2));

    const cliEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cliEnv[k] = v;
    }
    cliEnv.BROWSE_STATE_FILE = stateFile;

    try {
      const result = await runCli(
        ['--proxy', 'socks5://reuse.example:1080', 'status'],
        cliEnv,
      );
      // Status command would fail to actually return useful data because our
      // fake server doesn't implement /command, but the CLI must NOT exit
      // with the mismatch error code path (which is exit 1 + 'different
      // config' in stderr). Acceptable outcomes:
      //   - exit 0 (status returned ok somehow)
      //   - exit !=0 from a different reason (bad token, command-handler missing)
      // The thing we assert is: stderr does NOT contain the mismatch hint.
      expect(result.stderr).not.toMatch(/different config|run 'browse disconnect' first/i);
    } finally {
      await fakeServer.close();
      try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15000);
});
