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
 *   in that attempt and succeeded; its artifact (or, for a profile with
 *   tree_log_step and a run with no artifact at all, the one tree.json line
 *   the runner logged inside that step; treeFromLog) names this run, attempt,
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
 *   (run_changed otherwise). A pull_request run tested GitHub's merge commit,
 *   not its head, so it counts only when its tree.json names that head and a
 *   merge commit (sha) whose tree git computes equal to the head's tree: the
 *   head already contained its base, so the merge tested the head tree. A lane
 *   carry (the caller passes onlyBaseMoved, GST-3567) also counts it when the
 *   merge commit is the head merged onto a commit of the base branch and the
 *   pull request's own added and removed lines in it are byte-identical to the
 *   head's own (lib/pregate/run-check.ts onlyBaseMoved):
 *   only the base moved. Land's merged-tree CI never passes it.
 *
 * Profiles are the base branch's `.gstack/pregate.json` `run_profiles`, so a
 * pull request can tighten them but never relax them. The workflow a run
 * executed and the tree.json it uploaded are the run head's own, so a diff to
 * that workflow is reviewed like any other gate change. Every refusal names a
 * reason code; an API or git error refuses (fail closed). Verification runs
 * once, online, at `gstack-pregate clear`; the receipt it writes carries the
 * evidence, and `gstack-pregate verify` checks that receipt offline.
 */
import { spawnSync } from './spawn-sync';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256Hex, writeReceipt } from './egress-receipt';
import { ghSpawnSync } from './gh-poll';
import { runBashSync } from './script-invocation';

/**
 * `skippable` (GST-1190): named jobs the workflow may skip by path; a skip counts only in a pull_request run whose `gate` job
 * succeeded, with the workflow, the declared `scripts` and any path the gate's steps name matching origin/<base> byte for byte.
 */
/**
 * `tree_log_step` (HARN-118): the opt-in for a run with no unexpired artifact named `artifact` (artifact storage full): its
 * tree.json is read from the one `GSTACK_TREE_JSON <artifact> <base64>` line the runner logged inside this step of a profile job.
 */
export interface RunProfile { workflow: string; events: string[]; jobs: string[]; artifact: string; max_age_hours?: number; os?: string; skippable?: { jobs: string[]; gate: string; scripts: string[] }; tree_log_step?: string }
export interface RemoteGateRuns { profiles: string[]; inventory: string; skipped?: string }
export interface ApiRun {
  id: number; run_attempt: number; status: string; conclusion: string | null; event: string; head_sha: string;
  path?: string; created_at?: string; run_started_at?: string; updated_at?: string;
  repository?: { full_name: string } | null; head_repository?: { full_name: string } | null; head_branch?: string | null;
  head_commit?: { tree_id?: string } | null;
}
export interface ApiStep { number: number; name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }
export interface ApiJob { id?: number; name: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; steps?: ApiStep[] }
export interface TreeRecord { run_id?: unknown; run_attempt?: unknown; event?: unknown; sha?: unknown; head_sha?: unknown; tree?: unknown; reused?: unknown; reuse?: unknown; sizing_experiment?: unknown; os?: unknown; files?: unknown; tests?: unknown; skipped_files?: unknown; rerun_files?: unknown; attempts?: unknown }

/** What a red run's reader needs beyond RunDeps (lib/pregate/flaky-exception.ts): every file of one artifact, and a pull request's head. */
export interface RunArtifactDeps {
  /** Every file of the run's one unexpired artifact `name`, path → text; throws when it is missing, ambiguous or too large. */
  artifactFiles(id: number, name: string): Record<string, string>;
  pull(n: number): { head_sha: string; state: string; head_repo: string | null };
}

/** What `RunDeps.artifact` throws when the run holds no unexpired artifact by that name at all: the only case a job log may stand in. */
export class NoArtifactError extends Error {}

/** Everything verifyRun reads, injectable so every refusal has a fixture. */
export interface RunDeps {
  run(id: number): ApiRun;
  runsForHead(workflow: string, sha: string): ApiRun[];
  jobs(id: number, attempt: number): ApiJob[];
  /** The tree.json of the run's unexpired artifact `name`: the only one, or with one per rerun attempt of its job, the one that records run_attempt `attempt`. */
  artifact(id: number, name: string, attempt: number): TreeRecord;
  /** One job's whole log as the runner wrote it, each line led by the runner's own timestamp (HARN-118's fallback only). */
  jobLog?(jobId: number): string;
  commitTree(sha: string): string | null;
  /** `sha` and its ancestors, newest first, at most `max` (git rev-list): where a commit with `sha`'s exact tree is looked for (GST-3019). */
  ancestors?(sha: string, max: number): string[];
}

export type RunRefusal = 'run_ref_invalid' | 'other_repository' | 'fork_run' | 'workflow_mismatch' | 'event_mismatch' | 'run_in_progress'
  | 'run_not_success' | 'job_missing' | 'job_ambiguous' | 'job_skipped' | 'job_not_success' | 'artifact_missing' | 'artifact_mismatch'
  | 'artifact_reused' | 'sizing_experiment' | 'tree_mismatch' | 'newer_run_vetoes' | 'run_changed' | 'run_stale' | 'os_mismatch' | 'rerun_malformed' | 'tree_log_unbound' | 'api_error';
