/**
 * approval-record — the per-thread approval record gstack keeps for Capy
 * Captains (capy/skill/gstack/captain.md): one row per answer, with the date,
 * what was asked, the person's exact words, who said them, what the answer
 * covers, what is still pending and the outcome. bin/gstack-approvals is the
 * CLI; /ship pastes `render` into the PR body as `## Approvals` and a crew
 * thread pastes it into its report.
 *
 * The record is display and audit only. It is not an approval citation
 * (lib/approval-citations.ts stays the one enforced mechanism): every cell is
 * escaped so the rendered table cannot be parsed as an `Approved by ...`
 * citation, a mention, an image or hidden HTML.
 *
 * Storage: `<state root>/projects/<slug>/approvals/<branch key>.jsonl`, the
 * branch key being a readable prefix plus a hash of the exact ref (no two
 * branches share a file, and the key is always one contained path segment).
 * On Capy (GSTACK_CAPY=1) the state root is thrown away with the machine, so
 * every write is mirrored: to GSTACK_APPROVALS_DIR when set, else to the
 * directory the Captain named by creating `approvals/` in its drive
 * (`~/.capy/drive/captain-<name>/approvals/<slug>/<branch key>.jsonl`, which every
 * crew thread can read), else to the private project-user Drive folder
 * (`<drive>/approvals/<slug>/<branch key>.jsonl`). GSTACK_APPROVALS_MIRROR=0
 * turns the mirror off. Reads take the union of both. Every field passes the
 * secret scanner before anything is written.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capyDriveFolder } from './autoplan-checkpoint';
import { reviewedPlan } from './captain-brief';
import { slugFromEnvironment } from './bin-context';
import { firstTitle } from './markdown-sections';
import { scan } from './redact-engine';
import type { ResultCodeName } from './result-codes';
import { resolveStateRoot } from './state-root';

export const OUTCOMES = ['approved', 'rejected', 'pending', 'standing'] as const;
export type Outcome = typeof OUTCOMES[number];
export const CAPS = { ask: 300, words: 2000, scope: 300, pending: 300, by: 120, source: 200 } as const;

export interface ApprovalRow {
  schema_version: 1; id: string; date: string; ask: string; words: string; by: string;
  scope: string; pending: string; outcome: Outcome; source: string; branch: string; recorded_at: string;
}
export type MirrorSource = 'GSTACK_APPROVALS_DIR' | 'captain drive' | 'project-user drive';
/** `mirror` is written and read; `read_also` are the other mirror roots' copies, read so a row mirrored under an earlier rule stays visible. */
export interface StoreLocation { file: string; mirror?: string; mirror_source?: MirrorSource; read_also?: string[]; branch: string; slug: string; ephemeral: boolean }
export interface RecordError { code: ResultCodeName; message: string }
export type Env = NodeJS.ProcessEnv;

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });

/** A branch this checkout knows: a local head or an origin remote-tracking ref. */
export function branchExists(cwd: string, branch: string): boolean {
  return [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].some(ref => git(cwd, ['rev-parse', '--verify', '--quiet', ref]).status === 0);
}

/** One contained path segment for a branch: readable prefix plus a hash of the exact ref. */
export function branchKey(branch: string): string {
  const readable = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'branch';
  return `${readable}-${createHash('sha256').update(branch).digest('hex').slice(0, 10)}`;
}

