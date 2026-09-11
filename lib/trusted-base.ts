import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareCandidateProfile, LANES, parseWorkProfile, type Lane, type ParsedWorkProfile } from './work-profile';
import { resolveProjectIdentity, resolveTrustedLocalBase } from './project-identity';
import { resolveRuntimeStateRoot } from './canonical-state-root';
import { inspectSafetyLatch } from './milestone-block';
import { resolveCanaryExecutionGate } from './lane-canary';
import { inspectAuthorizedProfilePromotion, type ProfilePromotionLineage } from './profile-promotion-writer';

export interface TrustedBaseResolution {
  source: 'provider_pr_base' | 'remote_default' | 'registry_pinned_commit' | 'untrusted_comparison_ref';
  target_ref: string | null;
  target_sha: string;
  candidate_sha: string;
  merge_base_sha: string;
}

export interface ResolvedWorkProfile {
  schema_version: 'harness.gstack.work-profile.v1';
  mode: 'legacy' | 'profile';
  activation: Record<Lane, 'legacy' | 'shadow' | 'enforce'>;
  lane: Lane;
  lane_activation: 'legacy' | 'shadow' | 'enforce';
  execution: 'legacy' | 'profile';
  trusted_base: TrustedBaseResolution;
  trusted_merge_base_sha: string;
  trusted_blob_sha?: string;
  profile_hash: string | null;
  semantic_policy_hashes: Record<string, string>;
  validator_version_hashes: Record<string, string>;
  candidate_state: 'absent' | 'same' | 'strengthening_applied' | 'authorized_promotion' | 'ignored_untrusted';
  promotion_lineage: ProfilePromotionLineage | null;
  effective: ParsedWorkProfile | null;
  trusted_release?: ParsedWorkProfile['release'] | null;
  warnings: string[];
}

export interface TrustedActivationSnapshot {
  schema: 'ecpe.trusted-activation-snapshot.v1';
  trusted_base_sha: string;
  profile_blob_sha: string;
  activations: Record<Lane, { activation: 'legacy' | 'shadow' | 'enforce'; profile_lineage_hash: string }>;
}

function git(cwd: string, args: string[], allowMissing = false): string | undefined {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' } });
  if (result.status !== 0) { if (allowMissing) return undefined; throw new Error('trusted_base_git_failure'); }
  return result.stdout.trim();
}
function remoteDefault(cwd: string): string | undefined {
  const symbolic = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], true);
  if (symbolic?.startsWith('refs/remotes/') && git(cwd, ['rev-parse', '--verify', `${symbolic}^{commit}`], true)) return symbolic.slice('refs/remotes/'.length);
  for (const candidate of ['origin/main', 'origin/master']) if (git(cwd, ['rev-parse', '--verify', `${candidate}^{commit}`], true)) return candidate;
  return undefined;
}
function readAt(cwd: string, sha: string, file: string): string | undefined { return git(cwd, ['show', `${sha}:${file}`], true); }
function validatorHashes(profile: ParsedWorkProfile): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  for (const validatorId of Object.keys(profile.validators).sort()) output[validatorId] = new Bun.CryptoHasher('sha256').update(JSON.stringify(profile.validators[validatorId])).digest('hex');
  return output;
}
function semanticValidatorHashes(profile: ParsedWorkProfile): Record<string, string> {
  const output: Record<string, string> = Object.create(null);
  for (const [validatorId, validator] of Object.entries(profile.validators).sort(([a], [b]) => a.localeCompare(b))) {
    const roles = new Set([...validator.depends_on, ...validator.required_by_surface]);
    const capabilities = new Set([validator.capability, ...(validator.provides ?? [])]);
    const projection = {
      semantic_paths: profile.semantic_paths.filter((entry) => entry.roles.some((role) => roles.has(role))),
      dependency_surfaces: (profile.dependency_surfaces ?? []).filter((entry) => entry.capability_ids.some((capability) => capabilities.has(capability)) || entry.dependency_ids.some((dependency) => validator.dependency_ids?.includes(dependency))),
      lanes: Object.fromEntries(Object.entries(profile.lanes).map(([lane, spec]) => [lane, { required: spec.required_capabilities.filter((capability) => capabilities.has(capability)), stages: Object.fromEntries(Object.entries(spec.stage_requirements).map(([stage, values]) => [stage, (values ?? []).filter((capability) => capabilities.has(capability))]).filter(([, values]) => values.length)) }]).filter(([, value]) => value.required.length || Object.keys(value.stages).length)),
      metadata_projections: roles.has('release_metadata') ? profile.metadata_projections : [],
      validator: { required_by_surface: validator.required_by_surface, depends_on: validator.depends_on, dependency_ids: validator.dependency_ids ?? [], lockfiles: validator.lockfiles ?? [], ttl: validator.ttl ?? null },
    };
    output[validatorId] = new Bun.CryptoHasher('sha256').update(JSON.stringify(projection)).digest('hex');
  }
  return output;
}