/** `skipped`: the files whose every test skipped on the runner (tree.json `skipped_files`, GST-1190); undefined when an older tree.json does not say. */
/** `docs_only`: a pull_request run whose gate skipped every skippable job on a change lib/docs-only.ts calls human docs only; it ran and recorded no tests (R81). */
/** `tree_source`: `job-log` when tree.json came from the job log because the run held no artifact (HARN-118); absent for an artifact. */
/** `rerun`: the files whose newest result came from a re-run attempt (tree.json `rerun_files`, gbrain#9690), with the run's `attempts`; set only when a file passed on a re-run (GST-3054). */
/** `base_moved`: the pull_request run tested its head merged onto `base`, a newer base commit, with the pull request's own lines byte-identical (lib/pregate/run-check.ts onlyBaseMoved, GST-3567); `tree` is then the head's tree it counts for and `tested_tree` the merge's. */
export interface RunEvidence { run_id: number; run_attempt: number; head_sha: string; tree: string; profile: string; event: string; finished_at: string; files: string[]; tests: number | null; skipped?: string[]; skipped_jobs?: string[]; docs_only?: true; rerun?: string[]; attempts?: number[]; tree_source?: 'job-log'; base_moved?: { merge: string; base: string; tested_tree: string } }
/** `fix`: the one command that clears a refusal the caller can repair, such as a pull_request run that tested a merge with an older base. `notMoved`: why onlyBaseMoved did not count that run for its head. */
export type RunVerdict = { ok: true; evidence: RunEvidence } | { ok: false; reason: RunRefusal; detail: string; fix?: string; notMoved?: string };
/** What lib/pregate/run-check.ts onlyBaseMoved decides about a pull_request run's merge commit (GST-3567): the base it merged onto, or why it does not count for the head. */
export type BaseMove = { ok: true; base: string } | { ok: false; why: string };

const SHA = /^[0-9a-f]{40}$/;
const RUN_EVENTS = ['push', 'workflow_dispatch', 'pull_request'];
const PROFILE_KEYS = ['workflow', 'events', 'jobs', 'artifact', 'max_age_hours', 'os', 'skippable', 'tree_log_step'];
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const NAME = /^[A-Za-z0-9_.\/-]{1,128}$/;
export const DEFAULT_MAX_AGE_HOURS = 24;
/** The scratch branch land.merged_ci runs CI on (lib/land-merged-ci.ts), whose run a main push of that land may reuse (scripts/ci-tree-reuse.ts). */
export const landBranch = (pr: number | string): string => `gstack-land/${pr}`;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** Same-named artifacts one run may hold, one per attempt of the job that uploads it. */
const MAX_ARTIFACT_ATTEMPTS = 10;
/** Shard logs are the whole test stream, so a red run's reader allows more than a tree.json. */
const MAX_LOG_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** The one log line that carries a tree.json when a run holds no artifact (HARN-118): the runner's timestamp, the marker, the artifact name, base64. */
const TREE_LOG_LINE = /^\S+Z GSTACK_TREE_JSON (\S+) ([A-Za-z0-9+/]+={0,2})\r?$/;
const LOG_STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/;

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
      if (Array.isArray(p.events) && p.events.some(e => !RUN_EVENTS.includes(e))) errors.push({ path: `${at}.events`, message: 'events are push, workflow_dispatch or pull_request (a pull_request run counts only when its merge commit\'s tree is its head\'s tree)' });
      if (typeof p.artifact !== 'string' || !NAME.test(p.artifact)) errors.push({ path: `${at}.artifact`, message: 'must be the artifact name holding tree.json' });
      if ('max_age_hours' in p && (!Number.isInteger(p.max_age_hours) || (p.max_age_hours as number) < 1 || (p.max_age_hours as number) > 168)) errors.push({ path: `${at}.max_age_hours`, message: 'must be an integer from 1 to 168' });
      if ('os' in p && (typeof p.os !== 'string' || !/^(Linux|macOS|Windows)$/.test(p.os))) errors.push({ path: `${at}.os`, message: 'must be Linux, macOS or Windows' });
      if ('tree_log_step' in p && (typeof p.tree_log_step !== 'string' || !p.tree_log_step.trim() || p.tree_log_step.length > 200 || /[\0\r\n]/.test(p.tree_log_step))) errors.push({ path: `${at}.tree_log_step`, message: 'must be the name of the step in a profile job that prints GSTACK_TREE_JSON <artifact> <base64 of tree.json>, one line of at most 200 characters' });
      if ('skippable' in p) {
        const s = p.skippable as Record<string, unknown> | null;
        const names = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(x => typeof x === 'string' && !!x.trim() && x.length <= 128);
        const repoPath = (x: unknown) => typeof x === 'string' && !!x && !x.startsWith('/') && !x.split('/').includes('..') && !/[\0\r\n]/.test(x);
        if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['jobs', 'gate', 'scripts'].includes(k)) || !names(s.jobs) || typeof s.gate !== 'string' || !s.gate.trim()
          || (s.jobs as string[]).includes(s.gate as string) || !Array.isArray(s.scripts) || !s.scripts.length || !s.scripts.every(repoPath))
          errors.push({ path: `${at}.skippable`, message: 'must be { jobs: [job names], gate: <the job that decides the skip>, scripts: [every repo file the gate reads] }, the gate not among the jobs' });
      }
    }
  }
  if (gateRuns !== undefined && gateRuns !== null) {
    const g = gateRuns as Record<string, unknown>;
    if (!g || typeof g !== 'object' || Array.isArray(g)) errors.push({ path: 'remote_gate_runs', message: 'must be { profiles: [names], inventory: command, skipped?: command }' });
    else {
      for (const k of Object.keys(g)) if (k !== 'profiles' && k !== 'inventory' && k !== 'skipped') errors.push({ path: `remote_gate_runs.${k}`, message: 'unknown key; valid keys: profiles, inventory, skipped' });
      if (!Array.isArray(g.profiles) || g.profiles.length === 0 || g.profiles.some(p => typeof p !== 'string')) errors.push({ path: 'remote_gate_runs.profiles', message: 'must be a non-empty array of run_profiles names' });
      else {
        for (const p of g.profiles as string[]) if (!names.has(p)) errors.push({ path: 'remote_gate_runs.profiles', message: `${JSON.stringify(p)} is not a run_profiles name` });
        if (new Set(g.profiles).size !== g.profiles.length) errors.push({ path: 'remote_gate_runs.profiles', message: 'names each profile once' });
      }
      if (typeof g.inventory !== 'string' || !g.inventory.trim() || g.inventory.length > 512 || /[\0\r\n]/.test(g.inventory)) errors.push({ path: 'remote_gate_runs.inventory', message: 'must be one command line under 512 characters that prints the remote gate\'s test files, one per line' });
      if ('skipped' in g && (typeof g.skipped !== 'string' || !g.skipped.trim() || g.skipped.length > 512 || /[\0\r\n]/.test(g.skipped))) errors.push({ path: 'remote_gate_runs.skipped', message: 'must be one command line under 512 characters that prints which selected test files (PREGATE_FILES_FILE) the remote gate itself does not run, one per line' });
    }
  }
  return errors;
}

