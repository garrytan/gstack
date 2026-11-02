/**
 * GST-850: the new security and money patterns (lib/review-risk.ts) finish in linear time on hostile input, and every one of
 * them is in RISK_RULES, which DEPTH_RULES folds in (docs/review-policy.md#risk-classes).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { matchRisk } from '../lib/review-risk';

const ROOT = path.join(import.meta.dir, '..');
const N = 10_000;
const fast = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
const scan = (lines: string[]) => matchRisk({ codePaths: ['src/a.ts'], added: { 'src/a.ts': lines }, removed: { 'src/a.ts': lines }, scopeAuth: false });

describe('linear time on hostile input', () => {
  // Value: protects=gstack-review-plan and the queue verdict never hang on a diff (the R51 resource regex did at about 50
  //   backslashes; round 1 of GST-850 found a quadratic split-import scan); fails_when=a risk pattern or the split-import
  //   scan backtracks on long input; seam=matchRisk
  test('a 512 KB comment of unclosed imports and a long path.join chain finish under 200 ms', () => {
    expect(fast(() => scan(Array.from({ length: 65_536 }, () => 'import {')))).toBeLessThan(200);
    expect(fast(() => scan(['path.join('.repeat(50_000)]))).toBeLessThan(200);
  });
  test('the risk patterns finish under 100 ms on 10k-character lines', () => {
    for (const body of ['\\'.repeat(N), 'fetch(' + "'".repeat(N), 'import {' + ' exec'.repeat(N / 5), 'path.join(' + 'a'.repeat(N), 'import ' + 'a '.repeat(N / 2) + 'from', 'require(' + ' '.repeat(N),
      ' '.repeat(N) + '} = require(', "'..".repeat(N / 3), 'x'.repeat(N) + 'Usage', 'tar ' + '-'.repeat(N), 'import {'.repeat(N / 8), 'new URL(' + '"'.repeat(N)])
      expect(fast(() => scan([body]))).toBeLessThan(100);
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
      fs.symlinkSync(path.join(ROOT, 'lib/ship-policy.ts'), path.join(dir, 'ship-policy.ts'));
      fs.writeFileSync(path.join(dir, 'print.ts'), "import { DEPTH_RULES } from './review-depth';\nconsole.log(DEPTH_RULES);\n");
      const hash = () => {
        const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });
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
