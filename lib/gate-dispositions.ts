/**
 * Owner gate dispositions (GST-2491, docs/ship-policy.md#gate-dispositions): the owner's recorded answer to a gate finding
 * (a loosened gate the review logged with a `gate` tag and the hunk identity `gate_id`). An unattended session cannot answer
 * `review-gate-disposition`, so gstack-review-log logs its gate findings `open`; the owner closes one through the approval
 * record instead, with `gstack-approvals gate`, outside the lane's /ship run. A disposition is one approved row with scope
 * `gate_disposition <fingerprint> <gate_id> <head>` and ask `gate_disposition <fingerprint> <gate_id> at <head>: <reason>`,
 * the owner's exact words in `words`, the recorder in `by` and the time in `recorded_at`. A review-log field never makes one.
 *
 * A row counts only with every field the writer writes (`source: gate`, the branch of the store it is in, an approval-shaped id
 * the writer's hash reproduces) and its `digest` over those fields, so a hand-typed or edited row is ignored. The digest catches
 * edits; it is not authentication: a same-user lane can compute it too. What authorizes a disposition is the lander's explicit
 * `--accept-gate-disposition <id>` (`gateAcceptance`, run by `gstack-ship-queue land --pin` and `verify --pin`), re-derived from
 * the store at the pin, never from the receipt or the PR body (docs/ship-policy.md#gate-dispositions).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendRows, locate, readRecord, type ApprovalRow, type Env, type RecordError, type StoreLocation } from './approval-record';
import type { ShipReceipt } from './headless-artifacts';
import type { ResultCodeName } from './result-codes';
import { GSTACK_ACTOR } from './ruled-notes';
import { BIN_DIR, runScriptSync } from './script-invocation';

export interface GateDisposition { finding: string; gate_id: string; head: string; by: string; reason: string; words: string; at: string; approval: string }

const SCOPE = /^gate_disposition (\S+) (\S+) ([0-9a-f]{40})$/;
const ASK = /^gate_disposition (\S+) (\S+) at ([0-9a-f]{40}): (\S(?:.*\S)?)$/;
export const GATE_DISPOSITION_SCOPE = /^\s*gate_disposition\b/;
export const ONE_LINE = /^[^\x00-\x1f\x7f]*$/;
/** The `source` only `gstack-approvals gate` writes. */
export const GATE_SOURCE = 'gate';
const APPROVAL_ID = /^a-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** A gate_id a gate finding can carry: one token, never a stringified missing value. */
export const validGateId = (id: unknown): id is string => typeof id === 'string' && /^\S+$/.test(id) && !/^(?:undefined|null)$/i.test(id);
/** The checksum over a disposition row's canonical fields: it catches an edited or hand-built row, and anyone can compute it. */
export const gateDispositionDigest = (r: Record<string, unknown>) => 'sha256:' + createHash('sha256')
  .update(JSON.stringify(['schema_version', 'id', 'date', 'ask', 'words', 'by', 'scope', 'pending', 'outcome', 'source', 'branch', 'recorded_at'].map(k => r[k] ?? null))).digest('hex');
/** Whether a row has every field the writer writes, in the writer's shape, for the store's own branch. */
function writerShaped(r: Record<string, any>, branch: string): boolean {
  const str = (v: unknown) => typeof v === 'string' && v.trim() === v && v !== '';
  return r.schema_version === 1 && typeof r.id === 'string' && APPROVAL_ID.test(r.id) && r.source === GATE_SOURCE && r.outcome === 'approved' &&
    r.pending === 'none' && str(r.by) && ONE_LINE.test(r.by) && !GSTACK_ACTOR.test(r.by) && str(r.words) && ONE_LINE.test(r.words) && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    typeof r.recorded_at === 'string' && ISO_TIME.test(r.recorded_at) && r.branch === branch && typeof r.ask === 'string' && typeof r.scope === 'string' &&
    r.id === 'a-' + createHash('sha256').update([r.source, r.date, r.ask, r.words, r.by].join('\u0000')).digest('hex').slice(0, 12) &&
    r.digest === gateDispositionDigest(r);
}
/** The key a disposition and a gate finding share: the fingerprint and the hunk identity the gate scan gave it. */
export const gateKey = (finding: unknown, gateId: unknown) => `${finding} ${gateId}`;

export const gateDispositionRow = (finding: string, gateId: string, head: string, reason: string) => ({ scope: `gate_disposition ${finding} ${gateId} ${head}`, ask: `gate_disposition ${finding} ${gateId} at ${head}: ${reason}` });

