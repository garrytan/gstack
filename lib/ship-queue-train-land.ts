/**
 * `train land --train <nonce> --pr <n>` (docs/ship-policy.md#train-land, GSTA-154 PR B): the merge step for
 * one slot of a stamped train (changelog_fragments). The train built S_1..S_k and gated S_k; slot i
 * publishes S_i exactly. With main's tree equal to S_(i-1)'s (slot 1: the train base), land commits S_i's
 * tree with parents [pin_i, main], labels the PR evals-no-debounce (a tool-made head gets no later push,
 * so the quiet window protects nothing), pushes under --force-with-lease=<branch>:<pin>, waits for the
 * PR's checks on that commit (CI runs live at the slot until GSTA-156's reuse is on main), merges with
 * --match-head-commit and confirms main's tree is S_i. Any other main is the freeze path
 * (QUEUE_TRAIN_TREE_MISMATCH), as for verify. Journaled beside the train record; a rerun resumes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ciAtHead, type QueueContext } from './ship-queue';
import { git, writeJsonAtomic } from './ship-queue-gate';
import { waitChecks } from './ship-queue-land';
import { bindShippedReceipt } from './ship-receipt-depth';
import { checkRun, prInfo } from './ship-queue-train-github';
import { activeFreeze, attemptsOf, trainFile } from './ship-queue-train-record';
import { fetchBase, fetchTrainBranch, findTrain, frozenLines, nextFor, outFailed, outOk, outPending, outRefused, trainEnv, type TrainOut } from './ship-queue-train';
import { confirmMerged, stopped } from './ship-queue-train-verify';

const Q = 'gstack-ship-queue';
const STAMP_IDENTITY = { GIT_AUTHOR_NAME: 'gstack-ship-queue', GIT_AUTHOR_EMAIL: 'ship-queue@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-queue',
  GIT_COMMITTER_EMAIL: 'ship-queue@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
const isSha = (s: string) => /^[0-9a-f]{40,64}$/.test(s);
interface SlotJournal { schema_version: 1; pr: string; pin: string; stamp_commit: string; base: string }

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
  if (!t.stamped) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} was built without stamped prefixes; merge it with the slot stamp and ${Q} verify` }, [], `${Q} verify --pr ${o.pr} --train ${t.nonce}`, run);
  const gate = attemptsOf(t).filter(a => a.purpose !== 'bisect').at(-1);
  if (gate?.outcome !== 'GREEN' || !['green', 'merging', 'merged'].includes(t.state)) return outRefused({ code: 'QUEUE_GATE_MISSING', message: `train ${t.nonce} has no green record (state ${t.state}, last gate ${gate?.outcome ?? 'none'})` }, [], nextFor(t), run);
  const check = checkRun(ctx, t.head, env.train.full_gate_check);
  if (check?.conclusion !== 'success') return outRefused({ code: 'QUEUE_GATE_MISSING', message: `no successful ${env.train.full_gate_check} check run on the train head ${t.head.slice(0, 12)}` }, [], `${Q} train verdict --train ${t.nonce}`, run);
  if (!fetchTrainBranch(env, t)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the train's prefix commits are not here and ${t.branch} could not be fetched` }, [], `${Q} train status --train ${t.nonce}`, run);
  const freeze = activeFreeze(env.repo.keys);
  if (freeze && freeze.repair?.train !== t.nonce) return outRefused({ code: 'QUEUE_TRAIN_FROZEN', message: `the queue is frozen (${freeze.reason}); only the admitted repair train merges` }, frozenLines(freeze), `${Q} train build --repair --prs <repair-pr>@<sha>`, run);

  const root = ctx.repoRoot;
  const k = t.slots.length;
  const chain = Array.from({ length: k + 1 }, (_, n) => {
    const commit = git(root, ['rev-parse', '--verify', '-q', `${t.head}~${k - n}^{commit}`]).out;
    return { index: n, commit, tree: isSha(commit) ? git(root, ['rev-parse', `${commit}^{tree}`]).out : '', pin: n && isSha(commit) ? git(root, ['rev-parse', '--verify', '-q', `${commit}^2`]).out : '' };
  });
  const recorded = [t.prefixes[0], ...t.stamped];
  if (t.stamped.length !== k || chain.some((c, n) => !isSha(c.commit) || c.commit !== recorded[n]?.commit || c.tree !== recorded[n]?.tree || (n > 0 && c.pin !== t.slots[n - 1]!.head))) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the record's T0 and S1..S${k} (with each slot's pin as second parent) are not the first-parent chain of the gated head ${t.head.slice(0, 12)}` }, [], `${Q} train status --train ${t.nonce}`, run);
  const s = { ...chain[i + 1]!, version: t.stamped[i]!.version };
  const pred = chain[i]!;
  const pin = t.slots[i]!.head;
  const mainNow = (): { sha: string; tree: string } | { error: string } => {
    const error = fetchBase(ctx);
    if (error) return { error };
    const sha = git(root, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
    return { sha, tree: git(root, ['rev-parse', `${sha}^{tree}`]).out };
  };
  const rerun = `${Q} train land --train ${t.nonce} --pr ${o.pr}`;
  const lines = [`TRAIN_LAND: ${t.nonce} slot ${i + 1}/${t.slots.length} #${o.pr} pin ${pin} -> S${s.index} v${s.version} tree ${s.tree}`];
  let main = mainNow();
  if ('error' in main) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: main.error }, lines, rerun, run);
  if (main.tree === s.tree) return confirmMerged(env, t, o.pr, main.sha, s.index, [...lines, `main: ${main.sha} is S${s.index} exactly`]);
  const mainTree = main.tree;
  const earlier = chain.slice(0, i).find(p => p.tree === mainTree);
  if (earlier) return outRefused({ code: 'QUEUE_TRAIN_TREE_MISMATCH', message: `main is ${earlier.index ? `S${earlier.index}` : 'the train base'}; land #${t.slots[earlier.index]!.pr} (slot ${earlier.index + 1}) first` }, lines, `${Q} train land --train ${t.nonce} --pr ${t.slots[earlier.index]!.pr}`, run);
  const later = chain.slice(i + 2).find(p => p.tree === mainTree);
  if (later) return confirmMerged(env, t, o.pr, main.sha, s.index, [...lines, `main: ${main.sha} is S${later.index}, past S${s.index}`]);
  if (main.tree !== pred.tree) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main ${main.sha.slice(0, 12)} is neither S${pred.index} nor S${s.index} exactly`, main.sha, lines, true);

  const file = path.join(path.dirname(run), `land-${o.pr}.json`);
  let j: SlotJournal | null = null;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) as SlotJournal; } catch { j = null; }
  const info = prInfo(ctx, o.pr);
  if ('error' in info) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: info.error }, lines, rerun, run);
  if (info.isCrossRepository) return outRefused({ code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr} is a fork head; train land pushes only crew branches` }, lines, 'none', run);
  const retargeted = (b?: string) => b && b !== ctx.base ? outRefused({ code: 'QUEUE_NOT_READY', message: `#${o.pr} targets ${b}, not ${ctx.base}; train land merges only PRs on the base the train stamped` }, lines, `retarget #${o.pr} to ${ctx.base}, then ${rerun}`, run) : null;
  const wrongBase = retargeted(info.baseRefName);
  if (wrongBase) return wrongBase;
  if (!j || j.base !== main.sha || info.headRefOid !== j.stamp_commit) {
    const commit = git(root, ['commit-tree', '--no-gpg-sign', s.tree, '-p', pin, '-p', main.sha, '-m', `v${s.version} stamp: train ${t.nonce} S${s.index} (#${o.pr})`], { ...process.env, ...STAMP_IDENTITY }).out;
    if (!isSha(commit)) return outFailed({ code: 'QUEUE_LAND_CONFLICT', message: `cannot create the stamp commit for tree ${s.tree.slice(0, 12)}; nothing pushed` }, lines, `${Q} train status --train ${t.nonce}`, run);
    if (![pin, commit, j?.stamp_commit].includes(info.headRefOid)) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr}'s head is ${info.headRefOid.slice(0, 12)}, not its pin ${pin.slice(0, 12)}`, main.sha, lines, true);
    const shipped = bindShippedReceipt(root, `refs/remotes/${env.remote}/${ctx.base}`, info.body, o.pr, [pin]);
    lines.push(shipped.line, ...(shipped.depthLine ? [shipped.depthLine] : []));
    if (!shipped.ok) return outRefused({ code: shipped.code, message: shipped.message }, lines, `#${o.pr}'s lane runs /ship at its pin and READYs again`, run);
    const label = ctx.gh(['pr', 'edit', o.pr, '--add-label', 'evals-no-debounce']);
    lines.push(`LABEL: evals-no-debounce ${label.ok ? 'added' : `not added (${(label.err ?? label.out).trim().slice(0, 80)}); the 10-minute quiet window applies`}`);
    j = { schema_version: 1, pr: o.pr, pin, stamp_commit: commit, base: main.sha };
    writeJsonAtomic(file, j);
    const pushed = info.headRefOid !== commit;
    if (pushed) {
      const push = git(root, ['push', '-q', `--force-with-lease=refs/heads/${info.headRefName}:${info.headRefOid}`, env.remote, `${commit}:refs/heads/${info.headRefName}`]);
      if (!push.ok) {
        const remote = git(root, ['ls-remote', env.remote, `refs/heads/${info.headRefName}`]);
        const now = remote.ok ? remote.out.split(/\s/)[0] ?? '' : '';
        if (remote.ok && now !== info.headRefOid && now !== commit) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr}'s branch moved off ${info.headRefOid.slice(0, 12)} before the stamp push; train land never overwrites it`, main.sha, lines, true);
        if (!remote.ok || now !== commit) return outFailed({ code: 'QUEUE_NOT_READY', message: `the stamp push failed and ${info.headRefName} still reads ${remote.ok ? info.headRefOid.slice(0, 12) : 'unknown'}: ${push.err.split('\n')[0]}` }, lines, rerun, run);
      }
    }
    lines.push(`${pushed ? 'PUSHED' : 'RESUMED'}: ${commit} (tree S${s.index}, parents [pin, main ${main.sha.slice(0, 12)}]) ${pushed ? 'to' : 'is already the head of'} ${info.headRefName}`);
    const next = `gstack-pr-wait ${o.pr} --until green && ${Q} train land --train ${t.nonce} --pr ${o.pr}`;
    if (o.noWait && pushed) return outPending({ code: 'QUEUE_NOT_READY', message: `checks run on the stamp commit ${commit.slice(0, 12)}` }, lines, next, run);
    if (!o.noWait) waitChecks(ctx, commit, o.timeoutMin ?? 60);
  }
  const head = prInfo(ctx, o.pr);
  if ('error' in head) return outPending({ code: 'QUEUE_PROOF_MISSING', message: head.error }, lines, rerun, run);
  if (head.headRefOid !== j.stamp_commit) return stopped(env, t, 'QUEUE_TRAIN_MOVED', `#${o.pr}'s head is not the stamp commit ${j.stamp_commit.slice(0, 12)}`, main.sha, lines, true);
  const movedBase = retargeted(head.baseRefName);
  if (movedBase) return movedBase;
  const ci = ciAtHead(ctx, j.stamp_commit);
  lines.push(`CI: ${ci.line}`);
  const required = env.policy.policy.changelog_fragments?.required_checks ?? [];
  const missing = required.filter(name => {
    const runs = ci.checks.filter(c => c.name === name || c.name.startsWith(`${name} (`));
    const contexts = ci.contexts.filter(c => c.name === name);
    return !(runs.length || contexts.length) || runs.some(c => c.status !== 'completed' || c.conclusion !== 'success') || contexts.some(c => c.state !== 'success');
  });
  if (missing.length) lines.push(`REQUIRED_CHECKS: not green at ${j.stamp_commit.slice(0, 12)}: ${missing.join(', ')}`);
  const waitFix = `wait for ${missing.join(', ')} to pass on ${j.stamp_commit.slice(0, 12)} (dispatch the workflow on ${head.headRefName} if it never ran), then ${rerun}`;
  if (missing.length) return outPending({ code: 'QUEUE_NOT_READY', message: `required checks missing or not green on the stamp commit ${j.stamp_commit.slice(0, 12)}: ${missing.join(', ')}`, fix: waitFix }, lines, waitFix, run);
  if (!ci.green) return outPending({ code: 'QUEUE_NOT_READY', message: `checks on the stamp commit ${j.stamp_commit.slice(0, 12)} are not green` }, lines, `gstack-pr-wait ${o.pr} --until green && ${Q} train land --train ${t.nonce} --pr ${o.pr}`, run);
  main = mainNow();
  if ('error' in main) return outPending({ code: 'QUEUE_PROOF_MISSING', message: main.error }, lines, rerun, run);
  if (main.sha !== j.base) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `main moved to ${main.sha.slice(0, 12)} during the slot's checks (stamped on ${j.base.slice(0, 12)})`, main.sha, lines, true);
  const m = ctx.gh(['pr', 'merge', o.pr, '--squash', '--match-head-commit', j.stamp_commit]);
  if (!m.ok) return outFailed({ code: 'QUEUE_NOT_READY', message: `gh pr merge refused: ${(m.err ?? m.out).trim().slice(0, 200)}` }, lines, rerun, run);
  main = mainNow();
  if ('error' in main) return outPending({ code: 'QUEUE_PROOF_MISSING', message: `merged; ${main.error}` }, lines, rerun, run);
  if (main.sha === j.base) return outPending({ code: 'QUEUE_NOT_READY', message: `merged; main still reads ${j.base.slice(0, 12)}, so the merge is not visible yet` }, lines, rerun, run);
  if (main.tree !== s.tree) return stopped(env, t, 'QUEUE_TRAIN_TREE_MISMATCH', `after the merge main ${main.sha.slice(0, 12)} is not S${s.index} exactly`, main.sha, lines, true);
  return confirmMerged(env, t, o.pr, main.sha, s.index, [...lines, `MERGED: #${o.pr} as ${main.sha}; main's tree is S${s.index} exactly`]);
}
