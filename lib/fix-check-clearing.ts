/**
 * fix-check-clearing — the one owner of when a granted fix-check counts and what it closes (GST-3260,
 * docs/review-policy.md#what-closes-a-finding). A stop leaves a stop record in the PR body, the lane or its Captain records a
 * fix-check grant naming it, a run claims the grant, and gstack-review-log stamps that run's review-fix-check row from the claim
 * (fix_check_base, run, grant, pr) with the digest of the hunks its reader was given. finish's fixChecked counts such a row through
 * bindFixCheckRow, anchored on the grant's stop rather than the newest reviewed tree (#4612); gstack-ship-receipt write closes
 * exactly the open blockers the grant names through clearByGrant, and a fix whose Review-Finding trailer a later full round read
 * clean through clearByTrailer (#4597). Anything less closes nothing and says why on one line. Every input is a record gstack's
 * tools wrote (the PR body's stop and claim entries, the approval record, the review log); the agent's --review-loop file only
 * lists which blockers are open.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { grantedStop } from './pr-review-history';
import { ownLinesSame, type ReviewRoundGrant } from './review-round-grant';
import { ledgerPass, parseFixTrailers, reviewRowKey, rowTime } from './review-scope';
import { isSecurityFinding } from './security-findings';
import { receiptRuns } from './ship-receipt';
import { spawnSync } from './spawn-sync';

type Row = Record<string, any>;
/** One entry of the loop summary's `open` list: a ledger id or fingerprint, or both. */
export type OpenBlocker = string | { id: string; fingerprint: string };
export type RowBinding = { ok: true; grant: ReviewRoundGrant; base: string; commit: string } | { ok: false; why: string };
export interface GrantClearing { ids: string[]; approval?: string; run?: string; why?: string }
export interface TrailerClearing { id: string; commit: string; review: string }

const SHA = /^[0-9a-f]{40}$/;
const s12 = (s: string) => s.slice(0, 12);
const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout ?? '' : null;
};
const ancestor = (cwd: string, a: string, d: string) => a === d || git(cwd, ['merge-base', '--is-ancestor', a, d]) !== null;
const treeOf = (cwd: string, c: string) => git(cwd, ['rev-parse', '--verify', '--quiet', `${c}^{tree}`])?.trim();
const findingsOf = (r: Row): Row[] => (Array.isArray(r?.findings) ? r.findings.filter((f: unknown) => !!f && typeof f === 'object') : []);
const nameOf = (b: OpenBlocker) => (typeof b === 'string' ? b : b.id);

/** A fix-check grant buys one fix-check: it is spent once a row carries it, or once any fix-check started after it was recorded. */
export const grantSpent = (rows: readonly Row[], g: Pick<ReviewRoundGrant, 'approval' | 'at'>) =>
  rows.some(r => r?.skill === 'review-fix-check' && (r.grant === g.approval || rowTime(r) > Date.parse(g.at)));

/**
 * The grant-and-row binding finish and write share (amendments A, B and H): a review-fix-check row gstack-review-log stamped from a
 * claim, whose grant is an approved fix-check grant naming its fix_check_base as the stop head on its PR; no agent-written
 * range_base that disagrees; a completed, converged read bound to its commit's own tree, which contains the base; nothing open in it
 * (rule e: its status, an inline finding with action open at any severity, findings_open from a findings file, an id its dispatch
 * ledger collected that the row does not dispose); and the hunks its reader was given are git diff <base> <commit> over their paths,
 * which cover every path that diff changes.
 */
