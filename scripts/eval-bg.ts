#!/usr/bin/env bun
/**
 * eval-bg — the one entry point for background paid evals (`bun run eval:bg:<lane>`).
 *
 * Two backends, one completion contract (W5d, CEO-17, DX-1..3/7, ENG-12/19):
 *
 *   dispatch  The pushed, clean ref is dispatched to CI (evals.yml and/or
 *             evals-periodic.yml on garrytan/gstack) with an `expected_sha` the
 *             workflow verifies and a `nonce` its run-name carries; this process
 *             resolves the run by that nonce and follows it to its conclusion.
 *   local     The lane's sharded runner on this machine, capped at
 *             ceil(1.5 x planned serial seconds / EVALS_JOBS) + 20 min, at most 4 h.
 *
 * Both run under bin/gstack-detach with the `gstack-evals` lock, a run-scoped
 * log under ~/.gstack-dev/eval-runs/ whose first line names the backend and the
 * tested revision, and the `### gstack-detach EXIT=<code> ###` sentinel. A
 * followed CI run maps its conclusion: success 0, failure 1, cancelled 130,
 * anything else 2. `status <run-id|log>` reconnects later.
 *
 * Dispatch needs every one of: gh installed and authenticated, origin is
 * garrytan/gstack with push rights, a branch whose remote head (read with
 * `gh api`, never git fetch) equals HEAD, and a clean tree (no staged,
 * unstaged or untracked files, the rule test/helpers/test-selection.ts uses).
 * Otherwise it runs locally and prints why; `--dispatch` refuses instead.
 * Dispatched runs are validation runs: fresh, never writing PR receipts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectBaseBranch } from '../test/helpers/touchfiles';
import { DEFAULT_JOBS, ROOT, type PaidTier } from './lib/paid-types';
import { buildRunManifest, loadPaidTestDurations, recordedShardMs } from './lib/paid-plan';

export type EvalBgLane = 'pr' | 'gate' | 'periodic' | 'release';
export type Backend = 'dispatch' | 'local';
export const EVAL_BG_LANES: readonly EvalBgLane[] = ['pr', 'gate', 'periodic', 'release'];
export const CANONICAL_REPO = 'garrytan/gstack';
export const EVAL_LOCK = 'gstack-evals';
export const LOCAL_CAP_SECONDS = 4 * 60 * 60;
export const LOCAL_SETUP_SECONDS = 20 * 60;
export const LOCAL_CAP_FACTOR = 1.5;
/** Packing weight of a shard with no recorded wall: the PR lane's ~10-minute case target. */
export const UNRECORDED_SHARD_MS = 600_000;
/** How long the dispatch follower may hold the lock: the longest CI lane plus queueing. */
export const DISPATCH_FOLLOW_SECONDS = 4 * 60 * 60;

export interface WorkflowDispatch { workflow: 'evals.yml' | 'evals-periodic.yml'; inputs: Record<string, string> }

interface LaneSpec {
  /** The package script the local backend runs. */
  script: string;
  /** Worker count the local command defaults to (EVALS_JOBS overrides). */
  jobs: number;
  /** Tiers the local command plans, in order. */
  tiers: Array<{ tier: PaidTier; profile: 'pr' | 'full' }>;
}

export const LANE_SPECS: Record<EvalBgLane, LaneSpec> = {
  pr: { script: 'test:pr', jobs: 2, tiers: [{ tier: 'gate', profile: 'pr' }] },
  gate: { script: 'test:gate:sharded', jobs: DEFAULT_JOBS, tiers: [{ tier: 'gate', profile: 'full' }] },
  periodic: { script: 'test:periodic:sharded', jobs: DEFAULT_JOBS, tiers: [{ tier: 'periodic', profile: 'full' }] },
  release: { script: 'test:release', jobs: DEFAULT_JOBS, tiers: [{ tier: 'gate', profile: 'full' }, { tier: 'periodic', profile: 'full' }] },
};

