/**
 * Plan E16/E22 (lane F, autoplan gates):
 *  E16 every gate prints its cost: `GATE_SPEND:` from the run's ledger and
 *      `GATE_REC_COST:` for the phases a `rec` reopens (an upper bound priced on
 *      the effective choices, as `answer` reads them); the owner brief carries
 *      the same sentence. Host-subagent attempts are priced unknown, never zero.
 *  E22 the approvals mirror honours the directory a Captain named by creating
 *      `approvals/` in its drive, between GSTACK_APPROVALS_DIR and the private
 *      project-user folder; `gstack-approvals path` names the rule.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRow, captainApprovalsDir, locate, readRecord, type ApprovalRow } from '../lib/approval-record';
import { gateCost, priorChoices, recReopens, renderGateCost, gateCostSentence } from '../lib/autoplan-gate-cost';
import type { GateList } from '../lib/gate-list';
import { attemptsOf, autoplan, env, readRun, resultOf, review, ROOT, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-gate-cost-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const keep = { key: 'a', text: 'keep your direction', changes_plan: false };
const change = { key: 'b', text: 'accept the change', changes_plan: true };
const list = (recommended: 'a' | 'b'): GateList => ({
  schema_version: 1, run: 'r', gate_rev: 1, items: [
    { id: 'uc1', title: 'challenge', options: [keep, change], recommended, kind: 'approval', phase: 'ceo' },
    { id: 'd1', title: 'auto', options: [keep, change], recommended: 'a', kind: 'auto', phase: 'design' },
    { id: 'p1', title: 'Plan approval', options: [{ key: 'a', text: 'approve as-is' }], recommended: 'a', kind: 'approval' },
  ],
});
const row = (over: Partial<Parameters<typeof buildRow>[0]> = {}, branch = 'main'): ApprovalRow => {
  const r = buildRow({ ask: 'autoplan gates', words: 'assume Garry will take the recommendations', by: 'Garry (user-scope AGENTS.md)', scope: 'autoplan gates: take the recommendations', outcome: 'standing', date: '2026-10-20', source: 'AGENTS.md', ...over }, branch);
  if ('code' in r) throw new Error(r.message);
  return r;
};

describe('E16: the gate prints what it cost and what rec adds', () => {
  test('recReopens is the upper bound of the answer and revise rules: a plan change counts every phase revise can keep or add, a recommended round grant its phase plus Eng, nothing otherwise', () => {
    const pinned = { ui: false, dx: false };
    expect(recReopens(list('b'), { phase_order: ['ceo', 'design', 'eng'], scope_flags: pinned })).toEqual(['ceo', 'design', 'eng']);
    expect(recReopens(list('a'), { phase_order: ['ceo', 'design', 'eng'], scope_flags: pinned })).toEqual([]);
    // revise re-detects scope: a run that skipped Design and DX without pinning them off can gain both.
    expect(recReopens(list('b'), { phase_order: ['ceo', 'eng'] })).toEqual(['ceo', 'design', 'dx', 'eng']);
    expect(recReopens(list('b'), { phase_order: ['ceo', 'eng'], scope_flags: { ui: false } })).toEqual(['ceo', 'dx', 'eng']);
    // an answer already recorded at this gate wins over the recommendation, as rec itself keeps it
    expect(recReopens(list('a'), { phase_order: ['ceo', 'eng'], scope_flags: pinned }, { uc1: 'b' })).toEqual(['ceo', 'eng']);
    const carried = list('b'); carried.items[0]!.carried = { from: 'x', chosen: 'b', gate_rev: 1 };
    expect(recReopens(carried, { phase_order: ['ceo', 'eng'], scope_flags: pinned })).toEqual([]);
    // a carried choice overridden at this gate is a change again; an override of a non-changing recommendation counts as answerGate counts it
    const carriedA = list('a'); carriedA.items[0]!.carried = { from: 'x', chosen: 'a', gate_rev: 1 };
    expect(recReopens(carriedA, { phase_order: ['ceo', 'eng'], scope_flags: pinned }, { uc1: 'b' })).toEqual(['ceo', 'eng']);
    const plain = list('a'); plain.items[0]!.options = [{ key: 'a', text: 'keep' }, { key: 'b', text: 'other' }];
    expect(recReopens(plain, { phase_order: ['ceo', 'eng'], scope_flags: pinned }, { uc1: 'b' })).toEqual(['ceo', 'eng']);
    // the plan approval: a recorded rerun reopens every phase; a reject or stop reopens nothing
    const rerun = list('a'); rerun.items[2]!.options.push({ key: 'd', text: 'rerun every phase' }, { key: 'e', text: 'reject' });
    expect(recReopens(rerun, { phase_order: ['ceo', 'eng'], scope_flags: pinned }, { p1: 'd' })).toEqual(['ceo', 'eng']);
    expect(recReopens(list('b'), { phase_order: ['ceo', 'eng'], scope_flags: pinned }, { p1: 'e' })).toEqual([]);
    const agent = list('b'); agent.items[0]!.reopens = false;
    expect(recReopens(agent, { phase_order: ['ceo', 'eng'], scope_flags: pinned })).toEqual([]);
    const grant = list('a');
    grant.items.splice(1, 0, { id: 'c1', title: 'design at its round cap', options: [{ key: 'a', text: 'accept as deferred', changes_plan: false }, { key: 'b', text: 'one more round', changes_plan: false }], recommended: 'b', kind: 'approval', phase: 'design', cap: { phase: 'design', kind: 'deferred' } });
    expect(recReopens(grant, { phase_order: ['ceo', 'design', 'dx', 'eng'] })).toEqual(['design', 'eng']);
    grant.items[1]!.recommended = 'a';
    expect(recReopens(grant, { phase_order: ['ceo', 'design', 'dx', 'eng'] })).toEqual([]);
    expect(recReopens(grant, { phase_order: ['ceo', 'design', 'dx', 'eng'] }, { c1: 'b' })).toEqual(['design', 'eng']);
  });

  test('priorChoices reads the answers already recorded at this gate revision, as answerGate does; gateCost prices the partial answer, not the recommendation', () => {
    const out = path.join(TMP, 'prior'); fs.mkdirSync(out, { recursive: true });
    const rows = [
      { schema_version: 1, run: 'r', id: 'r-UC1', label: 'UC1', kind: 'approval', status: 'approved', gate_rev: 1, chosen: 'b' },
      { schema_version: 1, run: 'r', id: 'r-D1', label: 'D1', kind: 'auto', status: 'pending', gate_rev: 1, chosen: null },
      { schema_version: 1, run: 'r', id: 'r-OLD', label: 'UC1', kind: 'approval', status: 'approved', gate_rev: 0, chosen: 'a' },
    ];
    fs.writeFileSync(path.join(out, 'decisions.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(priorChoices(out, 1)).toEqual({ uc1: 'b' });
    expect(priorChoices(path.join(TMP, 'no-decisions'), 1)).toEqual({});
    const c = gateCost(out, list('a'), { phase_order: ['ceo', 'eng'], outside_enabled: false, spend_cap_usd: null, scope_flags: { ui: false, dx: false } }, { defaultPerVoiceUsd: 2 });
    expect(c).toMatchObject({ reopens: ['ceo', 'eng'], voices: 2, rec_more_usd: 4 });
  });

  test('the lines price the reopen at the per-voice reservation, two voices each with the outside voice on, and name unknown host attempts', () => {
    const out = path.join(TMP, 'cost'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'spend.json'), JSON.stringify({ schema_version: 1, cap_usd: 40, spent_usd: 1.5, reserved: [], released: [],
      settled: [{ attempt: 'a1', usd: 1.5, reserved_usd: 5, at: 't' }, { attempt: 'a2', usd: 'unknown', reserved_usd: 5, at: 't' }] }));
    const c = gateCost(out, list('b'), { phase_order: ['ceo', 'design', 'eng'], outside_enabled: true, spend_cap_usd: 40, scope_flags: { dx: false } });
    expect(c).toMatchObject({ attempts: 2, reopens: ['ceo', 'design', 'eng'], voices: 6, per_voice_usd: 5, rec_more_usd: 30 });
    const lines = renderGateCost(c);
    expect(lines[0]).toBe('GATE_SPEND: spent=1.50 worst_case=6.50 cap=40.00 headroom=33.50 attempts=2; 1 host-subagent attempt(s) priced unknown, counted at their reservation (read the actual figure in the host\'s cost view)');
    expect(lines[1]).toBe('GATE_REC_COST: rec reopens up to ceo,design,eng ≈ 6 voice(s) × 5.00 = +30.00 at most (the run\'s per-voice reservation) → headroom 3.50');
    expect(gateCostSentence(c)).toContain('Taking every recommendation reopens up to ceo, design, eng: at most +30.00 more.');
    const variant = (name: string, cap: string) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'spend.json'), fs.readFileSync(path.join(out, 'spend.json'), 'utf8').replace('"cap_usd":40', `"cap_usd":${cap}`)); return d; };
    const over = renderGateCost(gateCost(variant('cost-tight', '10'), list('b'), { phase_order: ['ceo', 'design', 'eng'], outside_enabled: true, spend_cap_usd: 10, scope_flags: { dx: false } }));
    expect(over[1]).toContain('(over the cap: raise it with gstack-autoplan budget before answering rec)');
    const uncapped = gateCost(variant('cost-uncapped', 'null'), list('a'), { phase_order: ['ceo', 'eng'], outside_enabled: false, spend_cap_usd: null });
    const none = renderGateCost(uncapped);
    expect(none[0]).toContain('cap=none headroom=none');
    expect(none[1]).toBe('GATE_REC_COST: rec reopens nothing (no recommended option changes the plan): +0.00');
    expect(gateCostSentence(uncapped)).toBe('Cost so far: spent 1.50, worst case 6.50 (no cap set, 1 host attempt(s) unknown and counted at reservation; 2 reviewer attempt(s)). Taking every recommendation reopens nothing: no further spend.');
    const empty = gateCost(path.join(TMP, 'no-ledger'), list('b'), { phase_order: ['ceo', 'eng'], outside_enabled: true, spend_cap_usd: null }, { defaultPerVoiceUsd: 5 });
    expect(empty).toMatchObject({ attempts: 0, per_voice_usd: 5, rec_more_usd: 40, reopens: ['ceo', 'design', 'dx', 'eng'] });
  });
});

describe('E22: the mirror honours the Captain-named approvals directory', () => {
  const home = path.join(TMP, 'home');
  const drive = path.join(home, '.capy', 'drive');
  fs.mkdirSync(path.join(drive, 'project-user-gstack-garry', 'autoplan-checkpoints'), { recursive: true });
  const base = { GSTACK_CAPY: '1', HOME: home, GSTACK_STATE_ROOT: path.join(TMP, 'state') } as NodeJS.ProcessEnv;
  const at = (e: NodeJS.ProcessEnv) => { const l = locate({ cwd: ROOT, env: e, branch: 'lane-x' }); if ('code' in l) throw new Error(l.message); return l; };

  test('no Captain drive: the private project-user folder; one Captain drive with approvals/: that directory; two: back to project-user; GSTACK_APPROVALS_DIR wins over both', () => {
    expect(captainApprovalsDir(base)).toBeUndefined();
    expect(at(base)).toMatchObject({ mirror_source: 'project-user drive' });
    expect(at(base).mirror).toBe(path.join(drive, 'project-user-gstack-garry', 'approvals', at(base).slug, path.basename(at(base).file)));
    fs.mkdirSync(path.join(drive, 'captain-minder'), { recursive: true });
    expect(captainApprovalsDir(base)).toBeUndefined();
    fs.mkdirSync(path.join(drive, 'captain-minder', 'approvals'));
    expect(captainApprovalsDir(base)).toBe(path.join(drive, 'captain-minder', 'approvals'));
    expect(at(base)).toMatchObject({ mirror_source: 'captain drive', mirror: path.join(drive, 'captain-minder', 'approvals', at(base).slug, path.basename(at(base).file)) });
    fs.mkdirSync(path.join(drive, 'captain-other', 'approvals'), { recursive: true });
    expect(captainApprovalsDir(base)).toBeUndefined();
    expect(at(base)).toMatchObject({ mirror_source: 'project-user drive' });
    fs.rmSync(path.join(drive, 'captain-other'), { recursive: true });
    const explicit = path.join(TMP, 'explicit');
    expect(at({ ...base, GSTACK_APPROVALS_DIR: explicit })).toMatchObject({ mirror_source: 'GSTACK_APPROVALS_DIR', mirror: path.join(explicit, at(base).slug, path.basename(at(base).file)) });
    expect(at({ ...base, GSTACK_APPROVALS_MIRROR: '0' }).mirror).toBeUndefined();
    expect(captainApprovalsDir({ ...base, GSTACK_CAPY: undefined })).toBeUndefined();
  });

  test('the other mirror roots are read: a row mirrored under project-user before the Captain created approvals/ stays visible, and path names both', () => {
    const h = fs.mkdtempSync(path.join(TMP, 'home-'));
    const d = path.join(h, '.capy', 'drive');
    fs.mkdirSync(path.join(d, 'project-user-gstack-garry', 'autoplan-checkpoints'), { recursive: true });
    const e = { ...base, HOME: h, GSTACK_STATE_ROOT: path.join(TMP, 'state-ra') } as NodeJS.ProcessEnv;
    const before = locate({ cwd: ROOT, env: e, branch: 'lane-x' }); if ('code' in before) throw new Error(before.message);
    expect(before.read_also).toEqual([]);
    fs.mkdirSync(path.dirname(before.mirror!), { recursive: true });
    fs.writeFileSync(before.mirror!, JSON.stringify(row({}, 'lane-x')) + '\n');
    fs.mkdirSync(path.join(d, 'captain-minder', 'approvals'), { recursive: true });
    const after = locate({ cwd: ROOT, env: e, branch: 'lane-x' }); if ('code' in after) throw new Error(after.message);
    expect(after.mirror_source).toBe('captain drive');
    expect(after.read_also).toEqual([before.mirror!]);
    expect(readRecord(after).rows.map(r => r.id)).toEqual([row({}, 'lane-x').id]);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-approvals'), 'path', '--branch', 'lane-x'], { cwd: ROOT, env: { ...process.env, ...e } as Record<string, string>, encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toContain(`MIRROR: ${after.mirror} (captain drive)`);
    expect(r.stdout).toContain(`READ_ALSO: ${before.mirror}`);
  });
});

describe('E16 end to end: every gate-producing command prints the cost, and the briefs carry it', () => {
  /** Both voices challenge the same item: the gate recommends the plan change (b) and `rec` would reopen phases. */
  function gateRun(name: string, extraFinding: Record<string, unknown> = {}, o: { challenge?: boolean; json?: boolean } = {}): string {
    const repo = path.join(TMP, name);
    fs.mkdirSync(repo, { recursive: true });
    expect(spawnSync('git', ['init', '-q', '-b', 'lane-z', repo], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    const out = startSmallRun(repo);
    const challenge = o.challenge === false ? [] : [{ id: 'F3', severity: 'High', title: 'Four lanes share result-codes.ts', file: 'lib/result-codes.ts', line: 1, user_challenge: true, changes: 'direction', fix: 'stack the lanes' }];
    const native = JSON.stringify([
      { id: 'F1', severity: 'High', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 12, fix: 'print PASS/FAIL per component', ...extraFinding }, ...challenge]);
    const outside = JSON.stringify([
      { id: 'O1', severity: 'Critical', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 14, fix: 'exit non-zero on any FAIL', ...extraFinding },
      ...challenge.map(c => ({ ...c, id: 'O3', fix: 'Stack the lanes.' }))]);
    let last = '';
    for (const phase of ['ceo', 'eng']) {
      const n = autoplan(['next', '--out', out]);
      expect(n.status).toBe(0);
      review(path.join(out, `${phase}-native-prompt.md`), { FIXTURE_FINDINGS: native });
      review(path.join(out, `${phase}-outside-prompt.md`), { FIXTURE_FINDINGS: outside });
      const ids = attemptsOf(out, phase);
      expect(autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'native', '--result', resultOf(out, phase, 'native'), '--model', 'anthropic/claude-opus-4-7', '--attempt', ids.native, '--runner', 'host-subagent']).status).toBe(0);
      last = autoplan(['submit', '--out', out, '--phase', phase, '--voice', 'outside', '--result', resultOf(out, phase, 'outside'), '--model', 'openai/gpt-6-astra', '--attempt', ids.outside, '--runner', 'host-subagent', ...(o.json && phase === 'eng' ? ['--json'] : [])]).stdout;
    }
    expect(readRun(out).status).toBe('gate_pending');
    if (o.json) {
      const payload = JSON.parse(last.trim().split('\n').pop()!);
      expect(payload.status).toBe('gate_pending');
      expect(payload.gate_cost).toMatchObject({ attempts: 4, unknown_count: 4, rec_voices: payload.gate_cost.rec_reopens.length * 2 });
      expect(typeof payload.gate_cost.spent_usd).toBe('number');
    } else {
      expect(last).toMatch(/^GATE_SPEND: spent=\d+\.\d\d worst_case=\d+\.\d\d cap=\S+ headroom=\S+ attempts=4; 4 host-subagent attempt/m);
      expect(last).toMatch(/^GATE_REC_COST: rec reopens /m);
    }
    return out;
  }


  test('the closing submit prints GATE_SPEND/GATE_REC_COST (text) or gate_cost (--json); the owner brief carries the Cost so far sentence and render --captain a ### Cost section above the relaying trailer', () => {
    const out = gateRun('plain', { severity: 'Medium' }, { challenge: false, json: true });
    const brief = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--out', out], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 30_000 });
    expect(brief.stdout).toMatch(/Cost so far: spent \d+\.\d\d, worst case \d+\.\d\d \(/);
    const captain = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--captain', '--out', out, '--allow-incomplete'], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 30_000 });
    expect(captain.stdout).toMatch(/### Cost\n\nCost so far: spent \d+\.\d\d, worst case \d+\.\d\d \(/);
    expect(captain.stdout).toContain('Taking every recommendation reopens nothing: no further spend.');
    // the relaying agent sends everything above the trailer, so the price must sit above it
    expect(captain.stdout.indexOf('### Cost')).toBeLessThan(captain.stdout.indexOf('_For the relaying agent, not the person:_'));
    expect(captain.stdout.indexOf('_For the relaying agent, not the person:_')).toBeGreaterThan(0);
    const changing = gateRun('changing');
    const rendered = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'gstack-owner-brief'), 'render', '--out', changing], { cwd: ROOT, env: env(), encoding: 'utf8', timeout: 30_000 });
    expect(rendered.stdout).toMatch(/Taking every recommendation reopens up to [a-z, ]+: at most \+\d+\.\d\d more\./);
  });

  test('run at a pending gate prints the gate lines once: text mode carries GATE_SPEND/GATE_REC_COST, --json exactly one payload with gate_cost', () => {
    const out = gateRun('run-gate', { severity: 'Medium' }, { challenge: false });
    const models = ['--native-model', 'anthropic/claude-opus-4-7', '--outside-model', 'openai/gpt-6-astra'];
    const text = autoplan(['run', '--out', out, ...models]);
    expect(text.status).toBe(0);
    expect(text.stdout.match(/^GATE_SPEND: /gm)?.length).toBe(1);
    expect(text.stdout.match(/^GATE_REC_COST: /gm)?.length).toBe(1);
    const json = autoplan(['run', '--out', out, ...models, '--json']);
    expect(json.status).toBe(0);
    const objects = json.stdout.trim().split('\n').filter(l => l.startsWith('{'));
    expect(objects.length).toBe(1);
    expect(JSON.parse(objects[0]!)).toMatchObject({ status: 'gate_pending', gate_cost: { rec_reopens: [] } });
    expect(readRun(out).status).toBe('gate_pending');
  });
});
