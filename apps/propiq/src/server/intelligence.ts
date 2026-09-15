/**
 * The Property Intelligence use case.
 *
 * This is the single place where repository data meets the domain engines. It
 * exists so the Property Intelligence Page, the Decision Room and the search
 * results all produce the *same* verdict for the same property — a score that
 * differs between two screens is worse than no score.
 *
 * Order matters: valuation feeds risk (valuation risk), and both feed scoring,
 * which feeds the decision. Nothing here is concurrent-order dependent beyond
 * that chain.
 */

import 'server-only';
import type { PropertyId } from '@/domain/shared/types';
import type { Developer, Project, Property } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';
import type { BuyerProfile } from '@/domain/buyer/types';
import type { BuyerPersona } from '@/domain/buyer/types';
import { summarizeFreshness } from '@/domain/evidence/freshness';
import type { FreshnessSummary } from '@/domain/evidence/freshness';
import { priceCagrPercent } from '@/domain/locality/types';
import { negotiationGuidance, valueProperty } from '@/domain/valuation/engine';
import type { NegotiationGuidance, Valuation } from '@/domain/valuation/types';
import { assessRisk } from '@/domain/risk/engine';
import type { RiskAssessment } from '@/domain/risk/types';
import { DEFAULT_ASSUMPTIONS, analyzeWithScenarios } from '@/domain/investment/calculator';
import type { InvestmentAnalysis } from '@/domain/investment/types';
import { computePropIQScore } from '@/domain/scoring/engine';
import type { PropIQScore } from '@/domain/scoring/types';
import { decide } from '@/domain/decision/engine';
import type { DecisionResult } from '@/domain/decision/engine';
import { getPropertyRepository } from '@/data';
import type { Evidence } from '@/domain/evidence/types';

export interface PropertyIntelligence {
  readonly property: Property;
  readonly project?: Project;
  readonly developer?: Developer;
  readonly locality?: Locality;
  readonly valuation: Valuation;
  readonly negotiation?: NegotiationGuidance;
  readonly risk: RiskAssessment;
  readonly investment: InvestmentAnalysis;
  readonly score: PropIQScore;
  readonly decision: DecisionResult;
  readonly freshness: FreshnessSummary;
  readonly alternatives: readonly Property[];
  /** Count of first-party site-visit records folded into this payload. */
  readonly visitEvidenceCount: number;
  /** True when any input to this payload was demo data. */
  readonly usesDemoData: boolean;
  readonly computedAt: string;
}

export interface IntelligenceOptions {
  readonly persona?: BuyerPersona;
  readonly buyer?: BuyerProfile;
  /** Injected clock. Defaults to now; tests and replays pass a fixed instant. */
  readonly now?: string;
  readonly includeAlternatives?: boolean;
  /**
   * First-party evidence from the buyer's own site visit.
   *
   * Merged into the property's evidence before scoring, which is what closes
   * the loop: a buyer who stands in a flat and sees a silt line on the
   * compound wall knows something the model does not, and that observation
   * should move the score rather than sit in a notes field.
   */
  readonly visitEvidence?: readonly Evidence[];
}

/**
 * Market drift used to carry comparables forward.
 * Derived from the locality's own price history when we have enough of it;
 * otherwise we fall back to a conservative national-ish figure and say so.
 */
export const marketDriftFor = (
  locality: Locality | undefined,
): { rate: number; derived: boolean } => {
  const cagr = locality ? priceCagrPercent(locality.priceHistory) : undefined;
  if (cagr === undefined || !Number.isFinite(cagr)) return { rate: 5, derived: false };
  // Clamp so one anomalous history cannot produce an absurd carry-forward.
  return { rate: Math.max(-10, Math.min(20, Number(cagr.toFixed(2)))), derived: true };
};