/** The workflows a lane dispatches and their inputs (names agreed with evals.yml's workflow_dispatch). */
export function dispatchPlan(lane: EvalBgLane, ids: { sha: string; baseRef: string; baseSha: string; nonce: string; prNumber?: number | null }): WorkflowDispatch[] {
  const evals = (all: boolean): WorkflowDispatch => ({ workflow: 'evals.yml', inputs: {
    evals_all: String(all), expected_sha: ids.sha, nonce: ids.nonce,
    ...(all ? {} : { base_ref: ids.baseRef, base_sha: ids.baseSha }),
    // CEO-29/ENG-8: a PR lane run on a ref with an open same-repo PR reads that PR's receipts read-only.
    ...(!all && ids.prNumber ? { pr_receipts: String(ids.prNumber) } : {}),
  } });
  const periodic: WorkflowDispatch = { workflow: 'evals-periodic.yml', inputs: { expected_sha: ids.sha, nonce: ids.nonce } };
  if (lane === 'pr') return [evals(false)];
  if (lane === 'gate') return [evals(true)];
  if (lane === 'periodic') return [periodic];
  return [evals(true), periodic];
}

/**
 * Local cap: ceil(1.5 x planned serial seconds / jobs) + 20 min setup, at most
 * 4 h. Serial seconds sum the recorded wall of every planned shard
 * (scripts/paid-test-durations.json), unrecorded shards at UNRECORDED_SHARD_MS.
 */
export function localCapSeconds(serialMs: number, jobs: number): { seconds: number; capped: boolean } {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('EVALS_JOBS must be a positive integer');
  const computed = Math.ceil(LOCAL_CAP_FACTOR * serialMs / jobs / 1000) + LOCAL_SETUP_SECONDS;
  return { seconds: Math.min(computed, LOCAL_CAP_SECONDS), capped: computed > LOCAL_CAP_SECONDS };
}

/** Planned serial work of a lane on this checkout, from the same planner CI uses. */
export function plannedSerialMs(lane: EvalBgLane, rootDir = ROOT): number {
  return LANE_SPECS[lane].tiers.reduce((total, { tier, profile }) => {
    const plan = (all: boolean) => buildRunManifest({ tier, profile: all ? 'full' : profile, sliceCount: 1, evalsAll: all,
      env: all ? { EVALS_ALL: '1' } : {}, rootDir });
    let manifest;
    try { manifest = plan(profile === 'full'); }
    catch { manifest = plan(true); } // a PR diff that needs full validation runs the full gate locally
    const recorded = loadPaidTestDurations(rootDir, tier);
    return total + manifest.entries.filter(entry => entry.status === 'planned')
      .reduce((sum, entry) => sum + (recordedShardMs(recorded, entry.file) ?? UNRECORDED_SHARD_MS), 0);
  }, 0);
}

export interface CheckoutFacts {
  sha: string;
  branch: string | null;
  /** `git status --porcelain --untracked-files=all` lines. */
  dirty: string[];
  /** owner/name of origin, null when unknown. */
  repo: string | null;
  ghReady: boolean;
  canPush: boolean;
  /** Remote head of the branch on garrytan/gstack (gh api), null when absent. */
  remoteSha: string | null;
  /** Commits HEAD is ahead of remoteSha, null when unknown. */
  ahead: number | null;
}

export type BackendChoice =
  | { backend: Backend; reason: string }
  | { backend: 'refuse'; reason: string };

