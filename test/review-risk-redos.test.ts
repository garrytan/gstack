/**
 * GST-898: R51's rm and rmSync rules (lib/review-risk.ts) ran in quadratic time on one hostile added line ('rm -' and
 * 100,000 r's took about 3.2 s); every risk pattern finishes in linear time on its anchor followed by a long run of the
 * class it repeats, and the rewritten rm rule matches exactly the lines R51's pattern matched.
 */
import { describe, expect, test } from 'bun:test';
import { DATA_LINE, MONEY_LINE, SECRET_LINE, SECRET_PATH, SECURITY_LINE, matchRisk } from '../lib/review-risk';

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
    run('', 'rmSync('), run('rmSync(', ' '), run('rmSync(', 'recursive '), run('rmSync(', 'recursive: '),
    run('shell', ' '), run('shell:', ' '), run('shell=', ' '), run('', '; '), run(';', ' '), run('; eval', ' '), run('eval', ' '), run('', ';eval '),
    run('execSync', ' '), run('child_process.exec', ' '), run('os.system', ' '), run('new', ' '), run('new Function', ' '),
    run('spawn(', ' '), run('Bun.spawn(', ' '), run('Bun.spawn([', ' '), run('innerHTML', ' '),
    run('tar -', 'A'), run('tar x', 'A'), run('tar', ' '), run('redirect', ' '), run('redirect:', ' '), run('maxRedirects', ' '),
    run('DELETE', ' '), run('drop', ' '), run('truncate', ' '), run('delete from', ' '), run('delete from ', 'a.'), run('', 'delete from a '), run('.deleteMany', ' '),
    run('', 'a_'), run('', 'aU'), run('a', 'A'), run('spend', '_'), run('new Anthropic', ' '), run('.messages.create', ' '),
    run('$', 'A_'), run('${', 'A_'), run('', '$A_'), run('process.env.', 'A_'), run('process.env[', ' '), run('os.environ[', ' '), run('os.getenv(', ' '), run('ENV[', ' '),
  ];
  test.each(Object.entries({ SECURITY_LINE, DATA_LINE, SECRET_LINE, MONEY_LINE, SECRET_PATH: [SECRET_PATH] }))('every %s pattern finishes under 100 ms on each 100k-character hostile line', (_n, patterns) => {
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
  test('the same verdict on 60,000 seeded short lines and the hand-picked edges', () => {
    let seed = 898;
    const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const prefixes = ['rm -', 'rm  -', 'xrm -', ' rm\t-', 'rm-', 'rm -- ', '"rm -', 'brm -', 'rm -r ', ''];
    const alphabet = 'rfFRa1_- .x/m';
    const lines = Array.from({ length: 60_000 }, () => prefixes[next(prefixes.length)] + Array.from({ length: next(11) }, () => alphabet[next(alphabet.length)]).join(''));
    const edges = ['rm -rf /', 'rm -fr x', 'rm -Rf x', 'rm -rF x', 'rm -rvf x', 'rm -frv', 'rm -r -f x', 'rm -rf1', 'rm -rf_x', 'rm -rfx', 'rm -rf-x', 'rm -f', 'rm -r', 'rm -rrf', 'rm -ffr', 'rm -rfr', 'farm -rf x', 'rm-rf x', 'rm\t\t-rf', 'sudo rm -rf "$DIR"'];
    const differ = [...lines, ...edges].filter(s => rm.test(s) !== r51.test(s));
    expect(differ).toEqual([]);
    expect(edges.filter(s => rm.test(s))).toEqual(['rm -rf /', 'rm -fr x', 'rm -rvf x', 'rm -rf-x', 'rm -rrf', 'rm -ffr', 'rm -rfr', 'rm\t\t-rf', 'sudo rm -rf "$DIR"']);
  });
  test('rmSync with recursive: true still raises security, up to 500 characters into the call', () => {
    expect(security('fs.rmSync(dir, { recursive: true, force: true });')).toBe(true);
    expect(security('fs.rmSync(' + 'a'.repeat(480) + ', { recursive: true })')).toBe(true);
  });
});
