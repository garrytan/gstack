/**
 * The one reader of GitHub Actions history: run lists, run jobs, artifact
 * downloads and the free lane's CI flake ledgers. `scripts/eval-flake-rank.ts`
 * (pass-rates) and `scripts/test-health-report.ts` (test:health) both read CI
 * history through this module; every call goes through an injectable client so
 * the free tests never touch the network.
 *
 * Downloads are data only: artifacts are size-capped, name-checked and parsed,
 * never executed. A failed call throws; callers that report metrics turn the
 * error into a named "unavailable: <reason>" with `unavailableReason`, never 0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FlakeLedgerEntry } from '../test-free-shards';

// --- Clients ---

export interface WeeklyRun { id: number; attempt: number; sha: string; branch: string; createdAt: string; event?: string }
export interface RunArtifact { id: number; name: string; size: number }

/** The GitHub calls pass-rates makes; injectable so the free tests never touch the network. */
export interface HistoryFetcher {
  listRuns(repo: string, workflow: string, branch: string, limit: number): WeeklyRun[];
  listArtifacts(repo: string, runId: number): RunArtifact[];
  downloadZip(repo: string, artifactId: number, destination: string): void;
}

/** One GitHub REST page as parsed JSON, plus artifact zip downloads. */
export interface GhClient {
  getJson(apiPath: string): unknown;
  downloadZip(repo: string, artifactId: number, destination: string): void;
}

/** Per-file cap for downloaded artifacts: CI history is parsed as data only, never executed. */
export const TRIAL_OUTCOMES_MAX_BYTES = 8 * 1024 * 1024;

function gh(args: string[]): Buffer {
  const result = spawnSync('gh', args, { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr || result.error || '').trim()}`);
  return result.stdout;
}

function jsonLines<T>(buffer: Buffer): T[] {
  return buffer.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

export const GH_CLIENT: GhClient = {
  getJson: (apiPath) => JSON.parse(gh(['api', apiPath]).toString('utf8')),
  downloadZip: (repo, artifactId, destination) => fs.writeFileSync(destination, gh(['api', `repos/${repo}/actions/artifacts/${artifactId}/zip`])),
};

export const GH_HISTORY: HistoryFetcher = {
  listRuns: (repo, workflow, branch, limit): WeeklyRun[] => jsonLines(gh(['api',
    `repos/${repo}/actions/workflows/${workflow}/runs?${branch ? `branch=${encodeURIComponent(branch)}&` : ''}status=completed&per_page=${limit}`,
    '--jq', '.workflow_runs[] | {id, attempt: .run_attempt, sha: .head_sha, branch: .head_branch, createdAt: .created_at, event}'])),
  listArtifacts: (repo, runId): RunArtifact[] => jsonLines(gh(['api', `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    '--paginate', '--jq', '.artifacts[] | select(.expired | not) | {id, name, size: .size_in_bytes}'])),
  downloadZip: GH_CLIENT.downloadZip,
};

/**
 * A named reason plus the next step for a failed GitHub read (DX-6): rate
 * limits, server errors, auth and a missing CLI each say what to do next.
 */
export function unavailableReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  if (/rate limit|secondary rate|abuse detection/i.test(message)) {
    return `GitHub API rate limit (${message.slice(0, 160)}); next: \`gh api rate_limit --jq .resources.core.reset\` gives the reset time, rerun after it`;
  }
  if (/HTTP 5\d\d|\b50[0234]\b|bad gateway|service unavailable|gateway time-?out/i.test(message)) {
    return `GitHub API server error (${message.slice(0, 160)}); next: rerun later, the history is unchanged`;
  }
  if (/ENOENT|not found: gh|command not found/i.test(message)) {
    return 'gh CLI not installed; next: install it (https://cli.github.com) and run `gh auth login`';
  }
  if (/HTTP 401|HTTP 403|auth|not logged|credentials/i.test(message)) {
    return `gh cannot read this repository (${message.slice(0, 160)}); next: \`gh auth status\` and \`gh auth login\` with repo read access`;
  }
  if (/HTTP 404|not found/i.test(message)) {
    return `not found (${message.slice(0, 160)}); next: check --repo and that the workflow or artifact still exists (artifacts expire)`;
  }
  return `${message.slice(0, 200) || 'unknown error'}; next: fix the input named above, then rerun`;
}

// --- Runs, jobs and artifacts ---

