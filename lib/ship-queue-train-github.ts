/**
 * GitHub reads and writes for merge trains, all through the queue's `gh`
 * seam (QueueContext.gh) so tests answer them from a fixture: PR identity,
 * workflow runs found by branch or by eval-bg nonce, run artifacts and the
 * full-gate check run. Dispatch itself goes through scripts/eval-bg.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Exec, RunSummary } from '../scripts/eval-bg';
import type { QueueContext } from './ship-queue';

export interface PrInfo { headRefOid: string; isCrossRepository: boolean; state: string; headRefName: string; body: string; baseRefName?: string }
export interface RunInfo { databaseId: number; status: string; conclusion: string | null; url: string; headSha: string; event: string; displayTitle: string }
export interface CheckInfo { status: string; conclusion: string | null }

function json<T>(r: { ok: boolean; out: string }): T | null {
  if (!r.ok) return null;
  try { return JSON.parse(r.out) as T; } catch { return null; }
}

/** eval-bg's process seam bound to the queue's gh (only `gh` is ever routed through it). */
export function execFor(ctx: QueueContext): Exec {
  return (command, args) => {
    if (command !== 'gh') return { status: null, stdout: '' };
    const r = ctx.gh(args);
    return { status: r.ok ? 0 : 1, stdout: r.out };
  };
}

export function repoSlug(ctx: QueueContext): string | null {
  const r = json<{ nameWithOwner?: string }>(ctx.gh(['repo', 'view', '--json', 'nameWithOwner']));
  return r?.nameWithOwner && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.nameWithOwner) ? r.nameWithOwner : null;
}

export function prInfo(ctx: QueueContext, pr: string): PrInfo | { error: string } {
  const r = ctx.gh(['pr', 'view', pr, '--json', 'headRefOid,isCrossRepository,state,headRefName,body,baseRefName']);
  const p = json<Partial<PrInfo>>(r);
  if (!p?.headRefOid) return { error: `cannot read PR #${pr} through gh (${(r.err ?? r.out).trim().slice(0, 120) || 'no headRefOid'})` };
  return { headRefOid: p.headRefOid, isCrossRepository: p.isCrossRepository !== false, state: p.state ?? 'OPEN', headRefName: p.headRefName ?? '', body: p.body ?? '', ...(p.baseRefName ? { baseRefName: p.baseRefName } : {}) };
}

const RUN_FIELDS = 'databaseId,status,conclusion,url,headSha,event,displayTitle';

/** Newest workflow_dispatch run of a workflow on one branch; null when none; 'unreadable' when gh failed. */
export function newestBranchRun(ctx: QueueContext, slug: string, workflow: string, branch: string): RunInfo | null | 'unreadable' {
  const runs = json<RunInfo[]>(ctx.gh(['run', 'list', '--repo', slug, '--workflow', workflow, '--branch', branch, '--event', 'workflow_dispatch', '--limit', '20', '--json', RUN_FIELDS]));
  if (!Array.isArray(runs)) return 'unreadable';
  return runs.filter(r => r.event === 'workflow_dispatch').sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
}

export function runView(ctx: QueueContext, slug: string, id: number): RunInfo | null {
  return json<RunInfo>(ctx.gh(['run', 'view', String(id), '--repo', slug, '--json', RUN_FIELDS]));
}

export function asRun(summary: RunSummary): { id: number; url: string } {
  return { id: summary.databaseId, url: summary.url };
}

/**
 * One JSON artifact of a run: the named file wherever the artifact keeps it
 * (a multi-path upload keeps its directories, so report-verdict-a1 holds
 * paid-report/collector-outcomes.json), else the first .json file at its
 * root; null when it is missing or unreadable.
 */