/** DX-1 checkout contract, one row per reason dispatch is not possible. */
export function dispatchBlockers(facts: CheckoutFacts): string[] {
  const sha = facts.sha.slice(0, 12);
  const blockers: string[] = [];
  if (!facts.ghReady) blockers.push('gh is not installed or not authenticated (run `gh auth status`)');
  if (facts.repo !== CANONICAL_REPO) blockers.push(`origin is ${facts.repo ?? 'unknown'}, not ${CANONICAL_REPO} (a fork cannot dispatch its workflows)`);
  else if (facts.ghReady && !facts.canPush) blockers.push(`this gh account cannot dispatch workflows on ${CANONICAL_REPO}`);
  if (!facts.branch) blockers.push(`HEAD ${sha} is detached; dispatch needs a pushed branch`);
  else if (facts.ghReady && facts.repo === CANONICAL_REPO && facts.remoteSha === null) blockers.push(`branch ${facts.branch} is not on ${CANONICAL_REPO}; push it`);
  else if (facts.remoteSha !== null && facts.remoteSha !== facts.sha) {
    blockers.push(facts.ahead !== null
      ? `HEAD ${sha} is ${facts.ahead} commits ahead of origin/${facts.branch}`
      : `HEAD ${sha} differs from origin/${facts.branch} (${facts.remoteSha.slice(0, 12)})`);
  }
  if (facts.dirty.length) blockers.push(`${facts.dirty.length} files are modified or untracked`);
  return blockers;
}

/** Choose the backend: an explicit mode wins; otherwise dispatch when nothing blocks it. */
export function chooseBackend(facts: CheckoutFacts, mode: Backend | 'auto'): BackendChoice {
  if (mode === 'local') return { backend: 'local', reason: 'local requested (--local or GSTACK_EVAL_BG_MODE=local)' };
  const blockers = dispatchBlockers(facts);
  if (!blockers.length) return { backend: 'dispatch', reason: `HEAD ${facts.sha.slice(0, 12)} is clean and pushed to ${CANONICAL_REPO}/${facts.branch}` };
  if (mode === 'dispatch') return { backend: 'refuse', reason: `${blockers.join(' and ')}; commit and push, or rerun with --local` };
  return { backend: 'local', reason: `cannot dispatch: ${blockers.join('; ')}` };
}

/** CI conclusion -> the detach exit code (DX-2). */
export function conclusionExitCode(conclusion: string | null | undefined): number {
  if (conclusion === 'success') return 0;
  if (conclusion === 'failure') return 1;
  if (conclusion === 'cancelled') return 130;
  return 2;
}

/** Status words `status` prints, from a detach EXIT code or a CI run. */
export function exitStatusWord(code: string): 'passed' | 'failed' | 'cancelled' {
  if (code === '0') return 'passed';
  return code === '130' ? 'cancelled' : 'failed';
}

/** Nonce: lane, tested revision and base, plus a random suffix; the dedupe key is everything but the suffix. */
export function makeNonce(lane: EvalBgLane, sha: string, baseSha: string, random = Math.random().toString(36).slice(2, 8)): string {
  return `${dedupeKey(lane, sha, baseSha)}${random}`;
}
export function dedupeKey(lane: EvalBgLane, sha: string, baseSha: string): string {
  return `${lane}-${sha.slice(0, 12)}-${(baseSha || 'none').slice(0, 12)}-`;
}

export interface RunSummary { databaseId: number; displayTitle: string; status: string; conclusion: string | null; url: string; event: string }

/**
 * DX-3 / ENG-12: an existing dispatch of the same lane, revision and base that
 * is queued, running or completed successfully is followed instead of
 * dispatching a duplicate. Only dispatches match (by the nonce in run-name); a
 * failed or cancelled run is never reused.
 */
export function findDuplicateRun(runs: readonly RunSummary[], key: string): RunSummary | null {
  return runs.find(run => run.event === 'workflow_dispatch' && run.displayTitle.includes(`eval-bg ${key}`)
    && (run.status !== 'completed' || run.conclusion === 'success')) ?? null;
}

// ─── Process plumbing (git / gh / detach) ────────────────────────────────────

type Exec = (command: string, args: string[]) => { status: number | null; stdout: string };

