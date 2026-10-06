/**
 * eval:pass-rates report views over stored trial records (plan 0.1):
 * session headroom (--headroom), the verdict red ledger with the all-green
 * probability (--reds), and one census's triage view (--run <id>). Pure
 * functions plus the run-scoped fetches they need; scripts/eval-flake-rank.ts
 * parses flags, loads history and dispatches here.
 *
 * Headroom is per armed session (session ledger, `sessions[]` on a record):
 * elapsed over the timeout it armed. A case's headroom is its slowest
 * session; a timed-out sample is censored (its true duration is unknown).
 * Records without sessions are unknown, never scored; their case wall
 * (JUnit or shard clock) is shown separately as an upper bound.
 *
 * The all-green probability is an approximation that assumes independent
 * verdicts: P(green) = Π (1 - p_i) over the cases a census verdicts, where
 * p_i = (reds_i + K * p̄) / (verdicts_i + K) shrinks each case's red rate
 * toward the pooled rate p̄. Its interval recomputes the same product with p̄
 * replaced by the pooled rate's 95% Wilson bounds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { panelVerdict, type TrialOutcomeRecord } from '../../test/helpers/eval-store';
import { HEADROOM_FAIL, HEADROOM_WARN } from '../../test/helpers/eval-budgets';
import { sanitizeFixedFenceLine } from './published-text';
import type { HistoryFetcher, WeeklyRun } from './ci-history';
import { CASE_SHARDED_FILES, trialShardKey } from './paid-cases';
import { shardSlug } from '../test-paid-shards';
import { CENSUS_RED_GUIDE } from './paid-report';

export { CENSUS_RED_GUIDE };

/** Below this many session samples a case's headroom is insufficient, never a pass. */
export const HEADROOM_MIN_SAMPLES = 3;
/** Pseudo-verdicts of pooled rate added to each case's red rate. */
export const RED_RATE_SHRINK = 4;
/** Largest slice artifact --run downloads. */
export const EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;

type Rec = TrialOutcomeRecord;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

// --- Headroom ---

export interface SessionHeadroom { key: string; samples: number; censored: number; maxRatio: number; maxElapsedMs: number; budgetMs: number }
export interface CaseHeadroom {
  case: string;
  status: 'over' | 'warn' | 'ok' | 'insufficient' | 'unknown';
  sessions: SessionHeadroom[];
  /** Slowest session's worst ratio, when any session was recorded. */
  worst?: SessionHeadroom;
  /** Largest case wall (JUnit or shard clock) over the window: an upper bound, never a session clock. */
  caseWallMs: number;
  runs: number;
}

export function headroom(records: readonly Rec[]): CaseHeadroom[] {
  const byCase = new Map<string, Rec[]>();
  for (const r of records) if (r.outcome !== 'skipped' && r.execution !== 'reused') byCase.set(r.case, [...(byCase.get(r.case) ?? []), r]);
  return [...byCase.entries()].map(([id, rs]) => {
    const sessions = new Map<string, SessionHeadroom>();
    for (const s of rs.flatMap(r => r.sessions ?? [])) {
      if (!s.budget_ms) continue;
      const key = s.key;
      const entry = sessions.get(key) ?? { key, samples: 0, censored: 0, maxRatio: 0, maxElapsedMs: 0, budgetMs: s.budget_ms };
      entry.samples++;
      if (s.end === 'session_timeout' || s.end === 'observer_timeout') entry.censored++;
      const ratio = s.elapsed_ms / s.budget_ms;
      if (ratio > entry.maxRatio) Object.assign(entry, { maxRatio: ratio, maxElapsedMs: s.elapsed_ms, budgetMs: s.budget_ms });
      sessions.set(key, entry);
    }
    const list = [...sessions.values()].sort((a, b) => b.maxRatio - a.maxRatio);
    const worst = list[0];
    const status: CaseHeadroom['status'] = !worst ? 'unknown' : worst.samples < HEADROOM_MIN_SAMPLES ? 'insufficient'
      : worst.maxRatio > HEADROOM_FAIL ? 'over' : worst.maxRatio > HEADROOM_WARN ? 'warn' : 'ok';
    return { case: id, status, sessions: list, ...(worst ? { worst } : {}), caseWallMs: Math.max(0, ...rs.map(r => r.duration_ms)),
      runs: new Set(rs.map(r => r.run_id ?? 'local')).size };
  }).sort((a, b) => (b.worst?.maxRatio ?? -1) - (a.worst?.maxRatio ?? -1) || b.caseWallMs - a.caseWallMs);
}

