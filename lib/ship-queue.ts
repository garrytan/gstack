/**
 * ship-queue — the shared merge queue's protocol steps (field list 2, W1),
 * behind bin/gstack-ship-queue. gstack-restamp stays the primitive; this
 * module strings it together with gstack-tree-receipt and the ship receipt
 * so every step ends in a line a coordinator can act on:
 *
 *   ready       READY #<pr> <head> STAMP_VERSION=<X|unstamped> plus head, base,
 *               CI at that exact head, the PREGATE line, the gate state and the
 *               /ship receipt; refused when the tree is not the pushed PR head
 *               or the PR body carries no receipt for it (QUEUE_RECEIPT_*).
 *               A pregate record missing from this checkout, unreadable,
 *               recorded for another tree, or current but still waiting on a
 *               remote receipt, is looked up by the current tree under
 *               <state root>/pregate/by-tree/ (gstack-pregate mirrors every
 *               record there), and the PREGATE line says where it came from;
 *               a record whose own checks failed or stayed incomplete stands.
 *   stamp       preflight (gated head equals HEAD modulo stamps, base, policy,
 *               gate record under full_e2e), restamp, commit, tree receipt,
 *               each stage journaled; QUEUE_STAMP: <pr> <version> head= gated=
 *               tree=same-modulo-stamps receipt=<sha256>. An identical retry
 *               resumes or returns the stored outcome. Never pushes.
 *   verify      the coordinator's check: fetch the PR head, rerun the tree
 *               receipt there (and for a gate-ahead record, recompute the
 *               merge with git merge-tree and rebuild the gated tree from the
 *               recorded stamp patch), so QUEUE_STAMP is never a pasted claim.
 *   gate-ahead  lib/ship-queue-gate.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PregateFile } from './headless-artifacts';
import { CHECKS, pregateMirrorPath, readPregateFile, verifyPregate, PREGATE_OUT_REL } from './pregate/index';
import { ensureTmpExcluded, restamp, versionAtRef } from './restamp';
import type { ResultCodeName } from './result-codes';
import { extractReceipt } from './ship-receipt';
import { bindShippedReceipt } from './ship-receipt-depth';
import { isUnavailable, loadPolicyFromBase, type LoadedPolicy } from './ship-policy';
import {
  QUEUE_DIR_REL, applyStampPatch, commitForTree, currentAttempt, git, listAttempts, recomputeMergeTree, sha256, writeJsonAtomic,
  type AttemptRecord, type QueueFailure,
} from './ship-queue-gate';
import { wtreeFingerprint } from './script-invocation';
import { nowIso, persist, readyPath, repoIdentity } from './ship-queue-train-record';
import { buildReceipt, type TreeReceipt } from './tree-receipt';

export type Gh = (args: string[]) => { ok: boolean; out: string; err?: string };
export interface QueueContext { repoRoot: string; base: string; gh: Gh; remote?: string }
export interface StepOutput { ok: boolean; lines: string[]; failure?: QueueFailure; run: string }

const fail = (failure: QueueFailure, lines: string[], run: string): StepOutput => ({ ok: false, lines, failure, run });

export function loadBasePolicy(ctx: QueueContext): LoadedPolicy | QueueFailure {
  const loaded = loadPolicyFromBase(ctx.repoRoot, ctx.base);
  if (isUnavailable(loaded)) return { code: 'POLICY_SOURCE_UNAVAILABLE', message: `policy source unavailable (${loaded.detail})`, fix: `git fetch origin ${ctx.base} --depth=1` };
  if (loaded.errors.length) return { code: loaded.errors[0]!.code, message: `${loaded.source.label}: ${loaded.errors[0]!.message} at ${loaded.errors[0]!.path}` };
  return loaded;
}

/**
 * The receipt's portable digest: the trees, versions, per-file verdicts and
 * stamp diff, never a commit id or the machine identity, so the lane's
 * QUEUE_STAMP and the coordinator's verify agree exactly when the trees do.
 */
export function receiptDigest(r: TreeReceipt): string {
  const files = [...r.files].sort((a, b) => a.path.localeCompare(b.path)).map(f => ({ path: f.path, rule: f.rule, verdict: f.verdict }));
  return sha256(JSON.stringify({ gated_tree: r.gated_tree, current_tree: r.current_tree, old_version: r.old_version, new_version: r.new_version, files, tree: r.tree, stamp_diff: r.stamp_diff }));
}

function treeReceipt(ctx: QueueContext, policy: LoadedPolicy, gated: string, current: string): TreeReceipt | QueueFailure {
  const r = buildReceipt({ repoRoot: ctx.repoRoot, gated, current, policy: policy.policy, policyLabel: policy.source.label });
  return 'error' in r ? { code: 'QUEUE_PROOF_MISSING', message: r.error } : r;
}

/**
 * The heads a READY accepts a /ship receipt for: HEAD, plus the receipt's own
 * head when HEAD is that commit with only stamp files changed on top (the
 * slot's stamp commit, docs/ship-policy.md#ship-before-ready), or, from slot
 * 2 on, the stamp over a merge of the base into it: /ship ran on the pin, the
 * stamp changes nothing it checked, and verify --train binds the same pair
 * against the train's own prefix. A merge with no stamp on top is a lane's
 * own push (rule 14), so it reruns /ship like any other head. Any other
 * receipt head stays QUEUE_RECEIPT_STALE.
 */
