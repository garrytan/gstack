'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, ShieldAlert } from 'lucide-react';
import { analyseDocument, rulesFor } from '@/domain/documents/rules';
import type {
  DocumentKind,
  ExtractedDocument,
  FindingSeverity,
  KhataType,
} from '@/domain/documents/types';
import { DOCUMENT_DISCLAIMER, DOCUMENT_KINDS, DOCUMENT_LABELS } from '@/domain/documents/types';
import { Input, Label, Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const SEVERITY: Readonly<Record<FindingSeverity, { color: string; icon: typeof ShieldAlert }>> = {
  serious: { color: 'var(--color-avoid)', icon: ShieldAlert },
  attention: { color: 'var(--color-negotiate)', icon: AlertTriangle },
  info: { color: 'var(--color-watch)', icon: CircleHelp },
};

type FieldState = Record<string, string>;

/**
 * Manual document checker.
 *
 * The checks run in the browser against values the buyer types, because the
 * deterministic half of document analysis does not need OCR — and because
 * nothing is uploaded, nothing leaves the page. A buyer standing in a builder's
 * office can use this on their phone today.
 */
export const DocumentChecker = () => {
  const [kind, setKind] = useState<DocumentKind>('khata');
  const [fields, setFields] = useState<FieldState>({});

  const set = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }));

  // Only fields the user actually touched are sent. An untouched field stays
  // undefined so its rule is reported as "could not check" rather than passing.
  const extracted = useMemo<ExtractedDocument>(() => {
    const num = (k: string) => (fields[k] === undefined ? undefined : Number(fields[k]) || 0);
    const str = (k: string) => fields[k];
    const bool = (k: string) => (fields[k] === undefined ? undefined : fields[k] === 'yes');

    return {
      kind,
      extractedAt: new Date().toISOString(),
      extractionMethod: 'manual',
      extractionConfidence: 1,
      surveyNumber: str('surveyNumber'),
      registrationNumber: str('registrationNumber'),
      witnessCount: num('witnessCount'),
      considerationAmount: num('considerationAmount'),
      stampDutyPaid: num('stampDutyPaid'),
      advancePaid: num('advancePaid'),
      ecPeriodFrom: str('ecPeriodFrom'),
      ecPeriodTo: str('ecPeriodTo'),
      encumbranceEntries:
        fields.outstandingCharges === undefined
          ? undefined
          : fields.outstandingCharges === 'yes'
            ? [
                {
                  date: fields.chargeDate ?? '',
                  nature: fields.chargeNature ?? 'Charge',
                  outstanding: true,
                },
              ]
            : [],
      khataType: str('khataType') as KhataType | undefined,
      propertyTaxPaidUpto: str('propertyTaxPaidUpto'),
      possessionDate: str('possessionDate'),
      delayPenaltyClause: bool('delayPenaltyClause'),
      forfeitureClause: bool('forfeitureClause'),
      reraValidUntil: str('reraValidUntil'),
      carpetAreaSqFt: num('carpetAreaSqFt'),
      superBuiltUpAreaSqFt: num('superBuiltUpAreaSqFt'),
    };
  }, [kind, fields]);

  const analysis = useMemo(() => analyseDocument(extracted, new Date().toISOString()), [extracted]);
  const willCheck = rulesFor(kind);
  const answered = Object.keys(fields).length > 0;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section>
        <h2 className="text-sm font-semibold">What does your document say?</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Nothing is uploaded and nothing leaves this page. Leave anything you do not know blank — a
          blank is reported as &ldquo;could not check&rdquo;, never as a pass.
        </p>

        <div className="mt-4 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="kind">Document type</Label>
            <Select
              id="kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as DocumentKind);
                setFields({});
              }}
            >
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DOCUMENT_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>

          {kind === 'saleDeed' && (
            <>
              <TextField
                id="surveyNumber"
                label="Survey number"
                onChange={set}
                placeholder="e.g. 42/3"
              />
              <TextField id="registrationNumber" label="Registration number" onChange={set} />
              <NumberField id="witnessCount" label="How many witnesses signed?" onChange={set} />
              <NumberField
                id="considerationAmount"
                label="Consideration / sale price (₹)"
                onChange={set}
              />
              <NumberField id="stampDutyPaid" label="Stamp duty paid (₹)" onChange={set} />
            </>
          )}

          {kind === 'encumbranceCertificate' && (
            <>
              <TextField id="ecPeriodFrom" label="Period covered from" type="date" onChange={set} />
              <TextField id="ecPeriodTo" label="Period covered to" type="date" onChange={set} />
              <YesNo
                id="outstandingCharges"
                label="Does it show any charge that has not been released?"
                onChange={set}
              />
              {fields.outstandingCharges === 'yes' && (
                <>
                  <TextField
                    id="chargeNature"
                    label="What is the charge?"
                    onChange={set}
                    placeholder="e.g. Mortgage to a bank"
                  />
                  <TextField
                    id="chargeDate"
                    label="Date of the charge"
                    type="date"
                    onChange={set}
                  />
                </>
              )}
            </>
          )}

          {kind === 'khata' && (
            <>
              <div className="space-y-1">
                <Label htmlFor="khataType">Khata type</Label>
                <Select
                  id="khataType"
                  defaultValue=""
                  onChange={(e) => set('khataType', e.target.value)}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  <option value="A">A-khata</option>
                  <option value="B">B-khata</option>
                  <option value="eKhata">e-Khata</option>
                  <option value="unknown">I do not know</option>
                </Select>
              </div>
              <TextField
                id="propertyTaxPaidUpto"
                label="Property tax paid up to"
                type="date"
                onChange={set}
              />
              <TextField id="surveyNumber" label="Survey number" onChange={set} />
            </>
          )}

          {kind === 'agreementToSell' && (
            <>
              <TextField
                id="possessionDate"
                label="Committed possession date"
                type="date"
                onChange={set}
              />
              <YesNo
                id="delayPenaltyClause"
                label="Is there a penalty on the builder for late possession?"
                onChange={set}
              />
              <YesNo
                id="forfeitureClause"
                label="Can your money be forfeited if you withdraw?"
                onChange={set}
              />
              <NumberField id="considerationAmount" label="Total price (₹)" onChange={set} />
              <NumberField id="advancePaid" label="Advance being asked for (₹)" onChange={set} />
            </>
          )}

          {kind === 'reraCertificate' && (
            <>
              <TextField
                id="reraValidUntil"
                label="Registration valid until"
                type="date"
                onChange={set}
              />
              <TextField
                id="possessionDate"
                label="Committed possession date"
                type="date"
                onChange={set}
              />
            </>
          )}

          {kind === 'costSheet' && (
            <>
              <NumberField id="carpetAreaSqFt" label="Carpet area (sqft)" onChange={set} />
              <NumberField
                id="superBuiltUpAreaSqFt"
                label="Super built-up area (sqft)"
                onChange={set}
              />
              <NumberField id="considerationAmount" label="Total payable (₹)" onChange={set} />
            </>
          )}

          {(kind === 'sanctionedPlan' || kind === 'loanSanction') && (
            <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-secondary)]">
              PropIQ has no deterministic checks for this document type yet. Rather than run an
              empty check and imply it passed, it says so.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">What the checks say</h2>

        {!answered ? (
          <div className="mt-4 rounded-lg border border-dashed border-[var(--border-strong)] p-6">
            <p className="text-xs text-[var(--text-secondary)]">
              Fill anything in on the left and the checks run as you type. For a{' '}
              {DOCUMENT_LABELS[kind].toLowerCase()} PropIQ will look at:
            </p>
            <ul className="mt-3 space-y-1">
              {willCheck.map((r) => (
                <li key={r.id} className="text-xs text-[var(--text-muted)]">
                  • {r.title}
                </li>
              ))}
              {willCheck.length === 0 && (
                <li className="text-xs text-[var(--text-muted)]">
                  • Nothing yet for this document type.
                </li>
              )}
            </ul>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {analysis.findings.length > 0 && (
              <ul className="space-y-3">
                {analysis.findings.map((f) => {
                  const meta = SEVERITY[f.severity];
                  const Icon = meta.icon;
                  return (
                    <li
                      key={f.ruleId}
                      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
                      style={{ borderLeftWidth: 3, borderLeftColor: meta.color }}
                    >
                      <div className="flex items-start gap-2">
                        <Icon
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0"
                          style={{ color: meta.color }}
                        />
                        <div>
                          <p className="text-xs font-semibold">{f.title}</p>
                          <p className="mt-1 text-xs text-[var(--text-secondary)]">
                            {f.observation}
                          </p>
                          <p className="mt-1.5 text-xs">
                            <strong className="font-medium">Ask:</strong>{' '}
                            <span className="text-[var(--text-secondary)]">{f.askAbout}</span>
                          </p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {analysis.passed.length > 0 && (
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <CheckCircle2
                    aria-hidden
                    className="size-3.5"
                    style={{ color: 'var(--color-buy)' }}
                  />
                  Checked and nothing wrong
                </p>
                <ul className="mt-2 space-y-0.5">
                  {analysis.passed.map((p) => (
                    <li key={p} className="text-xs text-[var(--text-secondary)]">
                      • {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.skipped.length > 0 && (
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <CircleHelp aria-hidden className="size-3.5 text-[var(--text-muted)]" />
                  Could not check
                </p>
                <ul className="mt-2 space-y-0.5">
                  {analysis.skipped.map((s) => (
                    <li key={s} className="text-xs text-[var(--text-muted)]">
                      • {s}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                  These were skipped because the value they need was left blank. They are not
                  passes.
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={analysis.seriousCount > 0 ? 'avoid' : 'neutral'}>
                {analysis.seriousCount} serious
              </Badge>
              <Badge tone="neutral">{analysis.passed.length} checked clean</Badge>
              <Badge tone="warn">{analysis.skipped.length} unchecked</Badge>
              <Badge tone="neutral">rules v{analysis.rulesVersion}</Badge>
            </div>
          </div>
        )}

        <p className="mt-6 rounded-md border border-[var(--color-negotiate)] bg-[var(--color-negotiate)]/10 p-3 text-[11px] text-[var(--text-secondary)]">
          {DOCUMENT_DISCLAIMER}
        </p>
      </section>
    </div>
  );
};

const TextField = ({
  id,
  label,
  type = 'text',
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  type?: string;
  placeholder?: string;
  onChange: (k: string, v: string) => void;
}) => (
  <div className="space-y-1">
    <Label htmlFor={id}>{label}</Label>
    <Input
      id={id}
      type={type}
      placeholder={placeholder}
      onChange={(e) => onChange(id, e.target.value)}
    />
  </div>
);

const NumberField = ({
  id,
  label,
  onChange,
}: {
  id: string;
  label: string;
  onChange: (k: string, v: string) => void;
}) => (
  <div className="space-y-1">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="number" min={0} onChange={(e) => onChange(id, e.target.value)} />
  </div>
);

const YesNo = ({
  id,
  label,
  onChange,
}: {
  id: string;
  label: string;
  onChange: (k: string, v: string) => void;
}) => (
  <div className="space-y-1">
    <Label htmlFor={id}>{label}</Label>
    <Select id={id} defaultValue="" onChange={(e) => onChange(id, e.target.value)}>
      <option value="" disabled>
        Select…
      </option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </Select>
  </div>
);