/**
 * The approved disposition rows of `branch`'s store, one per finding, gate_id and head (the newest wins). A row counts only in
 * the writer's full shape with its digest (`writerShaped`) and a real gate_id; a row gstack wrote is none.
 */
export function gateDispositions(rows: readonly ApprovalRow[], branch: string): GateDisposition[] {
  const byFinding = new Map<string, GateDisposition>();
  for (const r of rows) {
    const scope = SCOPE.exec(r.scope), ask = ASK.exec(r.ask);
    if (!scope || !ask || ask[1] !== scope[1] || ask[2] !== scope[2] || ask[3] !== scope[3] || !validGateId(scope[2]) || !writerShaped(r as Record<string, any>, branch)) continue;
    const [, finding, gate_id, head] = scope as unknown as [string, string, string, string], key = `${finding} ${gate_id} ${head}`;
    byFinding.delete(key);
    byFinding.set(key, { finding, gate_id, head, by: r.by, reason: ask[4]!, words: r.words, at: r.recorded_at, approval: r.id });
  }
  return [...byFinding.values()];
}

/** The dispositions in the checked-out branch's approval record (and its mirror). */
export function readGateDispositions(cwd: string, env: Env = process.env): GateDisposition[] {
  const loc = locate({ cwd, env });
  return 'code' in loc ? [] : gateDispositions(readRecord(loc).rows, loc.branch);
}

/**
 * The dispositions `branch`'s store applies at `pin`: every counted row whose head the pin contains. Throws when the store is
 * unreadable, when the pin is not in this clone, or when a shallow clone cannot prove a row's head is or is not an ancestor. In a
 * full clone a row whose head commit is gone (a rewritten and collected branch, a reused name) is not applied: the pin's history
 * is all present, so a missing commit cannot be in it.
 */
export function appliedGateDispositions(cwd: string, o: { branch?: string; pin: string; env?: Env }): { applied: GateDisposition[]; loc: StoreLocation } {
  const loc = locate({ cwd, env: o.env ?? process.env, branch: o.branch });
  if ('code' in loc) throw new Error(loc.message);
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (git('cat-file', '-e', `${o.pin}^{commit}`).status !== 0) throw new Error(`the pin ${o.pin.slice(0, 12)} is not a commit in this clone; fetch it and rerun`);
  let shallow: boolean | undefined;
  const contains = (head: string) => {
    const r = git('merge-base', '--is-ancestor', head, o.pin);
    if (r.status === 0) return true;
    shallow ??= git('rev-parse', '--is-shallow-repository').stdout?.trim() !== 'false';
    if (shallow) throw new Error(`this clone is shallow, so whether disposition head ${head.slice(0, 12)} is in the pin's history cannot be proved; deepen the clone (git fetch --unshallow) and rerun`);
    if (r.status === 1 || git('cat-file', '-e', `${head}^{commit}`).status !== 0) return false;
    throw new Error(`git merge-base --is-ancestor ${head.slice(0, 12)} ${o.pin.slice(0, 12)} failed (${(r.stderr ?? r.error?.message ?? '').trim().slice(0, 120) || `exit ${r.status}`})`);
  };
  return { applied: gateDispositions(readRecord(loc).rows, loc.branch).filter(d => contains(d.head)), loc };
}

/**
 * The /ship runs open on `branch` in any worktree of this repository (found through the git common dir); a detached worktree's run
 * counts too. A marker counts while its run's lease is open (`gstack-lease open`, the test preflight uses), so a run parked before
 * finish stops counting once its 120-minute lease ends; a lease check that cannot run counts the marker as open.
 */
export function openShipRunsOn(cwd: string, branch: string): string[] {
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (list.status !== 0) return [`unknown (git worktree list failed: ${(list.stderr ?? '').trim().slice(0, 120)})`];
  const here = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? '';
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const open: string[] = [];
  for (const block of list.stdout.split(/\n\n+/).filter(b => b.trim())) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const on = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!dir || /^bare$/m.test(block) || (on !== undefined && on !== branch)) continue;
    const marker = spawnSync('git', ['rev-parse', '--git-path', 'gstack-ship-run'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    if (marker.status !== 0 || !marker.stdout.trim()) continue;
    let run = '';
    try { run = fs.readFileSync(path.resolve(dir, marker.stdout.trim()), 'utf8').trim(); } catch { continue; }
    if (!run || runScriptSync(path.join(BIN_DIR, 'gstack-lease'), ['open', '--root', dir, '--run', run], { cwd: dir, encoding: 'utf8', timeout: 60_000 }).status === 1) continue;
    open.push(real(dir) === real(here) ? `${run} is open on this checkout` : `${run} is open in the worktree ${dir}`);
  }
  return open;
}