function acceptedReceiptHeads(ctx: QueueContext, policy: LoadedPolicy, head: string, body: string): string[] {
  const ex = extractReceipt(body);
  const r = ex.receipt;
  if (!r || ex.errors.length || typeof r.head !== 'string' || !/^[0-9a-f]{12,64}$/i.test(r.head) || head.startsWith(r.head)) return [head];
  const root = ctx.repoRoot;
  const full = git(root, ['rev-parse', '--verify', '--quiet', `${r.head}^{commit}`]);
  if (!full.ok || !git(root, ['merge-base', '--is-ancestor', full.out, head]).ok) return [head];
  const stampOnly = (from: string, to: string) => { const t = from === to ? null : treeReceipt(ctx, policy, from, to); return !t || (!('message' in t) && t.tree === 'same-modulo-stamps'); };
  if (stampOnly(full.out, head)) return [full.out, head];
  const baseSha = git(root, ['rev-parse', `origin/${ctx.base}`]).out;
  const onBase = (sha: string) => !!sha && git(root, ['merge-base', '--is-ancestor', sha, baseSha]).ok;
  const merge = git(root, ['rev-parse', '--verify', '--quiet', `${head}^1`]).out;
  const stamp = merge && merge !== head ? treeReceipt(ctx, policy, merge, head) : null;
  if (!stamp || 'message' in stamp || stamp.tree !== 'same-modulo-stamps' || stamp.files.length === 0) return [head];
  const parents = git(root, ['rev-list', '--parents', '-n', '1', merge]).out.split(' ').slice(1);
  if (parents.length !== 2) return [head];
  const pinSide = onBase(parents[0]!) ? parents[1]! : onBase(parents[1]!) ? parents[0]! : '';
  if (pinSide && git(root, ['merge-base', '--is-ancestor', full.out, pinSide]).ok && stampOnly(full.out, pinSide)) return [full.out, head];
  return [head];
}

const CI_PAGE = 100;
const CI_MAX_PAGES = 10;

/** Every page of one GitHub list for a commit; anything short of exactly total_count is an error, never a partial answer. */
function readAllPages(ctx: QueueContext, endpoint: string, key: 'check_runs' | 'statuses'): { items: Array<Record<string, unknown>> } | { error: string } {
  const items: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= CI_MAX_PAGES; page++) {
    const r = ctx.gh(['api', `${endpoint}?per_page=${CI_PAGE}&page=${page}`]);
    let body: { total_count?: unknown; [k: string]: unknown } | null = null;
    try { body = r.ok ? JSON.parse(r.out) : null; } catch {}
    const list = body?.[key];
    const total = body?.total_count;
    if (!Array.isArray(list) || typeof total !== 'number') return { error: `${key} page ${page} unreadable (gh: ${(r.err ?? r.out).trim().slice(0, 120) || 'no total_count'})` };
    items.push(...list);
    if (items.length >= total || list.length < CI_PAGE) {
      return items.length === total ? { items } : { error: `${key}: read ${items.length} of total_count=${total}` };
    }
  }
  return { error: `${key}: more than ${CI_PAGE * CI_MAX_PAGES} entries, not all read` };
}

/**
 * The latest run per check, the way GitHub's rollup counts: a check that was
 * re-run or superseded (a cancelled run beside a later pass of the same name on
 * the same commit, from a second workflow run) is judged by its newest run
 * alone. A check is one app's check name, so two apps that both report "build"
 * stay separate. Newest is the latest completed_at, then the highest id; a run
 * still in progress is newer than any finished one. A run with no name, or a
 * completed run with no readable completed_at, is never collapsed and counts on
 * its own (fail closed).
 */
export function latestRunPerName<T extends { name?: unknown; id?: unknown; status?: unknown; completed_at?: unknown; app?: unknown }>(runs: T[]): T[] {
  const latest = new Map<string, T>();
  const standalone: T[] = [];
  const rank = (r: T) => (r.status !== 'completed' ? Infinity : typeof r.completed_at === 'string' ? Date.parse(r.completed_at) : NaN);
  const id = (r: T) => (typeof r.id === 'number' ? r.id : Number(r.id) || 0);
  for (const r of runs) {
    const app = (r.app as { id?: unknown } | null | undefined)?.id;
    if (typeof r.name !== 'string' || !r.name || Number.isNaN(rank(r))) { standalone.push(r); continue; }
    const key = `${typeof app === 'number' || typeof app === 'string' ? app : ''}\0${r.name}`;
    const have = latest.get(key);
    if (!have || rank(r) > rank(have) || (rank(r) === rank(have) && id(r) > id(have))) latest.set(key, r);
  }
  return [...latest.values(), ...standalone];
}

/** CI at one exact SHA: the latest check run per name (as GitHub's rollup counts) and every commit-status context; unreadable or incomplete is unknown, never green. */
export function ciAtHead(ctx: QueueContext, sha: string): { line: string; green: boolean; none: boolean; checks: Array<{ name: string; status: string; conclusion: string | null }>; contexts: Array<{ name: string; state: string }> } {
  const at = sha.slice(0, 12);
  const runs = readAllPages(ctx, `repos/{owner}/{repo}/commits/${sha}/check-runs`, 'check_runs');
  if ('error' in runs) return { line: `unknown at ${at} (${runs.error})`, green: false, none: false, checks: [], contexts: [] };
  const statuses = readAllPages(ctx, `repos/{owner}/{repo}/commits/${sha}/status`, 'statuses');
  if ('error' in statuses) return { line: `unknown at ${at} (${statuses.error})`, green: false, none: false, checks: [], contexts: [] };
  const checks = latestRunPerName(runs.items).map(c => ({ name: String(c.name ?? ''), status: String(c.status ?? ''), conclusion: c.conclusion === undefined || c.conclusion === null ? null : String(c.conclusion) }));
  const verdicts = [
    ...checks.map(c => c.status !== 'completed' ? 'pending' : c.conclusion === 'success' ? 'passed' : c.conclusion === 'skipped' || c.conclusion === 'neutral' ? 'skipped' : 'failed'),
    ...statuses.items.map(s => s.state === 'success' ? 'passed' : s.state === 'pending' ? 'pending' : 'failed'),
  ];
  const count = (v: string) => verdicts.filter(x => x === v).length;
  const [passed, failed, pending, skipped] = [count('passed'), count('failed'), count('pending'), count('skipped')];
  const green = verdicts.length > 0 && pending === 0 && failed === 0;
  return { line: `${green ? 'green' : pending ? 'pending' : verdicts.length ? 'red' : 'none'} at ${at} (passed=${passed} failed=${failed} pending=${pending} skipped=${skipped})`, green, none: verdicts.length === 0, checks, contexts: statuses.items.map(s => ({ name: String(s.context ?? ''), state: String(s.state ?? '') })) };
}

