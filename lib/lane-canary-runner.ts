import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregateEcpeObservations, appendReservedEcpeBatch, appendTimelineBatch } from './ecpe-metrics';
import { legacyValidatorDescriptor } from './legacy-validator';
import {
  appendCanaryComparison, bindCanaryFocusedComparison, inspectCanaryFocusedSlot, inspectCanaryWindow, previewCanaryComparison,
  acquireCanarySafetyPredecessors,
  prepareCanaryControl, startCanaryControl, terminalCanaryControl,
  type CanaryControlMeasurement, type CanaryFocusedBindingInput,
} from './lane-canary';
import { materializePrivateValidatorEnv, releasePrivateValidatorEnv } from './private-validator-env';
import { releaseRuntimeBinding, resolveRuntimeBinding } from './validator-runtime';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';
import { ECPE_PILOT_LANES, recordCanarySafetyStop, withActiveMilestoneOwnerSync } from './milestone-block';

type FocusedInput = CanaryFocusedBindingInput & { focusedRunId: string };
type TimelineSnapshot = { rows: Record<string, any>[]; observations: Record<string, any>[]; allObservations: Record<string, any>[] };
export type ControlExecutor = () => CanaryControlMeasurement;

export function localCanaryHostFingerprint(): string {
  const material = `${os.hostname()}\0${os.platform()}\0${os.arch()}\0${process.geteuid?.() ?? -1}`;
  return `host-${new Bun.CryptoHasher('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`; }
  return JSON.stringify(value);
}

function timeline(input: { stateRoot: string; runId: string }): TimelineSnapshot {
  const rows: Record<string, any>[] = [];
  const projects = path.join(path.resolve(input.stateRoot), 'projects');
  let directories: fs.Dirent[] = [];
  try { directories = fs.readdirSync(projects, { withFileTypes: true }); } catch { /* missing is an empty timeline */ }
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const candidate = path.join(projects, directory.name, 'timeline.jsonl');
    let content = ''; try { const info = fs.lstatSync(candidate); if (!info.isFile() || info.isSymbolicLink()) continue; content = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (row?.run_id === input.runId) rows.push(row); } catch { /* malformed unrelated row cannot become evidence */ }
    }
  }
  const allObservations=rows.filter((row)=>row.ecpe?.run_id===input.runId).map((row)=>row.ecpe);
  return { rows, allObservations, observations: allObservations.filter((item)=>(item.execution_purpose??'ordinary')==='ordinary') };
}

export function inspectCanaryFocusedRun(input: FocusedInput) {
  const slot = inspectCanaryFocusedSlot(input);
  if (slot.phase === 'superseded') throw new Error('canary_focused_run_superseded');
  const snapshot = timeline({ stateRoot: input.stateRoot, runId: input.focusedRunId });
  const starts = snapshot.rows.filter((row) => row.event === 'started');
  const terminals = snapshot.rows.filter((row) => row.event === 'completed');
  if (starts.length > 1 || terminals.length > 1) throw new Error('canary_focused_run_ambiguous');
  if (starts.length !== 1 || terminals.length !== 1) throw new Error('canary_focused_run_nonterminal');
  const terminal = terminals[0];
  if (terminal.session && terminal.session !== input.focusedRunId) throw new Error('canary_focused_run_ambiguous');
  return { schema: 'ecpe.canary-focused-run-inspection.v1' as const, result: 'terminal' as const, focused_run_id: input.focusedRunId, block_id: slot.block_id, participant: slot.participant, lane: slot.lane, subject_head: slot.subject_head, subject_tree: slot.subject_tree, outcome: terminal.outcome, duration_s: Number(terminal.duration_s), observation_count: snapshot.observations.length };
}

