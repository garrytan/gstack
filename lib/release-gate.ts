/**
 * The release gate (docs/ship-policy.md#release-gate; plan ship-90-90 choice A):
 * the full paid gate on the gated branch's head every cadence_hours, only when
 * the branch moved since the last gate, instead of a gate per train or per push.
 *
 *   run     skip when the branch head equals the stable branch, already has a
 *           green or red record, or the last gate is younger than the cadence;
 *           otherwise write a PENDING `release` record to refs/notes/gstack-trains,
 *           dispatch gate_workflow on the head (eval-bg's backstop nonce), follow
 *           it, and record GREEN, RED or INCOMPLETE. Rule-16 reruns happen inside
 *           the gate run (scripts/lib/paid-rerun.ts): a case that failed once and
 *           passed its one rerun is green and listed as flaky here.
 *   bisect  a red record's red verdict cases, one trial each, on up to
 *           MAX_PREFIXES first-parent commits between the last green gate (or
 *           the stable branch) and the red head, dispatched on release-gate/<id>
 *           and narrowed round by round until first_bad is the commit right after
 *           a green one; spend-capped and resumable.
 *   status  stable, the last gate, pending commits and the hold.
 *
 * The gate never writes the stable branch. scripts/release-cut.ts is its only
 * writer: it reads a green record (or the check_name check run this gate's
 * workflow publishes) as gated, and refuses every cut while a red record is not
 * followed by a green gate on a later commit (the hold, on_red hold-release).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DISPATCH_INPUTS, makeNonce } from '../scripts/eval-bg';
import { pollDelayMs } from './gh-poll';
import { ghFailureReason, type GhRunner } from '../scripts/recover-receipts';
import { MAX_BISECT_CASES, MAX_PREFIXES, RELEASE_BISECT_ARTIFACT, RELEASE_BISECT_REF, type Git } from '../scripts/train-gate';
import type { ReleaseGatePolicy } from './release-gate-policy';
import { loadPolicyFromBase, mergePolicy, validatePolicy } from './ship-policy';
import {
  NOTES_REF, fetchNotes, nowIso, persist, repoIdentity,
  type PrefixResult, type ReleaseBisect, type ReleaseBisectRound, type ReleaseRecord,
} from './ship-queue-train-record';

export const RELEASE_TRIAL_RESERVATION_USD = 1.5;
/** A bisect case runs one trial and, on a VERDICT failure, its one rule-16 rerun (scripts/train-gate.ts runBisectPrefix). */
export const RELEASE_TRIALS_PER_CASE = 2;
/** The gate plus the one re-dispatch EVAL_POLICY.infraRedispatch allows an incomplete census. */
export const MAX_RELEASE_ATTEMPTS = 2;
/** Cron start jitter the cadence forgives. */
export const CADENCE_GRACE_HOURS = 1;
export const MAX_BISECT_ROUNDS = 4;
/** An open gate (a run past its budget, or a red gate's running bisect) on an older commit is finished first for this many cadences; after that it stops holding up main's head. */
export const OPEN_GATE_CADENCES = 3;
const SHA = /^[0-9a-f]{40}$/;
const CASE_ID = /^[A-Za-z0-9 _.:/-]{1,128}$/;
const HOUR = 3_600_000;
const GH_MS = 60_000;

export interface Run { id: number; status: string; conclusion: string | null; head_sha: string; display_title?: string; html_url?: string; run_attempt?: number }
export interface GateEnv {
  repo: string; repoRoot: string; remote: string; gh: GhRunner; git: Git;
  now: () => number; sleep: (ms: number) => void; random: () => string; pollMs: number;
  /** Epoch ms after which nothing waits on a run any more; the record stays resumable. */
  deadline: number;
}
export type GateAction = 'inert' | 'skipped' | 'dry-run' | 'gated' | 'held' | 'failed';
export interface GateOut { action: GateAction; sha: string | null; lines: string[] }

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : 'none');
const usd = (n: number | null) => (n === null ? 'unknown' : n.toFixed(2));

