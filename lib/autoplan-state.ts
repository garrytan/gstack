/**
 * autoplan-state — the unattended runner's on-disk state (plan B2): the
 * RunState shape (the B0 run manifest plus the runner's own fields), the
 * typed RunError every command maps to a result code and exit code, the fixed
 * file names, the append-only attempts journal, atomic run.json writes, and
 * the per-voice reads the gate and export share. No command logic lives here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Phase, Scope } from './autoplan-prompts';
import type { DecisionRow, FindingRow, RunManifest, VoiceOutcome } from './headless-artifacts';
import { readJsonl } from './headless-artifacts';
import type { ResultCodeName } from './result-codes';

export type Voice = 'native' | 'outside';
export interface AttemptState { attempt: string; state: 'dispatched' | 'submitted' | 'execution_unknown' | 'cancelled' | 'superseded' | 'deferred'; prompt: string; result: string; estimate_usd: number; dispatched_at: string; terminal_at?: string }
export interface VoiceState extends VoiceOutcome {
  attempt?: string; attempts?: AttemptState[]; result_sha256?: string; findings?: number; label?: string; usage?: Record<string, unknown>; detail?: string;
  /** verified: the INPUT receipt matched the snapshot; attested: a --record bound without one, on the parent's word (attest_reason). */
  receipt?: 'verified' | 'attested'; attest_reason?: string; findings_source?: 'fence' | 'table' | 'list' | 'none'; reviewed_sha256?: string;
}
/** An accepted plan change (gate option with changes_plan) the plan must absorb before the run continues. */
export interface Amendment {
  decision: string; title: string; chosen: string; text: string; gate_rev: number; status: 'pending' | 'incorporated' | 'withdrawn' | 'settled'; at: string; settled_at?: string;
  /** The gate item's `changes` and phase: packaging/ordering changes settle without a plan edit (`revise --settle`). */
  changes?: string; phase?: string; item?: string;
  /** The reviewed Implementation-plan hash of the active plan when the owner accepted it: `--settle` evidence. */
  plan_sha256?: string;
}
/** A revise that changed the plan under a phase at its round cap: the phase keeps its review, the delta becomes a gate item. */
export interface CappedDelta {
  k: number; phase: string; round: number; cap: number; old_plan_sha256: string; new_plan_sha256: string; added: number; removed: number;
  status: 'pending' | 'accepted' | 'reopened'; at: string; decided_at?: string;
}
/** Why a run stopped `incomplete` with work left: the structured budget_exhausted stop `resume` lifts after a budget raise. */
export interface RunStop {
  reason: 'budget_exhausted'; phase?: string; cap_usd: number | null; max_rounds: number | null; rounds: Record<string, number>;
  spent: number; reserved: number; unknown: number; unknown_count: number; next_estimate_usd: number; at: string;
}
/** A phase closed accepted-with-findings (`closeDeferred`): its open findings carry into tasks.jsonl and the gate. */
export interface DeferredClose {
  reason: string; by: string; cause: 'cap' | 'owner'; at: string; round: number; counts: Record<string, number>;
  carried_file?: string; blockers: string[]; open: number;
}
export interface PhaseState {
  snapshot?: string; snapshot_dir?: string; snapshot_path?: string; methodology?: string; opened_at?: string; closed_at?: string;
  native?: VoiceState; outside?: VoiceState; consensus?: Record<string, unknown>; skipped?: string;
  prompts?: { native: string; outside: string; nativeResult: string; outsideResult: string };
  sections?: { loaded: string[]; skipped: string[]; checklist: boolean };
  deferred?: DeferredClose;
  /** A confirm round (r > 1): the revision this phase last reviewed. */
  confirm?: { round: number; previous_sha256?: string; added: number; removed: number };
  /** Revisions bound to this phase without re-review: every incorporated decision was below High (lib/autoplan-revise.ts). */
  rebound?: Array<{ k: number; from: string; to: string; decisions: string[]; at: string }>;
}
/** Reviewer attempts journaled as dispatched (failed, unknown and superseded ones included), per phase and voice. */
export interface DispatchCounts { total: number; by_phase: Record<string, Partial<Record<Voice, number>>> }
export interface RunState extends RunManifest {
  revision: number; out: string; plan_source: string; active_plan: string; restore: string; scope: Scope; phase_order: Phase[];
  phases: Record<string, PhaseState>; native_model?: string; outside_model?: string; outside_enabled: boolean; attempt_counter: number;
  spend_cap_usd: number | null; deadline_at?: string; light?: boolean; history: Array<Record<string, unknown>>; created_at: string; updated_at: string;
  /** The gstack that last wrote this run (lib/autoplan-migrate.ts); absent on runs written before 1.91.96. */
  gstack_version?: string;
  /** The --plan file the owner edits (drift hints, revise), the --plan-heading it was cut from, and the scope flags revise re-detects with. */
  plan_input?: string; plan_heading?: string; scope_flags?: Record<string, boolean | undefined>; scaffolded?: boolean;
  plan_revision?: number; amendments?: Amendment[];
  plan_reality?: { plan_sha256: string; checker: string; verdict: string; line: string };
  /** Review rounds per phase (null: uncapped); round_grants are the owner's per-phase raises at the gate. */
  max_rounds?: number | null; round_grants?: Record<string, number>;
  stop?: RunStop; stops?: RunStop[]; capped_deltas?: CappedDelta[];
  /** Written by export from attempts.jsonl; est_input_tokens is dispatched prompt bytes / 4, a relative estimate only. Absent on older runs. */
  dispatches?: DispatchCounts; est_input_tokens?: number;
  /** Carry-forward (lib/autoplan-carry.ts): false with --no-carry-forward; the per-gate cap on the delta check; the latest carry decision. */
  carry_forward?: boolean; carry_check_cap_usd?: number; carry?: import('./autoplan-carry').CarryRecord;
}

