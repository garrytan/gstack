/**
 * `ready --pr <n> --screen | --no-screen` under a ship policy with a `train`
 * block (docs/ship-policy.md#run-a-merge-train; plan GSTA-49 T1). The
 * READY block is today's (lib/ship-queue.ts ready()); this adds the screen
 * selection and the default recommendation (screen only when the selector
 * restores every case or cannot select), requires an explicit choice
 * (READY_SCREEN_CHOICE_REQUIRED), dispatches a chosen screen through
 * eval-bg's nonce with its purpose and policy in the key, and records the
 * choice as a READY receipt (local state and refs/notes/gstack-trains) that
 * `train build` requires. The screen's dollar price is left to the T0 cost
 * replay (lib/gate-cost.ts) and printed as pending until it lands.
 *
 * The screen's verdict comes from its run (lib/ship-queue-screen.ts): a head
 * whose recorded screen is RED is refused (QUEUE_SCREEN_RED) under either
 * choice, and a red run is never re-dispatched at its merge SHA. The screen
 * is planned on GitHub's refs/pull/<n>/merge when that merges the head, else
 * on a scratch merge of the head onto origin/<base> built with the train's
 * merge rules and pushed as screen/<pr>-<head12> (#3465); only a real
 * conflict is QUEUE_SCREEN_STALE_REF.
 */
import { randomBytes } from 'node:crypto';
import { DISPATCH_INPUTS, awaitNonceRun, dedupeKey, dispatchWorkflow, findDuplicateRun, listDispatchRuns, makeNonce, type WorkflowDispatch } from '../scripts/eval-bg';
import { EXIT } from './headless-artifacts';
import { ready, type QueueContext } from './ship-queue';
import { classifyTrainHead } from './version-gate-train';
import { git } from './ship-queue-gate';
import { dispatchCi } from './ship-queue-dispatch-ci';
import { recordVerdict, screenVerdict, verdictLines, type ScreenOutcome } from './ship-queue-screen';
import { execFor, prInfo, repoSlug } from './ship-queue-train-github';
import { bindTrainReceipt } from './ship-queue-train-gate';
import { extractReceipt } from './ship-receipt';
import { loadReady, nowIso, persist, readyPath, rebuildFromNotes, type ReadyReceipt, type ScreenChoice } from './ship-queue-train-record';
import { baseOverlap, fetchBase, mergeCommit, outOk, outPending, outRefused, trainEnv, type TrainEnv, type TrainOut } from './ship-queue-train';

const Q = 'gstack-ship-queue';

export interface ReadyOptions {
  pr: string; pregate?: string; gateExit?: number; gateLog?: string; screen?: 'screen' | 'no-screen'; broad: boolean; dryRun: boolean;
  /** `--dispatch-ci`: run these workflows on the PR branch, wait, and clear the matching requires-remote pregate lanes before reading the head. */
  dispatchCi?: { workflows: string[]; timeoutSec: number; pollMs: number };
  /** `--base-red --fixer <n>`: a conditional READY on a paused receipt, owned by the fixer PR (trains with gates only). */
  baseRed?: { fixer?: string };
  /** `--fixes-base-red <case,...>`: the fixer's READY names the gate cases T0 may be red on. */
  fixesBaseRed?: string[];
}
export interface ScreenSelection { lines: string[]; recommend: 'screen' | 'no-screen' | null }

/** Skill directories a diff touches: top-level directories that hold a SKILL.md.tmpl at the head. */
export function touchedSkills(changed: readonly string[], hasTemplate: (dir: string) => boolean): string[] {
  return [...new Set(changed.filter(f => f.includes('/')).map(f => f.split('/')[0]!))].filter(hasTemplate).sort();
}

/** The selected cases that are a touched skill's own: their touchfiles name a path inside that skill's directory. */
export function skillOwnCases(selected: readonly string[], touchfiles: Record<string, string[]>, skills: readonly string[]): string[] {
  return selected.filter(id => (touchfiles[id] ?? []).some(glob => skills.some(s => glob.startsWith(`${s}/`)))).sort();
}

