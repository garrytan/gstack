/**
 * pregate flaky exception (GST-1096, docs/pregate.md#flaky-exception): an owner-granted exception that lets GitHub
 * Actions runs with failures clear one requires-remote obligation. `gstack-pregate clear --remote <lane> --run <run>
 * --flaky-exception "<test file>::<case>" … --pr <n> --grant <approval id>` (lib/pregate/index.ts clearByRuns) takes
 * the runs only when:
 *
 * - every failure is named from the run's own records: each job of the attempt reconciles (only test-shard jobs, and
 *   the aggregate that needs them, may fail), the plan and every shard's strict result are present and complete (a
 *   timed-out or unattributed shard is incomplete evidence), and each failed shard's log names no failure its result
 *   omits;
 * - the named cases are exactly the failures, at most three, none in a paid test file or a test of a security scan,
 *   and each file is outside the PR's diff and the diff's import closure (lib/pregate/import-graph.ts);
 * - the runs tested pregate.json's own head and tree (no stamp-only substitution), the PR's head is that head, and an
 *   approved gstack-approvals row in the owner's words carries the scope `exceptionBinding` computes over repository,
 *   PR, head, tree, lane, runs with their attempts and cases, so it cannot be rebound to another head or case list.
 *
 * It is pregate only: nothing here touches a required CI check, which still needs its own green run at the head.
 * base_red is not used: it proves a failure by reproducing it on the base, and a timing flake passes there.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { locate, readRecord } from '../approval-record';
import type { PregateException, PregateFile } from '../headless-artifacts';
import { parseRunRef, verifyRun, type ApiJob, type ApiRun, type RunArtifactDeps, type RunDeps, type RunEvidence, type RunProfile } from '../run-evidence';
import { wtreeFingerprint } from '../script-invocation';
import { resolveBaseBranch } from '../ship-policy';
import type { FreeCiPlan, FreeCiResult, FreeShardOutcome } from '../../scripts/test-free-shards';
import { isConfigUnavailable, loadConfigFromBase } from './config';
import { buildGraph, testsFor } from './import-graph';

export type FailureDeps = RunArtifactDeps;
export interface GrantRow { id: string; outcome: string; scope: string; words: string; by: string }
export interface FlakyInput { cases: string[]; pr?: number; grant?: string; grantRow?: (id: string) => GrantRow | null }
export type FlakyRefusal = { refused: 'usage' | 'PREGATE_RECEIPT_INVALID'; message: string; fix?: string };
/** What a flaky exception is granted for; `exceptionBinding` hashes exactly these fields. */
export type ExceptionSubject = Pick<PregateException, 'lane' | 'repo' | 'pr' | 'head' | 'tree' | 'runs' | 'cases'>;
export interface FlakyRuns { evidence: RunEvidence[]; red: Array<{ evidence: RunEvidence; failures: string[] }> }

export const MAX_FLAKY_CASES = 3;
export const FLAKY_SCOPE_PREFIX = 'flaky-exception:';
/** The receipt field an exception clear adds; verify and verdictOf read it back. */
export const EXCEPTION_RECEIPT = / exception=(\S+)/;

/** The strict shard runner's artifacts and job names (scripts/test-free-shards.ts --ci-run) in the workflows that upload them. */
interface ShardLayout { plan: string; result: string; logs: string; shardJob: string; aggregate: string }
const SHARD_LAYOUTS: Record<string, ShardLayout> = {
  'free-tests.yml': { plan: 'free-plan', result: 'free-result-', logs: 'free-test-shard-logs-', shardJob: 'free-suite', aggregate: 'free-tests' },
  'windows-free-tests.yml': { plan: 'windows-plan', result: 'windows-result-', logs: 'windows-free-test-shard-logs-', shardJob: 'windows-free-shard', aggregate: 'windows-free-tests' },
};
/** A test of a security scanner (/cso, secrets, gitleaks, the sealed guard, redaction, OSV): never excepted. */
const SECURITY_TEST = /(?:^|[-_.])(?:cso|secrets?|gitleaks|sealed|redact\w*|osv|security|sanitize\w*|injection|inject)(?=[-_.])/;
const SHA = /^[0-9a-f]{40}$/;
const LOG_FILE_HEADER = /^(\S.*\.test\.(?:[cm]?[jt]s|tsx|jsx)):$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const short = (s: string | undefined) => (s ?? '').slice(0, 12);
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The gstack-approvals scope that grants one exception: a digest of every field it binds, cases in sorted order. */
export function exceptionBinding(e: ExceptionSubject): string {
  const lines = [`lane=${e.lane}`, `repo=${e.repo}`, `pr=${e.pr}`, `head=${e.head}`, `tree=${e.tree}`, ...e.runs.map(r => `run=${r}`), ...[...e.cases].sort().map(c => `case=${c}`)];
  return FLAKY_SCOPE_PREFIX + sha256(lines.join('\n'));
}

