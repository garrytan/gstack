import type { AuditData, Job, Run } from './collect';

export const SETUP_STEP = /^(set up job|complete job|initialize containers|stop containers|post |.*\bcheckout\b|.*\bsetup[- _]?(node|bun|python|go|java|ruby|dotnet|uv|pnpm|deno|rust|toolchain|gradle|buildx|qemu)\b|.*\bcache\b|.*\brestore\b|install( dependencies| deps)?$|.*\b(npm ci|npm install|pnpm install|yarn install|bun install|pip install|uv sync|bundle install|poetry install)\b|download .*artifact|.*login\b)/i;

export const sec = (a?: string | null, b?: string | null): number => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : 0);

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

export interface JobPhases { workflow: string; job: string; runId: number; labels: string[]; waitS: number; setupS: number; runS: number; createdAt: string; startedAt: string; completedAt: string; steps: { name: string; s: number; setup: boolean }[] }

export function jobKey(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').replace(/\s+\d+(\s*\/\s*\d+)?$/, '').trim();
}

export function phases(run: Run, job: Job): JobPhases | null {
  if (!job.started_at || !job.completed_at || job.conclusion === 'skipped') return null;
  if (!job.labels?.length && !job.steps?.length) return null;
  const steps = (job.steps ?? []).map(s => ({ name: s.name, s: sec(s.started_at, s.completed_at), setup: SETUP_STEP.test(s.name) }));
  return {
    workflow: run.path, job: jobKey(job.name), runId: run.id, labels: job.labels ?? [],
    waitS: sec(job.created_at, job.started_at),
    setupS: steps.filter(s => s.setup).reduce((a, s) => a + s.s, 0),
    runS: steps.filter(s => !s.setup).reduce((a, s) => a + s.s, 0),
    createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at, steps,
  };
}

export interface Dist { n: number; p50: number | null; p90: number | null }
export const dist = (v: number[]): Dist => ({ n: v.length, p50: percentile(v, 0.5), p90: percentile(v, 0.9) });

export interface JobGroup { key: string; workflow: string; job: string; labels: string; n: number; wait: Dist; setup: Dist; run: Dist; longWaits: string[]; jobMinutes: number; billedMinutes: number }

export interface HeadSample { sha: string; prs: number[]; base: string; start: string; end: string; seconds: number; workflows: string[]; bottleneck: string; secondEnd: string }

export interface Cohort { heads: HeadSample[]; excluded: Record<string, number>; total: Dist; bottlenecks: { workflow: string; share: number }[]; failures: Dist }

export interface Measures { jobs: JobPhases[]; groups: JobGroup[]; cohort: Cohort; preJob: Dist; sampledRuns: number; windowDays: number }

const EDGE_MS = 30 * 60_000;