/**
 * gstack's paid selector over a diff, as a narrow screen (`--screen` without `--broad`) plans it, loaded only when the
 * policy asks for it. The recommendation is --screen only when the selector restores every case (its `full-fallback`
 * mode: an unknown dependency or a shared runtime input) or cannot select at all; every other PR rides the train
 * unscreened, where the full gate census runs every case on the tree that merges (GSTA-165).
 */
export async function gstackPaidSelection(repoRoot: string, baseSha: string, changed: string[], hasTemplate: (dir: string) => boolean): Promise<ScreenSelection> {
  const { computePaidCaseSelection } = await import('../scripts/lib/paid-select');
  const { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } = await import('../test/helpers/touchfiles');
  const skills = touchedSkills(changed, hasTemplate);
  let e2e: string[]; let judges: number; let note = "the narrow screen's selection; --broad adds the dependents of files whose references reach every gate case";
  let why: string;
  let everyCase = false;
  try {
    const r = computePaidCaseSelection({ profile: 'pr', rootDir: repoRoot, changedFiles: changed, env: { ...process.env, EVALS_BASE: baseSha, EVALS_ALL: '', EVALS_SCREEN_POLICY: 'narrow' } });
    e2e = r.selection.e2e ?? Object.keys(E2E_TOUCHFILES);
    judges = r.selection.judges ? r.selection.judges.length : Object.keys(LLM_JUDGE_TOUCHFILES).length;
    const mode = r.coverage?.mode ?? 'unknown';
    everyCase = mode === 'full-fallback';
    why = everyCase ? `selector mode full-fallback (${r.reason.slice(0, 200)})` : `selector mode ${mode}: the train gate's full census covers these cases`;
  } catch (error) {
    e2e = Object.keys(E2E_TOUCHFILES);
    judges = Object.keys(LLM_JUDGE_TOUCHFILES).length;
    note = `the PR profile needs full validation (${error instanceof Error ? error.message.slice(0, 160) : String(error)}): the screen is the full gate selection`;
    everyCase = true;
    why = 'the selector could not select';
  }
  const own = skillOwnCases(e2e, E2E_TOUCHFILES, skills);
  const recommend = everyCase ? 'screen' : 'no-screen';
  return {
    recommend,
    lines: [
      `SCREEN: selection ${e2e.length} e2e case(s) + ${judges} judge(s) (${note})`,
      `SCREEN: skill's own cases ${own.length ? own.slice(0, 12).join(',') + (own.length > 12 ? ` (+${own.length - 12})` : '') : 'none'}`,
      `SCREEN: ${why} → recommend --${recommend}`,
    ],
  };
}

async function screenSelection(env: TrainEnv, head: string, baseSha: string): Promise<ScreenSelection> {
  const price = 'SCREEN: price pending the T0 cost replay (lib/gate-cost.ts): cases without cost data are unknown; a red train holds its PRs about an hour';
  if (env.train.gates || env.train.screen_selection === 'none') return { recommend: null, lines: ['SCREEN: selection not computed (train.screen_selection is none); no recommendation, the lane decides', price] };
  const changed = git(env.ctx.repoRoot, ['diff', '--name-only', `${baseSha}...${head}`]).out.split('\n').filter(Boolean);
  const hasTemplate = (dir: string) => git(env.ctx.repoRoot, ['cat-file', '-e', `${head}:${dir}/SKILL.md.tmpl`]).ok;
  const s = await gstackPaidSelection(env.ctx.repoRoot, baseSha, changed, hasTemplate);
  return { ...s, lines: [...s.lines, price] };
}

/** The scratch branch a screen's merge commit is pushed to when GitHub's merge ref lags the head. */
export const screenBranch = (pr: string, head: string) => `screen/${pr}-${head.slice(0, 12)}`;

/**
 * The merge commit the screen tests: GitHub's refs/pull/<n>/merge when it
 * merges the PR head, else a scratch merge of the head onto origin/<base>
 * (the train's merge rules) pushed as screen/<pr>-<head12>, so evals.yml can
 * check it out and read its parents. A conflict beyond the CHANGELOG and the
 * stamp files is the only QUEUE_SCREEN_STALE_REF left.
 */
