/**
 * The eval-loop checks behind /eval-plan (docs/TESTING_INTERNALS.md#eval-loop-checks):
 * an uncounted pilot per arm on at most a tenth of its budget that draws every unit
 * type in a seeded order, a judge read per arm at a stated effort, a cost line, one
 * preregistered look at half the units above $500 paid, "smaller" scored with tests,
 * an answers check on the task machine, and a quick look that publishes no number.
 */
import { describe, expect, test } from 'bun:test';
import { checkPrereg, quickLookTemplate } from '../lib/eval-plan';
import { checkJudgeLabels, LOOP_CHECKS_SINCE } from '../lib/eval-plan-checks';
import { checkResults } from '../lib/eval-plan-report';

const PILOT: Record<string, string> = { share: '10%', counted: 'no', ran: "the skill's tool calls appear in each arm's transcripts", judge: "labels checked on each arm's pilot outputs", supply: 'three development rows per arm at the planned rate', units: 'bug fix, refactor and docs tasks, one each', seed: '7, independent of the number of workers' };
const COST: Record<string, string> = { paid: '$200', meter: '$40', ledger: 'the private spend ledger' };
const INTERIM: Record<string, string> = { at: '50%', looks: '1', bounds: "O'Brien-Fleming, |z| >= 2.80 at the look, 1.98 at the end", futility: 'stop when the paired difference is below zero at the look' };
const kv = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n');
const without = (o: Record<string, string>, k: string) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));
const plan = (o: { pilot?: Record<string, string>; cost?: Record<string, string>; interim?: Record<string, string> | null; scoring?: string; arms?: string; bars?: string; heldOut?: string; frozen?: string } = {}) => [
  o.frozen ? `frozen: ${o.frozen}\n` : '',
  `## Bars\n${o.bars ?? '- pass rate, higher is better'}\n`,
  '## Decisions\nif the skill arm passes more items: keep the skill\nif there is no difference: cut the skill\n',
  `## Arms\n${o.arms ?? '- claude-opus-5-5 the skill installed\n- claude-opus-5-5#plain no skill'}\n`,
  '## Comparison\nstack: none\nwhy: prompts compared, not skill stacks\n',
  `## Scoring\n${o.scoring ?? 'judge: gpt-6.2-astra\nlabels: 40\nagreement: 0.6\nper-arm: yes\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3 of 20 items'}\n`,
  `## Pilot\n${kv(o.pilot ?? PILOT)}\n`,
  `## Cost\n${kv(o.cost ?? COST)}\n`,
  o.interim === null || o.interim === undefined ? '' : `## Interim look\n${kv(o.interim)}\n`,
  '## Decoys\n- filled in\n', '## Stop rules\n- filled in\n',
  `## Held-out exposure\n- none touched\n${o.heldOut ?? 'answers: other git refs and build caches checked on each task machine'}\n`,
].join('\n');
const messages = (text: string) => checkPrereg(text).loop.errors.map(e => `${e.section}: ${e.message.split(' ')[0]}`);