export function downloadJson(ctx: QueueContext, slug: string, run: number, name: string, scratch: string, file?: string): unknown {
  const dir = path.join(scratch, `${run}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!ctx.gh(['run', 'download', String(run), '--repo', slug, '-n', name, '-D', dir]).ok) return null;
    const pick = file
      ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => path.basename(f) === file).sort((a, b) => a.length - b.length)[0]
      : fs.readdirSync(dir).find(f => f.endsWith('.json'));
    return pick && fs.existsSync(path.join(dir, pick)) ? JSON.parse(fs.readFileSync(path.join(dir, pick), 'utf8')) : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * A finished screen run that planned no cases is not a screen: when the merge
 * ref it was dispatched for was superseded, evals.yml skips plan-slices and
 * concludes success (GSTA-95 on #3431). A screen run uploads no train record,
 * so the evidence is the plan itself: no `paid-plan` artifact, or a manifest
 * with nothing planned. `hollow` carries the reason; `live` is a screen that
 * planned cases or is still running; `unknown` names what could not be read
 * (the caller decides, and says, how it counts).
 */
export type ScreenPlan = { kind: 'hollow'; reason: string } | { kind: 'live' } | { kind: 'unknown'; reason: string };
export function hollowScreen(ctx: QueueContext, slug: string, run: number): ScreenPlan {
  if (!Number.isSafeInteger(run) || run <= 0) return { kind: 'unknown', reason: `screen run id ${String(run).slice(0, 40)} is not a run number` };
  const view = runView(ctx, slug, run);
  if (!view) return { kind: 'unknown', reason: `run ${run} is unreadable` };
  if (view.status !== 'completed') return { kind: 'live' };
  const list = json<{ artifacts?: Array<{ name?: string; expired?: boolean }> }>(ctx.gh(['api', `repos/${slug}/actions/runs/${run}/artifacts?name=${PLAN_ARTIFACT}&per_page=10`]));
  if (!Array.isArray(list?.artifacts)) return { kind: 'unknown', reason: `run ${run}'s artifact list is unreadable` };
  const plan = list.artifacts.find(a => a.name === PLAN_ARTIFACT);
  if (!plan) return { kind: 'hollow', reason: `run ${run} planned no cases (no ${PLAN_ARTIFACT} artifact; concluded ${view.conclusion ?? 'unknown'})` };
  if (plan.expired) return { kind: 'unknown', reason: `run ${run}'s ${PLAN_ARTIFACT} artifact has expired` };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-screen-'));
  let manifest: { entries?: Array<{ status?: unknown }> } | null;
  try { manifest = downloadJson(ctx, slug, run, PLAN_ARTIFACT, scratch, 'manifest.json') as typeof manifest; } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  if (!Array.isArray(manifest?.entries)) return { kind: 'unknown', reason: `run ${run}'s ${PLAN_ARTIFACT} manifest.json is unreadable` };
  const planned = manifest.entries.filter(e => e?.status === 'planned').length;
  return planned === 0 ? { kind: 'hollow', reason: `run ${run} planned no cases (an empty plan manifest; concluded ${view.conclusion ?? 'unknown'})` } : { kind: 'live' };
}

/** The plan manifest every evals.yml run that planned anything uploads (plan-slices); a superseded screen never reaches that job. */
const PLAN_ARTIFACT = 'paid-plan';

/** The named check run on a commit (the newest when several); null when absent or unreadable. */
export function checkRun(ctx: QueueContext, sha: string, name: string): CheckInfo | null {
  const r = json<{ check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }> }>(
    ctx.gh(['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`]));
  const hit = r?.check_runs?.find(c => c.name === name);
  return hit ? { status: hit.status ?? 'unknown', conclusion: hit.conclusion ?? null } : null;
}

/** Whether a branch exists on the remote (ls-remote, never a fetch). */
export function remoteBranchSha(git: (args: string[]) => { ok: boolean; out: string }, remote: string, branch: string): string | null {
  const r = git(['ls-remote', remote, `refs/heads/${branch}`]);
  return r.ok ? (r.out.split(/\s/)[0] || null) : null;
}