function screenMerge(env: TrainEnv, o: ReadyOptions, head: string, baseSha: string): { mergeSha: string; branch?: string; line: string } | TrainOut {
  const { ctx } = env;
  const ls = git(ctx.repoRoot, ['ls-remote', env.remote, `refs/pull/${o.pr}/merge`]);
  if (!ls.ok) return outRefused({ code: 'QUEUE_SCREEN_STALE_REF', message: `could not list ${env.remote}'s refs: ${(ls.err || ls.out).trim().replace(/\s+/g, ' ').slice(0, 200) || 'git ls-remote failed'}` }, [], `check the remote, then ${Q} ready --pr ${o.pr} --screen`, 'none');
  const github = ls.out.split(/\s/)[0] ?? '';
  let lag = `${env.remote} has no refs/pull/${o.pr}/merge`;
  if (/^[0-9a-f]{40,64}$/.test(github)) {
    const fetched = git(ctx.repoRoot, ['fetch', '-q', env.remote, `refs/pull/${o.pr}/merge`]);
    const parent = fetched.ok ? git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `${github}^2`]).out : '';
    const onto = fetched.ok ? git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `${github}^1`]).out : '';
    if (parent === head && onto === baseSha) return { mergeSha: github, line: `SCREEN_MERGE: GitHub's refs/pull/${o.pr}/merge ${github.slice(0, 12)} merges the head ${head.slice(0, 12)} onto ${ctx.base}@${baseSha.slice(0, 12)}` };
    lag = !fetched.ok ? `refs/pull/${o.pr}/merge ${github.slice(0, 12)} could not be fetched`
      : parent !== head ? `refs/pull/${o.pr}/merge ${github.slice(0, 12)} merges ${parent ? parent.slice(0, 12) : 'no PR head'}, not ${head.slice(0, 12)}`
      : `refs/pull/${o.pr}/merge ${github.slice(0, 12)} merges onto ${onto ? onto.slice(0, 12) : 'no base'}, not ${ctx.base}@${baseSha.slice(0, 12)}`;
  }
  const m = mergeCommit(ctx.repoRoot, baseSha, head, env.policy.policy, `screen #${o.pr}: merge ${head.slice(0, 12)} onto ${ctx.base} ${baseSha.slice(0, 12)}`);
  if ('conflicts' in m) {
    return outRefused({ code: 'QUEUE_SCREEN_STALE_REF', message: `#${o.pr} conflicts with ${ctx.base}@${baseSha.slice(0, 12)} beyond the CHANGELOG and the stamp files (${m.conflicts.join(', ')}); GitHub's merge ref lags too (${lag})` }, [],
      `resolve the conflict with ${ctx.base}, push, run /ship, then ${Q} ready --pr ${o.pr} --screen`, 'none');
  }
  const branch = screenBranch(o.pr, head);
  const line = `SCREEN_MERGE: scratch merge ${m.commit.slice(0, 12)} of #${o.pr}@${head.slice(0, 12)} onto ${ctx.base}@${baseSha.slice(0, 12)} (${lag})`;
  if (o.dryRun) return { mergeSha: m.commit, branch, line: `${line}; would push ${branch} (dry run)` };
  const p = git(ctx.repoRoot, ['push', '-q', '-f', env.remote, `${m.commit}:refs/heads/${branch}`]);
  if (!p.ok) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `could not push the screen's scratch merge as ${branch}: ${p.err.trim().replace(/\s+/g, ' ').slice(0, 200)}` }, [line], `check the remote, then ${Q} ready --pr ${o.pr} --screen`, 'none');
  return { mergeSha: m.commit, branch, line: `${line}; pushed ${branch}` };
}

