import type { ExecutionProfile } from './types';

export interface ExecutionProfileContract {
  profile: ExecutionProfile;
  inferWhen: string;
  mandatoryModules: string;
  legalSkips: string;
  artifacts: string;
  allowedClaims: string;
}

export const EXECUTION_PROFILE_CONTRACTS: Record<ExecutionProfile, ExecutionProfileContract> = {
  readiness: {
    profile: 'readiness',
    inferWhen: 'A narrow, reversible, pre-deployment or operational readiness decision needs bounded evidence; the requested claim is readiness, not completeness.',
    mandatoryModules: 'Every selected specialist module remains mandatory. Run its entry gates and the smallest source-authorized evidence path that can answer the readiness question.',
    legalSkips: 'Only source-declared conditional work whose condition is demonstrably false, or evidence unavailable after a named attempt. Never skip a STOP gate, approval boundary, reproduction/root-cause gate, or required physical-device/production evidence.',
    artifacts: 'A readiness record naming the exact scope, probes run, evidence and freshness, failures, skipped work with reasons, and the next standard/deep step.',
    allowedClaims: 'Only ready/not-ready for the named bounded decision. Must say “Readiness profile — not a complete review.” Never claim comprehensive, fully verified, production-safe, or no issues found outside the inspected scope.',
  },
  standard: {
    profile: 'standard',
    inferWhen: 'Normal feature or change work has bounded scope and risk and needs the selected specialist’s complete default workflow.',
    mandatoryModules: 'Every selected specialist module and all of its mandatory phases, gates, artifacts, and exit checks.',
    legalSkips: 'Only smart skips explicitly authorized by the specialist and supported by inspected evidence; list each skipped primary module and each skipped conditional phase.',
    artifacts: 'Every artifact required by the selected specialist, plus evidence provenance, unresolved decisions, and a skip ledger.',
    allowedClaims: 'Complete only for the named specialist scope and evidence layer. Broader product, security, production, or device claims require those modules and evidence.',
  },
  deep: {
    profile: 'deep',
    inferWhen: 'Risk, ambiguity, blast radius, cross-system effects, irreversible mutation, security/reliability needs, or production deployment demands stronger evidence.',
    mandatoryModules: 'Every selected specialist module, all mandatory phases and outside-voice/cross-consumer modules selected by the dispatcher, with unchanged STOP and approval gates.',
    legalSkips: 'Only specialist-authorized smart skips proven irrelevant. Missing, stale, malformed, or contradictory evidence is a gap or blocker, never a successful skip.',
    artifacts: 'All specialist artifacts plus changed-input/unchanged-consumer trace, negative and failure-path evidence, provenance/freshness, rollback or reversibility evidence where applicable, and unresolved-risk ledger.',
    allowedClaims: 'Complete only across the explicitly listed modules and evidence layers. “Confirmed” requires independent supporting evidence; production/device/security claims require matching production/device/security evidence.',
  },
};

/** Infer from structured operating conditions, never prompt text. */
export function inferExecutionProfile(
  signals: Record<string, unknown>,
  specialistDefault: ExecutionProfile,
): ExecutionProfile {
  const highRisk = signals.risk === 'high'
    || signals.blast_radius === 'broad'
    || signals.irreversible === true
    || signals.audit_focus === 'security'
    || signals.audit_focus === 'deep'
    || signals.evidence_need === 'independent'
    || signals.failure_impact === 'critical'
    || signals.mutation_scope === 'consequential'
    || signals.external_mutation_authorized === true
    || signals.deployment_state === 'production'
    || signals.release_stage === 'approved-pr'
    || signals.release_stage === 'landed';
  if (highRisk) return 'deep';

  const boundedReadiness = signals.evidence_need === 'readiness'
    && signals.scope === 'narrow'
    && signals.irreversible !== true
    && signals.mutation_scope !== 'consequential'
    && signals.external_mutation_authorized !== true
    && signals.deployment_state !== 'production'
    && signals.release_stage !== 'approved-pr'
    && signals.release_stage !== 'landed';
  if (boundedReadiness) return 'readiness';

  return specialistDefault;
}

export function renderExecutionProfiles(): string {
  const rows = (['readiness', 'standard', 'deep'] as const).map((name) => {
    const contract = EXECUTION_PROFILE_CONTRACTS[name];
    return `## ${name === 'readiness' ? 'Smoke/readiness' : name[0].toUpperCase() + name.slice(1)}\n\n- Infer when: ${contract.inferWhen}\n- Mandatory modules: ${contract.mandatoryModules}\n- Legal skips: ${contract.legalSkips}\n- Artifacts: ${contract.artifacts}\n- Claims: ${contract.allowedClaims}`;
  });
  return `# Inferred execution profiles\n\nChoose a profile from product stage, mutation authority, risk/evidence needs, and deployment state. Prompt keywords and a request to “be quick” are not routing evidence. A profile narrows or strengthens evidence; it never overrides a specialist’s binding question order, pressure, gates, mutation boundary, or exit behavior.\n\n${rows.join('\n\n')}\n`;
}
