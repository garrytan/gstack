/**
 * ship-queue-land-direct — B1's merge step, behind `gstack-ship-queue land --pr <n> --pin <sha>` under the base
 * policy's merge: direct (docs/ship-policy.md#land-direct). The PR merges at its own green head: no train and no stamp
 * commit. It refuses unless the /ship receipt and the READY note are bound to the pin, the pin is the PR's head, the
 * diff leaves VERSION, the manifest version and the CHANGELOG at its merge base
 * (versions are set at release), every check at the pin is green with none pending and each required check present,
 * and GitHub reports the PR mergeable and clean. Then land takes the land lock and re-fetches the base. When the base
 * moved past the pin's merge base, the checks at the pin never saw the tree that would land (GST-1316), so land builds
 * the pin merged onto the base tip and runs the base policy's land.merged_checks there (lib/land-merged-checks.ts;
 * repo commands, so only under --allow-repo-commands and never under --dry-run), refusing on a conflict or a failure;
 * with no list it prints a STALE_BASE: warn line and lands. Then gh pr merge --squash --match-head-commit <pin>, a check
 * that the merge commit's tree is the pin merged onto that commit's parent (its merged checks rerun when that parent is
 * neither the base land checked nor in the pin), a land note on refs/notes/gstack-trains, and the lock's release. A
 * rerun after GitHub merged goes straight to the tree check.
 */
import { runMergedChecks } from './land-merged-checks';
import { classifyRelease, RELEASE_BRANCH } from './release-stamp';
import { versionAtRef } from './restamp';
import type { ShipPolicy } from './ship-policy';
import { ciAtHead, loadBasePolicy, type QueueContext, type StepOutput } from './ship-queue';
import { git, type QueueFailure } from './ship-queue-gate';
import { acquireLandLock, lockLabel, ownsLock, readLock, type HeldLandLock, type LandLock } from './ship-queue-land-lock';
import * as os from 'node:os';
import { activeFreeze, loadReady, persist, rebuildFromNotes, repoIdentity, type FreezeRecord } from './ship-queue-train-record';
import { bindShippedReceipt } from './ship-receipt-depth';

interface DirectPr { state: string; baseRefName?: string; headRefName: string; headRefOid: string; isCrossRepository: boolean; body: string; mergeable?: string; mergeStateStatus?: string; mergeCommit?: { oid: string } | null }
export interface DirectOptions { pr: string; pin: string; dryRun?: boolean; allowRepoCommands?: boolean; breakLock?: boolean; repair?: boolean; now?: () => Date }

const isSha = (s: string | undefined) => /^[0-9a-f]{40,64}$/.test(s ?? '');

function view(ctx: QueueContext, pr: string): DirectPr | QueueFailure {
  const r = ctx.gh(['pr', 'view', pr, '--json', 'state,baseRefName,headRefName,headRefOid,isCrossRepository,body,mergeable,mergeStateStatus,mergeCommit']);
  try { return JSON.parse(r.out) as DirectPr; } catch { return { code: 'QUEUE_NOT_READY', message: `gh pr view ${pr} failed: ${(r.err ?? r.out).trim().slice(0, 160)}` }; }
}

/**
 * Whether `land --pin --repair` may record #pr@pin as the freeze's one repair (docs/ship-policy.md#direct-freeze): null
 * admits. A repair already recorded at another pin gives way once GitHub reports it did not merge at that pin; one that merged there
 * holds the slot until the main backstop clears the freeze or a red backstop on a main containing it frees the slot.
 */
