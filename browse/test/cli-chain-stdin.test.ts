/**
 * #3039: `chain` with no arguments reads its JSON flow from stdin. On Windows
 * an awaited Bun.stdin.text() inside the CLI's un-awaited main() let the
 * process exit 0 before reading, so a replayed flow "passed" with nothing
 * sent to the daemon. The CLI reads stdin synchronously; this drives the real
 * CLI against a stub daemon (the Windows free lane runs it natively).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');

describe('#3039: chain reads its flow from piped stdin', () => {
  let scratch: string;
  let daemon: ReturnType<typeof Bun.serve>;
  let received: Array<{ command: string; args: string[] }>;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-chain-stdin-'));
    received = [];
    daemon = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/health') return Response.json({ status: 'healthy' });
        if (url.pathname === '/command') {
          const body = await req.json();
          received.push(body);
          return body.args?.[0] ? new Response('chain ran') : new Response('Usage: echo \'[["goto","url"]]\' | browse chain', { status: 400 });
        }
        return new Response('not found', { status: 404 });
      },
    });
  });

  afterEach(() => {
    try { daemon.stop(true); } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function runChain(stdin: string) {
    const stateFile = path.join(scratch, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port: daemon.port, token: 'chain-stdin-test', mode: 'launched' }));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(BROWSE_|GSTACK_)/.test(key)) env[key] = value;
    }
    Object.assign(env, { HOME: scratch, GSTACK_HOME: path.join(scratch, '.gstack'), BROWSE_STATE_FILE: stateFile });
    const cli = Bun.spawn([process.execPath, CLI, 'chain'], {
      cwd: scratch, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => cli.kill('SIGKILL'), 30_000);
    const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    clearTimeout(timer);
    return { code, out: stdout + stderr };
  }

  test('a piped flow reaches the daemon as the chain argument', async () => {
    const flow = '[["js","1+1"]]';
    const r = await runChain(`${flow}\n`);
    expect(received).toEqual([{ command: 'chain', args: [flow] }]);
    expect(r.out).toContain('chain ran');
    expect(r.code).toBe(0);
  }, 45_000);

  test('empty stdin is a usage error, never a silent exit 0', async () => {
    const r = await runChain('');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Usage');
  }, 45_000);
});
