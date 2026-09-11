import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ECPE_SCHEMA_VERSION = 1 as const;

const WORK_KINDS = ['answer', 'design', 'diagnose', 'change', 'review', 'release', 'operation'] as const;
const FINISH_LINES = ['response', 'artifact', 'local_change', 'review_receipt', 'pr_open', 'merged', 'deployed', 'verified', 'operation_result'] as const;
const KINDS = ['context', 'section_load', 'decision', 'shadow_comparison', 'candidate_preview', 'authority_call', 'receipt', 'spawn', 'validator', 'gate', 'effect', 'token', 'record'] as const;
const ROLES = ['docs', 'code', 'contract', 'schema', 'prompt', 'auth', 'ui', 'runtime', 'data', 'release_metadata'] as const;
const EFFECTS = ['read', 'tracked_write', 'git_stage', 'paid_model', 'external_comment', 'commit', 'push', 'pr_create', 'pr_update', 'merge', 'deploy', 'rollback', 'recording_abandon'] as const;
const LANES = ['docs_ux', 'single_repo_code', 'cross_repo_contract'] as const;
const PAYLOAD_KEYS = ['context', 'section_load', 'semantic_roles', 'capability_ids', 'authority_call', 'shadow_comparison', 'candidate_preview', 'receipt', 'spawn', 'validator', 'gate', 'effect', 'token_usage', 'record'] as const;
const BASE_KEYS = ['schema_version', 'run_id', 'timestamp', 'wtree', 'kind', 'execution_purpose', 'work_kind', 'finish_line'] as const;
const BASE_REQUIRED_KEYS = ['schema_version', 'run_id', 'timestamp', 'wtree', 'kind', 'work_kind', 'finish_line'] as const;
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const LEGACY_PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_PROJECT_COMPONENT = /^(?:[A-Za-z0-9._]|%[0-9A-F]{2})+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type EcpeObservation = Record<string, any>;
export type EffectObservation = {
  effect: string;
  phase: 'granted' | 'observed';
  source: string;
  scope: EffectScope;
};
export type EffectScope = {
  repo_id: string;
  ref_or_pr: string | null;
  target_id: string | null;
  paths_or_surface: string[];
  environment: string | null;
  index_preimage_hash: string | null;
  binding_id: string | null;
  projection_id: string | null;
};

export class EcpeValidationError extends Error {
  code: string;

  constructor(code: string = 'ecpe_schema_invalid') {
    super(code);
    this.name = 'EcpeValidationError';
    this.code = code;
  }
}

function invalid(code = 'ecpe_schema_invalid'): never {
  throw new EcpeValidationError(code);
}

function plain(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, any>, allowed: readonly string[], required: readonly string[] = allowed): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) invalid();
}

function text(value: unknown, expression: RegExp = OPAQUE, maxBytes = 256): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes || !expression.test(value)) invalid();
  return value;
}

function encodeProjectComponent(value: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    const literal =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2e ||
      byte === 0x5f;
    encoded += literal ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/** A filesystem-safe legacy slug or exact canonical project-identity encoding. */
export function isProjectSlug(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128) return false;
  if (LEGACY_PROJECT_SLUG.test(value)) return true;
  const components = value.split('--');
  if (components.some((component) => !CANONICAL_PROJECT_COMPONENT.test(component))) return false;
  return components.every((component) => {
    let decoded: string;
    try { decoded = decodeURIComponent(component); } catch { return false; }
    if (decoded === '.' || decoded === '..' || /[\/\\\0\r\n]/.test(decoded)) return false;
    return encodeProjectComponent(decoded) === component;
  });
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 512 || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function finite(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) invalid();
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}

function closed<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid();
  return value as T;
}

function idList(value: unknown, values?: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 128) invalid();
  const result = value.map((item) => values ? closed(item, values) : text(item, ID));
  if (new Set(result).size !== result.length) invalid();
  return result;
}

function rejectContentBearingKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectContentBearingKeys(item);
    return;
  }
  if (!plain(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (['prompt', 'payload', 'diff', 'secret', 'content'].some((needle) => normalized.includes(needle))) invalid();
    if (normalized.includes('token') && normalized !== 'token_usage') invalid();
    rejectContentBearingKeys(child);
  }
}

