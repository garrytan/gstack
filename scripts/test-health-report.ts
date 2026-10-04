#!/usr/bin/env bun
/**
 * test:health — the audit's success metrics as one command, read from CI
 * history (scripts/lib/ci-history.ts, the same reader pass-rates uses) plus
 * the local tree. Every metric prints its counting rule; a metric whose input
 * cannot be read prints "unavailable: <reason>; next: <step>", never 0.
 *
 * Enforced checks (`--enforce`): a free test file that flakes in more than 5%
 * of main free-tests runs over a window of at least 20 runs (W7a), and more
 * than 5 free test files missing from scripts/free-test-durations.json
 * (CEO-10). Without `--enforce` the command always exits 0; an unavailable
 * check never fails it. Needs `gh` with read access to the repository.
 *
 * Usage:
 *   bun run test:health [--since-days 7] [--json] [--enforce] [--summary <file>]
 *                       [--repo owner/name] [--complexity-base <ref>]
 *   bun run test:health flake-summary <dir>   # job-summary table of downloaded flake-ledger-* artifacts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GH_CLIENT, downloadRunArtifacts, formatFlakeSummary, historyFetcher, listRunJobs, listWorkflowRuns, readCiFlakeLedgers,
  readFlakeLedgerDir, repoSlug, unavailableReason, type CiRun, type FlakeWindow, type GhClient } from './lib/ci-history';
import { analyzePassRates, readTrialOutcomeDir, type TrialRecord } from './eval-flake-rank';
import { collectFreeTestFiles, loadFreeTestDurations, unseededFreeFiles } from './test-free-shards';
import { EVAL_POLICY } from '../test/helpers/periodic-exclude-data';
import { resolveStateRoot } from '../lib/state-root';

const ROOT = path.resolve(import.meta.dir, '..');
export const UNSEEDED_LIMIT = 5;
export const COMPLEXITY_PATHS = ['scripts', 'test/helpers', '.github/workflows'] as const;

export interface Metric { id: string; title: string; rule: string; value?: string; detail?: string[]; unavailable?: string }
export interface Check { id: string; title: string; status: 'pass' | 'fail' | 'unavailable'; detail: string; fix: string }
export type IssueAction = 'upsert' | 'keep-open' | 'close';
export interface HealthReport { repo: string; sinceDays: number; generatedAt: string; metrics: Metric[]; checks: Check[]; issueAction: IssueAction }

export interface HealthInputs {
  client: GhClient;
  repo: string;
  now: number;
  sinceDays: number;
  cacheDir: string;
  root?: string;
  complexityBase?: string;
}

// --- Pure arithmetic ---

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function choose(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

/** P(fewer than k of n independent trials pass) when one trial fails with probability `failRate`. */
export function panelRedProbability(failRate: number, n: number, k: number): number {
  let red = 0;
  for (let passes = 0; passes < k; passes++) red += choose(n, passes) * (1 - failRate) ** passes * failRate ** (n - passes);
  return red;
}

export interface CensusStats {
  runs: number;
  trials: number;
  failed: number;
  byKind: Record<string, { trials: number; failed: number }>;
  byClass: Record<string, number>;
  /** P(lane red) with each case's pooled trial failure rate, under the recorded panels. */
  redInForce: number;
  /** The same evidence with every case judged on one trial. */
  redSingleTrial: number;
}

/**
 * CEO-06/22 census arithmetic over one lane's trial records. Every observed
 * failure is treated as nondeterminism, so both red probabilities are upper
 * bounds for known-good inputs; they are reported separately from the raw
 * trial failure rate so a verdict-policy change cannot read as a reliability gain.
 */
export function censusStats(records: TrialRecord[], runIds: string[]): CensusStats {
  const scored = records.filter(record => record.outcome !== 'skipped');
  const byKind: CensusStats['byKind'] = {};
  const byClass: Record<string, number> = {};
  const perCase = new Map<string, { trials: number; failed: number; n: number; k: number }>();
  for (const record of scored) {
    const failed = record.outcome === 'failed';
    const kind = (byKind[record.kind] ??= { trials: 0, failed: 0 });
    kind.trials += 1;
    if (failed) { kind.failed += 1; byClass[record.failure_class ?? 'unknown'] = (byClass[record.failure_class ?? 'unknown'] ?? 0) + 1; }
    const slot = perCase.get(record.case) ?? { trials: 0, failed: 0, n: 1, k: 1 };
    slot.trials += 1;
    if (failed) slot.failed += 1;
    if (record.panel.n > slot.n) { slot.n = record.panel.n; slot.k = record.panel.k; }
    perCase.set(record.case, slot);
  }
  let greenInForce = 1, greenSingle = 1;
  for (const slot of perCase.values()) {
    const p = slot.failed / slot.trials;
    greenInForce *= 1 - panelRedProbability(p, slot.n, slot.k);
    greenSingle *= 1 - p;
  }
  return { runs: runIds.length, trials: scored.length, failed: scored.filter(record => record.outcome === 'failed').length,
    byKind, byClass, redInForce: 1 - greenInForce, redSingleTrial: 1 - greenSingle };
}

