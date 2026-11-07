/**
 * The design lint's core contract: parsers, the rule table, the output lines,
 * exit codes and waivers. Rule families have their own files
 * (test/design-lint-<family>.test.ts); the render tier is
 * test/design-lint-render.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildStyleIndex, buildTokens, parseCss, pxOf, resolveVars, stylesFor, type StyleIndex } from '../lib/design-lint/css';
import { contrastRatio, parseColor, srgbToOklch } from '../lib/design-lint/color';
import { ancestorsOf, directChildren, getAttr, innerOf, jsxPseudo, parseDoc, plainText, treeOf } from '../lib/design-lint/html';
import { lint, formatResult } from '../lib/design-lint/index';
import { Reporter, exitCodeOf, finalize, formatFinding, formatSummary, summarize } from '../lib/design-lint/report';
import { collectFiles, contextWaivers, lintStatic, MAX_FILE_BYTES } from '../lib/design-lint/static';
import type { LintContext } from '../lib/design-lint/context';
import { browserAvailable } from './helpers/browser-available';
import { RULES } from '../lib/design-lint/rules/ids';
import { BUZZWORDS, COPY_IDS } from '../lib/design-lint/rules/copy';
import { catalogEntry, DESIGN_SLOP_CATALOG, detectorSlopEntries, judgmentTellEntries, renderCatalog, selectCatalog } from '../lib/design-catalog';
import { autoFixEntries, checklistSlopEntries } from '../scripts/resolvers/design-checklist';
import { FAMILIES } from '../lib/design-lint/rules';
import { findWaivers, reasonIsBoilerplate, resolveWaivers, applyWaivers, suspectedRules } from '../lib/design-lint/waivers';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-lint');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'design-lint');

function runBin(args: string[], cwd = ROOT) {
  const r = Bun.spawnSync([BIN, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function tmpPage(html: string, name = 'index.html'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, html);
  return file;
}

/** A temporary tree: each key is a relative path (parent directories are created), each value the file's text. */
function tmpTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-tree-'));
  tmpDirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

describe('design-lint: CSS reading', () => {
  test('nested rules, media blocks and keyframes flatten with line numbers; tokens resolve through var() with fallbacks', () => {
    const css = `:root { --color-ink: oklch(20% 0.02 250); --space-4: 1rem; }
.card {
  padding: var(--space-4);
  &:hover { color: var(--color-ink); }
  @media (min-width: 60em) { padding: 2rem; }
}
@keyframes rise { from { opacity: 0 } to { opacity: 1 } }`;
    const rules = parseCss(css, 'a.css');
    const sel = (s: string) => rules.filter((r) => r.selector === s);
    expect(sel('.card')[0].decls).toEqual([{ prop: 'padding', value: 'var(--space-4)', line: 3 }]);
    expect(sel('.card:hover')[0].decls[0]).toEqual({ prop: 'color', value: 'var(--color-ink)', line: 4 });
    expect(sel('.card').find((r) => r.media === '(min-width: 60em)')?.decls[0].value).toBe('2rem');
    expect(rules.filter((r) => r.keyframes === 'rise')).toHaveLength(2);
    const tokens = buildTokens(rules);
    expect(tokens['--space-4']).toBe('1rem');
    expect(resolveVars('var(--space-4) var(--missing, 8px)', tokens)).toBe('1rem 8px');
    expect(pxOf('1.5rem')).toBe(24);
    expect(pxOf('50%')).toBeNull();
  });
});

describe('design-lint: colour', () => {
  test('hex, rgb, hsl and oklch parse; contrast and OKLCH round-trip hold', () => {
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1, alpha: 1 });
    expect(parseColor('rgb(0 0 0 / 50%)')?.alpha).toBe(0.5);
    expect(parseColor('hsl(0 100% 50%)')?.r).toBeCloseTo(1, 5);
    const ok = parseColor('oklch(50% 0.1 250)')!;
    expect(ok.okl).toEqual({ L: 0.5, C: 0.1, H: 250 });
    const back = srgbToOklch(ok);
    expect(back.L).toBeCloseTo(0.5, 1);
    expect(back.H).toBeCloseTo(250, 0);
    expect(contrastRatio(parseColor('black')!, parseColor('white')!)).toBeCloseTo(21, 1);
    expect(parseColor('var(--x)')).toBeNull();
  });
});

describe('design-lint: markup reading', () => {
  test('tags keep positions and lines; styles and scripts are lifted; component files become pseudo-HTML with their class strings', () => {
    const doc = parseDoc('p.html', '<html><head><style>h1{color:red}</style></head>\n<body>\n<h1 class="t">Hi &amp; bye</h1><img src="a.png" alt="">\n<script>alert(1)</script></body></html>');
    expect(doc.tags.find((t) => t.name === 'h1')?.line).toBe(3);
    expect(doc.styles[0].css).toBe('h1{color:red}');
    expect(doc.scripts.trim()).toBe('alert(1)');
    expect(doc.text).toContain('Hi & bye');
    expect(getAttr(doc.tags.find((t) => t.name === 'img')!.attrs, 'alt')).toBe('');
    expect(plainText('<p>A &middot; B &rarr;</p>')).toBe('A · B →');
    const tsx = parseDoc('Hero.tsx', 'export const Hero = () => (<section className={cn("bg-indigo-500", open && "p-4")}><h1 className="text-4xl">Hi</h1></section>);');
    expect(tsx.kind).toBe('jsx');
    expect(tsx.tags.map((t) => t.name).filter((n) => n === 'section' || n === 'h1')).toEqual(['section', 'h1', 'h1', 'section']);
    expect(tsx.classAt.get(tsx.tags.find((t) => t.name === 'section')!.pos)).toEqual(['bg-indigo-500', 'p-4']);
  });
});

describe('design-lint: the rule table', () => {
  test('every id is kebab-case with a tier, a source gate, a title and a fix; docs/design-lint.md names each one', () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'design-lint.md'), 'utf8');
    for (const [id, m] of Object.entries(RULES)) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(['blocks', 'ask', 'polish']).toContain(m.tier);
      expect(m.gate.length).toBeGreaterThan(0);
      expect(m.title.length).toBeGreaterThan(8);
      expect(m.fix.length).toBeGreaterThan(3);
      expect(docs).toContain('`' + id + '`');
    }
    expect(Object.keys(RULES).length).toBeGreaterThan(100);
    expect(FAMILIES.map((f) => f.name)).toEqual(['color', 'type', 'structure', 'chrome', 'motion', 'assets', 'finish', 'component', 'copy']);
  });

  test('the three house rules gstack keeps at ask stay at ask, and the Floor rules the plan names block', () => {
    expect(RULES['kicker-above-heading'].tier).toBe('ask');
    expect(RULES['screen-word-budget'].tier).toBe('ask');
    expect(RULES['em-dash-overuse'].tier).toBe('ask');
    expect(RULES['overflow-x-unclipped'].tier).toBe('ask');
    for (const id of ['purple-blue-gradient', 'nested-cards', 'wide-tracking', 'template-punctuation', 'missing-focus-visible', 'low-contrast', 'content-hidden-at-rest', 'hero-fold']) expect(RULES[id].tier).toBe('blocks');
  });
});