function validateScope(value: unknown): EffectScope {
  if (!plain(value)) invalid();
  exactKeys(value, ['repo_id', 'ref_or_pr', 'target_id', 'paths_or_surface', 'environment', 'index_preimage_hash', 'binding_id', 'projection_id']);
  text(value.repo_id, ID);
  nullableText(value.ref_or_pr);
  nullableText(value.target_id);
  nullableText(value.environment);
  nullableText(value.index_preimage_hash);
  nullableText(value.binding_id);
  nullableText(value.projection_id);
  if (!Array.isArray(value.paths_or_surface) || value.paths_or_surface.length === 0 || value.paths_or_surface.length > 256) invalid();
  for (const surface of value.paths_or_surface) {
    if (typeof surface !== 'string' || !surface.trim() || Buffer.byteLength(surface) > 512 || /[\0\r\n*]/.test(surface)) invalid();
    if (surface.split('/').includes('..')) invalid();
  }
  if (new Set(value.paths_or_surface).size !== value.paths_or_surface.length) invalid();
  return value as EffectScope;
}

function validateEffect(value: unknown): EffectObservation {
  if (!plain(value)) invalid();
  exactKeys(value, ['effect', 'phase', 'source', 'scope']);
  closed(value.effect, EFFECTS);
  closed(value.phase, ['granted', 'observed']);
  if (value.phase === 'granted') closed(value.source, ['explicit_user_request', 'explicit_skill_invocation']);
  else if (value.source !== 'adapter_observed') invalid();
  validateScope(value.scope);
  return value as EffectObservation;
}

function validateShadow(value: unknown): void {
  if (!plain(value)) invalid();
  exactKeys(value, ['block_id', 'participant', 'repo_id', 'profile_lineage_hash', 'lane', 'lane_activation', 'execution', 'subject_head_sha', 'trusted_base_sha', 'comparison_id', 'paired_change_set_id', 'legacy_executed_capability_ids', 'projected_capability_ids', 'safety_outcomes']);
  for (const key of ['block_id', 'participant', 'repo_id', 'comparison_id'] as const) text(value[key], ID);
  text(value.profile_lineage_hash, /^[0-9a-f]{64}$/);
  closed(value.lane, LANES);
  closed(value.lane_activation, ['shadow', 'enforce']);
  closed(value.execution, ['legacy', 'profile']);
  text(value.subject_head_sha, /^[0-9a-f]{40,64}$/);
  text(value.trusted_base_sha, /^[0-9a-f]{40,64}$/);
  if (value.paired_change_set_id !== null) text(value.paired_change_set_id, /^[0-9a-f]{64}$/);
  idList(value.legacy_executed_capability_ids);
  idList(value.projected_capability_ids);
  closed(value.safety_outcomes, ['complete', 'unknown']);
}

function validatePreview(value: unknown): void {
  if (!plain(value)) invalid();
  exactKeys(value, ['block_id', 'participant', 'repo_id', 'descriptor_id', 'candidate_sha256', 'comparison_ref', 'subject_head_sha', 'subject_tree_sha', 'activation_projection_hash', 'preview_lanes', 'validator_ids', 'result', 'clean_before', 'clean_after', 'subject_materialization', 'repository_fs_manifest_before_sha256', 'repository_fs_manifest_after_sha256', 'private_subject_cleanup_complete', 'repository_file_creations', 'external_effects', 'paid_effects']);
  for (const key of ['block_id', 'participant', 'repo_id', 'descriptor_id'] as const) text(value[key], ID);
  for (const key of ['candidate_sha256', 'activation_projection_hash', 'repository_fs_manifest_before_sha256', 'repository_fs_manifest_after_sha256'] as const) text(value[key], /^[0-9a-f]{64}$/);
  for (const key of ['subject_head_sha', 'subject_tree_sha'] as const) text(value[key], /^[0-9a-f]{40,64}$/);
  nullableText(value.comparison_ref);
  const lanes = idList(value.preview_lanes, LANES);
  if (lanes.join('\0') !== [...lanes].sort().join('\0')) invalid();
  idList(value.validator_ids);
  closed(value.result, ['pass', 'fail']);
  if (typeof value.clean_before !== 'boolean' || typeof value.clean_after !== 'boolean') invalid();
  if (value.subject_materialization !== 'helper_owned_private_checkout' || value.private_subject_cleanup_complete !== true) invalid();
  for (const key of ['repository_file_creations', 'external_effects', 'paid_effects'] as const) {
    if (integer(value[key]) !== 0) invalid();
  }
}

export interface ValidateEcpeOptions {
  allowCanaryControl?: boolean;
  allowReservedProducer?: boolean;
}