/** Newer-run conclusions that never veto: a green run, and a skipped or neutral one, which ran no job that could fail (GST-3514, GST-3554). */
const QUIET = ['success', 'skipped', 'neutral'];
const fail = (reason: RunRefusal, detail: string, fix?: string): RunVerdict => ({ ok: false, reason, detail, ...(fix ? { fix } : {}) });
/** When a run's newest attempt started. A run vetoes the candidate when it started at or after the second the candidate was created: a red re-run of an older run counts, and re-running the candidate does not hide a failure in between. */
const started = (r: ApiRun): string => r.run_started_at ?? r.created_at ?? '';
export const normalPath = (f: string): string => f.replace(/^(\.\/)+/, '');

/**
 * The verdict for run `runRef` under `profile`. `vetoHeads` are further heads
 * whose newer runs of the same workflow can veto (the consumer's own head).
 */
export function verifyRun(deps: RunDeps, o: { repo: string; runRef: string; profileName: string; profile: RunProfile; vetoHeads?: string[]; ignoreRun?: number; now: Date; unchanged?: (p: RunProfile) => string | null; docsOnly?: (head: string) => boolean; dispatchable?: boolean; onlyBaseMoved?: (merge: string, head: string) => BaseMove }): RunVerdict {
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
    const completed = jobs.filter(j => p.jobs.includes(j.name)).map(j => j.completed_at).filter((t): t is string => !!t).sort().pop();
    const finishedAt = completed ?? run.updated_at;
    const finished = Date.parse(finishedAt ?? '');
    const maxAge = p.max_age_hours ?? DEFAULT_MAX_AGE_HOURS;
    if (!Number.isFinite(finished)) return fail('api_error', `${at} has no completion time`);
    if (o.now.getTime() - finished > maxAge * 3600_000) return fail('run_stale', `${at} finished ${finishedAt}, more than ${maxAge} h before now`);
    const skippedJobs: string[] = [];
    for (const name of p.jobs) {
      const hits = jobs.filter(j => j.name === name);
      if (hits.length === 0) return fail('job_missing', `${at} has no job named ${name}`);
      if (hits.length > 1) return fail('job_ambiguous', `${at} has ${hits.length} jobs named ${name}`);
      if (hits[0]!.conclusion === 'skipped') {
        const skip = p.skippable;
        if (!skip?.jobs.includes(name)) return fail('job_skipped', `${at}'s ${name} job was skipped`);
        if (run.event !== 'pull_request') return fail('job_skipped', `${at}'s ${name} job was skipped in a ${run.event} run; only a pull_request run's gate diffs against the PR base, so only its skip counts`);
        const gate = jobs.filter(j => j.name === skip.gate);
        if (gate.length !== 1 || gate[0]!.conclusion !== 'success') return fail('job_skipped', `${at}'s ${name} job was skipped and its gate job ${skip.gate} ${gate.length === 1 ? `concluded ${gate[0]!.conclusion}` : gate.length ? 'is ambiguous' : 'is missing'}`);
        const changed = o.unchanged ? o.unchanged(p) : 'no base copy of the workflow was compared';
        if (changed) return fail('job_skipped', `${at}'s ${name} job was skipped, but ${changed}, so this branch decided the skip`);
        skippedJobs.push(name);
        continue;
      }
      if (hits[0]!.conclusion !== 'success') return fail('job_not_success', `${at}'s ${name} job concluded ${hits[0]!.conclusion}`);
    }
    const heads = [...new Set([run.head_sha, ...(o.vetoHeads ?? []).filter(h => SHA.test(h))])];
    for (const head of heads) {
      const newer = deps.runsForHead(p.workflow, head).filter(r => !(r.id === id && r.run_attempt === run.run_attempt) && r.id !== o.ignoreRun && started(r) >= (run.created_at ?? '') && !(r.status === 'completed' && QUIET.includes(r.conclusion ?? '')));
      if (newer.length) return fail('newer_run_vetoes', `newer run ${newer[0]!.id} of ${p.workflow} on ${head.slice(0, 12)} is ${newer[0]!.status === 'completed' ? newer[0]!.conclusion : newer[0]!.status}`);
    }
    if (p.skippable && p.skippable.jobs.every(j => skippedJobs.includes(j)) && o.docsOnly?.(run.head_sha)) {
      const tree = deps.commitTree(run.head_sha);
      if (!tree) return fail('api_error', `git cannot read the tree of ${run.head_sha}`);
      const changed = runChanged(deps, id, run.run_attempt);
      if (changed) return fail('run_changed', changed);
      return { ok: true, evidence: { run_id: id, run_attempt: run.run_attempt, head_sha: run.head_sha, tree, profile: o.profileName, event: run.event, finished_at: finishedAt!, files: [], tests: null, skipped_jobs: skippedJobs, docs_only: true } };
    }
    const ranIn = ownAttempt(deps, id, run.run_attempt, jobs, p.jobs.filter(n => !skippedJobs.includes(n)));
    let rec: TreeRecord;
    let fromLog = false;
    try { rec = deps.artifact(id, p.artifact, ranIn); }
    catch (e: any) {
      if (!(e instanceof NoArtifactError) || !p.tree_log_step || !deps.jobLog) return fail('artifact_missing', `${at} has no readable ${p.artifact} tree.json: ${String(e?.message ?? e).slice(0, 200)}`);
      const logged = treeFromLog(deps, id, ranIn, p, p.jobs.filter(n => !skippedJobs.includes(n)), at);
      if (!logged.ok) return logged;
      rec = logged.rec;
      fromLog = true;
    }
    if (!rec || typeof rec !== 'object') return fail('artifact_mismatch', `${at}'s ${p.artifact} tree.json is not a JSON object`);
    if (rec.reused === true || rec.reuse === true) return fail('artifact_reused', `${at} reused another run; a reuse is never evidence`);
    if (rec.sizing_experiment !== undefined) return fail('sizing_experiment', `${at} was a runner-sizing experiment (a dispatch that overrode the runner, shards or sub-shards); it is never a Free Tests result`);
    const pr = run.event === 'pull_request';
    const recHeads = pr ? [['head_sha', rec.head_sha, run.head_sha] as const] : rec.head_sha === undefined && rec.sha === undefined ? [['head', undefined, run.head_sha] as const] : ([['sha', rec.sha, run.head_sha], ['head_sha', rec.head_sha, run.head_sha]] as const).filter(([, got]) => got !== undefined);
    const wrong = ([['run_id', rec.run_id, id], ['run_attempt', rec.run_attempt, ranIn], ['event', rec.event, run.event], ...recHeads] as const).filter(([, got, want]) => got !== want);
    if (wrong.length) return fail('artifact_mismatch', `${at}'s ${p.artifact} records ${wrong.map(([k, got, want]) => `${k} ${String(got)} (expected ${want})`).join(', ')}`);
    const headTree = deps.commitTree(run.head_sha);
    if (!headTree) return fail('api_error', `git cannot read the tree of ${run.head_sha}`);
    const baseMoved = o.dispatchable === false
      ? `push a merge of the base to ${run.head_branch || '<branch>'}, or ask the pull request's author to (${p.workflow} cannot be dispatched for this run profile), then gstack-ci-carry wait`
      : `gh workflow run ${p.workflow} --ref ${run.head_branch || '<branch>'}, then gstack-ci-carry wait`;
    let moved: RunEvidence['base_moved'];
    if (rec.tree !== headTree) {
      const testedMerge = pr && typeof rec.sha === 'string' && SHA.test(rec.sha) && deps.commitTree(rec.sha) === rec.tree;
      if (!testedMerge) return fail('tree_mismatch', `${at} recorded tree ${String(rec.tree)}, but its head ${run.head_sha.slice(0, 12)} has tree ${headTree}`);
      const m = o.onlyBaseMoved?.(rec.sha as string, run.head_sha);
      if (!m?.ok) return { ...fail('tree_mismatch', `${at} tested merge commit ${(rec.sha as string).slice(0, 12)} (tree ${String(rec.tree)}), not its head ${run.head_sha.slice(0, 12)}'s tree ${headTree}: the pull request was behind its base (the base moved after the run, or the branch lacks its tip)${m ? `; it does not count for the head because ${m.why}` : ''}`, baseMoved), ...(m ? { notMoved: m.why } : {}) };
      moved = { merge: rec.sha as string, base: m.base, tested_tree: rec.tree as string };
    }
    if (pr && !moved) {
      if (typeof rec.sha !== 'string' || !SHA.test(rec.sha)) return fail('artifact_mismatch', `${at}'s ${p.artifact} names no merge commit (sha) for its pull_request run`);
      const mergeTree = deps.commitTree(rec.sha);
      if (!mergeTree) return fail('api_error', `git cannot read the tree of merge commit ${rec.sha}`);
      if (mergeTree !== headTree) return fail('tree_mismatch', `${at} tested merge commit ${rec.sha.slice(0, 12)} (tree ${mergeTree}), not its head ${run.head_sha.slice(0, 12)}'s tree ${headTree}: the pull request was behind its base (the base moved after the run, or the branch lacks its tip)`, baseMoved);
    }
    const oses = Array.isArray(rec.os) ? rec.os : [rec.os];
    if (p.os && !oses.includes(p.os)) return fail('os_mismatch', `${at} ran on ${oses.filter(Boolean).map(String).join(', ') || 'an unrecorded OS'}; ${o.profileName} requires ${p.os}`);
    if (rec.files !== undefined && (!Array.isArray(rec.files) || rec.files.some(f => typeof f !== 'string'))) return fail('artifact_mismatch', `${at}'s ${p.artifact} files is not a list of paths`);
    if (rec.tests !== undefined && (!Number.isInteger(rec.tests) || (rec.tests as number) < 0)) return fail('artifact_mismatch', `${at}'s ${p.artifact} tests is not a non-negative integer`);
    if (rec.skipped_files !== undefined && (!Array.isArray(rec.skipped_files) || rec.skipped_files.some(f => typeof f !== 'string'))) return fail('artifact_mismatch', `${at}'s ${p.artifact} skipped_files is not a list of paths`);
    if (rec.rerun_files !== undefined && (!Array.isArray(rec.rerun_files) || rec.rerun_files.some(f => typeof f !== 'string'))) return fail('rerun_malformed', `${at}'s ${p.artifact} rerun_files is not a list of paths (CI_CARRY_RERUN_MALFORMED)`);
    if (rec.attempts !== undefined && (!Array.isArray(rec.attempts) || rec.attempts.some(n => !Number.isInteger(n) || (n as number) < 1))) return fail('rerun_malformed', `${at}'s ${p.artifact} attempts is not a list of attempt numbers (CI_CARRY_RERUN_MALFORMED)`);
    const files = ((rec.files ?? []) as string[]).map(normalPath);
    const tests = rec.tests === undefined ? null : (rec.tests as number);
    const changed = runChanged(deps, id, run.run_attempt);
    if (changed) return fail('run_changed', changed);
    const skipped = rec.skipped_files === undefined ? {} : { skipped: (rec.skipped_files as string[]).map(normalPath) };
    const rerun = ((rec.rerun_files ?? []) as string[]).map(normalPath);
    const reran = rerun.length ? { rerun, attempts: [...new Set((rec.attempts ?? []) as number[])].sort((a, b) => a - b) } : {};
    return { ok: true, evidence: { run_id: id, run_attempt: run.run_attempt, head_sha: run.head_sha, tree: headTree, profile: o.profileName, event: run.event, finished_at: finishedAt!, files, tests, ...skipped, ...(skippedJobs.length ? { skipped_jobs: skippedJobs } : {}), ...reran, ...(fromLog ? { tree_source: 'job-log' as const } : {}), ...(moved ? { base_moved: moved } : {}) } };
  } catch (e: any) {
    return fail('api_error', `reading run ${id} failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

/**
 * The tree.json run `id` logged at `attempt` for a profile that opted in with `tree_log_step`, read only when the run holds no
 * artifact (HARN-118). Exactly one TREE_LOG_LINE naming the profile's artifact across the profile's `names` jobs counts, and it
 * binds only by the runner's own timestamp, which a step's output cannot set: inside the named step (one step of that name,
 * a success), at least a second after every earlier step that ran ended and a second before every later one started,
 * since the API times steps only to the second. A test
 * that prints a well-formed line therefore adds a second line, or stands alone outside the step, and refuses either way.
 * The decoded tree.json is capped at MAX_ARTIFACT_BYTES; verifyRun then checks it exactly as it checks an artifact.
 */
function treeFromLog(deps: RunDeps, id: number, attempt: number, p: RunProfile, names: string[], at: string): { ok: true; rec: TreeRecord } | { ok: false; reason: RunRefusal; detail: string } {
  const missing = (detail: string) => ({ ok: false as const, reason: 'artifact_missing' as const, detail: `${at} has no unexpired ${p.artifact} artifact and ${detail}` });
  const hits: Array<{ job: ApiJob; stamp: string; data: string }> = [];
  for (const job of deps.jobs(id, attempt).filter(j => names.includes(j.name))) {
    if (!Number.isSafeInteger(job.id)) return missing(`its ${job.name} job has no numeric id, so its log cannot be read`);
    let text: string;
    try { text = deps.jobLog!(job.id!); } catch (e: any) { return missing(`its ${job.name} job's log cannot be read: ${String(e?.message ?? e).slice(0, 200)}`); }
    for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
      const m = TREE_LOG_LINE.exec(raw);
      if (m && m[1] === p.artifact) hits.push({ job, stamp: raw.slice(0, raw.indexOf(' ')), data: m[2]! });
    }
  }
  if (hits.length !== 1) return missing(`${hits.length} GSTACK_TREE_JSON lines name it in the logs of ${names.join(', ')} at attempt ${attempt}; exactly one counts`);
  const { job, stamp, data } = hits[0]!;
  const step = p.tree_log_step!;
  const unbound = (why: string) => ({ ok: false as const, reason: 'tree_log_unbound' as const, detail: `${at}'s ${p.artifact} line in the ${job.name} job ${why} (CI_CARRY_TREE_LOG_UNBOUND)` });
  if (job.conclusion !== 'success') return unbound(`is from a job that concluded ${job.conclusion}`);
  const named = (job.steps ?? []).filter(s => s.name === step);
  if (named.length !== 1) return unbound(named.length ? `cannot be bound: the job has ${named.length} steps named "${step}"` : `cannot be bound: the job has no step named "${step}"`);
  const s = named[0]!;
  if (s.conclusion !== 'success') return unbound(`cannot be bound: step "${step}" concluded ${s.conclusion}`);
  const ran = (job.steps ?? []).filter(x => x.number < s.number && x.conclusion !== 'skipped');
  const later = (job.steps ?? []).filter(x => x.number > s.number && x.conclusion !== 'skipped');
  const untimed = [s, ...ran, ...later].find(x => !Number.isFinite(Date.parse(x.started_at ?? '')) || !Number.isFinite(Date.parse(x.completed_at ?? '')));
  if (untimed) return unbound(`cannot be bound: step "${untimed.name}" has no start and finish time`);
  const t = LOG_STAMP.exec(stamp);
  const when = t ? Date.parse(`${t[1]}.${(t[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`) : NaN;
  const from = Math.max(Date.parse(s.started_at!), ...ran.map(x => Date.parse(x.completed_at!) + 1000));
  const until = Math.min(Date.parse(s.completed_at!) + 1000, ...later.map(x => Date.parse(x.started_at!) - 1000));
  if (!(when >= from && when < until)) return unbound(`was stamped ${stamp.slice(0, 40)}, not inside step "${step}" (${s.started_at} to ${s.completed_at}) at least a second after every earlier step ended and before every later step started`);
  if (data.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) return missing(`its line holds a tree.json over ${MAX_ARTIFACT_BYTES} bytes`);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_ARTIFACT_BYTES) return missing(`its line holds a tree.json over ${MAX_ARTIFACT_BYTES} bytes`);
  const bad = { ok: false as const, reason: 'artifact_mismatch' as const };
  if (bytes.toString('base64') !== data) return { ...bad, detail: `${at}'s ${p.artifact} line is not canonical base64` };
  try { return { ok: true, rec: JSON.parse(bytes.toString('utf8')) as TreeRecord }; }
  catch { return { ...bad, detail: `${at}'s ${p.artifact} line does not decode to JSON` }; }
}

