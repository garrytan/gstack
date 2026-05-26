/**
 * Schema reference for the per-skill Implementation Tasks JSONL artifact (#1454).
 *
 * Each review skill (plan-ceo-review, plan-design-review, plan-eng-review,
 * plan-devex-review) writes one JSONL line per task during its synthesis step
 * to `~/.gstack/projects/$SLUG/tasks-{phase}-{datetime}.jsonl`.
 *
 * `/autoplan`'s Phase 4 aggregator reads ALL phase JSONL files, scopes them
 * by branch + commit window, dedupes by exact (component, sorted(files), title),
 * and renders an `## Implementation Tasks (aggregated across phases)` section
 * inside the Final Approval Gate output.
 *
 * Wire format: one JSON object per line. Build via `jq -nc` from bash — never
 * by hand-rolled echo/printf, because task titles and source findings may
 * contain quotes, newlines, and backslashes.
 */

export type TaskPhase = 'ceo-review' | 'design-review' | 'eng-review' | 'devex-review';
export type TaskPriority = 'P1' | 'P2' | 'P3';

/**
 * One row in tasks-{phase}-{datetime}.jsonl. All fields required unless noted.
 */
export interface ImplementationTask {
  /** Which review phase produced this task. */
  phase: TaskPhase;
  /** Unique run identifier for this phase invocation (timestamp + pid suffix). */
  run_id: string;
  /** Branch the review ran on. Aggregator filters by this. */
  branch: string;
  /** HEAD commit at review time. Aggregator filters by commit-window proximity. */
  commit: string;
  /** Short task id, unique within a single run_id (T1, T2, ...). */
  id: string;
  priority: TaskPriority;
  /** Coarse component label (e.g., `browse/sanitizer`, `auth/login`). */
  component: string;
  /** Files the task touches. Aggregator sorts this and uses it in the dedup key. */
  files: string[];
  /** Human-team effort estimate (e.g., "2h", "1 day"). */
  effort_human: string;
  /** CC+gstack effort estimate (e.g., "15min"). */
  effort_cc: string;
  /** Action-oriented title in imperative form ("Add commandResult-level sanitization"). */
  title: string;
  /** Free-text reference to the finding that motivated this task. */
  source_finding: string;
}

/**
 * Dedup key for the aggregator. Two tasks collapse into one ONLY when this
 * tuple is identical (per `D13 finding 9`). Near-duplicates surface as
 * separate tasks with a `possible-duplicate-of: <id>` note.
 */
export function dedupKey(t: Pick<ImplementationTask, 'component' | 'files' | 'title'>): string {
  return JSON.stringify({
    component: t.component,
    files: [...t.files].sort(),
    title: t.title,
  });
}