export function validateEcpeObservation(value: unknown, options: ValidateEcpeOptions = {}): EcpeObservation {
  if (!plain(value)) invalid();
  rejectContentBearingKeys(value);
  const kind = closed(value.kind, KINDS);
  const allowedPayloads = kind === 'decision' ? ['semantic_roles', 'capability_ids'] : [kind === 'token' ? 'token_usage' : kind];
  exactKeys(value, [...BASE_KEYS, ...allowedPayloads], BASE_REQUIRED_KEYS);
  if (value.schema_version !== ECPE_SCHEMA_VERSION) invalid();
  text(value.run_id, OPAQUE);
  if (typeof value.timestamp !== 'string' || !ISO.test(value.timestamp) || new Date(value.timestamp).toISOString() !== value.timestamp) invalid();
  if (!isProjectSlug(value.wtree)) text(value.wtree, OPAQUE);
  closed(value.work_kind, WORK_KINDS);
  closed(value.finish_line, FINISH_LINES);
  const purpose = value.execution_purpose ?? 'ordinary';
  closed(purpose, ['ordinary', 'canary_control']);
  if (purpose === 'canary_control' && !options.allowCanaryControl) invalid('protected_producer');
  if ((kind === 'shadow_comparison' || kind === 'candidate_preview') && !options.allowReservedProducer) invalid('protected_producer');
  const presentPayloads = PAYLOAD_KEYS.filter((key) => Object.hasOwn(value, key));
  if (kind === 'decision') {
    if (presentPayloads.length < 1 || presentPayloads.some((key) => !allowedPayloads.includes(key))) invalid();
  } else if (presentPayloads.length !== 1 || presentPayloads[0] !== allowedPayloads[0]) invalid();

  switch (kind) {
    case 'context':
      if (!plain(value.context)) invalid();
      exactKeys(value.context, ['skill', 'eager_bytes', 'skillpack_identity']);
      text(value.context.skill, ID); integer(value.context.eager_bytes); text(value.context.skillpack_identity, /^[a-z0-9][a-z0-9:._-]{0,127}$/);
      break;
    case 'section_load':
      if (!plain(value.section_load)) invalid();
      exactKeys(value.section_load, ['section_id', 'bundle_hash', 'bytes', 'delivery_provenance', 'delivery_batch_id']);
      text(value.section_load.section_id, ID); text(value.section_load.bundle_hash, /^[a-z0-9][a-z0-9:._-]{0,127}$/); integer(value.section_load.bytes);
      closed(value.section_load.delivery_provenance, ['adapter_delivered', 'host_reported_assertion']);
      if (value.section_load.delivery_batch_id !== null) text(value.section_load.delivery_batch_id, ID);
      break;
    case 'decision':
      if (value.semantic_roles !== undefined) idList(value.semantic_roles, ROLES);
      if (value.capability_ids !== undefined) idList(value.capability_ids);
      break;
    case 'authority_call':
      if (!plain(value.authority_call)) invalid();
      exactKeys(value.authority_call, ['command_id', 'duration_ms', 'anchor_duration_ms', 'adapter_duration_ms', 'authority_processes', 'bundle_hash_bytes', 'full_tool_hash_bytes', 'lease', 'fused_read_decision']);
      text(value.authority_call.command_id, ID); finite(value.authority_call.duration_ms); finite(value.authority_call.anchor_duration_ms); finite(value.authority_call.adapter_duration_ms);
      if (value.authority_call.authority_processes !== 1) invalid();
      integer(value.authority_call.bundle_hash_bytes); integer(value.authority_call.full_tool_hash_bytes); closed(value.authority_call.lease, ['created', 'hit']);
      if (typeof value.authority_call.fused_read_decision !== 'boolean') invalid();
      break;
    case 'shadow_comparison': validateShadow(value.shadow_comparison); break;
    case 'candidate_preview': validatePreview(value.candidate_preview); break;
    case 'receipt':
      if (!plain(value.receipt)) invalid();
      exactKeys(value.receipt, ['capability_id', 'disposition', 'reason_ids']);
      text(value.receipt.capability_id, ID); text(value.receipt.disposition, ID); idList(value.receipt.reason_ids);
      break;
    case 'spawn':
      if (!plain(value.spawn)) invalid();
      exactKeys(value.spawn, ['kind', 'id', 'execution_effect']);
      closed(value.spawn.kind, ['helper', 'model']); text(value.spawn.id, ID); closed(value.spawn.execution_effect, ['read', 'paid_model']);
      if ((value.spawn.kind === 'model') !== (value.spawn.execution_effect === 'paid_model')) invalid();
      break;
    case 'validator':
      if (!plain(value.validator)) invalid();
      exactKeys(value.validator, ['id', 'duration_s', 'result']);
      text(value.validator.id, ID); finite(value.validator.duration_s); closed(value.validator.result, ['pass', 'fail']);
      break;
    case 'gate':
      if (!plain(value.gate)) invalid();
      exactKeys(value.gate, ['phase', 'gate_wtree']);
      closed(value.gate.phase, ['before_final', 'after_final']);
      if (!isProjectSlug(value.gate.gate_wtree)) text(value.gate.gate_wtree, OPAQUE);
      break;
    case 'effect': validateEffect(value.effect); break;
    case 'token':
      if (!plain(value.token_usage)) invalid();
      exactKeys(value.token_usage, ['input', 'output', 'total', 'source']);
      closed(value.token_usage.source, ['host_reported', 'offline_estimate', 'unknown']);
      for (const key of ['input', 'output', 'total'] as const) if (value.token_usage[key] !== null) integer(value.token_usage[key]);
      if (value.token_usage.source === 'unknown' && [value.token_usage.input, value.token_usage.output, value.token_usage.total].some((item) => item !== null)) invalid();
      break;
    case 'record':
      if (!plain(value.record)) invalid();
      exactKeys(value.record, ['kind', 'delta']);
      closed(value.record.kind, ['receipt', 'session', 'report', 'eod']);
      if (!Number.isSafeInteger(value.record.delta) || value.record.delta === 0) invalid();
      break;
  }
  return { ...value, execution_purpose: purpose };
}

