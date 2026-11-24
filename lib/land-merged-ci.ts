/**
 * land.merged_ci (docs/ship-policy.md#land-direct): CI on the tree that would land. When the base moved past a pin's
 * merge base, the pin's own pull_request runs never tested the merged tree, and land.merged_checks runs only what land's
 * machine can afford. So land pushes the merged commit to a scratch branch, gstack-land/<pr>, dispatches the policy's
 * workflow there, waits for that run, and lands only when lib/run-evidence.ts verifyRun accepts it under the named run
 * profile from the base's .gstack/pregate.json, with the run's head as its head and the merged tree as its tested tree.
 * Each land builds a new merged commit, so before dispatching land looks for a run an earlier land started (any
 * workflow_dispatch run on gstack-land/<pr>, or one at this merged commit) whose head commit has the merged tree: the
 * newest one that was not cancelled decides. A finished green run that verifyRun accepts lands with no dispatch, a run
 * still going is waited on, and a red one refuses; only a finished green run that no longer proves the tree (an expired
 * artifact, past the profile's max age) falls through to a fresh dispatch. GitHub keeps a run and its record of the
 * branch after the branch is deleted, and serves its head commit by sha, so the scratch branch is deleted whatever the
 * outcome. The run executes on CI runners, so no repo command runs on land's machine and it needs no
 * --allow-repo-commands.
 */
import { git, type QueueFailure } from '../crew/lib/ship-queue-gate';
import { repoSlug } from '../crew/lib/ship-queue-train-github';
import { MIN_POLL_MS, pollDelayMs, syncLimitEnv } from './gh-poll';
import { ghRunDeps, landBranch, runProfileErrors, verifyRun, type ApiRun, type RunProfile } from './run-evidence';
import type { QueueContext } from './ship-queue';

export const CI_TIMEOUT_MS = 45 * 60_000;

export interface MergedCi { workflow: string; profile: string }
export interface CiDeps {
  /** Push the commit to the branch, replacing a leftover one; an error message, or null. */
  push(commit: string, branch: string): string | null;
  remove(branch: string): void;
  dispatch(workflow: string, branch: string): string | null;
  /** The workflow's workflow_dispatch runs at the commit, newest first. */
  runsAt(workflow: string, commit: string): ApiRun[];
  /** The workflow's workflow_dispatch runs on the branch, newest first, including runs on a branch since deleted. */
  runsOn(workflow: string, branch: string): ApiRun[];
  run(id: number): ApiRun;
  verify(id: number): { ok: true; head: string; tree: string } | { ok: false; detail: string };
  sleep(ms: number): void;
  now(): number;
  url(id: number): string;
}
/** `run`: the run the refusal is about: a red run, or one still going that the next land on the same merged tree waits on. `unproved`: the run finished green but does not prove the merged tree. */
export type CiResult = { ok: true; line: string } | { ok: false; red: boolean; detail: string; run?: number; unproved?: true };
type CiInput = { pr: string; commit: string; tree: string; ci: MergedCi; timeoutMs?: number };

/** The newest workflow_dispatch run of `ci.workflow` on the scratch branch or at the merged commit whose head commit has the merged tree, unless it was cancelled. */
function earlierRun(deps: CiDeps, o: CiInput, branch: string): ApiRun | undefined {
  const runs = [...deps.runsAt(o.ci.workflow, o.commit), ...deps.runsOn(o.ci.workflow, branch).filter(r => r.head_branch === branch)];
  return runs.filter(r => r.event === 'workflow_dispatch' && r.head_commit?.tree_id === o.tree).sort((a, b) => b.id - a.id).find(r => r.conclusion !== 'cancelled');
}