/**
 * The newest attempt that ran any of `names` itself (GST-2284). A job-level rerun relists every job it did not rerun under the
 * new attempt with its old start and finish times, so a job listed with the same times and conclusion one attempt earlier
 * was carried from there, and so is the artifact it uploaded. A job without both times counts as run in `attempt`.
 */
function ownAttempt(deps: RunDeps, id: number, attempt: number, jobs: ApiJob[], names: string[]): number {
  const carried = (a: ApiJob, b: ApiJob) => a.started_at === b.started_at && a.completed_at === b.completed_at && a.conclusion === b.conclusion;
  let pending = names.map(n => jobs.find(j => j.name === n)!);
  if (!pending.length || pending.some(j => !j.started_at || !j.completed_at)) return attempt;
  for (let k = attempt - 1; k >= 1; k--) {
    const earlier = deps.jobs(id, k);
    const still = pending.filter(j => { const hits = earlier.filter(e => e.name === j.name); return hits.length === 1 && carried(hits[0]!, j); });
    if (still.length < pending.length) return k + 1;
    pending = still;
  }
  return 1;
}

/** Why run `id` no longer stands as attempt `attempt`, a success; null while it does. Read again after the evidence, and for every run once a whole clear is assembled. */
export function runChanged(deps: RunDeps, id: number, attempt: number): string | null {
  const again = deps.run(id);
  return again.run_attempt === attempt && again.status === 'completed' && again.conclusion === 'success' ? null : `run ${id} moved to attempt ${again.run_attempt} (${again.status === 'completed' ? again.conclusion : again.status}) while it was being verified`;
}