/** --gate alarms: a case whose slowest session ran above HEADROOM_FAIL of its armed budget. */
export function headroomAlarms(cases: readonly CaseHeadroom[]): Array<{ kind: 'headroom'; case: string; message: string }> {
  return cases.filter(c => c.status === 'over').map(c => ({ kind: 'headroom' as const, case: c.case,
    message: `${c.case} session ${c.worst!.key}: max ${secs(c.worst!.maxElapsedMs)} of ${secs(c.worst!.budgetMs)} (${pct(c.worst!.maxRatio)})`
      + `${c.worst!.censored ? `, ${c.worst!.censored} timed-out sample(s) censored` : ''} over ${c.worst!.samples} sample(s), above the ${pct(HEADROOM_FAIL)} cap. `
      + 'Cut work in the skill or fixture; budgets are never raised (TESTING_INTERNALS "Timeout policy").' }));
}

export function formatHeadroom(cases: readonly CaseHeadroom[], critical: readonly CriticalPath[] = []): string[] {
  const lines = [`headroom: slowest armed session per case (warn > ${pct(HEADROOM_WARN)}, alarm > ${pct(HEADROOM_FAIL)}; `
    + `insufficient below ${HEADROOM_MIN_SAMPLES} samples; censored = timed out)`,
  '  status        session max/budget          samples  case wall (upper bound, not a session clock)  case'];
  for (const c of cases) {
    const w = c.worst;
    const session = w ? `${pct(w.maxRatio)} ${secs(w.maxElapsedMs)}/${secs(w.budgetMs)}` : 'unknown (no session ledger)';
    lines.push(`  ${c.status.padEnd(12)}  ${session.padEnd(26)}  ${(w ? `${w.samples}${w.censored ? ` (${w.censored} censored)` : ''}` : '-').padEnd(7)}  `
      + `${secs(c.caseWallMs).padEnd(45)}  ${c.case}${w ? `  [${w.key}]` : ''}`);
  }
  return [...lines, ...formatCriticalPath(critical)];
}

export function formatCriticalPath(critical: readonly CriticalPath[]): string[] {
  return critical.map(cp => `critical path ${cp.run}: ${cp.slowest ? `${cp.slowest.name} ${secs(cp.slowest.ms)}` : 'unknown'}`
    + ` of ${cp.jobs} slice job(s), run wall ${cp.wallMs === null ? 'unknown' : secs(cp.wallMs)}${cp.files?.length ? `; slice files: ${cp.files.join(', ')}` : ''}`);
}

// --- Critical path from runner slice timings ---

export interface JobTiming { name: string; startedAt: string | null; completedAt: string | null }
export interface CriticalPath { run: string; jobs: number; slowest: { name: string; ms: number } | null; wallMs: number | null; files?: string[] }

const SLICE_JOB = /^(eval-slices|eval-codex-slices|gate-census) \((\d+)\)$/;

