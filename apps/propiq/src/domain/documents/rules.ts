/**
 * Deterministic document checks.
 *
 * Each rule is a small, named function over the extracted fields. They encode
 * the things that actually go wrong in Indian residential conveyancing, which
 * is why the list is specific rather than generic:
 *
 *  - A B-khata property in Bengaluru is not loan-eligible at most banks and
 *    cannot get a building plan sanction. Buyers discover this at the bank.
 *  - An encumbrance certificate covering five years proves nothing about a
 *    charge created six years ago. Thirteen years is the usual minimum and
 *    thirty is what a careful buyer asks for.
 *  - A sale deed needs two witnesses under the Registration Act. One is a
 *    defect on the face of the document.
 *  - RERA mandates carpet-area disclosure. A cost sheet quoting only super
 *    built-up area is both a compliance problem and the usual place a bad
 *    loading ratio hides.
 *
 * Every rule returns a finding phrased as an observation and a question to
 * ask, never as a conclusion about title.
 */

import type { Instant, Unit01 } from '../shared/types';
import { daysBetween } from '../evidence/freshness';
import type {
  DocumentAnalysis,
  DocumentFinding,
  DocumentKind,
  ExtractedDocument,
  FindingSeverity,
} from './types';

export const DOCUMENT_RULES_VERSION = '0.1.0';

/** Years of encumbrance history below which the certificate proves little. */
export const MIN_EC_YEARS = 13;
/** Carpet-to-super-built-up ratio below which loading is unusually aggressive. */
export const MIN_CARPET_RATIO = 0.6;
/** Witnesses required on a registered sale deed. */
export const REQUIRED_WITNESSES = 2;

interface Rule {
  readonly id: string;
  readonly kinds: readonly DocumentKind[];
  readonly title: string;
  /** Fields the rule needs. Absent fields mean the rule is skipped, not passed. */
  readonly requires: ReadonlyArray<keyof ExtractedDocument>;
  readonly evaluate: (
    doc: ExtractedDocument,
    now: Instant,
  ) => Omit<DocumentFinding, 'ruleId' | 'kind' | 'title'> | undefined;
}

const finding = (
  severity: FindingSeverity,
  observation: string,
  askAbout: string,
  confidence: Unit01 = 0.9,
  needsHumanReview = true,
) => ({ severity, observation, askAbout, confidence, needsHumanReview });

const yearsBetween = (from: string, to: string): number => daysBetween(from, to) / 365.25;