/** The remote gate's inventory (or skipped list, with PREGATE_FILES_FILE in `env`): `command`'s non-empty output lines under pipefail, so a pipeline whose producer fails refuses instead of listing part of the gate. */
export function runInventory(command: string, cwd: string, env?: Record<string, string>): string[] | { error: string } {
  const r = runBashSync(`set -o pipefail\n${command}`, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024, ...(env && { env: { ...process.env, ...env } }) });
  if (r.status !== 0 || r.error) return { error: `${command} exited ${r.status ?? r.error}: ${(r.stderr ?? '').trim().slice(0, 200)}` };
  return [...new Set(r.stdout.split('\n').map(l => l.trim()).filter(Boolean))];
}

/** The files in `inventory` that no verified run's tree.json lists. */
/** A run's files minus the ones whose every test skipped there (GST-1190): only those ran anything. Older tree.json: all files. */
export const ranFiles = (e: RunEvidence): string[] => { const skipped = new Set(e.skipped ?? []); return e.files.map(normalPath).filter(f => !skipped.has(f)); };

/**
 * The inventory files no run covers. `skipped: 'uncovered'` (a carry, which drops tests on a machine where they might run)
 * also counts a file every test of which skipped in the run; `'covered'` (the remote gate, a Linux runner like CI) does not.
 */
