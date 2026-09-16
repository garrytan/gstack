import { describe, expect, it } from 'vitest';
import {
  MIN_CARPET_RATIO,
  MIN_EC_YEARS,
  REQUIRED_WITNESSES,
  analyseDocument,
  rulesFor,
} from '@/domain/documents/rules';
import { DOCUMENT_KINDS, DOCUMENT_DISCLAIMER } from '@/domain/documents/types';
import type { ExtractedDocument } from '@/domain/documents/types';
import { MAX_DOCUMENT_BYTES, documentStoragePath, validateUpload } from '@/ai/document-extractor';
import { NOW } from './support/factories';

const doc = (
  overrides: Partial<ExtractedDocument> & Pick<ExtractedDocument, 'kind'>,
): ExtractedDocument => ({
  extractedAt: NOW,
  extractionMethod: 'manual',
  extractionConfidence: 1,
  ...overrides,
});

const findingIds = (d: ExtractedDocument) => analyseDocument(d, NOW).findings.map((f) => f.ruleId);

describe('rule coverage', () => {
  it('has at least one rule for every document kind it claims to check', () => {
    const covered = DOCUMENT_KINDS.filter((k) => rulesFor(k).length > 0);
    expect(covered.length).toBeGreaterThanOrEqual(6);
  });

  it('never returns a clearance — legal review is always required', () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(analyseDocument(doc({ kind }), NOW).requiresLegalReview).toBe(true);
    }
  });

  it('states plainly that it is not a title opinion', () => {
    expect(DOCUMENT_DISCLAIMER).toContain('not a title opinion');
    expect(DOCUMENT_DISCLAIMER).toContain('not legal advice');
  });
});

describe('missing fields are skipped, not passed', () => {
  it('skips every rule when nothing was extracted', () => {
    const analysis = analyseDocument(doc({ kind: 'saleDeed' }), NOW);
    expect(analysis.findings).toHaveLength(0);
    expect(analysis.passed).toHaveLength(0);
    expect(analysis.skipped.length).toBeGreaterThan(0);
  });

  it('separates what was checked from what could not be', () => {
    const analysis = analyseDocument(doc({ kind: 'khata', khataType: 'A' }), NOW);
    expect(analysis.passed).toContain('A-khata, not B-khata');
    expect(analysis.skipped).toContain('Property tax paid up to date');
  });
});

describe('sale deed', () => {
  it('flags a deed that names no buyer', () => {
    expect(
      findingIds(doc({ kind: 'saleDeed', parties: [{ role: 'seller', name: 'A' }] })),
    ).toContain('deed.parties');
  });

  it('passes a deed naming both sides', () => {
    expect(
      findingIds(
        doc({
          kind: 'saleDeed',
          parties: [
            { role: 'seller', name: 'A' },
            { role: 'buyer', name: 'B' },
          ],
        }),
      ),
    ).not.toContain('deed.parties');
  });

  it(`flags fewer than ${REQUIRED_WITNESSES} witnesses as serious`, () => {
    const analysis = analyseDocument(doc({ kind: 'saleDeed', witnessCount: 1 }), NOW);
    const f = analysis.findings.find((x) => x.ruleId === 'deed.witnesses');
    expect(f?.severity).toBe('serious');
  });

  it('accepts two witnesses', () => {
    expect(findingIds(doc({ kind: 'saleDeed', witnessCount: 2 }))).not.toContain('deed.witnesses');
  });

  it('flags an unregistered deed as serious', () => {
    const analysis = analyseDocument(doc({ kind: 'saleDeed', registrationNumber: '   ' }), NOW);
    expect(analysis.findings.find((f) => f.ruleId === 'deed.registration')?.severity).toBe(
      'serious',
    );
  });

  it('flags stamp duty well below the residential band', () => {
    expect(
      findingIds(
        doc({ kind: 'saleDeed', considerationAmount: 10_000_000, stampDutyPaid: 200_000 }),
      ),
    ).toContain('deed.stampDuty');
  });

  it('accepts stamp duty inside the band', () => {
    expect(
      findingIds(
        doc({ kind: 'saleDeed', considerationAmount: 10_000_000, stampDutyPaid: 660_000 }),
      ),
    ).not.toContain('deed.stampDuty');
  });
});

