'use client';

/**
 * Map and list explorer.
 *
 * No Mapbox token is configured, and the brief is explicit that the homepage
 * must not need an API key to render. So this draws the covered market from
 * the coordinates already in the data, using the same equirectangular
 * projection with a cosine correction that the application's market map uses.
 * It is a real plot of real coordinates, not a decorative illustration.
 *
 * Selecting a property in the list highlights it on the plot and the other
 * way round, and below `lg` the two become a toggle rather than a split.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { List, MapPin } from 'lucide-react';
import { DECISION_LABELS } from '@/domain/decision/engine';
import type { Decision } from '@/domain/decision/engine';
import { formatINR } from '@/lib/utils';
import type { SiteLocality, SiteProperty } from '@/site/types';

/**
 * Label geometry. Annotations stack *upward* from the marker so switching a
 * layer on grows the block away from the pin instead of down through it.
 */
const LABEL_GAP = 44;
const LINE_H = 11;

const VIEW_W = 640;
const VIEW_H = 460;
const PAD = 54;

const DECISION_COLOR: Readonly<Record<Decision, string>> = {
  BUY: 'var(--color-buy)',
  NEGOTIATE: 'var(--color-negotiate)',
  WATCH: 'var(--color-watch)',
  AVOID: 'var(--color-avoid)',
  INSUFFICIENT_EVIDENCE: 'var(--color-unknown)',
};

/**
 * Layers a reader can toggle. Only those the dataset can actually support.
 *
 * Every one of these reads a figure the locality record already carries, and a
 * locality missing that figure simply shows one fewer line — nothing is
 * zero-filled to keep a layer looking complete. Road geometry, school and
 * hospital positions are deliberately absent: the record holds counts and
 * distances for those, not coordinates, and a marker placed at a guessed
 * position is a fabricated fact with a pin in it.
 */
const LAYERS = [
  { id: 'properties', label: 'Properties' },
  { id: 'localities', label: 'Localities' },
  { id: 'price', label: 'Price' },
  { id: 'growth', label: 'Growth' },
  { id: 'metro', label: 'Metro' },
  { id: 'infrastructure', label: 'Infrastructure' },
] as const;
type LayerId = (typeof LAYERS)[number]['id'];

/**
 * The annotation lines an active layer set produces for one locality. Returns
 * only the lines the record can actually support.
 */
const annotationsFor = (
  locality: SiteLocality,
  on: (id: LayerId) => boolean,
): readonly string[] => {
  const lines: string[] = [];
  if (on('price') && locality.medianPricePerSqFt !== undefined) {
    lines.push(`₹${locality.medianPricePerSqFt.toLocaleString('en-IN')}/sqft`);
  }
  if (on('growth') && locality.priceCagrPercent !== undefined) {
    const cagr = locality.priceCagrPercent;
    lines.push(`${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}% a year`);
  }
  if (on('metro')) {
    const metro = locality.anchors.find((a) => a.kind === 'metro');
    if (metro) lines.push(`Metro ${metro.distanceKm} km`);
  }
  if (on('infrastructure') && locality.catalysts.length > 0) {
    lines.push(
      `${locality.catalysts.length} catalyst${locality.catalysts.length === 1 ? '' : 's'}`,
    );
  }
  return lines;
};

