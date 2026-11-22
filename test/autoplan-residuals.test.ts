/**
 * Field-wave residuals (gstack fix wave review, gate revs 1–2, 2026-10-12/13):
 *  R1 (superseded by next-wave B1, owner decision gate_rev 1): `rec` and its
 *     silent alias `all` take every recommendation, plan changes included;
 *     `as-is` keeps every direction; the render prints the `rec` resolution
 *     from the parser that applies it.
 *  R2 every later phase sees its predecessors' consensus: the DX prompt
 *     carries the CEO consensus, not only the Eng prompt.
 *  R3 lib code spawns the Bun that runs it (`process.execPath`), never `bun`
 *     by PATH name, so the snapshot tool and restamp cannot silently run the
 *     Capy image's 1.3.14 when a parent forgot the launch PATH.
 *  R5 gate answers carry provenance: `answer --by <human|agent:<id>>` is
 *     required in an unattended run and lands on every decision row; an agent
 *     answer also carries the owner's verbatim reply (next-wave B-c), and a
 *     parseable owner reply that resolves differently from the relay is refused.
 *  A gate.json written before `rec` (no rec_rev) refuses alias replies
 *     until the owner sees a re-render (--rec-hash); tokens still answer.
 *  B-b `recommend` changes what `rec` resolves to, so it bumps rec_rev and a
 *     `rec` must carry the rec_hash of the render the owner saw.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { legacyRecHash, parseReply, recHash, renderGate, type GateList } from '../lib/gate-list';
import { attemptsOf, autoplan, readRun, resultOf, review, ROOT, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-residuals-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const keep = { key: 'a', text: 'keep your direction', changes_plan: false };
const change = { key: 'b', text: 'accept the change both reviewers recommend', changes_plan: true };
const agreed: GateList = {
  schema_version: 1, run: 'r', gate_rev: 1, items: [
    { id: 'uc1', title: 'both voices agree', options: [keep, change], recommended: 'b', kind: 'approval', phase: 'ceo', recommended_basis: 'both voices; remedies shown' },
    { id: 'uc2', title: 'one voice', options: [keep, change], recommended: 'a', kind: 'approval', phase: 'ceo' },
    { id: 'd1', title: 'auto item', options: [keep, change], recommended: 'a', kind: 'auto', phase: 'ceo' },
    { id: 'p1', title: 'Plan approval', options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: 'approve with the overrides above' }], recommended: 'a', kind: 'approval' },
  ],
};
const decisions = (out: string) => fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

/** Both voices challenge the same item with the same `changes` and the same remedy: the gate recommends `b`. */
function agreedRun(name: string): string {
  const out = startSmallRun(path.join(TMP, name));
  const native = JSON.stringify([
    { id: 'F1', severity: 'High', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 12, fix: 'print PASS/FAIL per component' },
    { id: 'F3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'stack the lanes' }]);
  const outside = JSON.stringify([
    { id: 'O1', severity: 'Critical', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 14, fix: 'exit non-zero on any FAIL' },
    { id: 'O3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'Stack the lanes.' }]);
  for (const phase of ['ceo', 'eng']) {
    expect(autoplan(['next', '--out', out]).status).toBe(0);
    review(path.join(out, `${phase}-native-prompt.md`), { FIXTURE_FINDINGS: native });
    review(path.join(out, `${phase}-outside-prompt.md`), { FIXTURE_FINDINGS: outside });
    const ids = attemptsOf(out, phase);
    expect(autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', resultOf(out, phase, 'native'), '--model', 'anthropic/claude-opus-4-7', '--attempt', ids.native, '--runner', 'host-subagent']).status).toBe(0);
    expect(autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', resultOf(out, phase, 'outside'), '--model', 'openai/gpt-6-astra', '--attempt', ids.outside, '--runner', 'host-subagent']).status).toBe(0);
  }
  expect(readRun(out).status).toBe('gate_pending');
  return out;
}

describe('R1/B1: `rec` (and its alias `all`) takes every recommendation, plan changes included', () => {
  test('an approval item recommended b is answered by `rec`/`all`; `rec except uc1a` and `as-is` keep the direction', () => {
    for (const reply of ['rec', 'all', 'approve all', 'Accept all', 'take all recommendations']) {
      const r = parseReply(reply, agreed);
      expect(r.valid).toBe(true);
      expect(r.mode).toBe('rec');
      expect(r.pending).toEqual([]);
      expect(r.choices.map(c => `${c.id}${c.chosen}`)).toEqual(['uc1b', 'uc2a', 'd1a', 'p1a']);
    }
    expect(parseReply('rec except uc1a', agreed).choices.find(c => c.id === 'uc1')).toMatchObject({ chosen: 'a', how: 'override' });
    expect(parseReply('all except uc1a', agreed).choices.find(c => c.id === 'uc1')).toMatchObject({ chosen: 'a', how: 'override' });
    for (const reply of ['as-is', 'all as-is']) {
      const r = parseReply(reply, agreed);
      expect(r.mode).toBe('as-is');
      expect(r.choices.find(c => c.id === 'uc1')).toMatchObject({ chosen: 'a' });
    }
    for (const bare of ['yes', 'no', 'rec d1', 'rec yes']) expect(parseReply(bare, agreed).valid).toBe(false);
  });

  test('the rendering offers `rec` first and prints its resolution from the same parser, with the rec_hash', () => {
    const text = renderGate(agreed);
    expect(text).toMatch(/Reply with exactly one of: `rec` \(default: take every recommendation, plan changes included\)/);
    expect(text).toMatch(/"choices":\{"uc1":"b","uc2":"a","d1":"a","p1":"a"\}/);
    expect(text).toMatch(/rec_hash=[0-9a-f]{12}/);
    expect(text).not.toMatch(/does not answer/);
  });

  test('end to end: both voices agree with one remedy, the gate recommends b, and `rec` accepts it as a pending amendment', () => {
    const out = agreedRun('agreed');
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8')) as GateList;
    const uc = gate.items.filter(i => i.id.startsWith('uc'));
    expect(uc.length).toBeGreaterThan(0);
    expect(uc.every(i => i.recommended === 'b' && i.recommended_basis === 'both voices; same remedy')).toBe(true);
    const rec = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--by', 'human']);
    expect(rec.status, rec.stderr).toBe(0);
    for (const i of uc) expect(rec.stdout).toMatch(new RegExp(`^APPLY: ${readRun(out).run}-${i.id} .*; edit the plan, then revise$`, 'm'));
    expect(rec.stdout).toContain('GSTACK_RESULT: skill=autoplan status=amend_pending');
    expect(readRun(out).status).toBe('amend_pending');
    const rows = decisions(out);
    for (const i of uc) expect(rows.find(r => r.label === i.id.toUpperCase())).toMatchObject({ status: 'approved', chosen: 'b' });
  });
});

describe('legacy gates: a gate.json written before `rec` (no rec_rev)', () => {
  test('alias replies are refused until a re-render binds --rec-hash; explicit tokens still answer', () => {
    const out = agreedRun('legacy');
    const gateFile = path.join(out, 'gate.json');
    const gate = JSON.parse(fs.readFileSync(gateFile, 'utf8'));
    expect(gate.rec_rev).toBe(0);
    delete gate.rec_rev;
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2) + '\n');
    const before = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8');
    for (const reply of ['all', 'rec', 'approve all', 'all except uc1a']) {
      const refused = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', reply, '--by', 'human']);
      expect(refused.status, reply).toBe(3);
      expect(refused.stderr).toMatch(/written before `rec`\/`all` took plan changes.*\(GATE_REC_STALE\)$/m);
    }
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before);
    const tokens = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'uc1a', '--by', 'human']);
    expect(tokens.status, tokens.stderr).toBe(0);
    const hash = renderGate(JSON.parse(fs.readFileSync(gateFile, 'utf8'))).match(/rec_hash=([0-9a-f]{12})/)![1]!;
    const bound = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', hash, '--by', 'human']);
    expect(bound.status, bound.stderr).toBe(0);
  });
});

describe('R5: gate answers carry provenance', () => {
  test('an unattended answer without --by is refused and writes nothing; --by lands on every answered row', () => {
    const out = agreedRun('provenance');
    const before = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8');
    const bare = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is']);
    expect(bare.status).toBe(3);
    expect(bare.stderr).toMatch(/\(ANSWER_BY_REQUIRED\)/);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before);
    const bad = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is', '--by', 'me']);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toMatch(/\(ANSWER_BY_REQUIRED\)/);
    const noOwner = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is', '--by', 'agent:GSTA-29']);
    expect(noOwner.status).toBe(3);
    expect(noOwner.stderr).toMatch(/\(OWNER_REPLY_REQUIRED\)/);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before);
    const ok = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all as-is', '--by', 'agent:GSTA-29', '--owner-reply', 'keep the plan as written']);
    expect(ok.status, ok.stderr).toBe(0);
    const answered = decisions(out).filter(r => r.status !== 'pending');
    expect(answered.length).toBeGreaterThan(0);
    for (const r of answered) expect(r).toMatchObject({ answered_by: 'agent:GSTA-29', owner_reply: 'keep the plan as written', owner_reply_parsed: false });
    expect(fs.readFileSync(path.join(out, 'review-record.md'), 'utf8')).toMatch(/answered by agent:GSTA-29/);
  });
});

describe('B-b/B-c: recommend binds rec to the render the owner saw; the owner reply must match the relay', () => {
  test('recommend bumps rec_rev and rewrites p1 and decisions; a rec without the new rec_hash is refused; a mismatched owner reply is refused', () => {
    const out = agreedRun('recommend');
    const gateFile = path.join(out, 'gate.json');
    const uc = (JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList).items.find(i => i.id.startsWith('uc'))!;
    const oldHash = renderGate(JSON.parse(fs.readFileSync(gateFile, 'utf8'))).match(/rec_hash=([0-9a-f]{12})/)![1]!;
    const rec = autoplan(['recommend', '--out', out, '--gate-rev', '1', '--item', uc.id, '--option', 'a', '--basis', 'the lanes already split by file', '--by', 'parent']);
    expect(rec.status, rec.stderr).toBe(0);
    const hash = rec.stdout.match(/^RECOMMENDED: .* rec_hash=([0-9a-f]{12})$/m)![1]!;
    expect(hash).not.toBe(oldHash);
    const gate = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
    expect(gate.rec_rev).toBe(1);
    expect(gate.items.find(i => i.id === uc.id)).toMatchObject({ recommended: 'a', recommended_basis: 'the lanes already split by file', recommended_by: 'parent' });
    expect(renderGate(gate)).toContain(`rec_hash=${hash}`);
    expect(decisions(out).find(r => r.label === uc.id.toUpperCase())).toMatchObject({ recommended: 'a', recommended_by: 'parent' });
    const before = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8');
    for (const extra of [[], ['--rec-hash', oldHash]]) {
      const stale = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--by', 'human', ...extra]);
      expect(stale.status).toBe(3);
      expect(stale.stderr).toMatch(/\(GATE_REC_STALE\)/);
    }
    const mismatch = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', hash, '--by', 'agent:GSTA-29', '--owner-reply', `${uc.id}b`]);
    expect(mismatch.status).toBe(3);
    expect(mismatch.stderr).toMatch(/\(GATE_OWNER_REPLY_MISMATCH\)/);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before);
    const ownerFile = path.join(TMP, 'owner-reply.txt');
    fs.writeFileSync(ownerFile, 'rec');
    const ok = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', hash, '--by', 'agent:GSTA-29', '--owner-reply-file', ownerFile]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).not.toMatch(new RegExp(`^APPLY: \\S+-${uc.id} `, 'm'));
    expect(ok.stdout).toMatch(/^APPLY: \S+-uc2 /m);
    expect(decisions(out).find(r => r.label === uc.id.toUpperCase())).toMatchObject({ chosen: 'a', owner_reply: 'rec', owner_reply_parsed: true, recommended_by: 'parent' });
  });
});

