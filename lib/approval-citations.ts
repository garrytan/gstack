/**
 * approval-citations — the `Approved by <owner> <YYYY-MM-DD> via <ref>`
 * lines that let a change in a declared approval class ship (field list 2,
 * W2; lib/approval-classes.ts finds the classes). A citation is resolved,
 * never trusted as typed:
 *
 * - a plan sha (7-64 hex) must match the plan of an autoplan run passed with
 *   `--approval-run <dir>` whose gate is APPROVED (status complete, the p1
 *   decision answered and not reject/interrogate), with plan.md matching its
 *   manifest hash;
 * - a GitHub comment or review URL must be written by a ship-policy
 *   maintainer whose login is the cited owner, and the evidence is the body's
 *   first non-blank line only (`approvalLine`: "Approve" or "Approved" at
 *   column 0, optionally in `**`, no list marker, quote or indent; nothing
 *   later in the body counts); a review must also be APPROVED;
 * - anything else, or a ref that cannot be read here, is `unverified`.
 *
 * Resolution alone is not enough: the evidence (the approved plan text or
 * the comment's approval line) must bind to the class's current effects, by
 * carrying the scope token `<class>@<digest12>` or by naming the class and
 * every effect path. A token is authoritative: evidence naming the class with
 * another digest approved earlier effects and never falls back to paths. An
 * authentic approval of other work, or one given before an effect was added,
 * does not bind. An unverified citation counts only as an explicit
 * applicability attestation: `for <class>@<digest12>` on the line, matching
 * the current scope, so a later effect change invalidates it.
 * Caller: bin/gstack-ship-receipt write (APPROVAL_CITATION_MISSING).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runApprovalScan, type ApprovalHit, type ApprovalScope } from './approval-classes';
import { sha256File } from './headless-artifacts';
import { isUnavailable, loadPolicyFromBase } from './ship-policy';

export interface Citation { raw: string; owner: string; date: string; ref: string; for: Array<{ class: string; digest?: string }> }
export type Resolution =
  | { state: 'resolved'; evidence: string; text: string; approvalLine?: true }
  | { state: 'rejected'; why: string }
  | { state: 'unresolved'; why: string };
export type GhRunner = (args: string[]) => { ok: boolean; out: string; err: string };
export interface CitationContext { runDirs: string[]; maintainers: string[]; gh: GhRunner }

const CLASS_REF = '[a-z][a-z0-9-]*(?:@[0-9a-f]{12,64})?';
const CITATION_RE = new RegExp(`Approved by @?([A-Za-z0-9][\\w.-]*) (\\d{4}-\\d{2}-\\d{2}) via (\\S+)(?: for (${CLASS_REF}(?:,${CLASS_REF})*))?`, 'g');

function validDate(d: string): boolean {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** Every well-formed citation line in `text` (a PR body or --approval values); a bad calendar date is not a citation. */
export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    if (!validDate(m[2]!)) continue;
    const ref = m[3]!.replace(/[.,;:)\]>]+$/, '');
    const forList = (m[4] ?? '').split(',').filter(Boolean).map(entry => {
      const [cls, digest] = entry.split('@');
      return digest ? { class: cls!, digest } : { class: cls! };
    });
    out.push({ raw: m[0], owner: m[1]!.replace(/\.$/, ''), date: m[2]!, ref, for: forList });
  }
  return out;
}