export function uncoveredFiles(inventory: string[], evidence: RunEvidence[], skipped: 'uncovered' | 'covered' = 'covered'): string[] {
  const ran = new Set(evidence.flatMap(e => (skipped === 'uncovered' ? ranFiles(e) : e.files.map(normalPath))));
  return inventory.filter(f => !ran.has(normalPath(f)));
}

/** What a run check reads: the repository, the verifier's dependencies, the base branch's profiles and the clock. */
/** `unchanged` (findCarry only): null when a profile's workflow and gate inputs match the base, else which file differs. */
/** `onlyBaseMoved`: onlyBaseMoved bound to the checkout and its base branch, so a lane carry counts a run whose base moved (GST-3567). */
export interface RunSource { repo: string; deps: RunDeps; profiles: Record<string, RunProfile>; now: Date; unchanged?: (p: RunProfile) => string | null; docsOnly?: (head: string) => boolean; dispatchable?: (p: RunProfile) => boolean; onlyBaseMoved?: (merge: string, head: string) => BaseMove }
export type FromRunVerdict = { ok: true; evidence: RunEvidence; receipt: string } | { ok: false; reason: string; detail: string };

/**
 * `gstack-pregate --stage tests --from-run <run>`: the run as evidence for `tree` under the first profile in `names`
 * it verifies against (the base branch's profiles for this machine's OS whose workflow holds a local lane), with `head` as a further veto
 * head. The run must have tested exactly this tree (no stamp-only substitution) and list the files it ran.
 */
