/**
 * Cancellation recovery for the PR lane's receipt store (W1c: CEO-14/25/34,
 * ENG-4/5/7/8).
 *
 * A PR run cancelled by the next push never reaches its report, so its
 * finished receipts never enter the store the report saves. The
 * `recover-receipts` job in evals.yml runs this script from the base ref
 * (never PR code) with `actions: read`, before `plan-slices`:
 *
 *   collect  restores nothing itself: it reads the store the job restored,
 *            lists this PR's evals.yml runs newer than that store (plus runs
 *            the checkpoint left unresolved), downloads the receipts of
 *            completed cancelled runs (at most 5, merged oldest first,
 *            negatives first), reconstructs completed behavior panels from
 *            their manifest and slice results to publish panel negatives
 *            (partial panels get no credit), and writes the checkpoint
 *            `recovery.json` into the store.
 *   decide   (plan-slices) reads the checkpoint and turns reuse off when
 *            recovery degraded or a cancelled run is still unresolved, so a
 *            FAIL that may exist is never bypassed by an older PASS.
 *
 * Recovery never fails the run: a gh error, rate limit, missing artifact or
 * an exhausted download budget degrades to "no recovered receipts" with a
 * named reason, and the run executes unreduced.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeReceiptDirs, writeNegativeReceipt } from './e2e-shard-reuse';
import { loadSliceArtifacts, panelReports, parseRunManifest, shardFile } from './test-paid-shards';

export const RECOVERY_FILE = 'recovery.json';
export const MAX_RECOVERED_RUNS = 5;
const PROCESSED_KEEP = 200;

export interface RecoveryCheckpoint {
  schema: 1;
  updatedAt: number;
  mode: 'pr' | 'dispatch';
  /** Run ids whose evidence is merged (or that needed none). */
  processed: string[];
  /** Cancelled runs whose evidence could not be read yet; reuse stays off until a later run reconciles them. */
  unresolved: Array<{ runId: string; reason: string }>;
  /** Why recovery could not run at all; reuse stays off. */
  degraded?: string;
  recovered: number;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_sha: string;
  run_attempt?: number;
  updated_at?: string;
  head_repository?: { full_name?: string } | null;
  pull_requests?: Array<{ number: number }>;
}

/** One `gh` invocation; injectable so free tests drive recovery from recorded responses. */
export type GhRunner = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string };

export const runGh: GhRunner = (args, timeoutMs) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: Math.max(1_000, timeoutMs), maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.error ? String(result.error) : result.stderr ?? '' };
};

/** A gh failure as a named reason with the next step (DX-6). */
export function ghFailureReason(stderr: string): string {
  if (/rate limit|secondary rate|HTTP 429/i.test(stderr)) {
    const reset = /reset[^0-9]*(\d{9,})/i.exec(stderr)?.[1];
    return `GitHub API rate limit${reset ? ` (resets at ${new Date(Number(reset) * 1000).toISOString()})` : ''}; rerun the job after the reset`;
  }
  if (/HTTP 40[13]|authentication|auth login/i.test(stderr)) return 'gh is not authorized for actions: read; check the job permissions and `gh auth status`';
  if (/ETIMEDOUT|timed out/i.test(stderr)) return 'gh timed out inside the 60 s recovery budget; rerun the job';
  return `gh failed: ${stderr.trim().split('\n')[0]?.slice(0, 160) || 'no output'}`;
}

export function readCheckpoint(store: string): RecoveryCheckpoint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(store, RECOVERY_FILE), 'utf8'));
    if (parsed?.schema !== 1 || !Array.isArray(parsed.processed) || !Array.isArray(parsed.unresolved)) return null;
    return parsed as RecoveryCheckpoint;
  } catch { return null; }
}

