/**
 * Paid-gate verdict reuse for the PR lane (GSTA-48). A gate edit: a head may
 * report the verdict of an earlier full paid gate instead of running one only
 * when every condition below holds; anything else runs the full gate.
 *
 *   bind     (slices-report, every executed pull_request run) records what the
 *            run proved: PR, head, the base its merge commit was built on
 *            (the tested commit's first parent), the reconcile exit, the
 *            report verdict and its plan's selection fingerprint. Reused runs
 *            bind nothing, so reuse never chains off a reuse.
 *   find     (recover-receipts, BASE-REF code, actions: read) takes the newest
 *            earlier completed run of this PR that bound a verdict (its
 *            newest attempt's binding). It must be GREEN with reconcile exit 0
 *            and a successful conclusion, ran the PR profile, and gated a
 *            different head. A flaky-annotated GREEN (rule 16: a red that
 *            passed its one in-run rerun, or a `gh run rerun --failed`
 *            attempt that passed every earlier red) is such a GREEN; a run
 *            still red after its rerun binds RED and is never reused. Then one of:
 *              restamp-only (R2a): same base; the tree receipt
 *                (lib/tree-receipt.ts, the base's ship policy) says
 *                `TREE: same-modulo-stamps` and every differing file is a stamp
 *                file (the version file, package.json, the CHANGELOG, the
 *                release outputs).
 *              main-moved (R2): the base moved; the PR's own diff from its
 *                merge-base, excluding stamp files, is byte-identical to the
 *                gated head's (package.json compared without its version,
 *                the CHANGELOG by the PR's own section bodies).
 *            It writes candidate.json.
 *   confirm  (plan-slices, after this run's own plan) requires this head's
 *            selection fingerprint to equal the bound one, so the reused
 *            verdict covers exactly the cases and trial plans this head would
 *            run. It writes gate-reuse.json and `gate_reuse=true`.
 *   report   (slices-report) prints the reused verdict: which run, which head,
 *            and why.
 *
 * Every failure (no binding, a red, partial or cancelled gate, a non-stamp
 * byte, a missing receipt or merge-base, gh or git errors, a selection change)
 * leaves no candidate, and the run executes the full gate. The free suite and
 * every other check run on the new head regardless.
 *
 * Dispatched screens (plan GSTA-49 T1b): a workflow_dispatch run with
 * screen_pr tests the refs/pull/<n>/merge commit gstack-ship-queue pinned.
 * Its run name ends ` screen #<n>`, and its binding adds the tested merge
 * commit and the screen policy. A screen's find lists both events filtered by
 * the PR, so every newer-run veto spans pull_request runs and screens. A
 * dispatched binding is accepted only when it names this PR and repository,
 * its head is one of the PR's commits, its tested commit merges that head
 * into the bound base, and its policy equals this screen's (a pull_request
 * run counts as broad: today's full PR selection). Train and bisect runs never
 * bind and are never listed, so they neither reuse nor are reused.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { receiptDigest } from '../../lib/ship-queue';
import { isUnavailable, loadPolicyFromBase, matchesAny, type ShipPolicy } from '../../lib/ship-policy';
import { rewriteStamps } from '../../lib/restamp';
import { buildReceipt } from '../../lib/tree-receipt';
import { ghFailureReason, listGateRuns, runGh, type GhRunner, type WorkflowRun } from './recover-receipts';
import type { PaidRunManifest } from '../../scripts/lib/paid-plan';

export const BINDING_FILE = 'gate-binding.json';
export const CANDIDATE_FILE = 'candidate.json';
export const REUSE_FILE = 'gate-reuse.json';
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface GateBinding {
  schema: 1;
  repository: string;
  pr: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  /** The tested merge commit's first parent: the main the gate actually ran against. */
  base_sha: string;
  profile: string;
  reconcile_exit: number;
  verdict: string;
  /** Cases accepted manually (unscored); a gate with any is never reused as a clean pass. */
  manual_accepted: number;
  selection_sha256: string;
  /** Rule 16: cases that failed once and passed on their one rerun; the GREEN is reusable and carries their names. */
  flaky_cases?: string[];
  /** Dispatched screens only: the purpose, the refs/pull/<n>/merge commit it tested, and the screen policy. */
  purpose?: 'screen';
  tested_sha?: string;
  screen_policy?: ScreenPolicy;
}

export type ScreenPolicy = 'narrow' | 'broad';
/** What a run is for: train and bisect runs never bind a verdict and are never reused. */
export type RunPurpose = 'pr' | 'screen' | 'train' | 'bisect' | 'dispatch';

