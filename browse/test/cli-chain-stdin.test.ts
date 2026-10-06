/**
 * #3039: `chain` with no arguments reads its JSON flow from stdin. On Windows
 * an awaited Bun.stdin.text() inside the CLI's un-awaited main() let the
 * process exit 0 before reading, so a replayed flow "passed" with nothing
 * sent to the daemon. The CLI reads stdin synchronously; this drives the real
 * CLI against a stub daemon (the Windows free lane runs it natively). No flow
 * (empty input, a terminal, an unreadable stdin) is a usage error before
 * ensureServer(), so it never boots a daemon.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CHAIN_NO_FLOW_ANCHOR, readChainFlow } from '../src/cli';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');

describe('#3039: chain reads its flow from piped stdin', () => {
  let scratch: string;
  let daemon: ReturnType<typeof Bun.serve>;
  let received: Array<{ command: string; args: string[] }>;
  let hits: string[];

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-chain-stdin-'));
    received = [];
    hits = [];
    daemon = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        hits.push(url.pathname);
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

  async function runChain(stdin: string | 'ignore', opts: { daemon?: boolean } = {}) {
    const stateFile = path.join(scratch, 'browse.json');
    if (opts.daemon !== false) {
      fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port: daemon.port, token: 'chain-stdin-test', mode: 'launched' }));
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(BROWSE_|GSTACK_|PLAYWRIGHT_)/.test(key)) env[key] = value;
    }
    // Browser dependencies unavailable: a daemon boot attempt could not succeed.
    Object.assign(env, { HOME: scratch, GSTACK_HOME: path.join(scratch, '.gstack'), BROWSE_STATE_FILE: stateFile,
      PLAYWRIGHT_BROWSERS_PATH: path.join(scratch, 'no-browsers') });
    const cli = Bun.spawn([process.execPath, CLI, 'chain'], {
      cwd: scratch, env, stdin: stdin === 'ignore' ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
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

  test('empty stdin is a usage error, never a silent exit 0, and never reaches the daemon', async () => {
    const r = await runChain('');
    expect(r.code).toBe(1);
    expect(r.out).toContain('[browse] chain: no flow to run (stdin was empty).');
    expect(r.out).toContain('Usage: echo');
    expect(r.out).toContain(CHAIN_NO_FLOW_ANCHOR);
    expect(hits).toEqual([]);
  }, 45_000);

  test('with no daemon, whitespace-only or closed stdin exits 1 without booting one', async () => {
    for (const stdin of ['  \n\t\n', 'ignore'] as const) {
      const r = await runChain(stdin, { daemon: false });
      expect(r.code).toBe(1);
      expect(r.out).toContain('[browse] chain: no flow to run (stdin was empty).');
      expect(fs.existsSync(path.join(scratch, 'browse.json'))).toBe(false);
      expect(fs.existsSync(path.join(scratch, '.gstack'))).toBe(false);
    }
  }, 45_000);
});

describe('readChainFlow: no flow is a usage error', () => {
  test('a terminal never reads stdin', () => {
    let read = false;
    const r = readChainFlow(true, () => { read = true; return '[["text"]]'; });
    expect(read).toBe(false);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('no flow to run (stdin is a terminal)') });
  });

  test('a read error (EAGAIN, EOF) is a usage error naming the code', () => {
    for (const code of ['EAGAIN', 'EOF']) {
      const r = readChainFlow(false, () => { throw Object.assign(new Error(code), { code }); });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(`no flow to run (stdin could not be read (${code}))`);
        expect(r.error).toContain('Usage: echo');
      }
    }
  });

  test('piped input is trimmed and returned', () => {
    expect(readChainFlow(false, () => '  [["text"]]\n')).toEqual({ ok: true, flow: '[["text"]]' });
  });
});
