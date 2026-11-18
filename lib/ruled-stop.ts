/**
 * The ruled-stop check (GST-2273, GST-3005, docs/review-policy.md item 7): whether the owner ruled every open finding of the stop
 * this /ship run recorded, so the run may ship them as disclosed notes. The stop is the newest stop record in the PR body
 * (gstack-ship-receipt stop, lib/pr-review-history.ts stopFrom: a review bound to one committed tree). Its open findings are the
 * blocking findings of this run's review rows at that head, each named by its run-unique ledger id, plus every blocker this
 * run's dispatch ledgers hold that no row fixed or classified below the floor. A finding closes only by a stop ruling naming its
 * id, that head, the PR and this run (lib/ruled-notes.ts stopRulings); a gate finding (a gate on its row or in its ledger line)
 * and a security-class blocker never close this way. Review-read, the loop summary and the dispatch judge never read rulings, so a
 * ruled finding stays open in the raw evidence and shows as owner-deferred only in the receipt and the PR body.
 */
import * as fs from 'node:fs';
import { rank, readLedger, type MergedLine } from './review-ledger';
import type { StopRuling } from './ruled-notes';

export interface LedgerTrait { key: string; reader: string; gate?: string; category?: string; specialist?: string }
export interface OpenFinding { id: string; why: 'ruled' | 'open' | 'gated' | 'security' | 'unnamed'; ruling?: StopRuling }
export interface RuledStop {
  state: 'closed' | 'open' | 'none' | 'unbound';
  why?: string;
  stop?: { head: string; tree: string; run: string };
  findings: OpenFinding[];
  /** Rulings for this PR that name no open finding of this stop (another id, head or run). */
  unmatched: StopRuling[];
}

const SECURITY = /^(security|auth|secrets?|privacy|data[-_ ]?loss)$/i;
const FIXED = new Set(['fixed', 'auto-fixed']);
const bound = (r: Record<string, any>, tree: string) => {
  const b = r.review_binding;
  return r.completed === true && r.dirty !== true && r.tree === tree && !!b && (b.state === 'verified' || b.state === 'incomplete') && b.start_wtree === tree && b.end_wtree === tree && (r.wtree === undefined || r.wtree === tree);
};
const blocks = (f: Record<string, any>) => (typeof f.blocking === 'boolean' ? f.blocking : rank(f.severity) === 4);
const gateOf = (texts: readonly string[]) => {
  for (const t of texts) { try { const o = JSON.parse(t); if (o && typeof o.gate === 'string' && o.gate) return o.gate as string; } catch { /* a prose finding */ } }
  return texts.map(t => /\bRH-\d+\b/.exec(t)?.[0]).find(Boolean);
};

/** Each collected finding's reader, and the gate and category its merged line or judged reason names, keyed <pass dir>/<id>. */
export function ledgerTraits(ledger: string, keyOf: (id: string) => string): LedgerTrait[] {
  const events = readLedger(ledger);
  const reasons = new Map<string, string>();
  const judge = [...events].reverse().find(e => e.event === 'judge' && e.ok === true);
  if (judge && typeof judge.judged === 'string' && fs.existsSync(judge.judged)) {
    for (const l of fs.readFileSync(judge.judged, 'utf8').split('\n')) { try { const j = JSON.parse(l); if (typeof j?.id === 'string' && typeof j.reason === 'string') reasons.set(j.id, j.reason); } catch { /* not a judged line */ } }
  }
  const out = new Map<string, LedgerTrait>();
  for (const o of events.filter(e => e.event === 'output' && Array.isArray(e.ids) && typeof e.merged === 'string')) {
    const lines = fs.readFileSync(String(o.merged), 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l) as MergedLine]; } catch { return []; } });
    for (const id of o.ids as string[]) {
      const line = lines.find(l => l.id === id);
      const raw = line?.raw ?? '';
      let category: string | undefined, specialist: string | undefined;
      try { const j = JSON.parse(raw); category = typeof j?.category === 'string' ? j.category : undefined; specialist = typeof j?.specialist === 'string' ? j.specialist : undefined; } catch { /* prose */ }
      const gate = gateOf([raw, reasons.get(id) ?? '']);
      out.set(keyOf(id), { key: keyOf(id), reader: String(o.reader), ...(gate ? { gate } : {}), ...(category ? { category } : {}), ...(specialist ? { specialist } : {}) });
    }
  }
  return [...out.values()];
}

/**
 * The check itself. rows: this run's via:ship review-log rows (oldest first); blockers: the keys of the blockers this run's ledgers
 * hold (lib/review-ledger.ts ledgerBlockers); traits: ledgerTraits for every collected finding; rulings: the approved stop rulings.
 */
