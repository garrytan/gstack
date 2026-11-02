/**
 * `train land --train <nonce> --pr <n>` (docs/ship-policy.md#train-land): the merge step for one slot of a train
 * whose slots publish their gated prefix exactly. A stamped train (changelog_fragments, GSTA-154 PR B; or a train with
 * gates under stamp-at-merge) publishes S_i; an unstamped train with gates (GSTA-157 PR 2) publishes T_i. With main's
 * tree equal to the prefix before the slot (slot 1: the train base), land picks one of two modes and records it, with
 * the update sha when there is one, in the train record and the notes before its first remote effect:
 *
 * - `update` (today's path): commit the prefix tree with parents [pin, main], push it to the PR branch under
 *   --force-with-lease=<branch>:<pin>, wait for the PR's checks on that commit, merge with --match-head-commit and
 *   the policy's merge method (train.land.merge_method, default squash; rebase is refused, since it would replay
 *   commits instead of landing the gated tree). Forced for a stamped train, strict branch protection (or protection
 *   that cannot be read), a conditional PR, a merge that needed release-file resolution, and a pin whose own checks
 *   are not green (they ran against an older base).
 * - `direct`: `gh pr merge --<method> --match-head-commit <pin>` once the PR's required checks are green at the pin
 *   and merging the pin onto main gives the gated tree exactly.
 *
 * Either way main's tree must be the prefix after the merge; any other main is the freeze path
 * (QUEUE_TRAIN_TREE_MISMATCH), as for verify. Fork heads are refused. Journaled beside the train record; a rerun
 * resumes: open at the pin, open at the update commit, or merged (confirmed through main's tree).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ciAtHead, type QueueContext } from './ship-queue';
import { git, writeJsonAtomic } from './ship-queue-gate';
import { waitChecks } from './ship-queue-land';
import { verifyPostMerge } from './ship-queue-post-merge';
import { bindTrainReceipt } from './ship-queue-train-gate';
import { checkRun, prInfo, type PrInfo } from './ship-queue-train-github';
import { activeFreeze, attemptsOf, nowIso, trainFile, type LandingRecord, type TrainRecord } from './ship-queue-train-record';
import { fetchBase, fetchTrainBranch, findTrain, frozenLines, nextFor, outFailed, outPending, outRefused, save, trainEnv, type TrainEnv, type TrainOut } from './ship-queue-train';
import { confirmMerged, stopped } from './ship-queue-train-verify';

const Q = 'gstack-ship-queue';
const STAMP_IDENTITY = { GIT_AUTHOR_NAME: 'gstack-ship-queue', GIT_AUTHOR_EMAIL: 'ship-queue@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-queue',
  GIT_COMMITTER_EMAIL: 'ship-queue@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
const isSha = (s: string) => /^[0-9a-f]{40,64}$/.test(s);
interface SlotJournal { schema_version: 1; pr: string; pin: string; stamp_commit: string; base: string }
interface Link { index: number; commit: string; tree: string; pin: string }
interface Slot { env: TrainEnv; t: TrainRecord; i: number; pin: string; target: Link & { version?: string }; pred: Link; run: string; rerun: string; lines: string[] }

/** The checks train land requires on the landing commit: changelog_fragments.required_checks, else train.land.required_checks. */
export const landRequiredChecks = (env: TrainEnv): string[] => env.policy.policy.changelog_fragments?.required_checks ?? env.train.land?.required_checks ?? [];

/** Required checks missing or not green in a ciAtHead read. */
function missingChecks(ci: ReturnType<typeof ciAtHead>, required: string[]): string[] {
  return required.filter(name => {
    const runs = ci.checks.filter(c => c.name === name || c.name.startsWith(`${name} (`));
    const contexts = ci.contexts.filter(c => c.name === name);
    return !(runs.length || contexts.length) || runs.some(c => c.status !== 'completed' || c.conclusion !== 'success') || contexts.some(c => c.state !== 'success');
  });
}

/** GitHub's answers that mean no required-checks protection; a bare 404 or 403 (a token that cannot read protection) is unreadable, never unprotected. */
export const UNPROTECTED = /Branch not protected|Required status checks not enabled/i;

/** Branch protection's "require branches to be up to date": true, false (unprotected or not strict), or null when unreadable. */
function strictProtection(ctx: QueueContext): boolean | null {
  const r = ctx.gh(['api', `repos/{owner}/{repo}/branches/${ctx.base}/protection/required_status_checks`]);
  if (!r.ok) return UNPROTECTED.test(`${r.err ?? ''} ${r.out}`) ? false : null;
  try { return (JSON.parse(r.out) as { strict?: unknown }).strict === true; } catch { return null; }
}

