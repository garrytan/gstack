/**
 * `verify --pr <n> --train <nonce>`: the coordinator's merge check under
 * merge trains (docs/ship-policy.md#run-a-merge-train; plan GSTA-49 T1, P1).
 *
 * Each merge needs a green train record that includes the PR at its pinned
 * head, or at a head whose tree is the slot's prefix after it modulo stamps
 * (from slot 2 on, the lane merges main into its pin so GitHub can merge it),
 * with main's tree equal to the prefix before the PR (pre-merge:
 * MERGE_CONDITION) or after it (post-merge confirmation), modulo stamps
 * (lib/tree-receipt.ts). When a train stops partway (a mismatch or a moved
 * head after earlier slots merged) the queue freezes: the freeze is written
 * locally and to the notes ref first, then the backstop gate is dispatched on
 * main's published prefix at once. One repair train is admitted under the
 * freeze; verify clears the freeze when main after that merge carries it.
 */
import { randomBytes } from 'node:crypto';
import { DISPATCH_INPUTS, awaitNonceRun, dispatchWorkflow, makeNonce } from '../scripts/eval-bg';
import type { QueueContext } from './ship-queue';
import { git } from './ship-queue-gate';
import { bindReceipt } from './ship-receipt';
import { checkRun, execFor, prInfo, repoSlug } from './ship-queue-train-github';
import { activeFreeze, attemptsOf, listTrains, nowIso, persist, rebuildFromNotes, trainFile, type FreezeRecord, type TrainRecord } from './ship-queue-train-record';
import {
  effect, fetchBase, fetchTrainBranch, findTrain, frozenLines, nextFor, outFailed, outOk, outRefused, pinList, prState, prsArgs, save, trainEnv, type TrainEnv, type TrainOut,
} from './ship-queue-train';
import { mergeChangelogs, ownEntryAboveMain, parseChangelog } from './changelog-check';
import { buildReceipt } from './tree-receipt';

const Q = 'gstack-ship-queue';

function sameModuloStamps(env: TrainEnv, gated: string, current: string): { same: boolean; detail: string } {
  const r = buildReceipt({ repoRoot: env.ctx.repoRoot, gated, current, policy: env.policy.policy, policyLabel: env.policy.source.label });
  if ('error' in r) return { same: false, detail: r.error };
  return { same: r.tree === 'same-modulo-stamps', detail: r.tree === 'same-modulo-stamps' ? `same modulo stamps (${r.files.length} stamp file(s))` : `differs: ${r.residual.slice(0, 8).join(', ')}` };
}

/**
 * The one CHANGELOG rule of a slot, applied before and after the merge:
 * `current`'s CHANGELOG must be `mainBefore`'s with the PR's own entry above it
 * (ownEntryAboveMain), the own lines being those the pin's CHANGELOG diff from
 * its fork point added, or those `mergeChangelogs` itself writes for the pin
 * against that main (a released parent's carried corrections, GSTA-96). Pre-merge
 * `current` is the lane's head and `mainBefore` is main; post-merge `current` is
 * main and `mainBefore` its first parent, the main the pre-merge verify saw.
 * Null when it holds, else why not.
 */
function changelogIsMainPlusOwn(env: TrainEnv, t: TrainRecord, i: number, current: string, mainBefore: string): string | null {
  const cl = env.policy.policy.changelog!;
  const root = env.ctx.repoRoot;
  const pin = t.slots[i]!.head;
  const forkPoint = git(root, ['merge-base', pin, t.prefixes[0]!.commit]).out;
  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', forkPoint, pin, '--', cl]);
  const show = (rev: string) => git(root, ['show', `${rev}:${cl}`]);
  const [currentCl, mainCl, pinCl, forkCl] = [show(current), show(mainBefore), show(pin), show(forkPoint)];
  if (!forkPoint || !diff.ok || !currentCl.ok || !mainCl.ok) return `cannot read ${cl} at the pin, ${current.slice(0, 12)} or main ${mainBefore.slice(0, 12)}`;
  const authored = new Set(diff.out.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)));
  const tool = pinCl.ok ? mergeChangelogs(pinCl.out + '\n', mainCl.out + '\n', forkCl.ok ? forkCl.out + '\n' : undefined) : null;
  if (tool) {
    const mainKeys = new Set(parseChangelog(mainCl.out).sections.map(s => s.version ?? 'Unreleased'));
    for (const s of parseChangelog(tool).sections.filter(s => !mainKeys.has(s.version ?? 'Unreleased'))) for (const l of s.lines.slice(1)) authored.add(l);
  }
  return ownEntryAboveMain(currentCl.out, mainCl.out, authored);
}

