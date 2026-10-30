/**
 * Merge trains (plan GSTA-49 lane T1), the pure decisions: slot order and
 * fill, every paid-report class mapped to a train verdict, bisect pattern
 * attribution, the rebuild and re-dispatch allowances pinned to EVAL_POLICY,
 * the screen recommendation, the `train` policy block and eval-bg's nonce
 * key with purpose and screen policy.
 */
import { describe, expect, test } from 'bun:test';
import { DISPATCH_INPUTS, dedupeKey, dispatchPlan, findDuplicateRun, makeNonce, nonceScope, type RunSummary } from '../scripts/eval-bg';
import { DEFAULT_POLICY, TRAIN_KEYS_VERSION, validatePolicy } from '../lib/ship-policy';
import { fillDue, orderSlots, parseOrder, parsePins, prsArgs } from '../lib/ship-queue-train';
import { gstackPaidSelection, skillOwnCases, touchedSkills } from '../lib/ship-queue-train-ready';
import { normalizeRemoteUrl, repoIdentity, type TrainSlot } from '../lib/ship-queue-train-record';
import { INFRA_REDISPATCH, REBUILD_ONCE, classifyBisect, classifyGate } from '../lib/ship-queue-train-verdict';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';
import { COMPLETE, FAIL, PASS, TRAIN_BLOCK } from './helpers/ship-queue-train-fixture';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SHA = 'a'.repeat(40);
const slot = (pr: string, screened: boolean, at: string): TrainSlot => ({ pr, head: SHA, ready_at: at, screen: { choice: screened ? 'screen' : 'no-screen', policy: null, nonce: null, run: null, merge_sha: null } });

describe('ordering and fill', () => {
  test('screened PRs go first in READY order, then unscreened; the order is stable on ties', () => {
    const o = orderSlots([slot('4', false, '2026-10-18T01:00:00Z'), slot('3', true, '2026-10-18T03:00:00Z'), slot('2', false, '2026-10-18T00:00:00Z'), slot('1', true, '2026-10-18T02:00:00Z')], 5);
    expect(o.train.map(s => s.pr)).toEqual(['1', '3', '2', '4']);
    expect(o.held).toEqual([]);
  });

  test('unscreened PRs fill the seats a screened PR leaves, however many wait; over-size PRs are held in order', () => {
    const unscreened = ['5', '6', '7', '10', '11'].map((pr, i) => slot(pr, false, `2026-10-18T0${i}:00:00Z`));
    const mixed = orderSlots([slot('9', true, '2026-10-18T05:00:00Z'), ...unscreened], 5);
    expect(mixed.train.map(s => s.pr)).toEqual(['9', '5', '6', '7', '10']);
    expect(mixed.held.map(s => s.pr)).toEqual(['11']);
    const atThree = orderSlots([slot('9', true, '2026-10-18T05:00:00Z'), ...unscreened.slice(0, 3)], 3);
    expect([atThree.train.map(s => s.pr), atThree.held.map(s => s.pr)]).toEqual([['9', '5', '6'], ['7']]);
    expect(orderSlots(unscreened, 3).train.map(s => s.pr)).toEqual(['5', '6', '7']);
    const over = orderSlots([slot('8', true, '2026-10-18T06:00:00Z'), slot('9', true, '2026-10-18T05:00:00Z'), unscreened[0]!], 2);
    expect(over.train.map(s => s.pr)).toEqual(['9', '8']);
    expect(over.held.map(s => s.pr)).toEqual(['5']);
  });

  test('a train under its size dispatches once its oldest READY has waited fill_hours; full or urgent dispatches at once', () => {
    const slots = [slot('1', false, '2026-10-18T09:00:00Z'), slot('2', false, '2026-10-18T10:00:00Z')];
    expect(fillDue(slots, TRAIN_BLOCK as any, '2026-10-18T11:59:00Z', false)).toBe('2026-10-18T12:00:00.000Z');
    expect(fillDue(slots, TRAIN_BLOCK as any, '2026-10-18T12:00:00Z', false)).toBeNull();
    expect(fillDue(slots, TRAIN_BLOCK as any, '2026-10-18T09:30:00Z', true)).toBeNull();
    expect(fillDue(slots, { ...TRAIN_BLOCK, max_size: 2 } as any, '2026-10-18T09:30:00Z', false)).toBeNull();
  });

  test('pins are <pr>@<sha>, each PR once', () => {
    expect(parsePins(`12@${SHA},#13@abcdef1`)).toEqual([{ pr: '12', sha: SHA }, { pr: '13', sha: 'abcdef1' }]);
    expect(parsePins('12')).toMatch(/entries are <pr>@<sha>/);
    expect(parsePins(`12@${SHA},12@${SHA}`)).toBe('a PR appears twice in --prs');
  });

  test('--order (GSTA-67, #3337 docs slotted ahead of the #3343 catalog it describes): an explicit order replaces screened-first and READY order; absent, the default is unchanged', () => {
    const docs = slot('3337', false, '2026-10-22T18:00:00Z');
    const catalog = slot('3343', false, '2026-10-22T19:00:00Z');
    expect(orderSlots([docs, catalog], 5).train.map(s => s.pr)).toEqual(['3337', '3343']);
    expect(orderSlots([docs, catalog], 5, undefined).train.map(s => s.pr)).toEqual(['3337', '3343']);
    const pins = [{ pr: '3337' }, { pr: '3343' }];
    const order = parseOrder('3343,#3337', pins);
    expect(order).toEqual(['3343', '3337']);
    expect(orderSlots([docs, catalog], 5, order as string[]).train.map(s => s.pr)).toEqual(['3343', '3337']);
    const screened = slot('9', true, '2026-10-22T20:00:00Z');
    const over = orderSlots([docs, catalog, screened], 2, ['3343', '3337', '9']);
    expect([over.train.map(s => s.pr), over.held.map(s => s.pr)]).toEqual([['3343', '3337'], ['9']]);
    expect(parseOrder(undefined, pins)).toBeUndefined();
    for (const bad of ['3343', '3343,3337,3337', '3343,3337,1', '3343,x']) expect(parseOrder(bad, pins)).toEqual({ error: `--order must list every PR in --prs exactly once (--prs has #3337,#3343; got ${bad})` });
    expect(prsArgs([{ pr: '3343', head: SHA }, { pr: '3337', head: SHA }], true)).toBe(`--prs 3343@${SHA},3337@${SHA} --order 3343,3337`);
    expect(prsArgs([{ pr: '3343', head: SHA }], false)).toBe(`--prs 3343@${SHA}`);
  });
});