/** The gate a slot needs before it lands: a generic train's verdict seats it, else the gstack-evals green record and check run. */
function gateRefusal(ctx: QueueContext, env: TrainEnv, t: TrainRecord, i: number, run: string): TrainOut | null {
  if (t.gated) {
    if (t.verdict && i < t.verdict.landable) return null;
    return outRefused({ code: 'QUEUE_GATE_MISSING', message: t.verdict ? `train ${t.nonce}'s verdict (${t.verdict.kind}) lands slots 1..${t.verdict.landable}; #${t.slots[i]!.pr} is slot ${i + 1}` : `train ${t.nonce} has no verdict yet (state ${t.state})` }, [], nextFor(t), run);
  }
  const gate = attemptsOf(t).filter(a => a.purpose !== 'bisect').at(-1);
  if (gate?.outcome !== 'GREEN' || !['green', 'merging', 'merged'].includes(t.state)) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} has no green record (state ${t.state}, last gate ${gate?.outcome ?? 'none'})` }, [], nextFor(t), run);
  const check = checkRun(ctx, t.head, env.train.full_gate_check);
  if (check?.conclusion !== 'success') return outRefused({ code: 'QUEUE_GATE_MISSING', message: `no successful ${env.train.full_gate_check} check run on the train head ${t.head.slice(0, 12)}` }, [], `${Q} train verdict --train ${t.nonce}`, run);
  return null;
}

/** T0 and the published prefixes as the first-parent chain of the gated head, each slot's pin its second parent; null when the record disagrees. */
function landChain(root: string, t: TrainRecord): Link[] | null {
  const k = t.slots.length;
  const chain = Array.from({ length: k + 1 }, (_, n) => {
    const commit = git(root, ['rev-parse', '--verify', '-q', `${t.head}~${k - n}^{commit}`]).out;
    return { index: n, commit, tree: isSha(commit) ? git(root, ['rev-parse', `${commit}^{tree}`]).out : '', pin: n && isSha(commit) ? git(root, ['rev-parse', '--verify', '-q', `${commit}^2`]).out : '' };
  });
  const recorded = t.stamped ? [t.prefixes[0]!, ...t.stamped] : t.prefixes;
  if (t.stamped && t.stamped.length !== k) return null;
  if (t.gated && (t.gated.length !== k + 1 || t.gated.some((g, n) => g.commit !== recorded[n]?.commit || g.tree !== recorded[n]?.tree))) return null;
  return chain.some((c, n) => !isSha(c.commit) || c.commit !== recorded[n]?.commit || c.tree !== recorded[n]?.tree || (n > 0 && c.pin !== t.slots[n - 1]!.head)) ? null : chain;
}

function mainNow(ctx: QueueContext, env: TrainEnv): { sha: string; tree: string } | { error: string } {
  const error = fetchBase(ctx);
  if (error) return { error };
  const sha = git(ctx.repoRoot, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
  return { sha, tree: git(ctx.repoRoot, ['rev-parse', `${sha}^{tree}`]).out };
}

const label = (s: Slot) => (s.t.stamped ? `S${s.target.index}` : `T${s.target.index}`);

/** Record the slot's landing (mode, pin, update commit, base, expected tree) in the train record and the notes, before any remote effect. */
function recordLanding(s: Slot, mode: LandingRecord['mode'], update: string | null, base: string): void {
  s.t.landing = { ...s.t.landing, [s.t.slots[s.i]!.pr]: { slot: s.i + 1, mode, method: s.env.train.land?.merge_method ?? 'squash', pin: s.pin, update, base, expected_tree: s.target.tree, at: nowIso() } };
  if (s.t.state !== 'merged') s.t.state = 'merging';
  save(s.env, s.t);
}

/**
 * Which mode lands this slot, and why. `wait`: the pin's checks are still running, so whether the pin itself can be
 * merged is not known yet.
 */
function chooseMode(ctx: QueueContext, s: Slot, mainSha: string, conditional: boolean): { mode: 'direct' | 'update' | 'wait'; why: string } {
  if (s.t.stamped) return { mode: 'update', why: `the slot publishes the stamped ${label(s)}` };
  if (conditional) return { mode: 'update', why: 'a conditional (base-red) PR lands only through a commit whose own checks run on the gated tree' };
  if ((s.env.train.land?.merge_method ?? 'squash') === 'rebase') return { mode: 'update', why: 'a rebase replays the pin\'s commits, and the replayed tree is not the one the train gated' };
  const strict = strictProtection(ctx);
  if (strict !== false) return { mode: 'update', why: strict ? 'branch protection requires branches to be up to date' : 'branch protection could not be read, so the up-to-date path is taken' };
  const m = git(ctx.repoRoot, ['merge-tree', '--write-tree', mainSha, s.pin]);
  if (!m.ok || m.out.split('\n')[0] !== s.target.tree) return { mode: 'update', why: `merging the pin onto main does not give ${label(s)} exactly (the train resolved release files)` };
  const ci = ciAtHead(ctx, s.pin);
  const missing = missingChecks(ci, landRequiredChecks(s.env));
  if (ci.green && !missing.length) return { mode: 'direct', why: `the pin's checks are green (${ci.line}) and it merges onto main as ${label(s)} exactly` };
  if (ci.line.startsWith('pending') && !missing.some(n => !ci.checks.some(c => c.name === n || c.name.startsWith(`${n} (`)))) return { mode: 'wait', why: `the pin's checks are still running (${ci.line})` };
  return { mode: 'update', why: `the pin's own checks are not green (${ci.line}${missing.length ? `; missing ${missing.join(', ')}` : ''}); they ran against an older base` };
}