function focusedMeasurement(input: FocusedInput): { measurement: CanaryControlMeasurement; contract: { work_kind: string; finish_line: string }; skill: string } {
  const inspected = inspectCanaryFocusedRun(input);
  const snapshot = timeline({ stateRoot: input.stateRoot, runId: input.focusedRunId });
  const report = aggregateEcpeObservations(snapshot.observations, { allowCanaryControl: true, allowReservedProducer: true });
  const run = report.runs.find((item: any) => item.run_id === input.focusedRunId);
  const first = snapshot.observations[0];
  const hasContext = snapshot.observations.some((item) => item.kind === 'context');
  const hasMechanical = !!run && snapshot.observations.some((item) => item.kind === 'validator');
  const terminalPass = ['success', 'approved', 'merged', 'pass'].includes(String(inspected.outcome));
  return {
    measurement: {
      outcome: terminalPass ? 'pass' : 'fail', durationMs: hasMechanical ? Math.round(run.validator_duration_s * 1000) : null,
      contextBytes: hasContext ? run.total_context_bytes : null,
      helperSpawns: run ? run.helper_calls : null, modelSpawns: run ? run.model_calls : null,
      unauthorizedEffects: run?.unauthorized_effects?.length ?? 0,
      tokens: { total: run?.token_usage?.total ?? null, provenance: run?.token_usage?.source ?? 'unknown' },
    },
    contract: { work_kind: first?.work_kind ?? 'change', finish_line: first?.finish_line ?? 'local_change' },
    skill: snapshot.rows.find((row) => row.event === 'started')?.skill ?? 'ecpe',
  };
}

function defaultControl(input: FocusedInput & { sourceRepository: string }): CanaryControlMeasurement {
  const descriptor = legacyValidatorDescriptor('portfolioops', 'full');
  if (descriptor.execution_effect !== 'read' || !descriptor.interpreter_relpath || !descriptor.lockfiles || !descriptor.runtime_binding) throw new Error('unsupported_paid_control');
  const root = fs.realpathSync(path.resolve(input.sourceRepository));
  const subject = materializePrivateValidatorEnv({ sourceRepository: root, subjectSha: input.subjectHead });
  let runtime: ReturnType<typeof resolveRuntimeBinding> | null = null;
  const started = performance.now();
  try {
    if (subject.subject_tree !== input.subjectTree) throw new Error('canary_control_subject_moved');
    runtime = resolveRuntimeBinding({ repositoryRoot: root, interpreterRelpath: descriptor.interpreter_relpath, lockfiles: descriptor.lockfiles, sourceRoots: descriptor.source_roots, binding: descriptor.runtime_binding, argv: descriptor.argv });
    const executable = path.join(subject.checkout_root, descriptor.argv[0]);
    const info = fs.lstatSync(executable);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error('canary_control_executable_invalid');
    const git = (args: string[]) => spawnSync('/usr/bin/git', args, { cwd: subject.checkout_root, encoding: 'utf8', shell: false, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } }).stdout.trim();
    if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '') throw new Error('canary_control_subject_mutated');
    const child = spawnSync(executable, [], { cwd: subject.checkout_root, shell: false, stdio: 'inherit', timeout: 600_000, env: { ...subject.environment, ...runtime.environment, PYTHONPATH: descriptor.source_roots.map((relative) => path.join(subject.checkout_root, relative)).join(path.delimiter) } });
    if (git(['status', '--porcelain=v1', '--untracked-files=all']) !== '' || git(['rev-parse', 'HEAD^{commit}']) !== input.subjectHead) throw new Error('canary_control_subject_mutated');
    return { outcome: child.status === 0 ? 'pass' : 'fail', durationMs: Math.round(performance.now() - started), contextBytes: null, helperSpawns: 1, modelSpawns: 0, unauthorizedEffects: 0, tokens: { total: null, provenance: 'unknown' } };
  } finally { if (runtime) releaseRuntimeBinding(runtime); releasePrivateValidatorEnv(subject); }
}

