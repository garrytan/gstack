import { AuditError, Budget, assertRepo, pool, type ApiClient } from './github';
import type { LogEvidence } from './lessons';

export interface Step { name: string; started_at: string | null; completed_at: string | null; conclusion: string | null }
export interface Job { id: number; run_id: number; name: string; status: string; conclusion: string | null; created_at: string; started_at: string | null; completed_at: string | null; labels: string[]; steps: Step[] }
export interface Run { id: number; name: string; path: string; event: string; head_sha: string; head_branch: string; status: string; conclusion: string | null; created_at: string; run_started_at?: string; updated_at: string; run_attempt: number; head_repository?: { full_name?: string }; pull_requests?: { number: number; base?: { ref?: string } }[] }
export interface Cache { key: string; ref: string; size_in_bytes: number; last_accessed_at: string }

export interface AuditData {
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
  since: string;
  until: string;
  runs: Run[];
  jobs: Record<number, Job[]>;
  caches: Cache[] | null;
  partial: string[];
  notes: string[];
  calls: number;
  sampledPerWorkflow: number;
  /** Runs per workflow file over the requested window (from per-workflow total_count, not capped at 1,000), for scaling cost. */
  runCounts?: { since: string; byPath: Record<string, number> } | null;
}

export interface CollectOptions { repo: string; sinceDays: number; runsPerWorkflow: number; workflows?: string[]; now?: number; /** ISO end of the window; runs created after it are left out. */ until?: string; concurrency?: number; maxRunPages?: number }

const RATE_HEADROOM = 500;

export async function preflight(client: ApiClient, budget: Budget): Promise<{ limit: number; remaining: number; reset: number } | null> {
  const res = await client.get('/rate_limit');
  const core = (res.json as any)?.resources?.core;
  if (res.status !== 200 || !core) return null;
  const need = budget.maxCalls - budget.used + Math.min(RATE_HEADROOM, Math.floor(core.limit / 10));
  if (core.remaining < need) {
    const reset = new Date(core.reset * 1000).toISOString();
    throw new AuditError('ci_audit_rate_limit', `${core.remaining} of ${core.limit} GitHub calls left this hour; this run needs up to ${need}`, `after ${reset}`);
  }
  return core;
}

/** A runs list query; GitHub returns at most 1,000 results, so `capped` says the oldest runs in the window were cut. */
export async function listRuns(client: ApiClient, repo: string, query: string, maxPages: number, partial: string[], capped?: { hit: boolean }, at: { firstPage?: number; workflow?: string } = {}): Promise<Run[]> {
  const runs: Run[] = [];
  const first = at.firstPage ?? 1;
  const list = at.workflow ? `/repos/${repo}/actions/workflows/${encodeURIComponent(at.workflow)}/runs` : `/repos/${repo}/actions/runs`;
  for (let page = first; page < first + maxPages; page++) {
    const res = await client.get(`${list}?per_page=100&page=${page}&${query}`);
    if (res.status === 404) throw new AuditError('ci_audit_repo_unreadable', `no Actions runs readable for ${repo} (HTTP 404)`);
    if (res.status !== 200) throw new AuditError('ci_audit_api_failed', `runs list returned HTTP ${res.status}`, 'now');
    const batch = ((res.json as any)?.workflow_runs ?? []) as Run[];
    runs.push(...batch);
    if (batch.length < 100) return runs;
    if (page * 100 >= 1000) { if (capped) capped.hit = true; else partial.push('runs list reached GitHub\'s 1,000-result cap'); return runs; }
  }
  partial.push(`runs list stopped at ${maxPages} pages`);
  return runs;
}

