/**
 * pregate — the cheap pre-gate (plan C8): the check registry, the two-stage
 * runner with separate clocks, the table, `pregate.json` and the publication
 * verdict. Stage 1 (mechanical preflight: regen, secrets, strays, literals,
 * …) is the two-minute promise and is timed per check; stage 2 (test
 * execution: lanes, …) has its own clock and is never folded into the first.
 * A failing check blocks; `.gstack/pregate.json` downgrades a named check to
 * warn except `secrets` and the required-lane verdicts; timeout or a missing
 * tool is `incomplete`, never `pass`. Tier 2 checks (guards, ratchets, lint,
 * links, hermetic, patches, integrator) register here as they land.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_SCHEMAS, checkSchema, type PregateFile, type PregateRemote, type ValidationError } from '../headless-artifacts';
import { wtreeFingerprint } from '../regen';
import { lanesCheck } from './checks/lanes';
import { literalsCheck } from './checks/literals';
import { regenCheck } from './checks/regen';
import { secretsCheck } from './checks/secrets';
import { straysCheck } from './checks/strays';
import { NON_DOWNGRADABLE } from './config';
import { withFingerprint } from './context';
import type { CheckDef, CheckResult, PregateContext, Stage } from './types';

export const CHECKS: readonly CheckDef[] = [regenCheck, secretsCheck, straysCheck, literalsCheck, lanesCheck];
export const CHECK_IDS = CHECKS.map(c => c.id);
export const PREGATE_OUT_REL = '.gstack/tmp/pregate.json';
export const PREGATE_TIER2 = ['guards', 'ratchets', 'lint', 'links', 'hermetic', 'patches', 'integrator'] as const;

export interface RunOptions { stage: Stage | 'all'; only?: string[]; run?: string }

/** Apply the repo's `warn` downgrades: never `secrets`, and never a lane that could run here and failed. */
export function applyDowngrades(ctx: PregateContext, result: CheckResult, def: CheckDef): CheckResult {
  if (result.status !== 'fail') return result;
  if (!def.downgradable || (NON_DOWNGRADABLE as readonly string[]).includes(def.id)) return result;
  if (!ctx.config.warn.includes(def.id)) return result;
  if (def.id === 'lanes' && result.code === 'PREGATE_LANE_FAILED') return { ...result, detail: `${result.detail} (required lane; warn downgrade does not apply)` };
  return { ...result, status: 'warn', detail: `${result.detail} (downgraded to warn by ${ctx.configLabel})` };
}

export function runPregate(ctx: PregateContext, o: RunOptions): PregateFile {
  const selected = CHECKS.filter(c => (o.stage === 'all' || c.stage === o.stage) && (!o.only || o.only.includes(c.id)));
  const checks: CheckResult[] = [];
  const clocks: Record<Stage, number> = { preflight: 0, tests: 0 };
  for (const def of selected) {
    const started = Date.now();
    const result = applyDowngrades(ctx, withFingerprint(ctx, def.id, def.stage, () => def.run(ctx)), def);
    clocks[def.stage] += Date.now() - started;
    checks.push({ ...result, stage: def.stage });
  }
  const remote: PregateRemote[] = checks.flatMap(c => c.remote ?? []).map(r => ({ ...r }));
  const file: PregateFile = {
    schema_version: 1, tree: ctx.wtree, head: ctx.head, base: `${ctx.baseRef}@${ctx.baseSha.slice(0, 12)}`, generated_at: new Date().toISOString(),
    policy: ctx.configLabel, registry: ctx.registryLabel, run: o.run,
    stage1_ms: o.stage === 'tests' ? undefined : clocks.preflight, stage2_ms: o.stage === 'preflight' ? undefined : clocks.tests,
    checks: checks.map(c => { const { remote: _r, ...rest } = c; return rest; }),
    requires_remote: remote,
  };
  file.verdict = verdictOf(file);
  return file;
}

/** `pass`, `warn`, `requires-remote`, `incomplete` or `fail`: the worst status across checks, with uncleared obligations counted. */
export function verdictOf(file: PregateFile): string {
  const statuses = new Set(file.checks.map(c => c.status));
  if (statuses.has('fail')) return 'fail';
  if (statuses.has('incomplete') || statuses.has('not_installed')) return 'incomplete';
  const uncleared = (file.requires_remote ?? []).filter(r => !r.receipt);
  if (uncleared.length) return `requires-remote (${uncleared.length} uncleared)`;
  if (statuses.has('requires-remote')) return 'requires-remote cleared';
  if (statuses.has('warn')) return 'warn';
  return 'pass';
}

