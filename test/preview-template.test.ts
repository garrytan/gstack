/**
 * design-review/templates/preview-fixtures.mjs without a browser: the shim in
 * every page, scenarios by header, query or Referer, 501 problem documents
 * that name the route and the file to edit (recorded for the build receipt),
 * declared error fixtures passed through, SPA routes still served, loopback
 * only, an owned port, a private redacted log and a clean stop. The shim
 * itself runs in a VM with stand-in fetch and XHR.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { PREVIEW_TEMPLATE, runPreview, startPreview, type Preview } from './helpers/preview-template';

const ROOT = path.resolve(import.meta.dir, '..');
const PAGE = path.join(ROOT, 'test', 'fixtures', 'ui-spacing', 'preview');
const FIXTURES = path.join(PAGE, 'fixtures');
const tmp: string[] = [];
const live: Preview[] = [];
afterAll(() => { for (const p of live) p.proc.kill(); for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')); tmp.push(d); return d; };

async function begin(extra: string[] = []) {
  const state = tmpDir();
  const p = await startPreview(['--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', '0', '--state', state, ...extra]);
  live.push(p);
  return { ...p, state };
}

describe('preview template: scenarios and the fixture API (T3, T21, T22, T26, T36)', () => {
  test('pages get the shim; API calls are answered by header, ?as= or Referer; anything unsupported is a recorded 501', async () => {
    const p = await begin();
    expect(p.ready).toMatch(/^PREVIEW: ready url=http:\/\/127\.0\.0\.1:\d+\/ mode=static state=\S+ log=\S+preview\.log$/);
    const html = await (await fetch(p.url + '?as=owner')).text();
    expect(html.match(/data-gstack-preview/g)).toHaveLength(1);
    expect(html.indexOf('data-gstack-preview')).toBeLessThan(html.indexOf('<title>'));
    const spa = await fetch(p.url + 'settings/team?as=owner');
    expect([spa.status, (await spa.text()).includes('Who has access')]).toEqual([200, true]);

    const byHeader = await fetch(p.url + 'api/members', { headers: { 'x-gstack-scenario': 'owner' } });
    expect((await byHeader.json()).map((m: { name: string }) => m.name)).toEqual(['Dana Whitfield', 'Omar Haddad', 'Lena Park']);
    expect((await (await fetch(p.url + 'api/members?as=lastowner')).json())).toHaveLength(2);
    expect((await (await fetch(p.url + 'api/members', { headers: { referer: p.url + 'settings?as=lastowner' } })).json())).toHaveLength(2);
    const declared = await fetch(p.url + 'api/members/7', { method: 'DELETE', headers: { 'x-gstack-scenario': 'owner' } });
    expect([declared.status, (await declared.json()).error]).toEqual([409, 'The only owner cannot be removed.']);

    const problems = [
      [await fetch(p.url + 'api/members'), 'PREVIEW_NO_SCENARIO', 'arrived with no scenario'],
      [await fetch(p.url + 'api/members', { headers: { 'x-gstack-scenario': 'nobody' } }), 'PREVIEW_UNKNOWN_SCENARIO', 'scenario "nobody" has no fixture file'],
      [await fetch(p.url + 'api/audit?token=SEKRETSENTINEL', { headers: { referer: p.url + '?as=lastowner&session=REFSENTINEL' } }), 'PREVIEW_UNHANDLED', 'scenario "lastowner" has no route "GET /api/audit"'],
    ] as const;
    for (const [res, code, detail] of problems) {
      expect([code, res.status, res.headers.get('content-type'), res.headers.get('x-gstack-preview')]).toEqual([code, 501, 'application/problem+json', code]);
      const body = await res.json();
      expect(body).toMatchObject({ status: 501, code, type: expect.stringMatching(/howto-preview-a-frontend\.md#preview-/) });
      expect(body.detail).toContain(detail);
    }
    const unhandled = fs.readFileSync(path.join(p.state, 'unhandled.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(unhandled).toEqual([
      { scenario: '', method: 'GET', path: '/api/members', code: 'PREVIEW_NO_SCENARIO' },
      { scenario: 'nobody', method: 'GET', path: '/api/members', code: 'PREVIEW_UNKNOWN_SCENARIO' },
      { scenario: 'lastowner', method: 'GET', path: '/api/audit', code: 'PREVIEW_UNHANDLED' },
    ]);
    const fixLine = (await (await fetch(p.url + 'api/audit?as=lastowner')).json()).fix;
    expect(fixLine).toBe(`add "GET /api/audit": {"status":200,"json":…} to ${path.join(FIXTURES, 'lastowner.json')}`);

    const log = path.join(p.state, 'preview.log');
    expect([fs.statSync(p.state).mode & 0o777, fs.statSync(log).mode & 0o777]).toEqual([0o700, 0o600]);
    const text = fs.readFileSync(log, 'utf8');
    expect(text).toContain('GET /api/audit?token=REDACTED 501 PREVIEW_UNHANDLED scenario=lastowner');
    expect(text).not.toContain('SEKRETSENTINEL');

    const stop = runPreview(['stop', '--state', p.state]);
    expect(stop.out.trim()).toBe(`PREVIEW: stopped port=${p.port}`);
    expect(await p.proc.exited).toBe(0);
    expect(fs.existsSync(path.join(p.state, 'preview.json'))).toBe(false);
    expect(await fetch(p.url).then(() => 'answered', () => 'closed')).toBe('closed');
  }, 30_000);

  test('loopback only, an owned port, and a named failure when the app has no Vite', async () => {
    const p = await begin();
    const taken = runPreview(['start', '--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', String(p.port), '--state', tmpDir()]);
    expect([taken.code, taken.err.trim()]).toEqual([4, `PREVIEW: fail code=PREVIEW_PORT port ${p.port} on 127.0.0.1 is taken | fix: stop whatever holds the port, or pass another --port`]);
    const host = runPreview(['start', '--static', '--root', PAGE, '--fixtures', FIXTURES, '--host', '0.0.0.0']);
    expect([host.code, host.err]).toEqual([3, 'PREVIEW: fail code=PREVIEW_HOST --host 0.0.0.0 is not loopback | fix: the preview listens on 127.0.0.1 only; drop --host\n']);
    const app = tmpDir();
    fs.writeFileSync(path.join(app, 'package.json'), '{"name":"no-vite","private":true}\n');
    const noVite = runPreview(['start', '--root', app, '--fixtures', FIXTURES, '--port', '0', '--state', tmpDir()]);
    expect(noVite.code).toBe(4);
    expect(noVite.err).toStartWith(`PREVIEW: fail code=PREVIEW_NO_VITE no vite package resolves from ${app} | fix: install vite`);
    p.proc.kill('SIGTERM');
    expect(await p.proc.exited).toBe(0);
  }, 30_000);
});

describe('preview template: the shim and the Vite plugin (T3, T21)', () => {
  test('the shim adds x-gstack-scenario to same-origin fetch and XHR only, and keeps ?as= for the tab', async () => {
    const mod = await import(PREVIEW_TEMPLATE);
    const seen: Array<[string, string | null]> = [];
    const store = new Map<string, string>();
    class FakeXHR { headers: Record<string, string> = {}; open(_m: string, _u: string) {} send() { seen.push(['xhr', this.headers['x-gstack-scenario'] ?? null]); } setRequestHeader(k: string, v: string) { this.headers[k] = v; } }
    const ctx = (search: string) => {
      const window: Record<string, unknown> = {
        location: { search, href: 'http://127.0.0.1:5300/settings' + search, origin: 'http://127.0.0.1:5300' },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
        fetch: async (u: string, init?: { headers?: Headers }) => { seen.push([u, init?.headers?.get('x-gstack-scenario') ?? null]); return 'ok'; },
        XMLHttpRequest: FakeXHR, URL, URLSearchParams, Headers,
      };
      window.window = window;
      vm.runInNewContext(mod.SHIM, { ...window, window });
      return window;
    };
    const w = ctx('?as=lastowner');
    await (w.fetch as (u: string) => Promise<unknown>)('/api/members');
    await (w.fetch as (u: string) => Promise<unknown>)('https://api.example.com/x');
    const x = new (w.XMLHttpRequest as typeof FakeXHR)();
    x.open('GET', '/api/audit');
    x.send();
    const later = ctx('');
    await (later.fetch as (u: string) => Promise<unknown>)('/api/members');
    expect(seen).toEqual([['/api/members', 'lastowner'], ['https://api.example.com/x', null], ['xhr', 'lastowner'], ['/api/members', 'lastowner']]);
  });

  test('the plugin prepends the shim and mounts the fixture API on the dev server', async () => {
    const mod = await import(PREVIEW_TEMPLATE);
    const plugin = mod.gstackPreviewFixtures({ fixtures: FIXTURES });
    expect(plugin.name).toBe('gstack-preview-fixtures');
    expect(plugin.transformIndexHtml()).toEqual([{ tag: 'script', attrs: { 'data-gstack-preview': '' }, children: mod.SHIM, injectTo: 'head-prepend' }]);
    const used: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    plugin.configureServer({ middlewares: { use: (fn: (typeof used)[number]) => used.push(fn) } });
    let status = 0;
    let body = '';
    let passed = false;
    used[0]!({ url: '/api/members', method: 'GET', headers: { 'x-gstack-scenario': 'owner' }, resume() {} }, { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } }, () => { passed = true; });
    expect([status, JSON.parse(body).length, passed]).toEqual([200, 3, false]);
    used[0]!({ url: '/src/main.ts', method: 'GET', headers: {} }, {}, () => { passed = true; });
    expect(passed).toBe(true);
    expect(mod.redact('http://u:p@h/x?api_key=a)b&ok=1#sig=c')).toBe('http://h/x?api_key=REDACTED&ok=1#sig=REDACTED');
  });
});
