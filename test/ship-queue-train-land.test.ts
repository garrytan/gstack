/**
 * Stamped trains (changelog_fragments; GSTA-154 PR B): train build makes S_1..S_k beside T_1..T_k and gates
 * S_k; train land publishes each slot's S_i exactly (a tool-made stamp commit on [pin, main], pushed under
 * the pin's lease, labelled evals-no-debounce), confirms main is S_i, and freezes on any other main.
 * Fixture repos with a bare origin and the train gh shim, wrapped for pr edit, pr merge and the PR's checks.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup } from './helpers/restamp-fixture';
import {
  GREEN_GATE, RED_GATE, TRAIN_POLICY, line, nonceOf, openPr, queue, readyReceipt, shippedBody, trainFixture, trainJson, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const POLICY = { ...TRAIN_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' };
const fixtures: TrainFixture[] = [];
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

/** pr view reads the head from origin's branch; pr edit and pr merge act on origin; any commit without recorded CI reads green. */
function wrap(fx: TrainFixture): void {
  const dir = path.join(fx.repo.root, 'gh-land-wrap');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(fx.repo.root, 'gh-train-shim', 'shim.js');
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    "const fs=require('fs');const cp=require('child_process');const D=process.env.LAND_WRAP_DATA;const a=process.argv.slice(2);",
    "const d=JSON.parse(fs.readFileSync(D,'utf8'));const save=()=>fs.writeFileSync(D,JSON.stringify(d));",
    "const g=(...x)=>cp.execFileSync('git',['--git-dir',d.origin,...x],{encoding:'utf8',timeout:30000}).trim();",
    "const rev=r=>{try{return g('rev-parse','--verify','--quiet',r)}catch{return ''}};",
    "if(a[0]==='pr'&&a[1]==='view'&&d.prs[a[2]]){const p=d.prs[a[2]];const h=rev('refs/heads/'+p.headRefName);if(h)p.headRefOid=h;save();console.log(JSON.stringify(p));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='edit'){(d.labels=d.labels||{})[a[2]]=a[a.indexOf('--add-label')+1];save();process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='merge'){const p=d.prs[a[2]];const want=a[a.indexOf('--match-head-commit')+1];if(rev('refs/heads/'+p.headRefName)!==want){console.error('Head branch was modified');process.exit(1)}",
    "  const before=rev('main');let tree=rev(want+'^{tree}');",
    "  if(d.outsideOnMerge){const blob=cp.execFileSync('git',['--git-dir',d.origin,'hash-object','-w','--stdin'],{input:'outside\\n',encoding:'utf8',timeout:30000}).trim();",
    "    const ls=g('ls-tree',before+'^{tree}')+'\\n100644 blob '+blob+'\\toutside.txt';const ot=cp.execFileSync('git',['--git-dir',d.origin,'mktree'],{input:ls+'\\n',encoding:'utf8',timeout:30000}).trim();",
    "    g('update-ref','refs/heads/main',g('commit-tree',ot,'-p',before,'-m','outside'));tree=g('merge-tree','--write-tree','--merge-base='+before,rev('main'),want).split('\\n')[0];d.outsideOnMerge=false}",
    "  g('update-ref','refs/heads/main',g('commit-tree',tree,'-p',rev('main'),'-m','squash #'+a[2]));p.state='MERGED';save();process.exit(0)}",
    "const paged=/commits\\/([0-9a-f]+)\\/(check-runs|status)\\?.*page=(\\d+)/.exec(a[1]||'');",
    "if(a[0]==='api'&&paged&&!(d.ci||{})[paged[1]]&&!((d.statuses||{})[paged[1]])){const list=paged[2]==='check-runs'?[{name:'free-tests',status:'completed',conclusion:'success',id:1,completed_at:'2026-10-26T00:00:00Z'}]:[];const key=paged[2]==='check-runs'?'check_runs':'statuses';console.log(JSON.stringify(paged[3]==='1'?{total_count:list.length,state:'success',[key]:list}:{total_count:list.length,[key]:[]}));process.exit(0)}",
    `const r=cp.spawnSync('node',[${JSON.stringify(shim)},D,...a],{stdio:'inherit',timeout:120000});process.exit(r.status??1);`,
    '',
  ].join('\n'), { mode: 0o755 });
  fx.env.PATH = `${dir}:${fx.env.PATH}`;
  (fx.env as Record<string, string>).LAND_WRAP_DATA = fx.dataFile;
}

