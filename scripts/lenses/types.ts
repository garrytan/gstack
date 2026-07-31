export const LENS_STATUSES = ['READY', 'DRAFT', 'DEFERRED'] as const;
export type LensStatus = (typeof LENS_STATUSES)[number];

export const EVIDENCE_KINDS = [
  'file_line',
  'file_range',
  'cross_file',
  'missing_artifact',
  'missing_control',
  'missing_record',
  'policy_mismatch',
  'unmeasured_claim',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const DECISION_IMPACTS = ['BLOCKING', 'MATERIAL', 'ADVISORY'] as const;
export type DecisionImpact = (typeof DECISION_IMPACTS)[number];

export const EVIDENCE_STRENGTHS = ['STRONG', 'MODERATE', 'WEAK'] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const INFERENCE_STATUSES = [
  'DIRECTLY_SUPPORTED',
  'CONDITIONAL',
  'ASSUMPTION_DEPENDENT',
  'REQUIRES_DOMAIN_VALIDATION',
] as const;
export type InferenceStatus = (typeof INFERENCE_STATUSES)[number];

export const URGENCIES = ['PRE_SHIP', 'PLANNED', 'MONITOR'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const REMEDIATION_EFFECTS = [
  'ADD',
  'REMOVE',
  'ENABLE',
  'DISABLE',
  'ALLOW',
  'DENY',
  'RETAIN',
  'DELETE',
  'CHANGE',
  'REQUIRE',
  'RELAX',
  'NEUTRAL',
] as const;
export type RemediationEffect = (typeof REMEDIATION_EFFECTS)[number];

export const NOVELTY_STATUSES = [
  'NOVEL',
  'OVERLAPS_BASELINE',
  'AMBIGUOUS',
  'NOT_MEASURED',
] as const;
export type NoveltyStatus = (typeof NOVELTY_STATUSES)[number];

export type AutofixPolicy = 'ask_always' | 'mechanical_only';
export type MissingEvidencePolicy = 'INSUFFICIENT_EVIDENCE';
export type EvidenceThreshold = 'STRONG_ONLY' | 'STRONG_OR_MODERATE' | 'ANY';
export type MaterialityThreshold = 'BLOCKING_ONLY' | 'MATERIAL_OR_BLOCKING' | 'ANY';
export type EscalationPolicy = 'ADVISORY' | 'MATERIAL' | 'BLOCKING' | 'REQUIRES_DOMAIN_VALIDATION' | 'ADVISORY_PLUS_MATERIAL';

export interface SemanticTrigger {
  kind: 'pr_label' | 'file_metadata' | 'user_declared';
  value: string;
}

export interface InvocationTriggers {
  path_globs: string[];
  semantic_triggers: SemanticTrigger[];
}

export interface LensSpec {
  lens: string;
  cli_aliases: string[];
  status: LensStatus;
  summary: string;
  primary_skill: string[];
  supported_skills: string[];
  severity: string[];
  ranking: string;
  scope_disclaimer: string;
  required_artifacts: string[];
  optional_artifacts: string[];
  required_context: string[];
  optional_context: string[];
  allowed_evidence_kinds: EvidenceKind[];
  on_missing_required_evidence: MissingEvidencePolicy;
  invocation_triggers: InvocationTriggers;
  evidence_threshold: EvidenceThreshold;
  materiality_threshold: MaterialityThreshold;
  escalation_policy: EscalationPolicy;
  autofix_policy: AutofixPolicy;
  safety_directive: string | null;
  prompt_marker_name: string;
  body: string;
  path: string;
}

export interface LensEvidence {
  path?: string;
  line?: number | null;
  end_line?: number | null;
  kind: EvidenceKind;
  scope?: string;
  policy_ref?: string;
  description: string;
  paths?: string[];
  source?: 'diff' | 'repository' | 'context' | 'artifact';
}

export interface LensFindingInput {
  finding_id?: string;
  lens: string;
  severity: string;

  // Structured semantic keys make reconciliation deterministic. These are
  // identifiers, not prose, and should remain stable across prompt reruns.
  claim_key: string;
  control_or_asset: string;
  remediation_key: string;
  remediation_effect: RemediationEffect;

  evidence: LensEvidence;
  stakeholder_frame: string;
  middle_fields?: Record<string, unknown>;
  required_proof?: string;
  recommended_action: string;
  classification?: 'FIXABLE' | 'INVESTIGATE';
  decision_impact: DecisionImpact;
  evidence_strength: EvidenceStrength;
  inference_status: InferenceStatus;
  urgency: Urgency;
  confidence_evidence_exists: ConfidenceLevel;
  confidence_interpretation_correct: ConfidenceLevel;
  confidence_consequence_material: ConfidenceLevel;
}

export interface LensFinding extends LensFindingInput {
  finding_id: string;
  classification: 'FIXABLE' | 'INVESTIGATE';
  evidence_cluster_id: string | null;
  novelty_vs_tech_review: NoveltyStatus;
  novelty_vs_generic_adversarial: NoveltyStatus;
  contradiction: boolean;
  validation_errors: string[];
}

export interface InsufficientEvidenceResult {
  lens: string;
  status: 'INSUFFICIENT_EVIDENCE';
  missing_required: string[];
  missing_optional?: string[];
  why_insufficient: string;
  what_would_make_actionable: string;
}

export interface NoMaterialFindingsResult {
  lens: string;
  status: 'NO_MATERIAL_FINDINGS';
}

export interface LensFindingResult {
  lens: string;
  status: 'FINDINGS';
  findings: LensFindingInput[];
}

export type LensResult = InsufficientEvidenceResult | NoMaterialFindingsResult | LensFindingResult;

export interface BaselineFinding {
  evidence_key?: string;
  path?: string;
  line?: number | null;
  scope?: string;
  category?: string;
  summary?: string;
  claim?: string;
  claim_key?: string;
  control_or_asset?: string;
  remediation_key?: string;
  evidence?: Partial<LensEvidence>;
}

export interface EvidenceCluster {
  id: string;
  evidence_key: string;
  tags: Array<'SHARED_EVIDENCE' | 'MULTI_LENS' | 'EVIDENCE_CLUSTER' | 'CONTRADICTION'>;
  finding_ids: string[];
  lenses: string[];
  control_or_assets: string[];
  remediation_keys: string[];
  convergent_remediation: boolean;
  contradiction: boolean;
}

export interface SynthesisInput {
  findings: Array<Pick<LensFinding,
    'finding_id' | 'lens' | 'claim_key' | 'control_or_asset' | 'remediation_key' |
    'remediation_effect' | 'decision_impact' | 'evidence_strength' |
    'stakeholder_frame' | 'recommended_action' | 'evidence_cluster_id' | 'contradiction'>>;
  clusters: EvidenceCluster[];
}

export interface SynthesisPlan {
  required: boolean;
  reason: string;
  input: SynthesisInput | null;
}

export interface ReconcileInput {
  novelty_mode?: 'production' | 'evaluation';
  lens_results: LensResult[];
  tech_findings?: BaselineFinding[];
  generic_adversarial_findings?: BaselineFinding[];
}

export interface ReconcileOutput {
  findings: LensFinding[];
  clusters: EvidenceCluster[];
  insufficient_evidence: InsufficientEvidenceResult[];
  no_material_findings: string[];
  malformed_or_invalid: Array<{ lens: string; reason: string; raw?: unknown }>;
  synthesis: SynthesisPlan;
}

export interface SynthesisReferenceItem {
  finding_ids: string[];
  [key: string]: unknown;
}

export interface CtoSynthesisOutput {
  shared_primitives: Array<{ primitive: string; rationale: string; finding_ids: string[] }>;
  reinforcing_constraints: Array<{ summary: string; finding_ids: string[] }>;
  tensions: Array<{ summary: string; decision_required: string; finding_ids: string[] }>;
  sequencing: Array<{ order: number; action: string; finding_ids: string[] }>;
  decisions_required: Array<{ decision: string; finding_ids: string[]; options?: string[] }>;
}