/** Dispatch (or adopt) the PR's screen on the base branch: inputs name the PR, its merge SHA and the screen policy. */
async function dispatchScreen(env: TrainEnv, o: ReadyOptions, slug: string | null, mergeSha: string, baseSha: string): Promise<{ choice: ScreenChoice; lines: string[] } | TrainOut> {
  const policy = o.broad ? 'broad' : 'narrow';
  const scope = { purpose: 'screen' as const, policy: policy as 'narrow' | 'broad' };
  const nonce = makeNonce('pr', mergeSha, baseSha, randomBytes(3).toString('hex'), scope);
  const dispatch: WorkflowDispatch = { workflow: env.train.gate_workflow, inputs: {
    [DISPATCH_INPUTS.evalsAll]: 'false', [DISPATCH_INPUTS.expectedSha]: mergeSha, [DISPATCH_INPUTS.nonce]: nonce, [DISPATCH_INPUTS.baseRef]: env.ctx.base,
    [DISPATCH_INPUTS.baseSha]: baseSha, [DISPATCH_INPUTS.screenPr]: o.pr, [DISPATCH_INPUTS.screenMergeSha]: mergeSha, [DISPATCH_INPUTS.screenPolicy]: policy,
  } };
  const inputs = Object.entries(dispatch.inputs).map(([k, v]) => `${k}=${v}`).join(' ');
  if (o.dryRun) return { choice: { choice: 'screen', policy, nonce, run: null, merge_sha: mergeSha }, lines: [`SCREEN_DISPATCH: ${dispatch.workflow} --ref ${env.ctx.base} ${inputs} (dry run: not dispatched)`] };
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, [], `${Q} ready --pr ${o.pr} --screen`, 'none');
  const exec = execFor(env.ctx);
  const existing = findDuplicateRun(listDispatchRuns(dispatch.workflow, exec, slug) ?? [], dedupeKey('pr', mergeSha, baseSha, scope));
  const prior: ScreenOutcome | null = existing ? screenVerdict(env.ctx, slug, existing.databaseId) : null;
  if (existing && prior) {
    const choice: ScreenChoice = { choice: 'screen', policy, nonce: /eval-bg (\S+?)\]/.exec(existing.displayTitle)?.[1] ?? nonce, run: existing.databaseId, merge_sha: mergeSha };
    recordVerdict(choice, prior);
    const lines = verdictLines(o.pr, existing.databaseId, prior);
    if (prior.kind === 'red') return outRefused({ code: 'QUEUE_SCREEN_RED', message: `the screen of #${o.pr} at merge ${mergeSha.slice(0, 12)} (run ${existing.databaseId}) is RED on ${prior.red.join(', ') || 'its gate binding'}; a red screen is not re-dispatched at the same merge SHA` },
      lines, `repair, push a new head, run /ship, then ${Q} ready --pr ${o.pr} --screen`, 'none');
    if (prior.kind !== 'not-run' && prior.kind !== 'incomplete') {
      return { choice, lines: [...lines, `SCREEN_DISPATCH: following run ${existing.databaseId} (same merge SHA, base and policy; no duplicate)`] };
    }
  }
  const notFollowing = existing && prior ? ` (not following ${prior.detail}: a screen that ${prior.kind === 'not-run' ? 'planned nothing' : 'bound no verdict'} is not a screen)` : '';
  const found = dispatchWorkflow(dispatch, env.ctx.base, exec, slug) ? await awaitNonceRun(dispatch.workflow, nonce, exec, slug) : null;
  if (!found) return outPending({ code: 'QUEUE_TRAIN_DISPATCH_UNKNOWN', message: `no ${dispatch.workflow} run named ${nonce} appeared after the screen dispatch` }, [], `${Q} ready --pr ${o.pr} --screen${o.broad ? ' --broad' : ''} (adopts the run by its key once it appears)`, 'none');
  return { choice: { choice: 'screen', policy, nonce, run: found.databaseId, merge_sha: mergeSha }, lines: [`SCREEN_DISPATCH: ${dispatch.workflow} run ${found.databaseId} ${found.url} nonce ${nonce}${notFollowing}`] };
}

const screenLine = (c: ScreenChoice) => `screen: ${c.choice}${c.policy ? ` policy=${c.policy} nonce=${c.nonce} run=${c.run ?? '-'}${c.verdict ? ` verdict=${c.verdict.outcome}` : ''}` : ''}`;

