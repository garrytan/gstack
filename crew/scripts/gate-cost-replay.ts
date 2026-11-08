#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * gate-cost-replay — what the paid PR gate costs and what each selection
 * policy would have cost on recent merges (GSTA-49 plan lane T0). Free and
 * read-only: it downloads recorded report artifacts with `gh` into a cache,
 * replays origin/main's first-parent squash merges through the selectors in
 * this checkout, and models merge trains. Logic lives in crew/lib/gate-cost.ts.
 *
 * Usage:
 *   bun run crew/scripts/gate-cost-replay.ts --runs <id,id,...> [--since YYYY-MM-DD --until YYYY-MM-DD | --prs 3201,3202]
 *     [--ref origin/main] [--repo owner/name] [--cache .context/gate-cost-cache] [--window-days N]
 *     [--usd-per-second R]
 *     [--train-size 5] [--reps 400] [--seed 1] [--cases] [--history] [--json]
 *
 * --history (needs --since/--until) adds the red-head replay and the
 * READY-arrival train replay (crew/lib/gate-cost-history.ts): it lists the
 * window's E2E Evals and Free Tests runs and PRs, downloads report-verdict
 * and trial-outcomes artifacts of red runs, and fetches PR heads by SHA.
 *
 * --runs names complete full-gate runs (108 rule cases + 24 judges). Bare
 * dates are UTC days; --until is inclusive. Cases without a recorded cost are
 * estimated from their duration (default rate: recorded $ over recorded
 * session-seconds; --usd-per-second pins it). Screening figures are labelled
 * screen-provisional: the preamble detector is a heuristic until T2 lands.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SCREEN_LABEL, TODAY_WEEKLY_USD, AFTER_GSTA48_WEEKLY_USD, caseCostTable, changedLinesByFile, fullGateUsd, isSkillMd,
  parseEvalReport, parseTrialOutcomes, prSelectionCost, screenSelection, simulateTrains, summarizeGates, summarizeSelector, todaySelection,
  type CaseCostEntry, type GateRecord, type GateSummary, type PrDiff, type PrSelectionCost, type ScreenPolicy,
  type SelectionDeps, type SelectorSummary, type TrainModelResult,
} from '../lib/gate-cost';
import {
  STAMP_FILES, classifyReds, headGreenAt, latencySummary, parseReportVerdict, prForRun, readyTimes, screenHit, simulateArrivalTrains,
  stampFreeSignature, summarizeRedHeads, SCREEN_CANARY_CASES,
  type ArrivalTrainResult, type CheckRun, type GatedRun, type HeadDiff, type LatencySummary, type ReadyRow, type RedHeadRow, type RedHeadSummary, type RedRun,
} from '../lib/gate-cost-history';
import { GH_CLIENT, GH_HISTORY, downloadRunArtifacts, repoSlug } from '../../scripts/lib/ci-history';
import { computePaidCaseSelection } from '../../scripts/lib/paid-select';
import { packageChangeOnlyVersion } from '../../scripts/test-pr-profile';
import { E2E_TIERS, E2E_TOUCHFILES, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES, matchGlob } from '../../test/helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const DAY_MS = 86_400_000;
const ARTIFACT = /^(paid-slice-\d+|trial-outcomes[A-Za-z0-9_-]*?)-a(\d+)$/;
export const MODEL_POLICIES: ScreenPolicy[] = [
  { kind: 'all' }, { kind: 'random', fraction: 0.8 }, { kind: 'random', fraction: 0.5 },
  { kind: 'cheapest-half' }, { kind: 'expensive-half' }, { kind: 'none' },
];
export const MODEL_OUTSIDE_RED = [0.10, 0.15];

