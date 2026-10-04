/**
 * G4 (#494): with HTTP_PROXY set, the CLI's loopback calls to its own daemon
 * went through the proxy, so the daemon never looked healthy. The CLI appends
 * loopback to NO_PROXY (keeping the user's entries) before its first fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withLoopbackNoProxy } from '../src/cli';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');

describe('withLoopbackNoProxy', () => {
  test('appends loopback names to an existing list without replacing it', () => {
    expect(withLoopbackNoProxy({ NO_PROXY: 'corp.internal, .example.com' })).toBe('corp.internal,.example.com,127.0.0.1,localhost,::1');
    expect(withLoopbackNoProxy({ no_proxy: 'corp.internal' })).toBe('corp.internal,127.0.0.1,localhost,::1');
    expect(withLoopbackNoProxy({})).toBe('127.0.0.1,localhost,::1');
    expect(withLoopbackNoProxy({ NO_PROXY: 'localhost,127.0.0.1,::1' })).toBe('localhost,127.0.0.1,::1');
  });
});

describe('CLI → daemon behind a proxy that fails every request', () => {
  let scratch: string;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxied = 0;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-no-proxy-'));
    proxied = 0;
    proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { proxied++; return new Response('proxy refuses', { status: 502 }); } });
  });

  afterEach(() => {
    try { proxy.stop(true); } catch {}
    const stateFile = path.join(scratch, 'state', 'browse.json');
    if (fs.existsSync(stateFile)) {
      try { process.kill(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test.skipIf(process.platform === 'win32')('status reaches the daemon directly and the daemon keeps the user NO_PROXY entries', async () => {
    const stateFile = path.join(scratch, 'state', 'browse.json');
    const stub = path.join(scratch, 'stub-server.ts');
    fs.writeFileSync(stub, `
      import * as fs from 'node:fs';
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'healthy' }) });
      fs.writeFileSync(process.env.BROWSE_STATE_FILE!, JSON.stringify({
        pid: process.pid, port: server.port, token: 'no-proxy-test', mode: 'launched', noProxy: process.env.NO_PROXY,
      }));
      setTimeout(() => server.stop(true), 5000);
    `);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(BROWSE_|GSTACK_|NO_PROXY$|no_proxy$|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$)/.test(key)) env[key] = value;
    }
    Object.assign(env, {
      HOME: scratch,
      GSTACK_HOME: path.join(scratch, '.gstack'),
      BROWSE_STATE_FILE: stateFile,
      BROWSE_SERVER_SCRIPT: stub,
      BROWSE_PARENT_PID: '0',
      BROWSE_START_TIMEOUT: '8000',
      HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
      http_proxy: `http://127.0.0.1:${proxy.port}`,
      NO_PROXY: 'corp.internal',
    });
    const cli = Bun.spawn([process.execPath, CLI, 'status'], { cwd: scratch, env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => cli.kill('SIGKILL'), 30_000);
    const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    clearTimeout(timer);
    expect(code, stdout + stderr).toBe(0);
    expect(proxied).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).noProxy).toBe('corp.internal,127.0.0.1,localhost,::1');
  }, 45_000);
});