/** The release_gate block from origin/<base>'s reviewed policy, or from --policy <file> (validated the same way). */
export function loadReleaseGate(repoRoot: string, o: { policyFile?: string; base?: string }): { gate: ReleaseGatePolicy | null; label: string } | { error: string } {
  if (o.policyFile) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(o.policyFile, 'utf8')); } catch (e: any) { return { error: `${o.policyFile} is not readable JSON: ${e.message}` }; }
    const errors = validatePolicy(raw);
    if (errors.length) return { error: `${o.policyFile}: ${errors.map(e => `${e.path} ${e.message}`).join('; ')}` };
    return { gate: mergePolicy(raw as Record<string, unknown>, o.policyFile).policy.release_gate, label: o.policyFile };
  }
  const loaded = loadPolicyFromBase(repoRoot, o.base ?? 'main');
  if ('unavailable' in loaded) return { error: `no reviewed policy: ${loaded.detail}` };
  if (loaded.errors.length) return { error: `${loaded.source.label}: ${loaded.errors.map(e => `${e.path} ${e.message}`).join('; ')}` };
  return { gate: loaded.policy.release_gate, label: loaded.source.label };
}

/** This repository's release records from the local notes ref, newest first. */
export function releaseRecords(git: Git, repoKey: string): ReleaseRecord[] {
  const listed = git(['notes', `--ref=${NOTES_REF}`, 'list']);
  if (!listed.ok || !listed.out.trim()) return [];
  return listed.out.split('\n').map(line => line.split(' ')[0]!).filter(Boolean).flatMap(blob => {
    try { const r = JSON.parse(git(['cat-file', 'blob', blob]).out) as ReleaseRecord; return r?.kind === 'release' && r.repo_key === repoKey && SHA.test(r.sha) ? [r] : []; } catch { return []; }
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The red record that holds releases: red, and no green record sits on a later commit that contains it. Null when none. */
export function activeHold(records: readonly ReleaseRecord[], isAncestor: (older: string, newer: string) => boolean): ReleaseRecord | null {
  const greens = records.filter(r => r.verdict === 'GREEN');
  return records.filter(r => r.verdict === 'RED').find(red => !greens.some(g => g.sha !== red.sha && isAncestor(red.sha, g.sha))) ?? null;
}

/** The newest green record on an ancestor of sha: where pending commits and a bisect start. */
export function greenBase(records: readonly ReleaseRecord[], sha: string, isAncestor: (older: string, newer: string) => boolean): ReleaseRecord | null {
  return records.find(r => r.verdict === 'GREEN' && r.sha !== sha && isAncestor(r.sha, sha)) ?? null;
}

export interface ReportFacts { verdict: 'GREEN' | 'RED' | 'NONE'; red: string[]; other: string[]; cost: number | null }

/** report-verdict's report.txt: the verdict, each failed case (a verdict red, or another class), and the known cost. */
export function parseReport(text: string): ReportFacts {
  const verdict = (/VERDICT (GREEN|RED)/.exec(text)?.[1] as 'GREEN' | 'RED' | undefined) ?? 'NONE';
  const red: string[] = [];
  const other: string[] = [];
  for (const m of text.matchAll(/^\s+✗ (\S(?:.*?\S)?) {2,}(\w+) {2,}(\w+)(?: {2,}([A-Z_]+))?/gm)) {
    (m[3] === 'FAIL' && (!m[4] || m[4] === 'VERDICT') ? red : other).push(m[1]!);
  }
  const cost = /· cost \$(\d+(?:\.\d+)?)/.exec(text)?.[1];
  return { verdict, red: [...new Set(red)].sort(), other: [...new Set(other)].sort(), cost: cost ? Number(cost) : null };
}

/** A finished gate run as one verdict; green needs the run's own success, which follows its rule-16 report. */
export function classifyRun(run: Pick<Run, 'status' | 'conclusion'>, report: ReportFacts | null): { verdict: ReleaseRecord['verdict']; red: string[]; detail: string } {
  if (run.status !== 'completed') return { verdict: 'PENDING', red: [], detail: `run is ${run.status}` };
  if (run.conclusion === 'success') {
    if (report?.verdict === 'GREEN') return { verdict: 'GREEN', red: [], detail: 'run and report green' };
    return { verdict: 'INCOMPLETE', red: [], detail: report ? `the run concluded success but its report says ${report.verdict}` : 'the run concluded success but its report artifact is missing' };
  }
  if (report?.verdict === 'RED' && report.red.length) {
    return { verdict: 'RED', red: report.red, detail: `${report.red.length} red case(s)${report.other.length ? `; also not green: ${report.other.join(', ')}` : ''}` };
  }
  return { verdict: 'INCOMPLETE', red: [], detail: `run concluded ${run.conclusion ?? 'unknown'}; report ${report ? `${report.verdict}${report.other.length ? ` (${report.other.join(', ')})` : ''}` : 'missing'}` };
}

/** Up to max commits spread evenly over the interior of a range (oldest first), never the endpoints. */
export function planPrefixes(interior: readonly string[], max = MAX_PREFIXES): string[] {
  if (interior.length <= max) return [...interior];
  const picked = Array.from({ length: max }, (_, i) => interior[Math.round(((i + 1) * (interior.length + 1)) / (max + 1)) - 1]!);
  return [...new Set(picked)];
}

/**
 * One round's results narrow (good, bad]: the earliest prefix where any case is
 * red becomes bad, the prefix before it good. Every case must be monotone
 * (green, then red) over the tested prefixes and have a result on each.
 */
export function narrow(range: { good: string; bad: string }, tested: ReadonlyArray<{ sha: string; results: Record<string, PrefixResult> }>, cases: readonly string[]): { good: string; bad: string } | { unknown: string } {
  let firstRed = tested.length;
  for (const c of cases) {
    const seq = tested.map(p => (p.results[c] === 'red' ? 'R' : p.results[c] === 'green' ? 'G' : '?')).join('');
    if (seq.includes('?')) return { unknown: `no result for ${c} on ${tested.filter(p => !p.results[c]).map(p => short(p.sha)).join(', ')}` };
    const at = seq.indexOf('R');
    if (at >= 0 && seq.slice(at).includes('G')) return { unknown: `${c} is not monotone over the tested commits (${seq})` };
    if (at >= 0) firstRed = Math.min(firstRed, at);
  }
  return { good: firstRed > 0 ? tested[firstRed - 1]!.sha : range.good, bad: firstRed < tested.length ? tested[firstRed]!.sha : range.bad };
}

function ghJson<T>(env: GateEnv, args: string[]): T | null {
  const r = env.gh(args, GH_MS);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

/** One file of a run's artifact, or null when the artifact or the file is missing. */
function artifactFile(env: GateEnv, run: number, name: string, file: string): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  try {
    if (env.gh(['run', 'download', String(run), '-R', env.repo, '-n', name, '-D', dir], GH_MS).status !== 0) return null;
    const find = (d: string): string | null => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { const hit = find(p); if (hit) return hit; } else if (e.name === file) return p;
      }
      return null;
    };
    const hit = find(dir);
    return hit ? fs.readFileSync(hit, 'utf8') : null;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function dispatch(env: GateEnv, workflow: string, ref: string, inputs: Record<string, string>): string | null {
  const r = env.gh(['workflow', 'run', workflow, '--repo', env.repo, '--ref', ref, ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`])], GH_MS);
  return r.status === 0 ? null : ghFailureReason(r.stderr);
}

/** Find a dispatch's run by its nonce, then follow it until it completes or the deadline passes. */
function follow(env: GateEnv, workflow: string, nonce: string, known: number | null, lines: string[]): Run | null {
  let run: Run | null = known ? ghJson<Run>(env, ['api', `repos/${env.repo}/actions/runs/${known}`]) : null;
  for (;;) {
    if (!run) {
      const runs = ghJson<{ workflow_runs?: Run[] }>(env, ['api', '-X', 'GET', `repos/${env.repo}/actions/workflows/${workflow}/runs`, '-f', 'event=workflow_dispatch', '-f', 'per_page=30']);
      run = runs?.workflow_runs?.find(r => (r.display_title ?? '').includes(`eval-bg ${nonce}]`)) ?? null;
      if (run) lines.push(`RELEASE: run ${run.id} ${run.html_url ?? ''}`.trim());
    } else if (run.status === 'completed') return run;
    if (env.now() >= env.deadline) break;
    env.sleep(pollDelayMs(env.pollMs));
    if (run) run = ghJson<Run>(env, ['api', `repos/${env.repo}/actions/runs/${run.id}`]) ?? run;
  }
  lines.push(`RELEASE: ${run ? `run ${run.id} is still ${run.status}` : `no run for nonce ${nonce} yet`} at the deadline; the record stays resumable`);
  return run;
}

const runRef = (env: GateEnv, run: Run) => ({ id: run.id, url: run.html_url ?? `https://github.com/${env.repo}/actions/runs/${run.id}` });

/** Writes the record and pushes it to origin's notes; false when the push failed, so no paid dispatch may follow. */
function save(env: GateEnv, rec: ReleaseRecord, lines: string[]): boolean {
  rec.updated_at = nowIso();
  const p = persist(env.repoRoot, [rec], { remote: env.remote });
  if (!p.pushed) lines.push(`RELEASE: record ${p.detail}`);
  return p.pushed;
}

interface Context { gate: ReleaseGatePolicy; repoKey: string; stable: string | null; records: ReleaseRecord[]; isAncestor: (a: string, b: string) => boolean }

function context(env: GateEnv, gate: ReleaseGatePolicy): Context | { error: string } {
  const f = fetchNotes(env.repoRoot, env.remote);
  if (!f.ok) return { error: f.detail };
  const stable = env.git(['ls-remote', env.remote, `refs/heads/${gate.stable_ref}`]).out.split(/\s/)[0] || null;
  const isAncestor = (a: string, b: string) => env.git(['merge-base', '--is-ancestor', a, b]).ok;
  const repoKey = repoIdentity(env.repoRoot).key;
  return { gate, repoKey, stable: stable && SHA.test(stable) ? stable : null, records: releaseRecords(env.git, repoKey), isAncestor };
}

/** Make sure the gated branch's history is here (a shallow checkout gets it), so ancestry and ranges read true. */
function ensureHistory(env: GateEnv, gate: ReleaseGatePolicy, sha: string): void {
  if (env.git(['rev-parse', '--is-shallow-repository']).out === 'true') env.git(['fetch', '--no-tags', '-q', '--unshallow', env.remote, gate.branch, gate.stable_ref]);
  if (!env.git(['cat-file', '-e', `${sha}^{commit}`]).ok) env.git(['fetch', '--no-tags', '-q', env.remote, gate.branch]);
}

const firstParents = (env: GateEnv, from: string, to: string): string[] | null => {
  const r = env.git(['rev-list', '--first-parent', '--reverse', `${from}..${to}`]);
  return r.ok ? r.out.split('\n').filter(Boolean) : null;
};

export interface RunOptions { gate: ReleaseGatePolicy | null; label: string; sha?: string; dryRun: boolean; ignoreCadence: boolean }

/** `run`: gate the branch head once when it moved; bisect a red. */
export function runGate(env: GateEnv, o: RunOptions): GateOut {
  const lines: string[] = [];
  const out = (action: GateAction, sha: string | null): GateOut => ({ action, sha, lines });
  if (!o.gate) { lines.push(`RELEASE: inert (${o.label} declares no release_gate block; the per-push main backstop gates main)`); return out('inert', null); }
  const gate = o.gate;
  const c = context(env, gate);
  if ('error' in c) { lines.push(`RELEASE: cannot read refs/notes/gstack-trains (${c.error}); nothing dispatched`); return out('failed', null); }
  const head = o.sha ?? env.git(['ls-remote', env.remote, `refs/heads/${gate.branch}`]).out.split(/\s/)[0] ?? '';
  if (!SHA.test(head)) { lines.push(`RELEASE: cannot resolve ${gate.branch} on ${env.remote} (${JSON.stringify(head)})`); return out('failed', null); }
  const fresh = (r: ReleaseRecord) => env.now() - Date.parse(r.created_at) < OPEN_GATE_CADENCES * gate.cadence_hours * HOUR;
  const open = o.sha ? null : c.records.find(r => r.sha !== head && fresh(r) && ((r.verdict === 'PENDING' && r.run) || (r.verdict === 'RED' && r.bisect?.state === 'running')));
  if (open && o.dryRun) { lines.push(`RELEASE: dry run: would finish the open gate on ${short(open.sha)} (${open.verdict}, run ${open.run?.id ?? '-'}) before gating ${gate.branch}@${short(head)}; nothing written`); return out('dry-run', open.sha); }
  if (open) lines.push(`RELEASE: finishing the open gate on ${short(open.sha)} (${open.verdict}, run ${open.run?.id ?? '-'}) before gating ${gate.branch}@${short(head)}`);
  const sha = open?.sha ?? head;
  ensureHistory(env, gate, sha);
  const prior = c.records.find(r => r.sha === sha) ?? null;
  const skip = (why: string) => { lines.push(`RELEASE: skip sha=${sha} (${why})`); return out('skipped', sha); };
  if (!open && sha === c.stable) return skip(`${gate.branch} has not moved since ${gate.stable_ref}`);
  if (prior?.verdict === 'GREEN' || prior?.verdict === 'RED') {
    if (prior.verdict === 'RED' && prior.bisect?.state === 'running' && !o.dryRun) return finishRed(env, c, prior, lines, out);
    return skip(`${gate.branch} has not moved since the last gate: ${prior.verdict} run ${prior.run?.id ?? '-'}`);
  }
  if (prior?.verdict === 'INCOMPLETE' && prior.attempts >= MAX_RELEASE_ATTEMPTS) return skip(`the gate on this commit was incomplete ${prior.attempts} times (${prior.detail}); diagnose run ${prior.run?.url ?? prior.run?.id ?? '-'}`);
  const newest = c.records[0];
  const age = newest ? (env.now() - Date.parse(newest.created_at)) / HOUR : Infinity;
  if (!o.ignoreCadence && prior?.verdict !== 'PENDING' && age < gate.cadence_hours - CADENCE_GRACE_HOURS) {
    return skip(`the last gate was dispatched ${age.toFixed(1)} h ago on ${short(newest!.sha)}; cadence ${gate.cadence_hours} h`);
  }
  const since = greenBase(c.records, sha, c.isAncestor)?.sha ?? c.stable;
  const pending = since ? firstParents(env, since, sha)?.length ?? null : null;
  lines.push(`RELEASE: gate sha=${sha} since=${short(since)} (${since === c.stable ? gate.stable_ref : 'last green gate'}) pending=${pending ?? 'unknown'} stable=${short(c.stable)}`);
  if (o.dryRun) { lines.push(`RELEASE: dry run: would dispatch ${gate.gate_workflow} on ${gate.branch}@${short(sha)} (full gate, about $37); nothing written`); return out('dry-run', sha); }
  const now = nowIso();
  const rec: ReleaseRecord = prior?.verdict === 'PENDING' ? prior : {
    schema: 1, kind: 'release', repo_key: c.repoKey, sha, tree: env.git(['rev-parse', `${sha}^{tree}`]).out, branch: gate.branch, stable: c.stable, since,
    nonce: makeNonce('gate', sha, sha, env.random(), { purpose: 'backstop' }), attempts: (prior?.attempts ?? 0) + 1, run: null, verdict: 'PENDING',
    red_cases: [], flaky: [], cost_usd: null, detail: 'dispatching', bisect: null, created_at: now, updated_at: now,
  };
  if (rec !== prior) {
    if (!save(env, rec, lines)) { lines.push(`RELEASE: incomplete sha=${sha} run=- (the record did not reach ${env.remote}; nothing dispatched, so no run repeats a paid gate)`); return out('failed', sha); }
    const failed = dispatch(env, gate.gate_workflow, gate.branch, { [DISPATCH_INPUTS.evalsAll]: 'true', [DISPATCH_INPUTS.expectedSha]: sha, [DISPATCH_INPUTS.nonce]: rec.nonce });
    if (failed) { Object.assign(rec, { verdict: 'INCOMPLETE', detail: `the gate dispatch failed (${failed})` }); save(env, rec, lines); lines.push(`RELEASE: incomplete sha=${sha} run=- (${rec.detail})`); return out('failed', sha); }
    lines.push(`RELEASE: dispatched ${gate.gate_workflow} on ${gate.branch}@${short(sha)} (nonce ${rec.nonce})`);
  } else lines.push(`RELEASE: resuming the pending gate on ${short(sha)} (nonce ${rec.nonce})`);
  const run = follow(env, gate.gate_workflow, rec.nonce, rec.run?.id ?? null, lines);
  if (run) rec.run = runRef(env, run);
  if (!run || run.status !== 'completed') { rec.detail = run ? `run ${run.id} ${run.status}` : 'no run found for the nonce yet'; save(env, rec, lines); return out('failed', sha); }
  const attempt = run.run_attempt ?? 1;
  const reportText = artifactFile(env, run.id, `report-verdict-a${attempt}`, 'report.txt');
  const report = reportText === null ? null : parseReport(reportText);
  const flakes = artifactFile(env, run.id, `flake-records-a${attempt}`, 'flake-records.jsonl') ?? '';
  const k = classifyRun(run, report);
  Object.assign(rec, {
    verdict: k.verdict, red_cases: k.red, detail: k.detail, cost_usd: report?.cost ?? null,
    flaky: [...new Set(flakes.split('\n').flatMap(l => { try { const f = JSON.parse(l); return typeof f?.case === 'string' ? [f.case] : []; } catch { return []; } }))].sort(),
  });
  save(env, rec, lines);
  if (rec.flaky.length) lines.push(`RELEASE: flaky (failed once, passed its one rule-16 rerun in run ${run.id}): ${rec.flaky.join(', ')}`);
  if (rec.verdict === 'GREEN') {
    lines.push(`RELEASE: green sha=${sha} stable=${c.stable ?? 'none'} run=${run.id} cost=${usd(rec.cost_usd)}`,
      `RELEASE: ${gate.check_name} success goes on ${short(sha)}; scripts/release-cut.ts moves ${gate.stable_ref} on its own schedule and floor`);
    return out('gated', sha);
  }
  if (rec.verdict === 'RED') return finishRed(env, c, rec, lines, out);
  lines.push(`RELEASE: incomplete sha=${sha} run=${run.id} (${rec.detail})${rec.attempts < MAX_RELEASE_ATTEMPTS ? '; the next run re-dispatches it once' : ''}`);
  return out('failed', sha);
}

function finishRed(env: GateEnv, c: Context, rec: ReleaseRecord, lines: string[], out: (a: GateAction, s: string | null) => GateOut): GateOut {
  bisectRecord(env, c, rec, { dryRun: false }, lines);
  lines.push(`RELEASE: red sha=${rec.sha} first_bad=${rec.bisect?.first_bad ?? 'unknown'} run=${rec.run?.id ?? '-'}`,
    `RELEASE: hold: scripts/release-cut.ts refuses to move ${c.gate.stable_ref} until a gate on a later commit is green (red: ${rec.red_cases.join(', ')}); land the revert or the fix-forward`);
  return out('held', rec.sha);
}

/**
 * Collect a bisect round's prefix records into its results. Each case on each prefix adds its reported cost to the spend, or
 * RELEASE_TRIAL_RESERVATION_USD for each trial it ran when the cost is null: two for a VERDICT failure or a flaky pass (the
 * rule-16 rerun), one otherwise, and two when the prefix record is missing, so the cap holds across rounds.
 */
function collectRound(env: GateEnv, b: ReleaseBisect, round: ReleaseBisectRound, run: Run): void {
  for (const p of round.prefixes) {
    const text = artifactFile(env, run.id, `${RELEASE_BISECT_ARTIFACT}-bisect-${p.sha.slice(0, 12)}`, 'bisect-prefix.json');
    let rec: { kind?: string; nonce?: string; prefix_sha?: string; checked_out_sha?: string; panels?: Array<{ case: string; status: string; red_class: string | null; cost_usd: number | null; flaky?: unknown }> } | null = null;
    try { rec = text ? JSON.parse(text) : null; } catch { rec = null; }
    const valid = rec && rec.kind === 'train-bisect-prefix' && rec.nonce === round.nonce && rec.prefix_sha === p.sha && rec.checked_out_sha === p.sha && Array.isArray(rec.panels);
    for (const c of b.cases) {
      const panel = valid ? rec!.panels!.find(x => x.case === c) : undefined;
      const trials = !panel || panel.flaky || (panel.status === 'FAIL' && panel.red_class === 'VERDICT') ? RELEASE_TRIALS_PER_CASE : 1;
      b.spent_usd = Math.round((b.spent_usd + (typeof panel?.cost_usd === 'number' ? panel.cost_usd : trials * RELEASE_TRIAL_RESERVATION_USD)) * 100) / 100;
      if (!panel) continue;
      if (panel.status === 'PASS') p.results[panel.case] = 'green';
      else if (panel.status === 'FAIL' && panel.red_class === 'VERDICT') p.results[panel.case] = 'red';
    }
  }
}

/**
 * Bisect a red record (resumable): finish a round still running, then narrow
 * (good, bad] with up to MAX_PREFIXES commits a round until they are adjacent,
 * the pattern is not monotone, the cap is spent, or MAX_BISECT_ROUNDS pass.
 * Without o.spendCap the bisect runs under the policy's current cap (stored as spend_cap), so lowering the policy stops further
 * rounds and raising it lets `bisect` resume; a one-off `bisect --spend-cap` (o.spendCap) applies to that invocation only and is never stored.
 */
export function bisectRecord(env: GateEnv, c: Context, rec: ReleaseRecord, o: { spendCap?: number; dryRun: boolean }, lines: string[]): void {
  const policyCap = c.gate.bisect_spend_cap_usd;
  const b: ReleaseBisect = rec.bisect ?? { cases: rec.red_cases, good: rec.since, bad: rec.sha, first_bad: null, spend_cap: policyCap, spent_usd: 0, state: 'running', detail: '', rounds: [] };
  b.spend_cap = policyCap;
  const cap = o.spendCap ?? policyCap;
  const stop = (state: ReleaseBisect['state'], detail: string) => { Object.assign(b, { state, detail }); };
  if (!o.dryRun) rec.bisect = b;
  if (b.state === 'running' && cap <= 0 && !b.rounds.length) stop('unknown', 'bisect_spend_cap_usd is 0: no bisect');
  else if (b.state === 'running' && (!b.cases.length || b.cases.length > MAX_BISECT_CASES || b.cases.some(id => !CASE_ID.test(id)))) stop('unknown', `the red cases cannot be bisected (${b.cases.length} case ids, at most ${MAX_BISECT_CASES})`);
  else if (b.state === 'running' && !b.good) stop('unknown', 'no green gate and no stable branch before the red commit to bisect from');
  while (b.state === 'running') {
    const open = b.rounds.at(-1);
    if (open && open.prefixes.some(p => b.cases.some(cs => !p.results[cs])) && open.run?.id !== -1) {
      if (o.dryRun) { lines.push(`RELEASE: dry run: round ${b.rounds.length} (nonce ${open.nonce}) still has prefixes to collect`); return; }
      const run = follow(env, c.gate.gate_workflow, open.nonce, open.run?.id ?? null, lines);
      if (run) open.run = runRef(env, run);
      if (!run || run.status !== 'completed') { b.detail = `round ${b.rounds.length} is still running`; save(env, rec, lines); return; }
      collectRound(env, b, open, run);
      env.git(['push', '-q', env.remote, '--delete', `refs/heads/${open.ref}`]);
      const n = narrow({ good: b.good!, bad: b.bad }, open.prefixes, b.cases);
      if ('unknown' in n) { stop('unknown', n.unknown); break; }
      Object.assign(b, n);
      lines.push(`RELEASE: bisect round ${b.rounds.length}: good=${short(b.good)} bad=${short(b.bad)} spent=$${b.spent_usd.toFixed(2)}`);
      save(env, rec, lines);
    }
    const interior = firstParents(env, b.good!, b.bad);
    if (!interior) { stop('unknown', `cannot list ${short(b.good)}..${short(b.bad)}`); break; }
    interior.pop();
    if (!interior.length) { b.first_bad = b.bad; stop('found', `${short(b.bad)} is the first red commit after green ${short(b.good)}`); break; }
    if (b.rounds.length >= MAX_BISECT_ROUNDS) { stop('unknown', `${MAX_BISECT_ROUNDS} rounds left ${interior.length} commit(s) between ${short(b.good)} and ${short(b.bad)}`); break; }
    const perPrefix = b.cases.length * RELEASE_TRIALS_PER_CASE * RELEASE_TRIAL_RESERVATION_USD;
    const fits = Math.max(0, Math.floor((cap - b.spent_usd + 1e-9) / perPrefix));
    const prefixes = planPrefixes(interior, Math.min(MAX_PREFIXES, fits));
    if (!prefixes.length) { stop('capped', `the next round needs $${perPrefix.toFixed(2)} a prefix; $${Math.max(0, cap - b.spent_usd).toFixed(2)} of the $${cap.toFixed(2)} cap is left`); break; }
    lines.push(`RELEASE: bisect round ${b.rounds.length + 1}: ${b.cases.length} case(s) on ${prefixes.length} of ${interior.length} commit(s) between ${short(b.good)} and ${short(b.bad)}, $${(perPrefix * prefixes.length).toFixed(2)} reserved`);
    if (o.dryRun) { lines.push('RELEASE: dry run: nothing dispatched'); return; }
    const nonce = makeNonce('gate', b.bad, b.good!, env.random(), { purpose: 'bisect' });
    const ref = `${RELEASE_BISECT_REF}${nonce.slice(-6)}-${b.bad.slice(0, 12)}`;
    const round: ReleaseBisectRound = { nonce, ref, run: null, prefixes: prefixes.map(sha => ({ sha, results: {} })) };
    b.rounds.push(round);
    if (!save(env, rec, lines)) { b.rounds.pop(); lines.push('RELEASE: bisect round not dispatched: the record did not reach ' + env.remote); return; }
    const pushed = env.git(['push', '-q', env.remote, `${b.bad}:refs/heads/${ref}`]);
    const failed = pushed.ok ? dispatch(env, c.gate.gate_workflow, ref, {
      [DISPATCH_INPUTS.cases]: b.cases.join(','), [DISPATCH_INPUTS.prefixShas]: prefixes.join(','), [DISPATCH_INPUTS.expectedSha]: b.bad, [DISPATCH_INPUTS.nonce]: nonce,
    }) : `git push ${ref} failed: ${pushed.out.slice(0, 120)}`;
    if (failed) { round.run = { id: -1, url: '' }; env.git(['push', '-q', env.remote, '--delete', `refs/heads/${ref}`]); stop('unknown', `round ${b.rounds.length} dispatch failed: ${failed}`); }
  }
  lines.push(`RELEASE: bisect ${b.state}: ${b.detail} (spent $${b.spent_usd.toFixed(2)} of $${cap.toFixed(2)})`);
  if (!o.dryRun) save(env, rec, lines);
}

/** `bisect`: resume or start the bisect of the newest red record (or the one at sha). */
export function bisectGate(env: GateEnv, o: { gate: ReleaseGatePolicy | null; label: string; sha?: string; spendCap?: number; dryRun: boolean }): GateOut {
  const lines: string[] = [];
  if (!o.gate) { lines.push(`RELEASE: inert (${o.label} declares no release_gate block)`); return { action: 'inert', sha: null, lines }; }
  const c = context(env, o.gate);
  if ('error' in c) { lines.push(`RELEASE: cannot read refs/notes/gstack-trains (${c.error})`); return { action: 'failed', sha: null, lines }; }
  const rec = o.sha ? c.records.find(r => r.sha === o.sha) : c.records.find(r => r.verdict === 'RED');
  if (!rec || rec.verdict !== 'RED') { lines.push(`RELEASE: no red release record${o.sha ? ` at ${o.sha}` : ''} to bisect`); return { action: 'failed', sha: o.sha ?? null, lines }; }
  ensureHistory(env, o.gate, rec.sha);
  if (rec.bisect?.state === 'capped' && (o.spendCap ?? o.gate.bisect_spend_cap_usd) > rec.bisect.spent_usd) rec.bisect.state = 'running';
  bisectRecord(env, c, rec, { spendCap: o.spendCap, dryRun: o.dryRun }, lines);
  lines.push(`RELEASE: red sha=${rec.sha} first_bad=${rec.bisect?.first_bad ?? 'unknown'} run=${rec.run?.id ?? '-'}`);
  return { action: o.dryRun ? 'dry-run' : 'held', sha: rec.sha, lines };
}

/** `status`: never spends and never writes. */
export function gateStatus(env: GateEnv, o: { gate: ReleaseGatePolicy | null; label: string }): GateOut {
  const lines: string[] = [];
  if (!o.gate) { lines.push(`RELEASE: inert (${o.label} declares no release_gate block; the per-push main backstop gates main)`); return { action: 'inert', sha: null, lines }; }
  const c = context(env, o.gate);
  if ('error' in c) { lines.push(`RELEASE: cannot read refs/notes/gstack-trains (${c.error})`); return { action: 'failed', sha: null, lines }; }
  const head = env.git(['ls-remote', env.remote, `refs/heads/${o.gate.branch}`]).out.split(/\s/)[0] ?? '';
  if (SHA.test(head)) ensureHistory(env, o.gate, head);
  const last = c.records[0];
  const base = SHA.test(head) ? greenBase(c.records, head, c.isAncestor)?.sha ?? c.stable : null;
  const pending = base && SHA.test(head) ? (base === head ? 0 : firstParents(env, base, head)?.length ?? null) : null;
  const hold = activeHold(c.records, c.isAncestor);
  lines.push(
    `STABLE: ${o.gate.stable_ref} ${c.stable ?? 'absent'} (scripts/release-cut.ts moves it; the gate never does)`,
    `LAST_GATE: ${last ? `${last.verdict} sha=${last.sha} run=${last.run?.id ?? '-'} at=${last.created_at} cost=${usd(last.cost_usd)}${last.flaky.length ? ` flaky=${last.flaky.join(',')}` : ''}` : 'none'}`,
    `PENDING: ${pending ?? 'unknown'} commit(s) on ${o.gate.branch} ${short(head)} since ${short(base)}`,
    `HOLD: ${hold ? `red on ${hold.sha} since ${hold.created_at} (red: ${hold.red_cases.join(', ')}; first_bad=${hold.bisect?.first_bad ?? 'unknown'}, bisect ${hold.bisect?.state ?? 'not run'}); release-cut refuses until a gate on a later commit is green` : 'none'}`,
  );
  return { action: hold ? 'held' : 'skipped', sha: SHA.test(head) ? head : null, lines };
}
