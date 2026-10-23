/**
 * pregate — the cheap pre-gate (plan C8): the check registry, the two-stage
 * runner with separate clocks, the table, `pregate.json` and the publication
 * verdict. Stage 1 (mechanical preflight: regen, secrets, strays, literals,
 * …) is the two-minute promise and is timed per check; stage 2 (test
 * execution: lanes, …) has its own clock and is never folded into the first.
 * A failing check blocks; `.gstack/pregate.json` downgrades a named check to
 * warn except `secrets` and the required-lane verdicts; timeout or a missing
 * tool is `incomplete`, never `pass`. Tier 2 checks register here as they
 * land: `guards` (field wave CD1); ratchets, lint, links, hermetic, patches
 * and integrator later.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTIFACT_SCHEMAS, checkSchema, type PregateFile, type PregateRemote, type ValidationError } from '../headless-artifacts';
import { wtreeFingerprint, type WtreeResult } from '../script-invocation';
import { guardsCheck } from './checks/guards';
import { clearHint, lanesCheck, parseRemoteReport, REMOTE_GATE_LANE, remoteReportProblem } from './checks/lanes';
import { literalsCheck } from './checks/literals';
import { regenCheck } from './checks/regen';
import { secretsCheck } from './checks/secrets';
import { straysCheck } from './checks/strays';
import { timingCheck } from './checks/timing';
import { NON_DOWNGRADABLE } from './config';
import { sha256, withFingerprint } from './context';
import type { CheckDef, CheckResult, PregateContext, Stage } from './types';

export const CHECKS: readonly CheckDef[] = [regenCheck, secretsCheck, straysCheck, literalsCheck, timingCheck, guardsCheck, lanesCheck];
export const CHECK_IDS = CHECKS.map(c => c.id);
export const PREGATE_OUT_REL = '.gstack/tmp/pregate.json';
export const PREGATE_TIER2 = ['ratchets', 'lint', 'links', 'hermetic', 'patches', 'integrator'] as const;

export interface RunOptions { stage: Stage | 'all'; only?: string[]; run?: string }

/** Apply the repo's `warn` downgrades: never `secrets`, and never a lane that could run here and failed. */
export function applyDowngrades(ctx: PregateContext, result: CheckResult, def: CheckDef): CheckResult {
  if (result.status !== 'fail') return result;
  if (!def.downgradable || (NON_DOWNGRADABLE as readonly string[]).includes(def.id)) return result;
  if (!ctx.config.warn.includes(def.id)) return result;
  if (def.id === 'lanes' && result.code === 'PREGATE_LANE_FAILED') return { ...result, detail: `${result.detail} (required lane; warn downgrade does not apply)` };
  return { ...result, status: 'warn', detail: `${result.detail} (downgraded to warn by ${ctx.configLabel})` };
}