function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Where this branch's record lives, and its mirror. */
export function locate(o: { cwd: string; env: Env; branch?: string }): StoreLocation | RecordError {
  let branch = o.branch?.trim();
  if (!branch) {
    const r = git(o.cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    branch = r.status === 0 ? r.stdout.trim() : '';
  }
  if (!branch) return { code: 'APPROVAL_RECORD_NO_BRANCH', message: `no branch at ${o.cwd} (detached HEAD or not a git repository)` };
  const stateRoot = resolveStateRoot(o.env);
  const slug = slugFromEnvironment(stateRoot, o.cwd) || 'unknown';
  const dir = path.join(stateRoot, 'projects', slug, 'approvals');
  const file = path.join(dir, `${branchKey(branch)}.jsonl`);
  if (!contained(stateRoot, file)) return { code: 'APPROVAL_RECORD_INVALID', message: `record path escapes the state root: ${file}` };
  // Every mirror root this machine can see, best first; the first is written, the rest are read so a
  // row mirrored before the Captain created approvals/ (or under an explicit directory) stays visible.
  const roots: Array<[MirrorSource, string]> = [];
  if (o.env.GSTACK_APPROVALS_DIR) roots.push(['GSTACK_APPROVALS_DIR', o.env.GSTACK_APPROVALS_DIR]);
  if (o.env.GSTACK_CAPY === '1' && o.env.GSTACK_APPROVALS_MIRROR !== '0') {
    const captain = captainApprovalsDir(o.env);
    if (captain) roots.push(['captain drive', captain]);
    const top = git(o.cwd, ['rev-parse', '--show-toplevel']);
    const folder = capyDriveFolder(o.env, top.status === 0 ? path.basename(top.stdout.trim()) : undefined);
    if (folder) roots.push(['project-user drive', path.join(path.dirname(folder), 'approvals')]);
  }
  const rel = path.join(slug, `${branchKey(branch)}.jsonl`);
  for (const [, root] of roots) if (!contained(root, path.join(root, rel))) return { code: 'APPROVAL_RECORD_INVALID', message: `mirror path escapes ${root}` };
  const [chosen, ...rest] = roots;
  return {
    file, mirror: chosen ? path.join(chosen[1], rel) : undefined, mirror_source: chosen?.[0], read_also: rest.map(([, root]) => path.join(root, rel)),
    branch, slug, ephemeral: o.env.GSTACK_EPHEMERAL === '1',
  };
}

/**
 * The approvals directory a Captain named for its crew: exactly one mounted Captain drive
 * (`~/.capy/drive/captain-*`) holding an `approvals/` directory. Two Captains with one each
 * is ambiguous, so neither is taken and the private project-user folder stays the mirror.
 */
export function captainApprovalsDir(env: Env): string | undefined {
  if (env.GSTACK_CAPY !== '1') return undefined;
  const drive = path.join(env.HOME || os.homedir(), '.capy', 'drive');
  let found: string[];
  try {
    found = fs.readdirSync(drive).filter(d => d.startsWith('captain-')).map(d => path.join(drive, d, 'approvals')).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch { return undefined; }
  return found.length === 1 ? found[0] : undefined;
}

function readRows(file: string | undefined): ApprovalRow[] {
  if (!file || !fs.existsSync(file)) return [];
  const rows: ApprovalRow[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.schema_version === 1 && typeof r.id === 'string') rows.push(r as ApprovalRow); } catch { /* a torn tail line is skipped, never repaired */ }
  }
  return rows;
}

export interface ReadResult { rows: ApprovalRow[]; state: 'present' | 'empty' | 'unavailable'; restored: boolean }

