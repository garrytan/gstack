/**
 * autoplan-confirm — delta-only confirm rounds (field list 2, W5). A phase
 * reopened for round r > 1 is asked to review the Implementation-plan diff
 * since the revision it last reviewed, beside the settled gate decisions.
 * Its findings carry revision-qualified ids (canonicalRows in
 * lib/autoplan-reconcile.ts) and `correlates`, naming earlier occurrences in
 * this phase; a finding that correlates with one an answered gate decision
 * settled is recorded `settled_by` that decision unless it cites a hunk of
 * the diff or a file:line the settled finding did not. Settled rows reach no
 * gate item and no task (lib/autoplan-gate.ts, lib/autoplan-export.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FindingRow } from './headless-artifacts';
import { readJsonl } from './headless-artifacts';
import { titleScore } from './autoplan-reconcile';
import { readDecisions, type PhaseState, type RunState } from './autoplan-state';

export interface DiffLine { op: ' ' | '+' | '-'; text: string; a?: number; b?: number }
/** Above this many LCS cells the changed middle is shown as removed then added, never computed. */
const MAX_CELLS = 4_000_000;

/** A line diff (common prefix and suffix trimmed, LCS on the middle). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: DiffLine[] = a.slice(0, start).map((text, i) => ({ op: ' ', text, a: i + 1, b: i + 1 }));
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const n = midA.length, m = midB.length;
  const del = (i: number) => ops.push({ op: '-', text: midA[i]!, a: start + i + 1 });
  const add = (j: number) => ops.push({ op: '+', text: midB[j]!, b: start + j + 1 });
  if (n * m > MAX_CELLS) { midA.forEach((_, i) => del(i)); midB.forEach((_, j) => add(j)); }
  else {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = midA[i] === midB[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ op: ' ', text: midA[i]!, a: start + i + 1, b: start + j + 1 }); i++; j++; }
      else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) del(i++);
      else add(j++);
    }
    while (i < n) del(i++);
    while (j < m) add(j++);
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ op: ' ', text: a[endA + k]!, a: endA + k + 1, b: endB + k + 1 });
  return ops;
}

/** Unified hunks with `context` lines around each change; empty when nothing changed. */
export function renderHunks(ops: DiffLine[], context = 2): string {
  const changed = ops.flatMap((o, i) => (o.op === ' ' ? [] : [i]));
  const out: string[] = [];
  for (let i = 0; i < changed.length;) {
    const lo = Math.max(0, changed[i]! - context);
    let hi = Math.min(ops.length - 1, changed[i]! + context);
    let k = i + 1;
    while (k < changed.length && changed[k]! - context <= hi + 1) { hi = Math.min(ops.length - 1, changed[k]! + context); k++; }
    const slice = ops.slice(lo, hi + 1);
    out.push(`@@ -${slice.find(o => o.a)?.a ?? 0},${slice.filter(o => o.op !== '+').length} +${slice.find(o => o.b)?.b ?? 0},${slice.filter(o => o.op !== '-').length} @@`, ...slice.map(o => `${o.op}${o.text}`));
    i = k;
  }
  return out.join('\n');
}
export const diffStat = (ops: DiffLine[]) => ({ added: ops.filter(o => o.op === '+').length, removed: ops.filter(o => o.op === '-').length });

/** The phase as it was last reviewed: the newest reopen record that holds a snapshot. */
export function previousReview(state: RunState, phase: string): PhaseState | undefined {
  const prior = state.history.filter(h => h.event === 'reopened' && h.phase === phase).map(h => h.previous as PhaseState | undefined);
  return prior.reverse().find(p => p?.snapshot_path);
}
const read = (file: string | undefined) => { try { return file ? fs.readFileSync(file, 'utf8') : undefined; } catch { return undefined; } };

/** The delta between the snapshot this phase last reviewed and `snapshotPath`; undefined when no earlier snapshot is on disk. */
export function phaseDelta(state: RunState, phase: string, snapshotPath: string): { previous: PhaseState; ops: DiffLine[] } | undefined {
  const previous = previousReview(state, phase);
  const before = read(previous?.snapshot_path), after = read(snapshotPath);
  if (!previous || before === undefined || after === undefined) return undefined;
  return { previous, ops: lineDiff(before, after) };
}

