/**
 * Plan-review task lists across reruns (G2, #1791).
 *
 * Each plan review writes `tasks-<phase>-<branch>-<ts>.jsonl` (older runs:
 * `tasks-<phase>-<ts>.jsonl`) in the project's state directory, and
 * /autoplan's aggregator keeps the newest run_id per phase. A rerun used to
 * write a fresh list blind, so run 1's open tasks vanished from the aggregate.
 *
 *   prior      the newest earlier list for this phase and branch (selected
 *              by each row's branch field and run_id, never by file name),
 *              so the rerun reconciles it: carry, done or dropped
 *   supersede  after the rerun's list validates, rename the reconciled
 *              earlier lists for this phase and branch to `superseded-…`,
 *              out of the aggregator's `tasks-<phase>-*.jsonl` glob; another
 *              phase, another branch's rows, a newer run and an empty legacy
 *              file are left alone. A pending marker written before the
 *              renames lets the next call finish an interrupted supersede.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TASK_PHASES = ['ceo-review', 'design-review', 'eng-review', 'devex-review'] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];
export type TaskRow = Record<string, unknown> & { phase?: string; run_id?: string; branch?: string; id?: string };
export interface TaskFile { file: string; rows: TaskRow[]; malformed: number[] }
export interface PriorSet { file: string; run_id: string; rows: TaskRow[] }

const TS_SUFFIX_RE = /-\d{8}-\d{6}\.jsonl$/;
const marker = (dir: string, phase: string) => path.join(dir, `.tasks-supersede-${phase}.pending`);

export function readTaskFiles(dir: string, phase: TaskPhase): TaskFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.startsWith(`tasks-${phase}-`) && n.endsWith('.jsonl')).sort().map(name => {
    const file = path.join(dir, name);
    const rows: TaskRow[] = [], malformed: number[] = [];
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { const v = JSON.parse(line); if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v); else malformed.push(i + 1); }
      catch { malformed.push(i + 1); }
    });
    return { file, rows, malformed };
  });
}

/** The newest earlier task set for this phase and branch: the rows of the highest run_id, wherever they live. */
export function priorSet(files: readonly TaskFile[], phase: TaskPhase, branch: string): PriorSet | undefined {
  let best: PriorSet | undefined;
  for (const f of files) {
    for (const row of f.rows) {
      if (row.phase !== phase || row.branch !== branch || typeof row.run_id !== 'string') continue;
      if (!best || row.run_id > best.run_id) best = { file: f.file, run_id: row.run_id, rows: [] };
    }
  }
  if (best) for (const f of files) best.rows.push(...f.rows.filter(r => r.phase === phase && r.branch === branch && r.run_id === best!.run_id));
  return best;
}

export function finishPending(dir: string, phase: TaskPhase): string[] {
  const m = marker(dir, phase);
  if (!fs.existsSync(m)) return [];
  const moves = JSON.parse(fs.readFileSync(m, 'utf8')) as Array<[string, string]>;
  const done: string[] = [];
  for (const [from, to] of moves) if (fs.existsSync(from)) { fs.renameSync(from, to); done.push(from); }
  fs.rmSync(m);
  return done;
}

export class SupersedeRefused extends Error {}

/** `tasks-<phase>-<branch slug>-<ts>.jsonl`, created empty (an empty list means "ran, no findings"), and a run id that sorts after older ones. */
export function startList(dir: string, phase: TaskPhase, branchSlug: string, now = new Date()): { file: string; runId: string } {
  fs.mkdirSync(dir, { recursive: true });
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const local = `${iso.slice(0, 8)}-${iso.slice(9, 15)}`;
  const file = path.join(dir, `tasks-${phase}-${branchSlug.replace(/[^A-Za-z0-9._-]/g, '-') || 'unknown'}-${local}.jsonl`);
  fs.appendFileSync(file, '');
  return { file, runId: `${iso}-${process.pid}` };
}

export const TASK_FIELDS = ['id', 'priority', 'component', 'title', 'source_finding', 'effort_human', 'effort_cc'] as const;

