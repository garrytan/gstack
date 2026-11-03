/**
 * GST-898: R51's rm and rmSync rules (lib/review-risk.ts) ran in quadratic time on one hostile added line ('rm -' and
 * 100,000 r's took about 3.2 s); every risk pattern finishes in linear time on its anchor followed by a long run of the
 * class it repeats, and the rewritten rm rule matches exactly the lines R51's pattern matched.
 */
import { describe, expect, test } from 'bun:test';
import { SVG_REFUSED, svgDrawing } from '../lib/review-depth';
import { DATA_LINE, MONEY_LINE, SECRET_LINE, SECRET_PATH, SECURITY_JOINED, SECURITY_LINE, matchRisk } from '../lib/review-risk';

const L = 100_000;
const ms = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
const run = (anchor: string, unit: string, tail = '') => [JSON.stringify(anchor) + ' + ' + JSON.stringify(unit) + '*n' + (tail ? ' + ' + JSON.stringify(tail) : ''), anchor + unit.repeat(Math.ceil(L / unit.length)) + tail] as const;
const security = (line: string) => matchRisk({ codePaths: ['x.sh'], added: { 'x.sh': [line] }, removed: {}, scopeAuth: false }).has('security');

describe('linear time on hostile input', () => {
  // Value: protects=gstack-review-plan, the targeted pass and the queue depth check never stall on one added line;
  //   fails_when=any risk pattern backtracks quadratically on its anchor followed by a long run of the class it repeats,
  //   or on a line of repeated anchors; seam=every pattern in SECURITY_LINE, DATA_LINE, SECRET_LINE, MONEY_LINE and SECRET_PATH
  const hostile = [
    run('rm -', 'r'), run('rm -', 'f'), run('rm -r', 'r'), run('rm -f', 'a'), run('rm\t-', 'r'), run('rm ', ' '), run('rm -', 'r', '1'), run('rm -', 'rf', '_'), run('', 'rm -r '),
    run('', 'rmSync('), run('rmSync(', ' '), run('rmSync(', 'recursive '), run('rmSync(', 'recursive: '), run('', '.rm('), run('.rm(', ' '), run('.rm(', 'recursive: '), run('', 'rm('), run('rm(', ' '), run('rmSync(', ' \n'),
    run('shell', ' '), run('shell:', ' '), run('shell=', ' '), run('', '; '), run(';', ' '), run('; eval', ' '), run('eval', ' '), run('', ';eval '),
    run('execSync', ' '), run('child_process.exec', ' '), run('os.system', ' '), run('new', ' '), run('new Function', ' '),
    run('spawn(', ' '), run('Bun.spawn(', ' '), run('Bun.spawn([', ' '), run('innerHTML', ' '),
    run('tar -', 'A'), run('tar x', 'A'), run('tar', ' '), run('redirect', ' '), run('redirect:', ' '), run('maxRedirects', ' '),
    run('DELETE', ' '), run('drop', ' '), run('truncate', ' '), run('delete from', ' '), run('delete from ', 'a.'), run('', 'delete from a '), run('.deleteMany', ' '),
    run('', 'a_'), run('', 'aU'), run('a', 'A'), run('spend', '_'), run('new Anthropic', ' '), run('.messages.create', ' '),
    run('$', 'A_'), run('${', 'A_'), run('', '$A_'), run('process.env.', 'A_'), run('process.env[', ' '), run('os.environ[', ' '), run('os.getenv(', ' '), run('ENV[', ' '),
  ];
  test.each(Object.entries({ SECURITY_LINE, SECURITY_JOINED, DATA_LINE, SECRET_LINE, MONEY_LINE, SECRET_PATH: [SECRET_PATH] }))('every %s pattern finishes under 100 ms on each 100k-character hostile line', (_n, patterns) => {
    const slow = patterns.flatMap(r => hostile.map(([label, s]) => [r.source.slice(0, 50), label, Math.round(ms(() => r.test(s)))] as const)).filter(([, , t]) => t >= 100);
    expect(slow).toEqual([]);
  }, 120_000);
  test("matchRisk on 'rm -' and 100,000 r's (the GST-898 repro) returns in under 250 ms and raises no class", () => {
    const line = 'rm -' + 'r'.repeat(100_000);
    let hit = true;
    expect(ms(() => { hit = security(line); })).toBeLessThan(250);
    expect(hit).toBe(false);
  }, 60_000);
});