/**
 * A slot head with main merged in (from slot 2 on the lane merges main into
 * its pin so GitHub can merge it): it must contain main, and its tree must be
 * the slot's prefix T<i> modulo stamps. The CHANGELOG is judged against main
 * instead of T<i>'s mechanical merge (changelogIsMainPlusOwn), so a hand
 * resolve is accepted when it is main's CHANGELOG plus the PR's own entry;
 * any other difference is refused.
 */
function mergedIn(env: TrainEnv, t: TrainRecord, i: number, head: string, main: string): { same: boolean; detail: string } {
  const after = t.prefixes[i + 1]!;
  const root = env.ctx.repoRoot;
  if (!git(root, ['merge-base', '--is-ancestor', main, head]).ok) return { same: false, detail: `does not contain main ${main.slice(0, 12)}` };
  const r = buildReceipt({ repoRoot: root, gated: after.commit, current: head, policy: env.policy.policy, policyLabel: env.policy.source.label });
  if ('error' in r) return { same: false, detail: r.error };
  const stamps = `${r.files.filter(f => f.verdict === 'stamp').length} stamp file(s)`;
  if (r.tree === 'same-modulo-stamps') return { same: true, detail: `T${after.index} with main merged in, same modulo stamps (${stamps})` };
  const cl = env.policy.policy.changelog;
  const beyond = r.residual.filter(f => f !== cl);
  if (beyond.length || !cl) return { same: false, detail: `differs from T${after.index}: ${r.residual.slice(0, 8).join(', ')}` };
  const why = changelogIsMainPlusOwn(env, t, i, head, main);
  if (why) return { same: false, detail: `differs from T${after.index} in ${cl}, which is not main's plus #${t.slots[i]!.pr}'s own entry: ${why}` };
  return { same: true, detail: `T${after.index} with main merged in, same modulo stamps (${stamps}) except ${cl}, resolved as main's ${cl} plus #${t.slots[i]!.pr}'s own entry` };
}

/**
 * Post-merge, the same rule the pre-merge verify applied: main is T<i> modulo
 * stamps, or differs from it in the CHANGELOG alone while being its own first
 * parent (the main the pre-merge verify saw, itself T<i-1> modulo stamps) plus
 * the PR's own entry. A merge the pre-merge verify accepted therefore confirms
 * here with the same CHANGELOG (train 24, 2026-10-27: #3453's accepted head
 * froze the queue post-merge because T2's one [Unreleased] had become two
 * released sections).
 */
function published(env: TrainEnv, t: TrainRecord, i: number, main: string): { same: boolean; detail: string } {
  const after = t.prefixes[i + 1]!;
  const post = sameModuloStamps(env, after.commit, main);
  if (post.same) return post;
  const cl = env.policy.policy.changelog;
  const r = buildReceipt({ repoRoot: env.ctx.repoRoot, gated: after.commit, current: main, policy: env.policy.policy, policyLabel: env.policy.source.label });
  if ('error' in r || !cl || r.residual.some(f => f !== cl)) return post;
  const parent = git(env.ctx.repoRoot, ['rev-parse', '--verify', '-q', `${main}^`]).out;
  if (!parent || !sameModuloStamps(env, t.prefixes[i]!.commit, parent).same) return { same: false, detail: `${post.detail}; main's parent ${parent.slice(0, 12) || '(none)'} is not T${t.prefixes[i]!.index} modulo stamps` };
  const why = changelogIsMainPlusOwn(env, t, i, main, parent);
  if (why) return { same: false, detail: `${post.detail}, which is not main ${parent.slice(0, 12)}'s plus #${t.slots[i]!.pr}'s own entry: ${why}` };
  return { same: true, detail: `same modulo stamps (${r.files.filter(f => f.verdict === 'stamp').length} stamp file(s)) except ${cl}, main ${parent.slice(0, 12)}'s ${cl} plus #${t.slots[i]!.pr}'s own entry` };
}

/**
 * Freeze the queue: the record goes to local state and the notes ref before
 * anything remote, then the backstop gate is dispatched on main's sha.
 * `states` is the one GitHub read of every unverified slot, made by the
 * caller (for a stamped train every slot: its record entries never count on
 * their own): a slot that read MERGED is merged, verified tree or not, and a slot
 * that could not be read is left out of `unmerged`, recorded under
 * `unreadable` and named in the reason and in the NEXT after the repair (the
 * operator seats it by hand once gh answers), so the rebuild after the repair
 * never seats a PR that may already be in.
 */