describe('design-lint: the output contract', () => {
  test('a finding prints as LINT: <grade> <rule> <file>:<line> <evidence> | fix: <fix>; a suspected blocking tell lands at ask; unknown ids throw', () => {
    const r = new Reporter('page', '/cwd');
    r.report('nested-cards', '/cwd/site/index.html', 12, 'div.card > div.card', {});
    r.report('invented-proof', '/cwd/site/index.html', 30, '"Trusted by 500+ teams"', { suspected: true });
    r.report('section-gap', '/cwd/site/index.html', 1, 'x');
    expect(formatFinding(r.findings[0])).toBe('LINT: blocks nested-cards site/index.html:12 div.card > div.card | fix: one containment layer');
    expect(r.findings[1].tier).toBe('ask');
    expect(() => r.report('no-such-rule', 'f', 1, 'x')).toThrow(/unknown rule id/);
    const component = new Reporter('component', '/cwd');
    component.report('section-gap', '/cwd/a.tsx', 1, 'page-only rule under component scope');
    expect(component.findings).toEqual([]);
  });

  test('blocks exit 2, an unanswered ask exits 1, polish alone exits 0; waived is counted apart from ask and never summed into blocks', () => {
    const base = { file: 'a.html', line: 1, evidence: 'e', fix: 'f', source: 'static' as const };
    const blocks = { rule: 'nested-cards', tier: 'blocks' as const, grade: 'blocks' as const, ...base };
    const ask = { rule: 'section-gap', tier: 'ask' as const, grade: 'ask' as const, ...base };
    const waived = { ...ask, grade: 'waived' as const, waiver: 'because the ledger separates rows with rules' };
    const polish = { rule: 'straight-quotes', tier: 'polish' as const, grade: 'polish' as const, ...base };
    expect(exitCodeOf(summarize([blocks, ask, polish], 'skipped: x'))).toBe(2);
    expect(exitCodeOf(summarize([ask, polish], 'ran'))).toBe(1);
    expect(exitCodeOf(summarize([polish, waived], 'ran'))).toBe(0);
    expect(formatSummary(summarize([blocks, waived, waived, polish], 'ran'))).toBe('LINT_SUMMARY: blocks=1 ask=0 waived=2 polish=1 render=ran');
    expect(finalize([polish, ask, blocks, blocks]).map((f) => f.grade)).toEqual(['blocks', 'ask', 'polish']);
    expect(formatFinding(waived)).toContain('| fix: waived (because the ledger');
  });

  test('the bin prints the contract and exits by it; --rules lists the table; a usage error exits 3', () => {
    const slopped = runBin(['test/fixtures/design-lint/slopped.html']);
    expect(slopped.code).toBe(2);
    const lines = slopped.out.trim().split('\n');
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/^LINT: (blocks|ask|polish|waived) [a-z][a-z0-9-]* \S+:\d+ .+ \| fix: .+$/);
    expect(lines.at(-1)).toMatch(/^LINT_SUMMARY: blocks=\d+ ask=\d+ waived=\d+ polish=\d+ render=skipped: not requested$/);
    expect(runBin(['--rules']).out).toContain('nested-cards');
    expect(runBin([]).code).toBe(3);
    expect(runBin(['--scope', 'app', 'x.html']).code).toBe(3);
    const json = JSON.parse(runBin(['--json', 'test/fixtures/design-lint/slopped.html']).out);
    expect(json.summary.blocks).toBeGreaterThan(0);
    expect(Array.isArray(json.findings)).toBe(true);
  });

  test('a clean page passes: exit 0 and LINT_SUMMARY blocks=0 ask=0', async () => {
    const file = tmpPage(fs.readFileSync(path.join(FIXTURES, 'clean', 'index.html'), 'utf8'));
    const result = await lint([file], { cwd: path.dirname(file) });
    const unexpected = result.findings.filter((f) => f.grade === 'blocks' || f.grade === 'ask');
    expect(unexpected.map(formatFinding)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(formatResult(result)).toContain('LINT_SUMMARY: blocks=0 ask=0');
  });

  // Value: protects=every usage exit (3) the bin promises and --help's 0; fails_when=a flag check is dropped or a usage error falls through to lint() and exits 0; why_new=the bin test only covers no-args and --scope; seam=none; no_claim=stderr wording beyond the key phrase
  test('the bin exits 3 for a non-http --url, an unknown flag, a flag without its value, a path it cannot read and a tree with nothing to lint; --help exits 0', () => {
    const url = runBin(['--url', 'ftp://example.test/page']);
    expect([url.code, url.err]).toEqual([3, expect.stringContaining('http or https')]);
    const flag = runBin(['--bogus', 'x.html']);
    expect([flag.code, flag.err]).toEqual([3, expect.stringContaining('unknown flag --bogus')]);
    const value = runBin(['x.html', '--job']);
    expect([value.code, value.err]).toEqual([3, expect.stringContaining('--job needs a value')]);
    const missing = runBin(['/nowhere/design-lint/none.html']);
    expect([missing.code, missing.err]).toEqual([3, expect.stringContaining('cannot read /nowhere/design-lint/none.html')]);
    expect(missing.err).toContain('no .html, .css, .jsx, .tsx, .vue, .svelte or .astro files found');
    const nothing = runBin([tmpTree({ 'notes.txt': 'not a page', 'data.json': '{}' })]);
    expect([nothing.code, nothing.out]).toEqual([3, '']);
    const help = runBin(['--help']);
    expect([help.code, help.out.trim(), help.err]).toEqual([0, expect.stringMatching(/^usage: gstack-design-lint </), '']);
  });

  // Value: protects=lint() wires --render/--url to the render tier: only HTML pages render, a URL is a target of its own; fails_when=render is requested but never reaches lintRender, or a URL target is dropped; why_new=lintRender is tested alone, the glue in lint() and the bin is not; seam=none; no_claim=the no-browser summary wording beyond its prefix
  test('render requested on a tree without a page says so in the summary; --url with no file is a render target of its own', async () => {
    const cssOnly = tmpTree({ 'tokens.css': ':root { --color-ink: oklch(22% 0.03 250); }', 'Hero.tsx': 'export const Hero = () => <h1 className="text-xl">Ledger</h1>;' });
    const result = await lint([cssOnly], { cwd: cssOnly, render: true, warn: () => {} });
    expect(result.files.map((f) => path.basename(f))).toEqual(['Hero.tsx', 'tokens.css']);
    expect(result.summary.render).toBe('skipped: no HTML page to render');
    expect(formatResult(result)).toMatch(/render=skipped: no HTML page to render$/);
    const nothing = await lint([cssOnly], { cwd: cssOnly, warn: () => {} });
    expect(nothing.summary.render).toBe('skipped: not requested');

    const r = runBin(['--url', 'http://127.0.0.1:9/']);
    if (browserAvailable()) {
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/^LINT: blocks render http:\/\/127\.0\.0\.1:9\/:1 could not reach http:\/\/127\.0\.0\.1:9\/: .+ \| fix: .+$/m);
      expect(r.out).toMatch(/^LINT_SUMMARY: blocks=1 ask=0 waived=0 polish=0 render=ran$/m);
    } else {
      expect(r.code).toBe(4);
      expect(r.out).toMatch(/^LINT_SUMMARY: blocks=0 ask=0 waived=0 polish=0 render=skipped: /m);
      expect(r.err).toMatch(/^gstack-design-lint: RENDER_UNAVAILABLE: nothing was measured at http:\/\/127\.0\.0\.1:9\/ \(no browser available.+\) \| fix: gstack-browser-ensure, then rerun$/m);
    }
  });
});

