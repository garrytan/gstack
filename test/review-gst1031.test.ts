import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promptHash } from '../lib/review-brief';
import { collect, judge, ledgerBlockers, parseFindings, readJsonl, recordJudgment, summaryCandidate, verify } from '../lib/review-ledger';
import { isBlocking, summarizeReviewLoop } from '../lib/review-scope';

const ROOT = path.resolve(import.meta.dir, '..');
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger', name), 'utf8');
const labels = (reader: string, output: string, raises: boolean) => parseFindings(reader, output, raises).map(f => f.label);
const HEAD = '**1. The family check refuses two models in one call (check.ts:165-169). FIXABLE.**';

describe('one record per native finding at its stated severity (GST-1031 case 1, ruling A)', () => {
  // Value: protects=a native finding whose reader states Severity and Blocks: no collects once, at that severity, on every class, and a
  //   heading keeps its body (located or numbered bullets, a bold subheading, a located paragraph) until its fields arrive;
  //   fails_when=the heading collects CRITICAL beside a separate severity record, or the gate class raises a Blocks: no finding;
  //   why_new=GEVA-196 (gstack-evals #153) and GSTA-150 GST-1027 looped Steps 9-11 at about 12M tokens a hit; seam=parseFindings;
  //   no_claim=which class a diff belongs to (lib/review-depth.ts decides)
  test.each([true, false])('the GEVA-196 shape collects Medium, Low, Low with raises=%p', (raises) => {
    const found = parseFindings('adversarial-native', fixture('gst-1031-native.txt'), raises);
    expect(found.map(f => f.label)).toEqual(['Medium', 'Low', 'Low']);
    expect(found.map(f => f.raw.startsWith('**'))).toEqual([true, true, true]);
  });
  test.each([
    ['located bullets', [HEAD, 'The check runs always.', '', 'Now every judge stops:', '- the default judge clashes in policy.ts:12;', '- the other judges clash in call.ts:40.', '', 'Fix: gate it on judged.', 'Severity: Medium. Blocks: no.']],
    ['numbered bullets', [HEAD, 'The check runs always.', '', 'Now every judge stops:', '1. the default judge clashes;', '2. the other judges clash.', '', 'Severity: Medium. Blocks: no.']],
    ['a bold subheading', [HEAD, 'The check runs always.', '', '**Why it matters**', 'So the two models cannot share a call.', 'Severity: Medium. Blocks: no.']],
    ['a located paragraph', [HEAD, 'The check runs always.', '', 'The caller in call.ts:40 picks the judge by provider.', 'Severity: Medium. Blocks: no.']],
  ])('a heading keeps its body with %s: one record on both classes', (_shape, lines) => {
    for (const raises of [true, false]) expect(labels('adversarial-native', (lines as string[]).join('\n'), raises)).toEqual(['Medium']);
  });
  test('negative controls: no Blocks: no, Blocks: yes, no Severity field, or a labeled body line keep the raise or their own record', () => {
    for (const raises of [true, false]) {
      expect(labels('adversarial-native', [HEAD, 'Body.', 'Severity: Medium.'].join('\n'), raises)).toEqual(['CRITICAL']);
      expect(labels('adversarial-native', [HEAD, 'Body.', 'Severity: Medium. Blocks: yes.'].join('\n'), raises)).toEqual(['CRITICAL']);
      expect(labels('adversarial-native', [HEAD, 'Body.', 'Blocks: no.'].join('\n'), raises)).toEqual(['CRITICAL']);
      expect(labels('adversarial-native', [HEAD, '', '- High: the caller in call.ts:40 leaks the key.', '', 'Severity: Medium. Blocks: no.'].join('\n'), raises)).toEqual(['CRITICAL', 'High']);
    }
    expect(labels('adversarial-native', '## FIXABLE\n1. Leak in a.ts:3\n2. Race in b.ts:4. Blocks: no', true)).toEqual(['CRITICAL', 'CRITICAL']);
  });
  test('collect records the stated severity beside the one record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031-'));
    const c = collect(path.join(dir, 'l.jsonl'), 'adversarial-native', fixture('gst-1031-native.txt'), path.join(dir, 'm.jsonl'));
    expect(c.lines.map(l => [l.label, l.stated])).toEqual([['Medium', { severity: 'Medium', blocks: 'no' }], ['Low', { severity: 'Low', blocks: 'no' }], ['Low', { severity: 'Low', blocks: 'no' }]]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('a closing summary is a candidate lead judgment may dismiss on record (GST-1031 case 5)', () => {
  // Value: protects=a sentence that names a severity with no file:line and no exception clause collects as a summary_candidate, which
  //   judge lets lead judgment lower with a reason (recorded as dismissed) so it stops counting as a blocker, while it still collects at
  //   its label; fails_when=GSTA-212's "nothing is CRITICAL" or GST-986 r2's "covers the CRITICAL fix" can only be cleared by a
  //   hand-edited row, a candidate lowered without a reason passes judge, or GST-766's exception-clause line becomes a candidate;
  //   why_new=both stopped /ship with NEXT: stop; seam=collect, judge, ledgerBlockers; no_claim=that a dismissal is right (it is on record)
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031s-'));
  test('the negated and the plain summary sentence are candidates; dismissed with a reason they leave the blocker count', () => {
    for (const [reader, output, id] of [['fix-check', 'None of these would fail a test or let a real consumer through on input the fix was about, so nothing is CRITICAL.\n', 'fix-check#1'], ['fix-check', fixture('gst-1031-fix-check.txt'), 'fix-check#4']]) {
      const d = dir();
      const ledger = path.join(d, 'l.jsonl');
      const merged = path.join(d, 'm.jsonl');
      fs.writeFileSync(path.join(d, 'out.txt'), output!);
      const c = collect(ledger, reader!, output!, merged, path.join(d, 'out.txt'));
      expect(c.lines.filter(l => l.summary_candidate).map(l => [l.id, l.label])).toEqual([[id, 'CRITICAL']]);
      const write = (reason?: string) => { fs.writeFileSync(path.join(d, 'j.jsonl'), c.lines.map(l => JSON.stringify({ id: l.id, severity: 'INFORMATIONAL', ...(l.id === id && reason ? { reason } : {}) })).join('\n') + '\n'); return recordJudgment(ledger, c.lines, readJsonl(path.join(d, 'j.jsonl')), path.join(d, 'j.jsonl'), merged); };
      expect(write()).toMatchObject({ ok: false, downgraded: [id], dismissed: [] });
      expect(write('closing summary: it names no defect')).toMatchObject({ ok: true, downgraded: [], dismissed: [id] });
      expect(ledgerBlockers(ledger)).toEqual([]);
      expect(verify(ledger).rows.find(r => r.kind === 'JUDGE')!.status).toBe('OK');
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  test('coordinated denials are candidates', () => {
    for (const line of ['No CRITICAL or HIGH findings remain.', 'Nothing CRITICAL or HIGH remains.', 'No CRITICAL/HIGH findings.', 'No CRITICAL, HIGH or MEDIUM issues.', 'Nothing at CRITICAL severity remains.', 'No CRITICAL — the fix is sound.'])
      expect([line, summaryCandidate(line)]).toEqual([line, true]);
  });
  test('negative controls: a locus, an exception clause, a lead label, a field or a JSON finding is no candidate and keeps its label', () => {
    for (const line of ['No CRITICAL issues except the token leak in log.ts:3.', 'Nothing else is CRITICAL, but the retry loop never ends.', 'The token leak in log.ts:3 is CRITICAL.',
      'The leak in bin/gstack-log:3 is CRITICAL.', 'CRITICAL: the retry loop never ends.', 'The retry loop never ends. Severity: High', 'Not checked. Blocks: no. CRITICAL', '{"severity":"CRITICAL","summary":"x"}',
      'The retry loop in the upload handler never ends, which is CRITICAL.', 'Path traversal in the download route lets any user read arbitrary files; this is CRITICAL.',
      'The session token is written to the debug log on every request, a CRITICAL leak.', 'Nothing guards the write path the failure of which is CRITICAL',
      'There is no CRITICAL lock around the refund write, so two workers double-pay.', 'The patch closes the CRITICAL window only on Linux; on macOS the race remains.']) {
      expect([line, summaryCandidate(line)]).toEqual([line, false]);
      expect(parseFindings('fix-check', line).length).toBe(1);
    }
    const lowered = judge([{ id: 'r#1', reader: 'r', label: 'CRITICAL', raw: 'No CRITICAL issues except the token leak in log.ts:3.', output_sha256: 'x' }], [{ id: 'r#1', severity: 'INFORMATIONAL', reason: 'summary' }]);
    expect(lowered).toMatchObject({ ok: false, downgraded: ['r#1'] });
  });
});

describe('lead judgment may lower a native finding to the Severity its reader stated beside Blocks: no (GST-1031 ruling A, GST-1406)', () => {
  // Value: protects=a native finding whose reader wrote its Severity and Blocks: no after prose (so collect keeps the FIXABLE raise)
  //   can be lowered by lead judgment to that Severity, on record with a reason, so the native record can bind; fails_when=that finding
  //   is an unlowerable CRITICAL (GSTA-275 GST-1276 v4 stopped Step 11.5), or the route lowers a non-native finding, one stating Blocks:
  //   yes or no Blocks, one below its stated Severity, or one with no reason; why_new=collect cannot tell a heading's own fields from
  //   another subject's (GST-1406 red team), lead judgment can; seam=judge, ledgerBlockers; no_claim=that a lowering is right (it is on record)
  const OUT = ['**1. Title (FIXABLE).** body in lib/x.ts:', '- a', '- b', '', 'Before this diff it stopped. Fix: refuse it. Severity: Medium. Blocks: no, because a reader still reads it.', ''].join('\n');
  const run = (reader: string, output: string, severity: string, reason?: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1406-'));
    const ledger = path.join(d, 'l.jsonl');
    const merged = path.join(d, 'm.jsonl');
    fs.writeFileSync(path.join(d, 'out.txt'), output);
    const c = collect(ledger, reader, output, merged, path.join(d, 'out.txt'));
    fs.writeFileSync(path.join(d, 'j.jsonl'), c.lines.map(l => JSON.stringify({ id: l.id, severity, ...(reason ? { reason } : {}) })).join('\n') + '\n');
    const r = recordJudgment(ledger, c.lines, readJsonl(path.join(d, 'j.jsonl')), path.join(d, 'j.jsonl'), merged);
    const out = { labels: c.lines.map(l => l.label), ok: r.ok, dismissed: r.dismissed.length, blockers: ledgerBlockers(ledger).length };
    fs.rmSync(d, { recursive: true, force: true });
    return out;
  };
  test('lowered to its stated Severity with a reason, it is dismissed on record and leaves the blocker count', () => {
    expect(run('adversarial-native', OUT, 'Medium', 'its reader stated Severity: Medium, Blocks: no')).toEqual({ labels: ['CRITICAL'], ok: true, dismissed: 1, blockers: 0 });
  });
  test('negative controls: no reason, below the stated Severity, Blocks: yes, no Blocks, or a non-native reader stay downgrades', () => {
    expect(run('adversarial-native', OUT, 'Medium')).toMatchObject({ ok: false, dismissed: 0 });
    expect(run('adversarial-native', OUT, 'Low', 'r')).toMatchObject({ ok: false, dismissed: 0 });
    expect(run('adversarial-native', OUT.replace('Blocks: no', 'Blocks: yes'), 'Medium', 'r')).toMatchObject({ ok: false, dismissed: 0 });
    expect(run('adversarial-native', OUT.replace(' Blocks: no, because a reader still reads it.', ''), 'Medium', 'r')).toMatchObject({ ok: false, dismissed: 0 });
    expect(run('red-team', '**1. Auth bypass lets any user read admin data (CRITICAL).**\n\nThe earlier triage filed it lower. Severity: Low. Blocks: no.\n', 'Low', 'r')).toMatchObject({ ok: false, dismissed: 0 });
    expect(run('adversarial-native', OUT.replace('Severity: Medium', 'Severity: FIXABLE'), 'Low', 'r')).toMatchObject({ ok: false, dismissed: 0 });
  });
  test('a merged row whose reader was edited to adversarial-native is caught by verify', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1406r-'));
    const ledger = path.join(d, 'l.jsonl');
    const merged = path.join(d, 'm.jsonl');
    const output = 'CRITICAL: admin.ts:9 skips authentication. Severity: Low. Blocks: no.\n';
    fs.writeFileSync(path.join(d, 'out.txt'), output);
    const c = collect(ledger, 'outside-voice', output, merged, path.join(d, 'out.txt'));
    const forged = c.lines.map(l => ({ ...l, reader: 'adversarial-native' }));
    fs.writeFileSync(merged, forged.map(l => JSON.stringify(l)).join('\n') + '\n');
    fs.writeFileSync(path.join(d, 'j.jsonl'), forged.map(l => JSON.stringify({ id: l.id, severity: 'Low', reason: 'r' })).join('\n') + '\n');
    recordJudgment(ledger, forged, readJsonl(path.join(d, 'j.jsonl')), path.join(d, 'j.jsonl'), merged);
    const v = verify(ledger);
    expect(v.clean).toBe(false);
    expect(v.rows.find(r => r.kind === 'OUTPUT')!.detail).toContain('merged_line_differs=["outside-voice#1"]');
    expect(v.rows.find(r => r.kind === 'JUDGE')!.status).toBe('MISMATCH');
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('the blocker count keys on Blocks (GST-1031 case 3)', () => {
  // Value: protects=a CRITICAL its reader marked Blocks: no is not counted as a blocker by the ledger count, the row count or Step
  //   9.4's classify, while Blocks: yes, an unstated Blocks and a lead promotion still block; fails_when=REVIEW_LOOP reports a
  //   Blocks: no note as found or unrecorded, or a Blocks: yes CRITICAL stops blocking; why_new=ggstack#52: a lane hand-added
  //   fixed rows to get a receipt; seam=ledgerBlockers, summarizeReviewLoop, isBlocking; no_claim=what the reader meant
  const OUT = '1. Drops rows in q.ts:7. Severity: Critical. Blocks: no.\n\n2. Leaks a token in log.ts:3. Severity: Critical. Blocks: yes.\n\n3. Races in a.ts:9. Severity: Critical.\n\n4. Slows down in b.ts:2. Severity: Medium. Blocks: no.\n';
  const run = (judged?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031b-'));
    const ledger = path.join(dir, 'l.jsonl');
    const merged = path.join(dir, 'm.jsonl');
    fs.writeFileSync(path.join(dir, 'out.txt'), OUT);
    collect(ledger, 'outside-voice', OUT, merged, path.join(dir, 'out.txt'));
    if (judged !== undefined) {
      fs.writeFileSync(path.join(dir, 'j.jsonl'), judged);
      fs.appendFileSync(ledger, JSON.stringify({ event: 'judge', ok: true, judged: path.join(dir, 'j.jsonl'), judged_sha256: promptHash(judged) }) + '\n');
    }
    const ids = ledgerBlockers(ledger).map(b => b.id);
    fs.rmSync(dir, { recursive: true, force: true });
    return ids;
  };
  test('ledgerBlockers skips a Blocks: no CRITICAL and keeps Blocks: yes, unstated and a lead promotion', () => {
    expect(run()).toEqual(['outside-voice#2', 'outside-voice#3']);
    const promote = ['outside-voice#1', 'outside-voice#2', 'outside-voice#3'].map(id => JSON.stringify({ id, severity: 'CRITICAL' })).join('\n') + '\n' + JSON.stringify({ id: 'outside-voice#4', severity: 'CRITICAL', reason: 'it loses rows' }) + '\n';
    expect(run(promote)).toEqual(['outside-voice#2', 'outside-voice#3', 'outside-voice#4']);
  });
  test('a verb "blocks no" is no Blocks field: the located CRITICAL still counts, on the ledger and in a native finding', () => {
    for (const out of ['CRITICAL: The lock in queue.ts:40 blocks no other writer, so two passes lose findings.\n', '1. **CRITICAL** — cache.ts:12 evicts on read; it blocks no request with a stale token.\n', '- CRITICAL src/auth.ts:9 token check is skipped; it blocks no attacker.\n']) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031v-'));
      const c = collect(path.join(d, 'l.jsonl'), 'outside-voice', out, path.join(d, 'm.jsonl'));
      expect([out, c.lines[0]!.stated?.blocks, ledgerBlockers(path.join(d, 'l.jsonl')).map(b => b.id)]).toEqual([out, undefined, ['outside-voice#1']]);
      fs.rmSync(d, { recursive: true, force: true });
    }
    for (const raises of [true, false]) expect(labels('adversarial-native', '**1. Race in a.ts:3. FIXABLE.**\nIt blocks no attacker.\nSeverity: Low.', raises)).toEqual(['CRITICAL']);
    const q = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031y-'));
    const y = collect(path.join(q, 'l.jsonl'), 'outside-voice', 'CRITICAL: auth.ts:9 skips authentication. The previous note said `Blocks: no`. Blocks yes.\n', path.join(q, 'm.jsonl'));
    expect([y.lines[0]!.stated?.blocks, ledgerBlockers(path.join(q, 'l.jsonl')).map(b => b.id)]).toEqual(['yes', ['outside-voice#1']]);
    fs.rmSync(q, { recursive: true, force: true });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031j-'));
    collect(path.join(d, 'l.jsonl'), 'specialist', JSON.stringify({ severity: 'CRITICAL', path: 'lib/auth.ts', line: 9, summary: 'the old guard, which a reader marked `Blocks: no`, is gone so any caller gets admin' }) + '\n', path.join(d, 'm.jsonl'));
    expect(ledgerBlockers(path.join(d, 'l.jsonl')).map(b => b.id)).toEqual(['specialist#1']);
    fs.rmSync(d, { recursive: true, force: true });
  });
  test('classify and the row count key on Blocks, and a raw holding both Blocks: yes and no blocks', () => {
    expect(isBlocking({ severity: 'CRITICAL', stated: { severity: 'Critical', blocks: 'no' } })).toBe(false);
    expect(isBlocking({ severity: 'CRITICAL', stated: { severity: 'Critical', blocks: 'yes' } })).toBe(true);
    expect(isBlocking({ severity: 'CRITICAL' })).toBe(true);
    const row = (stated?: object) => ({ skill: 'review', via: 'ship', timestamp: '2026-11-02T00:00:00Z', findings: [{ path: 'q.ts', line: 7, severity: 'CRITICAL', ...(stated ? { stated } : {}) }] });
    expect(summarizeReviewLoop([row({ blocks: 'no' })], '2026-11-01T00:00:00Z').blocking_found).toBe(0);
    expect(summarizeReviewLoop([row()], '2026-11-01T00:00:00Z')).toMatchObject({ blocking_found: 1, unrecorded: 1 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gst1031c-'));
    const both = collect(path.join(dir, 'l.jsonl'), 'outside-voice', 'Leaks a token in log.ts:3. Severity: Critical. Blocks: yes. Retry is fine. Blocks: no.\n', path.join(dir, 'm.jsonl'));
    expect(both.lines.map(l => l.stated?.blocks)).toEqual(['yes']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
