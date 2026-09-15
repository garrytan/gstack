/**
 * A floating metric on the hero.
 *
 * Every one of these carries its own data-status chip. They sit over a 3D
 * scene, detached from any surrounding context, which is exactly the
 * situation where a number gets screenshotted and quoted without the banner
 * that qualified it.
 */

import type { DataStatus } from '@/site/types';

const STATUS_LABEL: Readonly<Record<DataStatus, string>> = {
  verified: 'Verified',
  derived: 'Derived',
  estimated: 'Estimated',
  demo: 'Demo',
};

export const GlassMetricCard = ({
  label,
  value,
  note,
  accent,
  dataStatus,
  className,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: string;
  dataStatus: DataStatus;
  className?: string;
}) => (
  <div className={`propiq-site-glass rounded-xl px-4 py-3 ${className ?? ''}`}>
    <div className="flex items-center justify-between gap-3">
      <p className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-white/55">
        {label}
      </p>
      <span className="rounded border border-white/15 px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-wider text-white/45">
        {STATUS_LABEL[dataStatus]}
      </span>
    </div>
    <p
      data-figure
      className="mt-1.5 text-xl font-semibold tracking-tight text-white"
      style={accent ? { color: accent } : undefined}
    >
      {value}
    </p>
    {note && <p className="mt-0.5 text-[11px] leading-snug text-white/60">{note}</p>}
  </div>
);
