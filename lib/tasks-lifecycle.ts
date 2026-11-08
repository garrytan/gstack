/**
 * Task list lifecycle reader and disposition state transitions (#3943).
 *
 * Plan reviews write `tasks-<phase>-*.jsonl` and `task-dispositions-<phase>-*.jsonl`
 * in `<state root>/projects/<slug>`. This module resolves `carried_from` chains to
 * canonical root task identities, replays disposition rows through an explicit
 * transition table (ignoring illegal/stale transitions without locks), and powers
 * `gstack-tasks open`, `close`, `sweep`, and rerun reconciliation in `prior`/`add`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SupersedeRefused, TASK_PHASES, readTaskFiles, type TaskPhase, type TaskRow } from './tasks-prior';

export const DISPOSITIONS = ['done', 'dropped', 'pending', 'reopened'] as const;
export type TaskDisposition = (typeof DISPOSITIONS)[number];
export type TaskStatus = 'open' | 'pending' | 'done' | 'dropped';

export interface DispositionRow {
  phase: TaskPhase;
  run_id: string;
  branch: string;
  prior: string;
  disposition: TaskDisposition;
  reason: string;
  pr?: string;
}

export interface TaskState {
  rootRef: string;
  latestRef: string;
  status: TaskStatus;
  reason?: string;
  pr?: string;
}

const PRIOR_RE = /^[^/\s]+\/[^/\s]+$/;

const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskDisposition, TaskStatus>>> = {
  open: { pending: 'pending', done: 'done', dropped: 'dropped' },
  pending: { done: 'done', dropped: 'dropped', reopened: 'open' },
  done: { reopened: 'open' },
  dropped: { reopened: 'open' },
};

export function canTransition(current: TaskStatus, disposition: TaskDisposition): TaskStatus | undefined {
  return TRANSITIONS[current]?.[disposition];
}

function readAllPhaseTaskRows(dir: string, phase: TaskPhase): TaskRow[] {
  if (!fs.existsSync(dir)) return [];
  const rows: TaskRow[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!(name.startsWith(`tasks-${phase}-`) || name.startsWith(`superseded-tasks-${phase}-`)) || !name.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v as TaskRow);
      } catch {}
    }
  }
  return rows;
}

export function readDispositionRows(dir: string, phase: TaskPhase): DispositionRow[] {
  if (!fs.existsSync(dir)) return [];
  const rows: DispositionRow[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.startsWith(`task-dispositions-${phase}-`) || !name.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as Record<string, unknown>;
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        if (typeof v.prior !== 'string' || typeof v.disposition !== 'string' || !DISPOSITIONS.includes(v.disposition as TaskDisposition)) continue;
        rows.push({
          phase,
          run_id: typeof v.run_id === 'string' ? v.run_id : '',
          branch: typeof v.branch === 'string' ? v.branch : 'unknown',
          prior: v.prior,
          disposition: v.disposition as TaskDisposition,
          reason: typeof v.reason === 'string' ? v.reason : '',
          ...(typeof v.pr === 'string' && v.pr ? { pr: v.pr } : {}),
        });
      } catch {}
    }
  }
  return rows;
}

export function resolveRootRef(ref: string, carriedByRef: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  let cur = ref;
  while (carriedByRef.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = carriedByRef.get(cur)!;
  }
  return cur;
}

export function buildTaskStateMap(dir: string, phase: TaskPhase): { carriedByRef: Map<string, string>; states: Map<string, TaskState> } {
  const carriedByRef = new Map<string, string>();
  const allRows = readAllPhaseTaskRows(dir, phase);
  for (const row of allRows) {
    if (typeof row.run_id !== 'string' || typeof row.id !== 'string') continue;
    const ref = `${row.run_id}/${row.id}`;
    if (typeof row.carried_from === 'string' && PRIOR_RE.test(row.carried_from)) {
      carriedByRef.set(ref, row.carried_from);
    }
  }
  const states = new Map<string, TaskState>();
  for (const row of allRows) {
    if (typeof row.run_id !== 'string' || typeof row.id !== 'string') continue;
    const ref = `${row.run_id}/${row.id}`;
    const rootRef = resolveRootRef(ref, carriedByRef);
    const existing = states.get(rootRef);
    states.set(rootRef, { rootRef, latestRef: ref, status: existing?.status ?? 'open', reason: existing?.reason, pr: existing?.pr });
  }
  for (const disp of readDispositionRows(dir, phase)) {
    const rootRef = resolveRootRef(disp.prior, carriedByRef);
    const current = states.get(rootRef) ?? { rootRef, latestRef: disp.prior, status: 'open' as TaskStatus };
    const next = canTransition(current.status, disp.disposition);
    if (!next) continue;
    states.set(rootRef, {
      rootRef,
      latestRef: current.latestRef,
      status: next,
      reason: disp.reason,
      pr: next === 'pending' ? (disp.pr ?? disp.reason) : next === 'done' ? (current.pr ?? disp.pr) : undefined,
    });
  }
  return { carriedByRef, states };
}

/** Task refs (and root refs) in `dir` for `phase` whose replayed state is `done`, `dropped`, or `pending`. */
export function decidedTaskRefs(dir: string, phase: TaskPhase): Set<string> {
  const { carriedByRef, states } = buildTaskStateMap(dir, phase);
  const decided = new Set<string>();
  for (const [rootRef, st] of states) {
    if (st.status !== 'open') decided.add(rootRef);
  }
  for (const [ref] of carriedByRef) {
    const rootRef = resolveRootRef(ref, carriedByRef);
    if (decided.has(rootRef)) decided.add(ref);
  }
  return decided;
}