export interface CiRun {
  id: number; attempt: number; sha: string; branch: string; event: string;
  status: string; conclusion: string | null; createdAt: string; updatedAt: string; startedAt: string;
  prNumbers: number[];
}

export interface CiJob { id: number; name: string; conclusion: string | null; startedAt: string | null; completedAt: string | null }

const PAGE = 100;

/**
 * Every completed run of `workflow` created at or after `since`, newest first,
 * paging until a page is short or older than `since`. A failure on any page
 * throws: a partial history is never reported as a complete one.
 */
export function listWorkflowRuns(client: GhClient, repo: string, workflow: string,
  opts: { since: string; branch?: string; event?: string; maxPages?: number }): CiRun[] {
  const out: CiRun[] = [];
  const query = [`status=completed`, `per_page=${PAGE}`, `created=${encodeURIComponent(`>=${opts.since.slice(0, 10)}`)}`,
    ...(opts.branch ? [`branch=${encodeURIComponent(opts.branch)}`] : []), ...(opts.event ? [`event=${encodeURIComponent(opts.event)}`] : [])];
  for (let page = 1; page <= (opts.maxPages ?? 20); page++) {
    const body = client.getJson(`repos/${repo}/actions/workflows/${workflow}/runs?${query.join('&')}&page=${page}`) as { workflow_runs?: any[] };
    const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    for (const run of runs) {
      if (String(run.created_at) < opts.since) continue;
      if ((opts.branch && run.head_branch !== opts.branch) || (opts.event && run.event !== opts.event)) continue;
      out.push({ id: Number(run.id), attempt: Number(run.run_attempt ?? 1), sha: String(run.head_sha ?? ''), branch: String(run.head_branch ?? ''),
        event: String(run.event ?? ''), status: String(run.status ?? ''), conclusion: run.conclusion ?? null,
        createdAt: String(run.created_at ?? ''), updatedAt: String(run.updated_at ?? ''), startedAt: String(run.run_started_at ?? run.created_at ?? ''),
        prNumbers: Array.isArray(run.pull_requests) ? run.pull_requests.map((pr: any) => Number(pr.number)).filter(Number.isFinite) : [] });
    }
    if (runs.length < PAGE) break;
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every job of one run attempt (all pages). */
export function listRunJobs(client: GhClient, repo: string, runId: number, attempt = 1): CiJob[] {
  const out: CiJob[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = client.getJson(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE}&page=${page}`) as { jobs?: any[] };
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    out.push(...jobs.map(job => ({ id: Number(job.id), name: String(job.name ?? ''), conclusion: job.conclusion ?? null,
      startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null })));
    if (jobs.length < PAGE) break;
  }
  return out;
}

/** Unexpired artifacts of one run (all pages). */
export function listRunArtifacts(client: GhClient, repo: string, runId: number): RunArtifact[] {
  const out: RunArtifact[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = client.getJson(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=${PAGE}&page=${page}`) as { artifacts?: any[] };
    const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
    out.push(...artifacts.filter(artifact => !artifact.expired)
      .map(artifact => ({ id: Number(artifact.id), name: String(artifact.name ?? ''), size: Number(artifact.size_in_bytes ?? 0) })));
    if (artifacts.length < PAGE) break;
  }
  return out;
}

/** A HistoryFetcher over a GhClient (artifact listings memoized per run), so downloads share one cache and one parser. */
export function historyFetcher(client: GhClient): HistoryFetcher {
  const artifacts = new Map<string, RunArtifact[]>();
  return {
    listRuns: (repo, workflow, branch, limit) => listWorkflowRuns(client, repo, workflow, { since: '1970-01-01', branch, maxPages: 1 })
      .slice(0, limit).map(run => ({ id: run.id, attempt: run.attempt, sha: run.sha, branch: run.branch, createdAt: run.createdAt, event: run.event })),
    listArtifacts: (repo, runId) => {
      const key = `${repo}#${runId}`;
      if (!artifacts.has(key)) artifacts.set(key, listRunArtifacts(client, repo, runId));
      return artifacts.get(key)!;
    },
    downloadZip: (repo, artifactId, destination) => client.downloadZip(repo, artifactId, destination),
  };
}

/**
 * EVAL_POLICY v2 weekly history (W4b): scheduled runs on main plus main
 * dispatches, never a branch dispatch, so back-to-back validation runs on a
 * branch neither feed pass rates nor count as weeks for quarantine expiry.
 */
export function isWeeklyHistoryRun(run: Pick<WeeklyRun, 'branch' | 'event'>): boolean {
  return run.branch === 'main' && (run.event === 'schedule' || run.event === 'workflow_dispatch');
}

/**
 * Branch census runs whose trials may pool into a case's main series (D1
 * option b, approved 2026-10-05): any completed non-main run of the census
 * workflow. A pooled trial counts only toward a series main has also run
 * (same case-owned bytes, HARNESS_VERSION, model and CLI); weeks for
 * quarantine expiry still come from isWeeklyHistoryRun alone.
 */
export function isPooledTrialRun(run: Pick<WeeklyRun, 'branch'>): boolean {
  return run.branch !== '' && run.branch !== 'main';
}

/** The last `limit` completed runs of `workflow` on each branch, newest first, deduplicated. */
export function listWeeklyRuns(opts: { repo: string; workflow: string; branches: string[]; limit: number; fetcher?: HistoryFetcher }): WeeklyRun[] {
  const fetcher = opts.fetcher ?? GH_HISTORY;
  const runs = new Map<number, WeeklyRun>();
  for (const branch of opts.branches) for (const run of fetcher.listRuns(opts.repo, opts.workflow, branch, opts.limit)) runs.set(run.id, run);
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Download the artifacts of one run whose names match into a per-run cache
 * directory (reused on later calls) and return the extracted directories.
 * Oversized or oddly named artifacts are skipped: downloads are data only.
 */
export function downloadRunArtifacts(opts: { repo: string; run: Pick<WeeklyRun, 'id'>; match: (name: string) => boolean; cacheDir: string;
  fetcher?: HistoryFetcher; maxBytes?: number; artifacts?: RunArtifact[] }): string[] {
  const fetcher = opts.fetcher ?? GH_HISTORY;
  const dirs: string[] = [];
  for (const artifact of opts.artifacts ?? fetcher.listArtifacts(opts.repo, opts.run.id)) {
    if (!opts.match(artifact.name) || !/^[A-Za-z0-9._-]+$/.test(artifact.name)) continue;
    if (artifact.size > (opts.maxBytes ?? TRIAL_OUTCOMES_MAX_BYTES)) continue;
    const dir = path.join(opts.cacheDir, `${opts.run.id}`, artifact.name);
    if (!fs.existsSync(path.join(dir, '.complete'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, 'artifact.zip');
      fetcher.downloadZip(opts.repo, artifact.id, zip);
      const unzip = spawnSync('unzip', ['-o', '-q', zip, '-d', dir], { timeout: 120_000 });
      if (unzip.status !== 0) throw new Error(`unzip failed for ${artifact.name}: ${String(unzip.stderr || unzip.error || '')}`);
      fs.rmSync(zip, { force: true });
      fs.writeFileSync(path.join(dir, '.complete'), '');
    }
    dirs.push(dir);
  }
  return dirs;
}

/** Every regular file under `dir` whose basename matches, recursively. */
export function filesUnder(dir: string, match: (base: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter(name => match(path.basename(name)))
    .map(name => path.join(dir, name))
    .filter(full => fs.statSync(full).isFile());
}

// --- Free-lane flake ledgers (W7a) ---

/** Per-line parse: one torn or hand-edited JSONL line drops that line, never the file. */
export function parseFlakeLedger(text: string): FlakeLedgerEntry[] {
  const out: FlakeLedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.kind === 'flaky-pass' && typeof entry.file === 'string') out.push(entry);
    } catch { /* torn line: skip */ }
  }
  return out;
}

/** Every flaky-pass entry in the `*.jsonl` files under a directory of downloaded `flake-ledger-*` artifacts. */
export function readFlakeLedgerDir(dir: string): FlakeLedgerEntry[] {
  return filesUnder(dir, base => base.endsWith('.jsonl')).flatMap(file => parseFlakeLedger(fs.readFileSync(file, 'utf8')));
}

/** The pre-registered flaky-file rule (CEO-15): > 5% of main free-tests runs over a window of >= 20 runs. */
export const FLAKE_POLICY = { maxRate: 0.05, minRuns: 20 } as const;

export interface FlakyFile { file: string; flakyRuns: number; entries: number; rate: number; enforced: boolean; failing: boolean }
export interface FlakeWindow { runs: number; flakyRuns: number; since: string; files: FlakyFile[]; enforceable: boolean }

/**
 * Rank files by the share of runs in which they needed the retry pass. A file
 * fails only when the window holds at least `minRuns` runs and its rate is
 * strictly above `maxRate`; a thinner window is report-only.
 */
export function rankFlakyFiles(runEntries: Map<number, FlakeLedgerEntry[]>, runCount: number, since: string,
  policy: { maxRate: number; minRuns: number } = FLAKE_POLICY): FlakeWindow {
  const perFile = new Map<string, { runs: Set<number>; entries: number }>();
  for (const [runId, entries] of runEntries) for (const entry of entries) {
    const slot = perFile.get(entry.file) ?? { runs: new Set<number>(), entries: 0 };
    slot.runs.add(runId);
    slot.entries += 1;
    perFile.set(entry.file, slot);
  }
  const enforceable = runCount >= policy.minRuns;
  const files = [...perFile].map(([file, slot]) => {
    const rate = runCount ? slot.runs.size / runCount : 0;
    return { file, flakyRuns: slot.runs.size, entries: slot.entries, rate, enforced: enforceable, failing: enforceable && rate > policy.maxRate };
  }).sort((a, b) => b.rate - a.rate || a.file.localeCompare(b.file));
  return { runs: runCount, flakyRuns: runEntries.size, since, files, enforceable };
}

/**
 * Read the flake ledgers of main's completed free-tests runs: the runs created
 * in the last `sinceDays`, widened to the newest `minRuns` runs (within
 * `maxLookbackDays`) so the 5% rule has a window of at least 20 runs. A run
 * with no `flake-ledger-*` artifact had no flaky passes (the upload is skipped
 * when the ledger file does not exist).
 */
export function readCiFlakeLedgers(opts: { client: GhClient; repo: string; sinceDays: number; now: number; cacheDir: string;
  minRuns?: number; maxLookbackDays?: number; workflow?: string }): FlakeWindow {
  const minRuns = opts.minRuns ?? FLAKE_POLICY.minRuns;
  const iso = (days: number) => new Date(opts.now - days * 86_400_000).toISOString();
  const all = listWorkflowRuns(opts.client, opts.repo, opts.workflow ?? 'free-tests.yml',
    { since: iso(Math.max(opts.sinceDays, opts.maxLookbackDays ?? 60)), branch: 'main' })
    .filter(run => run.conclusion === 'success' || run.conclusion === 'failure');
  const recent = all.filter(run => run.createdAt >= iso(opts.sinceDays));
  const window = recent.length >= minRuns ? recent : all.slice(0, minRuns);
  const fetcher = historyFetcher(opts.client);
  const runEntries = new Map<number, FlakeLedgerEntry[]>();
  for (const run of window) {
    const dirs = downloadRunArtifacts({ repo: opts.repo, run, cacheDir: opts.cacheDir, fetcher, match: name => name.startsWith('flake-ledger-') });
    const entries = dirs.flatMap(readFlakeLedgerDir);
    if (entries.length) runEntries.set(run.id, entries);
  }
  return rankFlakyFiles(runEntries, window.length, window[window.length - 1]?.createdAt ?? iso(opts.sinceDays));
}

/** Markdown table of one run's merged flake ledgers, for a job summary. */
export function formatFlakeSummary(entries: FlakeLedgerEntry[]): string {
  if (entries.length === 0) return '### Free-suite flaky passes\n\nNone: every file passed on its first run.\n';
  const byFile = new Map<string, FlakeLedgerEntry[]>();
  for (const entry of entries) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  const rows = [...byFile].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([file, list]) => `| \`${file}\` | ${list.length} | ${[...new Set(list.map(entry => entry.shard).filter(shard => shard !== undefined))].join(', ') || '-'} |`);
  return ['### Free-suite flaky passes', '',
    `${entries.length} flaky pass(es) in ${byFile.size} file(s): each failed, then passed on the serial retry. They are green, not fixed.`, '',
    '| File | Flaky passes | Shard(s) |', '|---|---:|---|', ...rows, '',
    'Weekly enforcement: `bun run test:health --enforce` fails when a file flakes in more than 5% of main runs over at least 20 runs.', ''].join('\n');
}

// --- Repository ---

export function gitOutput(args: string[], cwd?: string): string | null {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 5_000, cwd });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function repoSlug(cwd?: string): string {
  const url = gitOutput(['remote', 'get-url', 'origin'], cwd) ?? '';
  return url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? 'garrytan/gstack';
}