/** The approvals rows of this checkout's branch record (lib/approval-record.ts), looked up by id. */
export function approvalGrants(repoRoot: string, env: NodeJS.ProcessEnv = process.env): (id: string) => GrantRow | null {
  return id => {
    const loc = locate({ cwd: repoRoot, env });
    return 'code' in loc ? null : readRecord(loc).rows.find(r => r.id === id) ?? null;
  };
}

/** The `--flaky-exception` values as `<file>::<case>` strings, or the usage refusal. */
export function parseCases(cases: string[]): string[] | FlakyRefusal {
  if (cases.length > MAX_FLAKY_CASES) return { refused: 'usage', message: `--flaky-exception names at most ${MAX_FLAKY_CASES} cases; got ${cases.length}` };
  const bad = cases.find(c => { const i = c.indexOf('::'); return i <= 0 || i + 2 >= c.length; });
  if (bad !== undefined) return { refused: 'usage', message: `--flaky-exception takes "<test file>::<case>", the file and the test name as the run printed them; got ${JSON.stringify(bad)}` };
  if (new Set(cases).size !== cases.length) return { refused: 'usage', message: '--flaky-exception names each case once' };
  return cases;
}

/** One-line summary for verify's PREGATE line: `pass-with-exception (<cases>; grant <id>)`. */
export function describeExceptions(file: PregateFile): string | null {
  const list = file.exceptions ?? [];
  if (!list.length) return null;
  return `pass-with-exception (${list.flatMap(e => e.cases).join(', ')}; grant ${list.map(e => e.grant).join(', ')})`;
}

/** READY's line for each exception: it waives the pregate obligation, never a required CI check. */
export function flakyExceptionLines(file: PregateFile): string[] {
  return (file.exceptions ?? []).map(e => `FLAKY_EXCEPTION: ${e.lane} cases=${e.cases.join(' | ')} run=${e.runs.join(',')} grant=${e.grant} by=${e.by} (pregate only; every required CI check still needs its own green run at this head)`);
}

/** verify's offline check: every exception receipt has its entry, bound to this head and tree, with an intact binding; null when all hold. */
export function exceptionProblem(file: PregateFile): string | null {
  const list = file.exceptions ?? [];
  const remote = file.requires_remote ?? [];
  for (const r of remote) {
    const grant = EXCEPTION_RECEIPT.exec(r.receipt ?? '')?.[1];
    if (!grant) continue;
    const e = list.find(x => x.lane === r.lane && x.grant === grant);
    if (!e) return `${r.lane}'s receipt names flaky exception grant ${grant}, but pregate.json has no exceptions entry for it; clear again`;
    if (e.head !== file.head || e.tree !== file.tree) return `${r.lane}'s flaky exception (grant ${grant}) is bound to head ${short(e.head)} tree ${short(e.tree)}, not pregate.json's head ${short(file.head)} tree ${short(file.tree)}; a new head needs a new run and a new grant`;
    if (exceptionBinding(e) !== e.binding) return `${r.lane}'s flaky exception (grant ${grant}): the binding does not match its recorded fields (granted scope ${e.binding}); clear again`;
    const runs = / runs=(\S+)/.exec(r.receipt ?? '')?.[1];
    if (runs !== e.runs.join(',')) return `${r.lane}'s receipt names runs ${runs ?? 'none'}, but its flaky exception (grant ${grant}) was granted for ${e.runs.join(',')}; clear again`;
  }
  const orphan = list.find(e => !remote.some(r => r.lane === e.lane && EXCEPTION_RECEIPT.exec(r.receipt ?? '')?.[1] === e.grant));
  return orphan ? `pregate.json records a flaky exception for ${orphan.lane} (grant ${orphan.grant}) that no receipt uses; clear again` : null;
}