/** A record entry that counts as merged without a GitHub read: plain trains only; a stamped train counts only what GitHub reports MERGED (#3603). */
const recordedMerged = (t: TrainRecord, pr: string): boolean => !t.stamped && t.merged.some(m => m.pr === pr);

async function freezeQueue(env: TrainEnv, t: TrainRecord, reason: string, mainSha: string, states: ReadonlyMap<string, string>): Promise<FreezeRecord> {
  const now = nowIso();
  const unverified = t.slots.filter(s => !recordedMerged(t, s.pr));
  const landed = unverified.filter(s => states.get(s.pr) === 'MERGED').map(s => s.pr);
  const untreed = landed.filter(pr => !t.merged.some(m => m.pr === pr));
  const unreadable = unverified.filter(s => states.get(s.pr) === 'unreadable').map(s => s.pr);
  const prs = (list: string[]) => list.map(p => '#' + p).join(', ');
  const f: FreezeRecord = {
    schema: 1, kind: 'freeze', repo_key: env.repo.key, train: t.nonce, merged: [...t.slots.filter(s => recordedMerged(t, s.pr)).map(s => s.pr), ...landed],
    unmerged: unverified.filter(s => !landed.includes(s.pr) && !unreadable.includes(s.pr)).map(s => ({ pr: s.pr, head: s.head })),
    unreadable: unverified.filter(s => unreadable.includes(s.pr)).map(s => ({ pr: s.pr, head: s.head })),
    main: { sha: mainSha, tree: git(env.ctx.repoRoot, ['rev-parse', `${mainSha}^{tree}`]).out },
    reason: [reason, untreed.length ? `${prs(untreed)} merged on GitHub without a verified tree` : '', unreadable.length ? `${prs(unreadable)} unreadable on GitHub, left out of unmerged; seat it in a train by hand once gh pr view answers` : ''].filter(Boolean).join('; '),
    backstop: null, repair: null,
    created_at: now, cleared_at: null, cleared_by: null, updated_at: now,
  };
  persist(env.ctx.repoRoot, [f], { remote: env.remote });
  effect(t, `queue frozen: ${reason}`);
  save(env, t);
  const slug = repoSlug(env.ctx);
  const nonce = makeNonce('gate', mainSha, mainSha, randomBytes(3).toString('hex'), { purpose: 'backstop' });
  const dispatch = { workflow: env.train.gate_workflow, inputs: { [DISPATCH_INPUTS.evalsAll]: 'true', [DISPATCH_INPUTS.expectedSha]: mainSha, [DISPATCH_INPUTS.nonce]: nonce } };
  const exec = execFor(env.ctx);
  const found = slug && dispatchWorkflow(dispatch, env.ctx.base, exec, slug) ? await awaitNonceRun(dispatch.workflow, nonce, exec, slug) : null;
  f.backstop = { nonce, run: found?.databaseId ?? null, state: found ? 'dispatched' : 'unconfirmed' };
  f.updated_at = nowIso();
  persist(env.ctx.repoRoot, [f], { remote: env.remote });
  return f;
}

/**
 * Where another train's verify confirmed main's exact sha as one of its merged
 * prefixes, read from local records after the notes ref (a machine that never
 * ran that train still sees it). Null when none did.
 */
function verifiedElsewhere(env: TrainEnv, t: TrainRecord, mainSha: string): string | null {
  rebuildFromNotes(env.ctx.repoRoot, env.remote);
  for (const other of listTrains(env.repo.keys)) {
    if (other.nonce === t.nonce) continue;
    const m = other.merged.find(x => x.sha === mainSha);
    if (m) return `T${other.prefixes.find(p => p.pr === m.pr)?.index ?? '?'} of train ${other.nonce} (#${m.pr}, verified at ${m.at})`;
  }
  return null;
}

/**
 * Interrupted publication: freeze when a slot merged, verified or merged on
 * GitHub without a verified tree (slot 1's own squash failing the post-merge
 * check leaves main unverified with nothing in `merged` yet); otherwise a
 * plain refusal (nothing was published). A GitHub state that cannot be read
 * is neither: the verify refuses and asks to be rerun, never "nothing merged".
 */