export function criticalPath(run: string, jobs: readonly JobTiming[], plan?: { entries: Array<{ file: string; slice?: number; status?: string }> }): CriticalPath {
  const timed = jobs.filter(j => SLICE_JOB.test(j.name) && j.startedAt && j.completedAt)
    .map(j => ({ name: j.name, ms: Date.parse(j.completedAt!) - Date.parse(j.startedAt!) }));
  const slowest = timed.sort((a, b) => b.ms - a.ms)[0] ?? null;
  const all = jobs.filter(j => j.startedAt && j.completedAt);
  const wallMs = all.length ? Math.max(...all.map(j => Date.parse(j.completedAt!))) - Math.min(...all.map(j => Date.parse(j.startedAt!))) : null;
  const slice = slowest ? Number(SLICE_JOB.exec(slowest.name)![2]) : null;
  const files = plan && slice !== null && slowest!.name.startsWith('gate-census')
    ? plan.entries.filter(e => e.slice === slice && e.status === 'planned').map(e => e.file) : undefined;
  return { run, jobs: timed.length, slowest, wallMs, ...(files ? { files } : {}) };
}

// --- Red ledger ---

export interface VerdictRed { run: string; lane: string; case: string; status: string; trials: Rec[] }
export interface CensusReds { run: string; lane: string; verdicts: number; reds: VerdictRed[]; byClass: Record<string, number>; byCause: Record<string, number> }
export interface RedLedger {
  censuses: CensusReds[];
  pooled: { verdicts: number; reds: number; rate: number; lo: number; hi: number };
  perCase: Array<{ case: string; verdicts: number; reds: number; rate: number }>;
  allGreen: { p: number; lo: number; hi: number; verdicts: number } | null;
}

function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