/**
 * A PR that conflicts with the base (CHANGELOG-only conflicts included, which
 * the train resolves) has no merge ref, so GitHub runs no pull_request CI on
 * its head. The lane dispatches the free workflows on the branch by hand; their
 * check runs attach to the commit, so ready reads them like any other.
 */
function conflictHint(mergeable: unknown, ci: { green: boolean; none: boolean }, branch: string | undefined, fork: boolean, head: string): string | null {
  if (mergeable !== 'CONFLICTING') return null;
  const ref = branch && /^[\w.][\w./-]*$/.test(branch) ? `--ref ${branch}` : '--ref <branch>';
  if (ci.none && fork) return `ci-hint: PR conflicts with the base (no merge ref, so pull_request CI did not run on ${head.slice(0, 12)}) and its head is on a fork, so the free workflows cannot be dispatched here; the coordinator decides (advisory)`;
  if (ci.none) return `ci-hint: PR conflicts with the base (no merge ref, so pull_request CI did not run on ${head.slice(0, 12)}); dispatch the free workflows on the branch (gh workflow run free-tests.yml ${ref} && gh workflow run windows-free-tests.yml ${ref}), clear the pregate lanes with their run URLs (gstack-pregate clear --remote <lane> --run-url <run>), then rerun ready (advisory)`;
  if (ci.green) return `ci-hint: PR conflicts with the base (no merge ref); the runs at ${head.slice(0, 12)} were not pull_request runs (dispatched on the branch, or push-triggered), and they count (advisory)`;
  return null;
}

/** Under full_e2e: a passing gate bound to this head (the stamp journal, a gate-ahead attempt on it) or the lane's own run on it. */
function gateEvidence(ctx: QueueContext, pr: string, head: string, attempt: AttemptRecord | null, gateExit?: number, gateLog?: string): { ok: boolean; line: string } {
  const j = readJournal(path.join(ctx.repoRoot, stampJournalRel(pr)));
  if (j?.outcome?.head === head && j.gate) return { ok: j.gate.exit === 0, line: `gate-evidence: exit ${j.gate.exit} (${j.gate.source}, stamped onto ${head.slice(0, 12)})` };
  if (attempt?.result && attempt.branch_head === head) return { ok: attempt.result.exit === 0, line: `gate-evidence: exit ${attempt.result.exit} (gate-ahead attempt ${attempt.attempt})` };
  if (gateExit !== undefined && gateLog && fs.existsSync(gateLog)) return { ok: gateExit === 0, line: `gate-evidence: exit ${gateExit} log_sha256=${sha256(fs.readFileSync(gateLog))} (lane run on ${head.slice(0, 12)})` };
  return { ok: false, line: `gate-evidence: missing for ${head.slice(0, 12)} (gate-ahead --record, or --gate-exit 0 --gate-log <file>)` };
}

/**
 * Why a by-tree pregate mirror cannot stand in for this checkout's own
 * record, or null. The mirror is keyed by tree alone, so any pregate run
 * anywhere mints one; what the lane case needs from it is the test tier that
 * `gstack-pregate --stage tests --remote` ran in the clone, so the mirror
 * must hold every tests-stage check (a `--only timing` or preflight-only run
 * is not evidence), be recorded against the same base, and not come from
 * `--policy-from head`.
 */
function mirrorGap(file: PregateFile, base: string): string | null {
  if (!(file.base ?? '').startsWith(`origin/${base}@`)) return `recorded against ${file.base ?? 'no base'}, not origin/${base}`;
  if (file.policy?.startsWith('head ')) return 'recorded under the unreviewed head policy';
  const missing = CHECKS.filter(c => c.stage === 'tests' && !file.checks.some(k => k.id === c.id)).map(c => c.id);
  return missing.length ? `a run without the tests stage (${missing.join(', ')})` : null;
}

function gateLine(policy: LoadedPolicy, attempt: AttemptRecord | null): string {
  const p = policy.policy;
  const rec = attempt ? `attempt=${attempt.attempt} gated_tree=${attempt.gated_tree.slice(0, 12)} ${attempt.result ? `exit=${attempt.result.exit}` : 'not recorded'}` : 'none';
  return `gate: command=${p.gate_command ? JSON.stringify(p.gate_command) : 'none'} full_e2e=${p.full_e2e ? 'yes' : 'no'} gate-ahead=${rec}`;
}

