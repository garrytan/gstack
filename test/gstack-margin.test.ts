import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-margin');

// ── Stub Margin server ──────────────────────────────────────────────────────
// Implements just the four endpoints gstack-margin calls, records each request,
// and lets the helper run fully offline (MARGIN_URL points here).
type Req = { method: string; path: string; auth: string | null; body: any };
let server: ReturnType<typeof Bun.serve>;
let base: string;
let seen: Req[] = [];
const DOC = 'plan-stub-1234';
const TOKEN = 'agenttoken-secret';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: any = null;
      if (req.method === 'POST') { try { body = await req.json(); } catch { body = null; } }
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body });
      const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

      if (req.method === 'POST' && url.pathname === '/api/docs')
        return json({ doc_id: DOC, version: 1, agent_token: TOKEN, reviewer_url: `${base}/d/${DOC}?token=reviewertok` });
      if (req.method === 'POST' && url.pathname === `/api/docs/${DOC}/publish`)
        return json({ doc_id: DOC, version: 2 });
      if (req.method === 'GET' && url.pathname === `/api/docs/${DOC}/comments`)
        return json({ docId: DOC, title: 'x', version: 2, threads: [{ id: 'c_1', body: 'tighten this', anchor: { quote: 'foo' } }] });
      if (req.method === 'POST' && url.pathname === `/api/docs/${DOC}/comments/c_1/status`)
        return json({ ok: true });
      return json({ error: 'not found' }, 404);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

let home: string;
// Drive the helper asynchronously (Bun.spawn, not spawnSync): the stub server's
// fetch handler runs on this same JS thread, so a synchronous spawn would block
// the event loop and deadlock against the subprocess's curl.
async function run(args: string[]): Promise<{ status: number; stdout: string }> {
  const proc = Bun.spawn([BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: home, MARGIN_URL: base },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const status = await proc.exited;
  return { status, stdout };
}
function credFile(): string | null {
  const projects = path.join(home, 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const slug of fs.readdirSync(projects)) {
    for (const f of fs.readdirSync(path.join(projects, slug))) {
      if (f.startsWith('margin-') && f.endsWith('.json')) return path.join(projects, slug, f);
    }
  }
  return null;
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-margin-')); seen = []; });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('gstack-margin', () => {
  test('usage errors exit 2', async () => {
    expect((await run(['publish'])).status).toBe(2);          // missing html file
    expect((await run(['bogus'])).status).toBe(2);            // unknown command
  });

  test('status / url before any publish', async () => {
    expect((await run(['url'])).stdout.trim()).toBe('');
    const s = await run(['status']);
    expect(s.status).toBe(0);
    expect(s.stdout).toContain('yet');
  });

  test('comments before publish exits 3 (no doc)', async () => {
    expect((await run(['comments'])).status).toBe(3);
  });

  test('publish creates a doc, caches a 0600 token, prints reviewer url', async () => {
    const html = path.join(home, 'p.html');
    fs.writeFileSync(html, '<h1>plan</h1>');
    const r = await run(['publish', html, '--title', 'T']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${base}/d/${DOC}?token=reviewertok`);

    // First call hit create (no auth), not revise.
    expect(seen.filter(s => s.path === '/api/docs').length).toBe(1);
    expect(seen[0].auth).toBeNull();

    // Token cached privately and NEVER printed.
    const cf = credFile()!;
    expect(cf).toBeTruthy();
    expect((fs.statSync(cf).mode & 0o777)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(cf, 'utf-8')).agent_token).toBe(TOKEN);
    expect(r.stdout).not.toContain(TOKEN);
  });

  test('second publish revises the SAME doc with bearer auth (stable link)', async () => {
    const html = path.join(home, 'p.html');
    fs.writeFileSync(html, '<h1>plan</h1>');
    const first = (await run(['publish', html])).stdout.trim();
    seen = [];
    const second = (await run(['publish', html, '--summary', 'round 2'])).stdout.trim();
    expect(second).toBe(first);                              // link unchanged
    const calls = seen.filter(s => s.method === 'POST');
    expect(calls.some(s => s.path === '/api/docs')).toBe(false);   // no new create
    const revise = calls.find(s => s.path === `/api/docs/${DOC}/publish`)!;
    expect(revise).toBeTruthy();
    expect(revise.auth).toBe(`Bearer ${TOKEN}`);
    expect(revise.body.summary).toBe('round 2');
  });

  test('comments + resolve use the cached bearer', async () => {
    const html = path.join(home, 'p.html');
    fs.writeFileSync(html, '<h1>plan</h1>');
    await run(['publish', html]);
    const c = await run(['comments']);
    expect(c.status).toBe(0);
    expect(JSON.parse(c.stdout).threads[0].id).toBe('c_1');

    seen = [];
    const res = await run(['resolve', 'c_1']);
    expect(res.status).toBe(0);
    const statusCall = seen.find(s => s.path === `/api/docs/${DOC}/comments/c_1/status`)!;
    expect(statusCall.auth).toBe(`Bearer ${TOKEN}`);
    expect(statusCall.body.status).toBe('resolved');
  });
});
