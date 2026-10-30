/**
 * Pre-dispatch enforcement (GSTA-152 build-spec r2 item 1): under a cap,
 * gstack-review-log --start refuses a dispatch without an unspent, one-shot
 * reservation id from gstack-ship-budget check; --finish settles it (its
 * completion receipt, item 7 M2); close audits unreserved dispatches after the
 * fact. Without a cap nothing changes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function capped(h: Harness, cap = '80M') {
  const record = h.record();
  const r = h.sb(['start', '--record', record, '--token-cap', cap, '--reading', '0']);
  expect(r.code).toBe(0);
  return { record, run: h.field(r.out, 'BUDGET_RUN', 'id'), ledger: h.field(r.out, 'BUDGET_RUN', 'ledger') };
}
const reserve = (h: Harness, run: string, next = 'dispatch:specialist,red-team') =>
  h.field(h.sb(['check', '--run', run, '--step', '9', '--next', next, '--reading', '0']).out, 'RESERVATION', 'id');
const startFiles = (h: Harness) => {
  const dirs = fs.existsSync(path.join(h.state, 'projects')) ? fs.readdirSync(path.join(h.state, 'projects')) : [];
  return dirs.flatMap(d => { try { return fs.readdirSync(path.join(h.state, 'projects', d, '.review-starts')); } catch { return []; } });
};

describe('gstack-review-log --start under a token cap', () => {
  test('without a cap, --start behaves exactly as before: one token line, no reservation asked', () => {
    const h = fresh();
    const plain = h.reviewLog(['--start', 'review']);
    expect(plain.code).toBe(0);
    expect(plain.out.trim()).toMatch(UUID);
    expect(plain.err).toBe('');
    const record = h.record();
    expect(h.sb(['start', '--record', record, '--token-cap', 'none', '--reading', '0']).code).toBe(0);
    const still = h.reviewLog(['--start', 'review']);
    expect(still.code).toBe(0);
    expect(still.out.trim()).toMatch(UUID);
    expect(still.err).toBe('');
  });

  test('a skipped admission refuses before launch and captures nothing', () => {
    const h = fresh();
    capped(h);
    const before = startFiles(h).length;
    const r = h.reviewLog(['--start', 'review']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('(BUDGET_CHECK_SKIPPED)');
    expect(r.err).toContain('no --reservation');
    expect(r.err.trim()).toEndWith(`; fix: ` + RESULT_CODES.BUDGET_CHECK_SKIPPED.fix + ' (BUDGET_CHECK_SKIPPED)');
    expect(startFiles(h).length).toBe(before);
  });

  test('a mismatched reservation (another run, or a step reservation) refuses', () => {
    const h = fresh();
    const other = capped(h);
    const foreign = reserve(h, other.run);
    const mine = capped(h);
    expect(h.reviewLog(['--start', 'review', '--reservation', foreign]).err).toContain('(mismatched)');
    const stepRes = h.field(h.sb(['check', '--run', mine.run, '--step', '1', '--next', '2', '--reading', '0']).out, 'RESERVATION', 'id');
    const r = h.reviewLog(['--start', 'review', '--reservation', stepRes]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('a step reservation');
    expect(r.err).toContain('(BUDGET_CHECK_SKIPPED)');
  });

  test('a reused reservation refuses; the first use consumes it and --finish settles it', () => {
    const h = fresh();
    const run = capped(h);
    const id = reserve(h, run.run, 'dispatch:specialist');
    const ok = h.reviewLog(['--start', 'review', '--reservation', id]);
    expect(ok.code).toBe(0);
    const token = ok.out.trim();
    expect(token).toMatch(UUID);
    const again = h.reviewLog(['--start', 'review', '--reservation', id]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already consumed');
    let row = h.ledger(run.ledger).reservations.find((r: any) => r.id === id);
    expect(row).toMatchObject({ state: 'consumed', token });
    const fin = h.reviewLog([JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 }), '--finish', token]);
    expect(fin.code).toBe(0);
    row = h.ledger(run.ledger).reservations.find((r: any) => r.id === id);
    expect(row.state).toBe('settled');
    expect(h.sb(['close', '--run', run.run, '--reading', '10']).code).toBe(0);
  });

  // GSTA-167 #34 replay: Step 11 reserved adversarial-native and outside-voice as one batch, and the second
  // voice's --start refused (one-shot), so it ran unreserved and close stopped with budget_check_skipped.
  test('a multi-role reservation admits one start per role, refuses the extra, and close finds nothing unreserved', () => {
    const h = fresh();
    const run = capped(h);
    const id = reserve(h, run.run, 'dispatch:adversarial-native,outside-voice');
    const tokens = [1, 2].map(() => {
      const r = h.reviewLog(['--start', 'adversarial-review', '--reservation', id]);
      expect(r.code, r.err).toBe(0);
      return r.out.trim();
    });
    expect(new Set(tokens).size).toBe(2);
    const extra = h.reviewLog(['--start', 'adversarial-review', '--reservation', id]);
    expect(extra.code).toBe(1);
    expect(extra.err).toContain('one start per role: 2 of 2 used');
    expect(h.ledger(run.ledger).reservations.find((r: any) => r.id === id).starts.map((s: any) => s.token)).toEqual(tokens);
    for (const token of tokens) {
      const row = { skill: 'adversarial-review', timestamp: new Date().toISOString(), status: 'clean', source: 'in-host' };
      expect(h.reviewLog([JSON.stringify(row), '--finish', token]).code).toBe(0);
    }
    expect(h.ledger(run.ledger).reservations.find((r: any) => r.id === id).state).toBe('settled');
    const close = h.sb(['close', '--run', run.run, '--reading', '10']);
    expect(close.out).not.toContain('BUDGET_CHECK_SKIPPED');
    expect(close.out).not.toContain('reason=budget_check_skipped');
    expect(close.code, close.out).toBe(0);
  });

  // Value: protects=a later batch of the same Step 9 pass (the Red Team, built after collect) takes no start of its own and still settles when the pass finishes, so no start token is left unfinished and no reservation stays open (gstack-evals #34 round 3: an extra red-team --start review token was never finished); fails_when=--finish settles only reservations a start consumed, leaving the Red Team's open and counted as reserved at close;
  //   why_new=the --finish tests above start every batch; seam=none; no_claim=that the program's own settle ran
  test('--finish REVIEW_START settles the pass\'s later Red Team batch that took no start; close finds nothing reserved or unreserved', () => {
    const h = fresh();
    const run = capped(h);
    const first = reserve(h, run.run, 'dispatch:specialist');
    const start = h.reviewLog(['--start', 'review', '--reservation', first]);
    expect(start.code, start.err).toBe(0);
    const redTeam = reserve(h, run.run, 'dispatch:red-team');
    const earlier = h.ledger(run.ledger).reservations.find((r: any) => r.id === redTeam);
    expect(earlier.state).toBe('open');
    const row = { skill: 'review', timestamp: new Date().toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 };
    const fin = h.reviewLog([JSON.stringify(row), '--finish', start.out.trim()]);
    expect(fin.code, fin.err).toBe(0);
    expect(fin.err).toContain(`settled budget reservations ${first},${redTeam}`);
    expect(h.ledger(run.ledger).reservations.filter((r: any) => r.kind === 'dispatch').map((r: any) => r.state)).toEqual(['settled', 'settled']);
    const close = h.sb(['close', '--run', run.run, '--reading', '10']);
    expect(close.out).toContain('reserved=0');
    expect(close.out).not.toContain('BUDGET_CHECK_SKIPPED');
    expect(close.code, close.out).toBe(0);
  });

  test('close prints one BUDGET_CHECK_SKIPPED line per unreserved dispatch and ends incomplete', () => {
    const h = fresh();
    const run = capped(h);
    const row = { skill: 'review', timestamp: new Date(Date.now() + 1000).toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 };
    expect(h.reviewLog([JSON.stringify(row)]).code).toBe(0);
    const close = h.sb(['close', '--run', run.run, '--reading', '10']);
    expect(close.code).toBe(3);
    const skipped = close.out.split('\n').filter(l => l.endsWith('(BUDGET_CHECK_SKIPPED)'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('role=review step=9');
    expect(skipped[0]).toContain('spend=unknown');
    expect(close.out).toContain('owner decision');
    expect(close.out.trim().split('\n').at(-1)).toMatch(/^GSTACK_RESULT: skill=ship status=incomplete run=/);
    const accepted = h.sb(['close', '--run', run.run, '--reading', '20', '--approved-by', 'Garry', '--words', 'accept that spend']);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('ACCEPTED: 1 unreserved dispatches by Garry');
  });

  // Value: protects=a dispatch reserved and finished inside a handoff child is not flagged at the root's close (gstack-evals #34 round 3: close printed budget_check_skipped dispatches=3 for Steps 9 and 11, which ran in child 1); fails_when=close audits review-log rows against the root ledger's own reservations only;
  //   why_new=every close test above runs on one ledger; seam=none; no_claim=that the child passed the reservation (the start refuses without one)
  test('close counts starts reserved in its handoff children; an unreserved row in the child window is still flagged', () => {
    const h = fresh();
    const root = capped(h, '200M');
    const ho = h.sb(['handoff', '--run', root.run, '--from', '7', '--to', '11.5', '--base', 'origin/main', '--reading', '1000000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    const v = h.sb(['verify-handoff', '--in', ho.out.match(/^HANDOFF: (\S+) /m)![1]!, '--reading', '100000']);
    expect(v.code, v.out + v.err).toBe(0);
    const child = h.field(v.out, 'BUDGET_RUN', 'id');
    const id = h.field(h.sb(['check', '--run', child, '--step', '8', '--next', 'dispatch:specialist', '--reading', '200000']).out, 'RESERVATION', 'id');
    const start = h.reviewLog(['--start', 'review', '--reservation', id]);
    expect(start.code, start.err).toBe(0);
    const row = { skill: 'review', timestamp: new Date().toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 };
    expect(h.reviewLog([JSON.stringify(row), '--finish', start.out.trim()]).code).toBe(0);
    expect(h.sb(['return', '--run', child, '--to', '11.5', '--reading', '300000']).code).toBe(0);
    expect(h.sb(['reconcile', '--run', root.run, '--return', ho.out.match(/^RETURN_FILE: (\S+)$/m)![1]!, '--reading', '1400000']).code).toBe(0);
    const clean = h.sb(['close', '--run', root.run, '--reading', '1500000']);
    expect(clean.out).not.toContain('BUDGET_CHECK_SKIPPED');
    expect(clean.code, clean.out).toBe(0);
    const h2 = fresh();
    const root2 = capped(h2, '200M');
    const ho2 = h2.sb(['handoff', '--run', root2.run, '--from', '7', '--to', '11.5', '--base', 'origin/main', '--reading', '1000000']);
    expect(h2.sb(['verify-handoff', '--in', ho2.out.match(/^HANDOFF: (\S+) /m)![1]!, '--reading', '100000']).code).toBe(0);
    expect(h2.reviewLog([JSON.stringify({ ...row, timestamp: new Date(Date.now() + 1000).toISOString() })]).code).toBe(0);
    const flagged = h2.sb(['close', '--run', root2.run, '--reading', '1500000']);
    expect(flagged.code).toBe(3);
    expect(flagged.out.split('\n').filter(l => l.endsWith('(BUDGET_CHECK_SKIPPED)'))).toHaveLength(1);
  });

  test('a stopped run refuses every later dispatch until resume', () => {
    const h = fresh();
    const run = capped(h, '20M');
    expect(h.sb(['check', '--run', run.run, '--step', '9', '--next', 'dispatch:specialist,red-team', '--reading', '9000000']).code).toBe(3);
    const r = h.reviewLog(['--start', 'review', '--reservation', 'anything']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('(BUDGET_CAP_REACHED)');
  });

  test('a stopped run or a lost ledger does not block a later uncapped review on the branch', () => {
    const h = fresh();
    const run = capped(h, '20M');
    expect(h.sb(['check', '--run', run.run, '--step', '9', '--next', 'dispatch:specialist,red-team', '--reading', '9000000']).code).toBe(3);
    const afterStop = h.reviewLog(['--start', 'review']);
    expect(afterStop.code).toBe(0);
    expect(afterStop.out.trim()).toMatch(UUID);
    const h2 = fresh();
    const lost = capped(h2);
    fs.unlinkSync(lost.ledger);
    const afterLoss = h2.reviewLog(['--start', 'review']);
    expect(afterLoss.code).toBe(0);
    expect(afterLoss.out.trim()).toMatch(UUID);
  });
});
