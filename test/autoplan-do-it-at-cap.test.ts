/**
 * GST-3753: the owner's "do it" is carried through the round cap. Replays the shape of run autoplan-embftp-20261124162738
 * (gstack v1.103.1.0) on the simulated Capy host: gate 1 answered "do it", a revise and re-review, gate 2 answered "do it",
 * then a revise at the round cap that only takes those recommendations. Before the fix that revise raised gate 3 with one
 * "accept the unreviewed delta" approval per capped phase, which a relaying agent could not settle (OWNER_REPLY_REQUIRED),
 * and a cut whose command was renamed counted as a new item. Now the run finishes with an UNREVIEWED note a ruling closes;
 * a change the owner did not approve still raises one item for all capped phases; a phase that does review the revision
 * still raises its finding; and a cut keeps its id when reworded.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OWNER_RECS_AT_CAP, ownerTookRecs } from '../lib/autoplan-budget';
import type { RunState } from '../lib/autoplan-state';
import { cutIds } from '../lib/autoplan-owner-text';
import { recReopens } from '../lib/autoplan-gate-cost';
import { recHash } from '../lib/gate-list';
import { SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';

setDefaultTimeout(60_000);
const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
const NONE = { native: [], outside: [] };
const DO_IT = 'Garry: Do it';
const both = (id: string, title: string, fix: string) => ({
  native: [{ id: `N${id}`, severity: 'High', title, user_challenge: true, changes: 'scope', fix }],
  outside: [{ id: `O${id}`, severity: 'High', title, user_challenge: true, changes: 'scope', fix }],
});
const FLAG = both('1', 'Ship the backoff behind a flag first', 'gate the change behind RETRY_BACKOFF=1');
const DEAD = both('2', 'Dead-letter jobs after the last retry', 'move a job to the dead-letter table after 8 attempts');
const V2 = SMALL_PLAN.replace('cap 30 s', 'cap 30 s, behind RETRY_BACKOFF=1');
const V3 = V2.replace('jitter 10%.', 'jitter 10%; a job moves to the dead-letter table after 8 attempts.');
const gateOf = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
const pending = (out: string) => readRunJson(out).amendments.filter((a: any) => a.status === 'pending').map((a: any) => a.decision).join(',');
const file = (dir: string, text: string) => { const f = path.join(dir, `plan-${++n}.md`); fs.writeFileSync(f, text); return f; };

function answer(out: string, rev: number, reply: string, words: string, extra: string[] = []) {
  return r.ap(['answer', '--out', out, '--gate-rev', String(rev), '--reply', reply, '--rec-hash', recHash(gateOf(out)), '--by', 'agent:gstack-minder', '--owner-reply', words, ...extra]);
}

/** Gate 1 "do it", revise, round 2 with a new challenge, gate 2 answered with `gate2` in the owner's words: the revise at the cap comes next. */
function toTheCap(o: { first?: string[]; round2?: { native?: unknown[]; outside?: unknown[] }; gate2?: string; words2?: string } = {}) {
  const dir = path.join(r.host.base, `cap${++n}`);
  const out = path.join(dir, 'run');
  expect(r.ap(['next', '--out', out, '--plan', writePlan(dir), ...(o.first ?? ['--no-ui'])]).status).toBe(0);
  phaseVia(r, out, 'ceo', FLAG);
  expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toMatch(/^GATE: gate_rev=1 /m);
  const a1 = answer(out, 1, 'rec', DO_IT);
  expect(a1.status, a1.stderr).toBe(0);
  const v2 = r.ap(['revise', '--out', out, '--plan', file(dir, V2), '--incorporates', pending(out)]);
  expect(v2.stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng$/m);
  phaseVia(r, out, 'ceo', o.round2 ?? DEAD);
  expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toMatch(/^GATE: gate_rev=2 /m);
  const a2 = answer(out, 2, o.gate2 ?? 'rec', o.words2 ?? DO_IT);
  expect(a2.status, a2.stderr).toBe(0);
  expect(a2.stdout).toMatch(/^APPLY: /m);
  return { dir, out };
}

