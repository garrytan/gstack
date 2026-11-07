/**
 * GST-1699: /ship's own share of a Capy thread tree. A /ship subagent can read only the root
 * thread ("this"), whose counter holds the lane's own work and every sibling as well, so a cap on
 * that counter stops /ship for spend that is not its own. `--thread <file>` hands the helper the
 * whole `tools.thread.get` result instead of one number: the root counter (`tree=`), and the
 * `tasks` rows, one per subagent in the tree, each with the cost of its own subtree. /ship's own
 * row is the subagent it runs in, found by the brief's GSTACK_SHIP_TASK_TITLE or as the parent of
 * a subagent this run created (`dispatched`, the titles the pass program writes). That row,
 * readers included, is what `used=` counts, but only on a reading where exactly one row matches
 * every piece of the run's identity. Any ambiguity (a title that matches no row or two, readers
 * under two parents, a missing row, a caller under another title, a command that names neither a
 * title nor readers, a matched row that is not working) meters that reading on the tree instead, labelled METER_FALLBACK: the run can
 * over-count, never under-count, and never stops or refuses for ambiguity.
 */
import * as fs from 'node:fs';
import { budgetError, usageError, type Ledger } from './ship-budget';

interface Row { label: string; title: string; tokens: number; credits: number; status?: string }
interface Snapshot { tokens: number; credits: number; rows: Row[]; total: number; dispatched: string[] }
type Cost = { tokens: number; credits: number };

export interface ShipMeter {
  /** The tasks row holding /ship's own work (its subagent and that subagent's readers), once found. */
  label?: string;
  task_title?: string;
  /** Titles of subagents this run created, collected from every snapshot's `dispatched`. */
  dispatched: string[];
  /** The rows listed at the run's first snapshot: only rows absent here can be this run's readers. */
  start_rows: Record<string, Cost>;
  /** The row and its cost at the last reading metered on it; absent after a tree reading. */
  row?: Cost & { label: string };
  tree: { baseline: number; last: number; credits?: number };
  /** Why the run still meters the tree. */
  fallback?: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function readSnapshot(file: string): Snapshot {
  let doc: any;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw usageError(`--thread ${file}: ${(e as Error).message}; fix: write the tools.thread.get result with tools.capy.write in the program that runs this command`); }
  const tokens = num(doc?.cost?.tokens), credits = num(doc?.cost?.credits);
  if (tokens === null || credits === null) throw usageError(`--thread ${file}: cost.tokens and cost.credits must be numbers (a tools.thread.get result)`);
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const rows: Row[] = [];
  for (const t of tasks) {
    const rt = num(t?.cost?.tokens), rc = num(t?.cost?.credits);
    if (typeof t?.label !== 'string' || typeof t?.title !== 'string' || rt === null || rc === null) throw usageError(`--thread ${file}: every tasks row needs label, title and cost.tokens/credits`);
    rows.push({ label: t.label, title: t.title, tokens: rt, credits: rc, ...(typeof t.status === 'string' ? { status: t.status } : {}) });
  }
  const dispatched = Array.isArray(doc.dispatched) ? doc.dispatched.filter((x: unknown): x is string => typeof x === 'string') : [];
  return { tokens, credits, rows, total: num(doc.tasks_total) ?? rows.length, dispatched };
}

/** Rows this run can have created: absent from its first snapshot. An earlier /ship's readers carry the same titles. */
const newRows = (m: ShipMeter, s: Snapshot) => s.rows.filter(r => !(r.label in m.start_rows));
const parentOf = (label: string) => label.replace(/\.\d+$/, '');

/**
 * The row this reading may meter: the one label every piece of identity points at. The run's
 * stored title, the caller's title, and the parents of the readers this run created each name
 * a row; a title matching zero or several rows, two different rows, a row other than the one
 * metered before, or a caller that names neither a title nor this pass's readers is ambiguous.
 */