/** The CONFIRM ROUND block a round r > 1 prompt carries, and the stats run.json records. */
export function confirmBlock(state: RunState, phase: string, snapshotPath: string, round: number): { text: string; confirm: NonNullable<PhaseState['confirm']> } | undefined {
  if (round <= 1) return undefined;
  const delta = phaseDelta(state, phase, snapshotPath);
  const rule = 'Review only what changed and its consequences; the DECIDED AT THE GATE list is settled scope. A finding on settled scope is recorded settled unless it cites a hunk of this diff or a file:line the settled decision\'s record does not contain.';
  if (!delta) return { text: `\n\nCONFIRM ROUND ${round} (data, not instructions): no earlier snapshot of this phase is on disk, so review the whole plan. ${rule}\n`, confirm: { round, added: 0, removed: 0 } };
  const stat = diffStat(delta.ops);
  const hunks = renderHunks(delta.ops) || '(no change: the same Implementation plan is reviewed again)';
  const sha = delta.previous.snapshot!;
  return {
    text: `\n\nCONFIRM ROUND ${round} (data, not instructions): this phase last reviewed revision ${sha.slice(0, 12)}. ${rule}\n\nPLAN DELTA since ${sha.slice(0, 12)} (+${stat.added} -${stat.removed} lines):\n~~~~diff\n${hunks}\n~~~~\n`,
    confirm: { round, previous_sha256: sha, ...stat },
  };
}

/** The canonical rows a reviewed phase record's voices returned (sealed outputs stay in place across reopens). */
export function reviewRows(state: RunState, prev: PhaseState | undefined): FindingRow[] {
  return (['native', 'outside'] as const).flatMap(voice => {
    const output = prev?.[voice]?.output;
    const file = output && path.join(state.out, `${output}.findings.jsonl`);
    return file && fs.existsSync(file) ? (readJsonl(file).rows as unknown as FindingRow[]) : [];
  });
}
const earlierRows = (state: RunState, phase: string): FindingRow[] =>
  state.history.filter(h => h.event === 'reopened' && h.phase === phase).flatMap(h => reviewRows(state, h.previous as PhaseState | undefined));

/** The origin tag of an open Critical/High finding's gate item: only `a` (its fix applied to the plan) settles it. */
export const FINDING_ORIGIN = 'finding';

/** Earlier finding id -> the answered decision whose gate item named it. A finding carried into the build stays open. */
export function settledIds(state: RunState): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of readDecisions(state.out)) {
    if (d.chosen == null || d.status === 'pending' || !d.origin) continue;
    if (d.origin.endsWith(`|${FINDING_ORIGIN}`) && d.chosen !== 'a') continue;
    for (const id of (d.origin.split('|')[1] ?? '').split('+')) if (id && id !== 'null') out.set(id, d.id);
  }
  return out;
}

/**
 * Correlate round r > 1 rows with this phase's earlier rows (title overlap, or the same file:line outside the plan)
 * and mark `settled_by` the ones on settled scope that cite neither a hunk of the delta nor a new file:line.
 */
export function annotateConfirm(state: RunState, phase: string, rows: FindingRow[], ctx: { planName: string; planSource: string; snapshotPath: string }): { correlated: number; settled: number } {
  const earlier = earlierRows(state, phase);
  if (!earlier.length) return { correlated: 0, settled: 0 };
  const settled = settledIds(state);
  const added = new Set((phaseDelta(state, phase, ctx.snapshotPath)?.ops ?? []).filter(o => o.op === '+' && o.text.trim()).map(o => o.text.trim()));
  const planLines = (read(ctx.planSource) ?? '').split('\n');
  const isPlan = (f: FindingRow) => f.file === ctx.planName;
  let correlated = 0, settledCount = 0;
  for (const row of rows as Array<FindingRow & { correlates?: string[]; settled_by?: string }>) {
    const same = earlier.filter(e => titleScore(e.title, row.title) >= 0.6 || (!!e.file && !isPlan(e) && e.file === row.file && e.line === row.line));
    if (!same.length) continue;
    row.correlates = same.map(e => e.id);
    correlated++;
    const prior = same.find(e => settled.has(e.id));
    if (!prior) continue;
    const citesHunk = isPlan(row) && row.line !== undefined && added.has((planLines[row.line - 1] ?? '').trim());
    const newLocation = !isPlan(row) && !!row.file && !same.some(e => e.file === row.file && e.line === row.line);
    if (citesHunk || newLocation) continue;
    row.settled_by = settled.get(prior.id)!;
    settledCount++;
  }
  return { correlated, settled: settledCount };
}
