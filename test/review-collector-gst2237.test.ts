import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promptHash } from '../lib/review-brief';
import { collect, judge, ledgerBlockers, readJsonl, verify, type MergedLine } from '../lib/review-ledger';

/** One collect into a throwaway ledger: what it merged, whether it was a review, and the blockers the ledger counts. */
function run(reader: string, output: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst2237-'));
  try {
    const ledger = path.join(d, 'l.jsonl'), merged = path.join(d, 'm.jsonl'), out = path.join(d, 'out.txt');
    fs.writeFileSync(out, output);
    fs.writeFileSync(merged, '');
    const r = collect(ledger, reader, output, merged, out);
    return { review: r.review, why: r.why, labels: r.lines.map(l => l.label), blockers: ledgerBlockers(ledger).map(b => b.id), lines: readJsonl<MergedLine>(merged) };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const PAY = 'charges the card twice when the webhook retries';
const json = (o: Record<string, unknown>) => JSON.stringify({ confidence: 9, path: 'lib/pay.ts', line: 40, category: 'money', summary: PAY, ...o });

describe('the collector neither drops a prose finding nor invents a blocker (GST-2237, GSTA-461 item 3)', () => {
  // Value: protects=a native reply whose located finding the parser cannot read is re-asked, never a clean review: the audit's
  //   "1. [Fixable] lib/pay.ts:40 …" reply collected 0 findings and counted clean because its Recommendation line is the clean marker;
  //   fails_when=it is a review with no finding; why_new=GSTA-461 item 3 repro; seam=collect; no_claim=that the parser reads the line
  test('a native reply with an unread located finding is not a review', () => {
    const r = run('adversarial-native', `ADVERSARIAL REVIEW (Claude subagent):\n\n1. [Fixable] lib/pay.ts:40 ${PAY}.\n\nRecommendation: fix before merge\n`);
    expect(r).toMatchObject({ review: false, why: 'prose_not_collected', labels: [] });
  });

  // Value: protects=an outside-voice sentence that only uses a severity word as an adjective is no blocker: "Critical paths
  //   (checkout, refund) are covered" collected Critical, and judge could not lower it; fails_when=it collects or counts a blocker, or
  //   the reply counts clean; why_new=GSTA-461 item 3 repro (#4208, ALPH-93, ALPH-11 class); seam=parseFindings, collect and
  //   ledgerBlockers; no_claim=that the re-asked reader answers differently
  test("the outside voice's 'Critical paths … are covered' reply is no blocker and is re-asked", () => {
    const r = run('outside-voice', 'Critical paths (checkout, refund) are covered by the new tests.\n\nRecommendation: ship\n');
    expect(r).toMatchObject({ review: false, why: 'prose_not_collected', labels: [], blockers: [] });
  });

  // Value: protects=a NO FINDINGS native reply that mentions earlier FIXABLE items collects nothing: GST-2122 counted the bare word as
  //   structure, so "both are fixed" collected CRITICAL beside NO FINDINGS; fails_when=it collects or counts a blocker; why_new=GSTA-461
  //   item 3 repro; seam=parseFindings and collect; no_claim=other mentions under NO FINDINGS
  test('a NO FINDINGS native reply that says both FIXABLE items are fixed is a clean review', () => {
    const r = run('adversarial-native', 'ADVERSARIAL REVIEW (Claude subagent):\n\nI rechecked the two FIXABLE items from pass 1; both are fixed and covered by tests.\n\nNO FINDINGS\n\nRecommendation: ship\n');
    expect(r).toMatchObject({ review: true, labels: [], blockers: [] });
    expect(run('adversarial-native', 'NO FINDINGS\n\n1. Race in queue.ts:40 (FIXABLE).\n')).toMatchObject({ labels: ['CRITICAL'], blockers: ['adversarial-native#1'] });
  });

  // Value: protects=an unranked JSON severity blocks: "CRITICAL (blocks shipping)" is the brief's own wording
  //   (ship/sections/review-army.md) and `rank(label) ?? 0` made it non-blocking; lead judgment may not lower it either;
  //   fails_when=it counts no blocker or judge accepts INFORMATIONAL; why_new=GSTA-461 item 3 repro; seam=collect, ledgerBlockers and
  //   judge; no_claim=ranked labels (HIGH stays rank 3 for a JSON reader)
  test('an unknown JSON severity counts as CRITICAL', () => {
    for (const severity of ['CRITICAL (blocks shipping)', 'BLOCKER', 'severe']) {
      const r = run('red-team', json({ severity }) + '\n');
      expect([severity, r.labels, r.blockers]).toEqual([severity, [severity], ['red-team#1']]);
      expect(judge(r.lines, [{ id: 'red-team#1', severity: 'INFORMATIONAL', reason: 'not blocking' }]).downgraded).toEqual(['red-team#1']);
    }
  });

  // Value: protects=the outside voice's High and P1 block as its brief says (ship/sections/adversarial.md: "A Critical, High or
  //   Blocks: yes finding is CRITICAL", "P0/P1 findings block like native ones"), and Blocks: no keeps its GST-1031 meaning;
  //   fails_when=either counts no blocker, Medium counts one, or the native voice's High blocks; why_new=GSTA-461 item 3;
  //   seam=ledgerBlockers; no_claim=other readers' High
  test("the outside voice's High and P1 are blockers; Medium and the native voice's High are not", () => {
    expect(run('outside-voice', `1. **High** - lib/pay.ts:40 ${PAY}.\n\nRecommendation: fix before merge\n`).blockers).toEqual(['outside-voice#1']);
    expect(run('outside-voice', `[P1] lib/pay.ts:40 ${PAY}.\n\nRecommendation: fix before merge\n`).blockers).toEqual(['outside-voice#1']);
    expect(run('outside-voice', `1. lib/pay.ts:40 ${PAY}. Severity: Medium. Blocks: no\n\nRecommendation: ship\n`)).toMatchObject({ labels: ['Medium'], blockers: [] });
    expect(run('outside-voice', `1. lib/pay.ts:40 ${PAY}. Severity: High. Blocks: no\n\nRecommendation: ship\n`)).toMatchObject({ labels: ['High'], blockers: [] });
    expect(run('adversarial-native', `1. lib/pay.ts:40 ${PAY}. Severity: High. Blocks: no\n\nRecommendation: ship\n`)).toMatchObject({ labels: ['High'], blockers: [] });
  });
});

describe('a JSON reader collects only its JSON objects and NO FINDINGS (GST-2237)', () => {
  const READERS = ['specialist/testing', 'specialist-batched', 'red-team', 'targeted', 'fix-check'];

  // Value: protects=a JSON reader's prose never becomes a finding: a coverage note or a preface beside a JSON finding collected a
  //   phantom label (2 of the 5 prose rows in the saved ledgers were phantom CRITICALs); fails_when=the prose collects or the reply is
  //   re-asked; why_new=GSTA-461 item 3; seam=parseFindings and collect; no_claim=that the dropped prose held no defect
  test('prose beside a JSON finding is ignored', () => {
    const info = json({ severity: 'INFORMATIONAL', line: 7, summary: 'rename tmp' });
    for (const reader of READERS) {
      expect([reader, run(reader, `I checked the P0 list from the brief against the diff.\n${info}\nCritical paths (checkout, refund) are covered by the new tests.\n`)])
        .toMatchObject([reader, { review: true, labels: ['INFORMATIONAL'], blockers: [] }]);
    }
  });

  // Value: protects=every JSON object with a severity collects whatever its layout: pretty-printed with a lowercase label (dropped
  //   before), in an array, in a code fence, nested under another key, or cut off; fails_when=any is lost; why_new=GSTA-461 audit B
  //   item 3; seam=parseFindings; no_claim=objects without a severity key
  test('pretty-printed, fenced, array, nested and cut-off objects all collect', () => {
    const pretty = ['{', '  "severity": "critical",', '  "path": "lib/pay.ts",', '  "line": 40,', `  "summary": "${PAY}"`, '}', json({ severity: 'INFORMATIONAL', line: 7 })].join('\n');
    expect(run('red-team', pretty)).toMatchObject({ review: true, labels: ['critical', 'INFORMATIONAL'], blockers: ['red-team#1'] });
    expect(run('red-team', '```json\n[' + json({ severity: 'CRITICAL' }) + ', ' + json({ severity: 'INFORMATIONAL' }) + ']\n```\n').labels).toEqual(['CRITICAL', 'INFORMATIONAL']);
    const nested = run('targeted', JSON.stringify({ finding: JSON.parse(json({ severity: 'CRITICAL' })) }) + '\n');
    expect(nested).toMatchObject({ labels: ['CRITICAL'], blockers: ['targeted#1'] });
    expect(JSON.parse(nested.lines[0]!.raw).path).toBe('lib/pay.ts');
    expect(run('fix-check', '{"severity":"CRITICAL","path":"lib/a.ts","line":3,"summary":"cut off\n')).toMatchObject({ labels: ['CRITICAL'], blockers: ['fix-check#1'] });
  });

  // Value: protects=a JSON reader that answers only in prose is not a review, however severe its prose sounds, and a NO FINDINGS reply
  //   with notes is a clean one (#4208's red-team shape); fails_when=prose collects, a prose-only reply counts as a review, or the NO
  //   FINDINGS reply is re-asked; why_new=GST-2237 contract; seam=collect; no_claim=none
  test('a prose-only reply is re-asked; NO FINDINGS with notes is clean', () => {
    for (const reader of READERS) {
      expect([reader, run(reader, `1. lib/pay.ts:40 ${PAY}. Severity: Critical. Blocks: yes\n`)]).toMatchObject([reader, { review: false, why: 'no_finding_no_clean_marker', labels: [] }]);
      expect([reader, run(reader, 'NO FINDINGS\n\nCoverage note: the CRITICAL path in lib/pay.ts:40 is unchanged.\n')]).toMatchObject([reader, { review: true, labels: [] }]);
    }
  });
});

describe('fail closed only on prose the collector could not read (GST-2237 negative controls)', () => {
  // Value: protects=a clean prose-voice reply stays clean when its prose only denies a severity or names an id that looks like one;
  //   fails_when=either is re-asked; why_new=the replay of the 92 saved ledgers (an outside-voice `p1` gate id); seam=collect;
  //   no_claim=every denial spelling
  test('a denial or a look-alike id is no reason to re-ask', () => {
    expect(run('outside-voice', 'No Critical or High findings.\n\nRecommendation: ship because the diff only renames a test\nVERDICT: CLEAN\n').review).toBe(true);
    expect(run('outside-voice', 'Recommendation: approve because `p1` matches the existing gate parser and consumers.\nVERDICT: CLEAN\n').review).toBe(true);
    expect(run('outside-voice', 'Recommendation: ship\nVERDICT: FINDINGS\n')).toMatchObject({ review: false, why: 'prose_not_collected' });
  });

  // Value: protects=verify re-derives the not-reviewed verdict from the saved reply, so a ledger edited to say review: true still
  //   reports NOT_REVIEWED with its reason; fails_when=verify trusts the recorded field or prints the old reason; why_new=GST-2237;
  //   seam=verify; no_claim=none
  test('verify reports an unread reply as NOT_REVIEWED with its reason', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst2237v-'));
    try {
      const ledger = path.join(d, 'l.jsonl'), merged = path.join(d, 'm.jsonl'), out = path.join(d, 'out.txt');
      const brief = path.join(d, 'brief.md');
      fs.writeFileSync(brief, 'brief');
      fs.writeFileSync(ledger, JSON.stringify({ event: 'rendered', reader: 'outside-voice', file: brief, sha256: promptHash('brief') }) + '\n' + JSON.stringify({ event: 'sent', reader: 'outside-voice', sha256: promptHash('brief'), match: true }) + '\n');
      const reply = 'Critical paths (checkout, refund) are covered by the new tests.\n\nRecommendation: ship\n';
      fs.writeFileSync(out, reply);
      fs.writeFileSync(merged, '');
      collect(ledger, 'outside-voice', reply, merged, out);
      fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace('"review":false', '"review":true'));
      const row = verify(ledger).rows.find(r => r.kind === 'OUTPUT')!;
      expect([row.status, row.detail.includes('prose_not_collected')]).toEqual(['NOT_REVIEWED', true]);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
