/**
 * Comparison, why PropIQ, research, command centre, trust, closing call.
 *
 * The comparison table marks a winner per row only where the gap is wide
 * enough to mean something — the same `MIN_SPREAD` discipline the Decision
 * Room uses. Declaring a winner on a 0.4-point difference teaches a reader to
 * distrust the ones that are real.
 */

import Link from 'next/link';
import { ArrowRight, BookOpen, Check, Minus } from 'lucide-react';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { Section, SectionHead, DemoNote } from '@/components/site/section';
import { Tilt3D } from '@/components/site/tilt-3d';
import { formatINR, formatPercent, formatPsf } from '@/lib/utils';
import type { CommandCentreSnapshot, ResearchArticle, SiteProperty } from '@/site/types';

/* ------------------------------------------------------------- comparison */

/** Below this, two values are the same answer with different rounding. */
const MIN_SPREAD = { score: 4, pricePsf: 250, deviation: 3 } as const;

const bestBy = (
  values: ReadonlyArray<number | undefined>,
  spread: number,
  lowerWins = false,
): number | undefined => {
  const present = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== undefined);
  if (present.length < 2) return undefined;
  const sorted = [...present].sort((a, b) => (lowerWins ? a.v - b.v : b.v - a.v));
  const [first, second] = sorted;
  if (!first || !second) return undefined;
  return Math.abs(first.v - second.v) >= spread ? first.i : undefined;
};