export function verifyFromRun(src: RunSource, ref: string, names: string[], tree: string, head: string): FromRunVerdict {
  if (!names.length) return { ok: false, reason: 'no_profile', detail: 'the base branch declares no run_profiles entry for this machine\'s OS whose workflow holds a lane this machine runs (gstack\'s ci-reuse/free-tests, for example)' };
  const refusals: Array<{ reason: string; detail: string }> = [];
  for (const name of names) {
    const v = verifyRun(src.deps, { repo: src.repo, runRef: ref, profileName: name, profile: src.profiles[name]!, vetoHeads: SHA.test(head) ? [head] : [], now: src.now, onlyBaseMoved: src.onlyBaseMoved });
    if (!v.ok) { refusals.push({ reason: v.reason, detail: `${name}: ${v.detail}` }); continue; }
    const e = v.evidence;
    if (e.tree !== tree) return { ok: false, reason: 'tree_mismatch', detail: `run ${e.run_id} tested tree ${e.tree.slice(0, 12)}, not this tree ${tree.slice(0, 12)}` };
    if (!e.files.length || e.tests === 0) return { ok: false, reason: 'no_tests', detail: `run ${e.run_id}'s tree.json ${e.files.length ? `records 0 tests for ${e.files.length} file(s)` : 'lists no test files'}` };
    return { ok: true, evidence: e, receipt: `run tree=${tree.slice(0, 12)} tests=${e.tests ?? e.files.length} ${runReceiptFields([e], src.now)}` };
  }
  return refusals.length === 1 ? { ok: false, ...refusals[0]! } : { ok: false, reason: 'no_verified_run', detail: refusals.map(r => `${r.detail} (${r.reason})`).join(' | ') };
}

/**
 * The receipt suffix a run clear records: runs, profiles and the verification time, read back by `parseRunReceipt`. A run some of
 * whose files passed only on a re-run adds `rerun=<files> attempts=<list>` (GST-3054): allowed, but never shown as a clean pass.
 */
export function runReceiptFields(evidence: RunEvidence[], now: Date): string {
  return `runs=${evidence.map(e => `${e.run_id}/${e.run_attempt}`).join(',')} profiles=${evidence.map(e => e.profile).join(',')} heads=${[...new Set(evidence.map(e => e.head_sha.slice(0, 12)))].join(',')}${rerunMarker([...rerunByRun(evidence).values()])}${evidence.some(e => e.tree_source === 'job-log') ? ' tree_source=job-log' : ''}${evidence.some(e => e.base_moved) ? ` base_moved=${[...new Set(evidence.flatMap(e => (e.base_moved ? [e.base_moved.base.slice(0, 12)] : [])))].join(',')}` : ''} verified=${now.toISOString()}`;
}

/** The re-run record per carried run (`<id>/<attempt>`): the distinct re-run files and attempts across every profile that read that run, so two profiles on one run count each file once. */
export function rerunByRun(evidence: Array<Pick<RunEvidence, 'run_id' | 'run_attempt' | 'rerun' | 'attempts'>>): Map<string, { files: number; attempts: number[] }> {
  const runs = new Map<string, { files: Set<string>; attempts: Set<number> }>();
  for (const e of evidence) {
    if (!e.rerun?.length) continue;
    const key = `${e.run_id}/${e.run_attempt}`;
    const run = runs.get(key) ?? { files: new Set<string>(), attempts: new Set<number>() };
    for (const f of e.rerun) run.files.add(f);
    for (const n of e.attempts ?? []) run.attempts.add(n);
    runs.set(key, run);
  }
  return new Map([...runs].map(([key, r]) => [key, { files: r.files.size, attempts: [...r.attempts].sort((a, b) => a - b) }]));
}

/** ` rerun=<files> attempts=<list>` over the runs with re-run files, each run counted once, or '' when every run passed first time (GST-3054). */
export function rerunMarker(runs: Array<{ files: number; attempts: number[] }>): string {
  const reran = runs.filter(r => r.files > 0);
  if (!reran.length) return '';
  const attempts = [...new Set(reran.flatMap(r => r.attempts))].sort((a, b) => a - b);
  return ` rerun=${reran.reduce((n, r) => n + r.files, 0)} attempts=${attempts.length ? attempts.join(',') : 'unrecorded'}`;
}

export function parseRunReceipt(receipt: string): { runs: string[]; profiles: string[]; tree: string | null } | null {
  const runs = / runs=(\S+)/.exec(receipt)?.[1];
  const profiles = / profiles=(\S+)/.exec(receipt)?.[1];
  if (!runs || !profiles || !/ verified=\S+/.test(receipt)) return null;
  return { runs: runs.split(','), profiles: profiles.split(','), tree: /\btree=([0-9a-f]{12})\b/.exec(receipt)?.[1] ?? null };
}

/** Egress receipts for the reads below (fail-open, like contributor-mode): only this repository's name, run ids and a commit sha leave the machine. */
const receiptFor = (host: string, payloadClass: string, request: string) => ({ sink: 'run-evidence', host, payloadClass, bytes: 0, sha256: sha256Hex(request), consent: 'a run verification the user or the repository\'s own workflow started (gstack-pregate clear --run or --from-run, the main-push reuse job); reads its own repository\'s Actions runs and fetches a run head by sha' });
const receiptFailed = (err: unknown) => process.stderr.write(`[run-evidence] egress receipt could not be written (${(err as Error).message}); proceeding (fail-open)\n`);