describe('two "do it" answers, then the round cap', () => {
  test("ownerTookRecs counts only recommendations the owner answered in his own words, not ones taken under \"do it\" unseen", () => {
    const out = path.join(r.host.base, `took${++n}`);
    fs.mkdirSync(out, { recursive: true });
    const row = (id: string, extra: Record<string, unknown>) => JSON.stringify({ id, status: 'approved', chosen: 'a', recommended: 'a', owner_reply: DO_IT, ...extra });
    fs.writeFileSync(path.join(out, 'decisions.jsonl'), [row('seen', {}), row('unseen', { carried_under: 'do it' }), row('own', { owner_reply: undefined, answer_words: 'ok', words_by: 'agent:x' }), row('over', { chosen: 'b', status: 'overridden' })].join('\n') + '\n');
    const state = { out } as RunState;
    expect(ownerTookRecs(state, ['seen'])).toBe(DO_IT);
    for (const id of ['unseen', 'own', 'over']) expect(ownerTookRecs(state, ['seen', id])).toBeUndefined();
  });

  test('the revise that only takes the approved recommendations finishes the run: no third gate, one UNREVIEWED note', () => {
    const s = toTheCap();
    const rev = r.ap(['revise', '--out', s.out, '--plan', file(s.dir, V3), '--incorporates', pending(s.out)]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: plan=\S+ reopened=none capped=ceo,eng$/m);
    expect(rev.stdout).not.toMatch(/^GATE: gate_rev=3/m);
    expect(rev.stdout).toMatch(/^APPROVED: gate_rev=2 /m);
    const note = rev.stdout.split('\n').filter(l => l.startsWith('UNREVIEWED:'));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain(`changed the plan after ceo,eng used their last round, so no reviewer read it; accepted without a gate: ${OWNER_RECS_AT_CAP}`);
    expect(note[0]).toContain(`answered in the owner's words ${JSON.stringify(DO_IT)}`);
    expect(note[0]).toMatch(/open note: gstack-autoplan rule --out \S+ --revision 2 /);
    const run = readRunJson(s.out);
    expect(run.status).toBe('complete');
    expect(run.gate_rev).toBe(2);
    expect(run.capped_deltas.map((d: any) => [d.phase, d.status, d.basis])).toEqual([['ceo', 'accepted', OWNER_RECS_AT_CAP], ['eng', 'accepted', OWNER_RECS_AT_CAP]]);
    expect(readJsonl(path.join(s.out, 'attempts.jsonl')).filter((j: any) => j.event === 'unreviewed_at_cap')).toMatchObject([{ k: 2, phases: ['ceo', 'eng'], reason: OWNER_RECS_AT_CAP }]);
    expect(r.validate(s.out).status).toBe(0);
    expect(fs.readFileSync(path.join(s.out, 'review-record.md'), 'utf8')).toContain(`accepted without a gate (${OWNER_RECS_AT_CAP}`);
  });

  test("a ruling closes the note, as a ruled note closes a /ship finding after round two; gstack can't rule on its own", () => {
    const s = toTheCap();
    expect(r.ap(['revise', '--out', s.out, '--plan', file(s.dir, V3), '--incorporates', pending(s.out)]).status).toBe(0);
    for (const bad of [['--revision', '1', '--by', 'GStack Minder (GSTA-36)', '--reason', 'x'], ['--revision', '2', '--by', 'gstack', '--reason', 'x'], ['--revision', '2', '--by', 'GStack Minder (GSTA-36)'],
      ['--revision', '2', '--by', 'GStack Minder (GSTA-36)', '--reason', 'x', '--owner-ref', 'not a ref']]) {
      const res = r.ap(['rule', '--out', s.out, ...bad]);
      expect(res.status, res.stdout).toBe(3);
    }
    expect(r.ap(['status', '--out', s.out]).stdout).toMatch(/^CAPPED_DELTA: v2 \S+ .* accepted unreviewed open: needs gstack-autoplan rule$/m);
    const ok = r.ap(['rule', '--out', s.out, '--revision', '2', '--by', 'GStack Minder (GSTA-36)', '--owner-ref', 'GSTA-36:2026-11-24T16:00:00Z', '--reason', "the owner's standing do it covers the applied changes"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^UNREVIEWED: revise v2 .*; closed by GStack Minder \(GSTA-36\) \(relayed from GSTA-36:2026-11-24T16:00:00Z\): the owner's standing do it covers the applied changes$/m);
    expect(readRunJson(s.out).capped_deltas.every((d: any) => d.ruling?.by === 'GStack Minder (GSTA-36)')).toBe(true);
    expect(fs.readFileSync(path.join(s.out, 'review-record.md'), 'utf8')).toContain('closed by GStack Minder (GSTA-36)');
    expect(r.ap(['status', '--out', s.out]).stdout).toMatch(/^CAPPED_DELTA: v2 \S+ .* accepted unreviewed ruled by GStack Minder \(GSTA-36\)$/m);
    expect(r.validate(s.out).status).toBe(0);
  });

  test('a settled change the owner did not take in his own words keeps the cap item, even beside an approved one', () => {
    const PACK = { native: [...DEAD.native, { id: 'N5', severity: 'Medium', title: 'Split the backoff into its own PR', user_challenge: true, changes: 'packaging', fix: 'land the schedule change as its own PR' }], outside: [...DEAD.outside, { id: 'O5', severity: 'Medium', title: 'Split the backoff into its own PR', user_challenge: true, changes: 'packaging', fix: 'Land the schedule change as its own PR.' }] };
    const s = toTheCap({ round2: PACK });
    const open = readRunJson(s.out).amendments.filter((a: any) => a.status === 'pending');
    const settle = open.find((a: any) => a.changes === 'packaging').decision, inc = open.find((a: any) => a.changes === 'scope').decision;
    const rows = readJsonl(path.join(s.out, 'decisions.jsonl'));
    fs.writeFileSync(path.join(s.out, 'decisions.jsonl'), rows.map((d: any) => JSON.stringify(d.id === settle ? { ...d, carried_under: 'do it' } : d)).join('\n') + '\n');
    const rev = r.ap(['revise', '--out', s.out, '--plan', file(s.dir, V3), '--incorporates', inc, '--settle', settle]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^GATE: gate_rev=3 /m);
    expect(rev.stdout).not.toMatch(/^(APPROVED|UNREVIEWED):/m);
    expect(readRunJson(s.out).capped_deltas.every((d: any) => d.status === 'pending' && !d.basis)).toBe(true);
  });

  test('a change the owner did not approve still raises a gate, with one item for every capped phase', () => {
    const s = toTheCap({ round2: { native: [{ id: 'N2', severity: 'High', title: 'Dead-letter jobs after the last retry', user_challenge: true, changes: 'scope', fix: 'dead-letter after 8 attempts' }], outside: [] }, gate2: 'd1b p1b', words2: 'd1b p1b' });
    const rev = r.ap(['revise', '--out', s.out, '--plan', file(s.dir, V3), '--incorporates', pending(s.out)]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).not.toMatch(/^UNREVIEWED:/m);
    expect(rev.stdout).toMatch(/^GATE: gate_rev=3 /m);
    const deltas = gateOf(s.out).items.filter((i: any) => i.cap?.kind === 'delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].title).toStartWith('plan changed after the ceo and eng cap: unreviewed delta');
    const own = answer(s.out, 3, 'rec', 'Accepted on the standing approval', ['--words-by', 'agent:gstack-minder']);
    expect(own.status).toBe(3);
    expect(own.stderr).toContain(`(${deltas[0].id} is a round-cap approval only the owner can settle, and this reply`);
    expect(own.stderr).toContain('(OWNER_REPLY_REQUIRED)');
    const reopen = r.ap(['answer', '--out', s.out, '--gate-rev', '3', '--reply', `${deltas[0].id}b p1a`, '--by', 'human']);
    expect(reopen.status, reopen.stderr).toBe(0);
    expect(reopen.stdout).toMatch(/^ROUND_GRANTED: ceo cap=3 /m);
    expect(reopen.stdout).toMatch(/^ROUND_GRANTED: eng cap=3 \(reruns after ceo; /m);
    expect(readRunJson(s.out).capped_deltas.filter((d: any) => d.k === 2).map((d: any) => d.status)).toEqual(['reopened', 'reopened']);
  });

  test('a phase that does review the revision still raises its new finding at a gate', () => {
    const s = toTheCap({ first: [] });
    const rev = r.ap(['revise', '--out', s.out, '--plan', file(s.dir, `<!-- gstack-autoplan-scope: --ui -->\n${V3}`), '--incorporates', pending(s.out)]);
    expect(rev.status, rev.stderr).toBe(0);
    expect(rev.stdout).toMatch(/^REVISED: plan=\S+ reopened=none added=design capped=ceo,eng$/m);
    const design = phaseVia(r, s.out, 'design', { native: [{ id: 'D1', severity: 'High', title: 'The retry status has no screen' }], outside: [] });
    expect(design.outside.stdout).toMatch(/^GATE: gate_rev=3 /m);
    const items = gateOf(s.out).items;
    expect(items.filter((i: any) => i.item_class === 'finding').map((i: any) => i.title)).toEqual([expect.stringContaining('The retry status has no screen')]);
    expect(items.some((i: any) => i.cap?.kind === 'delta')).toBe(false);
  });
});

describe('carried items match by stable id', () => {
  const plan = (button: string, extra = '') => [`# Plantpal watering coach (synthetic)`, '', '## Implementation plan', '', "### Owner's words", '',
    '- Ada Example, day 0: "I keep forgetting which plant needs water" → does it', '', '### Day one', '',
    '| action | frequency | source | feature | route | first build | check |', '|---|---|---|---|---|---|---|',
    '| sees which plant needs water today | daily | owner words 1 | Today list | root screen | build 1 | the plant due today is at the top |', '',
    "### What it won't do yet", '', `- No \`${button}\` command for shared households`, '- No Android build', '',
    `### Units`, '', `U1 the Today list${extra}. U2 the watering reminder.`, '', '## Review record', ''].join('\n');

  test('cutIds: a renamed command keeps its id, a new cut takes the next one, a dropped id is never reused', () => {
    const first = cutIds(['No `share` command for shared households', 'No Android build']);
    expect(first.map(c => c.id)).toEqual(['c1', 'c2']);
    const next = cutIds(['No `invite` command for shared households', 'No plant disease diagnosis'], first);
    expect(next.map(c => c.id)).toEqual(['c1', 'c3']);
    expect(cutIds(['No gstack-push command yet'], cutIds(['No gstack-sync command yet']))[0]!.id).toBe('c1');
  });

  test('cutIds: a cut whose scope changed takes a new id; an id dropped two gates back is not handed out again', () => {
    const first = cutIds(['No `share` command for shared households']);
    expect(cutIds(['No `share` command for anyone'], first)[0]!.id).toBe('c2');
    const g1 = cutIds(['No sync command', 'No export to CSV']);
    const g2 = cutIds(['No sync command'], g1, g1);
    expect(cutIds(['No sync command', 'No billing page at all'], g2, [...g1, ...g2]).map(c => c.id)).toEqual(['c1', 'c3']);
  });

  test('cutIds: a changed hyphenated word, number or version is a new cut, not a renamed command', () => {
    for (const [a, b] of [['No CSV-export for guests', 'No account-deletion for guests'], ['No 3-day trial', 'No 30-day trial'], ['No self-serve signup in v1.0', 'No self-serve signup in 2.0']]) {
      expect(cutIds([b], cutIds([a]))[0]!.id).toBe('c2');
    }
    expect(cutIds(['Skip the --dry-run flag'], cutIds(['Skip the --preview flag']))[0]!.id).toBe('c1');
  });

  test('the cost line for granting rounds counts every phase the one cap item reopens', () => {
    const opt = (key: string) => ({ key, text: key, changes_plan: key === 'b' });
    const list = { schema_version: 1, run: 'r', gate_rev: 3, items: [{ id: 'uc1', title: 'cap', options: [opt('a'), opt('b')], recommended: 'b', kind: 'approval', cap: { phase: 'ceo', kind: 'delta', ref: '2', phases: ['ceo', 'design'] } }] } as any;
    expect(recReopens(list, { phase_order: ['ceo', 'design', 'eng'] })).toEqual(['ceo', 'design', 'eng']);
  });

  test('a cut whose command was renamed is carried with its answer, so the carry is not refused as a new item', () => {
    const dir = path.join(r.host.base, `cuts${++n}`);
    const out = path.join(dir, 'run');
    expect(r.ap(['next', '--out', out, '--plan', writePlan(dir, plan('share')), '--no-ui', '--no-dx']).status).toBe(0);
    phaseVia(r, out, 'ceo', FLAG);
    expect(phaseVia(r, out, 'eng', NONE).outside.stdout).toMatch(/^GATE: gate_rev=1 /m);
    const cut1 = gateOf(out).items.find((i: any) => i.item_class === 'cut' && i.title.includes('share'));
    expect(cut1).toBeDefined();
    expect(answer(out, 1, 'rec', DO_IT).status).toBe(0);
    const rev = r.ap(['revise', '--out', out, '--plan', file(dir, plan('invite', ', behind RETRY_BACKOFF=1')), '--incorporates', pending(out)]);
    expect(rev.stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng$/m);
    phaseVia(r, out, 'ceo', NONE);
    const eng = phaseVia(r, out, 'eng', NONE).outside;
    const gate = gateOf(out);
    const cut2 = gate.items.find((i: any) => i.item_class === 'cut' && i.title.includes('invite'));
    expect(cut2.origin).toBe(cut1.origin);
    expect(cut2.carried).toMatchObject({ chosen: 'a', gate_rev: 1 });
    expect(gate.cut_ids.find((c: any) => c.text.includes('invite')).id).toBe('c1');
    expect(eng.stdout).not.toMatch(/^CARRY: no \(new item/m);
    expect(eng.stdout).toMatch(/^CARRIED: gate_rev=2 <- gate_rev=1 /m);
  });
});
