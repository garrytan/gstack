/**
 * Document intelligence.
 *
 * The valuable half of document analysis is not the OCR — it is knowing what
 * to look for in an Indian property document and what its absence means. That
 * half is deterministic, so it lives here as rules over a structured
 * `ExtractedDocument`, independent of how those fields were obtained.
 *
 * Extraction can come from an OCR provider or from a buyer typing what their
 * document says. The checks are identical either way, which is what lets the
 * feature be useful before any provider is wired.
 *
 * Nothing here is a legal opinion. A finding says "this looks wrong, ask
 * about it", never "your title is clear".
 */

import type { INR, Instant, Unit01 } from '../shared/types';

export const DOCUMENT_KINDS = [
  'saleDeed',
  'encumbranceCertificate',
  'khata',
  'agreementToSell',
  'reraCertificate',
  'sanctionedPlan',
  'loanSanction',
  'costSheet',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_LABELS: Readonly<Record<DocumentKind, string>> = {
  saleDeed: 'Sale deed',
  encumbranceCertificate: 'Encumbrance certificate',
  khata: 'Khata',
  agreementToSell: 'Agreement to sell',
  reraCertificate: 'RERA registration',
  sanctionedPlan: 'Sanctioned plan',
  loanSanction: 'Loan sanction letter',
  costSheet: 'Cost sheet',
};

/** Karnataka's A/B khata split decides loan eligibility, so it is modelled. */
export const KHATA_TYPES = ['A', 'B', 'eKhata', 'unknown'] as const;
export type KhataType = (typeof KHATA_TYPES)[number];

export interface ExtractedParty {
  readonly role: 'seller' | 'buyer' | 'witness' | 'guarantor' | 'other';
  readonly name: string;
}

export interface EncumbranceEntry {
  readonly date: string; // YYYY-MM-DD
  readonly nature: string;
  readonly amount?: INR;
  /** True when the entry is a charge that is still outstanding. */
  readonly outstanding: boolean;
}

/**
 * The structured shape a document reduces to.
 *
 * Every field is optional. A missing field is a finding in its own right for
 * several document kinds, so `undefined` has to survive all the way to the
 * rule engine rather than being defaulted anywhere on the way in.
 */
export interface ExtractedDocument {
  readonly kind: DocumentKind;
  readonly extractedAt: Instant;
  /** How the fields were obtained. Shown to the user; never inferred. */
  readonly extractionMethod: 'provider' | 'manual';
  /** Provider confidence in the extraction itself, 0..1. Manual entry is 1. */
  readonly extractionConfidence: Unit01;

  readonly parties?: readonly ExtractedParty[];
  readonly surveyNumber?: string;
  readonly propertyAddress?: string;
  readonly considerationAmount?: INR;
  readonly advancePaid?: INR;
  readonly executionDate?: string;
  readonly registrationNumber?: string;
  readonly registrationDate?: string;
  readonly subRegistrarOffice?: string;
  readonly stampDutyPaid?: INR;
  readonly witnessCount?: number;

  // Encumbrance certificate
  readonly ecPeriodFrom?: string;
  readonly ecPeriodTo?: string;
  readonly encumbranceEntries?: readonly EncumbranceEntry[];

  // Khata
  readonly khataType?: KhataType;
  readonly khataNumber?: string;
  readonly propertyTaxPaidUpto?: string;

  // Agreement to sell
  readonly possessionDate?: string;
  readonly delayPenaltyClause?: boolean;
  readonly terminationClause?: boolean;
  readonly forfeitureClause?: boolean;

  // RERA
  readonly reraNumber?: string;
  readonly reraValidUntil?: string;

  // Cost sheet
  readonly carpetAreaSqFt?: number;
  readonly superBuiltUpAreaSqFt?: number;
  readonly basePrice?: INR;
  readonly itemisedCharges?: Readonly<Record<string, INR>>;
  readonly gstAmount?: INR;

  /** Free text the user or provider supplied. Untrusted; never parsed for rules. */
  readonly notes?: string;
}

export type FindingSeverity = 'info' | 'attention' | 'serious';

export interface DocumentFinding {
  readonly ruleId: string;
  readonly kind: DocumentKind;
  readonly severity: FindingSeverity;
  readonly title: string;
  /** What we observed, stated as an observation rather than a conclusion. */
  readonly observation: string;
  /** The question to put to the seller, builder or your lawyer. */
  readonly askAbout: string;
  /** Confidence in the finding, distinct from confidence in the extraction. */
  readonly confidence: Unit01;
  readonly needsHumanReview: boolean;
}

export interface DocumentAnalysis {
  readonly kind: DocumentKind;
  readonly analysedAt: Instant;
  readonly rulesVersion: string;
  readonly extractionMethod: ExtractedDocument['extractionMethod'];
  readonly extractionConfidence: Unit01;
  readonly findings: readonly DocumentFinding[];
  /** Checks that ran and found nothing wrong — evidence of what was looked at. */
  readonly passed: readonly string[];
  /** Checks skipped because the field they need was not present. */
  readonly skipped: readonly string[];
  readonly seriousCount: number;
  /** Always true. Retained so no caller can render this as a clearance. */
  readonly requiresLegalReview: true;
}

export const DOCUMENT_DISCLAIMER =
  'This is an automated check against common problems, not a title opinion and not legal ' +
  'advice. It can only see the fields it was given, it cannot verify that the document is ' +
  'genuine, and a clean result here is not a clear title. Have a property lawyer read the ' +
  'originals before you pay anything.';
