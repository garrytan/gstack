/**
 * The fifth review cycle's regressions: the last comment-blanked reader, hostile inputs that stayed quadratic or blew
 * the stack (a digit run, 699k rules, unclosed JSX, thousands of tracked labels), per-sheet waivers, the render tier
 * holding its measured findings against every wrong-shaped field, and the rule judgements the design pass asked for.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderResult, RenderSpec } from '../lib/aside-render';
import { parseDoc } from '../lib/design-lint/html';
import { lint } from '../lib/design-lint/index';
import { lintRender, type Runner } from '../lib/design-lint/render';
import { formatFinding, Reporter, type Finding } from '../lib/design-lint/report';
import { lintStatic, MAX_FILE_BYTES, resolveRef } from '../lib/design-lint/static';
import { twDataText } from '../lib/design-lint/tailwind';
import { FLOOR_REFUSAL, resolveWaivers } from '../lib/design-lint/waivers';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const TOKENS = ':root { --color-paper: oklch(97% 0.01 80); --color-ink: oklch(20% 0.02 250); --color-accent: oklch(50% 0.16 30); --color-accent-ink: oklch(98% 0.01 30); --color-muted: oklch(50% 0.02 250); --font-display: "Literata", serif; --font-body: "Public Sans", sans-serif; }';
const HEAD = '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Harbour office</title><meta name="description" content="A test page."><link rel="icon" href="data:,">\n';
const page = (css: string, body: string): string => HEAD + '<style>\n' + TOKENS + '\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-cycle5-'));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const quiet = { warn: () => {} };
const run = (html: string, files: Record<string, string> = {}): Finding[] => { const dir = tree({ 'index.html': html, ...files }); return lintStatic([dir], { cwd: dir, ...quiet }).findings; };
const only = (f: Finding[], rule: string) => f.filter((x) => x.rule === rule);
const timed = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };
// A linearity check measures the lint's own CPU time, fastest of three runs: wall time on a loaded shard carries scheduling waits that are not the lint's cost.
const cpuTimed = (fn: () => void): number => { const c = process.cpuUsage(); fn(); const d = process.cpuUsage(c); return (d.user + d.system) / 1000; };
const fastest = (fn: () => void, trials = 3): number => Math.min(...Array.from({ length: trials }, () => cpuTimed(fn)));

describe('design-lint fifth cycle: dead markup and hostile inputs', () => {
  test('an emoji placeholder inside an HTML comment is dead', () => {
    const f = run(page('', '<main><h1>Hi there</h1><p>Text.</p>\n<!-- <input placeholder="🚀 Search"> -->\n</main>'));
    expect(only(f, 'emoji-decoration')).toEqual([]);
    const live = run(page('', '<main><h1>Hi there</h1><form><input placeholder="🚀 Search"></form></main>'));
    expect(only(live, 'emoji-decoration').length).toBe(1);
  });

  test('a long digit run, a long mono word and a run of scheme prefixes each cost their length', () => {
    const dir = tree({ 'index.html': page('', '<main><h1>Hi there</h1><p>' + '7'.repeat(200_000) + '</p><p>' + 'https://'.repeat(20_000) + '</p></main>') });
    expect(timed(() => lintStatic([dir], { cwd: dir, ...quiet }))).toBeLessThan(4000);
    expect(timed(() => twDataText('a'.repeat(400_000)))).toBeLessThan(500);
  });

  test('a 2 MB stylesheet of 699k rules lints instead of blowing the stack', () => {
    const dir = tree({ 'big.css': 'a{}'.repeat(Math.floor(MAX_FILE_BYTES / 3) - 1), 'index.html': HEAD + '<link rel="stylesheet" href="big.css"></head><body><main><h1>Hello there</h1><p>Body.</p></main></body></html>' });
    expect(() => lintStatic([dir], { cwd: dir, ...quiet })).not.toThrow();
  });

  test('a JSX file of unclosed elements parses in linear time', () => {
    const times = [5000, 10000].map((n) => timed(() => parseDoc('Page.tsx', 'export default function P(){ return (<div>' + '<Card className="p-4">text\n'.repeat(n) + '</div>); }')));
    expect(times[1]).toBeLessThan(Math.max(times[0] * 3, 300));
    expect(times[1]).toBeLessThan(4000);
  });

  test('a page of many tracked-caps labels lints in linear time and a well-formed JSX file still yields its classes', () => {
    const times = [4000, 8000].map((n) => { const dir = tree({ 'index.html': page('', '<main><h1>Hello world</h1>' + '<span class="text-xs uppercase tracking-widest">Label one</span>\n'.repeat(n) + '</main>') }); return fastest(() => lintStatic([dir], { cwd: dir, ...quiet })); });
    expect(times[1]).toBeLessThan(Math.max(times[0] * 2.5, 500));
    const doc = parseDoc('Page.tsx', 'export default function P(){ return (<div className="p-4"><Card className="rounded-xl">x</Card></div>); }');
    expect(doc.classAt.size + doc.virtuals.length).toBeGreaterThan(0);
  });

  test('a fact after an inline close tag is counted in its own section', () => {
    const sec = (i: number) => '<section><h2>S' + i + '</h2><p><strong>Price:</strong> $5 a month</p></section>';
    const f = run(page('', '<main><h1>Hi there</h1>' + [0, 1, 2, 3].map(sec).join('') + '</main>'));
    expect(only(f, 'repeated-fact').length).toBe(1);
  });

  test('a relative stylesheet href that climbs out of the project attaches nothing; inside the project it attaches', () => {
    const dir = tree({ 'site/package.json': '{}', 'site/pages/index.html': HEAD + '<link rel="stylesheet" href="../../outside.css"></head><body><main><h1>t</h1><p>Body.</p></main></body></html>', 'outside.css': 'html, body { overflow-x: clip; }' });
    const r = lintStatic([path.join(dir, 'site')], { cwd: dir, ...quiet });
    expect(r.contexts[0].cssFiles).toEqual([]);
    expect(only(r.findings, 'overflow-x-unclipped').length).toBe(1);
    expect(resolveRef('css/site.css', path.join(dir, 'site'), path.join(dir, 'site'))).toBe(path.join(dir, 'site', 'css/site.css'));
    expect(resolveRef('../outside.css', path.join(dir, 'site'), path.join(dir, 'site'))).toBeNull();
  });

  // Value: protects=an unreadable top-level path prints relative to a cwd reached through a symlink; fails_when=the finding keeps the unresolved path while cwd is resolved; why_new=only a symlinked tmpdir (macOS) hit it; seam=none
  test('an unreadable top-level path beside a readable page is one internal-error finding with its own fix, also through a symlink', () => {
    const dir = tree({ 'index.html': page('', '<main><h1>Hi</h1><p>Body.</p></main>') });
    const r = lintStatic([dir, path.join(dir, 'nowhere.html')], { cwd: dir, ...quiet });
    expect(r.files.map((f) => path.basename(f))).toEqual(['index.html']);
    expect(only(r.findings, 'internal-error').map((f) => [f.grade, f.file, f.line, /cannot be read/.test(f.evidence), f.fix])).toEqual([['ask', 'nowhere.html', 1, true, 'check the path']]);
    const link = dir + '-link';
    fs.symlinkSync(dir, link);
    tmpDirs.push(link);
    fs.symlinkSync(path.join(dir, 'self'), path.join(dir, 'self'));
    const via = lintStatic([link, path.join(link, 'gone', 'nowhere.html'), path.join(link, 'self')], { cwd: link, ...quiet });
    expect(only(via.findings, 'internal-error').map((f) => f.file)).toEqual(['gone/nowhere.html', 'self']);
  });
});

describe('design-lint fifth cycle: waivers per sheet and the untested cells', () => {
  const claim = (rule: string, reason: string) => ({ rule, reason, file: 'a.html', line: 3 });
  const PAGE_TEXT = 'The manifesto sets long declarative lines. The ledger separates its rows with rules. Three links for the paper modes.';

  test('two linked stylesheets each waive the same rule for themselves; a short second claim is refused for its reason', () => {
    const sheets = (b: string) => ({
      'index.html': HEAD + '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css"></head><body><main><h1>The ledger</h1><p>The ledger keeps its grey rows grey.</p></main></body></html>',
      'a.css': '/* gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey in the theme sheet */\n' + TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }',
      'b.css': '/* gstack-lint-disable zero-chroma-neutrals: ' + b + ' */\n:root { --color-gray-print: oklch(45% 0 0); }\n.plate { color: var(--color-gray-print); }',
    });
    const both = lintStatic([tree(sheets('the print sheet keeps grey plates grey for the press'))], { cwd: tmpDirs[tmpDirs.length - 1], ...quiet }).findings;
    expect(only(both, 'waiver')).toEqual([]);
    expect(only(both, 'zero-chroma-neutrals').map((x) => [x.file, x.grade]).sort()).toEqual([['a.css', 'waived'], ['b.css', 'waived']]);
    const short = lintStatic([tree(sheets('short'))], { cwd: tmpDirs[tmpDirs.length - 1], ...quiet }).findings;
    expect(only(short, 'waiver').map((x) => x.evidence)).toEqual(['waiver on zero-chroma-neutrals refused: reason under 24 characters']);
    expect(only(short, 'zero-chroma-neutrals').map((x) => [x.file, x.grade]).sort()).toEqual([['a.css', 'waived'], ['b.css', 'ask']]);
  });

  test('a stylesheet claim with a boilerplate reason is refused and its finding stays ask', () => {
    const dir = tree({ 'index.html': HEAD + '<link rel="stylesheet" href="t.css"></head><body><main><h1>Ledger</h1><p>Rows.</p></main></body></html>', 't.css': '/* gstack-lint-disable zero-chroma-neutrals: this is intentional and by design for the sheet */\n' + TOKENS + '\n:root { --color-gray: oklch(55% 0 0); }\n.row { color: var(--color-gray); }' });
    const f = lintStatic([dir], { cwd: dir, ...quiet }).findings;
    expect(only(f, 'waiver').map((x) => x.evidence)).toEqual(['waiver on zero-chroma-neutrals refused: boilerplate reason']);
    expect(only(f, 'zero-chroma-neutrals').map((x) => x.grade)).toEqual(['ask']);
  });

  test('a second page claim on an accepted rule is refused as the duplicate even when its reason is short, and three accepted plus one refused is not a house style', () => {
    const dup = resolveWaivers([claim('gradient-text', 'the ledger separates its rows with rules'), claim('gradient-text', 'short')], PAGE_TEXT);
    expect([...dup.accepted.keys()]).toEqual(['gradient-text']);
    expect(dup.refused.map((f) => f.evidence)).toEqual(['waiver on gradient-text refused: one waiver per rule']);
    const four = resolveWaivers([claim('line-length', 'the manifesto sets long declarative lines'), claim('section-gap', 'the ledger separates its rows with rules'), claim('template-nav', 'three links for the paper modes'), claim('overused-font', 'short')], PAGE_TEXT);
    expect(four.accepted.size).toBe(3);
    expect(four.refused.map((f) => f.rule)).toEqual(['waiver']);
  });

  test('suspected leaves an ask or polish rule at its own tier', () => {
    const r = new Reporter('page', '/cwd');
    r.report('section-gap', '/cwd/a.html', 1, 'x', { suspected: true });
    r.report('text-sliver', '/cwd/a.html', 1, 'x', { suspected: true, source: 'render' });
    expect(r.findings.map((f) => [f.tier, f.grade])).toEqual([['ask', 'ask'], ['polish', 'polish']]);
  });
});

