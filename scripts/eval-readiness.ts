/**
 * Readiness-gated dispatch for the PR paid lane (R1, GSTA-48).
 *
 * The `readiness` job in evals.yml runs this before any paid work: a PR
 * head's paid slices start only after (1) the PR has been quiet for the
 * window (no newer push since this run was created; `vars.EVALS_QUIET_MINUTES`,
 * default 10; the `evals-no-debounce` label sets it to 0) and (2) Free Tests
 * (free-tests.yml) has concluded success on the same head SHA. Selection,
 * trials and verdict rules are unchanged: only the start time moves.
 *
 * A newer push cancels the run through the workflow's cancel-in-progress
 * group, so the quiet window is a plain sleep with no API calls. After it,
 * Free Tests is polled every `--poll-seconds`. Free Tests concluding anything
 * but success on this head fails the run without paid work: that head cannot
 * merge, and re-running this workflow after a green Free Tests rerun starts
 * the gate (a re-run keeps the run's original creation time, so it does not
 * wait out the window again). A head that is no longer the PR's head reports
 * superseded and plans nothing.
 *
 * Dispatched screens (plan GSTA-49 T1b): `--merge-sha` names the
 * refs/pull/<n>/merge commit `gstack-ship-queue ready --screen` pinned. The
 * screen is accepted only for an open same-repository PR whose current head
 * is that merge commit's second parent; its first parent is the tested base.
 * The same Free Tests rule then applies to the PR head, with no quiet window
 * (a screen is an explicit request).
 */
import * as fs from 'node:fs';
import { runGh, type GhRunner } from './recover-receipts';

export interface FreeTestsRun { id: number; status: string; conclusion: string | null; head_sha: string; event: string }
export type FreeTestsState =
  | { state: 'missing' }
  | { state: 'running'; runId: number }
  | { state: 'success'; runId: number }
  | { state: 'failed'; runId: number; conclusion: string };

export type ReadinessDecision =
  | { kind: 'wait'; reason: string }
  | { kind: 'ready'; reason: string }
  | { kind: 'superseded'; by: string }
  | { kind: 'blocked'; reason: string };

/** The newest Free Tests pull_request run on this exact head decides; a rerun updates that run in place. */
export function freeTestsState(runs: FreeTestsRun[], headSha: string): FreeTestsState {
  const newest = runs.filter(run => run.head_sha === headSha && (run.event === 'pull_request' || run.event === 'workflow_dispatch')).sort((a, b) => b.id - a.id)[0];
  if (!newest) return { state: 'missing' };
  if (newest.status !== 'completed') return { state: 'running', runId: newest.id };
  if (newest.conclusion === 'success') return { state: 'success', runId: newest.id };
  return { state: 'failed', runId: newest.id, conclusion: newest.conclusion ?? 'unknown' };
}

export function readinessDecision(input: { headSha: string; prHead: string | null; free: FreeTestsState; quietLeftMs: number }): ReadinessDecision {
  if (input.prHead && input.prHead !== input.headSha) return { kind: 'superseded', by: input.prHead };
  const free = input.free;
  if (free.state === 'failed') {
    return { kind: 'blocked', reason: `Free Tests run ${free.runId} concluded ${free.conclusion} on ${input.headSha.slice(0, 12)}; the paid gate does not start for a head that cannot merge. Fix and push, or re-run Free Tests and then re-run this workflow` };
  }
  if (input.quietLeftMs > 0) return { kind: 'wait', reason: `quiet window: ${Math.ceil(input.quietLeftMs / 1000)} s left` };
  if (free.state === 'missing') return { kind: 'wait', reason: 'Free Tests has not started on this head yet' };
  if (free.state === 'running') return { kind: 'wait', reason: `Free Tests run ${free.runId} is still running` };
  return { kind: 'ready', reason: `Free Tests run ${free.runId} passed on ${input.headSha.slice(0, 12)} and the PR has been quiet for the window` };
}