export interface GateReuse {
  schema: 1;
  kind: 'restamp-only' | 'main-moved';
  pr: number;
  reused_run_id: number;
  reused_run_attempt: number;
  gated_head: string;
  current_head: string;
  gated_base: string;
  base_sha: string;
  selection_sha256: string;
  /** One sentence: why this head may carry that verdict. */
  why: string;
  /** restamp-only: the tree receipt. */
  receipt_sha256?: string;
  stamp_files?: string[];
  old_version?: string | null;
  new_version?: string | null;
  /** main-moved: the merge-bases and the identical own-diff signature. */
  gated_merge_base?: string;
  merge_base?: string;
  own_diff_sha256?: string;
  /** The reused run was a dispatched screen with this policy. */
  reused_screen_policy?: ScreenPolicy;
  /** The reused GREEN was flaky-annotated (rule 16): these cases failed once and passed on their one rerun. */
  reused_flaky?: string[];
}

/** The cases, trial plans and verdict-relevant plan fields a run executes; slice packing and receipts are excluded. */
export function selectionFingerprint(manifest: PaidRunManifest): string {
  const entries = manifest.entries
    .map(entry => ({ file: entry.file, status: entry.status, trial: entry.trial ?? null, excludeCases: entry.excludeCases ?? null }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const body = { tier: manifest.tier, evalsAll: manifest.evalsAll, profile: manifest.profile ?? null, selection: manifest.selection ?? null,
    mode: manifest.prCoverage?.mode ?? null, entries };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

export function parseBinding(value: unknown): GateBinding | null {
  const b = value as GateBinding | null;
  if (!b || b.schema !== 1 || typeof b.repository !== 'string' || !Number.isSafeInteger(b.pr) || !Number.isSafeInteger(b.run_id)
    || !Number.isSafeInteger(b.run_attempt) || !SHA.test(b.head_sha ?? '') || !SHA.test(b.base_sha ?? '') || typeof b.profile !== 'string'
    || !Number.isSafeInteger(b.reconcile_exit) || typeof b.verdict !== 'string' || !Number.isSafeInteger(b.manual_accepted) || b.manual_accepted < 0 || !SHA256.test(b.selection_sha256 ?? '')) return null;
  if (b.flaky_cases !== undefined && (!Array.isArray(b.flaky_cases) || b.flaky_cases.some(id => typeof id !== 'string' || !id))) return null;
  if (b.purpose !== undefined && (b.purpose !== 'screen' || !SHA.test(b.tested_sha ?? '') || (b.screen_policy !== 'narrow' && b.screen_policy !== 'broad'))) return null;
  return b;
}

export function parseReuse(value: unknown): GateReuse | null {
  const r = value as GateReuse | null;
  if (!r || r.schema !== 1 || !Number.isSafeInteger(r.pr) || !Number.isSafeInteger(r.reused_run_id) || !Number.isSafeInteger(r.reused_run_attempt)
    || !SHA.test(r.gated_head ?? '') || !SHA.test(r.current_head ?? '') || r.gated_head === r.current_head
    || !SHA.test(r.gated_base ?? '') || !SHA.test(r.base_sha ?? '') || !SHA256.test(r.selection_sha256 ?? '') || typeof r.why !== 'string') return null;
  if (r.kind === 'restamp-only') {
    return r.gated_base === r.base_sha && SHA256.test(r.receipt_sha256 ?? '') && Array.isArray(r.stamp_files) && r.stamp_files.length > 0 ? r : null;
  }
  if (r.kind === 'main-moved') {
    return r.gated_base !== r.base_sha && SHA.test(r.gated_merge_base ?? '') && SHA.test(r.merge_base ?? '') && SHA256.test(r.own_diff_sha256 ?? '') ? r : null;
  }
  return null;
}

type Git = (args: string[]) => { ok: boolean; out: string };
const gitIn = (cwd: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? { ok: true, out: r.stdout ?? '' } : { ok: false, out: (r.stderr || String(r.error ?? '')).trim() };
};

/** A merge commit's parents from its own object, so a depth-1 checkout can read them. */
export function commitParents(git: Git, commit: string): string[] | null {
  const shown = git(['cat-file', '-p', commit]);
  if (!shown.ok) return null;
  return shown.out.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7).trim());
}

/** The tested commit of a pull_request run is the merge of the head into the base; returns that base. */
export function testedBase(git: Git, tested: string, head: string): { base: string } | { error: string } {
  const parents = commitParents(git, tested);
  if (!parents) return { error: `the tested commit ${tested.slice(0, 12)} is not readable` };
  if (parents.length !== 2 || parents[1] !== head || !SHA.test(parents[0]!)) {
    return { error: `the tested commit ${tested.slice(0, 12)} is not the merge of ${head.slice(0, 12)} into a base` };
  }
  return { base: parents[0]! };
}

/** The files whose differences count as stamps under the base's policy. */
function stampSet(policy: ShipPolicy): { version: string; changelog: string | null; releaseOutputs: string[]; patterns: string[] } {
  return { version: 'VERSION', changelog: policy.changelog ?? null, releaseOutputs: policy.release_outputs, patterns: policy.stamp_patterns };
}

/** A version or [Unreleased] heading, which a restamp rewrites; any other heading is content. */
const STAMP_HEADING = /^## \[(?:Unreleased|\d+(?:\.\d+)+)\](?: - \d{4}-\d{2}-\d{2})?\s*$/;

/** The CHANGELOG as its preamble and the multiset of its sections, each without a stamp heading. */
function changelogParts(text: string | null): { preamble: string; sections: string[] } {
  if (text === null) return { preamble: '\u0000missing', sections: [] };
  const chunks: string[][] = [[]];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) chunks.push([]);
    chunks[chunks.length - 1]!.push(line);
  }
  const [preamble, ...sections] = chunks;
  return { preamble: preamble!.join('\n'), sections: sections.map(lines => (STAMP_HEADING.test(lines[0]!) ? lines.slice(1) : lines).join('\n').replace(/\n+$/, '')) };
}

