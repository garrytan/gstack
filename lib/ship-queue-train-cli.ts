/**
 * Argument parsing and output for the merge-train surface of
 * bin/gstack-ship-queue: `train build|status|verdict|bisect|rebuild|prune`,
 * `ready --screen|--no-screen [--broad]` and `verify --train`. Every command
 * prints its lines, the coded error line on stderr, then `NEXT: <command>`
 * and the canonical `GSTACK_RESULT: skill=ship-queue status=<s> run=<record>`.
 * Loaded by the bin only when one of those paths runs.
 */
import { EXIT, formatResult } from './headless-artifacts';
import { RESULT_CODES } from './result-codes';
import type { QueueContext } from './ship-queue';
import { buildTrain, pruneTrains, trainStatus, type TrainOut } from './ship-queue-train';
import { trainReady, verifyScreen } from './ship-queue-train-ready';
import { trainBisect, trainRebuild, trainVerdict } from './ship-queue-train-verdict';
import { verifyTrain } from './ship-queue-train-verify';
import { trainWatch } from './ship-queue-train-watch';
import { verifyPostMerge } from './ship-queue-post-merge';
import { trainForget } from './ship-queue-train-forget';
import { redactCause } from './ship-queue-train-record';

export const TRAIN_HELP = `  train build --prs <n>@<sha>[,...] [--order <n>,...] [--urgent | --repair] [--dry-run [--stack-tests [--stack-tests-command "<cmd>"]]] [--free-timeout <s>]
                                           [--allow-repo-commands]: changelog_fragments trains stamp S_1..S_k with the
                                           base policy's restamp_command or release_tool
                                           --order: explicit slot order, every PR in --prs once (default: screened
                                           first, then READY order)
  train init [--command "<test cmd>" [--timeout <s>] [--spend-cap <usd>]]
                                           (any repository) read branch protection, the base's workflows and open PRs; print
                                           a train block with gates, the nonce snippet each gate workflow needs and the land
                                           mode; refuses when PRs bump the version without changelog_fragments or stamp-at-merge
  train doctor                             re-check the base policy's train block with gates against the repository: gate
                                           workflows, nonce input, run-name, required jobs, concurrency, push triggers on
                                           train-prefix/ refs, green on the base, merge method (writes nothing)
  train build --train <nonce>              resume a train (push, free tests, dispatch) from its record
                                           merge pinned unstamped heads in slot order onto main, free tests on
                                           train/<nonce>, then one full gate through eval-bg's nonce
  train status [--train <nonce>]           never spends: rebuild records from refs/notes/gstack-trains, reconcile
                                           unconfirmed dispatches by nonce
  train verdict --train <nonce>            read the gate run and its record: GREEN, RED, INCOMPLETE or PENDING
  train land --train <nonce> --pr <n> [--no-wait] [--timeout <min>]
                                           publish slot n's prefix (stamped S_i, else gated T_i): update mode commits its tree on
                                           [pin, main], pushes under the pin's lease, waits for checks and merges; direct mode
                                           (trains with gates, no strict protection, a green pin) runs gh pr merge
                                           --match-head-commit <pin>; then confirms main's tree is the prefix's
  train bisect --train <nonce> --spend-cap <usd> [--dry-run]
                                           red cases on every prefix T0..Tk, resumable and capped
  train rebuild --train <nonce> [--infra]  the one rebuild an all-green bisect earns (or the one INFRA re-dispatch)
  train watch --train <nonce> [--timeout <s>] [--land]
                                           resumable follow: runs the step the record asks for (build, status), waits for the
                                           pending run, reads the verdict, prints NEXT; rerun it after a restart (no daemon);
                                           --land (trains with gates) lands each landable slot in order
  train forget --train <nonce> | --receipt <pr>@<sha> [--dry-run]
                                           remove a settled train record (attempts, bisect) or a READY receipt from
                                           refs/notes/gstack-trains under an exact lease, then delete the local files
  train prune [--train <nonce>] [--dry-run] [--stale]
                                           delete train/<nonce> branches of merged, superseded or dropped trains; --stale also
                                           settles merging or green trains whose every PR is merged or closed on GitHub, and
                                           deletes screen/<pr>-* branches of merged or closed PRs
  ready --pr <n> --screen [--broad] | --no-screen [--dry-run] [--dispatch-ci <wf.yml[,…]> [--timeout <s>]]
        [--base-red --fixer <pr> | --fixes-base-red <case,...>]
                                           (trains with gates) --base-red: a conditional READY for a paused /ship, seated
                                           only behind fixer <pr> at slot 1; --fixes-base-red: the fixer's READY
                                           (train policy) READY plus the screen choice, recorded as a receipt; a head whose
                                           screen run is RED is refused (QUEUE_SCREEN_RED). --dispatch-ci runs the named
                                           workflows on the branch first (a conflicting PR has no pull_request CI), waits for
                                           them and clears the matching requires-remote pregate lanes with the run URLs
  verify --pr <n> --train <nonce> [--no-fetch]
                                           (train policy) the merge check against a green train record
  verify --pr <n> --screen                 (train policy) the PR head's screen verdict read from its run: SCREEN_VERDICT and
                                           FLAKY lines, recorded in the READY receipt
  verify --post-merge <sha> [--timeout <s>] [--checks <a,b>] after a merge: wait for every check run at the merged commit to settle;
                                           POST_MERGE: green|red|pending plus one CHECK: line per workflow (resumable)
  Merge trains need a "train" block in the base revision's ship policy (docs/ship-policy.md#run-a-merge-train).`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function printTrain(cmd: string, out: TrainOut): number {
  for (const line of out.lines) process.stdout.write(line + '\n');
  if (out.failure) {
    const f = out.failure;
    process.stderr.write(`gstack-ship-queue ${cmd}: ${f.message}; fix: ${f.fix ?? RESULT_CODES[f.code].fix} (${f.code})\n`);
  }
  process.stdout.write(`NEXT: ${out.next}\n`);
  process.stdout.write(formatResult('ship-queue', out.status, out.run) + '\n');
  return out.exit;
}

