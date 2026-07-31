import { createHash } from 'crypto';
import { loadLensRegistry, resolveLensName } from './registry';
import {
  CONFIDENCE_LEVELS,
  DECISION_IMPACTS,
  EVIDENCE_KINDS,
  EVIDENCE_STRENGTHS,
  INFERENCE_STATUSES,
  REMEDIATION_EFFECTS,
  URGENCIES,
  type BaselineFinding,
  type EvidenceCluster,
  type LensEvidence,
  type LensFinding,
  type LensFindingInput,
  type LensSpec,
  type NoveltyStatus,
  type ReconcileInput,
  type ReconcileOutput,
  type SynthesisPlan,
} from './types';

const EVIDENCE_RANK: Record<string, number> = { WEAK: 1, MODERATE: 2, STRONG: 3 };
const IMPACT_RANK: Record<string, number> = { ADVISORY: 1, MATERIAL: 2, BLOCKING: 3 };
const REQUIRED_EVIDENCE_RANK: Record<string, number> = { ANY: 1, STRONG_OR_MODERATE: 2, STRONG_ONLY: 3 };
const REQUIRED_IMPACT_RANK: Record<string, number> = { ANY: 1, MATERIAL_OR_BLOCKING: 2, BLOCKING_ONLY: 3 };
const STRUCTURAL_KEY_RE = /^[a-z][a-z0-9-]{1,95}$/;

const OPPOSITE_EFFECTS = new Set([
  'ADD:REMOVE', 'REMOVE:ADD',
  'ENABLE:DISABLE', 'DISABLE:ENABLE',
  'ALLOW:DENY', 'DENY:ALLOW',
  'RETAIN:DELETE', 'DELETE:RETAIN',
  'REQUIRE:RELAX', 'RELAX:REQUIRE',
]);