describe('repo identity (GSTA-67, #3331 on 2026-10-21)', () => {
  test("every URL form of one GitHub repository gives one key, the github.com key gstack's records already use", () => {
    const canonical = 'https://github.com/garrytan/gstack';
    for (const url of ['https://github.com/garrytan/gstack', 'https://github.com/garrytan/gstack.git', 'https://git.capy.ai/garrytan/gstack', 'https://git.capy.ai/garrytan/gstack.git/',
      'git@github.com:garrytan/gstack.git', 'ssh://git@github.com/garrytan/gstack.git', 'ssh://git@ssh.github.com:443/garrytan/gstack.git', 'https://x-access-token:PASSWORD@github.com/garrytan/gstack.git',
      'http://www.github.com/GarryTan/GStack']) expect(normalizeRemoteUrl(url)).toBe(canonical);
    expect(normalizeRemoteUrl('https://gitlab.com/acme/widget.git')).toBe('https://gitlab.com/acme/widget');
    expect(normalizeRemoteUrl('https://user:PASSWORD@gitlab.com/acme/widget.git')).toBe('https://gitlab.com/acme/widget');
    expect(normalizeRemoteUrl('/tmp/fixture/origin.git')).toBe('/tmp/fixture/origin');
  });

  test("#3331's lane (origin https://git.capy.ai/garrytan/gstack) now writes b321d228efd2bc14, and readers still accept the 1fb5dd69740a8cf8 receipt it wrote", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-identity-'));
    try {
      const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
      git('init', '-q');
      git('remote', 'add', 'origin', 'https://git.capy.ai/garrytan/gstack');
      const lane = repoIdentity(dir);
      expect(lane.key).toBe('b321d228efd2bc14');
      expect(lane.url).toBe('https://github.com/garrytan/gstack');
      expect(lane.keys).toContain('1fb5dd69740a8cf8');
      git('remote', 'set-url', 'origin', 'https://github.com/garrytan/gstack.git');
      const coordinator = repoIdentity(dir);
      expect(coordinator.key).toBe('b321d228efd2bc14');
      expect(coordinator.keys).toEqual(expect.arrayContaining(['b321d228efd2bc14', '1fb5dd69740a8cf8']));
      expect(coordinator.keys[0]).toBe('b321d228efd2bc14');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('verdict class mapping', () => {
  const expectIds = { nonce: 'n1', head: SHA, tree: 'b'.repeat(40) };
  const record = (over: Record<string, unknown> = {}) => ({ schema: 1, kind: 'train-gate', nonce: 'n1', head_sha: SHA, tree: 'b'.repeat(40), verdict: 'GREEN', census: COMPLETE, panels: [PASS('c1'), PASS('j1', 'judge')], ...over });
  const done: { status: string; conclusion: string | null } = { status: 'completed', conclusion: 'success' };
  const check = { status: 'completed', conclusion: 'success' };
  const classify = (rec: unknown, run = done, chk: typeof check | null = check) => classifyGate(rec, expectIds, run, chk);

  test('GREEN only for a complete, bound census on a successful run that published its check', () => {
    const g = classify(record());
    expect(g.outcome).toBe('GREEN');
    expect(g.detail).toBe('rule 2/2, judge 1/1');
    expect(classify(record(), done, null).outcome).toBe('INCOMPLETE');
    expect(classify(record(), done, { status: 'completed', conclusion: 'failure' }).detail).toContain('did not publish a successful check run');
  });

  test('a run still going is PENDING; no record is INCOMPLETE and eligible for the one INFRA re-dispatch', () => {
    expect(classify(record(), { status: 'in_progress', conclusion: null }).outcome).toBe('PENDING');
    const none = classify(null, { status: 'completed', conclusion: 'cancelled' });
    expect([none.outcome, none.infraEligible]).toEqual(['INCOMPLETE', true]);
    expect(none.detail).toContain('a slice killed before its upload step');
  });

  test('a VERDICT FAIL is RED with its cases, even beside census gaps', () => {
    const r = classify(record({ verdict: 'RED', panels: [FAIL('c2'), FAIL('c1'), PASS('j1')], census: { ...COMPLETE, cancelled_shards: 1 } }), { status: 'completed', conclusion: 'failure' });
    expect([r.outcome, r.red]).toEqual(['RED', ['c1', 'c2']]);
    expect(r.cost).toBe(2.5);
  });

  test('INFRA and INCOMPLETE panels, unbound, partial or cancelled shards and killed slices are INCOMPLETE, never green', () => {
    const cases: Array<[Record<string, unknown>, boolean, RegExp]> = [
      [{ panels: [FAIL('c1', 'INFRA'), PASS('j1')] }, true, /c1 FAIL \(INFRA\)/],
      [{ panels: [{ ...PASS('c1'), status: 'INCOMPLETE', red_class: 'INCOMPLETE' }, PASS('j1')] }, true, /c1 INCOMPLETE/],
      [{ panels: [{ ...PASS('c1'), status: 'SKIPPED' }, PASS('j1')] }, false, /c1 SKIPPED/],
      [{ census: { ...COMPLETE, unbound: 1 } }, true, /1 unbound result/],
      [{ census: { ...COMPLETE, partial_shards: 2 } }, true, /2 partial shard/],
      [{ census: { ...COMPLETE, killed_before_upload: 1 } }, true, /slice killed before upload/],
      [{ census: { ...COMPLETE, executed: { rule: 1, judge: 1 } } }, true, /rule 1\/2 executed/],
      [{ census: { ...COMPLETE, planned: { rule: 0, judge: 0 }, executed: { rule: 0, judge: 0 } } }, true, /lists no cases/],
    ];
    for (const [over, eligible, why] of cases) {
      const r = classify(record(over));
      expect([r.outcome, r.infraEligible]).toEqual(['INCOMPLETE', eligible]);
      expect(r.detail).toMatch(why);
    }
  });

  test('a record bound to another nonce, head or tree, or a failed run with a green census, is INCOMPLETE and not eligible', () => {
    for (const over of [{ nonce: 'other' }, { head_sha: 'c'.repeat(40) }, { tree: 'd'.repeat(40) }]) {
      const r = classify(record(over));
      expect([r.outcome, r.infraEligible]).toEqual(['INCOMPLETE', false]);
      expect(r.detail).toContain('not this train');
    }
    expect(classify(record(), { status: 'completed', conclusion: 'failure' }).detail).toContain('run concluded failure with record verdict GREEN');
  });

  test('the one INFRA re-dispatch and the one rebuild are pinned to EVAL_POLICY', () => {
    expect(INFRA_REDISPATCH).toBe(EVAL_POLICY.infraRedispatch);
    expect(REBUILD_ONCE).toBe(1);
  });
});

describe('bisect attribution', () => {
  const slots = [{ pr: '11' }, { pr: '12' }, { pr: '13' }];
  const results = (patterns: Record<string, string>) => [0, 1, 2, 3].map(i => Object.fromEntries(Object.entries(patterns).map(([c, p]) => [c, p[i] === 'R' ? 'red' as const : 'green' as const])));

  test('monotone green-then-red blames the PR that starts the red, the last PR included', () => {
    expect(classifyBisect(['c1'], results({ c1: 'GGRR' }), slots)).toEqual({ kind: 'attributed', all_green: false, prs: ['12'], patterns: { c1: 'GGRR' } });
    expect(classifyBisect(['c1'], results({ c1: 'GGGR' }), slots).prs).toEqual(['13']);
    expect(classifyBisect(['c1', 'c2'], results({ c1: 'GRRR', c2: 'GGGR' }), slots).prs).toEqual(['11', '13']);
    expect(classifyBisect(['c1', 'c2'], results({ c1: 'GRRR', c2: 'GGGG' }), slots).kind).toBe('attributed');
  });

  test('red on every prefix, T0 included, is main; all green and non-monotone are unattributed', () => {
    expect(classifyBisect(['c1'], results({ c1: 'RRRR' }), slots).kind).toBe('red-on-main');
    expect(classifyBisect(['c1', 'c2'], results({ c1: 'RRRR', c2: 'GGRR' }), slots).kind).toBe('red-on-main');
    expect(classifyBisect(['c1'], results({ c1: 'GGGG' }), slots)).toMatchObject({ kind: 'unattributed', all_green: true, prs: [] });
    expect(classifyBisect(['c1'], results({ c1: 'GRGR' }), slots)).toMatchObject({ kind: 'unattributed', all_green: false });
    expect(classifyBisect(['c1'], results({ c1: 'RGGG' }), slots)).toMatchObject({ kind: 'unattributed', all_green: false });
    expect(classifyBisect(['c1', 'c2'], results({ c1: 'GGRR', c2: 'GRGR' }), slots)).toMatchObject({ kind: 'unattributed', all_green: false });
  });
});

describe('screen recommendation', () => {
  test('a skill directory is touched when the diff changes a file under a directory holding SKILL.md.tmpl', () => {
    expect(touchedSkills(['review/SKILL.md.tmpl', 'review/x.md', 'lib/a.ts', 'README.md'], d => d === 'review')).toEqual(['review']);
    expect(skillOwnCases(['a', 'b', 'c'], { a: ['review/**'], b: ['lib/**'], c: ['review/SKILL.md'] }, ['review'])).toEqual(['a', 'c']);
  });

  test("gstack's selector on gstack's own tree: only a change that restores every case recommends --screen", async () => {
    const has = (dir: string) => fs.existsSync(path.join(ROOT, dir, 'SKILL.md.tmpl'));
    const skill = await gstackPaidSelection(ROOT, 'HEAD', ['review/SKILL.md.tmpl'], has);
    expect(skill.recommend).toBe('no-screen');
    expect(skill.lines[0]).toMatch(/^SCREEN: selection \d+ e2e case\(s\) \+ \d+ judge\(s\)/);
    expect(skill.lines[1]).toMatch(/^SCREEN: skill's own cases \S+$/);
    expect(skill.lines[2]).toMatch(/^SCREEN: selector mode (pr|dependents): the train gate's full census covers these cases → recommend --no-screen$/);
    const shared = await gstackPaidSelection(ROOT, 'HEAD', ['bun.lock'], has);
    expect(shared.recommend).toBe('screen');
    expect(shared.lines[2]).toMatch(/^SCREEN: selector mode full-fallback \(.*bun\.lock.*\) → recommend --screen$/);
    expect((await gstackPaidSelection(ROOT, 'HEAD', ['review/SKILL.md.tmpl', 'bun.lock'], has)).recommend).toBe('screen');
    const docs = await gstackPaidSelection(ROOT, 'HEAD', ['docs/ship-policy.md'], has);
    expect(docs.recommend).toBe('no-screen');
  }, 60_000);

  // Generated by /ship Step 7 coverage audit (GSTA-165 1a).
  // Value: protects=a diff the paid selector cannot select (needs full validation) recommends --screen with the full gate selection;
  //   fails_when=the selector-error branch stops forcing everyCase, so an unselectable diff rides the train unscreened;
  //   why_new=the existing selector test covers pr, dependents and full-fallback modes only, never the throw;
  //   seam=none; no_claim=dispatch of the screen itself (pure selection on gstack's own tree; no eval-bg run)
  test("gstack's selector on gstack's own tree: a diff it cannot select recommends --screen with the full gate selection", async () => {
    const r = await gstackPaidSelection(ROOT, 'HEAD', ['unregistered/nested/SKILL.md'], () => false);
    expect(r.recommend).toBe('screen');
    expect(r.lines[0]).toMatch(/^SCREEN: selection \d+ e2e case\(s\) \+ \d+ judge\(s\) \(the PR profile needs full validation \(.*requires full validation.*\): the screen is the full gate selection\)$/);
    expect(r.lines[2]).toBe('SCREEN: the selector could not select → recommend --screen');
  }, 60_000);
});

describe('the train policy block', () => {
  const ok = { train: TRAIN_BLOCK, min_gstack_version: TRAIN_KEYS_VERSION };
  const codes = (raw: unknown) => validatePolicy(raw, { gstackVersion: '1.91.200.0' }).map(e => `${e.code}@${e.path}`);

  test('defaults keep it null; a full block validates with min_gstack_version at its introducing version', () => {
    expect(DEFAULT_POLICY.train).toBeNull();
    expect(codes(ok)).toEqual([]);
    expect(codes({ train: TRAIN_BLOCK })).toEqual(['POLICY_INVALID@train']);
  });

  test('unknown, missing and out-of-range fields fail closed', () => {
    expect(codes({ ...ok, train: { ...TRAIN_BLOCK, colour: 'red' } })).toEqual(['POLICY_INVALID@train.colour']);
    const { fill_hours: _drop, ...missing } = TRAIN_BLOCK;
    expect(codes({ ...ok, train: missing })).toEqual(['POLICY_INVALID@train.fill_hours']);
    expect(codes({ ...ok, train: { ...TRAIN_BLOCK, max_size: 7, gate_workflow: '../evals.yml', screen_selection: 'all' } }))
      .toEqual(['POLICY_INVALID@train.gate_workflow', 'POLICY_INVALID@train.max_size', 'POLICY_INVALID@train.screen_selection']);
    expect(codes({ ...ok, train: [] })).toEqual(['POLICY_INVALID@train']);
  });
});

describe("eval-bg nonce key: purpose and screen policy", () => {
  const base = 'c'.repeat(40);
  const run = (title: string): RunSummary => ({ databaseId: 1, displayTitle: title, status: 'in_progress', conclusion: null, url: 'u', event: 'workflow_dispatch' });

  test('a plain lane key is unchanged; a scoped key carries purpose and policy, and parses back', () => {
    expect(dedupeKey('pr', SHA, base)).toBe(`pr-${SHA.slice(0, 12)}-${base.slice(0, 12)}-`);
    expect(makeNonce('pr', SHA, base, 'zz', { purpose: 'screen', policy: 'broad' })).toBe(`pr.screen.broad-${SHA.slice(0, 12)}-${base.slice(0, 12)}-zz`);
    expect(nonceScope(makeNonce('gate', SHA, base, 'q1', { purpose: 'train' }))).toEqual({ purpose: 'train' });
    expect(nonceScope(makeNonce('pr', SHA, base, 'q1', { purpose: 'screen', policy: 'narrow' }))).toEqual({ purpose: 'screen', policy: 'narrow' });
    expect(nonceScope(makeNonce('pr', SHA, base, 'q1'))).toBeNull();
  });

  test('a broad screen never adopts a narrow run, a screen never adopts a plain PR lane run, and a train never adopts a bisect', () => {
    const narrow = makeNonce('pr', SHA, base, 'n1', { purpose: 'screen', policy: 'narrow' });
    const plain = makeNonce('pr', SHA, base, 'p1');
    const bisect = makeNonce('gate', SHA, base, 'b1', { purpose: 'bisect' });
    const runs = [run(`E2E Evals [eval-bg ${narrow}]`), run(`E2E Evals [eval-bg ${plain}]`), run(`E2E Evals [eval-bg ${bisect}]`)];
    expect(findDuplicateRun(runs, dedupeKey('pr', SHA, base, { purpose: 'screen', policy: 'broad' }))).toBeNull();
    expect(findDuplicateRun([runs[1]!], dedupeKey('pr', SHA, base, { purpose: 'screen', policy: 'narrow' }))).toBeNull();
    expect(findDuplicateRun(runs, dedupeKey('pr', SHA, base, { purpose: 'screen', policy: 'narrow' }))?.displayTitle).toContain(narrow);
    expect(findDuplicateRun([runs[2]!], dedupeKey('gate', SHA, base, { purpose: 'train' }))).toBeNull();
  });

  test('every dispatch input name lives in DISPATCH_INPUTS, and the lane plans still send the same inputs', () => {
    expect(DISPATCH_INPUTS).toMatchObject({ cases: 'cases', prefixShas: 'prefix_shas', screenPr: 'screen_pr', screenMergeSha: 'screen_merge_sha', screenPolicy: 'screen_policy' });
    expect(dispatchPlan('gate', { sha: SHA, baseRef: 'main', baseSha: base, nonce: 'n' })).toEqual([{ workflow: 'evals.yml', inputs: { evals_all: 'true', expected_sha: SHA, nonce: 'n' } }]);
  });
});
