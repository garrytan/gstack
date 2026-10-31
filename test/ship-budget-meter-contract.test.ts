/**
 * GSTA-167 #3633: on Capy the budget meter is the agent's own jam counter.
 * `tools.thread.get({ thread_id: "this" })` is the ROOT thread, so a lane
 * subagent's budget counted every sibling tree under the root (on #3633 the
 * root moved 37.3M while the lane's own counter moved 22.9M). A jam's own
 * counter includes its own subagents (jam_01M658JBRMTMQ1WQWYT6WFD22W,
 * 2026-10-30: +10.92M across a 6-reader dispatch with two ~0.35M parent calls
 * between), so each run reads its own jam and a handoff child reads its own
 * counter, starting below the parent's; reconcile charges the child's own delta.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { METER_CONTRACTS } from '../lib/ship-budget';
import { RESULT_CODES } from '../lib/result-codes';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OWN = 'tools.thread.get({ thread_id: "<this agent\'s own jam id>" }).cost.tokens';
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

describe('the Capy meter is the agent\'s own jam counter', () => {
  // Value: protects=a lane subagent's ledger meters its own jam (its subagents included), never the root thread's siblings; fails_when=the capy contract names thread_id "this" or a root scope;
  //   why_new=no test pinned the contract fields; seam=none; no_claim=that Capy's counter rolls up descendants (measured, not tested)
  test('METER_CONTRACTS.capy reads the agent\'s own jam id with descendants, scope thread', () => {
    expect(METER_CONTRACTS.capy).toMatchObject({ meter: 'capy', unit: 'capy-tokens', host_field: OWN, scope: 'thread', descendants: true });
    expect(RESULT_CODES.BUDGET_READING_MISSING.fix).toContain("own jam id");
    expect(RESULT_CODES.BUDGET_READING_MISSING.fix).not.toContain('thread_id: "this"');
  });

  // Value: protects=every place that tells the agent how to read the meter names its own jam, so prose and contract agree; fails_when=a section, the Capy skill, docs/ship-budget.md or the troubleshooting fix still reads thread_id "this";
  //   why_new=the contract test above reads only lib; seam=none; no_claim=the agent finds its jam id
  test('the budget prose reads the agent\'s own jam counter, never thread_id "this"', () => {
    for (const rel of ['ship/sections/budget-handoff.md.tmpl', 'capy/skill/gstack/SKILL.md', 'docs/ship-budget.md', 'docs/troubleshooting.md']) {
      const text = read(rel);
      expect(text, rel).not.toContain('thread_id: "this"');
      expect(text, rel).toMatch(/thread_id: "<(?:this agent's|your) own jam id>"/);
    }
    const capy = read('capy/skill/gstack/SKILL.md');
    expect(capy.slice(capy.indexOf('Token caps on /ship'), capy.indexOf('/ship reviewers on Capy'))).toMatch(/own jam id/);
  });

  // Value: protects=a handoff child meters its own counter, which starts far below the parent's, and the parent charges the child's own delta; fails_when=verify-handoff baselines the child at the parent's reading (its own lower reading is rejected) or reconcile charges the parent's counter delta;
  //   why_new=the chain tests feed child readings above the parent's, so they pass on a shared counter; seam=none; no_claim=the child passes its own counter
  test('a child reads its own counter from below the parent\'s reading; reconcile charges its returned own-counter delta', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '200M', '--reading', '1000000']);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const ho = h.sb(['handoff', '--run', run, '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '8000000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const brief = ho.out.match(/^HANDOFF: (\S+) /m)![1]!;
    const returnFile = ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!;
    const v = h.sb(['verify-handoff', '--in', brief, '--reading', '200000']);
    expect(v.code, v.out + v.err).toBe(0);
    expect(h.field(v.out, 'BUDGET', 'used')).toBe('0');
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    const c = h.sb(['check', '--run', child, '--step', '8', '--next', '9', '--reading', '1200000']);
    expect(c.code, c.out + c.err).toBe(0);
    expect(h.field(c.out, 'BUDGET', 'used')).toBe('1000000');
    const ret = h.sb(['return', '--run', child, '--to', '11.5', '--reading', '3200000']);
    expect(h.field(ret.out, 'BUDGET', 'used')).toBe('3000000');
    const rec = h.sb(['reconcile', '--run', run, '--return', returnFile, '--reading', '11500000']);
    expect(rec.code, rec.out + rec.err).toBe(0);
    expect(rec.out).toContain('child=complete child_used=3000000');
    expect(h.field(rec.out, 'BUDGET', 'used')).toBe('10500000');
  });

  // Value: protects=a Capy handoff child never needs its own jam id: the brief tells it to verify with no reading and never to borrow the parent's or root's counter, and the parent's own counter measures it; fails_when=the brief asks the child for its own jam counter again (replay 7e #36: every child failed verify-handoff with BUDGET_READING_MISSING, ~5M wasted, then metered off the root);
  //   why_new=replaces the own-counter brief test, whose contract replay 7e showed a subagent cannot meet; seam=none; no_claim=the child obeys
  test('the handoff brief tells a Capy child to take no reading and says the parent charges it from its own counter', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '200M', '--reading', '1000000']);
    const ho = h.sb(['handoff', '--run', h.field(s.out, 'BUDGET_RUN', 'id'), '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '2000000']);
    const text = fs.readFileSync(ho.out.match(/^HANDOFF: (\S+) /m)![1]!, 'utf8');
    const start = text.slice(text.indexOf('## Start'), text.indexOf('## Read'));
    expect(start).toContain('with no `--reading` on Capy: a subagent cannot read its own jam id');
    expect(start).toMatch(/never pass the parent's or the root's counter/);
    expect(start).not.toContain('<your own jam id>');
    const budget = text.slice(text.indexOf('## Budget'), text.indexOf('## Return contract'));
    expect(budget).toContain('On Capy pass no --reading or --credits: the parent charges child_used from its own counter around your work');
  });

  // Value: protects=a child's return settles its open step reservation, so no step reservation stays open in the child ledger after it hands back; fails_when=return leaves the last step's reservation open (replay 7e #36: return left the Step 17 reservation r8, 742,152 tokens, open);
  //   why_new=replay 7e; seam=none; no_claim=the settled amount's accuracy
  test('return settles the child\'s open Step 17 reservation', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '400M', '--reading', '1000000']);
    const ho = h.sb(['handoff', '--run', h.field(s.out, 'BUDGET_RUN', 'id'), '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '1500000']);
    const v = h.sb(['verify-handoff', '--in', ho.out.match(/^HANDOFF: (\S+) /m)![1]!, '--reading', '200000']);
    expect(v.code, v.out + v.err).toBe(0);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    const c = h.sb(['check', '--run', child, '--step', '16', '--next', '17', '--reading', '900000']);
    expect(c.code, c.out + c.err).toBe(0);
    const id = h.field(c.out, 'RESERVATION', 'id');
    const ret = h.sb(['return', '--run', child, '--to', '22', '--reading', '1600000']);
    expect(ret.code, ret.out + ret.err).toBe(0);
    const ledger = h.ledger(h.field(v.out, 'BUDGET_RUN', 'ledger'));
    expect(ledger.reservations.find((r: any) => r.id === id).state).toBe('settled');
    expect(ledger.reservations.filter((r: any) => r.state === 'open')).toEqual([]);
  });

  // Value: protects=a Capy child with no jam id of its own verifies, checks, returns and is reconciled from the parent's counter delta; fails_when=verify-handoff or a child check refuses with BUDGET_READING_MISSING, an unknown charge delegates the child onward, or reconcile charges the child's own BUDGET used=0 instead of the parent's delta;
  //   why_new=replay 7e #36 (handoffs/GSTA-167/replay7e-36.md); seam=none; no_claim=that the parent's counter excludes its own pings
  test('a child handoff passes verify-handoff with no jam id of its own and the parent measures it', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '400M', '--reading', '1000000']);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    const ho = h.sb(['handoff', '--run', run, '--from', '9', '--to', '11.5', '--base', 'origin/main', '--reading', '1500000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const v = h.sb(['verify-handoff', '--in', ho.out.match(/^HANDOFF: (\S+) /m)![1]!]);
    expect(v.code, v.out + v.err).toBe(0);
    expect(v.out).toContain('HANDOFF_OK: steps=9-11.5');
    expect(v.out).toMatch(/^METER: parent \(no counter of its own/m);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    const c = h.sb(['check', '--run', child, '--step', '9', '--next', '10']);
    expect(c.code, c.out + c.err).toBe(0);
    expect(c.err).not.toContain('BUDGET_READING_MISSING');
    expect(h.field(c.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(h.sb(['check', '--run', child, '--step', '10', '--next', '11']).out).not.toContain('DELEGATE:');
    const ret = h.sb(['return', '--run', child, '--to', '11.5']);
    expect(ret.code, ret.out + ret.err).toBe(0);
    expect(ret.out).toContain('METER: parent');
    const rec = h.sb(['reconcile', '--run', run, '--return', ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!, '--reading', '9500000']);
    expect(rec.code, rec.out + rec.err).toBe(0);
    expect(rec.out).toContain('child=complete child_used=8000000');
  });
});