function repairRefusal(ctx: QueueContext, freeze: FreezeRecord | null, pr: string, pin: string): QueueFailure | null {
  if (!freeze) return { code: 'QUEUE_NOT_READY', message: 'no freeze is active; --repair lands only the one repair PR a freeze admits', fix: `land it without --repair: gstack-ship-queue land --pr ${pr} --pin ${pin}` };
  if (freeze.train !== 'backstop') return { code: 'QUEUE_TRAIN_FROZEN', message: `train ${freeze.train} froze the queue (${freeze.reason}); land --pin --repair admits a repair only into a main backstop freeze`, fix: 'land the repair through train build --repair under merge: train; its verify clears the freeze' };
  const held = freeze.repair;
  if (!held || (held.pr === pr && held.head === pin && !held.train)) return null;
  const admitted = `the freeze admitted repair #${held.pr}@${held.head.slice(0, 12)}`;
  if (held.train) return { code: 'QUEUE_TRAIN_FROZEN', message: `repair train ${held.train} holds the freeze (${freeze.reason})`, fix: 'land the repair through that train; its verify clears the freeze' };
  const other = view(ctx, held.pr);
  if ('code' in other) return { code: 'QUEUE_TRAIN_FROZEN', message: `${admitted}, and whether it merged cannot be read: ${other.message}`, fix: `rerun land once gh pr view ${held.pr} answers` };
  if (other.state === 'MERGED' && other.headRefOid === held.head) return { code: 'QUEUE_TRAIN_FROZEN', message: `${admitted}, which merged; the queue stays frozen until the main backstop is green on a main that contains it, and a red backstop there frees the slot for the next repair`, fix: 'wait for the main backstop run on that merge (docs/ship-policy.md#direct-freeze)' };
  return null;
}

/** Release files the pin changed since its merge base: the version file, the manifest version and the CHANGELOG; an unreadable version is an error, never a pass. */
export function stampedFiles(root: string, policy: ShipPolicy, mergeBase: string, pin: string): string[] | { error: string } {
  const out: string[] = [];
  const [was, now] = [versionAtRef(root, mergeBase), versionAtRef(root, pin)];
  if ('error' in was || 'error' in now) return { error: 'error' in was ? was.error : (now as { error: string }).error };
  if (was.version !== now.version) out.push(now.rel);
  const npm = (rev: string) => { const r = git(root, ['show', `${rev}:package.json`]); try { return r.ok ? JSON.parse(r.out).version ?? null : null; } catch { return null; } };
  if (!('rel' in now && now.rel === 'package.json') && npm(mergeBase) !== npm(pin)) out.push('package.json version');
  if (policy.changelog && git(root, ['diff', '--quiet', mergeBase, pin, '--', policy.changelog]).ok === false) out.push(policy.changelog);
  if (!git(root, ['diff', '--quiet', mergeBase, pin, '--', '.gstack/version-path']).ok) out.push('.gstack/version-path');
  return out;
}

/** The pin's commit is local, fetched from its branch or GitHub's refs/pull/<n>/head (which outlives a deleted branch). */
function havePin(root: string, pr: string, pin: string, branch?: string): boolean {
  const have = () => git(root, ['cat-file', '-e', `${pin}^{commit}`]).ok;
  if (have()) return true;
  if (branch) git(root, ['fetch', '-q', 'origin', `refs/heads/${branch}`]);
  if (!have()) git(root, ['fetch', '-q', 'origin', `refs/pull/${pr}/head`]);
  return have();
}