function gh(args: string[], timeoutMs = 60_000, encoding: 'utf8' | 'latin1' = 'utf8'): string {
  try { writeReceipt(receiptFor('api.github.com', 'actions-run-read', args.join(' '))); } catch (err) { receiptFailed(err); }
  const r = ghSpawnSync(args, { encoding, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || String(r.error ?? '')).trim().slice(0, 300)}`);
  return r.stdout;
}

/** One `gh api` read on this repository's own data, receipted like every read here. */
export function ghApiJson<T>(apiPath: string): T { return JSON.parse(gh(['api', apiPath])) as T; }

/** The gh- and git-backed dependencies for `repo`, reading trees in `repoRoot` (fetching a missing head from origin once). */
export function ghRunDeps(repo: string, repoRoot: string): RunDeps {
  const json = <T>(p: string): T => JSON.parse(gh(['api', p]));
  // Every page, one JSON value per line: a veto or a required job past the first 100 entries must still be seen.
  const all = <T>(p: string, key: string): T[] => gh(['api', '--paginate', p, '--jq', `.${key}[]`]).split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
  return {
    run: id => json<ApiRun>(`repos/${repo}/actions/runs/${id}`),
    runsForHead: (workflow, sha) => all<ApiRun>(`repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`, 'workflow_runs'),
    // A long rerun attempt's 100-job page can outlast a proxy's ~10 s cutoff (GST-2215): read 50 per page, and after a 5xx read the whole list once more at 25. A failed page throws, so a partial list never counts.
    jobs: (id, attempt) => {
      const read = (n: number) => all<ApiJob>(`repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=${n}`, 'jobs');
      try { return read(50); } catch (e) { if (!/\bHTTP 5\d\d\b/.test((e as Error).message)) throw e; return read(25); }
    },
    // A rerun of the uploading job leaves one artifact per attempt (GST-2284): read each by id and keep the one from `attempt`.
    artifact: (id, name, attempt) => {
      const listed = all<{ id: number; name: string; size_in_bytes: number; expired: boolean }>(`repos/${repo}/actions/runs/${id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`, 'artifacts').filter(a => a.name === name && !a.expired);
      if (listed.length === 0) throw new NoArtifactError(`run ${id} has 0 unexpired artifacts named ${name}`);
      if (listed.length > MAX_ARTIFACT_ATTEMPTS) throw new Error(`run ${id} has ${listed.length} unexpired artifacts named ${name}`);
      for (const a of listed) if (!(a.size_in_bytes <= MAX_ARTIFACT_BYTES)) throw new Error(`artifact ${name} is ${a.size_in_bytes} bytes, over ${MAX_ARTIFACT_BYTES}`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-run-evidence-'));
      try {
        if (listed.length === 1) {
          gh(['run', 'download', String(id), '--repo', repo, '--name', name, '--dir', dir], 120_000);
          const file = path.join(dir, 'tree.json');
          if (fs.statSync(file).size > MAX_ARTIFACT_BYTES) throw new Error(`tree.json is over ${MAX_ARTIFACT_BYTES} bytes`);
          return JSON.parse(fs.readFileSync(file, 'utf8')) as TreeRecord;
        }
        const records = listed.map(a => {
          if (!Number.isSafeInteger(a.id)) throw new Error(`run ${id}'s artifact ${name} has no numeric id`);
          const zip = path.join(dir, `${a.id}.zip`);
          fs.writeFileSync(zip, Buffer.from(gh(['api', `repos/${repo}/actions/artifacts/${a.id}/zip`], 120_000, 'latin1'), 'latin1'));
          const r = spawnSync('unzip', ['-p', zip, 'tree.json'], { encoding: 'utf8', timeout: 60_000, maxBuffer: MAX_ARTIFACT_BYTES });
          if (r.status !== 0 || r.error) throw new Error(`artifact ${a.id} has no readable tree.json: ${(r.stderr || String(r.error ?? '')).trim().slice(0, 200)}`);
          return JSON.parse(r.stdout) as TreeRecord;
        });
        const hits = records.filter(r => r && r.run_attempt === attempt);
        if (hits.length !== 1) throw new Error(`run ${id} has ${listed.length} unexpired artifacts named ${name} and ${hits.length} of them record run_attempt ${attempt}`);
        return hits[0]!;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    // A job log holds the runner's escape sequences, which gh refuses to print without --allow-escape-sequences.
    jobLog: jobId => {
      if (!Number.isSafeInteger(jobId)) throw new Error(`job id ${jobId} is not a number`);
      return gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${jobId}/logs`], 120_000);
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
    ancestors: (sha, max) => {
      const r = spawnSync('git', ['rev-list', `--max-count=${max}`, sha], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
      return r.status === 0 ? (r.stdout ?? '').split('\n').filter(s => SHA.test(s)) : [];
    },
  };
}

/** The gh-backed artifact and pull request reads for `repo` (lib/pregate/flaky-exception.ts): one unexpired artifact by name, every regular file in it under a byte cap. */
export function ghArtifactDeps(repo: string): RunArtifactDeps {
  const all = <T>(p: string, key: string): T[] => gh(['api', '--paginate', p, '--jq', `.${key}[]`]).split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
  return {
    artifactFiles: (id, name) => {
      const listed = all<{ name: string; size_in_bytes: number; expired: boolean }>(`repos/${repo}/actions/runs/${id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`, 'artifacts').filter(a => a.name === name && !a.expired);
      if (listed.length !== 1) throw new Error(`run ${id} has ${listed.length} unexpired artifacts named ${name}`);
      if (!(listed[0]!.size_in_bytes <= MAX_LOG_ARTIFACT_BYTES)) throw new Error(`artifact ${name} is ${listed[0]!.size_in_bytes} bytes, over ${MAX_LOG_ARTIFACT_BYTES}`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-run-evidence-'));
      try {
        gh(['run', 'download', String(id), '--repo', repo, '--name', name, '--dir', dir], 300_000);
        const out: Record<string, string> = {};
        let bytes = 0;
        const walk = (rel: string) => {
          for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            const child = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(child); continue; }
            if (!entry.isFile()) continue;
            bytes += fs.statSync(path.join(dir, child)).size;
            if (bytes > MAX_LOG_ARTIFACT_BYTES) throw new Error(`artifact ${name} unpacks to more than ${MAX_LOG_ARTIFACT_BYTES} bytes`);
            out[child] = fs.readFileSync(path.join(dir, child), 'utf8');
          }
        };
        walk('');
        return out;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    pull: n => {
      const p = JSON.parse(gh(['api', `repos/${repo}/pulls/${n}`])) as { state: string; head: { sha: string; repo: { full_name: string } | null } };
      return { head_sha: p.head.sha, state: p.state, head_repo: p.head.repo?.full_name ?? null };
    },
  };
}
