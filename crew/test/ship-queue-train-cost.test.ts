/**
 * The train verdict's cost line: the known sum plus how many of the record's
 * cases carry no cost, so a partial sum is never read as the run's spend.
 * Train 76db1d1f10c4 (2026-10-26) printed cost=$24.41 while its slice report
 * said "cost $32.92 known + 54 of 136 trial(s) cost unknown": 54 E2E records
 * named by display label had no case attributed (scripts/lib/paid-report.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EXIT } from '../../lib/headless-artifacts';
import { cleanup } from '../../test/helpers/restamp-fixture';
import { GREEN_GATE, PASS, TRAIN_POLICY, line, nonceOf, openPr, queue, readyReceipt, trainFixture, type Rule, type TrainFixture } from '../../test/helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = () => { const f = trainFixture(TRAIN_POLICY); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

function greenTrain(fx: TrainFixture, gate: Rule) {
  const h1 = openPr(fx, '1');
  const h2 = openPr(fx, '2');
  readyReceipt(fx, '1', h1);
  readyReceipt(fx, '2', h2);
  fx.write(d => { d.rules['evals.yml'] = gate; });
  return nonceOf(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--free-timeout', '1']).out);
}

describe('train verdict cost line', () => {
  // Value: protects=a train verdict never presents a partial sum as the run's cost (train 76db1d1f10c4 on 2026-10-26: verdict $24.41, the run's slice reports $32.92 known with 54 trials unattributed);
  // fails_when=the ATTEMPT line prints cost=$ without naming the cost-unknown cases, or names them when every panel has a cost; why_new=the line only had the known sum; seam=the gate record's panels; no_claim=why a trial's cost is unknown
  test('the verdict prints the known cost and how many cases have none, and nothing extra when every panel is priced', () => {
    const fx = make();
    const unpriced = { ...GREEN_GATE, record: { ...GREEN_GATE.record, panels: [PASS('c1'), { ...PASS('c2'), cost_usd: null }, { ...PASS('j1', 'judge', 0.1), cost_usd: null }] } };
    const nonce = greenTrain(fx, unpriced);
    const v = queue(fx, ['train', 'verdict', '--train', nonce]);
    expect([v.status, line(v.out, 'ATTEMPT:')]).toEqual([EXIT.ok, 'ATTEMPT: a1 gate run 101 GREEN cost=$0.70 known + 2 of 3 case(s) cost unknown (rule 2/2, judge 1/1)']);
    const all = make();
    const priced = greenTrain(all, GREEN_GATE);
    expect(line(queue(all, ['train', 'verdict', '--train', priced]).out, 'ATTEMPT:')).toBe('ATTEMPT: a1 gate run 101 GREEN cost=$1.50 (rule 2/2, judge 1/1)');
  }, 120_000);

  // Value: protects=a train whose every case is priced at $0.00 (reused or free trials) still reports its cost as known;
  // fails_when=the null guard on cost_usd becomes a falsy check, so a zero sum prints nothing and reads like an unpriced run;
  // existing_gap=the two rows above price every panel above zero or leave some unpriced, never a known zero; seam=none
  test('a train priced at zero prints cost=$0.00 rather than no cost at all', () => {
    const fx = make();
    const free = { ...GREEN_GATE, record: { ...GREEN_GATE.record, panels: [PASS('c1', 'rule', 0), PASS('c2', 'rule', 0), PASS('j1', 'judge', 0)] } };
    const nonce = greenTrain(fx, free);
    expect(line(queue(fx, ['train', 'verdict', '--train', nonce]).out, 'ATTEMPT:')).toBe('ATTEMPT: a1 gate run 101 GREEN cost=$0.00 (rule 2/2, judge 1/1)');
  }, 60_000);
});