export interface WaitOptions {
  repo: string;
  pr: number;
  headSha: string;
  runId: number;
  quietMs: number;
  deadlineMs: number;
  pollMs: number;
  gh?: GhRunner;
  now?: () => number;
  sleep?: (ms: number) => void;
}

function ghJson<T>(gh: GhRunner, args: string[]): { ok: true; value: T } | { ok: false; error: string } {
  const out = gh(args, 30_000);
  if (out.status !== 0) return { ok: false, error: out.stderr.trim().split('\n')[0]?.slice(0, 200) || `gh exited ${out.status}` };
  try { return { ok: true, value: JSON.parse(out.stdout) as T }; } catch { return { ok: false, error: 'gh returned unreadable JSON' }; }
}

export interface ScreenTarget { head: string; base: string; branch: string }

/** A screen's merge commit, checked against the PR: same repository, open, and merging the PR's current head into its base. */
export function screenTarget(gh: GhRunner, repo: string, pr: number, mergeSha: string): ScreenTarget | { error: string } {
  if (!/^[0-9a-f]{40}$/.test(mergeSha)) return { error: `screen_merge_sha ${JSON.stringify(mergeSha)} is not a full commit SHA` };
  const pull = ghJson<{ state?: string; head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null }; base?: { repo?: { full_name?: string } } }>(gh, ['api', `repos/${repo}/pulls/${pr}`]);
  if (!pull.ok) return { error: `cannot read PR #${pr} (${pull.error})` };
  const p = pull.value;
  if (p.base?.repo?.full_name !== repo || p.head?.repo?.full_name !== repo) return { error: `PR #${pr} is not a same-repository PR of ${repo}; fork work is screened on a trusted branch` };
  if (p.state !== 'open') return { error: `PR #${pr} is ${p.state ?? 'unreadable'}, not open` };
  const commit = ghJson<{ parents?: Array<{ sha?: string }> }>(gh, ['api', `repos/${repo}/commits/${mergeSha}`]);
  if (!commit.ok) return { error: `cannot read the merge commit ${mergeSha.slice(0, 12)} (${commit.error})` };
  const parents = (commit.value.parents ?? []).map(parent => parent.sha ?? '');
  if (parents.length !== 2 || !parents.every(sha => /^[0-9a-f]{40}$/.test(sha))) return { error: `${mergeSha.slice(0, 12)} is not a two-parent merge commit` };
  return { head: parents[1]!, base: parents[0]!, branch: p.head?.ref ?? '' };
}

/** Waits until the head is ready, superseded or blocked; never longer than the deadline. */
export function waitForReadiness(o: WaitOptions): { decision: ReadinessDecision; lines: string[] } {
  const gh = o.gh ?? runGh;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const start = now();
  const lines: string[] = [];
  const run = ghJson<{ created_at?: string }>(gh, ['api', `repos/${o.repo}/actions/runs/${o.runId}`]);
  const created = run.ok ? Date.parse(run.value.created_at ?? '') : NaN;
  const quietUntil = (Number.isFinite(created) ? created : start) + o.quietMs;
  lines.push(`Readiness (R1): paid slices start after Free Tests passes on ${o.headSha.slice(0, 12)} and the PR is quiet for ${Math.round(o.quietMs / 60_000)} min (from ${new Date(quietUntil - o.quietMs).toISOString()})`);
  if (quietUntil > now()) sleep(quietUntil - now());
  let lastError = '';
  for (;;) {
    const listed = ghJson<{ workflow_runs?: FreeTestsRun[] }>(gh, ['api', '-X', 'GET', `repos/${o.repo}/actions/workflows/free-tests.yml/runs`,
      '-f', `head_sha=${o.headSha}`, '-f', 'per_page=100']);
    const pr = ghJson<{ head?: { sha?: string } }>(gh, ['api', `repos/${o.repo}/pulls/${o.pr}`]);
    lastError = !listed.ok ? listed.error : !pr.ok ? pr.error : '';
    if (!lastError && listed.ok && pr.ok) {
      const decision = readinessDecision({ headSha: o.headSha, prHead: pr.value.head?.sha ?? null,
        free: freeTestsState(listed.value.workflow_runs ?? [], o.headSha), quietLeftMs: quietUntil - now() });
      if (decision.kind !== 'wait') {
        lines.push(decision.kind === 'superseded' ? `superseded by ${decision.by}; this run plans no slices` : decision.reason);
        lines.push(`Readiness wait: ${Math.round((now() - start) / 1000)} s`);
        return { decision, lines };
      }
      lastError = decision.reason;
    }
    if (now() + o.pollMs > start + o.deadlineMs) {
      const reason = `not ready after ${Math.round(o.deadlineMs / 60_000)} min (${lastError}); re-run this workflow once Free Tests has passed on this head`;
      lines.push(reason);
      return { decision: { kind: 'blocked', reason }, lines };
    }
    sleep(o.pollMs);
  }
}

