/**
 * GSTA-167: per-call thresholds measure context above the host's per-call
 * floor (a fresh Capy thread's first call costs 150-230k before any work,
 * GSTA-2 on gstack 1.91.320.0), and a child never stops on the context rule.
 * Before its first completed step, or at the maximum chain depth, it continues
 * with a CONTEXT_HIGH note; after one it hands its remaining steps to a
 * grandchild through the same handoff, verify, return and reconcile commands.
 * The token admission cap still stops a child. Replays gstack-evals #36, where
 * two handoff children stopped at the Step 7/12 boundary before doing any work.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCalibration, MAX_CHAIN_DEPTH, stepProjection, unitConstants } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const FLOOR = cal.units['capy-tokens']!.call_floor!;
const K = unitConstants(cal, 'capy-tokens');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'claude-usage-2.1.292.json'), 'utf8'));
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

function start(h: Harness, args: string[]) {
  const r = h.sb(['start', '--record', h.record(), ...args]);
  expect(r.code, r.out + r.err).toBe(0);
  return { r, run: h.field(r.out, 'BUDGET_RUN', 'id'), ledger: h.field(r.out, 'BUDGET_RUN', 'ledger') };
}

const readingArgs = (reading: number | null) => (reading === null ? [] : ['--reading', String(reading)]);

/** Hand Steps from-to off from a run and verify the brief as the next run in the chain. */
function handOff(h: Harness, run: string, from: string, to: string, reading: number | null, verifyArgs: string[] = readingArgs(reading)) {
  const ho = h.sb(['handoff', '--run', run, '--from', from, '--to', to, '--base', 'origin/main', ...readingArgs(reading)]);
  expect(ho.code, ho.out + ho.err).toBe(0);
  const m = ho.out.match(/^HANDOFF: (\S+) sha256=\S+ sub_cap=(\d+)$/m)!;
  const v = h.sb(['verify-handoff', '--in', m[1]!, ...verifyArgs]);
  expect(v.code, v.out + v.err).toBe(0);
  return { ho, v, brief: m[1]!, subCap: Number(m[2]), returnFile: ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!, run: h.field(v.out, 'BUDGET_RUN', 'id'), ledger: h.field(v.out, 'BUDGET_RUN', 'ledger') };
}

function check(h: Harness, run: string, step: string, next: string, extra: string[] = []) {
  return h.sb(['check', '--run', run, '--step', step, '--next', next, ...extra]);
}

