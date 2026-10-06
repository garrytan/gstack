/**
 * D2 (#2811): redirects and page-driven navigations to link-local or metadata
 * addresses are refused, not only explicit `goto` targets. Commands run the way
 * server.ts runs write commands: through BrowserManager.failIfNavigationBlocked.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';

let bm: BrowserManager;
let server: ReturnType<typeof Bun.serve>;
let base: string;

const LINK_LOCAL = 'http://169.254.170.2/v2/credentials';
const MAPPED = 'http://[::ffff:169.254.170.2]/v2/credentials';
// Port 1 is unsafe in Chromium, so this blocked target fails at once (ERR_UNSAFE_PORT)
// and commits its error page around the guard's reset, as CI's mapped-address hop did.
const FAST_FAIL = 'http://[::ffff:169.254.170.2]:1/v2/credentials';

beforeAll(async () => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname === '/to-link-local') return Response.redirect(LINK_LOCAL, 302);
      if (url.pathname === '/to-mapped') return Response.redirect(MAPPED, 302);
      if (url.pathname === '/to-fast-fail') return Response.redirect(FAST_FAIL, 302);
      if (url.pathname === '/to-safe') return Response.redirect(`${base}/safe`, 302);
      if (url.pathname === '/link') return html(`<a id="go" href="${LINK_LOCAL}">go</a>`);
      if (url.pathname === '/script') return html(`<button id="go" onclick="location.href='${LINK_LOCAL}'">go</button>`);
      return html('<p id="ok">safe page</p>');
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { server.stop(true); } catch {}
  try { await Promise.race([bm?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]); } catch {}
});

function run(command: string, args: string[]): Promise<string> {
  const session = bm.getActiveSession();
  return bm.failIfNavigationBlocked(session.getPage(), handleWriteCommand(command, args, session, bm));
}

// While Bun's promise matchers (rejects/resolves) wait, each Playwright round-trip takes
// about a second, which pushed the 5 s click timeout past the guard's block under load.
// Settle the command first, then assert on the refusal.
async function refusal(command: string, args: string[]): Promise<string> {
  try {
    await run(command, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`${command} ${args.join(' ')} was not refused`);
}

describe('D2: navigation guard', () => {
  test('a redirect to 169.254.0.0/16 fails the goto and leaves the tab blank', async () => {
    expect(await refusal('goto', [`${base}/to-link-local`])).toMatch(/169\.254\.170\.2 is a cloud metadata or link-local address/);
    expect(bm.getActiveSession().getPage().url()).toBe('about:blank');
  }, 30_000);

  test('a redirect to an IPv4-mapped IPv6 link-local address is refused too', async () => {
    expect(await refusal('goto', [`${base}/to-mapped`])).toMatch(/cloud metadata or link-local/);
    expect(bm.getActiveSession().getPage().url()).toBe('about:blank');
  }, 30_000);

  test('a blocked target that fails at once still leaves the tab blank for the next command', async () => {
    expect(await refusal('goto', [`${base}/to-fast-fail`])).toMatch(/cloud metadata or link-local/);
    expect(bm.getActiveSession().getPage().url()).toBe('about:blank');
    const result = await run('goto', [`${base}/safe`]);
    expect(result).toContain('Navigated to');
    expect(bm.getActiveSession().getPage().url()).toBe(`${base}/safe`);
  }, 30_000);

  test('clicking a link to a link-local address is refused', async () => {
    await run('goto', [`${base}/link`]);
    expect(await refusal('click', ['#go'])).toMatch(/cloud metadata or link-local/);
    expect(bm.getActiveSession().getPage().url()).toBe('about:blank');
  }, 30_000);

  test('a script-driven navigation to a link-local address is refused', async () => {
    await run('goto', [`${base}/script`]);
    expect(await refusal('click', ['#go'])).toMatch(/cloud metadata or link-local/);
    expect(bm.getActiveSession().getPage().url()).toBe('about:blank');
  }, 30_000);

  test('ordinary redirects and the next command still work after a block', async () => {
    const result = await run('goto', [`${base}/to-safe`]);
    expect(result).toContain('Navigated to');
    expect(bm.getActiveSession().getPage().url()).toBe(`${base}/safe`);
  }, 30_000);
});

test('live browser commands settle before the refusal is asserted', () => {
  const source = readFileSync(import.meta.path, 'utf8');
  expect(source).not.toMatch(new RegExp(['expect\\(', 'run\\('].join('')));
  expect(source).not.toMatch(new RegExp(['\\.', 'rejects'].join('')));
});
