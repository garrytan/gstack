/**
 * Wave PRs (lib/ship-queue-wave.ts; docs/ship-policy.md#wave-prs; Garry R46, GST-574)
 * through the real bin/gstack-ship-queue against the train fixture (bare origin, gh shim):
 * the area and grouping rules, wave build (merge chain, record on the notes ref, frozen
 * notices, size and moved refusals), the conflict worktree and --continue, --drop as a new
 * wave and its dependent refusal, ready and train build reading a wave PR (WAVE and
 * CONSTITUENTS lines, a record rebuilt from notes on a clean state root, moved, duplicate and
 * unknown refusals, WAVE_ADVISED over the trigger), wave plan, and wave settle.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { WAVE_HELP, areaKey, groupWaves, isHubFile, type PlanPr } from '../lib/ship-queue-wave';
import { cleanup, runBin } from './helpers/restamp-fixture';
import { line, openPr, queue, readyReceipt, shippedBody, trainFixture, type TrainFixture } from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = () => { const f = trainFixture(); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const nonceOf = (out: string) => /^WAVE: (\S+)/m.exec(out)?.[1] ?? '';
const waveJson = (fx: TrainFixture, nonce: string) => JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'waves', `${nonce}.json`), 'utf8'));
const gitIn = (fx: TrainFixture, cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...fx.repo.env } });

/** Commit seed files onto main and push them. */
function seedMain(fx: TrainFixture, files: Record<string, string>, message = 'seed'): void {
  fx.repo.git('checkout', '-q', 'origin/main', '-B', 'seed');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(fx.repo.work, f)), { recursive: true }); fs.writeFileSync(path.join(fx.repo.work, f), t); }
  fx.repo.git('add', '-A');
  fx.repo.git('commit', '-q', '-m', message);
  fx.repo.git('push', '-q', 'origin', 'HEAD:main');
  fx.repo.git('fetch', '-q', 'origin');
}

/** A READY PR off main writing (or, for null, deleting) files, with green CI and a READY receipt at its head. */
function readyPr(fx: TrainFixture, n: string, files: Record<string, string | null>): string {
  fx.repo.git('checkout', '-q', 'origin/main', '-B', `pr-${n}`);
  for (const [f, t] of Object.entries(files)) {
    if (t === null) { fs.rmSync(path.join(fx.repo.work, f)); continue; }
    fs.mkdirSync(path.dirname(path.join(fx.repo.work, f)), { recursive: true });
    fs.writeFileSync(path.join(fx.repo.work, f), t);
  }
  fx.repo.git('add', '-A');
  fx.repo.git('commit', '-q', '-m', `feat #${n}`);
  const head = fx.repo.git('rev-parse', 'HEAD');
  fx.repo.git('push', '-q', '-f', 'origin', `HEAD:refs/pull/${n}/head`);
  fx.write(d => {
    d.prs[n] = { headRefOid: head, isCrossRepository: false, state: 'OPEN', headRefName: `pr-${n}`, url: `https://github.com/fixture/repo/pull/${n}`, body: shippedBody(n, head) };
    d.ci[head] = [{ name: 'free-tests', status: 'completed', conclusion: 'success' }];
  });
  readyReceipt(fx, n, head);
  return head;
}

function threePrs(fx: TrainFixture) {
  return ['1', '2', '3'].map(pr => openPr(fx, pr, { file: `lib/ship-${pr}.ts`, changelog: pr === '1' }));
}

/** A wave PR #10 whose head branch is the wave branch, with a /ship receipt and a READY receipt at its head. */
function waveAsPr(fx: TrainFixture, nonce: string, pr = '10', tip?: string): string {
  const head = tip ?? fx.repo.git('ls-remote', 'origin', `refs/heads/wave/${nonce}`).split(/\s/)[0]!;
  fx.repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/${pr}/head`);
  fx.write(d => { d.prs[pr] = { headRefOid: head, isCrossRepository: false, state: 'OPEN', headRefName: `wave/${nonce}`, url: `https://github.com/fixture/repo/pull/${pr}`, body: shippedBody(pr, head) }; });
  readyReceipt(fx, pr, head);
  return head;
}