describe('per-call thresholds above the host floor', () => {
  test('Capy floor: a fresh thread\'s first call of 150-230k does not delegate at start; 260k does', () => {
    expect(FLOOR).toBe(150_000);
    const h = fresh();
    for (const [call, verdict] of [[150_000, 'continue'], [230_000, 'continue'], [260_000, 'delegate']] as const) {
      const s = start(h, ['--token-cap', '60M', '--reading', String(98_000 + call), '--prior-reading', '98000']);
      expect(h.field(s.r.out, 'BUDGET', 'call')).toBe(String(call));
      expect(h.field(s.r.out, 'BUDGET', 'call_floor')).toBe(String(FLOOR));
      expect(h.field(s.r.out, 'BUDGET', 'above_floor')).toBe(String(call - FLOOR));
      expect(h.field(s.r.out, 'BUDGET', 'verdict')).toBe(verdict);
      expect(s.r.out.includes('--from 1 --to 22')).toBe(verdict === 'delegate');
    }
  });

  test('at a segment boundary, 150k above the floor delegates and less continues; an unknown charge still delegates', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '80M', '--reading', '1000000']);
    const low = check(h, s.run, '8', '9', ['--reading', '1230000', '--prior-reading', '1000000']);
    expect(low.code, low.out + low.err).toBe(0);
    expect(h.field(low.out, 'BUDGET', 'above_floor')).toBe('80000');
    expect(h.field(low.out, 'BUDGET', 'verdict')).toBe('continue');
    const high = check(h, s.run, '11.5', '12', ['--reading', '2000000', '--prior-reading', '1700000']);
    expect(h.field(high.out, 'BUDGET', 'above_floor')).toBe('150000');
    expect(h.field(high.out, 'BUDGET', 'verdict')).toBe('delegate');
    const unknown = check(h, s.run, '11.5', '12', ['--reading', '2100000']);
    expect(h.field(unknown.out, 'BUDGET', 'above_floor')).toBe('unknown');
    expect(h.field(unknown.out, 'BUDGET', 'verdict')).toBe('delegate');
  });

  // Value: protects=start refuses a delegate mode it does not implement, the removed measured mode included; fails_when=an unknown --delegate starts a ledger that silently runs as auto;
  //   why_new=/ship #3648 pass-1 simplification finding removed the uncalled measured mode; seam=gstack-ship-budget start; no_claim=the auto and never rules
  test('--delegate takes only auto or never', () => {
    const h = fresh();
    for (const mode of ['measured', 'sometimes']) {
      const bad = h.sb(['start', '--record', h.record(), '--token-cap', '60M', '--reading', '0', '--delegate', mode]);
      expect([bad.code, bad.err.includes(`--delegate '${mode}' is not auto or never`)]).toEqual([2, true]);
    }
  });

  test('--call-floor overrides the calibrated floor and is recorded in the ledger', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '60M', '--reading', '218000', '--prior-reading', '98000', '--call-floor', '0']);
    expect(h.field(s.r.out, 'BUDGET', 'call_floor')).toBe('0');
    expect(h.field(s.r.out, 'BUDGET', 'verdict')).toBe('delegate');
    expect(h.ledger(s.ledger).call_floor).toBe(0);
    const bad = h.sb(['start', '--record', h.record(), '--token-cap', '60M', '--reading', '0', '--call-floor', 'lots']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--call-floor 'lots' is not a token count");
  });
});

