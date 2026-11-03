/**
 * #915 end to end: the CLI resolves the proxy from the standard variables and
 * the daemon's Chromium navigates through it, across launch, reuse and
 * restart. A local HTTP proxy answers every proxied request itself, so a page
 * at a name that does not resolve loads only through the proxy; a loopback
 * page loads directly. NO_PROXY is part of the daemon config, so a change to it
 * alone is refused instead of silently reusing the daemon.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
const PROXIED_HOST = 'proxied.gstack-915.test';
const AUTH_HOST = 'auth.gstack-3457.test';
const AUTH_HEADER = `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`;

let scratch = '';
let stateFile = '';
let proxy: http.Server;
let proxyUrl = '';
let direct: ReturnType<typeof Bun.serve>;
const proxiedHosts: string[] = [];

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-proxy-env-'));
  stateFile = path.join(scratch, 'state', 'browse.json');
  proxy = http.createServer((req, res) => {
    const host = new URL(req.url ?? '/', 'http://unknown').hostname;
    if (host === AUTH_HOST && req.headers['proxy-authorization'] !== AUTH_HEADER) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="gstack-3457"' });
      res.end();
      return;
    }
    proxiedHosts.push(host);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body><p>via proxy for ${host}</p></body></html>`);
  });
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  direct = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><html><body><p>direct loopback page</p></body></html>', { headers: { 'Content-Type': 'text/html' } }) });
});

afterAll(async () => {
  await browse(['stop'], {});
  if (fs.existsSync(stateFile)) {
    try { process.kill(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid, 'SIGKILL'); } catch {}
  }
  try { direct.stop(true); } catch {}
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function browse(args: string[], extraEnv: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(BROWSE_|GSTACK_|NO_PROXY$|no_proxy$|HTTPS?_PROXY$|https?_proxy$|ALL_PROXY$|all_proxy$)/.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: scratch,
    GSTACK_HOME: path.join(scratch, '.gstack'),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'ms-playwright'),
    BROWSE_STATE_FILE: stateFile,
    BROWSE_PARENT_PID: '0',
  }, extraEnv);
  const cli = Bun.spawn([process.execPath, CLI, ...args], { cwd: scratch, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => cli.kill('SIGKILL'), 60_000);
  const [code, stdout, stderr] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr, out: stdout + stderr };
}

const daemonPid = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid as number;

describe.skipIf(process.platform === 'win32')('#915 proxy from the environment, across launch, reuse and restart', () => {
  let firstPid = 0;

  test('launch: HTTP_PROXY routes Chromium through the proxy and names its source once', async () => {
    const r = await browse(['goto', `http://${PROXIED_HOST}/`], { HTTP_PROXY: proxyUrl });
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).toContain(`Starting server with proxy ${proxyUrl}/ from HTTP_PROXY...`);
    expect(proxiedHosts).toContain(PROXIED_HOST);
    const text = await browse(['text'], { HTTP_PROXY: proxyUrl });
    expect(text.stdout).toContain(`via proxy for ${PROXIED_HOST}`);
    firstPid = daemonPid();
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state).toMatchObject({ proxy: `${proxyUrl}/`, proxySource: 'HTTP_PROXY', proxyBypass: 'localhost,127.0.0.1,[::1]' });
  }, 120_000);

  test('reuse: the same environment reuses the daemon, and loopback stays direct', async () => {
    const before = proxiedHosts.length;
    const r = await browse(['goto', `http://127.0.0.1:${direct.port}/`], { http_proxy: proxyUrl });
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).not.toContain('Starting server');
    expect(daemonPid()).toBe(firstPid);
    expect((await browse(['text'], { http_proxy: proxyUrl })).stdout).toContain('direct loopback page');
    expect(proxiedHosts.length).toBe(before);
  }, 120_000);

  test('a NO_PROXY-only change is refused with the variable, both settings and the remedies', async () => {
    const r = await browse(['text'], { HTTP_PROXY: proxyUrl, NO_PROXY: PROXIED_HOST });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('different proxy settings (NO_PROXY differs)');
    expect(r.stderr).toContain(`daemon:  proxy ${proxyUrl}/ from HTTP_PROXY, bypassing localhost,127.0.0.1,[::1]`);
    expect(r.stderr).toContain(`session: proxy ${proxyUrl}/ from HTTP_PROXY, bypassing *.${PROXIED_HOST},${PROXIED_HOST},localhost,127.0.0.1,[::1]`);
    expect(r.stderr).toContain("run 'browse stop'");
    expect(r.stderr).toContain('BROWSER.md#proxy-from-environment');
    expect(daemonPid()).toBe(firstPid);
  }, 120_000);

  test('BROWSE_PROXY_URL=direct against a proxied daemon is refused, naming the variable', async () => {
    const r = await browse(['text'], { HTTP_PROXY: proxyUrl, BROWSE_PROXY_URL: 'direct' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('(HTTP_PROXY differs)');
    expect(r.stderr).toContain('session: no proxy (BROWSE_PROXY_URL=direct)');
    expect(r.stderr).toContain("run 'browse stop'");
  }, 120_000);

  test('restart: after browse stop, the new NO_PROXY applies to the new daemon', async () => {
    expect((await browse(['stop'], {})).code).toBe(0);
    const before = proxiedHosts.length;
    const r = await browse(['goto', `http://${PROXIED_HOST}/`], { HTTP_PROXY: proxyUrl, NO_PROXY: `${PROXIED_HOST},corp.internal` });
    expect(r.stderr).toContain(`Starting server with proxy ${proxyUrl}/ from HTTP_PROXY...`);
    expect(daemonPid()).not.toBe(firstPid);
    expect(r.out).not.toContain(`via proxy for ${PROXIED_HOST}`);
    expect(proxiedHosts.length).toBe(before);
  }, 120_000);

  test('a scheme-less HTTPS_PROXY is the configured http:// proxy (#3440), redacted in the start line and the state', async () => {
    expect((await browse(['stop'], {})).code).toBe(0);
    const r = await browse(['goto', `http://127.0.0.1:${direct.port}/`], { HTTPS_PROXY: 'user:secret@proxy.corp:8080' });
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).toContain('Starting server with proxy http://***:***@proxy.corp:8080/ from HTTPS_PROXY...');
    expect(r.stderr).not.toContain('warning: HTTPS_PROXY is not a proxy URL');
    expect(r.out).not.toContain('secret');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.proxy).toBe('http://***:***@proxy.corp:8080/');
    expect(state.proxySource).toBe('HTTPS_PROXY');
  }, 120_000);

  test('an HTTPS_PROXY that does not parse even as http:// warns and falls back to direct instead of failing', async () => {
    expect((await browse(['stop'], {})).code).toBe(0);
    const before = proxiedHosts.length;
    const r = await browse(['goto', `http://127.0.0.1:${direct.port}/`], { HTTPS_PROXY: 'ftp://user:secret@proxy.corp:21' });
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).toContain('warning: HTTPS_PROXY is not a proxy URL browse can use');
    expect(r.stderr).toContain('BROWSE_PROXY_URL=direct');
    expect(r.out).not.toContain('secret');
    expect(r.stderr).toContain('Starting server...');
    expect(proxiedHosts.length).toBe(before);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).proxy).toBeUndefined();
  }, 120_000);

  // Added by: /ship test coverage audit (Capy), 2026-10-25, for #3440 item 8.
  // Value: protects=the daemon state records BROWSE_PROXY_URL=direct where it bypasses the system proxy settings, and a default session there is refused, not handed the opt-out;
  //   fails_when=server.ts drops proxyDirect from the state, the CLI hash stops carrying the opt-out, or Linux starts refusing a reused daemon over it;
  //   why_new=proxy-env.test.ts drives proxyMismatchLines with a hand-built state; nothing reads the state the daemon wrote or runs the refusal through the CLI;
  //   seam=none; no_claim=Chromium's proxy behaviour (loopback page only); the proxyDirect=true write and the refusal arm run on the macOS named-regressions CI job and on a Windows checkout, the Linux lanes run the reuse arm
  test('BROWSE_PROXY_URL=direct is daemon state where it bypasses the system proxy, and a default session is refused there (#3440)', async () => {
    expect((await browse(['stop'], {})).code).toBe(0);
    const r = await browse(['goto', `http://127.0.0.1:${direct.port}/`], { BROWSE_PROXY_URL: 'direct' });
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).toContain('Starting server...');
    const pid = daemonPid();
    const bypassesSystemProxy = process.platform !== 'linux';
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.proxy).toBeUndefined();
    if (bypassesSystemProxy) expect(state.proxyDirect).toBe(true);
    else expect(state.proxyDirect).toBeUndefined();
    const plain = await browse(['text'], {});
    if (bypassesSystemProxy) {
      expect(plain.code).toBe(1);
      expect(plain.stderr).toContain('different proxy settings (BROWSE_PROXY_URL differs)');
      expect(plain.stderr).toContain('daemon:  no proxy (BROWSE_PROXY_URL=direct)');
      expect(plain.stderr).toContain('session: no proxy');
      expect(plain.stderr).toContain('or set BROWSE_PROXY_URL=direct to use the running daemon without a proxy');
    } else {
      expect(plain.code, plain.out).toBe(0);
      expect(plain.stderr).not.toContain('Starting server');
      expect(plain.stdout).toContain('direct loopback page');
    }
    expect(daemonPid()).toBe(pid);
  }, 120_000);

  test('BROWSE_PROXY_USER/PASS with HTTP_PROXY: the daemon starts and Chromium answers the proxy auth challenge (#3457)', async () => {
    expect((await browse(['stop'], {})).code).toBe(0);
    const env = { HTTP_PROXY: proxyUrl, BROWSE_PROXY_USER: 'proxy-user', BROWSE_PROXY_PASS: 'proxy-secret' };
    const r = await browse(['goto', `http://${AUTH_HOST}/`], env);
    expect(r.code, r.out).toBe(0);
    expect(r.stderr).toContain(`Starting server with proxy ${proxyUrl.replace('http://', 'http://***:***@')}/ from HTTP_PROXY...`);
    expect(r.out).not.toContain('proxy-secret');
    expect(proxiedHosts).toContain(AUTH_HOST);
    expect((await browse(['text'], env)).stdout).toContain(`via proxy for ${AUTH_HOST}`);
  }, 120_000);
});
