/**
 * `train forget --train <nonce> | --receipt <pr>@<head> [--dry-run]`: remove a
 * train record (its attempts and bisect ledger) or a READY receipt from
 * refs/notes/gstack-trains under an exact lease, then delete the local files
 * (until now a stale record needed a hand-run
 * `git notes remove` plus a file hunt on every machine that ran the train).
 * A rejected lease removes nothing (the local notes ref is restored too, so a
 * later write cannot carry the removal without a lease). Other machines that
 * still hold the local files can push the record back with their next write;
 * the output says so.
 */
import * as fs from 'node:fs';
import type { QueueContext } from '../../lib/ship-queue';
import { outOk, outRefused, trainEnv, type TrainOut } from './ship-queue-train';
import { attemptsOf, forgetNotes, loadBisect, loadReady, loadTrain, noteName, readyPath, rebuildFromNotes, trainDir, type AnyRecord, type TrainState } from './ship-queue-train-record';

const Q = 'gstack-ship-queue';
/** States with work still in flight (a branch being built or pushed, free tests or a gate running, a merge under way): forget never settles them. */
const LIVE_STATES: readonly TrainState[] = ['built', 'pushed', 'free-pending', 'free-green', 'dispatch-unknown', 'dispatch-absent', 'gate-pending', 'merging'];

export function trainForget(ctx: QueueContext, o: { train?: string; receipt?: string; dryRun: boolean }): TrainOut {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  rebuildFromNotes(ctx.repoRoot, env.remote);
  const records: AnyRecord[] = [];
  const files: string[] = [];
  let what = '';
  if (o.train) {
    const t = loadTrain(o.train);
    if (!t) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no train record ${o.train} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
    if (LIVE_STATES.includes(t.state)) {
      return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `train ${t.nonce} is ${t.state}; forget settles nothing that is still building, running or merging (train prune --stale for a train whose PRs merged elsewhere)` }, [], `${Q} train status --train ${t.nonce}`, trainDir(t.nonce));
    }
    const bisect = loadBisect(t.nonce);
    records.push(t, ...attemptsOf(t), ...(bisect ? [bisect] : []));
    files.push(trainDir(t.nonce));
    what = `train ${t.nonce} (${t.state}; ${t.attempts.length} attempt(s)${bisect ? ', a bisect ledger' : ''})`;
  } else {
    const m = /^#?(\d+)@([0-9a-f]{40,64})$/.exec(o.receipt ?? '');
    if (!m) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: '--receipt takes <pr>@<full head sha>' }, [], `${Q} train forget --receipt <pr>@<sha>`, 'none');
    const r = loadReady(env.repo.keys, m[1]!, m[2]!);
    if (!r) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `no READY receipt for #${m[1]} at ${m[2]!.slice(0, 12)} here or in refs/notes/gstack-trains` }, [], `${Q} train status`, 'none');
    records.push(r);
    files.push(readyPath(r.repo_key, r.pr, r.head));
    what = `READY receipt #${r.pr} at ${r.head.slice(0, 12)} (screen ${r.screen.choice}${r.screen.run ? `, run ${r.screen.run}` : ''})`;
  }
  const names = records.map(noteName);
  const lines = [`FORGET: ${what}`, ...names.map(n => `  note ${n}`), ...files.map(f => `  local ${f}`)];
  if (o.dryRun) return outOk([...lines, 'DRY-RUN: nothing removed'], `${Q} train forget ${o.train ? `--train ${o.train}` : `--receipt ${o.receipt}`}`, 'none');
  const f = forgetNotes(ctx.repoRoot, names, env.remote);
  if (!f.pushed) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the notes ref was not updated (${f.detail}); nothing deleted locally` }, lines, `${Q} train forget ${o.train ? `--train ${o.train}` : `--receipt ${o.receipt}`} (the lease is re-read each run)`, 'none');
  for (const file of files) fs.rmSync(file, { recursive: true, force: true });
  lines.push(`FORGOTTEN: ${f.removed.length} note(s) removed${f.missing.length ? `, ${f.missing.length} already absent` : ''}; ${f.detail}; ${files.length} local path(s) deleted`,
    'note: a machine that still holds these files locally can push the record back with its next write; run train forget there too, or clear its $GSTACK_STATE_ROOT/ship-queue copy');
  return outOk(lines, `${Q} train status`, 'none');
}