describe('a child never stops on the context rule', () => {
  test('#36 replay: a child at its first boundary with zero completed steps continues with one CONTEXT_HIGH note', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '400M', '--reading', '98000']);
    for (const [from, to, step, at] of [['9', '11.5', '8', 1_000_000], ['12', '22', '11.5', 2_000_000]] as const) {
      const c = handOff(h, s.run, from, to, at);
      const r = check(h, c.run, step, from, ['--reading', String(at + 200_000)]);
      expect(r.code, r.out + r.err).toBe(0);
      expect(h.field(r.out, 'BUDGET', 'verdict')).toBe('continue');
      const notes = r.out.split('\n').filter(l => l.startsWith('CONTEXT_HIGH:'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('no step completed since verify-handoff');
      expect(r.out).toContain(`RESERVATION: id=${c.run}-r1 next=${from}`);
      expect(r.out).not.toContain('STOP:');
      expect(r.out).not.toContain('GSTACK_RESULT');
      expect(fs.existsSync(c.returnFile)).toBe(false);
    }
  });

  test('a child with a completed step hands its remaining steps to a grandchild at depth 2, sub-cap = its remaining sub-cap', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '200M', '--reading', '98000']);
    const child = handOff(h, s.run, '1', '22', 200_000);
    expect(h.ledger(child.ledger).depth).toBe(1);
    expect(check(h, child.run, '1', '2', ['--reading', '600000']).code).toBe(0);
    const d = check(h, child.run, '8', '9', ['--reading', '1500000']);
    expect(d.code, d.out + d.err).toBe(0);
    expect(h.field(d.out, 'BUDGET', 'verdict')).toBe('delegate');
    expect(d.out).toContain(`gstack-ship-budget handoff --run ${child.run} --from 9 --to 22`);
    expect(d.out).not.toContain('RESERVATION');
    const room = ['admission_cap', 'used', 'reserved', 'unknown', 'tail'].map(k => Number(h.field(d.out, 'BUDGET', k)));
    const grand = handOff(h, child.run, '9', '22', 1_500_000);
    expect(grand.subCap).toBe(room[0]! - room[1]! - room[2]! - room[3]! - room[4]!);
    expect(h.field(grand.v.out, 'BUDGET', 'admission_cap')).toBe(String(grand.subCap));
    const g = h.ledger(grand.ledger);
    expect(g).toMatchObject({ role: 'child', depth: 2, parent: { run: child.run, ledger: child.ledger, from: '9', to: '22' } });
    expect(h.ledger(child.ledger).handoffs[0]).toMatchObject({ depth: 2, from: '9', to: '22' });
    const text = fs.readFileSync(grand.brief, 'utf8');
    expect(text).toContain('"depth": 2');
    expect(text).not.toContain('a delegate rule stops you');
  });

  test(`at the maximum chain depth (${MAX_CHAIN_DEPTH}) a child continues and its handoff refuses`, () => {
    expect(MAX_CHAIN_DEPTH).toBe(3);
    const h = fresh();
    const s = start(h, ['--token-cap', '900M', '--reading', '0']);
    let run = s.run;
    let reading = 100_000;
    const chain: string[] = [];
    for (const [from, done] of [['1', '1'], ['2', '2'], ['3', '3']] as const) {
      const c = handOff(h, run, from, '22', (reading += 100_000));
      expect(check(h, c.run, done, String(Number(done) + 1), ['--reading', String((reading += 100_000))]).code).toBe(0);
      run = c.run;
      chain.push(c.ledger);
    }
    expect(chain.map(f => h.ledger(f).depth)).toEqual([1, 2, 3]);
    const r = check(h, run, '8', '9', ['--reading', String((reading += 100_000))]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(h.field(r.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(r.out).toMatch(/^CONTEXT_HIGH: .*chain depth 3 is the maximum/m);
    const refused = h.sb(['handoff', '--run', run, '--from', '9', '--to', '22', '--base', 'origin/main', '--reading', String(reading)]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('chain depth 3');
  });

  test('the token admission cap still stops a child that would otherwise hand off', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '80M', '--reading', '0']);
    const ho = h.sb(['handoff', '--run', s.run, '--from', '1', '--to', '22', '--base', 'origin/main', '--reading', '100000', '--sub-cap', '5M']);
    const brief = ho.out.match(/^HANDOFF: (\S+)/m)![1]!;
    const returnFile = ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!;
    const child = h.field(h.sb(['verify-handoff', '--in', brief, '--reading', '110000']).out, 'BUDGET_RUN', 'id');
    expect(check(h, child, '1', '2', ['--reading', '120000']).code).toBe(0);
    const stop = check(h, child, '8', '9', ['--reading', '2120000']);
    expect(stop.code).toBe(3);
    expect(stop.out).toContain('STOP: reason=budget_exhausted');
    expect(stop.out).toContain('(BUDGET_CAP_REACHED)');
    expect(stop.out).not.toContain('context_threshold');
    expect(fs.readFileSync(returnFile, 'utf8')).toMatch(/^RETURN: handoff=[0-9a-f]{64} status=incomplete steps=1-22 next=9/);
  });
});