describe('the rm rule matches what R51 matched', () => {
  // Value: protects=the rewrite changes no verdict; fails_when=the linear rm pattern matches a line R51's pattern did not, or misses
  //   one it did; seam=SECURITY_LINE's rm pattern against R51's original source
  const r51 = /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/;
  const rm = SECURITY_LINE.find(r => r.source.startsWith(String.raw`\brm\s+-`))!;
  let x = 898;
  const next = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
  test('the same verdict on 60,000 seeded short lines and the hand-picked edges', () => {
    x = 898;
    const prefixes = ['rm -', 'rm  -', 'xrm -', ' rm\t-', 'rm-', 'rm -- ', '"rm -', 'brm -', 'rm -r ', ''];
    const alphabet = 'rfrfrfFRa1_- .x/m';
    const lines = Array.from({ length: 60_000 }, () => prefixes[next(prefixes.length)] + Array.from({ length: next(11) }, () => alphabet[next(alphabet.length)]).join(''));
    const edges = ['rm -rf /', 'rm -fr x', 'rm -Rf x', 'rm -rF x', 'rm -rvf x', 'rm -frv', 'rm -r -f x', 'rm -rf1', 'rm -rf_x', 'rm -rfx', 'rm -rf-x', 'rm -f', 'rm -r', 'rm -rrf', 'rm -ffr', 'rm -rfr', 'farm -rf x', 'rm-rf x', 'rm\t\t-rf', 'sudo rm -rf "$DIR"'];
    const differ = [...lines, ...edges].filter(s => rm.test(s) !== r51.test(s));
    expect(differ).toEqual([]);
    expect(lines.filter(s => r51.test(s)).length).toBeGreaterThan(1000);
    expect(edges.filter(s => rm.test(s))).toEqual(['rm -rf /', 'rm -fr x', 'rm -rvf x', 'rm -rf-x', 'rm -rrf', 'rm -ffr', 'rm -rfr', 'rm\t\t-rf', 'sudo rm -rf "$DIR"']);
  });
  test('the rmSync rule matches every line R51 matched on 60,000 seeded short lines, and padding past its window still raises security', () => {
    x = 898;
    const r51Sync = /\brmSync\s*\([^)]*recursive\s*:\s*true/;
    const rmSync = SECURITY_LINE.find(r => r.source.startsWith(String.raw`\brmSync`))!;
    const parts = ['rmSync(', 'rmSync (', 'xrmSync(', 'recursive', ':', ' ', 'true', ')', 'a', 'recursive: true', 'rmSync', '(', '\t'];
    const lines = Array.from({ length: 60_000 }, () => Array.from({ length: next(9) + 1 }, () => parts[next(parts.length)]).join(''));
    expect(lines.filter(s => r51Sync.test(s) && !rmSync.test(s))).toEqual([]);
    expect(lines.filter(s => r51Sync.test(s)).length).toBeGreaterThan(1000);
    expect(security('fs.rmSync(dir, { recursive: true, force: true });')).toBe(true);
    expect(security('fs.rmSync(' + 'a'.repeat(480) + ', { recursive: true })')).toBe(true);
    expect(security('fs.rmSync(dir, /*' + 'x'.repeat(501) + '*/ { recursive: true, force: true });')).toBe(true);
    expect(security('fs.rmSync(dir, /*' + 'x'.repeat(5_000_000) + '*/ { recursive: true });')).toBe(true);
    expect(security('fs.rmSync(dir, { force: true });')).toBe(false);
  });
  test('a recursive rm or rmSync whose first argument is a call, or whose arguments hold a ), raises security (GST-942)', () => {
    // Value: protects=a recursive delete written the common way keeps the security class; fails_when=the rule stops at the first
    //   ) inside the first argument or a comment, or skips the async fs.rm; seam=matchRisk on one added line
    const recursive = ['fs.rmSync(path.join(dir, "x"), { recursive: true, force: true });', 'fs.rmSync(dir, /* ) */ { recursive: true });',
      'fs.rmSync(path.resolve(root, name), { recursive: true });', 'await fs.promises.rm(path.join(dir, "x"), { recursive: true });',
      'await fs.rm(dir, { recursive: true })', "await rm(dir, { recursive: true, force: true }); // import { rm } from 'node:fs/promises'",
      'fs.rm(' + 'a'.repeat(600) + ', { force: true })'];
    expect(recursive.filter(l => !security(l))).toEqual([]);
    expect(['fs.rm(path.join(dir, "x"), { force: true });', 'farm(x, { recursive: true });', 'confirm(x, { recursive: true });'].filter(security)).toEqual([]);
  });
  test('a recursive delete a formatter split across lines raises security, read over the joined lines (GST-942 review)', () => {
    // Value: protects=a Prettier-formatted rmSync or fs.promises.rm keeps the security class; fails_when=the delete rules read
    //   only one line at a time; seam=matchRisk over a file's added lines
    const split = (lines: string[]) => matchRisk({ codePaths: ['src/clean.ts'], added: { 'src/clean.ts': lines }, removed: {}, scopeAuth: false }).has('security');
    expect(split(['  fs.rmSync(path.join(root, "build-output-cache"), {', '    recursive: true,', '    force: true,', '  });'])).toBe(true);
    expect(split(['  await fs.promises.rm(', '    path.join(root, "cache"),', '    { recursive: true },', '  );'])).toBe(true);
    expect(split(['  fs.rmSync(', '    dir,', '    /*' + 'x'.repeat(510) + '*/', '    { recursive: true },', '  );'])).toBe(true);
    expect(split(['  fs.rmSync(path.join(root, "file"), {', '    force: true,', '  });'])).toBe(false);
  });
});

