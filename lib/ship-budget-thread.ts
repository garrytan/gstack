/**
 * GST-1699: /ship's own share of a Capy thread tree. A /ship subagent can read only the root
 * thread ("this"), whose counter holds the lane's own work and every sibling as well, so a cap on
 * that counter stops /ship for spend that is not its own. `--thread <file>` hands the helper the
 * whole `tools.thread.get` result instead of one number: the root counter (`tree=`), and the
 * `tasks` rows, one per subagent in the tree, each with the cost of its own subtree. /ship's own
 * row is the subagent it runs in, found by the brief's GSTACK_SHIP_TASK_TITLE or as the parent of
 * a subagent this run created (`dispatched`, the titles the pass program writes). That row,
 * readers included, is what `used=` counts and the cap stops on. Until it is found (no reader yet,
 * /ship on the root thread itself, a truncated list) the run meters the tree, labelled.
 */
import * as fs from 'node:fs';
import { budgetError, usageError, type Ledger } from './ship-budget';

interface Row { label: string; title: string; tokens: number; credits: number }
interface Snapshot { tokens: number; credits: number; rows: Row[]; total: number; dispatched: string[] }
type Cost = { tokens: number; credits: number };

export interface ShipMeter {
  /** The tasks row holding /ship's own work (its subagent and that subagent's readers), once found. */
  label?: string;
  task_title?: string;
  /** Titles of subagents this run created, collected from every snapshot's `dispatched`. */
  dispatched: string[];
  /** Each row's cost at the run's first snapshot: a row found later is metered from here. */
  start_rows: Record<string, Cost>;
  tree: { baseline: number; last: number };
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
    rows.push({ label: t.label, title: t.title, tokens: rt, credits: rc });
  }
  const dispatched = Array.isArray(doc.dispatched) ? doc.dispatched.filter((x: unknown): x is string => typeof x === 'string') : [];
  return { tokens, credits, rows, total: num(doc.tasks_total) ?? rows.length, dispatched };
}

function resolve(m: ShipMeter, s: Snapshot): { label?: string; reason?: string } {
  const truncated = s.total > s.rows.length ? `; the snapshot lists ${s.rows.length} of ${s.total} rows` : '';
  if (m.task_title) {
    const hits = s.rows.filter(r => r.title === m.task_title);
    if (hits.length === 1) return { label: hits[0]!.label };
    return { reason: `${hits.length} rows carry the task title "${m.task_title}"${truncated}` };
  }
  const parents = new Set<string>();
  for (const title of m.dispatched) {
    const hits = s.rows.filter(r => r.title === title);
    if (hits.length !== 1) continue;
    const parent = hits[0]!.label.replace(/\.\d+$/, '');
    if (parent === hits[0]!.label) return { reason: `this run's readers are top-level subagents, so /ship runs on the root thread, whose own counter also holds the lane's work` };
    parents.add(parent);
  }
  if (parents.size > 1) return { reason: `this run's readers sit under ${[...parents].join(', ')}` };
  const [label] = parents;
  if (label && s.rows.some(r => r.label === label)) return { label };
  return { reason: `no subagent this run created is listed yet (its row is found from its first reader)${truncated}` };
}

/**
 * Turn a snapshot into this command's reading: /ship's own row once found, else the tree. The
 * first time the row is found, the run's meter is rebased onto that row's cost at the run's first
 * snapshot, so tree spend counted before it (the lane's work included) drops out of used=.
 */
export function threadReading(l: Ledger, file: string, taskTitle?: string): { reading: number; credits: number; lines: string[]; readers?: Cost & { n: number } } {
  const s = readSnapshot(file);
  const fresh = !l.ship_meter;
  const m: ShipMeter = l.ship_meter ??= {
    dispatched: [], start_rows: Object.fromEntries(s.rows.map(r => [r.label, { tokens: r.tokens, credits: r.credits }])),
    tree: { baseline: s.tokens, last: s.tokens }, ...(taskTitle ? { task_title: taskTitle } : {}),
  };
  if (s.tokens < m.tree.last) throw budgetError('BUDGET_READING_REJECTED', `--thread ${file}: tree reading ${s.tokens} is below the run's last tree reading ${m.tree.last}`);
  m.tree.last = s.tokens;
  for (const t of s.dispatched) if (!m.dispatched.includes(t)) m.dispatched.push(t);
  const readers = s.dispatched.length ? s.rows.filter(r => s.dispatched.includes(r.title)).reduce((a, r) => ({ n: a.n + 1, tokens: a.tokens + r.tokens, credits: Math.round((a.credits + r.credits) * 100) / 100 }), { n: 0, tokens: 0, credits: 0 }) : undefined;
  const lines: string[] = [];
  if (!m.label) {
    const found = resolve(m, s);
    if (found.label) {
      m.label = found.label;
      delete m.fallback;
      delete l.meter_scope;
      const base = m.start_rows[found.label] ?? { tokens: 0, credits: 0 };
      if (!fresh) {
        l.meter.baseline = base.tokens; l.meter.last = base.tokens;
        l.credits = { baseline: base.credits, last: base.credits, ...(l.credits?.carried === undefined ? {} : { carried: l.credits.carried }) };
        lines.push(`METER_SCOPE: ship row=${found.label} (was the tree; used= now counts that row from the run's start)`);
      }
    } else {
      m.fallback = found.reason;
      l.meter_scope = 'tree';
      return { reading: s.tokens, credits: s.credits, lines: [`METER_FALLBACK: ${found.reason}`], ...(readers ? { readers } : {}) };
    }
  }
  const row = s.rows.find(r => r.label === m.label);
  if (!row) {
    lines.push(`METER_ROW_MISSING: ${m.label} is not among the ${s.rows.length} of ${s.total} rows listed; used= holds at its last reading`);
    return { reading: l.meter.last ?? l.meter.baseline, credits: l.credits?.last ?? 0, lines, ...(readers ? { readers } : {}) };
  }
  return { reading: row.tokens, credits: row.credits, lines, ...(readers ? { readers } : {}) };
}
