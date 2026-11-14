/**
 * GST-2495: every blocking reader's reply carries `REVIEW_VERDICT: blocking=<n>[ at=<path>:<line>,...]`, and collect checks it
 * against the findings it parses instead of inferring "nothing blocks" from prose (docs/review-policy.md#verdict-line). The
 * controls are test/fixtures/review-ledger/verdict-controls.json: the GSTA-521 probe lines, FOUN-298's native reply
 * (founderstar#926), #3901's verdict line and CAPY-1's fix-check (qm #3567) and red-team (qm #3589) summaries.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRIEF_ROLES, promptHash, VERDICT_ASK, withWorkspace } from '../lib/review-brief';
import { appendEvent, collect, judge, parseFindings, parseReply, rank, readJsonl, recordJudgment, recordSent, statesNoBlocks, verify, type MergedLine } from '../lib/review-ledger';
import { parseVerdict, withoutVerdictLines } from '../lib/review-verdict';

const ROOT = path.resolve(import.meta.dir, '..');
const CONTROLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/review-ledger/verdict-controls.json'), 'utf8')) as { probes: string[]; outputs: Record<string, string> };
const TREE = `REVIEWED_TREE: ${'a'.repeat(40)} /workspace/app`;
const blocking = (fs: Array<{ label: string; raw: string }>) => fs.filter(f => (rank(f.label) ?? 0) >= 4 && !statesNoBlocks(f.raw)).length;
const reply = (body: string, line?: string) => [TREE, ...(line === undefined ? [] : [line]), '', body].join('\n');
const asked = (role: string, out: string, raises = true) => parseReply(role, out, raises, true);

describe('the REVIEW_VERDICT line', () => {
  test('grammar: count, optional locations, wrappers; fenced lines ignored; identical repeats count once, differing ones are malformed', () => {
    expect(parseVerdict('REVIEW_VERDICT: blocking=0')).toEqual({ state: 'valid', blocking: 0, at: [] });
    expect(parseVerdict('x\n**REVIEW_VERDICT: blocking=2 at=lib/a.ts:3,b.md:9**')).toEqual({ state: 'valid', blocking: 2, at: ['lib/a.ts:3', 'b.md:9'] });
    expect(parseVerdict('- `REVIEW_VERDICT: blocking=1`')).toEqual({ state: 'valid', blocking: 1, at: [] });
    expect(parseVerdict('REVIEW_VERDICT: blocking=1\nREVIEW_VERDICT: blocking=1')).toEqual({ state: 'valid', blocking: 1, at: [] });
    expect(parseVerdict('no line here').state).toBe('missing');
    expect(parseVerdict('```\nREVIEW_VERDICT: blocking=0\n```').state).toBe('missing');
    for (const bad of ['REVIEW_VERDICT: blocking=two', 'REVIEW_VERDICT: blocking=0 at=lib/a.ts:3', 'REVIEW_VERDICT: blocking=100', 'REVIEW_VERDICT: none',
      'REVIEW_VERDICT: blocking=1 at=somewhere', 'REVIEW_VERDICT: blocking=0\nREVIEW_VERDICT: blocking=1', 'review_verdict: blocking=0 trailing words']) expect(parseVerdict(bad).state, bad).toBe('malformed');
    expect(withoutVerdictLines('a\nREVIEW_VERDICT: blocking=0\n```\nREVIEW_VERDICT: blocking=9\n```')).toBe('a\n```\nREVIEW_VERDICT: blocking=9\n```');
  });

  test('the ask: every blocking role\'s brief carries it after the fingerprint step and in the closing paragraph; an audit reader\'s does not', () => {
    const w = withWorkspace('BODY', '/work/repo', undefined, { verdict: true });
    expect(w.split('\n\n')[0]).toContain(VERDICT_ASK);
    expect(w.endsWith('gstack checks that count against your findings, so do not repeat it.')).toBe(true);
    expect(withWorkspace('BODY', '/work/repo')).not.toContain('REVIEW_VERDICT');
    expect(BRIEF_ROLES.length).toBe(7);
  });
});

describe('negative controls on every blocking role, both review classes', () => {
  // A valid line lowers nothing by itself (Captain ruling D1, 2026-11-14): no probe line, role or line state stops blocking.
  for (const role of BRIEF_ROLES) for (const raises of [true, false]) {
    test(`${role} ${raises ? 'gate' : 'relaxed'} class`, () => {
      const lowered: number[] = [];
      for (const [i, p] of CONTROLS.probes.entries()) {
        const main = parseFindings(role, reply(p), raises);
        for (const line of [undefined, 'REVIEW_VERDICT: blocking=none', 'REVIEW_VERDICT: blocking=0\nREVIEW_VERDICT: blocking=1']) {
          expect(asked(role, reply(p, line), raises).findings.map(f => [f.label, f.raw]), `${i} ${line}`).toEqual(main.map(f => [f.label, f.raw]));
        }
        // A declared blocker the parser missed always blocks; unlocated ones share one row, so blocking_found counts them once.
        for (const n of [1, 2]) expect(blocking(asked(role, reply(p, `REVIEW_VERDICT: blocking=${n}`), raises).findings), `${i} blocking=${n}`).toBeGreaterThanOrEqual(1);
        const zero = asked(role, reply(p, 'REVIEW_VERDICT: blocking=0'), raises).findings;
        if (blocking(main) && !blocking(zero)) lowered.push(i);
      }
      expect(lowered).toEqual([]);
    });
  }

  test('FOUN-298: blocking=0 keeps CRITICAL,Low,Low,Low and makes the summary row a candidate the lead may lower; with no line nothing is flagged', () => {
    const out = CONTROLS.outputs.foun298!;
    const at = out.replace(/^(REVIEWED_TREE: .*)$/m, '$1\nREVIEW_VERDICT: blocking=0');
    for (const raises of [true, false]) {
      const r = asked('adversarial-native', at, raises);
      expect(r.findings.map(f => [f.label, f.summary ?? false])).toEqual([['CRITICAL', true], ['Low', false], ['Low', false], ['Low', false]]);
      expect(r.verdict).toEqual({ state: 'valid', parsed: 1, declared: 0, agrees: false });
      expect(asked('adversarial-native', out, raises).findings.some(f => f.summary)).toBe(false);
      expect(asked('adversarial-native', out, raises).findings.map(f => f.label)).toEqual(['CRITICAL', 'Low', 'Low', 'Low']);
      expect(asked('adversarial-native', at.replace('blocking=0', 'blocking=1'), raises).verdict).toMatchObject({ declared: 1, parsed: 1, agrees: true });
    }
  });

  test('#3901: without a line every role parses as on main', () => {
    for (const role of BRIEF_ROLES) for (const raises of [true, false]) expect(asked(role, CONTROLS.outputs.pr3901!, raises).findings).toEqual(parseFindings(role, CONTROLS.outputs.pr3901!, raises));
  });

  test('CAPY-1 (qm #3567 fix-check, qm #3589 red-team): blocking=0 keeps the CRITICAL row but makes it a summary candidate; no line keeps it a plain CRITICAL', () => {
    for (const key of ['capy1_fix_check', 'capy1_red_team']) for (const role of BRIEF_ROLES) {
      const out = CONTROLS.outputs[key]!;
      const zero = asked(role, out.replace(/^(REVIEWED_TREE: .*)$/m, '$1\nREVIEW_VERDICT: blocking=0'));
      expect(zero.findings.map(f => [f.label, f.summary ?? false]), `${key} ${role}`).toEqual([['INFORMATIONAL', false], ['CRITICAL', true]]);
      expect(zero.verdict).toMatchObject({ declared: 0, parsed: 1, agrees: false });
      expect(asked(role, out).findings.map(f => [f.label, f.summary ?? false])).toEqual([['INFORMATIONAL', false], ['CRITICAL', false]]);
      expect(asked(role, out.replace(/^(REVIEWED_TREE: .*)$/m, '$1\nREVIEW_VERDICT: blocking=1')).findings.map(f => [f.label, f.summary ?? false])).toEqual([['INFORMATIONAL', false], ['CRITICAL', false]]);
    }
  });

  test('positive phrasings under blocking=0 still block, as summary candidates the lead may lower with a reason', () => {
    const one = (p: string) => asked('adversarial-native', reply(p, 'REVIEW_VERDICT: blocking=0')).findings.map(f => [f.label, f.summary ?? false]);
    expect(one('Nothing that blocks: one Medium and two Low findings, all FIXABLE.')).toEqual([['CRITICAL', true]]);
    expect(one('Nothing that blocks: three High findings, all FIXABLE.')).toEqual([['CRITICAL', true]]);
    expect(one('Nothing that blocks: two CRITICAL findings, all FIXABLE.')).toEqual([['CRITICAL', true]]);
  });

  test('a real unanchored FIXABLE blocker beside a denial line keeps blocking when the count agrees (Step 11 rerun at 1acb0d5)', () => {
    const out = CONTROLS.outputs.native_relabel_loss!;
    for (const raises of [true, false]) {
      const r = asked('adversarial-native', out, raises);
      expect(r.findings[0]!.label, `raises=${raises}`).toBe(raises ? 'CRITICAL' : parseFindings('adversarial-native', out, raises)[0]!.label);
      expect(r.findings.map(f => [f.label, f.raw])).toEqual(parseFindings('adversarial-native', out, raises).map(f => [f.label, f.raw]));
    }
    const gate = asked('adversarial-native', out);
    expect(blocking(gate.findings)).toBe(2);
    expect(gate.verdict).toMatchObject({ declared: 1, parsed: 2, agrees: false });
    expect(gate.findings.map(f => f.summary ?? false)).toEqual([true, true]);
  });
});

describe('declared more blockers than parsed', () => {
  test('one row per unmatched location and one for the rest, appended after the parsed rows', () => {
    const out = reply('1. **Cache key (key.ts:3).** FIXABLE: key on the tree. Severity: Low. Blocks: no.', 'REVIEW_VERDICT: blocking=3 at=key.ts:3,lib/auth.ts:10');
    const r = asked('adversarial-native', out);
    expect(r.findings.map(f => [f.label, !!f.synthetic])).toEqual([['Low', false], ['CRITICAL', true], ['CRITICAL', true], ['CRITICAL', true]]);
    expect(r.findings[1]!.raw.startsWith('key.ts:3: REVIEW_VERDICT declared blocking=3, but collect parsed 0')).toBe(true);
    expect(r.findings[2]!.raw.startsWith('lib/auth.ts:10: ')).toBe(true);
    expect(r.findings[3]!.raw).toContain('1 declared blocker with no location named');
    expect(asked('adversarial-native', out.replace('blocking=3 at=key.ts:3,lib/auth.ts:10', 'blocking=1 at=key.ts:3')).findings.map(f => f.raw.split(':')[0])).toEqual(['1. **Cache key (key.ts', 'key.ts']);
  });
});

describe('the line never colours its neighbour', () => {
  test('in an asked render it is skipped; main\'s parser (no ask) still raises the shapes it always did', () => {
    const next = 'I found no Critical findings and two Low findings.';
    const out = `${TREE}\nREVIEW_VERDICT: blocking=0\n${next}`;
    expect(asked('fix-check', out).findings).toEqual(parseFindings('fix-check', `${TREE}\n${next}`));
    expect(parseFindings('fix-check', `${TREE}\n${next}`).map(f => f.label)).toEqual(['Low']);
    const pinned = parseFindings('fix-check', out).map(f => f.label);
    expect(pinned).toEqual(parseFindings('fix-check', out).map(f => f.label));
    for (const role of BRIEF_ROLES) for (const p of CONTROLS.probes) {
      const without = parseFindings(role, reply(p));
      const withLine = parseFindings(role, reply(p, 'REVIEW_VERDICT: blocking=0'));
      expect(blocking(withLine), `${role} ${p}`).toBeGreaterThanOrEqual(blocking(without));
    }
  });
});

describe('a finding line that names REVIEW_VERDICT is never stripped', () => {
  test('prose about the token is no attempt, and a malformed attempt keeps its line for the parser', () => {
    const finding = '1. REVIEW_VERDICT parsing in lib/a.ts:3 drops findings. CRITICAL. Blocks: yes';
    const r = asked('specialist/testing', reply(finding, 'REVIEW_VERDICT: blocking=1 at=lib/a.ts:3'));
    expect(r.findings.filter(f => f.label === 'CRITICAL').length).toBeGreaterThanOrEqual(1);
    expect(r.verdict?.state).toBe('valid');
    expect(r.verdict?.agrees).toBe(true);
    const malformed = '- REVIEW_VERDICT: lines in lib/a.ts:3 are dropped. CRITICAL. Blocks: yes';
    const m = asked('specialist/testing', reply(malformed));
    expect(m.verdict?.state).toBe('malformed');
    expect(blocking(m.findings)).toBe(blocking(parseFindings('specialist/testing', reply(malformed))));
    expect(blocking(m.findings)).toBeGreaterThanOrEqual(1);
  });
});

describe('a ledger round trip', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const run = (verdict: boolean, outputs: string[]) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verdict-')); dirs.push(d);
    const ledger = path.join(d, 'review-ledger.jsonl'), merged = path.join(d, 'merged.jsonl');
    fs.writeFileSync(merged, '');
    for (const [k, out] of outputs.entries()) {
      const brief = path.join(d, `brief${k}.md`), text = `brief ${k}`;
      fs.writeFileSync(brief, text);
      appendEvent(ledger, { event: 'rendered', reader: 'adversarial-native', role: 'adversarial-native', name: null, file: brief, sha256: promptHash(text), bytes: text.length, ...(verdict ? { verdict: 1 } : {}) });
      recordSent(ledger, 'adversarial-native', text);
      const file = path.join(d, `out${k}.md`);
      fs.writeFileSync(file, out);
      collect(ledger, 'adversarial-native', out, merged, file);
    }
    const rows = readJsonl<MergedLine>(merged);
    const judged = rows.map(m => ({ id: m.id, severity: m.label }));
    fs.writeFileSync(path.join(d, 'judged.jsonl'), judged.map(j => JSON.stringify(j)).join('\n') + '\n');
    recordJudgment(ledger, rows, judged, path.join(d, 'judged.jsonl'), merged);
    return { ledger, merged, rows, v: verify(ledger) };
  };
  const declared = reply('1. **Cache key (key.ts:3).** FIXABLE: key on the tree. Severity: Low. Blocks: no.', 'REVIEW_VERDICT: blocking=1');

  test('re-rendered twice: ids keep the per-output prefix, synthetic rows survive verify, and verify counts the verdicts', () => {
    const { rows, v } = run(true, [declared, declared]);
    expect(rows.map(r => r.id)).toEqual(['adversarial-native#1', 'adversarial-native#v1', 'adversarial-native#2.1', 'adversarial-native#2.v1']);
    expect(v.rows.filter(r => r.kind !== 'VERDICT').map(r => r.status).every(s => s === 'MATCH' || s === 'OK')).toBe(true);
    expect(v.clean).toBe(true);
    expect(v.verdicts).toEqual({ asked: 2, agree: 0 });
  });

  test('an edited summary flag or verdict makes verify dirty; a render that never asked ignores the line', () => {
    const capy = CONTROLS.outputs.capy1_fix_check!.replace(/^(REVIEWED_TREE: .*)$/m, '$1\nREVIEW_VERDICT: blocking=0');
    const a = run(true, [capy]);
    expect(a.rows.map(r => r.summary_candidate ?? false)).toEqual([false, true]);
    fs.writeFileSync(a.merged, a.rows.map(r => JSON.stringify({ ...r, summary_candidate: undefined })).join('\n') + '\n');
    expect(verify(a.ledger).clean).toBe(false);
    const b = run(false, [declared]);
    expect(b.rows.map(r => r.id)).toEqual(['adversarial-native#1']);
    expect(b.v.verdicts).toEqual({ asked: 0, agree: 0 });
  });

  test('a summary flag edited onto a real CRITICAL makes verify dirty even when the render never asked', () => {
    const c = run(false, [reply('1. CRITICAL: token leak in auth.ts:3. Blocks: yes')]);
    expect(c.v.clean).toBe(true);
    expect(c.rows.map(r => [r.label, r.summary_candidate ?? false])).toEqual([['CRITICAL', false]]);
    fs.writeFileSync(c.merged, c.rows.map(r => JSON.stringify({ ...r, summary_candidate: true })).join('\n') + '\n');
    expect(verify(c.ledger).clean).toBe(false);
  });

  test('lead judgment lowers a verdict summary candidate only with a reason', () => {
    const rows = run(true, [CONTROLS.outputs.capy1_red_team!.replace(/^(REVIEWED_TREE: .*)$/m, '$1\nREVIEW_VERDICT: blocking=0')]).rows;
    const lower = (reason?: string) => judge(rows, rows.map(m => ({ id: m.id, severity: m.summary_candidate ? 'INFORMATIONAL' : m.label, ...(reason ? { reason } : {}) })));
    expect(lower('the reader\'s own verdict line says nothing blocks').dismissed).toEqual([rows[1]!.id]);
    expect(lower().downgraded).toEqual([rows[1]!.id]);
  });
});
