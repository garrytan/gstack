/**
 * Integration test: server.ts startup fail-fast on bad SOCKS5 upstream.
 *
 * Spawns the actual server.ts with BROWSE_PROXY_URL pointing at a port
 * that listens but rejects every CONNECT. Asserts:
 *   - exit code 1
 *   - stderr contains "FAIL upstream" (proof the testUpstream pre-flight ran)
 *   - stderr does NOT contain raw credentials (proof redaction works on
 *     the failure path)
 *   - exits within the 5s budget + retry overhead
 */

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';

async function startRejectingUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  // Accepts TCP connections, completes the SOCKS5 username/password auth
  // handshake by REJECTING (status 0x01), then closes. Our testUpstream()
  // should retry 3x and exhaust within ~5s.
  const server = net.createServer((sock) => {
    sock.once('data', (greeting) => {
      if (greeting[0] !== 0x05) { sock.destroy(); return; }
      const methods = greeting.subarray(2, 2 + greeting[1]);
      if (!methods.includes(0x02)) { sock.write(Buffer.from([0x05, 0xFF])); sock.destroy(); return; }
      sock.write(Buffer.from([0x05, 0x02]));
      sock.once('data', () => {
        // Reject auth (0x01)
        try { sock.write(Buffer.from([0x01, 0x01])); } catch { /* peer gone */ }
        sock.destroy();
      });
    });
    sock.on('error', () => sock.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('rejecting upstream: bad address');
  return {
    port: addr.port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe('server fail-fast on bad SOCKS5 upstream', () => {
  test('exits 1 with redacted error within budget', async () => {
    const upstream = await startRejectingUpstream();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-fail-fast-'));
    const stateFile = path.join(tmpDir, 'browse.json');

    const serverPath = path.resolve(__dirname, '../src/server.ts');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.BROWSE_STATE_FILE = stateFile;
    env.BROWSE_PARENT_PID = '0'; // disable watchdog so we can isolate the proxy failure
    env.BROWSE_HEADLESS_SKIP = '1'; // skip the chromium launch (we only test the proxy gate)
    env.BROWSE_PROXY_URL = `socks5://baduser:badpass@127.0.0.1:${upstream.port}`;

    const start = Date.now();
    const result = await new Promise<{ code: number; stdout: string; stderr: string; ms: number }>((resolve) => {
      const proc = spawn('bun', ['run', serverPath], {
        timeout: 30000,
        env,
      });
      let stdout = ''; let stderr = '';
      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - start }));
    });

    try {
      // Expectation 1: exit 1
      expect(result.code).toBe(1);
      // Expectation 2: stderr names the failure mode and references the upstream
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/FAIL upstream/);
      // Expectation 3: redaction. Raw 'baduser' and 'badpass' must NEVER
      // appear in any output, even on the failure path.
      expect(combined).not.toContain('baduser');
      expect(combined).not.toContain('badpass');
      // Expectation 4: budget. testUpstream caps at 5s plus a small amount
      // of script startup overhead (~3-5s for `bun run`). Cap at 30s as a
      // generous upper bound so the assertion is meaningful but not flaky.
      expect(result.ms).toBeLessThan(30000);
    } finally {
      await upstream.close();
      try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60000);
});