function writeCheckpoint(store: string, checkpoint: RecoveryCheckpoint): void {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, RECOVERY_FILE), `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
}

/** The run id that saved a restored store, from its cache key (`…-pr-<n>-<run id>-<attempt>-merged`). */
export function storeRunId(cacheKey: string): number {
  const match = /-pr-\d+-(\d+)-\d+-(?:merged|plan)$/.exec(cacheKey);
  return match ? Number(match[1]) : 0;
}

/** CEO-34 provenance: same workflow event, PR number and head repository, never this run. */
export function acceptedRun(run: WorkflowRun, scope: { pr: number; headRepo: string; selfRunId: number }): boolean {
  return run.id !== scope.selfRunId && run.event === 'pull_request'
    && run.head_repository?.full_name === scope.headRepo
    && (run.pull_requests ?? []).some(pr => pr.number === scope.pr);
}

/**
 * Negative receipts a cancelled run's completed work proves (ENG-5): every
 * completed FAIL panel whose trials share one input identity, and every
 * completed non-passing single-trial shard. Partial panels publish nothing.
 */
export function negativesFromRun(runDir: string, run: Pick<WorkflowRun, 'id' | 'head_sha' | 'updated_at'>, out: string): number {
  let manifest;
  try { manifest = parseRunManifest(fs.readFileSync(path.join(runDir, 'paid-plan', 'manifest.json'), 'utf8')); } catch { return 0; }
  const artifacts = loadSliceArtifacts(runDir);
  let written = 0;
  for (const attempt of [...new Set(artifacts.map(a => a.result.attempt ?? 1))]) {
    const results = artifacts.map(a => a.result).filter(r => (r.attempt ?? 1) === attempt);
    const completedAt = Math.max(0, ...results.map(r => r.finishedAt ?? 0)) || Date.parse(run.updated_at ?? '') || Date.now();
    const source = { runId: `${run.id}/${attempt}`, revision: run.head_sha, completedAt };
    if (!/^[a-f0-9]{40}$/.test(source.revision)) continue;
    const outcomes = results.flatMap(r => r.outcomes);
    for (const panel of panelReports(manifest, results, attempt).filter(p => p.status === 'FAIL')) {
      const keys = outcomes.filter(o => o.trial?.case === panel.case && shardFile(o.files[0] ?? '') === panel.file).map(o => o.reused ? null : o.inputKey ?? null);
      if (keys.length !== panel.panel.n || keys.some(k => k === null) || new Set(keys).size !== 1) continue;
      writeNegativeReceipt(out, { schema: 1, key: keys[0]!, source });
      written++;
    }
    for (const outcome of outcomes.filter(o => !o.trial && o.inputKey && !o.reused && o.status !== 'passed' && o.status !== 'skipped-by-diff')) {
      writeNegativeReceipt(out, { schema: 1, key: outcome.inputKey!, source });
      written++;
    }
  }
  return written;
}

export interface CollectOptions {
  repo: string;
  pr: number;
  headRepo: string;
  branch: string;
  selfRunId: number;
  store: string;
  /** The restored cache key; recovery reads only runs newer than the run that saved it. */
  storeKey?: string;
  /** `dispatch`: read-only receipts of the PR's completed runs for a validation dispatch (ENG-8). */
  mode?: 'pr' | 'dispatch';
  budgetMs?: number;
  pollMs?: number;
  gh?: GhRunner;
  now?: () => number;
  sleep?: (ms: number) => void;
}

export function collectRecovery(options: CollectOptions): { checkpoint: RecoveryCheckpoint; lines: string[] } {
  const gh = options.gh ?? runGh;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const mode = options.mode ?? 'pr';
  const deadline = now() + (options.budgetMs ?? 60_000);
  const left = () => deadline - now();
  const previous = readCheckpoint(options.store);
  const processed = new Set(previous?.processed ?? []);
  const pending = new Set((previous?.unresolved ?? []).map(entry => entry.runId));
  const lines: string[] = [];
  const finish = (checkpoint: Omit<RecoveryCheckpoint, 'schema' | 'updatedAt' | 'mode'>) => {
    const full: RecoveryCheckpoint = { schema: 1, updatedAt: now(), mode, ...checkpoint, processed: checkpoint.processed.slice(-PROCESSED_KEEP) };
    writeCheckpoint(options.store, full);
    return { checkpoint: full, lines };
  };
  const degrade = (reason: string) => {
    lines.push(`receipt recovery degraded: ${reason}; no recovered receipts, this run executes unreduced`);
    return finish({ processed: [...processed], unresolved: previous?.unresolved ?? [], degraded: reason, recovered: 0 });
  };

  const listed = gh(['api', '-X', 'GET', `repos/${options.repo}/actions/workflows/evals.yml/runs`,
    '-f', 'event=pull_request', '-f', `branch=${options.branch}`, '-f', 'per_page=50'], left());
  if (listed.status !== 0) return degrade(ghFailureReason(listed.stderr));
  let runs: WorkflowRun[];
  try { runs = (JSON.parse(listed.stdout).workflow_runs ?? []) as WorkflowRun[]; } catch { return degrade('gh returned an unreadable run list'); }

  const floor = mode === 'pr' ? storeRunId(options.storeKey ?? '') : 0;
  const scope = { pr: options.pr, headRepo: options.headRepo, selfRunId: options.selfRunId };
  for (const rejected of runs.filter(run => run.id !== options.selfRunId && run.event === 'pull_request' && !acceptedRun(run, scope)
    && (run.pull_requests ?? []).some(pr => pr.number === options.pr))) {
    lines.push(`rejected run ${rejected.id}: head repository ${rejected.head_repository?.full_name ?? 'unknown'} is not ${options.headRepo}`);
  }
  const older = runs.filter(run => acceptedRun(run, scope) && run.id < options.selfRunId);
  // A completed run that was not cancelled reached its report, which saved its receipts.
  const reported = (run: WorkflowRun) => run.status === 'completed' && run.conclusion !== 'cancelled';
  const fresh = (run: WorkflowRun) => pending.has(String(run.id)) || (run.id > floor && !processed.has(String(run.id)));
  const candidates = (mode === 'dispatch' ? older.filter(run => run.status === 'completed')
    : older.filter(run => fresh(run) && !reported(run))).sort((a, b) => b.id - a.id).slice(0, MAX_RECOVERED_RUNS);
  if (mode === 'pr') for (const run of older.filter(run => fresh(run) && reported(run))) processed.add(String(run.id));

  const unresolved: RecoveryCheckpoint['unresolved'] = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-receipts-'));
  let recovered = 0;
  try {
    // Oldest first, so a newer FAIL always lands after the PASS it blocks.
    for (const listedRun of [...candidates].sort((a, b) => a.id - b.id)) {
      const id = String(listedRun.id);
      let run = listedRun;
      while (run.status !== 'completed' && left() > (options.pollMs ?? 5_000)) {
        sleep(options.pollMs ?? 5_000);
        const polled = gh(['api', `repos/${options.repo}/actions/runs/${id}`], left());
        if (polled.status !== 0) break;
        try { run = JSON.parse(polled.stdout) as WorkflowRun; } catch { break; }
      }
      if (run.status !== 'completed') {
        unresolved.push({ runId: id, reason: 'still in progress; its completed FAILs cannot be read yet' });
        lines.push(`run ${id} is still ${run.status}; reuse stays off until a later run reconciles it`);
        continue;
      }
      if (mode === 'pr' && run.conclusion !== 'cancelled') { processed.add(id); continue; }
      const dir = path.join(work, id);
      const names = gh(['api', '-X', 'GET', `repos/${options.repo}/actions/runs/${id}/artifacts`, '-f', 'per_page=100'], left());
      let artifacts: string[] = [];
      try {
        artifacts = names.status === 0 ? (JSON.parse(names.stdout).artifacts ?? [])
          .filter((a: { name: string; expired?: boolean }) => !a.expired && /^(?:paid-plan|paid-slice-\d+-a\d+|report-verdict-a\d+)$/.test(a.name))
          .map((a: { name: string }) => a.name) : [];
      } catch { artifacts = []; }
      if (names.status !== 0) {
        unresolved.push({ runId: id, reason: ghFailureReason(names.stderr) });
        lines.push(`run ${id}: cannot list artifacts (${ghFailureReason(names.stderr)})`);
        continue;
      }
      let failed = '';
      if (artifacts.length && left() <= 0) failed = 'the 60 s download budget ran out';
      else if (artifacts.length) {
        // gh extracts one artifact into -D itself and several into one directory per artifact.
        const target = artifacts.length === 1 ? path.join(dir, artifacts[0]!) : dir;
        const got = gh(['run', 'download', id, '-R', options.repo, ...artifacts.flatMap(name => ['-n', name]), '-D', target], left());
        if (got.status !== 0) failed = ghFailureReason(got.stderr);
      }
      if (failed) {
        unresolved.push({ runId: id, reason: failed });
        lines.push(`run ${id}: ${failed}; its evidence stays unresolved`);
        continue;
      }
      const negatives = path.join(dir, 'recovered-negatives');
      const panelNegatives = negativesFromRun(dir, run, negatives);
      const receiptDirs = [negatives, ...artifacts.filter(name => name !== 'paid-plan').flatMap(name =>
        [path.join(dir, name, 'receipts'), path.join(dir, name, 'paid-report', 'report-receipts')]),
      ...(mode === 'dispatch' ? [path.join(dir, 'paid-plan', 'store'), path.join(dir, 'paid-plan', 'receipts')] : [])];
      const merged = mergeReceiptDirs(options.store, receiptDirs);
      recovered += merged;
      processed.add(id);
      lines.push(`run ${id} (${run.conclusion}): merged ${merged} receipt(s), ${panelNegatives} reconstructed negative(s) from completed panels and shards`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (!candidates.length) lines.push('no cancelled runs to recover');
  return finish({ processed: [...processed], unresolved, recovered });
}

/** plan-slices: reuse is on only when recovery ran, did not degrade and left nothing unresolved. */
export function recoveryDecision(store: string): { reuse: boolean; reason: string } {
  const checkpoint = readCheckpoint(store);
  if (!checkpoint) return { reuse: false, reason: 'receipt recovery unavailable (no checkpoint from the recover-receipts job); cases execute fresh' };
  if (checkpoint.degraded) return { reuse: false, reason: `receipt recovery degraded: ${checkpoint.degraded}; cases execute fresh` };
  if (checkpoint.unresolved.length) {
    return { reuse: false, reason: `cancelled run(s) ${checkpoint.unresolved.map(u => u.runId).join(', ')} not reconciled (${checkpoint.unresolved[0]!.reason}); cases execute fresh and the next push reconciles them` };
  }
  return { reuse: true, reason: `receipt reuse on; ${checkpoint.recovered} receipt(s) recovered from cancelled runs` };
}

const USAGE = `usage:
  bun run scripts/recover-receipts.ts collect --repo <owner/name> --pr <n> --head-repo <owner/name> --branch <head branch>
      --run-id <this run> --store <dir> [--store-key <restored cache key>] [--mode pr|dispatch] [--budget-seconds 60]
  bun run scripts/recover-receipts.ts decide <store> [--github-output <file>]
