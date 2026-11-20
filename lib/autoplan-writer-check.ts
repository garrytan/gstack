/**
 * Provenance for `gstack-artifact validate <run.json>` and `ack` (GST-3090).
 * validateRun (lib/headless-artifacts.ts) says a run directory is well formed;
 * this says gstack-autoplan wrote it. gstack-autoplan is the only writer of
 * run.json (docs/unattended.md), so a run.json that parses against its schema
 * gets this check too. A public copy does not: it carries no journal and is
 * bound to its private run by provenance digests (lib/autoplan-public.ts).
 *
 *   ARTIFACT_NOT_AUTOPLAN_RUN  host is not gstack-autoplan, a field initRun always writes is missing, or attempts.jsonl is absent
 *   ARTIFACT_JOURNAL_MISMATCH  attempts.jsonl, a bound review output or the run's checkpoint disagrees with run.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkpointRoot, listGenerations, repoOf } from './autoplan-checkpoint';
import { FILES, readJournal, type RunState } from './autoplan-state';
import { sha256File, validateRun, type ValidationError, type ValidationResult } from './headless-artifacts';

/** What initRun (lib/autoplan-run.ts) writes on every run, whatever its kind; gstack_version is absent on runs before 1.91.96. */
const WRITER_FIELDS = [
  ['plan_input', 'string'], ['plan_source', 'string'], ['active_plan', 'string'], ['restore', 'string'], ['out', 'string'],
  ['created_at', 'string'], ['revision', 'number'], ['attempt_counter', 'number'], ['outside_enabled', 'boolean'],
  ['phase_order', 'array'], ['history', 'array'], ['scope', 'object'],
] as const;
const STRUCTURE = ['ARTIFACT_INVALID_JSON', 'ARTIFACT_UNSUPPORTED_VERSION', 'ARTIFACT_SCHEMA'];
const kindOf = (x: unknown) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);

/** validateRun plus the writer check, for a run directory a consumer treats as evidence. */
export function validateAutoplanRun(runJson: string, env: NodeJS.ProcessEnv = process.env): ValidationResult {
  const result = validateRun(runJson);
  if (!result.manifest || result.errors.some(e => STRUCTURE.includes(e.code))) return result;
  const errors = [...result.errors, ...checkWriter(result.manifest as unknown as RunState, result.runDir, env)];
  return { ...result, errors, valid: errors.length === 0 };
}

export function checkWriter(m: RunState, runDir: string, env: NodeJS.ProcessEnv = process.env): ValidationError[] {
  const out: ValidationError[] = [];
  const notWritten = (p: string, message: string) => out.push({ code: 'ARTIFACT_NOT_AUTOPLAN_RUN', path: p, message });
  const mismatch = (p: string, message: string) => out.push({ code: 'ARTIFACT_JOURNAL_MISMATCH', path: p, message });
  if (m.host !== 'gstack-autoplan') notWritten('run.json.host', `host is ${JSON.stringify(m.host ?? null)}; gstack-autoplan writes "gstack-autoplan"`);
  for (const [field, kind] of WRITER_FIELDS) {
    const got = kindOf((m as unknown as Record<string, unknown>)[field]);
    if (got !== kind) notWritten(`run.json.${field}`, got === 'undefined' ? `missing; gstack-autoplan writes it on every run` : `expected ${kind}, got ${got}`);
  }
  if (!fs.existsSync(path.join(runDir, FILES.journal))) {
    notWritten(FILES.journal, 'no journal; gstack-autoplan appends one from the first next');
    return out;
  }
  const rows = readJournal(runDir);
  if (!rows.some(r => r.event === 'init' && r.run === m.run)) mismatch(FILES.journal, `no init row for run ${m.run}`);
  for (const [phase, ps] of Object.entries(m.phases ?? {})) {
    for (const voice of ['native', 'outside'] as const) {
      const v = ps?.[voice];
      if (!v) continue;
      for (const a of v.attempts ?? []) {
        if (!rows.some(r => r.event === 'dispatched' && r.attempt === a.attempt && r.phase === phase && r.voice === voice)) mismatch(FILES.journal, `${phase} ${voice} attempt ${a.attempt} was never journaled as dispatched`);
      }
      if (v.status !== 'completed') continue;
      if (typeof v.attempt !== 'string' || typeof v.result_sha256 !== 'string') { mismatch(`run.json.phases.${phase}.${voice}`, 'completed without the attempt and result_sha256 submit records'); continue; }
      const sub = rows.find(r => r.event === 'submitted' && r.attempt === v.attempt);
      if (!sub || sub.phase !== phase || sub.voice !== voice || sub.result_sha256 !== v.result_sha256 || (v.output && sub.result !== v.output)) {
        mismatch(FILES.journal, `${phase} ${voice}: run.json binds ${v.output ?? '?'} (${v.result_sha256.slice(0, 12)}) to ${v.attempt}; the journal's submitted row ${sub ? `says ${sub.phase} ${sub.voice} ${sub.result} (${String(sub.result_sha256).slice(0, 12)})` : 'is missing'}`);
        continue;
      }
      const bound = v.output ? path.resolve(runDir, v.output) : '';
      if (bound.startsWith(path.resolve(runDir) + path.sep) && fs.existsSync(bound) && sha256File(bound) !== v.result_sha256) mismatch(v.output!, `changed after submit: sha256 ${sha256File(bound).slice(0, 12)} is not the submitted ${v.result_sha256.slice(0, 12)}`);
    }
  }
  checkCheckpoint(m, runDir, rows, env, mismatch);
  return out;
}

/**
 * The run's own checkpoint is never ahead of run.json, agrees on status and gate at the same revision, and holds a
 * journal that is a prefix of the live one (append-only). Its own: the generation it was restored from, else the
 * newest valid one written from this run directory (its run.json names the same `out`); a copy restored elsewhere
 * forks the run and checkpoints into the same collection, so its generations say nothing about this directory.
 */
function checkCheckpoint(m: RunState, runDir: string, rows: Array<Record<string, any>>, env: NodeJS.ProcessEnv, mismatch: (p: string, message: string) => void): void {
  const root = checkpointRoot(env, repoOf(m));
  const collection = root ? path.join(path.resolve(root), m.run) : '';
  if (!collection || !fs.existsSync(collection)) return;
  const restored = rows.filter(r => r.event === 'restored').pop();
  const valid = listGenerations(collection).filter(g => g.manifest && !g.problem);
  const writtenFrom = (dir: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'run', FILES.run), 'utf8')).out; } catch { return undefined; } };
  const ref = restored ? valid.find(g => path.resolve(g.dir) === path.resolve(String(restored.from))) : valid.find(g => writtenFrom(g.dir) === m.out);
  if (!ref) return;
  const g = ref.manifest!;
  if (g.revision > m.revision) mismatch(ref.dir, `this checkpoint is at revision ${g.revision}, ahead of run.json's ${m.revision}`);
  else if (g.revision === m.revision && (g.status !== m.status || g.gate_rev !== (m.gate_rev ?? 0))) mismatch(ref.dir, `revision ${g.revision} was checkpointed as status=${g.status} gate_rev=${g.gate_rev}; run.json says status=${m.status} gate_rev=${m.gate_rev ?? 0}`);
  const saved = path.join(ref.dir, 'run', FILES.journal);
  if (fs.existsSync(saved) && !fs.readFileSync(path.join(runDir, FILES.journal)).subarray(0, fs.statSync(saved).size).equals(fs.readFileSync(saved))) {
    mismatch(ref.dir, `attempts.jsonl no longer begins with the journal checkpointed at revision ${g.revision}: an earlier row was changed or removed`);
  }
}