export function ruledStop(o: { pr: number; run: string; stop?: { head: string; tree?: string; run: string }; rows: readonly Record<string, any>[]; blockers: readonly string[]; traits: readonly LedgerTrait[]; rulings: readonly StopRuling[] }): RuledStop {
  const mine = o.rulings.filter(r => r.pr === o.pr);
  const unbound = (why: string): RuledStop => ({ state: 'unbound', why, findings: [], unmatched: mine });
  const s = o.stop;
  if (!s || !s.tree) return unbound('the PR body holds no stop record; gstack-ship-receipt stop records the stop this run is answering');
  if (s.run !== o.run) return unbound(`the newest stop record is run ${s.run}'s, not this run's (${o.run}): a ruling closes a finding only in the run that stopped on it`);
  const atStop = o.rows.filter(r => (r.skill === 'review' || r.skill === 'adversarial-review') && String(r.commit_full ?? '').toLowerCase() === s.head);
  if (!atStop.some(r => r.skill === 'review')) return unbound(`no review row of this run at the stop head ${s.head.slice(0, 12)}`);
  const loose = atStop.find(r => !bound(r, s.tree!));
  if (loose) return unbound(`the ${loose.skill} row at ${s.head.slice(0, 12)} is not bound to the stop's tree on a clean worktree (binding ${loose.review_binding?.state ?? 'missing'}): a ruling closes only a finding read on that commit`);
  const traits = new Map(o.traits.map(t => [t.key, t]));
  const settled = new Set(o.rows.flatMap(r => (Array.isArray(r.findings) ? r.findings : []).filter((f: any) => f && typeof f.ledger_id === 'string' && (FIXED.has(f.action) || f.blocking === false)).map((f: any) => f.ledger_id as string)));
  const open = new Map<string, { gate: boolean; security: boolean; named: boolean }>();
  for (const r of atStop) for (const f of (Array.isArray(r.findings) ? r.findings : []) as Record<string, any>[]) {
    if (!f || typeof f !== 'object' || !blocks(f) || FIXED.has(f.action)) continue;
    const id = typeof f.ledger_id === 'string' && f.ledger_id ? f.ledger_id : `${String(f.fingerprint ?? '?')} (no ledger id)`;
    const t = traits.get(id);
    open.set(id, { gate: !!f.gate || !!f.gate_id || !!t?.gate, security: [f.category, f.specialist, f.raised_by, t?.category, t?.specialist].some(c => typeof c === 'string' && SECURITY.test(c)), named: typeof f.ledger_id === 'string' && !!f.ledger_id });
  }
  for (const key of o.blockers) {
    if (settled.has(key) || open.has(key)) continue;
    const t = traits.get(key);
    open.set(key, { gate: !!t?.gate, security: [t?.category, t?.specialist, t?.reader].some(c => typeof c === 'string' && SECURITY.test(c)), named: true });
  }
  const findings: OpenFinding[] = [...open].sort(([a], [b]) => a.localeCompare(b)).map(([id, f]) => {
    const ruling = [...mine].reverse().find(r => r.finding === id && r.head === s.head && r.stop_run === s.run);
    const why = !f.named ? 'unnamed' : f.gate ? 'gated' : f.security ? 'security' : ruling ? 'ruled' : 'open';
    return { id, why, ...(ruling && why === 'ruled' ? { ruling } : {}) };
  });
  const used = new Set(findings.flatMap(f => (f.ruling ? [f.ruling.approval] : [])));
  const unmatched = mine.filter(r => !used.has(r.approval));
  const stop = { head: s.head, tree: s.tree, run: s.run };
  if (!findings.length) return { state: 'none', why: 'the stop holds no open finding to rule', stop, findings, unmatched };
  return { state: findings.every(f => f.why === 'ruled') ? 'closed' : 'open', stop, findings, unmatched };
}

const LABEL: Record<OpenFinding['why'], string> = {
  ruled: 'ruled',
  open: 'open: no stop ruling names it',
  gated: 'RULING_GATED: a gate finding takes a gate disposition (gstack-approvals gate), never a ruling',
  security: 'RULING_SECURITY_CLASS: a security-class blocker is fixed, or the PR parks with its owner',
  unnamed: 'open: the row names no ledger id, so no ruling can name it',
};

/** The lines gstack-ship-receipt ruled-stop prints, the RULED_STOP: line last. */
export function ruledStopLines(r: RuledStop, pr: number): string[] {
  const lines = r.findings.map(f => `RULED_STOP_FINDING: ${f.id} ${LABEL[f.why]}${f.ruling ? ` by ${f.ruling.by} (approval ${f.ruling.approval})` : ''}`);
  for (const u of r.unmatched) lines.push(`RULED_STOP_RULING: ${u.finding} at ${u.head.slice(0, 12)} run ${u.stop_run} (approval ${u.approval}): not applied, it names no open finding of this stop`);
  const open = r.findings.filter(f => f.why !== 'ruled').length;
  const s = r.stop;
  lines.push(r.state === 'closed' ? `RULED_STOP: closed run=${s!.run} head=${s!.head} tree=${s!.tree} ids=${r.findings.map(f => f.id).join(',')}`
    : r.state === 'open' ? `RULED_STOP: open ${open} of ${r.findings.length} at ${s!.head.slice(0, 12)}: the owner rules each open one with gstack-approvals rule --pr ${pr} --stop-run ${s!.run} --head ${s!.head} --finding <id> --reason '<why>' --words '<owner\'s exact words>' --by '<owner>', outside this run`
    : `RULED_STOP: ${r.state} (${r.why})`);
  return lines;
}