export function listOpenTasks(dir: string, phases: readonly TaskPhase[] = TASK_PHASES): Array<TaskRow & { status: 'open' | 'pending'; root_ref: string; pr?: string }> {
  const result: Array<TaskRow & { status: 'open' | 'pending'; root_ref: string; pr?: string }> = [];
  for (const phase of phases) {
    const { carriedByRef, states } = buildTaskStateMap(dir, phase);
    const latestByRoot = new Map<string, TaskRow>();
    for (const file of readTaskFiles(dir, phase)) {
      for (const row of file.rows) {
        if (row.phase !== phase || typeof row.run_id !== 'string' || typeof row.id !== 'string') continue;
        const ref = `${row.run_id}/${row.id}`;
        const rootRef = resolveRootRef(ref, carriedByRef);
        const prev = latestByRoot.get(rootRef);
        if (!prev || String(row.run_id) >= String(prev.run_id)) latestByRoot.set(rootRef, row);
      }
    }
    for (const [rootRef, row] of latestByRoot) {
      const st = states.get(rootRef);
      const status = st?.status ?? 'open';
      if (status === 'done' || status === 'dropped') continue;
      result.push({ ...row, status, root_ref: rootRef, ...(st?.pr ? { pr: st.pr } : {}) });
    }
  }
  return result;
}

export function closeTask(
  dir: string,
  phase: TaskPhase,
  branch: string,
  branchSlug: string,
  prior: string,
  disposition: TaskDisposition,
  reason: string,
  pr?: string,
  now = new Date(),
): DispositionRow {
  if (!PRIOR_RE.test(prior)) throw new SupersedeRefused(`prior must be <run_id>/<id>, got ${prior}`);
  if (!DISPOSITIONS.includes(disposition)) throw new SupersedeRefused(`disposition must be one of ${DISPOSITIONS.join(', ')}`);
  if (!reason.trim()) throw new SupersedeRefused('close requires a non-empty --reason');
  const { carriedByRef, states } = buildTaskStateMap(dir, phase);
  const rootRef = resolveRootRef(prior, carriedByRef);
  const current = states.get(rootRef)?.status ?? 'open';
  const next = canTransition(current, disposition);
  if (!next) throw new SupersedeRefused(`cannot transition ${prior} (root ${rootRef}) from ${current} via ${disposition}`);
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const slug = branchSlug.replace(/[^A-Za-z0-9._-]/g, '-') || 'unknown';
  const entry: DispositionRow = {
    phase,
    run_id: `${iso}-${process.pid}`,
    branch,
    prior,
    disposition,
    reason,
    ...(pr ? { pr } : {}),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `task-dispositions-${phase}-${slug}.jsonl`), JSON.stringify(entry) + '\n');
  return entry;
}

export function sweepPrTasks(
  dir: string,
  pr: string,
  prState: 'merged' | 'closed' | 'reverted',
  branch: string,
  branchSlug: string,
  reason?: string,
  now = new Date(),
): DispositionRow[] {
  if (!pr.trim()) throw new SupersedeRefused('sweep requires --pr <repo#number>');
  const written: DispositionRow[] = [];
  for (const phase of TASK_PHASES) {
    const { states } = buildTaskStateMap(dir, phase);
    for (const [rootRef, st] of states) {
      const matchesPr = st.pr === pr || st.reason === pr;
      if (!matchesPr) continue;
      if (prState === 'merged' && st.status === 'pending') {
        written.push(closeTask(dir, phase, branch, branchSlug, st.latestRef, 'done', reason || pr, pr, now));
      } else if (prState === 'closed' && st.status === 'pending') {
        written.push(closeTask(dir, phase, branch, branchSlug, st.latestRef, 'reopened', reason || `${pr} closed unmerged`, undefined, now));
      } else if (prState === 'reverted' && (st.status === 'done' || st.status === 'pending')) {
        written.push(closeTask(dir, phase, branch, branchSlug, st.latestRef, 'reopened', reason || `${pr} reverted`, undefined, now));
      }
    }
  }
  return written;
}