export const buildPropertyIntelligence = async (
  id: PropertyId,
  options: IntelligenceOptions = {},
): Promise<PropertyIntelligence | undefined> => {
  const repo = getPropertyRepository();
  const now = options.now ?? new Date().toISOString();

  const base = await repo.getById(id);
  if (!base) return undefined;

  // Visit evidence is appended, never substituted: it adds what the buyer saw
  // to what we already hold rather than replacing it.
  const property =
    options.visitEvidence && options.visitEvidence.length > 0
      ? { ...base, evidence: [...base.evidence, ...options.visitEvidence] }
      : base;

  const [project, locality, comparables] = await Promise.all([
    repo.getProject(property.projectId),
    repo.getLocality(property.localityId),
    repo.getComparables(property.id),
  ]);
  const developer = project ? await repo.getDeveloper(project.developerId) : undefined;

  const drift = marketDriftFor(locality);
  const valuation = valueProperty({
    property,
    comparables,
    marketDriftPercentPerYear: drift.rate,
    now,
  });

  const risk = assessRisk({ property, project, developer, locality, valuation, now });

  const investment = analyzeWithScenarios(
    {
      ...DEFAULT_ASSUMPTIONS,
      purchasePrice: property.askingPrice,
      monthlyRent: property.expectedRentPerMonth ?? 0,
      monthlyMaintenance: Math.round((property.maintenancePerSqFtMonth ?? 0) * property.areaSqFt),
      appreciationPercent: drift.derived ? drift.rate : DEFAULT_ASSUMPTIONS.appreciationPercent,
    },
    // Input confidence, not arithmetic confidence: rent is the weakest input.
    property.expectedRentPerMonth ? 0.6 : 0.2,
    [
      property.expectedRentPerMonth
        ? 'Rent is an estimate for this unit type, not a signed lease.'
        : 'No rent estimate is available for this unit, so yield and IRR are not meaningful.',
      drift.derived
        ? `Appreciation defaults to this locality's own ${drift.rate}% price CAGR.`
        : 'Appreciation uses a default assumption because this locality has too little price history.',
    ],
  );

  const score = computePropIQScore(
    {
      property,
      project,
      developer,
      locality,
      valuation: valuation.insufficientEvidence ? undefined : valuation,
      investment: investment.base,
      risk,
      buyer: options.buyer,
      now,
    },
    { persona: options.persona ?? options.buyer?.persona ?? 'homebuyer' },
  );

  const decision = decide({
    score,
    risk,
    valuation: valuation.insufficientEvidence ? undefined : valuation,
    now,
  });

  const alternatives =
    options.includeAlternatives === false ? [] : await repo.getAlternatives(property.id, 3);

  const leverPoints: string[] = [];
  for (const material of risk.materialRisks) {
    // Drivers are written as complete sentences, so trim any trailing stop
    // before adding our own rather than emitting "... period..".
    const driver = (material.drivers[0] ?? 'material risk on record').replace(/\.\s*$/, '');
    leverPoints.push(`${material.label}: ${driver}.`);
  }

  return {
    property,
    project,
    developer,
    locality,
    valuation,
    negotiation: negotiationGuidance(valuation, leverPoints),
    risk,
    investment,
    score,
    decision,
    freshness: summarizeFreshness([...property.evidence, ...(locality?.evidence ?? [])], now),
    alternatives,
    visitEvidenceCount: options.visitEvidence?.length ?? 0,
    usesDemoData:
      repo.servesDemoData ||
      property.dataStatus === 'demo' ||
      locality?.dataStatus === 'demo' ||
      score.usesDemoData,
    computedAt: now,
  };
};

/**
 * Lightweight scoring for search results and comparison columns.
 * Skips alternatives and negotiation, which are only needed on a detail page.
 */
export const buildSummaries = async (
  properties: readonly Property[],
  options: IntelligenceOptions = {},
): Promise<readonly PropertyIntelligence[]> => {
  const results = await Promise.all(
    properties.map((p) =>
      buildPropertyIntelligence(p.id, { ...options, includeAlternatives: false }),
    ),
  );
  return results.filter((r): r is PropertyIntelligence => r !== undefined);
};