describe('a chained return is charged once', () => {
  test('Capy meter: root, child and grandchild reconcile, each token counted once and a duplicate reconcile charges nothing', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '200M', '--reading', '1000000']);
    const child = handOff(h, s.run, '1', '22', 1_100_000, ['--reading', '1200000']);
    expect(check(h, child.run, '1', '2', ['--reading', '1500000']).code).toBe(0);
    expect(h.field(check(h, child.run, '8', '9', ['--reading', '2000000']).out, 'BUDGET', 'verdict')).toBe('delegate');
    const grand = handOff(h, child.run, '9', '22', 2_100_000, ['--reading', '2200000']);
    expect(check(h, grand.run, '9', '10', ['--reading', '3000000']).code).toBe(0);
    expect(h.sb(['return', '--run', grand.run, '--to', '22', '--changed', 'Reviews', '--reading', '6000000']).code).toBe(0);
    const mid = h.sb(['reconcile', '--run', child.run, '--return', grand.returnFile, '--reading', '6100000']);
    expect(mid.code, mid.out + mid.err).toBe(0);
    // Each run reads its own counter from its verify-handoff reading, and reconcile charges the return's used=.
    expect(mid.out).toContain('child=complete child_used=3800000');
    expect(h.field(mid.out, 'BUDGET', 'used')).toBe('4900000');
    expect(h.field(mid.out, 'BUDGET', 'reserved')).toBe('0');
    const midAgain = h.sb(['reconcile', '--run', child.run, '--return', grand.returnFile, '--reading', '6100000']);
    expect(midAgain.out).toContain('nothing charged twice');
    expect(h.field(midAgain.out, 'BUDGET', 'used')).toBe('4900000');
    expect(h.sb(['return', '--run', child.run, '--to', '22', '--changed', 'Reviews', '--reading', '6200000']).code).toBe(0);
    const top = h.sb(['reconcile', '--run', s.run, '--return', child.returnFile, '--reading', '6300000']);
    expect(top.code, top.out + top.err).toBe(0);
    expect(top.out).toContain('child=complete child_used=5000000');
    expect(h.field(top.out, 'BUDGET', 'reserved')).toBe(String(stepProjection(cal, 'capy-tokens', '1')));
    expect(h.sb(['reconcile', '--run', s.run, '--return', child.returnFile, '--reading', '6300000']).out).toContain('nothing charged twice');
    const close = h.sb(['close', '--run', s.run, '--reading', '6300000']);
    expect(close.out).toContain('BUDGET_FINAL: used=5300000 reserved=0');
  });

  // Value: protects=the parent reconciles by --record after a --continue child returned, the way ship run ship-20261030T022114-ef9f9a on #3633 did; fails_when=--record resolves to the child run whose writes last replaced the record's gstack-budget block, so reconcile refuses with "no handoff ... in run <child>";
  test('reconcile --record after a --continue child returned reconciles the parent run the record belongs to', () => {
    const h = fresh();
    const record = h.record();
    const s = h.sb(['start', '--record', record, '--token-cap', '160M', '--reading', '1000000']);
    expect(s.code, s.out + s.err).toBe(0);
    const parent = h.field(s.out, 'BUDGET_RUN', 'id');
    const ho = h.sb(['handoff', '--record', record, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '1100000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const returnFile = ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!;
    const v = h.sb(['verify-handoff', '--in', ho.out.match(/^HANDOFF: (\S+)/m)![1]!, '--reading', '200000']);
    expect(v.code, v.out + v.err).toBe(0);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    expect(check(h, child, '12', '13', ['--reading', '900000']).code).toBe(0);
    expect(h.sb(['return', '--run', child, '--to', '22', '--changed', 'Reviews', '--reading', '1500000']).code).toBe(0);
    const rec = h.sb(['reconcile', '--record', record, '--return', returnFile, '--reading', '1600000']);
    expect(rec.code, rec.out + rec.err).toBe(0);
    expect(rec.out).toContain('child=complete child_used=1300000');
    expect(h.ledger(h.field(s.out, 'BUDGET_RUN', 'ledger')).handoffs[0].reconciled_at).toBeTruthy();
    expect(fs.readFileSync(record, 'utf8')).toContain(`run=${parent} `);
  });

  test("estimate meter: the grandchild's settled spend reaches the root once, through the child's return", () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '400M', '--meter', 'estimate']);
    const child = handOff(h, s.run, '1', '22', null);
    expect(check(h, child.run, '1', '2').code).toBe(0);
    expect(h.field(check(h, child.run, '8', '9').out, 'BUDGET', 'verdict')).toBe('delegate');
    const grand = handOff(h, child.run, '9', '22', null);
    expect(check(h, grand.run, '9', '10').code).toBe(0);
    expect(check(h, grand.run, '10', '11').code).toBe(0);
    const gret = h.sb(['return', '--run', grand.run, '--to', '22', '--changed', 'Reviews']);
    const grandUsed = Number(h.field(gret.out, 'BUDGET', 'used'));
    expect(grandUsed).toBe(stepProjection(cal, 'estimate-tokens', '10'));
    const childOwn = stepProjection(cal, 'estimate-tokens', '2');
    for (let i = 0; i < 2; i++) expect(h.sb(['reconcile', '--run', child.run, '--return', grand.returnFile]).code).toBe(0);
    const cret = h.sb(['return', '--run', child.run, '--to', '22', '--changed', 'Reviews']);
    expect(Number(h.field(cret.out, 'BUDGET', 'used'))).toBe(childOwn + grandUsed);
    const top = h.sb(['reconcile', '--run', s.run, '--return', child.returnFile]);
    expect(Number(h.field(top.out, 'BUDGET', 'used'))).toBe(childOwn + grandUsed);
    const again = h.sb(['reconcile', '--run', s.run, '--return', child.returnFile]);
    expect(Number(h.field(again.out, 'BUDGET', 'used'))).toBe(childOwn + grandUsed);
  });

  test("Claude Code meter: a grandchild launched by a child joins every ancestor's meter, so the root sees its usage", () => {
    const h = fresh();
    const project = path.join(h.root, 'claude', 'projects', '-tmp-repo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${FIXTURE.sessions.parent}.jsonl`), FIXTURE.journals.parent.map((l: string) => l + '\n').join(''));
    const s = start(h, ['--token-cap', '400M', '--session', FIXTURE.sessions.parent]);
    const child = handOff(h, s.run, '1', '22', null, ['--session', 'child-session-1']);
    expect(check(h, child.run, '1', '2').code).toBe(0);
    expect(h.field(check(h, child.run, '8', '9').out, 'BUDGET', 'verdict')).toBe('delegate');
    const ho = h.sb(['handoff', '--run', child.run, '--from', '9', '--to', '22', '--base', 'origin/main']);
    const brief = ho.out.match(/^HANDOFF: (\S+)/m)![1]!;
    const fake = path.join(h.root, 'fake-claude');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const launched = h.sb(['launch', '--in', brief], { GSTACK_CLAUDE_BIN: fake });
    expect(launched.code, launched.out + launched.err).toBe(0);
    const session = h.field(launched.out, 'CHILD', 'session');
    expect(h.ledger(child.ledger).meter.sessions).toContain(session);
    expect(h.ledger(s.ledger).meter.sessions).toEqual([FIXTURE.sessions.parent, session]);
  });
});