/** The union of the local record and its mirror (local wins on the same id), oldest first. */
export function readRecord(loc: StoreLocation): ReadResult {
  const local = readRows(loc.file);
  const mirrored = readRows(loc.mirror);
  const byId = new Map<string, ApprovalRow>();
  for (const r of [...(loc.read_also ?? []).flatMap(readRows), ...mirrored, ...local]) byId.set(r.id, r);
  const rows = [...byId.values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const known = fs.existsSync(loc.file) || (loc.mirror !== undefined && fs.existsSync(loc.mirror));
  const state = rows.length ? 'present' : known || !loc.ephemeral || loc.mirror ? 'empty' : 'unavailable';
  return { rows, state, restored: !fs.existsSync(loc.file) && mirrored.length > 0 };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export interface NewRow { ask: string; words: string; by: string; scope: string; pending?: string; outcome?: string; date?: string; source?: string }

/** Validate and secret-scan one row; the error names the field and rule, never the text. */
export function buildRow(input: NewRow, branch: string, now = new Date()): ApprovalRow | RecordError {
  const fields = { ask: input.ask, words: input.words, by: input.by, scope: input.scope, pending: input.pending ?? 'none', source: input.source ?? 'manual' };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string' || !v.trim()) return { code: 'APPROVAL_RECORD_INVALID', message: `--${k} is required` };
    const cap = CAPS[k as keyof typeof CAPS];
    if (v.length > cap) return { code: 'APPROVAL_RECORD_INVALID', message: `--${k} is ${v.length} characters (cap ${cap})` };
  }
  const outcome = (input.outcome ?? 'approved') as Outcome;
  if (!OUTCOMES.includes(outcome)) return { code: 'APPROVAL_RECORD_INVALID', message: `--outcome must be one of ${OUTCOMES.join('|')}` };
  const date = input.date ?? now.toISOString().slice(0, 10);
  if (!validDate(date)) return { code: 'APPROVAL_RECORD_INVALID', message: `--date must be a real YYYY-MM-DD day` };
  for (const [k, v] of Object.entries(fields)) {
    const s = scan(v);
    const hits = s.findings.filter(f => f.severity === 'HIGH' || f.severity === 'MEDIUM');
    if (s.oversize || hits.length) return { code: 'APPROVAL_RECORD_SECRET', message: `field ${k}: ${s.oversize ? 'oversize input' : [...new Set(hits.map(f => f.id))].join(', ')}` };
  }
  const id = 'a-' + createHash('sha256').update([fields.source, date, fields.ask, fields.words, fields.by].join('\u0000')).digest('hex').slice(0, 12);
  return { schema_version: 1, id, date, ask: fields.ask.trim(), words: fields.words.trim(), by: fields.by.trim(), scope: fields.scope.trim(), pending: fields.pending.trim(), outcome, source: fields.source, branch, recorded_at: now.toISOString() };
}

function writeMirror(loc: StoreLocation, rows: ApprovalRow[]): RecordError | undefined {
  if (!loc.mirror) return undefined;
  try {
    fs.mkdirSync(path.dirname(loc.mirror), { recursive: true, mode: 0o700 });
    const tmp = `${loc.mirror}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, loc.mirror);
    return undefined;
  } catch (e: any) { return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `mirror ${loc.mirror}: ${e.code ?? e.message} (the local row is kept)` }; }
}

export interface AppendResult { added: ApprovalRow[]; skipped: number; mirrorError?: RecordError }

/** Append rows not already present (by id) as single-line appends, then mirror the merged record. */
export function appendRows(loc: StoreLocation, rows: ApprovalRow[]): AppendResult | RecordError {
  const have = new Set(readRecord(loc).rows.map(r => r.id));
  const fresh = rows.filter(r => !have.has(r.id));
  try {
    fs.mkdirSync(path.dirname(loc.file), { recursive: true, mode: 0o700 });
    for (const r of fresh) fs.appendFileSync(loc.file, JSON.stringify(r) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (e: any) { return { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `${loc.file}: ${e.code ?? e.message}` }; }
  const mirrorError = writeMirror(loc, readRecord(loc).rows);
  return { added: fresh, skipped: rows.length - fresh.length, ...(mirrorError ? { mirrorError } : {}) };
}

/** Re-mirror the merged record (after a failed mirror write, or to restore a local copy from the mirror). */
export function syncRecord(loc: StoreLocation): { rows: number; error?: RecordError } {
  const { rows } = readRecord(loc);
  try {
    fs.mkdirSync(path.dirname(loc.file), { recursive: true, mode: 0o700 });
    const tmp = `${loc.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, loc.file);
  } catch (e: any) { return { rows: rows.length, error: { code: 'APPROVAL_RECORD_WRITE_FAILED', message: `${loc.file}: ${e.code ?? e.message}` } }; }
  const error = writeMirror(loc, rows);
  return { rows: rows.length, ...(error ? { error } : {}) };
}

/** One Markdown table cell: no row breaks, mentions, images, links, HTML, code spans or citation-shaped text. */
export function cell(text: string, cap = 400): string {
  const clipped = text.length > cap ? text.slice(0, cap - 1).trimEnd() + '…' : text;
  return clipped
    .replace(/\r?\n+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;').replace(/\`/g, '&#96;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/!/g, '&#33;')
    .replace(/\|/g, '\\|')
    .replace(/(approved)(\s+)(by)/gi, '$1&#32;$3');
}

/** The rendered table's header row and the footer's closing words; lib/ship-receipt-prose.ts recognizes the block by them. */
export const APPROVALS_TABLE_HEADER = '| Date | Asked | Exact words | Outcome | Covers | Still pending |';
export const APPROVALS_FOOTER_END = '(display only; not an approval citation).';

export function renderRecord(read: ReadResult, loc: StoreLocation, o: { heading?: boolean } = {}): string {
  const head = o.heading === false ? [] : ['## Approvals', ''];
  if (read.state === 'unavailable') return [...head, `Record unavailable on this machine: no approval record for branch ${cell(loc.branch)} here, and the state root is ephemeral with no Drive mirror, so this is not proof that nothing was approved.`, ''].join('\n');
  if (!read.rows.length) return [...head, `No approvals recorded for branch ${cell(loc.branch)}.`, ''].join('\n');
  const lines = [APPROVALS_TABLE_HEADER, '|---|---|---|---|---|---|'];
  for (const r of read.rows) {
    const outcome = r.outcome === 'standing' ? 'standing approval' : r.outcome;
    lines.push(`| ${r.date} | ${cell(r.ask)} | “${cell(r.words, 280)}” (${cell(r.by)}) | ${outcome} | ${cell(r.scope)} | ${cell(r.pending)} |`);
  }
  return [...head, ...lines, '', `Source: gstack-approvals record for ${cell(loc.branch)} ${APPROVALS_FOOTER_END}`, ''].join('\n');
}

interface DecisionLike { id?: string; title?: string; status?: string; chosen?: string | null; recommended?: string | null; gate_rev?: number; answered_at?: string; answered_by?: string; reply?: string; owner_reply?: string; carried_from?: string; label?: string; chosen_text?: string;
  carried_gate_from?: string; carried_gate_rev?: number; carried_answered_by?: string; carried_under?: string; carry_check?: string }

const stripRef = (t: string) => t.replace(/\s*\[[^\]]*\]\s*$/, '').trim();

/**
 * Rows for every answered gate in an autoplan run: one row per answer event (gate_rev, time, answerer), covering
 * the items it settled. Item answers carried from an earlier revision were recorded when first given and are skipped;
 * a whole gate carried forward (lib/autoplan-carry.ts) gets its own row naming the revision its words came from. Ids are stable,
 * so a rerun (or a retry after an interrupted import) adds nothing twice.
 */
export function importAutoplan(runDir: string, branch: string, by?: string): ApprovalRow[] | RecordError {
  const file = path.join(runDir, 'decisions.jsonl');
  if (!fs.existsSync(file)) return { code: 'BRIEF_INPUT_MISSING', message: `decisions.jsonl not in ${runDir}` };
  const rows: DecisionLike[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { return { code: 'ARTIFACT_MALFORMED_JSONL', message: `decisions.jsonl has a line that is not JSON` }; }
  }
  const run = (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); } catch { return {}; } })();
  const plan = reviewedPlan(runDir, run);
  const planTitle = firstTitle(plan.text) ?? 'the plan';
  const planSha = plan.sha;
  const runId = String(run.run ?? run.id ?? path.basename(runDir));
  const answered = rows.filter(r => r.status && r.status !== 'pending' && r.answered_at && !r.carried_from);
  if (!answered.length) return { code: 'APPROVAL_IMPORT_UNANSWERED', message: `no answered gate in ${runDir}` };
  const groups = new Map<string, DecisionLike[]>();
  for (const r of answered) {
    const k = [r.gate_rev, r.answered_at, r.answered_by].join('|');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: ApprovalRow[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const rev = first.gate_rev ?? 0;
    const p1 = group.find(r => (r.label ?? '').toLowerCase() === 'p1' || (r.id ?? '').endsWith('-p1'));
    const outcome: Outcome = !p1 ? 'pending' : p1.chosen === 'a' || p1.chosen === 'b' ? 'approved' : p1.chosen === 'e' ? 'rejected' : 'pending';
    const items = group.filter(r => r !== p1);
    const changed = items.filter(r => r.chosen && r.recommended && r.chosen !== r.recommended);
    const stillPending = rows.filter(r => r.gate_rev === rev && r.status === 'pending');
    const answerer = first.answered_by ?? 'unknown';
    const carried = p1?.carried_gate_from ? p1 : undefined;
    const relayed = carried?.carried_answered_by && carried.carried_answered_by !== 'human' ? `, relayed by ${carried.carried_answered_by}` : '';
    const who = carried ? `${by ?? 'the owner'} (words from gate_rev ${carried.carried_gate_rev}${relayed}), carried forward by gstack-autoplan`
      : answerer === 'human' ? (by ? `${by}, typed at the gate` : 'the owner, typed at the gate') : `${by ?? 'the owner'}, relayed by ${answerer}`;
    const unseen = items.filter(r => r.carried_under).map(r => stripRef(r.title ?? ''));
    const checked = [...new Set(items.map(r => r.carry_check).filter((c): c is string => !!c))];
    const scope = [`the reviewed plan (sha256 ${planSha}), ${changed.length ? `${changed.length} recommendation(s) changed: ${changed.map(r => stripRef(r.title ?? '')).join('; ')}` : 'every recommendation taken'}`,
      unseen.length ? `taken under "do it", not seen by the owner: ${unseen.join('; ')}` : '', checked.length ? `post-cap delta checked by ${checked.join(', ')}` : ''].filter(Boolean).join('; ');
    const built = buildRow({
      ask: `Approve the plan "${planTitle}" (autoplan run ${runId}, ${carried ? `gate_rev ${rev} carried forward from gate_rev ${carried.carried_gate_rev}, ` : ''}${items.length + (p1 ? 1 : 0)} decisions)`.slice(0, CAPS.ask),
      words: first.owner_reply ?? first.reply ?? '(no words recorded)',
      by: who.slice(0, CAPS.by),
      scope: scope.slice(0, CAPS.scope),
      pending: (stillPending.length ? `${stillPending.length} decision(s) unanswered: ${stillPending.map(r => stripRef(r.title ?? '')).join('; ')}` : outcome === 'pending' ? 'the plan approval itself' : 'none').slice(0, CAPS.pending),
      outcome,
      date: first.answered_at!.slice(0, 10),
      source: `autoplan:${runId}@gate_rev=${rev}`,
    }, branch, new Date(first.answered_at!));
    if ('code' in built) return built;
    out.push(built);
  }
  return out;
}