/** One task row in the schema /autoplan's aggregator reads; the phase comes from the file name. */
export function taskRow(file: string, o: { runId: string; branch: string; commit: string; files: unknown; carriedFrom?: string } & Record<(typeof TASK_FIELDS)[number], string>): TaskRow {
  const phase = TASK_PHASES.find(p => path.basename(file).startsWith(`tasks-${p}-`));
  if (!phase) throw new SupersedeRefused(`${file} is not a tasks-<phase>-*.jsonl list`);
  if (!Array.isArray(o.files) || o.files.some(f => typeof f !== 'string')) throw new SupersedeRefused('--files must be a JSON array of strings');
  return { phase, run_id: o.runId, branch: o.branch, commit: o.commit, id: o.id, priority: o.priority, component: o.component, files: o.files, effort_human: o.effort_human, effort_cc: o.effort_cc, title: o.title, source_finding: o.source_finding, ...(o.carriedFrom ? { carried_from: o.carriedFrom } : {}) };
}

/** A prior task closed without carrying it: done (with the commit) or dropped (with the reason). */
export function closeTask(dir: string, phase: TaskPhase, branch: string, branchSlug: string, prior: string, disposition: 'done' | 'dropped', reason: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(prior)) throw new SupersedeRefused('--prior must be <run_id>/<id>');
  const file = path.join(dir, `task-dispositions-${phase}-${branchSlug.replace(/[^A-Za-z0-9._-]/g, '-') || 'unknown'}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ phase, branch, prior, disposition, reason, at: new Date().toISOString() }) + '\n');
  return file;
}

export function supersede(dir: string, phase: TaskPhase, branch: string, keep: string): { moved: string[]; skipped: Array<{ file: string; reason: string }> } {
  finishPending(dir, phase);
  const keepPath = path.resolve(keep);
  if (path.dirname(keepPath) !== path.resolve(dir) || !path.basename(keepPath).startsWith(`tasks-${phase}-`)) throw new SupersedeRefused(`--keep must be a tasks-${phase}-*.jsonl file in ${dir}`);
  const files = readTaskFiles(dir, phase);
  const kept = files.find(f => f.file === keepPath);
  if (!kept) throw new SupersedeRefused(`${keep} does not exist`);
  if (kept.malformed.length) throw new SupersedeRefused(`${keep} has malformed lines ${kept.malformed.join(',')}`);
  const stray = kept.rows.find(r => r.phase !== phase || r.branch !== branch);
  if (stray) throw new SupersedeRefused(`${keep} holds a row for phase ${String(stray.phase)} branch ${String(stray.branch)}`);
  const keepRun = kept.rows.map(r => String(r.run_id ?? '')).sort().at(-1);
  const keepMtime = fs.statSync(keepPath).mtimeMs;
  const keepPrefix = path.basename(keepPath).replace(TS_SUFFIX_RE, '');
  const moves: Array<[string, string]> = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  for (const f of files) {
    if (f.file === keepPath) continue;
    const skip = (reason: string) => skipped.push({ file: f.file, reason });
    if (f.malformed.length) { skip('malformed lines'); continue; }
    if (!f.rows.length) {
      if (path.basename(f.file).replace(TS_SUFFIX_RE, '') !== keepPrefix || keepPrefix === `tasks-${phase}`) { skip('empty file of unknown branch'); continue; }
      if (fs.statSync(f.file).mtimeMs > keepMtime) { skip('newer than the kept list'); continue; }
    } else {
      if (f.rows.some(r => r.branch !== branch)) { skip('holds another branch'); continue; }
      const run = f.rows.map(r => String(r.run_id ?? '')).sort().at(-1)!;
      if (keepRun ? run > keepRun : fs.statSync(f.file).mtimeMs > keepMtime) { skip('newer than the kept list'); continue; }
    }
    moves.push([f.file, path.join(dir, `superseded-${path.basename(f.file)}`)]);
  }
  if (!moves.length) return { moved: [], skipped };
  fs.writeFileSync(marker(dir, phase), JSON.stringify(moves));
  return { moved: finishPending(dir, phase), skipped };
}