describe('design-lint fifth cycle: render answers of the wrong shape, field by field', () => {
  const PAGE = HEAD + '</head><body><main><h1>t</h1><p class="faint">Body.</p><a href="#">Go</a></main></body></html>';
  const SWATCH = path.join(path.resolve(import.meta.dir, '..'), 'test', 'fixtures', 'design-lint', 'render', 'swatch.png');
  const SETUP = 1, FIRST = 2, FOCUS = 13;
  const SCROLL = { rule: 'horizontal-scroll', grade: 'fail', evidence: 'the hero overflows' };
  type Patch = (evals: Record<number, string>, spec: RenderSpec) => void;
  const runner = (patch: Patch, stdout = ''): Runner => async (spec: RenderSpec): Promise<RenderResult> => {
    const evals: Record<number, string> = {};
    const shot = spec.steps.findIndex((s) => s.kind === 'screenshot');
    if (shot < 0) {
      evals[SETUP] = '{"lost":[]}';
      for (let i = FIRST; i <= FOCUS; i++) evals[i] = '[]';
      patch(evals, spec);
      return { ok: true, engine: 'browse', outputs: [], evals, stdout };
    }
    spec.steps.forEach((s, i) => {
      if (s.kind !== 'screenshot') return;
      fs.copyFileSync(SWATCH, s.out);
      const width = s.width ?? 0;
      evals[i - 1] = JSON.stringify([{ x: 0, y: 0, w: width / 2, h: width }]);
    });
    return { ok: true, engine: 'browse', outputs: [], evals, stdout };
  };
  const measured = (f: Finding[]) => only(f, 'horizontal-scroll').map((x) => x.evidence);
  const noAbort = (f: Finding[]) => only(f, 'render').filter((x) => /could not be measured/.test(x.evidence));

  test('a non-string at.cls, a ring without its colour, a probe without fg and a non-string PAGE_ERRORS entry each keep the measured findings', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const cls = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'nested-cards', grade: 'fail', evidence: 'x', at: { tag: 'p', text: 'Body.', cls: {} } }, SCROLL]); }) });
    expect(measured(cls.findings)).toEqual(['[320px] the hero overflows']);
    expect(only(cls.findings, 'nested-cards').map((f) => f.line)).toEqual([4]);
    expect(noAbort(cls.findings)).toEqual([]);

    const ring = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([SCROLL]); ev[FOCUS] = JSON.stringify([{ key: 'a', path: 'main>a', at: { tag: 'a', text: 'Go' }, bare: false, ratio: 1.2, pad: 2 }]); }) });
    expect(measured(ring.findings)).toEqual(['[320px] the hero overflows']);
    expect(noAbort(ring.findings)).toEqual([]);
    expect(only(ring.findings, 'render').map((f) => /\((.*?)\)/.exec(f.evidence)![1])).toEqual(['focus']);

    const fg = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([SCROLL]); ev[FIRST + 5] = JSON.stringify([{ rule: 'low-contrast', grade: 'fail', evidence: 'computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)', probe: { path: 'main>p', threshold: 4.5 } }, { rule: 'low-contrast', grade: 'fail', evidence: 'y', probe: true }]); }) });
    expect(measured(fg.findings)).toEqual(['[320px] the hero overflows']);
    expect(only(fg.findings, 'low-contrast').map((f) => f.evidence)).toEqual(['[1280px] computed contrast 2.50:1 under the 4.5:1 threshold on p.faint (2.50:1)', '[1280px] y']);
    expect(noAbort(fg.findings)).toEqual([]);

    const errs = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([SCROLL]); }, 'PAGE_ERRORS=[1]\n') });
    expect(measured(errs.findings)).toEqual(['[320px] the hero overflows']);
    expect(only(errs.findings, 'render')).toEqual([]);
  });

  test('a malformed entry claiming the render rule is reported as tampering with evidence on the line', async () => {
    const dir = tree({ 'index.html': PAGE });
    const file = path.join(dir, 'index.html');
    const r = await lintRender([file], { cwd: dir, run: runner((ev) => { ev[FIRST] = JSON.stringify([{ rule: 'render', grade: 'x', evidence: 'y' }]); }) });
    expect(only(r.findings, 'render').map((f) => f.evidence)).toEqual([expect.stringMatching(/does not know \(render\)/)]);
    expect(formatFinding(only(r.findings, 'render')[0])).toMatch(/^LINT: blocks render \S+:\d+ .+ \| fix: .+$/);
  });

  test('a short claim on a rule the render tier measured is refused as the Floor after both tiers settle', async () => {
    const dir = tree({ 'index.html': '<!-- gstack-lint-disable horizontal-scroll: table scrolls -->\n' + PAGE });
    const r = await lint([dir], { cwd: dir, render: true, warn: () => {}, run: runner((ev) => { ev[FIRST] = JSON.stringify([SCROLL]); }) });
    expect(only(r.findings, 'waiver').map((f) => f.evidence)).toEqual([`waiver on horizontal-scroll refused: ${FLOOR_REFUSAL}`]);
    expect(only(r.findings, 'horizontal-scroll').map((f) => f.grade)).toEqual(['blocks']);
  });
});

