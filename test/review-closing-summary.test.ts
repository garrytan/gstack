import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collect, judge, ledgerBlockers, parseFindings, readJsonl, recordJudgment, summaryCandidate, type MergedLine } from '../lib/review-ledger';

const ROOT = path.resolve(import.meta.dir, '..');
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger', name), 'utf8');
const labels = (output: string, reader = 'fix-check') => parseFindings(reader, output).map(f => f.label);

describe("a reader's no-defect closing sentence is not a finding (GST-435)", () => {
  // Value: protects=a fix-check's own closing sentence that denies every severity it names ("I found nothing CRITICAL",
  //   "I found no defect that is CRITICAL") collects nothing, so the review loop stops counting a blocker that names no defect;
  //   fails_when=any of these sentences collects a finding; why_new=gstack-evals #194 (blocking_found=4 from "I found nothing
  //   CRITICAL") and #202 (fix-check#3 from "I found no defect that is CRITICAL...") each needed a Captain exception because judge
  //   refuses to lower a collected CRITICAL; seam=parseFindings and collect; no_claim=that every summary shape is recognized (one
  //   that opens with a defect clause, "None of them breaks a caller, so there's nothing at CRITICAL", still collects as a candidate)
  test('the quoted closing sentences and plain negations collect nothing', () => {
    for (const line of ['I found nothing CRITICAL.', 'I found nothing CRITICAL', 'I found no defect that is CRITICAL.', 'I found no defect that is CRITICAL...', 'Neither finding is CRITICAL.',
      'No CRITICAL issues.', 'no CRITICAL issues', 'Nothing blocking, nothing CRITICAL.', 'Nothing blocking; no CRITICAL issues.', 'There are no CRITICAL findings.',
      'No CRITICAL or High findings to report.', "So there's nothing at CRITICAL.", 'Nothing here is CRITICAL.', 'Neither fix is CRITICAL.', 'Nothing in this diff is CRITICAL.',
      'No CRITICAL findings remain.', 'We found no P0 or P1 issues.', 'None of the fixes blocks landing, and nothing is CRITICAL.'])
      expect([line, labels(line)]).toEqual([line, []]);
    for (const line of ['I found no CRITICAL defects. Here is what I checked:', 'I found nothing CRITICAL. I checked these and found them sound:',
      'No CRITICAL issues. The webhook signature check was removed entirely.', 'The admin route never checks the session token. I found nothing CRITICAL.'])
      expect([line, labels(line)]).toEqual([line, ['INFORMATIONAL']]);
  });

  test('the #194 and #202 fix-check replies collect no blocker: the closing line stays on record as a note', () => {
    for (const [name, json] of [['gst-435-closing-nothing-critical.txt', 4], ['gst-435-closing-no-defect.txt', 3]] as const) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst435-'));
      const ledger = path.join(d, 'l.jsonl');
      const merged = path.join(d, 'm.jsonl');
      fs.writeFileSync(path.join(d, 'out.txt'), fixture(name));
      const c = collect(ledger, 'fix-check', fixture(name), merged, path.join(d, 'out.txt'));
      expect([name, c.review, c.lines.map(l => l.label)]).toEqual([name, true, Array(json).fill('INFORMATIONAL')]);
      fs.writeFileSync(path.join(d, 'j.jsonl'), c.lines.map(l => JSON.stringify({ id: l.id, severity: l.label })).join('\n') + '\n');
      expect(recordJudgment(ledger, c.lines, readJsonl(path.join(d, 'j.jsonl')), path.join(d, 'j.jsonl'), merged).ok).toBe(true);
      expect(ledgerBlockers(ledger)).toEqual([]);
      fs.rmSync(d, { recursive: true, force: true });
    }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst435-'));
    const merged = path.join(d, 'm.jsonl');
    const r = collect(path.join(d, 'l.jsonl'), 'fix-check', fixture('geva-77-fix-check.txt'), merged);
    expect(r.lines.map(l => [l.id, l.label])).toEqual([['fix-check#1', 'INFORMATIONAL'], ['fix-check#2', 'INFORMATIONAL'], ['fix-check#3', 'INFORMATIONAL']]);
    expect(r.lines[2]!.raw).toStartWith('Neither finding is CRITICAL.');
    expect(judge(readJsonl<MergedLine>(merged), r.lines.map(l => ({ id: l.id, severity: l.label }))).ok).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('a count summary keeps the label it counts and drops only the one it denies', () => {
    expect(labels('I found three INFORMATIONAL issues and nothing CRITICAL.')).toEqual(['INFORMATIONAL']);
    expect(labels('I found one High issue and nothing CRITICAL.')).toEqual(['High']);
    expect(labels('None of the fixes blocks landing; I found four INFORMATIONAL defects and no CRITICAL.')).toEqual(['INFORMATIONAL']);
  });

  // Value: protects=collect stays linear on a crafted reply: a long run of joined labels that ends in a non-matching token parses in
  //   milliseconds; fails_when=the summary grammar backtracks exponentially (each label matching two ways), which made 24 labels take 19 s;
  //   why_new=GST-435 pass-1 red team measured it; seam=parseFindings; no_claim=a timing bound on any other parser path
  test('a long run of joined labels parses in linear time', () => {
    for (const join of [' and ', ' or ', ', ', '/']) {
      const line = 'No ' + Array(40).fill('CRITICAL').join(join) + ' x';
      const t = performance.now();
      expect(labels(line)).toEqual(['CRITICAL']);
      expect(performance.now() - t).toBeLessThan(250);
    }
  });

  test('a reply whose only text is a no-defect sentence, with no clean marker, is still no review', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst435-'));
    const r = collect(path.join(d, 'l.jsonl'), 'fix-check', 'I found nothing CRITICAL.\n', path.join(d, 'm.jsonl'));
    expect([r.review, r.lines]).toEqual([false, []]);
    fs.rmSync(d, { recursive: true, force: true });
  });

  // Value: protects=a real blocker keeps collecting at its label: a sentence that names a file:line or a defect, an exception clause
  //   (GST-796), an "other"/"else" quantifier that implies a blocker named elsewhere, a list item, heading, bold opener, field or
  //   Blocks: yes, or any second labelled sentence that is not itself a denial; fails_when=any of them collects nothing or a weaker
  //   label; why_new=GST-766's negation drop lost real blockers and was reverted; seam=parseFindings; no_claim=that each is a real finding
  test('negative controls: a locus, a named defect, an exception, a quantifier or a structured line keeps its label', () => {
    const kept: Array<[string, string]> = [['The token leak in log.ts:3 is CRITICAL.', 'CRITICAL'], ['I found nothing CRITICAL in auth.ts:9.', 'CRITICAL'],
      ['No CRITICAL issues (a.ts:3).', 'CRITICAL'], ['I found nothing CRITICAL. The token leak in log.ts:3 is CRITICAL.', 'CRITICAL'],
      ['I found nothing CRITICAL. The retry loop never ends, which is High.', 'CRITICAL'], ['No CRITICAL issues except the token leak in log.ts:3', 'CRITICAL'],
      ['There is no CRITICAL issue other than the race in a.ts:3.', 'CRITICAL'], ['Nothing CRITICAL apart from the unescaped query.', 'CRITICAL'],
      ['No new CRITICAL findings, but the race still blocks.', 'CRITICAL'], ['I found no defect that is CRITICAL, but the retry loop never ends.', 'CRITICAL'],
      ['No auth check guards the admin route, so nothing CRITICAL.', 'CRITICAL'], ['There is no CRITICAL lock around the refund write, so two workers double-pay.', 'CRITICAL'],
      ['No input validation is CRITICAL.', 'CRITICAL'], ['Nothing guards the write path the failure of which is CRITICAL', 'CRITICAL'], ['Nothing else is CRITICAL.', 'CRITICAL'],
      ['No other issue is CRITICAL.', 'CRITICAL'], ['No remaining finding is CRITICAL.', 'CRITICAL'], ['None of the blockers are CRITICAL.', 'CRITICAL'], ['This is not CRITICAL.', 'CRITICAL'],
      ['Otherwise nothing CRITICAL.', 'CRITICAL'], ['- No CRITICAL issues.', 'CRITICAL'], ['1. No CRITICAL issues.', 'CRITICAL'], ['**No CRITICAL issues.**', 'CRITICAL'],
      ['CRITICAL: none of the writes are atomic.', 'CRITICAL'], ['No CRITICAL issues. Severity: High', 'High'], ['No CRITICAL issues. Blocks: yes', 'CRITICAL'],
      ['{"severity":"CRITICAL","summary":"I found nothing CRITICAL"}', 'CRITICAL'], ['No CRITICAL — the upload handler drops auth.', 'CRITICAL']];
    for (const [line, label] of kept) expect([line, labels(line)]).toEqual([line, [label]]);
    expect(labels('1. Token leak in log.ts:3 must be fixed before landing.\n\nNothing else is CRITICAL.')).toEqual(['CRITICAL']);
    expect(labels('The token leak blocks the merge.\nNo other issue is CRITICAL.')).toEqual(['CRITICAL']);
    expect(labels('## CRITICAL\n- No CRITICAL issues in the fix.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing CRITICAL. Here is what I checked:\n- **Auth:** the token check at auth.ts:9 is CRITICAL and missing.')).toEqual(['INFORMATIONAL', 'CRITICAL']);
    expect(labels('No FIXABLE findings.', 'adversarial-native')).toEqual(['CRITICAL']);
    expect(labels('Apart from the SQL injection in db.ts:40, I found\nnothing CRITICAL.')).toEqual(['CRITICAL']);
    for (const wrap of ['Apart from the SQL injection in db.ts:40 —\nnothing CRITICAL.\nRecommendation: request changes because the SQL injection exposes the database',
      'Apart from the SQL injection in db.ts:40\nI found nothing CRITICAL.', 'Apart from the SQL injection in `db.ts:40`\nnothing CRITICAL.', 'The guard was removed (see auth)\nno CRITICAL issue.',
      'Apart from the SQL injection in db.ts:40, the rest is fine.\nI found nothing CRITICAL.', '1. auth.ts:3 LOW: log line too verbose\nNo CRITICAL issues remain.'])
      expect([wrap, labels(wrap).at(-1)]).toEqual([wrap, 'CRITICAL']);
    expect(labels('The rest of the diff is fine.\nI found nothing CRITICAL.')).toEqual([]);
    expect(labels('The webhook check is gone and I found\nno CRITICAL issues.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing CRITICAL and two high issues.')).toEqual(['CRITICAL']);
    expect(labels('## Summary\nI found nothing CRITICAL.')).toEqual([]);
    expect(labels('High risk in the retry path. No CRITICAL issues.')).toEqual(['CRITICAL']);
    expect(summaryCandidate('No auth check guards the admin route, so nothing CRITICAL.')).toBe(true);
  });
});