describe('GST-1819: rec_hash binds to its run; a gate rendered before that keeps its own hash', () => {
  test('another run\'s rec_hash for the same decision shape is refused; an unmarked gate accepts its legacy hash and records it', () => {
    const out = agreedRun('run-bound');
    const gateFile = path.join(out, 'gate.json');
    const gate = JSON.parse(fs.readFileSync(gateFile, 'utf8')) as GateList;
    expect(gate.rec_hash_v).toBe(2);
    const before = fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8');
    for (const hash of [recHash({ ...gate, run: `${gate.run}-other` }), legacyRecHash(gate)]) {
      const refused = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', hash, '--by', 'human']);
      expect(refused.status, hash).toBe(3);
      expect(refused.stderr).toMatch(/is not this gate's: .* for another run; current rec_hash=[0-9a-f]{12} \(run \S+\)\).*\(GATE_REC_STALE\)$/m);
    }
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before);
    delete gate.rec_hash_v;
    fs.writeFileSync(gateFile, JSON.stringify(gate, null, 2) + '\n');
    const legacy = legacyRecHash(gate);
    expect(legacy).not.toBe(recHash(gate));
    const ok = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'rec', '--rec-hash', legacy, '--by', 'human']);
    expect(ok.status, ok.stderr).toBe(0);
    const answered = decisions(out).filter(r => r.answered_at);
    expect(answered.length).toBe(gate.items.length);
    for (const r of answered) expect(r.rec_hash).toBe(legacy);
  });
});