export async function runPregate(ctx: PregateContext, o: RunOptions): Promise<PregateFile> {
  const selected = CHECKS.filter(c => (o.stage === 'all' || c.stage === o.stage) && (!o.only || o.only.includes(c.id)));
  const checks: CheckResult[] = [];
  const clocks: Record<Stage, number> = { preflight: 0, tests: 0 };
  for (const def of selected) {
    const started = Date.now();
    const result = applyDowngrades(ctx, await withFingerprint(ctx, def.id, def.stage, () => def.run(ctx)), def);
    clocks[def.stage] += Date.now() - started;
    checks.push({ ...result, stage: def.stage });
  }
  const tests = checks.filter(c => c.stage === 'tests');
  if (tests.length) ctx.progress(`PREGATE: tests ${verdictOf({ schema_version: 1, tree: ctx.wtree, checks: tests, requires_remote: tests.flatMap(c => c.remote ?? []) })} in ${(clocks.tests / 1000).toFixed(1)}s — ${tests.map(c => `${c.id}: ${c.detail ?? c.status}`).join('; ')}`);
  const remote: PregateRemote[] = checks.flatMap(c => c.remote ?? []).map(r => ({ ...r }));
  const file: PregateFile = {
    schema_version: 1, tree: ctx.wtree, head: ctx.head, base: `${ctx.baseRef}@${ctx.baseSha.slice(0, 12)}`, generated_at: new Date().toISOString(),
    policy: ctx.configLabel, ...(ctx.configDigest ? { policy_digest: ctx.configDigest } : {}), ...(ctx.absentUserPolicy ? { policy_user_path: ctx.absentUserPolicy } : {}), registry: ctx.registryLabel, run: o.run,
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
  const remote = (file.requires_remote ?? []).map(r => {
    const run = r.command ? `run ${r.command.length > 200 ? `${r.command.slice(0, 200)}… (full command in pregate.json)` : r.command}, then ` : '';
    return `requires-remote: ${r.lane} (${r.platform}) ${r.tests.length} test(s) — ${r.receipt ? `cleared by ${r.receipt}` : `uncleared; ${run}clear with ${clearHint(r.lane)}`}`;
  });
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
 * incomplete, and every requires-remote obligation needs its receipt. The
 * user-owned policy behind the run (or its absence, under the defaults) must
 * still hold, since it lives outside the tree.
 */
export function verifyPregate(repoRoot: string, file: PregateFile, treeNow: WtreeResult = wtreeFingerprint({ cwd: repoRoot })): Verification {
  const uncleared = (file.requires_remote ?? []).filter(r => !r.receipt);
  const treeCurrent = 'tree' in treeNow && treeNow.tree === file.tree;
  if (!treeCurrent) return { ok: false, code: 'PREGATE_STALE', message: `pregate.json was recorded against tree ${file.tree.slice(0, 12)}; ${'tree' in treeNow ? `the tree is now ${treeNow.tree.slice(0, 12)}` : `the tree cannot be fingerprinted now (${treeNow.error})`}`, current: false, uncleared };
  const policyChange = userPolicyChange(file);
  if (policyChange) return { ok: false, code: 'PREGATE_STALE', message: policyChange, current: false, uncleared };
  const current = true;
  const failed = file.checks.filter(c => c.status === 'fail');
  if (failed.length) return { ok: false, code: 'PREGATE_LANE_FAILED', message: `${failed.length} check(s) failed: ${failed.map(c => c.id).join(', ')}`, current, uncleared };
  const incomplete = file.checks.filter(c => c.status === 'incomplete' || c.status === 'not_installed');
  if (incomplete.length) return { ok: false, code: 'PREGATE_INCOMPLETE', message: `${incomplete.length} check(s) incomplete: ${incomplete.map(c => c.id).join(', ')}`, current, uncleared };
  if (uncleared.length) return { ok: false, code: 'PREGATE_REMOTE_UNCLEARED', message: `${uncleared.length} requires-remote obligation(s) without a receipt: ${uncleared.map(r => r.lane).join(', ')}`, current, uncleared };
  return { ok: true, message: `pregate ${file.verdict} is current for tree ${file.tree.slice(0, 12)}`, current, uncleared };
}

/**
 * Why the user-owned policy a run recorded no longer holds, or null. Both paths come from the record, never the verifier's
 * environment: the policy file and its digest, or under the defaults the path that was looked for and absent.
 */
function userPolicyChange(file: PregateFile): string | null {
  const recorded = file.policy?.startsWith('user ') ? file.policy.slice('user '.length) : null;
  if (recorded) {
    if (!file.policy_digest) return `pregate.json names the user-owned policy ${recorded} without its digest; rerun gstack-pregate`;
    let text: string;
    try { text = fs.readFileSync(recorded, 'utf8'); } catch { return `the user-owned policy ${recorded} that pregate.json was recorded under is gone or unreadable; rerun gstack-pregate`; }
    return sha256(text) === file.policy_digest ? null : `the user-owned policy ${recorded} changed after pregate.json was recorded; rerun gstack-pregate`;
  }
  const absent = file.policy_user_path;
  if (!absent) return null;
  try { if (!fs.lstatSync(absent, { throwIfNoEntry: false })) return null; } catch (e) { return `cannot confirm ${absent} is still absent (${(e as Error).message}); rerun gstack-pregate`; }
  return `${absent} now holds a user-owned policy, and pregate.json was recorded under the defaults; rerun gstack-pregate`;
}

export interface ClearInput { runUrl?: string; bundleLane?: string; receiptPath?: string }
export type ClearDecision = { receipt: string; attested: boolean } | { refused: 'usage' | 'PREGATE_RECEIPT_INVALID'; message: string };

/**
 * What `clear` may record for one obligation. A `pregate.json/remote_gate`
 * obligation needs the gate's own report (`--receipt <file>` holding its
 * PREGATE_REMOTE: line), validated as `--remote` validates it against the
 * tested tree; a run URL is not checkable there. A `test_backend/<backend>`
 * obligation has no machine-checkable receipt, so its run URL is recorded as
 * attested. Platform lanes take a run URL or an evidence-bundle lane label.
 */
export function clearDecision(file: PregateFile, lane: string, input: ClearInput): ClearDecision {
  const list = file.requires_remote ?? [];
  const target = list.find(r => r.lane === lane);
  if (!target) return { refused: 'usage', message: `no requires-remote obligation named ${lane}; obligations: ${list.map(r => r.lane).join(', ') || '(none)'}` };
  if (target.lane === REMOTE_GATE_LANE) {
    if (!input.receiptPath) return { refused: 'usage', message: `${lane} clears only with --receipt <file> holding the remote gate's PREGATE_REMOTE: tree=… tests=… failed=… line (a run URL is not checkable); or rerun gstack-pregate --remote` };
    let text: string;
    try { text = fs.readFileSync(input.receiptPath, 'utf8'); }
    catch (e: any) { return { refused: 'PREGATE_RECEIPT_INVALID', message: `cannot read ${input.receiptPath}: ${e.message}` }; }
    const report = parseRemoteReport(text);
    const problem = report ? remoteReportProblem(report, file.tree) : `${input.receiptPath} has no PREGATE_REMOTE: line`;
    if (problem) return { refused: 'PREGATE_RECEIPT_INVALID', message: `${problem}; ${lane} stays uncleared` };
    return { receipt: `remote-gate tree=${file.tree.slice(0, 12)} tests=${report!.tests} receipt=${path.resolve(input.receiptPath)} sha256=${createHash('sha256').update(text).digest('hex').slice(0, 12)}`, attested: false };
  }
  if (input.receiptPath) return { refused: 'usage', message: `--receipt applies only to ${REMOTE_GATE_LANE}; clear ${lane} with --run-url <url>${target.workflow === 'test_backend' ? '' : ' or --bundle-lane <label>'}` };
  if (target.workflow === 'test_backend') {
    if (!input.runUrl) return { refused: 'usage', message: `${lane} clears with --run-url <url>` };
    return { receipt: `attested:${input.runUrl}`, attested: true };
  }
  const receipt = input.runUrl ?? (input.bundleLane ? `bundle-lane:${input.bundleLane}` : undefined);
  if (!receipt) return { refused: 'usage', message: `${lane} clears with --run-url <url> or --bundle-lane <label>` };
  return { receipt, attested: false };
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
