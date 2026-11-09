import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect, ledgerBlockers, parseFindings } from '../lib/review-ledger';

const DIR = path.resolve(import.meta.dir, 'fixtures/review-ledger/gst-2122');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const labels = (reader: string, output: string, raises = true) => parseFindings(reader, output, raises).map(f => f.label);
const TREE = 'REVIEWED_TREE: 35aa2e6c1f8a972d6541e40cd27074c054a4971a /workspace/gstack';
/** alphaclaw #385/#386's fix-check sentence, verbatim; the reply around it is rebuilt in the brief's shape (the raw reply was not kept). */
const ALPHACLAW = 'No fix introduced a CRITICAL defect.';
const fixCheck = (body: string) => `${TREE}\n\n${body}\n`;

function blockersOf(reader: string, output: string): string[] {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst2122-'));
  try {
    const ledger = path.join(d, 'l.jsonl');
    fs.writeFileSync(path.join(d, 'out.txt'), output);
    collect(ledger, reader, output, path.join(d, 'm.jsonl'), path.join(d, 'out.txt'));
    return ledgerBlockers(ledger).map(b => b.id);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

describe('a clean reply or a denial in reader prose is never a blocker (GST-2122)', () => {
  // Value: protects=a reader that returned NO FINDINGS counts no finding however its notes quote a severity: #4208's pass-2 red-team
  //   reply quoted "CRITICAL (the reviewer wrote …)" in a coverage bullet and collected as p2/red-team#1 CRITICAL, which judge may not
  //   drop, so gstack-review-plan printed NEXT: stop; fails_when=that reply collects any finding or the ledger counts a blocker;
  //   why_new=#4208 /ship stopped on a phantom; seam=parseFindings, collect and ledgerBlockers; no_claim=other readers' replies
  test("#4208's NO FINDINGS red-team reply collects nothing", () => {
    const out = read('gsta-435-pr4208-p2_red-team.txt');
    for (const raises of [true, false]) expect([raises, labels('red-team', out, raises)]).toEqual([raises, []]);
    expect(blockersOf('red-team', out)).toEqual([]);
  });

  // Value: protects=a sentence that is wholly a denial that a change introduced a severity collects at no label: alphaclaw #385/#386's
  //   "No fix introduced a CRITICAL defect" collected CRITICAL and stopped /ship; alone on its line it collects nothing, beside an
  //   unlabelled sentence it stays on record at INFORMATIONAL (GST-435), and under NO FINDINGS it collects nothing; fails_when=any of
  //   these collects above INFORMATIONAL or counts a blocker; why_new=two alphaclaw PRs stopped on it; seam=parseFindings, collect and
  //   ledgerBlockers; no_claim=that every denial spelling is read
  test("alphaclaw's fix-check sentence is no blocker", () => {
    expect(labels('fix-check', fixCheck(ALPHACLAW))).toEqual([]);
    const prose = fixCheck(`I re-read each fix against its finding and the tests that cover it. ${ALPHACLAW}`);
    expect(labels('fix-check', prose)).toEqual(['INFORMATIONAL']);
    expect(blockersOf('fix-check', prose)).toEqual([]);
    const clean = fixCheck(`NO FINDINGS\n\n${ALPHACLAW}`);
    expect(labels('fix-check', clean)).toEqual([]);
    expect(blockersOf('fix-check', clean)).toEqual([]);
  });

  // Value: protects=prose under NO FINDINGS that names several severities, in quotes, code spans and bullets, collects nothing;
  //   fails_when=any of it collects; why_new=the negative control for the NO FINDINGS rule; seam=parseFindings; no_claim=none
  test('a NO FINDINGS reply with severity words in its prose collects nothing', () => {
    const out = fixCheck([
      'NO FINDINGS',
      '',
      'Coverage note: the "CRITICAL path" in auth.ts is unchanged, and I checked whether the retry change rises to High.',
      '- **Callers:** the P0 alert path (`CRITICAL (the reviewer wrote Blocks: no)`) still renders the same.',
      'The old High finding from pass 1 stays fixed.',
    ].join('\n'));
    for (const reader of ['red-team', 'fix-check', 'specialist-batched', 'targeted']) expect([reader, labels(reader, out)]).toEqual([reader, []]);
  });
});

describe('the structured finding formats still collect at their label (GST-2122 hold)', () => {
  // Value: protects=a real CRITICAL in each brief's documented format still collects CRITICAL and counts a blocker: a JSON object for
  //   the JSON readers, a Severity/Blocks field for the prose voices; fails_when=any collects lower or counts no blocker;
  //   why_new=the prose rule narrows a fail-closed parser, so each documented format is pinned first; seam=parseFindings, collect
  //   and ledgerBlockers; no_claim=out-of-format replies beyond the cases below
  test('a documented-format CRITICAL collects CRITICAL', () => {
    const json = '{"severity":"CRITICAL","confidence":9,"path":"lib/a.ts","line":3,"category":"auth","summary":"skips the token check","fingerprint":"lib/a.ts:3:auth","specialist":"red-team"}';
    for (const reader of ['red-team', 'specialist-batched', 'targeted', 'fix-check']) {
      expect([reader, labels(reader, fixCheck(json))]).toEqual([reader, ['CRITICAL']]);
      expect([reader, blockersOf(reader, fixCheck(json))]).toEqual([reader, [`${reader}#1`]]);
    }
    const prose = fixCheck('1. The handler at api.ts:9 skips the auth check. Severity: Critical. Blocks: yes');
    for (const reader of ['outside-voice', 'adversarial-native']) expect([reader, labels(reader, prose)]).toEqual([reader, ['CRITICAL']]);
    expect(blockersOf('outside-voice', prose)).toEqual(['outside-voice#1']);
  });

  // Value: protects=fail-closed on a structured finding that contradicts NO FINDINGS or is malformed: a JSON CRITICAL, a lead-label
  //   CRITICAL, a `Blocks: yes` and a truncated JSON object all still collect CRITICAL; fails_when=any collects lower or disappears;
  //   why_new=hold tests before narrowing the scanner; seam=parseFindings; no_claim=none
  test('structured findings beside NO FINDINGS, and malformed JSON, stay CRITICAL', () => {
    const cases = [
      'NO FINDINGS\n{"severity":"CRITICAL","path":"lib/a.ts","line":3,"summary":"x"}',
      'NO FINDINGS\n\nCRITICAL: the token is logged at log.ts:3.',
      'NO FINDINGS\n\nThe token is logged at log.ts:3. Blocks: yes',
      '{"severity":"CRITICAL","path":"lib/a.ts","line":3,"summary":"cut off',
    ];
    for (const c of cases) expect([c, labels('red-team', fixCheck(c))]).toEqual([c, ['CRITICAL']]);
  });

  // Value: protects=outside a NO FINDINGS reply prose severity collects as before this change (fail-closed): #4075's surviving fix-check
  //   blocker "Neither fix clears the P0." still collects P0 and counts a blocker; fails_when=it collects lower or counts none;
  //   why_new=the Captain's narrowing of GST-2122 (a real prose blocker must not drop to a note); seam=parseFindings, collect and
  //   ledgerBlockers; no_claim=that every prose blocker is real (judge folds phantoms)
  test("#4075's prose blocker still blocks", () => {
    const out = fixCheck('Neither fix clears the P0.');
    expect(labels('fix-check', out)).toEqual(['P0']);
    expect(blockersOf('fix-check', out)).toEqual(['fix-check#1']);
  });

  // Value: protects=the bypass is bounded to clean replies: prose with no finding structure collects at its label in a reply with no
  //   NO FINDINGS marker and nothing in one that has it; fails_when=the unmarked reply collects lower or the marked one collects
  //   anything; why_new=the NO FINDINGS rule's one bypass, pinned; seam=parseFindings; no_claim=that unstructured prose under NO
  //   FINDINGS is never a real defect
  test('unstructured prose keeps its label unless the reply says NO FINDINGS', () => {
    for (const reader of ['red-team', 'fix-check', 'outside-voice']) {
      expect([reader, labels(reader, fixCheck('The handler skips the auth check, which is CRITICAL.'))]).toEqual([reader, ['CRITICAL']]);
      expect([reader, labels(reader, fixCheck('NO FINDINGS\n\nThe handler skips the auth check, which is CRITICAL.'))]).toEqual([reader, []]);
    }
  });

  // Value: protects=a bold-led coverage line that only denies a severity collects nothing, a numbered heading included, under NO
  //   FINDINGS or not (the readers' negative controls on #4218 pass 2, adversarial-native#2 and red-team#1), while a bold-led line that
  //   rates a defect keeps its label; fails_when=a denial collects anything or the rated line collects lower; why_new=numbered headings
  //   counted as structure and brought the GST-2122 stop back for "**1. Coverage:** no fix introduced a CRITICAL defect."; seam=parseFindings;
  //   no_claim=that every denial spelling is read
  test('a denial after a bold lead collects nothing, headings included', () => {
    for (const reader of ['adversarial-native', 'red-team', 'fix-check']) {
      expect([reader, labels(reader, fixCheck('**1. Coverage:** no fix introduced a CRITICAL defect.'))]).toEqual([reader, []]);
      expect([reader, labels(reader, fixCheck('NO FINDINGS\n\n**1. Coverage:** no fix introduced a CRITICAL defect.'))]).toEqual([reader, []]);
      expect([reader, labels(reader, fixCheck('- **Callers:** none of the fixes introduced a High regression.'))]).toEqual([reader, []]);
      expect([reader, labels(reader, fixCheck('- **Auth:** the token check at auth.ts:9 is CRITICAL and missing.'))]).toEqual([reader, ['CRITICAL']]);
    }
  });

  // Value: protects=dropping unshaped prose under NO FINDINGS never shifts the native voice's relaxed parse off its findings, so a FIXABLE
  //   `Severity: Low. Blocks: no` finding after such prose keeps its field; fails_when=it collects CRITICAL; why_new=/ship pass 1 on #4218
  //   (specialist-batched#1) found the drop misaligned the two parses; seam=parseFindings; no_claim=none
  test('a NO FINDINGS reply with prose keeps a native Blocks: no finding at its field', () => {
    const out = fixCheck('NO FINDINGS\n\nThe retry path looks High risk overall.\n\nFIXABLE: the log line at a.ts:3 is verbose. Severity: Low. Blocks: no');
    expect(labels('adversarial-native', out)).toEqual(['Low']);
  });

  // Value: protects=a numbered finding heading (GST-1031, GST-1657) is finding structure, so its label stands without a file:line;
  //   fails_when=it collects INFORMATIONAL; why_new=/ship pass 1 on #4218 (red-team#2); seam=parseFindings; no_claim=bullets or wrapped loci
  test('a numbered finding heading keeps its label', () => {
    expect(labels('adversarial-native', fixCheck('**Finding 1 (CRITICAL): the session token is logged in plaintext**'))).toEqual(['CRITICAL']);
    expect(labels('outside-voice', fixCheck('### 1. Session token logged in plaintext (P1)'))).toEqual(['P1']);
  });
});