export interface ReplayArgs {
  runs: string[];
  since?: string;
  until?: string;
  prs: number[];
  ref: string;
  repo: string;
  cache: string;
  windowDays?: number;
  usdPerSecond?: number;
  trainSize: number;
  reps: number;
  seed: number;
  cases: boolean;
  history: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): ReplayArgs {
  const args: ReplayArgs = { runs: [], prs: [], ref: 'origin/main', repo: '', cache: path.join(ROOT, '.context', 'gate-cost-cache'),
    trainSize: 5, reps: 400, seed: 1, cases: false, history: false, json: false };
  const list = (value: string) => value.split(/[\s,]+/).filter(Boolean);
  const positive = (flag: string, value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got ${value}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--json') { args.json = true; continue; }
    if (flag === '--cases') { args.cases = true; continue; }
    if (flag === '--history') { args.history = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--runs') args.runs.push(...list(value));
    else if (flag === '--prs') args.prs.push(...list(value).map(pr => Number(pr.replace(/^#/, ''))));
    else if (flag === '--since') args.since = value;
    else if (flag === '--until') args.until = value;
    else if (flag === '--ref') args.ref = value;
    else if (flag === '--repo') args.repo = value;
    else if (flag === '--cache') args.cache = path.resolve(value);
    else if (flag === '--window-days') args.windowDays = positive(flag, value);
    else if (flag === '--usd-per-second') args.usdPerSecond = positive(flag, value);
    else if (flag === '--train-size') args.trainSize = Math.round(positive(flag, value));
    else if (flag === '--reps') args.reps = Math.round(positive(flag, value));
    else if (flag === '--seed') args.seed = Math.round(Number(value));
    else throw new Error(`unknown flag ${flag}`);
  }
  if (args.runs.length === 0) throw new Error('--runs <id,...> is required: the full-gate runs whose recorded costs price every case');
  if (args.runs.some(run => !/^\d+$/.test(run))) throw new Error('--runs takes numeric GitHub Actions run ids');
  if (args.prs.some(pr => !Number.isInteger(pr) || pr <= 0)) throw new Error('--prs takes PR numbers');
  if (args.prs.length && (args.since || args.until)) throw new Error('use either --prs or --since/--until, not both');
  if (!!args.since !== !!args.until) throw new Error('--since and --until go together');
  if (args.history && !args.since) throw new Error('--history needs a window: --since and --until');
  return args;
}

/** A bare date is a UTC day; `end` makes it inclusive (the next midnight). */
export function parseWindowDate(value: string, end: boolean): Date {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(bare ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`not a date: ${value}`);
  return bare && end ? new Date(date.getTime() + DAY_MS) : date;
}

function git(args: string[], timeout = 60_000): string {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${String(result.stderr || result.error || '').trim()}`);
  return result.stdout;
}

// --- Artifacts ---

/** Download a run's paid-slice and trial-outcomes artifacts once; a run with a .complete marker never calls gh again. */
export function fetchRun(runId: string, cacheDir: string, repo: string): string {
  const dir = path.join(cacheDir, runId);
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  downloadRunArtifacts({ repo, run: { id: Number(runId) }, cacheDir, match: name => ARTIFACT.test(name), maxBytes: 512 * 1024 * 1024, fetcher: GH_HISTORY });
  fs.writeFileSync(path.join(dir, '.complete'), '');
  return dir;
}

/** One run directory -> GateRecord, reading only each artifact's highest attempt. */
export function readGateRecord(runDir: string, runId = path.basename(runDir)): GateRecord {
  const latest = new Map<string, { name: string; attempt: number }>();
  for (const name of fs.existsSync(runDir) ? fs.readdirSync(runDir) : []) {
    const match = name.match(ARTIFACT);
    if (!match || (latest.get(match[1]!)?.attempt ?? 0) >= Number(match[2])) continue;
    latest.set(match[1]!, { name, attempt: Number(match[2]) });
  }
  const gate: GateRecord = { runId, tests: [], trials: [] };
  for (const { name } of [...latest.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const artifact = path.join(runDir, name);
    if (name.startsWith('trial-outcomes')) {
      const file = path.join(artifact, 'trial-outcomes.jsonl');
      if (fs.existsSync(file)) gate.trials.push(...parseTrialOutcomes(fs.readFileSync(file, 'utf8')));
      continue;
    }
    const shards = path.join(artifact, 'shards');
    for (const shard of fs.existsSync(shards) ? fs.readdirSync(shards).sort() : []) {
      const shardDir = path.join(shards, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const file of fs.readdirSync(shardDir).sort()) {
        if (!file.endsWith('.json') || file.startsWith('_partial') || file.startsWith('slice-')) continue;
        let report: unknown;
        try { report = JSON.parse(fs.readFileSync(path.join(shardDir, file), 'utf8')); } catch { continue; }
        gate.tests.push(...parseEvalReport(shard, report));
      }
    }
  }
  return gate;
}

// --- Merged PRs ---

export interface MergedPr { pr: number; sha: string; committedAt: string }

/** First-parent squash merges whose subject ends in (#NNN). */
export function parseMergeLog(log: string): MergedPr[] {
  return log.split('\n').filter(Boolean).flatMap(line => {
    const [sha, committedAt, ...subject] = line.split('\t');
    const match = subject.join('\t').match(/\(#(\d+)\)\s*$/);
    return match && sha && committedAt ? [{ pr: Number(match[1]), sha, committedAt }] : [];
  });
}

function mergedPrs(args: ReplayArgs): { prs: MergedPr[]; windowDays: number | null; since?: Date; until?: Date } {
  const format = '--format=%H%x09%cI%x09%s';
  const shallowHint = (since: string) => git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
    ? `; this checkout is shallow: run "git fetch --shallow-since=${since} origin main" and rerun` : '';
  if (args.since && args.until) {
    const since = parseWindowDate(args.since, false), until = parseWindowDate(args.until, true);
    const oldest = git(['log', '--first-parent', '--format=%cI', args.ref]).trim().split('\n').pop() ?? '';
    const hint = shallowHint(since.toISOString().slice(0, 10));
    if (hint && new Date(oldest) > since) throw new Error(`history before ${oldest} is missing${hint}`);
    const prs = parseMergeLog(git(['log', '--first-parent', `--since=${since.toISOString()}`, `--until=${until.toISOString()}`, format, args.ref])).reverse();
    return { prs, windowDays: args.windowDays ?? (until.getTime() - since.getTime()) / DAY_MS, since, until };
  }
  if (args.prs.length === 0) return { prs: [], windowDays: null };
  const all = new Map(parseMergeLog(git(['log', '--first-parent', format, args.ref])).map(pr => [pr.pr, pr]));
  const missing = args.prs.filter(pr => !all.has(pr));
  if (missing.length) throw new Error(`no squash merge of #${missing.join(', #')} on ${args.ref}'s first-parent history${shallowHint('2026-01-01')}`);
  return { prs: args.prs.map(pr => all.get(pr)!), windowDays: args.windowDays ?? null };
}

/** The PR diff the selectors see between two revisions. */
function revisionDiff(pr: number, from: string, to: string): PrDiff {
  const files = git(['diff', '--name-only', '--no-renames', from, to]).split('\n').filter(Boolean);
  let packageVersionOnly = false;
  if (files.includes('package.json')) {
    const show = (rev: string) => spawnSync('git', ['show', `${rev}:package.json`], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    const before = show(from), after = show(to);
    packageVersionOnly = before.status === 0 && after.status === 0 && packageChangeOnlyVersion(before.stdout, after.stdout);
  }
  const skillMds = files.filter(isSkillMd);
  const skillMdChangedLines = skillMds.length >= 10
    ? changedLinesByFile(git(['diff', '-U0', '--no-renames', from, to, '--', ...skillMds], 120_000)) : {};
  return { pr, sha: to.slice(0, 8), files, packageVersionOnly, skillMdChangedLines };
}

const prDiff = (merge: MergedPr): PrDiff => revisionDiff(merge.pr, `${merge.sha}^`, merge.sha);

/** The selectors in this checkout: today's PR profile (with R4's shadow) and the plain touchfile selection. */
export function checkoutSelectionDeps(rootDir = ROOT): SelectionDeps {
  const gateCases = Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === 'gate');
  const judgeCases = Object.keys(LLM_JUDGE_TOUCHFILES);
  return {
    gateCases, judgeCases,
    today(files, packageVersionOnly) {
      try {
        const result = computePaidCaseSelection({ profile: 'pr', env: {}, rootDir, changedFiles: files, packageVersionOnly });
        return { e2e: result.selection.e2e ?? gateCases, judges: result.selection.judges ?? judgeCases,
          shadowE2e: result.coverage?.shadow?.e2e ?? null, mode: result.coverage?.mode ?? 'pr' };
      } catch {
        return { e2e: gateCases, judges: judgeCases, shadowE2e: null, mode: 'needs-full' };
      }
    },
    touchfiles(files) {
      const result = computePaidCaseSelection({ profile: 'full', env: {}, rootDir, changedFiles: files });
      return { e2e: result.selection.e2e ?? gateCases, global: files.some(file => GLOBAL_TOUCHFILES.some(pattern => matchGlob(file, pattern))) };
    },
  };
}

// --- Report ---

export interface ReplayReport {
  repo: string;
  ref: string;
  head: string;
  runs: Array<{ runId: string; tests: number; trials: number; recordedUsd: number }>;
  gate: GateSummary;
  fullScaleUsd: number;
  usdPerSecond: number;
  cases: CaseCostEntry[];
  window: { since: string; until: string } | null;
  windowDays: number | null;
  prs: PrSelectionCost[];
  selection: { today: SelectorSummary; shadow: SelectorSummary; screenProvisional: SelectorSummary } | null;
  model: { screenScale: number; fullGateUsd: number; trainSize: number; reps: number; seed: number; rows: TrainModelResult[] } | null;
  history?: HistoryReport;
}

export function buildReport(args: ReplayArgs, gates: GateRecord[], merges: ReturnType<typeof mergedPrs>, deps: SelectionDeps,
  diffs: (merge: MergedPr) => PrDiff = prDiff): Omit<ReplayReport, 'repo' | 'ref' | 'head'> {
  const table = caseCostTable(gates, { usdPerSecond: args.usdPerSecond });
  const gate = summarizeGates(gates);
  const fullScaleUsd = fullGateUsd(deps, table);
  const prs = merges.prs.map(merge => prSelectionCost(diffs(merge), deps, table));
  const selection = prs.length ? {
    today: summarizeSelector(prs.map(row => row.today), fullScaleUsd),
    shadow: summarizeSelector(prs.map(row => row.shadow), fullScaleUsd),
    screenProvisional: summarizeSelector(prs.map(row => row.screenProvisional), fullScaleUsd),
  } : null;
  const screenScale = fullScaleUsd ? gate.recordedUsd.mean / fullScaleUsd : 0;
  const model = prs.length && merges.windowDays ? {
    screenScale, fullGateUsd: gate.recordedUsd.mean, trainSize: args.trainSize, reps: args.reps, seed: args.seed,
    rows: MODEL_POLICIES.flatMap(policy => MODEL_OUTSIDE_RED.map(outsideRed => simulateTrains({
      prs: prs.map(row => ({ paidRelevant: row.today.usd > 0, screenUsd: row.screenProvisional.usd * screenScale })),
      policy, outsideRed, windowDays: merges.windowDays!, trainSize: args.trainSize, fullGateUsd: gate.recordedUsd.mean, reps: args.reps, seed: args.seed,
    }))),
  } : null;
  return {
    runs: gates.map(g => ({ runId: g.runId, tests: g.tests.length, trials: g.trials.length, recordedUsd: g.tests.reduce((sum, t) => sum + t.costUsd, 0) })),
    gate, fullScaleUsd, usdPerSecond: table.usdPerSecond, cases: Object.values(table.cases).sort((a, b) => b.costUsd - a.costUsd),
    window: merges.since && merges.until ? { since: merges.since.toISOString(), until: merges.until.toISOString() } : null,
    windowDays: merges.windowDays, prs, selection, model,
  };
}

const usd = (value: number) => value.toFixed(2);
const pct = (value: number, total: number) => (total ? `${(100 * value / total).toFixed(1)}%` : '-');
const mtok = (tokens: number) => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(2)}M` : `${Math.round(tokens / 1e3)}k`);
const pad = (cells: Array<string | number>, widths: number[]) => cells.map((cell, i) => String(cell).padEnd(widths[i] ?? 0)).join('  ').trimEnd();

export function formatReport(report: ReplayReport, options: { cases?: boolean } = {}): string {
  const out: string[] = [];
  const { gate } = report;
  const gateUsd = gate.recordedUsd.mean;
  out.push(`gate-cost replay: ${report.repo} at ${report.head.slice(0, 8)} (selectors from this checkout)`, '');
  out.push(`Gates: ${report.runs.length} run(s), recorded $ per gate mean ${usd(gateUsd)} (min ${usd(gate.recordedUsd.min)}, max ${usd(gate.recordedUsd.max)})`);
  for (const run of report.runs) out.push(`  run ${run.runId}: ${run.trials} trials, ${run.tests} cost entries, $${usd(run.recordedUsd)}`);
  out.push('', 'Recorded $ per gate by model:');
  for (const [model, value] of Object.entries(gate.byModel).sort((a, b) => b[1] - a[1])) out.push(`  ${pad([model, usd(value), pct(value, gateUsd)], [34, 8])}`);
  out.push('', 'Token classes per gate (lib/pricing.ts prices; cache writes at 1.25x input; share of the recorded gate):');
  const classes = Object.values(gate.tokenClasses);
  const sum = (pick: (c: (typeof classes)[number]) => number) => classes.reduce((total, c) => total + pick(c), 0);
  const thinking = sum(c => c.output.thinkingTokens);
  for (const [label, key] of [['cache write', 'cacheWrite'], [`output (incl. ${mtok(thinking)} thinking)`, 'output'], ['cache read', 'cacheRead'], ['uncached input', 'uncachedInput']] as const) {
    const value = sum(c => c[key].usd);
    out.push(`  ${pad([label, mtok(sum(c => c[key].tokens)), usd(value), pct(value, gateUsd)], [34, 8, 8])}`);
  }
  for (const [model, c] of Object.entries(gate.tokenClasses)) {
    out.push(`  ${model}: ${c.priced ? `priced $${usd(c.pricedUsd)} vs recorded $${usd(c.recordedUsd)}` : `no lib/pricing.ts row, recorded $${usd(c.recordedUsd)} unpriced`}`);
  }
  const estimated = report.cases.filter(c => c.estimated);
  const estimatedUsd = estimated.reduce((total, c) => total + c.costUsd, 0);
  out.push('', `Cases: ${report.cases.length}; ${estimated.length} without recorded cost, estimated at $${report.usdPerSecond.toFixed(4)} per session-second: ~${usd(estimatedUsd)} per gate`);
  for (const c of estimated) out.push(`  ${pad([c.caseId, `~${usd(c.costUsd)} (est.)`, `${Math.round(c.meanDurationMs / 1000)} s`, c.runner ?? '-'], [40, 14, 7])}`);
  out.push(`Full-gate scale: $${usd(report.fullScaleUsd)} per gate (recorded case means plus estimates)`);
  if (options.cases) {
    out.push('', 'Per-case mean cost:');
    for (const c of report.cases) out.push(`  ${pad([c.caseId, (c.estimated ? '~' : '') + usd(c.costUsd), c.kind, c.runner ?? '-', c.estimated ? 'estimated' : `${c.recordedGates} gate(s)`], [50, 8, 6, 10])}`);
  }
  if (!report.prs.length) return out.join('\n');
  const label = SCREEN_LABEL;
  out.push('', `Per merged PR ($ on the $${usd(report.fullScaleUsd)} full-gate scale; cases are gate e2e cases, judges extra):`);
  out.push(`  ${pad(['PR', 'sha', 'files', 'today $ (cases)', 'R4 shadow $ (cases)', `${label} $ (cases)`], [6, 8, 5, 16, 20])}`);
  for (const row of report.prs) {
    const cell = (s: { usd: number; cases: number }) => `${usd(s.usd)} (${s.cases})`;
    out.push(`  ${pad([`#${row.pr}`, row.sha, row.files, cell(row.today), cell(row.shadow), cell(row.screenProvisional) + (row.screenProvisional.canary ? ' +canary' : '')], [6, 8, 5, 16, 20])}`);
  }
  const s = report.selection!;
  out.push('', `Selection over ${report.prs.length} merged PRs (one cohort: every merged PR counts, zeros included)${report.window ? `, ${report.window.since} to ${report.window.until}` : ''}:`);
  out.push(`  ${pad(['selector', '$ / merged PR', 'median $', 'mean cases', 'PRs >= 90% of gate'], [20, 13, 9, 10])}`);
  for (const [name, row] of [['today', s.today], ['R4 shadow', s.shadow], [label, s.screenProvisional]] as const) {
    out.push(`  ${pad([name, usd(row.meanUsd), usd(row.medianUsd), row.meanCases.toFixed(1), row.nearFull], [20, 13, 9, 10])}`);
  }
  out.push(`  ${label}: its preamble detector is a line-commonality heuristic, not T2's hunk classifier; heuristic until T2 lands.`);
  if (!report.model) {
    out.push('', 'Train model: skipped (needs a window: --since/--until, or --window-days with --prs).');
    return out.join('\n');
  }
  const m = report.model;
  const perWeek = report.prs.length * 7 / report.windowDays!;
  out.push('', `Train model (seeded Monte Carlo, ${m.reps} reps, seed ${m.seed}; trains of ${m.trainSize}; full gate $${usd(m.fullGateUsd)}, bisect $6, repair re-screens x1.3,`,
    `  red rates screened 6% / unscreened 25%; ${label} screen costs scaled by ${m.screenScale.toFixed(4)} to the recorded gate;`,
    `  window ${report.windowDays!.toFixed(1)} days, ${perWeek.toFixed(1)} merged PRs a week; multiples against $${TODAY_WEEKLY_USD} and $${AFTER_GSTA48_WEEKLY_USD} a week):`);
  const widths = [15, 5, 7, 6, 7, 7, 22, 9, 9, 9, 8, 9, 10];
  out.push(`  ${pad(['policy', 'o', '$/week', '$/PR', 'x9950', 'x8400', `${label} $/w`, 'trains/w', 'gates/w', 'bisect/w', 'rebld/w', 'stalls/w', 'first-red'], widths)}  attempt-red`);
  for (const r of m.rows) {
    out.push(`  ${pad([r.policy, r.outsideRed.toFixed(2), Math.round(r.weeklyUsd), r.perMergedPrUsd.toFixed(1), r.multipleVsToday.toFixed(2), r.multipleVsAfterGsta48.toFixed(2),
      Math.round(r.screenWeeklyUsd), r.initialTrainsWeekly.toFixed(2), r.gateAttemptsWeekly.toFixed(2), r.bisectsWeekly.toFixed(2), r.rebuildOnceWeekly.toFixed(2),
      r.stallsWeekly.toFixed(2), pct(r.firstCandidateRedShare, 1)], widths)}  ${pct(r.attemptRedShare, 1)}`);
  }
  return out.join('\n');
}

// --- History (--history): red-head replay and READY-arrival trains ---

const REPORT_ARTIFACT = /^report-verdict-a\d+$/;
const TRIALS_ARTIFACT = /^trial-outcomes[A-Za-z0-9_-]*?-a\d+$/;
const TRAIN_POLICIES: ScreenPolicy[] = [{ kind: 'all' }, { kind: 'random', fraction: 0.5 }, { kind: 'none' }];
const GH_RUN_PAGE = 100;
const HISTORY_GIT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 300_000;

interface HistoryRun { id: number; sha: string; branch: string; createdAt: string; updatedAt: string; conclusion: string | null; prNumbers: number[] }
interface PullRow { number: number; ref: string; head: string; createdAt: string; mergedAt: string | null; closedAt: string | null }
type Merges = ReturnType<typeof mergedPrs>;

export interface HistoryReport {
  window: { since: string; until: string };
  runs: { evals: number; gated: number; red: number; free: number; unmapped: number };
  redRuns: RedRun[];
  redHeads: RedHeadRow[];
  redSummary: RedHeadSummary;
  perPr: Array<{ pr: number; paidRelevant: boolean; prCausedRed: boolean; screenedMiss: boolean }>;
  ready: ReadyRow[];
  baseline: LatencySummary & { gatesAfterReady: number; sources: Record<string, number> };
  trainParams: { trainSize: number; fillLimitHours: number; gateMinutes: number; bisectMinutes: number; redScreened: number; redUnscreened: number; reps: number; seed: number };
  trains: ArrivalTrainResult[];
}

function tryGit(args: string[], timeout = HISTORY_GIT_TIMEOUT_MS): string | null {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function cachedJson<T>(file: string, load: () => T): T {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  const value = load();
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}

/** Completed runs of one workflow, one UTC day per query: GitHub caps a filtered run listing at 1,000 results. */
function listRunsByDay(repo: string, workflow: string, since: Date, until: Date, event?: string): HistoryRun[] {
  const out: HistoryRun[] = [];
  for (let day = new Date(since.toISOString().slice(0, 10)); day < until; day = new Date(day.getTime() + DAY_MS)) {
    const date = day.toISOString().slice(0, 10);
    for (let page = 1; page <= 10; page += 1) {
      const query = [`status=completed`, `per_page=${GH_RUN_PAGE}`, `page=${page}`, `created=${date}..${date}`, ...(event ? [`event=${event}`] : [])];
      const body = GH_CLIENT.getJson(`repos/${repo}/actions/workflows/${workflow}/runs?${query.join('&')}`) as { workflow_runs?: any[] };
      const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
      out.push(...runs.map(run => ({ id: Number(run.id), sha: String(run.head_sha ?? ''), branch: String(run.head_branch ?? ''), createdAt: String(run.created_at ?? ''),
        updatedAt: String(run.updated_at ?? ''), conclusion: run.conclusion ?? null,
        prNumbers: Array.isArray(run.pull_requests) ? run.pull_requests.map((pr: any) => Number(pr.number)).filter(Number.isFinite) : [] })));
      if (runs.length < GH_RUN_PAGE) break;
    }
  }
  return out.filter(run => run.createdAt >= since.toISOString() && run.createdAt < until.toISOString());
}

function listPulls(repo: string, since: Date): PullRow[] {
  const out: PullRow[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const body = GH_CLIENT.getJson(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`) as any[];
    if (!Array.isArray(body)) break;
    out.push(...body.map(p => ({ number: Number(p.number), ref: String(p.head?.ref ?? ''), head: String(p.head?.sha ?? ''), createdAt: String(p.created_at ?? ''),
      mergedAt: p.merged_at ?? null, closedAt: p.closed_at ?? null })));
    if (body.length < 100 || String(body[body.length - 1]?.updated_at ?? '') < since.toISOString()) break;
  }
  return out;
}

/** Artifacts of one run matching a name pattern, downloaded once (a .history marker records that the run was listed). */
function runArtifactDirs(runId: number, repo: string, cache: string, match: RegExp): string[] {
  const dir = path.join(cache, String(runId));
  const marker = path.join(dir, `.history-${match.source.replace(/[^a-z]/gi, '')}`);
  if (!fs.existsSync(marker)) {
    downloadRunArtifacts({ repo, run: { id: runId }, cacheDir: cache, match: name => match.test(name), maxBytes: 16 * 1024 * 1024, fetcher: GH_HISTORY });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, '');
  }
  return fs.readdirSync(dir).filter(name => match.test(name)).sort((a, b) => Number(a.split('-a').pop()) - Number(b.split('-a').pop())).map(name => path.join(dir, name));
}

/** The run's report verdict over its attempts: the last attempt's verdict, every attempt's failures; null when no report exists. */
function runVerdict(runId: number, repo: string, cache: string): { green: boolean; failures: GatedRun['failures'] } | null {
  const reports = runArtifactDirs(runId, repo, cache, REPORT_ARTIFACT).map(dir => path.join(dir, 'report.txt')).filter(file => fs.existsSync(file))
    .map(file => parseReportVerdict(fs.readFileSync(file, 'utf8')));
  if (!reports.length) return null;
  return { green: reports[reports.length - 1]!.verdict === 'GREEN', failures: reports.flatMap(r => r.failures) };
}

/** The tested merge commit of a run, from its trial outcomes. */
function testedMergeSha(runId: number, repo: string, cache: string): string | null {
  for (const dir of runArtifactDirs(runId, repo, cache, TRIALS_ARTIFACT)) {
    const file = path.join(dir, 'trial-outcomes.jsonl');
    const first = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').find(Boolean) : undefined;
    try { const sha = first ? JSON.parse(first).sha : null; if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) return sha; } catch { /* torn line */ }
  }
  return null;
}

/** Fetch commits this clone lacks by SHA (GitHub serves PR heads and merge refs that no branch holds anymore). */
function ensureCommits(shas: string[]): void {
  const missing = [...new Set(shas)].filter(sha => tryGit(['cat-file', '-e', `${sha}^{commit}`], 30_000) === null);
  for (let i = 0; i < missing.length; i += 20) spawnSync('git', ['fetch', '-q', 'origin', ...missing.slice(i, i + 20)], { cwd: ROOT, timeout: FETCH_TIMEOUT_MS });
}

function headDiff(sha: string, ref: string): HeadDiff | null {
  const mergeBase = tryGit(['merge-base', ref, sha])?.trim();
  if (!mergeBase) return null;
  const files = tryGit(['diff', '--name-only', '--no-renames', mergeBase, sha]);
  const diff = tryGit(['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', mergeBase, sha, '--', '.', ...STAMP_FILES.map(file => `:(exclude)${file}`)]);
  return files === null || diff === null ? null : { ownSig: stampFreeSignature(diff), files: files.split('\n').filter(Boolean) };
}

/** The base a red run tested: its merge commit's first parent, else main's first-parent tip when the run was created. */
function testedBase(run: RedRun, args: ReplayArgs, repo: string): { base: string; source: RedHeadRow['baseSource'] } | null {
  const merge = testedMergeSha(run.runId, repo, args.cache);
  if (merge) {
    ensureCommits([merge]);
    const parents = (tryGit(['rev-list', '--parents', '-n1', merge]) ?? '').trim().split(' ').slice(1);
    if (parents.length === 2 && parents[1] === run.head) return { base: parents[0]!, source: 'tested-merge' };
  }
  const tip = tryGit(['rev-list', '-1', '--first-parent', `--before=${run.createdAt}`, args.ref])?.trim();
  return tip ? { base: tip, source: 'main-at-run' } : null;
}

function collectHistory(args: ReplayArgs, repo: string, merges: Merges, body: Omit<ReplayReport, 'repo' | 'ref' | 'head'>, deps: SelectionDeps, gates: GateRecord[]): HistoryReport {
  const since = merges.since!, until = merges.until!;
  const key = `${since.toISOString()}_${until.toISOString()}`.replace(/[^0-9TZ_]/g, '');
  const cached = <T>(name: string, load: () => T) => cachedJson(path.join(args.cache, `history-${key}-${name}.json`), load);
  const evals = cached('evals', () => listRunsByDay(repo, 'evals.yml', since, until));
  const free = cached('free', () => listRunsByDay(repo, 'free-tests.yml', since, until, 'pull_request'));
  const pulls = cached('pulls', () => listPulls(repo, since));
  const prOf = new Map([...evals, ...free].map(run => [run.id, prForRun(run, pulls)]));
  const gated: GatedRun[] = evals.flatMap(run => {
    const pr = prOf.get(run.id) ?? null;
    if (run.conclusion === 'success') return [{ id: run.id, pr, head: run.sha, createdAt: run.createdAt, green: true, failures: [] }];
    const verdict = run.conclusion === 'failure' ? runVerdict(run.id, repo, args.cache) : null;
    return verdict ? [{ id: run.id, pr, head: run.sha, createdAt: run.createdAt, ...verdict }] : [];
  });
  const mergedSet = new Set(merges.prs.map(m => m.pr));
  const pullOf = new Map(pulls.map(p => [p.number, p]));
  const checkRuns = [...evals.map(run => ({ run, workflow: 'evals' as const })), ...free.map(run => ({ run, workflow: 'free' as const }))]
    .filter(({ run }) => mergedSet.has(prOf.get(run.id) ?? -1));
  const heads = [...new Set([...gated.filter(r => r.pr !== null).map(r => r.head), ...checkRuns.map(({ run }) => run.sha),
    ...merges.prs.map(m => pullOf.get(m.pr)?.head ?? '')].filter(Boolean))];
  ensureCommits(heads);
  const diffs = cached('heads', () => Object.fromEntries(heads.map(sha => [sha, headDiff(sha, args.ref)])));
  const headMap = new Map(Object.entries(diffs).filter((e): e is [string, HeadDiff] => e[1] !== null));
  const caseFiles = new Map(gates.flatMap(g => g.trials.map(t => [t.caseId, t.file] as const)));
  const caseFile = (id: string) => caseFiles.get(id) ?? null;
  const inputsOf = (id: string) => /^test\/.+\.test\.ts$/.test(id)
    ? [id, ...[...caseFiles].filter(([, file]) => file === id).flatMap(([c]) => E2E_TOUCHFILES[c] ?? [])]
    : [...(E2E_TOUCHFILES[id] ?? []), ...(caseFile(id) ? [caseFile(id)!] : [])];
  const redRuns = classifyReds(gated, {
    heads: headMap,
    delta: (from, to) => tryGit(['diff', '--name-only', '--no-renames', from, to])?.split('\n').filter(Boolean) ?? null,
    touches: (id, files) => files.filter(file => [...inputsOf(id), ...GLOBAL_TOUCHFILES].some(pattern => matchGlob(file, pattern))),
  });
  const redHeads: RedHeadRow[] = redRuns.filter(run => run.cause === 'pr').flatMap(run => {
    const tested = testedBase(run, args, repo);
    const mergeBase = tested && tryGit(['merge-base', tested.base, run.head])?.trim();
    if (!tested || !mergeBase) return [];
    const diff = revisionDiff(run.pr, mergeBase, run.head);
    const selection = screenSelection(diff, deps, todaySelection(diff, deps));
    return run.cases.filter(c => c.cause === 'pr').map(c => ({ caseId: c.caseId, kind: c.kind, pr: run.pr, runId: run.runId, head: run.head.slice(0, 8),
      base: tested.base.slice(0, 8), baseSource: tested.source, files: diff.files.length, hit: screenHit(c, selection, caseFile), canaryReasons: selection.canaryReasons }));
  });
  const selected = new Map(body.prs.map(row => [row.pr, row]));
  const merged = merges.prs.map(m => ({ pr: m.pr, paidRelevant: (selected.get(m.pr)?.today.usd ?? 0) > 0 }));
  const redSummary = summarizeRedHeads(redHeads, redRuns, merged);
  const ready = readyTimes(merges.prs.flatMap(m => {
    const pull = pullOf.get(m.pr);
    if (!pull?.mergedAt) return [];
    const prHeads = [...new Set([...checkRuns.filter(({ run }) => prOf.get(run.id) === m.pr).map(({ run }) => run.sha), pull.head])];
    return [{ pr: m.pr, mergedAt: pull.mergedAt, finalHead: pull.head, heads: prHeads.map(sha => ({ sha, ownSig: headMap.get(sha)?.ownSig ?? null })),
      gatedRuns: gated.filter(r => r.pr === m.pr).map(r => r.createdAt) }];
  }), headGreenAt(checkRuns.map(({ run, workflow }): CheckRun => ({ head: run.sha, workflow, createdAt: run.createdAt, completedAt: run.updatedAt, conclusion: run.conclusion }))));
  const withReady = ready.filter(row => row.ready !== null);
  const sources: Record<string, number> = {};
  for (const row of ready) sources[row.source] = (sources[row.source] ?? 0) + 1;
  const scale = body.model?.screenScale ?? 1;
  const arrivals = withReady.map(row => ({ pr: row.pr, readyMs: Date.parse(row.ready!), paidRelevant: (selected.get(row.pr)?.today.usd ?? 0) > 0,
    screenUsd: (selected.get(row.pr)?.screenProvisional.usd ?? 0) * scale }));
  const trainParams = { trainSize: args.trainSize, fillLimitHours: 3, gateMinutes: 45, bisectMinutes: 45, redScreened: 0.06, redUnscreened: 0.25, reps: args.reps, seed: args.seed };
  return {
    window: { since: since.toISOString(), until: until.toISOString() },
    runs: { evals: evals.length, gated: gated.length, red: gated.filter(r => !r.green).length, free: free.length, unmapped: evals.filter(run => prOf.get(run.id) === null).length },
    redRuns, redHeads, redSummary,
    perPr: merged.map(m => ({ ...m, prCausedRed: redSummary.prsWithPrRed.includes(m.pr), screenedMiss: redSummary.missedPrs.includes(m.pr) })),
    ready, baseline: { ...latencySummary(withReady.map(row => row.readyToMergeHours!)), gatesAfterReady: withReady.reduce((sum, row) => sum + row.gatesAfterReady, 0), sources },
    trainParams,
    trains: TRAIN_POLICIES.flatMap(policy => MODEL_OUTSIDE_RED.map(outsideRed => simulateArrivalTrains({ ...trainParams, arrivals, policy, outsideRed, windowDays: merges.windowDays! }))),
  };
}

export function formatHistory(h: HistoryReport): string {
  const s = h.redSummary;
  const label = SCREEN_LABEL;
  const share = (n: number, d: number) => `${n} of ${d} (${pct(n, d)})`;
  const causes = (cause: string) => h.redRuns.filter(run => run.cause === cause).length;
  const out = [`History replays, E2E Evals and Free Tests runs created ${h.window.since} to ${h.window.until}:`,
    `  E2E Evals runs ${h.runs.evals} (${h.runs.unmapped} not mapped to a PR), gated ${h.runs.gated}, red ${h.runs.red}: PR-caused ${causes('pr')}, outside ${causes('outside')}, unknown ${causes('unknown')}; Free Tests PR runs ${h.runs.free}`,
    '  Classification (GSTA-47): per failed case, first match wins: transcript diagnosis; red in another PR within 72 h -> outside;',
    '  no later gated run -> unknown; next gated run has the same own diff -> outside; the push to it changed the case\'s inputs',
    '  (touchfiles, test file, harness globals) among either head\'s own files -> PR-caused; else outside. A run with any PR-caused case is PR-caused.',
    '', `Red-head replay (${label} on the failing head's diff from its tested base; canary set fixed before the replay: ${Object.values(SCREEN_CANARY_CASES).join(', ')}):`,
    `  ${pad(['PR', 'run', 'head', 'base', 'files', 'case', 'kind', `${label} hit`], [6, 12, 9, 22, 5, 46, 6])}`];
  for (const row of h.redHeads) {
    out.push(`  ${pad([`#${row.pr}`, row.runId, row.head, `${row.base} ${row.baseSource}`, row.files, row.caseId, row.kind, row.hit ?? 'MISSED'], [6, 12, 9, 22, 5, 46, 6])}`);
  }
  out.push(`  ${label} hits by kind: ${Object.entries(s.byHit).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
    `  ${label} misses: ${share(s.missedPrs.length, s.prsWithPrRed.length)} merged PRs with a PR-caused red (${s.missedCases} of ${s.prCausedCases} case results)${s.missedPrs.length ? `: #${s.missedPrs.join(', #')}` : ''}`,
    `  ${label} misses with an empty canary set: ${s.missedPrsWithoutCanary.length}${s.missedPrsWithoutCanary.length ? ` (#${s.missedPrsWithoutCanary.join(', #')})` : ''}`,
    `  P-i (${label} misses over paid-relevant merged PRs): ${share(s.missedPrs.length, s.paidRelevantPrs)}`,
    `  P-k (merged PRs with any PR-caused red run): ${share(s.prsWithPrRed.length, s.mergedPrs)}${s.prsWithPrRed.length ? `: #${s.prsWithPrRed.join(', #')}` : ''}; ${s.prCausedRuns} PR-caused red runs`,
    `  PR-caused red runs on PRs that did not merge in the window (not counted): ${s.otherPrCausedRuns}`,
    '', `Per merged PR (paid-relevant: today's selector picks a case on the squash; red: any PR-caused red run; miss: a ${label} miss):`);
  for (let i = 0; i < h.perPr.length; i += 6) {
    out.push(`  ${h.perPr.slice(i, i + 6).map(p => `#${p.pr} ${p.paidRelevant ? 'paid' : '----'} ${p.prCausedRed ? 'red ' : '--- '}${p.screenedMiss ? 'miss' : '----'}`).join('  ')}`);
  }
  const b = h.baseline;
  const hrs = (v: number) => v.toFixed(1);
  const p = h.trainParams;
  out.push('', 'READY-to-merge. READY = when the merged own diff (modulo main merges and stamps) first had green Free Tests and E2E Evals on a',
    '  head, before the merge (fallback: the final head\'s green time; READY reports are not machine-readable).',
    `  READY signal: ${Object.entries(b.sources).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `  today (one PR per gate): ${b.prs} PRs, READY-to-merge p50 ${hrs(b.p50Hours)} h, p90 ${hrs(b.p90Hours)} h, mean ${hrs(b.meanHours)} h; ${b.gatesAfterReady} gated E2E Evals runs after READY`,
    `  trains (${p.reps} reps, seed ${p.seed}; size ${p.trainSize}, fill limit ${p.fillLimitHours} h, screened first, unscreened alone when ${p.trainSize}+ wait; ${p.gateMinutes} min a gate,`,
    `    ${p.bisectMinutes} min a bisect, one train gating at a time; defects ${p.redScreened * 100}% screened / ${p.redUnscreened * 100}% unscreened; a dropped PR rejoins at once):`,
    `  ${pad(['policy', 'o', 'trains/w', 'occupancy', 'full', 'sizes 1..k per window', 'gates/w', 'drop+gate/w', 'rebld/w', 'stalls/w', 'p50 h', 'p90 h'], [10, 5, 8, 9, 5, 22, 7, 11, 7, 8, 6])}  mean h`);
  for (const r of h.trains) {
    out.push(`  ${pad([r.policy, r.outsideRed.toFixed(2), r.trainsWeekly.toFixed(2), r.meanOccupancy.toFixed(2), pct(r.fullTrainShare, 1), r.occupancy.map(n => n.toFixed(1)).join('/'),
      r.gateAttemptsWeekly.toFixed(2), r.attributedRebuildsWeekly.toFixed(2), r.rebuildOnceWeekly.toFixed(2), r.stallsWeekly.toFixed(2), hrs(r.readyToMerge.p50Hours), hrs(r.readyToMerge.p90Hours)],
    [10, 5, 8, 9, 5, 22, 7, 11, 7, 8, 6])}  ${hrs(r.readyToMerge.meanHours)}`);
  }
  out.push(`  "screened" follows the ${label} policy column; PRs with no paid case ride as screened.`);
  return out.join('\n');
}

export function main(argv: string[]): number {
  let args: ReplayArgs;
  try { args = parseArgs(argv); } catch (error) {
    console.error(`gate-cost-replay: ${(error as Error).message}`);
    return 2;
  }
  try {
    const repo = args.repo || repoSlug(ROOT);
    fs.mkdirSync(args.cache, { recursive: true });
    const gates = args.runs.map(run => readGateRecord(fetchRun(run, args.cache, repo), run));
    const empty = gates.filter(g => g.trials.length === 0);
    if (empty.length) throw new Error(`run(s) ${empty.map(g => g.runId).join(', ')} have no trial outcomes (expired artifacts, or not a paid gate run)`);
    const merges = mergedPrs(args);
    const deps = checkoutSelectionDeps();
    const body = buildReport(args, gates, merges, deps);
    const report: ReplayReport = { repo, ref: args.ref, head: git(['rev-parse', args.ref]).trim(), ...body,
      ...(args.history ? { history: collectHistory(args, repo, merges, body, deps, gates) } : {}) };
    const text = formatReport(report, { cases: args.cases }) + (report.history ? `\n\n${formatHistory(report.history)}` : '');
    console.log(args.json ? JSON.stringify(report, null, 2) : text);
    return 0;
  } catch (error) {
    console.error(`gate-cost-replay: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