function readJsonl(file: string): Array<Record<string, any>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function planGate(dir: string, run: Record<string, any>): Resolution {
  const entry = run.artifacts?.['plan.md'];
  const planFile = path.join(dir, entry?.path ?? 'plan.md');
  if (!entry || !fs.existsSync(planFile) || sha256File(planFile) !== entry.sha256) return { state: 'rejected', why: `run ${run.run}: plan.md does not match its manifest hash` };
  const gate = run.gate ?? {};
  const rev = gate.gate_rev ?? run.gate_rev;
  const p1 = readJsonl(path.join(dir, 'decisions.jsonl')).find(d => d.label === 'P1' && d.gate_rev === rev);
  const approved = run.status === 'complete' && typeof gate.plan === 'string' && !['c', 'e'].includes(gate.plan) && p1 && p1.chosen === gate.plan && p1.status !== 'pending';
  if (!approved) return { state: 'rejected', why: `run ${run.run} holds this plan but its gate is not APPROVED (status ${run.status}, p1 ${p1?.chosen ?? 'unanswered'})` };
  if (p1.words_by) return { state: 'rejected', why: `run ${run.run}: its gate was answered in ${p1.words_by}'s own words, not the owner's` };
  return { state: 'resolved', evidence: `plan ${run.run} gate_rev=${rev} p1=${gate.plan} answered_by=${gate.answered_by ?? p1.answered_by ?? 'unrecorded'}`, text: fs.readFileSync(planFile, 'utf8') };
}

/** A plan sha: the plan.md (or reviewed plan) hash of an approved autoplan run among `runDirs`. */
export function resolvePlan(ref: string, runDirs: string[]): Resolution {
  const want = ref.toLowerCase();
  let rejected: Resolution | undefined;
  for (const dir of runDirs) {
    let run: Record<string, any>;
    try { run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { continue; }
    const hashes = [run.artifacts?.['plan.md']?.sha256, run.plan_reality?.plan_sha256].filter((h): h is string => typeof h === 'string');
    if (!hashes.some(h => h.toLowerCase().startsWith(want))) continue;
    const r = planGate(dir, run);
    if (r.state === 'resolved') return r;
    rejected = r;
  }
  return rejected ?? { state: 'unresolved', why: runDirs.length ? `no --approval-run directory holds a plan with sha ${ref}` : `plan sha ${ref}: pass the autoplan run with --approval-run <dir>` };
}

/**
 * The approval evidence in a comment or review body: its first non-blank line, and only when that line starts at
 * column 0 with "Approve" or "Approved" (optionally in `**`), with no list marker, quote or indent; '' otherwise.
 * Nothing later in the body counts, so no quoting or nesting can turn a rejection's example into consent.
 */
export function approvalLine(body: string): string {
  const first = body.split(/\r?\n/).find(l => l.trim()) ?? '';
  return /^(?:\*\*)?approved?\b/i.test(first) ? first : '';
}

const GH_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)#(?:issuecomment-(\d+)|pullrequestreview-(\d+)|discussion_r(\d+))$/;

/** A comment or review URL: authored by a ship-policy maintainer whose login is the cited owner; a review must be APPROVED; only the body's first-line approval is evidence. */
export function resolveGithub(c: Citation, ctx: CitationContext): Resolution {
  const m = GH_URL.exec(c.ref)!;
  const [, owner, repo, num, issueComment, review, discussion] = m;
  const api = issueComment ? `repos/${owner}/${repo}/issues/comments/${issueComment}`
    : review ? `repos/${owner}/${repo}/pulls/${num}/reviews/${review}`
    : `repos/${owner}/${repo}/pulls/comments/${discussion}`;
  const r = ctx.gh(['api', api]);
  if (!r.ok) return { state: 'unresolved', why: `gh api ${api} failed: ${r.err.split('\n')[0] || 'no output'}` };
  let body: Record<string, any>;
  try { body = JSON.parse(r.out); } catch { return { state: 'unresolved', why: `gh api ${api} returned no JSON` }; }
  const login = String(body.user?.login ?? '');
  if (!ctx.maintainers.length) return { state: 'unresolved', why: 'the base ship policy lists no maintainers, so the author cannot be classified' };
  if (!ctx.maintainers.some(x => x.toLowerCase() === login.toLowerCase())) return { state: 'rejected', why: `${c.ref} is by ${login || 'an unknown author'}, not a ship-policy maintainer` };
  if (login.toLowerCase() !== c.owner.toLowerCase()) return { state: 'rejected', why: `the citation names ${c.owner} but ${c.ref} is by ${login}` };
  if (review && body.state === 'CHANGES_REQUESTED') return { state: 'rejected', why: `${c.ref} requests changes; it is not an approval` };
  if (review && body.state !== 'APPROVED') return { state: 'rejected', why: `${c.ref} is a ${String(body.state ?? 'stateless').toLowerCase()} review; only an APPROVED review counts` };
  return { state: 'resolved', evidence: `${review ? 'review' : 'comment'} by ${login}`, text: approvalLine(String(body.body ?? '')), approvalLine: true };
}