/** READY: one block, identifiers first, about the exact pushed PR head. */
export function ready(ctx: QueueContext, o: { pr: string; pregate?: string; gateExit?: number; gateLog?: string }): StepOutput {
  const run = PREGATE_OUT_REL;
  const policy = loadBasePolicy(ctx);
  if ('message' in policy) return fail(policy, [], run);
  const head = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  const dirty = git(ctx.repoRoot, ['status', '--porcelain', '--untracked-files=no']).out;
  if (dirty) return fail({ code: 'QUEUE_NOT_READY', message: `uncommitted tracked changes: ${dirty.split('\n').map(l => l.slice(3)).slice(0, 8).join(', ')}` }, [], run);
  const view = ctx.gh(['pr', 'view', o.pr, '--json', 'headRefOid,url,body,mergeable,headRefName,isCrossRepository']);
  let info: { headRefOid?: string; url?: string; body?: string; mergeable?: string; headRefName?: string; isCrossRepository?: boolean } = {};
  try { info = view.ok ? JSON.parse(view.out) : {}; } catch {}
  if (!info.headRefOid) return fail({ code: 'QUEUE_NOT_READY', message: `cannot read PR #${o.pr}'s head through gh (${(view.err ?? view.out).trim().slice(0, 120)})` }, [], run);
  if (info.headRefOid !== head) return fail({ code: 'QUEUE_NOT_READY', message: `HEAD ${head.slice(0, 12)} is not PR #${o.pr}'s pushed head ${info.headRefOid.slice(0, 12)}` }, [], run);
  const atHead = versionAtRef(ctx.repoRoot, head);
  const baseSha = git(ctx.repoRoot, ['rev-parse', `origin/${ctx.base}`]).out;
  const atBase = versionAtRef(ctx.repoRoot, baseSha);
  const version = 'version' in atHead && 'version' in atBase && atHead.version !== atBase.version ? atHead.version : 'unstamped';
  const ci = ciAtHead(ctx, head);
  const pregateFile = path.resolve(ctx.repoRoot, o.pregate ?? PREGATE_OUT_REL);
  let pregateLine = `PREGATE: missing (${path.relative(ctx.repoRoot, pregateFile)}; run gstack-pregate run --allow-repo-commands)`;
  let pregateOk = false;
  const treeNow = wtreeFingerprint({ cwd: ctx.repoRoot });
  // The mirror stands in for a record that is missing, unreadable, recorded for another tree, or current but
  // waiting on a remote receipt another checkout holds; a record whose own checks failed or stayed incomplete (the diff's doing
  // or the environment's) is final.
  let useMirror = true;
  if (fs.existsSync(pregateFile)) {
    const read = readPregateFile(pregateFile);
    if (read.file) {
      const v = verifyPregate(ctx.repoRoot, read.file, treeNow);
      pregateOk = v.ok;
      useMirror = !v.ok && v.code !== 'PREGATE_LANE_FAILED' && v.code !== 'PREGATE_INCOMPLETE' && v.code !== 'PREGATE_ENVIRONMENT';
      pregateLine = `PREGATE: ${read.file.verdict} tree=${read.file.tree.slice(0, 12)} head=${(read.file.head ?? '').slice(0, 12)} checks=${read.file.checks.length}${v.ok ? '' : ` — ${v.message} (${v.code})`}`;
    } else pregateLine = `PREGATE: unreadable (${read.errors[0]?.message ?? 'invalid'})`;
  }
  if (useMirror && 'tree' in treeNow) {
    const mirror = pregateMirrorPath(treeNow.tree);
    const read = fs.existsSync(mirror) ? readPregateFile(mirror) : null;
    const gap = read?.file ? mirrorGap(read.file, ctx.base) : null;
    const v = read?.file && !gap ? verifyPregate(ctx.repoRoot, read.file, treeNow) : null;
    if (read?.file && v?.ok) {
      pregateOk = true;
      pregateLine = `PREGATE: ${read.file.verdict} tree=${read.file.tree.slice(0, 12)} head=${(read.file.head ?? '').slice(0, 12)} checks=${read.file.checks.length} (from the state root's pregate/by-tree/${treeNow.tree.slice(0, 12)}.json, recorded by another checkout)`;
    } else if (gap) pregateLine += `; the state root's mirror for this tree cannot stand in: ${gap}`;
  }
  const receipt = bindShippedReceipt(ctx.repoRoot, `origin/${ctx.base}`, info.body ?? '', o.pr, acceptedReceiptHeads(ctx, policy, head, info.body ?? ''));
  const attempt = currentAttempt(ctx.repoRoot, o.pr);
  const hint = conflictHint(info.mergeable, ci, info.headRefName, info.isCrossRepository === true, head);
  const lines = [
    `READY #${o.pr} ${head} STAMP_VERSION=${version}`,
    `pr: ${info.url ?? `#${o.pr}`}`,
    `head: ${head}`,
    `version: ${version}`,
    `base: origin/${ctx.base}@${baseSha}`,
    `ci: ${ci.line}`,
    ...(hint ? [hint] : []),
    pregateLine,
    gateLine(policy, attempt),
    receipt.line,
    ...(receipt.depthLine ? [receipt.depthLine] : []),
  ];
  const gate = policy.policy.full_e2e ? gateEvidence(ctx, o.pr, head, attempt, o.gateExit, o.gateLog) : null;
  if (gate) lines.push(gate.line);
  if (!ci.green) return fail({ code: 'QUEUE_NOT_READY', message: `CI is not green at ${head.slice(0, 12)}: ${ci.line}` }, lines, run);
  if (!pregateOk) return fail({ code: 'QUEUE_NOT_READY', message: `the pregate result is not a current pass: ${pregateLine}` }, lines, run);
  if (gate && !gate.ok) return fail({ code: 'QUEUE_GATE_MISSING', message: `full_e2e is set and no passing gate is bound to ${head.slice(0, 12)}: ${gate.line}` }, lines, run);
  if (!receipt.ok) return fail({ code: receipt.code, message: receipt.message }, lines, run);
  if (!policy.policy.train && policy.policy.changelog_fragments) {
    const repo = repoIdentity(ctx.repoRoot);
    const now = nowIso();
    const p = persist(ctx.repoRoot, [{ schema: 1, kind: 'ready', repo_key: repo.key, pr: o.pr, head, base_sha: baseSha, ready_at: now, screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: now }], { remote: ctx.remote ?? 'origin' });
    lines.push(`READY_RECEIPT: ${readyPath(repo.key, o.pr, head)} (${p.detail})`);
  }
  return { ok: true, lines, run };
}

