/**
 * `ready --dispatch-ci <workflow.yml[,…]> [--timeout <s>]`: a PR that
 * conflicts with the base (a CHANGELOG-only conflict after every stamp
 * counts) has no merge ref, so GitHub runs no pull_request CI on its head and
 * `ready` prints `ci: none`. The lane used to dispatch the free workflows by
 * hand, wait, clear the requires-remote pregate lanes with the run URLs and
 * rerun ready. This does those four steps before `ready` reads the head: one
 * `gh workflow run <wf> --ref <branch>` per named workflow (skipped when a
 * run at this head already concluded), a wait for each run, and one
 * `PREGATE_CLEARED:` per requires-remote lane whose workflow is one of them
 * and whose run concluded success. A red run clears no lane and refuses. A
 * fork head is never dispatched here (QUEUE_TRAIN_UNTRUSTED).
 *
 * Each lane clears through `clearDecision`, exactly as `gstack-pregate clear
 * --remote <lane> --run-url <url>` would: a lane the base branch profiles
 * (`.gstack/pregate.json` run_profiles, docs/pregate.md#run-evidence) is
 * verified by lib/run-evidence.ts, so a run on another tree, an older green
 * attempt under a newer red one or a run with a newer red sibling clears
 * nothing and refuses; a lane with no profile records the URL as before.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PregateFile } from './headless-artifacts';
import { PREGATE_OUT_REL, clearDecision, clearObligation, readPregateFile, writePregateFile, type RunCheck } from './pregate/index';
import { buildRunCheck } from './pregate/run-check';
import type { QueueContext } from './ship-queue';
import type { QueueFailure } from './ship-queue-gate';
import { prInfo, repoSlug, runView } from './ship-queue-train-github';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface DispatchCiOptions {
  pr: string; workflows: string[]; pregate?: string; timeoutSec: number; pollMs: number;
  /** The run-evidence inputs for one lane; the base branch's (lib/pregate/run-check.ts) unless a test injects them. */
  runCheck?: (lane: string) => RunCheck | { error: string; profiled?: boolean };
}
export type DispatchCiResult = { lines: string[] } | { lines: string[]; failure: QueueFailure };

interface RunRow { databaseId: number; url: string; status: string; conclusion: string | null; headSha: string }

function runsAt(ctx: QueueContext, workflow: string, branch: string, head: string): RunRow[] {
  const r = ctx.gh(['run', 'list', '--workflow', workflow, '--branch', branch, '--event', 'workflow_dispatch', '--limit', '20', '--json', 'databaseId,url,status,conclusion,headSha']);
  try { return r.ok ? (JSON.parse(r.out) as RunRow[]).filter(x => x.headSha === head) : []; } catch { return []; }
}

export async function dispatchCi(ctx: QueueContext, o: DispatchCiOptions): Promise<DispatchCiResult> {
  const info = prInfo(ctx, o.pr);
  if ('error' in info) return { lines: [], failure: { code: 'QUEUE_NOT_READY', message: info.error } };
  if (!info.headRefName) return { lines: [], failure: { code: 'QUEUE_NOT_READY', message: `cannot read PR #${o.pr}'s branch through gh (no headRefName)` } };
  if (info.isCrossRepository) return { lines: [], failure: { code: 'QUEUE_TRAIN_UNTRUSTED', message: `#${o.pr}'s head is on a fork; its workflows are not dispatched here (the coordinator decides)` } };
  const head = info.headRefOid;
  const branch = info.headRefName;
  const slug = repoSlug(ctx);
  const deadline = Date.now() + o.timeoutSec * 1000;
  const lines: string[] = [];
  const concluded = new Map<string, RunRow>();
  for (const wf of o.workflows) {
    const atHead = runsAt(ctx, wf, branch, head);
    const prior = atHead.find(r => r.status === 'completed');
    if (prior) { lines.push(`CI_DISPATCH: ${wf} not dispatched (run ${prior.databaseId} already concluded ${prior.conclusion ?? 'unknown'} at this head)`); concluded.set(wf, prior); continue; }
    const live = atHead[0];
    if (!live) {
      const d = ctx.gh(['workflow', 'run', wf, '--ref', branch]);
      if (!d.ok) return { lines, failure: { code: 'QUEUE_NOT_READY', message: `gh workflow run ${wf} --ref ${branch} failed (${(d.err ?? d.out).trim().replace(/\s+/g, ' ').slice(0, 120) || 'no output'})` } };
    }
    let run: RunRow | undefined = live;
    for (;;) {
      run = run && slug ? runView(ctx, slug, run.databaseId) ?? run : runsAt(ctx, wf, branch, head)[0];
      if (run?.status === 'completed') break;
      if (Date.now() >= deadline) return { lines: [...lines, `CI_DISPATCH: ${wf} --ref ${branch} ${run ? `run ${run.databaseId} ${run.url} ${run.status}` : 'no run appeared'}`], failure: { code: 'QUEUE_TRAIN_PENDING', message: `${wf} ${run ? `run ${run.databaseId} is still ${run.status}` : 'has no workflow_dispatch run at this head yet'} at the --dispatch-ci timeout; rerun ready --dispatch-ci to continue waiting` } };
      await sleep(o.pollMs);
    }
    lines.push(`CI_DISPATCH: ${wf} --ref ${branch} run ${run.databaseId} ${run.url} ${run.conclusion ?? 'unknown'}`);
    concluded.set(wf, run);
  }
  const red = [...concluded.entries()].filter(([, r]) => r.conclusion !== 'success');
  if (red.length) return { lines, failure: { code: 'QUEUE_NOT_READY', message: red.map(([wf, r]) => `${wf} run ${r.databaseId} concluded ${r.conclusion ?? 'unknown'} at ${head.slice(0, 12)}`).join('; ') + '; a red run clears no lane' } };
  const pregateFile = path.resolve(ctx.repoRoot, o.pregate ?? PREGATE_OUT_REL);
  if (!fs.existsSync(pregateFile)) return { lines };
  const read = readPregateFile(pregateFile);
  if (!read.file) return { lines };
  let file: PregateFile = read.file;
  let changed = false;
  const refused: string[] = [];
  const runCheck = o.runCheck ?? ((lane: string) => buildRunCheck(ctx.repoRoot, lane, false, ctx.base));
  for (const lane of (file.requires_remote ?? []).filter(l => !l.receipt && concluded.has(l.workflow))) {
    const run = concluded.get(lane.workflow)!;
    const checked = runCheck(lane.lane);
    if ('error' in checked && checked.profiled) { refused.push(`${lane.lane}: ${checked.error}; it may have a run profile, so it clears only with a verified run and stays uncleared`); continue; }
    const decision = clearDecision(file, lane.lane, { runUrl: run.url, evidence: 'error' in checked ? undefined : checked }, ctx.repoRoot);
    if ('refused' in decision) { refused.push(`${lane.lane}: ${decision.message}`); continue; }
    file = clearObligation(file, lane.lane, decision.receipt, `gstack-ship-queue ready --dispatch-ci ${new Date().toISOString()}`, decision.substitution);
    lines.push(`PREGATE_CLEARED: ${lane.lane} ${decision.receipt}`);
    if ('error' in checked) lines.push(`PREGATE_UNVERIFIED: ${lane.lane} recorded by URL (${checked.error})`);
    changed = true;
  }
  if (changed) writePregateFile(ctx.repoRoot, pregateFile, file);
  if (refused.length) return { lines, failure: { code: 'QUEUE_NOT_READY', message: refused.join('; ') } };
  return { lines };
}