export function resolveTrustedWorkProfile(input: { cwd?: string; lane: Lane; assertTargetRef?: string; assertTargetSha?: string; providerBaseRef?: string; advisoryComparisonRef?: string; environment?: Record<string, string | undefined>; safetyStateRoot?:string }): ResolvedWorkProfile {
  if (!LANES.includes(input.lane)) throw new Error('lane_invalid');
  const cwd = fs.realpathSync(path.resolve(input.cwd ?? process.cwd()));
  const env = input.environment ?? process.env;
  const force = env.GSTACK_FORCE_LEGACY;
  if (force !== undefined && force !== '' && force !== '1') throw new Error('force_legacy_invalid');
  const detectedRemote = remoteDefault(cwd);
  if (input.advisoryComparisonRef && (input.providerBaseRef || detectedRemote)) throw new Error('comparison_ref_remote_forbidden');
  let localBase: ReturnType<typeof resolveTrustedLocalBase> | undefined;
  if (!input.providerBaseRef && !detectedRemote && !input.advisoryComparisonRef) localBase = resolveTrustedLocalBase(cwd, input.assertTargetSha);
  const targetRef = input.providerBaseRef ?? detectedRemote ?? input.advisoryComparisonRef ?? localBase?.trusted_base_ref;
  if (!targetRef) throw new Error('trusted_base_ref_missing');
  if (localBase && input.assertTargetRef) throw new Error('trusted_base_assertion_kind_mismatch');
  if (!localBase && input.assertTargetSha) throw new Error('trusted_base_assertion_kind_mismatch');
  if (input.assertTargetRef && input.assertTargetRef !== targetRef) throw new Error('trusted_base_assertion_mismatch');
  const targetSha = localBase?.target_sha ?? git(cwd, ['rev-parse', '--verify', `${targetRef}^{commit}`]);
  const candidateSha = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!targetSha || !candidateSha) throw new Error('trusted_base_sha_missing');
  const mergeBaseSha = git(cwd, ['merge-base', targetSha, candidateSha]);
  if (!mergeBaseSha) throw new Error('trusted_merge_base_missing');
  const advisory = Boolean(input.advisoryComparisonRef);
  const trustedBase: TrustedBaseResolution = { source: input.providerBaseRef ? 'provider_pr_base' : advisory ? 'untrusted_comparison_ref' : localBase ? 'registry_pinned_commit' : 'remote_default', target_ref: targetRef, target_sha: targetSha, candidate_sha: candidateSha, merge_base_sha: mergeBaseSha };
  const activation = Object.fromEntries(LANES.map((lane) => [lane, 'legacy'])) as ResolvedWorkProfile['activation'];
  const trustedText = readAt(cwd, mergeBaseSha, '.gstack/work-profile.yaml');
  const candidatePath = path.join(cwd, '.gstack', 'work-profile.yaml');
  if (trustedText === undefined) {
    const treeEntry = git(cwd, ['ls-tree', mergeBaseSha, '--', '.gstack/work-profile.yaml'], true);
    if (treeEntry === undefined) throw new Error('trusted_profile_presence_unresolved');
    if (treeEntry.trim()) throw new Error('trusted_profile_unreadable');
    return { schema_version: 'harness.gstack.work-profile.v1', mode: 'legacy', activation, lane: input.lane, lane_activation: 'legacy', execution: 'legacy', trusted_base: trustedBase, trusted_merge_base_sha: mergeBaseSha, profile_hash: null, semantic_policy_hashes: {}, validator_version_hashes: {}, candidate_state: fs.existsSync(candidatePath) ? 'ignored_untrusted' : 'absent', promotion_lineage: null, effective: null, trusted_release: null, warnings: fs.existsSync(candidatePath) ? ['first_profile_untrusted'] : [] };
  }
  let trusted: ParsedWorkProfile;
  try { trusted = parseWorkProfile(trustedText); } catch { throw new Error('trusted_profile_invalid'); }
  for (const lane of LANES) activation[lane] = trusted.lanes[lane].activation;
  let effective = trusted; let candidateState: ResolvedWorkProfile['candidate_state'] = 'absent'; let promotionLineage: ProfilePromotionLineage | null = null; let warnings: string[] = [];
  if (fs.existsSync(candidatePath)) {
    try {
      const candidate=parseWorkProfile(fs.readFileSync(candidatePath, 'utf8'));
      const compared = compareCandidateProfile(trusted, candidate); effective = compared.effective; candidateState = compared.state; warnings = compared.warnings;
      if(compared.state==='ignored_untrusted'&&trusted.lanes[input.lane].activation==='shadow'&&candidate.lanes[input.lane].activation==='enforce'){
        try{const authorized=inspectAuthorizedProfilePromotion({stateRoot:input.safetyStateRoot??resolveRuntimeStateRoot().root,cwd,lane:input.lane,trustedProfileHash:trusted.semantic_policy_hash,candidateProfileHash:candidate.semantic_policy_hash});if(authorized){effective=candidate;candidateState='authorized_promotion';promotionLineage=authorized;warnings=[]}}
        catch{candidateState='ignored_untrusted';warnings=['candidate_promotion_unresolved']}
      }
    }
    catch { candidateState = 'ignored_untrusted'; warnings = ['candidate_profile_invalid']; }
  }
  const laneActivation = effective.lanes[input.lane].activation;
  if (force === '1') warnings = [...warnings, 'forced_legacy'];
  let activationBlocked=false;
  if(laneActivation==='enforce'){
    try{
      const identity=resolveProjectIdentity(cwd,{mode:'profile'});
      if(identity.repo_id==='portfolioops'){
        const gateRoot=input.safetyStateRoot??resolveRuntimeStateRoot().root;
        const latch=inspectSafetyLatch({stateRoot:gateRoot,participant:'portfolioops',lane:input.lane});
        if(latch.result==='latched'){
          activationBlocked=true;
          warnings=[...warnings,`safety_latched:${latch.latch_id}`];
        }else{
          const gate=resolveCanaryExecutionGate({stateRoot:gateRoot,repoId:identity.repo_id,lane:input.lane,profileHash:trusted.semantic_policy_hash});
          if(!gate.execution_allowed){activationBlocked=true;warnings=[...warnings,gate.reason]}
        }
      }
    }catch{activationBlocked=true;warnings=[...warnings,'enforce_lineage_unresolved']}
  }
  const blob = git(cwd, ['rev-parse', `${mergeBaseSha}:.gstack/work-profile.yaml`], true);
  return { schema_version: 'harness.gstack.work-profile.v1', mode: 'profile', activation: Object.fromEntries(LANES.map((lane) => [lane, effective.lanes[lane].activation])) as ResolvedWorkProfile['activation'], lane: input.lane, lane_activation: laneActivation, execution: advisory || force === '1' || activationBlocked || laneActivation !== 'enforce' ? 'legacy' : 'profile', trusted_base: trustedBase, trusted_merge_base_sha: mergeBaseSha, ...(blob ? { trusted_blob_sha: blob } : {}), profile_hash: trusted.semantic_policy_hash, semantic_policy_hashes: semanticValidatorHashes(effective), validator_version_hashes: validatorHashes(effective), candidate_state: candidateState, promotion_lineage: promotionLineage, effective, trusted_release: trusted.release, warnings: advisory ? [...warnings, 'untrusted_comparison_ref'] : warnings };
}