const pct = (value: number) => `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
const minutes = (ms: number | null) => ms === null ? 'n/a' : `${(ms / 60_000).toFixed(1)} min`;
const span = (from: string | null, to: string | null) => from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : null;

/** DX-9: close only when every enforced check has evidence and passes; missing evidence keeps the issue open. */
export function issueActionFor(checks: Check[]): IssueAction {
  if (checks.some(check => check.status === 'fail')) return 'upsert';
  if (checks.some(check => check.status === 'unavailable')) return 'keep-open';
  return 'close';
}

// --- Checks ---

export function flakeCheck(window: FlakeWindow | Error): Check {
  const base = { id: 'flaky-files', title: 'Free-suite flaky files (W7a)',
    fix: 'Fix the race at source (docs/TESTING_INTERNALS.md#flake-ledger); never raise the timeout or add a retry. Reproduce with `bun test <file>` under load.' };
  if (window instanceof Error) return { ...base, status: 'unavailable', detail: `unavailable: ${unavailableReason(window)}` };
  const failing = window.files.filter(file => file.failing);
  if (!window.enforceable) {
    return { ...base, status: 'pass', detail: `report-only: ${window.runs} main run(s) since ${window.since.slice(0, 10)} (< 20 needed to enforce)` };
  }
  if (failing.length === 0) return { ...base, status: 'pass', detail: `no file above 5% over ${window.runs} main runs` };
  return { ...base, status: 'fail',
    detail: failing.map(file => `${file.file}: flaky in ${file.flakyRuns}/${window.runs} main runs (${pct(file.rate)} > 5%)`).join('; ') };
}

export function unseededCheck(root: string): Check {
  const base = { id: 'unseeded-free-files', title: 'Free test files missing from the duration seed (CEO-10)',
    fix: 'Refresh the seed: `bun run test:ubicloud --record-durations` (or a CI recording; a 4-core laptop recording is not acceptable), then commit scripts/free-test-durations.json (docs/TESTING_INTERNALS.md#duration-seed).' };
  const durations = loadFreeTestDurations(root);
  if (!durations) return { ...base, status: 'unavailable', detail: 'unavailable: scripts/free-test-durations.json is missing or unreadable; next: refresh the seed' };
  const unseeded = unseededFreeFiles(collectFreeTestFiles(root), durations);
  const shown = unseeded.slice(0, 10).join(', ') + (unseeded.length > 10 ? `, +${unseeded.length - 10} more` : '');
  if (unseeded.length > UNSEEDED_LIMIT) return { ...base, status: 'fail', detail: `stale seed: ${unseeded.length} unseeded file(s) > ${UNSEEDED_LIMIT}: ${shown}` };
  return { ...base, status: 'pass', detail: `${unseeded.length} unseeded file(s) (limit ${UNSEEDED_LIMIT})${unseeded.length ? `: ${shown}` : ''}` };
}

// --- Metric collection ---

function attempt<T>(fn: () => T): T | Error {
  try { return fn(); } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

function metric(id: string, title: string, rule: string, compute: () => { value: string; detail?: string[] }): Metric {
  const result = attempt(compute);
  if (result instanceof Error) return { id, title, rule, unavailable: unavailableReason(result) };
  return { id, title, rule, ...result };
}

function records(dirs: string[]): TrialRecord[] {
  return dirs.flatMap(dir => readTrialOutcomeDir(dir).records);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Net LOC under COMPLEXITY_PATHS and the package-script count at one ref. */
export function complexityAt(root: string, ref: string): { loc: number; scripts: number } {
  const grep = spawnSync('git', ['grep', '-c', '-I', '', ref, '--', ...COMPLEXITY_PATHS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`git grep ${ref} failed: ${grep.stderr.trim()}`);
  const loc = grep.stdout.split('\n').filter(Boolean).reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(':') + 1) || 0), 0);
  const pkg = spawnSync('git', ['show', `${ref}:package.json`], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (pkg.status !== 0) throw new Error(`git show ${ref}:package.json failed: ${pkg.stderr.trim()}`);
  return { loc, scripts: Object.keys(JSON.parse(pkg.stdout).scripts ?? {}).length };
}

export function collectHealth(inputs: HealthInputs): HealthReport {
  const { client, repo, now, sinceDays, cacheDir } = inputs;
  const root = inputs.root ?? ROOT;
  const since = new Date(now - sinceDays * 86_400_000).toISOString();
  const fetcher = historyFetcher(client);
  const artifactDirs = (run: CiRun, match: (name: string) => boolean) =>
    downloadRunArtifacts({ repo, run, cacheDir, fetcher, match, maxBytes: 64 * 1024 * 1024 });
  const prRuns = attempt(() => listWorkflowRuns(client, repo, 'evals.yml', { since, event: 'pull_request' }));
  const need = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };
  const prRecords = attempt(() => need(prRuns).filter(run => run.conclusion !== 'cancelled')
    .map(run => ({ run, trials: records(artifactDirs(run, name => name.startsWith('trial-outcomes'))) })));
  const metrics: Metric[] = [];

  metrics.push(metric('pr-fallback-rate', 'PR full-fallback rate', 'share of evals.yml pull_request runs whose paid-plan manifest has prCoverage.mode = full-fallback', () => {
    const modes = new Map<string, number>();
    for (const run of need(prRuns)) {
      const manifest = artifactDirs(run, name => name === 'paid-plan').flatMap(dir => [path.join(dir, 'manifest.json')]).find(file => fs.existsSync(file));
      if (!manifest) continue;
      const mode = String(readJson(manifest).prCoverage?.mode ?? 'none');
      modes.set(mode, (modes.get(mode) ?? 0) + 1);
    }
    const total = [...modes.values()].reduce((a, b) => a + b, 0);
    if (total === 0) throw new Error('no paid-plan manifests in the window');
    return { value: `${pct((modes.get('full-fallback') ?? 0) / total)} (${modes.get('full-fallback') ?? 0}/${total} runs)`,
      detail: [...modes].map(([mode, count]) => `${mode}: ${count}`) };
  }));

  metrics.push(metric('pr-reused-trials', 'Reused PR trial records', 'trial-outcomes records with execution = reused across non-cancelled PR runs', () => {
    const all = need(prRecords).flatMap(entry => entry.trials);
    const reused = all.filter(record => record.execution === 'reused').length;
    return { value: `${reused} of ${all.length} trial records` };
  }));

  metrics.push(metric('pr-spend', 'Recorded PR-lane spend', 'sum of executed trial cost_usd in PR runs; per merged PR = / PRs merged in the window; per validated revision = / distinct head SHAs with a success or failure verdict', () => {
    const entries = need(prRecords);
    const spend = entries.flatMap(entry => entry.trials).filter(record => record.execution === 'executed')
      .reduce((sum, record) => sum + record.cost_usd, 0);
    const revisions = new Set(entries.filter(entry => entry.run.conclusion === 'success' || entry.run.conclusion === 'failure').map(entry => entry.run.sha)).size;
    const merged = listMergedPulls(client, repo, since);
    return { value: `$${spend.toFixed(2)} recorded`, detail: [
      `per merged PR: ${merged ? `$${(spend / merged).toFixed(2)} (${merged} merged)` : 'n/a (0 merged)'}`,
      `per validated revision: ${revisions ? `$${(spend / revisions).toFixed(2)} (${revisions} revisions)` : 'n/a'}`] };
  }));

  metrics.push(metric('cancelled-slice-minutes', 'Cancelled slice-minutes per week', 'wall minutes of eval-slices jobs in cancelled evals.yml PR runs, scaled to 7 days', () => {
    const cancelled = need(prRuns).filter(run => run.conclusion === 'cancelled');
    const total = cancelled.flatMap(run => listRunJobs(client, repo, run.id, run.attempt))
      .filter(job => job.name.startsWith('eval-slices')).reduce((sum, job) => sum + (span(job.startedAt, job.completedAt) ?? 0), 0);
    return { value: `${(total / 60_000 * 7 / sinceDays).toFixed(0)} min/week (${cancelled.length} cancelled run(s))` };
  }));

  metrics.push(metric('push-to-verdict', 'PR lane push-to-verdict', 'created_at to updated_at of evals.yml pull_request runs that reached success or failure (includes queue and debounce)', () => {
    const walls = need(prRuns).filter(run => run.conclusion === 'success' || run.conclusion === 'failure').map(run => span(run.createdAt, run.updatedAt)!);
    if (walls.length === 0) throw new Error('no PR run reached a verdict in the window');
    return { value: `p50 ${minutes(percentile(walls, 0.5))}, p95 ${minutes(percentile(walls, 0.95))} (${walls.length} runs)` };
  }));

  metrics.push(...censusMetrics(inputs, artifactDirs));

  const flakes = attempt(() => readCiFlakeLedgers({ client, repo, sinceDays, now, cacheDir }));
  metrics.push(metric('free-flaky-pass-rate', 'Free-suite flaky-pass rate', 'share of main free-tests runs (success or failure) with at least one flaky-pass ledger entry; per-file rate = runs with that file / runs', () => {
    const window = need(flakes);
    return { value: `${pct(window.runs ? window.flakyRuns / window.runs : 0)} (${window.flakyRuns}/${window.runs} main runs since ${window.since.slice(0, 10)} needed the retry pass; ${window.files.length} file(s))`,
      detail: window.files.slice(0, 15).map(file => `${file.file}: ${file.flakyRuns}/${window.runs} runs (${pct(file.rate)})${file.failing ? ' FAIL > 5%' : ''}`) };
  }));

  metrics.push(metric('free-wall', 'Free-suite and Windows wall', 'p50 of run_started_at to updated_at for successful main runs of free-tests.yml and windows-free-tests.yml', () => {
    const wall = (workflow: string) => {
      const walls = listWorkflowRuns(client, repo, workflow, { since, branch: 'main' }).filter(run => run.conclusion === 'success').map(run => span(run.startedAt, run.updatedAt)!);
      return `${minutes(percentile(walls, 0.5))} (${walls.length} runs)`;
    };
    return { value: `free-tests ${wall('free-tests.yml')}; windows-free-tests ${wall('windows-free-tests.yml')}` };
  }));

  metrics.push(metric('free-serial', 'Free-suite serial time', 'sum of scripts/free-test-durations.json (the committed seed)', () => {
    const durations = loadFreeTestDurations(root);
    if (!durations) throw new Error('scripts/free-test-durations.json is missing or unreadable');
    return { value: `${Math.round(Object.values(durations).reduce((a, b) => a + b, 0) / 1000)} s over ${Object.keys(durations).length} files` };
  }));

  metrics.push(metric('net-complexity', 'Net complexity (CEO-32, reported, no target)', `lines under ${COMPLEXITY_PATHS.join(', ')} and package.json script count, HEAD vs --complexity-base`, () => {
    const head = complexityAt(root, 'HEAD');
    if (!inputs.complexityBase) return { value: `HEAD: ${head.loc} lines, ${head.scripts} package scripts (pass --complexity-base <ref> for the delta)` };
    const base = complexityAt(root, inputs.complexityBase);
    const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    return { value: `${sign(head.loc - base.loc)} lines (${base.loc} -> ${head.loc}), ${sign(head.scripts - base.scripts)} package scripts (${base.scripts} -> ${head.scripts}) vs ${inputs.complexityBase}` };
  }));

  const checks = [flakeCheck(flakes), unseededCheck(root)];
  return { repo, sinceDays, generatedAt: new Date(now).toISOString(), metrics, checks, issueAction: issueActionFor(checks) };
}

function listMergedPulls(client: GhClient, repo: string, since: string): number {
  let merged = 0;
  for (let page = 1; page <= 10; page++) {
    const pulls = client.getJson(`repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`) as any[];
    if (!Array.isArray(pulls)) throw new Error('pulls listing returned no array');
    merged += pulls.filter(pull => pull.merged_at && String(pull.merged_at) >= since).length;
    if (pulls.length < 100 || pulls.every(pull => String(pull.updated_at) < since)) break;
  }
  return merged;
}

/**
 * Census metrics from main's evals-periodic history (scheduled runs plus main
 * dispatches, the W4b weekly history): CEO-06/22 per lane over the trailing 4
 * scheduled censuses, the INFRA re-dispatch count, slice wall, and DX-12
 * quarantine evidence (qualifying vs required trials) over the last 10 runs.
 */
function censusMetrics(inputs: HealthInputs, artifactDirs: (run: CiRun, match: (name: string) => boolean) => string[]): Metric[] {
  const { client, repo, now } = inputs;
  const history = attempt(() => listWorkflowRuns(client, repo, 'evals-periodic.yml',
    { since: new Date(now - Math.max(inputs.sinceDays, 84) * 86_400_000).toISOString(), branch: 'main' })
    .filter(run => run.event === 'schedule' || run.event === 'workflow_dispatch'));
  const need = <T>(value: T | Error): T => { if (value instanceof Error) throw value; return value; };
  const censuses = attempt(() => {
    const out: { run: CiRun; trials: TrialRecord[] }[] = [];
    for (const run of need(history)) {
      if (out.length === 4) break;
      const trials = records(artifactDirs(run, name => name.startsWith('trial-outcomes')));
      if (trials.length) out.push({ run, trials });
    }
    return out;
  });
  const out: Metric[] = [];
  for (const lane of ['periodic', 'gate'] as const) {
    out.push(metric(`census-${lane}`, `${lane === 'gate' ? 'Gate' : 'Periodic'} census reliability (CEO-06/22)`,
      'trailing 4 main censuses with trial outcomes (scheduled runs and main dispatches): expected failed trials per run, raw trial failure rate per kind and class, and P(lane red) from pooled per-case rates under the recorded panels vs single-trial aggregation (every failure treated as nondeterminism: upper bounds for known-good inputs)', () => {
        const runs = need(censuses);
        const laneRuns = runs.filter(entry => entry.trials.some(record => (record.lane ?? '').startsWith(`${lane}/`)));
        if (laneRuns.length === 0) throw new Error(`no main census with ${lane} trial outcomes in the last 84 days`);
        const stats = censusStats(laneRuns.flatMap(entry => entry.trials).filter(record => (record.lane ?? '').startsWith(`${lane}/`)), laneRuns.map(entry => `${entry.run.id}`));
        return { value: `${(stats.failed / stats.runs).toFixed(2)} expected failed trials/run (${stats.failed}/${stats.trials} over ${stats.runs} run(s)); P(red) ${pct(stats.redInForce)} in force, ${pct(stats.redSingleTrial)} single-trial`,
          detail: [...Object.entries(stats.byKind).map(([kind, slot]) => `kind ${kind}: ${slot.failed}/${slot.trials} failed (${pct(slot.failed / Math.max(1, slot.trials))})`),
            ...Object.entries(stats.byClass).map(([cls, count]) => `class ${cls}: ${count}`)] };
      }));
  }
  out.push(metric('census-redispatch', 'INFRA re-dispatches (ENG-10)', 'trailing 4 main census runs whose redispatch job succeeded; longest paid slice job wall in the same runs', () => {
    const runs = need(history).slice(0, 4);
    const jobs = runs.map(run => listRunJobs(client, repo, run.id, run.attempt));
    const redispatched = jobs.filter(list => list.some(job => job.name === 'redispatch' && job.conclusion === 'success')).length;
    const walls = jobs.flat().filter(job => /^(eval-slices|eval-codex-slices|gate-census)/.test(job.name)).map(job => span(job.startedAt, job.completedAt) ?? 0);
    return { value: `${redispatched} of ${runs.length} census(es) re-dispatched; longest paid slice job ${minutes(walls.length ? Math.max(...walls) : null)}` };
  }));
  out.push(metric('quarantine-evidence', 'Quarantine evidence (DX-12)', `blocking cases with >= ${EVAL_POLICY.quarantine.entry.minTrials} qualifying v${EVAL_POLICY.version} trials on their current series, over the last 10 main census runs`, () => {
    const runs = need(history).slice(0, 10);
    const report = analyzePassRates(runs.flatMap(run => records(artifactDirs(run, name => name.startsWith('trial-outcomes')))), { weeklyRuns: runs.map(run => run.createdAt) });
    const blocking = report.cases.filter(entry => entry.tier === 'gate' || entry.tier === 'periodic');
    const sufficient = blocking.filter(entry => (entry.current?.trials ?? 0) >= EVAL_POLICY.quarantine.entry.minTrials);
    const labels = new Map<string, number>();
    for (const entry of sufficient) labels.set(entry.label, (labels.get(entry.label) ?? 0) + 1);
    return { value: `${sufficient.length} of ${blocking.length} blocking case(s) have enough evidence; ${blocking.length - sufficient.length} insufficient evidence (not the same as healthy)`,
      detail: [...[...labels].map(([label, count]) => `${label}: ${count}`),
        ...(report.newerPolicyTrials ? [`ignored ${report.newerPolicyTrials} newer-policy trial(s)`] : []),
        ...(report.olderPolicyTrials ? [`${report.olderPolicyTrials} older-policy trial(s) display only`] : [])] };
  }));
  return out;
}

// --- Rendering ---

export function formatHealth(report: HealthReport): string {
  const lines = [`test:health ${report.repo}, last ${report.sinceDays} day(s), ${report.generatedAt}`];
  for (const entry of report.metrics) {
    lines.push(`- ${entry.title}: ${entry.unavailable ? `unavailable: ${entry.unavailable}` : entry.value}`);
    lines.push(`    rule: ${entry.rule}`);
    for (const detail of entry.detail ?? []) lines.push(`    ${detail}`);
  }
  lines.push('Enforced checks:');
  for (const check of report.checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.title}: ${check.detail}`);
    if (check.status !== 'pass') lines.push(`    fix: ${check.fix}`);
  }
  const unavailable = report.checks.filter(check => check.status === 'unavailable').map(check => check.id);
  if (unavailable.length) lines.push(`Missing inputs (an unavailable check never fails the run, and keeps a tracking issue open): ${unavailable.join(', ')}`);
  return lines.join('\n');
}