/** Wait from `started` for `first` (or the run that appears at the merged commit) to finish, then its verdict. */
function settle(deps: CiDeps, o: CiInput, branch: string, first: ApiRun | undefined, started: number): CiResult {
  let run = first;
  for (;;) {
    run = run ? deps.run(run.id) : deps.runsAt(o.ci.workflow, o.commit)[0];
    if (run?.status === 'completed') break;
    if (deps.now() - started >= (o.timeoutMs ?? CI_TIMEOUT_MS)) {
      if (!run) return { ok: false, red: false, detail: `no ${o.ci.workflow} run appeared on ${branch} at ${o.commit.slice(0, 12)}` };
      return { ok: false, red: false, run: run.id, detail: `${o.ci.workflow} run ${deps.url(run.id)} is still ${run.status} after ${Math.round((deps.now() - started) / 60_000)} minutes; it tests the merged tree ${o.tree.slice(0, 12)}, so the next land onto the same base waits on this run instead of dispatching another` };
    }
    deps.sleep(pollDelayMs(MIN_POLL_MS));
  }
  const at = `${o.ci.workflow} run ${deps.url(run.id)} on the merged tree ${o.tree.slice(0, 12)}`;
  if (run.conclusion !== 'success') return { ok: false, red: true, run: run.id, detail: `${at} concluded ${run.conclusion ?? 'unknown'}` };
  const v = deps.verify(run.id);
  if (!v.ok) return { ok: false, red: false, unproved: true, detail: `${at} passed, but it does not prove the tree under ${o.ci.profile}: ${v.detail}` };
  if (v.head !== run.head_sha || v.tree !== o.tree) return { ok: false, red: false, unproved: true, detail: `${at} tested ${v.head.slice(0, 12)} (tree ${v.tree.slice(0, 12)}), not the merged commit ${o.commit.slice(0, 12)} or a commit with its tree` };
  const earlier = run.head_sha === o.commit ? '' : `; run by an earlier land at ${run.head_sha.slice(0, 12)}, not dispatched again`;
  return { ok: true, line: `MERGED_CI: pass ${at} (profile ${o.ci.profile}${earlier})` };
}

/** The verdict of `ci.workflow` on the merged tree: an earlier land's run on that tree when there is one, else one new dispatch on the merged commit; red when the run itself failed, else land could not run or prove it. */
export function runMergedCi(deps: CiDeps, o: CiInput): CiResult {
  const branch = landBranch(o.pr);
  const earlier = earlierRun(deps, o, branch);
  if (earlier) {
    const r = settle(deps, o, branch, earlier, deps.now());
    if (r.ok || !r.unproved || earlier.status !== 'completed') { deps.remove(branch); return r; }
  }
  const pushed = deps.push(o.commit, branch);
  if (pushed) return { ok: false, red: false, detail: `cannot push the merged commit ${o.commit.slice(0, 12)} to ${branch}: ${pushed}` };
  try {
    const started = deps.now();
    const sent = deps.dispatch(o.ci.workflow, branch);
    if (sent) return { ok: false, red: false, detail: `gh workflow run ${o.ci.workflow} --ref ${branch} failed: ${sent}` };
    return settle(deps, o, branch, undefined, started);
  } finally {
    deps.remove(branch);
  }
}