function fragmentPr(fx: TrainFixture, pr: string, fragment = `- #${pr} change\n`): string {
  const head = openPr(fx, pr, { file: `changelog.d/pr-${pr}.md`, text: fragment, changelog: false });
  fx.repo.git('push', '-q', 'origin', `${head}:refs/heads/pr-${pr}`);
  readyReceipt(fx, pr, head);
  return head;
}
function stampedTrain(gate = GREEN_GATE, policy: Record<string, unknown> = POLICY) {
  const fx = trainFixture(policy, 'gstack-train-land-'); fixtures.push(fx); wrap(fx);
  const h1 = fragmentPr(fx, '1');
  const h2 = fragmentPr(fx, '2', '---\nbump: minor\n---\n- #2 change\n');
  fx.write(d => { d.rules['evals.yml'] = gate; });
  const built = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]);
  const nonce = nonceOf(built.out);
  return { fx, h1, h2, built, nonce };
}
const land = (fx: TrainFixture, nonce: string, pr: string) => queue(fx, ['train', 'land', '--train', nonce, '--pr', pr, '--no-wait']);
const originMain = (fx: TrainFixture) => fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main');

describe('stamped trains: build and land', () => {
  test('build records S1, S2 and gates S2; land publishes each slot exactly, with the label, and records the merge', () => {
    const { fx, h1, h2, built, nonce } = stampedTrain();
    expect(built.status, built.err).toBe(EXIT.ok);
    expect(built.out).toMatch(/^S1: #1 v1\.2\.4\.0 [0-9a-f]{12} /m);
    expect(built.out).toMatch(/^S2: #2 v1\.3\.0\.0 [0-9a-f]{12} /m);
    const t = trainJson(fx, nonce);
    expect(t.stamped.map((s: any) => [s.pr, s.version])).toEqual([['1', '1.2.4.0'], ['2', '1.3.0.0']]);
    expect(t.head).toBe(t.stamped[1].commit);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);

    const verify = queue(fx, ['verify', '--pr', '1', '--train', nonce]);
    expect(verify.err).toMatch(/has stamped prefixes.*\(QUEUE_GATE_MISSING\)/);
    expect(line(verify.out, 'NEXT:')).toBe(`NEXT: gstack-ship-queue train land --train ${nonce} --pr 1`);
    const early = land(fx, nonce, '2');
    expect(early.err).toMatch(/main is the train base; land #1 \(slot 1\) first.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);
    const pushed = land(fx, nonce, '1');
    expect(pushed.out, pushed.err).toContain('LABEL: evals-no-debounce added');
    const stamp = /^PUSHED: ([0-9a-f]{40})/m.exec(pushed.out)![1]!;
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'refs/heads/pr-1')).toBe(stamp);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-list', '--parents', '-n', '1', stamp).split(' ').slice(1)).toEqual([h1, originMain(fx)]);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', stamp + '^{tree}')).toBe(t.stamped[0].tree);
    const merged = land(fx, nonce, '1');
    expect(merged.status, merged.err).toBe(EXIT.ok);
    expect(merged.out).toContain("main's tree is S1 exactly");
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main^{tree}')).toBe(t.stamped[0].tree);
    land(fx, nonce, '2');
    const second = land(fx, nonce, '2');
    expect(second.status, second.err).toBe(EXIT.ok);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'show', 'main:VERSION')).toBe('1.3.0.0');
    expect(trainJson(fx, nonce)).toMatchObject({ state: 'merged' });
    expect(fx.read().prs['2']).toMatchObject({ state: 'MERGED' });
    expect((fx.read() as any).labels).toEqual({ 1: 'evals-no-debounce', 2: 'evals-no-debounce' });
    void h2;
  }, 300_000);

  test('a foreign push to the PR branch is never overwritten; a merge outside the train freezes the queue', () => {
    const { fx, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    fx.repo.git('push', '-q', '-f', 'origin', 'origin/main:refs/heads/pr-1');
    const moved = land(fx, nonce, '1');
    expect(moved.err).toContain('(QUEUE_TRAIN_MOVED)');
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'refs/heads/pr-1')).toBe(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main'));

    const second = stampedTrain();
    expect(queue(second.fx, ['train', 'verdict', '--train', second.nonce]).status).toBe(EXIT.ok);
    land(second.fx, second.nonce, '1');
    expect(land(second.fx, second.nonce, '1').status).toBe(EXIT.ok);
    land(second.fx, second.nonce, '2');
    second.fx.write(d => { (d as any).outsideOnMerge = true; });
    const drift = land(second.fx, second.nonce, '2');
    expect(drift.err).toContain('(QUEUE_TRAIN_TREE_MISMATCH)');
    expect(line(drift.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1/);
  }, 300_000);

  test('a record that is not the gated head\'s first-parent chain (any slot\'s commit, tree or pin) pushes nothing, merges nothing and leaves the PR branch in place', () => {
    const { fx, h1, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const file = path.join(fx.state, 'ship-queue', 'trains', nonce, 'train.json');
    const t = trainJson(fx, nonce);
    const base = t.prefixes[0];
    const [s1, s2] = t.stamped;
    const forged = [
      { ...t, stamped: [{ ...s1, commit: h1, tree: fx.repo.git('rev-parse', h1 + '^{tree}') }, s2] },
      { ...t, stamped: [{ ...s1, tree: 'f'.repeat(40) }, s2] },
      { ...t, stamped: [{ ...s2 }, s2] },
      { ...t, stamped: [{ ...s1, index: 0, commit: base.commit, tree: base.tree }, s2] },
      { ...t, stamped: [s1, { ...s2, tree: base.tree }] },
      { ...t, stamped: [s1] },
      { ...t, slots: [{ ...t.slots[0], head: t.slots[1].head }, t.slots[1]] },
    ];
    for (const record of forged) {
      fs.writeFileSync(file, JSON.stringify(record));
      const r = land(fx, nonce, '1');
      expect(r.status).toBe(EXIT.refused);
      expect(r.err).toMatch(/are not the first-parent chain of the gated head.*\(QUEUE_PROOF_MISSING\)/);
      expect(r.out).not.toMatch(/^PUSHED:/m);
    }
    expect(fx.read().prs['1']).not.toMatchObject({ state: 'MERGED' });
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'refs/heads/pr-1')).toBe(h1);
  }, 180_000);

  test('a rerun after the stamp push but before the journal recognizes its own stamp and merges', () => {
    const { fx, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const pushed = land(fx, nonce, '1');
    const stamp = /^PUSHED: ([0-9a-f]{40})/m.exec(pushed.out)![1]!;
    fs.rmSync(path.join(fx.state, 'ship-queue', 'trains', nonce, 'land-1.json'));
    const resumed = land(fx, nonce, '1');
    expect(resumed.status, resumed.err).toBe(EXIT.ok);
    expect(resumed.out).toContain("main's tree is S1 exactly");
    expect(fx.read().prs['1']).toMatchObject({ state: 'MERGED' });
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'main^{tree}')).toBe(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', stamp + '^{tree}'));
  }, 300_000);

  test('a rerun after the journal but before the stamp push pushes the stamp instead of stopping', () => {
    const { fx, h1, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const stamp = /^PUSHED: ([0-9a-f]{40})/m.exec(land(fx, nonce, '1').out)![1]!;
    fx.repo.git('push', '-q', '-f', 'origin', `${h1}:refs/heads/pr-1`);
    const again = land(fx, nonce, '1');
    expect(again.err).not.toContain('QUEUE_TRAIN_MOVED');
    expect(again.out).toContain(`PUSHED: ${stamp}`);
    expect(land(fx, nonce, '1').status).toBe(EXIT.ok);
  }, 300_000);

  test('a slot landed out of order after an earlier slot merged refuses without freezing and names the next slot; a rerun of a landed slot confirms', () => {
    const fx = trainFixture(POLICY, 'gstack-train-land-'); fixtures.push(fx); wrap(fx);
    const heads = ['1', '2', '3'].map(pr => fragmentPr(fx, pr));
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', heads.map((h, i) => `${i + 1}@${h}`).join(',')]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    land(fx, nonce, '1');
    expect(land(fx, nonce, '1').status).toBe(EXIT.ok);
    const early = land(fx, nonce, '3');
    expect(early.err).toMatch(/main is S1; land #2 \(slot 2\) first.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);
    expect(early.out).not.toMatch(/^QUEUE_TRAIN_FROZEN:/m);
    expect(line(early.out, 'NEXT:')).toBe(`NEXT: gstack-ship-queue train land --train ${nonce} --pr 2`);
    land(fx, nonce, '2');
    expect(land(fx, nonce, '2').status).toBe(EXIT.ok);
    const rerun = land(fx, nonce, '1');
    expect(rerun.status, rerun.err).toBe(EXIT.ok);
    expect(rerun.out).toContain('is S2, past S1');
    expect(rerun.out).not.toMatch(/^QUEUE_TRAIN_FROZEN:/m);
  }, 300_000);

  test('a failed stamp push with the branch still at the pin fails retryably instead of reporting a move', () => {
    const { fx, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const hook = path.join(fx.repo.origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failed = land(fx, nonce, '1');
    expect(failed.err).toMatch(/the stamp push failed and pr-1 still reads.*\(QUEUE_NOT_READY\)/);
    expect(failed.err).not.toContain('QUEUE_TRAIN_MOVED');
    fs.rmSync(hook);
    expect(land(fx, nonce, '1').out).toMatch(/^PUSHED: [0-9a-f]{40}/m);
  }, 300_000);

  test('a required check that never reported on the stamp commit holds the merge and names the check', () => {
    const { fx, nonce } = stampedTrain(GREEN_GATE, { ...POLICY, changelog_fragments: { dir: 'changelog.d', required_checks: ['free-tests', 'windows-free-shard'] } });
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const stamp = /^PUSHED: ([0-9a-f]{40})/m.exec(land(fx, nonce, '1').out)![1]!;
    const held = land(fx, nonce, '1');
    expect(held.err).toMatch(/required checks missing or not green on the stamp commit \S+: windows-free-shard; fix: wait for windows-free-shard to pass on \S+ \(dispatch the workflow on pr-1 if it never ran\).*\(QUEUE_NOT_READY\)/);
    expect(held.out).toContain(`REQUIRED_CHECKS: not green at ${stamp.slice(0, 12)}: windows-free-shard`);
    expect(line(held.out, 'NEXT:')).toMatch(/^NEXT: wait for windows-free-shard to pass on /);
    expect(fx.read().prs['1']).not.toMatchObject({ state: 'MERGED' });
  }, 300_000);

  test('a PR retargeted off the train base refuses before any push', () => {
    const { fx, h1, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    fx.write(d => { (d.prs['1'] as any).baseRefName = 'release'; });
    const r = land(fx, nonce, '1');
    expect(r.err).toMatch(/targets release, not main.*\(QUEUE_NOT_READY\)/);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'refs/heads/pr-1')).toBe(h1);
  }, 180_000);

  test('a red stamped train bisects its stamped chain: T0 and S1..Sk, each an ancestor of the train head', () => {
    const { fx, nonce } = stampedTrain(RED_GATE);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.fail);
    const dry = queue(fx, ['train', 'bisect', '--train', nonce, '--spend-cap', '5', '--dry-run']);
    expect(dry.err).not.toContain('QUEUE_TRAIN_PREFIX_INVALID');
    expect(dry.out).toContain('BISECT: cases c1 prefixes T0,T1,T2 need results');
  }, 180_000);

  test('the receipt check is the depth-checked one train build uses: a receipt whose writer records depth but which records none refuses, nothing pushed', () => {
    const { fx, h1, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    fx.write(d => { (d.prs['1'] as any).body = shippedBody('1', h1, { gstack_version: '1.91.307.0' }); });
    const r = land(fx, nonce, '1');
    expect(r.err).toContain('(QUEUE_RECEIPT_DEPTH_RAISED)');
    expect(r.out).toMatch(/^REVIEW_DEPTH: receipt=none required=/m);
    expect(fx.repo.git('--git-dir', fx.repo.origin, 'rev-parse', 'refs/heads/pr-1')).toBe(h1);
  }, 180_000);

  test('a plain train refuses train land and keeps the slot-stamp path', () => {
    const fx = trainFixture(TRAIN_POLICY, 'gstack-train-land-'); fixtures.push(fx); wrap(fx);
    const h1 = openPr(fx, '1');
    readyReceipt(fx, '1', h1);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', `1@${h1}`, '--urgent']).out);
    expect(trainJson(fx, nonce).stamped).toBeUndefined();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const r = land(fx, nonce, '1');
    expect(r.err).toMatch(/was built without stamped prefixes.*\(QUEUE_GATE_MISSING\)/);
  }, 180_000);
});

describe('train land counts only merges GitHub reports (#3603)', () => {
  const trainPath = (fx: TrainFixture, nonce: string) => path.join(fx.state, 'ship-queue', 'trains', nonce, 'train.json');
  const landFirst = (fx: TrainFixture, nonce: string) => { land(fx, nonce, '1'); expect(land(fx, nonce, '1').status).toBe(EXIT.ok); };

  test('a record with its slot PRs swapped never confirms the open PR as merged', () => {
    const { fx, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    landFirst(fx, nonce);
    const t = trainJson(fx, nonce);
    fs.writeFileSync(trainPath(fx, nonce), JSON.stringify({ ...t, slots: [{ ...t.slots[0], pr: '2' }, { ...t.slots[1], pr: '1' }] }));
    const r = land(fx, nonce, '2');
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/GitHub reports #2 as OPEN, not MERGED.*\(QUEUE_PROOF_MISSING\)/);
    expect(r.out).not.toMatch(/^VERIFY_TRAIN: #2 merged/m);
    expect(fx.read().prs['2']).not.toMatchObject({ state: 'MERGED' });
    expect(trainJson(fx, nonce).merged.map((m: any) => m.pr)).toEqual(['1']);
  }, 300_000);

  test('a forged merged entry for an open slot does not mark the train merged', () => {
    const { fx, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    fs.writeFileSync(trainPath(fx, nonce), JSON.stringify({ ...t, merged: [{ pr: '2', sha: t.prefixes[0].commit, tree: t.prefixes[0].tree, at: '2026-10-29T00:00:00Z' }] }));
    landFirst(fx, nonce);
    const rerun = land(fx, nonce, '1');
    expect(rerun.out).toContain('(1/2 merged)');
    expect(trainJson(fx, nonce).state).toBe('merging');
  }, 300_000);

  test('a forged merged entry does not turn a pre-landing mismatch into a freeze', () => {
    const { fx, nonce } = stampedTrain();
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    fs.writeFileSync(trainPath(fx, nonce), JSON.stringify({ ...t, merged: [{ pr: '1', sha: t.prefixes[0].commit, tree: t.prefixes[0].tree, at: '2026-10-29T00:00:00Z' }] }));
    fx.repo.git('fetch', '-q', 'origin');
    fx.repo.git('checkout', '-q', '--detach', 'origin/main');
    fs.writeFileSync(path.join(fx.repo.work, 'outside.txt'), 'outside\n');
    fx.repo.git('add', 'outside.txt');
    fx.repo.git('commit', '-q', '-m', 'outside');
    fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    const r = land(fx, nonce, '1');
    expect(r.err).toMatch(/nothing of train \S+ merged, so the queue is not frozen.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);
    expect(r.out).not.toMatch(/^QUEUE_TRAIN_FROZEN:/m);
  }, 300_000);
});

