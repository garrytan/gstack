import * as fs from 'node:fs';
import type { GateReason } from '../gate-outcomes';
import * as path from 'node:path';

export interface ApiResponse { status: number; json: unknown }
export interface ApiClient { get(apiPath: string): Promise<ApiResponse>; text(apiPath: string): Promise<string | null> }

export type AuditCode = Extract<GateReason, `ci_audit_${string}`>;

export class AuditError extends Error {
  constructor(readonly code: AuditCode, readonly detail: string, readonly retry: string = 'never') { super(`${code}: ${detail}`); }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function assertRepo(repo: string): string {
  if (!REPO_RE.test(repo) || repo.includes('..')) throw new AuditError('ci_audit_bad_repo', `not an owner/name slug: ${repo}`);
  return repo;
}

/** One call budget and one deadline shared by every request of a run. */
export class Budget {
  used = 0;
  readonly deadline: number;
  readonly controller = new AbortController();
  constructor(readonly maxCalls: number, timeoutMs: number, now = Date.now()) {
    this.deadline = now + timeoutMs;
  }
  reserve(): void {
    if (this.used >= this.maxCalls) throw new AuditError('ci_audit_call_budget', `used ${this.used} of ${this.maxCalls} calls`);
    if (Date.now() >= this.deadline) throw new AuditError('ci_audit_deadline', 'the run deadline passed');
    this.used++;
  }
  remainingMs(): number { return Math.max(0, this.deadline - Date.now()); }
}

export function requireGh(gh: string): void {
  if (!Bun.which(gh)) throw new AuditError('ci_audit_gh_missing', `${gh} is not installed or not on PATH`);
}

/** Reads GitHub through `gh api`, which works behind proxies that rewrite the token. */
export function ghClient(budget: Budget, gh = 'gh'): ApiClient {
  return {
    async get(apiPath) {
      requireGh(gh);
      budget.reserve();
      const proc = Bun.spawn([gh, 'api', '-i', apiPath.replace(/^\//, '')], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      });
      const timer = setTimeout(() => proc.kill(), budget.remainingMs());
      const onAbort = () => proc.kill();
      budget.controller.signal.addEventListener('abort', onAbort);
      try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (Date.now() >= budget.deadline) throw new AuditError('ci_audit_deadline', `gh api ${apiPath} did not finish before the deadline`);
        return parseIncluded(out, err, code, apiPath);
      } finally {
        clearTimeout(timer);
        budget.controller.signal.removeEventListener('abort', onAbort);
      }
    },
    async text(apiPath) {
      requireGh(gh);
      budget.reserve();
      const read = async (extra: string[]) => {
        const proc = Bun.spawn([gh, 'api', ...extra, apiPath.replace(/^\//, '')], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
        const timer = setTimeout(() => proc.kill(), budget.remainingMs());
        try {
          const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
          return { out, err, code };
        } finally { clearTimeout(timer); }
      };
      let r = await read(['--allow-escape-sequences']);
      if (r.code !== 0 && /unknown flag/i.test(r.err)) r = await read([]);
      return r.code === 0 ? r.out : null;
    },
  };
}

function parseIncluded(out: string, err: string, code: number, apiPath: string): ApiResponse {
  const split = out.search(/\r?\n\r?\n/);
  const head = split >= 0 ? out.slice(0, split) : '';
  const body = split >= 0 ? out.slice(split).trim() : out.trim();
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? (code === 0 ? 200 : 0));
  if (status === 0) {
    if (/gh auth login|not logged in|GH_TOKEN/i.test(err)) throw new AuditError('ci_audit_gh_missing', 'gh is not signed in');
    throw new AuditError('ci_audit_api_failed', `gh api ${apiPath}: ${err.trim().split('\n')[0] ?? 'no output'}`, 'now');
  }
  if ((status === 403 || status === 429) && (/^x-ratelimit-remaining:\s*0\s*$/im.test(head) || /rate limit/i.test(body))) {
    const reset = Number(/^x-ratelimit-reset:\s*(\d+)/im.exec(head)?.[1]);
    throw new AuditError('ci_audit_rate_limit', `GitHub refused ${apiPath} for rate limit (HTTP ${status})`, Number.isFinite(reset) ? `after ${new Date(reset * 1000).toISOString()}` : 'after an hour');
  }
  let json: unknown = null;
  try { json = body ? JSON.parse(body) : null; } catch { throw new AuditError('ci_audit_api_failed', `gh api ${apiPath} returned non-JSON (HTTP ${status})`, 'now'); }
  return { status, json };
}

export function fixtureKey(apiPath: string): string {
  return apiPath.replace(/^\/+/, '').replace(/[^A-Za-z0-9._=-]+/g, '_').slice(0, 180) + '.json';
}

/** Replays a recorded fixture directory; a missing response is a 404, as GitHub would answer. */
export function fixtureClient(dir: string, budget?: Budget): ApiClient {
  return {
    async get(apiPath) {
      budget?.reserve();
      const file = path.join(dir, fixtureKey(apiPath));
      if (!fs.existsSync(file)) return { status: 404, json: { message: 'Not Found (no fixture)' } };
      return { status: 200, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
    },
    async text(apiPath) {
      budget?.reserve();
      const file = path.join(dir, fixtureKey(apiPath).replace(/\.json$/, '.txt'));
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    },
  };
}

const RUN_FIELDS = ['id', 'name', 'path', 'event', 'head_sha', 'head_branch', 'status', 'conclusion', 'created_at', 'run_started_at', 'updated_at', 'run_attempt', 'workflow_id'] as const;
const JOB_FIELDS = ['id', 'run_id', 'run_attempt', 'name', 'status', 'conclusion', 'created_at', 'started_at', 'completed_at', 'labels', 'runner_name'] as const;
const STEP_FIELDS = ['name', 'status', 'conclusion', 'number', 'started_at', 'completed_at'] as const;
const CACHE_FIELDS = ['key', 'ref', 'size_in_bytes', 'created_at', 'last_accessed_at'] as const;

function pick<T extends string>(o: any, fields: readonly T[]): Record<T, unknown> {
  const out = {} as Record<T, unknown>;
  for (const f of fields) if (o && f in o) out[f] = o[f];
  return out;
}

/** Keeps only the fields the audit reads, so a fixture never carries author emails, actors or commit messages. */
export function allowlist(json: any): unknown {
  if (!json || typeof json !== 'object') return json;
  if (Array.isArray(json.workflow_runs)) {
    return { total_count: json.total_count, workflow_runs: json.workflow_runs.map((r: any) => ({ ...pick(r, RUN_FIELDS), pull_requests: (r.pull_requests ?? []).map((p: any) => ({ number: p.number, base: { ref: p.base?.ref } })) })) };
  }
  if (Array.isArray(json.jobs)) return { total_count: json.total_count, jobs: json.jobs.map((j: any) => ({ ...pick(j, JOB_FIELDS), steps: (j.steps ?? []).map((s: any) => pick(s, STEP_FIELDS)) })) };
  if (Array.isArray(json.actions_caches)) return { total_count: json.total_count, actions_caches: json.actions_caches.map((c: any) => pick(c, CACHE_FIELDS)) };
  if (Array.isArray(json.workflows)) return { total_count: json.total_count, workflows: json.workflows.map((w: any) => pick(w, ['id', 'name', 'path', 'state'] as const)) };
  if (typeof json.full_name === 'string') return pick(json, ['full_name', 'default_branch', 'private'] as const);
  if (json.resources?.core) return { resources: { core: pick(json.resources.core, ['limit', 'remaining', 'reset', 'used'] as const) } };
  if (Array.isArray(json.check_suites)) return { total_count: json.total_count, check_suites: json.check_suites.map((s: any) => pick(s, ['id', 'status', 'conclusion', 'head_sha', 'created_at', 'updated_at'] as const)) };
  return {};
}

/** The only log lines a fixture keeps: cache restore outcomes and the runner's VM family. */
export const LOG_EVIDENCE = /Cache restored from key|Cache restored successfully|Cache hit occurred|Cache not found for input keys|VM Family:/i;

export function recordingClient(inner: ApiClient, dir: string): ApiClient {
  fs.mkdirSync(dir, { recursive: true });
  return {
    async get(apiPath) {
      const res = await inner.get(apiPath);
      if (res.status === 200) fs.writeFileSync(path.join(dir, fixtureKey(apiPath)), JSON.stringify(allowlist(res.json)) + '\n');
      return res;
    },
    async text(apiPath) {
      const out = await inner.text(apiPath);
      if (out != null) fs.writeFileSync(path.join(dir, fixtureKey(apiPath).replace(/\.json$/, '.txt')), out.split('\n').filter(l => LOG_EVIDENCE.test(l)).map(l => l.replace(/^\S+Z\s/, '')).join('\n') + '\n');
      return out;
    },
  };
}

/** Runs tasks with at most `limit` in flight; the first AuditError stops new work and is rethrown. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<{ results: (R | undefined)[]; error?: AuditError }> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  let error: AuditError | undefined;
  async function worker() {
    while (!error && next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i]!); } catch (e) {
        if (e instanceof AuditError) { error ??= e; return; }
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results, error };
}
