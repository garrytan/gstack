import Link from 'next/link';
import { MapPin } from 'lucide-react';
import type { PropertyIntelligence } from '@/server/intelligence';
import { pricePerSqFt } from '@/domain/property/types';
import { DecisionBadge } from './decision-badge';
import { DataStatusBadge } from './data-status';
import { DECISION_COLOUR } from '@/components/propiq/decision-colour';
import { formatINR, formatPsf, formatSignedPercent } from '@/lib/utils';

export const PropertyCard = ({ intelligence }: { intelligence: PropertyIntelligence }) => {
  const { property, project, locality, score, decision, valuation } = intelligence;

  return (
    <article className="flex flex-col rounded-lg propiq-card transition-colors hover:border-[var(--border-strong)]">
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">
            <Link href={`/property/${property.id}`} className="hover:underline">
              {property.title}
            </Link>
          </h3>
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-[var(--text-muted)]">
            <MapPin aria-hidden className="size-3 shrink-0" />
            {project?.name ?? 'Project'} · {locality?.name ?? 'Locality'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span
            data-figure
            className="block text-xl font-semibold leading-none"
            style={{ color: DECISION_COLOUR[decision.decision] }}
          >
            {score.score === undefined ? '—' : Math.round(score.score)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            Score
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2 px-4 pb-3">
        <Cell label="Asking" value={formatINR(property.askingPrice)} />
        <Cell label="₹/sqft" value={formatPsf(pricePerSqFt(property))} />
        <Cell
          label="vs fair value"
          value={
            valuation.insufficientEvidence
              ? 'unknown'
              : formatSignedPercent(valuation.askingDeviationPercent)
          }
        />
      </dl>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
        <DecisionBadge decision={decision.decision} size="sm" />
        <DataStatusBadge status={property.dataStatus} />
        <Link
          href={`/property/${property.id}`}
          className="ml-auto text-xs font-medium text-[var(--text-accent)] hover:underline"
        >
          Full intelligence
        </Link>
      </div>
    </article>
  );
};

const Cell = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0">
    <dt className="truncate text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
      {label}
    </dt>
    <dd data-figure className="truncate text-xs font-semibold">
      {value}
    </dd>
  </div>
);
