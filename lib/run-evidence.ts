/**
 * run-evidence — a GitHub Actions run as evidence for one tree (GSTA-156).
 *
 * A consumer that would otherwise run a suite again (pregate's remote gate
 * obligation, a platform lane) may accept a run that already passed on the
 * identical tree, but only on the runner's own record, never on prose: the
 * GitHub API's record of the run, the tree git computes from the run's head
 * commit, and the profile's artifact (its tree.json) the run uploaded itself.
 * `verifyRun` refuses unless every check holds:
 *
 *   the run belongs to this repository and ran for a same-repository head;
 *   its workflow file and event are the profile's; it is the newest attempt,
 *   completed with success; every job the profile names appears exactly once
 *   in that attempt and succeeded; its artifact names this run, attempt,
 *   event and head (the API always answers with the newest attempt, so an
 *   older green attempt under a newer red one is refused), is not a reuse
 *   record, records the tree git computes for the head, and holds well-formed
 *   files (a list of paths) and tests (a non-negative integer); no run of the
 *   same workflow on that head, or on any other head the consumer names, that
 *   started at or after this run was created failed, was cancelled or is still
 *   running (a red re-run of an older run counts, and re-running this run does
 *   not hide a failure in between); it finished within the profile's
 *   max_age_hours (default 24); its runner OS matches when the profile names
 *   one; and a second read of the run still shows the same successful attempt
 *   (run_changed otherwise).
 *
 * Profiles are the base branch's `.gstack/pregate.json` `run_profiles`, so a
 * pull request can tighten them but never relax them. The workflow a run
 * executed and the tree.json it uploaded are the run head's own, so a diff to
 * that workflow is reviewed like any other gate change. Every refusal names a
 * reason code; an API or git error refuses (fail closed). Verification runs
 * once, online, at `gstack-pregate clear`; the receipt it writes carries the
 * evidence, and `gstack-pregate verify` checks that receipt offline.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex, writeReceipt } from './egress-receipt';
import { runBashSync } from './script-invocation';

export interface RunProfile { workflow: string; events: string[]; jobs: string[]; artifact: string; max_age_hours?: number; os?: string }
export interface RemoteGateRuns { profiles: string[]; inventory: string }
export interface ApiRun {
  id: number; run_attempt: number; status: string; conclusion: string | null; event: string; head_sha: string;
  path?: string; created_at?: string; run_started_at?: string; updated_at?: string;
  repository?: { full_name: string } | null; head_repository?: { full_name: string } | null;
}
export interface ApiJob { name: string; conclusion: string | null; completed_at?: string | null }
export interface TreeRecord { run_id?: unknown; run_attempt?: unknown; event?: unknown; sha?: unknown; head_sha?: unknown; tree?: unknown; reused?: unknown; reuse?: unknown; os?: unknown; files?: unknown; tests?: unknown }

/** Everything verifyRun reads, injectable so every refusal has a fixture. */
export interface RunDeps {
  run(id: number): ApiRun;
  runsForHead(workflow: string, sha: string): ApiRun[];
  jobs(id: number, attempt: number): ApiJob[];
  artifact(id: number, name: string): TreeRecord;
  commitTree(sha: string): string | null;
}

export type RunRefusal = 'run_ref_invalid' | 'other_repository' | 'fork_run' | 'workflow_mismatch' | 'event_mismatch' | 'run_in_progress'
  | 'run_not_success' | 'job_missing' | 'job_ambiguous' | 'job_not_success' | 'artifact_missing' | 'artifact_mismatch'
  | 'artifact_reused' | 'tree_mismatch' | 'newer_run_vetoes' | 'run_changed' | 'run_stale' | 'os_mismatch' | 'api_error';
export interface RunEvidence { run_id: number; run_attempt: number; head_sha: string; tree: string; profile: string; event: string; finished_at: string; files: string[]; tests: number | null }
export type RunVerdict = { ok: true; evidence: RunEvidence } | { ok: false; reason: RunRefusal; detail: string };