/**
 * `ready --base-red --fixer <n>` (plan GSTA-157 item 5): the head's receipt is conditional (its base_red block), so
 * Step 5, CI and the pregate did not pass on the broken base and the per-PR READY checks are not asked; instead the
 * condition must be current (classified on today's base, not expired) and owned by a fixer PR. The READY receipt
 * records it; train build seats the PR only behind its fixer at slot 1 of a train with gates, every prefix is gated
 * with nothing excluded, and train land merges it only through an update commit whose own checks are green.
 */
function conditionalReady(env: TrainEnv, o: ReadyOptions, lines: string[]): TrainOut {
  const { ctx } = env;
  const head = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  const baseSha = git(ctx.repoRoot, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
  const info = prInfo(ctx, o.pr);
  if ('error' in info) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: info.error }, lines, 'none', 'none');
  if (info.headRefOid !== head) return outRefused({ code: 'QUEUE_NOT_READY', message: `HEAD ${head.slice(0, 12)} is not PR #${o.pr}'s pushed head ${info.headRefOid.slice(0, 12)}` }, lines, 'push, then ready again', 'none');
  const red = extractReceipt(info.body).receipt?.base_red;
  const again = `gstack-base-red classify on the current base, /ship, then ${Q} ready --pr ${o.pr} --no-screen --base-red --fixer ${o.baseRed!.fixer}`;
  if (!red) return outRefused({ code: 'SHIP_BASE_RED_FIXER', message: `#${o.pr}'s receipt carries no base_red condition; ready --base-red is only for a paused /ship` }, lines, `${Q} ready --pr ${o.pr} --no-screen`, 'none');
  if (red.base !== baseSha) return outRefused({ code: 'SHIP_BASE_RED_FIXER', message: `the condition was classified at ${red.base.slice(0, 12)} and ${ctx.base} is now ${baseSha.slice(0, 12)}; a base move reclassifies, never trusts` }, lines, again, 'none');
  if (!(Date.parse(red.expires_at) >= Date.parse(nowIso()))) return outRefused({ code: 'BASE_RED_PAUSE_EXPIRED', message: `the condition expired at ${red.expires_at}` }, lines, again, 'none');
  const shipped = bindTrainReceipt(ctx.repoRoot, `refs/remotes/${env.remote}/${ctx.base}`, info.body, o.pr, [head], true);
  lines.push(shipped.line, ...(shipped.depthLine ? [shipped.depthLine] : []));
  if (!shipped.ok) return outRefused({ code: shipped.code, message: shipped.message }, lines, `run /ship on ${head.slice(0, 12)}, then ready again`, 'none');
  const now = nowIso();
  const base_red = { cases: red.cases, fixer: o.baseRed!.fixer!, base: red.base, expires_at: red.expires_at };
  const receipt: ReadyReceipt = { schema: 1, kind: 'ready', repo_key: env.repo.key, pr: o.pr, head, base_sha: baseSha, ready_at: now, screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: now, base_red };
  lines.unshift(`READY #${o.pr} ${head} CONDITIONAL`, 'screen: no-screen');
  lines.push(`BASE_RED: ${red.cases.join(', ')} base=${red.base.slice(0, 12)} fixer=#${base_red.fixer} expires=${red.expires_at} (CI and the pregate ran on the broken base; the train gates every prefix and lands this PR only through an update commit with green checks)`);
  if (o.dryRun) return outOk([...lines, 'DRY-RUN: no READY receipt written'], `${Q} ready --pr ${o.pr} --no-screen --base-red --fixer ${base_red.fixer}`, 'none');
  const p = persist(ctx.repoRoot, [receipt], { remote: env.remote });
  lines.push(`READY_RECEIPT: ${readyPath(env.repo.key, o.pr, head)} (${p.detail})`);
  return outOk(lines, `send the READY block; the coordinator builds the train with fixer #${base_red.fixer} at slot 1: ${Q} train build --prs ${base_red.fixer}@<sha>,${o.pr}@${head}`, readyPath(env.repo.key, o.pr, head));
}