/** Why `file`'s exceptions cannot stand for this PR head: each binds the PR and head it was granted for, and a same-tree commit or another PR reusing the record never inherits it. */
export function exceptionConsumerProblem(file: PregateFile, head: string, pr?: string): string | null {
  const e = (file.exceptions ?? []).find(x => x.head !== head || (pr !== undefined && String(x.pr) !== pr));
  return e ? `flaky exception grant ${e.grant} is bound to PR #${e.pr} at ${short(e.head)}, not ${pr ? `PR #${pr} at ` : ''}${short(head)}; a new head needs a new run and a new grant` : null;
}

/** Why red run `id` no longer stands as completed, failed attempt `attempt`; read again once the whole clear is assembled. */
export function redRunChanged(deps: RunDeps, id: number, attempt: number): string | null {
  const again = deps.run(id);
  return again.run_attempt === attempt && again.status === 'completed' && again.conclusion === 'failure' ? null : `run ${id} moved to attempt ${again.run_attempt} (${again.status === 'completed' ? again.conclusion : again.status}) while it was being verified`;
}

/** verify's ok-line suffix naming each exception. */
export function exceptionSummary(file: PregateFile): string {
  return (file.exceptions ?? []).map(e => `flaky exception ${e.cases.join(', ')} (grant ${e.grant}, by ${e.by}, run ${e.runs.join(',')})`).join('; ');
}

const invalid = (lane: string, reason: string, detail: string, fix?: string): FlakyRefusal => ({ refused: 'PREGATE_RECEIPT_INVALID', message: `FLAKY_EXCEPTION: refused reason=${reason} — ${detail}; ${lane} stays uncleared`, ...(fix ? { fix } : {}) });
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * The runs for `names` (one per profile, matched by workflow): a green run verifies as `clear --run` verifies it, a red
 * run through `readRunFailures`. At least one must be red, or no exception is needed.
 */
export function flakyRuns(lane: string, check: { repo: string; deps: RunDeps; profiles: Record<string, RunProfile>; now: Date; failures?: FailureDeps }, names: string[], refs: string[], vetoHead: string | undefined): FlakyRuns | FlakyRefusal {
  if (!check.failures) return { refused: 'usage', message: 'the run artifacts cannot be read here (no GitHub origin), so failures cannot be named' };
  const runs: Array<{ ref: string; id: number; run: ApiRun }> = [];
  for (const ref of refs) {
    const id = parseRunRef(ref, check.repo);
    if (id === null) return invalid(lane, 'run_ref_invalid', `${JSON.stringify(ref)} is not a run id or a run URL on ${check.repo}`);
    try { runs.push({ ref, id, run: check.deps.run(id) }); }
    catch (e) { return invalid(lane, 'api_error', `reading run ${id} failed: ${errText(e)}`, `check gh auth status and that gh can read ${check.repo}'s Actions runs, then rerun the same clear`); }
  }
  if (runs.every(r => r.run.status === 'completed' && r.run.conclusion === 'success')) return invalid(lane, 'run_green', `${runs.map(r => `run ${r.id} attempt ${r.run.run_attempt}`).join(', ')} passed; clear with --run alone, no exception is needed`);
  const out: FlakyRuns = { evidence: [], red: [] };
  const used = new Set<number>();
  for (const name of names) {
    const profile = check.profiles[name]!;
    const pick = runs.find(r => !used.has(r.id) && r.run.path === `.github/workflows/${profile.workflow}`) ?? runs.find(r => !used.has(r.id));
    if (!pick) return { refused: 'usage', message: `${lane} needs one run per profile (${names.join(', ')})` };
    used.add(pick.id);
    if (pick.run.conclusion === 'success') {
      const v = verifyRun(check.deps, { repo: check.repo, runRef: pick.ref, profileName: name, profile, vetoHeads: vetoHead ? [vetoHead] : [], now: check.now });
      if (!v.ok) return invalid(lane, v.reason, `${name}: ${v.detail}`);
      out.evidence.push(v.evidence);
      continue;
    }
    const r = readRunFailures(check.deps, check.failures, { repo: check.repo, id: pick.id, run: pick.run, profileName: name, profile, now: check.now });
    if (!r.ok) return invalid(lane, r.reason, r.detail);
    out.evidence.push(r.evidence);
    out.red.push({ evidence: r.evidence, failures: r.failures });
  }
  return out;
}

type Read<T> = { ok: true } & T | { ok: false; reason: string; detail: string };
const fail = (reason: string, detail: string) => ({ ok: false as const, reason, detail });