describe('encumbrance certificate', () => {
  it(`flags a period shorter than ${MIN_EC_YEARS} years`, () => {
    const analysis = analyseDocument(
      doc({ kind: 'encumbranceCertificate', ecPeriodFrom: '2021-01-01', ecPeriodTo: '2026-05-01' }),
      NOW,
    );
    const f = analysis.findings.find((x) => x.ruleId === 'ec.periodLength');
    expect(f?.severity).toBe('serious');
    expect(f?.observation).toContain('2021-01-01');
  });

  it('accepts a long period', () => {
    expect(
      findingIds(
        doc({
          kind: 'encumbranceCertificate',
          ecPeriodFrom: '2000-01-01',
          ecPeriodTo: '2026-05-01',
        }),
      ),
    ).not.toContain('ec.periodLength');
  });

  it('flags a certificate that stops months ago', () => {
    expect(findingIds(doc({ kind: 'encumbranceCertificate', ecPeriodTo: '2025-06-01' }))).toContain(
      'ec.recency',
    );
  });

  it('flags outstanding charges and names them', () => {
    const analysis = analyseDocument(
      doc({
        kind: 'encumbranceCertificate',
        encumbranceEntries: [
          { date: '2019-04-02', nature: 'Mortgage to a bank', outstanding: true },
          { date: '2015-01-01', nature: 'Released mortgage', outstanding: false },
        ],
      }),
      NOW,
    );
    const f = analysis.findings.find((x) => x.ruleId === 'ec.outstandingCharges');
    expect(f?.severity).toBe('serious');
    expect(f?.observation).toContain('Mortgage to a bank');
    expect(f?.observation).not.toContain('Released mortgage');
  });

  it('passes when every charge is discharged', () => {
    expect(
      findingIds(
        doc({
          kind: 'encumbranceCertificate',
          encumbranceEntries: [{ date: '2015-01-01', nature: 'Released', outstanding: false }],
        }),
      ),
    ).not.toContain('ec.outstandingCharges');
  });
});

describe('khata', () => {
  it('flags a B-khata as serious and explains the consequence', () => {
    const analysis = analyseDocument(doc({ kind: 'khata', khataType: 'B' }), NOW);
    const f = analysis.findings.find((x) => x.ruleId === 'khata.type');
    expect(f?.severity).toBe('serious');
    expect(f?.askAbout).toContain('will not lend');
  });

  it('accepts an A-khata and an e-khata', () => {
    expect(findingIds(doc({ kind: 'khata', khataType: 'A' }))).not.toContain('khata.type');
    expect(findingIds(doc({ kind: 'khata', khataType: 'eKhata' }))).not.toContain('khata.type');
  });

  it('asks the question when the khata type is unknown', () => {
    const analysis = analyseDocument(doc({ kind: 'khata', khataType: 'unknown' }), NOW);
    expect(analysis.findings.find((x) => x.ruleId === 'khata.type')?.severity).toBe('attention');
  });

  it('flags property tax more than a year behind', () => {
    expect(findingIds(doc({ kind: 'khata', propertyTaxPaidUpto: '2024-03-31' }))).toContain(
      'khata.taxCurrent',
    );
  });
});

describe('agreement to sell', () => {
  it('flags a missing possession date', () => {
    expect(findingIds(doc({ kind: 'agreementToSell', possessionDate: '' }))).toContain(
      'agreement.possessionDate',
    );
  });

  it('flags a missing delay penalty', () => {
    expect(findingIds(doc({ kind: 'agreementToSell', delayPenaltyClause: false }))).toContain(
      'agreement.delayPenalty',
    );
  });

  it('flags asymmetric terms where only the buyer is penalised', () => {
    const analysis = analyseDocument(
      doc({ kind: 'agreementToSell', forfeitureClause: true, delayPenaltyClause: false }),
      NOW,
    );
    const f = analysis.findings.find((x) => x.ruleId === 'agreement.asymmetricTerms');
    expect(f?.severity).toBe('serious');
  });

  it('does not flag asymmetry when both sides carry a penalty', () => {
    expect(
      findingIds(
        doc({ kind: 'agreementToSell', forfeitureClause: true, delayPenaltyClause: true }),
      ),
    ).not.toContain('agreement.asymmetricTerms');
  });

  it('flags an advance above the RERA 10% cap', () => {
    expect(
      findingIds(
        doc({ kind: 'agreementToSell', considerationAmount: 10_000_000, advancePaid: 2_500_000 }),
      ),
    ).toContain('agreement.advanceShare');
  });

  it('accepts an advance at the cap', () => {
    expect(
      findingIds(
        doc({ kind: 'agreementToSell', considerationAmount: 10_000_000, advancePaid: 1_000_000 }),
      ),
    ).not.toContain('agreement.advanceShare');
  });
});

describe('RERA certificate', () => {
  it('flags an expired registration', () => {
    const analysis = analyseDocument(
      doc({ kind: 'reraCertificate', reraValidUntil: '2026-01-01' }),
      NOW,
    );
    expect(analysis.findings.find((f) => f.ruleId === 'rera.validity')?.severity).toBe('serious');
  });

  it('flags a registration expiring before possession', () => {
    expect(
      findingIds(
        doc({
          kind: 'reraCertificate',
          reraValidUntil: '2027-01-01',
          possessionDate: '2027-12-01',
        }),
      ),
    ).toContain('rera.coversPossession');
  });

  it('accepts a registration that outlasts possession', () => {
    expect(
      findingIds(
        doc({
          kind: 'reraCertificate',
          reraValidUntil: '2029-01-01',
          possessionDate: '2027-12-01',
        }),
      ),
    ).not.toContain('rera.coversPossession');
  });
});