function sameNullable(a: string | null, b: string | null): boolean {
  return a === b;
}

export function effectIsAuthorized(observed: EffectObservation, grants: EffectObservation[]): boolean {
  if (observed.phase !== 'observed' || observed.source !== 'adapter_observed') return false;
  return grants.some((grant) => {
    if (grant.phase !== 'granted' || grant.effect !== observed.effect) return false;
    const a = observed.scope;
    const g = grant.scope;
    if (a.repo_id !== g.repo_id) return false;
    for (const key of ['ref_or_pr', 'target_id', 'environment', 'index_preimage_hash', 'binding_id', 'projection_id'] as const) {
      if (!sameNullable(a[key], g[key])) return false;
    }
    const surfaces = new Set(g.paths_or_surface);
    return a.paths_or_surface.length > 0 && a.paths_or_surface.every((surface) => surfaces.has(surface));
  });
}

function unknownTokens(): Record<string, any> {
  return { input: null, output: null, total: null, source: 'unknown' };
}

function combineTokens(items: Record<string, any>[]): Record<string, any> {
  if (items.length === 0 || items.some((item) => item.source === 'unknown')) return unknownTokens();
  const sources = new Set(items.map((item) => item.source));
  if (sources.size !== 1) return unknownTokens();
  const sum = (key: string) => items.every((item) => typeof item[key] === 'number')
    ? items.reduce((total, item) => total + item[key], 0)
    : null;
  return { input: sum('input'), output: sum('output'), total: sum('total'), source: items[0].source };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function emptyRun(runId: string, wtree: string): Record<string, any> {
  return {
    run_id: runId, wtree, semantic_roles: [], capabilities: [], receipt_hits: [], receipt_miss_reasons: [],
    model_calls: 0, helper_calls: 0, canary_control_model_calls: 0, canary_control_helper_calls: 0,
    validator_duration_s: 0, validator_calls: 0, canary_control_validator_duration_s: 0,
    post_gate_mutations: 0, record_artifacts: 0, record_coverage: 'unknown', eager_bytes: 0,
    loaded_section_bytes: 0, loaded_section_ids: [], section_load_coverage: 'unknown', authority_calls: 0,
    authority_processes: 0, authority_duration_ms: 0, anchor_duration_ms: 0, adapter_duration_ms: 0,
    authority_bundle_hash_bytes: 0, full_tool_hash_bytes: 0, execution_processes: 0,
    local_orchestration_duration_ms: 0, token_usage: unknownTokens(), canary_control_token_usage: unknownTokens(),
    granted_effects: [], observed_effects: [], unauthorized_effects: [], shadow_comparisons: [],
  };
}

export function aggregateEcpeObservations(values: unknown[], options: ValidateEcpeOptions = {}): Record<string, any> {
  const observations = values.map((value) => validateEcpeObservation(value, options));
  observations.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.run_id.localeCompare(b.run_id));
  const runs = new Map<string, Record<string, any>>();
  const tokens = new Map<string, Record<string, any>[]>();
  const controlTokens = new Map<string, Record<string, any>[]>();
  const validatorDurations: number[] = [];
  const sectionIds = new Map<string, Set<string>>();
  const completeBatches = new Map<string, Set<string>>();
  const afterGate = new Set<string>();

  for (const observation of observations) {
    let run = runs.get(observation.run_id);
    if (!run) {
      run = emptyRun(observation.run_id, observation.wtree);
      runs.set(observation.run_id, run);
      tokens.set(observation.run_id, []);
      controlTokens.set(observation.run_id, []);
      sectionIds.set(observation.run_id, new Set());
      completeBatches.set(observation.run_id, new Set());
    }
    if (run.wtree !== observation.wtree) invalid('ecpe_run_identity_mismatch');
    const control = observation.execution_purpose === 'canary_control';
    if (observation.kind === 'decision' && !control) {
      for (const role of observation.semantic_roles ?? []) if (!run.semantic_roles.includes(role)) run.semantic_roles.push(role);
      for (const capability of observation.capability_ids ?? []) if (!run.capabilities.includes(capability)) run.capabilities.push(capability);
    } else if (observation.kind === 'context' && !control) {
      run.eager_bytes += observation.context.eager_bytes;
    } else if (observation.kind === 'section_load' && !control) {
      if (observation.section_load.delivery_provenance === 'adapter_delivered') {
        const ids = sectionIds.get(observation.run_id)!;
        if (!ids.has(observation.section_load.section_id)) {
          ids.add(observation.section_load.section_id);
          run.loaded_section_ids.push(observation.section_load.section_id);
          run.loaded_section_bytes += observation.section_load.bytes;
        }
        if (observation.section_load.delivery_batch_id) completeBatches.get(observation.run_id)!.add(observation.section_load.delivery_batch_id);
      }
    } else if (observation.kind === 'receipt' && !control) {
      if (!run.capabilities.includes(observation.receipt.capability_id)) run.capabilities.push(observation.receipt.capability_id);
      if (observation.receipt.disposition === 'hit') run.receipt_hits.push(observation.receipt.capability_id);
      else for (const reason of observation.receipt.reason_ids) if (!run.receipt_miss_reasons.includes(reason)) run.receipt_miss_reasons.push(reason);
    } else if (observation.kind === 'spawn') {
      if (control) {
        if (observation.spawn.kind === 'model') run.canary_control_model_calls += 1;
        else run.canary_control_helper_calls += 1;
      } else if (observation.spawn.kind === 'model') run.model_calls += 1;
      else run.helper_calls += 1;
    } else if (observation.kind === 'validator') {
      if (control) run.canary_control_validator_duration_s += observation.validator.duration_s;
      else {
        run.validator_calls += 1;
        run.validator_duration_s += observation.validator.duration_s;
        validatorDurations.push(observation.validator.duration_s);
      }
    } else if (observation.kind === 'authority_call' && !control) {
      run.authority_calls += 1;
      run.authority_processes += observation.authority_call.authority_processes;
      run.authority_duration_ms += observation.authority_call.duration_ms;
      run.anchor_duration_ms += observation.authority_call.anchor_duration_ms;
      run.adapter_duration_ms += observation.authority_call.adapter_duration_ms;
      run.authority_bundle_hash_bytes += observation.authority_call.bundle_hash_bytes;
      run.full_tool_hash_bytes += observation.authority_call.full_tool_hash_bytes;
    } else if (observation.kind === 'gate' && !control) {
      if (observation.gate.phase === 'after_final') afterGate.add(observation.run_id);
    } else if (observation.kind === 'effect' && !control) {
      if (observation.effect.phase === 'granted') run.granted_effects.push(observation.effect);
      else run.observed_effects.push(observation.effect);
      if (afterGate.has(observation.run_id) && observation.effect.phase === 'observed' && observation.effect.effect !== 'read') run.post_gate_mutations += 1;
    } else if (observation.kind === 'token') {
      (control ? controlTokens : tokens).get(observation.run_id)!.push(observation.token_usage);
    } else if (observation.kind === 'record' && !control) {
      run.record_artifacts += observation.record.delta;
      run.record_coverage = 'complete';
      if (afterGate.has(observation.run_id)) run.post_gate_mutations += 1;
    } else if (observation.kind === 'shadow_comparison' && !control) {
      run.shadow_comparisons.push(observation.shadow_comparison);
    }
  }

  for (const [runId, run] of runs) {
    for (const key of ['semantic_roles', 'capabilities', 'receipt_hits', 'receipt_miss_reasons', 'loaded_section_ids'] as const) run[key].sort();
    run.section_load_coverage = completeBatches.get(runId)!.size > 0 ? 'complete' : 'unknown';
    run.token_usage = combineTokens(tokens.get(runId)!);
    run.canary_control_token_usage = combineTokens(controlTokens.get(runId)!);
    run.unauthorized_effects = run.observed_effects.filter((effect: EffectObservation) => !effectIsAuthorized(effect, run.granted_effects));
    run.execution_processes = run.authority_processes + run.model_calls + run.helper_calls;
    run.local_orchestration_duration_ms = run.adapter_duration_ms;
    run.total_context_bytes = run.eager_bytes + run.loaded_section_bytes;
  }
  const runValues = [...runs.values()].sort((a, b) => a.run_id.localeCompare(b.run_id));
  const capabilityGroups = new Map<string, { wtree: string; capability_id: string; run_ids: string[] }>();
  for (const run of runValues) {
    for (const capability of run.capabilities) {
      const key = `${run.wtree}\0${capability}`;
      const group = capabilityGroups.get(key) ?? { wtree: run.wtree, capability_id: capability, run_ids: [] };
      group.run_ids.push(run.run_id);
      capabilityGroups.set(key, group);
    }
  }
  const duplicateCapabilityRuns = [...capabilityGroups.values()]
    .filter((group) => group.run_ids.length > 1)
    .map((group) => ({ ...group, run_ids: group.run_ids.sort() }))
    .sort((a, b) => a.wtree.localeCompare(b.wtree) || a.capability_id.localeCompare(b.capability_id));
  return {
    schema_version: ECPE_SCHEMA_VERSION,
    runs: runValues,
    totals: {
      eager_bytes: runValues.reduce((total, run) => total + run.eager_bytes, 0),
      loaded_section_bytes: runValues.reduce((total, run) => total + run.loaded_section_bytes, 0),
      total_context_bytes: runValues.reduce((total, run) => total + run.total_context_bytes, 0),
      model_calls: runValues.reduce((total, run) => total + run.model_calls, 0),
      helper_calls: runValues.reduce((total, run) => total + run.helper_calls, 0),
      validator_duration_s: runValues.reduce((total, run) => total + run.validator_duration_s, 0),
      unauthorized_effects: runValues.reduce((total, run) => total + run.unauthorized_effects.length, 0),
    },
    duplicate_capability_runs: duplicateCapabilityRuns,
    missing_producer_coverage: {
      record_runs: runValues.filter((run) => run.record_coverage === 'unknown').length,
      section_load_runs: runValues.filter((run) => run.section_load_coverage === 'unknown').length,
      token_runs: runValues.filter((run) => run.token_usage.source === 'unknown').length,
    },
    validator_duration_p50_s: percentile(validatorDurations, 0.5),
    validator_duration_p95_s: percentile(validatorDurations, 0.95),
    invalid_observations: 0,
  };
}