/** The one JSON file of artifact `name`, parsed; a message when it is missing, ambiguous or unreadable. */
function jsonArtifact<T>(art: FailureDeps, id: number, name: string): T | { error: string } {
  let files: Record<string, string>;
  try { files = art.artifactFiles(id, name); } catch (e) { return { error: errText(e) }; }
  const json = Object.entries(files).filter(([f]) => f.endsWith('.json'));
  if (json.length !== 1) return { error: `${name} holds ${json.length} JSON files, not one` };
  try { return JSON.parse(json[0]![1]) as T; } catch (e) { return { error: `${json[0]![0]} is not JSON: ${errText(e)}` }; }
}

const isError = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in v && typeof (v as { error: unknown }).error === 'string';
const escapeRe = (s: string) => s.replace(/[.*+?^${{}()|[\]\\]/g, '\\$&');

/**
 * A red run under `profile` read from its own records (B8: a red run uploads no tree.json): every job of the attempt, the
 * plan, every shard's strict result and each failed shard's logs. Returns the evidence (the plan's files, the tests the
 * shards ran) and the failed cases as `<file>::<test name>`, or the refusal naming what could not be reconciled.
 */
function readRunFailures(deps: RunDeps, art: FailureDeps, o: { repo: string; id: number; run: ApiRun; profileName: string; profile: RunProfile; now: Date }): Read<{ evidence: RunEvidence; failures: string[] }> {
  const { run, profile: p, id } = o;
  const layout = SHARD_LAYOUTS[p.workflow];
  if (!layout) return fail('no_shard_results', `${p.workflow} uploads no strict shard results gstack can read (only ${Object.keys(SHARD_LAYOUTS).join(' and ')} do), so its failures cannot be named`);
  const at = `run ${id} attempt ${run.run_attempt}`;
  try {
    if ((run.repository?.full_name ?? '').toLowerCase() !== o.repo.toLowerCase()) return fail('other_repository', `${at} belongs to ${run.repository?.full_name ?? 'an unknown repository'}, not ${o.repo}`);
    if ((run.head_repository?.full_name ?? '').toLowerCase() !== o.repo.toLowerCase()) return fail('fork_run', `${at} ran for ${run.head_repository?.full_name ?? 'an unknown repository'}, not ${o.repo}`);
    if (run.path !== `.github/workflows/${p.workflow}`) return fail('workflow_mismatch', `${at} ran ${run.path ?? 'an unknown workflow'}, not .github/workflows/${p.workflow}`);
    if (!p.events.includes(run.event)) return fail('event_mismatch', `${at} is a ${run.event} run; ${o.profileName} accepts ${p.events.join(', ')}`);
    if (run.status !== 'completed') return fail('run_in_progress', `${at} is ${run.status}`);
    if (run.conclusion !== 'failure') return fail('run_not_failure', `${at} concluded ${run.conclusion}; only a run that finished with test failures can carry an exception (a cancelled or timed-out run is incomplete evidence)`);
    if (!SHA.test(run.head_sha)) return fail('api_error', `${at} has no head commit`);
    const jobs = deps.jobs(id, run.run_attempt);
    const finishedAt = jobs.map(j => j.completed_at).filter((t): t is string => !!t).sort().pop() ?? run.updated_at;
    const finished = Date.parse(finishedAt ?? '');
    const maxAge = p.max_age_hours ?? 24;
    if (!Number.isFinite(finished)) return fail('api_error', `${at} has no completion time`);
    if (o.now.getTime() - finished > maxAge * 3600_000) return fail('run_stale', `${at} finished ${finishedAt}, more than ${maxAge} h before now`);
    const newer = deps.runsForHead(p.workflow, run.head_sha).find(r => r.id !== id && (r.run_started_at ?? r.created_at ?? '') >= (run.created_at ?? ''));
    if (newer) return fail('newer_run', `run ${newer.id} of ${p.workflow} on ${short(run.head_sha)} started after ${at}; clear with the newest run`);
    const shardJobs = reconcileJobs(jobs, layout, p, at);
    if ('reason' in shardJobs) return fail(shardJobs.reason, shardJobs.detail);
    const plan = jsonArtifact<FreeCiPlan>(art, id, layout.plan);
    if (isError(plan)) return fail('shard_incomplete', `${at} has no readable ${layout.plan} (${plan.error})`);
    if (plan.version !== 1 || typeof plan.id !== 'string' || typeof plan.revision !== 'string' || !Array.isArray(plan.shards) || !plan.shards.length
      || plan.shards.some((s, i) => s.shard !== i + 1 || !Array.isArray(s.files) || s.files.some(f => typeof f !== 'string'))) return fail('result_mismatch', `${at}'s ${layout.plan} is not a strict shard plan`);
    const headTree = deps.commitTree(run.head_sha);
    if (!headTree) return fail('api_error', `git cannot read the tree of ${run.head_sha}`);
    if (plan.revision !== run.head_sha && (!SHA.test(plan.revision) || deps.commitTree(plan.revision) !== headTree)) return fail('tree_mismatch', `${at} tested ${short(plan.revision)}, whose tree is not its head ${short(run.head_sha)}'s tree ${short(headTree)}`);
    if (shardJobs.size !== plan.shards.length || plan.shards.some(s => !shardJobs.has(s.shard))) return fail('shard_mismatch', `${at} has ${layout.shardJob} job(s) for shard(s) ${[...shardJobs.keys()].sort((a, b) => a - b).join(', ') || 'none'}, but its plan has ${plan.shards.length} shard(s)`);
    const failures: string[] = [];
    let tests = 0;
    for (const s of plan.shards) {
      const res = jsonArtifact<FreeCiResult>(art, id, `${layout.result}${s.shard}`);
      if (isError(res)) return fail('shard_incomplete', `shard ${s.shard} has no readable ${layout.result}${s.shard} (${res.error})`);
      if (res.planId !== plan.id || res.revision !== plan.revision || res.outcome?.shard !== s.shard || JSON.stringify(res.outcome.files) !== JSON.stringify(s.files)) return fail('result_mismatch', `shard ${s.shard}'s result is not shard ${s.shard} of plan ${plan.id}`);
      const named = shardFailures(res, s.shard);
      if ('reason' in named) return fail(named.reason, named.detail);
      const job = shardJobs.get(s.shard)!;
      if ((job.conclusion === 'failure') !== (named.final.length > 0)) return fail('shard_mismatch', `shard ${s.shard}'s job concluded ${job.conclusion}, but its result names ${named.final.length} final failure(s)`);
      if (job.conclusion === 'failure') {
        const problem = logProblem(art, id, `${layout.logs}${s.shard}`, s.shard, s.files, named.all);
        if (problem) return fail(problem.reason, problem.detail);
      }
      failures.push(...named.final);
      tests += res.outcome.summary?.testsRan ?? 0;
    }
    const again = deps.run(id);
    if (again.run_attempt !== run.run_attempt || again.status !== 'completed' || again.conclusion !== run.conclusion) return fail('run_changed', `run ${id} moved to attempt ${again.run_attempt} (${again.status === 'completed' ? again.conclusion : again.status}) while it was being verified`);
    return { ok: true, evidence: { run_id: id, run_attempt: run.run_attempt, head_sha: run.head_sha, tree: headTree, profile: o.profileName, event: run.event, finished_at: finishedAt!, files: plan.shards.flatMap(s => s.files), tests }, failures: [...new Set(failures)] };
  } catch (e) {
    return fail('api_error', `reading run ${id} failed: ${errText(e)}`);
  }
}

/** Shard number → job, once every job of the attempt is accounted for: only shard jobs and the aggregate may fail. */
function reconcileJobs(jobs: ApiJob[], layout: ShardLayout, p: RunProfile, at: string): Map<number, ApiJob> | { reason: string; detail: string } {
  const shardRe = new RegExp(`^${escapeRe(layout.shardJob)} \\((\\d+)\\)$`);
  const shards = new Map<number, ApiJob>();
  for (const j of jobs) {
    if (j.conclusion === null) return { reason: 'shard_incomplete', detail: `${at}'s ${j.name} job has not finished` };
    const m = shardRe.exec(j.name);
    if (m) {
      if (shards.has(Number(m[1]))) return { reason: 'shard_mismatch', detail: `${at} has two jobs named ${j.name}` };
      if (j.conclusion !== 'success' && j.conclusion !== 'failure') return { reason: 'shard_incomplete', detail: `${at}'s ${j.name} job concluded ${j.conclusion}` };
      shards.set(Number(m[1]), j);
      continue;
    }
    if (j.name === layout.aggregate) continue;
    const allowed = p.jobs.includes(j.name) ? ['success'] : ['success', 'skipped', 'neutral'];
    if (!allowed.includes(j.conclusion)) return { reason: 'unnamed_failure', detail: `${at}'s ${j.name} job concluded ${j.conclusion}; only test-shard failures can be named` };
  }
  const missing = p.jobs.find(n => !jobs.some(j => j.name === n));
  if (missing) return { reason: 'job_missing', detail: `${at} has no job named ${missing}` };
  const aggregate = jobs.filter(j => j.name === layout.aggregate);
  if (aggregate.length !== 1) return { reason: 'job_missing', detail: `${at} has ${aggregate.length} jobs named ${layout.aggregate}` };
  if (![...shards.values()].some(j => j.conclusion === 'failure')) return { reason: 'unnamed_failure', detail: `${at} failed, but no ${layout.shardJob} job did, so the failure is not a test case` };
  if (aggregate[0]!.conclusion !== 'failure') return { reason: 'shard_mismatch', detail: `${at}'s ${layout.aggregate} job concluded ${aggregate[0]!.conclusion} although a shard failed` };
  return shards;
}

function completeSummary(o: FreeShardOutcome): boolean {
  const s = o.summary;
  return !!s && Number.isInteger(s.testsRan) && s.testsRan! >= 0 && s.filesRan === o.files.length && (o.files.length === 0 || s.sawTerminalSummary === true);
}

/**
 * A shard's final failures (`<file>::<test>`) and every failure it recorded. A retry that passed recovered its files; a
 * retry that failed replaces the first run's failures for the files it ran. Anything unattributed or incomplete refuses.
 */
function shardFailures(r: FreeCiResult, n: number): { final: string[]; all: Set<string> } | { reason: string; detail: string } {
  const o = r.outcome;
  const key = (f: { file: string | null; testName: string }) => `${f.file}::${f.testName}`;
  if (o.status === 'timed-out') return { reason: 'shard_incomplete', detail: `shard ${n} timed out, so the tests after the hang never ran` };
  if (!completeSummary(o)) return { reason: 'shard_incomplete', detail: `shard ${n}'s result has no complete run summary` };
  if (o.status === 'passed') {
    if (o.exitCode !== 0 || o.failingFiles.length || o.unattributedFailures || r.retry) return { reason: 'result_mismatch', detail: `shard ${n} passed with failures recorded` };
    return { final: [], all: new Set() };
  }
  if (o.status !== 'failed') return { reason: 'result_mismatch', detail: `shard ${n} has status ${String(o.status)}` };
  if (o.unattributedFailures) return { reason: 'unnamed_failure', detail: `shard ${n}: ${o.unattributedFailures} failure(s) the runner could not attribute to a test file` };
  const first = o.failures ?? [];
  const unnamed = first.filter(f => !f.file || !o.files.includes(f.file) || !f.testName);
  if (!first.length || unnamed.length) return { reason: 'unnamed_failure', detail: `shard ${n} failed ${first.length ? `with ${unnamed.length} failure(s) not attributed to one of its files` : 'without naming a failure'}` };
  if (JSON.stringify([...new Set(first.map(f => f.file))].sort()) !== JSON.stringify([...o.failingFiles].sort())) return { reason: 'result_mismatch', detail: `shard ${n}'s named failures and failing files disagree` };
  const all = new Set(first.map(key));
  const t = r.retry;
  if (!t) return { final: [...all], all };
  if (t.status === 'timed-out' || !completeSummary(t)) return { reason: 'shard_incomplete', detail: `shard ${n}'s retry did not complete` };
  if (t.files.some(f => !o.failingFiles.includes(f))) return { reason: 'result_mismatch', detail: `shard ${n}'s retry ran files that had not failed` };
  const again = t.failures ?? [];
  if (t.unattributedFailures || (t.status === 'failed' && (!again.length || again.some(f => !f.file || !t.files.includes(f.file))))) return { reason: 'unnamed_failure', detail: `shard ${n}'s retry failed without naming each failure` };
  if (t.status === 'passed' && (again.length || t.exitCode !== 0)) return { reason: 'result_mismatch', detail: `shard ${n}'s retry passed with failures recorded` };
  for (const f of again) all.add(key(f));
  const final = [...first.filter(f => !t.files.includes(f.file!)), ...again].map(key);
  return { final: [...new Set(final)], all };
}

/** Why a failed shard's logs do not reconcile with its result: missing, an unhandled error between tests, or a failure the result omits. */
function logProblem(art: FailureDeps, id: number, name: string, n: number, planned: string[], recorded: Set<string>): { reason: string; detail: string } | null {
  let files: Record<string, string>;
  try { files = art.artifactFiles(id, name); } catch (e) { return { reason: 'logs_missing', detail: `shard ${n} failed and has no readable ${name} (${errText(e)})` }; }
  const logs = Object.entries(files).filter(([f]) => f.endsWith('.log'));
  if (!logs.length) return { reason: 'logs_missing', detail: `shard ${n} failed and its ${name} holds no .log file` };
  const canonical = (printed: string) => {
    const stripped = printed.replace(/\\/g, '/').replace(/^(?:\.{1,2}\/)+/, '');
    return planned.includes(stripped) ? stripped : planned.find(p => stripped.endsWith(`/${p}`) || p.endsWith(`/${stripped}`)) ?? stripped;
  };
  const { classifyBunTestOutputLine, parseBunFailureResult, stripAnsiLine } = require('../../scripts/lib/shard-engine') as typeof import('../../scripts/lib/shard-engine');
  for (const [, text] of logs) {
    let file: string | null = null;
    let recap = false;
    let unhandled = 0;
    for (const raw of text.split('\n')) {
      const line = stripAnsiLine(raw).replace(/^::group::/, '').replace(/\r$/, '');
      if (/^\d+ tests? failed:$/.test(line)) { recap = true; file = null; continue; }
      if (classifyBunTestOutputLine(line) === 'unhandled-between-tests') { unhandled++; continue; }
      const header = LOG_FILE_HEADER.exec(line);
      if (header) { if (!recap) file = canonical(header[1]!); continue; }
      const failed = recap ? null : parseBunFailureResult(line);
      if (failed !== null && !recorded.has(`${file}::${failed}`)) return { reason: 'unnamed_failure', detail: `shard ${n}'s log names ${file}::${failed}, which its result does not` };
    }
    if (unhandled) return { reason: 'unnamed_failure', detail: `shard ${n}'s log shows ${unhandled} unhandled error(s) between tests` };
  }
  return null;
}

/** The PR's changed paths against the merge base with origin/<base>, and each test the diff reaches through the import graph. */
function prScope(repoRoot: string, file: PregateFile): { diff: Set<string>; closure: Map<string, string[]> } | { error: string } {
  const git = (args: string[]) => { const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
  const base = resolveBaseBranch(repoRoot);
  const mb = git(['merge-base', `refs/remotes/origin/${base}`, '--end-of-options', file.head!])?.trim();
  if (!mb) return { error: `git cannot find the merge base of origin/${base} and ${short(file.head)}` };
  const listed = git(['diff', '--name-status', '-z', '--no-renames', '--end-of-options', mb, file.head!]);
  if (listed === null) return { error: `git diff ${short(mb)} ${short(file.head)} failed` };
  const parts = listed.split('\0').filter(Boolean);
  const diff = new Set<string>();
  const deleted: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) { diff.add(parts[i + 1]!); if (parts[i] === 'D') deleted.push(parts[i + 1]!); }
  const loaded = loadConfigFromBase(repoRoot, base);
  if (isConfigUnavailable(loaded) || loaded.errors.length) return { error: `the base branch's .gstack/pregate.json cannot be read, so its dependency declarations are unknown` };
  const at = () => { const fp = wtreeFingerprint({ cwd: repoRoot }); return 'tree' in fp ? fp.tree : null; };
  if (at() !== file.tree) return { error: `the working tree is not pregate.json's tree ${short(file.tree)}; the import closure must be read from that tree` };
  const declarations = loaded.config.dependencies;
  const graph = buildGraph(repoRoot, { declarations, extraFiles: deleted });
  const closure = new Map<string, string[]>();
  for (const changed of diff) for (const t of testsFor(graph, changed, declarations).tests) closure.set(t, [...(closure.get(t) ?? []), changed]);
  if (at() !== file.tree) return { error: 'the working tree changed while the import closure was read' };
  return { diff, closure };
}

/**
 * After the runs verified and covered the obligation: the named cases must be exactly the failures, in no paid or
 * security test, outside the PR's diff and import closure, the PR's head must be pregate.json's, and the grant row must
 * carry this exception's binding in the owner's words. Returns the exception to record.
 */
export function flakyDecision(file: PregateFile, lane: string, check: { repo: string; failures?: FailureDeps }, runs: FlakyRuns, input: FlakyInput & { cases: string[] }, repoRoot: string): { exception: PregateException } | FlakyRefusal {
  const label = runs.red.map(r => `run ${r.evidence.run_id} attempt ${r.evidence.run_attempt}`).join(', ');
  const failures = [...new Set(runs.red.flatMap(r => r.failures))];
  const extra = failures.filter(f => !input.cases.includes(f));
  if (extra.length) return invalid(lane, 'unnamed_failure', `${label} failed ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ` and ${extra.length - 5} more` : ''}, which no --flaky-exception names`);
  const notFailed = input.cases.find(c => !failures.includes(c));
  if (notFailed) return invalid(lane, 'case_not_failed', `${notFailed} did not fail in ${label}; its failures are ${failures.join(', ')}`);
  const files = [...new Set(input.cases.map(c => c.slice(0, c.indexOf('::'))))];
  const { isPaidTestFile } = require('../../test/helpers/paid-test-set') as typeof import('../../test/helpers/paid-test-set');
  const paid = files.find(f => isPaidTestFile(f));
  if (paid) return invalid(lane, 'case_paid', `${paid} is a paid test file; the paid gate covers it, never an exception`);
  const security = files.find(f => SECURITY_TEST.test(path.posix.basename(f)));
  if (security) return invalid(lane, 'case_security', `${security} tests a security scan, which an exception never covers`);
  let pr: { head_sha: string; state: string; head_repo: string | null };
  try { pr = check.failures!.pull(input.pr!); }
  catch (e) { return invalid(lane, 'api_error', `reading PR #${input.pr} failed: ${errText(e)}`); }
  if (pr.state !== 'open') return invalid(lane, 'pr_mismatch', `PR #${input.pr} is ${pr.state}`);
  if ((pr.head_repo ?? '').toLowerCase() !== check.repo.toLowerCase()) return invalid(lane, 'pr_mismatch', `PR #${input.pr}'s head is on ${pr.head_repo ?? 'an unknown repository'}, not ${check.repo}`);
  if (pr.head_sha !== file.head) return invalid(lane, 'pr_mismatch', `PR #${input.pr}'s head is ${short(pr.head_sha)}, not pregate.json's head ${short(file.head)}`);
  const scope = prScope(repoRoot, file);
  if ('error' in scope) return invalid(lane, 'closure_failed', scope.error);
  const touched = files.find(f => scope.diff.has(f));
  if (touched) return invalid(lane, 'case_in_diff', `${touched} is in the PR's diff`);
  const reached = files.find(f => scope.closure.has(f));
  if (reached) return invalid(lane, 'case_in_closure', `${reached} depends on a file the PR changes (${scope.closure.get(reached)!.slice(0, 5).join(', ')})`);
  const subject: ExceptionSubject = { lane, repo: check.repo, pr: input.pr!, head: file.head!, tree: file.tree, runs: runs.evidence.map(e => `${e.run_id}/${e.run_attempt}`), cases: [...input.cases].sort() };
  const binding = exceptionBinding(subject);
  if (!input.grant) {
    const ask = `Accept flaky ${subject.cases.join(', ')} in run ${subject.runs.join(',')} for PR #${subject.pr} at ${short(subject.head)}? Pregate only; required CI still needs a green run.`.slice(0, 300);
    return invalid(lane, 'grant_needed', `every failure in ${label} is named (${subject.cases.join(', ')}) and outside the PR's diff and its import closure; the owner must grant the exception`,
      `ask the owner, record their words with gstack-approvals add --ask ${shellQuote(ask)} --words "<the owner's exact words>" --by "<owner>" --scope "${binding}" --source pregate-flaky-exception, then rerun this clear with --grant <the row id it prints>`);
  }
  const row = input.grantRow?.(input.grant) ?? null;
  if (!row) return invalid(lane, 'grant_missing', `no gstack-approvals row ${input.grant} in this branch's record`);
  if (row.scope !== binding) return invalid(lane, 'grant_mismatch', `row ${row.id}'s scope ${JSON.stringify(row.scope.slice(0, 80))} is not this exception's binding ${binding}; a grant covers one repository, PR, head, tree, lane, run attempt and case list, so a new head needs a new grant`);
  if (row.outcome !== 'approved') return invalid(lane, 'grant_not_approved', `row ${row.id} records outcome ${row.outcome}, not approved`);
  if (/^agent:/i.test(row.by)) return invalid(lane, 'grant_not_owner', `row ${row.id} records an agent's words (${row.by}); only the owner grants an exception`);
  return { exception: { ...subject, grant: row.id, by: row.by, words: row.words, binding } };
}