describe('areas and grouping', () => {
  const skill = (dir: string) => dir === 'ship' || dir === 'review';
  test('areaKey maps skills, lib modules, tests, bins and docs to one functional area', () => {
    expect(areaKey('ship/SKILL.md.tmpl', skill)).toBe('ship');
    expect(areaKey('lib/ship-queue-train.ts', skill)).toBe('ship');
    expect(areaKey('test/ship-receipt.test.ts', skill)).toBe('ship');
    expect(areaKey('test/helpers/ship-queue-train-fixture.ts', skill)).toBe('ship');
    expect(areaKey('bin/gstack-pregate', skill)).toBe('pregate');
    expect(areaKey('lib/pregate/checks/guards.ts', skill)).toBe('pregate');
    expect(areaKey('docs/captain.md', skill)).toBe('docs');
    expect(areaKey('README.md', skill)).toBe('root');
  });

  test('groupWaves keeps PRs sharing a file together, packs one area into waves of at most max, leaves small groups solo and picks the largest PR as integrator', () => {
    const pr = (n: string, files: string[], lines = 10): PlanPr => ({ pr: n, head: n.repeat(40).slice(0, 40), files, lines });
    const areaOf = (f: string) => areaKey(f, () => false);
    const prs = [
      pr('1', ['lib/ship-a.ts']), pr('2', ['lib/ship-b.ts'], 90), pr('3', ['lib/ship-c.ts']), pr('4', ['lib/ship-d.ts']),
      pr('5', ['lib/ship-e.ts']), pr('6', ['lib/ship-f.ts']), pr('7', ['lib/ship-g.ts']),
      pr('8', ['docs/a.md']), pr('9', ['docs/b.md']),
      pr('11', ['lib/pregate-x.ts', 'docs/shared.md'], 5), pr('12', ['docs/shared.md', 'docs/c.md'], 50),
    ];
    const { groups, solo } = groupWaves(prs, areaOf, 3, 6);
    expect(groups.map(g => [g.area, g.prs.map(p => p.pr), g.integrator])).toEqual([
      ['docs', ['8', '9', '11', '12'], '12'],
      ['ship', ['1', '2', '3', '4', '5', '6'], '2'],
    ]);
    expect(solo).toEqual(['7']);
  });

  test('groupWaves links PRs through a shared code file or skill template only when the merge conflicts there, never through a hub file (GST-770)', () => {
    const pr = (n: string, files: string[]): PlanPr => ({ pr: n, head: n.repeat(40).slice(0, 40), files, lines: 10 });
    const areaOf = (f: string) => areaKey(f, d => d === 'ship');
    const linked = (files: string[], conflicts?: (a: PlanPr, b: PlanPr) => string[] | null) =>
      groupWaves([pr('1', ['lib/pregate-a.ts', 'test/pregate-a.test.ts', ...files]), pr('2', ['lib/review-b.ts', 'test/review-b.test.ts', ...files])], areaOf, 2, 6, conflicts).groups.map(g => g.prs.map(p => p.pr));
    expect(linked(['lib/ship-a.ts'])).toEqual([['1', '2']]);
    expect(linked(['lib/ship-a.ts'], () => ['lib/ship-a.ts'])).toEqual([['1', '2']]);
    expect(linked(['lib/ship-a.ts'], () => [])).toEqual([]);
    expect(linked(['ship/SKILL.md.tmpl'], () => ['ship/SKILL.md.tmpl'])).toEqual([['1', '2']]);
    for (const hub of ['docs/troubleshooting.md', 'ship/SKILL.md', 'scripts/harness-version.json']) expect(linked([hub], () => [hub])).toEqual([]);
    expect([isHubFile('docs/x.ts'), isHubFile('TODOS.md'), isHubFile('test/fixtures/x.json'), isHubFile('ship/SKILL.md.tmpl'), isHubFile('lib/x.ts')]).toEqual([true, true, true, false, false]);
  });

  test('groupWaves never splits a conflict cluster across waves, and a cluster over the wave maximum is oversize and stays whole (GST-770 follow-up)', () => {
    const pr = (n: number, file: string): PlanPr => ({ pr: String(n), head: String(n).repeat(40).slice(0, 40), files: [file], lines: 10 });
    const cluster = (from: number, to: number, file: string) => Array.from({ length: to - from + 1 }, (_, i) => pr(from + i, file));
    const plan = groupWaves([...cluster(1, 4, 'lib/ship-x.ts'), ...cluster(5, 8, 'lib/ship-y.ts'), ...cluster(9, 15, 'lib/ship-z.ts')], f => areaKey(f, () => false), 3, 6);
    expect(plan.groups.map(g => g.prs.map(p => p.pr))).toEqual([['1', '2', '3', '4'], ['5', '6', '7', '8']]);
    expect(plan.oversize.map(g => [g.area, g.prs.map(p => p.pr)])).toEqual([['ship', ['9', '10', '11', '12', '13', '14', '15']]]);
    expect(plan.solo).toEqual([]);
  });
});