/** The merge commit's tree is the pin merged onto the merge commit's first parent: GitHub merged exactly the pin. A read that fails is "cannot verify", never a mismatch. */
function verifyMerge(ctx: QueueContext, root: string, pr: string, pin: string, merge: string, lines: string[], run: string, now: Date, stamped?: string | 'pin-parent', merged: { checks: string[]; on?: string; allow?: boolean } = { checks: [] }): StepOutput {
  const cannot = (why: string): StepOutput => ({ ok: false, run, lines, failure: { code: 'QUEUE_NOT_READY', message: `#${pr} merged as ${merge.slice(0, 12)}, but land cannot verify it: ${why}`, fix: `fix the read named, then rerun gstack-ship-queue land --pr ${pr} --pin ${pin}; it goes straight to the tree check` } });
  if (!git(root, ['fetch', '-q', 'origin', ctx.base]).ok) return cannot(`git fetch origin ${ctx.base} failed`);
  if (!havePin(root, pr, pin)) return cannot(`the pin ${pin.slice(0, 12)} is not in this clone and refs/pull/${pr}/head did not fetch it`);
  const stampedOn = stamped === 'pin-parent' ? git(root, ['rev-parse', '--verify', '-q', `${pin}^1^{commit}`]).out : stamped;
  if (stampedOn !== undefined && !isSha(stampedOn)) return cannot(`cannot read the parent of the release pin ${pin.slice(0, 12)}, the ${ctx.base} commit it was stamped on`);
  if (!git(root, ['merge-base', '--is-ancestor', merge, `origin/${ctx.base}`]).ok) return { ok: false, run, lines, failure: { code: 'QUEUE_LAND_UNVERIFIED', message: `the merge commit ${merge.slice(0, 12)} is not on origin/${ctx.base}` } };
  const parent = git(root, ['rev-parse', `${merge}^1`]).out;
  if (!stampedOn && parent !== merged.on && !git(root, ['merge-base', '--is-ancestor', parent, pin]).ok) {
    const onto = `#${pr} merged as ${merge.slice(0, 12)} onto ${parent.slice(0, 12)}, which the pin ${pin.slice(0, 12)} does not contain`;
    const unverified = (why: string): StepOutput => ({ ok: false, run, lines, failure: { code: 'QUEUE_LAND_UNVERIFIED', message: `${onto}, so the checks at the pin never ran on the tree that landed, and ${why}`, fix: `run the free checks on origin/${ctx.base} at ${merge.slice(0, 12)} now; if one is red, fix forward or revert #${pr}, and report it to the Captain` } });
    if (merged.on === undefined && !merged.checks.length) lines.push(`STALE_BASE: warn ${onto}; no land.merged_checks configured, so the rerun checks the tree only`);
    else if (!merged.checks.length) return unverified('the base policy lists no land.merged_checks to run on it');
    else if (!merged.allow) return { ok: false, run, lines, failure: { code: 'REPO_COMMANDS_NOT_ALLOWED', message: `${onto}, so land must run land.merged_checks on the tree that landed; they are repo commands, so nothing ran`, fix: `rerun gstack-ship-queue land --pr ${pr} --pin ${pin} --allow-repo-commands` } };
    else {
      const mc = runMergedChecks(root, parent, pin, merged.checks);
      if (!mc.ok) return mc.setup ? cannot(mc.detail) : unverified(`land.merged_checks did not pass on it: ${mc.detail}`);
      lines.push(`MERGED_CHECKS: pass tree=${mc.tree} base=${parent} (after the merge, on the base GitHub merged onto)`);
    }
  }
  if (stampedOn && parent !== stampedOn) return { ok: false, run, lines, failure: { code: 'QUEUE_LAND_UNVERIFIED', message: `the release merged as ${merge.slice(0, 12)} onto ${parent.slice(0, 12)}, not onto ${stampedOn.slice(0, 12)} it was stamped on: a PR landed in between and ships under this version while its fragment waits for the next release`, fix: 'tell the Captain; the next release folds that fragment, so note the PR in its release notes' } };
  const tree = git(root, ['rev-parse', `${merge}^{tree}`]).out;
  const mt = git(root, ['merge-tree', '--write-tree', parent, pin]);
  const expected = mt.out.split('\n')[0] ?? '';
  if (!isSha(expected)) return cannot(`git merge-tree ${parent.slice(0, 12)} ${pin.slice(0, 12)} failed: ${mt.err.split('\n')[0]}`);
  if (!mt.ok || tree !== expected) return { ok: false, run, lines: [...lines, `MAIN: ${merge} tree=${tree} parent=${parent} expected=${expected || 'conflict'}`], failure: { code: 'QUEUE_LAND_UNVERIFIED', message: `origin/${ctx.base} ${merge.slice(0, 12)} is not the pin ${pin.slice(0, 12)} merged onto ${parent.slice(0, 12)}`, fix: `compare git diff ${expected || parent} ${merge} and revert what does not belong to #${pr}; report it to the Captain` } };
  const keys = repoIdentity(root);
  const at = now.toISOString();
  const note = persist(root, [{ schema: 1, kind: 'land', repo_key: keys.key, pr, pin, base_sha: parent, merge_sha: merge, tree, landed_at: at, updated_at: at }], { remote: ctx.remote });
  return { ok: true, run, lines: [...lines, `MERGED: #${pr} as ${merge}`, `LANDED: origin/${ctx.base} tree ${tree} equals the pin merged onto ${parent}`, `NOTE: land #${pr}@${pin.slice(0, 12)} (${note.detail})`] };
}