/** One panelVerdict per case per census lane (earliest attempt), exactly as the report computes it. */
export function verdictsOf(records: readonly Rec[]): Array<{ run: string; lane: string; case: string; status: string; failsLane: boolean; trials: Rec[] }> {
  const groups = new Map<string, Rec[]>();
  for (const r of records) {
    if (r.policy_version < 1 || r.execution === 'reused') continue;
    // A JUnit case is one verdict per shard file, as the report counts it; trial shards form one panel.
    const key = `${r.run_id ?? 'local'}\0${r.lane ?? r.tier}\0${r.case}\0${r.source === 'shard' ? '' : r.file}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [run, lane, id] = key.split('\0') as [string, string, string, string];
    const attempt = Math.min(...rs.map(r => r.attempt));
    const trials = rs.filter(r => r.attempt === attempt);
    const v = panelVerdict({ case: id, kind: trials[0]!.kind, panel: trials[0]!.panel, quarantined: trials[0]!.quarantined,
      trials: trials.map(t => ({ trial: t.trial, outcome: t.outcome, attempt, ...(t.failure_class ? { failure_class: t.failure_class } : {}) })) });
    return { run, lane, case: id, status: v.status, failsLane: v.failsLane, trials };
  });
}

export function redLedger(records: readonly Rec[]): RedLedger {
  const verdicts = verdictsOf(records).filter(v => v.status !== 'SKIPPED');
  const censusKey = (v: { run: string; lane: string }) => `${v.run}\0${v.lane}`;
  const censuses = new Map<string, CensusReds>();
  for (const v of verdicts) {
    const c = censuses.get(censusKey(v)) ?? { run: v.run, lane: v.lane, verdicts: 0, reds: [], byClass: {}, byCause: {} };
    c.verdicts++;
    if (v.failsLane) {
      c.reds.push({ run: v.run, lane: v.lane, case: v.case, status: v.status, trials: v.trials });
      for (const t of v.trials.filter(t => t.outcome === 'failed')) {
        c.byClass[t.failure_class ?? 'assertion'] = (c.byClass[t.failure_class ?? 'assertion'] ?? 0) + 1;
        c.byCause[t.failure_cause ?? 'unrecorded'] = (c.byCause[t.failure_cause ?? 'unrecorded'] ?? 0) + 1;
      }
    }
    censuses.set(censusKey(v), c);
  }
  const reds = verdicts.filter(v => v.failsLane).length;
  const rate = verdicts.length ? reds / verdicts.length : 0;
  const pooled = { verdicts: verdicts.length, reds, rate, ...wilson(reds, verdicts.length) };
  const byCase = new Map<string, { verdicts: number; reds: number }>();
  for (const v of verdicts) {
    const e = byCase.get(v.case) ?? { verdicts: 0, reds: 0 };
    e.verdicts++; if (v.failsLane) e.reds++;
    byCase.set(v.case, e);
  }
  const perCase = [...byCase.entries()].map(([id, e]) => ({ case: id, ...e, rate: (e.reds + RED_RATE_SHRINK * rate) / (e.verdicts + RED_RATE_SHRINK) }))
    .sort((a, b) => b.rate - a.rate || (a.case < b.case ? -1 : 1));
  const ordered = [...censuses.values()];
  const latestRun = ordered.map(c => c.run).sort().at(-1);
  const census = verdicts.filter(v => v.run === latestRun);
  const green = (prior: number) => census.reduce((p, v) => {
    const e = byCase.get(v.case)!;
    return p * (1 - (e.reds + RED_RATE_SHRINK * prior) / (e.verdicts + RED_RATE_SHRINK));
  }, 1);
  const allGreen = census.length ? { p: green(rate), lo: green(pooled.hi), hi: green(pooled.lo), verdicts: census.length } : null;
  return { censuses: ordered.sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : a.lane < b.lane ? -1 : 1)), pooled, perCase, allGreen };
}

const tally = (counts: Record<string, number>) => Object.entries(counts).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

export function formatRedLedger(ledger: RedLedger, opts: { top?: number } = {}): string[] {
  const lines = ['reds: verdict reds per census lane by failure class and machine cause (cause "unrecorded" = written before failure_cause existed)'];
  for (const c of ledger.censuses) {
    lines.push(`  ${c.run} ${c.lane}: ${c.reds.length} red of ${c.verdicts} verdicts${c.reds.length ? ` — class: ${tally(c.byClass)}; cause: ${tally(c.byCause)}` : ''}`);
    for (const red of c.reds) {
      const failed = red.trials.filter(t => t.outcome === 'failed');
      lines.push(`    ✗ ${red.case} ${red.status} ${failed.map(t => `t${t.trial} ${t.failure_class ?? 'assertion'}/${t.failure_cause ?? 'unrecorded'}`
        + `${t.error ? ` — ${sanitizeFixedFenceLine(t.error, 160)}` : ''}`).join('; ')}`);
    }
  }
  const p = ledger.pooled;
  lines.push(`pooled: ${p.reds} red of ${p.verdicts} verdicts = ${pct(p.rate)} per verdict [95% ${pct(p.lo)}–${pct(p.hi)}]`);
  const top = ledger.perCase.filter(c => c.reds > 0).slice(0, opts.top ?? 15);
  if (top.length) lines.push(`per-case red rates (shrunk toward the pooled rate, K=${RED_RATE_SHRINK}):`, ...top.map(c => `  ${pct(c.rate).padStart(6)}  ${c.reds}/${c.verdicts}  ${c.case}`));
  const g = ledger.allGreen;
  lines.push(g ? `all-green probability (approximation, assumes independent verdicts): ${pct(g.p)} for the latest census's ${g.verdicts} verdicts [${pct(g.lo)}–${pct(g.hi)} with the pooled rate's 95% interval as prior]; `
    + 'formula Π(1 - p_i) over its cases; rerun: bun run eval:pass-rates --reds' : 'all-green probability: no post-policy verdicts');
  lines.push(`guide: ${CENSUS_RED_GUIDE}`);
  return lines;
}

// --- One census's triage view ---

/** Fetches the report views make beyond the history loader: a named run and its slice jobs. */
export interface RunJobsFetcher { listJobs(repo: string, runId: number): JobTiming[]; getRun(repo: string, runId: number): WeeklyRun }

function ghJson(args: string[]): string[] {
  const result = spawnSync('gh', args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr || result.error || '').trim()}`);
  return result.stdout.toString('utf8').split('\n').filter(Boolean);
}