export function resolveCitation(c: Citation, ctx: CitationContext): Resolution {
  if (/^[0-9a-f]{7,64}$/i.test(c.ref)) return resolvePlan(c.ref, ctx.runDirs);
  if (GH_URL.test(c.ref)) return resolveGithub(c, ctx);
  return { state: 'unresolved', why: `${c.ref} is neither a plan sha nor a GitHub comment or review URL` };
}

/** The digests `text` names for this class (`<class>@<hex>`), lowercased. */
function namedDigests(text: string, cls: string): string[] {
  return [...text.toLowerCase().matchAll(new RegExp(`(?:^|[^a-z0-9-])${cls}@([0-9a-f]{12,64})(?![0-9a-f])`, 'g'))].map(m => m[1]!);
}

/** How the evidence names this exact scope: the token, or (when it names no token for the class) the class plus every effect path; null otherwise. */
export function binding(text: string, scope: ApprovalScope): 'token' | 'paths' | null {
  const digests = namedDigests(text, scope.class);
  if (digests.length) return digests.some(d => scope.digest.startsWith(d)) ? 'token' : null;
  const lower = text.toLowerCase();
  const named = new RegExp(`(^|[^a-z0-9-])${scope.class}([^a-z0-9-]|$)`).test(lower);
  return named && scope.files.every(f => text.includes(f)) ? 'paths' : null;
}

export interface ApprovalRecord {
  class: string; scope: string; effects: string[]; citation: 'verified' | 'unverified';
  approved_by: string; date: string; via: string; binding: 'token' | 'paths' | 'attested'; evidence: string;
}
export interface MissingApproval { class: string; token: string; files: string[]; reasons: string[] }

function judge(c: Citation, scope: ApprovalScope, res: Resolution): ApprovalRecord | string {
  const base = { class: scope.class, scope: scope.token, effects: scope.hits, approved_by: c.owner, date: c.date, via: c.ref };
  if (res.state === 'rejected') return `${c.ref}: ${res.why}`;
  if (res.state === 'resolved') {
    const how = binding(res.text, scope);
    if (how) return { ...base, citation: 'verified', binding: how, evidence: res.evidence };
    const stale = namedDigests(res.text, scope.class)[0];
    if (stale) return `${c.ref}: ${res.evidence} names ${scope.class}@${stale.slice(0, 12)}, not the current ${scope.token}; a token is authoritative, so approval of earlier effects never falls back to paths`;
    const where = res.approvalLine ? ' on its first non-blank line, which must start at column 0 with "Approved" or "Approve"' : '';
    return `${c.ref}: ${res.evidence} names neither ${scope.token} nor ${scope.class} with every effect path (${scope.files.join(', ')})${where}; an approval of other work, or one given before these effects, does not cover them`;
  }
  const attested = c.for.find(f => f.class === scope.class);
  if (attested?.digest && scope.digest.startsWith(attested.digest)) return { ...base, citation: 'unverified', binding: 'attested', evidence: `unresolved: ${res.why}` };
  if (attested?.digest) return `${c.ref}: attested for ${scope.class}@${attested.digest.slice(0, 12)} but the effects are now ${scope.token} (changed since the attestation)`;
  return `${c.ref}: unresolved (${res.why}); an unverified citation must attest "for ${scope.token}"`;
}