describe('design-lint: the static tier\'s files and contexts', () => {
  // Value: protects=which files the walk reads and which stylesheet may carry a page's waiver; fails_when=vendored or built CSS is linted, or a linked stylesheet from elsewhere waives a page's finding; why_new=no test walks a tree with node_modules, dot or build directories, or a waiver in CSS; seam=none; no_claim=ordering inside one directory beyond sorted names
  test('the walk skips node_modules, dot folders and build output below the top, warns on an unreadable path; a waiver in any stylesheet the page reads answers for that stylesheet', () => {
    const dir = tmpTree({
      'site/index.html': '<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="local.css"><link rel="stylesheet" href="../shared/theme.css"></head><body><main><h1>The ledger</h1><p>The ledger separates its rows with hairline rules.</p></main></body></html>',
      'site/local.css': '/* gstack-lint-disable section-gap: the ledger separates its rows with rules */\n.row { border-top: 1px solid var(--color-line); }',
      'shared/theme.css': '/* gstack-lint-disable template-nav: the ledger keeps three links for its three modes */\n:root { --color-line: oklch(85% 0.015 80); }',
      'site/node_modules/lib/vendor.css': '.v { color: #123456; }',
      'site/.cache/stale.html': '<h1>stale</h1>',
      'site/dist/built.css': '.b { color: #654321; }',
      'dist/top.css': '.t { color: var(--color-line); }',
    });
    const warned: string[] = [];
    const files = collectFiles([path.join(dir, 'site'), path.join(dir, 'dist'), path.join(dir, 'site', 'index.html'), path.join(dir, 'gone')], (l) => warned.push(l));
    expect(files.map((f) => path.relative(dir, f))).toEqual(['site/index.html', 'site/local.css', 'dist/top.css']);
    expect(warned).toEqual([`design-lint: cannot read ${path.join(dir, 'gone')}`]);

    const { contexts } = lintStatic([path.join(dir, 'site')], { cwd: dir, warn: (l) => { throw new Error(l); } });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].cssFiles.map((c) => path.relative(dir, c.file))).toEqual(['site/local.css', 'shared/theme.css']);
    const set = contextWaivers(contexts[0], dir);
    expect([...set.accepted.entries()]).toEqual([['section-gap@site/local.css', 'the ledger separates its rows with rules'], ['template-nav@shared/theme.css', 'the ledger keeps three links for its three modes']]);
    expect(set.refused).toEqual([]);
  });

  // Value: protects=two pages in one directory each own only the stylesheets they link; fails_when=grouping hands every stylesheet to every page, so one page's waiver answers the other's finding and the finding prints twice; why_new=every fixture directory holds one page; seam=none; no_claim=which page a stylesheet linked by neither belongs to
  test('two pages in one directory: a finding in one page\'s stylesheet is reported once and is not waived by the other page', () => {
    const dir = tmpTree({
      'a.html': '<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="a.css"></head><body><main><h1>The ledger</h1><p>The ledger closes the month on the first day.</p></main></body></html>',
      'a.css': ':root { --color-gray: oklch(55% 0 0); --color-ink: oklch(22% 0.03 250); }\n.rule { border-color: var(--color-gray); }',
      'b.html': '<!-- gstack-lint-disable zero-chroma-neutrals: the archive keeps its grey plates grey -->\n<!doctype html><html lang="en"><head><title>Archive</title><link rel="stylesheet" href="b.css"></head><body><main><h1>The archive</h1><p>The archive keeps its grey plates on the shelf.</p></main></body></html>',
      'b.css': ':root { --color-ink: oklch(22% 0.03 250); }\n.shelf { color: var(--color-ink); }',
    });
    const result = lintStatic([dir], { cwd: dir, warn: (l) => { throw new Error(l); } });
    expect(result.contexts.map((c) => [path.basename(c.key), c.cssFiles.map((f) => path.basename(f.file))])).toEqual([['a.html', ['a.css']], ['b.html', ['b.css']]]);
    const grey = finalize(result.findings).filter((f) => f.rule === 'zero-chroma-neutrals');
    expect(grey.map((f) => [f.grade, f.file, f.line])).toEqual([['ask', 'a.css', 1]]);
    expect(result.findings.filter((f) => f.rule === 'waiver')).toEqual([]);
  });
});

