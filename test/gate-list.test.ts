/**
 * B9: one gate list, one reply grammar. Pins the grammar on the owner replies
 * quoted in the feedback (`d10 yes`, `1a 2a`, a 33-decision approve-all),
 * stable ids across pages, auto vs approval, gate_rev binding, and the bin's
 * exit codes. Prose in the rendering is not pinned.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyReply, decisionRows, parseReply, recHash, renderGate, validateGateList, type GateList } from '../lib/gate-list';
import { EXIT, validateFile } from '../lib/headless-artifacts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-gate');

const ab = [{ key: 'a', text: 'option A' }, { key: 'b', text: 'option B' }];
const abc = [...ab, { key: 'c', text: 'option C' }];
const list: GateList = {
  schema_version: 1, run: 'maw-20261010', gate_rev: 1, items: [
    { id: 'uc1', title: 'Scope of the committed wave', options: abc, recommended: 'a', kind: 'approval', phase: 'ceo' },
    { id: 'd1', title: 'Delivery shape', options: abc, recommended: 'a', kind: 'approval' },
    { id: 'd2', title: 'Unattended as a session kind', options: ab, recommended: 'a', kind: 'auto' },
    { id: 'd3', title: 'Installer in the repo', options: ab, recommended: 'a', kind: 'auto' },
  ],
};
const numbered: GateList = {
  schema_version: 1, run: 'r', gate_rev: 2, items: [
    { id: '1', title: 'first', options: ab, recommended: 'b', kind: 'approval' },
    { id: '2', title: 'second', options: ab, recommended: 'a', kind: 'approval' },
  ],
};
const big: GateList = {
  schema_version: 1, run: 'r', gate_rev: 1,
  items: Array.from({ length: 33 }, (_, i) => ({ id: `d${i + 1}`, title: `decision ${i + 1}`, options: ab, recommended: 'a', kind: (i % 3 === 0 ? 'approval' : 'auto') as 'auto' | 'approval' })),
};

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
function write(name: string, g: GateList): string { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(g)); return f; }
function run(args: string[]) {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const chosen = (p: ReturnType<typeof parseReply>) => Object.fromEntries(p.choices.map(c => [c.id, c.chosen]));

describe('reply grammar', () => {
  test('`all` takes every recommendation; approval items included', () => {
    const p = parseReply('all', list, 1);
    expect(p.valid).toBe(true);
    expect(chosen(p)).toEqual({ uc1: 'a', d1: 'a', d2: 'a', d3: 'a' });
    expect(p.pending).toEqual([]);
    expect(p.choices.every(c => c.how === 'recommended')).toBe(true);
  });

  test('`<id><option>` tokens answer named items; unanswered auto items take their default, approval items stay pending', () => {
    const p = parseReply('d1b uc1a', list, 1);
    expect(p.valid).toBe(true);
    expect(chosen(p)).toEqual({ uc1: 'a', d1: 'b', d2: 'a', d3: 'a' });
    expect(p.choices.find(c => c.id === 'd1')!.how).toBe('override');
    expect(p.choices.find(c => c.id === 'd2')!.how).toBe('auto_default');
    expect(p.pending).toEqual([]);
    const partial = parseReply('d3b', list, 1);
    expect(partial.valid).toBe(true);
    expect(partial.pending).toEqual(['uc1', 'd1']);
    expect(chosen(partial)).toEqual({ d2: 'a', d3: 'b' });
  });

  test('`all except <tokens>` is the same operation as listing the overrides', () => {
    const a = parseReply('all except d1b d3b', list, 1);
    const b = parseReply('d1b d3b uc1a d2a', list, 1);
    expect(a.valid && b.valid).toBe(true);
    expect(chosen(a)).toEqual(chosen(b));
    expect(chosen(a)).toEqual({ uc1: 'a', d1: 'b', d2: 'a', d3: 'b' });
    expect(a.pending).toEqual([]);
  });

  test('separators and case are tolerated; `<id> <option>` pairs merge', () => {
    expect(chosen(parseReply('D1:B, UC1=a; d3 b', list, 1))).toEqual({ uc1: 'a', d1: 'b', d2: 'a', d3: 'b' });
    expect(parseReply('ALL', list, 1).valid).toBe(true);
  });

  test('owner replies from the feedback: `1a 2a` parses, `d10 yes` and bare yes/no are unparsed, 33-item approve-all resolves every item', () => {
    const ok = parseReply('1a 2a', numbered, 2);
    expect(ok.valid).toBe(true);
    expect(chosen(ok)).toEqual({ '1': 'a', '2': 'a' });
    expect(ok.choices[0]!.how).toBe('override');

    const d10 = parseReply('d10 yes', big, 1);
    expect(d10.valid).toBe(false);
    expect(d10.error).toBe('GATE_REPLY_UNPARSED');
    expect(d10.unparsed).toEqual(['d10', 'yes']);
    expect(d10.choices).toEqual([]);
    for (const bare of ['yes', 'no', 'ok', 'approve']) expect(parseReply(bare, big, 1).error).toBe('GATE_REPLY_UNPARSED');

    const all = parseReply('all', big, 1);
    expect(all.choices).toHaveLength(33);
    expect(all.pending).toEqual([]);
  });

  test('unknown ids, unknown options, conflicting tokens and `all` with trailing noise are unparsed; nothing is applied', () => {
    expect(parseReply('d9a', list, 1)).toMatchObject({ valid: false, error: 'GATE_REPLY_UNPARSED', unparsed: ['d9a'], choices: [] });
    expect(parseReply('d2c', list, 1).unparsed).toEqual(['d2c']);
    expect(parseReply('d1a d1b', list, 1).unparsed).toEqual(['d1b (conflicts with d1a)']);
    expect(parseReply('all d1b', list, 1).unparsed).toEqual(['d1b']);
    expect(parseReply('   ', list, 1).error).toBe('GATE_EMPTY');
  });

  test('a reply binds to the gate revision it answers; a stale revision is refused before parsing', () => {
    expect(parseReply('all', numbered, 1)).toMatchObject({ valid: false, error: 'GATE_REV_STALE', gate_rev: 2, choices: [] });
    expect(parseReply('all', numbered, 2).valid).toBe(true);
    expect(parseReply('all', numbered).valid).toBe(true);
  });
});

describe('rendering', () => {
  test('ids and numbering are stable across pages; each page prints the reply shape and the `rec` resolution with its rec_hash', () => {
    const p1 = renderGate(big, 1);
    const p5 = renderGate(big, 5);
    expect(p1).toContain('page=1/5');
    expect(p5).toContain('page=5/5');
    expect(p1).toContain('1. [d1] decision 1 (approval; recommended: a)');
    expect(p1).toContain('7. [d7] decision 7 (approval; recommended: a)');
    expect(p1).not.toContain('[d8]');
    expect(p5).toContain('29. [d29] decision 29');
    expect(p5).toContain('33. [d33] decision 33');
    for (const page of [p1, p5]) {
      expect(page).toContain('`rec`');
      expect(page).toContain('`rec except <tokens>`');
      expect(page).toContain(`gate_rev=1 rec_hash=${recHash(big)}`);
      expect(page).toContain(JSON.stringify({ gate_rev: 1, rec_hash: recHash(big), choices: Object.fromEntries(big.items.map(i => [i.id, i.recommended])) }));
    }
    expect(renderGate(list)).toContain('   d1a) option A (recommended)');
    expect(renderGate(list)).not.toContain('page=1/2');
  });

  test('validateGateList rejects malformed lists', () => {
    expect(validateGateList(list)).toEqual([]);
    expect(validateGateList({ ...list, items: [{ ...list.items[0], id: 'D1' }] })[0]).toContain('id must match');
    expect(validateGateList({ ...list, items: [list.items[0], list.items[0]] })[0]).toContain('duplicated');
    expect(validateGateList({ ...list, items: [{ ...list.items[0], recommended: 'z' }] })[0]).toContain('recommended');
    expect(validateGateList({ ...list, gate_rev: 0 })[0]).toContain('gate_rev');
  });
});

describe('next wave B1/B-b: rec, aliases, quotes and the rec_hash', () => {
  const held: GateList = { ...list, items: [{ ...list.items[0]!, recommended: 'b', options: [{ key: 'a', text: 'keep', changes_plan: false }, { key: 'b', text: 'change', changes_plan: true }, { key: 'c', text: 'other' }] }, ...list.items.slice(1)] };
  test('every alias resolves like `rec`, plan changes included; `except` and earlier answers combine; quotes, backticks and newlines are separators', () => {
    const want = { uc1: 'b', d1: 'a', d2: 'a', d3: 'a' };
    for (const reply of ['rec', 'REC', 'all', 'approve all', 'accept all', 'take all recommendations', '`rec`', '"rec"', '\u201crec\u201d', 'rec\n']) {
      const p = parseReply(reply, held, 1);
      expect(p.valid, reply).toBe(true);
      expect(p.mode).toBe('rec');
      expect(chosen(p)).toEqual(want);
    }
    expect(chosen(parseReply('rec except uc1a d3b', held, 1))).toEqual({ uc1: 'a', d1: 'a', d2: 'a', d3: 'b' });
    expect(chosen(parseReply('rec', held, 1, { d1: 'c' }))).toEqual({ uc1: 'b', d1: 'c', d2: 'a', d3: 'a' });
    expect(parseReply('rec', held, 1, { d1: 'c' }).choices.find(c => c.id === 'd1')!.prior).toBe(true);
    expect(chosen(parseReply('as-is', held, 1))).toEqual({ uc1: 'a', d1: 'a', d2: 'a', d3: 'a' });
    expect(parseReply('d3b', held, 1).pending).toEqual(['uc1', 'd1']);
    for (const bad of ['approve', 'accept', 'take all', 'rec rec', 'rec as-is', 'yes']) expect(parseReply(bad, held, 1).valid, bad).toBe(false);
  });
  test('rec_hash changes with a recommendation, its basis or rec_rev, and the render shows who set it', () => {
    const h = recHash(held);
    expect(recHash({ ...held })).toBe(h);
    expect(recHash({ ...held, rec_rev: 1 })).not.toBe(h);
    const moved = { ...held, items: held.items.map(i => (i.id === 'd1' ? { ...i, recommended: 'b', recommended_basis: 'both reviewers name it', recommended_by: 'agent:relay' } : i)) };
    expect(recHash(moved)).not.toBe(h);
    expect(renderGate(moved)).toContain('[d1] Delivery shape (approval; recommended: b (both reviewers name it; set by agent:relay))');
  });
  test('rec_hash binds to its run and plan: two runs with the same decision shape never share one (GST-1819)', () => {
    const eli5 = { summary: 's', before_after: '', why: '', cause: '', decisions: '', plan_file_sha256: 'a'.repeat(64) };
    const first: GateList = { ...held, run: 'run-20261106101500', eli5 };
    const second: GateList = { ...held, run: 'run-20261107093000', eli5: { ...eli5, plan_file_sha256: 'b'.repeat(64) } };
    expect(recHash(first)).not.toBe(recHash(second));
    expect(recHash({ ...first, run: second.run })).not.toBe(recHash(first));
    expect(recHash({ ...first, eli5: second.eli5 })).not.toBe(recHash(first));
    expect(recHash({ ...first, eli5: undefined, items: first.items.map(i => (i.id === 'd2' ? { ...i, title: 'another decision' } : i)) })).not.toBe(recHash({ ...first, eli5: undefined }));
  });
});

describe('decisions.jsonl rows', () => {
  test('pending rows carry gate_rev, kind, recommended and the auto default; applying a reply sets chosen/status', () => {
    const rows = decisionRows(list);
    expect(rows.map(r => r.id)).toEqual(['maw-20261010-uc1', 'maw-20261010-d1', 'maw-20261010-d2', 'maw-20261010-d3']);
    expect(rows[0]).toMatchObject({ kind: 'approval', status: 'pending', default_if_unanswered: null, gate_rev: 1, recommended: 'a', label: 'UC1' });
    expect(rows[2]).toMatchObject({ kind: 'auto', default_if_unanswered: 'a' });
    const f = path.join(tmp, 'decisions.jsonl');
    fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(validateFile(f, 'decisions', 'maw-20261010')).toEqual([]);

    const applied = applyReply(rows, parseReply('d1b', list, 1), '2026-10-10T21:30:00Z');
    expect(applied.find(r => r.id.endsWith('-d1'))).toMatchObject({ status: 'overridden', chosen: 'b', reply: 'd1b' });
    expect(applied.find(r => r.id.endsWith('-d2'))).toMatchObject({ status: 'approved', chosen: 'a' });
    expect(applied.find(r => r.id.endsWith('-uc1'))).toMatchObject({ status: 'pending' });
    expect(applied.find(r => r.id.endsWith('-uc1'))!.chosen).toBeUndefined();
    const stale = applyReply(rows, parseReply('all', list, 2), '2026-10-10T21:30:00Z');
    expect(stale.every(r => r.status === 'pending')).toBe(true);
  });

  test('a later gate revision mints its own ids, so rows from every revision stay unique in one file', () => {
    const rev2: GateList = { ...list, gate_rev: 2 };
    const answered = applyReply(decisionRows(list), parseReply('all', list, 1), '2026-10-10T21:30:00Z');
    const later = decisionRows(rev2);
    expect(later.map(r => r.id)).toEqual(['maw-20261010-r2-uc1', 'maw-20261010-r2-d1', 'maw-20261010-r2-d2', 'maw-20261010-r2-d3']);
    expect(later[1]).toMatchObject({ label: 'D1', gate_rev: 2 });
    const all = [...answered, ...applyReply(later, parseReply('d1b', rev2, 2), '2026-10-11T09:00:00Z')];
    expect(new Set(all.map(r => r.id)).size).toBe(all.length);
    expect(all.find(r => r.id === 'maw-20261010-r2-d1')).toMatchObject({ status: 'overridden', chosen: 'b' });
    expect(all.find(r => r.id === 'maw-20261010-d1')).toMatchObject({ status: 'approved', chosen: 'a', reply: 'all' });
    const f = path.join(tmp, 'decisions-two-revs.jsonl');
    fs.writeFileSync(f, all.map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(validateFile(f, 'decisions', 'maw-20261010')).toEqual([]);
  });
});

describe('bin/gstack-gate', () => {
  test('render / parse / decisions with the exit table: 0 ok, 1 unparsed, 2 usage, 3 stale or missing rev', () => {
    const file = write('gate.json', list);
    expect(run(['render', file]).out).toContain('[uc1] Scope of the committed wave');
    expect(run(['render', write('big.json', big), '--page', '3']).out).toContain('page=3/5');

    const ok = run(['parse', file, '--reply', 'all except d1b', '--gate-rev', '1', '--json']);
    expect(ok.code).toBe(EXIT.ok);
    expect(JSON.parse(ok.out)).toMatchObject({ valid: true, pending: [], unparsed: [] });
    expect(ok.err).toBe('');

    const bad = run(['parse', file, '--reply', 'd10 yes', '--gate-rev', '1', '--json']);
    expect(bad.code).toBe(EXIT.fail);
    expect(JSON.parse(bad.out)).toMatchObject({ valid: false, unparsed: ['d10', 'yes'] });
    expect(bad.err).toMatch(/unparsed: d10, yes.*\(GATE_REPLY_UNPARSED\)/);

    const stale = run(['parse', file, '--reply', 'all', '--gate-rev', '0']);
    expect(stale.code).toBe(EXIT.refused);
    expect(stale.err).toMatch(/current gate_rev=1.*\(GATE_REV_STALE\)/);
    const noRev = run(['parse', file, '--reply', 'all']);
    expect(noRev.code).toBe(EXIT.refused);
    expect(run(['parse', file]).code).toBe(EXIT.usage);
    expect(run([]).code).toBe(EXIT.usage);
    expect(run(['--help']).out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');

    const rows = run(['decisions', file, '--reply', 'all', '--gate-rev', '1', '--answered-at', '2026-10-10T21:30:00Z']);
    expect(rows.code).toBe(EXIT.ok);
    const parsed = rows.out.trim().split('\n').map(l => JSON.parse(l));
    expect(parsed).toHaveLength(4);
    expect(parsed.every(r => r.status === 'approved' && r.answered_at === '2026-10-10T21:30:00Z')).toBe(true);
    const pending = run(['decisions', file]).out.trim().split('\n').map(l => JSON.parse(l));
    expect(pending.every(r => r.status === 'pending')).toBe(true);
  });
});

describe('the /autoplan Phase 4 gate as documented (#4181)', () => {
  // Value: protects=the gate /autoplan tells the agent to write renders, and the documented plan-approval replies parse, through bin/gstack-gate;
  //   fails_when=the template names a gate item id or reply token outside the gate grammar; why_new=the grammar cases build their own lists; seam=none
  test('the template\'s plan-approval item renders and each documented reply for it parses to its option', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
    const write_ = /Write `\$_AP\/gate\.json`.*?gstack-gate render/.exec(tmpl)?.[0] ?? '';
    const item = /and `([^`]+)` \(approval: (a\) .*? e\) \w+)\)/.exec(write_);
    expect(item).not.toBeNull();
    const id = item![1]!;
    const parts = item![2]!.split(/(?:^| )([a-e])\) /).slice(1);
    const options = parts.flatMap((key, i) => (i % 2 ? [] : [{ key, text: parts[i + 1]! }]));
    expect(options.map(o => o.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const gate: GateList = { schema_version: 1, run: 'autoplan-4181', gate_rev: 1, items: [
      { id: 'uc1', title: 'User challenge', options: ab, recommended: 'a', kind: 'approval' },
      { id: 'd1', title: 'Taste decision', options: ab, recommended: 'a', kind: 'auto' },
      { id, title: 'Plan approval', options, recommended: 'a', kind: 'approval' },
    ] };
    const file = write('gate.json', gate);
    const parseText = /Parse the reply:.*?SESSION_KIND/.exec(tmpl)?.[0] ?? '';
    const replies = [...parseText.matchAll(/`([a-z0-9]+)`/g)].map(m => m[1]!).filter(t => t.startsWith(id) && t.length === id.length + 1);
    expect(replies.map(t => t.slice(-1))).toEqual(['a', 'c', 'd', 'e']);

    const calls = [['render', file], ...replies.map(reply => ['parse', file, '--reply', reply, '--gate-rev', '1', '--json'])];
    const results = calls.map(args => { const r = run(args); return { args: args.filter(a => a !== file).join(' '), code: r.code, err: r.err, out: r.out }; });
    expect(results.map(({ args, code, err }) => ({ args, code, err }))).toEqual(results.map(({ args }) => ({ args, code: EXIT.ok, err: '' })));
    expect(results.slice(1).map(r => chosen(JSON.parse(r.out))[id])).toEqual(['a', 'c', 'd', 'e']);
  });
});

describe('the /autoplan Phase 4 reply table agrees with gstack-gate (GST-2139)', () => {
  // Value: protects=the reply-to-option table /autoplan acts on matches what bin/gstack-gate parse resolves for `all`, `rec` and `p1a`;
  //   fails_when=`all`/`rec` send the run to approve-as-written while the gate took every recommended plan change, `p1a` approves while a uc item is pending, or an override of an unflagged option approves (answerGate counts it as a plan change); why_new=the #4181 case proves the replies parse, not what the skill does with them; seam=none
  const tmpl = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf8').replace(/\s+/g, ' ');
  const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1]!);
  const topLevel = (text: string): string[] => {
    const out: string[] = []; let depth = 0; let code = false; let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '`') code = !code;
      else if (!code && ch === '(') depth++;
      else if (!code && ch === ')') depth--;
      else if (!code && depth === 0 && (ch === ';' || ch === '.') && text[i + 1] === ' ') { out.push(text.slice(start, i).trim()); start = i + 2; }
    }
    return [...out, text.slice(start).trim()].filter(Boolean);
  };
  const table = topLevel(/Parse the reply:.*?never guessed\. (.*?) Under `SESSION_KIND/.exec(tmpl)?.[1] ?? '');
  const handling = Object.fromEntries([...tmpl.matchAll(/- ([A-E]2?): (.*?)(?= - [A-E]2?: |\*\*Starting)/g)].map(m => [m[1]!, m[2]!]));
  const write_ = /Write `\$_AP\/gate\.json`.*?gstack-gate render/.exec(tmpl)?.[0] ?? '';
  const p1 = /and `p1` \(approval: (a\) .*? e\) \w+)\)/.exec(write_)?.[1] ?? '';
  const parts = p1.split(/(?:^| )([a-e])\) /).slice(1);
  const p1Options = parts.flatMap((key, i) => (i % 2 ? [] : [{ key, text: parts[i + 1]!.replace(/ \(recommended\)$/, '') }]));
  const p1Recommended = parts.flatMap((key, i) => (i % 2 === 0 && / \(recommended\)$/.test(parts[i + 1]!) ? [key] : []))[0]
    ?? /recommending `([a-e])`/.exec(tmpl.slice(tmpl.indexOf(p1)))?.[1];
  const keep = { key: 'a', text: 'keep your direction', changes_plan: false };
  const change = { key: 'b', text: 'take the reviewers\' change', changes_plan: true };
  const gate = (): GateList => ({ schema_version: 1, run: 'autoplan-2139', gate_rev: 1, items: [
    { id: 'uc1', title: 'User challenge both voices raised', options: [keep, change], recommended: 'b', kind: 'approval' },
    { id: 'd1', title: 'Taste decision', options: [keep, change], recommended: 'b', kind: 'auto' },
    { id: 'p1', title: 'Plan approval', options: p1Options, recommended: p1Recommended ?? 'a', kind: 'approval' },
  ] });

  /** The skill's options for a reply: the first table row whose condition the gate's parse meets. */
  function documented(reply: string, g: GateList, parsed: ReturnType<typeof parseReply>) {
    const said = reply.toLowerCase().split(/\s+/);
    const optionOf = (c: { id: string; chosen: string }) => g.items.find(i => i.id === c.id)!.options.find(o => o.key === c.chosen)!;
    for (const row of table) {
      const changed = parsed.choices.filter(c => c.id !== 'p1' && (optionOf(c).changes_plan ?? (/unflagged override/.test(row) && c.how === 'override')));
      const at = row.indexOf(' = ');
      if (at < 0) continue;
      const lhs = row.slice(0, at), rhs = row.slice(at + 3), names = ticks(lhs);
      const hit = /\belse\b/.test(lhs) ? true
        : names.includes('pending') ? parsed.pending.length > 0
        : names.includes('changes_plan') ? changed.length > 0
        : names.some(t => said.includes(t) || (/^[a-z]+<n>$/.test(t) && parsed.choices.some(c => c.how === 'override' && said.includes(c.id + c.chosen) && c.id.startsWith(t.slice(0, -3)))));
      if (!hit) continue;
      const perKind = [...rhs.matchAll(/([A-E]2?) on an? `([a-z]+)<n>`/g)];
      const letters = perKind.length ? perKind.filter(m => changed.some(c => c.id.startsWith(m[2]!) && c.id !== 'p1')).map(m => m[1]!)
        : /^[A-E](\/[A-E])+$/.test(rhs.trim()) ? [rhs.trim().split('/')[names.findIndex(t => said.includes(t))]!]
        : [...rhs.replace(/`[^`]*`/g, '').replace(/\([^)]*\)/g, '').matchAll(/(?:^|[\s,])([A-E]2?)(?=$|[\s,.])/g)].map(m => m[1]!);
      return { row, letters: [...new Set(letters)].sort() };
    }
    return { row: '(no row)', letters: [] as string[] };
  }
  const approves = (letters: string[]) => letters.filter(l => /mark APPROVED/.test(handling[l] ?? ''));

  test('`all` and `rec` apply every recommended plan change, never the plan as first written', () => {
    expect(Object.keys(handling)).toEqual(['A', 'B', 'B2', 'C', 'D', 'E']);
    expect(p1Options.map(o => o.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(write_).toContain('Every `uc<n>`/`d<n>` option sets `changes_plan`');
    const g = gate();
    const file = write('gate.json', g);
    const seen = ['all', 'rec'].map(reply => {
      const r = run(['parse', file, '--reply', reply, '--gate-rev', '1', '--json']);
      const parsed = JSON.parse(r.out) as ReturnType<typeof parseReply>;
      const doc = documented(reply, g, parsed);
      return { reply, code: r.code, gate: chosen(parsed), p1: p1Options.find(o => o.key === chosen(parsed).p1)?.text, letters: doc.letters, approves: approves(doc.letters), row: doc.row };
    });
    expect(seen.map(({ row: _row, p1, ...rest }) => ({ ...rest, p1_as_written: /as-is|as written/.test(p1 ?? '') })))
      .toEqual(['all', 'rec'].map(reply => ({ reply, code: EXIT.ok, gate: { uc1: 'b', d1: 'b', p1: 'b' }, letters: ['B', 'B2'], approves: [], p1_as_written: false })));
  });

  test('`p1a` with a user challenge unanswered approves nothing', () => {
    const g = gate();
    const file = write('gate.json', g);
    const r = run(['parse', file, '--reply', 'p1a', '--gate-rev', '1', '--json']);
    const parsed = JSON.parse(r.out) as ReturnType<typeof parseReply>;
    const doc = documented('p1a', g, parsed);
    expect({ code: r.code, pending: parsed.pending, p1: chosen(parsed).p1, approves: approves(doc.letters), row_names_pending: ticks(doc.row.split(' = ')[0]!).includes('pending') })
      .toEqual({ code: EXIT.ok, pending: ['uc1'], p1: 'a', approves: [], row_names_pending: true });
  });

  test('an override of an unflagged option changes the plan, as answerGate counts it', () => {
    const unflagged = [{ key: 'a', text: 'keep your direction' }, { key: 'b', text: 'the alternative' }];
    const g: GateList = { schema_version: 1, run: 'autoplan-2139', gate_rev: 1, items: [
      { id: 'd1', title: 'Taste decision', options: unflagged, recommended: 'a', kind: 'auto' },
      { id: 'p1', title: 'Plan approval', options: p1Options, recommended: 'a', kind: 'approval' },
    ] };
    const r = run(['parse', write('gate.json', g), '--reply', 'p1a d1b', '--gate-rev', '1', '--json']);
    const parsed = JSON.parse(r.out) as ReturnType<typeof parseReply>;
    const doc = documented('p1a d1b', g, parsed);
    expect({ code: r.code, d1: parsed.choices.find(c => c.id === 'd1'), letters: doc.letters, approves: approves(doc.letters) })
      .toEqual({ code: EXIT.ok, d1: { id: 'd1', chosen: 'b', kind: 'auto', how: 'override' }, letters: ['B'], approves: [] });
  });
});
