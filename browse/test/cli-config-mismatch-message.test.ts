/**
 * #3030: when another session started the project's daemon with --headed or
 * --proxy, a plain call is refused (by design: a silent restart would drop
 * tabs and logins). The refusal must not tell a caller who passed no flags
 * to "apply --proxy/--headed".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');

describe('#3030: config-mismatch refusal names who started the daemon', () => {
  let scratch: string;
  let daemon: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-mismatch-'));
    daemon = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: (req) => new URL(req.url).pathname === '/health' ? Response.json({ status: 'healthy' }) : new Response('unexpected', { status: 500 }),
    });
  });
  afterEach(() => { try { daemon.stop(true); } catch {} fs.rmSync(scratch, { recursive: true, force: true }); });

  async function run(args: string[]) {
    const stateFile = path.join(scratch, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port: daemon.port, token: 't', mode: 'headed', configHash: 'started-by-another-session' }));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(BROWSE_|GSTACK_)/.test(key)) env[key] = value;
    Object.assign(env, { HOME: scratch, GSTACK_HOME: path.join(scratch, '.gstack'), BROWSE_STATE_FILE: stateFile });
    const cli = Bun.spawn([process.execPath, CLI, ...args], { cwd: scratch, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => cli.kill('SIGKILL'), 30_000);
    const [code, out, err] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    clearTimeout(timer);
    return { code, out: out + err };
  }

  test('a plain call is told another session started it, and both remedies', async () => {
    const r = await run(['text']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('running with --headed/--proxy (started by another session)');
    expect(r.out).toContain("pass the same flags to use it, or run 'browse disconnect'");
    expect(r.out).not.toContain('to apply --proxy/--headed');
  }, 45_000);

  test('a call that passed a different flag keeps the apply-via-disconnect hint', async () => {
    const r = await run(['--proxy', 'http://127.0.0.1:9', 'text']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("run 'browse disconnect' first to apply --proxy/--headed");
  }, 45_000);
});