describe('design-lint: the copy tier', () => {
  const DIRTY = `<!doctype html><html><head><style>.hero{height:100vh;transition: all .3s}</style></head><body>
<nav><a href="#">Docs</a><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<h1>Elevate your workflow seamlessly</h1><p>Trusted by Acme and John Doe. 99.99% uptime, 50% faster, 10,000+ happy users. [Needs proof: logo]</p>
<img src="a.png"><p>Oops! Something broke. Lorem ipsum.</p>
<script>window.addEventListener('scroll', () => {}); alert('hi'); showAlert(1);</script></body></html>`;

  const CLEAN = `<!doctype html><html lang="en"><head><title>Ledgerline: close the books in 2 days</title>
<meta name="description" content="Close faster."><meta property="og:image" content="/og.png"><link rel="icon" href="/favicon.svg">
<style>.hero{min-height:100vh;min-height:100dvh;transition: transform .4s var(--ease-out)} .w{width:100%}</style></head>
<body><a href="#main">Skip to content</a><a href="#pricing">Pricing</a><nav><a href="/" aria-current="page">Home</a><a href="/pricing">Pricing</a></nav>
<main id="main"><h1>Close the books in 2 days, not 9</h1><p>Teams at Halvorsen Freight cut month-end by 47.2%. Save 20% yearly. 100% open source. 30-day refund.</p><img src="x.png" alt=""></main>
<script>const io = new IntersectionObserver(() => {}); window.showAlert = () => {};</script></body></html>`;

  const copy = (html: string, scope: 'page' | 'component' = 'page') => {
    const file = tmpPage(html);
    return lintStatic([file], { cwd: path.dirname(file), scope, warn: () => {} }).findings.filter((f) => f.source === 'copy');
  };
  const ids = (html: string) => [...new Set(copy(html).map((f) => f.rule))].sort();

  // Value: protects=every copy-tier tell reports at the line that holds it, under the craft ids and catalog fixes; fails_when=a rule reports at line 1, drops a tell or re-reports the static tier's 100vh and transition: all; why_new=the fold replaced lib/design-craft's counts with positions; seam=none; no_claim=render-tier findings
  test('a page with every tell reports each one at its line, with what matched; 100vh and transition: all stay with the static tier', () => {
    const found = copy(DIRTY).map((f) => [f.rule, f.line, f.evidence]);
    expect(found).toEqual(expect.arrayContaining([
      ['dead-link', 2, 'a dead link (href="#")'],
      ['missing-aria-current', 2, 'route navigation without aria-current'],
      ['marketing-buzzword', 3, 'a marketing buzzword: "Elevate", "seamlessly"'],
      ['placeholder-brand', 3, 'a placeholder brand (Acme, Nexus): "Acme"'],
      ['placeholder-name', 3, 'a placeholder name (John Doe): "John Doe"'],
      ['round-number', 3, 'a round invented number: "99.99% uptime", "50% faster", "10,000+ happy users"'],
      ['needs-proof', 3, 'a [Needs proof] marker left in the page: "[Needs proof:"'],
      ['img-no-alt', 4, 'an <img> without alt'],
      ['oops', 4, '"oops" as an error message: "Oops"'],
      ['lorem', 4, 'lorem ipsum placeholder text: "Lorem ipsum"'],
      ['scroll-listener', 5, 'a scroll event listener'],
      ['alert', 5, 'alert() for a message'],
      ['missing-title', 1, 'a document without a <title>'],
    ]));
    expect(ids(DIRTY)).toEqual(['alert', 'dead-link', 'img-no-alt', 'lorem', 'marketing-buzzword', 'missing-aria-current', 'missing-favicon', 'missing-meta-description', 'missing-skip-link', 'missing-title', 'needs-proof', 'oops', 'placeholder-brand', 'placeholder-name', 'round-number', 'scroll-listener']);
    for (const f of copy(DIRTY)) expect(f.fix, f.rule).toBe(catalogEntry(f.rule)!.fix!);
    const file = tmpPage(DIRTY);
    const all = lintStatic([file], { cwd: path.dirname(file), warn: () => {} }).findings;
    expect(all.filter((f) => f.rule === 'vh-height').map((f) => f.source)).toEqual(['static']);
    expect(all.filter((f) => f.rule === 'layout-transition').map((f) => f.source)).toEqual(['static']);
  });

  test('a finished page is clean: CSS 100%, in-page anchors, a showAlert helper and inlined Pretext are not flagged', () => {
    expect(copy(CLEAN)).toEqual([]);
    const pretext = fs.readFileSync(path.join(ROOT, 'design-html', 'vendor', 'pretext.js'), 'utf-8');
    expect(copy(CLEAN.replace('</body>', `<script type="module">${pretext}</script></body>`))).toEqual([]);
  });

  test('every copy-tier id is a lint rule; each but the shell check is a grep-detectable catalog entry whose fix the lint prints', () => {
    expect(new Set(COPY_IDS).size).toBe(COPY_IDS.length);
    for (const id of COPY_IDS) {
      expect(RULES[id]?.gate, id).toBe('craft');
      if (id === 'empty-mount-node') continue;
      expect(catalogEntry(id)?.detect, id).toContain('grep');
      expect(RULES[id].fix, id).toBe(catalogEntry(id)!.fix!);
    }
    expect(Object.keys(RULES).filter((id) => RULES[id].gate === 'craft').sort()).toEqual([...COPY_IDS].sort());
  });

  // Value: protects=checker-only craft entries render into no skill prose or checklist, and the lint reports each; fails_when=a renderer reads DESIGN_SLOP_CATALOG, not RENDERED, or a checker-only id has no lint rule; why_new=moved from test/design-craft.test.ts with the checker; seam=none; no_claim=byte size of any one skill (size guard owns it)
  test('checker-only catalog entries are lint rules that no rendered list carries; catalog entries with a fix still render', () => {
    const checkerOnly = DESIGN_SLOP_CATALOG.filter((e) => e.checkerOnly);
    expect(checkerOnly.length).toBeGreaterThan(0);
    const rendered = new Set([selectCatalog({}), detectorSlopEntries(), judgmentTellEntries(), checklistSlopEntries(), autoFixEntries()].flat().map((e) => e.id));
    const prose = renderCatalog({ kind: 'slop' });
    for (const e of checkerOnly) {
      expect(RULES[e.id], e.id).toBeDefined();
      expect(rendered.has(e.id), e.id).toBe(false);
      expect(prose, e.id).not.toContain(e.prose);
    }
    for (const id of ['marketing-buzzword', 'layout-transition']) expect(rendered.has(id), id).toBe(true);
  });

  test('BUZZWORDS covers every word the catalog heuristic and the craft section name, and matches stems, not look-alikes', () => {
    const heuristic = catalogEntry('marketing-buzzword')?.heuristic ?? '';
    const words = heuristic.replace(/^.*?for /, '').replace(/\.$/, '').split(/,\s*/);
    expect(words.length).toBeGreaterThan(5);
    for (const word of words) expect(BUZZWORDS).toContain(word);
    const section = fs.readFileSync(path.join(ROOT, 'design-html', 'sections', 'craft.md.tmpl'), 'utf-8');
    const buzz = section.match(/No buzzwords: ([^\n]+)\.\n/)?.[1].replace(/"/g, '').split(/,\s*/) ?? [];
    expect(buzz.length).toBeGreaterThan(10);
    for (const word of buzz) expect(BUZZWORDS).toContain(word);
    expect(copy('<p>Unlocking seamless, next gen workflows that elevate teams</p>').map((f) => f.evidence)).toEqual(['a marketing buzzword: "Unlocking", "seamless", "next gen", "elevate"']);
    expect(copy('<p>Take the elevator to the elevation map; streamers sold here</p>')).toEqual([]);
    const names = section.match(/No placeholder people or brands \(([^)]+)\)/)?.[1].split(/,\s*/) ?? [];
    expect(names.length).toBe(5);
    for (const name of names) expect(ids(`<p>${name}</p>`)).toEqual([/Doe/.test(name) ? 'placeholder-name' : 'placeholder-brand']);
  });

  test('the skip link is judged by position and target; aria-current is required only for route navigation', () => {
    expect(ids(CLEAN.replace('id="main"', 'id="content"'))).toEqual(['missing-skip-link']);
    expect(ids(CLEAN.replace('id="main"', 'data-id="main"'))).toEqual(['missing-skip-link']);
    expect(ids(CLEAN.replace('>Skip to content<', '>Zum Inhalt springen<'))).toEqual([]);
    expect(ids(CLEAN.replace('<a href="#main">Skip to content</a>', ''))).toEqual(['missing-skip-link']);
    expect(ids(CLEAN.replace('<a href="/" aria-current="page">Home</a><a href="/pricing">Pricing</a>', '<a href="#features">Features</a><a href="#faq">FAQ</a>'))).toEqual([]);
    expect(copy(CLEAN.replace(' aria-current="page"', '')).map((f) => [f.rule, f.line])).toEqual([['missing-aria-current', 4]]);
  });

  test('copy reads visible text: entities decode, svg text counts, and comments, scripts, styles and templates do not', () => {
    expect(ids('<p>&#91;Needs proof: logo]</p>')).toEqual(['needs-proof']);
    expect(ids('<img src="a.png" data-alt="x">')).toEqual(['img-no-alt']);
    expect(ids('<svg><text>Acme</text></svg>')).toEqual(['placeholder-brand']);
    expect(ids('<p>Set a price alert (free)</p>')).toEqual([]);
    expect(ids('<style>.a{content:"Acme"}</style><script>// John Doe</script><template><p>Lorem ipsum</p></template><p>Halvorsen</p>')).toEqual([]);
    expect(ids('<section><h2>Pricing</h2><a href="/buy">Start free trial</a></section>')).toEqual([]);
  });

  // Value: protects=the documented craft-checker limits stay fixed in the fold: script payloads, single-quoted handlers, script text as presence, commented markup; fails_when=a code or presence rule reads the raw source again; why_new=#3433 listed these as checker limits for the follow-up; seam=none; no_claim=external scripts, which the lint does not fetch
  test('a hydration payload, commented-out markup and script text are not page content; single-quoted handlers are read', () => {
    expect(ids('<p>Halvorsen</p><script>window.__DATA__ = "<img src=a.png><a href=\\"#\\">x</a>";</script>')).toEqual([]);
    expect(ids('<!-- <img src="a.png"><p>Lorem ipsum</p><a href="#">x</a> --><p>Halvorsen</p>')).toEqual([]);
    expect(copy("<button onclick='alert(1)'>Go</button>\n<button onclick=\"alert(2)\">Go</button>").map((f) => [f.rule, f.line])).toEqual([['alert', 1], ['alert', 2]]);
    const head = '<!doctype html><html lang="en"><head><meta name="description" content="d"><link rel="icon" href="/i.svg"><script>const t = "<title>Ledger</title>";</script></head><body><a href="#m">Skip</a><main id="m"><p>Halvorsen</p></main></body></html>';
    expect(ids(head)).toEqual(['missing-title']);
  });

  // Value: protects=a client-rendered shell is named an empty mount node instead of passing as clean; fails_when=a <noscript> notice counts as body text, or an image-only page with no script is called a shell; why_new=#3433's craft audit left "mount-node shell" undefined and the checker gave shells a clean result; seam=none; no_claim=that the rendered page is clean
  test('an empty mount node is reported at its line; a noscript notice does not count as content, an image-only page is not a shell', () => {
    const shell = '<!doctype html><html lang="en"><head><title>App</title></head>\n<body>\n<noscript>You need to enable JavaScript to run this app.</noscript>\n<div id="root"></div>\n<script src="/main.js"></script></body></html>';
    expect(copy(shell).filter((f) => f.rule === 'empty-mount-node').map((f) => [f.grade, f.line, f.evidence])).toEqual([['ask', 4, `${RULES['empty-mount-node'].title}: <div id="root">`]]);
    expect(copy('<!doctype html><html><head><title>A</title></head><body><my-app></my-app><script type="module" src="/a.js"></script></body></html>').some((f) => f.rule === 'empty-mount-node')).toBe(true);
    expect(ids('<!doctype html><html><head><title>A</title></head><body><img src="a.png" alt="A harbour at dusk"></body></html>')).not.toContain('empty-mount-node');
    expect(ids(CLEAN)).not.toContain('empty-mount-node');
    expect(copy(shell, 'component').some((f) => f.rule === 'empty-mount-node')).toBe(false);
  });

  // Value: protects=the five content-realism ids sit at ask so a page waiver answers a supplied name or figure, as the owner chose; fails_when=one moves back to blocks, or a waiver beside a copy-tier tell is refused or ignored; why_new=option (a) moved them and no test pinned the tier or the waived grade; seam=none; no_claim=how far one page waiver reaches
  test('the content-realism ids sit at ask, and a waiver about the page answers a copy-tier tell', () => {
    for (const id of ['placeholder-name', 'placeholder-brand', 'lorem', 'round-number', 'needs-proof']) expect(RULES[id].tier, id).toBe('ask');
    const page = '<!doctype html><html lang="en"><head><title>Freight ledger</title></head><body>\n<!-- gstack-lint-disable placeholder-brand: Nexus is the freight customer this ledger page was built for -->\n<p>Nexus closes its freight ledger in two days.</p></body></html>';
    expect(copy(page).filter((f) => f.rule === 'placeholder-brand').map((f) => [f.grade, f.line, f.waiver])).toEqual([['waived', 3, 'Nexus is the freight customer this ledger page was built for']]);
  });

  // Value: protects=an inline handler's tell reports at the line its code is on, and a shell with no <body> tag is still an empty mount node; fails_when=the handler position is the attribute's start, or the <title> text counts as body text; why_new=the /ship review found both; seam=none; no_claim=every implicit-body layout
  test('an inline handler reports at its value\'s line; a shell without a <body> tag is an empty mount node', () => {
    expect(copy('<button\nonclick="alert(1)">Go</button>').map((f) => [f.rule, f.line])).toEqual([['alert', 2]]);
    const bare = '<!doctype html><html lang="en"><head><title>App</title></head>\n<div id="root"></div><script src="/app.js"></script></html>';
    expect(copy(bare).filter((f) => f.rule === 'empty-mount-node').map((f) => f.line)).toEqual([2]);
  });

  test('a component file gets no copy findings', () => {
    const dir = tmpTree({ 'Card.tsx': 'export const Card = () => <article className="p-4"><p>Lorem ipsum in a component</p><img src="c.png" /></article>;' });
    expect(lintStatic([dir], { cwd: dir, warn: () => {} }).findings.some((f) => f.source === 'copy')).toBe(false);
  });
});

