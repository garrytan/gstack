import Link from 'next/link';
import { AlertTriangle, ArrowRight, Info, ShieldAlert } from 'lucide-react';
import type { Alert, AlertSeverity } from '@/domain/alerts/types';

const SEVERITY: Readonly<
  Record<AlertSeverity, { color: string; icon: typeof Info; label: string }>
> = {
  urgent: { color: 'var(--color-avoid)', icon: ShieldAlert, label: 'Urgent' },
  attention: { color: 'var(--color-negotiate)', icon: AlertTriangle, label: 'Attention' },
  info: { color: 'var(--color-watch)', icon: Info, label: 'For information' },
};

export const AlertList = ({
  alerts,
  watchedCount,
  baselinesCreated,
}: {
  alerts: readonly Alert[];
  watchedCount: number;
  baselinesCreated: number;
}) => {
  if (alerts.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-8 text-center">
        <p className="text-sm font-medium">Nothing has moved</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
          {baselinesCreated > 0
            ? `We just took a first reading on ${baselinesCreated} of the ${watchedCount} propert${
                watchedCount === 1 ? 'y' : 'ies'
              } you watch. There is nothing to compare against yet, so there is nothing to report.`
            : `All ${watchedCount} propert${watchedCount === 1 ? 'y is' : 'ies are'} unchanged since we last looked, or moved by less than the thresholds below.`}
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {alerts.map((alert, i) => {
        const meta = SEVERITY[alert.severity];
        const Icon = meta.icon;
        return (
          <li
            key={`${alert.propertyId}-${alert.rule}-${i}`}
            className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4"
            style={{ borderLeftWidth: 3, borderLeftColor: meta.color }}
          >
            <div className="flex items-start gap-3">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: meta.color }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{alert.headline}</p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{alert.detail}</p>
                <p data-figure className="mt-2 text-[11px] text-[var(--text-muted)]">
                  <span className="line-through">{alert.before}</span>
                  <ArrowRight aria-hidden className="mx-1.5 inline size-3" />
                  <span className="font-medium text-[var(--text-secondary)]">{alert.after}</span>
                  <span className="ml-3 font-mono">{alert.rule}</span>
                </p>
              </div>
              <Link
                href={`/property/${alert.propertyId}`}
                className="shrink-0 text-xs font-medium text-accent-500 hover:underline"
              >
                Open
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
};