export function bindFixCheckRow(cwd: string, row: Row, grants: readonly ReviewRoundGrant[]): RowBinding {
  const no = (why: string): RowBinding => ({ ok: false, why });
  const base = typeof row.fix_check_base === 'string' ? row.fix_check_base.toLowerCase() : '';
  const commit = typeof row.commit_full === 'string' ? row.commit_full.toLowerCase() : '';
  const g = grants.find(x => x.kind === 'fix-check' && x.approval === row.grant);
  const b = row.review_binding, h = row.hunks, findings = findingsOf(row);
  if (!SHA.test(base)) return no('the row carries no fix_check_base that gstack-review-log stamped from a claim');
  if (!g) return no(`its grant ${row.grant ?? 'none'} is no approved fix-check grant in this branch's approval record`);
  if (g.head !== base || g.pr !== row.pr) return no(`its fix_check_base ${s12(base)} on PR #${row.pr ?? '?'} is not the stop ${s12(g.head)} that grant ${g.approval} names on PR #${g.pr}`);
  if (row.range_base !== undefined && git(cwd, ['rev-parse', '--verify', '--quiet', `${row.range_base}^{commit}`])?.trim() !== base) return no(`its range_base ${String(row.range_base).slice(0, 12)} disagrees with the logger's fix_check_base ${s12(base)}`);
  if (row.completed !== true || row.converged !== true || b?.state !== 'verified' || typeof row.tree !== 'string' || b.start_wtree !== row.tree || b.end_wtree !== row.tree) return no('it is not a completed, converged read bound to one committed tree');
  if (!SHA.test(commit) || treeOf(cwd, commit) !== row.tree || !ancestor(cwd, base, commit)) return no(`its commit ${s12(commit) || 'missing'} does not hold the tree it read or does not contain the stop ${s12(base)}`);
  if (row.status === 'issues_found' || row.status === 'issues_open' || Number(row.findings_open ?? 0) > 0 || findings.some(f => f.action === 'open')) return no('it left a finding open');
  if (!h || typeof h.sha256 !== 'string' || !Array.isArray(h.paths) || !h.paths.length) return no('it carries no record of the hunks its reader was given');
  const diff = git(cwd, ['diff', base, commit, '--', ...h.paths]);
  if (diff === null || createHash('sha256').update(diff).digest('hex') !== h.sha256) return no(`the hunks its reader was given are not git diff ${s12(base)} ${s12(commit)}`);
  const changed = git(cwd, ['diff', '--name-only', base, commit]);
  const unread = changed === null ? null : changed.split('\n').filter(p => p && !h.paths.includes(p));
  if (unread === null || unread.length) return no(`the hunks its reader was given leave out ${unread?.join(', ') ?? 'paths git could not list'}, which git diff ${s12(base)} ${s12(commit)} changes`);
  if (typeof h.ledger === 'string') {
    let ids: string[];
    try { fs.readFileSync(h.ledger); ids = ledgerPass(h.ledger, id => `${path.basename(path.dirname(h.ledger))}/${id}`).ids ?? []; } catch { return no(`its dispatch ledger ${h.ledger} is unreadable`); }
    const disposed = new Set(findings.filter(f => f.action !== 'open').map(f => f.ledger_id));
    const left = ids.filter(id => !disposed.has(id));
    if (left.length) return no(`its dispatch ledger holds ${left.join(', ')}, which the row does not dispose`);
  }
  return { ok: true, grant: g, base, commit };
}

/**
 * Rules a to f with amendments D and E: (a) grantedStop accepts the newest stop record's fix-check grant for this PR and run;
 * (b) the PR body's first claim of the grant is this run's; (c) exactly one review-fix-check row carries the grant, stamped with
 * this run, and it binds (bindFixCheckRow) at the stop's head and tree from the body, never the newest review row, on the receipt
 * head or a head that only merges the base into it; (d) the stop, the claim and the row's start are recorded in that order;
 * (e) inside the binding; (f) each grant id closes the one open blocker whose id it is, a fingerprint only for a blocker without a
 * ledger id that no other blocker shares, never a gate finding, and only an id the fix list its reader was given named; an id
 * that names nothing closes nothing.
 */
