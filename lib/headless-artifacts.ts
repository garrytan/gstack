/**
 * headless-artifacts — the one versioned contract for every artifact the
 * unattended workflows write (plan B0): `tasks` (v2), `decisions`, `findings`,
 * `timing`, the `run` manifest, `pregate` and `ship-receipt`. One JSON Schema
 * per artifact is the source of truth for `gstack-artifact schema <name>` and
 * for the row validation `validateRun` performs, so a parent on another
 * machine reads the same contract this code enforces. Readers and writers:
 * bin/gstack-artifact (validate | schema | ack | urgent), bin/gstack-gate
 * (decisions), bin/gstack-autoplan-timing (timing), bin/gstack-review-log
 * --findings (findings), and the B-runner/C-stamp tools that stack on them.
 * Docs: docs/unattended.md. Error codes: lib/result-codes.ts.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultCodeName } from './result-codes';

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational';
export type Disposition = 'open' | 'accepted' | 'partially_accepted' | 'rejected' | 'deferred' | 'fixed';
export type Voice = 'native' | 'outside';
export type DecisionKind = 'auto' | 'approval' | 'user_challenge';
export type DecisionStatus = 'pending' | 'approved' | 'overridden' | 'rejected';
export type TaskStatus = 'pending' | 'ready' | 'blocked_on_dependency' | 'blocked_on_decision' | 'in_progress' | 'done';
export type VoiceStatus = 'completed' | 'unavailable' | 'disabled' | 'skipped' | 'failed' | 'pending' | 'running';
export type ResultStatus = 'complete' | 'gate_pending' | 'incomplete' | 'interrupted' | 'refused';
export type RunStatus = ResultStatus | 'awaiting_result' | 'running';

export interface FindingRow {
  schema_version: 1; run: string; id: string; phase: string; voice: Voice; severity: Severity; title: string;
  model?: string; file?: string; line?: number; disposition?: Disposition; resolution?: string;
  plan_items?: string[]; native_counterpart?: string; source?: string;
}
export interface DecisionRow {
  schema_version: 1; run: string; id: string; title: string; options: string[]; recommended: string | null;
  kind: DecisionKind; status: DecisionStatus; gate_rev: number; label?: string; phase?: string;
  default_if_unanswered?: string | null; chosen?: string | null; answered_at?: string; reply?: string;
  source?: string; cost?: string;
}
export interface TaskRow {
  schema_version: 2; run: string; id: string; title: string; status: TaskStatus; depends_on: string[];
  findings: string[]; blocked_by: string[]; acceptance: string; pr?: string; item?: string; tier?: number;
  priority?: string; component?: string; files?: string[];
}
export interface TimingPhase {
  phase: string; started_at?: string; ended_at?: string; wall_s?: number; outside_s?: number; native_s?: number;
  amend_s?: number; note?: string; start_utc?: string; end_utc?: string;
}
export interface TimingFile {
  schema_version: 1; run: string; phases: TimingPhase[]; started_at?: string; total_wall_s?: number;
  session_kind?: string; estimate?: Record<string, number | null>; [extra: string]: unknown;
}
export interface VoiceOutcome { status: VoiceStatus; model?: string; provider?: string; output?: string; [extra: string]: unknown }
export interface RunPhase { snapshot?: string; native?: VoiceOutcome; outside?: VoiceOutcome }
export interface RunManifest {
  schema_version: 1; run: string; status: RunStatus; required_phases: string[]; phases: Record<string, RunPhase>;
  artifacts: Record<string, { path: string; sha256: string }>; counts?: Record<string, number>;
  base?: string; host?: string; session_kind?: string; gate_rev?: number; gate?: Record<string, unknown>;
  consumed_by?: Array<{ consumer: string; at: string }>; deviations?: string[]; [extra: string]: unknown;
}
export interface PregateCheck { id: string; status: 'pass' | 'fail' | 'warn' | 'incomplete' | 'requires-remote' | 'not_installed'; ms?: number; detail?: string }
export interface PregateFile { schema_version: 1; tree: string; checks: PregateCheck[]; run?: string; stage1_ms?: number; stage2_ms?: number }
export interface ShipReceipt {
  schema_version: 1; head: string; base: string; pr?: number; version?: string; gated_tree?: string;
  gate?: Record<string, unknown>; ci?: Record<string, unknown>; spend_usd?: number | string; predecessor?: string;
  session_kind?: string; artifacts_consumed?: string; run?: string;
}

export const RESULT_STATUSES: readonly ResultStatus[] = ['complete', 'gate_pending', 'incomplete', 'interrupted', 'refused'];
const TERMINAL_RUN: readonly string[] = ['complete', 'gate_pending', 'refused', 'incomplete'];
const TERMINAL_VOICE: readonly string[] = ['completed', 'unavailable', 'disabled', 'skipped', 'failed'];
const RESOLVED: readonly string[] = ['accepted', 'partially_accepted', 'rejected', 'deferred', 'fixed'];

/** Shared exit table for every workflow command; printed by each bin's --help. */
export const EXIT = { ok: 0, fail: 1, usage: 2, refused: 3 } as const;
export function exitTableHelp(): string {
  return 'Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag';
}

