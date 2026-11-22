/**
 * land.merged_ci (docs/ship-policy.md#land-direct): CI on the tree that would land. When the base moved past a pin's
 * merge base, the pin's own pull_request runs never tested the merged tree, and land.merged_checks runs only what land's
 * machine can afford. So land pushes the merged commit to a scratch branch, gstack-land/<pr>, dispatches the policy's
 * workflow there, waits for that run, and lands only when lib/run-evidence.ts verifyRun accepts it under the named run
 * profile from the base's .gstack/pregate.json, with the merged commit as its head and the merged tree as its tested
 * tree. The scratch branch is deleted whatever the outcome. The run executes on CI runners, so no repo command runs on
 * land's machine and it needs no --allow-repo-commands.
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
  run(id: number): ApiRun;
  verify(id: number): { ok: true; head: string; tree: string } | { ok: false; detail: string };
  sleep(ms: number): void;
  now(): number;
  url(id: number): string;
}
export type CiResult = { ok: true; line: string } | { ok: false; red: boolean; detail: string };

/** One dispatch of `ci.workflow` on the merged commit and its verdict; red when the run itself failed, else land could not run or prove it. */
export function runMergedCi(deps: CiDeps, o: { pr: string; commit: string; tree: string; ci: MergedCi; timeoutMs?: number }): CiResult {
  const branch = landBranch(o.pr);
  const pushed = deps.push(o.commit, branch);
  if (pushed) return { ok: false, red: false, detail: `cannot push the merged commit ${o.commit.slice(0, 12)} to ${branch}: ${pushed}` };
  try {
    const started = deps.now();
    const sent = deps.dispatch(o.ci.workflow, branch);
    if (sent) return { ok: false, red: false, detail: `gh workflow run ${o.ci.workflow} --ref ${branch} failed: ${sent}` };
    let run: ApiRun | undefined;
    for (;;) {
      run = run ? deps.run(run.id) : deps.runsAt(o.ci.workflow, o.commit)[0];
      if (run?.status === 'completed') break;
      if (deps.now() - started >= (o.timeoutMs ?? CI_TIMEOUT_MS)) return { ok: false, red: false, detail: run ? `${o.ci.workflow} run ${deps.url(run.id)} is still ${run.status} after ${Math.round((deps.now() - started) / 60_000)} minutes` : `no ${o.ci.workflow} run appeared on ${branch} at ${o.commit.slice(0, 12)}` };
      deps.sleep(pollDelayMs(MIN_POLL_MS));
    }
    const at = `${o.ci.workflow} run ${deps.url(run.id)} on the merged tree ${o.tree.slice(0, 12)}`;
    if (run.conclusion !== 'success') return { ok: false, red: true, detail: `${at} concluded ${run.conclusion ?? 'unknown'}` };
    const v = deps.verify(run.id);
    if (!v.ok) return { ok: false, red: false, detail: `${at} passed, but it does not prove the tree under ${o.ci.profile}: ${v.detail}` };
    if (v.head !== o.commit || v.tree !== o.tree) return { ok: false, red: false, detail: `${at} tested ${v.head.slice(0, 12)} (tree ${v.tree.slice(0, 12)}), not the merged commit ${o.commit.slice(0, 12)}` };
    return { ok: true, line: `MERGED_CI: pass ${at} (profile ${o.ci.profile})` };
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
  if (r.red) return { failure: { code: 'QUEUE_LAND_MERGED_CHECKS', message: `${o.moved}; on the pin merged onto it, ${r.detail}`, fix: `read the failed job in that run; a flaky case gets one rerun of land; a real failure goes back to the lane, which merges the base into the branch, fixes it, runs /ship and gstack-ship-queue ready --pr ${o.pr} at the new head` } };
  return { failure: { code: 'QUEUE_NOT_READY', message: `${o.moved}, and land.merged_ci could not run or prove CI on the pin merged onto it: ${r.detail}; nothing merged`, fix: `fix what the message names, then rerun gstack-ship-queue land --pr ${o.pr} --pin ${o.pin}` } };
}