const exec: Exec = (command, args) => {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

function originRepo(run: Exec): string | null {
  const url = run('git', ['config', '--get', 'remote.origin.url']).stdout.trim();
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
}

/** Gather the DX-1 facts. Remote state comes from `gh api` only (ENG-19). */
export function gatherCheckoutFacts(run: Exec = exec): CheckoutFacts {
  const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const branch = run('git', ['branch', '--show-current']).stdout.trim() || null;
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean);
  const repo = originRepo(run);
  const ghReady = run('gh', ['auth', 'status']).status === 0;
  const canPush = ghReady && repo === CANONICAL_REPO
    && run('gh', ['api', `repos/${CANONICAL_REPO}`, '--jq', '.permissions.push']).stdout.trim() === 'true';
  const remote = ghReady && repo === CANONICAL_REPO && branch
    ? run('gh', ['api', `repos/${CANONICAL_REPO}/branches/${encodeURIComponent(branch)}`, '--jq', '.commit.sha']) : null;
  const remoteSha = remote && remote.status === 0 && /^[0-9a-f]{40}$/.test(remote.stdout.trim()) ? remote.stdout.trim() : null;
  const count = remoteSha && remoteSha !== sha ? run('git', ['rev-list', '--count', `${remoteSha}..HEAD`]) : null;
  return { sha, branch, dirty, repo, ghReady, canPush, remoteSha,
    ahead: count && count.status === 0 ? Number(count.stdout.trim()) : null };
}

/** Run-scoped log path, the same layout gstack-detach uses for its own default. */
export function runScopedLog(label: string, branch: string | null, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return path.join(os.homedir(), '.gstack-dev', 'eval-runs',
    `${label}-${path.basename(ROOT)}-${(branch ?? 'nobranch').replace(/\//g, '-')}-${stamp}-${process.pid}.log`);
}

