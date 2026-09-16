/**
 * Market map.
 *
 * A real map drawn from the real coordinates already in the data, rather than
 * a tile layer. That is a deliberate choice, not a fallback: no provider token
 * is configured, tiles would be blocked by the CSP, and a basemap would show
 * roads and shopfronts the product has nothing to say about. What matters here
 * is where the money, the risk and the verdicts sit relative to each other,
 * and that is exactly what the fixture coordinates support.
 *
 * Projection is equirectangular with a cosine correction on longitude, which
 * is accurate enough across the ~28 km this dataset spans and keeps the
 * geometry honest rather than decorative.
 */

import Link from 'next/link';
import type { Decision } from '@/domain/decision/engine';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { DECISION_COLOUR } from '@/components/propiq/decision-colour';
import type { Locality } from '@/domain/locality/types';
import { formatINR, formatPsf } from '@/lib/utils';

export interface MapProperty {
  readonly id: string;
  readonly title: string;
  readonly lat: number;
  readonly lng: number;
  readonly decision: Decision;
  readonly score: number | undefined;
  readonly askingPrice: number;
}

const VIEW_W = 800;
const VIEW_H = 470;
const PAD = 74;

const PLATE_H = 31;

interface Plate {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const platesOverlap = (a: Plate, b: Plate): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Closest point on the rect to the circle centre, then compare to the radius. */
const plateHitsCircle = (plate: Plate, circle: { cx: number; cy: number; r: number }): boolean => {
  const nx = Math.max(plate.x, Math.min(circle.cx, plate.x + plate.w));
  const ny = Math.max(plate.y, Math.min(circle.cy, plate.y + plate.h));
  return Math.hypot(circle.cx - nx, circle.cy - ny) < circle.r;
};

interface Projector {
  readonly x: (lng: number) => number;
  readonly y: (lat: number) => number;
}

/**
 * Fit the data's bounding box into the viewBox, preserving aspect so the shape
 * of the city is not stretched. Longitude degrees are narrower than latitude
 * degrees at 13°N, so they are scaled by cos(lat) before fitting.
 */
export const buildProjector = (points: ReadonlyArray<{ lat: number; lng: number }>): Projector => {
  if (points.length === 0) {
    return { x: () => VIEW_W / 2, y: () => VIEW_H / 2 };
  }

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const midLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos((midLat * Math.PI) / 180);

  // Degrees of extent, with longitude narrowed to true ground distance.
  const spanX = Math.max((maxLng - minLng) * lngScale, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);

  const usableW = VIEW_W - PAD * 2;
  const usableH = VIEW_H - PAD * 2;
  // One scale for both axes keeps the city's real proportions.
  const scale = Math.min(usableW / spanX, usableH / spanY);

  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = (VIEW_W - drawnW) / 2;
  const offsetY = (VIEW_H - drawnH) / 2;

  return {
    x: (lng) => offsetX + (lng - minLng) * lngScale * scale,
    // SVG y grows downward; north should be up.
    y: (lat) => offsetY + (maxLat - lat) * scale,
  };
};

export const MarketMap = ({
  localities,
  properties,
}: {
  localities: readonly Locality[];
  properties: readonly MapProperty[];
}) => {
  const points = [
    ...localities.map((l) => l.center),
    ...properties.map((p) => ({ lat: p.lat, lng: p.lng })),
  ];
  const project = buildProjector(points);

  const psfValues = localities
    .map((l) => l.currentMedianPricePerSqFt)
    .filter((v): v is number => v !== undefined);
  const minPsf = psfValues.length > 0 ? Math.min(...psfValues) : 0;
  const maxPsf = psfValues.length > 0 ? Math.max(...psfValues) : 1;
  /** Catchment radius reads price level: dearer locality, larger halo. */
  const radiusFor = (psf: number | undefined): number => {
    if (psf === undefined || maxPsf === minPsf) return 30;
    return 22 + ((psf - minPsf) / (maxPsf - minPsf)) * 22;
  };

  const catchments = localities.map((l) => ({
    locality: l,
    cx: project.x(l.center.lng),
    cy: project.y(l.center.lat),
    r: radiusFor(l.currentMedianPricePerSqFt),
  }));

  // Label placement, resolved once so the JSX stays declarative. Each plate is
  // tried above its catchment and moved below when that would cover another
  // locality's circle or a plate already placed.
  const placed: Plate[] = [];
  const labelPlates = catchments.map((c) => {
    const psf = c.locality.currentMedianPricePerSqFt
      ? `\u20B9${c.locality.currentMedianPricePerSqFt.toLocaleString('en-IN')}/sqft`
      : 'no data';
    // Width from character count: an SVG text node cannot be measured before
    // paint, and this is accurate enough at 12.5px.
    const w = Math.max(c.locality.name.length * 7.4, psf.length * 6.2) + 18;
    const above: Plate = { x: c.cx - w / 2, y: c.cy - c.r - 34, w, h: PLATE_H };
    const below: Plate = { x: c.cx - w / 2, y: c.cy + c.r + 5, w, h: PLATE_H };

    const blocked = (plate: Plate): boolean =>
      placed.some((q) => platesOverlap(plate, q)) ||
      catchments.some((o) => o.locality.id !== c.locality.id && plateHitsCircle(plate, o));

    const plate = blocked(above) && !blocked(below) ? below : above;
    placed.push(plate);
    return { locality: c.locality, plate, psf };
  });

  // Two pins on top of each other would stack their score numerals into an
  // unreadable smudge. The pin still marks the true coordinate; only the
  // numeral is dropped, and the tooltip still carries the score.
  const crowded = (p: MapProperty): boolean =>
    properties.some(
      (o) =>
        o.id !== p.id &&
        Math.hypot(project.x(o.lng) - project.x(p.lng), project.y(o.lat) - project.y(p.lat)) < 26,
    );

  const dearest = localities.reduce<Locality | undefined>(
    (best, l) =>
      (l.currentMedianPricePerSqFt ?? 0) > (best?.currentMedianPricePerSqFt ?? 0) ? l : best,
    undefined,
  );

  return (
    <figure className="m-0">
      <div className="relative overflow-hidden rounded-lg propiq-card">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="block h-auto w-full"
          role="img"
          aria-label={
            `Map of ${localities.length} Bengaluru localities and ${properties.length} scored properties. ` +
            localities
              .map(
                (l) =>
                  `${l.name}, median ${l.currentMedianPricePerSqFt ?? 'unknown'} rupees per square foot`,
              )
              .join('. ') +
            '.'
          }
        >
          <defs>
            <radialGradient id="catchment" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--color-accent-500)" stopOpacity="0.20" />
              <stop offset="70%" stopColor="var(--color-accent-500)" stopOpacity="0.05" />
              <stop offset="100%" stopColor="var(--color-accent-500)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="ground" cx="50%" cy="45%" r="72%">
              <stop offset="0%" stopColor="var(--color-accent-500)" stopOpacity="0.10" />
              <stop offset="55%" stopColor="var(--color-accent-500)" stopOpacity="0.03" />
              <stop offset="100%" stopColor="var(--color-accent-500)" stopOpacity="0" />
            </radialGradient>
            <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path
                d="M 32 0 L 0 0 0 32"
                fill="none"
                stroke="var(--border-subtle)"
                strokeWidth="1"
                opacity="0.55"
              />
            </pattern>
          </defs>

          {/* Graticule over a soft ground — this is an instrument, and it
              should read as one rather than as an empty panel. */}
          <rect width={VIEW_W} height={VIEW_H} fill="url(#grid)" />
          <rect width={VIEW_W} height={VIEW_H} fill="url(#ground)" />

          {/* Locality catchments, sized by price level. */}
          {catchments.map((c) => (
            <g key={c.locality.id}>
              <circle cx={c.cx} cy={c.cy} r={c.r} fill="url(#catchment)" />
              <circle
                cx={c.cx}
                cy={c.cy}
                r={c.r}
                fill="none"
                stroke="var(--color-accent-600)"
                strokeOpacity="0.35"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
            </g>
          ))}

          {/* Locality labels sit on a plate, above the catchment where there
              is room and below it where there is not. Placing every label
              above put some of them over a neighbour's pins, which hides the
              one thing on this drawing a reader is looking for. */}
          {labelPlates.map(({ locality, plate, psf }) => (
            <g key={`label-${locality.id}`}>
              <rect
                x={plate.x}
                y={plate.y}
                width={plate.w}
                height={plate.h}
                rx={5}
                fill="var(--surface-0)"
                fillOpacity="0.94"
                stroke="var(--border-subtle)"
                strokeWidth="1"
              />
              <text
                x={plate.x + plate.w / 2}
                y={plate.y + 13}
                textAnchor="middle"
                fill="var(--text-primary)"
                fontSize="12.5"
                fontWeight="600"
              >
                {locality.name}
              </text>
              <text
                x={plate.x + plate.w / 2}
                y={plate.y + 26}
                textAnchor="middle"
                fill="var(--text-muted)"
                fontSize="10.5"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {psf}
              </text>
            </g>
          ))}

          {/* Property pins, coloured by verdict. */}
          {properties.map((p) => {
            const cx = project.x(p.lng);
            const cy = project.y(p.lat);
            const color = DECISION_COLOUR[p.decision];
            return (
              <g key={p.id} className="propiq-pin">
                <circle cx={cx} cy={cy} r="13" fill={color} opacity="0.16" />
                <circle
                  cx={cx}
                  cy={cy}
                  r="5.5"
                  fill={color}
                  stroke="var(--surface-0)"
                  strokeWidth="1.75"
                />
                {p.score !== undefined && !crowded(p) && (
                  <text
                    x={cx}
                    y={cy + 21}
                    textAnchor="middle"
                    fill={color}
                    fontSize="10.5"
                    fontWeight="700"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {Math.round(p.score)}
                  </text>
                )}
                <title>
                  {`${p.title} — ${DECISION_LABELS[p.decision]}${
                    p.score === undefined ? '' : `, score ${Math.round(p.score)}`
                  }, ${formatINR(p.askingPrice)}`}
                </title>
              </g>
            );
          })}
        </svg>

        {/* Legend sits over the map so the drawing keeps its full width. */}
        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-md propiq-card/85 px-2.5 py-1.5 backdrop-blur">
          {(['BUY', 'NEGOTIATE', 'WATCH', 'AVOID'] as const).map((d) => (
            <span
              key={d}
              className="flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)]"
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: DECISION_COLOUR[d] }}
              />
              {DECISION_LABELS[d]}
            </span>
          ))}
        </div>
      </div>

      <figcaption className="mt-2 text-xs text-[var(--text-muted)]">
        {properties.length} scored properties across {localities.length} localities, plotted on
        their real coordinates. Halo size tracks the locality median —{' '}
        {dearest?.name ?? 'the priciest pocket'} is dearest at{' '}
        {dearest?.currentMedianPricePerSqFt
          ? formatPsf(dearest.currentMedianPricePerSqFt)
          : 'unknown'}
        . Pin colour is the verdict PropIQ reached, not a listing status.
      </figcaption>

      {/* Text equivalent, so the map is not the only way to get the information. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {localities.map((l) => (
          <li key={`legend-${l.id}`} className="text-xs">
            <Link
              href={`/locality/${l.slug}`}
              className="text-[var(--text-accent)] hover:underline"
            >
              {l.name}
            </Link>
            <span data-figure className="ml-1.5 text-[var(--text-muted)]">
              {l.currentMedianPricePerSqFt ? formatPsf(l.currentMedianPricePerSqFt) : '—'}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
};
