import * as fs from 'node:fs';
import * as path from 'node:path';
import { adapterRegistryHash, resolveDeployOperation } from './deploy-adapter-registry';

export type GovernedSkill = 'review' | 'ship' | 'land-and-deploy' | 'setup-deploy';
export type Capability =
  | 'tracked_write' | 'test_generation' | 'test_bootstrap' | 'coverage_generation'
  | 'document_release' | 'external_reply' | 'git_stage' | 'git_commit'
  | 'git_push' | 'pr_create' | 'pr_update' | 'merge' | 'deploy' | 'rollback'
  | 'paid_model' | 'operations_doc';

export interface EffectGrant {
  schema: 'ecpe.effect-scope.v1';
  skill: GovernedSkill;
  capability: Capability;
  assertions: Readonly<Record<string, string | number | readonly string[]>>;
  grantId: string;
}

export interface TrustedPaidValidatorGrantBinding {
  repo_id: string;
  target_ref: string;
  target_sha: string;
  lane: string;
  validator_id: string;
  validator_version: string;
  capability_id: string;
  capability_version: string;
  semantic_policy_hash: string;
}

const SKILLS = new Set<GovernedSkill>(['review', 'ship', 'land-and-deploy', 'setup-deploy']);
const CAPABILITIES = new Set<Capability>([
  'tracked_write', 'test_generation', 'test_bootstrap', 'coverage_generation',
  'document_release', 'external_reply', 'git_stage', 'git_commit', 'git_push',
  'pr_create', 'pr_update', 'merge', 'deploy', 'rollback', 'paid_model', 'operations_doc',
]);
const PAID_VALIDATORS = new Set(['codex.adversarial.v1', 'codex.review.v1']);
const FULL_OID = /^[0-9a-f]{40}$/;

function stableHash(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
}

export function canonicalAssertionPath(raw: string): string {
  if (!raw || path.isAbsolute(raw) || raw.includes('\0') || raw.includes('*')) throw new Error('effect_path_invalid');
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== raw.replaceAll('\\', '/')) {
    throw new Error('effect_path_invalid');
  }
  return normalized;
}

function exactPaths(values: string[], cwd: string, capability: Capability): string[] {
  if (!values.length) throw new Error('effect_path_missing');
  const paths = [...new Set(values.map(canonicalAssertionPath))].sort();
  if (paths.length !== values.length) throw new Error('effect_path_duplicate');
  if (capability === 'tracked_write' && paths.some((item) => !fs.existsSync(path.join(cwd, item)))) throw new Error('effect_path_not_reviewed');
  if ((capability === 'test_generation' || capability === 'coverage_generation')
    && paths.some((item) => !/(^|\/)(test|tests|spec|__tests__|e2e|cypress)(\/|$)/.test(item))) throw new Error('effect_path_not_test');
  if (capability === 'document_release' && paths.some((item) => !/(^|\/)(README|CHANGELOG|CONTRIBUTING|docs\/).*(\.md)?$/i.test(item))) {
    throw new Error('effect_path_not_documentation');
  }
  return paths;
}

export function issueGrant(skill: GovernedSkill, capability: Capability, assertions: Record<string, string | number | readonly string[]>): EffectGrant {
  if (!SKILLS.has(skill) || !CAPABILITIES.has(capability)) throw new Error('effect_scope_unknown');
  const frozen = Object.freeze({ ...assertions });
  return Object.freeze({ schema: 'ecpe.effect-scope.v1', skill, capability, assertions: frozen, grantId: stableHash([skill, capability, frozen]) });
}

