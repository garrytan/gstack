/**
 * GST-850: every risk pattern (lib/review-risk.ts) finishes in linear time on hostile input, and every new one is in
 * RISK_RULES, which DEPTH_RULES folds in (docs/review-policy.md#risk-classes).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { DATA_LINE, MONEY_LINE, SECRET_LINE, SECURITY_LINE, matchRisk } from '../lib/review-risk';

const ROOT = path.join(import.meta.dir, '..');
const N = 10_000;
const fast = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
const scan = (lines: string[]) => matchRisk({ codePaths: ['src/a.ts'], added: { 'src/a.ts': lines }, removed: { 'src/a.ts': lines }, scopeAuth: false });

describe('linear time on hostile input', () => {
  // Value: protects=gstack-review-plan and the queue verdict never hang on a diff (the R51 resource regex did at about 50
  //   backslashes; GST-850 rounds 1 and 2 found quadratic import and exec-binding scans); fails_when=any risk pattern
  //   backtracks on a long or minified line, or on its anchor followed by a long run of the class it repeats; seam=every
  //   pattern in SECURITY_LINE, DATA_LINE, SECRET_LINE and MONEY_LINE (R51's rm rule is a known pre-existing issue, filed apart), and matchRisk
  const L = 200_000;
  const fill = (s: string) => s.repeat(Math.ceil(L / s.length));
  const hostile = [' ', '(', "'", '"', 'a', '{', '\\', '..', 'import a, {', 'fetch(', 'path.join(', 'rmSync(', '  exec', 'new URL("', 'child_process', 'http.get(', 'requests.',
    'tar -', 'unzip ', 'DELETE FROM ', 'delete from a ', 'process.env.', 'x_usd', 'aUsd'].map(fill).concat(['  exec' + ' '.repeat(L) + '// c', 'import a, {' + 'b,'.repeat(L / 2)],
    ['fetch', 'globalThis.fetch', 'http.get', 'https.request', 'got', 'urlopen', 'urljoin', 'url.resolve', 'exec', 'execSync', 'cp.exec', 'proxy', 'redirect', 'maxRedirects', 'tar.extract', 'unzip', 'tar'].map(a => a + ' '.repeat(L)),
    ['got.', 'requests.', 'httpx.', 'tar -', 'tar x', 'rm -', 'allowed_', 'host_allow', 'node_modules/adm-'].map(a => a + 'x'.repeat(L)),
    ['new' + ' '.repeat(L) + 'URL(', 'new URL(' + ' '.repeat(L), 'new URL("' + 'a'.repeat(L), "'" + 'node:'.repeat(L / 5), 'path.join(' + 'a'.repeat(L), 'path.join(' + ')'.repeat(L),
      "includes(" + ' '.repeat(L), '==' + ' '.repeat(L) + "'..'", "'..'" + ' '.repeat(L) + '==', '\\.' + '\\'.repeat(L)]);
  test.each(Object.entries({ SECURITY_LINE, DATA_LINE, SECRET_LINE, MONEY_LINE }))('every %s pattern finishes under 100 ms on each 200k-character hostile line', (_n, patterns) => {
    const slow = patterns.flatMap(r => hostile.map((s, k) => [r.source.slice(0, 40), k, fast(() => r.test(s))] as const)).filter(([, , ms]) => ms >= 100);
    expect(slow).toEqual([]);
  });
  test('a 512 KB comment of unclosed imports and a minified import line run through matchRisk in under 1 s', () => {
    expect(fast(() => scan(Array.from({ length: 65_536 }, () => 'import {')))).toBeLessThan(1000);
    expect(fast(() => scan(['import a, {'.repeat(32_000)]))).toBeLessThan(1000);
  });
});

describe('the rules hashes cover every new pattern', () => {
  // Value: protects=a receipt or queue verdict notices a risk-pattern edit; fails_when=an edit to a security pattern or a money
  //   word leaves DEPTH_RULES unchanged; seam=DEPTH_RULES over RISK_RULES
  test.each([
    ["'billable', 'billed'", "'billable', 'billed', 'tariff'"],
    ['extract-zip|unzipper', 'extract-zip|unzipper|jszip'],
    ["['proxy', ['billing', 'bill']]", "['proxy', ['billing', 'bill', 'meter']]"],
  ])('editing review-risk.ts (%s) changes DEPTH_RULES', (needle, to) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-rules-'));
    try {
      for (const f of ['review-depth.ts', 'review-risk.ts']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(dir, f));
      for (const f of ['ship-policy.ts', 'redact-engine.ts', 'redact-patterns.ts']) fs.symlinkSync(path.join(ROOT, 'lib', f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
      const hash = () => {
        const r = spawnSync(process.execPath, [...bunIsolationArgs(), path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      const before = hash();
      const src = fs.readFileSync(path.join(dir, 'review-risk.ts'), 'utf8');
      expect(src).toContain(needle);
      fs.writeFileSync(path.join(dir, 'review-risk.ts'), src.replace(needle, to));
      expect(before).toMatch(/^[0-9a-f]{16}$/);
      expect(hash()).not.toBe(before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
