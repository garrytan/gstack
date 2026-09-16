/**
 * The intelligence panels: price, investment, developer, risk, locality.
 *
 * Each is a projection of the engine's output for the showcase property or
 * the covered market. None of them holds a figure of its own, and every one
 * shows an honest absence where the dataset has a gap — "not valued", "no
 * record", a missing tile — rather than filling it.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Section, SectionHead, DemoNote } from '@/components/site/section';
import { PriceHistoryChart } from '@/components/propiq/price-history-chart';
import { LocalityPriceChart } from '@/components/site/locality-price-chart';
import { LocalityAccess } from '@/components/site/locality-access';
import { formatINR, formatPercent, formatPsf } from '@/lib/utils';
import type { DeveloperProfile, SiteLocality, SiteProperty } from '@/site/types';

/* ------------------------------------------------------------------ price */

export const PriceIntelligence = ({
  property,
  locality,
  localities,
}: {
  property: SiteProperty;
  locality: SiteLocality | undefined;
  localities: readonly SiteLocality[];
}) => {
  const under = property.priceDeviationPercent < 0;
  const position =
    property.fairValueMid === undefined
      ? 'Not valued'
      : Math.abs(property.priceDeviationPercent) < 5
        ? 'Fair'
        : under
          ? 'Below fair value'
          : 'Premium';

  // A scale wide enough to hold both the band and the asking price.
  const low = property.fairValueLow ?? property.price;
  const high = property.fairValueHigh ?? property.price;
  const from = Math.min(low, property.price) * 0.985;
  const to = Math.max(high, property.price) * 1.015;
  const at = (v: number) => ((v - from) / (to - from)) * 100;

  return (
    <Section tone="deep">
      <SectionHead
        eyebrow="Price intelligence"
        title="Is the property fairly priced?"
        standfirst="The asking price against a band built from comparable transactions, adjusted onto a carpet-area basis and carried with its own confidence."
      />

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5 sm:p-6">
          {property.fairValueMid === undefined ? (
            <p className="text-sm text-[var(--text-secondary)]">
              Not enough comparable transactions to publish a fair-value band for this property.
              That is reported rather than estimated around.
            </p>
          ) : (
            <>
              <div className="relative h-12">
                <span
                  className="absolute top-5 h-2 rounded-full bg-[var(--color-brand-blue-500)]/30"
                  style={{ left: `${at(low)}%`, width: `${at(high) - at(low)}%` }}
                />
                <span
                  className="absolute top-3 h-6 w-0.5 rounded bg-[var(--color-brand-blue-500)]"
                  style={{ left: `${at(property.fairValueMid)}%` }}
                />
                <span
                  className="absolute top-2 h-8 w-[3px] rounded"
                  style={{
                    left: `${at(property.price)}%`,
                    background: under ? 'var(--color-buy)' : 'var(--color-avoid)',
                  }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
                <span data-figure>{formatINR(low)}</span>
                <span data-figure>central {formatINR(property.fairValueMid)}</span>
                <span data-figure>{formatINR(high)}</span>
              </div>
              <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                <Legend colour="var(--color-brand-blue-500)" label="Fair-value band and centre" />
                <Legend
                  colour={under ? 'var(--color-buy)' : 'var(--color-avoid)'}
                  label={`Asking ${formatINR(property.price)}`}
                />
              </ul>
            </>
          )}

          <dl className="mt-6 grid grid-cols-2 gap-5 border-t border-[var(--border-subtle)] pt-5 sm:grid-cols-4">
            <Metric label="Project price" value={formatPsf(property.pricePerSqFt)} />
            <Metric
              label="On carpet"
              value={
                property.carpetPricePerSqFt === undefined
                  ? '—'
                  : formatPsf(property.carpetPricePerSqFt)
              }
            />
            <Metric
              label="Locality median"
              value={
                locality?.medianPricePerSqFt === undefined
                  ? '—'
                  : formatPsf(locality.medianPricePerSqFt)
              }
            />
            <Metric
              label="Price position"
              value={position}
              tone={
                property.fairValueMid === undefined
                  ? undefined
                  : under
                    ? 'var(--color-buy)'
                    : 'var(--color-avoid)'
              }
            />
          </dl>
        </div>

        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5 sm:p-6">
          <h3 className="text-sm font-semibold">What the gap means</h3>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            {property.fairValueMid === undefined
              ? 'With too few comparables, a price position would be a guess dressed as a measurement.'
              : `${property.name} asks ${formatINR(property.price)}, which is ${formatPercent(
                  Math.abs(property.priceDeviationPercent),
                  1,
                )} ${under ? 'below' : 'above'} the central estimate from its comparable set. ${
                  under
                    ? 'A price below the band is a reason to move quickly, not a reason to stop checking why.'
                    : 'A premium can be justified by developer record or connectivity — the pillar scores above say whether it is here.'
                }`}
          </p>
          <Link
            href="/valuation"
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
          >
            How fair value is computed <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5">
          <h3 className="text-sm font-semibold">
            {locality ? `${locality.name} price trend` : 'Price trend'}
          </h3>
          <p className="mb-3 mt-1 text-xs text-[var(--text-muted)]">
            Recorded median per square foot over the periods on file.
          </p>
          {locality && locality.priceHistory.length >= 2 ? (
            <PriceHistoryChart history={locality.priceHistory} />
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center text-xs text-[var(--text-muted)]">
              Not enough recorded history to draw a trend for this locality.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5">
          <h3 className="text-sm font-semibold">Across the covered market</h3>
          <p className="mb-3 mt-1 text-xs text-[var(--text-muted)]">
            Where this locality sits against the others we score.
          </p>
          <LocalityPriceChart localities={localities} highlight={locality?.slug} />
        </div>
      </div>

      <DemoNote />
    </Section>
  );
};

/* ------------------------------------------------------------- investment */

export const InvestmentIntelligence = ({
  property,
  locality,
}: {
  property: SiteProperty;
  locality: SiteLocality | undefined;
}) => (
  <Section tone="base">
    <SectionHead
      eyebrow="Investment intelligence"
      title="See the investment case clearly."
      standfirst="Yield, the cost of the money, and what the return depends on. Computed by arithmetic — a language model never touches an IRR here."
      action={
        <Link
          href="/investment"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
        >
          Full method <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    />

    <div className="mt-10 grid auto-rows-[minmax(120px,auto)] gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Bento
        span="lg:col-span-2 lg:row-span-2"
        label="Gross rental yield"
        value={
          property.rentalYieldPercent === undefined
            ? 'Not computed'
            : formatPercent(property.rentalYieldPercent, 2)
        }
        note={
          property.monthlyRent
            ? `From an expected ${formatINR(property.monthlyRent)} a month against the asking price. Net yield on all capital deployed is lower — stamp duty and registration are capital you do not see again.`
            : 'No expected rent recorded for this unit, so a yield would be invented rather than measured.'
        }
        large
      />
      <Bento label="Verdict" value={property.decision.replace(/_/g, ' ').toLowerCase()} />
      <Bento label="Risk band" value={property.riskBand} />
      <Bento
        label="vs fair value"
        value={
          property.fairValueMid === undefined
            ? '—'
            : `${property.priceDeviationPercent > 0 ? '+' : ''}${formatPercent(property.priceDeviationPercent, 1)}`
        }
      />
      <Bento
        label="Evidence coverage"
        value={formatPercent(property.coverage * 100, 0)}
        note="of the scoring weight"
      />

      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5 sm:col-span-2 lg:col-span-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Infrastructure catalysts
        </p>
        {locality && locality.catalysts.length > 0 ? (
          <>
            <ul className="mt-3 flex flex-wrap gap-2">
              {locality.catalysts.map((item) => (
                <li
                  key={item.name}
                  className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-1)] px-3 py-1.5 text-xs"
                >
                  {item.name}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                    {item.status.replace(/([A-Z])/g, ' $1').toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-[var(--text-muted)]">
              Only funded, under construction and commissioned projects are counted. An announcement
              is not infrastructure, and scoring it as though it were is how a corridor gets priced
              for a metro line that never arrives.
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            Nothing funded or under construction on file for this locality. That is reported rather
            than filled in with announcements.
          </p>
        )}
      </div>
    </div>
    <DemoNote />
  </Section>
);

/* -------------------------------------------------------------- developer */

export const DeveloperIntelligence = ({
  developers,
}: {
  developers: readonly DeveloperProfile[];
}) => (
  <Section tone="raise">
    <SectionHead
      eyebrow="Developer intelligence"
      title="Know who is building it."
      standfirst="Delivery record, average handover delay and complaints on file. Deliberately no separate trust score: developer track record is already a weighted pillar inside the PropIQ Score, and a second differently-computed number would give the page two answers to one question."
      action={
        <Link
          href="/developers"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
        >
          All developers <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    />

    <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {developers.slice(0, 3).map((d) => (
        <article
          key={d.id}
          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5"
        >
          <h3 className="text-base font-semibold">{d.name}</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {d.headquarters ?? 'Headquarters not recorded'}
            {d.incorporatedYear ? ` · since ${d.incorporatedYear}` : ''}
          </p>
          <dl className="mt-4 space-y-2.5">
            <Row label="Projects delivered" value={d.projectsDelivered} />
            <Row label="Units delivered" value={d.unitsDelivered} />
            <Row
              label="Average handover delay"
              value={d.averageDelayMonths}
              suffix=" months"
              invert
            />
            <Row label="RERA complaints on file" value={d.reraComplaintsCount} invert />
            <Row label="Ongoing litigation" value={d.ongoingLitigationCount} invert />
          </dl>
        </article>
      ))}
    </div>
    <DemoNote>
      Developer names in this dataset are invented. No real developer is described, and no figure
      here is a claim about a real company.
    </DemoNote>
  </Section>
);

/* ------------------------------------------------------------------- risk */

const RISK_TONE: Readonly<Record<string, string>> = {
  low: 'var(--color-buy)',
  moderate: 'var(--color-watch)',
  elevated: 'var(--color-negotiate)',
  high: 'var(--color-avoid)',
  severe: 'var(--color-avoid)',
};

export const RiskIntelligence = ({ property }: { property: SiteProperty }) => (
  <Section tone="base">
    <SectionHead
      eyebrow="Risk intelligence"
      title="Understand what could go wrong."
      standfirst="Nine dimensions scored separately rather than rolled into one reassuring number. A dimension with no evidence says so."
    />

    <div className="mt-10 flex flex-wrap items-center gap-4">
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] px-6 py-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Composite risk
        </p>
        <p
          data-figure
          className="mt-1 text-2xl font-bold capitalize"
          style={{ color: RISK_TONE[property.riskBand] ?? 'var(--text-primary)' }}
        >
          {property.riskBand}
        </p>
      </div>
      <p className="max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
        {property.materialRisks.length === 0
          ? 'Nothing on this property cleared the materiality bar. That is a statement about the evidence available, not a guarantee.'
          : `${property.materialRisks.length} dimension${
              property.materialRisks.length === 1 ? '' : 's'
            } cleared the materiality bar: ${property.materialRisks.join(', ')}.`}
      </p>
    </div>

    <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {property.watchItems.slice(0, 6).map((item) => (
        <li
          key={item}
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-4 text-xs leading-relaxed text-[var(--text-secondary)]"
        >
          {item}
        </li>
      ))}
      {property.watchItems.length === 0 && (
        <li className="rounded-lg border border-dashed border-[var(--border-strong)] p-4 text-xs text-[var(--text-muted)]">
          No material concerns in the evidence for this property.
        </li>
      )}
    </ul>
    <DemoNote />
  </Section>
);

/* --------------------------------------------------------------- locality */

export const LocalityIntelligence = ({ locality }: { locality: SiteLocality }) => (
  <Section tone="base">
    <SectionHead
      eyebrow="Locality intelligence"
      title="Understand the location before the property."
      standfirst="A flat can be improved. Its commute, its water table and what is approved to be built next door cannot."
      action={
        <Link
          href={`/locality/${locality.slug}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
        >
          Full locality workup <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    />

    <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {locality.city}
        </p>
        <h3 className="mt-1 text-3xl font-bold tracking-tight">{locality.name}</h3>
        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
          {locality.summary}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {locality.indicators.map((ind) => (
          <div
            key={ind.label}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-4"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {ind.label}
            </p>
            <p data-figure className="mt-1.5 text-lg font-semibold">
              {ind.value}
            </p>
            {ind.detail && (
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
                {ind.detail}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>

    <div className="mt-6">
      <LocalityAccess locality={locality} />
    </div>
    <DemoNote />
  </Section>
);

/* ---------------------------------------------------------------- helpers */

const Legend = ({ colour, label }: { colour: string; label: string }) => (
  <li className="flex items-center gap-1.5 text-[var(--text-secondary)]">
    <span aria-hidden className="h-3 w-0.5 rounded" style={{ background: colour }} />
    {label}
  </li>
);

const Metric = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
  <div>
    <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </dt>
    <dd
      data-figure
      className="mt-1 text-base font-semibold"
      style={tone ? { color: tone } : undefined}
    >
      {value}
    </dd>
  </div>
);

const Bento = ({
  label,
  value,
  note,
  span,
  large = false,
}: {
  label: string;
  value: string;
  note?: string;
  span?: string;
  large?: boolean;
}) => (
  <div
    // `justify-between` keeps figures on a baseline across a row of equal
    // tiles, but on the tall spanning tile it strands the label at the top of
    // a half-empty box. That one reads top-down instead.
    className={`flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5 ${large ? 'justify-start' : 'justify-between'} ${span ?? ''}`}
  >
    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </p>
    <div className="mt-2">
      <p
        data-figure
        className={`font-bold capitalize tracking-tight ${large ? 'text-4xl' : 'text-xl'}`}
      >
        {value}
      </p>
      {note && (
        <p className="mt-2 max-w-md text-xs leading-relaxed text-[var(--text-secondary)]">{note}</p>
      )}
    </div>
  </div>
);

const Row = ({
  label,
  value,
  suffix = '',
  invert = false,
}: {
  label: string;
  value: number | undefined;
  suffix?: string;
  invert?: boolean;
}) => (
  <div className="flex items-center justify-between gap-3 text-xs">
    <dt className="text-[var(--text-muted)]">{label}</dt>
    <dd
      data-figure
      className="font-semibold"
      style={
        value !== undefined && invert && value > 0 ? { color: 'var(--color-negotiate)' } : undefined
      }
    >
      {value === undefined ? 'No record' : `${value.toLocaleString('en-IN')}${suffix}`}
    </dd>
  </div>
);
