/**
 * The evidence drawer.
 *
 * Reusable across every surface that shows a fact. It answers the five
 * questions a buyer is entitled to ask about any number we put in front of
 * them: where it came from, when, how sure we are, by what method, and whether
 * money changed hands anywhere near it.
 */

'use client';

import { useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import type { Evidence } from '@/domain/evidence/types';
import type { CommercialRelationship } from '@/domain/property/types';
import { Badge } from '@/components/ui/badge';
import { DataStatusBadge } from './data-status';
import { cn, formatRelative } from '@/lib/utils';

export const EvidenceRow = ({ evidence }: { evidence: Evidence }) => (
  <li className="flex flex-col gap-1 border-b border-[var(--border-subtle)] py-3 last:border-0">
    <div className="flex flex-wrap items-center gap-2">
      <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
        {evidence.field}
      </code>
      <DataStatusBadge status={evidence.dataStatus} />
      {evidence.disputed && <Badge tone="avoid">Disputed</Badge>}
      {evidence.reviewState === 'human_verified' && <Badge tone="accent">Human verified</Badge>}
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
      <span>
        Source: <span className="text-[var(--text-secondary)]">{evidence.source.name}</span> (
        {evidence.source.type})
      </span>
      <span>Observed {formatRelative(evidence.observedAt)}</span>
      {evidence.lastVerifiedAt && <span>Verified {formatRelative(evidence.lastVerifiedAt)}</span>}
      <span data-figure>Confidence {Math.round(evidence.confidence * 100)}%</span>
      {evidence.methodologyVersion && <span>Method v{evidence.methodologyVersion}</span>}
      {evidence.source.reference?.startsWith('http') && (
        <a
          href={evidence.source.reference}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--text-accent)] hover:underline"
        >
          Source <ExternalLink aria-hidden className="size-3" />
        </a>
      )}
    </div>
  </li>
);

export const EvidencePanel = ({
  evidence,
  commercial,
  title = 'Evidence & sources',
  defaultOpen = false,
}: {
  evidence: readonly Evidence[];
  commercial?: CommercialRelationship;
  title?: string;
  defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-lg propiq-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span>
          <span className="text-sm font-semibold">{title}</span>
          <span className="ml-2 text-xs text-[var(--text-muted)]">
            {evidence.length} record{evidence.length === 1 ? '' : 's'}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="border-t border-[var(--border-subtle)] px-4 pb-4">
          {commercial && <CommercialDisclosure commercial={commercial} />}
          {evidence.length === 0 ? (
            <p className="py-4 text-sm text-[var(--text-muted)]">
              No evidence records are attached to this property yet. Nothing on this page that
              depends on them is being presented as a verified fact.
            </p>
          ) : (
            <ul className="mt-2">
              {evidence.map((e) => (
                <EvidenceRow key={e.id} evidence={e} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

/**
 * Commercial disclosure.
 *
 * Shown next to the evidence because it belongs to the same question: what
 * influenced what you are reading. No field here ever feeds the organic score.
 */
export const CommercialDisclosure = ({ commercial }: { commercial: CommercialRelationship }) => {
  const rows: ReadonlyArray<{ label: string; value: boolean }> = [
    { label: 'Developer relationship', value: commercial.developerRelationship },
    { label: 'Paid placement', value: commercial.paidPlacement },
    { label: 'Commission possible', value: commercial.commissionPossible },
  ];
  return (
    <div className="mt-4 rounded-md propiq-card p-3">
      <p className="text-xs font-semibold">Commercial disclosure</p>
      <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-3">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between gap-2 text-[11px] sm:flex-col sm:items-start"
          >
            <dt className="text-[var(--text-muted)]">{r.label}</dt>
            <dd className={r.value ? 'font-semibold text-[var(--color-negotiate)]' : 'font-medium'}>
              {r.value ? 'Yes' : 'No'}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-[var(--text-muted)]">
        No commercial arrangement changes the PropIQ Score. Scoring inputs and commercial fields are
        computed in separate systems that never read each other.
      </p>
      {commercial.note && (
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{commercial.note}</p>
      )}
    </div>
  );
};