/** Start `command` under gstack-detach with the eval lock; the header becomes the log's first line. */
export function launchDetached(opts: { log: string; label: string; timeoutSeconds: number; header: string; command: string[]; env?: NodeJS.ProcessEnv }): string {
  fs.mkdirSync(path.dirname(opts.log), { recursive: true });
  fs.writeFileSync(opts.log, `${opts.header}\n`, { flag: 'a' });
  const result = spawnSync(path.join(ROOT, 'bin', 'gstack-detach'), ['--log', opts.log, '--lock', EVAL_LOCK,
    '--timeout', String(opts.timeoutSeconds), '--label', opts.label, '--', ...opts.command],
  { cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: opts.env ?? process.env });
  if (result.status !== 0) throw new Error(`gstack-detach failed to start: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pollMs = () => Number(process.env.GSTACK_EVAL_BG_POLL_MS) || 30_000;

/** Dispatch one workflow (or adopt a duplicate) and follow it; returns the mapped exit code. */
async function followWorkflow(dispatch: WorkflowDispatch, ref: string, key: string, run: Exec): Promise<number> {
  const list = () => {
    const out = run('gh', ['run', 'list', '--repo', CANONICAL_REPO, '--workflow', dispatch.workflow, '--event', 'workflow_dispatch',
      '--limit', '30', '--json', 'databaseId,displayTitle,status,conclusion,url,event']);
    try { return out.status === 0 ? JSON.parse(out.stdout) as RunSummary[] : []; } catch { return []; }
  };
  let target = findDuplicateRun(list(), key);
  if (target) console.log(`[eval-bg] ${dispatch.workflow}: following existing run ${target.url} (same lane, revision and base; no duplicate dispatch)`);
  else {
    const args = ['workflow', 'run', dispatch.workflow, '--repo', CANONICAL_REPO, '--ref', ref,
      ...Object.entries(dispatch.inputs).flatMap(([name, value]) => ['-f', `${name}=${value}`])];
    if (run('gh', args).status !== 0) { console.log(`[eval-bg] ${dispatch.workflow}: gh workflow run failed`); return 2; }
    const deadline = Date.now() + 10 * pollMs();
    while (!target && Date.now() < deadline) {
      await sleep(Math.min(pollMs(), 10_000));
      target = list().find(item => item.displayTitle.includes(`eval-bg ${dispatch.inputs.nonce}`)) ?? null;
    }
    if (!target) { console.log(`[eval-bg] ${dispatch.workflow}: dispatched, but no run named ${dispatch.inputs.nonce} appeared`); return 2; }
  }
  console.log(`[eval-bg] ${dispatch.workflow}: run ${target.databaseId} ${target.url}`);
  let last = '';
  while (true) {
    const view = run('gh', ['run', 'view', String(target.databaseId), '--repo', CANONICAL_REPO, '--json', 'status,conclusion']);
    let state: { status?: string; conclusion?: string | null } = {};
    try { state = JSON.parse(view.stdout); } catch { /* transient gh failure: poll again */ }
    if (state.status && state.status !== last) console.log(`[eval-bg] ${dispatch.workflow}: ${last = state.status}`);
    if (state.status === 'completed') {
      const code = conclusionExitCode(state.conclusion);
      console.log(`[eval-bg] ${dispatch.workflow}: conclusion ${state.conclusion ?? 'unknown'} -> exit ${code}`);
      return code;
    }
    await sleep(pollMs());
  }
}

/** The detached follower: every planned workflow, then the first non-zero code. */
export async function follow(plan: WorkflowDispatch[], ref: string, key: string, run: Exec = exec): Promise<number> {
  const codes = await Promise.all(plan.map(dispatch => followWorkflow(dispatch, ref, key, run)));
  return codes.find(code => code !== 0) ?? 0;
}

/** `status <run-id|log>`: running / passed / failed / cancelled / incomplete. */
export function statusOf(target: string, run: Exec = exec, alive: (pgid: number) => boolean = pgidAlive): string {
  if (/^\d+$/.test(target)) {
    const view = run('gh', ['run', 'view', target, '--repo', CANONICAL_REPO, '--json', 'status,conclusion']);
    const state = JSON.parse(view.stdout || '{}') as { status?: string; conclusion?: string };
    return state.status === 'completed' ? exitStatusWord(String(conclusionExitCode(state.conclusion))) : 'running';
  }
  const log = fs.readFileSync(target, 'utf8');
  const exit = /### gstack-detach EXIT=(\S+) ###/.exec(log)?.[1];
  if (exit) return exitStatusWord(exit);
  const pgid = Number(/### gstack-detach START label=\S+ pgid=(\d+) ###/.exec(log)?.[1]);
  return pgid && alive(pgid) ? 'running' : 'incomplete';
}

function pgidAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

const HELP = `Usage:
  bun run scripts/eval-bg.ts <pr|gate|periodic|release> [--local | --dispatch] [--timeout SECS] [--base REF]
  bun run scripts/eval-bg.ts status <run-id|log>

Runs a paid eval lane in the background and returns immediately. Poll the printed
log; it ends with "### gstack-detach EXIT=<code> ###" (0 passed, 1 failed,
130 cancelled, 2 other).

  pr        diff-selected PR gate (CI: evals.yml, evals_all=false)
  gate      full gate tier (CI: evals.yml, evals_all=true)
  periodic  full periodic tier (CI: evals-periodic.yml, periodic lane only)
  release   gate + periodic (CI: both workflows)

Backend: a clean HEAD pushed to ${CANONICAL_REPO} dispatches the CI workflow and
follows it; anything else runs locally under bin/gstack-detach, capped at
ceil(1.5 x planned serial seconds / EVALS_JOBS) + 20 min (at most 4 h).
  --local / --dispatch   force a backend (also GSTACK_EVAL_BG_MODE=local|dispatch);
                         --dispatch refuses instead of falling back
  --timeout SECS         override the computed local cap
  --base REF             base branch for the pr lane (default: detected base)
Needs: gh with repo access for dispatch; ANTHROPIC_API_KEY for local runs.`;

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return argv.length ? 0 : 2; }
  const [command, ...rest] = argv;
  if (command === 'status') {
    if (!rest[0]) throw new Error('status needs a run id or a log path');
    console.log(statusOf(rest[0]));
    return 0;
  }
  if (command === '__follow') {
    const [planJson, ref, key] = rest;
    return follow(JSON.parse(planJson!), ref!, key!);
  }
  if (!EVAL_BG_LANES.includes(command as EvalBgLane)) throw new Error(`Unknown lane ${command}; expected ${EVAL_BG_LANES.join(', ')} or status (see --help)`);
  const lane = command as EvalBgLane;
  let mode: Backend | 'auto' = process.env.GSTACK_EVAL_BG_MODE === 'local' || process.env.GSTACK_EVAL_BG_MODE === 'dispatch' ? process.env.GSTACK_EVAL_BG_MODE : 'auto';
  let timeoutOverride: number | null = null;
  let baseRef = detectBaseBranch(ROOT) || 'main';
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--local' || flag === '--dispatch') mode = flag.slice(2) as Backend;
    else if (flag === '--timeout') {
      timeoutOverride = Number(rest[++index]);
      if (!Number.isSafeInteger(timeoutOverride) || timeoutOverride <= 0) throw new Error('--timeout needs positive seconds');
    } else if (flag === '--base') baseRef = rest[++index] ?? baseRef;
    else throw new Error(`Unknown argument: ${flag} (see --help)`);
  }
  const facts = gatherCheckoutFacts();
  const choice = chooseBackend(facts, mode);
  if (choice.backend === 'refuse') { console.error(`[eval-bg] refusing to dispatch: ${choice.reason}`); return 1; }
  const label = `evals-${lane}`;
  const log = runScopedLog(label, facts.branch);
  const tested = `${facts.sha}${facts.dirty.length ? ` + ${facts.dirty.length} uncommitted file(s)` : ''}`;
  if (choice.backend === 'dispatch') {
    const baseSha = exec('git', ['merge-base', `origin/${baseRef}`, 'HEAD']).stdout.trim();
    const pr = lane === 'pr' ? exec('gh', ['api', `repos/${CANONICAL_REPO}/pulls?head=${CANONICAL_REPO.split('/')[0]}:${facts.branch}&state=open`, '--jq', '.[0].number']).stdout.trim() : '';
    const nonce = makeNonce(lane, facts.sha, baseSha);
    const plan = dispatchPlan(lane, { sha: facts.sha, baseRef, baseSha, nonce, prNumber: Number(pr) || null });
    const header = `[eval-bg] backend=dispatch lane=${lane} tested=${facts.sha} ref=${facts.branch} workflows=${plan.map(item => item.workflow).join(',')} nonce=${nonce} (${choice.reason})`;
    console.log(header);
    console.log(launchDetached({ log, label, timeoutSeconds: DISPATCH_FOLLOW_SECONDS, header,
      command: [process.execPath, 'run', path.join(ROOT, 'scripts', 'eval-bg.ts'), '__follow', JSON.stringify(plan), facts.branch!, dedupeKey(lane, facts.sha, baseSha)] }));
    return 0;
  }
  const jobs = Number(process.env.EVALS_JOBS) || LANE_SPECS[lane].jobs;
  const cap = timeoutOverride !== null ? { seconds: timeoutOverride, capped: false } : localCapSeconds(plannedSerialMs(lane), jobs);
  const header = `[eval-bg] backend=local lane=${lane} tested=${tested} cap=${cap.seconds}s jobs=${jobs}${timeoutOverride !== null ? ' (--timeout)' : ''} (${choice.reason})`;
  console.log(header);
  if (cap.capped) console.log(`[eval-bg] WARNING: planned work exceeds the ${LOCAL_CAP_SECONDS}s local cap; the tail may not run. Dispatch to CI or raise EVALS_JOBS.`);
  console.log(launchDetached({ log, label, timeoutSeconds: cap.seconds, header, command: ['bun', 'run', LANE_SPECS[lane].script] }));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[eval-bg] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