export function resolveTrustedActivationSnapshot(input: { cwd?: string; assertTargetRef?: string; assertTargetSha?: string; providerBaseRef?: string; safetyStateRoot?: string }): TrustedActivationSnapshot {
  const cwd = fs.realpathSync(path.resolve(input.cwd ?? process.cwd()));
  const resolved = resolveTrustedWorkProfile({
    cwd,
    lane: 'single_repo_code',
    assertTargetRef: input.assertTargetRef,
    assertTargetSha: input.assertTargetSha,
    providerBaseRef: input.providerBaseRef,
    safetyStateRoot: input.safetyStateRoot,
    environment: {},
  });
  const trustedText = readAt(cwd, resolved.trusted_merge_base_sha, '.gstack/work-profile.yaml');
  if (trustedText === undefined) {
    const activations = Object.fromEntries(LANES.map((lane) => [lane, {
      activation: 'legacy' as const,
      profile_lineage_hash: new Bun.CryptoHasher('sha256').update(`legacy\0${resolved.trusted_merge_base_sha}\0${lane}`).digest('hex'),
    }])) as TrustedActivationSnapshot['activations'];
    return {
      schema: 'ecpe.trusted-activation-snapshot.v1',
      trusted_base_sha: resolved.trusted_merge_base_sha,
      profile_blob_sha: new Bun.CryptoHasher('sha256').update(`legacy\0${resolved.trusted_merge_base_sha}`).digest('hex'),
      activations,
    };
  }
  let trusted: ParsedWorkProfile;
  try { trusted = parseWorkProfile(trustedText); } catch { throw new Error('trusted_profile_invalid'); }
  const blob = git(cwd, ['rev-parse', `${resolved.trusted_merge_base_sha}:.gstack/work-profile.yaml`]);
  if (!blob || !/^[0-9a-f]{40}$/.test(blob)) throw new Error('trusted_profile_blob_invalid');
  return {
    schema: 'ecpe.trusted-activation-snapshot.v1',
    trusted_base_sha: resolved.trusted_merge_base_sha,
    profile_blob_sha: blob,
    activations: Object.fromEntries(LANES.map((lane) => [lane, {
      activation: trusted.lanes[lane].activation,
      profile_lineage_hash: trusted.semantic_policy_hash,
    }])) as TrustedActivationSnapshot['activations'],
  };
}
