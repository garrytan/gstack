/**
 * `verify --post-merge <sha> [--timeout <s>]`: the coordinator's follow
 * command after a train merged a PR onto the base branch. The push workflows
 * run on the merged commit (free tests, the Windows subset, the main backstop
 * that supersedes itself when main moves on), and a background `gh run
 * watch` chain dies with the machine that started it. This command keeps no
 * state: it reads every check run attached to the sha, waits (polling gh)
 * until none is still running or the timeout passes, prints one `CHECK:`
 * line per check, and a `POST_MERGE:` summary that is green only when at
 * least one check completed and none failed; a neutral or skipped check is
 * skipped, never red. Commit statuses count too: a pending status keeps the
 * commit pending, a failed one makes it red (named as a commit status when no
 * check run failed). Rerun it after an interruption and it continues.
 */
import { ciAtHead, type QueueContext } from './ship-queue';
import { outFailed, outOk, outPending, type TrainOut } from './ship-queue-train';

const Q = 'gstack-ship-queue';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface PostMergeOptions { sha: string; timeoutSec: number; pollMs: number; checks?: string[] }

export async function verifyPostMerge(ctx: QueueContext, o: PostMergeOptions): Promise<TrainOut> {
  const deadline = Date.now() + o.timeoutSec * 1000;
  const at = o.sha.slice(0, 12);
  const named = o.checks ?? [];
  const again = `${Q} verify --post-merge ${o.sha} --timeout ${o.timeoutSec}${named.length ? ` --checks ${JSON.stringify(named.join(','))}` : ''}`;
  for (;;) {
    const ci = ciAtHead(ctx, o.sha);
    const lines = [`POST_MERGE: ${ci.line.replace(/^(\S+) at ([0-9a-f]+)/, '$2 $1')}`, ...ci.checks.map(c => `CHECK: ${c.name} ${c.status === 'completed' ? c.conclusion ?? 'unknown' : c.status}`)];
    const settled = !ci.none && !/^(pending|unknown) /.test(ci.line) && !ci.checks.some(c => c.status !== 'completed');
    const runs = (n: string) => ci.checks.filter(c => c.name === n || c.name.startsWith(`${n} (`));
    const absent = named.filter(n => !runs(n).length);
    const unsuccessful = named.filter(n => runs(n).some(c => c.status === 'completed' && c.conclusion !== 'success'));
    if (settled && ci.green && unsuccessful.length) return outFailed({ code: 'QUEUE_POST_MERGE_RED', message: `the post-merge checks the train gate names did not succeed at ${at}: ${unsuccessful.join(', ')}` }, lines,
      `read the run, repair on a new PR or roll back; ${Q} train status names the freeze if the backstop filed one`, 'none');
    if (settled && ci.green && !absent.length) return outOk(lines, 'none', 'none');
    if (settled && !ci.green) {
      const red = ci.checks.filter(c => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion ?? '')).map(c => c.name);
      return outFailed({ code: 'QUEUE_POST_MERGE_RED', message: `main's push workflows at ${at} are red: ${red.join(', ') || 'a commit status (no check run failed)'}` }, lines,
        `read the red run, repair on a new PR or roll back; ${Q} train status names the freeze if the backstop filed one`, 'none');
    }
    if (Date.now() >= deadline) {
      const pending = ci.checks.filter(c => c.status !== 'completed').map(c => c.name);
      const message = ci.line.startsWith('unknown') ? `the check runs at ${at} are unreadable (${ci.line.replace(/^unknown at [0-9a-f]+ /, '')})`
        : ci.none ? `no check run has attached to ${at} yet` : settled ? `the post-merge checks the train gate names never ran at ${at}: ${absent.join(', ')}` : `main's push workflows at ${at} have not settled at the timeout: ${pending.join(', ') || 'a commit status'} still running`;
      return outPending({ code: 'QUEUE_TRAIN_PENDING', message }, lines, again, 'none');
    }
    await sleep(o.pollMs);
  }
}
