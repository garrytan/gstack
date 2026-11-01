// Split from test/ship-queue-train.test.ts (GSTA-151): verify freezes, GitHub merge-state reads and stale-train refusals.
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup } from './helpers/restamp-fixture';
import { coordinatorClone } from './helpers/ship-queue-fixture';
import { laneStamp, markMerged, publishMain, twoPrTrain } from './helpers/ship-queue-train-cases';
import {
  TRAIN_POLICY, dispatches, line, nonceOf, openPr, queue, readyReceipt, repoKey, trainFixture, trainJson,
  type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const next = (out: string) => line(out, 'NEXT:');

describe('verify, freeze, repair and clear', () => {
  // fails_when=a freeze lists a PR GitHub reports MERGED as unmerged (train 24's freeze named #3453), or a post-merge CHANGELOG with a line the pin never wrote confirms; why_new=the freeze test above merges nothing of the slot it freezes on; seam=the fixture's gh pr view state; no_claim=the backstop's outcome
  test('a post-merge CHANGELOG beyond the rule still freezes, and the freeze lists the slot GitHub reports MERGED as merged, not unmerged', () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const released = (prefix: string, version: string) => fx.repo.git('show', `${prefix}:CHANGELOG.md`).replace('## [Unreleased]', `## [${version}] - 2026-10-18`) + '\n';
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: released(t.prefixes[1].commit, '1.2.4.0') });
    markMerged(fx, '1');
    expect(v('1').status).toBe(EXIT.ok);
    const s2 = laneStamp(fx, '2', h2, { mergeMain: true });
    expect(line(v('2').out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${s2}`);
    // Main's CHANGELOG plus #2's stamped entry, with one line the pin never wrote.
    const smuggled = fx.repo.git('show', `${main1}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.5.0] - 2026-10-18\n\n- #2 change\n- added after the gate\n') + '\n';
    const broken = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'CHANGELOG.md', text: smuggled });
    fx.write(d => { (d.prs['2'] as any).state = 'MERGED'; });
    const frozen = v('2');
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain(`main ${broken.slice(0, 12)} is neither T1 nor T2 modulo stamps (vs T2: differs: CHANGELOG.md, which is not main ${main1.slice(0, 12)}'s plus #2's own entry: the PR's entry holds a line its pin never added: "- added after the gate")`);
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1,#2; main /);
    expect(line(frozen.out, 'freeze:')).toMatch(/; #2 merged on GitHub without a verified tree; unmerged \(none\); repair none admitted$/);
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    expect(JSON.parse(fs.readFileSync(freezeFile, 'utf8'))).toMatchObject({ merged: ['1', '2'], unmerged: [] });
  }, 300_000);

  // Value: protects=a first slot GitHub reports MERGED whose squash fails the post-merge check freezes the queue, and a GitHub state that cannot be read refuses instead of reading as not merged; fails_when=stopped() reads an empty merged list, or an unreadable gh answer, as "nothing merged" while main already holds the unverified squash (review of GSTA-129, passes 1 and 2); why_new=the test above freezes on slot 2 with slot 1 verified; seam=the fixture's gh pr view state; no_claim=the backstop's outcome
  test("slot 1 merged on GitHub but not confirmed: an unreadable GitHub state refuses, and a MERGED one freezes with #1 merged and #2 unmerged instead of saying nothing merged", () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const smuggled = fx.repo.git('show', `${t.prefixes[0].commit}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- #1 change\n- added after the gate\n') + '\n';
    const broken = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: smuggled });
    // While GitHub's answer for #1 cannot be read, the verify neither freezes nor says "nothing merged": it refuses and asks to be rerun.
    const row = fx.read().prs['1'] as any;
    fx.write(d => { delete d.prs['1']; });
    const unreadable = v('1');
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain(`main ${broken.slice(0, 12)} is neither T0 nor T1 modulo stamps`);
    expect(unreadable.err).toMatch(/; whether #1 merged on GitHub could not be read, so whether the queue must freeze is unknown; .*\(QUEUE_PROOF_MISSING\)/);
    expect(unreadable.out).toContain(`NEXT: gstack-ship-queue verify --pr 1 --train ${nonce} (once gh pr view answers)`);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`))).toBe(false);
    fx.write(d => { d.prs['1'] = { ...row, state: 'MERGED' }; });
    const frozen = v('1');
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain(`main ${broken.slice(0, 12)} is neither T0 nor T1 modulo stamps`);
    expect(frozen.err).toContain('"- added after the gate"); the queue is frozen;');
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1; main /);
    expect(line(frozen.out, 'freeze:')).toMatch(/; #1 merged on GitHub without a verified tree; unmerged #2; repair none admitted$/);
    expect(JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`), 'utf8'))).toMatchObject({ merged: ['1'], unmerged: [{ pr: '2', head: h2 }] });
  }, 300_000);

  // Value: protects=the freeze record is built from the same GitHub read that decided to freeze, so a slot that read MERGED stays merged even when GitHub stops answering a moment later; fails_when=freezeQueue reads GitHub again and files anything but an exact MERGED under unmerged (the misfile that listed train 24's merged #3453 as unmerged, GSTA-129 defect 1); why_new=the test above holds GitHub's answer fixed across the verify; seam=the fixture's gh pr view vanishing after one answer; no_claim=the backstop's outcome
  test("a slot that read MERGED when the verify decided to freeze is recorded as merged even when GitHub stops answering before the record is written", () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const smuggled = fx.repo.git('show', `${t.prefixes[0].commit}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- #1 change\n- added after the gate\n') + '\n';
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: smuggled });
    fx.write(d => { (d.prs['1'] as any).state = 'MERGED'; d.vanish = { '1': 1 }; });
    const frozen = queue(fx, ['verify', '--pr', '1', '--train', nonce], {}, coord);
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain('"- added after the gate"); the queue is frozen;');
    expect(fx.read().vanish).toEqual({ '1': 0 });
    expect(line(frozen.out, 'freeze:')).toMatch(/; #1 merged on GitHub without a verified tree; unmerged #2; repair none admitted$/);
    expect(JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`), 'utf8'))).toMatchObject({ merged: ['1'], unmerged: [{ pr: '2', head: h2 }] });
  }, 300_000);

  // Value: protects=a slot unreadable on GitHub beside a merged one is left out of unmerged and named in the reason, so the rebuild after the repair never seats a PR that may already be in; fails_when=freezeQueue files an unreadable slot under unmerged, or drops it without naming it; why_new=the test above keeps slot 2 readable; seam=the fixture's gh pr view vanishing for slot 2; no_claim=the backstop's outcome
  test("a slot unreadable on GitHub beside a merged one is left out of unmerged, recorded as unreadable and named by the NEXT after the repair", () => {
    const fx = make();
    const { h2, nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const smuggled = fx.repo.git('show', `${t.prefixes[0].commit}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- #1 change\n- added after the gate\n') + '\n';
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: smuggled });
    fx.write(d => { (d.prs['1'] as any).state = 'MERGED'; d.vanish = { '2': 0 }; });
    const frozen = queue(fx, ['verify', '--pr', '1', '--train', nonce], {}, coord);
    expect(frozen.status).toBe(EXIT.fail);
    expect(line(frozen.out, 'freeze:')).toMatch(/; #1 merged on GitHub without a verified tree; #2 unreadable on GitHub, left out of unmerged; seat it in a train by hand once gh pr view answers; unmerged \(none\); repair none admitted$/);
    expect(JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`), 'utf8'))).toMatchObject({ merged: ['1'], unmerged: [], unreadable: [{ pr: '2', head: h2 }] });
    expect(line(frozen.out, 'unreadable:')).toBe(`unreadable: #2@${h2.slice(0, 12)} (GitHub did not answer at the freeze; neither merged nor unmerged)`);
    // The repair clears the freeze, and the NEXT names the unreadable slot instead of omitting it (#3519 b).
    const h3 = openPr(fx, '3');
    readyReceipt(fx, '3', h3);
    const rn = nonceOf(queue(fx, ['train', 'build', '--repair', '--prs', `3@${h3}`]).out);
    expect(queue(fx, ['train', 'verdict', '--train', rn]).status).toBe(EXIT.ok);
    publishMain(fx, trainJson(fx, rn).prefixes[1].commit, '1.2.6.0');
    markMerged(fx, '3');
    const cleared = queue(fx, ['verify', '--pr', '3', '--train', rn], {}, coord);
    expect(cleared.out).toMatch(/^FREEZE: cleared /m);
    expect(next(cleared.out)).toBe(`NEXT: gh pr view 2 --json state,headRefOid (unreadable at the freeze: #2@${h2.slice(0, 12)}); seat each that is OPEN in a train`);
  }, 300_000);

  // Value: protects=verify on a train whose every slot already merged, against a main another train verified, refuses as stale instead of freezing the queue and dispatching a backstop (#3519 c: train 24's record froze the queue at 9ccb5233, T1 of verified train 28, run 40586582766); fails_when=stopped() freezes when every slot merged and main's sha is another train's verified prefix, or refuses without that proof; why_new=every freeze test above has an unmerged or unverified main; seam=a second train record written into the state root; no_claim=what prune --stale then does (covered by the prune tests)
  test("verify on a train whose every slot merged, against a main another train verified, refuses as stale and freezes nothing", () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    markMerged(fx, '1');
    expect(v('1').status).toBe(EXIT.ok);
    const later = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'a later train\n' });
    fx.write(d => { (d.prs['2'] as any).state = 'MERGED'; });
    const freezeFile = path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`);
    const tree = fx.repo.git('rev-parse', `${later}^{tree}`);
    const otherNonce = `${nonce}-later`;
    const other = { ...t, nonce: otherNonce, state: 'merging', prefixes: [t.prefixes[0], { index: 1, commit: later, tree, pr: '9' }], merged: [{ pr: '9', sha: later, tree, at: '2026-10-18T13:00:00.000Z' }] };
    fs.mkdirSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce), { recursive: true });
    fs.writeFileSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce, 'train.json'), JSON.stringify(other));
    const stale = v('2');
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toContain(`every slot of train ${nonce} merged on GitHub and main ${later.slice(0, 12)} is T1 of train ${otherNonce} (#9, verified at 2026-10-18T13:00:00.000Z), so this record is stale and the queue is not frozen`);
    expect(stale.err).toContain('(QUEUE_TRAIN_STALE)');
    expect(next(stale.out)).toBe(`NEXT: gstack-ship-queue train prune --stale --train ${nonce}`);
    expect(fs.existsSync(freezeFile)).toBe(false);
    expect(dispatches(fx, 'evals.yml').filter(d => d.ref === 'main').length).toBe(0);
    // Without another train's verified record for this main, the same mismatch still freezes.
    fs.rmSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce), { recursive: true });
    const frozen = v('2');
    expect(frozen.status).toBe(EXIT.fail);
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1,#2; main /);
  }, 300_000);

  // Value: protects=a train with a slot still OPEN on GitHub freezes on a mismatch even when main's sha is another train's verified prefix; fails_when=the every-slot-merged guard before verifiedElsewhere is dropped or weakened, so a live train refuses as stale and skips the freeze; why_new=the test above only covers an all-merged train; seam=none; no_claim=prune behavior
  test("a train with a slot still open freezes on the mismatch even when another train verified main's sha", () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    publishMain(fx, t.prefixes[1].commit, '1.2.4.0');
    markMerged(fx, '1');
    expect(v('1').status).toBe(EXIT.ok);
    const later = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'stray.txt', text: 'a later train\n' });
    const tree = fx.repo.git('rev-parse', `${later}^{tree}`);
    const otherNonce = `${nonce}-later`;
    const other = { ...t, nonce: otherNonce, state: 'merging', prefixes: [t.prefixes[0], { index: 1, commit: later, tree, pr: '9' }], merged: [{ pr: '9', sha: later, tree, at: '2026-10-18T13:00:00.000Z' }] };
    fs.mkdirSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce), { recursive: true });
    fs.writeFileSync(path.join(fx.state, 'ship-queue', 'trains', otherNonce, 'train.json'), JSON.stringify(other));
    const partial = v('2');
    expect(partial.status).toBe(EXIT.fail);
    expect(partial.err).not.toContain('(QUEUE_TRAIN_STALE)');
    expect(line(partial.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1; main /);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'freeze', `${repoKey(fx)}.json`))).toBe(true);
  }, 300_000);

  // Value: protects=a post-merge CHANGELOG difference is excused only when main's parent is T<i-1> modulo stamps, so a foreign commit between the verified head and the squash freezes; fails_when=published() skips or inverts the parent check; why_new=the two tests above reach the CHANGELOG rule only with a parent that is T1 modulo stamps; seam=none; no_claim=a parent differing from T1 in the CHANGELOG alone
  test("a post-merge CHANGELOG difference is not excused when main's parent is not the verified prefix modulo stamps: the queue freezes naming the parent", () => {
    const fx = make();
    const { nonce } = twoPrTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const t = trainJson(fx, nonce);
    const coord = coordinatorClone(fx.repo);
    const v = (pr: string) => queue(fx, ['verify', '--pr', pr, '--train', nonce], {}, coord);
    const released = fx.repo.git('show', `${t.prefixes[1].commit}:CHANGELOG.md`).replace('## [Unreleased]', '## [1.2.4.0] - 2026-10-18') + '\n';
    const main1 = publishMain(fx, t.prefixes[1].commit, '1.2.4.0', { file: 'CHANGELOG.md', text: released });
    markMerged(fx, '1');
    expect(v('1').status).toBe(EXIT.ok);
    const foreign = publishMain(fx, t.prefixes[1].commit, '1.2.4.1', { file: 'stray.txt', text: 'landed between the two slots\n' });
    const text = fx.repo.git('show', `${main1}:CHANGELOG.md`).replace('# Changelog\n', '# Changelog\n\n## [1.2.5.0] - 2026-10-18\n\n- #2 change\n- added after the gate\n') + '\n';
    const main2 = publishMain(fx, t.prefixes[2].commit, '1.2.5.0', { file: 'CHANGELOG.md', text });
    expect(fx.repo.git('rev-parse', `${main2}^`)).toBe(foreign);
    const frozen = v('2');
    expect(frozen.status).toBe(EXIT.fail);
    expect(frozen.err).toContain(`main ${main2.slice(0, 12)} is neither T1 nor T2 modulo stamps`);
    expect(frozen.err).toContain(`main's parent ${foreign.slice(0, 12)} is not T1 modulo stamps`);
    expect(line(frozen.out, 'QUEUE_TRAIN_FROZEN:')).toMatch(/^QUEUE_TRAIN_FROZEN: train \S+ merged #1; main /);
  }, 300_000);
});