export async function stopped(env: TrainEnv, t: TrainRecord, code: 'QUEUE_TRAIN_TREE_MISMATCH' | 'QUEUE_TRAIN_MOVED', message: string, mainSha: string, lines: string[], fetched: boolean): Promise<TrainOut> {
  const run = trainFile(t.nonce);
  // One GitHub read per unverified slot decides both the freeze and its record.
  const states = new Map(t.slots.filter(s => !recordedMerged(t, s.pr)).map(s => [s.pr, prState(env.ctx, s.pr)] as const));
  const landed = t.slots.some(s => recordedMerged(t, s.pr)) || [...states.values()].includes('MERGED');
  const unreadable = landed ? [] : [...states].filter(([, state]) => state === 'unreadable').map(([pr]) => `#${pr}`);
  if (unreadable.length) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `${message}; whether ${unreadable.join(', ')} merged on GitHub could not be read, so whether the queue must freeze is unknown` }, lines, `${Q} verify --pr ${t.slots[0]!.pr} --train ${t.nonce} (once gh pr view answers)`, run);
  if (!landed) return outFailed({ code, message: `${message}; nothing of train ${t.nonce} merged, so the queue is not frozen` }, lines, `${Q} train build ${prsArgs(t.slots, t.explicit_order)} (a new train on current main)`, run);
  const later = fetched && t.slots.every(s => recordedMerged(t, s.pr) || states.get(s.pr) === 'MERGED') ? verifiedElsewhere(env, t, mainSha) : null;
  if (later) {
    const held = activeFreeze(env.repo.keys);
    return outRefused({ code: 'QUEUE_TRAIN_STALE', message: `${message}; every slot of train ${t.nonce} merged on GitHub and main ${mainSha.slice(0, 12)} is ${later}, so this record is stale and ${held ? `freezes nothing (the queue is already frozen by train ${held.train})` : 'the queue is not frozen'}` }, held ? [...lines, ...frozenLines(held)] : lines, `${Q} train prune --stale --train ${t.nonce}`, run);
  }
  const f = activeFreeze(env.repo.keys) ?? await freezeQueue(env, t, message, mainSha, states);
  return outFailed({ code, message: `${message}; the queue is frozen` }, [...lines, ...frozenLines(f)], `${Q} train build --repair --prs <repair-pr>@<sha>`, run);
}

export async function verifyTrain(ctx: QueueContext, o: { pr: string; train: string; noFetch: boolean }): Promise<TrainOut> {
  const fetchErr = o.noFetch ? null : fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: fetchErr }, [], 'none', 'none');
  const t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const i = t.slots.findIndex(s => s.pr === o.pr);
  if (i < 0) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} does not include #${o.pr}` }, [], nextFor(t), run);
  if (t.stamped) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} has stamped prefixes; its slots publish S_i exactly through train land, never a hand stamp checked modulo stamps` }, [], `${Q} train land --train ${t.nonce} --pr ${o.pr}`, run);
  const gate = attemptsOf(t).filter(a => a.purpose !== 'bisect').at(-1);
  if (gate?.outcome !== 'GREEN' || !['green', 'merging', 'merged'].includes(t.state)) {
    return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} has no green record (state ${t.state}, last gate ${gate?.outcome ?? 'none'})` }, [], nextFor(t), run);
  }
  const check = checkRun(ctx, t.head, env.train.full_gate_check);
  if (check?.conclusion !== 'success') return outRefused({ code: 'QUEUE_GATE_MISSING', message: `no successful ${env.train.full_gate_check} check run on the train head ${t.head.slice(0, 12)}` }, [], `${Q} train verdict --train ${t.nonce}`, run);
  if (!fetchTrainBranch(env, t)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the train's prefix commits are not here and ${t.branch} could not be fetched` }, [], `${Q} train status --train ${t.nonce}`, run);
  const main = git(ctx.repoRoot, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
  const freeze = activeFreeze(env.repo.keys);
  if (freeze && freeze.repair?.train !== t.nonce) return outRefused({ code: 'QUEUE_TRAIN_FROZEN', message: `the queue is frozen (${freeze.reason}); only the admitted repair train merges` }, frozenLines(freeze), `${Q} train build --repair --prs <repair-pr>@<sha>`, run);
  const after = t.prefixes[i + 1]!;
  const before = t.prefixes[i]!;
  const post = published(env, t, i, main);
  const lines = [`TRAIN: ${t.nonce} slot ${i + 1}/${t.slots.length} #${o.pr} pinned ${t.slots[i]!.head}`];
  if (post.same) return confirmMerged(env, t, o.pr, main, after.index, [...lines, `main: ${main} = T${after.index} (${post.detail})`]);
  const pre = sameModuloStamps(env, before.commit, main);
  if (!pre.same) {
    return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main ${main.slice(0, 12)} is neither T${before.index} nor T${after.index} modulo stamps (vs T${after.index}: ${post.detail})`, main, lines, !o.noFetch);
  }
  const headRef = o.noFetch ? '' : (git(ctx.repoRoot, ['fetch', '--no-tags', '-q', env.remote, `+refs/pull/${o.pr}/head:refs/gstack/queue/pr-${o.pr}`]).ok ? `refs/gstack/queue/pr-${o.pr}` : '');
  const head = headRef ? git(ctx.repoRoot, ['rev-parse', headRef]).out : t.slots[i]!.head;
  const pinned = head === t.slots[i]!.head ? { same: true, detail: 'the pinned head' } : sameModuloStamps(env, t.slots[i]!.head, head);
  const stampOnly = pinned.same ? pinned : mergedIn(env, t, i, head, main);
  if (!stampOnly.same) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr} moved past its pinned head ${t.slots[i]!.head.slice(0, 12)} and is not T${after.index} modulo stamps (${head.slice(0, 12)}: ${stampOnly.detail}; against the pin it ${pinned.detail})`, main, lines, !o.noFetch);
  const info = prInfo(ctx, o.pr);
  if ('error' in info) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: info.error }, lines, `${Q} verify --pr ${o.pr} --train ${t.nonce}`, run);
  const shipped = bindReceipt(info.body, o.pr, [t.slots[i]!.head, head]);
  if (!shipped.ok) return outRefused({ code: shipped.code, message: shipped.message }, [...lines, shipped.line], `#${o.pr}'s lane runs /ship and READYs again; then ${Q} train build --prs <pins>`, run);
  return outOk([...lines, `main: ${main} = T${before.index} (${pre.detail})`, `head: ${head} (${stampOnly.detail})`, `${shipped.line} (binds ${shipped.head === t.slots[i]!.head ? 'the pinned head' : 'the current head'})`,
    `VERIFY_TRAIN: #${o.pr} may merge as slot ${i + 1} of train ${t.nonce} (green run ${gate.run?.id ?? '-'}, ${env.train.full_gate_check} success)`, `MERGE_CONDITION: sha=${head}`],
  `merge #${o.pr} with expected head ${head.slice(0, 12)} (gstack-restamp stamps at merge), then ${Q} verify --pr ${o.pr} --train ${t.nonce}`, run);
}