Recovery never fails: on any gh error it records why and the run executes unreduced.`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!command || command === '--help' || command === '-h') { console.log(USAGE); process.exit(command ? 0 : 2); }
  if (command === 'decide' && rest[0]) {
    const decision = recoveryDecision(rest[0]);
    const out = flag('github-output');
    if (out) fs.appendFileSync(out, `reuse=${decision.reuse ? 'on' : 'off'}\n`);
    console.log(`- Receipt reuse: ${decision.reason}`);
  } else if (command === 'collect') {
    const [store, repo, headRepo, branch] = [flag('store'), flag('repo'), flag('head-repo'), flag('branch')];
    const [pr, selfRunId] = [Number(flag('pr')), Number(flag('run-id'))];
    if (!store || !repo || !headRepo || !branch || !Number.isSafeInteger(pr) || !Number.isSafeInteger(selfRunId)) {
      console.error(USAGE); process.exit(2);
    }
    const { lines } = collectRecovery({ repo, pr, headRepo, branch, selfRunId, store, storeKey: flag('store-key'),
      mode: flag('mode') === 'dispatch' ? 'dispatch' : 'pr', budgetMs: Number(flag('budget-seconds') ?? '60') * 1000 });
    console.log('### Receipt recovery');
    for (const line of lines) console.log(`- ${line}`);
  } else { console.error(USAGE); process.exit(2); }
}