describe('a reconcile that stops the parent stops every check (replay 2, #36)', () => {
  // Replay 2: after reconcile printed verdict=stop for an incomplete child, check --next 9 still admitted Step 9.
  test('after an incomplete child, check refuses every step until resume; a regenerated child that returns complete also clears it', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '200M', '--reading', '0', '--reserve', '0']);
    const child = handOff(h, s.run, '9', '11.5', 1_000_000);
    const ret = h.sb(['return', '--run', child.run, '--to', '9', '--status', 'incomplete', '--reading', '5000000']);
    expect(ret.code, ret.out + ret.err).toBe(0);
    const rec = h.sb(['reconcile', '--run', s.run, '--return', child.returnFile, '--reading', '5100000']);
    expect(rec.code).toBe(3);
    expect(h.field(rec.out, 'BUDGET', 'verdict')).toBe('stop');
    expect(rec.out).toContain('Every check refuses until a regenerated child reconciles complete or the owner resumes');
    for (const next of ['9', '7', 'dispatch:red-team']) {
      const c = check(h, s.run, '8', next, ['--reading', '5200000']);
      expect(c.code, next).toBe(3);
      expect(c.out).toMatch(/^STOP: reason=child_incomplete at Step 9; resume first: /m);
      expect(c.out).not.toContain('RESERVATION:');
    }
    const resumed = h.sb(['resume', '--run', s.run, '--reading', '5300000']);
    expect(resumed.code, resumed.out + resumed.err).toBe(0);
    expect(resumed.out).toContain('RESUMED: from=Step 9 (child_incomplete)');
    expect(check(h, s.run, '8', '9', ['--reading', '5400000']).code).toBe(0);

    const t = start(h, ['--token-cap', '200M', '--reading', '0', '--reserve', '0']);
    const first = handOff(h, t.run, '9', '11.5', 1_000_000);
    h.sb(['return', '--run', first.run, '--to', '9', '--status', 'incomplete', '--reading', '2000000']);
    expect(h.sb(['reconcile', '--run', t.run, '--return', first.returnFile, '--reading', '2000000']).code).toBe(3);
    const second = handOff(h, t.run, '9', '11.5', 2_100_000);
    expect(h.sb(['return', '--run', second.run, '--to', '11.5', '--reading', '3000000']).code).toBe(0);
    const done = h.sb(['reconcile', '--run', t.run, '--return', second.returnFile, '--reading', '3100000']);
    expect(done.code, done.out).toBe(0);
    expect(check(h, t.run, '11.5', '12', ['--reading', '3200000']).code).toBe(0);
  });
});