export const TERMINAL_VOICE_STATUSES = ['completed', 'disabled', 'unavailable', 'failed', 'skipped'] as const;
/** The one terminal-voice predicate `next`, `submit`, `resume` and phase close share: a terminal voice is never dispatched or resurrected. */
export function voiceTerminal(v: { status?: string } | undefined): boolean {
  return (TERMINAL_VOICE_STATUSES as readonly string[]).includes(String(v?.status));
}
export const pendingAmendments = (state: RunState): Amendment[] => (state.amendments ?? []).filter(a => a.status === 'pending');
export class RunError extends Error {
  /** `status`: the run status the refusal leaves (default refused); `lines`: what the command still reports on stdout. */
  constructor(public code: ResultCodeName, public detail: string, public exit: 1 | 3 = 1, public after: { status?: string; lines?: string[] } = {}) { super(`${code}: ${detail}`); }
}

export const FILES = { run: 'run.json', journal: 'attempts.jsonl', lock: 'run.lock', spend: 'spend.json', active: 'plan-active.md', restore: 'restore.md', source: 'plan-source.md' } as const;
export const now = () => new Date().toISOString();

export function journal(out: string, row: Record<string, unknown>): void {
  fs.appendFileSync(path.join(out, FILES.journal), JSON.stringify({ ts: now(), ...row }) + '\n');
}
export function readJournal(out: string): Array<Record<string, any>> {
  const file = path.join(out, FILES.journal);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
export function writeState(state: RunState): void {
  state.revision += 1;
  state.updated_at = now();
  const file = path.join(state.out, FILES.run);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
export function readState(out: string): RunState {
  const file = path.join(out, FILES.run);
  if (!fs.existsSync(file)) throw new RunError('RUN_NOT_INITIALIZED', out, 3);
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
  // The directory may have been moved or copied: paths inside it are re-rooted on every read.
  const previous = state.out;
  state.out = path.resolve(out);
  if (previous && previous !== state.out) {
    const reroot = (p: string | undefined) => (p && p.startsWith(previous + path.sep) ? path.join(state.out, path.relative(previous, p)) : p);
    state.active_plan = reroot(state.active_plan)!; state.restore = reroot(state.restore)!; state.plan_source = reroot(state.plan_source)!; state.plan_input = reroot(state.plan_input);
    for (const ps of Object.values(state.phases)) {
      ps.snapshot_dir = reroot(ps.snapshot_dir); ps.snapshot_path = reroot(ps.snapshot_path); ps.methodology = reroot(ps.methodology);
      if (ps.prompts) for (const k of Object.keys(ps.prompts) as Array<keyof typeof ps.prompts>) ps.prompts[k] = reroot(ps.prompts[k])!;
      for (const v of [ps.native, ps.outside]) for (const a of v?.attempts ?? []) { a.prompt = reroot(a.prompt)!; a.result = reroot(a.result)!; }
    }
  }
  return state;
}

/** The canonical rows one completed voice returned (`<phase>-<voice>.md.findings.jsonl`). */
export function voiceRows(state: RunState, phase: string, voice: Voice): FindingRow[] {
  const v = state.phases[phase]?.[voice];
  if (v?.status !== 'completed' || !v.output) return [];
  const file = path.join(state.out, `${v.output}.findings.jsonl`);
  return fs.existsSync(file) ? (readJsonl(file).rows as unknown as FindingRow[]) : [];
}
export function readDecisions(out: string): DecisionRow[] {
  const file = path.join(out, 'decisions.jsonl');
  return fs.existsSync(file) ? (readJsonl(file).rows as unknown as DecisionRow[]) : [];
}
export function writeDecisions(out: string, rows: DecisionRow[]): void {
  const file = path.join(out, 'decisions.jsonl');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}
