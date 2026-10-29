// Split from test/ship-queue-train.test.ts (GSTA-151): verify --train acceptance, prefix equality and the CHANGELOG rule before and after merge.
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeChangelogs, parseChangelog } from '../lib/changelog-check';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import { publishMain, twoPrTrain } from './helpers/ship-queue-train-cases';
import {
  GREEN_GATE, TRAIN_POLICY, dispatches, line, nonceOf, openPr, queue, readyReceipt, repoKey, setPrBody, shippedBody, trainFixture, trainJson,
  type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const next = (out: string) => line(out, 'NEXT:');

describe('verify, freeze, repair and clear', () => {
  test('verify accepts each merge only at prefix equality modulo stamps; an interrupted publication freezes the queue until one repair train lands', () => {
    const fx = make();
    const { h1, h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string, train = nonce) => queue(fx, ['verify', '--pr', pr, '--train', train], {}, coord);

    const pre1 = v('1');
    expect(pre1.status).toBe(EXIT.ok);
    expect(pre1.out).toContain(`VERIFY_TRAIN: #1 may merge as slot 1 of train ${nonce}`);
    expect(line(pre1.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h1}`);
    const early = v('2');
    expect(early.status).toBe(EXIT.fail);
    expect(early.err).toMatch(/is neither T1 nor T2 modulo stamps.*nothing of train \S+ merged, so the queue is not frozen.*\(QUEUE_TRAIN_TREE_MISMATCH\)/);

    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    const post1 = v('1');
    expect(post1.status).toBe(EXIT.ok);
    expect(post1.out).toMatch(/^main: [0-9a-f]{40} = T1 \(same modulo stamps \(1 stamp file\(s\)\)\)$/m);
    expect(post1.out).toContain(`VERIFY_TRAIN: #1 merged; main's tree is T1 of train ${nonce} (1/2 merged)`);
    expect(next(post1.out)).toBe(`NEXT: gstack-ship-queue verify --pr 2 --train ${nonce}`);
    expect(line(v('2').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h2}`);

    const broken = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'not in the train\n' });
    const mismatch = v('2');
    expect(mismatch.status).toBe(EXIT.fail);
    expect(mismatch.err).toContain('(QUEUE_TRAIN_TREE_MISMATCH)');
    expect(line(mismatch.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(new RegExp(`^QUEUE_TRAIN_FROZEN: train \\S+ merged #1; main ${broken.slice(0, 12)} tree [0-9a-f]{12}; backstop dispatched run \\d+ \\(nonce gate\\.backstop-`));
    const backstop = dispatches(fx, 'evals.yml').at(-1)!;
    expect([backstop.ref, (backstop.inputs as any).expected_sha, (backstop.inputs as any).evals_all]).toEqual(['main', broken, 'true']);
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8'))).toMatchObject({ kind: 'freeze', merged: ['1'], unmerged: [{ pr: '2', head: h2 }], cleared_at: null });

    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3);
    const ordinary = queue(fx, ['train', 'build', '--prs', `3@${h3}`, '--urgent']);
    expect(ordinary.status).toBe(EXIT.refused);
    expect(ordinary.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(next(ordinary.out)).toBe('NEXT: gstack-ship-queue train build --repair --prs <repair-pr>@<sha>');
    const fresh = path.join(fx.repo.root, 'fresh-state');
    expect(queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: fresh }, coord).out).toMatch(/^QUEUE_TRAIN_FROZEN: train /m);

    const repair = queue(fx, ['train', 'build', '--repair', '--prs', `3@${h3}`]);
    expect(repair.status).toBe(EXIT.ok);
    const rn = nonceOf(repair.out);
    expect(trainJson(fx, rn)).toMatchObject({ repair: true, base: { sha: broken } });
    expect(queue(fx, ['train', 'verdict', '--train', rn]).status).toBe(EXIT.ok);
    expect(v('2').err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(dispatches(fx, 'evals.yml').filter(d => d.ref === 'main').length).toBe(1);
    expect(line(v('3', rn).out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h3}`);
    publishMain(fx, trainJson(fx, rn).prefixes[1].commit, '1.2.6.0');
    const cleared = v('3', rn);
    expect(cleared.status).toBe(EXIT.ok);
    expect(cleared.out).toMatch(/^FREEZE: cleared \(repair #3 via train \S+; main [0-9a-f]{12} carries a green record\)$/m);
    expect(next(cleared.out)).toBe(`NEXT: gstack-ship-queue train build --prs 2@${h2}`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8')).cleared_at).toBe('2026-10-18T12:00:00.000Z');
    expect(queue(fx, ['train', 'status']).out).not.toContain('QUEUE_TRAIN_FROZEN');
  }, 300_000);
  test("rule 22: verify --train binds the receipt to the pinned head when the current head is its stamp commit; a receipt for another head refuses the slot and merges nothing", () => {
    const fx = make();
    const { h1, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const coord = coordinatorClone(fx.repo);
    const v = () => queue(fx, ['verify', '--pr', '1', '--train', nonce], {}, coord);
    const { repo } = fx;
    repo.git('checkout', '-q', '-B', 'lane1', h1);
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    repo.git('commit', '-qam', 'v1.2.4.0 stamp');
    const stamped = repo.git('rev-parse', 'HEAD');
    repo.git('push', '-q', '-f', 'origin', `${stamped}:refs/pull/1/head`);
    const ok = v();
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toContain(`head: ${stamped} (same modulo stamps (1 stamp file(s)))`);
    expect(ok.out).toContain(`SHIP_RECEIPT: pr=1 head=${h1.slice(0, 12)} version=- base=main (binds the pinned head)`);
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${stamped}`);
    setPrBody(fx, '1', shippedBody('1', 'b'.repeat(40)));
    const stale = v();
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toMatch(new RegExp(`PR #1's ship receipt is for bbbbbbbbbbbb, not the head ${h1.slice(0, 12)} or ${stamped.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE\\)`));
    expect(stale.out).not.toContain('MERGE_CONDITION:');
    expect(next(stale.out)).toBe("NEXT: #1's lane runs /ship and READYs again; then gstack-ship-queue train build --prs <pins>");
    expect(trainJson(fx, nonce).merged).toEqual([]);
    setPrBody(fx, '1', '');
    expect(v().err).toContain('(QUEUE_RECEIPT_MISSING)');
    setPrBody(fx, '1', '```gstack-ship-receipt\n{"schema_version":1}\n```\n');
    const invalid = v();
    expect(invalid.err).toMatch(/PR #1's ship receipt is invalid \(.*\).*\(QUEUE_RECEIPT_MISSING\)/);
    expect(invalid.out).not.toContain('MERGE_CONDITION:');
    setPrBody(fx, '1', shippedBody('2', h1));
    const otherPr = v();
    expect(otherPr.err).toMatch(/PR #1's ship receipt names pr=2, not this PR.*\(QUEUE_RECEIPT_STALE\)/);
    expect(otherPr.out).not.toContain('MERGE_CONDITION:');
    expect(trainJson(fx, nonce).merged).toEqual([]);
    setPrBody(fx, '1', shippedBody('1', stamped));
    expect(v().out).toContain(`SHIP_RECEIPT: pr=1 head=${stamped.slice(0, 12)} version=- base=main (binds the current head)`);
    const saved = fx.read().prs['1'];
    fx.write(d => { delete d.prs['1']; });
    const unreadable = v();
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain('(QUEUE_PROOF_MISSING)');
    expect(unreadable.out).not.toContain('MERGE_CONDITION:');
    fx.write(d => { d.prs['1'] = saved; });
    expect(trainJson(fx, nonce).merged).toEqual([]);
  }, 300_000);

  test('from slot 2 on, a head that merges main into the pin verifies when its tree is the slot\'s prefix modulo stamps', () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    expect(v('1').status).toBe(EXIT.ok);

    const { repo } = fx;
    const laneHead = (extra?: { file: string; text: string }) => {
      repo.git('reset', '-q', '--hard');
      repo.git('checkout', '-q', '-B', 'lane2', h2);
      repo.git('rm', '-rq', '.');
      repo.git('checkout', t.prefixes[2].commit, '--', '.');
      fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
      if (extra) fs.writeFileSync(path.join(repo.work, extra.file), extra.text);
      repo.git('add', '-A');
      const tree = repo.git('write-tree');
      const head = repo.git('commit-tree', tree, '-p', h2, '-p', main1, '-m', 'merge main into #2, stamp 1.2.5.0');
      repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/2/head`);
      return head;
    };

    const merged = laneHead();
    const ok = v('2');
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(new RegExp(`^head: ${merged} \\(T2 with main merged in, same modulo stamps`, 'm'));
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${merged}`);

    const stray = laneHead({ file: 'stray.txt', text: 'not in the train\n' });
    const moved = v('2');
    expect(moved.status).toBe(EXIT.fail);
    expect(moved.err).toMatch(new RegExp(`#2 moved past its pinned head ${h2.slice(0, 12)} and is not T2 modulo stamps \\(${stray.slice(0, 12)}: .*\\(QUEUE_TRAIN_MOVED\\)`));
  }, 300_000);

  test("GSTA-67 (#3345 at 593e61c): a merged-in head whose CHANGELOG was resolved by hand verifies even where T<i>'s mechanical CHANGELOG differs; an invented line or a head without main is still refused", () => {
    const fx = make();
    const h1 = openPr(fx, '1', { changelog: false });
    const h2 = openPr(fx, '2', { changelog: cl => cl.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- #2 change\n').replace('## [1.2.2.0] - 2026-09-01\n\n', '') });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    expect(fx.repo.git('show', `${t.prefixes[2].commit}:CHANGELOG.md`)).not.toContain('## [1.2.2.0]');
    const coord = coordinatorClone(fx.repo);
    const v = () => queue(fx, ['verify', '--pr', '2', '--train', nonce], {}, coord);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    const { repo } = fx;
    const laneHead = (entry: string, parents: string[]) => {
      repo.git('reset', '-q', '--hard');
      repo.git('checkout', '-q', '-B', 'lane2', h2);
      repo.git('rm', '-rq', '.');
      repo.git('checkout', t.prefixes[2].commit, '--', '.');
      fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
      fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), repo.git('show', `${main1}:CHANGELOG.md`).replace('# Changelog\n', `# Changelog\n\n## [1.2.5.0] - 2026-10-18\n\n${entry}\n`) + '\n');
      repo.git('add', '-A');
      const head = repo.git('commit-tree', repo.git('write-tree'), ...parents.flatMap(p => ['-p', p]), '-m', 'merge main into #2 (CHANGELOG by hand), stamp 1.2.5.0');
      repo.git('push', '-q', '-f', 'origin', `${head}:refs/pull/2/head`);
      return head;
    };

    const byHand = laneHead('- #2 change', [h2, main1]);
    const ok = v();
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toContain(`head: ${byHand} (T2 with main merged in, same modulo stamps (1 stamp file(s)) except CHANGELOG.md, resolved as main's CHANGELOG.md plus #2's own entry)`);
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${byHand}`);

    const invented = laneHead('- #2 change\n- added after the gate', [h2, main1]);
    const refused = v();
    expect(refused.status).toBe(EXIT.fail);
    expect(refused.err).toContain(`#2 moved past its pinned head ${h2.slice(0, 12)} and is not T2 modulo stamps (${invented.slice(0, 12)}: differs from T2 in CHANGELOG.md, which is not main's plus #2's own entry: the PR's entry holds a line its pin never added: "- added after the gate"; against the pin it differs: `);
    expect(refused.err).toContain('(QUEUE_TRAIN_MOVED)');

    const orphan = laneHead('- #2 change', [h2]);
    const noMain = v();
    expect(noMain.status).toBe(EXIT.fail);
    expect(noMain.err).toContain(`(${orphan.slice(0, 12)}: does not contain main ${main1.slice(0, 12)}; against the pin it differs: `);
  }, 300_000);
  // fails_when=the post-merge verify of a merged-in head the pre-merge verify accepted freezes the queue because T<i>'s single [Unreleased] became two released sections, or the pre-merge verify refuses the correction bullet mergeChangelogs itself wrote; why_new=the GSTA-67 test above never publishes the accepted head and never stacks a child on a released parent; seam=none (real git, the fixture's gh); no_claim=what the squash commit's message says
  test("train 24 (GSTA-96): a stacked child's head the pre-merge verify accepted confirms after its squash merge under the same CHANGELOG rule, corrections to the released parent included", () => {
    const fx = make();
    const { repo } = fx;
    const h1 = openPr(fx, '1', { changelog: cl => cl.replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n**Parent entry of #1.**\n\n### Changed\n- #1 change, the first wording\n- #1 second bullet, unchanged\n') });
    const h2 = openPr(fx, '2', { from: 'pr-1', changelog: cl => cl.replace('## [Unreleased]\n\n**Parent entry of #1.**', '## [Unreleased]\n\n**Child entry of #2.**\n\n### Changed\n- #2 change\n\n**Parent entry of #1.**').replace('- #1 change, the first wording', '- #1 change, the better wording') });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = GREEN_GATE; });
    const nonce = nonceOf(queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`]).out);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    expect(parseChangelog(repo.git('show', `${t.prefixes[2].commit}:CHANGELOG.md`)).sections.map(s => s.version ?? 'Unreleased')).toEqual(['Unreleased', '1.2.3.0', '1.2.2.0']);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);

    // Slot 1: #1 squash-merges and is released as 1.2.4.0 (its [Unreleased] re-headed).
    expect(line(v('1').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${h1}`);
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: repo.git('show', `${t.prefixes[1].commit}:CHANGELOG.md`).replace('## [Unreleased]', '## [1.2.4.0] - 2026-10-18') + '\n' });
    expect(v('1').out).toContain(`VERIFY_TRAIN: #1 merged; main's tree is T1 of train ${nonce} (1/2 merged)`);

    // Slot 2: the lane merges main into its pin; mergeChangelogs carries the child past its released parent.
    const merged = mergeChangelogs(repo.git('show', `${h2}:CHANGELOG.md`) + '\n', repo.git('show', `${main1}:CHANGELOG.md`) + '\n', repo.git('show', `${h1}:CHANGELOG.md`) + '\n')!;
    expect(merged).toContain('- Correction to the 1.2.4.0 entry below: "first" should read "better".');
    repo.git('reset', '-q', '--hard');
    repo.git('checkout', '-q', '-B', 'lane2', h2);
    repo.git('rm', '-rq', '.');
    repo.git('checkout', t.prefixes[2].commit, '--', '.');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), merged.replace('## [Unreleased]', '## [1.2.5.0] - 2026-10-18'));
    repo.git('add', '-A');
    const laneHead = repo.git('commit-tree', repo.git('write-tree'), '-p', h2, '-p', main1, '-m', 'merge main into #2, stamp 1.2.5.0');
    repo.git('push', '-q', '-f', 'origin', `${laneHead}:refs/pull/2/head`);
    repo.git('reset', '-q', '--hard');
    const pre = v('2');
    expect([pre.status, pre.err]).toEqual([EXIT.ok, '']);
    expect(pre.out).toContain(`head: ${laneHead} (T2 with main merged in, same modulo stamps (1 stamp file(s)) except CHANGELOG.md, resolved as main's CHANGELOG.md plus #2's own entry)`);
    expect(line(pre.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${laneHead}`);

    // The squash merge publishes exactly that tree; the post-merge verify confirms it instead of freezing the queue.
    const main2 = publishMain(fx, laneHead, '1.2.5.0');
    expect(repo.git('rev-parse', `${main2}^{tree}`)).toBe(repo.git('rev-parse', `${laneHead}^{tree}`));
    const post = v('2');
    expect([post.status, post.err]).toEqual([EXIT.ok, '']);
    expect(line(post.out, 'main:')).toBe(`main: ${main2} = T2 (same modulo stamps (1 stamp file(s)) except CHANGELOG.md, main ${main1.slice(0, 12)}'s CHANGELOG.md plus #2's own entry)`);
    expect(post.out).toContain(`VERIFY_TRAIN: #2 merged; main's tree is T2 of train ${nonce} (2/2 merged)`);
    expect(queue(fx, ['train', 'status']).out).not.toContain('QUEUE_TRAIN_FROZEN');
  }, 300_000);
});