describe('a child returns complete only when its own work is finished', () => {
  test('a child that returns before reconciling its grandchild returns incomplete and names the handoff', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '200M', '--reading', '98000']);
    const child = handOff(h, s.run, '1', '22', 200_000);
    expect(check(h, child.run, '1', '2', ['--reading', '600000']).code).toBe(0);
    expect(h.field(check(h, child.run, '8', '9', ['--reading', '1500000']).out, 'BUDGET', 'verdict')).toBe('delegate');
    const grand = handOff(h, child.run, '9', '22', 1_500_000);
    const ret = h.sb(['return', '--run', child.run, '--to', '22', '--changed', 'Reviews', '--reading', '1600000']);
    expect(ret.code, ret.out + ret.err).toBe(0);
    expect(ret.out).toMatch(/^RETURN: handoff=[0-9a-f]{64} status=incomplete steps=1-22/);
    expect(ret.out).toContain(`UNRECONCILED: handoff=${h.ledger(child.ledger).handoffs[0].sha} steps=9-22`);
    expect(ret.out).toContain(grand.returnFile);
    const top = h.sb(['reconcile', '--run', s.run, '--return', child.returnFile, '--reading', '1700000']);
    expect(top.code).toBe(3);
    expect(top.out).toContain('child=incomplete');
  });

  test('a child with an ADMIT remainder it never re-checked returns incomplete with a DROPPED line', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '900M', '--reading', '0', '--reserve', '0']);
    const subCap = K.stop_overhead + Math.floor(1.5 * K.per_dispatch);
    const ho = h.sb(['handoff', '--run', s.run, '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '100000', '--sub-cap', String(subCap)]);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const child = h.field(h.sb(['verify-handoff', '--in', ho.out.match(/^HANDOFF: (\S+)/m)![1]!, '--reading', '100000']).out, 'BUDGET_RUN', 'id');
    const b = check(h, child, '9', 'dispatch:specialist,specialist,red-team', ['--reading', '100000']);
    expect(b.code, b.out + b.err).toBe(0);
    expect(b.out).toMatch(/^ADMIT: 1 of 3 \(remaining=specialist,red-team\)/m);
    const ret = h.sb(['return', '--run', child, '--to', '11.5', '--reading', '100000']);
    expect(ret.out).toMatch(/^RETURN: handoff=[0-9a-f]{64} status=incomplete steps=9-11.5/);
    expect(ret.out).toMatch(/^DROPPED: step=9 reservation=\S+ roles=specialist,red-team/m);
    expect(ret.out.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=incomplete run=/);
  });

  test("a grandchild handoff outside the child's own Steps refuses and reserves nothing", () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '200M', '--reading', '98000']);
    const child = handOff(h, s.run, '9', '11.5', 200_000);
    for (const [from, to] of [['7', '22'], ['6', '11.5']]) {
      const r = h.sb(['handoff', '--run', child.run, '--from', from!, '--to', to!, '--base', 'origin/main', '--reading', '300000']);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`--from ${from} --to ${to} is outside this child's Steps 9-11.5`);
    }
    expect(h.ledger(child.ledger).reservations.filter((r: any) => r.kind === 'child')).toHaveLength(0);
  });
});