export function formatHealthMarkdown(report: HealthReport): string {
  return ['## test:health', '', '```', formatHealth(report), '```', ''].join('\n');
}

export const HELP = `Usage: bun run test:health [options]
       bun run test:health flake-summary <dir>

Prints the test/eval/CI success metrics from GitHub Actions history (needs gh
with read access to the repository; \`gh auth status\` checks it). A metric whose
input cannot be read prints "unavailable: <reason>; next: <step>", never 0.

Options:
  --since-days <n>        window in days (default 7)
  --enforce               exit 1 when an enforced check fails (flaky file > 5% of
                          >= 20 main free-tests runs; > 5 unseeded free files);
                          without it the command always exits 0
  --json                  machine-readable report (includes issueAction)
  --summary <file>        append a markdown report (job summary / issue body)
  --repo <owner/name>     repository (default: origin)
  --complexity-base <ref> report the net-complexity delta against <ref>
  --help                  this text

flake-summary <dir>       markdown table of the flake-ledger-* artifacts under <dir>`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(0); }
  if (argv[0] === 'flake-summary') {
    if (!argv[1]) { console.error('usage: bun run test:health flake-summary <dir>'); process.exit(2); }
    console.log(formatFlakeSummary(readFlakeLedgerDir(argv[1])));
    process.exit(0);
  }
  const valued = new Set(['--since-days', '--summary', '--repo', '--complexity-base']);
  const known = new Set([...valued, '--enforce', '--json']);
  for (let index = 0; index < argv.length; index++) {
    if (!known.has(argv[index]!)) { console.error(`test:health: unknown argument ${argv[index]}\n\n${HELP}`); process.exit(2); }
    if (valued.has(argv[index]!)) {
      if (argv[index + 1] === undefined || argv[index + 1]!.startsWith('--')) { console.error(`test:health: ${argv[index]} needs a value`); process.exit(2); }
      index++;
    }
  }
  const flag = (name: string) => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
  const sinceDays = Number(flag('--since-days') ?? 7);
  if (!Number.isInteger(sinceDays) || sinceDays < 1) { console.error('test:health: --since-days must be a positive integer'); process.exit(2); }
  const repo = flag('--repo') ?? repoSlug(ROOT);
  const cacheDir = path.join(path.resolve(resolveStateRoot()), 'test-health-cache', repo.replace('/', '-'));
  const report = collectHealth({ client: GH_CLIENT, repo, now: Date.now(), sinceDays, cacheDir, complexityBase: flag('--complexity-base') });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatHealth(report));
  const summary = flag('--summary');
  if (summary) fs.appendFileSync(summary, formatHealthMarkdown(report));
  if (argv.includes('--enforce') && report.checks.some(check => check.status === 'fail')) process.exit(1);
}