/** `GSTACK_RESULT:` terminal line for workflow commands (never for pure queries). */
export function formatResult(skill: string, status: ResultStatus, run: string): string {
  return `GSTACK_RESULT: skill=${skill} status=${status} run=${run}`;
}
export function parseResult(text: string): { skill: string; status: ResultStatus; run: string } | undefined {
  const lines = text.split('\n').filter(l => l.startsWith('GSTACK_RESULT: '));
  const m = /^GSTACK_RESULT: skill=(\S+) status=(\S+) run=(.+)$/.exec(lines[lines.length - 1] ?? '');
  if (!m || !RESULT_STATUSES.includes(m[2] as ResultStatus)) return;
  return { skill: m[1]!, status: m[2] as ResultStatus, run: m[3]! };
}

// ---------------------------------------------------------------------------
// JSON Schemas (one per artifact; also the row validator's source of truth)
// ---------------------------------------------------------------------------
type Schema = {
  type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; enum?: readonly unknown[];
  items?: Schema; const?: unknown; description?: string; minimum?: number;
};
const str: Schema = { type: 'string' };
const strList: Schema = { type: 'array', items: str };
const nullableStr: Schema = { type: ['string', 'null'] };
const num: Schema = { type: 'number' };
const voiceOutcome: Schema = {
  type: 'object', required: ['status'],
  properties: { status: { enum: ['completed', 'unavailable', 'disabled', 'skipped', 'failed', 'pending', 'running'] }, model: str, provider: str, output: { ...str, description: 'artifact key holding this voice’s immutable output; defaults to <phase>-<voice>.md' } },
};