export function confirmMerged(env: TrainEnv, t: TrainRecord, pr: string, main: string, index: number, lines: string[]): TrainOut {
  const run = trainFile(t.nonce);
  const state = t.stamped ? prState(env.ctx, pr) : 'MERGED';
  if (state !== 'MERGED') return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `main's tree is S${index} of train ${t.nonce}, but GitHub reports #${pr} as ${state}, not MERGED; only a merge GitHub reports counts` }, lines, `gh pr view ${pr} --json state,headRefOid; rerun once GitHub reports #${pr} MERGED`, run);
  if (!t.merged.some(m => m.pr === pr)) t.merged.push({ pr, sha: main, tree: git(env.ctx.repoRoot, ['rev-parse', `${main}^{tree}`]).out, at: nowIso() });
  const merged = t.slots.filter(s => s.pr === pr || recordedMerged(t, s.pr) || (t.merged.some(m => m.pr === s.pr) && prState(env.ctx, s.pr) === 'MERGED'));
  t.state = merged.length === t.slots.length ? 'merged' : 'merging';
  effect(t, `verified #${pr} merged as T${index}`);
  save(env, t);
  lines.push(`VERIFY_TRAIN: #${pr} merged; main's tree is T${index} of train ${t.nonce} (${merged.length}/${t.slots.length} merged)`);
  const freeze = activeFreeze(env.repo.keys);
  if (freeze && freeze.repair?.train === t.nonce && t.state === 'merged') {
    freeze.cleared_at = nowIso();
    freeze.cleared_by = `repair #${pr} via train ${t.nonce}; main ${main.slice(0, 12)} carries a green record`;
    freeze.updated_at = freeze.cleared_at;
    persist(env.ctx.repoRoot, [freeze], { remote: env.remote });
    lines.push(`FREEZE: cleared (${freeze.cleared_by})`);
    const rebuild = freeze.unmerged.length ? `${Q} train build --prs ${pinList(freeze.unmerged)}` : '';
    const unread = freeze.unreadable ?? [];
    const check = unread.length ? `${unread.map(u => `gh pr view ${u.pr} --json state,headRefOid`).join(' && ')} (unreadable at the freeze: ${unread.map(u => `#${u.pr}@${u.head.slice(0, 12)}`).join(', ')}); seat each that is OPEN in a train` : '';
    return outOk(lines, [rebuild, check].filter(Boolean).join('; then ') || 'none', run);
  }
  return outOk(lines, nextFor(t), run);
}
