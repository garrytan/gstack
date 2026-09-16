/**
 * Data-status disclosure.
 *
 * These components are the visible half of the truthfulness rule. Any surface
 * rendering a figure that is not directly verified has to say so here, and
 * demo data is never allowed to render without the banner.
 */

import Link from 'next/link';
import { AlertTriangle, BadgeCheck, Calculator, FlaskConical } from 'lucide-react';
import type { DataStatus } from '@/domain/evidence/types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_META: Readonly<
  Record<DataStatus, { label: string; tone: 'accent' | 'neutral' | 'warn'; description: string }>
> = {
  verified: {
    label: 'Verified',
    tone: 'accent',
    description:
      'Observed directly from a source we trust and re-checked within its freshness window.',
  },
  derived: {
    label: 'Derived',
    tone: 'neutral',
    description: 'Computed from verified inputs by a documented method.',
  },
  estimated: {
    label: 'Estimated',
    tone: 'neutral',
    description: 'Modelled with a confidence band. Not a stated fact.',
  },
  demo: {
    label: 'Demo data',
    tone: 'warn',
    description: 'Development fixture. Synthetic figures that describe no real property.',
  },
};

const ICONS: Readonly<Record<DataStatus, typeof BadgeCheck>> = {
  verified: BadgeCheck,
  derived: Calculator,
  estimated: Calculator,
  demo: FlaskConical,
};

export const DataStatusBadge = ({
  status,
  className,
}: {
  status: DataStatus;
  className?: string;
}) => {
  const meta = STATUS_META[status];
  const Icon = ICONS[status];
  return (
    <Badge tone={meta.tone} className={className} title={meta.description}>
      <Icon aria-hidden className="size-3" />
      {meta.label}
    </Badge>
  );
};

/**
 * The demo banner. Deliberately loud and impossible to mistake for chrome:
 * a user must never be able to read a fixture number as a market reading.
 */
export const DemoDataBanner = ({ className }: { className?: string }) => (
  <div
    role="status"
    className={cn(
      'flex items-start gap-3 rounded-lg border border-[var(--color-negotiate)] bg-[var(--color-negotiate)]/10 p-3 text-sm',
      className,
    )}
  >
    <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--color-negotiate)]" />
    <div>
      <p className="font-semibold text-[var(--color-negotiate)]">
        Demo data — not live market intelligence
      </p>
      <p className="mt-0.5 text-[var(--text-secondary)]">
        Every figure on this screen comes from a development fixture. The properties, developers and
        transactions are invented, and the locality figures are synthetic. Nothing here describes a
        real listing.
      </p>
    </div>
  </div>
);

export const statusDescription = (status: DataStatus): string => STATUS_META[status].description;

/**
 * What a surface shows when no property source is connected.
 *
 * The distinction this draws matters: "no results" tells a buyer their filters
 * were too narrow, which is a lie when the truth is that this deployment has no
 * Indian property data at all. Every data-backed surface says the second thing
 * when `servesNoData` is set, and the tools that need no dataset keep working
 * beside it.
 */
export const NoDataNotice = ({ surface = 'This section' }: { surface?: string }) => (
  <div role="status" className="rounded-xl propiq-card p-6">
    <p className="flex items-center gap-2 text-sm font-semibold">
      <FlaskConical aria-hidden className="size-4 shrink-0 text-[var(--text-muted)]" />
      No property data source is connected
    </p>
    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">
      {surface} needs a property database, and this deployment has not been pointed at one. Rather
      than show invented figures or demo records dressed as market intelligence, it shows nothing.
    </p>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">
      Everything that does not depend on our dataset still works:{' '}
      <Link href="/tools" className="underline hover:text-[var(--text-primary)]">
        the free tools
      </Link>
      ,{' '}
      <Link href="/document-ai" className="underline hover:text-[var(--text-primary)]">
        the document checks
      </Link>
      ,{' '}
      <Link href="/site-visit-checklist" className="underline hover:text-[var(--text-primary)]">
        the site-visit checklist
      </Link>{' '}
      and{' '}
      <Link href="/methodology" className="underline hover:text-[var(--text-primary)]">
        the published scoring method
      </Link>
      . Those run on figures you supply and on published law, not on ours.
    </p>
  </div>
);