export interface StampOptions {
  pr: string; version: string; expectGated: string; expectBase: string; expectOrder?: string[]; allowRepoCommands: boolean;
  gateExit?: number; gateLog?: string; failAfter?: string;
}
interface StageRow { name: 'preflight' | 'restamp' | 'commit' | 'receipt'; status: 'done' | 'failed'; detail: string }
interface StampJournal {
  schema_version: 1; key: string; inputs: Record<string, unknown>; start_head: string; files: string[]; stages: StageRow[];
  gate?: { source: string; exit: number; log_sha256?: string }; outcome?: { head: string; gated: string; receipt_sha256: string; line: string; committed: boolean };
}

export function stampJournalRel(pr: string): string { return `${QUEUE_DIR_REL}/stamp-${pr}.json`; }
const stampMessage = (o: StampOptions, base: string) => `v${o.version} chore(release): queue stamp onto ${base} (#${o.pr})`;

function readJournal(file: string): StampJournal | null {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j?.schema_version === 1 ? j : null; } catch { return null; }
}

/** Preflight: nothing is written unless every proof input is present and the tree to stamp is the gated tree modulo stamps. */
function stampPreflight(ctx: QueueContext, o: StampOptions, policy: LoadedPolicy, head: string, gated: string): QueueFailure | { detail: string; gate?: StampJournal['gate'] } {
  if (!/^\d+(\.\d+){2,3}$/.test(o.version)) return { code: 'QUEUE_PROOF_MISSING', message: `--version ${o.version} is not MAJOR.MINOR.PATCH[.MICRO]` };
  const dirty = git(ctx.repoRoot, ['status', '--porcelain', '--untracked-files=no']).out;
  if (dirty) return { code: 'QUEUE_PROOF_MISSING', message: `uncommitted tracked changes (${dirty.split('\n').map(l => l.slice(3)).slice(0, 8).join(', ')}); commit or stash them first` };
  const baseSha = git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `origin/${ctx.base}^{commit}`]).out;
  if (!baseSha) return { code: 'POLICY_SOURCE_UNAVAILABLE', message: `origin/${ctx.base} is not a resolvable commit`, fix: `git fetch origin ${ctx.base}` };
  if (!baseSha.startsWith(o.expectBase)) return { code: 'QUEUE_STALE', message: `base moved: expected ${o.expectBase}, origin/${ctx.base} is ${baseSha}` };
  const pre = treeReceipt(ctx, policy, gated, head);
  if ('message' in pre) return pre;
  if (pre.tree !== 'same-modulo-stamps') return { code: 'QUEUE_PROOF_MISSING', message: `HEAD differs from the gated head ${gated.slice(0, 12)} beyond stamps (${pre.residual.join(', ')}); the gate does not cover this tree, regate first` };
  const attempt = listAttempts(ctx.repoRoot, o.pr).filter(a => a.gated_head === gated && a.result).at(-1);
  let gate: StampJournal['gate'];
  if (attempt?.result) gate = { source: `gate-ahead attempt ${attempt.attempt}`, exit: attempt.result.exit, log_sha256: attempt.result.log_sha256 };
  else if (o.gateExit !== undefined) {
    if (!o.gateLog || !fs.existsSync(o.gateLog)) return { code: 'QUEUE_PROOF_MISSING', message: '--gate-exit needs --gate-log <file> from that run' };
    gate = { source: 'lane run on the gated head', exit: o.gateExit, log_sha256: sha256(fs.readFileSync(o.gateLog)) };
  }
  if (policy.policy.full_e2e && gate?.exit !== 0) {
    return { code: 'QUEUE_GATE_MISSING', message: gate ? `the gate on ${gated.slice(0, 12)} exited ${gate.exit} (${gate.source})` : `no gate result bound to ${gated.slice(0, 12)} (gate-ahead --record, or --gate-exit 0 --gate-log <file>)` };
  }
  return { detail: `gated ${gated.slice(0, 12)} = HEAD modulo stamps; base ${baseSha.slice(0, 12)}${gate ? `; gate exit ${gate.exit} (${gate.source})` : ''}`, gate };
}