/** `gstack-ship-queue land --pr <n> --pin <sha>`: one pass; a refusal merges nothing. */
export function landDirect(ctx: QueueContext, o: DirectOptions): StepOutput {
  const root = ctx.repoRoot;
  const run = 'none';
  const now = o.now ?? (() => new Date());
  const fail = (lines: string[], failure: QueueFailure): StepOutput => ({ ok: false, lines, failure, run });
  if (!git(root, ['fetch', '-q', 'origin', ctx.base]).ok) return fail([], { code: 'QUEUE_NOT_READY', message: `cannot fetch origin/${ctx.base}; land reads the policy and the required checks from the current base`, fix: 'fix the fetch, then rerun land' });
  const loaded = loadBasePolicy(ctx);
  if ('message' in loaded) return fail([], loaded);
  const policy = loaded.policy;
  if (policy.merge === 'direct' && !policy.changelog_fragments) return fail([], { code: 'QUEUE_NOT_READY', message: 'merge: direct needs changelog_fragments: a PR carries its entry as a fragment, and ready records READY notes only under that key', fix: 'add "changelog_fragments": { "dir": "changelog.d" } to .gstack/ship-policy.json on the base' });
  if (policy.merge !== 'direct') return fail([], { code: 'QUEUE_NOT_READY', message: `the base policy sets merge: ${policy.merge}; land --pin merges only under merge: direct`, fix: 'land through the train (gstack-ship-queue train build), or set "merge": "direct" in .gstack/ship-policy.json on the base' });
  const info = view(ctx, o.pr);
  if ('code' in info) return fail([], info);
  const lines = [`LAND: #${o.pr} pin=${o.pin} direct`];
  if (info.isCrossRepository) return fail(lines, { code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr} is a fork head; land merges only crew branches` });
  if (info.baseRefName && info.baseRefName !== ctx.base) return fail(lines, { code: 'QUEUE_NOT_READY', message: `#${o.pr} targets ${info.baseRefName}, not ${ctx.base}`, fix: `retarget it to ${ctx.base}, or land its parent first` });
  const remote = ctx.remote ?? 'origin';
  const journal = `land-pin:${o.pin}`;
  const takeLock = () => acquireLandLock({
    root, remote, holder: `${os.hostname()}:${process.pid}`, owner: { pr: o.pr }, journal, now, phase: () => 'merging', breakLock: o.breakLock,
    takeover: (held: LandLock) => !held.train && held.pr === o.pr && held.journal.startsWith('land-pin:') ? `LOCK: taking over #${o.pr}'s land lock that an earlier land --pin run left (${held.journal}, since ${held.started_at})` : null,
  });
  if (info.state === 'MERGED' && info.headRefOid === o.pin && isSha(info.mergeCommit?.oid)) {
    lines.push(`#${o.pr} is already merged as ${info.mergeCommit!.oid.slice(0, 12)}; checking the tree`);
    if (o.dryRun) return { ok: true, run, lines: [...lines, 'DRY-RUN: nothing verified (a rerun without --dry-run runs the tree check and writes the land note)'] };
    const out = verifyMerge(ctx, root, o.pr, o.pin, info.mergeCommit!.oid, lines, run, now(), RELEASE_BRANCH.test(info.headRefName) ? 'pin-parent' : undefined, { checks: policy.land?.merged_checks ?? [], allow: o.allowRepoCommands });
    const left = readLock(root, remote);
    if (left.state !== 'held' || !ownsLock(left.lock, { pr: o.pr }, journal)) return out;
    const got = takeLock();
    const freed = 'held' in got && got.held.release();
    return { ...out, lines: [...out.lines, freed ? `LOCK: released the land lock an earlier run of this land left` : `LOCK: warn the land lock an earlier run of this land left is still held; rerun this land to release it`] };
  }
  if (info.state !== 'OPEN') return fail(lines, { code: 'QUEUE_NOT_READY', message: `#${o.pr} is ${info.state}` });
  if (info.headRefOid !== o.pin) return fail(lines, { code: 'QUEUE_LAND_PIN_MOVED', message: `#${o.pr}'s head is ${info.headRefOid.slice(0, 12)}, not the pin ${o.pin.slice(0, 12)}`, fix: `the lane runs /ship and gstack-ship-queue ready --pr ${o.pr} at the new head and reports READY with it` });

  if (!havePin(root, o.pr, o.pin, info.headRefName)) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot fetch the pin ${o.pin.slice(0, 12)} from ${info.headRefName} or refs/pull/${o.pr}/head`, fix: 'fix the fetch, then rerun land' });
  const mergeBase = git(root, ['merge-base', `origin/${ctx.base}`, o.pin]).out;
  if (!isSha(mergeBase)) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot compute the merge base of the pin ${o.pin.slice(0, 12)} and origin/${ctx.base}, so the release-file check cannot run`, fix: `git fetch origin ${ctx.base} and the PR head (an unshallow clone), then rerun land` });
  const named = RELEASE_BRANCH.exec(info.headRefName)?.[1];
  const release = named ? classifyRelease({ repoRoot: root, policy, mergeBase, head: o.pin }) : null;
  if (release?.ok && release.version !== named) return fail(lines, { code: 'RELEASE_STAMP_INVALID', message: `${info.headRefName} stamps v${release.version}, not the version its branch names`, fix: 'close it and run gstack-release-stamp open again' });
  if (release && !release.ok) return fail(lines, { code: 'RELEASE_STAMP_INVALID', message: `${info.headRefName} is not the release stamp of its merge base ${mergeBase.slice(0, 12)}: ${release.reason}`, fix: 'close it and run gstack-release-stamp open again; never edit a release branch by hand' });
  const releaseMoved = (tip: string): QueueFailure | null => release && mergeBase !== tip ? { code: 'RELEASE_STAMP_INVALID', message: `origin/${ctx.base} moved to ${tip.slice(0, 12)} since ${info.headRefName} was stamped on ${mergeBase.slice(0, 12)}; the PRs that landed since would ship under this version while their fragments wait for the next release`, fix: 'run gstack-release-stamp open again (it replaces the release branch), then land the new head' } : null;
  const moved = releaseMoved(git(root, ['rev-parse', `origin/${ctx.base}`]).out);
  if (moved) return fail(lines, moved);
  const keys = repoIdentity(root).keys;
  rebuildFromNotes(root, ctx.remote ?? 'origin');
  if (release) lines.push(`RELEASE: v${release.version} folds ${release.fragments.length} fragment(s) and changes nothing but the stamp, so it needs no /ship receipt or READY note`);
  else {
    const receipt = bindShippedReceipt(root, `origin/${ctx.base}`, info.body ?? '', o.pr, [o.pin]);
    lines.push(receipt.line, ...(receipt.depthLine ? [receipt.depthLine] : []), ...(receipt.targetedLine ? [receipt.targetedLine] : []));
    if (!receipt.ok) return fail(lines, { code: receipt.code, message: receipt.message, fix: `run /ship at the pin, then gstack-ship-queue ready --pr ${o.pr}` });
    if (!loadReady(keys, o.pr, o.pin)) return fail(lines, { code: 'QUEUE_NOT_READY', message: `no READY note for #${o.pr} at the pin ${o.pin.slice(0, 12)}`, fix: `the lane runs gstack-ship-queue ready --pr ${o.pr} --no-screen at the pin` });
  }
  const freeze = activeFreeze(keys);
  if (freeze && !o.repair) return fail(lines, { code: 'QUEUE_TRAIN_FROZEN', message: `main is frozen by train ${freeze.train} (${freeze.reason})`, fix: 'only the one repair PR lands: gstack-ship-queue land --pr <repair-pr> --pin <sha> --repair; the freeze clears when the main backstop is green on a main that contains it (docs/ship-policy.md#direct-freeze)' });
  const refused = !o.repair ? null : release ? { code: 'QUEUE_TRAIN_FROZEN' as const, message: `${info.headRefName} is a release PR, which never repairs main`, fix: 'land the revert or fix-forward with --repair; release once the backstop clears the freeze' } : repairRefusal(ctx, freeze, o.pr, o.pin);
  if (refused) return fail(lines, refused);
  const lock = o.dryRun ? readLock(root, remote) : null;
  if (lock?.state === 'held') return fail(lines, { code: 'QUEUE_LAND_LOCKED', message: `${lockLabel(lock.lock)} holds the land lock; a direct land would race it onto main` });

  const stamped = release ? [] : stampedFiles(root, policy, mergeBase, o.pin);
  if ('error' in stamped) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot read the version at the pin or its merge base: ${stamped.error}` });
  if (stamped.length) {
    const files = stamped.filter(f => f !== 'package.json version');
    const restore = files.length ? `git checkout $(git merge-base origin/${ctx.base} HEAD) -- ${files.join(' ')}` : '';
    const npm = stamped.includes('package.json version') ? 'set package.json "version" back to its merge base value' : '';
    return fail(lines, { code: 'QUEUE_LAND_STAMPED', message: `#${o.pr} changes ${stamped.join(', ')}; under merge: direct the release sets versions and the CHANGELOG, a PR carries only its changelog fragment`, fix: `${[restore, npm].filter(Boolean).join(' and ')}, keep (or add) the changelog.d fragment, commit, then /ship and ready at the new head` });
  }

  const ci = ciAtHead(ctx, o.pin);
  lines.push(`CI: ${ci.line}`);
  if (!ci.green) return fail(lines, { code: 'QUEUE_LAND_CHECKS', message: `checks are ${ci.line}`, fix: `wait for pending checks (gstack-pr-wait ${o.pr} --until green), or fix the red one at a new head; then rerun land` });
  const passed = new Set([...ci.checks.filter(c => c.conclusion === 'success').map(c => c.name), ...ci.contexts.filter(c => c.state === 'success').map(c => c.name)]);
  const missing = (policy.changelog_fragments?.required_checks ?? []).filter(n => !passed.has(n));
  if (missing.length) return fail(lines, { code: 'QUEUE_LAND_CHECKS', message: `required check(s) ${missing.join(', ')} did not pass at the pin ${o.pin.slice(0, 12)}`, fix: `dispatch them on the branch (gh workflow run <workflow> --ref ${info.headRefName}) and rerun land once they pass` });
  if (info.mergeable !== 'MERGEABLE' || info.mergeStateStatus !== 'CLEAN') return fail(lines, { code: 'QUEUE_LAND_NOT_CLEAN', message: `GitHub reports #${o.pr} mergeable=${info.mergeable ?? 'unknown'} mergeStateStatus=${info.mergeStateStatus ?? 'unknown'}`, fix: info.mergeable === 'CONFLICTING' ? `the lane merges origin/${ctx.base} into the branch, resolves, runs /ship and ready at the new head` : 'UNKNOWN means GitHub is still computing: rerun land in a minute; BLOCKED or BEHIND names the branch rule to meet first' });
  let held: HeldLandLock | undefined;
  if (!o.dryRun) {
    const got = takeLock();
    lines.push(...got.lines);
    if ('failure' in got) return fail(lines, got.failure);
    held = got.held;
  }
  const locked = (): StepOutput => {
    if (held && !git(root, ['fetch', '-q', 'origin', ctx.base]).ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot re-fetch origin/${ctx.base} under the land lock`, fix: 'fix the fetch, then rerun land' });
    const tip = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
    const current = loadBasePolicy(ctx);
    if ('message' in current) return fail(lines, current);
    if (current.policy.merge !== 'direct') return fail(lines, { code: 'QUEUE_NOT_READY', message: `the base policy at ${tip.slice(0, 12)} no longer sets merge: direct`, fix: 'land through the train' });
    const checks = current.policy.land?.merged_checks ?? [];
    const staleRelease = releaseMoved(tip);
    if (staleRelease) return fail(lines, staleRelease);
    if (mergeBase !== tip) {
      const moved = `origin/${ctx.base} moved to ${tip.slice(0, 12)} since the pin's merge base ${mergeBase.slice(0, 12)}, so the checks at the pin never ran on the tree that would land`;
      if (!checks.length) lines.push(`STALE_BASE: warn ${moved}; no land.merged_checks configured, so land merges it untested`);
      else if (o.dryRun) lines.push(`DRY-RUN: land.merged_checks not run (repo commands never run under --dry-run); a real land with --allow-repo-commands runs ${checks.length} on the pin merged onto ${tip.slice(0, 12)}`);
      else if (!o.allowRepoCommands) return fail(lines, { code: 'REPO_COMMANDS_NOT_ALLOWED', message: `${moved}, so land must run land.merged_checks on the pin merged onto it; they are repo commands (the merged tree's package.json decides what they run), so nothing ran and nothing merged`, fix: `rerun gstack-ship-queue land --pr ${o.pr} --pin ${o.pin} --allow-repo-commands` });
      else {
        const mc = runMergedChecks(root, tip, o.pin, checks);
        if (!mc.ok && mc.setup) return fail(lines, { code: 'QUEUE_NOT_READY', message: `${moved}, and land could not run land.merged_checks on the pin merged onto it: ${mc.detail}; nothing merged`, fix: `if the checkout is the problem, fix it and rerun land; if the dependencies changed, the lane merges origin/${ctx.base} into the branch, waits for the required checks, runs /ship and ready at the new head` });
        if (!mc.ok) return fail(lines, mc.conflict ? { code: 'QUEUE_LAND_NOT_CLEAN', message: `${moved}: ${mc.detail}`, fix: `the lane merges origin/${ctx.base} into the branch, resolves, runs /ship and ready at the new head` } : { code: 'QUEUE_LAND_MERGED_CHECKS', message: `${moved}; on the pin merged onto it, ${mc.detail}`, fix: `merge the base into the branch (git merge origin/${ctx.base}), fix what the failing check names, push, wait for the required checks at the new head, run /ship and gstack-ship-queue ready --pr ${o.pr} there, then land the new pin` });
        lines.push(`MERGED_CHECKS: pass tree=${mc.tree} base=${tip} pin=${o.pin.slice(0, 12)} checks: ${checks.join('; ')}`);
      }
    }
    if (o.dryRun) return { ok: true, run, lines: [...lines, `DRY-RUN: nothing merged (would run gh pr merge ${o.pr} --squash --match-head-commit ${o.pin})`] };
    if (o.repair) {
      if (!rebuildFromNotes(root, remote).fetched) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot fetch refs/notes/gstack-trains under the land lock, so the freeze's repair slot cannot be read; nothing merged`, fix: 'fix the fetch, then rerun land' });
      const frozen = activeFreeze(keys);
      const taken = repairRefusal(ctx, frozen, o.pr, o.pin);
      if (taken) return fail(lines, taken);
      if (frozen!.repair?.pr !== o.pr || frozen!.repair.head !== o.pin) {
        frozen!.repair = { pr: o.pr, head: o.pin, train: null };
        frozen!.updated_at = now().toISOString();
        const saved = persist(root, [frozen!], { remote });
        if (!saved.pushed) return fail(lines, { code: 'QUEUE_NOT_READY', message: `cannot record #${o.pr} as the freeze's repair: ${saved.detail}; nothing merged`, fix: 'fix the notes push, then rerun land' });
      }
      lines.push(`REPAIR: #${o.pr}@${o.pin.slice(0, 12)} admitted under the land lock; the freeze stays active until the main backstop is green on a main that contains this merge`);
    }

    const method = policy.history === 'merge-only' ? '--merge' : '--squash';
    const lost = held!.set('merging');
    if (lost) return fail(lines, lost);
    const m = ctx.gh(['pr', 'merge', o.pr, method, '--match-head-commit', o.pin]);
    let merge: string | undefined;
    for (let i = 0; i < (m.ok ? 4 : 1) && !isSha(merge); i++) {
      if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
      const after = view(ctx, o.pr);
      merge = 'code' in after || after.state !== 'MERGED' ? undefined : after.mergeCommit?.oid;
    }
    if (!isSha(merge) && m.ok) return fail(lines, { code: 'QUEUE_NOT_READY', message: `gh pr merge accepted #${o.pr}, but GitHub does not show it merged yet; nothing is verified`, fix: `rerun gstack-ship-queue land --pr ${o.pr} --pin ${o.pin} in a minute; once GitHub shows the merge it goes straight to the tree check` });
    if (!isSha(merge)) return fail(lines, { code: 'QUEUE_NOT_READY', message: `gh pr merge refused: ${(m.err ?? m.out).trim().slice(0, 200) || 'the PR is not merged'}`, fix: `read the refusal; rerun land --pr ${o.pr} --pin ${o.pin} once it is fixed` });
    return verifyMerge(ctx, root, o.pr, o.pin, merge!, lines, run, now(), release ? mergeBase : undefined, { checks, on: tip, allow: o.allowRepoCommands });
  };
  let out: StepOutput;
  let released = true;
  try { out = locked(); } finally { if (held) released = held.release(); }
  return released ? out : { ...out, lines: [...out.lines, `LOCK: warn the land lock release push failed, so the lock stays held; rerun gstack-ship-queue land --pr ${o.pr} --pin ${o.pin} to resume and release it`] };
}
