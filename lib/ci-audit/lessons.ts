import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditData } from './collect';
import { dist, isBurst, percentile, type JobGroup, type Measures } from './measure';
import { priceRunner } from './prices';
import type { StaticView } from './static';

export type LessonState = 'pass' | 'finding' | 'unknown' | 'not_applicable';
export interface Saving { prMinutes: number | null; jobMinutesPerWeek: number | null; usdPerMonth: number | null; measured: boolean; note: string }
export interface Lesson { id: number; name: string; state: LessonState; summary: string; evidence: string[]; fix?: string; saving?: Saving; caution?: string }
export interface LogEvidence { cacheHits: number; cacheMisses: number; logsRead: number; ubicloudFamily?: 'premium' | 'standard' }
export interface LessonContext { data: AuditData; m: Measures; st: StaticView | null; logs?: LogEvidence; prices?: Record<string, { usd: number; source?: string }> }

export const LESSON_NAMES = ['', 'Fast runners for every job', 'Fast, strict lint', 'The fastest typechecker', 'Bigger machines, not more shards',
  'Stop reloading the app per test file', 'Fix setup: caches, checkout, parallelism', 'Run every job in parallel; split the slowest',
  'Only run what a PR touches, and test that skip logic', 'Checks in a pre-push hook'] as const;