describe('wave build', () => {
  test('merges each pin unchanged as a merge commit, records the wave on the notes ref, pushes the branch and posts one frozen notice per constituent', () => {
    const fx = make();
    const heads = threePrs(fx);
    const r = queue(fx, ['wave', 'build', '--area', 'ship', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]);
    expect(r.status).toBe(EXIT.ok);
    const nonce = nonceOf(r.out);
    expect(nonce).toMatch(/^ship-[0-9a-f]{12}$/);
    expect(line(r.out, 'PUSHED:')).toContain(`wave/${nonce}`);
    expect(line(r.out, 'NEXT:')).toContain('run /ship on it, then gstack-ship-queue ready --pr <wave pr>');
    const tip = fx.repo.git('ls-remote', 'origin', `refs/heads/wave/${nonce}`).split(/\s/)[0]!;
    fx.repo.git('fetch', '-q', 'origin', `refs/heads/wave/${nonce}`);
    const seconds = fx.repo.git('rev-list', '--first-parent', '--parents', `origin/main..${tip}`).split('\n').map(l => l.split(' ')[2]).reverse();
    expect(seconds).toEqual(heads);
    const w = waveJson(fx, nonce);
    expect([w.state, w.head, w.constituents.map((c: any) => c.head)]).toEqual(['pushed', tip, heads]);
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains')).not.toBe('');
    const prs = fx.read().prs as Record<string, any>;
    for (const pr of ['1', '2', '3']) expect(prs[pr].comments.map((c: any) => c.body).join('\n')).toContain(`gstack-wave:${nonce}:frozen`);
    const again = queue(fx, ['wave', 'build', '--wave', nonce]);
    expect([again.status, line(again.out, 'WAVE:')]).toEqual([EXIT.ok, `WAVE: ${nonce} is pushed`]);
  }, 120_000);

  test('refuses a wave outside 3-6 PRs and a moved pin before writing anything', () => {
    const fx = make();
    const heads = threePrs(fx);
    const two = queue(fx, ['wave', 'build', '--prs', `1@${heads[0]},2@${heads[1]}`]);
    expect([two.status, two.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_SIZE')]);
    fx.write(d => { (d.prs['2'] as any).headRefOid = heads[0]; });
    const moved = queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]);
    expect([moved.status, moved.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_MOVED')]);
    fx.write(d => { Object.assign(d.prs['2'] as any, { headRefOid: heads[1], baseRefName: 'pr-1' }); });
    const stacked = queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]);
    expect([stacked.status, stacked.err]).toEqual([EXIT.refused, expect.stringContaining('#2 targets pr-1, not main')]);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'waves'))).toBe(false);
  }, 120_000);

  test('a conflict stops in a worktree; --continue adopts the committed resolution and finishes the chain', () => {
    const fx = make();
    const h1 = openPr(fx, '1', { file: 'lib/ship-a.ts' });
    const h2 = openPr(fx, '2', { file: 'lib/ship-shared.ts', text: 'two\n', changelog: false });
    const h3 = openPr(fx, '3', { file: 'lib/ship-shared.ts', text: 'three\n', changelog: false });
    const r = queue(fx, ['wave', 'build', '--prs', `1@${h1},2@${h2},3@${h3}`]);
    expect([r.status, r.err]).toEqual([EXIT.fail, expect.stringContaining('(QUEUE_WAVE_CONFLICT')]);
    const nonce = nonceOf(r.out);
    const worktree = line(r.out, 'WORKTREE:').split(' ')[1]!;
    expect(waveJson(fx, nonce).state).toBe('conflict');
    expect(fx.repo.git('ls-remote', 'origin', `refs/heads/wave/${nonce}`)).toBe('');
    const early = queue(fx, ['wave', 'build', '--wave', nonce, '--continue']);
    expect([early.status, early.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_CONFLICT')]);
    fs.writeFileSync(path.join(worktree, 'lib/ship-shared.ts'), 'two\nthree\n');
    gitIn(fx, worktree, 'add', '-A');
    expect(gitIn(fx, worktree, 'commit', '-q', '--no-edit').status).toBe(0);
    const done = queue(fx, ['wave', 'build', '--wave', nonce, '--continue']);
    expect(done.status).toBe(EXIT.ok);
    expect(done.out).toContain('RESOLVED: #3');
    expect(fs.existsSync(worktree)).toBe(false);
    const status = queue(fx, ['wave', 'status', '--wave', nonce]);
    expect(line(status.out, 'CHAIN:')).toContain('ok at');
    expect(line(status.out, 'CHAIN:')).toContain('3 constituent merges');
    const head = waveAsPr(fx, nonce);
    const merge = fx.repo.git('commit-tree', `${head}^{tree}`, '-p', 'origin/main', '-m', 'wave (#10)');
    fx.repo.git('push', '-q', 'origin', `${merge}:refs/heads/main`);
    fx.write(d => { Object.assign(d.prs['10'] as any, { state: 'MERGED', mergeCommit: { oid: merge } }); });
    expect(queue(fx, ['wave', 'settle', '--wave', nonce]).status).toBe(EXIT.ok);
    const prs = fx.read().prs as Record<string, any>;
    expect(prs['3'].comments.at(-1).body).toContain('(merge of #3, resolved by hand: lib/ship-shared.ts)');
    expect(prs['2'].comments.at(-1).body).toContain('(merge of #3, resolved by hand: lib/ship-shared.ts)');
    expect(prs['1'].comments.at(-1).body).toContain("Integrator changes touching this PR's files: none.");
  }, 180_000);

  test('--drop builds a new wave on a new branch and supersedes the old one; a dropped pin another pin contains is refused', () => {
    const fx = make();
    const heads = [...threePrs(fx), openPr(fx, '4', { file: 'lib/ship-4.ts', changelog: false })];
    const h5 = openPr(fx, '5', { file: 'lib/ship-5.ts', changelog: false, from: 'pr-4' });
    const first = queue(fx, ['wave', 'build', '--prs', [...heads, h5].map((h, i) => `${i + 1}@${h}`).join(',')]);
    expect(first.status).toBe(EXIT.ok);
    const old = nonceOf(first.out);
    const dry = queue(fx, ['wave', 'build', '--wave', old, '--drop', '5', '--dry-run']);
    expect([dry.status, dry.out]).toEqual([EXIT.ok, expect.stringContaining('DRY-RUN: no record written')]);
    expect(waveJson(fx, old).state).toBe('pushed');
    const dependent = queue(fx, ['wave', 'build', '--wave', old, '--drop', '4']);
    expect([dependent.status, dependent.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_DEPENDENT')]);
    const dropped = queue(fx, ['wave', 'build', '--wave', old, '--drop', '5']);
    expect(dropped.status).toBe(EXIT.ok);
    const fresh = /^WAVE: (\S+) area=/m.exec(dropped.out)![1]!;
    expect(fresh).not.toBe(old);
    expect(waveJson(fx, old)).toMatchObject({ state: 'superseded', superseded_by: fresh });
    expect(waveJson(fx, fresh).constituents.map((c: any) => c.pr)).toEqual(['1', '2', '3', '4']);
    expect(fx.repo.git('ls-remote', 'origin', `refs/heads/wave/${old}`)).not.toBe('');
  }, 120_000);

  test('a drop under the minimum releases the wave, and its other PRs are no longer refused as constituents', () => {
    const fx = make();
    const heads = threePrs(fx);
    const nonce = nonceOf(queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]).out);
    readyReceipt(fx, '1', heads[0]!);
    const held = queue(fx, ['train', 'build', '--prs', `1@${heads[0]}`, '--dry-run']);
    expect([held.status, held.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_DUPLICATE')]);
    waveAsPr(fx, nonce);
    const whileOpen = queue(fx, ['wave', 'build', '--wave', nonce, '--drop', '3']);
    expect([whileOpen.status, whileOpen.err]).toEqual([EXIT.refused, expect.stringContaining('wave PR #10 on wave/')]);
    fx.write(d => { (d.prs['10'] as any).state = 'CLOSED'; });
    const dropped = queue(fx, ['wave', 'build', '--wave', nonce, '--drop', '3']);
    expect([dropped.status, line(dropped.out, 'RELEASED:')]).toEqual([EXIT.ok, expect.stringContaining('#1,#2,#3 ride as single slots')]);
    expect(waveJson(fx, nonce).state).toBe('released');
    expect(queue(fx, ['train', 'build', '--prs', `1@${heads[0]}`, '--dry-run']).status).toBe(EXIT.ok);
    expect(queue(fx, ['wave', 'build', '--wave', nonce, '--release']).err).toContain('only a live wave is released');
  }, 120_000);
});

describe('ready and train build read the wave', () => {
  test('train build prints WAVE and CONSTITUENTS from a record rebuilt from notes, and refuses a moved constituent, a duplicate pin and an unknown wave branch', () => {
    const fx = make();
    const heads = threePrs(fx);
    const nonce = nonceOf(queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]).out);
    fs.rmSync(path.join(fx.state, 'ship-queue', 'waves'), { recursive: true });
    const head = waveAsPr(fx, nonce);
    const ok = queue(fx, ['train', 'build', '--prs', `10@${head}`, '--dry-run']);
    expect(ok.status).toBe(EXIT.ok);
    expect(line(ok.out, 'WAVE:')).toContain(`WAVE: ${nonce} area=`);
    expect(line(ok.out, 'CONSTITUENTS:')).toContain(`#1@${heads[0]!.slice(0, 12)},#2@${heads[1]!.slice(0, 12)},#3@${heads[2]!.slice(0, 12)}`);
    readyReceipt(fx, '1', heads[0]!);
    const dup = queue(fx, ['train', 'build', '--prs', `10@${head},1@${heads[0]}`, '--dry-run']);
    expect([dup.status, dup.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_DUPLICATE')]);
    const alone = queue(fx, ['train', 'build', '--prs', `1@${heads[0]}`, '--dry-run']);
    expect([alone.status, alone.err]).toEqual([EXIT.refused, expect.stringContaining(`#1 is a constituent of live wave ${nonce}`)]);
    const stamp = fx.repo.git('commit-tree', `${head}^{tree}`, '-p', head, '-p', 'origin/main', '-m', 'stamp');
    const stamped = queue(fx, ['train', 'build', '--prs', `10@${waveAsPr(fx, nonce, '10', stamp)}`, '--dry-run']);
    expect([stamped.status, line(stamped.out, 'WAVE:')]).toEqual([EXIT.ok, expect.stringContaining(`WAVE: ${nonce}`)]);
    const offBase = fx.repo.git('commit-tree', `${head}^{tree}`, '-p', head, '-p', heads[0]!, '-m', 'not a stamp');
    const foreign = queue(fx, ['train', 'build', '--prs', `10@${waveAsPr(fx, nonce, '10', offBase)}`, '--dry-run']);
    expect([foreign.status, foreign.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_MOVED')]);
    waveAsPr(fx, nonce);
    fx.write(d => { (d.prs['2'] as any).headRefOid = heads[0]; });
    const moved = queue(fx, ['train', 'build', '--prs', `10@${head}`, '--dry-run']);
    expect([moved.status, moved.err]).toEqual([EXIT.refused, expect.stringContaining('#2 moved')]);
    expect(moved.err).toContain('(QUEUE_WAVE_MOVED');
    fx.write(d => { (d.prs['10'] as any).headRefName = 'wave/nope-000000000000'; });
    const unknown = queue(fx, ['train', 'build', '--prs', `10@${head}`, '--dry-run']);
    expect([unknown.status, unknown.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_UNKNOWN')]);
  }, 180_000);

  test('ready on the wave PR adds WAVE and CONSTITUENTS to the READY block and refuses once a constituent moves', () => {
    const fx = make();
    const heads = threePrs(fx);
    const nonce = nonceOf(queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]).out);
    const head = waveAsPr(fx, nonce);
    fx.repo.git('checkout', '-q', '-B', 'wave-local', head);
    fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
    const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const ok = queue(fx, ['ready', '--pr', '10', '--pregate', pregate, '--no-screen']);
    expect(ok.status).toBe(EXIT.ok);
    expect(line(ok.out, 'WAVE:')).toContain(`WAVE: ${nonce} area=`);
    expect(line(ok.out, 'CONSTITUENTS:')).toContain('(heads frozen; fixes go on the wave branch)');
    fx.write(d => { (d.prs['3'] as any).headRefOid = heads[0]; });
    const moved = queue(fx, ['ready', '--pr', '10', '--pregate', pregate, '--no-screen']);
    expect([moved.status, moved.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_MOVED')]);
  }, 180_000);

  test('train build handed more than 6 pins prints WAVE_ADVISED, and wave plan groups the live READY PRs', () => {
    const fx = make();
    const pins = ['1', '2', '3', '4', '5', '6', '7'].map(pr => {
      const h = openPr(fx, pr, { file: pr === '7' ? 'docs/seven.md' : `lib/ship-${pr}.ts`, changelog: false });
      readyReceipt(fx, pr, h);
      fx.write(d => { d.ci[h] = [{ name: 'free-tests', status: 'completed', conclusion: 'success' }]; });
      return `${pr}@${h}`;
    });
    const build = queue(fx, ['train', 'build', '--prs', pins.join(','), '--dry-run']);
    expect(line(build.out, 'WAVE_ADVISED:')).toContain('7 READY PRs over the wave trigger 6');
    const plan = queue(fx, ['wave', 'plan']);
    expect(plan.status).toBe(EXIT.ok);
    expect(line(plan.out, 'QUEUE:')).toContain('7 live READY PR(s)');
    expect(line(plan.out, 'WAVE_GROUP:')).toContain('area=ship prs=#1,#2,#3,#4,#5,#6');
    expect(line(plan.out, 'SOLO:')).toContain('#7');
    expect(line(queue(fx, ['wave', 'plan', '--trigger', '7']).out, 'WAVE:')).toContain('not needed');
  }, 180_000);

  test('wave plan links PRs only on a real code conflict, so hub docs and ledgers do not chain areas together, and leaves out READY heads whose CI is not green (GST-770)', () => {
    const fx = make();
    const moved = (first: string) => Array.from({ length: 10 }, (_, i) => i === 0 && first ? `export const o0 = '${first}';\n` : `export const o${i} = ${i};\n`).join('');
    const seed = { 'docs/troubleshooting.md': '# Troubleshooting\n', 'test/fixtures/ledger.json': '{}\n', 'lib/ship-a.ts': 'export const a = 0;\n', 'lib/ship-old.ts': moved('') };
    fx.repo.git('checkout', '-q', 'origin/main', '-B', 'seed');
    for (const [f, t] of Object.entries(seed)) { fs.mkdirSync(path.dirname(path.join(fx.repo.work, f)), { recursive: true }); fs.writeFileSync(path.join(fx.repo.work, f), t); }
    fx.repo.git('add', '-A');
    fx.repo.git('commit', '-q', '-m', 'seed hub files');
    fx.repo.git('push', '-q', 'origin', 'HEAD:main');
    fx.repo.git('fetch', '-q', 'origin');
    const pr = (n: string, area: string, extra: Record<string, string | null> = {}, ci = 'success') => {
      fx.repo.git('checkout', '-q', 'origin/main', '-B', `pr-${n}`);
      const files = { [`lib/${area}-${n}.ts`]: `export const x${n} = 1;\n`, [`test/${area}-${n}.test.ts`]: `// #${n}\n`,
        'docs/troubleshooting.md': `# Troubleshooting\n\n## #${n}\n`, 'test/fixtures/ledger.json': `{ "pr": ${n} }\n`, ...extra };
      for (const [f, t] of Object.entries(files)) if (t === null) fs.rmSync(path.join(fx.repo.work, f)); else fs.writeFileSync(path.join(fx.repo.work, f), t);
      fx.repo.git('add', '-A');
      fx.repo.git('commit', '-q', '-m', `feat #${n}`);
      const head = fx.repo.git('rev-parse', 'HEAD');
      fx.repo.git('push', '-q', '-f', 'origin', `HEAD:refs/pull/${n}/head`);
      fx.write(d => {
        d.prs[n] = { headRefOid: head, isCrossRepository: false, state: 'OPEN', headRefName: `pr-${n}`, url: `https://github.com/fixture/repo/pull/${n}`, body: shippedBody(n, head) };
        d.ci[head] = [{ name: 'free-tests', status: 'completed', conclusion: ci }];
      });
      readyReceipt(fx, n, head);
    };
    pr('1', 'ship', { 'lib/ship-a.ts': Array.from({ length: 40 }, (_, i) => `export const a${i} = 'one';\n`).join('') });
    pr('2', 'ship', { 'lib/ship-old.ts': null, 'lib/ship-new.ts': moved('two') });
    pr('3', 'ship');
    for (const n of ['4', '5', '6']) pr(n, 'pregate');
    pr('8', 'review', { 'lib/ship-a.ts': "export const a = 'eight';\n" });
    pr('9', 'pregate', {}, 'failure');
    pr('10', 'pregate');
    pr('11', 'pregate', { 'lib/ship-old.ts': null, 'lib/ship-new.ts': moved('eleven') });
    fx.write(d => { d.ci[(d.prs['10'] as any).headRefOid] = [{ name: 'free-tests', status: 'in_progress', conclusion: null }]; });
    const plan = queue(fx, ['wave', 'plan']);
    expect(plan.status).toBe(EXIT.ok);
    expect(plan.out.split('\n').filter(l => l.startsWith('NOT_GREEN:')).map(l => l.replace(/ at [0-9a-f]{12} .*/, ''))).toEqual(['NOT_GREEN: #9 (red', 'NOT_GREEN: #10 (pending']);
    expect(line(plan.out, 'QUEUE:')).toContain('8 live READY PR(s)');
    expect(plan.out.split('\n').filter(l => l.startsWith('WAVE_GROUP:'))).toEqual([
      'WAVE_GROUP: area=pregate prs=#4,#5,#6 integrator=#4 (most changed lines)',
      'WAVE_GROUP: area=ship prs=#1,#8,#2,#11,#3 integrator=#1 (most changed lines)',
    ]);
    expect(line(plan.out, 'SOLO:')).toBe('');
    fx.write(d => { d.ciFail = [(d.prs['4'] as any).headRefOid]; });
    const unread = queue(fx, ['wave', 'plan']);
    expect([unread.status, unread.err]).toEqual([EXIT.fail, expect.stringContaining('(QUEUE_PROOF_MISSING')]);
    expect(unread.err).toContain('#4 (CI unknown at');
  }, 180_000);

  test('wave plan leaves out a READY head that conflicts with main as NOT_MERGEABLE, and keeps one whose only conflict is the CHANGELOG the train merges (GST-770 follow-up)', () => {
    const fx = make();
    seedMain(fx, { 'lib/ship-a.ts': 'export const a = 0;\n' });
    const changelog = (entry: string) => fx.repo.git('show', 'origin/main:CHANGELOG.md').replace('# Changelog\n', `# Changelog\n\n## [Unreleased]\n\n- ${entry}\n`) + '\n';
    const conflicting = readyPr(fx, '1', { 'lib/ship-a.ts': "export const a = 'one';\n" });
    readyPr(fx, '2', { 'lib/ship-b.ts': 'export const b = 2;\n', 'CHANGELOG.md': changelog('#2 change') });
    seedMain(fx, { 'lib/ship-a.ts': "export const a = 'main';\n", 'CHANGELOG.md': changelog('a change that landed first') }, 'main moves');
    const plan = queue(fx, ['wave', 'plan']);
    expect([plan.status, plan.err]).toEqual([EXIT.ok, '']);
    expect(plan.out.split('\n').filter(l => l.startsWith('NOT_MERGEABLE:'))).toEqual([
      `NOT_MERGEABLE: #1 (conflicts with origin/main at ${conflicting.slice(0, 12)} in lib/ship-a.ts; left out until the head merges cleanly onto main)`,
    ]);
    expect(line(plan.out, 'QUEUE:')).toContain('1 live READY PR(s)');
  }, 180_000);

  test('wave plan links a rename with an edit of the old path that conflicts with it, not with an edit that merges cleanly, and prints a cluster over --max as WAVE_OVERSIZE with no build command (GST-770 follow-up)', () => {
    const fx = make();
    const body = (first = '', last = '') => Array.from({ length: 10 }, (_, i) => i === 0 && first ? `export const o0 = '${first}';\n` : i === 9 && last ? `export const o9 = '${last}';\n` : `export const o${i} = ${i};\n`).join('');
    seedMain(fx, { 'lib/ship-old.ts': body() });
    readyPr(fx, '1', { 'lib/ship-old.ts': null, 'lib/ship-new.ts': body('one') });
    readyPr(fx, '2', { 'lib/ship-old.ts': body('two'), 'lib/review-2.ts': 'export const r = 2;\n', 'test/review-2.test.ts': '// #2\n' });
    readyPr(fx, '3', { 'lib/ship-old.ts': body('', 'three'), 'lib/pregate-3.ts': 'export const p = 3;\n', 'test/pregate-3.test.ts': '// #3\n' });
    const plan = queue(fx, ['wave', 'plan', '--trigger', '1', '--min', '2']);
    expect([plan.status, plan.err]).toEqual([EXIT.ok, '']);
    expect(plan.out.split('\n').filter(l => l.startsWith('WAVE_GROUP:'))).toEqual(['WAVE_GROUP: area=ship prs=#1,#2 integrator=#1 (most changed lines)']);
    expect(line(plan.out, 'SOLO:')).toBe('SOLO: #3 (no area group of 2+; they ride as single slots)');
    const small = queue(fx, ['wave', 'plan', '--trigger', '1', '--min', '1', '--max', '1']);
    expect([small.status, small.err]).toEqual([EXIT.ok, '']);
    const rows = small.out.split('\n');
    const at = rows.findIndex(l => l.startsWith('WAVE_OVERSIZE:'));
    expect(rows[at]).toBe('WAVE_OVERSIZE: area=ship prs=#1,#2 (2 PRs whose changes conflict, over the wave maximum 1; kept whole with no build command: land part of it as single slots, then run wave plan again)');
    expect(rows[at + 1]).not.toContain('build:');
    expect(rows.filter(l => l.startsWith('WAVE_GROUP:'))).toEqual(['WAVE_GROUP: area=pregate prs=#3 integrator=#3 (most changed lines)']);
  }, 180_000);
});

describe('wave settle', () => {
  test('closes constituents still at their pins with the link, leaves a moved one open with a comment, and is idempotent', () => {
    const fx = make();
    const heads = threePrs(fx);
    const nonce = nonceOf(queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]).out);
    const head = waveAsPr(fx, nonce);
    const early = queue(fx, ['wave', 'settle', '--wave', nonce]);
    expect([early.status, early.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_NOT_MERGED')]);
    const elsewhere = fx.repo.git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'merged into staging');
    fx.repo.git('push', '-q', 'origin', `${elsewhere}:refs/heads/staging`);
    fx.write(d => { Object.assign(d.prs['10'] as any, { state: 'MERGED', baseRefName: 'staging', mergeCommit: { oid: elsewhere } }); });
    const staging = queue(fx, ['wave', 'settle', '--wave', nonce]);
    expect([staging.status, staging.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_NOT_MERGED')]);
    expect((fx.read().prs as any)['1'].state).toBe('OPEN');
    fx.write(d => { Object.assign(d.prs['10'] as any, { state: 'OPEN', baseRefName: 'main', mergeCommit: null }); });
    const s1 = fx.repo.git('commit-tree', `${head}^{tree}`, '-p', head, '-p', 'origin/main', '-m', 'stamp 1');
    const s2 = waveAsPr(fx, nonce, '10', fx.repo.git('commit-tree', `${head}^{tree}`, '-p', s1, '-p', 'origin/main', '-m', 'stamp 2'));
    const merge = fx.repo.git('commit-tree', `${s2}^{tree}`, '-p', 'origin/main', '-m', 'wave (#10)');
    fx.repo.git('push', '-q', 'origin', `${merge}:refs/heads/main`);
    fx.write(d => { Object.assign(d.prs['10'] as any, { state: 'MERGED', mergeCommit: { oid: merge } }); (d.prs['2'] as any).headRefOid = heads[0]; });
    const dry = queue(fx, ['wave', 'settle', '--wave', nonce, '--dry-run']);
    expect(dry.out).toContain('DRY-RUN: nothing commented or closed');
    expect((fx.read().prs as any)['1'].state).toBe('OPEN');
    const r = queue(fx, ['wave', 'settle', '--wave', nonce]);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('SETTLED: #1 landed-closed');
    expect(r.out).toContain('SETTLED: #2 moved-left-open');
    const prs = fx.read().prs as Record<string, any>;
    expect([prs['1'].state, prs['2'].state, prs['3'].state]).toEqual(['CLOSED', 'OPEN', 'CLOSED']);
    expect(prs['1'].comments.at(-1).body).toContain('Landed in wave #10 as v1.2.3.0');
    expect(prs['2'].comments.at(-1).body).toContain('did not land');
    const count = prs['2'].comments.length;
    const again = queue(fx, ['wave', 'settle', '--wave', nonce]);
    expect(again.out).toContain('SETTLED: #1 skipped (closed)');
    expect((fx.read().prs as any)['2'].comments.length).toBe(count);
    expect(waveJson(fx, nonce).state).toBe('settled');
    expect(waveJson(fx, nonce).settled.map((s: any) => s.pr).sort()).toEqual(['1', '2', '3']);
  }, 180_000);

  test('settles a wave the train merged directly onto a main that moved after the build, and still refuses a merge that lost the wave', () => {
    const fx = make();
    const heads = threePrs(fx);
    const nonce = nonceOf(queue(fx, ['wave', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]).out);
    const head = waveAsPr(fx, nonce);
    const other = openPr(fx, '4', { file: 'lib/ship-4.ts', changelog: false });
    const moved = fx.repo.git('commit-tree', `${other}^{tree}`, '-p', 'origin/main', '-m', 'an earlier slot (#4)');
    const lost = fx.repo.git('commit-tree', `${moved}^{tree}`, '-p', moved, '-m', 'wave (#10) without its content');
    fx.repo.git('push', '-q', 'origin', `${lost}:refs/heads/main`);
    fx.write(d => { Object.assign(d.prs['10'] as any, { state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: lost } }); });
    const refused = queue(fx, ['wave', 'settle', '--wave', nonce]);
    expect([refused.status, refused.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_WAVE_NOT_MERGED')]);
    const tree = fx.repo.git('merge-tree', '--write-tree', moved, head).split('\n')[0]!;
    const squash = fx.repo.git('commit-tree', tree, '-p', moved, '-m', 'wave (#10)');
    fx.repo.git('push', '-q', '-f', 'origin', `${squash}:refs/heads/main`);
    fx.write(d => { Object.assign(d.prs['10'] as any, { mergeCommit: { oid: squash } }); });
    const r = queue(fx, ['wave', 'settle', '--wave', nonce]);
    expect([r.status, r.err]).toEqual([EXIT.ok, '']);
    expect(r.out).toContain('SETTLED: #1 landed-closed');
    const prs = fx.read().prs as Record<string, any>;
    expect([prs['1'].state, prs['2'].state, prs['3'].state]).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);
  }, 180_000);
});

test('wave with no subcommand prints the wave help and exits usage', () => {
  const fx = make();
  const r = queue(fx, ['wave']);
  expect([r.status, r.out]).toEqual([EXIT.usage, WAVE_HELP + '\n']);
}, 60_000);
