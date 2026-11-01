/**
 * `train watch --train <nonce> [--timeout <s>]`: the controller's one
 * resumable follow command. Machines restart and kill
 * background `gh run watch` chains, so watch keeps no process state: it
 * reads the train record, runs the step the state asks for (train build
 * --train to push, run the free tests and dispatch the gate; train status to
 * settle an unconfirmed dispatch), waits for the pending run to finish by
 * polling gh, then reads the verdict, and prints the last step's NEXT. Run it
 * again after an interruption and it continues from the record. It never
 * dispatches anything the record would not dispatch on its own.
 *
 * A generic train (gates in the policy; GSTA-157 PR 2) loops build, wait, verdict until the verdict settles, and with
 * --land lands each landable slot in order through train land, stopping at the first refusal with its code and NEXT.
 * It never merges without --land and never merges main into a PR.
 */
import type { QueueContext } from './ship-queue';
import { buildTrain, findTrain, nextFor, outOk, outPending, outRefused, trainEnv, trainStatus, type TrainOut } from './ship-queue-train';
import { repoSlug, runView } from './ship-queue-train-github';
import { attemptsOf, trainFile, type TrainRecord } from './ship-queue-train-record';
import type { TrainEnv } from './ship-queue-train';
import { trainVerdict } from './ship-queue-train-verdict';
import { verifyPostMerge } from './ship-queue-post-merge';

const Q = 'gstack-ship-queue';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface WatchOptions { train: string; timeoutSec: number; pollMs: number; freeTimeoutSec: number; land?: boolean }

/** Wait for the train's current gate run to complete; null when it did, else why the wait stopped. */
async function awaitGate(ctx: QueueContext, t: TrainRecord, deadline: number, pollMs: number): Promise<string | null> {
  const a = attemptsOf(t).filter(x => x.purpose !== 'bisect').at(-1);
  if (!a?.run) return `no gate run is recorded for ${t.nonce}`;
  const slug = repoSlug(ctx);
  if (!slug) return 'gh repo view could not name the repository';
  for (;;) {
    const view = runView(ctx, slug, a.run.id);
    if (view?.status === 'completed') return null;
    if (Date.now() >= deadline) return `run ${a.run.id} is still ${view?.status ?? 'unreadable'} at the watch timeout`;
    await sleep(pollMs);
  }
}

/** Wait until every dispatched prefix run of a generic train completes; null when they did, else why the wait stopped. */
async function awaitPrefixRuns(ctx: QueueContext, t: TrainRecord, deadline: number, pollMs: number): Promise<string | null> {
  const slug = repoSlug(ctx);
  if (!slug) return 'gh repo view could not name the repository';
  for (;;) {
    const open = attemptsOf(t).filter(a => a.state === 'dispatched' && a.run && a.outcome !== 'GREEN' && a.outcome !== 'RED' && a.outcome !== 'INCOMPLETE');
    const running = open.filter(a => runView(ctx, slug, a.run!.id)?.status !== 'completed');
    if (!running.length) return null;
    if (Date.now() >= deadline) return `${running.length} prefix run(s) still running at the watch timeout (${running.map(a => a.run!.id).join(', ')})`;
    await sleep(pollMs);
  }
}