export function parseEcpeTimeline(content: string, options: ValidateEcpeOptions = { allowCanaryControl: true, allowReservedProducer: true }): { observations: EcpeObservation[]; invalid: number } {
  const observations: EcpeObservation[] = [];
  let invalidCount = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!plain(entry) || !Object.hasOwn(entry, 'ecpe')) continue;
      observations.push(validateEcpeObservation(entry.ecpe, options));
    } catch {
      invalidCount += 1;
    }
  }
  return { observations, invalid: invalidCount };
}

export function aggregateEcpeTimelineContent(content: string): Record<string, any> {
  const parsed = parseEcpeTimeline(content);
  const report = aggregateEcpeObservations(parsed.observations, { allowCanaryControl: true, allowReservedProducer: true });
  report.invalid_observations = parsed.invalid;
  return report;
}

export interface AppendMetrics {
  telemetry_extra_processes: 0;
  append_lock_fsync_transactions: number;
  fsync_calls: number;
  open_plus_stat_calls: number;
  bytes_written: number;
  writer_duration_ms: number;
}

function withAppendLock<T>(timeline: string, action: () => T): T {
  const lock = `${timeline}.ecpe-lock`;
  const deadline = Date.now() + 2500;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new EcpeValidationError('timeline_lock_timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return action();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* exact owned lock cleanup */ }
  }
}