export const ARTIFACT_SCHEMAS = {
  findings: {
    type: 'object', description: 'one row per finding in findings.jsonl; shares the review-log row shape (bindReview --findings derives status from it)',
    required: ['schema_version', 'run', 'id', 'phase', 'voice', 'severity', 'title'],
    properties: {
      schema_version: { const: 1 }, run: str, id: { ...str, description: '<run>-<phase>-<voice>-<n>' }, phase: str,
      voice: { enum: ['native', 'outside'] }, model: str, severity: { enum: ['Critical', 'High', 'Medium', 'Low', 'Informational'] },
      title: str, file: str, line: { type: 'integer' }, disposition: { enum: ['open', 'accepted', 'partially_accepted', 'rejected', 'deferred', 'fixed'] },
      resolution: str, plan_items: strList, native_counterpart: nullableStr, source: str,
    },
  },
  decisions: {
    type: 'object', description: 'one row per decision in decisions.jsonl; gate items reference gate_rev (lib/gate-list.ts)',
    required: ['schema_version', 'run', 'id', 'title', 'options', 'recommended', 'kind', 'status', 'gate_rev'],
    properties: {
      schema_version: { const: 1 }, run: str, id: str, label: str, title: str, options: strList, recommended: nullableStr,
      kind: { enum: ['auto', 'approval', 'user_challenge'] }, status: { enum: ['pending', 'approved', 'overridden', 'rejected'] },
      default_if_unanswered: nullableStr, gate_rev: { type: 'integer', minimum: 1 }, phase: str, chosen: nullableStr,
      answered_at: str, reply: str, source: str, cost: str,
    },
  },
  tasks: {
    type: 'object', description: 'tasks.jsonl v2; v1 rows (phase/run_id/source_finding, scripts/resolvers/tasks-section.ts) still aggregate but do not validate here',
    required: ['schema_version', 'run', 'id', 'title', 'status', 'depends_on', 'findings', 'blocked_by', 'acceptance'],
    properties: {
      schema_version: { const: 2 }, run: str, id: str, title: str,
      status: { enum: ['pending', 'ready', 'blocked_on_dependency', 'blocked_on_decision', 'in_progress', 'done'] },
      depends_on: { ...strList, description: 'task ids, or a `pr` label another task in the file carries' },
      findings: { ...strList, description: 'finding ids' }, blocked_by: { ...strList, description: 'decision ids' },
      acceptance: { ...str, description: 'the command or check that proves the task' },
      pr: str, item: str, tier: { type: 'integer' }, priority: str, component: str, files: strList,
    },
  },
  timing: {
    type: 'object', required: ['schema_version', 'run', 'phases'],
    properties: {
      schema_version: { const: 1 }, run: str, started_at: str, total_wall_s: num, session_kind: str,
      phases: { type: 'array', items: { type: 'object', required: ['phase'], properties: { phase: str, started_at: str, ended_at: str, wall_s: num, outside_s: num, native_s: num, amend_s: num, note: str } } },
    },
  },
  run: {
    type: 'object', description: 'run.json manifest; `gstack-artifact validate run.json` is the completion check',
    required: ['schema_version', 'run', 'status', 'required_phases', 'phases', 'artifacts'],
    properties: {
      schema_version: { const: 1 }, run: str,
      status: { enum: ['complete', 'gate_pending', 'incomplete', 'interrupted', 'refused', 'awaiting_result', 'running'] },
      base: str, host: str, session_kind: str, required_phases: strList,
      phases: { type: 'object', description: 'phase id → { snapshot, native, outside }', properties: {} },
      counts: { type: 'object', description: 'decisions, decisions_pending, findings, tasks: each must equal the rows in its file' },
      artifacts: { type: 'object', description: 'artifact key → { path (relative to the run directory), sha256 }' },
      gate_rev: { type: 'integer' }, gate: { type: 'object' },
      consumed_by: { type: 'array', items: { type: 'object', required: ['consumer', 'at'], properties: { consumer: str, at: str } } },
      deviations: strList,
    },
  },
  pregate: {
    type: 'object', required: ['schema_version', 'tree', 'checks'],
    properties: {
      schema_version: { const: 1 }, run: str, tree: str, stage1_ms: num, stage2_ms: num,
      checks: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: str, status: { enum: ['pass', 'fail', 'warn', 'incomplete', 'requires-remote', 'not_installed'] }, ms: num, detail: str } } },
    },
  },
  'ship-receipt': {
    type: 'object', required: ['schema_version', 'head', 'base'],
    properties: {
      schema_version: { const: 1 }, pr: { type: 'integer' }, head: str, version: str, base: str, gated_tree: str,
      gate: { type: 'object' }, ci: { type: 'object' }, spend_usd: { type: ['number', 'string'] }, predecessor: str,
      session_kind: str, artifacts_consumed: { ...str, description: '<n>/<m>' }, run: str,
    },
  },
} as const satisfies Record<string, Schema>;

export type ArtifactName = keyof typeof ARTIFACT_SCHEMAS;
export const ARTIFACT_NAMES = Object.keys(ARTIFACT_SCHEMAS) as ArtifactName[];
export const SCHEMA_VERSIONS: Record<ArtifactName, number> = {
  findings: 1, decisions: 1, tasks: 2, timing: 1, run: 1, pregate: 1, 'ship-receipt': 1,
};

/** JSON Schema document for one artifact, as `gstack-artifact schema <name>` prints it. */
export function jsonSchema(name: ArtifactName): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/garrytan/gstack/docs/unattended.md#${name}-v${SCHEMA_VERSIONS[name]}`,
    title: `gstack ${name} v${SCHEMA_VERSIONS[name]}`,
    ...ARTIFACT_SCHEMAS[name],
  };
}

export interface ValidationError { code: ResultCodeName; path: string; message: string }

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeOk(v: unknown, t: string | string[]): boolean {
  const types = Array.isArray(t) ? t : [t];
  const actual = typeOf(v);
  return types.some(x => x === actual || (x === 'number' && actual === 'integer'));
}

