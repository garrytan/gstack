import type { ChangeManifest } from './change-manifest';
import type { ResolvedWorkProfile } from './trusted-base';
import { resolveProfileRequirements, type FinishLine, type Lane } from './work-profile';

const SKILLS = new Set(['review', 'ship', 'land-and-deploy', 'setup-deploy']);
const WORK_KINDS = new Set(['answer', 'design', 'diagnose', 'change', 'review', 'release', 'operation']);
function hash(value: unknown): string { return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex'); }

export function resolveManifestLane(profile:ResolvedWorkProfile['effective'],manifest:ChangeManifest):Lane{if(!profile)return'single_repo_code';const dependencies=profile.dependency_surfaces??[];const cross=manifest.changed.some(entry=>dependencies.some(surface=>new Bun.Glob(surface.glob).match(entry.path)));return cross?'cross_repo_contract':manifest.roles.every(role=>['docs','ui','release_metadata'].includes(role))?'docs_ux':'single_repo_code'}

export function resolveExecutionPlan(input: { skill: string; workKind: string; finishLine: FinishLine; lane: Lane; resolvedProfile: ResolvedWorkProfile; manifest: ChangeManifest; currentEvidence?: unknown[]; initialSectionBatches?: unknown[]; lifecycle?: unknown; canaryFocus?: unknown; onSpawn?: () => void }) {
  if(input.resolvedProfile.lane!==input.lane)throw new Error('execution_plan_lane_mismatch');
  if (!SKILLS.has(input.skill)) throw new Error('execution_plan_skill_invalid');
  if (!WORK_KINDS.has(input.workKind)) throw new Error('execution_plan_work_kind_invalid');
  if (!input.resolvedProfile.effective) {
    const body = { schema: 'ecpe.execution-plan.v1' as const, skill: input.skill, work_kind: input.workKind, finish_line: input.finishLine, lane: input.lane, mode: 'legacy' as const, profile: input.resolvedProfile, manifest: input.manifest, requirements: { required_capabilities: [], validator_ids: [], covered_by: {}, validator_bindings: {}, unbound_capabilities: [] }, evidence_requirements: [], current_evidence: input.currentEvidence ?? [], blockers: input.manifest.classification_state === 'complete' ? [] : ['semantic_declaration_required'], effect_proposal: [], initial_sections: [], initial_section_batches: input.initialSectionBatches ?? [], ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}), ...(input.canaryFocus ? { canary_focus: input.canaryFocus } : {}) };
    return { ...body, decision_id: `decision-${hash(body).slice(0, 24)}` };
  }
  const requirements = resolveProfileRequirements(input.resolvedProfile.effective, { roles: input.manifest.roles, lane: input.lane, finishLine: input.finishLine });
  const blockers = input.manifest.classification_state === 'complete' ? [] : ['semantic_declaration_required'];
  if (['ship', 'land-and-deploy'].includes(input.skill) && !['absent', 'same', 'authorized_promotion'].includes(input.resolvedProfile.candidate_state)) blockers.push('candidate_policy_unresolved');
  if (input.resolvedProfile.execution === 'profile') {
    for (const row of input.currentEvidence ?? []) {
      const evidence = row as { validator_id?: unknown; current?: unknown };
      if (evidence.current !== true && typeof evidence.validator_id === 'string') blockers.push(`evidence_not_current:${evidence.validator_id}`);
    }
  }
  const initialSections = input.skill === 'review' || input.skill === 'ship' ? ['review-army'] : input.skill === 'land-and-deploy' ? ['first-run-validation'] : [];
  const evidenceRequirements = requirements.validator_ids.map((validatorId) => {
    const validator = input.resolvedProfile.effective!.validators[validatorId];
    return { validator_id: validatorId, capability_id: validator.capability, execution_effect: validator.execution_effect, validator_version: input.resolvedProfile.validator_version_hashes?.[validatorId] ?? requirements.validator_bindings[validatorId]?.validator_version, semantic_policy_hash: input.resolvedProfile.semantic_policy_hashes?.[validatorId] ?? requirements.validator_bindings[validatorId]?.semantic_policy_hash };
  });
  const proposals: Record<string, string[]> = {
    review: [],
    ship: ['git_stage', 'git_commit', 'git_push', 'pr_create_or_update'],
    'land-and-deploy': input.resolvedProfile.effective.deploy_targets && Object.values(input.resolvedProfile.effective.deploy_targets)[0]?.trigger === 'on_merge' ? ['merge', 'deploy'] : ['merge'],
    'setup-deploy': ['operations_doc'],
  };
  const body = { schema: 'ecpe.execution-plan.v1' as const, skill: input.skill, work_kind: input.workKind, finish_line: input.finishLine, lane: input.lane, mode: input.resolvedProfile.execution, profile: input.resolvedProfile, manifest: input.manifest, requirements, evidence_requirements: evidenceRequirements, current_evidence: input.currentEvidence ?? [], blockers, effect_proposal: blockers.length ? [] : proposals[input.skill], initial_sections: initialSections, initial_section_batches: input.initialSectionBatches ?? [], ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}), ...(input.canaryFocus ? { canary_focus: input.canaryFocus } : {}) };
  return { ...body, decision_id: `decision-${hash(body).slice(0, 24)}` };
}