function usage(message: string): number {
  process.stderr.write(`gstack-ship-queue: ${message}\n${TRAIN_HELP}\n`);
  return EXIT.usage;
}

async function guarded(cmd: string, fn: () => Promise<TrainOut> | TrainOut): Promise<number> {
  try {
    return printTrain(cmd, await fn());
  } catch (error) {
    const cause = redactCause(error instanceof Error ? error.message : String(error));
    process.stderr.write(`gstack-ship-queue ${cmd}: unexpected failure: ${cause}\n`);
    process.stdout.write(`NEXT: gstack-ship-queue train status\n`);
    process.stdout.write(formatResult('ship-queue', 'interrupted', 'none') + '\n');
    return EXIT.fail;
  }
}

const positive = (s: string | undefined, fallback: number) => (s !== undefined && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : s === undefined ? fallback : NaN);

export async function trainMain(ctx: QueueContext, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const nonce = flag(rest, '--train');
  const dryRun = rest.includes('--dry-run');
  if (sub === 'build') {
    if (!nonce && !flag(rest, '--prs')) return usage('train build needs --prs <n>@<sha>[,...] or --train <nonce>');
    const freeTimeoutSec = positive(flag(rest, '--free-timeout'), 2700);
    if (Number.isNaN(freeTimeoutSec)) return usage('--free-timeout needs seconds');
    if (rest.includes('--urgent') && rest.includes('--repair')) return usage('--urgent and --repair are separate one-PR trains; pass one');
    if (rest.includes('--order') && (nonce || !flag(rest, '--order'))) return usage('--order <n>,... orders a new train from --prs; a resumed train keeps its recorded order');
    const stackCommand = flag(rest, '--stack-tests-command');
    if ((rest.includes('--stack-tests') || stackCommand !== undefined) && !dryRun) return usage('--stack-tests runs each PR\'s new test files on its integrated prefix; it needs --dry-run');
    const stackWords = stackCommand?.split(/\s+/).filter(Boolean);
    if (stackCommand !== undefined && !stackWords?.length) return usage('--stack-tests-command needs a command');
    return guarded('train build', () => buildTrain(ctx, {
      pins: flag(rest, '--prs'), order: flag(rest, '--order'), resume: nonce, dryRun, urgent: rest.includes('--urgent'), repair: rest.includes('--repair'), freeTimeoutSec,
      pollMs: Number(process.env.GSTACK_SHIP_QUEUE_POLL_MS) || 30_000, stackTests: stackWords?.length ? stackWords : rest.includes('--stack-tests') ? true : undefined,
      allowRepoCommands: rest.includes('--allow-repo-commands'),
    }));
  }
  if (sub === 'init') {
    const timeoutSec = positive(flag(rest, '--timeout'), 1800);
    const spendCap = flag(rest, '--spend-cap') === undefined ? undefined : positive(flag(rest, '--spend-cap'), NaN);
    if (Number.isNaN(timeoutSec) || (spendCap !== undefined && Number.isNaN(spendCap))) return usage('--timeout needs seconds and --spend-cap dollars');
    const command = flag(rest, '--command');
    if (rest.includes('--command') && !command?.trim()) return usage('--command needs the test command a command gate runs');
    return guarded('train init', async () => (await import('./ship-queue-train-init')).trainInit(ctx, { command, timeoutSec, spendCap }));
  }
  if (sub === 'doctor') return guarded('train doctor', async () => (await import('./ship-queue-train-init')).trainDoctor(ctx));
  if (sub === 'status') return guarded('train status', () => trainStatus(ctx, { train: nonce }));
  if (sub === 'prune') return guarded('train prune', () => pruneTrains(ctx, { dryRun, train: nonce, stale: rest.includes('--stale') }));
  if (sub === 'forget') {
    const receipt = flag(rest, '--receipt');
    if (!nonce && !receipt) return usage('train forget needs --train <nonce> or --receipt <pr>@<sha>');
    return guarded('train forget', () => trainForget(ctx, { train: nonce, receipt, dryRun }));
  }
  if (!nonce) return usage(`train ${sub ?? '<subcommand>'} needs --train <nonce>`);
  if (sub === 'watch') {
    const timeoutSec = positive(flag(rest, '--timeout'), 7200);
    if (Number.isNaN(timeoutSec)) return usage('--timeout needs seconds');
    const freeTimeoutSec = positive(flag(rest, '--free-timeout'), 2700);
    if (Number.isNaN(freeTimeoutSec)) return usage('--free-timeout needs seconds');
    return guarded('train watch', () => trainWatch(ctx, { train: nonce, timeoutSec, pollMs: Number(process.env.GSTACK_SHIP_QUEUE_POLL_MS) || 30_000, freeTimeoutSec, land: rest.includes('--land') }));
  }
  if (sub === 'verdict') return guarded('train verdict', () => trainVerdict(ctx, { train: nonce }));
  if (sub === 'land') {
    const pr = flag(rest, '--pr');
    if (!pr || !/^\d+$/.test(pr)) return usage('train land needs --pr <number>');
    const timeout = positive(flag(rest, '--timeout'), 60);
    if (Number.isNaN(timeout)) return usage('--timeout needs minutes');
    return guarded('train land', async () => (await import('./ship-queue-train-land')).trainLand(ctx, { train: nonce, pr, noWait: rest.includes('--no-wait'), timeoutMin: timeout }));
  }
  if (sub === 'rebuild') return guarded('train rebuild', () => trainRebuild(ctx, { train: nonce, infra: rest.includes('--infra') }));
  if (sub === 'bisect') {
    const cap = positive(flag(rest, '--spend-cap'), NaN);
    if (Number.isNaN(cap)) return usage('train bisect needs --spend-cap <usd>');
    return guarded('train bisect', () => trainBisect(ctx, { train: nonce, spendCap: cap, dryRun }));
  }
  return usage(`unknown train subcommand ${sub}`);
}