/** Merge with the policy's method at an exact head, then confirm main's tree is the slot's prefix. */
async function mergeAt(ctx: QueueContext, s: Slot, head: string, base: string): Promise<TrainOut> {
  const pr = s.t.slots[s.i]!.pr;
  const method = s.env.train.land?.merge_method ?? 'squash';
  let main = mainNow(ctx, s.env);
  if ('error' in main) return outPending({ code: 'QUEUE_PROOF_MISSING', message: main.error }, s.lines, s.rerun, s.run);
  if (main.sha !== base) return stopped(s.env, s.t, 'QUEUE_TRAIN_TREE_MISMATCH', `main moved to ${main.sha.slice(0, 12)} before the merge (the slot was prepared on ${base.slice(0, 12)})`, main.sha, s.lines, true);
  const target = prInfo(ctx, pr);
  if ('error' in target) return outPending({ code: 'QUEUE_PROOF_MISSING', message: target.error }, s.lines, s.rerun, s.run);
  if (target.baseRefName && target.baseRefName !== ctx.base) return retargeted(s, target.baseRefName, ctx.base);
  const m = ctx.gh(['pr', 'merge', pr, `--${method}`, '--match-head-commit', head]);
  if (!m.ok) return outFailed({ code: 'QUEUE_NOT_READY', message: `gh pr merge refused: ${(m.err ?? m.out).trim().slice(0, 200)}` }, s.lines, s.rerun, s.run);
  main = mainNow(ctx, s.env);
  if ('error' in main) return outPending({ code: 'QUEUE_PROOF_MISSING', message: `merged; ${main.error}` }, s.lines, s.rerun, s.run);
  if (main.sha === base) return outPending({ code: 'QUEUE_NOT_READY', message: `merged; main still reads ${base.slice(0, 12)}, so the merge is not visible yet` }, s.lines, s.rerun, s.run);
  if (main.tree !== s.target.tree) return stopped(s.env, s.t, 'QUEUE_TRAIN_TREE_MISMATCH', `after the merge main ${main.sha.slice(0, 12)} is not ${label(s)} exactly`, main.sha, s.lines, true);
  return confirmed(s, main.sha, `MERGED: #${pr} as ${main.sha} (${method}); main's tree is ${label(s)} exactly`);
}

/** The check names every workflows gate asks to see green on main after each land. */
export const postMergeChecks = (env: TrainEnv): string[] => (env.train.gates ?? []).flatMap(g => (g.kind === 'workflows' ? g.post_merge_checks ?? [] : []));

/** confirmMerged, with the post-merge checks a workflows gate declares in the NEXT: train land refuses the next slot until they are green. */
function confirmed(s: Slot, mainSha: string, line: string): TrainOut {
  const out = confirmMerged(s.env, s.t, s.t.slots[s.i]!.pr, mainSha, s.target.index, [...s.lines, line]);
  const post = postMergeChecks(s.env);
  if (!post.length || out.exit !== 0) return out;
  return { ...out, lines: [...out.lines, `POST_MERGE_CHECKS: ${post.join(', ')} at ${mainSha.slice(0, 12)}`], next: `${Q} verify --post-merge ${mainSha} --checks ${JSON.stringify(post.join(','))} && ${out.next}` };
}