export const RULES: readonly Rule[] = [
  // --- Sale deed -----------------------------------------------------------
  {
    id: 'deed.parties',
    kinds: ['saleDeed', 'agreementToSell'],
    title: 'Both parties named',
    requires: ['parties'],
    evaluate: (doc) => {
      const roles = new Set((doc.parties ?? []).map((p) => p.role));
      const missing = (['seller', 'buyer'] as const).filter((r) => !roles.has(r));
      if (missing.length === 0) return undefined;
      return finding(
        'serious',
        `The document does not name a ${missing.join(' or a ')}.`,
        `Ask why the ${missing.join(' and ')} are not named. A conveyance that does not identify both sides is not executable.`,
      );
    },
  },
  {
    id: 'deed.witnesses',
    kinds: ['saleDeed'],
    title: 'Two witnesses present',
    requires: ['witnessCount'],
    evaluate: (doc) => {
      if ((doc.witnessCount ?? 0) >= REQUIRED_WITNESSES) return undefined;
      return finding(
        'serious',
        `Only ${doc.witnessCount} witness(es) are recorded. A registered sale deed needs ${REQUIRED_WITNESSES}.`,
        'Ask the sub-registrar or your lawyer whether this deed was validly attested. This is a defect on the face of the document.',
      );
    },
  },
  {
    id: 'deed.surveyNumber',
    kinds: ['saleDeed', 'agreementToSell', 'khata'],
    title: 'Property identified by survey number',
    requires: ['surveyNumber'],
    evaluate: (doc) => {
      if (doc.surveyNumber && doc.surveyNumber.trim().length > 0) return undefined;
      return finding(
        'serious',
        'No survey number identifies the property.',
        'Ask for the survey number. Without it the document cannot be tied to a specific piece of land.',
      );
    },
  },
  {
    id: 'deed.registration',
    kinds: ['saleDeed'],
    title: 'Registered with a sub-registrar',
    requires: ['registrationNumber'],
    evaluate: (doc) => {
      if (doc.registrationNumber && doc.registrationNumber.trim().length > 0) return undefined;
      return finding(
        'serious',
        'No registration number appears on this deed.',
        'Ask whether the deed was registered. An unregistered sale deed does not transfer title in India.',
      );
    },
  },
  {
    id: 'deed.stampDuty',
    kinds: ['saleDeed'],
    title: 'Stamp duty recorded',
    requires: ['stampDutyPaid', 'considerationAmount'],
    evaluate: (doc) => {
      const duty = doc.stampDutyPaid;
      const consideration = doc.considerationAmount;
      if (duty === undefined || consideration === undefined || consideration <= 0) return undefined;
      const ratio = duty / consideration;
      // Karnataka runs ~5-7% all-in. Materially under that suggests the deed
      // was stamped on a declared value below what was actually paid.
      if (ratio >= 0.04) return undefined;
      return finding(
        'attention',
        `Stamp duty is ${(ratio * 100).toFixed(2)}% of the stated consideration, below the usual band for a residential sale.`,
        'Ask whether the deed was stamped on the guidance value rather than the price paid, and what that means for your own resale.',
        0.7,
      );
    },
  },

  // --- Encumbrance certificate --------------------------------------------
  {
    id: 'ec.periodLength',
    kinds: ['encumbranceCertificate'],
    title: 'Covers a long enough period',
    requires: ['ecPeriodFrom', 'ecPeriodTo'],
    evaluate: (doc) => {
      const from = doc.ecPeriodFrom;
      const to = doc.ecPeriodTo;
      if (!from || !to) return undefined;
      const years = yearsBetween(from, to);
      if (years >= MIN_EC_YEARS) return undefined;
      return finding(
        'serious',
        `The certificate covers about ${years.toFixed(1)} years. A charge created before ${from} would not appear on it.`,
        `Ask for an encumbrance certificate covering at least ${MIN_EC_YEARS} years, and ideally 30.`,
      );
    },
  },
  {
    id: 'ec.recency',
    kinds: ['encumbranceCertificate'],
    title: 'Recent enough to be current',
    requires: ['ecPeriodTo'],
    evaluate: (doc, now) => {
      const to = doc.ecPeriodTo;
      if (!to) return undefined;
      const monthsOld = daysBetween(to, now) / 30.44;
      if (monthsOld <= 3) return undefined;
      return finding(
        'attention',
        `The certificate stops ${Math.round(monthsOld)} months ago. Anything registered since then is not on it.`,
        'Ask for a fresh encumbrance certificate dated within the last month before you pay.',
        0.85,
      );
    },
  },
  {
    id: 'ec.outstandingCharges',
    kinds: ['encumbranceCertificate'],
    title: 'No outstanding charges',
    requires: ['encumbranceEntries'],
    evaluate: (doc) => {
      const outstanding = (doc.encumbranceEntries ?? []).filter((e) => e.outstanding);
      if (outstanding.length === 0) return undefined;
      return finding(
        'serious',
        `${outstanding.length} charge(s) on this property appear to still be outstanding: ${outstanding
          .map((e) => `${e.nature} (${e.date})`)
          .join(', ')}.`,
        'Ask for the discharge or release deed for each one, and make its production a condition of payment.',
      );
    },
  },

  // --- Khata ---------------------------------------------------------------
  {
    id: 'khata.type',
    kinds: ['khata'],
    title: 'A-khata, not B-khata',
    requires: ['khataType'],
    evaluate: (doc) => {
      if (doc.khataType === 'A' || doc.khataType === 'eKhata') return undefined;
      if (doc.khataType === 'B') {
        return finding(
          'serious',
          'This is a B-khata property.',
          'Ask whether it can be converted to A-khata, what that costs and how long it takes. Most banks will not lend against a B-khata, and it cannot get a building plan sanction — which also narrows who you can resell to.',
        );
      }
      return finding(
        'attention',
        'The khata type could not be determined from what was provided.',
        'Ask explicitly whether this is an A-khata or a B-khata. The difference decides loan eligibility.',
        0.8,
      );
    },
  },
  {
    id: 'khata.taxCurrent',
    kinds: ['khata'],
    title: 'Property tax paid up to date',
    requires: ['propertyTaxPaidUpto'],
    evaluate: (doc, now) => {
      const paidUpto = doc.propertyTaxPaidUpto;
      if (!paidUpto) return undefined;
      const monthsBehind = daysBetween(paidUpto, now) / 30.44;
      if (monthsBehind <= 14) return undefined;
      return finding(
        'attention',
        `Property tax appears paid only up to ${paidUpto}, about ${Math.round(monthsBehind / 12)} year(s) ago.`,
        'Ask for current paid receipts. Arrears attach to the property and become yours on transfer.',
        0.85,
      );
    },
  },

  // --- Agreement to sell ---------------------------------------------------
  {
    id: 'agreement.possessionDate',
    kinds: ['agreementToSell'],
    title: 'Possession date committed',
    requires: ['possessionDate'],
    evaluate: (doc) => {
      if (doc.possessionDate) return undefined;
      return finding(
        'serious',
        'The agreement does not commit to a possession date.',
        'Ask for a dated possession commitment in the agreement itself. Without one there is nothing to enforce a delay against.',
      );
    },
  },
  {
    id: 'agreement.delayPenalty',
    kinds: ['agreementToSell'],
    title: 'Delay penalty clause present',
    requires: ['delayPenaltyClause'],
    evaluate: (doc) => {
      if (doc.delayPenaltyClause) return undefined;
      return finding(
        'serious',
        'No penalty applies to the builder if possession is late.',
        'Ask for a delay-penalty clause. Note whether the forfeiture terms against you are symmetrical — commonly they are not.',
      );
    },
  },
  {
    id: 'agreement.asymmetricTerms',
    kinds: ['agreementToSell'],
    title: 'Termination terms are balanced',
    requires: ['forfeitureClause', 'delayPenaltyClause'],
    evaluate: (doc) => {
      if (!doc.forfeitureClause) return undefined;
      if (doc.delayPenaltyClause) return undefined;
      return finding(
        'serious',
        'The agreement can forfeit your money if you withdraw, but carries no penalty against the builder for delay.',
        'Ask for symmetry: if your deposit is forfeitable, late delivery should cost the builder something.',
      );
    },
  },
  {
    id: 'agreement.advanceShare',
    kinds: ['agreementToSell'],
    title: 'Advance is a reasonable share of the price',
    requires: ['advancePaid', 'considerationAmount'],
    evaluate: (doc) => {
      const advance = doc.advancePaid;
      const total = doc.considerationAmount;
      if (advance === undefined || total === undefined || total <= 0) return undefined;
      const share = advance / total;
      // RERA caps pre-agreement collection at 10% of cost.
      if (share <= 0.1) return undefined;
      return finding(
        'attention',
        `The advance is ${(share * 100).toFixed(1)}% of the total price.`,
        'Ask why more than 10% is being collected before registration. RERA caps pre-agreement collection at 10% of cost.',
        0.85,
      );
    },
  },

  // --- RERA ---------------------------------------------------------------
  {
    id: 'rera.validity',
    kinds: ['reraCertificate'],
    title: 'Registration still valid',
    requires: ['reraValidUntil'],
    evaluate: (doc, now) => {
      const validUntil = doc.reraValidUntil;
      if (!validUntil) return undefined;
      if (daysBetween(now, validUntil) > 0) return undefined;
      return finding(
        'serious',
        `The RERA registration expired on ${validUntil}.`,
        'Ask for the extension order. Marketing or selling an unregistered project is an offence under RERA.',
      );
    },
  },
  {
    id: 'rera.coversPossession',
    kinds: ['reraCertificate'],
    title: 'Registration outlasts the possession commitment',
    requires: ['reraValidUntil', 'possessionDate'],
    evaluate: (doc) => {
      const validUntil = doc.reraValidUntil;
      const possession = doc.possessionDate;
      if (!validUntil || !possession) return undefined;
      if (daysBetween(possession, validUntil) >= 0) return undefined;
      return finding(
        'attention',
        `The registration expires on ${validUntil}, before the committed possession date of ${possession}.`,
        'Ask how the project will stay registered through to handover.',
        0.9,
      );
    },
  },

  // --- Cost sheet ----------------------------------------------------------
  {
    id: 'costSheet.carpetAreaDisclosed',
    kinds: ['costSheet'],
    title: 'Carpet area disclosed',
    requires: ['carpetAreaSqFt'],
    evaluate: (doc) => {
      if (doc.carpetAreaSqFt && doc.carpetAreaSqFt > 0) return undefined;
      return finding(
        'serious',
        'The cost sheet does not state a carpet area.',
        'Ask for the carpet area in writing. RERA requires it, and a price quoted only on super built-up area hides how much floor you are actually buying.',
      );
    },
  },
  {
    id: 'costSheet.loadingRatio',
    kinds: ['costSheet'],
    title: 'Loading is within normal range',
    requires: ['carpetAreaSqFt', 'superBuiltUpAreaSqFt'],
    evaluate: (doc) => {
      const carpet = doc.carpetAreaSqFt;
      const sba = doc.superBuiltUpAreaSqFt;
      if (!carpet || !sba || sba <= 0) return undefined;
      const ratio = carpet / sba;
      if (ratio >= MIN_CARPET_RATIO) return undefined;
      return finding(
        'attention',
        `Carpet area is ${(ratio * 100).toFixed(1)}% of the quoted area, so loading is about ${((1 - ratio) * 100).toFixed(1)}%.`,
        `Ask what the loading covers. Below ${(MIN_CARPET_RATIO * 100).toFixed(0)}% carpet you are paying for a lot of space you cannot stand in.`,
        0.9,
      );
    },
  },
  {
    id: 'costSheet.chargesItemised',
    kinds: ['costSheet'],
    title: 'Charges are itemised',
    requires: ['itemisedCharges', 'basePrice', 'considerationAmount'],
    evaluate: (doc) => {
      const charges = doc.itemisedCharges;
      const base = doc.basePrice;
      const total = doc.considerationAmount;
      if (!charges || base === undefined || total === undefined) return undefined;
      const itemised = Object.values(charges).reduce((a, b) => a + b, 0);
      const unexplained = total - base - itemised - (doc.gstAmount ?? 0);
      if (unexplained <= total * 0.01) return undefined;
      return finding(
        'attention',
        `About ₹${Math.round(unexplained).toLocaleString('en-IN')} of the total is not explained by the base price, the itemised charges or GST.`,
        'Ask for a line-by-line breakdown of the balance before you sign anything.',
        0.8,
      );
    },
  },
];