/** The table: one row per check with its stage, status, wall time and detail, then the stage clocks. */
export function renderTable(file: PregateFile, opts: { lines?: boolean } = { lines: true }): string {
  const rows = file.checks.map(c => `${c.stage === 'tests' ? 'tests    ' : 'preflight'}  ${c.id.padEnd(9)} ${c.status.padEnd(15)} ${String(c.ms ?? 0).padStart(7)} ms  ${c.detail ?? ''}${c.code && c.status !== 'pass' ? ` (${c.code})` : ''}`);
  const body = opts.lines ? file.checks.flatMap(c => (c.lines ?? []).map(l => `    ${c.id}: ${l}`).concat(c.fix && c.status !== 'pass' && c.status !== 'requires-remote' ? [`    ${c.id}: fix: ${c.fix}`] : [])) : [];
  const clocks = [
    file.stage1_ms !== undefined ? `stage 1 (mechanical preflight): ${file.stage1_ms} ms` : null,
    file.stage2_ms !== undefined ? `stage 2 (test execution): ${file.stage2_ms} ms` : null,
  ].filter(Boolean);
  const remote = (file.requires_remote ?? []).map(r => `requires-remote: ${r.lane} (${r.platform}) ${r.tests.length} test(s) — ${r.receipt ? `cleared by ${r.receipt}` : 'uncleared; clear with gstack-pregate clear --remote ' + r.lane + ' --run-url <url>'}`);
  return [
    `stage      check     status            time  detail`,
    ...rows, ...body, ...clocks, ...remote,
    `PREGATE: ${file.verdict} tree=${file.tree.slice(0, 12)} head=${(file.head ?? '').slice(0, 12)} checks=${file.checks.length}`,
  ].join('\n') + '\n';
}

export function writePregateFile(repoRoot: string, rel: string, file: PregateFile): string {
  const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const errors: ValidationError[] = [];
  const plain = JSON.parse(JSON.stringify(file));
  checkSchema(plain, ARTIFACT_SCHEMAS.pregate, '', errors, rel);
  if (errors.length) throw new Error(`pregate.json does not validate: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  fs.writeFileSync(abs, JSON.stringify(plain, null, 2) + '\n');
  return abs;
}

export function readPregateFile(file: string): { file: PregateFile | null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e: any) { return { file: null, errors: [{ code: 'ARTIFACT_INVALID_JSON', path: file, message: e.message }] }; }
  checkSchema(parsed, ARTIFACT_SCHEMAS.pregate, '', errors, file);
  return { file: errors.length ? null : (parsed as PregateFile), errors };
}

export interface Verification { ok: boolean; code?: 'PREGATE_STALE' | 'PREGATE_REMOTE_UNCLEARED' | 'PREGATE_INCOMPLETE' | 'PREGATE_LANE_FAILED'; message: string; current: boolean; uncleared: PregateRemote[] }

/**
 * Publication check: the recorded tree must equal the tree now (results
 * current after final generation and stamping), no check may be fail or
 * incomplete, and every requires-remote obligation needs its receipt.
 */
export function verifyPregate(repoRoot: string, file: PregateFile, treeNow = wtreeFingerprint(repoRoot)): Verification {
  const uncleared = (file.requires_remote ?? []).filter(r => !r.receipt);
  const current = !!treeNow && treeNow === file.tree;
  if (!current) return { ok: false, code: 'PREGATE_STALE', message: `pregate.json was recorded against tree ${file.tree.slice(0, 12)}; the tree is now ${(treeNow ?? 'unknown').slice(0, 12)}`, current, uncleared };
  const failed = file.checks.filter(c => c.status === 'fail');
  if (failed.length) return { ok: false, code: 'PREGATE_LANE_FAILED', message: `${failed.length} check(s) failed: ${failed.map(c => c.id).join(', ')}`, current, uncleared };
  const incomplete = file.checks.filter(c => c.status === 'incomplete' || c.status === 'not_installed');
  if (incomplete.length) return { ok: false, code: 'PREGATE_INCOMPLETE', message: `${incomplete.length} check(s) incomplete: ${incomplete.map(c => c.id).join(', ')}`, current, uncleared };
  if (uncleared.length) return { ok: false, code: 'PREGATE_REMOTE_UNCLEARED', message: `${uncleared.length} requires-remote obligation(s) without a receipt: ${uncleared.map(r => r.lane).join(', ')}`, current, uncleared };
  return { ok: true, message: `pregate ${file.verdict} is current for tree ${file.tree.slice(0, 12)}`, current, uncleared };
}

/** Record the receipt that clears one obligation (a run URL or an evidence-bundle lane label). */
export function clearObligation(file: PregateFile, lane: string, receipt: string, by: string): PregateFile {
  const list = file.requires_remote ?? [];
  const target = list.find(r => r.lane === lane);
  if (!target) throw new Error(`no requires-remote obligation named ${lane}; obligations: ${list.map(r => r.lane).join(', ') || '(none)'}`);
  target.receipt = receipt; target.cleared_by = by;
  file.verdict = verdictOf(file);
  return file;
}