const fmt = (s: number | null) => (s == null ? 'n/a' : s >= 120 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
const mk = (id: number, state: LessonState, summary: string, extra: Partial<Lesson> = {}): Lesson => ({ id, name: LESSON_NAMES[id]!, state, summary, evidence: [], ...extra });
const unknownStatic = (id: number) => mk(id, 'unknown', 'needs a local checkout of this repository to read its config', { evidence: ['run from a checkout whose origin is this repository'] });

function runsPerWeek(c: LessonContext, workflow: string): number {
  const n = c.data.runs.filter(r => r.path === workflow).length;
  return c.m.windowDays > 0 ? (n / c.m.windowDays) * 7 : 0;
}
const allRunText = (st: StaticView) => st.workflows.flatMap(w => w.jobs.flatMap(j => j.steps.map(s => s.run ?? ''))).join('\n') + '\n' + Object.values(st.packageScripts).join('\n');
/** The longest matching step per job, so a short helper step named like the tool does not hide the real one. */
function stepDist(c: LessonContext, re: RegExp) {
  return dist(c.m.jobs.map(j => Math.max(0, ...j.steps.filter(s => !s.setup && re.test(s.name)).map(s => s.s))).filter(s => s > 0));
}

export function lessonRunners(c: LessonContext): Lesson {
  const groups = c.m.groups.filter(g => g.n >= 5);
  if (!groups.length) return mk(1, 'unknown', 'fewer than 5 sampled runs per job', { evidence: [`${c.m.sampledRuns} runs sampled`] });
  const priced = groups.map(g => ({ g, p: priceRunner(g.labels, c.data.isPrivate, c.prices, c.logs?.ubicloudFamily) }));
  const slow = priced.filter(({ g }) => (g.wait.p90 ?? 0) > 60 && (g.wait.p90 ?? 0) > (g.run.p50 ?? 0));
  if (!slow.length) return mk(1, 'pass', `every job's p90 wait is under a minute or below its own running time`, { evidence: groups.slice(0, 3).map(g => `${g.key}: wait p50 ${fmt(g.wait.p50)}, p90 ${fmt(g.wait.p90)} (n=${g.n})`) });
  const burst = isBurst(slow.flatMap(({ g }) => g.longWaits));
  const hosted = slow.filter(({ p }) => p.kind === 'github-hosted');
  const evidence = slow.slice(0, 5).map(({ g, p }) => `${g.key} on ${p.label}: wait p50 ${fmt(g.wait.p50)}, p90 ${fmt(g.wait.p90)} for ${fmt(g.run.p50)} of work; ${g.longWaits.length} of ${g.n} waited over a minute`);
  if (burst) return mk(1, 'finding', 'long waits cluster in a few hours: the repo starts more jobs at once than its runner pool takes', { evidence, fix: 'cap concurrency (concurrency groups with cancel-in-progress, fewer parallel jobs during bursts) before changing runners' });
  const weekly = hosted.reduce((a, { g }) => a + (g.jobMinutes / Math.max(1, c.m.windowDays)) * 7, 0);
  const caution = !c.data.isPrivate && hosted.length ? 'a third-party runner executes fork PR code on its machines: review that before moving pull_request jobs' : undefined;
  return mk(1, 'finding', hosted.length ? `${hosted.length} GitHub-hosted job(s) wait longer for a machine than they run` : `${slow.length} job(s) on non-GitHub runners still queue over a minute`, {
    evidence, caution,
    fix: hosted.length ? 'move every job, including the tiny ones, to the same fast runner pool as the rest' : 'raise the runner pool size or concurrency limit with your runner provider',
    saving: { prMinutes: null, jobMinutesPerWeek: null, usdPerMonth: hosted.length && !c.data.isPrivate ? +(weekly * 4.33 * 0.00125).toFixed(2) : null, measured: false, note: hosted.length && !c.data.isPrivate ? 'adds about this much per month at Ubicloud standard-2 rates (these jobs are free on GitHub today)' : 'cuts the p90 wait tail' },
  });
}

export function lessonLint(c: LessonContext): Lesson {
  if (!c.st) return unknownStatic(2);
  const text = allRunText(c.st) + ' ' + c.st.deps.join(' ');
  const lint = stepDist(c, /lint/i);
  if (/\b(oxlint|biome|ruff|golangci-lint)\b/.test(text)) return mk(2, 'pass', 'a fast linter is in use', { evidence: [`lint step p50 ${fmt(lint.p50)} (n=${lint.n})`] });
  if (/\beslint\b/.test(text)) {
    if (lint.n && (lint.p50 ?? 0) > 30) return mk(2, 'finding', `ESLint takes ${fmt(lint.p50)} per run`, { evidence: [`lint steps p50 ${fmt(lint.p50)}, p90 ${fmt(lint.p90)} (n=${lint.n})`], fix: 'run Oxlint (or Biome) with every rule you can turn on; keep ESLint only for rules they lack', saving: { prMinutes: null, jobMinutesPerWeek: null, usdPerMonth: null, measured: false, note: `Owen measured 2 min to 5 s; here up to ${fmt(lint.p50)} per run` } });
    return mk(2, lint.n ? 'pass' : 'unknown', lint.n ? `ESLint runs in ${fmt(lint.p50)}` : 'ESLint is configured but no CI step named lint was sampled', { evidence: [`lint steps n=${lint.n}`] });
  }
  return mk(2, 'unknown', 'no recognized linter (eslint, oxlint, biome, ruff, golangci-lint) in scripts or workflows');
}

export function lessonTypecheck(c: LessonContext): Lesson {
  if (!c.st) return unknownStatic(3);
  if (!c.st.files.some(f => /(^|\/)tsconfig[^/]*\.json$/.test(f))) return mk(3, 'not_applicable', 'no tsconfig.json in the repository');
  const text = allRunText(c.st);
  const tc = stepDist(c, /type ?check|tsc|tsgo/i);
  if (/\b(tsgo|bun check)\b/.test(text)) return mk(3, 'pass', 'a native typechecker is in use', { evidence: [`typecheck step p50 ${fmt(tc.p50)} (n=${tc.n})`] });
  if (!tc.n) return mk(3, 'unknown', 'no CI step named typecheck/tsc was sampled');
  if ((tc.p50 ?? 0) <= 20) return mk(3, 'pass', `tsc runs in ${fmt(tc.p50)}`, { evidence: [`n=${tc.n}`] });
  return mk(3, 'finding', `tsc takes ${fmt(tc.p50)} per run`, { evidence: [`typecheck steps p50 ${fmt(tc.p50)}, p90 ${fmt(tc.p90)} (n=${tc.n})`], fix: 'benchmark tsgo (TypeScript 7) or bun check on this repo and switch CI to the fastest', saving: { prMinutes: null, jobMinutesPerWeek: null, usdPerMonth: null, measured: false, note: 'Owen measured 70 s on tsc to under 5 s' } });
}

function shardGroups(c: LessonContext): JobGroup[] {
  const counts = new Map<string, Set<number>>();
  for (const j of c.m.jobs) { const k = `${j.workflow} / ${j.job}`; const s = counts.get(k) ?? new Set(); s.add(j.runId); counts.set(k, s); }
  return c.m.groups.filter(g => g.n >= 4 * (counts.get(g.key)?.size ?? 1));
}

export function lessonShards(c: LessonContext): Lesson {
  const sharded = shardGroups(c);
  if (!sharded.length) return mk(4, 'not_applicable', 'no job runs as four or more parallel shards');
  const heavy = sharded.filter(g => (g.setup.p50 ?? 0) >= 0.3 * ((g.setup.p50 ?? 0) + (g.run.p50 ?? 0)));
  const evidence = sharded.slice(0, 4).map(g => { const p = priceRunner(g.labels, c.data.isPrivate, c.prices, c.logs?.ubicloudFamily); return `${g.key} on ${p.label} (${p.vcpu ?? '?'} vCPU): setup p50 ${fmt(g.setup.p50)}, running p50 ${fmt(g.run.p50)}`; });
  if (!heavy.length) return mk(4, 'pass', 'shards spend most of their time running tests, not setting up', { evidence });
  const g = heavy[0]!;
  const runs = runsPerWeek(c, g.workflow);
  const perRunShards = g.n / Math.max(1, new Set(c.m.jobs.filter(j => `${j.workflow} / ${j.job}` === g.key).map(j => j.runId)).size);
  const saved = (perRunShards / 2) * ((g.setup.p50 ?? 0) / 60) * runs;
  return mk(4, 'finding', `${heavy.length} sharded job(s) spend 30% or more of each shard on setup`, { evidence, fix: 'halve the shard count on machines with twice the cores, and match test concurrency to cores; measure the slowest shard before and after', saving: { prMinutes: null, jobMinutesPerWeek: Math.round(saved), usdPerMonth: null, measured: false, note: 'setup minutes no longer repeated per shard; wall time is unknown until measured' } });
}

export function lessonIsolation(c: LessonContext): Lesson {
  if (!c.st) return unknownStatic(5);
  const cfg = c.st.files.filter(f => /(^|\/)(vitest|vite)\.config\.[cm]?[jt]s$/.test(f));
  const text = allRunText(c.st) + ' ' + c.st.deps.join(' ');
  if (cfg.length || /\bvitest\b/.test(text)) {
    const off = cfg.some(f => { try { return /isolate\s*:\s*false/.test(fs.readFileSync(path.join(c.st!.root, f), 'utf8')); } catch { return false; } });
    return off ? mk(5, 'pass', 'Vitest runs with isolate: false', { evidence: cfg }) : mk(5, 'finding', 'Vitest gives every test file a fresh worker that reloads the app', { evidence: cfg.length ? cfg : ['vitest in package.json'], fix: 'set isolate: false and add a hook that resets shared state after each file; tell agents what a test must clean up', saving: { prMinutes: null, jobMinutesPerWeek: null, usdPerMonth: null, measured: false, note: 'Owen measured 100 s to 35 s per shard' } });
  }
  if (/\bbun test\b/.test(text)) return mk(5, 'pass', 'bun test runs files in one process by default');
  if (/\bjest\b/.test(text)) return mk(5, 'unknown', 'Jest has no isolate: false; measure per-file module load time before changing runners');
  return mk(5, 'unknown', 'no recognized JS test runner (vitest, jest, bun test)');
}

export function lessonSetup(c: LessonContext): Lesson {
  if (!c.m.groups.length) return mk(6, 'unknown', 'no job details were sampled');
  const findings: string[] = [];
  const evidence: string[] = [];
  const heavy = c.m.groups.filter(g => (g.setup.p50 ?? 0) >= 30 && (g.setup.p50 ?? 0) >= 0.25 * ((g.setup.p50 ?? 0) + (g.run.p50 ?? 0)));
  for (const g of heavy.slice(0, 3)) evidence.push(`${g.key}: setup p50 ${fmt(g.setup.p50)} against running p50 ${fmt(g.run.p50)} (n=${g.n})`);
  if (heavy.length) findings.push(`${heavy.length} job(s) spend a quarter or more of their time on setup`);
  if (c.data.caches) {
    const main = c.data.caches.filter(x => x.ref === `refs/heads/${c.data.defaultBranch}`).length;
    const prRefs = c.data.caches.filter(x => x.ref.startsWith('refs/pull/')).length;
    evidence.push(`caches: ${c.data.caches.length} entries, ${main} on ${c.data.defaultBranch}, ${prRefs} on PR refs`);
    if (prRefs && !main) findings.push(`no cache is saved from ${c.data.defaultBranch}, so every PR starts cold (GitHub scopes PR caches to their own branch)`);
  } else evidence.push('caches: not read');
  if (c.logs?.logsRead) {
    const total = c.logs.cacheHits + c.logs.cacheMisses;
    evidence.push(`cache restores in ${c.logs.logsRead} sampled logs: ${c.logs.cacheHits} hit, ${c.logs.cacheMisses} missed`);
    if (total && c.logs.cacheMisses / total > 0.1) findings.push(`${Math.round((100 * c.logs.cacheMisses) / total)}% of sampled cache restores missed`);
  } else evidence.push('cache hit rate: unknown without logs (run with --logs 20)');
  if (c.st) {
    const deep = c.st.workflows.flatMap(w => w.jobs.flatMap(j => j.steps.filter(s => /actions\/checkout/.test(s.uses ?? '') && String(s.with?.['fetch-depth'] ?? '') === '0' && !s.with?.filter).map(() => `${w.file} / ${j.id}`)));
    if (deep.length) { findings.push(`${deep.length} full-history checkout(s) without filter: blob:none`); evidence.push(`full-history checkouts: ${deep.slice(0, 3).join(', ')}${deep.length > 3 ? ', ...' : ''}`); }
    const over = new Set<string>();
    for (const w of c.st.workflows) for (const j of w.jobs) {
      const vcpu = priceRunner(j.runsOn, c.data.isPrivate, c.prices).vcpu;
      const n = Math.max(0, ...j.steps.map(s => concurrencyFlag(s.run)));
      if (n && vcpu && n > 2 * vcpu) over.add(`${w.file} / ${j.id} runs ${n} tasks on ${vcpu} vCPU`);
    }
    if (over.size) { findings.push(`${over.size} job(s) run more parallel tasks than twice their cores`); evidence.push(...[...over].slice(0, 3)); }
  }
  if (!findings.length) return mk(6, 'pass', 'setup is a small share of each job and caches are seeded from the default branch', { evidence });
  const has = (re: RegExp) => findings.some(f => re.test(f));
  const fix = [
    has(/cache/) && `seed the dependency cache from ${c.data.defaultBranch} (a push or nightly run there that saves it), since PRs can read only their own and the default branch's caches`,
    has(/setup/) && 'cache installed dependencies, not only the download cache',
    has(/full-history/) && 'add filter: blob:none to full-history checkouts',
    has(/parallel tasks/) && 'match task concurrency to the runner\'s cores',
  ].filter(Boolean).join('; ');
  return mk(6, 'finding', findings.join('; '), { evidence, fix });
}

export function lessonParallel(c: LessonContext): Lesson {
  const heads = c.m.cohort.heads;
  if (heads.length < 8) return mk(7, 'unknown', `only ${heads.length} comparable all-green PR heads in the window`);
  const top = c.m.cohort.bottlenecks[0]!;
  const gaps = heads.filter(h => h.bottleneck === top.workflow).map(h => (Date.parse(h.end) - Date.parse(h.secondEnd)) / 1000);
  const gap = percentile(gaps, 0.5) ?? 0;
  const evidence = [`push to all green p50 ${fmt(c.m.cohort.total.p50)}, p90 ${fmt(c.m.cohort.total.p90)} (n=${heads.length})`, ...c.m.cohort.bottlenecks.slice(0, 3).map(b => `${b.workflow} finished last on ${Math.round(b.share * 100)}% of heads`), `when ${top.workflow} finished last, the next check finished ${fmt(gap)} earlier (median)`];
  if (top.share < 0.5 || gap < 120) return mk(7, 'pass', 'no single check holds every PR back by two minutes or more', { evidence });
  const slowest = c.m.groups.filter(g => g.workflow === top.workflow).sort((a, b) => (b.wait.p50 ?? 0) + (b.setup.p50 ?? 0) + (b.run.p50 ?? 0) - ((a.wait.p50 ?? 0) + (a.setup.p50 ?? 0) + (a.run.p50 ?? 0)))[0];
  const waiting = slowest && (slowest.wait.p50 ?? 0) > (slowest.setup.p50 ?? 0) + (slowest.run.p50 ?? 0);
  const late = `${top.workflow} finishes last on ${Math.round(top.share * 100)}% of PR heads, a median ${fmt(gap)} after everything else`;
  return mk(7, 'finding', waiting ? `${late}, mostly waiting for a machine (${slowest!.key}: wait p50 ${fmt(slowest!.wait.p50)} for ${fmt((slowest!.setup.p50 ?? 0) + (slowest!.run.p50 ?? 0))} of work)` : late, { evidence, fix: waiting ? `move ${top.workflow}'s jobs to the same fast runner pool as the rest (lesson 1); splitting a job that mostly waits would not help` : `run everything in parallel and split ${top.workflow}'s slowest job (move unrelated steps into their own job)`, saving: { prMinutes: +((gap / 60) * top.share).toFixed(1), jobMinutesPerWeek: null, usdPerMonth: null, measured: true, note: 'upper bound per PR: the slowest check can finish no earlier than the next one' } });
}

/** A test-runner concurrency flag in a run line (bun --max-concurrency, jest --maxWorkers, vitest --maxConcurrency, make -j). */
export function concurrencyFlag(run?: string): number {
  const m = /(?:--max-?concurrency[= ]|--maxWorkers[= ]|--max-workers[= ]|\bmake\b[^\n]*\s-j\s?)(\d+)/i.exec(run ?? '');
  return m ? Number(m[1]) : 0;
}

const SELECTOR = /\b(nx affected|turbo .*--filter|--changed|--affected|dorny\/paths-filter|tj-actions\/changed-files|pregate|test-free-shards)\b/;

export function lessonAffected(c: LessonContext): Lesson {
  if (!c.st) return unknownStatic(8);
  const text = allRunText(c.st);
  const filtered = c.st.workflows.filter(w => w.prTrigger && w.prPathFilter).map(w => w.file);
  const selector = SELECTOR.exec(text)?.[1];
  const full = c.st.workflows.filter(w => (w.schedule || w.pushDefault) && /\btest\b/.test(w.text)).map(w => w.file);
  const evidence = [`path-filtered PR workflows: ${filtered.length ? filtered.join(', ') : 'none'}`, `selector in scripts: ${selector ?? 'none'}`, `full runs on schedule or ${c.data.defaultBranch}: ${full.length ? full.join(', ') : 'none'}`];
  if (!filtered.length && !selector) {
    const slowest = c.m.cohort.total.p50 ?? 0;
    return slowest > 300 ? mk(8, 'finding', 'every PR runs the whole suite', { evidence, fix: 'select tests from the diff (nx affected or a file-to-test map), run the full suite nightly, and add a test that hides a change from the selector and expects a failure' }) : mk(8, 'pass', 'no skip logic, and PRs go green in under five minutes', { evidence });
  }
  const tested = c.st.testFilesMentioning(/paths-ignore|paths-filter|affected|selection|changed-files|pregate/);
  evidence.push(`tests that exercise the selector: ${tested.length ? tested.slice(0, 3).join(', ') : 'none found'}`);
  const gaps = [!full.length && 'no full run on a schedule or the default branch', !tested.length && 'no test exercises the skip logic, so a change it hides passes green'].filter(Boolean) as string[];
  if (!gaps.length) return mk(8, 'pass', 'PRs run a selected subset, a full run covers the rest, and the selector has tests', { evidence });
  return mk(8, 'finding', gaps.join('; '), { evidence, fix: 'run the full suite nightly on the default branch and add a test that hides a change from the selector and asserts the run fails' });
}

export function lessonHook(c: LessonContext): Lesson {
  if (!c.st) return unknownStatic(9);
  const h = c.st.hook;
  if (!h) return mk(9, 'finding', 'no pre-push hook', { fix: 'add a pre-push hook (in the hook manager the repo already uses) that runs format, lint and typecheck on changed files in seconds; a line in AGENTS.md gets skipped' });
  if (!h.runs.includes('lint') && !h.runs.includes('typecheck')) return mk(9, 'finding', `the ${h.manager} pre-push hook runs no lint or typecheck`, { evidence: [h.file], fix: 'add lint and typecheck on changed files to the existing hook; never install a second hook manager over it' });
  return mk(9, 'pass', `${h.manager} pre-push hook runs ${h.runs.join(', ')}`, { evidence: [h.file] });
}

export function lessons(c: LessonContext): Lesson[] {
  return [lessonRunners, lessonLint, lessonTypecheck, lessonShards, lessonIsolation, lessonSetup, lessonParallel, lessonAffected, lessonHook].map(f => f(c));
}