export class ProcessLocalGrant {
  #consumed = false;
  #grant: EffectGrant;
  constructor(grant: EffectGrant) { this.#grant = grant; }
  consume(expected: Capability): EffectGrant {
    if (this.#consumed) throw new Error('effect_grant_replayed');
    if (this.#grant.capability !== expected) throw new Error('effect_grant_mismatch');
    this.#consumed = true;
    return this.#grant;
  }
}

export function resolveEffectScope(input: {
  skill: string;
  capability?: string;
  fix?: boolean;
  paths?: string[];
  pr?: number;
  commentId?: string;
  mode?: string;
  environment?: string;
  validatorId?: string;
  trustedPaidValidatorId?: string;
  trustedPaidValidatorBinding?: TrustedPaidValidatorGrantBinding;
  classificationState?: 'complete' | 'semantic_declaration_required';
  candidatePolicyState?: 'absent' | 'same' | 'strengthening_applied' | 'authorized_promotion' | 'ignored_untrusted';
  cwd?: string;
  trustedDeployTarget?: {
    id: string;
    environment_class: string;
    trigger: string;
    binding: Record<string, string>;
  };
}): EffectGrant[] {
  if (!SKILLS.has(input.skill as GovernedSkill)) throw new Error('effect_skill_invalid');
  const skill = input.skill as GovernedSkill;
  const cwd = path.resolve(input.cwd ?? process.cwd());
  if (!input.capability) {
    if (skill === 'review') return input.fix ? [issueGrant(skill, 'tracked_write', { paths: exactPaths(input.paths ?? [], cwd, 'tracked_write') })] : [];
    if (skill === 'setup-deploy') return [issueGrant(skill, 'operations_doc', { paths: ['docs/OPERATIONS.md'] })];
    throw new Error('effect_capability_required');
  }
  if (!CAPABILITIES.has(input.capability as Capability)) throw new Error('effect_capability_invalid');
  const capability = input.capability as Capability;
  if (capability === 'external_reply') {
    if (!Number.isSafeInteger(input.pr) || (input.pr ?? 0) <= 0 || !input.commentId || !/^[A-Za-z0-9_.:-]+$/.test(input.commentId)) throw new Error('effect_provider_assertion_invalid');
    return [issueGrant(skill, capability, { pr: input.pr!, commentId: input.commentId })];
  }
  if (capability === 'merge' || capability === 'deploy') {
    if (input.classificationState === 'semantic_declaration_required') throw new Error('semantic_declaration_required');
    if (input.candidatePolicyState && !['absent', 'same', 'authorized_promotion'].includes(input.candidatePolicyState)) throw new Error('candidate_policy_unresolved');
    if (skill !== 'land-and-deploy' || !Number.isSafeInteger(input.pr) || (input.pr ?? 0) <= 0) throw new Error('effect_land_assertion_invalid');
    if (!['merge-only', 'merge-and-deploy'].includes(input.mode ?? '')) throw new Error('effect_land_mode_invalid');
    if (capability === 'deploy' && (!input.environment || !/^[A-Za-z0-9._:-]+$/.test(input.environment))) throw new Error('effect_environment_invalid');
    if (input.trustedDeployTarget) {
      const target = input.trustedDeployTarget;
      if ((target.trigger === 'none' && input.mode !== 'merge-only') || (target.trigger === 'on_merge' && input.mode !== 'merge-and-deploy')) throw new Error('deploy_binding_mismatch');
      if (capability === 'deploy') {
        const operation = resolveDeployOperation(target, 'status');
        if (!operation.supported) throw new Error('adapter_operation_unsupported');
        if (input.environment !== target.binding.environment_database_id) throw new Error('effect_environment_mismatch');
      }
      const bindingHash = stableHash(target.binding);
      return [issueGrant(skill, capability, {
        pr: input.pr!, mode: input.mode!, target_id: target.id,
        environment_class: target.environment_class,
        trigger: target.trigger,
        binding_hash: bindingHash,
        adapter_registry_hash: adapterRegistryHash(),
        ...(input.environment ? { environment: input.environment } : {}),
      })];
    }
    return [issueGrant(skill, capability, { pr: input.pr!, mode: input.mode!, ...(input.environment ? { environment: input.environment } : {}) })];
  }
  if (capability === 'paid_model') {
    if (!input.validatorId || (!PAID_VALIDATORS.has(input.validatorId) && input.trustedPaidValidatorId !== input.validatorId)) throw new Error('validator_id_invalid');
    if (process.env.ECPE_PAID_MODEL_AUTHORIZED !== '1') throw new Error('grant_required');
    if (input.trustedPaidValidatorBinding) {
      if (input.trustedPaidValidatorBinding.validator_id !== input.validatorId) throw new Error('validator_binding_mismatch');
      return [issueGrant(skill, capability, input.trustedPaidValidatorBinding)];
    }
    return [issueGrant(skill, capability, { validatorId: input.validatorId })];
  }
  if (['tracked_write', 'test_generation', 'coverage_generation'].includes(capability)) {
    return [issueGrant(skill, capability, { paths: exactPaths(input.paths ?? [], cwd, capability) })];
  }
  if (['document_release', 'git_stage', 'git_commit', 'git_push', 'pr_create', 'pr_update', 'rollback'].includes(capability)) {
    throw new Error('effect_closed_adapter_required');
  }
  return [issueGrant(skill, capability, {})];
}

export function validateFullOid(value: string): string {
  if (!FULL_OID.test(value)) throw new Error('git_oid_invalid');
  return value;
}