function ensureControlTelemetry(input: FocusedInput, controlRunId: string, value: CanaryControlMeasurement, contract: { work_kind: string; finish_line: string }, skill: string): void {
  const now = new Date().toISOString(); const timelinePath = path.join(path.resolve(input.stateRoot), 'projects', input.repoId, 'timeline.jsonl');
  const base = { schema_version: 1, run_id: controlRunId, timestamp: now, wtree: input.repoId, execution_purpose: 'canary_control', work_kind: contract.work_kind, finish_line: contract.finish_line };
  const observations: Record<string, any>[]=[];
  if(value.helperSpawns!==null&&value.helperSpawns>0)observations.push({ ...base, kind: 'spawn', spawn: { kind: 'helper', id: 'portfolioops.full', execution_effect: 'read' } });
  if(value.durationMs!==null&&['pass','fail'].includes(value.outcome))observations.push({ ...base, kind: 'validator', validator: { id: 'portfolioops.full', duration_s: value.durationMs / 1000, result: value.outcome } });
  observations.push({ ...base, kind: 'token', token_usage: { input: null, output: null, total: value.tokens.total, source: value.tokens.provenance } });
  const existing=timeline({stateRoot:input.stateRoot,runId:controlRunId});const terminals=existing.rows.filter(row=>row.event==='completed');
  if(terminals.length>1||existing.allObservations.length>observations.length)throw new Error('canary_control_event_ambiguous');
  if(existing.allObservations.length===0)appendReservedEcpeBatch(timelinePath,observations);
  else if(existing.allObservations.length!==observations.length||canonical(existing.allObservations.map(item=>({kind:item.kind,[item.kind==='token'?'token_usage':item.kind]:item[item.kind==='token'?'token_usage':item.kind]})))!==canonical(observations.map(item=>({kind:item.kind,[item.kind==='token'?'token_usage':item.kind]:item[item.kind==='token'?'token_usage':item.kind]}))))throw new Error('canary_control_event_ambiguous');
  if(terminals.length===0)appendTimelineBatch(input.stateRoot, input.repoId, [{ skill, event: 'completed', run_id: controlRunId, session: controlRunId, outcome: value.outcome, duration_s: Math.ceil((value.durationMs ?? 0) / 1000), ts: now }]);
}

function comparisonClass(focused: CanaryControlMeasurement, legacy: CanaryControlMeasurement): 'passed' | 'safety_regressed' | 'efficiency_inconclusive' | 'efficiency_regressed' {
  if (focused.unauthorizedEffects > 0 || (legacy.outcome === 'pass' && focused.outcome !== 'pass')) return 'safety_regressed';
  if (focused.outcome !== 'pass' || legacy.outcome !== 'pass') return 'efficiency_inconclusive';
  const values = [focused.durationMs, legacy.durationMs, focused.contextBytes, legacy.contextBytes, focused.helperSpawns, legacy.helperSpawns, focused.modelSpawns, legacy.modelSpawns];
  if (values.some((value) => value === null)) return 'efficiency_inconclusive';
  const focusedSpawns = focused.helperSpawns! + focused.modelSpawns!; const legacySpawns = legacy.helperSpawns! + legacy.modelSpawns!;
  if (focused.durationMs! > legacy.durationMs! || focused.contextBytes! > legacy.contextBytes! || focusedSpawns > legacySpawns) return 'efficiency_regressed';
  if (focused.tokens.provenance !== 'unknown' && focused.tokens.provenance === legacy.tokens.provenance && focused.tokens.total !== null && legacy.tokens.total !== null && focused.tokens.total > legacy.tokens.total) return 'efficiency_regressed';
  return 'passed';
}

type CanaryActivationSnapshot=Record<'docs_ux'|'single_repo_code'|'cross_repo_contract',{activation:'legacy'|'shadow'|'enforce';profile_lineage_hash:string}>;
type CanaryControlDependencies = { executeControl?: ControlExecutor; beforeSpawn?: () => void; afterControlTerminal?: () => void; afterComparisonAppended?: () => void; ownerLockTimeoutMs?: number;trustedActivations?:CanaryActivationSnapshot;profileBlobSha?:string;resolveSafetySnapshot?:()=>{activations:CanaryActivationSnapshot;profileBlobSha:string} };