const USAGE = `usage: bun run scripts/eval-readiness.ts wait --repo <owner/name> --pr <n> (--head-sha <sha> | --merge-sha <sha>) --run-id <id>
    [--quiet-minutes 10] [--deadline-minutes 80] [--poll-seconds 60] [--github-output <file>] [--summary <file>]
--merge-sha (a dispatched screen) waits on the PR head that merge commit merges and writes head_sha, base_sha and
head_branch outputs. Exit 0 when ready or superseded (output superseded=true), 1 when blocked, 2 on usage.`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const num = (name: string, fallback: number) => { const value = flag(name); return value === undefined || value === '' ? fallback : Number(value); };
  const [repo, mergeSha] = [flag('repo'), flag('merge-sha')];
  const [pr, runId, quiet, deadline, poll] = [Number(flag('pr')), Number(flag('run-id')), num('quiet-minutes', 10), num('deadline-minutes', 80), num('poll-seconds', 60)];
  if (command !== 'wait' || !repo || !(flag('head-sha') ?? mergeSha) || !Number.isSafeInteger(pr) || !Number.isSafeInteger(runId)
    || ![quiet, deadline, poll].every(value => Number.isFinite(value) && value >= 0)) {
    console.error(USAGE);
    process.exit(2);
  }
  const output = flag('github-output');
  const summary = flag('summary');
  const target = mergeSha ? screenTarget(runGh, repo, pr, mergeSha) : null;
  if (target && 'error' in target) {
    console.error(`::error::screen refused: ${target.error}`);
    if (summary) fs.appendFileSync(summary, `- Screen refused: ${target.error}\n`);
    process.exit(1);
  }
  const headSha = target ? target.head : flag('head-sha')!;
  if (!/^[0-9a-f]{40}$/.test(headSha)) { console.error(USAGE); process.exit(2); }
  if (target && output) fs.appendFileSync(output, `head_sha=${target.head}\nbase_sha=${target.base}\nhead_branch=${target.branch}\n`);
  const { decision, lines } = waitForReadiness({ repo, pr, headSha, runId, quietMs: quiet * 60_000, deadlineMs: deadline * 60_000, pollMs: Math.max(5, poll) * 1000 });
  if (target) lines.unshift(`Screen of PR #${pr}: merge ${mergeSha} merges head ${target.head.slice(0, 12)} into base ${target.base.slice(0, 12)}`);
  for (const line of lines) {
    console.log(line);
    if (summary) fs.appendFileSync(summary, `- ${line}\n`);
  }
  if (output && decision.kind === 'superseded') fs.appendFileSync(output, 'superseded=true\n');
  if (decision.kind === 'blocked') console.error(`::error::${decision.reason}`);
  process.exit(decision.kind === 'blocked' ? 1 : 0);
}