export const MapExplorer = ({
  properties,
  localities,
}: {
  properties: readonly SiteProperty[];
  localities: readonly SiteLocality[];
}) => {
  const [selected, setSelected] = useState(properties[0]?.id);
  const [layers, setLayers] = useState<readonly LayerId[]>(['properties', 'localities']);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [hoveredLocality, setHoveredLocality] = useState<string | undefined>();

  const project = useMemo(() => {
    const points = [
      ...properties.map((p) => ({ lat: p.latitude, lng: p.longitude })),
      ...localities.map((l) => ({ lat: l.latitude, lng: l.longitude })),
    ];
    if (points.length === 0) return { x: () => VIEW_W / 2, y: () => VIEW_H / 2 };

    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
    const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
    // Longitude degrees are narrower than latitude degrees at 13°N.
    const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
    const spanX = Math.max((maxLng - minLng) * k, 1e-6);
    const spanY = Math.max(maxLat - minLat, 1e-6);
    const scale = Math.min((VIEW_W - PAD * 2) / spanX, (VIEW_H - PAD * 2) / spanY);
    const offX = (VIEW_W - spanX * scale) / 2;
    const offY = (VIEW_H - spanY * scale) / 2;

    return {
      x: (lng: number) => offX + (lng - minLng) * k * scale,
      y: (lat: number) => offY + (maxLat - lat) * scale,
    };
  }, [properties, localities]);

  const active = properties.find((p) => p.id === selected);

  const on = (id: LayerId) => layers.includes(id);
  const toggle = (id: LayerId) =>
    setLayers((current) =>
      current.includes(id) ? current.filter((l) => l !== id) : [...current, id],
    );

  /** Localities that have something to say under the active value layers. */
  const valueLayerRows = localities
    .map((l) => ({ slug: l.slug, name: l.name, lines: annotationsFor(l, on) }))
    .filter((row) => row.lines.length > 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Layers
        </span>
        {LAYERS.map((layer) => (
          <button
            key={layer.id}
            type="button"
            onClick={() => toggle(layer.id)}
            aria-pressed={on(layer.id)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              on(layer.id)
                ? 'border-[var(--color-brand-blue-500)] bg-[var(--color-brand-blue-500)]/10 text-[var(--text-primary)]'
                : 'border-[var(--border-subtle)] text-[var(--text-muted)]'
            }`}
          >
            {layer.label}
          </button>
        ))}

        <div className="ml-auto inline-flex rounded-lg border border-[var(--border-subtle)] p-0.5 lg:hidden">
          {(['list', 'map'] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setMobileView(view)}
              aria-pressed={mobileView === view}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                mobileView === view
                  ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)]'
              }`}
            >
              {view === 'list' ? (
                <List aria-hidden className="size-3.5" />
              ) : (
                <MapPin aria-hidden className="size-3.5" />
              )}
              {view}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <ol
          className={`max-h-[460px] space-y-2 overflow-y-auto pr-1 ${
            mobileView === 'map' ? 'hidden lg:block' : ''
          }`}
        >
          {properties.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelected(p.id)}
                aria-current={selected === p.id}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selected === p.id
                    ? 'border-[var(--color-brand-blue-500)] bg-[var(--surface-1)]'
                    : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-[var(--text-muted)]">{p.locality}</p>
                  </div>
                  <span
                    data-figure
                    className="shrink-0 text-sm font-bold"
                    style={{ color: DECISION_COLOR[p.decision] }}
                  >
                    {p.propiqScore === undefined ? '—' : p.propiqScore.toFixed(0)}
                  </span>
                </div>
                <p data-figure className="mt-1 text-xs text-[var(--text-secondary)]">
                  {formatINR(p.price)} · {DECISION_LABELS[p.decision]}
                </p>
              </button>
            </li>
          ))}
        </ol>

        <div
          className={`relative overflow-hidden rounded-xl propiq-card ${
            mobileView === 'list' ? 'hidden lg:block' : ''
          }`}
        >
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="block h-auto w-full"
            role="img"
            aria-label={`${properties.length} scored properties across ${localities.length} localities, plotted on their real coordinates. The list beside this map carries the same information.`}
          >
            <defs>
              <pattern id="explorer-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                <path
                  d="M 32 0 L 0 0 0 32"
                  fill="none"
                  stroke="var(--border-subtle)"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            <rect width={VIEW_W} height={VIEW_H} fill="url(#explorer-grid)" />

            {on('localities') &&
              localities.map((l) => {
                // Layer values are shown for one locality at a time. Stacking
                // four lines over every marker made neighbouring blocks collide
                // and clipped the northern ones out of the viewBox — a legible
                // plot that answers on demand beats a complete one that cannot
                // be read.
                const focused =
                  hoveredLocality === l.slug ||
                  (hoveredLocality === undefined && active?.localitySlug === l.slug);
                const lines = focused ? annotationsFor(l, on) : [];
                return (
                  <g
                    key={l.id}
                    onPointerEnter={() => setHoveredLocality(l.slug)}
                    onPointerLeave={() => setHoveredLocality(undefined)}
                  >
                    <circle
                      cx={project.x(l.longitude)}
                      cy={project.y(l.latitude)}
                      r={34}
                      fill="var(--color-brand-blue-500)"
                      fillOpacity="0.07"
                      stroke="var(--color-brand-blue-500)"
                      strokeOpacity="0.28"
                      strokeDasharray="3 4"
                    />
                    <text
                      x={project.x(l.longitude)}
                      y={
                        project.y(l.latitude) -
                        LABEL_GAP -
                        LINE_H * annotationsFor(l, on).length -
                        2
                      }
                      textAnchor="middle"
                      fontSize="10.5"
                      fontWeight="600"
                      fill="var(--text-secondary)"
                    >
                      {l.name}
                    </text>
                    {lines.map((line, i, all) => (
                      <text
                        key={line}
                        x={project.x(l.longitude)}
                        y={project.y(l.latitude) - LABEL_GAP - LINE_H * (all.length - 1 - i)}
                        textAnchor="middle"
                        fontSize="9.5"
                        fill="var(--text-muted)"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}

            {on('properties') &&
              properties.map((p) => {
                const isActive = p.id === selected;
                return (
                  <g
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                    style={{ cursor: 'pointer' }}
                    role="presentation"
                  >
                    <circle
                      cx={project.x(p.longitude)}
                      cy={project.y(p.latitude)}
                      r={isActive ? 15 : 10}
                      fill={DECISION_COLOR[p.decision]}
                      fillOpacity={isActive ? 0.28 : 0.16}
                    />
                    <circle
                      cx={project.x(p.longitude)}
                      cy={project.y(p.latitude)}
                      r={isActive ? 7 : 5}
                      fill={DECISION_COLOR[p.decision]}
                      stroke="var(--surface-1)"
                      strokeWidth="1.6"
                    />
                    {p.propiqScore !== undefined && (
                      <text
                        x={project.x(p.longitude)}
                        y={project.y(p.latitude) + (isActive ? 26 : 20)}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="700"
                        fill={DECISION_COLOR[p.decision]}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {p.propiqScore.toFixed(0)}
                      </text>
                    )}
                    {/* One template literal, not three children: React
                        serialises adjacent text nodes inside an SVG <title>
                        differently on the server and the client, which is a
                        hydration mismatch. */}
                    <title>{`${p.name} — ${DECISION_LABELS[p.decision]}, ${formatINR(p.price)}`}</title>
                  </g>
                );
              })}
          </svg>

          {active && (
            <div className="absolute inset-x-3 bottom-3 rounded-lg propiq-card/95 p-3 backdrop-blur">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{active.name}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {active.locality} · {formatINR(active.price)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">
                    {active.verdictHeadline}
                  </p>
                </div>
                <span
                  data-figure
                  className="shrink-0 text-xl font-bold"
                  style={{ color: DECISION_COLOR[active.decision] }}
                >
                  {active.propiqScore === undefined ? '—' : active.propiqScore.toFixed(0)}
                </span>
              </div>
              <Link
                href={`/property/${active.slug}`}
                className="mt-2 inline-block text-xs font-medium text-[var(--text-accent)] hover:underline"
              >
                View intelligence →
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* The plot annotates one locality at a time so the labels stay legible.
          This is where the rest of them live: the same figures as text, so a
          keyboard or screen-reader user is never asked to hover for a number,
          and a touch user is never asked for a hover they cannot perform. */}
      {valueLayerRows.length > 0 && (
        <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-[var(--border-subtle)] pt-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {valueLayerRows.map((row) => (
            <div key={row.slug}>
              {/* Name above values rather than beside them: side by side, a
                  four-layer value string squeezes the name to nothing. */}
              <dt className="font-medium">{row.name}</dt>
              <dd data-figure className="mt-0.5 text-[var(--text-muted)]">
                {row.lines.join(' · ')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};