/** Run `fn` holding the repository's gate-disposition lock (a directory in the git common dir; one older than a minute is stale). */
export function withGateLock<T>(cwd: string, fn: () => T, waitMs = 15_000): T | RecordError {
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 10_000 });
  if (common.status !== 0 || !common.stdout.trim()) return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `no git common dir at ${cwd}, so the gate-disposition lock cannot be taken` };
  const lock = path.join(path.resolve(cwd, common.stdout.trim()), 'gstack-gate-disposition.lock');
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e: any) {
      if (e.code !== 'EEXIST') return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `${lock}: ${e.code ?? e.message}` };
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > until) return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `${lock} is held; another gate disposition or /ship preflight is writing (rerun in a moment)` };
      Bun.sleepSync(100);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** Append one disposition row under the lock, refused while any /ship run is open on its branch in any worktree (the check and the append are one step). */
export function recordGateDisposition(cwd: string, loc: StoreLocation, row: ApprovalRow): ReturnType<typeof appendRows> {
  const signed = { ...row, digest: gateDispositionDigest(row as unknown as Record<string, unknown>) } as ApprovalRow;
  if (!gateDispositions([signed], loc.branch).length) return { code: 'APPROVAL_RECORD_INVALID', message: 'the row would not count as a gate disposition (gstack-approvals dispositions would not list it: a 40-hex --head and one-line fields are required), so it would close nothing; nothing was written' };
  const held = withGateLock(cwd, () => {
    const open = openShipRunsOn(cwd, loc.branch);
    if (open.length) return { code: 'APPROVAL_RECORD_INVALID' as const, message: `/ship run ${open.join('; /ship run ')} (branch ${loc.branch}): a gate disposition is the owner's, never the lane's own runner's; record it from the owner's session once no /ship run is open on the branch` };
    return appendRows(loc, [signed]);
  });
  return held;
}

export type GateAcceptanceCode = Extract<ResultCodeName, 'QUEUE_GATE_DISPOSITION'>;
/**
 * The lander's check (docs/ship-policy.md#gate-dispositions), one function for `land --pin`, `verify --pin` and `ready`: the
 * dispositions `branch`'s store applies at `pin`, re-derived here, each printed as GATE_DISPOSITION. It refuses when the
 * receipt's gate_dispositions or the PR body's `Gate disposition:` lines differ from them, and, with `accepted` (land and
 * verify; ready passes none), when an applied disposition is not accepted or an accepted id is not applied.
 */
export function gateAcceptance(o: { cwd: string; branch: string; pin: string; body: string; receipt?: ShipReceipt; accepted?: readonly string[]; env?: Env }):
  { lines: string[]; applied: GateDisposition[]; failure?: { code: GateAcceptanceCode; message: string; fix: string } } {
  const fix = 'the lander reads each GATE_DISPOSITION line and reruns with --accept-gate-disposition <approval id> for each one it accepts; a receipt or body that differs from the store is rewritten by /ship at the pin (docs/troubleshooting.md#queue-gate-disposition)';
  let got: ReturnType<typeof appliedGateDispositions>;
  try { got = appliedGateDispositions(o.cwd, o); }
  catch (e: any) { return { lines: [], applied: [], failure: { code: 'QUEUE_GATE_DISPOSITION', message: `the gate dispositions for ${o.branch} at the pin cannot be derived (${e.message}); an unreadable store or a git error refuses, never reads as none`, fix } }; }
  const { applied, loc } = got;
  const recorded = o.receipt?.gate_dispositions;
  const listed = recorded ?? [];
  const where = `the store at ${loc.mirror ?? loc.file}`;
  const lines = applied.map(d => `GATE_DISPOSITION: ${gateDispositionText(d)}`);
  if (!applied.length && !listed.length && !o.accepted?.length) return { lines, applied };
  const problems: string[] = [];
  for (const d of applied) {
    const r = listed.find(l => l.approval === d.approval);
    if (!r) problems.push(recorded ? `the receipt omits applied disposition ${d.approval}` : `the receipt has no gate_dispositions field (written before receipts always recorded it, or edited), but ${where} applies disposition ${d.approval}`);
    else if (gateDispositionText(r as GateDisposition) !== gateDispositionText(d)) problems.push(`the receipt's disposition ${d.approval} differs from the store's row`);
    if (!o.body.split(/\r?\n/).some(b => b.trim() === `Gate disposition: ${gateDispositionText(d)}`)) problems.push(`the PR body lacks the line "Gate disposition: ${gateDispositionText(d)}"`);
  }
  for (const l of listed) if (!applied.some(d => d.approval === l.approval)) problems.push(`the receipt lists disposition ${l.approval}, which ${where} does not apply at ${o.pin.slice(0, 12)}: this lander may read another GSTACK_STATE_ROOT or approvals mirror than the one the owner recorded into (set GSTACK_APPROVALS_DIR to it), or the row was removed after the receipt was written`);
  if (o.accepted) {
    for (const d of applied) if (!o.accepted.includes(d.approval)) problems.push(`disposition ${d.approval} is not accepted (--accept-gate-disposition ${d.approval})`);
    for (const id of o.accepted) if (!applied.some(d => d.approval === id)) problems.push(`--accept-gate-disposition ${id} names no disposition the store applies at ${o.pin.slice(0, 12)}`);
  }
  lines.push(`GATE_DISPOSITIONS: applied=${applied.map(d => d.approval).join(',') || 'none'}${o.accepted ? ` accepted=${o.accepted.join(',') || 'none'}` : ''} store=${loc.mirror ?? loc.file}`);
  return problems.length ? { lines, applied, failure: { code: 'QUEUE_GATE_DISPOSITION', message: problems.join('; '), fix } } : { lines, applied };
}