function appendLines(timelinePath: string, entries: Record<string, any>[]): AppendMetrics {
  const started = performance.now();
  const parent = path.dirname(timelinePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return withAppendLock(timelinePath, () => {
    const fd = fs.openSync(timelinePath, 'a', 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      telemetry_extra_processes: 0,
      append_lock_fsync_transactions: 1,
      fsync_calls: 1,
      open_plus_stat_calls: 1,
      bytes_written: bytes.byteLength,
      writer_duration_ms: performance.now() - started,
    };
  });
}

export function appendTimelineBatch(stateRoot: string, slug: string, values: unknown[]): AppendMetrics {
  if (!isProjectSlug(slug)) invalid();
  if (!Array.isArray(values) || values.length === 0 || values.length > 256) invalid();
  const entries = values.map((value) => {
    if (!plain(value) || typeof value.skill !== 'string' || !value.skill || typeof value.event !== 'string' || !value.event) invalid();
    const entry = { ...value };
    if (Object.hasOwn(entry, 'ecpe')) {
      const ecpe = validateEcpeObservation(entry.ecpe);
      entry.ecpe = ecpe;
      entry.run_id = ecpe.run_id;
    }
    if (typeof entry.ts !== 'string') entry.ts = new Date().toISOString();
    return entry;
  });
  return appendLines(path.join(stateRoot, 'projects', slug, 'timeline.jsonl'), entries);
}

export function decideEcpeAppend(values: unknown[], _options: { disabled?: boolean } = {}): Record<string, any> {
  const observations = values.map((value) => validateEcpeObservation(value));
  return {
    accepted: true,
    count: observations.length,
    observed_effects: observations.filter((item) => item.kind === 'effect' && item.effect.phase === 'observed').length,
  };
}

export function appendEcpeBatch(timelinePath: string, values: unknown[]): AppendMetrics {
  const observations = values.map((value) => validateEcpeObservation(value));
  return appendLines(timelinePath, observations.map((observation) => ({
    skill: 'ecpe', event: 'observation', run_id: observation.run_id, ts: observation.timestamp, ecpe: observation,
  })));
}

/** Closed adapter path for reserved pilot and canary-control producers. */
export function appendReservedEcpeBatch(timelinePath: string, values: unknown[]): AppendMetrics {
  const observations = values.map((value) => validateEcpeObservation(value, { allowReservedProducer: true, allowCanaryControl: true }));
  return appendLines(timelinePath, observations.map((observation) => ({
    skill: 'ecpe', event: 'observation', run_id: observation.run_id, ts: observation.timestamp, ecpe: observation,
  })));
}

export function appendTimelineInput(input: string, root: string, slug: string): boolean {
  let entry: Record<string, any>;
  try {
    entry = JSON.parse(input);
    if (!plain(entry) || typeof entry.skill !== 'string' || !entry.skill || typeof entry.event !== 'string' || !entry.event) return false;
    if (Object.hasOwn(entry, 'ecpe')) {
      const ecpe = validateEcpeObservation(entry.ecpe);
      entry.ecpe = ecpe;
      entry.run_id = ecpe.run_id;
    }
    if (typeof entry.ts !== 'string') entry.ts = new Date().toISOString();
    appendTimelineBatch(root, slug, [entry]);
    return true;
  } catch {
    return false;
  }
}

export function readEcpeTimelineCandidates(
  stateRoot: string,
  explicitCandidates?: string[],
  expectedRepoId?: string,
): { observations: EcpeObservation[]; invalid: number } {
  const projects = path.join(stateRoot, 'projects');
  let candidates: string[] = explicitCandidates ? [...new Set(explicitCandidates)].sort() : [];
  try {
    if (!explicitCandidates) candidates = fs.readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(projects, entry.name, 'timeline.jsonl'))
      .filter((candidate) => {
        try { return fs.lstatSync(candidate).isFile() && !fs.lstatSync(candidate).isSymbolicLink(); } catch { return false; }
      });
  } catch {
    return { observations: [], invalid: 0 };
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const candidate of candidates.sort()) {
    let raw: string;
    try { raw = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let key = `invalid:${line}`;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (expectedRepoId && typeof row.repo_id === 'string' && row.repo_id !== expectedRepoId) continue;
        key = canonical(row);
      } catch { /* keep one invalid copy for closed diagnostics */ }
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return parseEcpeTimeline(lines.join('\n'));
}

type StatProjection = { exists: boolean; size: number; sentinel: string };
type InventoryStart = { run_id: string; report_sentinel: string; fixed: Record<string, StatProjection> };

function statProjection(candidate: string): StatProjection {
  try {
    const info = fs.statSync(candidate, { bigint: true });
    return { exists: true, size: Number(info.size), sentinel: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
  } catch {
    return { exists: false, size: 0, sentinel: 'missing' };
  }
}

function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  const parentFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
}

function reportCount(directory: string, limit = Number.POSITIVE_INFINITY): { count: number; overBudget: boolean; opened: number } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return { count: 0, overBudget: false, opened: 0 }; }
  let count = 0;
  let opened = 0;
  for (const entry of entries) {
    opened += 1;
    if (opened > limit) return { count, overBudget: true, opened };
    if (entry.isFile() && !entry.isSymbolicLink()) count += 1;
  }
  return { count, overBudget: false, opened };
}

