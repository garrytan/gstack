/**
 * GST-850: the allowlisted docs paths (lib/review-allowlist.ts) read whole inputs in linear time, and every pattern that decides
 * a risk class or an allowlisted path is in DEPTH_RULES (docs/review-policy.md#allowlisted-docs-paths).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { localeTextOnly, presentationalSvg } from '../lib/review-allowlist';
import { matchRisk } from '../lib/review-risk';

const ROOT = path.join(import.meta.dir, '..');
const N = 10_000;
const fast = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };

describe('linear time on hostile input', () => {
  // Value: protects=gstack-review-plan and the queue verdict never hang on a diff (the R51 resource regex did at about 50
  //   backslashes); fails_when=any scanner or risk pattern backtracks on a 10k-character input; seam=presentationalSvg,
  //   localeTextOnly and matchRisk
  const svgInputs = ['\\'.repeat(N), '<'.repeat(N), '<g '.repeat(N), '&'.repeat(N), '<svg xmlns="' + '\\'.repeat(N), '<svg ' + ' '.repeat(N) + 'x="' + '"'.repeat(N),
    '<svg xmlns="http://www.w3.org/2000/svg">' + '<g>'.repeat(N) + '</g>'.repeat(N) + '</svg>', '</g' + ' '.repeat(N) + '>', '<!--' + '-'.repeat(N), '<svg fill="' + 'url('.repeat(N) + '"/>'];
  test.each(svgInputs.map((s, n) => [n, s]))('SVG input %i finishes under 100 ms', (_n, s) => {
    expect(fast(() => presentationalSvg(s as string))).toBeLessThan(100);
  });
  const formats: [string, string, string][] = [
    ['locales/en.json', '"k": "', '",'], ['locales/en.arb', '"k": "', '",'], ['locales/en.yml', 'k: "', '"'], ['locales/en.yml', "k: '", "'"], ['locales/fr.po', 'msgstr "', '"'],
    ['locales/en.strings', '"k" = "', '";'], ['locales/fr.xlf', '<target>', '</target>'], ['locales/en.ftl', 'k = ', ''], ['locales/en.properties', 'k=', ''],
  ];
  test.each(formats)('%s with 10k backslashes, quotes, braces and percent signs finishes under 100 ms', (p, open, close) => {
    for (const body of ['\\'.repeat(N), '\\'.repeat(N) + 'x', "'".repeat(N), '{'.repeat(N), '%1'.repeat(N / 2), '%' + '0'.repeat(N), '{{'.repeat(N / 2), '$t('.repeat(N / 3)]) {
      const line = open + body + close;
      expect(fast(() => localeTextOnly(p, [open + 'x' + close], [line]))).toBeLessThan(100);
      expect(fast(() => localeTextOnly(p, [line], [line]))).toBeLessThan(100);
    }
  });
  test('a 512 KB comment of unclosed imports and a long path.join chain finish under 200 ms', () => {
    const lines = Array.from({ length: 65_536 }, () => 'import {');
    expect(fast(() => matchRisk({ codePaths: ['src/a.ts'], added: { 'src/a.ts': lines }, removed: {}, scopeAuth: false }))).toBeLessThan(200);
    expect(fast(() => matchRisk({ codePaths: ['src/a.ts'], added: { 'src/a.ts': ['path.join('.repeat(50_000)] }, removed: {}, scopeAuth: false }))).toBeLessThan(200);
  });
  test('the risk patterns finish under 100 ms on 10k-character lines', () => {
    for (const body of ['fetch(' + "'".repeat(N), 'import {' + ' exec'.repeat(N / 5), 'path.join(' + 'a'.repeat(N), 'import ' + 'a '.repeat(N / 2) + 'from', 'require(' + ' '.repeat(N),
      ' '.repeat(N) + '} = require(', "'..".repeat(N / 3), 'x'.repeat(N) + 'Usage', 'tar ' + '-'.repeat(N), 'import {'.repeat(N / 8)]) {
      expect(fast(() => matchRisk({ codePaths: ['src/a.ts'], added: { 'src/a.ts': [body] }, removed: { 'src/a.ts': [body] }, scopeAuth: false }))).toBeLessThan(100);
    }
  });
});

describe('the rules hashes cover every new pattern', () => {
  // Value: protects=a receipt or queue verdict notices an allowlist or risk-pattern edit; fails_when=an edit to an SVG element,
  //   a locale format, a security pattern or a money word leaves DEPTH_RULES unchanged; seam=DEPTH_RULES over ALLOWLIST_RULES and RISK_RULES
  test.each([
    ['review-allowlist.ts', "'foreignObject'", "'clipPath', 'foreignObject',", "'clipPath',"],
    ['review-allowlist.ts', "'properties'];", "'properties', 'ini'];", null],
    ['review-risk.ts', "'billable', 'billed'", "'billable', 'billed', 'tariff'", null],
    ['review-risk.ts', 'extract-zip|unzipper', 'extract-zip|unzipper|jszip', null],
  ])('editing %s (%s) changes DEPTH_RULES', (file, _what, to, from) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-rules-'));
    try {
      for (const f of ['review-depth.ts', 'review-risk.ts', 'review-allowlist.ts']) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(dir, f));
      fs.symlinkSync(path.join(ROOT, 'lib/ship-policy.ts'), path.join(dir, 'ship-policy.ts'));
      fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
      const hash = () => {
        const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      const before = hash();
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const needle = from ?? _what;
      expect(src).toContain(needle);
      fs.writeFileSync(path.join(dir, file), src.replace(needle, to));
      expect(before).toMatch(/^[0-9a-f]{16}$/);
      expect(hash()).not.toBe(before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