export const ComparisonSection = ({ properties }: { properties: readonly SiteProperty[] }) => {
  const cols = properties.slice(0, 3);
  if (cols.length < 2) return null;

  const rows = [
    {
      label: 'PropIQ Score',
      values: cols.map((p) => (p.propiqScore === undefined ? '—' : p.propiqScore.toFixed(0))),
      winner: bestBy(
        cols.map((p) => p.propiqScore),
        MIN_SPREAD.score,
      ),
    },
    {
      label: 'Price',
      values: cols.map((p) => formatINR(p.price)),
      winner: bestBy(
        cols.map((p) => p.price),
        1,
        true,
      ),
    },
    {
      label: 'Price per sqft',
      values: cols.map((p) => formatPsf(p.pricePerSqFt)),
      winner: bestBy(
        cols.map((p) => p.pricePerSqFt),
        MIN_SPREAD.pricePsf,
        true,
      ),
    },
    {
      label: 'vs fair value',
      values: cols.map((p) =>
        p.fairValueMid === undefined
          ? 'Not valued'
          : `${p.priceDeviationPercent > 0 ? '+' : ''}${formatPercent(p.priceDeviationPercent, 1)}`,
      ),
      winner: bestBy(
        cols.map((p) => (p.fairValueMid === undefined ? undefined : p.priceDeviationPercent)),
        MIN_SPREAD.deviation,
        true,
      ),
    },
    {
      label: 'Evidence coverage',
      values: cols.map((p) => formatPercent(p.coverage * 100, 0)),
      winner: bestBy(
        cols.map((p) => p.coverage),
        0.05,
      ),
    },
    {
      label: 'Risk band',
      values: cols.map((p) => p.riskBand),
      winner: undefined,
    },
    {
      label: 'Verdict',
      values: cols.map((p) => DECISION_LABELS[p.decision]),
      winner: undefined,
    },
  ];

  return (
    <Section tone="deep">
      <SectionHead
        eyebrow="Comparison"
        title="Compare properties beyond price."
        standfirst="A winner is marked only where the gap clears a minimum meaningful spread. Below that the honest answer is that they are too close to call."
        action={
          <Link
            href="/compare"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
          >
            Open the Decision Room <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      />

      {/* The table scrolls sideways on a narrow screen and holds nothing
          focusable, so it needs its own tab stop or a keyboard user cannot
          reach the columns past the fold. */}
      <div
        tabIndex={0}
        role="group"
        aria-label="Property comparison table"
        className="mt-10 overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
      >
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Three properties compared across score, price, value and risk
          </caption>
          <thead>
            <tr className="bg-[var(--surface-1)]">
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium">
                Dimension
              </th>
              {cols.map((p) => (
                <th key={p.id} scope="col" className="px-4 py-3 text-left">
                  <span className="block text-sm font-semibold">{p.name}</span>
                  <span className="block text-xs font-normal text-[var(--text-muted)]">
                    {p.locality}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-[var(--border-subtle)]">
                <th scope="row" className="px-4 py-3 text-left text-xs font-medium">
                  {row.label}
                </th>
                {row.values.map((value, i) => (
                  <td
                    key={cols[i]?.id ?? i}
                    data-figure
                    className={`px-4 py-3 capitalize ${
                      row.winner === i
                        ? 'font-semibold text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {value}
                      {row.winner === i && (
                        <Check
                          aria-label="best on this dimension"
                          className="size-3.5 text-[var(--color-buy)]"
                        />
                      )}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DemoNote />
    </Section>
  );
};

/* -------------------------------------------------------------- why propiq */

const PORTAL = ['Listings', 'Photographs', 'Basic filters', 'A broker to call'] as const;
const PROPIQ = [
  'Property discovery',
  'A published score with a confidence band',
  'Fair value against comparable transactions',
  'Locality intelligence',
  'Developer delivery record',
  'Investment arithmetic',
  'Nine risk dimensions',
  'Side-by-side comparison',
  'The evidence behind every number',
] as const;

export const WhyPropIQ = () => (
  <Section tone="base">
    <SectionHead
      eyebrow="Why PropIQ"
      title="Property portals show you listings. PropIQ helps you decide."
      standfirst="Finding what is available was solved a decade ago. Knowing whether to buy it was not."
    />

    <div className="mt-10 grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-6">
        <h3 className="text-sm font-semibold text-[var(--text-muted)]">A property portal</h3>
        <ul className="mt-4 space-y-3">
          {PORTAL.map((item) => (
            <li
              key={item}
              className="flex items-center gap-2.5 text-sm text-[var(--text-secondary)]"
            >
              <Minus aria-hidden className="size-4 shrink-0 text-[var(--text-muted)]" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="propiq-brand-gradient rounded-xl p-px">
        <div className="h-full rounded-[11px] bg-[var(--surface-0)] p-6">
          <h3 className="propiq-brand-text text-sm font-semibold">PropIQ</h3>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {PROPIQ.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--text-accent)]" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  </Section>
);

/* ----------------------------------------------------------------- research */

export const ResearchSection = ({ articles }: { articles: readonly ResearchArticle[] }) => (
  <Section tone="raise">
    <SectionHead
      eyebrow="Research"
      title="Intelligence for better property decisions."
      standfirst="Every one of these opens a page that exists. A card promising a report nobody has written is the marketing version of a fabricated number."
    />

    <div className="mt-10 grid gap-8 md:grid-cols-3">
      {articles.map((article) => (
        <article key={article.slug} className="group flex flex-col">
          <div className="propiq-brand-gradient h-0.5 w-12" />
          <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
            {article.kicker}
          </p>
          <h3 className="mt-2 text-xl font-bold leading-snug tracking-tight">
            <Link href={article.href} className="hover:underline">
              {article.title}
            </Link>
          </h3>
          <p className="mt-3 flex-1 text-sm leading-relaxed text-[var(--text-secondary)]">
            {article.standfirst}
          </p>
          <p className="mt-4 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <BookOpen aria-hidden className="size-3.5" />
            {article.published} · {article.readMinutes} min read
          </p>
        </article>
      ))}
    </div>
  </Section>
);

/* ----------------------------------------------------------- command centre */

export const CommandCentre = ({ snapshot }: { snapshot: CommandCentreSnapshot }) => {
  const nav = ['Overview', 'Discover', 'Saved', 'Compare', 'Localities', 'Developers', 'Reports'];

  return (
    <Section tone="deep">
      <SectionHead
        eyebrow="Command centre"
        title="Your real-estate intelligence command centre."
        standfirst="Everything you track in one place, re-scored on every visit, with what moved since you last looked."
      />

      <Tilt3D className="mt-10" max={4} lift={16}>
        <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-1)]">
          <div className="grid lg:grid-cols-[180px_minmax(0,1fr)]">
            <nav
              aria-label="Command centre preview"
              className="hidden border-r border-[var(--border-subtle)] p-4 lg:block"
            >
              <ul className="space-y-1">
                {nav.map((item, i) => (
                  <li key={item}>
                    <span
                      className={`block rounded-md px-3 py-2 text-sm ${
                        i === 0
                          ? 'bg-[var(--surface-2)] font-medium text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="p-5 sm:p-6">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Tile
                  label="Mean PropIQ Score"
                  value={snapshot.meanScore === undefined ? '—' : snapshot.meanScore.toFixed(0)}
                />
                <Tile label="Properties tracked" value={String(snapshot.tracked)} />
                <Tile label="Under fair value" value={String(snapshot.opportunities)} />
                <Tile label="Material risks" value={String(snapshot.materialRisks)} />
              </div>

              <div className="mt-5 rounded-xl border border-[var(--border-subtle)] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  How the verdicts fall
                </p>
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                  {snapshot.verdictCounts
                    .filter((c) => c.count > 0)
                    .map((c) => (
                      <li key={c.decision} className="text-xs text-[var(--text-secondary)]">
                        {DECISION_LABELS[c.decision]}{' '}
                        <span data-figure className="font-semibold text-[var(--text-primary)]">
                          {c.count}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>

              <ul className="mt-5 space-y-2">
                {snapshot.alerts.map((alert) => (
                  <li
                    key={alert.label}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)]/60 p-3"
                  >
                    <p className="text-sm font-medium">{alert.label}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)]">{alert.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Tilt3D>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/dashboard"
          className="propiq-brand-gradient inline-flex h-11 items-center rounded-lg px-5 text-sm font-semibold text-white"
        >
          Open the dashboard
        </Link>
        <Link
          href="/dashboard/notifications"
          className="inline-flex h-11 items-center rounded-lg border border-[var(--border-strong)] px-5 text-sm font-semibold"
        >
          See notifications
        </Link>
      </div>
      <DemoNote>
        Every figure in this panel is derived from the covered market on this deployment, not
        authored for the screenshot.
      </DemoNote>
    </Section>
  );
};

/* -------------------------------------------------------------------- trust */

const CAPABILITIES = [
  {
    title: 'Structured property intelligence',
    body: 'Every material fact carries a status, a source, an observation date and a confidence that decays with age.',
  },
  {
    title: 'Multi-factor analysis',
    body: 'Twelve scoring pillars and nine risk dimensions, each scored separately before anything is combined.',
  },
  {
    title: 'Transparent scoring',
    body: 'The formula and the weights are published in-product and rendered from the running code, so they cannot drift.',
  },
  {
    title: 'Locality-level insight',
    body: 'Commute, supply overhang, environment and the funded infrastructure pipeline, separate from the building.',
  },
  {
    title: 'Decision-focused research',
    body: 'Free tools and document checks that work on what you type, with nothing uploaded and nothing stored.',
  },
  {
    title: 'Built for verified data',
    body: 'Ports and adapters throughout: point it at a live feed and every screen works unchanged.',
  },
] as const;

export const TrustLayer = () => (
  <Section tone="base">
    <SectionHead
      eyebrow="What this is built on"
      title="Capability, not customer logos."
      standfirst="No testimonials and no client badges appear here, because none have been earned yet. What can be shown is what the product actually does."
    />
    <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {CAPABILITIES.map((c) => (
        <div
          key={c.title}
          className="h-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5"
        >
          <h3 className="text-sm font-semibold">{c.title}</h3>
          <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{c.body}</p>
        </div>
      ))}
    </div>
  </Section>
);

/* ---------------------------------------------------------------- final cta */

export const FinalCTA = () => (
  <section className="propiq-dark relative overflow-hidden border-t border-[var(--border-subtle)]">
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-70"
      style={{
        background:
          'radial-gradient(ellipse 70% 60% at 25% 0%, rgba(59,99,239,0.34), transparent 65%),' +
          'radial-gradient(ellipse 60% 60% at 80% 100%, rgba(139,124,240,0.30), transparent 68%)',
      }}
    />
    <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:py-28">
      <h2 className="text-[2rem] font-bold leading-[1.1] tracking-tight sm:text-5xl">
        <span className="block">Don&rsquo;t just find a property.</span>
        <span className="propiq-brand-text block">Understand it.</span>
      </h2>
      <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-[var(--text-secondary)]">
        Compare projects, evaluate locations and uncover the signals behind a smarter property
        decision.
      </p>
      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <Link
          href="/search"
          className="propiq-brand-gradient inline-flex h-12 items-center gap-2 rounded-lg px-7 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Analyze a Property <ArrowRight aria-hidden className="size-4" />
        </Link>
        <Link
          href="/localities"
          className="inline-flex h-12 items-center rounded-lg border border-white/20 px-7 text-sm font-semibold text-white transition-colors hover:bg-white/5"
        >
          Explore Properties
        </Link>
      </div>
      <p className="mt-5 text-xs text-[var(--text-muted)]">
        Start with a property, a project, or a locality.
      </p>
    </div>
  </section>
);

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-2)]/50 p-4">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </p>
    <p data-figure className="mt-1.5 text-2xl font-bold tracking-tight">
      {value}
    </p>
  </div>
);
