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
import { applyReply, decisionRows, parseReply, renderGate, resolveAll, validateGateList, type GateList } from '../lib/gate-list';
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
  test('ids and numbering are stable across pages; each page prints the reply shape and the `all` resolution', () => {
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
      expect(page).toContain('`all`');
      expect(page).toContain('`all except <tokens>`');
      expect(page).toContain(`gate_rev=1`);
      expect(page).toContain(JSON.stringify({ gate_rev: 1, choices: resolveAll(big) }));
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
