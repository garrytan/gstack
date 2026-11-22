/**
 * The app profile measured (gstack-design-lint --scope app, GST-1741 PR 1):
 * the qm#3186 replica and its variants (other markup, open, slotted, nested and
 * closed shadow roots, rows that load late), the fixed copy, the negative
 * controls, the threshold boundaries at +-0.5px, and the false-positive
 * corpus. Fixtures are served from a loopback server, so every state goes
 * through the URL path the CLI takes. Skipped with a named reason when no
 * browser is available, except in CI, where a missing browser fails.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pickEngine, resolveBrowseBin, type EngineChoice } from '../lib/aside-render';
import { lintApp, type AppOptions, type AppResult } from '../lib/design-lint/render-app';
import { asideAvailable } from './helpers/aside-available';
import { browserAvailable, NO_BROWSER_REASON } from './helpers/browser-available';

const ROOT = path.resolve(import.meta.dir, '..');
const FIX = 'test/fixtures/ui-spacing';
const hasBrowser = browserAvailable();
if (!hasBrowser && process.env.CI) throw new Error('design-lint-app-profile: CI needs a browser for the app profile tier: ' + NO_BROWSER_REASON);
if (!hasBrowser) process.stderr.write('design-lint-app-profile: SKIPPED — ' + NO_BROWSER_REASON + '\n');

const engine = (): EngineChoice => {
  if (asideAvailable()) return pickEngine(true);
  const bin = resolveBrowseBin();
  return bin ? { engine: 'browse', bin } : { engine: null, probe: { ok: false, reason: 'NEEDS_ASIDE', detail: NO_BROWSER_REASON }, error: NO_BROWSER_REASON };
};

const FOUR = ['copy-flush-under-list', 'note-in-row-weight', 'row-crowding', 'small-hit-area'];
const gen = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-app-gen-'));
let base = '';
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  if (!hasBrowser) return;
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname);
      const file = rel.startsWith('/gen/') ? path.join(gen, rel.slice(5)) : path.join(ROOT, rel);
      const inside = file.startsWith(gen + path.sep) || file.startsWith(ROOT + path.sep);
      if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file));
    },
  });
  base = 'http://127.0.0.1:' + server.port;
});
afterAll(() => { server?.stop(true); fs.rmSync(gen, { recursive: true, force: true }); });

async function measure(page: string, within: string, more: Partial<AppOptions> = {}): Promise<AppResult & { ids: string[] }> {
  const url = page.startsWith('/') ? base + page : base + '/' + FIX + '/' + page;
  const r = await lintApp({ states: [{ name: page, url }], within, engine, traceDir: gen, ...more });
  return { ...r, ids: [...new Set(r.findings.filter((f) => f.grade !== 'waived').map((f) => f.rule))].sort() };
}

const genPage = (name: string, css: string, body: string): string => {
  fs.writeFileSync(path.join(gen, name), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + name + '</title><style>* { box-sizing: border-box } body { margin: 0; font: 14px/20px system-ui, sans-serif; color: #1d2433 } main { max-width: 640px; margin: 0 auto; padding: 24px 16px } ' + css + '</style></head><body><main><section class="probe">' + body + '</section></main></body></html>');
  return '/gen/' + name;
};

describe.skipIf(!hasBrowser)('app profile: the replica and its variants', () => {
  test('the replica reports exactly row-crowding, copy-flush-under-list, note-in-row-weight and small-hit-area; open, exit 1', async () => {
    const r = await measure('replica.html', '.sharing');
    expect(r.ids).toEqual(FOUR);
    expect([r.app.verdict, r.exitCode, r.app.matched, r.app.states.map((s) => s.status)]).toEqual(['open', 1, 1, ['measured', 'measured']]);
    const crowd = r.findings.find((f) => f.rule === 'row-crowding')!;
    expect(crowd.evidence).toMatch(/^\[replica\.html 1440px\] a 2-line row leaves 4px between its text and its top edge \(under 8px\) at .*div\.rows:nth-of-type\(1\) > div\.row:nth-of-type\(1\) "Deploy key Read-only access to the repos"$/);
    expect(crowd.app).toMatchObject({ state: 'replica.html', viewport: '1440x900', measured: 4, threshold: 8 });
    const hit = r.findings.find((f) => f.rule === 'small-hit-area')!;
    expect([hit.app!.viewport, hit.app!.measured, hit.app!.threshold, hit.app!.locator]).toEqual(['375x812', 18, 32, expect.stringContaining('button.x "Remove')]);
    expect(r.findings.filter((f) => f.rule === 'small-hit-area').every((f) => f.app!.viewport === '375x812')).toBe(true);
    expect(r.findings.filter((f) => f.rule === 'copy-flush-under-list').map((f) => f.app!.measured)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(new Set(r.findings.map((f) => f.app!.viewport + f.app!.locator + f.rule)).size).toBe(r.findings.length);
  }, 60_000);

  test('the fixed copy is clean, exit 0', async () => {
    const r = await measure('fixed.html', '.sharing');
    expect([r.findings, r.app.verdict, r.exitCode]).toEqual([[], 'clean', 0]);
  }, 60_000);

  test("the replica's defects in other markup (ul/li, a grid per row, renamed classes, no test hooks) give the same four ids", async () => {
    expect(fs.readFileSync(path.join(ROOT, FIX, 'structural.html'), 'utf8')).not.toContain('data-testid');
    expect((await measure('structural.html', '.settings-sharing')).ids).toEqual(FOUR);
  }, 60_000);

  test('open, slotted and nested shadow roots match the light DOM; a closed one is incomplete CLOSED_SHADOW, exit 4', async () => {
    for (const [page, within] of [['shadow-open.html', 'qm-sharing'], ['shadow-slotted.html', 'qm-card'], ['nested-shadow.html', '.sharing']]) {
      const r = await measure(page, within);
      expect([page, r.ids, r.app.verdict]).toEqual([page, FOUR, 'open']);
    }
    const open = await measure('shadow-open.html', 'qm-sharing');
    expect(open.findings[0].app!.locator).toStartWith('qm-sharing >>> ');
    const closed = await measure('shadow-closed.html', 'qm-sharing');
    expect([closed.app.verdict, closed.app.code, closed.exitCode, closed.findings]).toEqual(['incomplete', 'CLOSED_SHADOW', 4, []]);
  }, 120_000);

  test('rows that load 800ms late are measured once ready and match the replica; rows that never load are NOT_READY', async () => {
    const late = await measure('async.html', '.sharing');
    expect([late.ids, late.app.verdict]).toEqual([FOUR, 'open']);
    const replica = await measure('replica.html', '.sharing');
    expect(late.findings.map((f) => f.rule + f.app!.viewport + f.app!.measured)).toEqual(replica.findings.map((f) => f.rule + f.app!.viewport + f.app!.measured));
    const never = await measure('never-ready.html', '.sharing', { readyMs: 1_500 });
    expect([never.app.code, never.exitCode, never.app.states[0].detail]).toEqual(['NOT_READY', 4, 'no list of two or more rows appeared inside .sharing within 2s']);
  }, 90_000);

  test('a section nothing matches is WITHIN_NO_MATCH naming the roots searched; a state whose expect selector is absent is STATE_MISMATCH', async () => {
    const none = await measure('shadow-open.html', '.no-such-section', { sectionWaitMs: 1_000, readyMs: 500 });
    expect([none.app.code, none.app.matched, none.app.states[0].detail]).toEqual(['WITHIN_NO_MATCH', 0, 'nothing matched .no-such-section in the document or its 1 open shadow roots']);
    const url = base + '/' + FIX + '/replica.html?as=lastowner';
    const wrong = await lintApp({ states: [{ name: 'lastowner', url, expect: '.only-owner-note' }], within: '.sharing', engine, readyMs: 1_000 });
    expect([wrong.app.code, wrong.exitCode]).toEqual(['STATE_MISMATCH', 4]);
    const right = await lintApp({ states: [{ name: 'owner', url, expect: '.sharing .row' }], within: '.sharing', engine });
    expect(right.app.verdict).toBe('open');
  }, 90_000);
});

describe.skipIf(!hasBrowser)('app profile: what must not fire', () => {
  test('plain role labels beside names are never notes; a note louder than its name is', async () => {
    const reader = await measure('reader.html', '.members');
    expect(reader.findings.filter((f) => f.rule === 'note-in-row-weight')).toEqual([]);
    expect(reader.app.verdict).toBe('clean');
    expect((await measure('larger-note.html', '.integrations')).ids).toEqual(['note-in-row-weight']);
  }, 60_000);

  test('a list of one row is not a list; a three-line note on a phone only is not note-in-row-weight', async () => {
    const one = await measure('one-row.html', '.credentials', { waitFor: '.credentials' });
    expect([one.findings, one.app.verdict]).toEqual([[], 'clean']);
    const phone = await measure('mobile-note.html', '.channels');
    expect([phone.findings, phone.app.verdict]).toEqual([[], 'clean']);
  }, 60_000);

  test('a defect outside --within is not reported; the same section measured directly is', async () => {
    const page = genPage('outside.html', '.list { border: 1px solid #dfe3ea } .row { padding: 3px 12px } .row + .row { border-top: 1px solid #dfe3ea } .row p { margin: 0 } .row p + p { color: #6b7385; font-size: 13px } .ok .row { padding: 10px 12px } .ok + .bad { margin-top: 24px }',
      '<div class="ok"><div class="list"><div class="row"><p>Deploy key</p><p>Read-only access</p></div><div class="row"><p>Registry token</p><p>Pushes images</p></div></div></div>'
      + '<div class="bad"><div class="list"><div class="row"><p>Deploy key</p><p>Read-only access</p></div><div class="row"><p>Registry token</p><p>Pushes images</p></div></div></div>');
    const inside = await measure(page, '.ok');
    expect([inside.findings, inside.app.verdict]).toEqual([[], 'clean']);
    expect((await measure(page, '.bad')).ids).toEqual(['row-crowding']);
  }, 60_000);

  test('small-hit-area counts an input\'s label toward its box and skips a link inside a run of text; a bare 16px checkbox fires', async () => {
    const page = genPage('targets.html', '.list { border: 1px solid #dfe3ea } .row { display: flex; gap: 8px; align-items: center; padding: 10px 12px } .row + .row { border-top: 1px solid #dfe3ea } .row p { margin: 0 } label.big { display: flex; align-items: center; gap: 8px; min-height: 40px } input { width: 16px; height: 16px; margin: 0 }',
      '<div class="list"><div class="row"><label class="big"><input type="checkbox"> Notify me</label></div>'
      + '<div class="row"><p>Read the <a href="#policy">sharing policy</a> before adding people.</p></div>'
      + '<div class="row"><p>Mute</p><input type="checkbox" aria-label="Mute"></div></div>');
    const r = await measure(page, '.probe');
    expect(r.findings.map((f) => [f.rule, f.app!.viewport, f.app!.locator])).toEqual([['small-hit-area', '375x812', expect.stringMatching(/input "Mute"$/)]]);
  }, 60_000);

  test('negative controls with trigger bait: a nav list, a table, a card grid and a list spaced right give zero app findings', async () => {
    const r = await measure('negatives.html', '.negatives');
    expect([r.findings, r.app.verdict, r.exitCode]).toEqual([[], 'clean', 0]);
  }, 60_000);
});

describe.skipIf(!hasBrowser)('app profile: thresholds at +-0.5px', () => {
  const rows = (pad: string, css = '') => genPage('rows-' + pad.replace(/\W/g, '_') + css.length + '.html',
    '.list { border: 1px solid #dfe3ea } .row + .row { border-top: 1px solid #dfe3ea } .row { padding: ' + pad + ' } .row p { margin: 0 } .help { margin: 0 } button { width: 40px; height: 40px } ' + css,
    '<div class="list"><div class="row"><p>Deploy key</p><p>Read-only access to the repository</p></div><div class="row"><p>Registry token</p><p>Pushes release images</p></div></div><p class="help" style="margin-top: 20px">Credentials are encrypted at rest.</p>');
  const at = async (page: string, rule: string) => (await measure(page, '.probe')).findings.filter((f) => f.rule === rule).map((f) => f.app!.measured);

  test('row-crowding: 7.5px to a drawn edge fires, 8.5px does not', async () => {
    expect([...new Set(await at(rows('7.5px 12px'), 'row-crowding'))]).toEqual([7.5]);
    expect(await at(rows('8.5px 12px'), 'row-crowding')).toEqual([]);
  }, 60_000);

  test('row-crowding: layout subpixel noise never fires (7.97px does not), 7.9px does', async () => {
    expect(await at(rows('7.97px 12px'), 'row-crowding')).toEqual([]);
    expect((await at(rows('7.9px 12px'), 'row-crowding')).length).toBeGreaterThan(0);
  }, 60_000);

  test('row-crowding reads an unboxed list of laid-out rows (avatar, text and control side by side); an unboxed list of prose items stays prose', async () => {
    const people = genPage('people-unboxed.html',
      '.row { display: flex; align-items: center; gap: 10px; padding: 4px 0 } .av { width: 28px; height: 28px; border-radius: 14px; background: #dbe7f0; flex: none } .text { flex: 1 } .text div { margin: 0 } button { width: 80px; height: 32px; flex: none } .help { margin: 24px 0 0 }',
      '<div class="list"><div class="row"><span class="av"></span><div class="text"><div>Dana Whitfield</div><div>Can\'t use personas until an admin turns them on</div></div><button>Can chat</button></div><div class="row"><span class="av"></span><div class="text"><div>Design team</div><div>Personas is off for the organization</div></div><button>Can chat</button></div></div><p class="help">Owners change who has access.</p>');
    const crowded = await at(people, 'row-crowding');
    expect(crowded.length).toBeGreaterThan(0);
    expect(crowded.every((m) => m < 16)).toBe(true);
    const prose = genPage('prose-unboxed.html', 'ul { margin: 0; padding-left: 20px } li { margin: 0 0 4px } .help { margin: 24px 0 0 }',
      '<ul><li>Read the docs before you start, then run the setup script once on each machine you use</li><li>Keep the token out of the repository and rotate it when someone leaves the team</li></ul><p class="help">Questions go to the platform channel.</p>');
    expect(await at(prose, 'row-crowding')).toEqual([]);
  }, 60_000);

  test('row-crowding: 15.5px from a two-line row\'s text to the next row\'s fires, 16.5px does not', async () => {
    const pair = (next: number) => genPage('next-' + next + '.html',
      '.list { border: 1px solid #dfe3ea } .row { padding: 8px 12px } .row p { margin: 0 } .row + .row { padding-top: ' + next + 'px }',
      '<div class="list"><div class="row"><p>Deploy key</p><p>Read-only access to the repository</p></div><div class="row"><p>Registry token</p></div></div>');
    expect(await at(pair(7.5), 'row-crowding')).toEqual([15.5, 15.5]);
    expect(await at(pair(8.5), 'row-crowding')).toEqual([]);
  }, 60_000);

  test('copy-flush-under-list: 11.5px fires, 12.5px does not', async () => {
    const help = (gap: number) => genPage('help-' + gap + '.html',
      '.list { border: 1px solid #dfe3ea } .row { padding: 10px 12px } .row + .row { border-top: 1px solid #dfe3ea } .row p { margin: 0 } .help { margin: ' + gap + 'px 0 0 }',
      '<div class="list"><div class="row"><p>Deploy key</p></div><div class="row"><p>Registry token</p></div></div><p class="help">Credentials are encrypted at rest.</p>');
    expect(await at(help(11.5), 'copy-flush-under-list')).toEqual([11.5, 11.5]);
    expect(await at(help(12.5), 'copy-flush-under-list')).toEqual([]);
  }, 60_000);

  test('small-hit-area at 375 only: 31.5px fires, 32.5px does not', async () => {
    const hit = (side: number) => genPage('hit-' + side + '.html',
      '.list { border: 1px solid #dfe3ea } .row { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px } .row + .row { border-top: 1px solid #dfe3ea } .row p { margin: 0 } button { width: ' + side + 'px; height: 40px; padding: 0 }',
      '<div class="list"><div class="row"><p>Deploy key</p><button aria-label="Remove">×</button></div><div class="row"><p>Registry token</p><button aria-label="Remove">×</button></div></div><p class="help" style="margin-top: 16px">Credentials are encrypted at rest.</p>');
    const small = (await measure(hit(31.5), '.probe')).findings;
    expect(small.map((f) => [f.rule, f.app!.viewport, f.app!.measured])).toEqual([['small-hit-area', '375x812', 31.5], ['small-hit-area', '375x812', 31.5]]);
    expect(await at(hit(32.5), 'small-hit-area')).toEqual([]);
  }, 60_000);
});

describe.skipIf(!hasBrowser)('app profile: the false-positive corpus (decision 6, T10)', () => {
  test('zero app findings on all pages but one, and at most one on that page', async () => {
    const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, FIX, 'corpus.json'), 'utf8')) as { pages: Array<{ path: string; within: string; waitFor: string }> };
    expect(corpus.pages.length).toBeGreaterThanOrEqual(10);
    const counts: Array<[string, number, string]> = [];
    for (const p of corpus.pages) {
      const r = await measure('/' + p.path, p.within, { waitFor: p.waitFor });
      counts.push([p.path, r.findings.length, r.app.verdict === 'incomplete' ? r.app.code : 'measured']);
    }
    expect(counts.filter(([, , status]) => status !== 'measured')).toEqual([]);
    const withAny = counts.filter(([, n]) => n > 0);
    expect(withAny.length).toBeLessThanOrEqual(1);
    expect(withAny.every(([, n]) => n <= 1)).toBe(true);
  }, 300_000);
});

describe.skipIf(!hasBrowser)('app profile: the CLI end to end', () => {
  /** Asynchronous on purpose: the fixture server runs in this process, and a synchronous spawn would block it from answering. */
  async function runBin(args: string[]): Promise<{ code: number; out: string }> {
    const child = Bun.spawn([path.join(ROOT, 'bin', 'gstack-design-lint'), ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
    const out = await new Response(child.stdout).text();
    return { code: await child.exited, out };
  }

  test('the documented invocation prints the four ids, the LINT_APP line and exits 1; --json carries the app block', async () => {
    const url = base + '/' + FIX + '/replica.html';
    const text = await runBin(['--scope', 'app', '--url', url, '--within', '.sharing', '--viewport', '1440x900', '--viewport', '375x812']);
    const out = text.out;
    expect(text.code).toBe(1);
    expect([...new Set(out.split('\n').filter((l) => l.startsWith('LINT: ')).map((l) => l.split(' ')[2]))].sort()).toEqual(FOUR);
    expect(out.trim().split('\n').slice(-2)).toEqual([expect.stringMatching(/^LINT_SUMMARY: blocks=0 ask=25 waived=0 polish=0 render=ran$/), 'LINT_APP: verdict=open code=OPEN states=1/1 viewports=1440x900,375x812 within=.sharing matched=1 open=25 waived=0']);
    const json = await runBin(['--scope', 'app', '--url', url, '--within', '.sharing', '--json']);
    const doc = JSON.parse(json.out);
    expect([json.code, doc.app.verdict, doc.app.states.length, doc.findings[0].app.threshold]).toEqual([1, 'open', 2, expect.any(Number)]);
  }, 120_000);
});
