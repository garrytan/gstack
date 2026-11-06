import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect, ledgerBlockers, parseFindings, readJsonl, recordJudgment, statesNoBlocks, type JudgedLine } from '../lib/review-ledger';

const read = (f: string) => fs.readFileSync(path.resolve(import.meta.dir, 'fixtures/review-ledger/gst-1657', f), 'utf8');
const CAPTURED = read('geva-358-pr248-p2_adversarial-native.txt');
const native = (output: string, raises: boolean) => parseFindings('adversarial-native', output, raises);
const finding = (head: string, fields: string[]) => [head, 'It merges and never deletes.', '',
  'I reproduced it:', '1. Attempt 1 wrote trial.json.', '2. Attempt 2 ran in the same dir (run.ts:494).', '',
  'The fix: rmSync each sink target, then copy.', '', ...fields, '', 'Recommendation: Fix copyToSink because it mixes attempts.'].join('\n');
const BOLD = "**Finding 1 (FIXABLE): a re-run session's sink copy mixes attempts.**";
/** Collects one native output, records a judgment that keeps every label except the lowerings given, and returns the verdict and blockers. */
const judged = (output: string, lower: Record<string, [string, string]> = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1657-'));
  const [ledger, merged, file, out] = ['l.jsonl', 'm.jsonl', 'j.jsonl', 'out.txt'].map(f => path.join(d, f)) as [string, string, string, string];
  fs.writeFileSync(out, output);
  const c = collect(ledger, 'adversarial-native', output, merged, out);
  const set: JudgedLine[] = c.lines.map(l => (lower[l.id] ? { id: l.id, severity: lower[l.id]![0], reason: lower[l.id]![1] } : { id: l.id, severity: l.label }));
  fs.writeFileSync(file, set.map(j => JSON.stringify(j)).join('\n') + '\n');
  const verdict = recordJudgment(ledger, c.lines, readJsonl(file), file, merged);
  const result = { labels: c.lines.map(l => l.label), ok: verdict.ok, dismissed: verdict.dismissed, blockers: ledgerBlockers(ledger).length };
  fs.rmSync(d, { recursive: true, force: true });
  return result;
};

