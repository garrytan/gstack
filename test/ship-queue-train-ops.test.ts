/**
 * Operational gaps seen on live trains, through the real
 * bin/gstack-ship-queue against the train fixture: the screen verdict is read
 * from the run (ready refuses a red head, verify --screen prints it, train
 * build refuses the pin), a lagging GitHub merge ref gets a scratch merge
 * (#3465), `train prune --stale` settles trains whose PRs merged elsewhere,
 * and `train watch` resumes from the record after an interruption.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup, runBin } from './helpers/restamp-fixture';
import {
  GREEN_GATE, TRAIN_POLICY, dispatches, line, nonceOf, openPr, queue, readyReceipt, repoKey, trainJson, trainFixture, type Rule, type TrainFixture,
} from './helpers/ship-queue-train-fixture';

const fixtures: TrainFixture[] = [];
const make = (policy: Record<string, unknown> = TRAIN_POLICY) => { const f = trainFixture(policy); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) cleanup(fixtures.pop()!.repo); });

const next = (out: string) => line(out, 'NEXT:');
const result = (out: string) => line(out, 'GSTACK_RESULT:');

function readyFixture() {
  const fx = make();
  const head = openPr(fx, '1');
  fx.write(d => { d.ci[head] = [{ status: 'completed', conclusion: 'success' }]; });
  const tree = runBin(fx.repo, 'gstack-wtree', []).out.trim();
  const pregate = path.join(fx.repo.root, 'pregate.json');
  fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
  return { fx, head, pregate };
}
const receiptOf = (fx: TrainFixture, pr: string, head: string) => JSON.parse(fs.readFileSync(path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `${pr}-${head}.json`), 'utf8'));

const RED_SCREEN: Rule = { status: 'completed', conclusion: 'failure', plan: { planned: 3 }, binding: { verdict: 'RED', flaky: ['c-flaky'] }, outcomes: { red: ['judge-voice-tone'], flakyLines: ['c-flaky rule FLAKY: failed in slice 2, passed on its one rerun'] } };
const GREEN_SCREEN: Rule = { status: 'completed', conclusion: 'success', plan: { planned: 3 }, binding: { verdict: 'GREEN', flaky: ['c-flaky'] }, outcomes: { flakyLines: ['c-flaky rule FLAKY: failed in slice 2, passed on its one rerun'] } };

describe('the screen verdict comes from the run', () => {
  // Value: protects=a RED screen run (runs 40269992077 and 40275443393 on 2026-10-26 were VERDICT RED while the lane reported green) can never be READY'd, followed or seated;
  // fails_when=ready or train build trust the lane's choice without reading the run's gate binding; why_new=no test read a screen's verdict; seam=the gh shim's gate-binding and report-verdict artifacts; no_claim=evals.yml's real upload step
  test('a RED screen refuses ready under either choice and is never re-dispatched; verify --screen prints the red and flaky cases; train build refuses the pin', () => {
    const { fx, head, pregate } = readyFixture();
    fx.write(d => { d.rules['evals.yml'] = RED_SCREEN; });
    const first = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect([first.status, line(first.out, 'SCREEN_DISPATCH:')]).toEqual([EXIT.ok, expect.stringMatching(/^SCREEN_DISPATCH: evals\.yml run 100 /)]);
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(again.status).toBe(EXIT.refused);
    expect(line(again.out, 'SCREEN_VERDICT:')).toBe('SCREEN_VERDICT: #1 run 100 RED red=judge-voice-tone flaky=c-flaky (verdict RED, reconcile exit 1, run concluded failure, flaky 1)');
    expect(line(again.out, 'FLAKY:')).toBe('FLAKY: c-flaky rule FLAKY: failed in slice 2, passed on its one rerun');
    expect(again.err).toMatch(/the screen recorded for [0-9a-f]{12} \(run 100\) is RED on judge-voice-tone; this head is not READY under any screen choice; fix: .*\(QUEUE_SCREEN_RED\)/);
    expect(next(again.out)).toBe('NEXT: repair, push a new head, run /ship, then gstack-ship-queue ready --pr 1 --screen');
    expect(receiptOf(fx, '1', head).screen.verdict).toMatchObject({ outcome: 'RED', run: 100, red: ['judge-voice-tone'], flaky: ['c-flaky'] });
    const noScreen = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect([noScreen.status, noScreen.err]).toEqual([EXIT.refused, expect.stringContaining('(QUEUE_SCREEN_RED)')]);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const verify = queue(fx, ['verify', '--pr', '1', '--screen']);
    expect(verify.status).toBe(EXIT.fail);
    expect(line(verify.out, 'SCREEN_VERDICT:')).toBe('SCREEN_VERDICT: #1 run 100 RED red=judge-voice-tone flaky=c-flaky (verdict RED, reconcile exit 1, run concluded failure, flaky 1)');
    expect(verify.out.split('\n')[1]).toMatch(/^screen: screen policy=narrow nonce=pr\.screen\.narrow-\S+ run=100 verdict=RED$/);
    expect(result(verify.out)).toMatch(/status=refused run=.*1-/);
    const build = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect(build.status).toBe(EXIT.refused);
    expect(build.err).toMatch(/#1's screen run 100 is RED on judge-voice-tone .*a red head is not seated.*\(QUEUE_SCREEN_RED\)/);
    expect(next(build.out)).toBe('NEXT: none');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'trains'))).toBe(false);
  }, 120_000);

  test('a GREEN screen with flaky cases is followed, recorded and printed by verify --screen and train build; a run that bound no verdict is re-dispatched', () => {
    const { fx, head, pregate } = readyFixture();
    fx.write(d => { d.rules['evals.yml'] = GREEN_SCREEN; });
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']).status).toBe(EXIT.ok);
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(again.status).toBe(EXIT.ok);
    expect(line(again.out, 'SCREEN_VERDICT:')).toBe('SCREEN_VERDICT: #1 run 100 GREEN flaky=c-flaky (verdict GREEN, reconcile exit 0, run concluded success, flaky 1)');
    expect(line(again.out, 'SCREEN_DISPATCH:')).toBe('SCREEN_DISPATCH: following run 100 (same merge SHA, base and policy; no duplicate)');
    expect(again.out.split('\n')[1]).toMatch(/^screen: screen policy=narrow nonce=\S+ run=100 verdict=GREEN$/);
    expect(receiptOf(fx, '1', head).screen.verdict).toMatchObject({ outcome: 'GREEN', run: 100, red: [], flaky: ['c-flaky'] });
    const verify = queue(fx, ['verify', '--pr', '1', '--screen']);
    expect([verify.status, verify.err]).toEqual([EXIT.ok, '']);
    expect(line(verify.out, 'FLAKY:')).toBe('FLAKY: c-flaky rule FLAKY: failed in slice 2, passed on its one rerun');
    expect(next(verify.out)).toBe(`NEXT: gstack-ship-queue train build --prs 1@${head},...`);
    const build = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([build.status, line(build.out, 'SCREEN:'), line(build.out, 'ORDER:')]).toEqual([EXIT.ok, 'SCREEN: #1 run 100 GREEN (flaky: c-flaky)', 'ORDER: 1:#1(screened)']);
    fx.write(d => { delete d.artifacts['100']['gate-binding-a1']; });
    const unbound = queue(fx, ['verify', '--pr', '1', '--screen']);
    expect(unbound.status).toBe(EXIT.refused);
    expect(unbound.err).toMatch(/has no verdict to read: run 100 concluded success and bound no verdict \(no gate-binding artifact.*\(QUEUE_PROOF_MISSING\)/);
    expect(next(unbound.out)).toBe('NEXT: gstack-ship-queue ready --pr 1 --screen (dispatches a fresh screen)');
    const redispatch = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(redispatch.status).toBe(EXIT.ok);
    expect(line(redispatch.out, 'SCREEN_DISPATCH:')).toMatch(/^SCREEN_DISPATCH: evals\.yml run 101 .*\(not following run 100 concluded success and bound no verdict .*: a screen that bound no verdict is not a screen\)$/);
    fx.write(d => { d.rules['evals.yml'] = { status: 'completed', conclusion: 'success', plan: { planned: 3 }, reuse: { run: 77, flaky: ['c-reused'] } }; });
    const reusedDispatch = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--broad', '--screen']);
    expect(reusedDispatch.status).toBe(EXIT.ok);
    const reused = queue(fx, ['verify', '--pr', '1', '--screen']);
    expect([reused.status, line(reused.out, 'SCREEN_VERDICT:')]).toEqual([EXIT.ok, 'SCREEN_VERDICT: #1 run 102 GREEN flaky=c-reused (reused the GREEN verdict of run 77 (main-moved): same own diff on a moved main, flaky 1)']);
    const noRun = queue(fx, ['verify', '--pr', '2', '--screen']);
    expect(noRun.err).toMatch(/cannot read PR #2's head through gh.*\(QUEUE_PROOF_MISSING\)/);
    const unscreened = openPr(fx, '3');
    readyReceipt(fx, '3', unscreened);
    const none = queue(fx, ['verify', '--pr', '3', '--screen']);
    expect([none.status, line(none.out, 'SCREEN_VERDICT:')]).toEqual([EXIT.ok, 'SCREEN_VERDICT: #3 none (READY --no-screen)']);
  }, 120_000);

  // Value: protects=a screen that concluded success with no slice (18 of 41 PR screens on 2026-10-26, superseded by a push before the plan) is NOT-RUN at verdict, not a screen and not a stale ref;
  // fails_when=verify --screen calls it GREEN, HOLLOW or QUEUE_SCREEN_STALE_REF, or ready follows it; why_new=the hollow outcome reused the stale-ref code; seam=the gh shim's run with no plan artifact; no_claim=why evals.yml planned nothing
  // Value: protects=train build --dry-run (with or without --stack-tests) writes nothing: the screen verdict it reads is printed, not recorded in the READY receipt or pushed to refs/notes/gstack-trains, as its DRY-RUN line says;
  // fails_when=admitSlots persists the read verdict under --dry-run (the notes ref moves and the receipt gains a verdict before any real build); why_new=the other dry-run tests only check the trains dir; seam=none; no_claim=a verdict that was already recorded by ready or verify
  test('train build --dry-run prints the screen verdict it read without recording it in the receipt or pushing the notes ref', () => {
    const { fx, head, pregate } = readyFixture();
    fx.write(d => { d.rules['evals.yml'] = GREEN_SCREEN; });
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']).status).toBe(EXIT.ok);
    expect(receiptOf(fx, '1', head).screen.verdict).toBeUndefined();
    const notes = fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains');
    const build = queue(fx, ['train', 'build', '--prs', `1@${head}`, '--dry-run']);
    expect([build.status, line(build.out, 'SCREEN:'), line(build.out, 'DRY-RUN:')]).toEqual([EXIT.ok, 'SCREEN: #1 run 100 GREEN (flaky: c-flaky)', 'DRY-RUN: nothing written, pushed or dispatched']);
    expect(receiptOf(fx, '1', head).screen.verdict).toBeUndefined();
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains')).toBe(notes);
    const verify = queue(fx, ['verify', '--pr', '1', '--screen']);
    expect([verify.status, receiptOf(fx, '1', head).screen.verdict?.outcome]).toEqual([EXIT.ok, 'GREEN']);
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains')).not.toBe(notes);
  }, 120_000);

  test('a screen run that concluded success with no slice is NOT-RUN: verify --screen refuses with QUEUE_SCREEN_NOT_RUN, the receipt records NOT_RUN, and ready --screen dispatches afresh', () => {
    const { fx, head, pregate } = readyFixture();
    fx.write(d => { d.rules['evals.yml'] = { status: 'completed', conclusion: 'success', plan: null }; });
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']).status).toBe(EXIT.ok);
    const verify = queue(fx, ['verify', '--pr', '1', '--screen']);
    expect(verify.status).toBe(EXIT.refused);
    expect(line(verify.out, 'SCREEN_VERDICT:')).toBe('SCREEN_VERDICT: #1 run 100 NOT-RUN (run 100 planned no cases (no paid-plan artifact; concluded success))');
    expect(verify.err).toMatch(/the screen of #1 \(run 100\) concluded success with no slice: run 100 planned no cases .*; it is not a screen, and this head is not screened; fix: .*\(QUEUE_SCREEN_NOT_RUN\)/);
    expect(next(verify.out)).toBe('NEXT: gstack-ship-queue ready --pr 1 --screen (dispatches a fresh screen)');
    expect(receiptOf(fx, '1', head).screen.verdict).toMatchObject({ outcome: 'NOT_RUN', run: 100 });
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect([again.status, dispatches(fx, 'evals.yml').length]).toEqual([EXIT.ok, 2]);
    expect(line(again.out, 'SCREEN_VERDICT:')).toBe('SCREEN_VERDICT: #1 run 100 NOT-RUN (run 100 planned no cases (no paid-plan artifact; concluded success))');
    expect(line(again.out, 'SCREEN_DISPATCH:')).toMatch(/not following run 100 planned no cases .*: a screen that planned nothing is not a screen\)$/);
  }, 120_000);
});

describe('#3465: the screen is planned on a scratch merge when GitHub\'s merge ref lags', () => {
  // Value: protects=a CHANGELOG-only conflict (every main stamp leaves one) no longer blocks --screen: the screen tests the head merged onto current main by the train's rules;
  // fails_when=ready still refuses on the lagging ref, pushes nothing, or the scratch merge's parents are not (base, head); why_new=the stale-ref test only asserted the refusal; seam=none; no_claim=evals.yml's checkout of the pushed branch
  test('a lagging or missing merge ref gets a scratch merge pushed as screen/<pr>-<head12>; a real conflict is QUEUE_SCREEN_STALE_REF; prune --stale removes the branch once the PR merged', () => {
    const { fx, head, pregate } = readyFixture();
    const { repo } = fx;
    fx.write(d => { d.rules['evals.yml'] = GREEN_SCREEN; });
    repo.git('checkout', '-q', '-B', 'mainsim', 'origin/main');
    const cl = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), cl.replace('# Changelog\n', '# Changelog\n\n## [1.2.4.0] - 2026-10-18\n\n- another PR, stamped\n'));
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    repo.git('commit', '-qam', 'v1.2.4.0 stamp');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.git('checkout', '-q', 'pr-1');
    const dry = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen', '--dry-run']);
    expect([dry.status, dry.err]).toEqual([EXIT.ok, '']);
    const main = repo.git('rev-parse', 'origin/main');
    expect(line(dry.out, 'SCREEN_MERGE:')).toMatch(new RegExp(`^SCREEN_MERGE: scratch merge [0-9a-f]{12} of #1@${head.slice(0, 12)} onto main@${main.slice(0, 12)} \\(refs/pull/1/merge [0-9a-f]{12} merges onto [0-9a-f]{12}, not main@${main.slice(0, 12)}\\); would push screen/1-${head.slice(0, 12)} \\(dry run\\)$`));
    // gstack-pr-wait's base-overlap event, read from git at READY (handoff GSTA-119): main's stamp touched the CHANGELOG this PR also changes.
    expect(line(dry.out, 'BASE_OVERLAP:')).toBe(`BASE_OVERLAP: main moved to ${main.slice(0, 7)} and touches files in this PR: CHANGELOG.md; the train's merge onto main is clean`);
    expect(repo.git('ls-remote', 'origin', 'refs/heads/screen/*')).toBe('');
    const real = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect([real.status, real.err]).toEqual([EXIT.ok, '']);
    const branch = `screen/1-${head.slice(0, 12)}`;
    expect(line(real.out, 'SCREEN_MERGE:')).toContain(`; pushed ${branch}`);
    const scratch = repo.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]!;
    expect(scratch).toMatch(/^[0-9a-f]{40}$/);
    repo.git('fetch', '-q', 'origin', `refs/heads/${branch}`);
    expect([repo.git('rev-parse', `${scratch}^1`), repo.git('rev-parse', `${scratch}^2`)]).toEqual([repo.git('rev-parse', 'origin/main'), head]);
    expect(repo.git('show', `${scratch}:VERSION`)).toBe('1.2.4.0');
    expect(repo.git('show', `${scratch}:CHANGELOG.md`)).toContain('- #1 change');
    expect(repo.git('show', `${scratch}:CHANGELOG.md`)).toContain('- another PR, stamped');
    const d = dispatches(fx, 'evals.yml');
    expect(d.length).toBe(1);
    expect((d[0]!.inputs as any)).toMatchObject({ screen_merge_sha: scratch, expected_sha: scratch, screen_pr: '1' });
    expect(receiptOf(fx, '1', head).screen).toMatchObject({ choice: 'screen', merge_sha: scratch, branch });
    repo.git('push', '-q', 'origin', ':refs/pull/1/merge');
    const missing = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect([missing.status, line(missing.out, 'SCREEN_DISPATCH:')]).toEqual([EXIT.ok, 'SCREEN_DISPATCH: following run 100 (same merge SHA, base and policy; no duplicate)']);
    expect(line(missing.out, 'SCREEN_MERGE:')).toContain('(origin has no refs/pull/1/merge)');
    const kept = queue(fx, ['train', 'prune', '--stale', '--dry-run']);
    expect(line(kept.out, 'KEEP:')).toBe(`KEEP: ${branch} (#1 OPEN)`);
    fx.write(data => { (data.prs['1'] as any).state = 'MERGED'; });
    const pruned = queue(fx, ['train', 'prune', '--stale']);
    expect(line(pruned.out, 'DELETED:')).toBe(`DELETED: ${branch} (#1 MERGED)`);
    expect(repo.git('ls-remote', 'origin', 'refs/heads/screen/*')).toBe('');
    fx.write(data => { (data.prs['1'] as any).state = 'OPEN'; });
    repo.git('checkout', '-q', '-B', 'mainsim2', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'pr-1.txt'), 'main added the same file\n');
    repo.git('add', 'pr-1.txt');
    repo.git('commit', '-qm', 'main adds pr-1.txt');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo.git('checkout', '-q', 'pr-1');
    const conflict = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--screen']);
    expect(conflict.status).toBe(EXIT.refused);
    expect(conflict.err).toMatch(/#1 conflicts with main@[0-9a-f]{12} beyond the CHANGELOG and the stamp files \(pr-1\.txt\); GitHub's merge ref lags too \(origin has no refs\/pull\/1\/merge\).*\(QUEUE_SCREEN_STALE_REF\)/);
    expect(next(conflict.out)).toBe('NEXT: resolve the conflict with main, push, run /ship, then gstack-ship-queue ready --pr 1 --screen');
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    const main2 = repo.git('rev-parse', 'origin/main');
    expect(line(conflict.out, 'BASE_OVERLAP:')).toBe(`BASE_OVERLAP: main moved to ${main2.slice(0, 7)} and touches files in this PR: CHANGELOG.md, pr-1.txt; the train's merge onto main conflicts beyond the CHANGELOG and the stamp files (pr-1.txt)`);
    // Without a screen there is no scratch merge to refuse at, so READY itself refuses the conflict the train would stop at;
    // the fix follows the crew template's rule 14 (the base is merged on the controller's word, never by the lane alone).
    const noScreen = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect(noScreen.status).toBe(EXIT.refused);
    expect(noScreen.err).toMatch(new RegExp(`#1 conflicts with main@${main2.slice(0, 12)} beyond the CHANGELOG and the stamp files \\(pr-1\\.txt\\); the train would stop at this PR.*\\(QUEUE_TRAIN_CONFLICT\\)`));
    expect(next(noScreen.out)).toBe('NEXT: report the conflict to the controller; on its word merge main into the pin (never rebase), resolve, push, run /ship, then gstack-ship-queue ready --pr 1 --screen|--no-screen');
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `1-${head}.json`))).toBe(true);
  }, 120_000);
});

describe('train prune --stale and train watch', () => {
  function greenTrain(fx: TrainFixture, gate: Rule = GREEN_GATE) {
    const h1 = openPr(fx, '1');
    const h2 = openPr(fx, '2');
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    fx.write(d => { d.rules['evals.yml'] = gate; });
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2}`, '--free-timeout', '1']);
    return { h1, h2, r, nonce: nonceOf(r.out) };
  }

  // Value: protects=a merging or green train whose PRs all merged elsewhere (gate.train-23af94b3c5e9 and -6755ab829acf on 2026-10-26) can be pruned without hand-editing refs/notes/gstack-trains;
  // fails_when=prune skips merging/green trains, prunes one with an OPEN PR, or prunes without --stale; why_new=prune only knew terminal states; seam=the gh shim's PR states; no_claim=GitHub's real PR state
  test('--stale settles a merging or green train whose every PR is MERGED or CLOSED on GitHub, logging each PR; an OPEN PR keeps it; without --stale nothing changes', () => {
    const fx = make();
    const { nonce } = greenTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    expect(trainJson(fx, nonce).state).toBe('green');
    const plain = queue(fx, ['train', 'prune']);
    expect(line(plain.out, 'KEEP:')).toBe(`KEEP: train/${nonce} (green)`);
    const open = queue(fx, ['train', 'prune', '--stale', '--dry-run']);
    expect(line(open.out, 'KEEP:')).toBe(`KEEP: train/${nonce} (green; #1 OPEN, #2 OPEN still need the train)`);
    fx.write(d => { (d.prs['1'] as any).state = 'MERGED'; });
    const half = queue(fx, ['train', 'prune', '--stale', '--dry-run']);
    expect(line(half.out, 'KEEP:')).toBe(`KEEP: train/${nonce} (green; #2 OPEN still needs the train)`);
    fx.write(d => { (d.prs['2'] as any).state = 'CLOSED'; });
    const dry = queue(fx, ['train', 'prune', '--stale', '--dry-run']);
    expect(line(dry.out, 'STALE:')).toBe(`STALE: ${nonce} (green): #1 MERGED, #2 CLOSED; would mark stale`);
    expect(line(dry.out, 'WOULD-DELETE:')).toBe(`WOULD-DELETE: train/${nonce} (stale)`);
    expect(trainJson(fx, nonce).state).toBe('green');
    const pruned = queue(fx, ['train', 'prune', '--stale']);
    expect([pruned.status, line(pruned.out, 'STALE:'), line(pruned.out, 'DELETED:')]).toEqual([EXIT.ok, `STALE: ${nonce} (green): #1 MERGED, #2 CLOSED`, `DELETED: train/${nonce} (stale)`]);
    const t = trainJson(fx, nonce);
    expect(t.state).toBe('stale');
    expect(t.effects.map((e: any) => e.what)).toContain('marked stale by train prune --stale: #1 MERGED, #2 CLOSED');
    expect(fx.repo.git('ls-remote', 'origin', `refs/heads/train/${nonce}`)).toBe('');
    const status = queue(fx, ['train', 'status']);
    expect(status.out).toContain('TRAIN: none live');
  }, 120_000);

  // Value: protects=a stale train record or READY receipt leaves refs/notes/gstack-trains through one command under an exact lease, with the local files, instead of a hand-run git notes remove on every machine;
  // fails_when=forget removes the wrong notes, deletes locally when the push failed, or forgets a merging train; why_new=no CLI removed notes (merge-train skill, known gaps); seam=none; no_claim=a concurrent writer's race (the lease is exercised only as a fast-forward)
  test('train forget removes a settled train (attempts included) or a READY receipt from the notes ref and the state root, leaves other records alone, keeps everything (the local notes ref too) when the lease is rejected, and refuses a train still building, running or merging', () => {
    const fx = make();
    const { nonce, h1 } = greenTrain(fx);
    expect(queue(fx, ['train', 'verdict', '--train', nonce]).status).toBe(EXIT.ok);
    const trainDir = path.join(fx.state, 'ship-queue', 'trains', nonce);
    expect(fs.existsSync(path.join(trainDir, 'attempts', 'a1.json'))).toBe(true);
    const dry = queue(fx, ['train', 'forget', '--train', nonce, '--dry-run']);
    expect([dry.status, line(dry.out, 'FORGET:')]).toEqual([EXIT.ok, `FORGET: train ${nonce} (green; 1 attempt(s))`]);
    expect(dry.out).toContain(`  note gstack-trains:train:${nonce}`);
    expect(dry.out).toContain(`  note gstack-trains:attempt:${nonce}:a1`);
    expect(fs.existsSync(trainDir)).toBe(true);
    const notesBefore = fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains').split(/\s/)[0]!;
    const forgot = queue(fx, ['train', 'forget', '--train', nonce]);
    expect([forgot.status, forgot.err]).toEqual([EXIT.ok, '']);
    expect(line(forgot.out, 'FORGOTTEN:')).toMatch(new RegExp(`^FORGOTTEN: 2 note\\(s\\) removed; notes pushed to origin refs/notes/gstack-trains \\(lease ${notesBefore.slice(0, 12)}\\); 1 local path\\(s\\) deleted$`));
    expect(fs.existsSync(trainDir)).toBe(false);
    const clean = path.join(fx.repo.root, 'clean-state');
    const status = queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: clean });
    expect(status.out).toContain('TRAIN: none live');
    expect(fs.existsSync(path.join(clean, 'ship-queue', 'trains', nonce))).toBe(false);
    expect(fs.existsSync(path.join(clean, 'ship-queue', 'ready', repoKey(fx), `1-${h1}.json`))).toBe(false);
    const again = queue(fx, ['train', 'forget', '--train', nonce]);
    expect(again.err).toMatch(new RegExp(`no train record ${nonce} here or in refs/notes/gstack-trains.*\\(QUEUE_PROOF_MISSING\\)`));
    const h3 = openPr(fx, '3');
    fx.write(d => { d.ci[h3] = [{ status: 'completed', conclusion: 'success' }]; });
    const pregate = path.join(fx.repo.root, 'pregate3.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(fx.repo, 'gstack-wtree', []).out.trim(), head: h3, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    expect(queue(fx, ['ready', '--pr', '3', '--pregate', pregate, '--no-screen']).status).toBe(EXIT.ok);
    const h4 = openPr(fx, '4');
    fx.write(d => { d.ci[h4] = [{ status: 'completed', conclusion: 'success' }]; });
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(fx.repo, 'gstack-wtree', []).out.trim(), head: h4, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    expect(queue(fx, ['ready', '--pr', '4', '--pregate', pregate, '--no-screen']).status).toBe(EXIT.ok);
    const receipt = queue(fx, ['train', 'forget', '--receipt', `3@${h3}`]);
    expect([receipt.status, line(receipt.out, 'FORGET:')]).toEqual([EXIT.ok, `FORGET: READY receipt #3 at ${h3.slice(0, 12)} (screen no-screen)`]);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'ready', repoKey(fx), `3-${h3}.json`))).toBe(false);
    const rebuilt = queue(fx, ['train', 'status'], { GSTACK_STATE_ROOT: path.join(fx.repo.root, 'clean-state-2') });
    expect(rebuilt.status).toBe(EXIT.ok);
    expect(fs.existsSync(path.join(fx.repo.root, 'clean-state-2', 'ship-queue', 'ready', repoKey(fx), `4-${h4}.json`))).toBe(true);
    expect(fs.existsSync(path.join(fx.repo.root, 'clean-state-2', 'ship-queue', 'ready', repoKey(fx), `3-${h3}.json`))).toBe(false);
    expect(queue(fx, ['train', 'forget', '--receipt', '3@abc']).err).toMatch(/--receipt takes <pr>@<full head sha>.*\(QUEUE_PROOF_MISSING\)/);
    expect(queue(fx, ['train', 'forget']).status).toBe(EXIT.usage);
    const { nonce: second } = (() => { readyReceipt(fx, '3', h3); readyReceipt(fx, '4', h4); const r = queue(fx, ['train', 'build', '--prs', `3@${h3},4@${h4}`, '--free-timeout', '1']); return { nonce: nonceOf(r.out) }; })();
    expect(queue(fx, ['train', 'verdict', '--train', second]).status).toBe(EXIT.ok);
    const hook = path.join(fx.repo.origin, 'hooks', 'pre-receive');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read o n r; do case "$r" in refs/notes/*) echo "notes frozen" >&2; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
    const localNotes = fx.repo.git('rev-parse', 'refs/notes/gstack-trains');
    const rejected = queue(fx, ['train', 'forget', '--train', second]);
    expect(rejected.status).toBe(EXIT.refused);
    expect(rejected.err).toMatch(/the notes ref was not updated \(git push refs\/notes\/gstack-trains rejected: .*notes frozen.*; the local notes ref was restored\); nothing deleted locally.*\(QUEUE_PROOF_MISSING\)/);
    expect(fs.existsSync(path.join(fx.state, 'ship-queue', 'trains', second, 'train.json'))).toBe(true);
    expect(fx.repo.git('rev-parse', 'refs/notes/gstack-trains')).toBe(localNotes);
    expect(fx.repo.git('notes', '--ref=refs/notes/gstack-trains', 'list').split('\n').length).toBeGreaterThan(0);
    fs.rmSync(hook);
    const trainFile = path.join(fx.state, 'ship-queue', 'trains', second, 'train.json');
    for (const state of ['dispatch-unknown', 'merging']) {
      const t = JSON.parse(fs.readFileSync(trainFile, 'utf8'));
      t.state = state;
      fs.writeFileSync(trainFile, JSON.stringify(t));
      const live = queue(fx, ['train', 'forget', '--train', second]);
      expect(live.status).toBe(EXIT.refused);
      expect(live.err).toMatch(new RegExp(`is ${state}; forget settles nothing that is still building, running or merging .*\\(QUEUE_PROOF_MISSING\\)`));
      expect(fs.existsSync(trainFile)).toBe(true);
    }
  }, 120_000);

  // Value: protects=a restarted controller re-arms with one command: watch continues from the record (free tests, gate dispatch, the pending run, the verdict) and prints NEXT;
  // fails_when=watch dispatches twice, blocks past --timeout, silently replaces a malformed --free-timeout with the default, or does not reach the verdict after a restart; why_new=no resumable follow existed (hand-run gh run watch chains died with the machine); seam=GSTACK_SHIP_QUEUE_POLL_MS; no_claim=real GitHub run timing
  test('watch resumes from free-pending through the gate dispatch to the verdict, times out with its own NEXT, and never dispatches twice', () => {
    const fx = make();
    fx.write(d => { d.rules['free-tests.yml'] = { status: 'in_progress', conclusion: null }; });
    const { nonce, r } = greenTrain(fx, { ...GREEN_GATE, status: 'in_progress', conclusion: null });
    expect(r.status).toBe(EXIT.refused);
    expect(trainJson(fx, nonce).state).toBe('free-pending');
    const waiting = queue(fx, ['train', 'watch', '--train', nonce, '--timeout', '1']);
    expect([waiting.status, result(waiting.out)]).toEqual([EXIT.refused, expect.stringContaining('status=incomplete')]);
    expect(waiting.out).toContain(`WATCH: train ${nonce} state=free-pending (resumable; rerun this command after an interruption)`);
    expect(next(waiting.out)).toBe(`NEXT: gstack-ship-queue train watch --train ${nonce} --timeout 1`);
    expect(dispatches(fx, 'evals.yml')).toEqual([]);
    fx.write(d => { for (const run of d.runs) if (run.workflow === 'free-tests.yml') Object.assign(run, { status: 'completed', conclusion: 'success' }); });
    const gate = queue(fx, ['train', 'watch', '--train', nonce, '--timeout', '1']);
    expect(gate.status).toBe(EXIT.refused);
    expect(gate.out).toContain(`WATCH: train build --train ${nonce}: free tests green, gate dispatched`);
    expect(gate.err).toMatch(/is still in_progress at the watch timeout.*\(QUEUE_TRAIN_PENDING\)/);
    expect(next(gate.out)).toBe(`NEXT: gstack-ship-queue train watch --train ${nonce} --timeout 1`);
    expect(dispatches(fx, 'evals.yml').length).toBe(1);
    expect(trainJson(fx, nonce).state).toBe('gate-pending');
    const again = queue(fx, ['train', 'watch', '--train', nonce, '--timeout', '1']);
    expect([again.status, dispatches(fx, 'evals.yml').length]).toEqual([EXIT.refused, 1]);
    fx.write(d => { for (const run of d.runs) if (run.workflow === 'evals.yml') Object.assign(run, { status: 'completed', conclusion: 'success' }); });
    const done = queue(fx, ['train', 'watch', '--train', nonce, '--timeout', '5']);
    expect([done.status, done.err]).toEqual([EXIT.ok, '']);
    expect(done.out).toContain('WATCH: gate run completed; reading the verdict');
    expect(line(done.out, 'VERDICT:')).toMatch(new RegExp(`^VERDICT: GREEN train ${nonce} run 10[0-9] `));
    expect(next(done.out)).toBe(`NEXT: gstack-ship-queue verify --pr 1 --train ${nonce}`);
    const idle = queue(fx, ['train', 'watch', '--train', nonce]);
    expect([idle.status, line(idle.out, 'WATCH: nothing')]).toEqual([EXIT.ok, 'WATCH: nothing to wait for in state green']);
    expect(next(idle.out)).toBe(`NEXT: gstack-ship-queue verify --pr 1 --train ${nonce}`);
    expect(queue(fx, ['train', 'watch']).status).toBe(EXIT.usage);
    expect(queue(fx, ['train', 'watch', '--train', nonce, '--free-timeout', 'abc']).status).toBe(EXIT.usage);
    expect(queue(fx, ['train', 'watch', '--train', 'no-such-train']).err).toMatch(/no train record no-such-train.*\(QUEUE_PROOF_MISSING\)/);
  }, 120_000);
});

describe('verify --post-merge', () => {
  // Value: protects=after a train merges, the coordinator watches main's push workflows at the merged sha until they settle instead of a background gh chain a restart kills (GBrain practice 8);
  // fails_when=a pending check is called settled, a red check is called green, a pending or failed commit status (the legacy status API, which ciAtHead counts) is reported as red with no name or as green, or the command needs process state; why_new=no post-merge watch existed; seam=the gh shim's check runs and commit statuses at a sha; no_claim=which workflows main runs
  test('waits for every check run at the sha to complete, prints each, is green only when none failed, red with the failed names, pending or red on a commit status, and resumable after a timeout', () => {
    const fx = make();
    const sha = fx.repo.git('rev-parse', 'HEAD');
    fx.write(d => { d.ci[sha] = [{ name: 'free-tests', status: 'completed', conclusion: 'success' }, { name: 'windows-free-tests', status: 'in_progress', conclusion: null }, { name: 'main-backstop', status: 'completed', conclusion: 'neutral' }]; });
    const pending = queue(fx, ['verify', '--post-merge', sha, '--timeout', '1']);
    expect(pending.status).toBe(EXIT.refused);
    expect(line(pending.out, 'POST_MERGE:')).toBe(`POST_MERGE: ${sha.slice(0, 12)} pending (passed=1 failed=0 pending=1 skipped=1)`);
    expect(pending.out).toContain('CHECK: windows-free-tests in_progress');
    expect(pending.err).toMatch(new RegExp(`main's push workflows at ${sha.slice(0, 12)} have not settled .*windows-free-tests.*\\(QUEUE_TRAIN_PENDING\\)`));
    expect(next(pending.out)).toBe(`NEXT: gstack-ship-queue verify --post-merge ${sha} --timeout 1`);
    fx.write(d => { d.ci[sha]![1] = { name: 'windows-free-tests', status: 'completed', conclusion: 'failure' }; });
    const red = queue(fx, ['verify', '--post-merge', sha, '--timeout', '1']);
    expect(red.status).toBe(EXIT.fail);
    expect(line(red.out, 'POST_MERGE:')).toBe(`POST_MERGE: ${sha.slice(0, 12)} red (passed=1 failed=1 pending=0 skipped=1)`);
    expect(red.out).toContain('CHECK: windows-free-tests failure');
    expect(red.err).toMatch(new RegExp(`main's push workflows at ${sha.slice(0, 12)} are red: windows-free-tests.*\\(QUEUE_POST_MERGE_RED\\)`));
    expect(next(red.out)).toBe('NEXT: read the red run, repair on a new PR or roll back; gstack-ship-queue train status names the freeze if the backstop filed one');
    fx.write(d => { d.ci[sha]![1] = { name: 'windows-free-tests', status: 'completed', conclusion: 'success' }; });
    const green = queue(fx, ['verify', '--post-merge', sha, '--timeout', '1']);
    expect([green.status, green.err]).toEqual([EXIT.ok, '']);
    expect(line(green.out, 'POST_MERGE:')).toBe(`POST_MERGE: ${sha.slice(0, 12)} green (passed=2 failed=0 pending=0 skipped=1)`);
    expect(green.out.split('\n').filter(l => l.startsWith('CHECK: ')).sort()).toEqual(['CHECK: free-tests success', 'CHECK: main-backstop neutral', 'CHECK: windows-free-tests success']);
    expect(next(green.out)).toBe('NEXT: none');
    fx.write(d => { d.statuses = { [sha]: [{ state: 'pending', context: 'ci/vendor' }] }; });
    const statusPending = queue(fx, ['verify', '--post-merge', sha, '--timeout', '1']);
    expect([statusPending.status, line(statusPending.out, 'POST_MERGE:')]).toEqual([EXIT.refused, `POST_MERGE: ${sha.slice(0, 12)} pending (passed=2 failed=0 pending=1 skipped=1)`]);
    expect(statusPending.err).toMatch(/have not settled at the timeout: a commit status still running.*\(QUEUE_TRAIN_PENDING\)/);
    fx.write(d => { d.statuses = { [sha]: [{ state: 'failure', context: 'ci/vendor' }] }; });
    const statusRed = queue(fx, ['verify', '--post-merge', sha, '--timeout', '1']);
    expect([statusRed.status, line(statusRed.out, 'POST_MERGE:')]).toEqual([EXIT.fail, `POST_MERGE: ${sha.slice(0, 12)} red (passed=2 failed=1 pending=0 skipped=1)`]);
    expect(statusRed.err).toMatch(/are red: a commit status \(no check run failed\).*\(QUEUE_POST_MERGE_RED\)/);
    fx.write(d => { d.statuses = {}; d.ci[sha] = []; });
    const none = queue(fx, ['verify', '--post-merge', sha, '--timeout', '1']);
    expect([none.status, line(none.out, 'POST_MERGE:')]).toEqual([EXIT.refused, `POST_MERGE: ${sha.slice(0, 12)} none (passed=0 failed=0 pending=0 skipped=0)`]);
    expect(none.err).toMatch(new RegExp(`no check run has attached to ${sha.slice(0, 12)} yet.*\\(QUEUE_TRAIN_PENDING\\)`));
    expect(queue(fx, ['verify', '--post-merge', 'not-a-sha']).status).toBe(EXIT.usage);
  }, 120_000);
});

describe('ready --dispatch-ci', () => {
  // Value: protects=a PR that conflicts with the base (a CHANGELOG-only conflict after every stamp) gets its free workflows dispatched on the branch, waited for, and its requires-remote pregate lanes cleared with the run URLs in one command, replacing the four-step hand procedure;
  // fails_when=the dispatch happens on a fork head, a red run clears a lane, a lane whose workflow was not dispatched is cleared, ready still says ci: none, or the CI_DISPATCH lines push the screen: line in front of READY (identifiers first); why_new=the ci-hint was advisory prose; seam=the gh shim's workflow run, run list and check runs; no_claim=GitHub's real dispatch latency
  test('dispatches the named workflows on a conflicting PR, waits for their runs, clears the matching pregate lanes with the run URLs and then READYs; a fork head and a red run are refused', () => {
    const { fx, head, pregate } = readyFixture();
    fx.write(d => {
      (d.prs['1'] as any).mergeable = 'CONFLICTING';
      d.ci[head] = [];
      d.rules['free-tests.yml'] = { ci: 'free-tests', headSha: head };
      d.rules['windows-free-tests.yml'] = { ci: 'windows-free-tests', headSha: head };
    });
    const tree = JSON.parse(fs.readFileSync(pregate, 'utf8')).tree;
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'requires-remote', checks: [{ id: 'unit', status: 'pass' }], requires_remote: [
      { lane: 'free-tests.yml/free-tests', platform: 'linux', workflow: 'free-tests.yml', job: 'free-tests', tests: ['test/a.test.ts'], receipt: null },
      { lane: 'windows-free-tests.yml/windows-free-tests', platform: 'windows', workflow: 'windows-free-tests.yml', job: 'windows-free-tests', tests: ['test/a.test.ts'], receipt: null },
      { lane: 'macos-free-tests.yml/macos', platform: 'macos', workflow: 'macos-free-tests.yml', job: 'macos', tests: ['test/b.test.ts'], receipt: null }] }));
    const plain = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen']);
    expect([plain.status, line(plain.out, 'ci:')]).toEqual([EXIT.refused, `ci: none at ${head.slice(0, 12)} (passed=0 failed=0 pending=0 skipped=0)`]);
    const r = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', 'free-tests.yml,windows-free-tests.yml', '--timeout', '5']);
    expect(r.out.split('\n').filter(l => l.startsWith('CI_DISPATCH:'))).toEqual([
      'CI_DISPATCH: free-tests.yml --ref pr-1 run 100 https://example.invalid/runs/100 success',
      'CI_DISPATCH: windows-free-tests.yml --ref pr-1 run 101 https://example.invalid/runs/101 success']);
    expect(r.out.split('\n').filter(l => l.startsWith('PREGATE_CLEARED:'))).toEqual([
      'PREGATE_CLEARED: free-tests.yml/free-tests https://example.invalid/runs/100',
      'PREGATE_CLEARED: windows-free-tests.yml/windows-free-tests https://example.invalid/runs/101']);
    expect(line(r.out, 'ci:')).toBe(`ci: green at ${head.slice(0, 12)} (passed=2 failed=0 pending=0 skipped=0)`);
    expect(line(r.out, 'PREGATE:')).toMatch(/^PREGATE: requires-remote .*/);
    expect(r.err).toMatch(/1 requires-remote obligation\(s\) without a receipt: macos-free-tests\.yml\/macos.*\(QUEUE_NOT_READY\)/);
    const saved = JSON.parse(fs.readFileSync(pregate, 'utf8'));
    expect(saved.requires_remote.map((l: any) => l.receipt)).toEqual(['https://example.invalid/runs/100', 'https://example.invalid/runs/101', null]);
    expect(dispatches(fx).map(l => l.workflow)).toEqual(['free-tests.yml', 'windows-free-tests.yml']);
    const again = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', 'free-tests.yml', '--timeout', '5']);
    expect(dispatches(fx).length).toBe(2);
    expect(line(again.out, 'CI_DISPATCH:')).toBe('CI_DISPATCH: free-tests.yml not dispatched (run 100 already concluded success at this head)');
    const cleared = JSON.parse(fs.readFileSync(pregate, 'utf8'));
    cleared.requires_remote[2].receipt = 'https://example.invalid/runs/7';
    fs.writeFileSync(pregate, JSON.stringify(cleared));
    const ok = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', 'free-tests.yml', '--timeout', '5']);
    expect([ok.status, ok.err]).toEqual([EXIT.ok, '']);
    const okLines = ok.out.split('\n');
    expect(okLines[0]).toBe('CI_DISPATCH: free-tests.yml not dispatched (run 100 already concluded success at this head)');
    expect(okLines[okLines.findIndex(l => l.startsWith('READY #1 ')) + 1]).toBe('screen: no-screen');
    fx.write(d => { d.rules['free-tests.yml'] = { ci: 'free-tests', conclusion: 'failure', headSha: head }; d.ci[head] = []; d.runs.length = 0; });
    const red = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', 'free-tests.yml', '--timeout', '5']);
    expect([red.status, line(red.out, 'CI_DISPATCH:')]).toEqual([EXIT.refused, 'CI_DISPATCH: free-tests.yml --ref pr-1 run 102 https://example.invalid/runs/102 failure']);
    expect(red.err).toMatch(new RegExp(`free-tests\\.yml run 102 concluded failure at ${head.slice(0, 12)}; a red run clears no lane.*\\(QUEUE_NOT_READY\\)`));
    expect(JSON.parse(fs.readFileSync(pregate, 'utf8')).requires_remote[0].receipt).toBe('https://example.invalid/runs/100');
    fx.write(d => { (d.prs['1'] as any).isCrossRepository = true; });
    const fork = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', 'free-tests.yml']);
    expect([fork.status, fork.err]).toEqual([EXIT.refused, expect.stringMatching(/#1's head is on a fork.*not dispatched.*\(QUEUE_TRAIN_UNTRUSTED\)/)]);
    expect(queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', '../evil.yml']).status).toBe(EXIT.usage);
  }, 120_000);

  // Value: protects=a conflicting PR cut before main gained windows-smoke.yml still gets its free-tests dispatch when the hint names both workflows (GitHub reads the workflow file from the branch, so dispatching the missing one could only fail);
  // fails_when=the missing workflow is dispatched, a missing workflow refuses the whole command, or a workflow the branch has is skipped; why_new=windows-smoke.yml replaced windows-free-tests.yml in the hint while open branches predate it; seam=git objects in the fixture checkout; no_claim=GitHub's exact error for a workflow missing at the ref
  test('skips a workflow the base has but the PR head predates, with a note, and dispatches the rest', () => {
    const { fx, head, pregate } = readyFixture();
    const { repo } = fx;
    repo.git('checkout', '-q', 'origin/main');
    fs.mkdirSync(path.join(repo.work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, '.github', 'workflows', 'windows-smoke.yml'), 'name: Windows Smoke\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'add windows-smoke.yml');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'pr-1');
    fx.write(d => {
      (d.prs['1'] as any).mergeable = 'CONFLICTING';
      d.ci[head] = [];
      d.rules['free-tests.yml'] = { ci: 'free-tests', headSha: head };
      d.rules['windows-smoke.yml'] = { ci: 'windows-smoke', headSha: head };
    });
    const r = queue(fx, ['ready', '--pr', '1', '--pregate', pregate, '--no-screen', '--dispatch-ci', 'free-tests.yml,windows-smoke.yml', '--timeout', '5']);
    expect(r.out.split('\n').filter(l => l.startsWith('CI_DISPATCH:'))).toEqual([
      'CI_DISPATCH: free-tests.yml --ref pr-1 run 100 https://example.invalid/runs/100 success',
      `CI_DISPATCH: windows-smoke.yml not dispatched (.github/workflows/windows-smoke.yml is on main but not in ${head.slice(0, 12)}; the branch predates it, so its pull_request run comes with the stamp commit)`]);
    expect(dispatches(fx).map(l => l.workflow)).toEqual(['free-tests.yml']);
    expect(line(r.out, 'ci:')).toBe(`ci: green at ${head.slice(0, 12)} (passed=1 failed=0 pending=0 skipped=0)`);
  }, 120_000);
});

describe('train build --dry-run --stack-tests', () => {
  // Value: protects=a PR whose new tests pass on its own branch but fail once stacked behind another PR's change is caught before the train spends a gate (#3460 on #3451, 2026-10-26);
  // fails_when=the new test files run against the PR head instead of the integrated prefix, a failing prefix still dry-runs green, or a PR without new tests (a helper under test/ included: bun exits 1 when a positional filter matches no test file) is misreported; why_new=no pre-dispatch stack check existed; seam=bun test in a scratch worktree; no_claim=the repo's full suite on the prefix
  test('runs each PR\'s new test files on its integrated prefix T<k>: a pass and a helper-only PR are reported, a failure refuses the dry run and names the prefix, and the ordinary dry run skips it', () => {
    const fx = make();
    const h1 = openPr(fx, '1', { file: 'test/pr-1_test.ts', text: "import { expect, test } from 'bun:test';\ntest('pr-1', () => { expect(1).toBe(1); });\n" });
    const h2 = openPr(fx, '2', { file: 'test/pr-2.test.ts', text: "import { existsSync } from 'node:fs';\nimport { expect, test } from 'bun:test';\ntest('pr-2 wants no pr-1 test beside it', () => { expect(existsSync('test/pr-1_test.ts')).toBe(false); });\n" });
    const h3 = openPr(fx, '3', { file: 'test/helpers/pr-3-helper.ts', text: 'export const three = 3;\n' });
    readyReceipt(fx, '1', h1);
    readyReceipt(fx, '2', h2);
    readyReceipt(fx, '3', h3);
    const plain = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2},3@${h3}`, '--dry-run']);
    expect([plain.status, plain.out.includes('STACK_TESTS:')]).toEqual([EXIT.ok, false]);
    const r = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2},3@${h3}`, '--dry-run', '--stack-tests']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out.split('\n').filter(l => l.startsWith('STACK_TESTS:'))).toEqual([
      'STACK_TESTS: #1 T1 1 new test file(s) pass (test/pr-1_test.ts)',
      expect.stringMatching(/^STACK_TESTS: #2 T2 1 new test file\(s\) FAIL \(test\/pr-2\.test\.ts\): .*\(fail\) pr-2 wants no pr-1 test beside it.*1 fail$/),
      'STACK_TESTS: #3 T3 no new test files']);
    expect(r.err).toMatch(/#2's new tests fail on the integrated prefix T2 \(test\/pr-2\.test\.ts\); they pass on the PR head alone only if nothing before it in the train changes what they read.*\(QUEUE_TRAIN_STACK_RED\)/);
    expect(next(r.out)).toBe(`NEXT: fix #2's tests against T2, or reorder with --order, then gstack-ship-queue train build --prs 1@${h1},2@${h2},3@${h3} --dry-run --stack-tests`);
    expect(line(r.out, 'DRY-RUN:')).toBe('DRY-RUN: nothing written, pushed or dispatched');
    const reordered = queue(fx, ['train', 'build', '--prs', `1@${h1},2@${h2},3@${h3}`, '--order', '2,1,3', '--dry-run', '--stack-tests']);
    expect(reordered.status).toBe(EXIT.ok);
    expect(reordered.out.split('\n').filter(l => l.startsWith('STACK_TESTS:'))).toEqual([
      'STACK_TESTS: #2 T1 1 new test file(s) pass (test/pr-2.test.ts)',
      'STACK_TESTS: #1 T2 1 new test file(s) pass (test/pr-1_test.ts)',
      'STACK_TESTS: #3 T3 no new test files']);
    expect(fx.repo.git('worktree', 'list', '--porcelain')).not.toContain('gstack-stack-tests-');
    expect(queue(fx, ['train', 'build', '--prs', `1@${h1}`, '--stack-tests']).status).toBe(EXIT.usage);
  }, 180_000);
});
