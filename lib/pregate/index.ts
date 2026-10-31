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
import { ARTIFACT_SCHEMAS, checkSchema, type PregateFile, type PregateReceiptSubstitution, type PregateRemote, type ValidationError } from '../headless-artifacts';
import { wtreeFingerprint, type WtreeResult } from '../script-invocation';
import { resolveStateRoot } from '../state-root';
import { guardsCheck } from './checks/guards';
import { clearHint, lanesCheck, parseRemoteReport, REMOTE_GATE_LANE, remoteReportProblem, treeMismatch } from './checks/lanes';
import { literalsCheck } from './checks/literals';
import { regenCheck } from './checks/regen';
import { secretsCheck } from './checks/secrets';
import { straysCheck } from './checks/strays';
import { timingCheck } from './checks/timing';
import { NON_DOWNGRADABLE, PREGATE_CONFIG_PATH, userPolicyAbsent } from './config';
import { sha256, withFingerprint } from './context';
import { baseBranchOf, baseMismatchFix, describeSubstitution, substituteStampOnlyTree } from './remote-receipt';
import { resolveBaseBranch } from '../ship-policy';
import { parseRunReceipt, parseRunRef, runChanged, runReceiptFields, uncoveredFiles, verifyRun, type RemoteGateRuns, type RunDeps, type RunEvidence, type RunProfile } from '../run-evidence';
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
    policy: ctx.configLabel, ...(ctx.configDigest ? { policy_digest: ctx.configDigest } : {}), ...(ctx.absentUserPolicy ? { policy_user_path: ctx.absentUserPolicy } : {}), registry: ctx.registryLabel, run: o.run, scratch: ctx.scratch,
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
    file.scratch ? `scratch: ${file.scratch}` : null,
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

/** Where a pregate record is mirrored by the tree it was recorded against: `<state root>/pregate/by-tree/<tree>.json`. */
export function pregateMirrorPath(tree: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateRoot(env), 'pregate', 'by-tree', `${tree}.json`);
}

/**
 * Write the record, then mirror the same bytes under the state root by tree
 * (pregateMirrorPath), so a checkout that did not run the pregate (a lane
 * whose `--remote` run had to happen in a separate clone) can still find the
 * verdict for its tree through `gstack-ship-queue ready`. The mirror is best
 * effort: a failure to write it never fails the record.
 */