describe('variant E: the review segment and the docs reader (GSTA-167 replay 5)', () => {
  // Value: protects=Steps 7-8 stay with the parent and the fresh child starts at Step 9 with Steps 9-11.5, so the child reads only the review sections; fails_when=the Step 7 boundary delegates again or the Step 9 boundary hands off any other segment;
  //   why_new=the boundary tests above take whichever segment the code names; seam=none; no_claim=what a child costs (handoffs/GSTA-167/replay5-anatomy.md estimates ~3M on #34)
  test('Step 7 is no boundary; Step 9 delegates Steps 9-11.5 and Step 12 delegates Steps 12-22', () => {
    const h = fresh();
    const high = (step: string, next: string, at: number) => check(h, start(h, ['--token-cap', '400M', '--reading', '1000000']).run, step, next, ['--reading', String(at + 400_000), '--prior-reading', String(at)]);
    const seven = high('6', '7', 1_100_000);
    expect(h.field(seven.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(seven.out).not.toContain('DELEGATE:');
    const nine = high('8', '9', 1_100_000);
    expect(h.field(nine.out, 'BUDGET', 'verdict')).toBe('delegate');
    expect(nine.out).toMatch(/^DELEGATE: Steps 9-11\.5 go to a fresh child: gstack-ship-budget handoff --run \S+ --from 9 --to 11\.5 /m);
    expect(high('11.5', '12', 1_100_000).out).toMatch(/^DELEGATE: Steps 12-22 go to a fresh child/m);
  });

  // Value: protects=the Step 14.5 documentation audit is a metered dispatch role: priced per reader, reserved, and measured from its own reading pair, so its reader stays out of Step 14.5's step sample; fails_when=dispatch:docs is refused, priced other than a reader, or settles UNMEASURED with a valid pair, or the step sample swallows the audit (#34 replay 5: projected 1.83M, actual 7.64M, calibration=step:5.092);
  //   why_new=no role covered the docs audit; seam=none; no_claim=the docs reader's real size
  test('dispatch:docs is reserved at the reader price, settles with a DRIFT line, and Step 14.5 measures only the parent\'s own calls', () => {
    const h = fresh();
    const s = start(h, ['--token-cap', '400M', '--reading', '1000000']);
    expect(check(h, s.run, '14', '14.5', ['--reading', '1100000']).code).toBe(0);
    const c = check(h, s.run, '14.5', 'dispatch:docs', ['--reading', '1200000']);
    expect(c.code, c.out + c.err).toBe(0);
    expect(h.field(c.out, 'BUDGET', 'projected')).toBe(String(K.per_dispatch));
    const id = h.field(c.out, 'RESERVATION', 'id');
    const settled = h.sb(['settle', '--run', s.run, '--reservation', id, '--dispatched-at', '1200000', '--reading', '3200000', '--readers', '1']);
    expect(settled.code, settled.out + settled.err).toBe(0);
    expect(settled.out).toMatch(new RegExp(`^DRIFT: id=${id} kind=dispatch next=dispatch:docs projected=${K.per_dispatch} actual=2000000 `, 'm'));
    const step = check(h, s.run, '14.5', '15', ['--reading', '3500000']);
    expect(step.out).toMatch(/^DRIFT: id=\S+ kind=step next=14\.5 projected=\d+ actual=400000 /m);
    expect(h.sb(['check', '--run', s.run, '--step', '15', '--next', 'dispatch:doc', '--reading', '3600000']).err).toContain('valid: specialist, red-team, adversarial-native, outside-voice, fix-check, docs');
  });
});

describe('variant G: observe mode, note and credits (GSTA-167)', () => {
  // Value: protects=an observe run records each program's tokens and credits and the readers a program bracketed, reserves nothing, writes no review-log marker, and closes with the timeline; fails_when=note admits, reserves or delegates, a review-log start under observe needs a reservation, close flags the unreserved start, or the timeline drops credits;
  //   why_new=observe mode and note are new; seam=gstack-review-log --start; no_claim=the host counter's accuracy
  test('note records tokens, credits and the reader pair, reserves nothing, and close prints BUDGET_TIMELINE', () => {
    const h = fresh();
    const s = start(h, ['--mode', 'observe', '--token-cap', '400M', '--reading', '1000000', '--credits', '100']);
    expect(s.r.out).not.toContain('RESERVATION');
    const six = h.sb(['note', '--run', s.run, '--step', '6', '--reading', '1200000', '--credits', '150.5']);
    expect(six.code, six.out + six.err).toBe(0);
    expect(six.out).toMatch(/^NOTE: 6 used=200000 credits=50\.5$/m);
    expect(h.field(six.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(h.field(six.out, 'BUDGET', 'credits')).toBe('50.5');
    expect(h.reviewLog(['--start', 'review']).code).toBe(0);
    const pass = h.sb(['note', '--run', s.run, '--step', '9', '--label', 'dispatch:specialist,red-team', '--reading', '3200000', '--credits', '400',
      '--dispatched-at', '1200000', '--dispatched-credits', '150.5', '--readers', '2']);
    expect(pass.code, pass.out + pass.err).toBe(0);
    expect(pass.out).toMatch(/^NOTE: 9:dispatch:specialist,red-team used=2200000 credits=300 readers=2 readers_tokens=2000000 readers_credits=249\.5$/m);
    const l = h.ledger(s.ledger);
    expect(l.reservations).toEqual([]);
    expect(l.mode).toBe('observe');
    expect(fs.readFileSync(l.record, 'utf8')).toMatch(/used=2200000 credits=300 .*mode=observe/);
    const close = h.sb(['close', '--run', s.run, '--reading', '3300000', '--credits', '410']);
    expect(close.code, close.out + close.err).toBe(0);
    expect(close.out).toContain('BUDGET_FINAL: used=2300000 credits=310 reserved=0');
    expect(close.out).toContain('BUDGET_TIMELINE: 6 used=200000 credits=50.5; 9:dispatch:specialist,red-team used=2200000 credits=300 readers=2 readers_tokens=2000000 readers_credits=249.5');
  });

  // Value: protects=the cap stays one hard stop in observe mode: a note past it stops with the resumable block, and a credits reading below the last is refused like a token reading; fails_when=observe never stops, stops below the cap, or accepts a credits regression;
  //   why_new=observe mode is new; seam=none; no_claim=what a stop costs
  test('a note past the cap stops; at the cap it continues; a lower credits reading is refused', () => {
    const h = fresh();
    const s = start(h, ['--mode', 'observe', '--token-cap', '5M', '--reading', '1000000', '--credits', '100']);
    expect(h.sb(['note', '--run', s.run, '--step', '8', '--reading', '6000000', '--credits', '200']).code).toBe(0);
    const low = h.sb(['note', '--run', s.run, '--step', '9', '--reading', '6000000', '--credits', '150']);
    expect(low.code).toBe(2);
    expect(low.err).toContain('BUDGET_READING_REJECTED');
    const over = h.sb(['note', '--run', s.run, '--step', '9', '--reading', '6000001', '--credits', '210']);
    expect(over.code).toBe(3);
    expect(over.out).toContain('STOP: reason=budget_exhausted');
    expect(over.out).toContain('GSTACK_RESULT: skill=ship status=incomplete');
    expect(h.sb(['note', '--run', s.run, '--step', '12', '--reading', '6100000']).code).toBe(3);
  });

  // Value: protects=credits ride every reading in admission mode too, so the ship/SKILL.md path reports both units; fails_when=check or settle refuse --credits, or the BUDGET line omits credits once a reading exists, or prints it before any;
  //   why_new=credits are new; seam=none; no_claim=credits-to-dollars conversion
  test('admission mode takes --credits on start and check and prints credits only once one is read', () => {
    const h = fresh();
    const plain = start(h, ['--token-cap', '400M', '--reading', '1000000']);
    expect(plain.r.out).not.toMatch(/credits=/);
    const s = start(h, ['--token-cap', '400M', '--reading', '1000000', '--credits', '12.25']);
    const c = check(h, s.run, '6', '7', ['--reading', '1100000', '--credits', '20']);
    expect(c.code, c.out + c.err).toBe(0);
    expect(h.field(c.out, 'BUDGET', 'credits')).toBe('7.75');
    expect(h.sb(['note', '--run', s.run, '--step', '7', '--reading', '1200000', '--credits', 'x']).code).toBe(2);
  });
});
