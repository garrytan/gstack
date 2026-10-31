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