/**
 * Whether the extraction recorded this field at all.
 *
 * Presence, not truthiness. An empty string or an empty array means the
 * extractor looked and found nothing there, which is a finding; `undefined`
 * means it never looked, which is a skip. Treating those two the same would
 * silently downgrade "this deed has no registration number" into "we did not
 * check whether it was registered".
 */
const hasField = (doc: ExtractedDocument, field: keyof ExtractedDocument): boolean =>
  doc[field] !== undefined && doc[field] !== null;

export const analyseDocument = (doc: ExtractedDocument, now: Instant): DocumentAnalysis => {
  const applicable = RULES.filter((r) => r.kinds.includes(doc.kind));
  const findings: DocumentFinding[] = [];
  const passed: string[] = [];
  const skipped: string[] = [];

  for (const rule of applicable) {
    // A rule whose inputs are missing is skipped, never silently passed. The
    // distinction matters: "we checked and it is fine" and "we could not
    // check" are different things to tell someone about their title.
    if (!rule.requires.every((f) => hasField(doc, f))) {
      skipped.push(rule.title);
      continue;
    }

    const result = rule.evaluate(doc, now);
    if (result) {
      findings.push({ ...result, ruleId: rule.id, kind: doc.kind, title: rule.title });
    } else {
      passed.push(rule.title);
    }
  }

  const order: Readonly<Record<FindingSeverity, number>> = {
    serious: 0,
    attention: 1,
    info: 2,
  };

  return {
    kind: doc.kind,
    analysedAt: now,
    rulesVersion: DOCUMENT_RULES_VERSION,
    extractionMethod: doc.extractionMethod,
    extractionConfidence: doc.extractionConfidence,
    findings: findings.sort((a, b) => order[a.severity] - order[b.severity]),
    passed,
    skipped,
    seriousCount: findings.filter((f) => f.severity === 'serious').length,
    requiresLegalReview: true,
  };
};

/** Rules that apply to a document kind, for the UI to show what will be checked. */
export const rulesFor = (kind: DocumentKind): ReadonlyArray<{ id: string; title: string }> =>
  RULES.filter((r) => r.kinds.includes(kind)).map((r) => ({ id: r.id, title: r.title }));