describe('cost sheet', () => {
  it('flags a cost sheet with no carpet area', () => {
    const analysis = analyseDocument(doc({ kind: 'costSheet', carpetAreaSqFt: 0 }), NOW);
    expect(
      analysis.findings.find((f) => f.ruleId === 'costSheet.carpetAreaDisclosed')?.severity,
    ).toBe('serious');
  });

  it(`flags loading beyond the ${MIN_CARPET_RATIO} carpet ratio`, () => {
    expect(
      findingIds(doc({ kind: 'costSheet', carpetAreaSqFt: 900, superBuiltUpAreaSqFt: 1800 })),
    ).toContain('costSheet.loadingRatio');
  });

  it('accepts a normal loading ratio', () => {
    expect(
      findingIds(doc({ kind: 'costSheet', carpetAreaSqFt: 1200, superBuiltUpAreaSqFt: 1700 })),
    ).not.toContain('costSheet.loadingRatio');
  });

  it('flags money in the total that no line item explains', () => {
    expect(
      findingIds(
        doc({
          kind: 'costSheet',
          considerationAmount: 10_000_000,
          basePrice: 8_000_000,
          itemisedCharges: { parking: 300_000 },
          gstAmount: 400_000,
        }),
      ),
    ).toContain('costSheet.chargesItemised');
  });

  it('accepts a sheet that adds up', () => {
    expect(
      findingIds(
        doc({
          kind: 'costSheet',
          considerationAmount: 10_000_000,
          basePrice: 8_500_000,
          itemisedCharges: { parking: 300_000, clubhouse: 200_000, maintenance: 600_000 },
          gstAmount: 400_000,
        }),
      ),
    ).not.toContain('costSheet.chargesItemised');
  });
});

describe('analysis output', () => {
  it('orders serious findings before attention', () => {
    const analysis = analyseDocument(
      doc({
        kind: 'agreementToSell',
        possessionDate: '',
        forfeitureClause: true,
        delayPenaltyClause: false,
        considerationAmount: 10_000_000,
        advancePaid: 3_000_000,
      }),
      NOW,
    );
    const severities = analysis.findings.map((f) => f.severity);
    expect(severities[0]).toBe('serious');
    expect(severities.at(-1)).toBe('attention');
  });

  it('counts serious findings', () => {
    const analysis = analyseDocument(
      doc({ kind: 'saleDeed', witnessCount: 0, registrationNumber: '' }),
      NOW,
    );
    expect(analysis.seriousCount).toBeGreaterThanOrEqual(2);
  });

  it('gives every finding an observation and a question to ask', () => {
    const analysis = analyseDocument(
      doc({ kind: 'khata', khataType: 'B', propertyTaxPaidUpto: '2023-01-01' }),
      NOW,
    );
    expect(analysis.findings.length).toBeGreaterThan(0);
    for (const f of analysis.findings) {
      expect(f.observation.length).toBeGreaterThan(15);
      expect(f.askAbout.length).toBeGreaterThan(15);
      expect(f.needsHumanReview).toBe(true);
    }
  });

  it('records the rules version and the extraction method', () => {
    const analysis = analyseDocument(doc({ kind: 'khata', khataType: 'A' }), NOW);
    expect(analysis.rulesVersion).toBe('0.1.0');
    expect(analysis.extractionMethod).toBe('manual');
  });
});

describe('upload validation', () => {
  it('accepts a PDF whose extension matches its type', () => {
    expect(validateUpload({ name: 'deed.pdf', size: 1024, type: 'application/pdf' }).ok).toBe(true);
  });

  it('rejects a type that is not on the allowlist', () => {
    const result = validateUpload({ name: 'x.exe', size: 1024, type: 'application/x-msdownload' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not accepted');
  });

  it('rejects a file whose extension disagrees with its declared type', () => {
    const result = validateUpload({ name: 'deed.exe', size: 1024, type: 'application/pdf' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('rejects an empty file', () => {
    expect(validateUpload({ name: 'a.pdf', size: 0, type: 'application/pdf' }).ok).toBe(false);
  });

  it('rejects a file over the size limit', () => {
    const result = validateUpload({
      name: 'a.pdf',
      size: MAX_DOCUMENT_BYTES + 1,
      type: 'application/pdf',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('limit is');
  });
});

describe('documentStoragePath', () => {
  it('puts the document under the owner prefix that RLS enforces', () => {
    expect(documentStoragePath('user-1', 'doc-9', 'deed.pdf')).toBe('user-1/doc-9.pdf');
  });

  it('keeps only the extension from a user-supplied filename', () => {
    const path = documentStoragePath('user-1', 'doc-9', '../../etc/passwd.pdf');
    expect(path).toBe('user-1/doc-9.pdf');
    expect(path).not.toContain('..');
    expect(path).not.toContain('passwd');
  });
});