export class RecordInventory {
  repositoryRoot: string;
  stateRoot: string;
  projectId: string;
  reconciliationEntryBudget: number;
  baselinePath: string;

  constructor(options: { repositoryRoot: string; stateRoot: string; projectId: string; reconciliationEntryBudget?: number }) {
    this.repositoryRoot = fs.realpathSync(options.repositoryRoot);
    this.stateRoot = fs.realpathSync(options.stateRoot);
    this.projectId = isProjectSlug(options.projectId) ? options.projectId : text(options.projectId, ID);
    this.reconciliationEntryBudget = options.reconciliationEntryBudget ?? 4096;
    this.baselinePath = path.join(this.stateRoot, 'ecpe', 'record-inventory', `${this.projectId}.json`);
  }

  private reportDirectory(): string { return path.join(this.repositoryRoot, 'docs', 'reports'); }
  private fixed(): Record<string, StatProjection> {
    return {
      receipt: statProjection(path.join(this.stateRoot, 'security', 'egress.jsonl')),
      session: statProjection(path.join(this.repositoryRoot, 'SESSION.md')),
      eod: statProjection(path.join(this.repositoryRoot, 'dev', 'active', 'EOD_Finalize.md')),
    };
  }

  private loadBaseline(): Record<string, any> | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.baselinePath, 'utf8'));
      return plain(value) && value.schema === 'ecpe.record-inventory.v1' ? value : null;
    } catch { return null; }
  }

  start(runId: string): InventoryStart {
    text(runId, OPAQUE);
    const reports = statProjection(this.reportDirectory());
    const fixed = this.fixed();
    if (!this.loadBaseline()) {
      const counted = reportCount(this.reportDirectory());
      writeJsonAtomic(this.baselinePath, {
        schema: 'ecpe.record-inventory.v1', project_id: this.projectId,
        report_sentinel: reports.sentinel, report_count: counted.count, report_coverage: 'complete', fixed,
        reconciliation_hash: createHash('sha256').update(`${this.projectId}\0${reports.sentinel}\0${counted.count}`).digest('hex'),
      });
    }
    return { run_id: runId, report_sentinel: reports.sentinel, fixed };
  }

  end(started: InventoryStart): Record<string, any> {
    const baseline = this.loadBaseline();
    if (!baseline) throw new EcpeValidationError('record_baseline_missing');
    let calls = 0;
    const reports = statProjection(this.reportDirectory()); calls += 1;
    const fixed = this.fixed(); calls += Object.keys(fixed).length;
    const observations: Array<{ kind: string; delta: number }> = [];
    let opened = 0;
    let coverage = baseline.report_coverage === 'complete' ? 'complete' : 'unknown';
    let queued = false;
    let reportCountValue = baseline.report_count;

    if (reports.sentinel !== started.report_sentinel) {
      const counted = reportCount(this.reportDirectory(), this.reconciliationEntryBudget);
      opened = counted.opened;
      if (counted.overBudget) {
        coverage = 'unknown';
        queued = true;
        reportCountValue = null;
        writeJsonAtomic(path.join(this.stateRoot, 'ecpe', 'health-reconciliation', `${this.projectId}.json`), {
          schema: 'ecpe.health-reconciliation.v1', project_id: this.projectId, reason: 'record_inventory_budget',
        });
      } else {
        coverage = 'complete';
        if (typeof baseline.report_count === 'number' && counted.count !== baseline.report_count) {
          observations.push({ kind: 'report', delta: counted.count - baseline.report_count });
        }
        reportCountValue = counted.count;
      }
    }
    for (const kind of ['receipt', 'session', 'eod'] as const) {
      const before = started.fixed[kind];
      const after = fixed[kind];
      const delta = Number(after.exists) - Number(before.exists);
      if (delta !== 0) observations.push({ kind, delta });
    }
    writeJsonAtomic(this.baselinePath, {
      schema: 'ecpe.record-inventory.v1', project_id: this.projectId,
      report_sentinel: reports.sentinel, report_count: reportCountValue, report_coverage: coverage, fixed,
      reconciliation_hash: createHash('sha256').update(`${this.projectId}\0${reports.sentinel}\0${reportCountValue ?? 'unknown'}`).digest('hex'),
    });
    return {
      run_id: started.run_id,
      record_coverage: coverage,
      observations,
      report_entries_opened: opened,
      open_plus_stat_calls: calls,
      health_reconciliation_queued: queued,
    };
  }
}