describe('design-lint: waivers', () => {
  const page = 'The manifesto sets long declarative lines on black paper for the ledger.';
  const claim = (rule: string, reason: string) => ({ rule, reason, file: 'a.html', line: 3 });

  test('an ask or polish rule is waived with the rule id and a reason about the page; the Floor is refused', () => {
    const set = resolveWaivers([claim('line-length', 'the manifesto sets long declarative lines'), claim('nested-cards', 'the manifesto nests its ledger on purpose for the paper')], page);
    expect([...set.accepted.keys()]).toEqual(['line-length']);
    expect(set.refused.map((f) => f.evidence)).toEqual(['waiver on nested-cards refused: it blocks; the Floor is never waivable']);
    const findings = applyWaivers([
      { rule: 'line-length', tier: 'ask', grade: 'ask', file: 'a.html', line: 9, evidence: 'e', fix: 'f', source: 'static' },
      { rule: 'nested-cards', tier: 'blocks', grade: 'blocks', file: 'a.html', line: 9, evidence: 'e', fix: 'f', source: 'static' },
    ], set);
    expect(findings.map((f) => [f.rule, f.grade])).toEqual([['line-length', 'waived'], ['nested-cards', 'blocks'], ['waiver', 'ask']]);
  });

  test('short, boilerplate, reused, self-vouching and duplicate reasons are refused, each naming why', () => {
    const set = resolveWaivers([
      claim('line-length', 'looks better this way'),
      claim('section-gap', 'intentional design choice by design'),
      claim('template-nav', 'the manifesto sets long declarative lines'),
      claim('template-footer', 'the manifesto sets long declarative lines'),
      claim('overused-font', 'quartz pelican umbrella semaphore'),
      claim('gradient-text', 'the ledger separates its rows with rules'),
      claim('gradient-text', 'the ledger separates its rows with hairline rules'),
      claim('not-a-rule', 'the manifesto sets long declarative lines'),
    ], page);
    expect([...set.accepted.keys()]).toEqual(['gradient-text']);
    expect(set.refused.map((f) => f.evidence.replace(/^waiver on \S+ refused: /, ''))).toEqual([
      'reason under 24 characters', 'boilerplate reason', 'reason reused on another waiver', 'reason reused on another waiver',
      'reason shares no word with the page', 'one waiver per rule', 'no such rule',
    ]);
    expect(reasonIsBoilerplate('deliberately, it works')).toBe(true);
    expect(reasonIsBoilerplate('the ledger separates its rows with rules')).toBe(false);
  });

  test('both comment forms are read, including impeccable-disable, from HTML, CSS and component sources', () => {
    const claims = findWaivers('a.html', '<!-- gstack-lint-disable section-gap: the ledger separates its rows with rules -->\n<style>/* impeccable-disable line-length: the manifesto sets long lines */</style>\n// gstack-lint-disable template-nav: three links are the three modes');
    expect(claims.map((c) => [c.rule, c.line, c.reason])).toEqual([
      ['section-gap', 1, 'the ledger separates its rows with rules'],
      ['line-length', 2, 'the manifesto sets long lines'],
      ['template-nav', 3, 'three links are the three modes'],
    ]);
  });

  test('the waiver fixture: five honoured (a house-style polish note), two refused (Floor, short reason), nothing blocks', async () => {
    const result = await lint([path.join(FIXTURES, 'waiver')], { cwd: ROOT });
    expect(result.summary.blocks).toBe(0);
    const refused = result.findings.filter((f) => f.rule === 'waiver').map((f) => f.evidence);
    expect(refused).toEqual([
      'waiver on low-contrast refused: it blocks; the Floor is never waivable',
      'waiver on template-footer refused: reason under 24 characters',
    ]);
    expect(result.findings.filter((f) => f.rule === 'house-style')).toHaveLength(1);
    expect(result.findings.some((f) => f.rule === 'low-contrast' && f.grade === 'waived')).toBe(false);
  });
});