describe('R2: later phases see their predecessors\' consensus', () => {
  test('the DX prompt carries the CEO consensus block', () => {
    const out = startSmallRun(path.join(TMP, 'dx-consensus'), ['--developer-tool']);
    expect(readRun(out).phase_order).toEqual(['ceo', 'dx', 'eng']);
    runPhase(out, 'ceo');
    expect(autoplan(['next', '--out', out]).status).toBe(0);
    const dx = fs.readFileSync(path.join(out, 'dx-native-prompt.md'), 'utf8');
    expect(dx).toContain('PRIOR-PHASE CONSENSUS');
    expect(dx).toContain('### CEO');
    expect(fs.readFileSync(path.join(out, 'dx-outside-prompt.md'), 'utf8')).toContain('### CEO');
  });
});

describe('R3: lib code spawns the Bun that runs it', () => {
  /** The admission probe measures the Bun a bare `bun` would run (that is its job); nothing else may. */
  const EXEMPT: Record<string, string> = { 'lib/autoplan-admission.ts': 'probes the PATH Bun for the install verdict by design' };
  test('no spawn of `bun` by PATH name under lib/ or bin/*.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (EXEMPT[path.relative(ROOT, p)]) continue;
        text.split('\n').forEach((line, i) => { if (/\bspawn(?:Sync)?\(\s*['"]bun['"]/.test(line)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`); });
      }
    };
    walk(path.join(ROOT, 'lib'));
    for (const e of fs.readdirSync(path.join(ROOT, 'bin'))) if (e.endsWith('.ts')) {
      const p = path.join(ROOT, 'bin', e);
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (/\bspawn(?:Sync)?\(\s*['"]bun['"]/.test(line)) offenders.push(`bin/${e}:${i + 1}`); });
    }
    expect(offenders).toEqual([]);
  });
});