export async function listJobs(client: ApiClient, repo: string, run: Run): Promise<Job[] | null> {
  const jobs: Job[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await client.get(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt || 1}/jobs?per_page=100${page > 1 ? `&page=${page}` : ''}`);
    if (res.status !== 200) return page === 1 ? null : jobs;
    const got = ((res.json as any)?.jobs ?? []) as Job[];
    jobs.push(...got);
    if (got.length < 100 || jobs.length >= Number((res.json as any)?.total_count ?? 0)) return jobs;
  }
  return jobs;
}

/** Newest completed runs per workflow file, the sample whose jobs get fetched. */
export function sampleRuns(runs: Run[], perWorkflow: number, workflows?: string[]): Run[] {
  const byPath = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.status !== 'completed' || r.conclusion === 'cancelled' || r.conclusion === 'skipped') continue;
    if (r.event !== 'pull_request' && r.event !== 'push') continue;
    if (workflows && !workflows.some(w => r.path.endsWith(w))) continue;
    const list = byPath.get(r.path) ?? [];
    list.push(r);
    byPath.set(r.path, list);
  }
  const out: Run[] = [];
  for (const list of byPath.values()) out.push(...list.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, perWorkflow));
  return out;
}

export async function collect(client: ApiClient, budget: Budget, opts: CollectOptions): Promise<AuditData> {
  const repo = assertRepo(opts.repo);
  const now = opts.until ? Date.parse(opts.until) : (opts.now ?? Date.now());
  const since = new Date(now - opts.sinceDays * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const partial: string[] = [];
  await preflight(client, budget);
  const meta = await client.get(`/repos/${repo}`);
  if (meta.status !== 200) throw new AuditError('ci_audit_repo_unreadable', `cannot read ${repo} (HTTP ${meta.status})`);
  const defaultBranch = String((meta.json as any)?.default_branch ?? 'main');
  const isPrivate = Boolean((meta.json as any)?.private);
  const notes: string[] = [];
  const capped = { hit: false };
  const until = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const created = (from: string) => (opts.until ? `created=${from}..${until}` : `created=%3E%3D${from}`);
  if (opts.workflows?.length) {
    const pages = Math.ceil(opts.runsPerWorkflow / 100) + 1;
    const lists = await Promise.all(opts.workflows.map(w => listRuns(client, repo, `status=completed&${created(since)}`, pages, partial, { hit: false }, { workflow: w.replace(/^\.github\/workflows\//, '') })));
    notes.push(`Limited to ${opts.workflows.join(', ')}: push-to-green counts only these workflows.`);
    return finish(client, budget, opts, { repo, defaultBranch, isPrivate, since, until, runs: lists.flat(), partial, notes, created });
  }
  const prRuns = await listRuns(client, repo, `event=pull_request&${created(since)}`, opts.maxRunPages ?? 10, partial, capped);
  let windowStart = since;
  if (capped.hit && prRuns.length) {
    windowStart = prRuns.reduce((m, r) => (r.created_at < m ? r.created_at : m), prRuns[0]!.created_at);
    notes.push(`GitHub's runs list stops at 1,000 runs, so push-to-green and job timings cover runs since ${windowStart}; cost uses per-workflow run counts over the whole window.`);
  }
  const pushRuns = await listRuns(client, repo, `event=push&branch=${encodeURIComponent(defaultBranch)}&${created(windowStart)}`, 3, partial, { hit: false });
  return finish(client, budget, opts, { repo, defaultBranch, isPrivate, since: windowStart, until, runs: [...prRuns, ...pushRuns], partial, notes, created, countSince: since });
}

interface Listed { repo: string; defaultBranch: string; isPrivate: boolean; since: string; until: string; runs: Run[]; partial: string[]; notes: string[]; created: (from: string) => string; countSince?: string }

async function finish(client: ApiClient, budget: Budget, opts: CollectOptions, l: Listed): Promise<AuditData> {
  const { repo, runs, partial } = l;
  const sample = sampleRuns(runs, opts.runsPerWorkflow, opts.workflows);
  const jobs: Record<number, Job[]> = {};
  const fetched = await pool(sample, opts.concurrency ?? 8, async r => { const j = await listJobs(client, repo, r); if (j) jobs[r.id] = j; return j; });
  const missing = fetched.results.filter(x => x == null).length;
  if (fetched.error) partial.push(`job details stopped early (${fetched.error.code}): ${Object.keys(jobs).length} of ${sample.length} sampled runs read`);
  else if (missing) partial.push(`${missing} of ${sample.length} sampled runs returned no job list`);
  const runCounts = fetched.error ? null : await countRuns(client, repo, l.countSince ?? l.since, l.created(l.countSince ?? l.since), [...new Set(sample.map(r => r.path))], partial);
  let caches: Cache[] | null = null;
  if (!fetched.error) {
    try {
      const res = await client.get(`/repos/${repo}/actions/caches?per_page=100&sort=last_accessed_at`);
      if (res.status === 200) caches = ((res.json as any)?.actions_caches ?? []) as Cache[];
    } catch (e) { if (!(e instanceof AuditError)) throw e; partial.push(`caches list skipped (${e.code})`); }
  }
  return { repo, defaultBranch: l.defaultBranch, isPrivate: l.isPrivate, since: l.since, until: l.until, runs, jobs, caches, partial, notes: l.notes, calls: budget.used, sampledPerWorkflow: opts.runsPerWorkflow, runCounts };
}