/**
 * The PR's own diff from its merge-base with stamps taken out. Every changed
 * path that is not a stamp file contributes its full binary patch (pre-image
 * blob ids included, so a file main also changed under the PR is a
 * difference). Stamp files contribute everything except the stamp: the root
 * package.json without its version, each release output with its revision's
 * version replaced (its pre-image too, when anything else changed), and the
 * CHANGELOG's preamble plus the sections the PR added and removed, with only
 * version or [Unreleased] headings dropped. The version file is the stamp.
 */
export function ownDiffSignature(git: Git, mergeBase: string, head: string, stamps: ReturnType<typeof stampSet>): { sha256: string } | { error: string } {
  const names = git(['diff', '--name-only', '-z', '--no-renames', mergeBase, head]);
  if (!names.ok) return { error: `git diff ${mergeBase.slice(0, 12)} ${head.slice(0, 12)} failed (${names.out.split('\n')[0]})` };
  const changed = names.out.split('\u0000').filter(Boolean);
  const isRelease = (file: string) => matchesAny(stamps.releaseOutputs, file);
  const others = changed.filter(file => file !== stamps.version && file !== 'package.json' && file !== stamps.changelog && !isRelease(file));
  let patch = '';
  if (others.length) {
    const r = git(['diff', '--no-ext-diff', '--no-renames', '--no-color', '--binary', '--full-index', mergeBase, head, '--', ...others.map(file => `:(literal)${file}`)]);
    if (!r.ok) return { error: `git diff ${mergeBase.slice(0, 12)} ${head.slice(0, 12)} failed (${r.out.split('\n')[0]})` };
    patch = r.out;
  }
  const stampPaths = changed.filter(file => !others.includes(file));
  let modes: string[] = [];
  if (stampPaths.length) {
    const raw = git(['diff', '--raw', '-z', '--no-renames', mergeBase, head, '--', ...stampPaths.map(file => `:(literal)${file}`)]);
    if (!raw.ok) return { error: `git diff --raw ${mergeBase.slice(0, 12)} ${head.slice(0, 12)} failed (${raw.out.split('\n')[0]})` };
    const fields = raw.out.split('\u0000');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [oldMode, newMode] = fields[i]!.replace(/^:/, '').split(' ');
      if (oldMode !== newMode) modes.push(`${fields[i + 1]} ${oldMode} ${newMode}`);
    }
    modes = modes.sort();
  }
  const blob = (rev: string, file: string): string | null => {
    const r = git(['show', `${rev}:${file}`]);
    if (r.ok) return r.out;
    const listed = git(['ls-tree', '--name-only', rev, '--', `:(literal)${file}`]);
    if (!listed.ok || listed.out.trim() !== '') throw new Error(`cannot read ${file} at ${rev.slice(0, 12)}`);
    return null;
  };
  const version = (rev: string) => blob(rev, stamps.version)?.trim() || null;
  const unstamped = (rev: string, file: string) => {
    const text = blob(rev, file);
    const v = version(rev);
    return text === null ? null : v ? rewriteStamps(text, v, '\u0000VERSION', stamps.patterns).text : text;
  };
  try {
    const manifest = (text: string | null) => {
      if (text === null) return null;
      try { const parsed = JSON.parse(text); delete parsed.version; return JSON.stringify(parsed); } catch { return text; }
    };
    const [pkgBase, pkgHead] = [manifest(blob(mergeBase, 'package.json')), manifest(blob(head, 'package.json'))];
    const releases = changed.filter(isRelease).sort().flatMap(file => {
      const [before, after] = [unstamped(mergeBase, file), unstamped(head, file)];
      return before === after ? [] : [[file, before, after]];
    });
    let changelog = null;
    if (stamps.changelog && changed.includes(stamps.changelog)) {
      const [before, after] = [changelogParts(blob(mergeBase, stamps.changelog)), changelogParts(blob(head, stamps.changelog))];
      const removed = [...before.sections];
      const added: string[] = [];
      for (const section of after.sections) {
        const i = removed.indexOf(section);
        if (i >= 0) removed.splice(i, 1);
        else added.push(section);
      }
      changelog = { preamble: before.preamble === after.preamble ? null : [before.preamble, after.preamble], added: added.sort(), removed: removed.sort() };
    }
    const body = { patch, modes, package: pkgBase === pkgHead ? null : [pkgBase, pkgHead], releases, changelog };
    return { sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** slices-report: what this executed run proved, or why it binds nothing. */
export function buildBinding(o: { repository: string; pr: number; runId: number; runAttempt: number; headSha: string; baseSha: string | null;
  profile: string; reconcileExit: number; reportDir: string; purpose?: RunPurpose; testedSha?: string; screenPolicy?: string }): { binding: GateBinding | null; reason: string } {
  if (o.purpose && o.purpose !== 'pr' && o.purpose !== 'screen') return { binding: null, reason: `a ${o.purpose} run never binds a verdict for reuse` };
  if (fs.existsSync(path.join(o.reportDir, REUSE_FILE))) return { binding: null, reason: 'this run reused a verdict; only executed gates bind' };
  if (!o.baseSha) return { binding: null, reason: 'the tested base is unknown' };
  const manifest = readJson<PaidRunManifest>(path.join(o.reportDir, 'manifest.json'));
  if (!manifest?.entries) return { binding: null, reason: 'no readable manifest' };
  const outcomes = readJson<{ verdict?: { verdict?: string }; totals?: { manual_accepted?: number }; flaky?: Array<{ case?: string }> }>(path.join(o.reportDir, 'collector-outcomes.json'));
  const flaky = (outcomes?.flaky ?? []).map(record => record.case ?? '');
  const binding: GateBinding = { schema: 1, repository: o.repository, pr: o.pr, run_id: o.runId, run_attempt: o.runAttempt,
    head_sha: o.headSha, base_sha: o.baseSha, profile: o.profile, reconcile_exit: o.reconcileExit,
    verdict: outcomes?.verdict?.verdict ?? 'MISSING', manual_accepted: outcomes?.totals?.manual_accepted ?? -1, selection_sha256: selectionFingerprint(manifest),
    ...(flaky.length ? { flaky_cases: flaky } : {}),
    ...(o.purpose === 'screen' ? { purpose: 'screen' as const, tested_sha: o.testedSha ?? '', screen_policy: o.screenPolicy as ScreenPolicy } : {}) };
  return parseBinding(binding)
    ? { binding, reason: `bound ${binding.verdict}${binding.flaky_cases ? ` (flaky: ${binding.flaky_cases.join(', ')})` : ''} at ${binding.head_sha.slice(0, 12)} on base ${binding.base_sha.slice(0, 12)} (reconcile exit ${binding.reconcile_exit})` }
    : { binding: null, reason: 'binding fields are incomplete' };
}

/**
 * A newer completed run with no binding is passed over only when no paid
 * slice of it ran: superseded, readiness-blocked, a reuse, or cancelled
 * before its slice step started. A slice that finished (success, failure,
 * timed out) without a bound verdict blocks reuse of an older GREEN, and so
 * does a slice cancelled after its slice step started (killed before its
 * upload step: its paid results are unknown, so it counts as incomplete), so a
 * newer red, partial or unknown result is never skipped.
 */
export function unboundRunVerdict(gh: GhRunner, repo: string, run: WorkflowRun, timeoutMs: number): string | null {
  const listed = gh(['api', '-X', 'GET', `repos/${repo}/actions/runs/${run.id}/jobs`, '-f', 'filter=latest', '-f', 'per_page=100'], timeoutMs);
  if (listed.status !== 0) return `cannot list run ${run.id}'s jobs (${ghFailureReason(listed.stderr)})`;
  type Job = { name: string; conclusion: string | null; steps?: Array<{ name: string; status?: string; conclusion?: string | null }> };
  let slices: Job[];
  try {
    slices = ((JSON.parse(listed.stdout).jobs ?? []) as Job[]).filter(job => job.name === 'eval-slices' || job.name.startsWith('eval-slices '));
  } catch { return `run ${run.id}'s job list is unreadable`; }
  const finished = slices.find(job => job.conclusion !== null && job.conclusion !== 'skipped' && job.conclusion !== 'cancelled');
  if (finished) return `newer run ${run.id} (${run.head_sha.slice(0, 12)}) finished a paid slice (${finished.conclusion}) but bound no verdict (conclusion ${run.conclusion})`;
  const killed = slices.find(job => job.conclusion === 'cancelled' && (job.steps ?? []).some(step => step.name.startsWith('Run slice')
    && step.status !== 'queued' && step.status !== 'pending' && step.conclusion !== 'skipped'));
  return killed
    ? `newer run ${run.id} (${run.head_sha.slice(0, 12)}) had a paid slice (${killed.name}) killed after its slice step started and before its upload step; its results are unknown, so it counts as incomplete`
    : null;
}

export interface FindOptions {
  repo: string;
  pr: number;
  headRepo: string;
  branch: string;
  selfRunId: number;
  headSha: string;
  /** This run's tested merge commit (github.sha, or a screen's refs/pull/<n>/merge commit); its first parent is the base. */
  testedSha: string;
  /** A dispatched screen: its policy; pull_request runs and earlier screens of this PR are both candidates. */
  screen?: { policy: ScreenPolicy };
  /** A base-ref checkout to fetch into and run the receipt in. */
  repoRoot: string;
  out: string;
  budgetMs?: number;
  maxRuns?: number;
  gh?: GhRunner;
  git?: Git;
  now?: () => number;
}

/** Never throws for an expected refusal: no candidate means the full gate runs, with the reason named. */
export function findReusableGate(o: FindOptions): { candidate: GateReuse | null; lines: string[] } {
  const gh = o.gh ?? runGh;
  const git = o.git ?? gitIn(o.repoRoot);
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? 90_000);
  const left = () => Math.max(1_000, deadline - now());
  const lines: string[] = [];
  const refuse = (reason: string) => { lines.push(`no gate reuse: ${reason}; the full gate runs`); return { candidate: null, lines }; };
  if (!SHA.test(o.headSha) || !SHA.test(o.testedSha)) return refuse('this run has no exact head and tested commit');

  const listed = listGateRuns(gh, { repo: o.repo, pr: o.pr, headRepo: o.headRepo, branch: o.branch, selfRunId: o.selfRunId, screens: !!o.screen }, left);
  if ('error' in listed) return refuse(listed.error);
  const older = listed.runs.filter(run => run.id < o.selfRunId).sort((a, b) => b.id - a.id).slice(0, o.maxRuns ?? 10);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-reuse-'));
  try {
    let found: { run: WorkflowRun; binding: GateBinding | null } | null = null;
    for (const run of older) {
      const names = gh(['api', '-X', 'GET', `repos/${o.repo}/actions/runs/${run.id}/artifacts`, '-f', 'per_page=100'], left());
      if (names.status !== 0) return refuse(`cannot list run ${run.id}'s artifacts (${ghFailureReason(names.stderr)})`);
      let artifact: string | undefined;
      let sliceEvidence: string | undefined;
      try {
        const listedNames = ((JSON.parse(names.stdout).artifacts ?? []) as Array<{ name: string; expired?: boolean }>).map(a => a.name);
        artifact = listedNames.filter(name => /^gate-binding-a\d+$/.test(name)).sort((a, b) => Number(b.slice(14)) - Number(a.slice(14)))[0];
        sliceEvidence = listedNames.find(name => name.startsWith('paid-slice-'));
      } catch { return refuse(`run ${run.id}'s artifact list is unreadable`); }
      if (run.status !== 'completed') return refuse(`newer run ${run.id} (${run.head_sha.slice(0, 12)}) is still ${run.status}`);
      if (!artifact) {
        if (sliceEvidence) return refuse(`newer run ${run.id} (${run.head_sha.slice(0, 12)}) holds paid slice results (${sliceEvidence}) but bound no verdict`);
        const unbound = unboundRunVerdict(gh, o.repo, run, left());
        if (unbound) return refuse(unbound);
        continue;
      }
      const dir = path.join(work, String(run.id));
      const got = gh(['run', 'download', String(run.id), '-R', o.repo, '-n', artifact, '-D', dir], left());
      if (got.status !== 0) return refuse(`cannot download ${artifact} of run ${run.id} (${ghFailureReason(got.stderr)})`);
      found = { run, binding: parseBinding(readJson(path.join(dir, BINDING_FILE))) };
      break;
    }
    if (!found) return refuse('no earlier executed gate on this PR bound a verdict');
    const { run, binding } = found;
    if (!binding) return refuse(`run ${run.id}'s gate binding is missing or malformed`);
    const screenRun = run.event === 'workflow_dispatch';
    if (binding.run_id !== run.id || binding.pr !== o.pr || binding.repository !== o.repo
      || (screenRun ? binding.purpose !== 'screen' : binding.head_sha !== run.head_sha || binding.purpose !== undefined)) {
      return refuse(`run ${run.id}'s gate binding does not match the run it came from`);
    }
    const boundPolicy = binding.screen_policy ?? 'broad';
    if (o.screen && boundPolicy !== o.screen.policy) {
      return refuse(`run ${run.id} gated the ${boundPolicy} selection; a ${o.screen.policy} screen never adopts it`);
    }
    if (run.conclusion !== 'success' || binding.verdict !== 'GREEN' || binding.reconcile_exit !== 0) {
      return refuse(`the newest executed gate (run ${run.id}, ${binding.head_sha.slice(0, 12)}) is ${binding.verdict}, reconcile exit ${binding.reconcile_exit}, conclusion ${run.conclusion}`);
    }
    if (binding.manual_accepted !== 0) {
      return refuse(`run ${run.id}'s GREEN includes ${binding.manual_accepted} manually accepted (unscored) case(s), which reuse would present as a clean pass`);
    }
    if (binding.profile !== 'pr') return refuse(`run ${run.id} ran the ${binding.profile} profile, not the PR gate`);
    if (binding.head_sha === o.headSha) return refuse(`run ${run.id} gated this same head; a re-run executes fresh`);

    if (screenRun) {
      const commits = gh(['api', `repos/${o.repo}/pulls/${o.pr}/commits`, '--paginate', '--jq', '.[].sha'], left());
      if (commits.status !== 0) return refuse(`cannot list PR #${o.pr}'s commits (${ghFailureReason(commits.stderr)})`);
      if (!commits.stdout.split('\n').includes(binding.head_sha)) return refuse(`screen run ${run.id}'s head ${binding.head_sha.slice(0, 12)} is not a commit of PR #${o.pr}`);
    }
    const fetched = git(['fetch', '--no-tags', '--depth=1', 'origin', binding.head_sha, o.headSha, o.testedSha, ...(binding.tested_sha ? [binding.tested_sha] : [])]);
    if (!fetched.ok) return refuse(`cannot fetch the gated and current commits (${fetched.out.split('\n')[0]})`);
    if (screenRun) {
      const gatedBase = testedBase(git, binding.tested_sha!, binding.head_sha);
      if ('error' in gatedBase || gatedBase.base !== binding.base_sha) return refuse(`screen run ${run.id}'s tested commit does not merge its head into its bound base (${'error' in gatedBase ? gatedBase.error : gatedBase.base.slice(0, 12)})`);
    }
    const tested = testedBase(git, o.testedSha, o.headSha);
    if ('error' in tested) return refuse(tested.error);
    const baseSha = tested.base;
    const fetchedBase = git(['fetch', '--no-tags', '--depth=1', 'origin', baseSha]);
    const pinned = fetchedBase.ok && git(['update-ref', 'refs/remotes/origin/gate-reuse-base', baseSha]).ok;
    if (!pinned) return refuse(`cannot pin this run's base ${baseSha.slice(0, 12)} for the policy`);
    const policy = loadPolicyFromBase(o.repoRoot, 'gate-reuse-base');
    if (isUnavailable(policy)) return refuse(`the base's ship policy is unavailable (${policy.detail})`);
    if (policy.errors.length) return refuse(`the base's ship policy is invalid (${policy.errors[0]!.message})`);
    const common = { schema: 1 as const, pr: o.pr, reused_run_id: run.id, reused_run_attempt: binding.run_attempt, gated_head: binding.head_sha,
      current_head: o.headSha, gated_base: binding.base_sha, base_sha: baseSha, selection_sha256: binding.selection_sha256,
      ...(binding.screen_policy ? { reused_screen_policy: binding.screen_policy } : {}),
      ...(binding.flaky_cases?.length ? { reused_flaky: binding.flaky_cases } : {}) };

    let candidate: GateReuse;
    if (binding.base_sha === baseSha) {
      const receipt = buildReceipt({ repoRoot: o.repoRoot, gated: binding.head_sha, current: o.headSha, policy: policy.policy, policyLabel: policy.source.label });
      if ('error' in receipt) return refuse(`no tree receipt: ${receipt.error}`);
      lines.push(`TREE: ${receipt.tree === 'changed' ? `changed (${receipt.residual.join(', ')})` : 'same-modulo-stamps'} (${binding.head_sha.slice(0, 12)} -> ${o.headSha.slice(0, 12)}, policy ${receipt.policy})`);
      if (receipt.tree !== 'same-modulo-stamps') return refuse(`${o.headSha.slice(0, 12)} differs from the gated head beyond stamps: ${receipt.residual.join(', ')}`);
      const stampFiles = receipt.files.map(file => file.path);
      const stamps = stampSet(policy.policy);
      const allowed = new Set([stamps.version, 'package.json', ...(stamps.changelog ? [stamps.changelog] : []), ...stamps.releaseOutputs]);
      const outside = stampFiles.filter(file => !allowed.has(file));
      if (outside.length) return refuse(`stamp-classified files outside the version file, package.json, CHANGELOG and release outputs: ${outside.join(', ')}`);
      if (!stampFiles.length) return refuse('the heads differ by no stamp file');
      candidate = { ...common, kind: 'restamp-only', receipt_sha256: receiptDigest(receipt), stamp_files: stampFiles,
        old_version: receipt.old_version, new_version: receipt.new_version,
        why: `main has not moved (base ${baseSha.slice(0, 12)}) and ${o.headSha.slice(0, 12)} differs from ${binding.head_sha.slice(0, 12)} only by stamp files (${stampFiles.join(', ')}): TREE same-modulo-stamps` };
    } else {
      const mergeBase = (base: string, head: string) => {
        const r = gh(['api', `repos/${o.repo}/compare/${base}...${head}`, '--jq', '.merge_base_commit.sha'], left());
        const sha = r.stdout.trim();
        return r.status === 0 && SHA.test(sha) ? sha : null;
      };
      const [gatedMb, currentMb] = [mergeBase(binding.base_sha, binding.head_sha), mergeBase(baseSha, o.headSha)];
      if (!gatedMb || !currentMb) return refuse('a merge-base is unavailable, so the own diffs cannot be compared');
      const fetchedMb = git(['fetch', '--no-tags', '--depth=1', 'origin', gatedMb, currentMb]);
      if (!fetchedMb.ok) return refuse(`cannot fetch the merge-bases (${fetchedMb.out.split('\n')[0]})`);
      const stamps = stampSet(policy.policy);
      const [gatedDiff, currentDiff] = [ownDiffSignature(git, gatedMb, binding.head_sha, stamps), ownDiffSignature(git, currentMb, o.headSha, stamps)];
      if ('error' in gatedDiff) return refuse(gatedDiff.error);
      if ('error' in currentDiff) return refuse(currentDiff.error);
      lines.push(`OWN DIFF: ${gatedDiff.sha256 === currentDiff.sha256 ? 'identical' : 'changed'} (${binding.head_sha.slice(0, 12)} from ${gatedMb.slice(0, 12)}: ${gatedDiff.sha256.slice(0, 12)}; ${o.headSha.slice(0, 12)} from ${currentMb.slice(0, 12)}: ${currentDiff.sha256.slice(0, 12)})`);
      if (gatedDiff.sha256 !== currentDiff.sha256) return refuse(`the PR's own diff (excluding stamp files) differs from the gated head's`);
      candidate = { ...common, kind: 'main-moved', gated_merge_base: gatedMb, merge_base: currentMb, own_diff_sha256: currentDiff.sha256,
        why: `main moved (${binding.base_sha.slice(0, 12)} -> ${baseSha.slice(0, 12)}) and the PR's own diff from its merge-base, excluding stamp files, is byte-identical to ${binding.head_sha.slice(0, 12)}'s (sha256 ${currentDiff.sha256.slice(0, 12)})` };
    }
    fs.mkdirSync(o.out, { recursive: true });
    fs.writeFileSync(path.join(o.out, CANDIDATE_FILE), `${JSON.stringify(candidate, null, 2)}\n`);
    lines.push(`${candidate.kind} candidate: run ${run.id} passed the full gate at ${binding.head_sha.slice(0, 12)}; ${candidate.why}; plan-slices confirms the selection`);
    return { candidate, lines };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** plan-slices: the reuse holds only when this head's own plan selects exactly what the reused gate ran. */
export function confirmReuse(candidateDir: string, manifest: PaidRunManifest | null): { reuse: GateReuse | null; reason: string } {
  const candidate = parseReuse(readJson(path.join(candidateDir, CANDIDATE_FILE)));
  if (!candidate) return { reuse: null, reason: 'no reuse candidate; the full gate runs' };
  if (!manifest?.entries) return { reuse: null, reason: 'this run has no readable plan; the full gate runs' };
  const fingerprint = selectionFingerprint(manifest);
  if (fingerprint !== candidate.selection_sha256) {
    return { reuse: null, reason: `this head's selection ${fingerprint.slice(0, 12)} differs from the reused gate's ${candidate.selection_sha256.slice(0, 12)}; the full gate runs` };
  }
  return { reuse: candidate, reason: `reusing run ${candidate.reused_run_id}'s GREEN verdict at ${candidate.gated_head.slice(0, 12)} (${candidate.kind}): ${candidate.why}; same selection ${fingerprint.slice(0, 12)}` };
}

export function reuseReport(reuse: GateReuse, repo: string): string {
  const evidence = reuse.kind === 'restamp-only'
    ? [`TREE: same-modulo-stamps receipt=${reuse.receipt_sha256}`, `stamp files: ${reuse.stamp_files!.join(', ')} (${reuse.old_version ?? '-'} -> ${reuse.new_version ?? '-'})`]
    : [`OWN DIFF: identical sha256=${reuse.own_diff_sha256} (merge-base ${reuse.gated_merge_base} -> ${reuse.merge_base}; stamp files excluded)`];
  return [
    `GATE REUSED (${reuse.kind === 'restamp-only' ? 'R2a, restamp-only' : 'R2, main moved'}): no paid case ran on ${reuse.current_head}`,
    `reused verdict: GREEN from run ${reuse.reused_run_id} attempt ${reuse.reused_run_attempt}${reuse.reused_screen_policy ? ` (a ${reuse.reused_screen_policy} screen)` : ''} at ${reuse.gated_head} (https://github.com/${repo}/actions/runs/${reuse.reused_run_id})`,
    `why: ${reuse.why}`,
    ...(reuse.reused_flaky?.length ? [`flaky (rule 16): ${reuse.reused_flaky.join(', ')} failed once and passed on their one rerun in the reused gate`] : []),
    `base: ${reuse.gated_base} -> ${reuse.base_sha}`,
    ...evidence,
    `selection: ${reuse.selection_sha256} (identical to the reused gate)`,
    'cost: $0 (no trials executed)',
  ].join('\n');
}

const USAGE = `usage:
  bun run crew/scripts/gate-reuse.ts bind <report dir> --out <dir> --repo <owner/name> --pr <n> --run-id <id> --run-attempt <n>
      --head-sha <sha> --tested-sha <merge sha> --profile <pr|full> --reconcile-exit <n> [--purpose pr|screen|train|bisect|dispatch]
      [--screen-policy narrow|broad]
  bun run crew/scripts/gate-reuse.ts find --repo <owner/name> --pr <n> --head-repo <owner/name> --branch <head branch> --run-id <id>
      --head-sha <sha> --tested-sha <merge sha> --out <dir> [--screen-policy narrow|broad] [--budget-seconds 90]
--screen-policy marks a dispatched screen (its tested sha is the pinned refs/pull/<n>/merge commit).
  bun run crew/scripts/gate-reuse.ts confirm <candidate dir> <manifest.json> --out <paid-plan dir> [--github-output <file>]
  bun run crew/scripts/gate-reuse.ts report <gate-reuse.json> --repo <owner/name>
bind and find never fail the run; no candidate means the full gate runs.`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const int = (name: string) => Number(flag(name));
  const usage = () => { console.error(USAGE); process.exit(2); };
  if (command === 'bind') {
    const [reportDir, out, repository, headSha, testedSha, profile] = [rest[0], flag('out'), flag('repo'), flag('head-sha'), flag('tested-sha'), flag('profile')];
    if (!reportDir || !out || !repository || !headSha || !testedSha || !profile) usage();
    const git = gitIn(process.cwd());
    if (!commitParents(git, testedSha!)) git(['fetch', '--no-tags', '--depth=1', 'origin', testedSha!]);
    const tested = testedBase(git, testedSha!, headSha!);
    const purpose = (flag('purpose') || 'pr') as RunPurpose;
    if (!['pr', 'screen', 'train', 'bisect', 'dispatch'].includes(purpose) || (purpose === 'screen' && !['narrow', 'broad'].includes(flag('screen-policy') ?? ''))) usage();
    const { binding, reason } = buildBinding({ repository: repository!, pr: int('pr'), runId: int('run-id'), runAttempt: int('run-attempt'),
      headSha: headSha!, baseSha: 'base' in tested ? tested.base : null, profile: profile!,
      reconcileExit: /^\d+$/.test(flag('reconcile-exit') ?? '') ? int('reconcile-exit') : -1, reportDir: reportDir!,
      purpose, testedSha: testedSha!, screenPolicy: flag('screen-policy') });
    if (binding) {
      fs.mkdirSync(out!, { recursive: true });
      fs.writeFileSync(path.join(out!, BINDING_FILE), `${JSON.stringify(binding, null, 2)}\n`);
    }
    console.log(`- Gate binding: ${reason}${'error' in tested ? ` (${tested.error})` : ''}`);
  } else if (command === 'find') {
    const [repo, headRepo, branch, headSha, testedSha, out] = [flag('repo'), flag('head-repo'), flag('branch'), flag('head-sha'), flag('tested-sha'), flag('out')];
    const policy = flag('screen-policy');
    if (!repo || !headRepo || !branch || !headSha || !testedSha || !out || !Number.isSafeInteger(int('pr')) || !Number.isSafeInteger(int('run-id'))
      || (policy !== undefined && policy !== 'narrow' && policy !== 'broad')) usage();
    const { lines } = findReusableGate({ repo: repo!, pr: int('pr'), headRepo: headRepo!, branch: branch!, selfRunId: int('run-id'), headSha: headSha!,
      testedSha: testedSha!, repoRoot: process.cwd(), out: out!, budgetMs: Number(flag('budget-seconds') ?? '90') * 1000,
      ...(policy ? { screen: { policy: policy as ScreenPolicy } } : {}) });
    console.log('### Paid-gate verdict reuse (R2a restamp-only, R2 main moved)');
    for (const line of lines) console.log(`- ${line}`);
  } else if (command === 'confirm') {
    const [dir, manifestPath, out] = [rest[0], rest[1], flag('out')];
    if (!dir || !manifestPath || !out) usage();
    const { reuse, reason } = confirmReuse(dir!, readJson<PaidRunManifest>(manifestPath!));
    if (reuse) {
      fs.mkdirSync(out!, { recursive: true });
      fs.writeFileSync(path.join(out!, REUSE_FILE), `${JSON.stringify(reuse, null, 2)}\n`);
    }
    const output = flag('github-output');
    if (output) fs.appendFileSync(output, `gate_reuse=${reuse ? 'true' : 'false'}\n`);
    console.log(`- Paid-gate verdict reuse: ${reason}`);
  } else if (command === 'report') {
    const reuse = parseReuse(readJson(rest[0] ?? ''));
    const repo = flag('repo');
    if (!reuse || !repo) { console.error('gate-reuse report: the reuse record is missing or malformed; the gate is not green'); process.exit(1); }
    console.log(reuseReport(reuse!, repo!));
  } else usage();
}