/** Minimal schema check (type, required, enum, const, items, minimum); unknown fields are allowed. */
export function checkSchema(value: unknown, schema: Schema, at: string, out: ValidationError[], file = ''): void {
  const where = file ? `${file}${at}` : at;
  if (schema.const !== undefined && value !== schema.const) {
    const code: ResultCodeName = at.endsWith('schema_version') ? 'ARTIFACT_UNSUPPORTED_VERSION' : 'ARTIFACT_SCHEMA';
    out.push({ code, path: where, message: `expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    out.push({ code: 'ARTIFACT_SCHEMA', path: where, message: `expected one of ${schema.enum.join('|')}, got ${JSON.stringify(value)}` });
    return;
  }
  if (schema.type && !typeOk(value, schema.type)) {
    out.push({ code: 'ARTIFACT_SCHEMA', path: where, message: `expected ${[schema.type].flat().join('|')}, got ${typeOf(value)}` });
    return;
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    out.push({ code: 'ARTIFACT_SCHEMA', path: where, message: `expected >= ${schema.minimum}, got ${value}` });
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => checkSchema(item, schema.items!, `${at}[${i}]`, out, file));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) out.push({ code: 'ARTIFACT_SCHEMA', path: `${where}.${key}`, message: 'required field missing' });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) checkSchema(obj[key], sub, `${at}.${key}`, out, file);
    }
  }
}

/** Tolerant JSONL read: every line must be one object; a bad line (usually the tail) is an error, not a crash. */
export function readJsonl(file: string): { rows: Record<string, unknown>[]; errors: ValidationError[] } {
  const rows: Record<string, unknown>[] = [];
  const errors: ValidationError[] = [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, i) => {
    if (line.trim() === '') { errors.push({ code: 'ARTIFACT_MALFORMED_JSONL', path: `${file}:${i + 1}`, message: 'blank line inside a JSONL file' }); return; }
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      rows.push(parsed);
    } catch (e: any) {
      errors.push({ code: 'ARTIFACT_MALFORMED_JSONL', path: `${file}:${i + 1}`, message: i === lines.length - 1 ? `malformed tail: ${e.message}` : e.message });
    }
  });
  return { rows, errors };
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Resolve an artifact path inside the run dir; symlinks are followed and must stay inside. */
export function resolveInside(runDir: string, rel: string): { abs: string; error?: ValidationError } {
  const root = fs.realpathSync(runDir);
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    return { abs: path.resolve(root, rel), error: { code: 'ARTIFACT_PATH_ESCAPE', path: rel, message: 'absolute path or `..` segment' } };
  }
  const abs = path.resolve(root, rel);
  if (!fs.existsSync(abs)) return { abs, error: { code: 'ARTIFACT_MISSING', path: rel, message: 'file not found in the run directory' } };
  const real = fs.realpathSync(abs);
  if (real !== root && !real.startsWith(root + path.sep)) {
    return { abs, error: { code: 'ARTIFACT_PATH_ESCAPE', path: rel, message: `resolves to ${real}, outside the run directory` } };
  }
  return { abs: real };
}

function checkIds(rows: Record<string, unknown>[], run: string, file: string, out: ValidationError[]): Set<string> {
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const id = row.id;
    if (typeof id !== 'string') return;
    if (seen.has(id)) out.push({ code: 'ARTIFACT_DUPLICATE_ID', path: `${file}:${i + 1}`, message: `duplicate id ${id}` });
    seen.add(id);
    if (!id.startsWith(`${run}-`)) out.push({ code: 'ARTIFACT_UNBOUND_ID', path: `${file}:${i + 1}`, message: `id ${id} is not bound to run ${run}` });
    if (row.run !== undefined && row.run !== run) out.push({ code: 'ARTIFACT_UNBOUND_ID', path: `${file}:${i + 1}`, message: `row.run ${JSON.stringify(row.run)} is not ${run}` });
  });
  return seen;
}

function findCycle(tasks: Record<string, unknown>[]): string[] | undefined {
  const byPr = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const t of tasks) {
    if (typeof t.id !== 'string') continue;
    ids.add(t.id);
    if (typeof t.pr === 'string') byPr.set(t.pr, [...(byPr.get(t.pr) ?? []), t.id]);
  }
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    if (typeof t.id !== 'string') continue;
    const deps = (Array.isArray(t.depends_on) ? t.depends_on : []).flatMap((d: unknown) =>
      typeof d !== 'string' ? [] : ids.has(d) ? [d] : (byPr.get(d) ?? []).filter(x => x !== t.id));
    edges.set(t.id, deps);
  }
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1); stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) { const found = visit(next); if (found) return found; }
    }
    stack.pop(); state.set(id, 2);
    return undefined;
  };
  for (const id of edges.keys()) if (!state.has(id)) { const found = visit(id); if (found) return found; }
  return undefined;
}

function checkPhases(m: RunManifest, out: ValidationError[]): void {
  if (!TERMINAL_RUN.includes(m.status)) {
    out.push({ code: 'ARTIFACT_RUN_INTERRUPTED', path: 'run.json.status', message: `status ${m.status} is not terminal` });
  }
  for (const phase of m.required_phases ?? []) {
    const p = m.phases?.[phase];
    if (!p) { out.push({ code: 'ARTIFACT_REVIEWER_MISSING', path: `run.json.phases.${phase}`, message: 'required phase absent' }); continue; }
    for (const voice of ['native', 'outside'] as const) {
      const v = p[voice];
      if (!v || typeof v !== 'object') { out.push({ code: 'ARTIFACT_REVIEWER_MISSING', path: `run.json.phases.${phase}.${voice}`, message: 'voice has no outcome' }); continue; }
      checkSchema(v, voiceOutcome, `.phases.${phase}.${voice}`, out, 'run.json');
      if (['pending', 'running'].includes(String(v.status))) {
        out.push({ code: 'ARTIFACT_RUN_INTERRUPTED', path: `run.json.phases.${phase}.${voice}.status`, message: `voice is still ${v.status}` });
      } else if (!TERMINAL_VOICE.includes(String(v.status))) {
        continue;
      }
      if (v.status === 'completed') {
        const key = typeof v.output === 'string' ? v.output : `${phase}-${voice}.md`;
        if (!m.artifacts?.[key]) out.push({ code: 'ARTIFACT_REVIEWER_MISSING', path: `run.json.phases.${phase}.${voice}`, message: `completed voice has no bound output artifact ${key}` });
      }
    }
  }
}

function checkCounts(m: RunManifest, rows: Partial<Record<ArtifactName, Record<string, unknown>[]>>, out: ValidationError[]): void {
  const counts = m.counts ?? {};
  const expect = (key: string, actual: number | undefined) => {
    if (actual === undefined || typeof counts[key] !== 'number') return;
    if (counts[key] !== actual) out.push({ code: 'ARTIFACT_COUNT_MISMATCH', path: `run.json.counts.${key}`, message: `manifest says ${counts[key]}, file has ${actual}` });
  };
  expect('decisions', rows.decisions?.length);
  expect('decisions_pending', rows.decisions?.filter(r => r.status === 'pending').length);
  expect('findings', rows.findings?.length);
  expect('tasks', rows.tasks?.length);
}

function checkRefs(rows: Partial<Record<ArtifactName, Record<string, unknown>[]>>, ids: Partial<Record<ArtifactName, Set<string>>>, out: ValidationError[]): void {
  const prs = new Set((rows.tasks ?? []).map(t => t.pr).filter((p): p is string => typeof p === 'string'));
  const need = (list: unknown, pool: Set<string> | undefined, where: string, what: string, extra?: Set<string>) => {
    if (!Array.isArray(list) || !pool) return;
    for (const ref of list) {
      if (typeof ref === 'string' && (pool.has(ref) || extra?.has(ref))) continue;
      out.push({ code: 'ARTIFACT_DANGLING_REF', path: where, message: `${what} ${JSON.stringify(ref)} is not defined in this run` });
    }
  };
  (rows.tasks ?? []).forEach((t, i) => {
    need(t.findings, ids.findings, `tasks.jsonl:${i + 1}.findings`, 'finding');
    need(t.blocked_by, ids.decisions, `tasks.jsonl:${i + 1}.blocked_by`, 'decision');
    need(t.depends_on, ids.tasks, `tasks.jsonl:${i + 1}.depends_on`, 'task', prs);
  });
  const cycle = rows.tasks ? findCycle(rows.tasks) : undefined;
  if (cycle) out.push({ code: 'ARTIFACT_DEPENDENCY_CYCLE', path: 'tasks.jsonl', message: cycle.join(' -> ') });
}

export interface ValidationResult { valid: boolean; errors: ValidationError[]; manifest?: RunManifest; runDir: string }

/**
 * The deterministic completion check a parent runs first. Fails on: invalid
 * JSON, an unsupported version, a non-terminal run or voice, a required
 * phase or voice without a terminal outcome or bound output, a listed artifact
 * that is missing, stale (hash) or escapes the run directory, malformed JSONL,
 * schema violations, duplicate or unbound ids, dangling references, task
 * dependency cycles, count mismatches, and an unattended run whose
 * review-record.md lacks the GUARD_NOT_INSTALLED line.
 */
export function validateRun(runJson: string): ValidationResult {
  const runDir = path.dirname(path.resolve(runJson));
  const errors: ValidationError[] = [];
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(runJson, 'utf8'));
  } catch (e: any) {
    return { valid: false, runDir, errors: [{ code: 'ARTIFACT_INVALID_JSON', path: runJson, message: e.message }] };
  }
  checkSchema(manifest, ARTIFACT_SCHEMAS.run, '', errors, 'run.json');
  if (errors.length) return { valid: false, errors, manifest, runDir };
  checkPhases(manifest, errors);

  const rows: Partial<Record<ArtifactName, Record<string, unknown>[]>> = {};
  const ids: Partial<Record<ArtifactName, Set<string>>> = {};
  const seenAbs = new Set<string>();
  for (const [key, entry] of Object.entries(manifest.artifacts)) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      errors.push({ code: 'ARTIFACT_SCHEMA', path: `run.json.artifacts.${key}`, message: 'expected { path, sha256 }' });
      continue;
    }
    const { abs, error } = resolveInside(runDir, entry.path);
    if (error) { errors.push({ ...error, path: `run.json.artifacts.${key} (${entry.path})` }); continue; }
    seenAbs.add(abs);
    const actual = sha256File(abs);
    if (actual !== entry.sha256) errors.push({ code: 'ARTIFACT_STALE', path: entry.path, message: `sha256 ${actual.slice(0, 12)}… differs from the manifest’s ${entry.sha256.slice(0, 12)}…` });
    const name = (['decisions', 'findings', 'tasks'] as const).find(n => key === `${n}.jsonl`);
    if (name) {
      const read = readJsonl(abs);
      errors.push(...read.errors);
      read.rows.forEach((row, i) => checkSchema(row, ARTIFACT_SCHEMAS[name], `:${i + 1}`, errors, entry.path));
      ids[name] = checkIds(read.rows, manifest.run, entry.path, errors);
      rows[name] = read.rows;
    } else if (key === 'timing.json') {
      try { checkSchema(JSON.parse(fs.readFileSync(abs, 'utf8')), ARTIFACT_SCHEMAS.timing, '', errors, entry.path); }
      catch (e: any) { errors.push({ code: 'ARTIFACT_INVALID_JSON', path: entry.path, message: e.message }); }
    }
  }
  checkCounts(manifest, rows, errors);
  checkRefs(rows, ids, errors);
  if (manifest.session_kind === 'unattended') {
    const record = manifest.artifacts['review-record.md'];
    const abs = record ? resolveInside(runDir, record.path).abs : '';
    const text = abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    if (!text.includes('GUARD_NOT_INSTALLED')) errors.push({ code: 'ARTIFACT_GUARD_LINE_MISSING', path: 'review-record.md', message: 'unattended run without the guard line' });
  }
  return { valid: errors.length === 0, errors, manifest, runDir };
}

/** Validate a standalone artifact file (pregate.json, a ship receipt, timing.json, or a JSONL of rows) against its schema. */
export function validateFile(file: string, name: ArtifactName, run?: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (file.endsWith('.jsonl')) {
    const read = readJsonl(file);
    errors.push(...read.errors);
    read.rows.forEach((row, i) => checkSchema(row, ARTIFACT_SCHEMAS[name], `:${i + 1}`, errors, file));
    if (run) checkIds(read.rows, run, file, errors);
    return errors;
  }
  try { checkSchema(JSON.parse(fs.readFileSync(file, 'utf8')), ARTIFACT_SCHEMAS[name], '', errors, file); }
  catch (e: any) { errors.push({ code: 'ARTIFACT_INVALID_JSON', path: file, message: e.message }); }
  return errors;
}

// ---------------------------------------------------------------------------
// Derivations shared with the review log (B7) and the final report (B12)
// ---------------------------------------------------------------------------
export interface DerivedReviewStatus {
  status: 'clean' | 'issues_open'; unresolved: number; issues_found: number; critical_gaps: number;
  findings_total: number; findings_open: number; findings_resolved: number;
}
export function isOpenFinding(row: Record<string, unknown>): boolean {
  if (typeof row.disposition === 'string') return !RESOLVED.includes(row.disposition);
  if (typeof row.status === 'string') return !['resolved', 'fixed', 'closed'].includes(row.status);
  return row.action !== 'fixed';
}
export function isCriticalFinding(row: Record<string, unknown>): boolean {
  return typeof row.severity === 'string' && row.severity.toLowerCase() === 'critical';
}
/** `clean` only when no finding is open; counts are over the whole file. */
export function deriveReviewStatus(rows: Record<string, unknown>[]): DerivedReviewStatus {
  const open = rows.filter(isOpenFinding);
  return {
    status: open.length === 0 ? 'clean' : 'issues_open',
    unresolved: open.length, issues_found: rows.length, critical_gaps: open.filter(isCriticalFinding).length,
    findings_total: rows.length, findings_open: open.length, findings_resolved: rows.length - open.length,
  };
}

const URGENT_HEADING = '## URGENT, outside this plan';
/** Fixed first block of the final report and plan.md: security or data-loss findings the plan does not own. */
export function renderUrgentBlock(rows: Record<string, unknown>[]): string {
  const urgent = rows.filter(r => r.urgent === true || r.outside_plan === true);
  if (urgent.length === 0) return `${URGENT_HEADING}\n\nNone.\n`;
  const lines = urgent.map(r => {
    const owner = typeof r.suggested_owner === 'string' ? r.suggested_owner : 'owner: unassigned';
    const sev = typeof r.severity === 'string' ? r.severity : 'unrated';
    return `- ${r.id ?? '(no id)'} [${sev}] ${r.title ?? ''} — ${owner}`;
  });
  return `${URGENT_HEADING}\n\n${lines.join('\n')}\n`;
}
export function urgentBlockPrecedes(text: string, summaryMarker = '### Plan Summary'): boolean {
  const u = text.indexOf(URGENT_HEADING);
  const s = text.indexOf(summaryMarker);
  return u >= 0 && (s < 0 || u < s);
}

// ---------------------------------------------------------------------------
// ack: the idempotent consumption report behind P7
// ---------------------------------------------------------------------------
export interface AckResult { consumed_by: Array<{ consumer: string; at: string }>; added: boolean; analytics: 'appended' | 'skipped_ephemeral' | 'already_acked' }
export function ackRun(runJson: string, consumer: string, opts: { analyticsPath: string; ephemeral: boolean; now?: Date }): AckResult {
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(consumer)) throw new Error(`consumer id must match [A-Za-z0-9_.:@/-]{1,200}, got ${JSON.stringify(consumer)}`);
  const manifest: RunManifest = JSON.parse(fs.readFileSync(runJson, 'utf8'));
  const list = Array.isArray(manifest.consumed_by) ? manifest.consumed_by : [];
  if (list.some(c => c.consumer === consumer)) return { consumed_by: list, added: false, analytics: 'already_acked' };
  const at = (opts.now ?? new Date()).toISOString();
  manifest.consumed_by = [...list, { consumer, at }];
  const tmp = `${runJson}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, runJson);
  if (opts.ephemeral) return { consumed_by: manifest.consumed_by, added: true, analytics: 'skipped_ephemeral' };
  fs.mkdirSync(path.dirname(opts.analyticsPath), { recursive: true });
  fs.appendFileSync(opts.analyticsPath, JSON.stringify({ event: 'ack', run: manifest.run, consumer, ts: at, session_kind: manifest.session_kind ?? null }) + '\n');
  return { consumed_by: manifest.consumed_by, added: true, analytics: 'appended' };
}