export const GH_JOBS: RunJobsFetcher = {
  listJobs: (repo, runId) => ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, '--paginate',
    '--jq', '.jobs[] | {name, startedAt: .started_at, completedAt: .completed_at}']).map(line => JSON.parse(line) as JobTiming),
  getRun: (repo, runId) => JSON.parse(ghJson(['api', `repos/${repo}/actions/runs/${runId}`,
    '--jq', '{id, attempt: .run_attempt, sha: .head_sha, branch: .head_branch, createdAt: .created_at}'])[0]!) as WeeklyRun,
};

/** The manifest shard key a record ran under: its trial shard, its case shard, or its file. */
export function recordShardKey(r: Pick<Rec, 'file' | 'case' | 'trial' | 'source'>): string {
  return r.source === 'shard' ? trialShardKey(r.file, r.case, r.trial) : CASE_SHARDED_FILES.includes(r.file) ? `${r.file}#${r.case}` : r.file;
}

/**
 * The run's reds with their values and history, and the slice artifacts that
 * hold their transcripts. Only the slices a red names are downloaded; a slice
 * over EVIDENCE_MAX_BYTES is reported, never silently skipped.
 */
export function triageRun(opts: { repo: string; run: WeeklyRun; records: readonly Rec[]; caseFilter?: string; cacheDir: string;
  fetcher: HistoryFetcher; download: (match: (name: string) => boolean, maxBytes: number) => string[] }): string[] {
  const runId = String(opts.run.id);
  const mine = opts.records.filter(r => r.run_id === runId);
  const reds = verdictsOf(mine).filter(v => v.failsLane && (!opts.caseFilter || v.case === opts.caseFilter));
  const lines = [`run ${runId} (${opts.run.branch} @ ${opts.run.sha.slice(0, 9)}, ${opts.run.createdAt}): ${reds.length} verdict red(s)${opts.caseFilter ? ` for ${opts.caseFilter}` : ''}`];
  const history = verdictsOf(opts.records);
  const plans = new Map<string, Map<string, number>>();
  const planFor = (lane: string) => {
    const name = lane.startsWith('gate') && lane.includes('census') ? 'gate-census-plan' : 'paid-plan';
    if (!plans.has(name)) {
      const files = new Map<string, number>();
      for (const dir of opts.download(n => n === name, 8 * 1024 * 1024)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
          for (const e of manifest.entries ?? []) if (e.status === 'planned' && Number.isInteger(e.slice)) files.set(e.file, e.slice);
        } catch { /* no manifest: slices stay unknown */ }
      }
      plans.set(name, files);
    }
    return { prefix: name === 'gate-census-plan' ? 'gate-census' : 'paid-slice', files: plans.get(name)! };
  };
  const artifacts = opts.fetcher.listArtifacts(opts.repo, opts.run.id);
  for (const red of reds) {
    const runs = history.filter(v => v.case === red.case);
    lines.push(`✗ ${red.case}  ${red.lane}  ${red.status}  (history: ${runs.filter(v => !v.failsLane).length}/${runs.length} verdicts green)`);
    for (const t of red.trials.filter(t => t.outcome === 'failed')) {
      const d = t.failure_detail;
      const detail = !d ? '' : 'judge' in d ? `  ${d.judge.map(j => `${j.dimension} ${j.mean} < ${j.threshold} (${j.samples} samples)${j.rationale ? ` "${j.rationale}"` : ''}`).join('; ')}`
        : `  Expected: ${d.expected} · Received: ${d.received}`;
      lines.push(sanitizeFixedFenceLine(`    t${t.trial}: ${t.failure_class ?? 'assertion'} / cause ${t.failure_cause ?? 'unrecorded'}`
        + `${t.failure_cause_evidence ? `: ${t.failure_cause_evidence}` : ''}${t.error ? ` — ${t.error}` : ''}${detail}`, 2000));
      const plan = planFor(red.lane);
      const slice = plan.files.get(recordShardKey(t));
      if (slice === undefined) { lines.push('    evidence: slice unknown (no plan artifact for this lane)'); continue; }
      const name = `${plan.prefix}-${slice}-a${t.attempt}`;
      const artifact = artifacts.find(a => a.name === name);
      if (!artifact) { lines.push(`    evidence: ${name} (expired or missing)`); continue; }
      if (artifact.size > EVIDENCE_MAX_BYTES) { lines.push(`    evidence: ${name} too large to fetch (${Math.round(artifact.size / 1024 / 1024)} MB)`); continue; }
      const [dir] = opts.download(n => n === name, EVIDENCE_MAX_BYTES);
      lines.push(`    evidence: ${dir ? path.join(dir, 'shards', shardSlug([recordShardKey(t)])) : `${name} (download failed)`}`);
    }
  }
  return lines;
}