/** Exact run counts per workflow file since `since`; the repo-wide count stops at 2,500, the per-workflow one does not reach it here. */
export async function countRuns(client: ApiClient, repo: string, since: string, created: string, paths: string[], partial: string[]): Promise<{ since: string; byPath: Record<string, number> } | null> {
  try {
    const res = await client.get(`/repos/${repo}/actions/workflows?per_page=100`);
    if (res.status !== 200) return null;
    const ids = new Map<string, number>(((res.json as any)?.workflows ?? []).map((w: any) => [String(w.path), Number(w.id)]));
    const byPath: Record<string, number> = {};
    const got = await pool(paths.filter(p => ids.has(p)), 8, async p => {
      const r = await client.get(`/repos/${repo}/actions/workflows/${ids.get(p)}/runs?per_page=1&${created}`);
      const n = Number((r.json as any)?.total_count);
      if (r.status === 200 && Number.isFinite(n)) byPath[p] = n;
    });
    if (got.error) { partial.push(`run counts stopped early (${got.error.code}); cost scaled from the runs list`); return null; }
    const missing = paths.filter(p => !(p in byPath));
    if (missing.length) { partial.push(`run counts missing for ${missing.length} workflow(s) (${missing.slice(0, 3).join(', ')}); cost scaled from the runs list`); return null; }
    if (Object.values(byPath).some(n => n >= 2500)) partial.push('a workflow reached GitHub\'s 2,500 run-count limit; its cost is a floor');
    return { since, byPath };
  } catch (e) { if (!(e instanceof AuditError)) throw e; partial.push(`run counts skipped (${e.code})`); return null; }
}

const CACHE_STEP = /cache|setup-(?:bun|node|python|go|java|ruby)|Set up (?:Bun|Node|Python|Go|Java|Ruby)/i;

/** Reads up to `limit` job logs: two Ubicloud jobs for the VM family, then one newest job per distinct job name that has a cache or setup step, newest first, for cache restore outcomes and the Ubicloud VM family. */
export async function sampleLogs(client: ApiClient, data: AuditData, limit: number): Promise<LogEvidence> {
  const done = Object.values(data.jobs).flat().filter(j => j.completed_at && j.conclusion === 'success').sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  const cap = Math.min(limit, 20);
  const ubi = done.filter(j => j.labels.some(l => /^ubicloud/.test(l))).slice(0, Math.min(2, cap));
  const seen = new Set<string>();
  const cached = done.filter(j => !ubi.includes(j) && j.steps.some(s => CACHE_STEP.test(s.name)) && !seen.has(j.name) && seen.add(j.name));
  const jobs = [...ubi, ...cached].slice(0, cap);
  const ev: LogEvidence = { cacheHits: 0, cacheMisses: 0, logsRead: 0 };
  const families = new Map<string, number>();
  const res = await pool(jobs, 4, async j => {
    const text = await client.text(`/repos/${data.repo}/actions/jobs/${j.id}/logs`);
    if (text == null) return;
    ev.logsRead++;
    ev.cacheHits += (text.match(/Cache restored from key|Cache restored successfully|Cache hit occurred/gi) ?? []).length;
    ev.cacheMisses += (text.match(/Cache not found for input keys/gi) ?? []).length;
    const fam = /VM Family:\s*(premium|standard)/i.exec(text)?.[1]?.toLowerCase();
    if (fam) families.set(fam, (families.get(fam) ?? 0) + 1);
  });
  if (res.error) data.partial.push(`log sampling stopped early (${res.error.code}) after ${ev.logsRead} logs`);
  const top = [...families].sort((a, b) => b[1] - a[1])[0];
  if (top) ev.ubicloudFamily = top[0] as 'premium' | 'standard';
  return ev;
}