/** land's real dependencies: git on the checkout, gh through the queue context, and the run profile read from the base tip. */
export function ghCiDeps(ctx: QueueContext, remote: string, tip: string, ci: MergedCi): CiDeps | { error: string } {
  const root = ctx.repoRoot;
  const slug = repoSlug(ctx);
  if (!slug) return { error: 'cannot read the repository name through gh' };
  let profile: RunProfile | undefined;
  try { profile = JSON.parse(git(root, ['show', `${tip}:.gstack/pregate.json`]).out).run_profiles?.[ci.profile]; } catch {}
  if (!profile || runProfileErrors({ [ci.profile]: profile }, undefined).length) return { error: `.gstack/pregate.json at ${tip.slice(0, 12)} has no valid run profile ${ci.profile}` };
  const evidence = ghRunDeps(slug, root);
  const api = <T>(p: string): T => { const r = ctx.gh(['api', p]); if (!r.ok) throw new Error((r.err ?? r.out).trim().slice(0, 160)); return JSON.parse(r.out) as T; };
  return {
    push: (commit, branch) => { const r = git(root, ['push', '-q', remote, `+${commit}:refs/heads/${branch}`]); return r.ok ? null : r.err.split('\n')[0] || 'git push failed'; },
    remove: branch => { git(root, ['push', '-q', remote, `:refs/heads/${branch}`]); },
    dispatch: (workflow, branch) => { const r = ctx.gh(['workflow', 'run', workflow, '--ref', branch]); return r.ok ? null : (r.err ?? r.out).trim().slice(0, 160) || 'no output'; },
    runsAt: (workflow, commit) => { try { return api<{ workflow_runs?: ApiRun[] }>(`repos/${slug}/actions/workflows/${workflow}/runs?head_sha=${commit}&event=workflow_dispatch&per_page=20`).workflow_runs ?? []; } catch { return []; } },
    runsOn: (workflow, branch) => { try { return api<{ workflow_runs?: ApiRun[] }>(`repos/${slug}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=20`).workflow_runs ?? []; } catch { return []; } },
    run: id => { try { return api<ApiRun>(`repos/${slug}/actions/runs/${id}`); } catch { return { id, run_attempt: 1, status: 'unknown', conclusion: null, event: 'workflow_dispatch', head_sha: '' }; } },
    verify: id => {
      const v = verifyRun(evidence, { repo: slug, runRef: String(id), profileName: ci.profile, profile: profile!, now: new Date() });
      return v.ok ? { ok: true, head: v.evidence.head_sha, tree: v.evidence.tree } : { ok: false, detail: `${v.reason}: ${v.detail}` };
    },
    sleep: syncLimitEnv.sleep,
    now: () => Date.now(),
    url: id => `https://github.com/${slug}/actions/runs/${id}`,
  };
}

/** The land step: the dispatch, its verdict and the failure land refuses with. */
export function landMergedCi(ctx: QueueContext, o: { remote: string; tip: string; pr: string; pin: string; commit: string; tree: string; ci: MergedCi; moved: string }): { line: string } | { failure: QueueFailure } {
  const deps = ghCiDeps(ctx, o.remote, o.tip, o.ci);
  if ('error' in deps) return { failure: { code: 'QUEUE_NOT_READY', message: `${o.moved}, and land cannot run land.merged_ci: ${deps.error}; nothing merged`, fix: 'fix what the message names, then rerun land' } };
  const r = runMergedCi(deps, o);
  if (r.ok) return { line: r.line };
  const rerun = `gstack-ship-queue land --pr ${o.pr} --pin ${o.pin}`;
  if (r.red) return { failure: { code: 'QUEUE_LAND_MERGED_CHECKS', message: `${o.moved}; on the pin merged onto it, ${r.detail}`, fix: `read the failed job in that run; for a flaky case rerun the run once (gh run rerun ${r.run}), then rerun ${rerun}, which waits on its new attempt (a rerun of land alone finds the same red run and refuses again); a real failure goes back to the lane, which merges the base into the branch, fixes it, runs /ship and gstack-ship-queue ready --pr ${o.pr} at the new head` } };
  if (r.run !== undefined) return { failure: { code: 'QUEUE_NOT_READY', message: `${o.moved}, and land.merged_ci timed out waiting for CI on the pin merged onto it: ${r.detail}; nothing merged`, fix: `rerun ${rerun} at any time: while origin/main stays at ${o.tip.slice(0, 12)} it waits up to 45 more minutes on run ${deps.url(r.run)} (or lands at once when it already passed) instead of dispatching a new one` } };
  return { failure: { code: 'QUEUE_NOT_READY', message: `${o.moved}, and land.merged_ci could not run or prove CI on the pin merged onto it: ${r.detail}; nothing merged`, fix: `fix what the message names, then rerun ${rerun}` } };
}