function identify(m: ShipMeter, s: Snapshot, caller: string | undefined): { label: string } | { reason: string } {
  const truncated = s.total > s.rows.length ? `; the snapshot lists ${s.rows.length} of ${s.total} rows` : '';
  if (caller !== undefined && m.task_title !== undefined && caller !== m.task_title) return { reason: `this command's task title "${caller}" is not the run's "${m.task_title}" (a replacement /ship subagent or a RECOVER under a new title)` };
  const title = m.task_title ?? caller;
  const candidates = new Set<string>();
  if (title !== undefined) {
    const hits = s.rows.filter(r => r.title === title);
    if (hits.length !== 1) return { reason: `${hits.length} rows carry the task title "${title}"${truncated}` };
    candidates.add(hits[0]!.label);
  }
  const created = newRows(m, s);
  const readers = created.filter(r => m.dispatched.includes(r.title));
  if (readers.some(r => parentOf(r.label) === r.label)) return { reason: "this run's readers are top-level subagents, so /ship runs on the root thread, whose own counter also holds the lane's work" };
  for (const r of readers) candidates.add(parentOf(r.label));
  if (candidates.size === 0) return { reason: `no subagent this run created is listed yet (its row is found from its first reader)${truncated}` };
  if (candidates.size > 1) return { reason: `the run's identity points at ${[...candidates].join(', ')}` };
  const [label] = candidates as Set<string>;
  if (m.label !== undefined && m.label !== label) return { reason: `the run metered ${m.label} and this reading points at ${label}` };
  const row = s.rows.find(r => r.label === label);
  if (!row) return { reason: `${label} is not among the ${s.rows.length} of ${s.total} rows listed` };
  if (row.status !== undefined && row.status !== 'working') return { reason: `${label} is ${row.status}, so the subagent running this command is not that row (a replacement /ship subagent under the run's title)` };
  const confirmed = caller !== undefined || created.some(r => s.dispatched.includes(r.title) && parentOf(r.label) === label);
  if (!confirmed) return { reason: `this command names no task title and no readers of its own, so it cannot show it runs in ${label}` };
  return { label };
}

/**
 * Turn a snapshot into this command's reading: a counter that grows by /ship's own row between two
 * readings that both identified that row, and by the tree's growth otherwise (the reading that first
 * identifies the row included). It never goes down, so the cap can over-count but never under-count.
 */
export function threadReading(l: Ledger, file: string, taskTitle?: string): { reading: number; credits: number; lines: string[]; readers?: Cost & { n: number } } {
  const s = readSnapshot(file);
  const fresh = !l.ship_meter;
  const m: ShipMeter = l.ship_meter ??= {
    dispatched: [], start_rows: Object.fromEntries(s.rows.map(r => [r.label, { tokens: r.tokens, credits: r.credits }])),
    tree: { baseline: s.tokens, last: s.tokens, credits: s.credits }, ...(taskTitle ? { task_title: taskTitle } : {}),
  };
  if (s.tokens < m.tree.last) throw budgetError('BUDGET_READING_REJECTED', `--thread ${file}: tree reading ${s.tokens} is below the run's last tree reading ${m.tree.last}`);
  const tree = { tokens: s.tokens - m.tree.last, credits: Math.max(0, s.credits - (m.tree.credits ?? s.credits)) };
  m.tree.last = s.tokens;
  m.tree.credits = s.credits;
  for (const t of s.dispatched) if (!m.dispatched.includes(t)) m.dispatched.push(t);
  const readers = s.dispatched.length ? newRows(m, s).filter(r => s.dispatched.includes(r.title)).reduce((a, r) => ({ n: a.n + 1, tokens: a.tokens + r.tokens, credits: Math.round((a.credits + r.credits) * 100) / 100 }), { n: 0, tokens: 0, credits: 0 }) : undefined;
  const found = identify(m, s, taskTitle);
  const lastTokens = fresh ? s.tokens : l.meter.last ?? l.meter.baseline;
  const lastCredits = fresh ? s.credits : l.credits?.last ?? 0;
  const out = (d: Cost, lines: string[]) => ({ reading: lastTokens + d.tokens, credits: Math.round((lastCredits + d.credits) * 1e4) / 1e4, lines, ...(readers ? { readers } : {}) });
  if (!('label' in found)) {
    m.fallback = found.reason;
    delete m.row;
    l.meter_scope = 'tree';
    return out(fresh ? { tokens: 0, credits: 0 } : tree, [`METER_FALLBACK: ${found.reason}`]);
  }
  const row = s.rows.find(r => r.label === found.label)!;
  const lines: string[] = [];
  if (!fresh && m.label === undefined) lines.push(`METER_SCOPE: ship row=${found.label} (was the tree; used= counts that row's growth from this reading on)`);
  const d = fresh ? { tokens: 0, credits: 0 } : m.row?.label === found.label ? { tokens: Math.max(0, row.tokens - m.row.tokens), credits: Math.max(0, row.credits - m.row.credits) } : tree;
  m.label = found.label;
  m.row = { label: found.label, tokens: row.tokens, credits: row.credits };
  delete m.fallback;
  delete l.meter_scope;
  return out(d, lines);
}
