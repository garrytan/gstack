/**
 * How far the locality is from the things people commute to.
 *
 * The first draft of this was a radar: anchors placed around a circle at their
 * true radius. It had to carry a paragraph explaining that the bearings meant
 * nothing, because the record stores distances and not coordinates — and a
 * chart that needs a paragraph to stop it lying is the wrong chart. This is the
 * same data on a single honest axis. Nothing here implies a direction, and the
 * one outlier that drags the scale (usually the airport) is exactly the fact a
 * buyer wants to see dragging it.
 */

import { Building2, Plane, Route, TrainFront } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LocalityAnchor, SiteLocality } from '@/site/types';

const KIND_COLOR: Readonly<Record<LocalityAnchor['kind'], string>> = {
  employment: 'var(--color-brand-blue-500)',
  metro: 'var(--color-brand-cyan-500)',
  road: 'var(--color-brand-violet-500)',
  airport: 'var(--text-muted)',
};

const KIND_ICON: Readonly<Record<LocalityAnchor['kind'], LucideIcon>> = {
  employment: Building2,
  metro: TrainFront,
  road: Route,
  airport: Plane,
};

const KIND_LABEL: Readonly<Record<LocalityAnchor['kind'], string>> = {
  employment: 'Employment hub',
  metro: 'Metro',
  road: 'Arterial road',
  airport: 'Airport',
};

/** Axis ticks that land on round kilometres rather than on the data. */
const ticksFor = (maxKm: number): readonly number[] => {
  const step = [1, 2, 5, 10, 20, 25, 50, 100].find((s) => maxKm / s <= 5) ?? 200;
  const ticks: number[] = [];
  for (let km = 0; km <= maxKm; km += step) ticks.push(km);
  return ticks;
};

export const LocalityAccess = ({ locality }: { locality: SiteLocality }) => {
  const anchors = locality.anchors;
  if (anchors.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border-subtle)] p-6 text-sm text-[var(--text-muted)]">
        No commute or transit distances are recorded for {locality.name}, so there is nothing to
        plot here. This appears once the locality record carries them.
      </p>
    );
  }

  const maxKm = Math.max(...anchors.map((a) => a.distanceKm));
  const ticks = ticksFor(maxKm);
  const axisMax = Math.max(ticks[ticks.length - 1] ?? maxKm, maxKm);
  const pct = (km: number) => `${(km / axisMax) * 100}%`;

  const nearest = anchors[0];
  const commute = anchors.find((a) => a.peakCommuteMinutes !== undefined);

  return (
    <figure className="rounded-2xl propiq-card p-5 sm:p-6">
      <figcaption className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
        Access from {locality.name}
      </figcaption>

      <ul className="mt-5 space-y-4">
        {anchors.map((anchor) => {
          const Icon = KIND_ICON[anchor.kind];
          return (
            <li key={`${anchor.kind}-${anchor.label}`}>
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex min-w-0 items-baseline gap-2">
                  <Icon
                    aria-hidden
                    className="size-3.5 shrink-0 translate-y-0.5"
                    style={{ color: KIND_COLOR[anchor.kind] }}
                  />
                  <span className="truncate text-sm font-medium">{anchor.label}</span>
                  {/* The record names some anchors after their own kind
                      ("Airport"), so the chip would just repeat the label. */}
                  {KIND_LABEL[anchor.kind].toLowerCase() !== anchor.label.toLowerCase() && (
                    <span className="hidden shrink-0 text-[11px] text-[var(--text-muted)] sm:inline">
                      {KIND_LABEL[anchor.kind]}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                  <span data-figure className="font-semibold">
                    {anchor.distanceKm} km
                  </span>
                  {anchor.peakCommuteMinutes !== undefined && (
                    <>
                      {' · '}
                      <span data-figure>{anchor.peakCommuteMinutes} min</span> at peak
                    </>
                  )}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-[var(--surface-2)]">
                <div
                  className="h-1.5 rounded-full"
                  style={{ width: pct(anchor.distanceKm), background: KIND_COLOR[anchor.kind] }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {/* The axis sits under the bars rather than above them, so the eye reads
          each name and its number first and only then checks the scale. */}
      <div aria-hidden className="relative mt-4 h-4 border-t border-[var(--border-subtle)]">
        {ticks.map((km) => (
          <span
            key={km}
            className="absolute top-1 -translate-x-1/2 text-[10px] text-[var(--text-muted)]"
            style={{ left: pct(km) }}
          >
            {km}
          </span>
        ))}
        <span className="absolute right-0 top-1 text-[10px] text-[var(--text-muted)]">km</span>
      </div>

      <p className="mt-5 border-t border-[var(--border-subtle)] pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Straight-line distance from {locality.name} to each anchor the record carries, on one shared
        scale to {axisMax} km.
        {nearest ? ` The nearest is ${nearest.label} at ${nearest.distanceKm} km.` : ''}
        {commute
          ? ` Peak commute is measured door to door, so it is longer than the distance suggests: ${commute.peakCommuteMinutes} minutes to ${commute.label}.`
          : ''}{' '}
        No direction is implied — the record stores distances, not coordinates.
      </p>
    </figure>
  );
};