const SHA = /^[0-9a-f]{40}$/;
const PROFILE_KEYS = ['workflow', 'events', 'jobs', 'artifact', 'max_age_hours', 'os'];
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const NAME = /^[A-Za-z0-9_.\/-]{1,128}$/;
export const DEFAULT_MAX_AGE_HOURS = 24;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** A numeric run id, or a run URL on this repository (`…/actions/runs/<id>[/attempts/<n>][/job/<j>]`). */
export function parseRunRef(ref: string, repo: string): number | null {
  if (/^\d{1,15}$/.test(ref)) return Number(ref);
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d{1,15})(?:\/(?:attempts\/\d+|job\/\d+))?\/?$/.exec(ref);
  return m && m[1]!.toLowerCase() === repo.toLowerCase() ? Number(m[2]) : null;
}

/** `<key>: <message>` errors for `run_profiles` and `remote_gate_runs`; empty when valid. Shared with lib/pregate/config.ts. */
export function runProfileErrors(profiles: unknown, gateRuns: unknown): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  const names = new Set<string>();
  if (profiles !== undefined) {
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) errors.push({ path: 'run_profiles', message: 'must be an object of name → { workflow, events, jobs, artifact, max_age_hours?, os? }' });
    else for (const [name, raw] of Object.entries(profiles as Record<string, unknown>)) {
      const at = `run_profiles[${JSON.stringify(name)}]`;
      names.add(name);
      if (!NAME.test(name)) errors.push({ path: at, message: 'name must be 1-128 letters, digits, . _ / -' });
      const p = raw as Record<string, unknown>;
      if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push({ path: at, message: 'must be an object' }); continue; }
      for (const k of Object.keys(p)) if (!PROFILE_KEYS.includes(k)) errors.push({ path: `${at}.${k}`, message: `unknown key; valid keys: ${PROFILE_KEYS.join(', ')}` });
      if (typeof p.workflow !== 'string' || !WORKFLOW_FILE.test(p.workflow)) errors.push({ path: `${at}.workflow`, message: 'must be a workflow file name like test.yml' });
      for (const k of ['events', 'jobs'] as const) {
        const v = p[k];
        if (!Array.isArray(v) || v.length === 0 || v.length > 32 || v.some(s => typeof s !== 'string' || !s.trim())) errors.push({ path: `${at}.${k}`, message: 'must be a non-empty array of up to 32 names' });
      }
      if (Array.isArray(p.events) && p.events.some(e => e !== 'push' && e !== 'workflow_dispatch')) errors.push({ path: `${at}.events`, message: 'events are push or workflow_dispatch (a pull_request run tests the merge commit, not the head tree)' });
      if (typeof p.artifact !== 'string' || !NAME.test(p.artifact)) errors.push({ path: `${at}.artifact`, message: 'must be the artifact name holding tree.json' });
      if ('max_age_hours' in p && (!Number.isInteger(p.max_age_hours) || (p.max_age_hours as number) < 1 || (p.max_age_hours as number) > 168)) errors.push({ path: `${at}.max_age_hours`, message: 'must be an integer from 1 to 168' });
      if ('os' in p && (typeof p.os !== 'string' || !/^(Linux|macOS|Windows)$/.test(p.os))) errors.push({ path: `${at}.os`, message: 'must be Linux, macOS or Windows' });
    }
  }
  if (gateRuns !== undefined && gateRuns !== null) {
    const g = gateRuns as Record<string, unknown>;
    if (!g || typeof g !== 'object' || Array.isArray(g)) errors.push({ path: 'remote_gate_runs', message: 'must be { profiles: [names], inventory: command }' });
    else {
      for (const k of Object.keys(g)) if (k !== 'profiles' && k !== 'inventory') errors.push({ path: `remote_gate_runs.${k}`, message: 'unknown key; valid keys: profiles, inventory' });
      if (!Array.isArray(g.profiles) || g.profiles.length === 0 || g.profiles.some(p => typeof p !== 'string')) errors.push({ path: 'remote_gate_runs.profiles', message: 'must be a non-empty array of run_profiles names' });
      else {
        for (const p of g.profiles as string[]) if (!names.has(p)) errors.push({ path: 'remote_gate_runs.profiles', message: `${JSON.stringify(p)} is not a run_profiles name` });
        if (new Set(g.profiles).size !== g.profiles.length) errors.push({ path: 'remote_gate_runs.profiles', message: 'names each profile once' });
      }
      if (typeof g.inventory !== 'string' || !g.inventory.trim() || g.inventory.length > 512 || /[\0\r\n]/.test(g.inventory)) errors.push({ path: 'remote_gate_runs.inventory', message: 'must be one command line under 512 characters that prints the remote gate\'s test files, one per line' });
    }
  }
  return errors;
}