/** Commit the restamp's files, or adopt a stamp commit an interrupted run already made. */
function stampCommit(ctx: QueueContext, o: StampOptions, j: StampJournal): QueueFailure | string {
  const head = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  const message = stampMessage(o, ctx.base);
  if (head !== j.start_head) {
    const parent = git(ctx.repoRoot, ['rev-parse', 'HEAD^']).out;
    const subject = git(ctx.repoRoot, ['log', '-1', '--format=%s']).out;
    if (parent === j.start_head && subject === message) return `adopted ${head.slice(0, 12)} (committed before the journal saved)`;
    return { code: 'QUEUE_PROOF_MISSING', message: `HEAD moved from ${j.start_head.slice(0, 12)} to ${head.slice(0, 12)} during the stamp; inspect it, then revert to ${j.start_head.slice(0, 12)} or start over` };
  }
  const changed = git(ctx.repoRoot, ['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter(Boolean).map(l => l.slice(3));
  const expected = new Set(j.files);
  const stray = changed.filter(p => !expected.has(p) && !p.startsWith('.gstack/tmp/'));
  if (stray.length) return { code: 'QUEUE_PROOF_MISSING', message: `the working tree holds edits beyond the restamp's files: ${stray.slice(0, 8).join(', ')}` };
  const add = git(ctx.repoRoot, ['add', '--', ...j.files]);
  const commit = add.ok ? git(ctx.repoRoot, ['commit', '-q', '-m', message, '--', ...j.files]) : add;
  if (!commit.ok) return { code: 'QUEUE_PROOF_MISSING', message: `git commit failed: ${commit.err.slice(0, 200)}` };
  return `committed ${git(ctx.repoRoot, ['rev-parse', 'HEAD']).out.slice(0, 12)} (${j.files.length} file(s))`;
}

/**
 * QUEUE_STAMP: preflight, restamp, commit, receipt, journaled in
 * .gstack/tmp/ship-queue/stamp-<pr>.json. The same inputs resume at the first
 * unfinished stage or return the stored outcome. Never pushes.
 */
export function stamp(ctx: QueueContext, o: StampOptions): StepOutput {
  const run = stampJournalRel(o.pr);
  const file = path.join(ctx.repoRoot, run);
  ensureTmpExcluded(ctx.repoRoot);
  const inputs = { pr: o.pr, version: o.version, expect_gated: o.expectGated, expect_base: o.expectBase, expect_order: o.expectOrder ?? [], base: ctx.base };
  const key = sha256(JSON.stringify(inputs));
  const head0 = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  let j = readJournal(file);
  if (j?.key === key && j.outcome) {
    if (j.outcome.head === head0) return { ok: true, lines: [j.outcome.line, 'note: identical retry; the stored outcome is returned, nothing ran'], run };
    return fail({ code: 'QUEUE_PROOF_MISSING', message: `this stamp completed at ${j.outcome.head.slice(0, 12)} and HEAD is now ${head0.slice(0, 12)}; stamp again with the current inputs` }, [], run);
  }
  if (j && j.key !== key) {
    if (j.stages.some(s => s.name === 'restamp' && s.status === 'done') && !j.outcome) {
      return fail({ code: 'QUEUE_PROOF_MISSING', message: `an earlier stamp with other inputs (${JSON.stringify(j.inputs)}) is unfinished; rerun it identically, or revert its files (${j.files.join(', ') || 'none'}) and delete ${run}` }, [], run);
    }
    j = null;
  }
  const journal: StampJournal = j ?? { schema_version: 1, key, inputs, start_head: head0, files: [], stages: [] };
  const save = () => writeJsonAtomic(file, journal);
  const done = (name: StageRow['name']) => journal.stages.some(s => s.name === name && s.status === 'done');
  const mark = (name: StageRow['name'], status: StageRow['status'], detail: string) => { journal.stages = journal.stages.filter(s => s.name !== name); journal.stages.push({ name, status, detail }); save(); };
  const stopped = (stage: StageRow['name'], failure: QueueFailure): StepOutput => {
    const now = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
    return fail(failure, [`QUEUE_STAMP_REFUSED: ${o.pr} head=${now} committed=${now !== journal.start_head ? `yes ${now}` : 'no'} stage=${stage}`, ...journal.stages.map(s => `stage ${s.name}: ${s.status} (${s.detail})`)], run);
  };
  const refusal = (stage: StageRow['name'], failure: QueueFailure): StepOutput => { mark(stage, 'failed', failure.message); return stopped(stage, failure); };
  const injected = (stage: StageRow['name']) => (o.failAfter === stage ? stopped(stage, { code: 'QUEUE_PROOF_MISSING', message: `injected failure after ${stage}; rerun the identical command to resume` }) : null);
  const policy = loadBasePolicy(ctx);
  if ('message' in policy) return refusal('preflight', policy);
  const gated = git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.expectGated}^{commit}`]).out;
  if (!gated) return refusal('preflight', { code: 'QUEUE_PROOF_MISSING', message: `gated head ${o.expectGated} is not a commit here (fetch it, or name the gate-ahead record's gated_head)` });
  if (!done('preflight')) {
    const pre = stampPreflight(ctx, o, policy, head0, gated);
    if ('message' in pre) return refusal('preflight', pre);
    journal.gate = pre.gate;
    mark('preflight', 'done', pre.detail);
    const stop = injected('preflight');
    if (stop) return stop;
  }
  if (!done('restamp')) {
    const r = restamp({ repoRoot: ctx.repoRoot, base: ctx.base, version: o.version, pr: o.pr, expectBase: o.expectBase, expectOrder: o.expectOrder, policyFrom: 'base', allowRepoCommands: o.allowRepoCommands, dryRun: false });
    if (r.status === 'refused' || r.status === 'failed') return refusal('restamp', { code: r.code ?? 'RESTAMP_CONFLICT', message: r.message ?? r.status, fix: r.recompute ?? r.fix });
    journal.files = r.files ?? [];
    mark('restamp', 'done', `${r.status}: ${r.oldVersion} -> ${r.newVersion}, ${journal.files.length} file(s)`);
    const stop = injected('restamp');
    if (stop) return stop;
  }
  if (!done('commit')) {
    const c = journal.files.length ? stampCommit(ctx, o, journal) : 'nothing to commit (restamp was a noop)';
    if (typeof c !== 'string') return refusal('commit', c);
    mark('commit', 'done', c);
    const stop = injected('commit');
    if (stop) return stop;
  }
  const head = git(ctx.repoRoot, ['rev-parse', 'HEAD']).out;
  const rcpt = treeReceipt(ctx, policy, gated, head);
  if ('message' in rcpt) return refusal('receipt', rcpt);
  if (rcpt.tree !== 'same-modulo-stamps') return refusal('receipt', { code: 'QUEUE_STAMP_NOT_STAMP_ONLY', message: `${head.slice(0, 12)} differs from the gated head beyond stamps: ${rcpt.residual.join(', ')}` });
  if (rcpt.new_version !== o.version) return refusal('receipt', { code: 'QUEUE_PROOF_MISSING', message: `the stamped head carries version ${rcpt.new_version}, not ${o.version}` });
  const digest = receiptDigest(rcpt);
  const receiptFile = path.join(ctx.repoRoot, QUEUE_DIR_REL, `tree-receipt-${o.pr}.json`);
  writeJsonAtomic(receiptFile, rcpt);
  const line = `QUEUE_STAMP: ${o.pr} ${o.version} head=${head} gated=${gated} tree=same-modulo-stamps receipt=${digest}`;
  journal.outcome = { head, gated, receipt_sha256: digest, line, committed: head !== journal.start_head };
  mark('receipt', 'done', `same-modulo-stamps (${rcpt.files.length} stamp file(s))`);
  return {
    ok: true, run,
    lines: [line, ...journal.stages.map(s => `stage ${s.name}: ${s.status} (${s.detail})`), `receipt-file: ${path.relative(ctx.repoRoot, receiptFile)}`,
      `next: push ${head.slice(0, 12)} (this command never pushes), wait for CI on it, then gstack-ship-queue ready --pr ${o.pr}; the coordinator runs gstack-ship-queue verify --pr ${o.pr} --gated ${gated} --receipt ${digest}`],
  };
}

export interface VerifyOptions { pr: string; gated?: string; record?: string; receipt?: string; expectHead?: string; ref?: string; noFetch?: boolean; gateExit?: number; gateLog?: string }

/** Rebuild a gate-ahead record's gated tree from the PR's own commits: merge-tree, then the recorded stamp patch. */
function reproduceGateAhead(ctx: QueueContext, policy: LoadedPolicy, rec: AttemptRecord, head: string): QueueFailure | { gatedCommit: string; lines: string[] } {
  const mismatch = (message: string): QueueFailure => ({ code: 'QUEUE_VERIFY_MISMATCH', message });
  for (const [what, sha] of [['branch head', rec.branch_head], ['predecessor head', rec.predecessor_head]] as const) {
    if (!git(ctx.repoRoot, ['cat-file', '-e', `${sha}^{commit}`]).ok) return { code: 'QUEUE_PROOF_MISSING', message: `the record's ${what} ${sha.slice(0, 12)} is not here after the fetch` };
  }
  const predNow = git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/gstack/queue/pr-${rec.predecessor_pr}`]).out;
  if (predNow && predNow !== rec.predecessor_head) return mismatch(`PREDECESSOR MOVED: #${rec.predecessor_pr} is at ${predNow.slice(0, 12)}, the gate assumed ${rec.predecessor_head.slice(0, 12)}`);
  const at = versionAtRef(ctx.repoRoot, head);
  const merged = recomputeMergeTree(ctx.repoRoot, rec.branch_head, rec.predecessor_head, policy.policy, 'rel' in at ? at.rel : 'VERSION');
  if ('error' in merged) return mismatch(`git merge-tree cannot recompute the gate-ahead merge: ${merged.error}`);
  if (merged.tree !== rec.merge_tree) return mismatch(`git merge-tree gives ${merged.tree.slice(0, 12)}, the record says ${rec.merge_tree.slice(0, 12)}`);
  const gatedTree = applyStampPatch(ctx.repoRoot, merged.tree, rec.stamp_patch);
  if ('error' in gatedTree) return mismatch(gatedTree.error);
  if (gatedTree.tree !== rec.gated_tree) return mismatch(`the merge plus the recorded stamp patch gives ${gatedTree.tree.slice(0, 12)}, not the recorded gated tree ${rec.gated_tree.slice(0, 12)}`);
  const mergeCommit = commitForTree(ctx.repoRoot, merged.tree, `recomputed gate-ahead merge for #${rec.pr}`);
  const gatedCommit = commitForTree(ctx.repoRoot, gatedTree.tree, `recomputed gated tree for #${rec.pr}`);
  if (!mergeCommit || !gatedCommit) return { code: 'QUEUE_PROOF_MISSING', message: 'cannot write the recomputed commits' };
  const stampOnly = treeReceipt(ctx, policy, mergeCommit, gatedCommit);
  if ('message' in stampOnly) return stampOnly;
  if (stampOnly.tree !== 'same-modulo-stamps') return mismatch(`the recorded stamp patch changes more than stamps: ${stampOnly.residual.join(', ')}`);
  if (rec.result && rec.result.exit !== 0) return { code: 'QUEUE_GATE_MISSING', message: `the recorded gate on ${rec.gated_tree.slice(0, 12)} exited ${rec.result.exit}` };
  if (policy.policy.full_e2e && !rec.result) return { code: 'QUEUE_GATE_MISSING', message: `attempt ${rec.attempt} has no recorded gate result` };
  return {
    gatedCommit,
    lines: [
      `merge_tree: ${merged.tree} reproduced by git merge-tree --write-tree ${rec.branch_head.slice(0, 12)} ${rec.predecessor_head.slice(0, 12)} (#${rec.predecessor_pr})`,
      `gated_tree: ${gatedTree.tree} reproduced from the recorded stamp patch (stamps only, ${stampOnly.files.length} file(s))`,
      `gate: ${rec.result ? `exit ${rec.result.exit} log_sha256=${rec.result.log_sha256}` : 'not recorded'} (attempt ${rec.attempt})`,
    ],
  };
}

/** The coordinator's check of a lane's stamp claim, from the PR's pushed commits alone. */
export function verify(ctx: QueueContext, o: VerifyOptions): StepOutput {
  const run = `refs/gstack/queue/pr-${o.pr}`;
  const remote = ctx.remote ?? 'origin';
  let rec: AttemptRecord | null = null;
  if (o.record) {
    try { rec = JSON.parse(fs.readFileSync(o.record, 'utf8')); } catch {}
    if (rec?.kind !== 'gate-ahead' || rec.schema_version !== 1) return fail({ code: 'QUEUE_PROOF_MISSING', message: `${o.record} is not a gate-ahead record` }, [], run);
    if (rec.pr !== o.pr) return fail({ code: 'QUEUE_VERIFY_MISMATCH', message: `the record is for #${rec.pr}, not #${o.pr}` }, [], run);
  }
  if (!o.gated && !rec) return fail({ code: 'QUEUE_PROOF_MISSING', message: 'pass --gated <sha> (the head the gate ran on) or --record <gate-ahead record>' }, [], run);
  if (!o.noFetch) {
    const specs = [`+${o.ref ?? `refs/pull/${o.pr}/head`}:${run}`, `+refs/heads/${ctx.base}:refs/remotes/${remote}/${ctx.base}`];
    if (rec) specs.push(`+refs/pull/${rec.predecessor_pr}/head:refs/gstack/queue/pr-${rec.predecessor_pr}`);
    const f = git(ctx.repoRoot, ['fetch', '--no-tags', '-q', remote, ...specs]);
    if (!f.ok) return fail({ code: 'QUEUE_PROOF_MISSING', message: `git fetch ${remote} failed: ${f.err.slice(0, 200)}` }, [], run);
  }
  const head = git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', run]).out;
  if (!head) return fail({ code: 'QUEUE_PROOF_MISSING', message: `PR #${o.pr}'s head is not fetched (${run})` }, [], run);
  if (o.expectHead && !head.startsWith(o.expectHead)) return fail({ code: 'QUEUE_VERIFY_MISMATCH', message: `PR #${o.pr}'s head is ${head.slice(0, 12)}, the lane reported ${o.expectHead}` }, [], run);
  const policy = loadBasePolicy(ctx);
  if ('message' in policy) return fail(policy, [], run);
  const lines: string[] = [];
  let gatedCommit: string;
  let gatedLabel: string;
  if (rec) {
    if (o.gated && !rec.gated_tree.startsWith(o.gated) && !rec.gated_head.startsWith(o.gated)) return fail({ code: 'QUEUE_VERIFY_MISMATCH', message: `--gated ${o.gated} is neither the record's gated head nor its gated tree` }, [], run);
    const g = reproduceGateAhead(ctx, policy, rec, head);
    if ('message' in g) return fail(g, [], run);
    gatedCommit = g.gatedCommit;
    gatedLabel = rec.gated_head;
    lines.push(...g.lines);
  } else {
    let sha = git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.gated}^{commit}`]).out;
    if (!sha && !o.noFetch) { git(ctx.repoRoot, ['fetch', '--no-tags', '-q', remote, o.gated!]); sha = git(ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.gated}^{commit}`]).out; }
    if (!sha) return fail({ code: 'QUEUE_PROOF_MISSING', message: `gated head ${o.gated} is not reachable from ${remote}; a gate-ahead claim needs --record` }, [], run);
    gatedCommit = sha;
    gatedLabel = sha;
    if (o.gateExit === undefined) {
      if (policy.policy.full_e2e) return fail({ code: 'QUEUE_GATE_MISSING', message: `full_e2e is set and no gate result is bound to the gated head ${sha.slice(0, 12)}; pass the lane's --gate-exit 0 --gate-log <file> from its gate run there, or verify a gate-ahead --record` }, [], run);
      lines.push('gate: not required by the policy');
    } else {
      if (!o.gateLog || !fs.existsSync(o.gateLog) || !fs.statSync(o.gateLog).size) return fail({ code: 'QUEUE_GATE_MISSING', message: `--gate-exit needs --gate-log <file>, the non-empty log of the gate run on ${sha.slice(0, 12)}` }, [], run);
      if (o.gateExit !== 0) return fail({ code: 'QUEUE_GATE_MISSING', message: `the gate on ${sha.slice(0, 12)} exited ${o.gateExit}` }, [], run);
      lines.push(`gate: exit 0 log_sha256=${sha256(fs.readFileSync(o.gateLog))} (lane run on gated ${sha.slice(0, 12)})`);
    }
  }
  const rcpt = treeReceipt(ctx, policy, gatedCommit, head);
  if ('message' in rcpt) return fail(rcpt, lines, run);
  if (rcpt.tree !== 'same-modulo-stamps') return fail({ code: 'QUEUE_VERIFY_MISMATCH', message: `PR #${o.pr}'s head ${head.slice(0, 12)} differs from the gated tree beyond stamps: ${rcpt.residual.join(', ')}` }, lines, run);
  const digest = receiptDigest(rcpt);
  if (o.receipt && digest !== o.receipt) return fail({ code: 'QUEUE_VERIFY_MISMATCH', message: `the receipt digest here is ${digest}, the lane reported ${o.receipt}` }, lines, run);
  return {
    ok: true, run,
    lines: [`VERIFY: ${o.pr} ${rcpt.new_version ?? '-'} head=${head} gated=${gatedLabel} tree=same-modulo-stamps receipt=${digest}`, ...lines,
      ...rcpt.files.map(f => `  ${f.verdict} ${f.path} (${f.rule})`), `MERGE_CONDITION: sha=${head}`],
  };
}