export async function trainReady(ctx: QueueContext, o: ReadyOptions): Promise<TrainOut> {
  const fetchErr = fetchBase(ctx);
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(o.baseRed || o.fixesBaseRed ? { code: 'QUEUE_BASE_RED_NO_TRAIN', message: `${env.message}; a base-red READY needs a train with gates` } : env, [], 'none', 'none');
  if (fetchErr) return outRefused({ code: 'POLICY_SOURCE_UNAVAILABLE', message: fetchErr }, [], 'none', 'none');
  if ((o.baseRed || o.fixesBaseRed) && !env.train.gates) return outRefused({ code: 'QUEUE_BASE_RED_NO_TRAIN', message: 'the base policy\'s train is the gstack-evals kind, which gates only its tip; a base-red READY needs a train with gates' }, [], 'none', 'none');
  if (o.baseRed && !o.baseRed.fixer) return outRefused({ code: 'SHIP_BASE_RED_FIXER', message: 'ready --base-red names no fixer: a conditional READY needs the PR whose merge fixes its cases' }, [], `${Q} ready --pr ${o.pr} --no-screen --base-red --fixer <pr>`, 'none');
  if (env.train.gates && o.screen === 'screen') return outRefused({ code: 'READY_SCREEN_CHOICE_REQUIRED', message: 'a train with gates has no paid screen; every prefix is gated at build' }, [], `${Q} ready --pr ${o.pr} --no-screen`, 'none');
  if (o.baseRed) return conditionalReady(env, o, []);
  const ciLines: string[] = [];
  if (o.dispatchCi && !o.dryRun) {
    const d = await dispatchCi(ctx, { pr: o.pr, pregate: o.pregate, ...o.dispatchCi });
    ciLines.push(...d.lines);
    if ('failure' in d) {
      const again = `${Q} ready --pr ${o.pr} ${o.screen === 'screen' ? '--screen' : '--no-screen'} --dispatch-ci ${o.dispatchCi.workflows.join(',')} --timeout ${o.dispatchCi.timeoutSec}`;
      return (d.failure.code === 'QUEUE_TRAIN_PENDING' ? outPending : outRefused)(d.failure, ciLines, d.failure.code === 'QUEUE_TRAIN_PENDING' ? again : `read the run, repair, push, run /ship, then ${again}`, 'none');
    }
  }
  const base = ready(ctx, o);
  base.lines.unshift(...ciLines);
  if (!base.ok) {
    const out = outRefused(base.failure!, base.lines, `fix the refusal, then ${Q} ready --pr ${o.pr} --screen|--no-screen`, base.run);
    return ['QUEUE_VERIFY_MISMATCH', 'QUEUE_STAMP_NOT_STAMP_ONLY'].includes(base.failure!.code) ? { ...out, exit: EXIT.fail } : out;
  }
  const head = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  const baseSha = git(ctx.repoRoot, ['rev-parse', `${env.remote}/${ctx.base}`]).out;
  const kind = classifyTrainHead({ repoRoot: ctx.repoRoot, baseRef: ctx.base, head });
  if (kind.kind === 'invalid') return outRefused({ code: 'QUEUE_NOT_READY', message: `the Version Gate refuses ${head.slice(0, 12)}: ${kind.reason}` }, base.lines, `fix the head, push, then ${Q} ready --pr ${o.pr} --screen|--no-screen`, 'none');
  const sel = await screenSelection(env, head, baseSha);
  const lines = [...base.lines, ...sel.lines];
  // gstack-pr-wait's base-overlap event, read from git at READY (handoff GSTA-119): the lane learns here that the base
  // moved onto its files, and a merge the train would stop at is refused before the pin is pooled. Under --screen the
  // scratch merge below reports the same conflict as QUEUE_SCREEN_STALE_REF. A comparison git could not make is printed as
  // unknown and refuses nothing: the screen or the train makes the merge for real.
  const overlap = baseOverlap(ctx.repoRoot, ctx.base, baseSha, head, env.policy.policy);
  if (overlap.line) lines.push(overlap.line);
  if (overlap.conflicts && o.screen !== 'screen') {
    // The fix follows the crew template (captain/templates/CREW.md rule 14): a lane merges the base into a READY PR only on
    // the controller's word, so the refusal is reported and the merge waits for that word.
    return outRefused({ code: 'QUEUE_TRAIN_CONFLICT', message: `#${o.pr} conflicts with ${ctx.base}@${baseSha.slice(0, 12)} beyond the CHANGELOG and the stamp files (${overlap.conflicts.join(', ')}); the train would stop at this PR` },
      lines, `report the conflict to the controller; on its word merge ${ctx.base} into the pin (never rebase), resolve, push, run /ship, then ${Q} ready --pr ${o.pr} --screen|--no-screen`, 'none');
  }
  if (!loadReady(env.repo.keys, o.pr, head)) rebuildFromNotes(ctx.repoRoot, env.remote);
  const prior = loadReady(env.repo.keys, o.pr, head);
  const slug = repoSlug(ctx);
  if (prior?.screen.run && slug) {
    const read = screenVerdict(ctx, slug, prior.screen.run);
    lines.push(...verdictLines(o.pr, prior.screen.run, read));
    if (recordVerdict(prior.screen, read) && !o.dryRun) { prior.updated_at = nowIso(); persist(ctx.repoRoot, [prior], { remote: env.remote }); }
    if (read.kind === 'red') {
      return outRefused({ code: 'QUEUE_SCREEN_RED', message: `the screen recorded for ${head.slice(0, 12)} (run ${prior.screen.run}) is RED on ${read.red.join(', ') || 'its gate binding'}; this head is not READY under any screen choice` },
        lines, `repair, push a new head, run /ship, then ${Q} ready --pr ${o.pr} --screen`, readyPath(env.repo.key, o.pr, head));
    }
  }
  const rec = sel.recommend ?? 'no-screen';
  if (!o.screen) {
    return outRefused({ code: 'READY_SCREEN_CHOICE_REQUIRED', message: `the base policy runs merge trains; choose --screen or --no-screen (recommended: --${rec})` }, lines,
      `${Q} ready --pr ${o.pr} --${rec}`, 'none');
  }
  let choice: ScreenChoice = { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null };
  if (o.screen === 'screen') {
    const merge = screenMerge(env, o, head, baseSha);
    if ('exit' in merge) return { ...merge, lines: [...lines, ...merge.lines] };
    lines.push(merge.line);
    const d = await dispatchScreen(env, o, slug, merge.mergeSha, baseSha);
    if ('exit' in d) return { ...d, lines: [...lines, ...d.lines] };
    choice = merge.branch ? { ...d.choice, branch: merge.branch } : d.choice;
    lines.push(...d.lines);
  }
  lines.splice(lines.findIndex(l => l.startsWith('READY ')) + 1, 0, screenLine(choice));
  const now = nowIso();
  const receipt: ReadyReceipt = { schema: 1, kind: 'ready', repo_key: env.repo.key, pr: o.pr, head, base_sha: baseSha, ready_at: prior?.ready_at ?? now, screen: choice, updated_at: now, ...(o.fixesBaseRed ? { fixes_base_red: o.fixesBaseRed } : {}) };
  if (o.fixesBaseRed) lines.push(`FIXES_BASE_RED: ${o.fixesBaseRed.join(', ')} (T0 may be red on exactly these gate cases while this PR rides at slot 1)`);
  if (o.dryRun) return outOk([...lines, 'DRY-RUN: no READY receipt written, nothing dispatched'], `${Q} ready --pr ${o.pr} --${o.screen}${o.broad ? ' --broad' : ''}`, 'none');
  const p = persist(ctx.repoRoot, [receipt], { remote: env.remote });
  lines.push(`READY_RECEIPT: ${readyPath(env.repo.key, o.pr, head)} (${p.detail})`);
  return outOk(lines, `send the READY block; the coordinator builds the train: ${Q} train build --prs ${o.pr}@${head},...`, readyPath(env.repo.key, o.pr, head));
}