export async function readyMain(ctx: QueueContext, args: string[], base: { pr: string; pregate?: string; gateExit?: number; gateLog?: string }): Promise<number> {
  const screen = args.includes('--screen');
  const noScreen = args.includes('--no-screen');
  if (screen && noScreen) return usage('pass one of --screen or --no-screen');
  if (args.includes('--broad') && !screen) return usage('--broad selects the screen policy; it needs --screen');
  const dispatchCi = flag(args, '--dispatch-ci');
  const workflows = dispatchCi === undefined ? [] : dispatchCi.split(',').map(s => s.trim()).filter(Boolean);
  if (dispatchCi !== undefined && (!workflows.length || workflows.some(w => !/^[\w.-]+\.ya?ml$/.test(w)))) return usage('--dispatch-ci names workflow files under .github/workflows, comma-separated (free-tests.yml,windows-free-tests.yml)');
  const timeoutSec = positive(flag(args, '--timeout'), 2700);
  if (!Number.isFinite(timeoutSec)) return usage('--timeout needs a positive number of seconds');
  const fixer = flag(args, '--fixer');
  const fixes = flag(args, '--fixes-base-red');
  if (fixer !== undefined && !/^\d+$/.test(fixer)) return usage('--fixer needs the fixer PR number');
  if (fixer !== undefined && !args.includes('--base-red')) return usage('--fixer names the fixer of a --base-red READY');
  if (args.includes('--base-red') && fixes !== undefined) return usage('--base-red (the paused PR) and --fixes-base-red (its fixer) are different READYs; pass one');
  if ((args.includes('--base-red') || fixes !== undefined) && !noScreen) return usage('a base-red READY is --no-screen: the train gates every prefix');
  const fixesBaseRed = fixes?.split(',').map(s => s.trim()).filter(Boolean);
  if (fixes !== undefined && !fixesBaseRed?.length) return usage('--fixes-base-red names the gate cases the fixer repairs, comma-separated');
  return guarded('ready', () => trainReady(ctx, { ...base, baseRed: args.includes('--base-red') ? { fixer } : undefined, fixesBaseRed, screen: screen ? 'screen' : noScreen ? 'no-screen' : undefined, broad: args.includes('--broad'), dryRun: args.includes('--dry-run'),
    dispatchCi: workflows.length ? { workflows, timeoutSec, pollMs: Number(process.env.GSTACK_SHIP_QUEUE_POLL_MS) || 30_000 } : undefined }));
}

export async function postMergeMain(ctx: QueueContext, args: string[]): Promise<number> {
  const sha = flag(args, '--post-merge');
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return usage('verify --post-merge needs the merged commit\'s full 40-hex SHA');
  const timeoutSec = positive(flag(args, '--timeout'), 2700);
  if (!Number.isFinite(timeoutSec)) return usage('--timeout needs a positive number of seconds');
  const checks = flag(args, '--checks')?.split(',').map(s => s.trim()).filter(Boolean);
  return guarded('verify', () => verifyPostMerge(ctx, { sha, timeoutSec, pollMs: Number(process.env.GSTACK_SHIP_QUEUE_POLL_MS) || 30_000, checks }));
}

export async function verifyMain(ctx: QueueContext, args: string[], pr: string): Promise<number> {
  if (args.includes('--screen')) return guarded('verify', () => verifyScreen(ctx, { pr }));
  return guarded('verify', () => verifyTrain(ctx, { pr, train: flag(args, '--train')!, noFetch: args.includes('--no-fetch') }));
}