const fail = (reason: RunRefusal, detail: string): RunVerdict => ({ ok: false, reason, detail });
/** When a run's newest attempt started. A run vetoes the candidate when it started at or after the second the candidate was created: a red re-run of an older run counts, and re-running the candidate does not hide a failure in between. */
const started = (r: ApiRun): string => r.run_started_at ?? r.created_at ?? '';
const normalPath = (f: string): string => f.replace(/^(\.\/)+/, '');

/**
 * The verdict for run `runRef` under `profile`. `vetoHeads` are further heads
 * whose newer runs of the same workflow can veto (the consumer's own head).
 */
export function verifyRun(deps: RunDeps, o: { repo: string; runRef: string; profileName: string; profile: RunProfile; vetoHeads?: string[]; now: Date }): RunVerdict {
  const id = parseRunRef(o.runRef, o.repo);
  if (id === null) return fail('run_ref_invalid', `${JSON.stringify(o.runRef)} is not a run id or a run URL on ${o.repo}`);
  const p = o.profile;
  try {
    const run = deps.run(id);
    const at = `run ${id} attempt ${run.run_attempt}`;
    if ((run.repository?.full_name ?? '').toLowerCase() !== o.repo.toLowerCase()) return fail('other_repository', `${at} belongs to ${run.repository?.full_name ?? 'an unknown repository'}, not ${o.repo}`);
    if ((run.head_repository?.full_name ?? '').toLowerCase() !== o.repo.toLowerCase()) return fail('fork_run', `${at} ran for ${run.head_repository?.full_name ?? 'an unknown repository'}, not ${o.repo}`);
    if (run.path !== `.github/workflows/${p.workflow}`) return fail('workflow_mismatch', `${at} ran ${run.path ?? 'an unknown workflow'}, not .github/workflows/${p.workflow}`);
    if (!p.events.includes(run.event)) return fail('event_mismatch', `${at} is a ${run.event} run; ${o.profileName} accepts ${p.events.join(', ')}`);
    if (run.status !== 'completed') return fail('run_in_progress', `${at} is ${run.status}`);
    if (run.conclusion !== 'success') return fail('run_not_success', `${at} concluded ${run.conclusion}`);
    if (!SHA.test(run.head_sha)) return fail('api_error', `${at} has no head commit`);
    const jobs = deps.jobs(id, run.run_attempt);
    const completed = jobs.map(j => j.completed_at).filter((t): t is string => !!t).sort().pop();
    const finishedAt = completed ?? run.updated_at;
    const finished = Date.parse(finishedAt ?? '');
    const maxAge = p.max_age_hours ?? DEFAULT_MAX_AGE_HOURS;
    if (!Number.isFinite(finished)) return fail('api_error', `${at} has no completion time`);
    if (o.now.getTime() - finished > maxAge * 3600_000) return fail('run_stale', `${at} finished ${finishedAt}, more than ${maxAge} h before now`);
    for (const name of p.jobs) {
      const hits = jobs.filter(j => j.name === name);
      if (hits.length === 0) return fail('job_missing', `${at} has no job named ${name}`);
      if (hits.length > 1) return fail('job_ambiguous', `${at} has ${hits.length} jobs named ${name}`);
      if (hits[0]!.conclusion !== 'success') return fail('job_not_success', `${at}'s ${name} job concluded ${hits[0]!.conclusion}`);
    }
    const heads = [...new Set([run.head_sha, ...(o.vetoHeads ?? []).filter(h => SHA.test(h))])];
    for (const head of heads) {
      const newer = deps.runsForHead(p.workflow, head).filter(r => !(r.id === id && r.run_attempt === run.run_attempt) && started(r) >= (run.created_at ?? '') && !(r.status === 'completed' && r.conclusion === 'success'));
      if (newer.length) return fail('newer_run_vetoes', `newer run ${newer[0]!.id} of ${p.workflow} on ${head.slice(0, 12)} is ${newer[0]!.status === 'completed' ? newer[0]!.conclusion : newer[0]!.status}`);
    }
    let rec: TreeRecord;
    try { rec = deps.artifact(id, p.artifact); }
    catch (e: any) { return fail('artifact_missing', `${at} has no readable ${p.artifact} tree.json: ${String(e?.message ?? e).slice(0, 200)}`); }
    if (!rec || typeof rec !== 'object') return fail('artifact_mismatch', `${at}'s ${p.artifact} tree.json is not a JSON object`);
    if (rec.reused === true || rec.reuse === true) return fail('artifact_reused', `${at} reused another run; a reuse is never evidence`);
    const recHeads = rec.head_sha === undefined && rec.sha === undefined ? [['head', undefined, run.head_sha] as const] : ([['sha', rec.sha, run.head_sha], ['head_sha', rec.head_sha, run.head_sha]] as const).filter(([, got]) => got !== undefined);
    const wrong = ([['run_id', rec.run_id, id], ['run_attempt', rec.run_attempt, run.run_attempt], ['event', rec.event, run.event], ...recHeads] as const).filter(([, got, want]) => got !== want);
    if (wrong.length) return fail('artifact_mismatch', `${at}'s ${p.artifact} records ${wrong.map(([k, got, want]) => `${k} ${String(got)} (expected ${want})`).join(', ')}`);
    const headTree = deps.commitTree(run.head_sha);
    if (!headTree) return fail('api_error', `git cannot read the tree of ${run.head_sha}`);
    if (rec.tree !== headTree) return fail('tree_mismatch', `${at} recorded tree ${String(rec.tree)}, but its head ${run.head_sha.slice(0, 12)} has tree ${headTree}`);
    if (p.os && rec.os !== p.os) return fail('os_mismatch', `${at} ran on ${String(rec.os ?? 'an unrecorded OS')}; ${o.profileName} requires ${p.os}`);
    if (rec.files !== undefined && (!Array.isArray(rec.files) || rec.files.some(f => typeof f !== 'string'))) return fail('artifact_mismatch', `${at}'s ${p.artifact} files is not a list of paths`);
    if (rec.tests !== undefined && (!Number.isInteger(rec.tests) || (rec.tests as number) < 0)) return fail('artifact_mismatch', `${at}'s ${p.artifact} tests is not a non-negative integer`);
    const files = ((rec.files ?? []) as string[]).map(normalPath);
    const tests = rec.tests === undefined ? null : (rec.tests as number);
    const changed = runChanged(deps, id, run.run_attempt);
    if (changed) return fail('run_changed', changed);
    return { ok: true, evidence: { run_id: id, run_attempt: run.run_attempt, head_sha: run.head_sha, tree: headTree, profile: o.profileName, event: run.event, finished_at: finishedAt!, files, tests } };
  } catch (e: any) {
    return fail('api_error', `reading run ${id} failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

/** Why run `id` no longer stands as attempt `attempt`, a success; null while it does. Read again after the evidence, and for every run once a whole clear is assembled. */
export function runChanged(deps: RunDeps, id: number, attempt: number): string | null {
  const again = deps.run(id);
  return again.run_attempt === attempt && again.status === 'completed' && again.conclusion === 'success' ? null : `run ${id} moved to attempt ${again.run_attempt} (${again.status === 'completed' ? again.conclusion : again.status}) while it was being verified`;
}

/** The remote gate's inventory: `command`'s non-empty output lines under pipefail, so a pipeline whose producer fails refuses instead of listing part of the gate. */
export function runInventory(command: string, cwd: string): string[] | { error: string } {
  const r = runBashSync(`set -o pipefail\n${command}`, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.error) return { error: `${command} exited ${r.status ?? r.error}: ${(r.stderr ?? '').trim().slice(0, 200)}` };
  return [...new Set(r.stdout.split('\n').map(l => l.trim()).filter(Boolean))];
}

/** The files in `inventory` that no verified run's tree.json lists. */
export function uncoveredFiles(inventory: string[], evidence: RunEvidence[]): string[] {
  const ran = new Set(evidence.flatMap(e => e.files.map(normalPath)));
  return inventory.filter(f => !ran.has(normalPath(f)));
}

/** The receipt suffix a run clear records: runs, profiles and the verification time, read back by `parseRunReceipt`. */
export function runReceiptFields(evidence: RunEvidence[], now: Date): string {
  return `runs=${evidence.map(e => `${e.run_id}/${e.run_attempt}`).join(',')} profiles=${evidence.map(e => e.profile).join(',')} heads=${[...new Set(evidence.map(e => e.head_sha.slice(0, 12)))].join(',')} verified=${now.toISOString()}`;
}

export function parseRunReceipt(receipt: string): { runs: string[]; profiles: string[]; tree: string | null } | null {
  const runs = / runs=(\S+)/.exec(receipt)?.[1];
  const profiles = / profiles=(\S+)/.exec(receipt)?.[1];
  if (!runs || !profiles || !/ verified=\S+/.test(receipt)) return null;
  return { runs: runs.split(','), profiles: profiles.split(','), tree: /\btree=([0-9a-f]{12})\b/.exec(receipt)?.[1] ?? null };
}

/** Egress receipts for the reads below (fail-open, like contributor-mode): only this repository's name, run ids and a commit sha leave the machine. */
const receiptFor = (host: string, payloadClass: string, request: string) => ({ sink: 'run-evidence', host, payloadClass, bytes: 0, sha256: sha256Hex(request), consent: 'user ran gstack-pregate clear --run (or --run-url on a profiled lane); reads its own repository\'s Actions runs and fetches a run head by sha' });
const receiptFailed = (err: unknown) => process.stderr.write(`[run-evidence] egress receipt could not be written (${(err as Error).message}); proceeding (fail-open)\n`);

function gh(args: string[], timeoutMs = 60_000): string {
  try { writeReceipt(receiptFor('api.github.com', 'actions-run-read', args.join(' '))); } catch (err) { receiptFailed(err); }
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || String(r.error ?? '')).trim().slice(0, 300)}`);
  return r.stdout;
}

/** The gh- and git-backed dependencies for `repo`, reading trees in `repoRoot` (fetching a missing head from origin once). */
export function ghRunDeps(repo: string, repoRoot: string): RunDeps {
  const json = <T>(p: string): T => JSON.parse(gh(['api', p]));
  // Every page, one JSON value per line: a veto or a required job past the first 100 entries must still be seen.
  const all = <T>(p: string, key: string): T[] => gh(['api', '--paginate', p, '--jq', `.${key}[]`]).split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
  return {
    run: id => json<ApiRun>(`repos/${repo}/actions/runs/${id}`),
    runsForHead: (workflow, sha) => all<ApiRun>(`repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`, 'workflow_runs'),
    jobs: (id, attempt) => all<ApiJob>(`repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, 'jobs'),
    artifact: (id, name) => {
      const listed = all<{ name: string; size_in_bytes: number; expired: boolean }>(`repos/${repo}/actions/runs/${id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`, 'artifacts').filter(a => a.name === name && !a.expired);
      if (listed.length !== 1) throw new Error(`run ${id} has ${listed.length} unexpired artifacts named ${name}`);
      if (!(listed[0]!.size_in_bytes <= MAX_ARTIFACT_BYTES)) throw new Error(`artifact ${name} is ${listed[0]!.size_in_bytes} bytes, over ${MAX_ARTIFACT_BYTES}`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-run-evidence-'));
      try {
        gh(['run', 'download', String(id), '--repo', repo, '--name', name, '--dir', dir], 120_000);
        const file = path.join(dir, 'tree.json');
        if (fs.statSync(file).size > MAX_ARTIFACT_BYTES) throw new Error(`tree.json is over ${MAX_ARTIFACT_BYTES} bytes`);
        return JSON.parse(fs.readFileSync(file, 'utf8')) as TreeRecord;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    commitTree: sha => {
      const read = () => spawnSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
      let r = read();
      if (r.status !== 0) {
        try { writeReceipt(receiptFor('origin', 'git-fetch-by-sha', sha)); } catch (err) { receiptFailed(err); }
        spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', sha], { cwd: repoRoot, timeout: 120_000 });
        r = read();
      }
      const tree = (r.stdout ?? '').trim();
      return r.status === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
    },
  };
}