/** `direct`: merge the pin itself once its required checks are green there. */
async function landDirect(ctx: QueueContext, s: Slot, info: PrInfo, base: string, why: string): Promise<TrainOut> {
  const pr = s.t.slots[s.i]!.pr;
  if (info.headRefOid !== s.pin) return stopped(s.env, s.t, 'QUEUE_TRAIN_MOVED', `#${pr}'s head is ${info.headRefOid.slice(0, 12)}, not its pin ${s.pin.slice(0, 12)}`, base, s.lines, true);
  const shipped = bindTrainReceipt(ctx.repoRoot, `refs/remotes/${s.env.remote}/${ctx.base}`, info.body, pr, [s.pin], false);
  s.lines.push(shipped.line, ...(shipped.depthLine ? [shipped.depthLine] : []), `MODE: direct (${why})`);
  if (!shipped.ok) return outRefused({ code: shipped.code, message: shipped.message }, s.lines, `#${pr}'s lane runs /ship at its pin and READYs again`, s.run);
  recordLanding(s, 'direct', null, base);
  return mergeAt(ctx, s, s.pin, base);
}

/** `update`: today's path, the prefix tree committed on [pin, main], pushed under the pin's lease, checked, then merged. */
async function landUpdate(ctx: QueueContext, s: Slot, info: PrInfo, base: string, why: string, o: { noWait?: boolean; timeoutMin?: number }): Promise<TrainOut> {
  const { env, t, pin } = s;
  const pr = t.slots[s.i]!.pr;
  const root = ctx.repoRoot;
  if ((env.train.land?.merge_method ?? 'squash') === 'rebase') return outRefused({ code: 'QUEUE_TRAIN_LAND_METHOD', message: `#${pr} must land through an update commit (${why}), and train.land.merge_method is rebase, which would replay commits instead of landing ${label(s)}` }, s.lines, 'none', s.run);
  s.lines.push(`MODE: update (${why})`);
  const what = t.stamped ? 'stamp' : 'update';
  const file = path.join(path.dirname(s.run), `land-${pr}.json`);
  let j: SlotJournal | null = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) as SlotJournal; } catch { j = null; }
  if (!j || j.base !== base || info.headRefOid !== j.stamp_commit) {
    const message = t.stamped ? `v${s.target.version} stamp: train ${t.nonce} S${s.target.index} (#${pr})` : `train ${t.nonce} T${s.target.index}: land #${pr} as the gated tree`;
    const commit = git(root, ['commit-tree', '--no-gpg-sign', s.target.tree, '-p', pin, '-p', base, '-m', message], { ...process.env, ...STAMP_IDENTITY }).out;
    if (!isSha(commit)) return outFailed({ code: 'QUEUE_LAND_CONFLICT', message: `cannot create the ${what} commit for tree ${s.target.tree.slice(0, 12)}; nothing pushed` }, s.lines, `${Q} train status --train ${t.nonce}`, s.run);
    if (![pin, commit, j?.stamp_commit].includes(info.headRefOid)) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${pr}'s head is ${info.headRefOid.slice(0, 12)}, not its pin ${pin.slice(0, 12)}`, base, s.lines, true);
    const shipped = bindTrainReceipt(root, `refs/remotes/${env.remote}/${ctx.base}`, info.body, pr, [pin], !!t.slots[s.i]!.base_red);
    s.lines.push(shipped.line, ...(shipped.depthLine ? [shipped.depthLine] : []));
    if (!shipped.ok) return outRefused({ code: shipped.code, message: shipped.message }, s.lines, `#${pr}'s lane runs /ship at its pin and READYs again`, s.run);
    if (!t.gated) {
      const added = ctx.gh(['pr', 'edit', pr, '--add-label', 'evals-no-debounce']);
      s.lines.push(`LABEL: evals-no-debounce ${added.ok ? 'added' : `not added (${(added.err ?? added.out).trim().slice(0, 80)}); the 10-minute quiet window applies`}`);
    }
    j = { schema_version: 1, pr, pin, stamp_commit: commit, base };
    writeJsonAtomic(file, j);
    recordLanding(s, 'update', commit, base);
    const pushed = info.headRefOid !== commit;
    if (pushed) {
      const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${info.headRefName}:${info.headRefOid}`, env.remote, `${commit}:refs/heads/${info.headRefName}`]);
      if (!push.ok) {
        const remote = git(root, ['ls-remote', env.remote, `refs/heads/${info.headRefName}`]);
        const now = remote.ok ? remote.out.split(/\s/)[0] ?? '' : '';
        if (remote.ok && now !== info.headRefOid && now !== commit) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${pr}'s branch moved off ${info.headRefOid.slice(0, 12)} before the ${what} push; train land never overwrites it`, base, s.lines, true);
        if (!remote.ok || now !== commit) return outFailed({ code: 'QUEUE_NOT_READY', message: `the ${what} push failed and ${info.headRefName} still reads ${remote.ok ? info.headRefOid.slice(0, 12) : 'unknown'}: ${push.err.split('\n')[0]}` }, s.lines, s.rerun, s.run);
      }
    }
    s.lines.push(`${pushed ? 'PUSHED' : 'RESUMED'}: ${commit} (tree ${label(s)}, parents [pin, main ${base.slice(0, 12)}]) ${pushed ? 'to' : 'is already the head of'} ${info.headRefName}`);
    if (o.noWait && pushed) return outPending({ code: 'QUEUE_NOT_READY', message: `checks run on the ${what} commit ${commit.slice(0, 12)}` }, s.lines, `gstack-pr-wait ${pr} --until green && ${s.rerun}`, s.run);
    if (!o.noWait) waitChecks(ctx, commit, o.timeoutMin ?? 60);
  }
  const head = prInfo(ctx, pr);
  if ('error' in head) return outPending({ code: 'QUEUE_PROOF_MISSING', message: head.error }, s.lines, s.rerun, s.run);
  if (head.headRefOid !== j.stamp_commit) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${pr}'s head is not the ${what} commit ${j.stamp_commit.slice(0, 12)}`, base, s.lines, true);
  if (head.baseRefName && head.baseRefName !== ctx.base) return retargeted(s, head.baseRefName, ctx.base);
  const ci = ciAtHead(ctx, j.stamp_commit);
  s.lines.push(`CI: ${ci.line}`);
  const missing = missingChecks(ci, landRequiredChecks(env));
  if (missing.length) {
    s.lines.push(`REQUIRED_CHECKS: not green at ${j.stamp_commit.slice(0, 12)}: ${missing.join(', ')}`);
    const fix = `wait for ${missing.join(', ')} to pass on ${j.stamp_commit.slice(0, 12)} (dispatch the workflow on ${head.headRefName} if it never ran), then ${s.rerun}`;
    return outPending({ code: 'QUEUE_NOT_READY', message: `required checks missing or not green on the ${what} commit ${j.stamp_commit.slice(0, 12)}: ${missing.join(', ')}`, fix }, s.lines, fix, s.run);
  }
  if (!ci.green) return outPending({ code: 'QUEUE_NOT_READY', message: `checks on the ${what} commit ${j.stamp_commit.slice(0, 12)} are not green` }, s.lines, `gstack-pr-wait ${pr} --until green && ${s.rerun}`, s.run);
  return mergeAt(ctx, s, j.stamp_commit, j.base);
}