describe("a native finding's own Severity and Blocks lines stay on that finding (GST-1657)", () => {
  // Value: protects=a native adversarial finding led by "**Finding N (FIXABLE): ...**" keeps its body (numbered steps, located lines,
  //   later paragraphs) until its Severity and Blocks lines come, so "Severity: Medium / Blocks: no" collects at Medium under GST-1031
  //   ruling A instead of the FIXABLE raise; fails_when=the finding collects CRITICAL, its fields split off as a second record carrying
  //   another paragraph as its subject, or the ledger counts a blocker; why_new=gstack-evals #248 (GEVA-358 p2/adversarial-native#1)
  //   collected CRITICAL beside a phantom Medium record, the judge refused the downgrade and /ship blocked until a hand-granted
  //   review-loop exception; seam=parseFindings, collect, recordJudgment and ledgerBlockers; no_claim=other finding-lead spellings
  test('the captured #248 native output collects the Severity its reader wrote, with no blocker', () => {
    for (const raises of [true, false]) {
      const found = native(CAPTURED, raises);
      expect([raises, found.map(f => f.label)]).toEqual([raises, ['Medium', 'Low']]);
      expect(found[0]!.raw.startsWith('**Finding 1 (FIXABLE)')).toBe(true);
      expect(found[0]!.raw.endsWith(' | Severity: Medium | Blocks: no')).toBe(true);
    }
    expect(judged(CAPTURED)).toEqual({ labels: ['Medium', 'Low'], ok: true, dismissed: [], blockers: 0 });
  });

  // Value: protects=a line right under a numbered heading that carries only that finding's Severity and Blocks fields joins the heading
  //   instead of starting a phantom record, keeping the stronger label (GST-1406: collect cannot tell a heading's own inline fields from
  //   another subject's), so a Blocks: no finding counts no blocker and lead judgment may lower it to its stated Severity, while
  //   Blocks: yes still blocks; fails_when=a phantom Low or Medium record reappears beside its heading, the Blocks: yes finding stops
  //   counting, or the lowering is refused; why_new=the GST-1657 replay found gstack-evals GEVA-228 (three FIXABLE findings, each
  //   "Severity: Low. Blocks: no.") and GSTA-234 collecting CRITICAL headings the judge would not lower; seam=parseFindings, collect,
  //   recordJudgment and ledgerBlockers; no_claim=that a located paragraph after a blank line joins (it stays its own record)
  test('inline fields under a numbered heading land on it, at the stronger label', () => {
    const crewlog = read('geva-228-s1.3_adversarial-native.txt');
    const preflight = read('gsta-234-s6_adversarial-native.txt');
    for (const raises of [true, false]) {
      expect([raises, native(crewlog, raises).map(f => f.label)]).toEqual([raises, ['CRITICAL', 'Medium', 'CRITICAL', 'CRITICAL', 'CRITICAL']]);
      expect([raises, native(crewlog, raises).map(f => statesNoBlocks(f.raw))]).toEqual([raises, [false, true, true, true, true]]);
      expect([raises, native(preflight, raises).map(f => [f.label, statesNoBlocks(f.raw)])]).toEqual([raises, [['CRITICAL', true]]]);
    }
    const why = 'the reader wrote Severity: Low. Blocks: no.';
    expect(judged(crewlog, { 'adversarial-native#3': ['Low', why], 'adversarial-native#4': ['Low', why], 'adversarial-native#5': ['Low', why] }))
      .toEqual({ labels: ['CRITICAL', 'Medium', 'CRITICAL', 'CRITICAL', 'CRITICAL'], ok: true, dismissed: ['adversarial-native#3', 'adversarial-native#4', 'adversarial-native#5'], blockers: 1 });
    expect(judged(preflight)).toEqual({ labels: ['CRITICAL'], ok: true, dismissed: [], blockers: 0 });
  });

  // Value: protects=FIXABLE still raises whenever the finding's own fields do not lower it: Blocks: yes, a Severity with no Blocks: no
  //   on a raising class (GST-987), and no fields at all collect CRITICAL; a "### Finding N" lead and the inline quote of the issue
  //   ("Severity: Medium, Blocks: no") collect at Medium; an unrelated paragraph's inline fields under a heading never lower its label
  //   (GST-1406's probe); fails_when=any control collects below CRITICAL or a lowered shape stays CRITICAL; why_new=GST-1657;
  //   seam=parseFindings; no_claim=that each control is a real finding
  test('the FIXABLE raise holds unless the finding states Blocks: no and one Severity', () => {
    for (const [fields, raises, want] of [[['Severity: Medium', 'Blocks: yes'], false, 'CRITICAL'], [['Severity: Medium'], true, 'CRITICAL'],
      [[], true, 'CRITICAL'], [[], false, 'CRITICAL'], [['Severity: Medium', 'Blocks: no'], true, 'Medium'], [['Severity: Low. Blocks: no.'], true, 'Low']] as const)
      expect([fields, raises, native(finding(BOLD, [...fields]), raises).map(f => f.label)]).toEqual([fields, raises, [want]]);
    expect(native(finding('### Finding 1 (FIXABLE): sink copy mixes attempts', ['Severity: Medium', 'Blocks: no']), true).map(f => f.label)).toEqual(['Medium']);
    expect(native(`${BOLD} It merges and never deletes. Severity: Medium, Blocks: no`, true).map(f => f.label)).toEqual(['Medium']);
    const two = native([finding(BOLD, ['Severity: Medium', 'Blocks: no']).replace(/\n\nRecommendation:.*/, ''), '',
      '**Finding 2 (FIXABLE): the copy runs once (run.ts:677).**', 'A crash copies nothing.', '', 'Severity: High', 'Blocks: yes'].join('\n'), true);
    expect(two.map(f => f.label)).toEqual(['Medium', 'CRITICAL']);
    for (const raises of [true, false])
      expect(native(['### 1. FIXABLE: webhook auth bypass in lib/auth.ts:42', 'Any caller can post to the webhook.', '',
        'Unrelated, the help text names an old flag. Severity: Low. Blocks: no.'].join('\n'), raises).map(f => f.label)).toEqual(['CRITICAL']);
    const located = ['**Finding 1 (FIXABLE): A in x.ts:3**', 'Second, y.ts:9 drops writes. Severity: High; Blocks: no'].join('\n');
    expect(native(located, true).map(f => f.label)).toEqual(['CRITICAL', 'High']);
    expect(judged(located, { 'adversarial-native#1': ['High', 'the next line says Blocks: no'] }).ok).toBe(false);
    const stated = parseFindings('outside-voice', ['### 1. CRITICAL: webhook accepts requests without authentication',
      'Separately, the help text names an obsolete flag. Severity: Low. Blocks: no.'].join('\n'));
    expect(stated.map(f => [f.label, statesNoBlocks(f.raw)])).toEqual([['CRITICAL', false], ['Low', true]]);
  });
});
