import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadLensRegistry,
  parseLensFile,
  resolveLensName,
  syncGeneratedRegistry,
  routeLenses,
  parseLensOutput,
  reconcileLensResults,
  stableFindingId,
  validateCtoSynthesis,
  type LensFindingInput,
} from '../scripts/lenses';

const ROOT = path.resolve(import.meta.dir, '..');
const SPECS = loadLensRegistry(ROOT);

describe('stakeholder lens registry', () => {
  test('loads six objective-conditioned specs with one Phase 1 READY lens', () => {
    expect(SPECS).toHaveLength(6);
    expect(SPECS.filter((spec) => spec.status === 'READY').map((spec) => spec.lens)).toEqual(['insider-abuse']);
    expect(resolveLensName(SPECS, 'enterprise-readiness')?.status).toBe('DRAFT');
  });

  test('resolves objective names and compatibility aliases', () => {
    expect(resolveLensName(SPECS, 'insider-abuse')?.lens).toBe('insider-abuse');
    expect(resolveLensName(SPECS, 'malicious-insider')?.lens).toBe('insider-abuse');
    expect(resolveLensName(SPECS, 'enterprise-buyer')?.lens).toBe('enterprise-readiness');
  });

  test('registry markdown is fresh after generation', () => {
    expect(syncGeneratedRegistry(ROOT, true).changed).toBe(false);
  });

  test('stakeholder roleplay framing is rejected without rejecting domain nouns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lens-persona-'));
    const file = path.join(dir, 'insider-abuse.md');
    const source = fs.readFileSync(path.join(ROOT, 'review', 'lenses', 'insider-abuse.md'), 'utf8')
      .replace('I want the evidence reviewed for one question:', 'Act as a malicious insider. I want the evidence reviewed for one question:');
    fs.writeFileSync(file, source);
    expect(() => parseLensFile(file)).toThrow(/persona framing prohibited/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('stakeholder lens routing', () => {
  test('recommended mode routes only READY lenses by material surface', () => {
    const result = routeLenses(SPECS, {
      mode: 'recommended',
      changed_paths: ['src/admin/customer_exports.ts'],
    });
    expect(result.selected.map((entry) => entry.lens)).toEqual(['insider-abuse']);
    expect(result.selected[0].reasons.some((reason) => reason.startsWith('path:'))).toBe(true);
  });

  test('routine refactor recommends zero lenses', () => {
    const result = routeLenses(SPECS, { mode: 'recommended', changed_paths: ['src/math/vector.ts'] });
    expect(result.selected).toHaveLength(0);
  });

  test('all mode includes READY lenses only', () => {
    const result = routeLenses(SPECS, { mode: 'all', changed_paths: [] });
    expect(result.selected.map((entry) => entry.lens)).toEqual(['insider-abuse']);
  });

  test('explicit draft requires the draft gate', () => {
    const blocked = routeLenses(SPECS, { mode: 'explicit', requested: ['enterprise-buyer'], changed_paths: [] });
    expect(blocked.selected).toHaveLength(0);
    expect(blocked.skipped[0].reason).toContain('--lens-draft');
    const allowed = routeLenses(SPECS, { mode: 'explicit', requested: ['enterprise-buyer'], allow_draft: true, changed_paths: [] });
    expect(allowed.selected[0].lens).toBe('enterprise-readiness');
  });

  test('project mandatory policy runs on plain review and bypass requires rationale', () => {
    const policy = {
      mandatory_lenses: [{ name: 'admin-export', surface_globs: ['ops/prod/admin_dump.rb'], lenses: ['insider-abuse'] }],
    };
    const result = routeLenses(SPECS, { mode: 'mandatory', changed_paths: ['ops/prod/admin_dump.rb'], policy });
    expect(result.selected[0].mandatory).toBe(true);
    expect(() => routeLenses(SPECS, { mode: 'mandatory', changed_paths: ['ops/prod/admin_dump.rb'], policy, no_mandatory: true })).toThrow(/non-empty rationale/);
    const bypassed = routeLenses(SPECS, {
      mode: 'mandatory',
      changed_paths: ['ops/prod/admin_dump.rb'],
      policy,
      no_mandatory: true,
      no_mandatory_reason: 'Emergency rollback review',
    });
    expect(bypassed.selected).toHaveLength(0);
    expect(bypassed.mandatory_bypassed).toBe(true);
  });
});

function finding(overrides: Partial<LensFindingInput> = {}): LensFindingInput {
  return {
    lens: 'insider-abuse',
    severity: 'AUDIT_GAP',
    claim_key: 'administrative-export-audit-missing',
    control_or_asset: 'administrative-export-audit',
    remediation_key: 'emit-structured-export-audit-event',
    remediation_effect: 'ADD',
    evidence: {
      kind: 'file_line',
      path: 'src/admin/export.ts',
      line: 42,
      description: 'Administrative export has no durable audit event',
    },
    stakeholder_frame: 'Administrative export has no durable audit event',
    recommended_action: 'Emit a durable audit event with actor, reason, and object scope',
    classification: 'INVESTIGATE',
    decision_impact: 'MATERIAL',
    evidence_strength: 'STRONG',
    inference_status: 'DIRECTLY_SUPPORTED',
    urgency: 'PRE_SHIP',
    confidence_evidence_exists: 'HIGH',
    confidence_interpretation_correct: 'HIGH',
    confidence_consequence_material: 'HIGH',
    ...overrides,
  };
}

describe('lens parsing, reconciliation, and synthesis', () => {
  test('parser preserves findings and stable IDs are deterministic', () => {
    const spec = resolveLensName(SPECS, 'insider-abuse')!;
    const parsed = parseLensOutput(JSON.stringify(finding()), spec);
    expect(parsed.result?.status).toBe('FINDINGS');
    const parsedFinding = parsed.result?.status === 'FINDINGS' ? parsed.result.findings[0] : null;
    expect(parsedFinding).not.toBeNull();
    expect(stableFindingId(parsedFinding!)).toBe(stableFindingId(parsedFinding!));
  });

  test('insufficient evidence remains distinct from no findings', () => {
    const spec = resolveLensName(SPECS, 'enterprise-readiness')!;
    const parsed = parseLensOutput(JSON.stringify({
      lens: 'enterprise-readiness',
      status: 'INSUFFICIENT_EVIDENCE',
      missing_required: ['deployment_model'],
      why_insufficient: 'Deployment boundaries cannot be assessed without the deployment model.',
      what_would_make_actionable: 'Provide the deployment model and tenant boundary artifact.',
    }), spec);
    expect(parsed.result?.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  test('same evidence is clustered while interpretations remain separate', () => {
    const result = reconcileLensResults(ROOT, {
      lens_results: [
        { lens: 'insider-abuse', status: 'FINDINGS', findings: [finding()] },
        { lens: 'enterprise-readiness', status: 'FINDINGS', findings: [finding({
          lens: 'enterprise-readiness',
          severity: 'OPERABILITY_GAP',
          claim_key: 'enterprise-export-visibility-missing',
          stakeholder_frame: 'Enterprise administrators cannot prove who exported customer data',
        })] },
      ],
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].tags).toContain('MULTI_LENS');
    expect(result.clusters[0].tags.join(' ')).not.toContain('CONFIRMED');
    expect(result.findings.every((item) => item.evidence_cluster_id === result.clusters[0].id)).toBe(true);
    expect(result.synthesis.required).toBe(true);
  });

  test('production novelty is not claimed from an exact-match miss', () => {
    const result = reconcileLensResults(ROOT, {
      lens_results: [{ lens: 'insider-abuse', status: 'FINDINGS', findings: [finding()] }],
      tech_findings: [],
    });
    expect(result.findings[0].novelty_vs_tech_review).toBe('NOT_MEASURED');
  });

  test('evaluation novelty and structured overlap are deterministic', () => {
    const novel = reconcileLensResults(ROOT, {
      novelty_mode: 'evaluation',
      lens_results: [{ lens: 'insider-abuse', status: 'FINDINGS', findings: [finding()] }],
      tech_findings: [],
    });
    expect(novel.findings[0].novelty_vs_tech_review).toBe('NOVEL');

    const overlap = reconcileLensResults(ROOT, {
      novelty_mode: 'evaluation',
      lens_results: [{ lens: 'insider-abuse', status: 'FINDINGS', findings: [finding()] }],
      tech_findings: [{ claim_key: 'administrative-export-audit-missing' }],
    });
    expect(overlap.findings[0].novelty_vs_tech_review).toBe('OVERLAPS_BASELINE');
  });

  test('evidence overlap without structured baseline semantics stays ambiguous', () => {
    const result = reconcileLensResults(ROOT, {
      novelty_mode: 'evaluation',
      lens_results: [{ lens: 'insider-abuse', status: 'FINDINGS', findings: [finding()] }],
      tech_findings: [{ path: 'src/admin/export.ts', line: 42, summary: 'Missing audit event' }],
    });
    expect(result.findings[0].novelty_vs_tech_review).toBe('AMBIGUOUS');
  });

  test('CTO synthesis cannot reference findings that do not exist', () => {
    const result = reconcileLensResults(ROOT, {
      lens_results: [{ lens: 'insider-abuse', status: 'FINDINGS', findings: [finding()] }],
    });
    const input = { findings: result.findings, clusters: result.clusters };
    expect(() => validateCtoSynthesis({
      shared_primitives: [{ primitive: 'audit primitive', rationale: 'shared control', finding_ids: ['missing-id', 'other-id'] }],
      reinforcing_constraints: [],
      tensions: [],
      sequencing: [],
      decisions_required: [],
    }, input)).toThrow(/unknown finding IDs/);
  });
});