/** The one-line form finish prints after `GATE_DISPOSITION: ` and the PR body carries after `Gate disposition: `. */
export const gateDispositionText = (d: GateDisposition) => `${d.finding} [gate ${d.gate_id}] at ${d.head.slice(0, 12)} by ${d.by} at ${d.at}: ${d.reason} — "${d.words}" (approval ${d.approval})`;

/**
 * The dispositions that close a review row's gate findings: the same fingerprint and gate_id on a gate finding the logger left
 * `open` (or that gstack-review-read already shows kept for a non-interactive actor, which only a disposition produces), recorded
 * at a head inside the row's `range_base..commit_full` (both ends included, the test rulings and review_loop_grant use), or at the
 * row's own commit when the row has no range_base (a first pass). The approval row decides; nothing on the review row counts.
 */
export function dispositionedOn(cwd: string, row: Record<string, any>, dispositions: readonly GateDisposition[]): GateDisposition[] {
  const open = new Set((Array.isArray(row?.findings) ? row.findings : [])
    .filter((f: any) => !!f && typeof f.gate === 'string' && f.gate && typeof f.fingerprint === 'string' && validGateId(f.gate_id) && (f.action === 'open' || (f.action === 'kept' && f.actor !== 'interactive')))
    .map((f: any) => gateKey(f.fingerprint, f.gate_id)));
  const mine = dispositions.filter(d => open.has(gateKey(d.finding, d.gate_id)));
  if (!mine.length) return [];
  const commitOf = (c: unknown) => typeof c === 'string' && /^[0-9a-f]{7,40}$/.test(c) ? spawnSync('git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], { cwd, encoding: 'utf8', timeout: 10_000 }).stdout?.trim() ?? '' : '';
  const ancestor = (a: string, d: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, d], { cwd, timeout: 10_000 }).status === 0;
  const to = commitOf(row.commit_full), from = row.range_base == null ? '' : commitOf(row.range_base);
  if (!to || (row.range_base != null && !from)) return [];
  return mine.filter(d => from ? ancestor(from, d.head) && ancestor(d.head, to) : d.head === to);
}

/**
 * gstack-review-read's view of a row the owner's dispositions close: each such gate finding reads `kept` with the disposition's
 * reason and approval id, so /ship's existing gate rules (`--blocking-open`, `--gate-open`, the draft state, the Gate edits
 * counts) treat it as kept. The review log itself keeps `open`.
 */
export function showDispositioned(row: Record<string, any>, closed: readonly GateDisposition[]): void {
  if (!closed.length || !Array.isArray(row.findings)) return;
  row.gate_dispositions = closed.map(d => d.approval);
  for (const f of row.findings) {
    const d = f && typeof f.gate === 'string' && f.gate ? closed.find(c => gateKey(c.finding, c.gate_id) === gateKey(f.fingerprint, f.gate_id)) : undefined;
    if (d) Object.assign(f, { action: 'kept', reason: `owner disposition ${d.approval}: ${d.reason}`, disposition: d.approval });
  }
}