/** Push to all checks done per PR head, counting only heads whose every run settled green on its first attempt. */
export function cohort(runs: Run[], since: string, base?: string): Cohort {
  const byHead = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.event !== 'pull_request') continue;
    if (base && r.pull_requests?.length && !r.pull_requests.some(p => p.base?.ref === base)) continue;
    const list = byHead.get(r.head_sha) ?? [];
    list.push(r);
    byHead.set(r.head_sha, list);
  }
  const excluded: Record<string, number> = { unsettled: 0, cancelled_or_superseded: 0, rerun: 0, window_edge: 0 };
  const heads: HeadSample[] = [];
  const failures: number[] = [];
  const edge = Date.parse(since) + EDGE_MS;
  for (const [sha, list] of byHead) {
    const start = list.reduce((m, r) => (r.created_at < m ? r.created_at : m), list[0]!.created_at);
    if (Date.parse(start) < edge) { excluded.window_edge!++; continue; }
    if (list.some(r => r.status !== 'completed')) { excluded.unsettled!++; continue; }
    if (list.some(r => r.conclusion === 'cancelled')) { excluded.cancelled_or_superseded!++; continue; }
    if (list.some(r => (r.run_attempt ?? 1) > 1)) { excluded.rerun!++; continue; }
    const counted = list.filter(r => r.conclusion !== 'skipped' && r.conclusion !== 'neutral');
    const failed = counted.filter(r => r.conclusion !== 'success');
    if (failed.length) {
      const firstFail = failed.reduce((m, r) => (r.updated_at < m ? r.updated_at : m), failed[0]!.updated_at);
      failures.push(sec(start, firstFail));
      continue;
    }
    if (!counted.length) continue;
    const ordered = [...counted].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    heads.push({
      sha, prs: [...new Set(list.flatMap(r => (r.pull_requests ?? []).map(p => p.number)))], base: list[0]!.pull_requests?.[0]?.base?.ref ?? '',
      start, end: ordered[0]!.updated_at, seconds: sec(start, ordered[0]!.updated_at),
      workflows: [...new Set(counted.map(r => r.path))].sort(), bottleneck: ordered[0]!.path, secondEnd: ordered[1]?.updated_at ?? start,
    });
  }
  const counts = new Map<string, number>();
  for (const h of heads) counts.set(h.bottleneck, (counts.get(h.bottleneck) ?? 0) + 1);
  const bottlenecks = [...counts].map(([workflow, n]) => ({ workflow, share: n / heads.length })).sort((a, b) => b.share - a.share);
  return { heads, excluded, total: dist(heads.map(h => h.seconds)), bottlenecks, failures: dist(failures) };
}

/** Long waits that fall in a few one-hour windows are a burst of the repo's own jobs, not a slow runner pool. */
export function isBurst(longWaitTimes: string[]): boolean {
  if (longWaitTimes.length < 5) return false;
  const hours = new Map<string, number>();
  for (const t of longWaitTimes) hours.set(t.slice(0, 13), (hours.get(t.slice(0, 13)) ?? 0) + 1);
  const top3 = [...hours.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  return top3 / longWaitTimes.length >= 0.7;
}

export function measure(data: AuditData): Measures {
  const runById = new Map(data.runs.map(r => [r.id, r]));
  const jobs: JobPhases[] = [];
  const preJob: number[] = [];
  for (const [id, list] of Object.entries(data.jobs)) {
    const run = runById.get(Number(id));
    if (!run) continue;
    const firstJob = list.reduce<string | null>((m, j) => (!m || j.created_at < m ? j.created_at : m), null);
    if (firstJob) preJob.push(sec(run.run_started_at ?? run.created_at, firstJob));
    for (const j of list) { const p = phases(run, j); if (p) jobs.push(p); }
  }
  const byKey = new Map<string, JobPhases[]>();
  for (const j of jobs) { const k = `${j.workflow} / ${j.job}\u0000${j.labels.join(',')}`; byKey.set(k, [...(byKey.get(k) ?? []), j]); }
  const runnersPerJob = new Map<string, number>();
  for (const k of byKey.keys()) { const base = k.split('\u0000')[0]!; runnersPerJob.set(base, (runnersPerJob.get(base) ?? 0) + 1); }
  const groups: JobGroup[] = [...byKey].map(([k, v]) => {
    const [base, labels] = k.split('\u0000') as [string, string];
    return { key: runnersPerJob.get(base)! > 1 ? `${base} (${labels})` : base, workflow: v[0]!.workflow, job: v[0]!.job, labels, n: v.length,
    wait: dist(v.map(x => x.waitS)), setup: dist(v.map(x => x.setupS)), run: dist(v.map(x => x.runS)),
    longWaits: v.filter(x => x.waitS > 60).map(x => x.createdAt),
    jobMinutes: v.reduce((a, x) => a + (x.setupS + x.runS) / 60, 0),
    billedMinutes: v.reduce((a, x) => a + Math.ceil(sec(x.startedAt, x.completedAt) / 60), 0),
  }; }).sort((a, b) => b.jobMinutes - a.jobMinutes);
  return { jobs, groups, cohort: cohort(data.runs, data.since, data.defaultBranch), preJob: dist(preJob), sampledRuns: Object.keys(data.jobs).length, windowDays: sec(data.since, data.until) / 86400 };
}
