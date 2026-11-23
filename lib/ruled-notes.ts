/**
 * Owner-ruled notes (GST-1537, docs/ship-policy.md#ruled-notes): the owner's ruling that a review finding ships as a
 * disclosed note instead of a fix. A ruling is one approved gstack-approvals row (`gstack-approvals rule`), with scope
 * `ruled_note <finding fingerprint> <head>` and ask `ruled_note <finding fingerprint> at <head>: <reason>`, where head is the
 * full sha of the stop head the owner ruled at; the row's `by` is the ruler and its `recorded_at` the time. A review-log field
 * never makes one, so the lane that logged a finding cannot close it.
 */
import { locate, readRecord, type ApprovalRow, type Env } from './approval-record';
import { isSecurityFinding, REDACTED_FINDING, REDACTED_REASON } from './security-findings';
import { openRun, readRunRecord } from './ship-run-record';

export interface RuledNote { finding: string; head: string; by: string; reason: string; at: string; approval: string; relayed?: string; not_security?: true }

const SCOPE = /^ruled_note (\S+) ([0-9a-f]{40})$/;
const ASK = /^ruled_note (\S+) at ([0-9a-f]{40}): (\S(?:.*\S)?)$/;
/** A ruler gstack names for itself (the no-stop default's `gstack no-stop default (K1)`) is no owner. */
const GSTACK_ACTOR = /^gstack\b/i;
/**
 * A crew named after gstack, in its brand capitals with a capitalised word after it (`GStack Minder (GSTA-36)`), is a person's
 * crew: GSTACK_ACTOR's prefix match refused it as --by on every owner record. gstack writes each name of its own in lower case
 * (GSTACK_ACTOR_NAMES, bin/gstack-no-stop), so this exemption on top of the catch admits none of them.
 */
const GSTACK_NAMED_CREW = /^GStack [A-Z]/;
/** The names gstack itself writes as `by`, matched whole: `gstack-evals Captain` or `GStack Minder` is a person's crew, not gstack. */
export const GSTACK_ACTOR_NAMES: readonly string[] = ['gstack', 'gstack no-stop default (K1)'];
export const isGstackActorName = (by: string) => GSTACK_ACTOR_NAMES.some(n => n.toLowerCase() === by.trim().toLowerCase());
export const isGstackActor = (by: string) => GSTACK_ACTOR.test(by.trim()) && !(GSTACK_NAMED_CREW.test(by.trim()) && !isGstackActorName(by));
export const RULED_NOTE_SCOPE = /^\s*ruled_note\b/;

export const ruledNoteRow = (finding: string, head: string, reason: string) => ({ scope: `ruled_note ${finding} ${head}`, ask: `ruled_note ${finding} at ${head}: ${reason}` });
/** Where a lane relays the owner's ruling from: `<thread code>:<message id or timestamp>`, a message a reader can look up. */
export const OWNER_REF = /^[A-Z][A-Z0-9]*-[1-9]\d*:[A-Za-z0-9][\w.:+-]*$/;
/** OWNER_REF in words, for the refusals and help that name it; a refusal never echoes the rejected ref, which may hold anything (#4718). */
export const OWNER_REF_SHAPE = '<thread code>:<message id or timestamp>, where the thread code is an uppercase letter, then uppercase letters or digits, a dash and a number from 1, and the message part starts with a letter or digit (GSTA-36:2026-11-19T12:29:59Z)';
const RED_TEAM = /:red-team$/i;
/** A ruling row's source: `relayed:<owner ref>` for a relayed ruling and `not-security` for a red-team finding the owner ruled not security class. */
export const ruledNoteSource = (o: { ownerRef?: string; notSecurity?: boolean }) => [o.ownerRef ? `relayed:${o.ownerRef}` : '', o.notSecurity ? 'not-security' : ''].filter(Boolean).join(' ') || undefined;

/** The approved ruling rows, one per finding and head (the newest wins). */
export function ruledNotes(rows: readonly ApprovalRow[]): RuledNote[] {
  const byFinding = new Map<string, RuledNote>();
  for (const r of rows) {
    const scope = SCOPE.exec(r.scope), ask = ASK.exec(r.ask);
    if (r.outcome !== 'approved' || !scope || !ask || ask[1] !== scope[1] || ask[2] !== scope[2] || isGstackActor(r.by)) continue;
    const finding = scope[1]!, head = scope[2]!, key = `${finding} ${head}`;
    byFinding.delete(key);
    const source = r.source.split(' ');
    const relayed = source.find(t => t.startsWith('relayed:'))?.slice('relayed:'.length);
    const notSecurity = source.includes('not-security') && RED_TEAM.test(finding);
    byFinding.set(key, { finding, head, by: r.by, reason: ask[3]!, at: r.recorded_at, approval: r.id, ...(relayed && OWNER_REF.test(relayed) ? { relayed } : {}), ...(notSecurity ? { not_security: true as const } : {}) });
  }
  return [...byFinding.values()];
}

/** The rulings in the checked-out branch's approval record (and its mirror). */
export function readRuledNotes(cwd: string, env: Env = process.env): RuledNote[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : ruledNotes(readRecord(loc).rows);
}

/**
 * The ruling as public text may carry it: a security-class finding's fingerprint and reason stay in the approval record (GST-3076).
 * A red-team finding the owner ruled not security class (gstack-evals #380: a statistics fix) shows its location and reason,
 * written without the `:red-team` fingerprint tail the public-text guards refuse.
 */
export const publicRuledNote = (n: RuledNote): RuledNote => !isSecurityFinding(n.finding) ? n
  : n.not_security && RED_TEAM.test(n.finding) ? { ...n, finding: n.finding.replace(RED_TEAM, ' (red-team, ruled not security class)') }
  : { ...n, finding: REDACTED_FINDING, reason: REDACTED_REASON };

/** The one-line form finish prints after `RULED_NOTE: ` and the PR body carries after `Ruled note: `, from publicRuledNote. */
export const ruledNoteText = (note: RuledNote) => { const n = publicRuledNote(note); return `${n.finding} at ${n.head.slice(0, 12)} ruled by ${n.by}${n.relayed ? ` (relayed from ${n.relayed})` : ''} at ${n.at}: ${n.reason} (approval ${n.approval})`; };

/**
 * The /ship run this checkout's run record holds open (open, stopped, legacy or unreadable), with the line a refusal prints: its state,
 * beat_age and abandon command; none once the run finished or was abandoned (lib/ship-run-record.ts).
 */
export const openShipRun = (cwd: string) => openRun(readRunRecord(cwd));