// --- Flags ---

export const PASS_RATES_USAGE = `Usage: bun run eval:pass-rates [options]
  (no view flag)       per-case trial pass rates with 95% Wilson intervals
  --headroom           slowest armed session per case vs its budget, case wall upper bound, census critical path
  --reds               verdict reds per census by failure class and cause, pooled and per-case rates, all-green probability
  --run <id>           one census: each red with its values, history and fetched transcript evidence
  --case <id>          restrict every view, the JSON and the alarms to one registered case
  --runs <n>           completed runs per branch to read (default 10)
  --branch <name>      branch whose runs to read beside main (default: current branch)
  --repo <owner/repo>  --workflow <file>  --dir <path> (repeatable, local artifacts; no network)
  --backfill           also import legacy slice artifacts, labeled pre-policy
  --since-days <n>     legacy eval files window for --dir (default 60)
  --json               machine-readable output
  --gate               exit 1 on ACTION REQUIRED (pass-rate alarms and sessions above ${pct(HEADROOM_FAIL)} of budget)
  --help               this text (no network)`;

export interface PassRatesArgs {
  view: 'rates' | 'headroom' | 'reds' | 'run';
  runId?: number; caseFilter?: string; runs: number; sinceDays: number; dirs: string[];
  json: boolean; gate: boolean; backfill: boolean; repo?: string; workflow?: string; branch?: string;
}

/** Parse eval:pass-rates flags; unknown flags, bad values and unknown case ids are errors (exit 2, before any fetch). */
export function parsePassRatesArgs(argv: readonly string[], isKnownCase: (id: string) => boolean): { help: true } | { error: string } | PassRatesArgs {
  const out: PassRatesArgs = { view: 'rates', runs: 10, sinceDays: 60, dirs: [], json: false, gate: false, backfill: false };
  const views: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`); return v; };
    const count = () => { const v = value(); if (!/^[1-9]\d*$/.test(v)) throw new Error(`${arg} needs a positive integer, got ${v}`); return Number(v); };
    try {
      switch (arg) {
        case '--help': case '-h': return { help: true };
        case '--headroom': views.push('headroom'); break;
        case '--reds': views.push('reds'); break;
        case '--run': views.push('run'); out.runId = count(); break;
        case '--case': out.caseFilter = value(); break;
        case '--runs': out.runs = count(); break;
        case '--since-days': out.sinceDays = count(); break;
        case '--dir': out.dirs.push(value()); break;
        case '--repo': out.repo = value(); break;
        case '--workflow': out.workflow = value(); break;
        case '--branch': out.branch = value(); break;
        case '--json': out.json = true; break;
        case '--gate': out.gate = true; break;
        case '--backfill': out.backfill = true; break;
        default: return { error: `unknown flag ${arg}` };
      }
    } catch (error) { return { error: (error as Error).message }; }
  }
  if (views.length > 1) return { error: `choose one of --headroom, --reds, --run (got ${views.join(', ')})` };
  if (views[0]) out.view = views[0] as PassRatesArgs['view'];
  if (out.caseFilter !== undefined && !isKnownCase(out.caseFilter)) return { error: `unknown case ${out.caseFilter} (not an E2E, judge or paid test file id)` };
  if (out.view === 'run' && out.dirs.length) return { error: '--run reads one GitHub run; it cannot combine with --dir' };
  return out;
}