describe('## Pilot (R111, G12)', () => {
  test('a complete pilot passes', () => {
    expect(checkPrereg(plan())).toMatchObject({ ok: true, missing: [], empty: [] });
  });

  test('a share above a tenth, a counted pilot, or a missing ran, supply, units, seed or judge line fails', () => {
    expect(messages(plan({ pilot: { ...PILOT, share: '15%' } }))).toEqual(['Pilot: share:']);
    expect(messages(plan({ pilot: { ...PILOT, counted: 'yes' } }))).toEqual(['Pilot: counted:']);
    for (const k of ['ran', 'supply', 'units', 'seed', 'judge']) expect(messages(plan({ pilot: without(PILOT, k) }))).toEqual([`Pilot: ${k}:`]);
    expect(checkPrereg(plan({ pilot: without(PILOT, 'judge'), scoring: 'judge: none\npaired: yes\ninterval: 95%\nmdd: 3' })).ok).toBe(true);
  });

  test('a missing Pilot or Cost section is missing', () => {
    expect(checkPrereg(plan().replace(/## Pilot[\s\S]*?(?=## Cost)/, '')).missing).toEqual(['Pilot']);
  });
});

describe('## Scoring per arm and effort (R78, G14)', () => {
  test('a model judge needs per-arm: yes and an effort; judge: none needs neither', () => {
    expect(messages(plan({ scoring: 'judge: gpt-6-astra\nlabels: 40\nagreement: 0.6\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3' }))).toEqual(['Scoring: per-arm:']);
    expect(messages(plan({ scoring: 'judge: gpt-6-astra\nlabels: 40\nagreement: 0.6\nper-arm: yes\npaired: yes\ninterval: 95%\nmdd: 3' }))).toEqual(['Scoring: effort:']);
  });

  test('with per-arm: yes, every label row names its arm and each arm meets the bar', () => {
    const scoring = { judge: 'gpt-6.2-astra', labels: 40, agreement: 0.6, errors: [], per_arm: true };
    const row = (i: number, arm: string | null, flip: boolean) => JSON.stringify({ id: `i${i}`, ...(arm ? { arm } : {}), human: i % 2 ? 'pass' : 'fail', judge: (i % 2 ? 'pass' : 'fail') === 'pass' !== flip ? 'pass' : 'fail' });
    const rows = (arm: (i: number) => string | null, flip: (i: number) => boolean) => Array.from({ length: 40 }, (_, i) => row(i, arm(i), flip(i))).join('\n');
    const good = checkJudgeLabels(scoring, rows(i => (i < 20 ? 'a' : 'b'), i => i === 0));
    expect(good).toMatchObject({ ok: true });
    expect(good.arms.map(a => a.arm)).toEqual(['a', 'b']);
    expect(checkJudgeLabels(scoring, rows(i => (i < 20 ? 'a' : null), () => false)).problems).toEqual(['per-arm: yes needs an "arm" on every label row; 20 have none']);
    const pooledOk = checkJudgeLabels(scoring, rows(i => (i < 10 ? 'a' : 'b'), i => i < 4));
    expect(pooledOk.kappa).toBeGreaterThanOrEqual(0.6);
    expect(pooledOk.problems.map(p => p.split(':')[0])).toEqual(['arm a']);
    expect(checkJudgeLabels(scoring, rows(() => 'a', () => false), ['a', 'b']).problems).toEqual(['per-arm: yes needs labels from every arm in ## Arms; no rows for b']);
    expect(checkJudgeLabels(scoring, rows(i => (i < 20 ? 'a' : 'typo'), () => false), ['a', 'b']).problems).toEqual(['per-arm: yes needs labels from every arm in ## Arms; no rows for b', 'label rows name arms that are not in ## Arms: typo']);
    expect(checkJudgeLabels({ ...scoring, per_arm: false }, rows(i => (i < 10 ? 'a' : 'b'), i => i < 4), ['a', 'b'])).toMatchObject({ ok: true });
  });
});

describe('## Cost and ## Interim look (R113)', () => {
  test('a cost line needs paid dollars, a meter and a ledger', () => {
    for (const k of ['paid', 'meter', 'ledger']) expect(messages(plan({ cost: without(COST, k) }))).toEqual([`Cost: ${k}:`]);
  });

  test('above $500 paid, one look at half the units with O\'Brien-Fleming and futility bounds is required; at $500 it is not', () => {
    expect(checkPrereg(plan({ cost: { ...COST, paid: '$500' } })).ok).toBe(true);
    const big = { ...COST, paid: '$1,200' };
    expect(messages(plan({ cost: big }))).toEqual(['Interim look: missing:']);
    for (const paid of ['$2k', '$1e3', '6 arms x $100', '$150USD', '$500-$900']) expect(messages(plan({ cost: { ...COST, paid } }))).toEqual(['Cost: paid:']);
    expect(checkPrereg(plan({ cost: { ...COST, paid: '1200.50' } })).loop.paid).toBe(1200.5);
    expect(checkPrereg(plan({ cost: big, interim: INTERIM }))).toMatchObject({ ok: true, loop: { paid: 1200, interim_required: true } });
    expect(messages(plan({ cost: big, interim: { ...INTERIM, at: '30%' } }))).toEqual(['Interim look: at:']);
    expect(messages(plan({ cost: big, interim: { ...INTERIM, looks: '3' } }))).toEqual(['Interim look: looks:']);
    expect(messages(plan({ cost: big, interim: { ...INTERIM, bounds: 'Pocock' } }))).toEqual(['Interim look: bounds:']);
    expect(messages(plan({ cost: big, interim: without(INTERIM, 'futility') }))).toEqual(['Interim look: futility:']);
  });
});

describe('smaller is scored with tests (G11) and no answers on the machine (G13)', () => {
  test('an arm that asks for less code needs a regression-test bar', () => {
    const arms = '- claude-opus-5-5#smaller "make the smaller change"\n- claude-opus-5-5#plain no instruction';
    expect(messages(plan({ arms }))).toEqual(['Bars: an']);
    expect(checkPrereg(plan({ arms, bars: '- pass rate, higher is better\n- regression test added, co-primary, higher is better' })).ok).toBe(true);
  });

  test('held-out exposure says how each task machine was checked for answers', () => {
    expect(messages(plan({ heldOut: '' }))).toEqual(['Held-out exposure: answers:']);
    expect(messages(plan({ heldOut: 'Answers on the task machine: tbd' }))).toEqual(['Held-out exposure: answers:']);
    expect(checkPrereg(plan({ heldOut: 'Answers on the task machine: git refs and caches checked' })).ok).toBe(true);
  });
});

describe('grandfathering by freeze date', () => {
  test(`a plan frozen before ${LOOP_CHECKS_SINCE} keeps its rules; one frozen on it does not`, () => {
    const old = plan({ frozen: '2026-11-20', pilot: {}, cost: {}, heldOut: '' }).replace(/## Pilot\n\n/, '').replace(/## Cost\n\n/, '');
    expect(checkPrereg(old)).toMatchObject({ ok: true, loop_grandfathered: true, grandfathered: false });
    expect(checkPrereg(old.replace('frozen: 2026-11-20', `frozen: ${LOOP_CHECKS_SINCE}`))).toMatchObject({ ok: false, loop_grandfathered: false, missing: ['Pilot', 'Cost'] });
  });
});

describe('quick look (R112)', () => {
  const quick = (cap = '$100', drop = '') => quickLookTemplate('q').replace('cap: $100', `cap: ${cap}`).split('\n').filter(l => !drop || !l.startsWith(drop)).join('\n').replace(/<[^!][^>]*>/g, 'filled');
  test('three lines and a cap of $100 or less pass, with no counted-run sections', () => {
    expect(checkPrereg(quick())).toMatchObject({ ok: true, quick: { cap: 100, errors: [] } });
  });

  test('a cap above $100 or a missing line fails', () => {
    expect(checkPrereg(quick('$150')).quick!.errors[0]).toContain('at most $100');
    expect(checkPrereg(quick('$100k')).quick!.errors[0]).toContain('at most $100');
    expect(checkPrereg(quickLookTemplate('q')).quick!.errors.map(e => e.split(':')[0])).toEqual(['no question', 'no decision', 'no stop']);
    for (const k of ['question', 'decision', 'stop']) expect(checkPrereg(quick('$100', k)).quick!.errors).toEqual([`no ${k}: line (a quick look is three lines: question, decision, stop rule)`]);
  });

  test('results --check refuses a quick look: it publishes no number', () => {
    const r = checkResults(quick(), '| arm | pass rate |\n|---|---|\n| claude-opus-5-5 | 7/10 |\n');
    expect(r.issues.map(i => i.code)).toEqual(['EVAL_QUICK_LOOK_NO_NUMBER']);
  });
});