function runCanaryControlOwned(input: FocusedInput & { sourceRepository?: string }, dependencies: CanaryControlDependencies = {}) {
  const focused = focusedMeasurement(input); let slot = inspectCanaryFocusedSlot(input);
  if (slot.phase === 'comparison_appended') return { ...inspectCanaryWindow(input), result: 'reused' as const };
  let legacy: CanaryControlMeasurement;
  if (slot.phase === 'control_started') legacy = { outcome: 'ambiguous', durationMs: null, contextBytes: null, helperSpawns: null, modelSpawns: null, unauthorizedEffects: 0, tokens: { total: null, provenance: 'unknown' } };
  else if (slot.phase === 'control_terminal') legacy = slot.control_measurement!;
  else {
    withActiveMilestoneOwnerSync({stateRoot:input.stateRoot,blockId:input.blockId,participant:'portfolioops',lane:input.lane,policyHash:input.policyHash},()=>{slot=prepareCanaryControl(input);if(slot.phase!=='control_prepared')throw new Error('canary_control_phase_invalid');startCanaryControl(input)});
    dependencies.beforeSpawn?.();
    try { legacy = dependencies.executeControl ? dependencies.executeControl() : defaultControl({ ...input, sourceRepository: input.sourceRepository ?? '' }); }
    catch { legacy = { outcome: 'ambiguous', durationMs: null, contextBytes: null, helperSpawns: null, modelSpawns: null, unauthorizedEffects: 0, tokens: { total: null, provenance: 'unknown' } }; }
    terminalCanaryControl({ ...input, measurement: legacy });
    dependencies.afterControlTerminal?.();
  }
  if(slot.phase!=='control_started')ensureControlTelemetry(input,slot.control_run_id,legacy,focused.contract,focused.skill);
  const klass = comparisonClass(focused.measurement, legacy);
  const tokenComparable = focused.measurement.tokens.provenance !== 'unknown' && focused.measurement.tokens.provenance === legacy.tokens.provenance;
  const comparison = {
    source_block_id: input.blockId, subject_head: input.subjectHead, subject_tree: input.subjectTree, host_fingerprint: input.hostFingerprint, class: klass,
    focused_run_id: input.focusedRunId, legacy_control_run_id: slot.control_run_id, policy_hash: input.policyHash,
    focused_duration_ms: focused.measurement.durationMs, legacy_duration_ms: legacy.durationMs,
    focused_context_bytes: focused.measurement.contextBytes, legacy_context_bytes: legacy.contextBytes,
    focused_spawns: focused.measurement.helperSpawns === null || focused.measurement.modelSpawns === null ? null : focused.measurement.helperSpawns + focused.measurement.modelSpawns,
    legacy_spawns: legacy.helperSpawns === null || legacy.modelSpawns === null ? null : legacy.helperSpawns + legacy.modelSpawns,
    focused_tokens: tokenComparable ? focused.measurement.tokens.total : null, legacy_tokens: tokenComparable ? legacy.tokens.total : null,
    token_provenance: tokenComparable ? focused.measurement.tokens.provenance : 'unknown' as const,
    focused_outcome: focused.measurement.outcome,
    legacy_control_outcome: legacy.outcome,
  };
  if(klass==='safety_regressed'){
    if(!dependencies.resolveSafetySnapshot&&(!dependencies.trustedActivations||!dependencies.profileBlobSha))throw new Error('canary_safety_activations_required');
    const preview=previewCanaryComparison({stateRoot:input.stateRoot,repoId:input.repoId,lane:input.lane,profileHash:input.profileHash,comparison});
    recordCanarySafetyStop({stateRoot:input.stateRoot,blockId:input.blockId,participant:'portfolioops',causeLane:input.lane,comparison:{...comparison,comparison_id:preview.comparison_id,ordinal:preview.ordinal},resolveSnapshot:()=>{const trusted=dependencies.resolveSafetySnapshot?.()??{activations:dependencies.trustedActivations!,profileBlobSha:dependencies.profileBlobSha!};const locked=acquireCanarySafetyPredecessors({stateRoot:input.stateRoot,repoId:input.repoId,profileHashes:Object.fromEntries(ECPE_PILOT_LANES.map(lane=>[lane,trusted.activations[lane].profile_lineage_hash])) as any});return{...trusted,canaryPredecessors:locked.predecessors as any,release:locked.release}}});
  }
  const appended = appendCanaryComparison({ stateRoot: input.stateRoot, repoId: input.repoId, lane: input.lane, profileHash: input.profileHash, comparison });
  dependencies.afterComparisonAppended?.();
  const comparisonId = appended.comparison_ids[appended.comparison_ids.length - 1]; bindCanaryFocusedComparison({ ...input, comparisonId });
  return { ...appended, comparison_class: klass };
}

export function runCanaryControl(input: FocusedInput & { sourceRepository?: string }, dependencies: CanaryControlDependencies = {}) {
  const lockTarget = path.join(path.resolve(input.stateRoot), 'ecpe', 'lane-canary-control', input.repoId, input.lane, `${input.focusedRunId}.json`);
  const owned = acquireDurableOwnerLock(lockTarget, 'canary_control_owner_busy', dependencies.ownerLockTimeoutMs);
  try { return runCanaryControlOwned(input, dependencies); }
  finally { releaseDurableOwnerLock(owned); }
}