export function writePregateFile(repoRoot: string, rel: string, file: PregateFile): string {
  const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const errors: ValidationError[] = [];
  const plain = JSON.parse(JSON.stringify(file));
  checkSchema(plain, ARTIFACT_SCHEMAS.pregate, '', errors, rel);
  if (errors.length) throw new Error(`pregate.json does not validate: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  const json = JSON.stringify(plain, null, 2) + '\n';
  fs.writeFileSync(abs, json);
  if (/^[0-9a-f]{12,128}$/.test(file.tree)) {
    try {
      const mirror = pregateMirrorPath(file.tree);
      fs.mkdirSync(path.dirname(mirror), { recursive: true });
      fs.writeFileSync(`${mirror}.${process.pid}.tmp`, json);
      fs.renameSync(`${mirror}.${process.pid}.tmp`, mirror);
    } catch {}
  }
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

export interface Verification { ok: boolean; code?: 'PREGATE_STALE' | 'PREGATE_REMOTE_UNCLEARED' | 'PREGATE_INCOMPLETE' | 'PREGATE_ENVIRONMENT' | 'PREGATE_LANE_FAILED'; message: string; current: boolean; uncleared: PregateRemote[] }

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
  // An environment cause is named apart from the diff: a lane waives it by kind, never by test name.
  const environment = incomplete.filter(c => c.cause === 'environment');
  if (environment.length === incomplete.length && environment.length) {
    const inferred = environment.filter(c => c.environment?.proof === 'output');
    const caveat = inferred.length ? `; ${inferred.map(c => c.id).join(', ')} inferred from output alone (no test was counted): confirm on another machine or with --remote before treating the diff as clear` : '';
    return { ok: false, code: 'PREGATE_ENVIRONMENT', message: `${environment.length} check(s) blocked by the environment (${[...new Set(environment.map(c => c.environment?.kind ?? 'unknown'))].join(', ')}), not by the diff: ${environment.map(c => `${c.id}: ${c.environment?.evidence ?? c.detail}`).join('; ')}${caveat}`, current, uncleared };
  }
  if (incomplete.length) return { ok: false, code: 'PREGATE_INCOMPLETE', message: `${incomplete.length} check(s) incomplete: ${incomplete.map(c => c.id).join(', ')}${environment.length ? ` (blocked by the environment: ${environment.map(c => `${c.id} ${c.environment?.kind}`).join(', ')})` : ''}`, current, uncleared };
  if (uncleared.length) return { ok: false, code: 'PREGATE_REMOTE_UNCLEARED', message: `${uncleared.length} requires-remote obligation(s) without a receipt: ${uncleared.map(r => r.lane).join(', ')}`, current, uncleared };
  // A receipt accepted from a stamp-only predecessor tree was accepted for one head tree; recorded for another, it clears nothing here.
  const misapplied = (file.requires_remote ?? []).filter(r => r.substitution && (r.substitution.accepted_for !== file.tree || !(r.receipt ?? '').includes(`tree=${r.substitution.gated_tree.slice(0, 12)} `)));
  if (misapplied.length) return { ok: false, code: 'PREGATE_REMOTE_UNCLEARED', message: `${misapplied.length} remote receipt(s) accepted for another tree or recorded against another gated tree: ${misapplied.map(r => `${r.lane} (accepted for ${r.substitution!.accepted_for.slice(0, 12)} from gated ${r.substitution!.gated_tree.slice(0, 12)}, pregate.json is ${file.tree.slice(0, 12)})`).join(', ')}; clear again`, current, uncleared: misapplied };
  // A run receipt was verified online at clear for its tree; offline it must still name this tree (or carry its substitution).
  const foreignRuns = (file.requires_remote ?? []).filter(r => { const run = parseRunReceipt(r.receipt ?? ''); return run && !r.substitution && run.tree !== file.tree.slice(0, 12); });
  if (foreignRuns.length) return { ok: false, code: 'PREGATE_REMOTE_UNCLEARED', message: `${foreignRuns.length} run receipt(s) verified for another tree: ${foreignRuns.map(r => `${r.lane} (${r.receipt})`).join(', ')}; clear again with runs on tree ${file.tree.slice(0, 12)}`, current, uncleared: foreignRuns };
  const substituted = (file.requires_remote ?? []).filter(r => r.substitution).map(r => `${r.lane}: ${describeSubstitution(r.substitution!)}`);
  return { ok: true, message: `pregate ${file.verdict} is current for tree ${file.tree.slice(0, 12)}${substituted.length ? `; ${substituted.join('; ')}` : ''}`, current, uncleared };
}

/**
 * Why the user-owned policy a run recorded no longer holds, or null. Both paths come from the record, never the verifier's
 * environment: the policy file and its digest, or under the defaults the path that was looked for and absent.
 */
function userPolicyChange(file: PregateFile): string | null {
  const recorded = file.policy?.startsWith('user ') ? file.policy.slice('user '.length) : file.policy?.startsWith('head ') ? / over user (.+)$/.exec(file.policy)?.[1] ?? null : null;
  if (recorded) {
    if (!file.policy_digest) return `pregate.json names the user-owned policy ${recorded} without its digest; rerun gstack-pregate`;
    let text: string;
    try { text = fs.readFileSync(recorded, 'utf8'); } catch { return `the user-owned policy ${recorded} that pregate.json was recorded under is gone or unreadable; rerun gstack-pregate`; }
    return sha256(text) === file.policy_digest ? null : `the user-owned policy ${recorded} changed after pregate.json was recorded; rerun gstack-pregate`;
  }
  const absent = file.policy_user_path;
  if (!absent) return null;
  if (userPolicyAbsent(absent)) return null;
  let leaf: fs.Stats | undefined;
  try { leaf = fs.lstatSync(absent, { throwIfNoEntry: false }); } catch { leaf = undefined; }
  if (!leaf) return `cannot confirm ${absent} is still absent (a link on the way to it is dangling or unreadable); rerun gstack-pregate`;
  return `${absent} now holds a user-owned policy, and pregate.json was recorded under the defaults; rerun gstack-pregate`;
}

export interface ClearInput { runUrl?: string; bundleLane?: string; receiptPath?: string; runs?: string[]; evidence?: RunCheck }
/** What a run clear needs: the base branch's run profiles, the verifier's dependencies, the clock, and the remote gate's inventory. */
export interface RunCheck { repo: string; deps: RunDeps; profiles: Record<string, RunProfile>; gateRuns: RemoteGateRuns | null; now: Date; inventory: (command: string, tree: string) => string[] | { error: string } }
export type ClearDecision = { receipt: string; attested: boolean; substitution?: PregateReceiptSubstitution } | { refused: 'usage' | 'PREGATE_RECEIPT_INVALID'; message: string; fix?: string };

/**
 * What `clear` may record for one obligation. A `pregate.json/remote_gate`
 * obligation needs the gate's own report (`--receipt <file>` holding its
 * PREGATE_REMOTE: line), validated as `--remote` validates it against the
 * tested tree; a run URL is not checkable there. A report whose tree is a
 * stamp-only predecessor of pregate.json's tree in `repoRoot` (the gate ran
 * ahead of the stamp; lib/pregate/remote-receipt.ts) is accepted for this
 * tree and the substitution recorded; when any differing path is not a stamp,
 * the tree mismatch refuses as before. A `test_backend/<backend>` obligation
 * has no machine-checkable receipt, so its run URL is recorded as attested.
 * Platform lanes take a run URL or an evidence-bundle lane label.
 *
 * `--run` (and `--run-url` on a lane the base branch profiles) goes to
 * clearByRuns, which accepts only verified Actions runs; a profiled lane
 * refuses `--bundle-lane`, and the remote gate clears by runs only when the
 * base declares remote_gate_runs.
 */
export function clearDecision(file: PregateFile, lane: string, input: ClearInput, repoRoot: string): ClearDecision {
  const list = file.requires_remote ?? [];
  const target = list.find(r => r.lane === lane);
  if (!target) return { refused: 'usage', message: `no requires-remote obligation named ${lane}; obligations: ${list.map(r => r.lane).join(', ') || '(none)'}` };
  const profiled = input.evidence && (lane === REMOTE_GATE_LANE ? input.evidence.gateRuns : input.evidence.profiles[lane]);
  if (input.runs?.length || (input.runUrl && profiled)) return clearByRuns(file, lane, [...(input.runs ?? []), ...(input.runUrl ? [input.runUrl] : [])], input.evidence, repoRoot);
  if (input.bundleLane && profiled && lane !== REMOTE_GATE_LANE) return { refused: 'usage', message: `${lane} has a run profile on the base branch; clear it with --run <id|url>, which verifies the run` };
  if (target.lane === REMOTE_GATE_LANE) {
    if (!input.receiptPath) return { refused: 'usage', message: `${lane} clears only with --receipt <file> holding the remote gate's PREGATE_REMOTE: tree=… tests=… failed=… line (a run URL is not checkable); or rerun gstack-pregate --remote` };
    let text: string;
    try { text = fs.readFileSync(input.receiptPath, 'utf8'); }
    catch (e: any) { return { refused: 'PREGATE_RECEIPT_INVALID', message: `cannot read ${input.receiptPath}: ${e.message}` }; }
    const report = parseRemoteReport(text);
    if (!report) return { refused: 'PREGATE_RECEIPT_INVALID', message: `${input.receiptPath} has no PREGATE_REMOTE: line; ${lane} stays uncleared` };
    const own = remoteReportProblem(report, report.tree);
    if (own) return { refused: 'PREGATE_RECEIPT_INVALID', message: `${own}; ${lane} stays uncleared` };
    const sub = treeSubstitution(file, report.tree, lane, repoRoot);
    if ('refused' in sub) return sub;
    const substitution = sub.substitution;
    const problem = remoteReportProblem(report, substitution ? report.tree : file.tree);
    if (problem) return { refused: 'PREGATE_RECEIPT_INVALID', message: `${problem}; ${lane} stays uncleared` };
    const accepted = substitution ? ` accepted-for=${file.tree.slice(0, 12)} stamp-only=${substitution.files.length}` : '';
    return { receipt: `remote-gate tree=${report.tree.slice(0, 12)} tests=${report.tests}${accepted} receipt=${path.resolve(input.receiptPath)} sha256=${createHash('sha256').update(text).digest('hex').slice(0, 12)}`, attested: false, substitution };
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

/** The stamp-only substitution that lets a receipt for `gatedTree` clear pregate.json's tree, none when the trees are equal, or the refusal. */
function treeSubstitution(file: PregateFile, gatedTree: string, lane: string, repoRoot: string): { substitution?: PregateReceiptSubstitution } | Extract<ClearDecision, { refused: string }> {
  if (gatedTree === file.tree) return {};
  // The stamp rule is the ship's own base branch's policy (origin/HEAD, as regate reads it), never a branch the artifact names.
  const base = resolveBaseBranch(repoRoot);
  const recorded = baseBranchOf(file.base);
  if (recorded && recorded !== base) return { refused: 'PREGATE_RECEIPT_INVALID', message: `${treeMismatch(gatedTree, file.tree)}; pregate.json was recorded against origin/${recorded}, not this repository's base origin/${base}, so the stamp rule that would class the difference is not the base's; ${lane} stays uncleared`, fix: baseMismatchFix(repoRoot, base, recorded) };
  const s = substituteStampOnlyTree(repoRoot, base, gatedTree, file.tree);
  if ('problem' in s) return { refused: 'PREGATE_RECEIPT_INVALID', message: `${s.problem}; ${lane} stays uncleared`, fix: s.fix };
  return { substitution: s.substitution };
}

/**
 * `clear --run`: GitHub Actions runs as the obligation's evidence (lib/run-evidence.ts). The remote gate needs one
 * verified run per `remote_gate_runs` profile, all on one tree, whose tree.json file lists together cover every file
 * the gate's inventory command prints; any other lane needs one verified run of the profile named after it. The run
 * tree must be pregate.json's tree or a stamp-only predecessor of it, exactly as a gate report's tree must.
 */
function clearByRuns(file: PregateFile, lane: string, refs: string[], check: RunCheck | undefined, repoRoot: string): ClearDecision {
  if (!check) return { refused: 'usage', message: `--run needs the base branch's run_profiles; none could be read` };
  const isGate = lane === REMOTE_GATE_LANE;
  const names = isGate ? check.gateRuns?.profiles ?? [] : check.profiles[lane] ? [lane] : [];
  if (!names.length) return { refused: 'usage', message: isGate ? `--run clears ${lane} only when the base branch's ${PREGATE_CONFIG_PATH} declares remote_gate_runs` : `--run clears ${lane} only when the base branch's ${PREGATE_CONFIG_PATH} declares a run_profiles entry named ${lane}` };
  if (refs.length !== names.length) return { refused: 'usage', message: `${lane} clears with exactly ${names.length} run(s), one per profile (${names.join(', ')}); got ${refs.length}` };
  const ids = refs.map(ref => parseRunRef(ref, check.repo) ?? ref);
  if (new Set(ids).size !== ids.length) return { refused: 'usage', message: `${lane} needs a different run for each profile; got ${refs.join(', ')}` };
  // The profiles are the base branch's; a pregate.json recorded against another base names another authority.
  const base = resolveBaseBranch(repoRoot);
  const recorded = baseBranchOf(file.base);
  if (recorded && recorded !== base) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=base_mismatch — pregate.json was recorded against origin/${recorded}, but run profiles come from this repository's base origin/${base}; ${lane} stays uncleared`, fix: baseMismatchFix(repoRoot, base, recorded) };
  const verdicts = new Map<string, ReturnType<typeof verifyRun>>();
  const verdict = (name: string, ref: string) => {
    const key = `${name}\0${ref}`;
    if (!verdicts.has(key)) verdicts.set(key, verifyRun(check.deps, { repo: check.repo, runRef: ref, profileName: name, profile: check.profiles[name]!, vetoHeads: file.head ? [file.head] : [], now: check.now }));
    return verdicts.get(key)!;
  };
  const missingProfile = names.find(name => !check.profiles[name]);
  if (missingProfile) return { refused: 'usage', message: `run profile ${missingProfile} is not declared` };
  // Every profile gets its own verified run; search the whole assignment so a run valid for two profiles cannot starve one.
  const assign = (i: number, used: Set<string>): RunEvidence[] | null => {
    if (i === names.length) return [];
    for (const ref of refs) {
      if (used.has(ref)) continue;
      const v = verdict(names[i]!, ref);
      if (!v.ok) continue;
      const rest = assign(i + 1, new Set([...used, ref]));
      if (rest) return [v.evidence, ...rest];
    }
    return null;
  };
  const evidence = assign(0, new Set());
  if (!evidence) {
    const failed = names.map(name => `${name}: ${refs.map(ref => { const v = verdict(name, ref); return v.ok ? `${ref} ok` : `${ref} reason=${v.reason} ${v.detail}`; }).join('; ')}`);
    return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=no_verified_run — no run per profile verifies (${failed.join(' | ')}); ${lane} stays uncleared` };
  }
  const trees = [...new Set(evidence.map(e => e.tree))];
  if (trees.length > 1) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=tree_mismatch — the runs tested different trees (${trees.map(t => t.slice(0, 12)).join(', ')}); ${lane} stays uncleared` };
  const sub = treeSubstitution(file, trees[0]!, lane, repoRoot);
  if ('refused' in sub) return { ...sub, message: `REUSE: refused reason=tree_not_stamp_only — ${sub.message}` };
  const idle = evidence.filter(e => (e.tests ?? e.files.length) === 0);
  if (idle.length) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=no_tests — ${idle.map(e => `run ${e.run_id} (${e.profile})`).join(', ')} records no tests; ${lane} stays uncleared` };
  const required = new Set(file.requires_remote?.find(r => r.lane === lane)?.tests ?? []);
  if (isGate) {
    const listed = check.inventory(check.gateRuns!.inventory, file.tree);
    if ('error' in listed) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=inventory_failed — the remote gate's inventory command failed: ${listed.error}; ${lane} stays uncleared` };
    if (!listed.length) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=inventory_empty — the remote gate's inventory command listed no test files; ${lane} stays uncleared` };
    for (const f of listed) required.add(f);
  }
  const missing = uncoveredFiles([...required], evidence);
  if (missing.length) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=${isGate ? 'inventory_uncovered' : 'tests_uncovered'} — ${missing.length} of the ${required.size} test file(s) ${lane} must cover appear in no run's tree.json (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}); ${lane} stays uncleared` };
  for (const e of evidence) {
    let changed: string | null;
    try { changed = runChanged(check.deps, e.run_id, e.run_attempt); }
    catch (err: any) { changed = `reading run ${e.run_id} again failed: ${String(err?.message ?? err).slice(0, 200)}`; }
    if (changed) return { refused: 'PREGATE_RECEIPT_INVALID', message: `REUSE: refused reason=run_changed — ${changed}; ${lane} stays uncleared` };
  }
  const tests = evidence.reduce((n, e) => n + (e.tests ?? e.files.length), 0);
  const accepted = sub.substitution ? ` accepted-for=${file.tree.slice(0, 12)} stamp-only=${sub.substitution.files.length}` : '';
  return { receipt: `${isGate ? 'remote-gate' : 'run'} tree=${trees[0]!.slice(0, 12)} tests=${tests}${accepted} ${runReceiptFields(evidence, check.now)}`, attested: false, substitution: sub.substitution };
}

/** Record the receipt that clears one obligation (a run URL, an evidence-bundle lane label, or a remote gate report, with the stamp-only substitution when one was accepted). */
export function clearObligation(file: PregateFile, lane: string, receipt: string, by: string, substitution?: PregateReceiptSubstitution): PregateFile {
  const list = file.requires_remote ?? [];
  const target = list.find(r => r.lane === lane);
  if (!target) throw new Error(`no requires-remote obligation named ${lane}; obligations: ${list.map(r => r.lane).join(', ') || '(none)'}`);
  target.receipt = receipt; target.cleared_by = by;
  if (substitution) target.substitution = substitution; else delete target.substitution;
  file.verdict = verdictOf(file);
  return file;
}