const retargeted = (s: Slot, b: string, base: string) => outRefused({ code: 'QUEUE_NOT_READY', message: `#${s.t.slots[s.i]!.pr} targets ${b}, not ${base}; train land merges only PRs on the base the train built` }, s.lines, `retarget #${s.t.slots[s.i]!.pr} to ${base}, then ${s.rerun}`, s.run);

export async function trainLand(ctx: QueueContext, o: { train: string; pr: string; noWait?: boolean; timeoutMin?: number }): Promise<TrainOut> {
  const fetchErr = fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: fetchErr }, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const i = t.slots.findIndex(s => s.pr === o.pr);
  if (i < 0) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} does not include #${o.pr}` }, [], nextFor(t), run);
  if (!t.stamped && !t.gated) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} was built without stamped prefixes; merge it with the slot stamp and ${Q} verify` }, [], `${Q} verify --pr ${o.pr} --train ${t.nonce}`, run);
  const gate = gateRefusal(ctx, env, t, i, run);
  if (gate) return gate;
  if (!fetchTrainBranch(env, t)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the train's prefix commits are not here and ${t.branch} could not be fetched` }, [], `${Q} train status --train ${t.nonce}`, run);
  const freeze = activeFreeze(env.repo.keys);
  if (freeze && freeze.repair?.train !== t.nonce) return outRefused({ code: 'QUEUE_TRAIN_FROZEN', message: `the queue is frozen (${freeze.reason}); only the admitted repair train merges` }, frozenLines(freeze), `${Q} train build --repair --prs <repair-pr>@<sha>`, run);
  const chain = landChain(ctx.repoRoot, t);
  const k = t.slots.length;
  if (!chain) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the record's T0 and ${t.stamped ? 'S' : 'T'}1..${t.stamped ? 'S' : 'T'}${k} (with each slot's pin as second parent) are not the first-parent chain of the gated head ${t.head.slice(0, 12)}` }, [], `${Q} train status --train ${t.nonce}`, run);
  const pin = t.slots[i]!.head;
  const rerun = `${Q} train land --train ${t.nonce} --pr ${o.pr}`;
  const s: Slot = { env, t, i, pin, target: { ...chain[i + 1]!, version: t.stamped?.[i]?.version }, pred: chain[i]!, run, rerun, lines: [] };
  s.lines.push(`TRAIN_LAND: ${t.nonce} slot ${i + 1}/${k} #${o.pr} pin ${pin} -> ${label(s)}${s.target.version ? ` v${s.target.version}` : ''} tree ${s.target.tree}`);
  const main = mainNow(ctx, env);
  if ('error' in main) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: main.error }, s.lines, rerun, run);
  if (main.tree === s.target.tree) return confirmed(s, main.sha, `main: ${main.sha} is ${label(s)} exactly`);
  const earlier = chain.slice(0, i).find(p => p.tree === main.tree);
  if (earlier) return outRefused({ code: 'QUEUE_TRAIN_TREE_MISMATCH', message: `main is ${earlier.index ? (t.stamped ? 'S' : 'T') + earlier.index : 'the train base'}; land #${t.slots[earlier.index]!.pr} (slot ${earlier.index + 1}) first` }, s.lines, `${Q} train land --train ${t.nonce} --pr ${t.slots[earlier.index]!.pr}`, run);
  const later = chain.slice(i + 2).find(p => p.tree === main.tree);
  if (later) return confirmed(s, main.sha, `main: ${main.sha} is ${t.stamped ? 'S' : 'T'}${later.index}, past ${label(s)}`);
  if (main.tree !== s.pred.tree) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main ${main.sha.slice(0, 12)} is neither ${s.pred.index ? (t.stamped ? 'S' : 'T') + s.pred.index : 'T0'} nor ${label(s)} exactly`, main.sha, s.lines, true);
  const info = prInfo(ctx, o.pr);
  if ('error' in info) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: info.error }, s.lines, rerun, run);
  if (info.isCrossRepository) return outRefused({ code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr} is a fork head; train land pushes and merges only crew branches` }, s.lines, 'none', run);
  if (info.baseRefName && info.baseRefName !== ctx.base) return retargeted(s, info.baseRefName, ctx.base);
  const post = postMergeChecks(env);
  const prev = i > 0 ? t.merged.find(m => m.pr === t.slots[i - 1]!.pr) : undefined;
  if (post.length && prev) {
    const checked = await verifyPostMerge(ctx, { sha: prev.sha, checks: post, timeoutSec: 0, pollMs: 0 });
    s.lines.push(`POST_MERGE_CHECKS: #${t.slots[i - 1]!.pr} at ${prev.sha.slice(0, 12)} (${checked.failure?.code ?? 'green'})`, ...checked.lines);
    if (checked.status !== 'complete') return { ...checked, lines: s.lines, next: checked.failure?.code === 'QUEUE_TRAIN_PENDING' ? `${checked.next} && ${rerun}` : checked.next, run };
  }
  const landing = t.landing?.[o.pr];
  const conditional = !!t.slots[i]!.base_red;
  let mode = landing?.mode === 'update' || fs.existsSync(path.join(path.dirname(run), `land-${o.pr}.json`)) ? { mode: 'update' as const, why: 'resuming the recorded update' } : chooseMode(ctx, s, main.sha, conditional);
  if (mode.mode === 'wait') {
    if (o.noWait) return outPending({ code: 'QUEUE_NOT_READY', message: mode.why }, s.lines, `gstack-pr-wait ${o.pr} --until green && ${rerun}`, run);
    waitChecks(ctx, pin, o.timeoutMin ?? 60);
    mode = chooseMode(ctx, s, main.sha, conditional);
    if (mode.mode === 'wait') return outPending({ code: 'QUEUE_NOT_READY', message: mode.why }, s.lines, `gstack-pr-wait ${o.pr} --until green && ${rerun}`, run);
  }
  return mode.mode === 'direct' ? landDirect(ctx, s, info, main.sha, mode.why) : landUpdate(ctx, s, info, main.sha, mode.why, o);
}
