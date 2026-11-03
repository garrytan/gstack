/**
 * lib/ci-carry.ts (GSTA-258 piece 1; design fixes A2, A3): CI's verified run at HEAD's exact, clean tree stands in
 * for running a lane again. The dependencies are fakes, so nothing here reaches GitHub.
 */
import { describe, expect, test } from 'bun:test';
import { findCarry, shipLanesErrors, waitForRun } from '../lib/ci-carry';
import { validateConfig } from '../lib/pregate/config';
import { receiptSummaryLine, validateReceipt } from '../lib/ship-receipt';
import type { ApiJob, ApiRun, RunDeps, RunProfile, RunSource, TreeRecord } from '../lib/run-evidence';

const REPO = 'garrytan/gstack';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = new Date('2026-11-02T12:00:00Z');
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['free-tests'], artifact: 'tested-tree', os: 'Linux' };

const run = (id: number, over: Partial<ApiRun> = {}): ApiRun => ({
  id, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: HEAD, path: '.github/workflows/free-tests.yml',
  created_at: `2026-11-02T1${id % 10}:00:00Z`.replace('T1', 'T0'), updated_at: '2026-11-02T11:30:00Z', repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...over,
});
const record = (id: number, over: Partial<TreeRecord> = {}): TreeRecord => ({ run_id: id, run_attempt: 1, event: 'workflow_dispatch', sha: HEAD, tree: TREE, files: ['test/a.test.ts', 'test/b.test.ts'], tests: 40, os: 'Linux', ...over });
function source(runs: ApiRun[], records: Record<number, TreeRecord> = {}, jobs: ApiJob[] = [{ name: 'free-tests', conclusion: 'success', completed_at: '2026-11-02T11:30:00Z' }]): RunSource {
  const deps: RunDeps = {
    run: id => { const r = runs.find(x => x.id === id); if (!r) throw new Error('HTTP 404'); return r; },
    runsForHead: (_wf, sha) => runs.filter(r => r.head_sha === sha),
    jobs: () => jobs,
    artifact: id => { if (!records[id]) throw new Error('no artifact'); return records[id]!; },
    commitTree: sha => (sha === HEAD ? TREE : null),
  };
  return { repo: REPO, deps, profiles: { 'ci-reuse/free-tests': PROFILE }, now: NOW };
}
const clean = () => TREE;
const carry = (src: RunSource, over: Partial<Parameters<typeof findCarry>[1]> = {}) => findCarry(src, { profiles: ['ci-reuse/free-tests'], head: HEAD, tree: TREE, wtree: clean, ...over });
const why = (v: ReturnType<typeof findCarry>) => (v.ok ? 'ok' : v.reason);

