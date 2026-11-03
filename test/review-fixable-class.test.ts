import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect, fixableRaises, parseFindings, verify } from '../lib/review-ledger';

const ROOT = path.resolve(import.meta.dir, '..');
const NATIVE = fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger/gsta-141-native.md'), 'utf8').split('\n').filter(l => /^\d+\. /.test(l)).join('\n\n');
const plan = (cls: string, reasons: string) => [`REVIEW_CLASS: ${cls} (x)`, `REVIEW_DEPTH: full runtime_lines=9 rules=r reasons=${reasons} codes=none`];
const CODE = plan('code', 'runtime=9');

describe('native FIXABLE by review class (GST-987)', () => {
  // Value: protects=outside the gate class with no risk reason a native finding's own Severity field decides, so gstack-evals #141's
  //   eval-driver findings (FIXABLE. Severity: Medium/Low. Blocks: no) collect as Medium and Low, while gate, risk and unreadable plans
  //   keep normalizer v2; fails_when=FIXABLE raises a fielded finding on a code-class plan, or a gate, risk, error or missing plan stops
  //   raising it; why_new=GEVA-2 reported #141 collecting both as CRITICAL; seam=fixableRaises, parseFindings and collect --manifest;
  //   no_claim=which class a diff belongs to (lib/review-depth.ts decides)
  test('#141 native #4 and #6 collect at their own Severity on a code-class plan', () => {
    expect(parseFindings('adversarial-native', NATIVE, fixableRaises(CODE)).map(f => f.label)).toEqual(['Medium', 'Low']);
    expect(parseFindings('adversarial-native', NATIVE).map(f => f.label)).toEqual(['Medium', 'Low']);
  });
  test('gate class, any risk reason, a depth error or an unreadable plan keeps normalizer v2', () => {
    for (const lines of [plan('gate', 'gate-class,runtime=9'), plan('code', 'risk:money,runtime=9'), plan('code', 'risk:data,runtime=9'), plan('code', 'error:DIFF,runtime=9'), plan('code', 'runtime=9,history:fixed-blocking'), plan('code', 'runtime=9,floor:full'), plan('code', ''), plan('unknown', 'runtime=9'), [CODE[0]!], [], undefined])
      expect(fixableRaises(lines)).toBe(true);
    expect(fixableRaises(CODE)).toBe(false);
    expect(fixableRaises(plan('docs', 'runtime=0'))).toBe(false);
  });
  test('on a code-class plan FIXABLE without a Severity field still collects CRITICAL, and Blocks: yes still raises', () => {
    expect(parseFindings('adversarial-native', '1. Race in a.ts:3. FIXABLE', false).map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('adversarial-native', 'FIXABLE: race in a.ts:3\nSeverity: Medium\nBlocks: no', false).map(f => f.label)).toEqual(['Medium']);
    expect(parseFindings('adversarial-native', 'FIXABLE: race in a.ts:3\nSeverity: Medium\nBlocks: yes', false).map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('adversarial-native', '1. Race in a.ts:3. Severity: FIXABLE', false).map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('adversarial-native', '1. FIXABLE: race in store.ts:40. Severity: High', false).map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('adversarial-native', '1. FIXABLE: race in store.ts:40\nSeverity: High\nBlocks: no', false).map(f => f.label)).toEqual(['High']);
    expect(parseFindings('adversarial-native', '## FIXABLE\n1. Leak in a.ts:3. Severity: Low. Blocks: no\n2. Race in b.ts:4\n3. Drift in c.ts:5. Severity: Low', false).map(f => f.label)).toEqual(['Low', 'CRITICAL', 'CRITICAL']);
    expect(parseFindings('adversarial-native', '**FIXABLE**\n- Leak in a.ts:3\n  Severity: Medium', false).map(f => f.label)).toEqual(['CRITICAL']);
    expect(parseFindings('adversarial-native', 'FIXABLE: race in a.ts:3. Severity: Low. Blocks: no-op path only', false).map(f => f.label)).toEqual(['CRITICAL']);
  });
  // Value: protects=a paragraph under a numbered finding heading joins that heading's finding, so the reader's later Severity and Blocks
  //   fields attach to it instead of splitting it into a CRITICAL heading plus a body item (gstack-evals #149); fails_when=any of the three
  //   shapes collects 4 findings or the heading alone keeps CRITICAL on a code-class plan; why_new=#149 split native findings in both
  //   classes; seam=parseFindings; no_claim=how unnumbered headings group
  test.each([
    ['### 1. FIXABLE: race in a.ts:3\n\nThe body explains it.\n\nSeverity: Medium, Blocks: no\n\n### 2. FIXABLE: drift in b.ts:9\n\nMore body.\n\nSeverity: Low, Blocks: no'],
    ['**1. Race in a.ts:3** FIXABLE\n\nBody.\n\nSeverity: Medium, Blocks: no\n\n**2. Drift in b.ts:9** FIXABLE\n\nBody.\n\nSeverity: Low, Blocks: no'],
    ['### 1. Race in a.ts:3 — FIXABLE\n\nBody.\n\n**Severity:** Medium\n**Blocks:** no\n\n### 2. Drift in b.ts:9 — FIXABLE\n\nBody.\n\n**Severity:** Low\n**Blocks:** no'],
  ])('a numbered finding heading keeps its body paragraph and fields (#149) %#', (output) => {
    expect(parseFindings('adversarial-native', output, false).map(f => f.label)).toEqual(['Medium', 'Low']);
    expect(parseFindings('adversarial-native', output, true).map(f => f.label)).toEqual(['Medium', 'Low']);
  });
  test('a labeled or located paragraph after a numbered heading stays its own finding (#149 joins only plain body text)', () => {
    for (const raises of [true, false]) {
      expect(parseFindings('outside-voice', '### 1. P2 race in a.ts:3\n\nP0: also data loss in b.ts:9\n\nSeverity: Medium', raises).map(f => f.label)).toEqual(['P2', 'P0']);
      expect(parseFindings('outside-voice', '### 1. P2 race in a.ts:3\n\nBody.\n\nP1: second issue in b.ts:9', raises).map(f => f.label)).toEqual(['P2', 'P1']);
    }
  });
  test('collect reads the class from --manifest and defaults to the gate class without one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gst987-'));
    const out = path.join(dir, 'native.txt');
    fs.writeFileSync(out, NATIVE + '\n');
    const manifest = path.join(dir, 'pass-manifest.json');
    const ledger = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, ledger, plan_lines: CODE, readers: [] }));
    const foreign = path.join(dir, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ version: 1, ledger: path.join(dir, 'other.jsonl'), plan_lines: CODE, readers: [] }));
    let n = 0;
    const labels = (extra: string[]) => {
      fs.rmSync(ledger, { force: true });
      const merged = path.join(dir, `${n++}.merged.jsonl`);
      const r = spawnSync(path.join(ROOT, 'bin/gstack-review-dispatch'), ['collect', '--ledger', ledger, '--role', 'adversarial-native', '--output', out, '--merged', merged, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
      expect(r.stderr).toBe('');
      return fs.readFileSync(merged, 'utf8').trim().split('\n').map(l => JSON.parse(l).label);
    };
    expect(labels(['--manifest', manifest])).toEqual(['Medium', 'Low']);
    expect(fs.readFileSync(ledger, 'utf8')).toContain('"fixable_raises":false');
    expect(labels([])).toEqual(['Medium', 'Low']);
    expect(fs.readFileSync(ledger, 'utf8')).not.toContain('fixable_raises');
    expect(labels(['--manifest', foreign])).toEqual(['Medium', 'Low']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('verify re-derives a code-class collect with the class it was collected under', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gst987v-'));
    const out = path.join(dir, 'native.txt');
    fs.writeFileSync(out, NATIVE + '\n');
    const c = collect(path.join(dir, 'l.jsonl'), 'adversarial-native', NATIVE + '\n', path.join(dir, 'm.jsonl'), out, undefined, undefined, false);
    expect(c.lines.map(l => l.label)).toEqual(['Medium', 'Low']);
    expect(JSON.stringify(verify(path.join(dir, 'l.jsonl')))).not.toContain('merged_line_differs');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