describe('design-lint: third review cycle', () => {
  test('two waiver comments on one line are both read, and a stylesheet claim answers only for that stylesheet', () => {
    const claims = findWaivers('a.html', '<!-- gstack-lint-disable section-gap: the ledger separates rows --> <!-- gstack-lint-disable line-length: the manifesto sets long lines -->\n/* impeccable-disable overused-font: the masthead face is the paper */ .x{}');
    expect(claims.map((c) => [c.rule, c.reason])).toEqual([['section-gap', 'the ledger separates rows'], ['line-length', 'the manifesto sets long lines'], ['overused-font', 'the masthead face is the paper']]);
    const dir = tmpTree({
      'index.html': '<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="t.css"><style>.row { border-color: oklch(55% 0 0); }</style></head><body><main><h1>The ledger</h1><p>The ledger closes the month.</p></main></body></html>',
      't.css': '/* gstack-lint-disable zero-chroma-neutrals: quartz pelican umbrella semaphore xylophone */\n:root { --color-ink: oklch(22% 0.03 250); --color-gray: oklch(55% 0 0); }\n.cell { color: var(--color-gray); }',
    });
    const f = finalize(lintStatic([dir], { cwd: dir, warn: () => {} }).findings);
    expect(f.filter((x) => x.rule === 'waiver')).toEqual([]);
    expect(f.filter((x) => x.rule === 'zero-chroma-neutrals').map((x) => [x.file, x.grade]).sort()).toEqual([['index.html', 'ask'], ['t.css', 'waived']]);
  });

  test('the indexed stylesFor answers exactly as the linear scan', () => {
    const rules = parseCss('a{color:red}\n.x{margin:0}\n.x.y{padding:1px}\na.x:hover{color:blue}\n@media (max-width:600px){.x{top:0}}\nbutton.y{gap:2px}\n.y a{left:0}\ndiv{right:0}', 'a.css');
    const idx = buildStyleIndex(rules);
    const plain = [...idx] as StyleIndex;
    let compared = 0;
    for (const cls of ['', 'x', 'y', 'x y', 'z']) for (const tag of ['a', 'button', 'div', 'span']) for (const resting of [false, true]) {
      expect(stylesFor(idx, cls, tag, resting)).toEqual(stylesFor(plain, cls, tag, resting));
      compared++;
    }
    expect(compared).toBe(40);
    expect(stylesFor(idx, 'x y', 'a', false).map((d) => d.prop + ':' + d.value)).toContain('padding:1px');
    expect(stylesFor(idx, 'x', 'div', true).map((d) => d.prop + ':' + d.value)).toEqual(['margin:0', 'right:0']);
  });

  test('the bin forwards --job (case-folded) and --scope to the lint', () => {
    const html = '<!doctype html><html lang="en"><head><title>t</title><style>:root{--color-ink:#222}</style></head><body><main><h1>Letters</h1><p>A monthly letter about the harbour.</p><section><form><input type="email" name="email"><button>Join</button></form></section></main></body></html>';
    const file = tmpPage(html);
    const plain = runBin([file], path.dirname(file));
    expect(plain.out).toMatch(/^LINT: ask email-band-close index\.html:\d+ .*no job was named/m);
    const subscribe = runBin(['--job', 'Subscribe', file], path.dirname(file));
    expect(subscribe.out).not.toContain('email-band-close');
    const component = runBin(['--scope', 'component', file], path.dirname(file));
    expect(component.out).not.toContain('email-band-close');
    expect(component.out).not.toMatch(/^LINT: \w+ (missing-skip-link|template-nav|section-gap) /m);
  });

  test('a comma-heavy nested selector and a long unclosed list each lint in linear time', async () => {
    let t = performance.now();
    parseCss('a{' + ','.repeat(80000) + '{color:red}}', 'x.css');
    expect(performance.now() - t).toBeLessThan(3000);
    const dir = tmpTree({ 'index.html': '<!doctype html><html lang="en"><head><title>t</title></head><body><ul>' + '<li>item text here'.repeat(8000) + '</ul></body></html>' });
    t = performance.now();
    await lint([dir], { warn: () => {} });
    expect(performance.now() - t).toBeLessThan(8000);
  });

  test('a file over the size limit is skipped with a warning and a symlink cycle is walked once', () => {
    const dir = tmpTree({ 'site/index.html': '<!doctype html><title>t</title>', 'site/big.css': 'a{}' });
    fs.truncateSync(path.join(dir, 'site', 'big.css'), MAX_FILE_BYTES + 1);
    fs.symlinkSync(path.join(dir, 'site'), path.join(dir, 'site', 'loop'));
    const warned: string[] = [];
    const files = collectFiles([dir], (l) => warned.push(l));
    expect(files.map((f) => path.relative(dir, f))).toEqual(['site/index.html']);
    expect(warned).toEqual([`design-lint: skipped ${path.join(dir, 'site', 'big.css')} (2 MB, over the 2 MB limit)`]);
  });
});