describe('findCarry', () => {
  // Value: protects=a green verified run at this exact tree carries, with a receipt naming it; fails_when=a verified run is ignored or its count is lost;
  //   why_new=GSTA-258 piece 1; seam=lib/run-evidence.ts verifyRun; no_claim=GitHub's API shape (ghRunDeps)
  test('the newest verified run at HEAD carries, and the receipt names its run and tree', () => {
    const v = findCarry(source([run(4)], { 4: record(4) }), { profiles: ['ci-reuse/free-tests'], head: HEAD, tree: TREE, wtree: clean, inventory: () => ['test/a.test.ts', 'test/b.test.ts'] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect([v.tests, v.unit]).toEqual([2, 'files']);
    expect(v.runs.map(e => e.run_id)).toEqual([4]);
    expect(v.receipt).toMatch(/^ci-carry tree=bbbbbbbbbbbb files=2 runs=4\/1 profiles=ci-reuse\/free-tests heads=aaaaaaaaaaaa verified=/);
    const whole = findCarry(source([run(4)], { 4: record(4) }), { profiles: ['ci-reuse/free-tests'], head: HEAD, tree: TREE, wtree: clean });
    expect(whole.ok && [whole.tests, whole.unit, whole.receipt.split(' ')[2]]).toEqual([40, undefined, 'tests=40']);
  });

  // Value: protects=A2, a carry binds to the working-tree fingerprint before and after; fails_when=a dirty tree or a tree edited during the lookup carries
  test('a dirty working tree, or one that changes while runs are read, never carries', () => {
    expect(why(carry(source([run(4)], { 4: record(4) }), { wtree: () => 'c'.repeat(40) }))).toBe('dirty_tree');
    expect(why(carry(source([run(4)], { 4: record(4) }), { wtree: () => null }))).toBe('dirty_tree');
    let reads = 0;
    expect(why(carry(source([run(4)], { 4: record(4) }), { wtree: () => (reads++ ? 'c'.repeat(40) : TREE) }))).toBe('tree_changed');
  });

  // Value: protects=A3, a lane carries only what CI provably ran; fails_when=a tree.json missing an inventory file still carries
  test('the inventory must be covered by the runs\' tree.json files', () => {
    const src = source([run(4)], { 4: record(4) });
    const v = carry(src, { inventory: () => ['test/a.test.ts', 'test/c.test.ts'] });
    expect(why(v)).toBe('inventory_uncovered');
    expect(v.ok ? '' : v.detail).toContain('test/c.test.ts');
    expect(why(carry(src, { inventory: () => ({ error: 'exited 1' }) }))).toBe('inventory_failed');
    expect(why(carry(src, { inventory: () => [] }))).toBe('inventory_empty');
  });

  // Value: protects=fork runs, newer red or running runs, stale runs and empty runs never carry; fails_when=any of them is accepted
  test('no run, a fork run, a newer red or running run, a stale run and a run with no tests are refused', () => {
    expect(why(carry(source([])))).toBe('no_run');
    expect(why(carry(source([run(4, { head_repository: { full_name: 'evil/gstack' } })], { 4: record(4) })))).toBe('no_verified_run');
    const red = carry(source([run(4), run(6, { conclusion: 'failure' })], { 4: record(4), 6: record(6) }));
    expect(why(red)).toBe('no_verified_run');
    expect(red.ok ? '' : red.detail).toContain('run 6: run_not_success; run 4: newer_run_vetoes');
    expect(why(carry(source([run(4), run(6, { status: 'in_progress', conclusion: null })], { 4: record(4) })))).toBe('no_verified_run');
    expect(why(carry(source([run(4)], { 4: record(4) }, [{ name: 'free-tests', conclusion: 'success', completed_at: '2026-10-30T00:00:00Z' }])))).toBe('no_verified_run');
    expect(why(carry(source([run(4)], { 4: record(4, { files: [] }) })))).toBe('no_tests');
    expect(why(carry(source([run(4)], { 4: record(4) }), { profiles: ['nope'] }))).toBe('no_profile');
  });
});

describe('waitForRun', () => {
  const clockAt = () => { let t = 0; return { clock: () => t, sleep: async (ms: number) => { t += ms; } }; };
  // Value: protects=the bounded wait reports green, red with failing jobs, still running and none; fails_when=it waits forever or calls a red run green
  test('green, red with its failing jobs, still running at the deadline, and none', async () => {
    const o = (runs: ApiRun[], jobs?: ApiJob[]) => waitForRun(source(runs, {}, jobs).deps, { workflow: 'free-tests.yml', events: PROFILE.events, head: HEAD, timeoutMs: 60_000, intervalMs: 20_000, ...clockAt() });
    expect((await o([run(4)])).state).toBe('green');
    const red = await o([run(4, { conclusion: 'failure' })], [{ name: 'free-tests', conclusion: 'failure' }, { name: 'typecheck', conclusion: 'success' }]);
    expect(red).toMatchObject({ state: 'red', failing: ['free-tests'] });
    expect((await o([run(4, { status: 'in_progress', conclusion: null })])).state).toBe('running');
    expect((await o([])).state).toBe('none');
  });
});

describe('ship_lanes_from config and the ci_carried receipt field', () => {
  // Value: protects=A3, the mapping names real profiles and one inventory command; fails_when=a typo or a label-shaped entry validates
  test('ship_lanes_from validates its profiles and inventory', () => {
    const profiles = { 'ci-reuse/free-tests': PROFILE };
    expect(validateConfig({ run_profiles: profiles, ship_lanes_from: { 'bun run test': { profiles: ['ci-reuse/free-tests'], inventory: 'bun run list' } } })).toEqual([]);
    expect(shipLanesErrors({ 'bun run test': { profiles: ['nope'], inventory: 'x' } }, ['ci-reuse/free-tests']).map(e => e.message)).toEqual(['"nope" is not a run_profiles name']);
    expect(shipLanesErrors({ 'bun run test': { profiles: ['ci-reuse/free-tests'], inventory: 'a\nb' } }, ['ci-reuse/free-tests'])[0]!.path).toBe('ship_lanes_from["bun run test"].inventory');
    expect(shipLanesErrors({ 'bun run test': { profiles: ['ci-reuse/free-tests'] , inventory: 'x', label: 'free' } }, ['ci-reuse/free-tests'])[0]!.message).toContain('unknown key');
    expect(shipLanesErrors(['bun run test'], [])[0]!.path).toBe('ship_lanes_from');
  });

  // Value: protects=the receipt and its SHIP_RECEIPT line name the carried runs; fails_when=ci_carried is dropped or malformed entries validate
  test('the receipt records ci_carried and its summary line names each run', () => {
    const receipt = { schema_version: 1 as const, head: HEAD, base: 'main', ci_carried: [{ lane: 'free', run: 41, attempt: 2, tree: TREE }] };
    expect(validateReceipt(receipt)).toEqual([]);
    expect(receiptSummaryLine(receipt)).toContain('ci_carried=free:41/2');
    expect(validateReceipt({ ...receipt, ci_carried: [{ lane: 'free', run: '41' }] }).length).toBeGreaterThan(0);
  });
});
