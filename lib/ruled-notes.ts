/**
 * Owner-ruled notes (GST-1537, docs/ship-policy.md#ruled-notes): the owner's ruling that a review finding ships as a
 * disclosed note instead of a fix. A ruling is one approved gstack-approvals row (`gstack-approvals rule`), with scope
 * `ruled_note <finding fingerprint> <head>` and ask `ruled_note <finding fingerprint> at <head>: <reason>`, where head is the
 * full sha of the stop head the owner ruled at; the row's `by` is the ruler and its `recorded_at` the time. A review-log field
 * never makes one, so the lane that logged a finding cannot close it.
 */
import { locate, readRecord, renderMode, repoVisibility, type ApprovalRow, type Env } from './approval-record';
import { isSecurityFinding, REDACTED_FINDING, REDACTED_REASON } from './security-findings';
import { openRun, readRunRecord } from './ship-run-record';
import { spawnSync } from './spawn-sync';

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
/**
 * A Capy thread or message id as public text must never carry it (GST-1955, CAPY-1 qm#3938): a `jam_` id, or a relay ref in
 * OWNER_REF's shape, `<thread code>:<message id or timestamp>`. A thread code alone (`GStack Minder (GSTA-36)`) names a ruler.
 */
export const INTERNAL_ID = /\bjam_[A-Za-z0-9]+|\b[A-Z][A-Z0-9]*-[1-9]\d*:[A-Za-z0-9][\w.:+-]*/;
/** What public text says in place of an INTERNAL_ID: the relay a Ruled note names, and any id in an abandon entry's who and why. */
export const PRIVATE_REF = 'a private message';
export const redactInternalIds = (text: string) => text.replace(new RegExp(INTERNAL_ID.source, 'g'), PRIVATE_REF);
/** Whether text for a PR body or receipt in the repository at cwd must leave out internal ids: gh is asked only when text holds one, and only a repository gh reports private keeps them. */
export const keepsInternalIds = (text: string, cwd: string, env: Env = process.env) => !INTERNAL_ID.test(text) || renderMode(repoVisibility(cwd, env), false) === 'full';
/**
 * The rulings as this repository's public text carries them: gstack-approvals rulings, finish's RULED_NOTE lines and the receipt's
 * ruled_notes all read them here, so all three agree. On a public or unknown-visibility repository a relayed ruling says it was
 * relayed from PRIVATE_REF, and the ref itself stays in the approval record's row (CAPY-1 qm#3938).
 */
export const repoRuledNotes = (notes: RuledNote[], cwd: string, env: Env = process.env): RuledNote[] =>
  keepsInternalIds(notes.map(n => n.relayed ?? '').join(' '), cwd, env) ? notes : notes.map(n => n.relayed ? { ...n, relayed: PRIVATE_REF } : n);
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

/**
 * A PR body line as the receipt checks read it: trimmed, with one leading `- ` or `* ` list bullet dropped, so a body that lists its
 * `Ruled note: …` lines as bullets carries them. The rest must still equal the rendered line word for word.
 */
export const bodyLineText = (line: string) => line.trim().replace(/^[-*][ \t]+/, '');
/** Whether `body` carries `line` as one whole line, bare or as a `- ` / `* ` list item (bodyLineText). */
export const bodyListsLine = (body: string, line: string) => body.split(/\r?\n/).some(b => bodyLineText(b) === line);

/** The one-line form finish prints after `RULED_NOTE: ` and the PR body carries after `Ruled note: `, from publicRuledNote. */
export const ruledNoteText = (note: RuledNote) => { const n = publicRuledNote(note); return `${n.finding} at ${n.head.slice(0, 12)} ruled by ${n.by}${n.relayed ? ` (relayed from ${n.relayed})` : ''} at ${n.at}: ${n.reason} (approval ${n.approval})`; };

/**
 * The /ship run this checkout's run record holds open (open, stopped, legacy or unreadable), with the line a refusal prints: its state,
 * beat_age and abandon command; none once the run finished or was abandoned (lib/ship-run-record.ts).
 */
export const openShipRun = (cwd: string) => openRun(readRunRecord(cwd));

/** Finish's and the plan's line for a ruled path: `RULED_EDIT: <path> (ruled at <head12> by <who>, approval <id>)`. */
export const ruledEditLine = (p: string, n: RuledNote) => `RULED_EDIT: ${p} (ruled at ${n.head.slice(0, 12)} by ${n.by}, approval ${n.approval})`;

/**
 * Which of `paths` an owner's `edit:<path>` ruling clears at `now` (a commit or tree; docs/ship-policy.md#ruled-edits): the ruling
 * names HEAD or an ancestor of it, both trees hold the path as one file under exactly this spelling with the same mode and bytes,
 * and no first-parent commit after the ruled head touches it. finish routes the cleared paths as RULED_EDIT and gstack-review-plan
 * leaves them out of the fix range (GST-3814), so both read a ruling the same way; `refused` names each ruled path that did not
 * clear, with why.
 */
export function ruledEdits(cwd: string, paths: readonly string[], now: string, edits: readonly RuledNote[]): { ruled: Map<string, RuledNote>; refused: string[] } {
  const git = (dir: string, args: string[]) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }); return { status: r.status, stdout: String(r.stdout ?? '') }; };
  const ancestor = (a: string, d: string) => git(cwd, ['merge-base', '--is-ancestor', a, d]).status === 0;
  const top = edits.length ? git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim() : '';
  const entry = (tree: string, p: string) => { const ls = git(cwd, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', p]); const rows = ls.stdout.split('\0').filter(Boolean);
    return ls.status !== 0 || rows.length > 1 || rows.some(e => e.slice(e.indexOf('\t') + 1) !== p) ? null : rows[0] ?? ''; };
  const untouched = (head: string, p: string) => { const log = git(top, ['--literal-pathspecs', 'log', '--first-parent', '--format=%H', `${head}..HEAD`, '--', p]); return log.status === 0 && !log.stdout.trim(); };
  const refusal = (n: RuledNote, p: string) => {
    if (!ancestor(n.head, 'HEAD')) return `ruled at ${n.head.slice(0, 12)}, which is not HEAD or an ancestor of it`;
    const [at, cur] = [entry(n.head, p), entry(now, p)], where = (e: string | null) => e === at ? n.head.slice(0, 12) : 'the tree finish routes';
    if (at === null || cur === null) return `git ls-tree could not read it at ${where(null)}`;
    if (!at || !cur) return `no file at ${where('')}: a ruling covers a file git holds under this spelling, never a deletion`;
    if (p.includes('\uFFFD')) return 'its spelling holds a replacement character (U+FFFD), so the file git changed may have another name';
    if (at !== cur) return `its mode or bytes differ from the ruled head ${n.head.slice(0, 12)}`;
    return top && untouched(n.head, p) ? '' : `a commit after ${n.head.slice(0, 12)} touches it, or git could not list them`;
  };
  const ruled = new Map<string, RuledNote>(), refused: string[] = [];
  for (const p of paths) {
    const why = edits.filter(n => n.finding === `edit:${p}`).map(n => [n, refusal(n, p)] as const);
    const ok = why.filter(([, w]) => !w).at(-1);
    if (ok) ruled.set(p, ok[0]); else if (why.length) refused.push(`${p} (${why.at(-1)![1]}; keep the edit and run /gstack-ship again, docs/ship-policy.md#ruled-edits)`);
  }
  return { ruled, refused };
}