function hash(input: string, length = 12): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function normalizePath(value: string | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function normalizeStructuralKey(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function validateStructuralKey(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== 'string' || !STRUCTURAL_KEY_RE.test(normalizeStructuralKey(value))) {
    errors.push(`${field} must be a kebab-case structural key between 2 and 96 characters`);
  }
}

function normalizeDescription(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function evidenceKey(evidence: Partial<LensEvidence>): string {
  const kind = evidence.kind ?? 'unknown';
  const filePath = normalizePath(evidence.path);
  if (kind === 'file_line') return `file_line:${filePath}:${evidence.line ?? '*'}`;
  if (kind === 'file_range') return `file_range:${filePath}:${evidence.line ?? '*'}-${evidence.end_line ?? '*'}`;
  if (kind === 'policy_mismatch') return `policy_mismatch:${evidence.policy_ref ?? evidence.scope ?? filePath}`;
  if (kind === 'cross_file') {
    const paths = [...(evidence.paths ?? []), ...(filePath ? [filePath] : [])].map(normalizePath).sort();
    const scope = evidence.scope ?? normalizeDescription(evidence.description);
    return `cross_file:${hash(`${paths.join('|')}|${scope}`, 20)}`;
  }
  if (['missing_artifact', 'missing_control', 'missing_record', 'unmeasured_claim'].includes(kind)) {
    return `${kind}:${normalizePath(evidence.scope) || filePath || hash(normalizeDescription(evidence.description), 20)}`;
  }
  return `${kind}:${filePath}:${evidence.line ?? '*'}`;
}

function baselineEvidenceKey(finding: BaselineFinding): string | null {
  if (finding.evidence_key?.trim()) return finding.evidence_key.trim();
  if (finding.evidence?.kind) return evidenceKey(finding.evidence);
  if (finding.scope) return `missing_control:${normalizePath(finding.scope)}`;
  if (finding.path && finding.line != null) return `file_line:${normalizePath(finding.path)}:${finding.line}`;
  return null;
}

export function noveltyAgainst(
  finding: LensFindingInput,
  baseline: BaselineFinding[] | undefined,
  mode: 'production' | 'evaluation',
): NoveltyStatus {
  if (baseline === undefined) return 'NOT_MEASURED';

  const claimKey = normalizeStructuralKey(finding.claim_key);
  const control = normalizeStructuralKey(finding.control_or_asset);
  const key = evidenceKey(finding.evidence);

  let unstructuredEvidenceOverlap = false;
  for (const other of baseline) {
    const otherClaim = other.claim_key ? normalizeStructuralKey(other.claim_key) : null;
    const otherControl = other.control_or_asset ? normalizeStructuralKey(other.control_or_asset) : null;
    const otherEvidence = baselineEvidenceKey(other);

    if (otherClaim && otherClaim === claimKey) return 'OVERLAPS_BASELINE';
    if (otherEvidence && otherEvidence === key && otherControl && otherControl === control) {
      return 'OVERLAPS_BASELINE';
    }
    if (otherEvidence && otherEvidence === key) unstructuredEvidenceOverlap = true;
  }

  // Same evidence without a structured material claim is not enough to call the
  // lens finding new or duplicative. Preserve the uncertainty explicitly.
  if (unstructuredEvidenceOverlap) return 'AMBIGUOUS';

  // Production review cannot prove semantic novelty from an exact-match miss.
  // Evaluation fixtures provide a labeled baseline and may record NOVEL.
  return mode === 'evaluation' ? 'NOVEL' : 'NOT_MEASURED';
}

export function stableFindingId(finding: LensFindingInput): string {
  const claim = normalizeStructuralKey(finding.claim_key);
  const evidence = evidenceKey(finding.evidence);
  return `${finding.lens}:${claim}:${hash(evidence, 20)}`;
}

function validateEnum(value: unknown, allowed: readonly string[], field: string, errors: string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) errors.push(`${field} must be one of ${allowed.join(', ')}`);
}

export function validateFinding(input: LensFindingInput, spec: LensSpec): string[] {
  const errors: string[] = [];
  if (input.lens !== spec.lens) errors.push(`lens must be '${spec.lens}'`);
  if (!spec.severity.includes(input.severity)) errors.push(`severity '${input.severity}' is not valid for ${spec.lens}`);
  validateStructuralKey(input.claim_key, 'claim_key', errors);
  validateStructuralKey(input.control_or_asset, 'control_or_asset', errors);
  validateStructuralKey(input.remediation_key, 'remediation_key', errors);
  validateEnum(input.remediation_effect, REMEDIATION_EFFECTS, 'remediation_effect', errors);

  if (!input.evidence || typeof input.evidence !== 'object') {
    errors.push('evidence is required');
    return errors;
  }
  validateEnum(input.evidence.kind, EVIDENCE_KINDS, 'evidence.kind', errors);
  if (!spec.allowed_evidence_kinds.includes(input.evidence.kind)) {
    errors.push(`evidence kind '${input.evidence.kind}' is not allowed for ${spec.lens}`);
  }
  if (!input.evidence.description?.trim()) errors.push('evidence.description is required');
  if (input.evidence.kind === 'file_line' && (!input.evidence.path || input.evidence.line == null)) {
    errors.push('file_line evidence requires path and line');
  }
  if (input.evidence.kind === 'file_range' && (!input.evidence.path || input.evidence.line == null || input.evidence.end_line == null)) {
    errors.push('file_range evidence requires path, line, and end_line');
  }
  if (input.evidence.kind === 'cross_file' && (!input.evidence.paths || input.evidence.paths.length < 2)) {
    errors.push('cross_file evidence requires at least two paths');
  }
  if (['missing_artifact', 'missing_control', 'missing_record', 'unmeasured_claim'].includes(input.evidence.kind) && !input.evidence.scope && !input.evidence.path) {
    errors.push(`${input.evidence.kind} evidence requires scope or path`);
  }
  if (!input.stakeholder_frame?.trim()) errors.push('stakeholder_frame is required');
  if (!input.recommended_action?.trim()) errors.push('recommended_action is required');
  validateEnum(input.decision_impact, DECISION_IMPACTS, 'decision_impact', errors);
  validateEnum(input.evidence_strength, EVIDENCE_STRENGTHS, 'evidence_strength', errors);
  validateEnum(input.inference_status, INFERENCE_STATUSES, 'inference_status', errors);
  validateEnum(input.urgency, URGENCIES, 'urgency', errors);
  validateEnum(input.confidence_evidence_exists, CONFIDENCE_LEVELS, 'confidence_evidence_exists', errors);
  validateEnum(input.confidence_interpretation_correct, CONFIDENCE_LEVELS, 'confidence_interpretation_correct', errors);
  validateEnum(input.confidence_consequence_material, CONFIDENCE_LEVELS, 'confidence_consequence_material', errors);

  if ((EVIDENCE_RANK[input.evidence_strength] ?? 0) < REQUIRED_EVIDENCE_RANK[spec.evidence_threshold]) {
    errors.push(`finding is below evidence threshold ${spec.evidence_threshold}`);
  }
  if ((IMPACT_RANK[input.decision_impact] ?? 0) < REQUIRED_IMPACT_RANK[spec.materiality_threshold]) {
    errors.push(`finding is below materiality threshold ${spec.materiality_threshold}`);
  }
  if (spec.autofix_policy === 'ask_always' && input.classification === 'FIXABLE') {
    errors.push('V0.5 lens findings cannot be FIXABLE when autofix_policy is ask_always');
  }
  return errors;
}

function actionsConverge(group: LensFinding[]): boolean {
  if (group.length < 2) return false;
  const keys = new Set(group.map((finding) => `${normalizeStructuralKey(finding.remediation_key)}:${finding.remediation_effect}`));
  return keys.size === 1;
}

function actionsContradict(a: LensFinding, b: LensFinding): boolean {
  if (normalizeStructuralKey(a.control_or_asset) !== normalizeStructuralKey(b.control_or_asset)) return false;
  return OPPOSITE_EFFECTS.has(`${a.remediation_effect}:${b.remediation_effect}`);
}

function buildSynthesisPlan(findings: LensFinding[], clusters: EvidenceCluster[]): SynthesisPlan {
  const materialFindings = findings.filter((finding) => finding.decision_impact === 'MATERIAL' || finding.decision_impact === 'BLOCKING');
  const lenses = new Set(materialFindings.map((finding) => finding.lens));
  if (lenses.size < 2) {
    return {
      required: false,
      reason: 'CTO synthesis requires material or blocking findings from at least two independent lenses',
      input: null,
    };
  }
  return {
    required: true,
    reason: `Material findings span ${lenses.size} independent lenses`,
    input: {
      findings: materialFindings.map((finding) => ({
        finding_id: finding.finding_id,
        lens: finding.lens,
        claim_key: finding.claim_key,
        control_or_asset: finding.control_or_asset,
        remediation_key: finding.remediation_key,
        remediation_effect: finding.remediation_effect,
        decision_impact: finding.decision_impact,
        evidence_strength: finding.evidence_strength,
        stakeholder_frame: finding.stakeholder_frame,
        recommended_action: finding.recommended_action,
        evidence_cluster_id: finding.evidence_cluster_id,
        contradiction: finding.contradiction,
      })),
      clusters: clusters.filter((cluster) => cluster.finding_ids.some((id) => materialFindings.some((finding) => finding.finding_id === id))),
    },
  };
}

export function reconcileLensResults(repoRoot: string, input: ReconcileInput): ReconcileOutput {
  const specs = loadLensRegistry(repoRoot);
  const findings: LensFinding[] = [];
  const insufficient: ReconcileOutput['insufficient_evidence'] = [];
  const noMaterial: string[] = [];
  const malformed: ReconcileOutput['malformed_or_invalid'] = [];
  const noveltyMode = input.novelty_mode ?? 'production';

  for (const result of input.lens_results) {
    const spec = resolveLensName(specs, result.lens);
    if (!spec) {
      malformed.push({ lens: result.lens, reason: 'unknown lens result', raw: result });
      continue;
    }
    if (result.status === 'INSUFFICIENT_EVIDENCE') {
      insufficient.push({ ...result, lens: spec.lens });
      continue;
    }
    if (result.status === 'NO_MATERIAL_FINDINGS') {
      noMaterial.push(spec.lens);
      continue;
    }
    if (result.status !== 'FINDINGS' || !Array.isArray(result.findings)) {
      malformed.push({ lens: spec.lens, reason: 'invalid lens result envelope', raw: result });
      continue;
    }
    for (const raw of result.findings) {
      const normalizedInput: LensFindingInput = {
        ...raw,
        lens: spec.lens,
        claim_key: normalizeStructuralKey(raw.claim_key ?? ''),
        control_or_asset: normalizeStructuralKey(raw.control_or_asset ?? ''),
        remediation_key: normalizeStructuralKey(raw.remediation_key ?? ''),
      };
      const errors = validateFinding(normalizedInput, spec);
      if (errors.length > 0) {
        malformed.push({ lens: spec.lens, reason: errors.join('; '), raw });
        continue;
      }
      findings.push({
        ...normalizedInput,
        finding_id: normalizedInput.finding_id ?? stableFindingId(normalizedInput),
        classification: 'INVESTIGATE',
        evidence_cluster_id: null,
        novelty_vs_tech_review: noveltyAgainst(normalizedInput, input.tech_findings, noveltyMode),
        novelty_vs_generic_adversarial: noveltyAgainst(normalizedInput, input.generic_adversarial_findings, noveltyMode),
        contradiction: false,
        validation_errors: [],
      });
    }
  }

  const byEvidence = new Map<string, LensFinding[]>();
  for (const finding of findings) {
    const key = evidenceKey(finding.evidence);
    const group = byEvidence.get(key) ?? [];
    group.push(finding);
    byEvidence.set(key, group);
  }

  const clusters: EvidenceCluster[] = [];
  for (const [key, group] of [...byEvidence.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lenses = [...new Set(group.map((finding) => finding.lens))].sort();
    if (lenses.length < 2) continue;
    const id = `EC-${hash(key, 10).toUpperCase()}`;
    let contradiction = false;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        contradiction = contradiction || actionsContradict(group[i], group[j]);
      }
    }
    for (const finding of group) {
      finding.evidence_cluster_id = id;
      finding.contradiction = contradiction;
    }
    const tags: EvidenceCluster['tags'] = ['SHARED_EVIDENCE', 'MULTI_LENS', 'EVIDENCE_CLUSTER'];
    if (contradiction) tags.push('CONTRADICTION');
    clusters.push({
      id,
      evidence_key: key,
      tags,
      finding_ids: group.map((finding) => finding.finding_id).sort(),
      lenses,
      control_or_assets: [...new Set(group.map((finding) => finding.control_or_asset))].sort(),
      remediation_keys: [...new Set(group.map((finding) => finding.remediation_key))].sort(),
      convergent_remediation: actionsConverge(group),
      contradiction,
    });
  }

  findings.sort((a, b) => {
    const impact = (IMPACT_RANK[b.decision_impact] ?? 0) - (IMPACT_RANK[a.decision_impact] ?? 0);
    if (impact !== 0) return impact;
    const evidence = (EVIDENCE_RANK[b.evidence_strength] ?? 0) - (EVIDENCE_RANK[a.evidence_strength] ?? 0);
    if (evidence !== 0) return evidence;
    return a.finding_id.localeCompare(b.finding_id);
  });

  return {
    findings,
    clusters,
    insufficient_evidence: insufficient,
    no_material_findings: noMaterial,
    malformed_or_invalid: malformed,
    synthesis: buildSynthesisPlan(findings, clusters),
  };
}