describe('design-lint fifth cycle: rule judgement', () => {
  test('a textarea taller than 52px is not a control-height finding; a button is', () => {
    const body = '<main><h1>Hi there</h1><form><textarea></textarea><button>Go</button></form></main>';
    expect(only(run(page('textarea { min-height: 120px; }', body)), 'control-height')).toEqual([]);
    expect(only(run(page('button { height: 30px; }', body)), 'control-height').length).toBe(1);
  });

  test('a border width change on an attribute-selected input is input-state-shift', () => {
    const f = run(page('input[type="text"] { border: 1px solid #333; } input[type="text"]:focus { border: 2px solid #000; outline: 2px solid red; }', '<main><h1>Hi there</h1><form><input type="text"></form></main>'));
    expect(only(f, 'input-state-shift').length).toBe(1);
  });

  test('an <i> holding only a glyph is not an italic word; a word is', () => {
    expect(only(run(page('', '<main><h1>Our favourite tools <i class="icon">★</i></h1><p>Body.</p></main>')), 'italic-word-in-heading')).toEqual([]);
    expect(only(run(page('', '<main><h1>Our <i>favourite</i> tools and more</h1><p>Body.</p></main>')), 'italic-word-in-heading').length).toBe(1);
  });

  test('a bounce keyframe by name on a UI selector is bounce-easing', () => {
    const f = run(page('@keyframes bounce { from { transform: none } to { transform: translateY(-4px) } } .btn:hover { animation: bounce .4s; }', '<main><h1>Hi there</h1><a class="btn" href="#">Go</a></main>'));
    expect(only(f, 'bounce-easing').map((x) => x.evidence)).toEqual([expect.stringMatching(/^bounce animation bounce on/)]);
  });

  test('a single-quoted inline style colour literal is literal-outside-tokens like its double-quoted twin', () => {
    const single = run(page('', "<main><h1>Hi there</h1><p style='color:#ff0000'>x</p></main>"));
    const double = run(page('', '<main><h1>Hi there</h1><p style="color:#ff0000">x</p></main>'));
    expect(only(single, 'literal-outside-tokens').map((x) => x.evidence)).toEqual(only(double, 'literal-outside-tokens').map((x) => x.evidence));
    expect(only(single, 'literal-outside-tokens').length).toBe(1);
  });

  test('a glass panel mixed from black names black; a tracked-only control is not called uppercase; emoji icon tiles stop at eight', () => {
    const glass = run(page('.glass::after { backdrop-filter: blur(8px); background: color-mix(in oklch, black 40%, transparent); }', '<main><h1>Hi there</h1><div class="glass">x</div></main>'));
    expect(only(glass, 'glow-wash').map((x) => x.evidence)).toEqual([expect.stringMatching(/translucent black/)]);
    const tracked = run(page('.btn { font-size: 13px; letter-spacing: .06em; }', '<main><h1>Hi there</h1><a class="btn" href="#">Go now</a></main>'));
    expect(only(tracked, 'wide-tracking').map((x) => x.evidence)).toEqual([expect.stringMatching(/^\.btn: a control tracked 0\.06em at 13px$/)]);
    const tiles = run(page('', '<main><h1>Hi there</h1>' + Array.from({ length: 12 }, (_, i) => '<div class="card"><span class="icon">🚀</span><h3>T' + i + '</h3></div>').join('\n') + '</main>'));
    expect(only(tiles, 'emoji-decoration').length).toBe(8);
  });
});
