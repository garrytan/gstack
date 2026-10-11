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
export interface AttemptState { attempt: string; state: 'dispatched' | 'submitted' | 'execution_unknown' | 'cancelled' | 'superseded'; prompt: string; result: string; estimate_usd: number; dispatched_at: string; terminal_at?: string }
export interface VoiceState extends VoiceOutcome { attempt?: string; attempts?: AttemptState[]; result_sha256?: string; findings?: number; label?: string; usage?: Record<string, unknown>; detail?: string }
export interface PhaseState {
  snapshot?: string; snapshot_dir?: string; snapshot_path?: string; methodology?: string; opened_at?: string; closed_at?: string;
  native?: VoiceState; outside?: VoiceState; consensus?: Record<string, unknown>; skipped?: string;
  prompts?: { native: string; outside: string; nativeResult: string; outsideResult: string };
  sections?: { loaded: string[]; skipped: string[]; checklist: boolean };
}
export interface RunState extends RunManifest {
  revision: number; out: string; plan_source: string; active_plan: string; restore: string; scope: Scope; phase_order: Phase[];
  phases: Record<string, PhaseState>; native_model?: string; outside_model?: string; outside_enabled: boolean; attempt_counter: number;
  spend_cap_usd: number | null; deadline_at?: string; light?: boolean; history: Array<Record<string, unknown>>; created_at: string; updated_at: string;
}
export class RunError extends Error {
  constructor(public code: ResultCodeName, public detail: string, public exit: 1 | 3 = 1) { super(`${code}: ${detail}`); }
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
    state.active_plan = reroot(state.active_plan)!; state.restore = reroot(state.restore)!;
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