async function watchGeneric(ctx: QueueContext, env: TrainEnv, start: TrainRecord, o: WatchOptions, lines: string[], again: string, deadline: number): Promise<TrainOut> {
  let t = start;
  const run = trainFile(t.nonce);
  const reload = () => { t = findTrain(env, o.train) ?? t; };
  let verdict: TrainOut | null = null;
  while (!t.verdict) {
    if (t.state === 'built' || t.state === 'pushed' || verdict?.next.includes('train build --train')) {
      const b = await buildTrain(ctx, { resume: t.nonce, dryRun: false, urgent: false, repair: false, freeTimeoutSec: o.freeTimeoutSec, pollMs: o.pollMs });
      reload();
      lines.push(`WATCH: train build --train ${t.nonce} (${b.failure?.code ?? b.status})`);
      if (b.status !== 'complete') return { ...b, lines: [...lines, ...b.lines] };
    }
    const why = await awaitPrefixRuns(ctx, t, deadline, o.pollMs);
    if (why) return outPending({ code: 'QUEUE_TRAIN_PENDING', message: why }, lines, again, run);
    verdict = trainVerdict(ctx, { train: t.nonce });
    reload();
    if (!t.verdict && Date.now() >= deadline) return { ...verdict, lines: [...lines, ...verdict.lines], next: again };
    if (!t.verdict) await sleep(o.pollMs);
  }
  verdict ??= trainVerdict(ctx, { train: t.nonce });
  lines.push(...verdict.lines);
  if (!o.land || !t.verdict.landable) return { ...verdict, lines };
  const { postMergeChecks, trainLand } = await import('./ship-queue-train-land');
  const post = postMergeChecks(env);
  for (const s of t.slots.slice(0, t.verdict.landable)) {
    if (t.merged.some(m => m.pr === s.pr)) continue;
    const remaining = Math.max(1, Math.floor((deadline - Date.now()) / 60_000));
    const landed = await trainLand(ctx, { train: t.nonce, pr: s.pr, timeoutMin: remaining });
    lines.push(`WATCH: train land --train ${t.nonce} --pr ${s.pr} (${landed.failure?.code ?? landed.status})`, ...landed.lines);
    if (landed.status !== 'complete') return { ...landed, lines };
    reload();
    const sha = t.merged.find(m => m.pr === s.pr)?.sha;
    if (!post.length || !sha) continue;
    const checked = await verifyPostMerge(ctx, { sha, checks: post, timeoutSec: Math.max(1, Math.floor((deadline - Date.now()) / 1000)), pollMs: o.pollMs });
    lines.push(`WATCH: verify --post-merge ${sha} (${checked.failure?.code ?? checked.status})`, ...checked.lines);
    if (checked.status !== 'complete') return { ...checked, lines, next: checked.failure?.code === 'QUEUE_TRAIN_PENDING' ? `${checked.next} && ${Q} train watch --train ${t.nonce} --land` : checked.next };
  }
  return outOk(lines, nextFor(t), run);
}

export async function trainWatch(ctx: QueueContext, o: WatchOptions): Promise<TrainOut> {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  let t = findTrain(env, o.train);
  if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
  const run = trainFile(t.nonce);
  const deadline = Date.now() + o.timeoutSec * 1000;
  const lines: string[] = [`WATCH: train ${t.nonce} state=${t.state} (resumable; rerun this command after an interruption)`];
  const again = `${Q} train watch --train ${t.nonce} --timeout ${o.timeoutSec}`;
  const step = (label: string, out: TrainOut): TrainOut => ({ ...out, lines: [...lines, `WATCH: ${label}`, ...out.lines] });
  const reload = () => { t = findTrain(env, o.train) ?? t; };
  if (t.gated) return watchGeneric(ctx, env, t, o, lines, again, deadline);
  if (t.state === 'dispatch-unknown') {
    const s = trainStatus(ctx, { train: t.nonce });
    lines.push(`WATCH: train status settled the unconfirmed dispatch`, ...s.lines.filter(l => l.startsWith('ATTEMPT:')));
    reload();
  }
  if (['built', 'pushed', 'free-pending', 'free-green', 'dispatch-absent'].includes(t.state)) {
    const remaining = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const b = await buildTrain(ctx, { resume: t.nonce, dryRun: false, urgent: false, repair: false, freeTimeoutSec: Math.min(o.freeTimeoutSec, remaining), pollMs: o.pollMs });
    reload();
    if (b.status !== 'complete') return step(`train build --train ${t.nonce} stopped (${b.failure?.code ?? b.status})`, b.failure?.code === 'QUEUE_TRAIN_PENDING' ? { ...b, next: again } : b);
    lines.push(`WATCH: train build --train ${t.nonce}: free tests green, gate dispatched`);
  }
  if (t.state === 'gate-pending') {
    const why = await awaitGate(ctx, t, deadline, o.pollMs);
    if (why) return outPending({ code: 'QUEUE_TRAIN_PENDING', message: why }, lines, again, run);
    lines.push('WATCH: gate run completed; reading the verdict');
    return step(`train verdict --train ${t.nonce}`, trainVerdict(ctx, { train: t.nonce }));
  }
  if (t.state === 'dispatch-unknown') return outPending({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `the gate dispatch for ${t.nonce} is still unconfirmed` }, lines, again, run);
  return outOk([...lines, `WATCH: nothing to wait for in state ${t.state}`], nextFor(t), run);
}