describe('design-lint: hardening (ship review)', () => {
  test('a stylesheet one page links from another directory is linted once, with that page, and its waiver is weighed against the page', () => {
    const dir = tmpTree({
      'site/pages/index.html': '<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="../css/theme.css"></head><body><main><h1>The ledger</h1><p>The ledger keeps its grey rows grey on purpose.</p></main></body></html>',
      'site/css/theme.css': '/* gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey */\n:root { --color-ink: oklch(22% 0.03 250); --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }',
    });
    const whole = lintStatic([path.join(dir, 'site')], { cwd: dir, warn: () => {} });
    const pagesOnly = lintStatic([path.join(dir, 'site', 'pages')], { cwd: dir, warn: () => {} });
    expect(whole.contexts.filter((c) => c.cssFiles.some((f) => f.file.endsWith('theme.css')))).toHaveLength(1);
    expect(whole.findings.filter((f) => f.rule === 'waiver')).toEqual([]);
    expect(whole.findings.map((f) => [f.rule, f.grade, f.file]).sort()).toEqual(pagesOnly.findings.map((f) => [f.rule, f.grade, f.file]).sort());
  });

  test('a stylesheet linted on its own keeps its waivers: there is no page prose to share a word with', () => {
    const dir = tmpTree({ 'css/theme.css': '/* gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey */\n:root { --color-ink: oklch(22% 0.03 250); --color-gray: oklch(55% 0 0); }\n.row { border-color: var(--color-gray); }' });
    const r = lintStatic([path.join(dir, 'css')], { cwd: dir, warn: () => {} });
    expect(r.findings.filter((f) => f.rule === 'waiver')).toEqual([]);
    expect(r.findings.filter((f) => f.rule === 'zero-chroma-neutrals').map((f) => f.grade)).toEqual(['waived']);
  });

  test('a root-relative stylesheet href attaches from the lint root; a protocol-relative one is not local', () => {
    const dir = tmpTree({
      'site/pages/index.html': '<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="//cdn.example/x.css"></head><body><main><h1>The ledger</h1><p>The ledger closes the month.</p></main></body></html>',
      'site/css/theme.css': ':root { --color-ink: oklch(22% 0.03 250); }\nhtml, body { overflow-x: clip; }',
    });
    const { contexts, findings } = lintStatic([path.join(dir, 'site')], { cwd: dir, warn: () => {} });
    const page = contexts.find((c) => c.key.endsWith('index.html'))!;
    expect(page.cssFiles.map((c) => path.relative(dir, c.file))).toEqual(['site/css/theme.css']);
    expect(findings.filter((f) => f.rule === 'overflow-x-unclipped')).toEqual([]);
  });

  test('a stylesheet twelve pages link belongs to each of them and is never linted on its own', () => {
    const files: Record<string, string> = { 'css/site.css': ':root { --color-ink: oklch(22% 0.03 250); }\n' + Array.from({ length: 300 }, (_, i) => `.u${i} { color: var(--color-ink); padding: 4px; }`).join('\n') };
    for (let i = 0; i < 12; i++) files[`pages/p${i}.html`] = `<!doctype html><html lang="en"><head><title>P${i}</title><link rel="stylesheet" href="../css/site.css"></head><body><main><h1>Page ${i}</h1><p>Hello there.</p></main></body></html>`;
    const dir = tmpTree(files);
    const r = lintStatic([dir], { cwd: dir, warn: () => {} });
    expect(r.contexts.filter((c) => c.cssFiles.some((f) => f.file.endsWith('site.css')))).toHaveLength(12);
    expect(r.contexts.filter((c) => c.key.endsWith('css'))).toEqual([]);
    const rulesOf = (c: LintContext) => c.rules.filter((x) => x.file.endsWith('site.css'));
    expect(rulesOf(r.contexts[0])[0]).toBe(rulesOf(r.contexts[1])[0]);
  });

  test('a regex metacharacter in aria-labelledby does not abort the chrome family', () => {
    const warns: string[] = [];
    const file = tmpPage('<!doctype html><html lang="en"><head><title>t</title></head><body><section aria-labelledby="lbl("><p id="lbl(">Label</p><p>Body copy for the section.</p></section><nav><a href="/">Home</a><a href="/about">About</a><a href="/pricing">Pricing</a><a href="/blog">Blog</a><a href="/contact">Contact</a><a class="button" href="/go">Start</a></nav></body></html>');
    const r = lintStatic([path.dirname(file)], { warn: (l) => warns.push(l) });
    expect(warns.filter((w) => /internal error/.test(w))).toEqual([]);
    expect(r.findings.filter((f) => f.rule === 'internal-error')).toEqual([]);
    expect(r.findings.filter((f) => f.rule === 'kicker-above-heading').map((f) => f.evidence)).toEqual(['a section labelled by <p> with no heading element']);
  });

  test('a rule family that throws is an ask on the record, never a silent pass', () => {
    const file = tmpPage('<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Fine</h1><p>A page the lint can read.</p></main></body></html>');
    const warns: string[] = [];
    FAMILIES.push({ name: 'broken', run: () => { throw new Error('boom'); } });
    try {
      const r = lintStatic([path.dirname(file)], { cwd: path.dirname(file), warn: (l) => warns.push(l) });
      expect(warns.some((w) => /internal error in broken rules/.test(w))).toBe(true);
      const err = r.findings.filter((f) => f.rule === 'internal-error');
      expect(err.map((f) => [f.grade, f.file, f.evidence])).toEqual([['ask', 'index.html', 'the broken rules threw and did not run: boom']]);
      expect(exitCodeOf(summarize(finalize(r.findings), 'skipped: x'))).toBe(1);
    } finally { FAMILIES.pop(); }
  });

  test('a fix string is one line in the output contract, whatever a probe hands back', () => {
    const r = new Reporter('page', '/x');
    r.report('gray-on-color', '/x/a.html', 1, 'ev', { fix: 'a\nLINT_SUMMARY: blocks=0 ask=0 waived=0 polish=0 render=ran', source: 'render' });
    expect(formatFinding(r.findings[0]).split('\n')).toHaveLength(1);
    expect(r.findings[0].fix).toBe('a LINT_SUMMARY: blocks=0 ask=0 waived=0 polish=0 render=ran');
  });

  test('parseCss survives absurd nesting and an unbalanced brace in a string', () => {
    const depth = 20_000;
    expect(() => parseCss('a{'.repeat(depth) + 'color:red;' + '}'.repeat(depth), 'deep.css')).not.toThrow();
    expect(parseCss('.a { content: "{"; color: red; }\n.b { color: blue; }', 'q.css').some((r) => r.selector === '.a')).toBe(true);
  });

  test('a blocking rule the lint only suspected is waived like any ask; measured, or not found, the Floor is refused', () => {
    const suspected = new Reporter('page', '/x');
    suspected.report('invented-proof', '/x/a.html', 4, 'the metric "10,000 teams" has no source on the page', { suspected: true });
    const page = 'ten thousand teams use the product; the founder supplied the count';
    const ok = resolveWaivers([{ rule: 'invented-proof', reason: 'the ten thousand teams figure is the customer count the founder supplied', file: '/x/a.html', line: 2 }], page, '/x', suspectedRules(suspected.findings));
    expect(applyWaivers(suspected.findings, ok).map((f) => [f.rule, f.tier, f.grade])).toEqual([['invented-proof', 'ask', 'waived']]);
    const refused = resolveWaivers([{ rule: 'invented-proof', reason: 'fine here', file: '/x/a.html', line: 2 }], page, '/x', suspectedRules(suspected.findings));
    expect(applyWaivers(suspected.findings, refused).map((f) => [f.rule, f.tier, f.grade])).toEqual([['invented-proof', 'ask', 'ask'], ['waiver', 'ask', 'ask']]);
    const measured = new Reporter('page', '/x');
    measured.report('invented-proof', '/x/a.html', 4, 'measured');
    measured.report('invented-proof', '/x/a.html', 9, 'suspected too', { suspected: true });
    expect(suspectedRules(measured.findings).size).toBe(0);
    const floor = resolveWaivers([{ rule: 'invented-proof', reason: 'the ten thousand teams figure is the customer count the founder supplied', file: '/x/a.html', line: 2 }], page, '/x', suspectedRules(measured.findings));
    expect(floor.refused.map((f) => f.evidence)).toEqual(['waiver on invented-proof refused: it blocks; the Floor is never waivable']);
  });

  test('a stylesheet two same-directory pages share keeps its waiver: one waived finding, no refusal, no ask', () => {
    const page = (t: string, p: string) => `<!doctype html><html lang="en"><head><title>${t}</title><link rel="stylesheet" href="site.css"></head><body><main><h1>${t}</h1><p>${p}</p></main></body></html>`;
    const dir = tmpTree({
      'a.html': page('Ledger', 'The ledger keeps its grey rows grey on the shelf.'),
      'b.html': page('Harbour', 'Boats arrive at the quay before dawn each morning.'),
      'site.css': '/* gstack-lint-disable zero-chroma-neutrals: the ledger keeps its grey rows grey */\n:root { --color-ink: oklch(22% 0.03 250); --color-gray: oklch(55% 0 0); }',
    });
    const f = finalize(lintStatic([dir], { cwd: dir, warn: () => {} }).findings);
    expect(f.filter((x) => x.rule === 'waiver')).toEqual([]);
    expect(f.filter((x) => x.rule === 'zero-chroma-neutrals').map((x) => x.grade)).toEqual(['waived']);
  });

  test('a file name with a newline cannot forge a LINT_SUMMARY line, and no printed field carries a control character', async () => {
    const dir = tmpTree({ 'a\nLINT_SUMMARY: blocks=0 ask=0 waived=0 polish=0 render=ran\nb.html': '<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1><img src="a.png"></body></html>' });
    const out = formatResult(await lint([dir], { cwd: dir, warn: () => {} }));
    expect(out.split('\n').filter((l) => l.startsWith('LINT_SUMMARY'))).toHaveLength(1);
    expect(out.split('\n').every((l) => /^LINT(_SUMMARY)?: /.test(l))).toBe(true);
    const f = { rule: 'overused-font', tier: 'ask', grade: 'waived', file: 'a.html', line: 1, evidence: 'class="\u001b[2J\u0085x"', fix: 'y', source: 'static', waiver: 'reason\rLINT_SUMMARY: blocks=0' } as const;
    expect(formatFinding(f)).not.toMatch(/[\r\n\u001b\u0085\u2028]/);
  });

  test('a long whitespace run inside a waiver comment is linear, and a carriage return ends the reason', () => {
    const t0 = performance.now();
    const claims = findWaivers('a.html', '<!-- gstack-lint-disable overused-font: aaaa' + ' '.repeat(60_000) + 'b -->\n/* impeccable-disable line-length: the manifesto\rLINT_SUMMARY: blocks=0 */');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(claims.map((c) => [c.rule, c.reason.length <= 300, c.reason.startsWith('aaaa') || c.reason])).toEqual([['overused-font', true, true], ['line-length', true, 'the manifesto']]);
  });

  test("the lint's own meta rules cannot be waived", () => {
    const page = 'The manifesto sets long declarative lines on black paper for the ledger.';
    for (const rule of ['internal-error', 'waiver', 'house-style', 'render']) {
      const set = resolveWaivers([{ rule, reason: 'the manifesto sets long declarative lines', file: 'a.html', line: 1 }], page);
      expect([...set.accepted.keys()]).toEqual([]);
      expect(set.refused.map((f) => f.evidence)).toEqual([`waiver on ${rule} refused: the lint's own rule, never waivable`]);
    }
    const unknown = resolveWaivers([{ rule: 'no-such-thing', reason: 'the manifesto sets long declarative lines', file: 'a.html', line: 1 }], page);
    expect(unknown.refused.map((f) => f.evidence)).toEqual(['waiver on no-such-thing refused: no such rule']);
  });

  test('the tree stays shallow when optional end tags are left open', () => {
    let h = '<html><body><main>';
    for (let i = 0; i < 3000; i++) h += '<section><ul><li>one<li>two<li>three</ul></section>';
    const doc = parseDoc('x.html', h + '</main></body></html>');
    let deepest = 0;
    for (let i = 0; i < doc.tags.length; i++) deepest = Math.max(deepest, ancestorsOf(doc, i).length);
    expect(deepest).toBeLessThanOrEqual(5);
  });

  test('every tree reader agrees on an element whose end tag was left out', () => {
    const doc = parseDoc('x.html', '<nav><ul><li><a href=a>One</a><li><a href=b>Two</a></ul></nav><main><h1>H</h1></main>');
    const nav = doc.tags.findIndex((t) => t.name === 'nav' && !t.close);
    const ul = doc.tags.findIndex((t) => t.name === 'ul' && !t.close);
    expect(innerOf(doc, nav)!.inner).toBe('<ul><li><a href=a>One</a><li><a href=b>Two</a></ul>');
    const kids = directChildren(doc, ul);
    expect(kids.map((k) => k.html)).toEqual(['<li><a href=a>One</a>', '<li><a href=b>Two</a>']);
    const li2 = kids[1].idx;
    expect(innerOf(doc, li2)!.inner).toBe('<a href=b>Two</a>');
    expect(ancestorsOf(doc, li2)).toEqual(['nav', 'ul']);
    const h1 = doc.tags.findIndex((t) => t.name === 'h1');
    expect(ancestorsOf(doc, h1)).toEqual(['main']);
  });

  test('a stray close tag and a mismatched close tag do not deepen what follows', () => {
    const doc = parseDoc('x.html', '<div><span>a</div></em><p>b</p><b>c</b>');
    const p = doc.tags.findIndex((t) => t.name === 'p');
    const b = doc.tags.findIndex((t) => t.name === 'b');
    expect(ancestorsOf(doc, p)).toEqual([]);
    expect(ancestorsOf(doc, b)).toEqual([]);
    const span = doc.tags.findIndex((t) => t.name === 'span');
    expect(innerOf(doc, span)!.inner).toBe('a');
  });

  test('deep nesting costs its depth, not its square', () => {
    const src = '<html><body>' + '<div>'.repeat(20000) + 'x' + '</div>'.repeat(20000) + '</body></html>';
    const doc = parseDoc('a.html', src);
    const { parent, close } = treeOf(doc);
    expect([parent.length, close.length]).toEqual([doc.tags.length, doc.tags.length]);
    expect(ancestorsOf(doc, 20001).length).toBe(512);
    expect(innerOf(doc, 20001)!.inner).toBe('');
    expect(innerOf(doc, 400)!.inner.length).toBeGreaterThan(1000);
    expect(parent[2]).toBe(1);
  });

  test('commented-out style and script are not live markup', () => {
    const d = parseDoc('a.html', '<!-- <style>h1{color:#000}</style><script>fetch(1)</script> -->\n<p>x</p>');
    expect(d.styles).toHaveLength(0);
    expect(d.scripts.trim()).toBe('');
    expect(d.tags.map((t) => t.name)).toEqual(['p', 'p']);
    expect(d.text.trim()).toBe('x');
  });

  test('an unclosed comment, script, style or tag parses in linear time', () => {
    for (const frag of ['<a ', '<!--', '<script>', '<style>', '<a<a']) {
      const t = performance.now();
      const d = parseDoc('x.html', frag.repeat(60000));
      expect(performance.now() - t).toBeLessThan(2000);
      expect(d.styles).toEqual([]);
    }
    const d = parseDoc('x.html', '<style>a{color:red}</style><p class="x">t</p><!-- c --><script>var a</script>');
    expect(d.styles.map((s) => s.css)).toEqual(['a{color:red}']);
    expect(d.scripts.trim()).toBe('var a');
    expect(d.tags.filter((t) => !t.close).map((t) => t.name)).toEqual(['style', 'p', 'script']);
    expect(d.text.trim()).toBe('t');
  });

  test('quoted and odd attribute text still scan as one tag', () => {
    const d = parseDoc('x.html', '<a title="x > y" data-s=\'<b>\' href="a<b">t</a><img src="data:image/png;base64,AAAA" alt="">');
    expect(d.tags.filter((t) => !t.close).map((t) => [t.name, t.attrs.trim()])).toEqual([['a', 'title="x > y" data-s=\'<b>\' href="a<b"'], ['img', 'src="data:image/png;base64,AAAA" alt=""']]);
    const e = parseDoc('x.html', '<div <span>a</span></div>');
    expect(e.tags.filter((t) => !t.close).map((t) => t.name)).toEqual(['span']);
  });

  test('a run of unclosed JSX elements scans in polynomial time', () => {
    let h = 'export default function A(){ return (';
    for (let i = 0; i < 26; i++) h += `<div className="a${i}">t${i} `;
    h += ');}\n';
    const t = performance.now();
    jsxPseudo(h);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test('a root-relative href that climbs out of the lint root attaches nothing', () => {
    const dir = tmpTree({
      'site/index.html': '<!doctype html><html lang="en"><head><title>t</title><link rel="stylesheet" href="/../outside.css"></head><body><main><h1>t</h1><p>Body.</p></main></body></html>',
      'outside.css': 'html, body { overflow-x: clip; }',
    });
    const { contexts } = lintStatic([path.join(dir, 'site')], { cwd: dir, warn: () => {} });
    expect(contexts[0].cssFiles).toEqual([]);
  });

  test('outline: none on :focus with no ring anywhere is missing-focus-visible at that line; a tokenless page with colour literals does not block on them', async () => {
    const file = tmpPage('<!doctype html><html lang="en"><head><title>t</title><meta name="description" content="x"><link rel="icon" href="data:,"><style>\nbody { color: #2b2b2b; background: #faf8f4; }\na:focus, button:focus { outline: none; }\n.card { box-shadow: 0 1px 3px rgba(0,0,0,.12); }\n</style></head><body><a href="#main">Skip to content</a><main id="main"><h1>Fine</h1><p>A plain page.</p><button>Go</button></main></body></html>');
    const r = await lint([path.dirname(file)], { cwd: path.dirname(file), warn: () => {} });
    expect(r.findings.filter((f) => f.rule === 'missing-focus-visible').map((f) => [f.grade, f.line, f.evidence])).toEqual([['blocks', 3, 'outline: none on a:focus, button:focus with nothing in its place: keyboard users cannot see where they are']]);
    expect(r.findings.filter((f) => f.rule === 'literal-outside-tokens')).toEqual([]);
  });

  test('a refused polish waiver leaves the polish finding alone and adds one ask refusal, so the exit code rises to 1', () => {
    const set = resolveWaivers([{ rule: 'balanced-display-head', reason: 'intentional by design', file: 'a.html', line: 2 }], 'the manifesto sets long lines');
    const out = applyWaivers([{ rule: 'balanced-display-head', tier: 'polish', grade: 'polish', file: 'a.html', line: 9, evidence: 'e', fix: 'f', source: 'static' }], set);
    expect(out.map((f) => [f.rule, f.grade])).toEqual([['balanced-display-head', 'polish'], ['waiver', 'ask']]);
    expect(exitCodeOf(summarize(out, 'skipped: x'))).toBe(1);
  });
});
