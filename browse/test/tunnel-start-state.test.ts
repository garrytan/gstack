/**
 * POST /tunnel/start state under a mocked ngrok: two concurrent starts share
 * one session, and a start that fails after ngrok opens leaves the daemon
 * idle-stoppable. Each probe runs in a child `bun test` so the ngrok module
 * mock and the module-level tunnel state cannot leak into other shard files.
 */

import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SRC = path.join(import.meta.dir, '..', 'src');

const PRELUDE = `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const opened: string[] = [];
const closed: string[] = [];
let forwardGate: Promise<void> = Promise.resolve();
mock.module(${JSON.stringify(Bun.resolveSync('@ngrok/ngrok', SRC))}, () => ({
  forward: async () => {
    const id = 'session-' + (opened.length + 1);
    opened.push(id);
    await forwardGate;
    return { url: () => 'https://' + id + '.invalid', close: async () => { closed.push(id); } };
  },
}));
const { buildFetchHandler, __testInternals__ } = await import(${JSON.stringify(path.join(SRC, 'server.ts'))});
const { resolveConfig } = await import(${JSON.stringify(path.join(SRC, 'config.ts'))});
const stateFile = process.env.BROWSE_STATE_FILE!;
const token = 'tunnel-start-token-0123456789';
const handle = buildFetchHandler({
  authToken: token, browsePort: 34998, config: resolveConfig(), ownsTerminalAgent: false, startTime: Date.now(),
  browserManager: { getConnectionMode: () => 'launched', isWatching: () => false, stopWatch: () => {}, close: async () => {}, onDisconnect: null } as any,
});
const start = () => handle.fetchLocal(new Request('http://127.0.0.1:34998/tunnel/start', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }), null);
`;

async function runProbe(body: string): Promise<{ code: number; tail: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-start-'));
  fs.writeFileSync(path.join(dir, 'probe.test.ts'), PRELUDE + body);
  try {
    const child = Bun.spawn([process.execPath, 'test', './probe.test.ts'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        BROWSE_STATE_FILE: path.join(dir, 'state', 'browse.json'),
        GSTACK_HOME: path.join(dir, 'gstack'),
        GSTACK_PAIR_AGENT: 'on',
        NGROK_AUTHTOKEN: 'fake-token-for-test',
        NGROK_DOMAIN: '',
      },
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { code, tail: (out + err).slice(-3000) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('two concurrent tunnel starts share one ngrok session and URL', async () => {
  const result = await runProbe(`
test('probe', async () => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, instanceId: __testInternals__.serverInstanceId }));
  let release!: () => void;
  forwardGate = new Promise<void>(r => { release = r; });
  const a = start();
  const b = start();
  await new Promise(r => setTimeout(r, 50));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(opened).toEqual(['session-1']);
  expect(closed).toEqual([]);
  expect([ra.status, rb.status]).toEqual([200, 200]);
  const [ja, jb] = [await ra.json(), await rb.json()] as any[];
  expect(ja.url).toBe('https://session-1.invalid');
  expect(jb.url).toBe(ja.url);
});
`);
  expect(result).toMatchObject({ code: 0 });
  expect(result.tail).toContain('1 pass');
}, 90_000);

test('a tunnel start that fails after ngrok opens leaves the daemon idle-stoppable', async () => {
  const result = await runProbe(`
test('probe', async () => {
  const resp = await start();
  expect(resp.status).toBe(500);
  expect(opened).toEqual(['session-1']);
  expect(closed).toEqual(['session-1']);
  const exitMock = mock((_c?: number) => {});
  (process as any).exit = exitMock;
  __testInternals__.setLastActivity(Date.now() - 31 * 60 * 1000);
  __testInternals__.idleCheckTick();
  for (let i = 0; i < 6; i++) await new Promise<void>(r => setImmediate(r));
  expect(exitMock.mock.calls.length).toBeGreaterThan(0);
});
`);
  expect(result).toMatchObject({ code: 0 });
  expect(result.tail).toContain('1 pass');
}, 90_000);