/** One record per scope: a verified citation first, else an attested unverified one; otherwise the scope is missing, with every candidate's reason. */
export function evaluateApprovals(scopes: ApprovalScope[], citations: Citation[], ctx: CitationContext): { records: ApprovalRecord[]; missing: MissingApproval[] } {
  const cache = new Map<string, Resolution>();
  const resolve = (c: Citation) => { const key = `${c.ref}\0${c.owner}`; if (!cache.has(key)) cache.set(key, resolveCitation(c, ctx)); return cache.get(key)!; };
  const records: ApprovalRecord[] = [];
  const missing: MissingApproval[] = [];
  for (const scope of scopes) {
    const candidates = citations.filter(c => !c.for.length || c.for.some(f => f.class === scope.class));
    const judged = candidates.map(c => judge(c, scope, resolve(c)));
    const pick = judged.find((j): j is ApprovalRecord => typeof j !== 'string' && j.citation === 'verified') ?? judged.find((j): j is ApprovalRecord => typeof j !== 'string');
    if (pick) records.push(pick);
    else missing.push({ class: scope.class, token: scope.token, files: scope.files, reasons: judged.length ? judged as string[] : ['no "Approved by" line names this class or applies to every class'] });
  }
  return { records, missing };
}

export function defaultGh(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

export interface ReceiptApprovalRequest { repoRoot: string; base: string; head: string; citationText: string; runDirs: string[]; gh?: GhRunner }
export type ReceiptApproval =
  | { kind: 'skip' }
  | { kind: 'ok'; approval: Record<string, unknown>; note?: string }
  | { kind: 'invalid'; lines: string[] }
  | { kind: 'error'; message: string; code?: 'APPROVAL_SOURCE_UNAVAILABLE' }
  | { kind: 'missing'; missing: MissingApproval[] };

const reportOnly = (hits: ApprovalHit[]) => hits.map(h => `${h.class} ${h.file}:${h.line} (${h.text})`);

/** The receipt's approval object, or the refusal: classes from origin/<base>, effects at `head`, citations from the body and --approval. */
export function approvalForReceipt(req: ReceiptApprovalRequest): ReceiptApproval {
  const outcome = runApprovalScan({ repoRoot: req.repoRoot, base: req.base, head: req.head });
  if ('unavailable' in outcome) return { kind: 'ok', approval: { source: outcome.source, status: 'unavailable', detail: outcome.unavailable, classes: [] }, note: `APPROVAL_CLASSES: unavailable (${outcome.unavailable}); approval classes were not checked` };
  if ('errors' in outcome) return { kind: 'invalid', lines: outcome.errors.map(e => `${e.message} at ${e.path || '<root>'} (${outcome.source})`) };
  if ('error' in outcome) return { kind: 'error', message: outcome.error, ...(outcome.unreadable ? { code: 'APPROVAL_SOURCE_UNAVAILABLE' as const } : {}) };
  const { scan, absent } = outcome;
  if (absent && !scan.report_only.length) return { kind: 'skip' };
  const policy = loadPolicyFromBase(req.repoRoot, req.base);
  const maintainers = isUnavailable(policy) ? [] : policy.policy.maintainers;
  const { records, missing } = evaluateApprovals(scan.scopes, parseCitations(req.citationText), { runDirs: req.runDirs, maintainers, gh: req.gh ?? defaultGh });
  if (missing.length) return { kind: 'missing', missing };
  return { kind: 'ok', approval: { source: scan.source, status: 'checked', classes: records, ...(scan.report_only.length ? { report_only: reportOnly(scan.report_only) } : {}) } };
}

/** The SHIP_RECEIPT summary token: verified, unverified:<classes>, none or unchecked. */
export function approvalSummary(approval: Record<string, any>): string {
  if (approval.status === 'unavailable') return 'unchecked';
  const classes = (approval.classes ?? []) as ApprovalRecord[];
  if (!classes.length) return 'none';
  const unverified = classes.filter(c => c.citation === 'unverified').map(c => c.class);
  return unverified.length ? `unverified:${unverified.join(',')}` : 'verified';
}