/**
 * `verify --pr <n> --screen`: the screen verdict of the PR's pushed head from
 * its run, recorded in the READY receipt; never a lane's prose.
 */
export function verifyScreen(ctx: QueueContext, o: { pr: string }): TrainOut {
  const env = trainEnv(ctx);
  if ('code' in env) return outRefused(env, [], 'none', 'none');
  const view = ctx.gh(['pr', 'view', o.pr, '--json', 'headRefOid']);
  let head = '';
  try { head = view.ok ? String(JSON.parse(view.out).headRefOid ?? '') : ''; } catch {}
  if (!/^[0-9a-f]{40,64}$/.test(head)) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `cannot read PR #${o.pr}'s head through gh (${(view.err ?? view.out).trim().slice(0, 120) || 'no headRefOid'})` }, [], `${Q} verify --pr ${o.pr} --screen`, 'none');
  if (!loadReady(env.repo.keys, o.pr, head)) rebuildFromNotes(ctx.repoRoot, env.remote);
  const receipt = loadReady(env.repo.keys, o.pr, head);
  const run = receipt ? readyPath(receipt.repo_key, o.pr, head) : 'none';
  if (!receipt) return outRefused({ code: 'QUEUE_NOT_READY', message: `no READY receipt for #${o.pr} at ${head.slice(0, 12)} (local state or refs/notes/gstack-trains)` }, [], `the lane runs ${Q} ready --pr ${o.pr} --screen|--no-screen`, 'none');
  const lines = [`READY: #${o.pr} ${head} ready_at=${receipt.ready_at}`, screenLine(receipt.screen)];
  if (receipt.screen.choice !== 'screen' || !receipt.screen.run) return outOk([...lines, `SCREEN_VERDICT: #${o.pr} none (${receipt.screen.choice === 'screen' ? 'no run recorded' : 'READY --no-screen'})`], `${Q} train build --prs ${o.pr}@${head},...`, run);
  const slug = repoSlug(ctx);
  if (!slug) return outRefused({ code: 'QUEUE_PROOF_MISSING', message: 'gh repo view could not name the repository' }, lines, `${Q} verify --pr ${o.pr} --screen`, run);
  const read = screenVerdict(ctx, slug, receipt.screen.run);
  lines.push(...verdictLines(o.pr, receipt.screen.run, read));
  if (recordVerdict(receipt.screen, read)) { receipt.updated_at = nowIso(); lines.push(`READY_RECEIPT: ${run} (${persist(ctx.repoRoot, [receipt], { remote: env.remote }).detail}; verdict recorded)`); }
  const again = `${Q} verify --pr ${o.pr} --screen`;
  switch (read.kind) {
    case 'green': return outOk(lines, `${Q} train build --prs ${o.pr}@${head},...`, run);
    case 'pending': return outPending({ code: 'QUEUE_TRAIN_PENDING', message: `the screen run ${receipt.screen.run} has not finished (${read.detail})` }, lines, again, run);
    case 'red': return { ...outRefused({ code: 'QUEUE_SCREEN_RED', message: `the screen of #${o.pr} at ${head.slice(0, 12)} (run ${receipt.screen.run}) is RED on ${read.red.join(', ') || 'its gate binding'}` }, lines, `repair, push a new head, run /ship, then ${Q} ready --pr ${o.pr} --screen`, run), exit: EXIT.fail };
    case 'not-run': return outRefused({ code: 'QUEUE_SCREEN_NOT_RUN', message: `the screen of #${o.pr} (run ${receipt.screen.run}) concluded success with no slice: ${read.detail}; it is not a screen, and this head is not screened` }, lines, `${Q} ready --pr ${o.pr} --screen (dispatches a fresh screen)`, run);
    default: return outRefused({ code: 'QUEUE_PROOF_MISSING', message: `the screen of #${o.pr} (run ${receipt.screen.run}) has no verdict to read: ${read.detail}` }, lines, read.kind === 'incomplete' ? `${Q} ready --pr ${o.pr} --screen (dispatches a fresh screen)` : again, run);
  }
}