describe('svgDrawing in linear time', () => {
  // Value: protects=gstack-review-plan and the commit collector behind ship-queue ready, train build and land never stall on one
  //   changed SVG; fails_when=a whole-text SVG pattern backtracks quadratically on a long whitespace run, or the linear url()
  //   refusal reads any url( differently from #3838's pattern; seam=SVG_REFUSED's url() entry and svgDrawing
  const old = /url\(\s*(?!['"]?\s*#)/i;
  test('a 1 MB whitespace run in url(), an attribute, a style element and an href returns in under 250 ms each', () => {
    const pad = ' '.repeat(1_000_000);
    const cases = [
      ['<svg><rect fill="url(' + pad + '#a)"/></svg>', true], ['<svg><rect fill="url(' + pad + 'x)"/></svg>', false],
      ['<svg><rect fill' + pad + '="red"/></svg>', true], ['<svg><style>rect{fill:url(' + pad + '#a)}</style></svg>', true],
      ['<svg><use href="' + pad + '#a"/></svg>', true], ['<svg>' + pad + '</svg>', true],
    ] as const;
    const wrong = cases.map(([s, want], i) => { let got = !want; const t = ms(() => { got = svgDrawing(s); }); return [i, got === want, Math.round(t)] as const; }).filter(([, ok, t]) => !ok || t >= 250);
    expect(wrong).toEqual([]);
  }, 60_000);
  test("the url() refusal matches #3838's pattern on 60,000 seeded short strings and the hand-picked edges", () => {
    const url = SVG_REFUSED.find(r => r.source.startsWith('url'))!;
    let x = 911;
    const next = (n: number) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
    const parts = ['url(', 'URL(', ' ', '\t', '\n', '#', "'", '"', 'a', '#a', ')', 'http:', '(', 'u'];
    const lines = Array.from({ length: 60_000 }, () => Array.from({ length: next(8) + 1 }, () => parts[next(parts.length)]).join(''));
    const edges = ['url(#a)', 'url( #a)', "url('#a')", "url( '#a')", 'url(  "#a")', 'url("  #a")', 'url(\t#a)', 'url(x)', 'url( x)', "url('http://x')", 'url(', 'url( ', "url('')"];
    expect([...lines, ...edges].filter(s => url.test(s) !== old.test(s))).toEqual([]);
    expect(lines.filter(s => old.test(s)).length).toBeGreaterThan(1000);
    expect(lines.filter(s => /url\(/i.test(s) && !old.test(s)).length).toBeGreaterThan(100);
  });
});