export function clearByGrant(cwd: string, o: { pr: number; run: string; head: string; baseRef: string; body: string; grants: readonly ReviewRoundGrant[]; rows: readonly Row[]; open: readonly OpenBlocker[] }): GrantClearing {
  const none = (why: string): GrantClearing => ({ ids: [], why });
  const answer = grantedStop(o.body, o.grants, { pr: o.pr, head: o.head, run: o.run, isAncestor: (a, d) => ancestor(cwd, a, d) });
  if (!answer) return none(`no fix-check grant for PR #${o.pr}`);
  if (!answer.ok) return none(answer.why);
  const { grant: g, stop } = answer;
  const claim = receiptRuns(o.body).find(r => r.mark === 'grant' && r.grant === g.approval);
  if (claim?.run !== o.run) return none(`the PR body's first claim of grant ${g.approval} is ${claim ? `run ${claim.run}'s` : 'missing'}, not run ${o.run}'s`);
  const stamped = [...new Map(o.rows.filter(r => r?.skill === 'review-fix-check' && r.grant === g.approval).map(r => [reviewRowKey(r), r] as const)).values()];
  const row = stamped[0];
  if (stamped.length !== 1 || row!.run !== o.run) return none(`grant ${g.approval} buys one fix-check row stamped with run ${o.run}, and the review log holds ${stamped.length}${row ? ` (run ${row.run}'s)` : ''}`);
  const bound = bindFixCheckRow(cwd, row!, o.grants);
  if (!bound.ok) return none(`the granted fix-check: ${bound.why}`);
  if (bound.base !== stop.head || treeOf(cwd, stop.head) !== stop.tree) return none(`the granted fix-check read from ${s12(bound.base)}, not the stop record's head ${s12(stop.head)} and its tree`);
  if (bound.commit !== o.head && !(ancestor(cwd, bound.commit, o.head) && ownLinesSame(cwd, o.baseRef, bound.commit, o.head))) return none(`the granted fix-check read ${s12(bound.commit)}, and ${s12(o.head)} is neither it nor a head that only merges the base into it`);
  const started = row!.review_binding?.started_at;
  if (!(Date.parse(String(stop.at)) < Date.parse(String(claim.at)) && Date.parse(String(claim.at)) < Date.parse(String(started)))) return none(`the stop (${stop.at ?? 'no time'}), the claim (${claim.at ?? 'no time'}) and the fix-check's start (${started ?? 'no time'}) are not recorded in that order`);
  const gated = new Set(o.rows.flatMap(r => findingsOf(r).filter(f => f.gate !== undefined).flatMap(f => [f.ledger_id, f.fingerprint])));
  const asked = new Set<string>(Array.isArray(row!.hunks?.fix_list) ? row!.hunks.fix_list : []);
  const ids = g.findings!.filter(name => asked.has(name) && !isSecurityFinding(name) && o.open.filter(b => nameOf(b) === name).length === 1 && !o.open.some(b => typeof b !== 'string' && b.fingerprint === name) && !gated.has(name));
  const unasked = g.findings!.filter(name => !asked.has(name));
  const unnamed = g.findings!.filter(name => asked.has(name) && !ids.includes(name));
  const why = [...(unasked.length ? [`the fix list its reader was given does not name ${unasked.join(', ')}`] : []), ...(unnamed.length ? [`grant ${g.approval} names ${unnamed.join(', ')}, which no open blocker carries alone`] : [])].join('; ');
  return { ids, approval: g.approval, run: o.run, ...(why ? { why } : {}) };
}

/**
 * The #4597 route: an open blocker closes when a branch commit carries its Review-Finding trailer (its exact ledger id, or its
 * fingerprint when no other open blocker shares it) and a later complete full review, bound to its own committed tree on this
 * branch and holding that commit in its range, left nothing open (the same open test as bindFixCheckRow: its status, findings_open
 * from a findings file, an inline open finding). Gate findings never close this way.
 */
export function clearByTrailer(cwd: string, o: { head: string; baseRef: string; rows: readonly Row[]; open: readonly OpenBlocker[] }): TrailerClearing[] {
  const log = git(cwd, ['log', '--no-merges', '--format=%H%x00%(trailers:key=Review-Finding,valueonly,separator=%x1f)%x1e', `${o.baseRef}..${o.head}`]);
  const trailers = (log ?? '').split('\x1e').flatMap(rec => { const [sha, values] = rec.trim().split('\0'); return sha && values ? parseFixTrailers(sha, values.split('\x1f').map(v => v.trim()).filter(Boolean)) : []; });
  return o.open.flatMap(b => {
    const id = nameOf(b), fp = typeof b === 'string' ? b : b.fingerprint;
    const raised = o.rows.flatMap(r => findingsOf(r).filter(f => f.action === 'open' && (f.ledger_id === id || (f.ledger_id === undefined && f.fingerprint === fp))).map(f => ({ r, f })));
    const alone = o.open.filter(c => (typeof c === 'string' ? c : c.fingerprint) === fp).length === 1;
    const t = trailers.find(x => x.finding === id || (alone && x.finding === fp));
    if (!t || !raised.length || raised.some(x => x.f.gate !== undefined) || isSecurityFinding(t.finding)) return [];
    const after = Math.max(...raised.map(x => rowTime(x.r)));
    const inRange = (from: unknown, fix: string) => from == null || (typeof from === 'string' && (b => !!b && !ancestor(cwd, fix, b))(git(cwd, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`])?.trim()));
    const review = o.rows.find(r => r?.skill === 'review' && r.via === 'ship' && r.completed === true && r.scope !== 'fix-range' && r.scope !== 'scoped' && rowTime(r) > after
      && r.converged === true && r.review_binding?.state === 'verified' && inRange(r.range_base, t.commit) && typeof r.tree === 'string' && r.review_binding.start_wtree === r.tree && r.review_binding.end_wtree === r.tree
      && SHA.test(String(r.commit_full)) && treeOf(cwd, r.commit_full) === r.tree && ancestor(cwd, t.commit, r.commit_full) && ancestor(cwd, r.commit_full, o.head)
      && r.status !== 'issues_found' && r.status !== 'issues_open' && Number(r.findings_open ?? 0) === 0 && !findingsOf(r).some(f => f.action === 'open'));
    return review ? [{ id, commit: t.commit, review: review.commit_full as string }] : [];
  });
}
