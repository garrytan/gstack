import Link from 'next/link';
import {
  ArrowRight,
  Check,
  ClipboardCheck,
  FileSearch,
  Gavel,
  Landmark,
  Ruler,
  ScanSearch,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { getPropertyRepository } from '@/data';
import { buildPropertyIntelligence, buildSummaries, summariseMarket } from '@/server/intelligence';
import type { MarketSummary } from '@/server/intelligence';
import { DECISION_LABELS } from '@/domain/decision/engine';
import type { Decision } from '@/domain/decision/engine';
import { formatINR, formatPercent } from '@/lib/utils';
import { loadBuyerProfile } from '@/server/actions';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { PropertyCard } from '@/components/propiq/property-card';
import { SearchBar } from '@/components/propiq/search-bar';
import { MarketMap } from '@/components/propiq/market-map';
import type { MapProperty } from '@/components/propiq/market-map';
import { CommandRail } from '@/components/propiq/command-rail';
import { HeroVerdictCard } from '@/components/propiq/hero-verdict-card';
import { TrackView } from '@/components/propiq/track-view';

export const dynamic = 'force-dynamic';

const JOURNEY = [
  { label: 'Discover', detail: 'Find the shortlist that matches how you actually buy.' },
  { label: 'Verify', detail: 'RERA, developer record and title signals, with dates on them.' },
  { label: 'Compare', detail: 'Side by side on the dimensions that decide it.' },
  { label: 'Score', detail: 'Twelve pillars, persona-weighted, published formula.' },
  { label: 'Analyze', detail: 'Fair value, yield, IRR, and what breaks the model.' },
  { label: 'Negotiate', detail: 'An opening number and a walk-away number.' },
] as const;

const EXAMPLE_QUERIES = ['Whitefield 3 BHK', 'Sarjapur Road', 'ready to move'] as const;

const FREE_TOOLS = [
  {
    href: '/tools/carpet-area',
    title: 'Carpet vs super built-up',
    icon: Ruler,
    blurb:
      'Two flats at the same advertised rate can differ by a fifth in usable space. Compare them on the rate that counts.',
  },
  {
    href: '/tools/emi',
    title: 'Home loan EMI',
    icon: Landmark,
    blurb:
      'The instalment, plus the number nobody shows you: what the loan costs over its whole life.',
  },
  {
    href: '/tools/rental-yield',
    title: 'Rental yield',
    icon: TrendingUp,
    blurb:
      'Gross yield is quoted. Net yield on every rupee you deployed is what decides the investment.',
  },
  {
    href: '/site-visit-checklist',
    title: 'Site visit checklist',
    icon: ClipboardCheck,
    blurb:
      '22 things you can only learn standing there, each with why it matters. Print it or send it on.',
  },
] as const;

/** Each of these is enforced by a test, which is why it is safe to claim. */
const HERO_PROOF = [
  'Published formula',
  '95% confidence band on every score',
  'No score produced by a language model',
] as const;

const DECISION_COLOR: Readonly<Record<Decision, string>> = {
  BUY: 'var(--color-buy)',
  NEGOTIATE: 'var(--color-negotiate)',
  WATCH: 'var(--color-watch)',
  AVOID: 'var(--color-avoid)',
  INSUFFICIENT_EVIDENCE: 'var(--color-unknown)',
};

export default async function HomePage() {
  const repo = getPropertyRepository();

  // One scoring pass feeds the map, the rail and the cards, so the three can
  // never disagree about the same property.
  const [{ items }, localities, profile] = await Promise.all([
    repo.search({ pageSize: 48 }),
    repo.listLocalities(),
    loadBuyerProfile(),
  ]);
  const intelligence = await buildSummaries(items, {
    persona: profile?.persona,
    buyer: profile,
  });

  const mapProperties: MapProperty[] = intelligence.map((i) => ({
    id: i.property.id,
    title: i.property.title,
    lat: i.property.location.lat,
    lng: i.property.location.lng,
    decision: i.decision.decision,
    score: i.score.score,
    askingPrice: i.property.askingPrice,
  }));

  const market = summariseMarket(intelligence);

  const ranked = [...intelligence].sort((a, b) => (b.score.score ?? -1) - (a.score.score ?? -1));
  const featured = ranked.slice(0, 3);

  // The hero card shows one real verdict, and the negotiation ladder is part
  // of what makes it worth showing. `buildSummaries` skips negotiation, so the
  // headline property is re-run through the full use case — the same one the
  // Property Intelligence Page calls, so the two cannot disagree.
  const showcase = ranked[0]
    ? await buildPropertyIntelligence(ranked[0].property.id, {
        persona: profile?.persona,
        buyer: profile,
        includeAlternatives: false,
      })
    : undefined;

  return (
    <>
      <TrackView event="property_viewed" properties={{ surface: 'home' }} />

      {/* ---------------- Hero: the decision desk ----------------
          A single dark instrument band in both themes. The product is
          dark-led and analytical, and a headline floating on white gave the
          page no anchor at all. Everything inside it is a real figure from
          the same scoring pass that feeds the map, the rail and the cards. */}
      <section className="relative isolate overflow-hidden bg-ink-950 text-ink-50">
        {/* Three layers of depth, none of them moving: a graticule that fades
            out, one warm glow behind the headline, one cool glow behind the
            card. Decoration that says "instrument" rather than "landing page". */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.055) 1px, transparent 1px),' +
              'linear-gradient(to bottom, rgba(255,255,255,0.055) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'radial-gradient(ellipse 85% 75% at 45% 0%, #000 50%, transparent 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 85% 75% at 45% 0%, #000 50%, transparent 100%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-40 -top-52 size-[42rem] rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgba(31,179,168,0.30) 0%, rgba(31,179,168,0.07) 45%, transparent 70%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 top-24 size-[38rem] rounded-full"
          style={{
            background:
              'radial-gradient(circle, rgba(74,127,181,0.26) 0%, rgba(74,127,181,0.06) 48%, transparent 72%)',
          }}
        />
        {/* A hairline that picks the band back up at the fold. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
          style={{
            background:
              'linear-gradient(to right, transparent, rgba(77,208,199,0.45), transparent)',
          }}
        />

        <div className="relative mx-auto max-w-7xl px-4 pb-14 pt-14 sm:pb-16 sm:pt-20">
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-14">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-accent-400">
                <span aria-hidden className="propiq-live-dot size-1.5 rounded-full bg-accent-400" />
                Property decision intelligence
              </p>

              <h1 className="mt-5 text-[2.6rem] font-bold leading-[1.02] sm:text-5xl lg:text-[3.5rem]">
                <span className="block">Know what it is worth</span>
                <span className="block text-accent-400">before you sign.</span>
              </h1>

              <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-300">
                Twelve pillars, a published formula, and the evidence behind every number. PropIQ
                tells you whether to buy, negotiate, watch or walk — and when the evidence is thin,
                it says so instead of guessing.
              </p>

              <div className="mt-8 max-w-xl">
                <SearchBar />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-400">Try</span>
                  {EXAMPLE_QUERIES.map((q) => (
                    <Link
                      key={q}
                      href={`/search?q=${encodeURIComponent(q)}`}
                      className="rounded-full border border-ink-700 px-2.5 py-1 text-xs text-ink-300 transition-colors hover:border-accent-500 hover:text-ink-50"
                    >
                      {q}
                    </Link>
                  ))}
                </div>
              </div>

              <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-400">
                {HERO_PROOF.map((p) => (
                  <li key={p} className="flex items-center gap-1.5">
                    <Check aria-hidden className="size-3.5 text-accent-400" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>

            {showcase && (
              <div className="min-w-0 lg:pt-8">
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
                  What that looks like, on a real property
                </p>
                <HeroVerdictCard intel={showcase} />
              </div>
            )}
          </div>

          <HeroStrip market={market} localityCount={localities.length} />
        </div>
      </section>

      {/* ---------------- The live desk: map + rail ---------------- */}
      <section className="border-b border-[var(--border-subtle)]">
        <div className="mx-auto max-w-7xl px-4 py-10">
          {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">The covered market</h2>
              <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
                Every property we can score, on its real coordinates, coloured by the verdict the
                engine reached. Halo size is the locality median, not a listing count.
              </p>
            </div>
            <Link
              href="/localities"
              className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent-500 hover:underline"
            >
              Locality detail <ArrowRight aria-hidden className="size-4" />
            </Link>
          </div>

          <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="min-w-0">
              <MarketMap localities={localities} properties={mapProperties} />
            </div>
            <CommandRail intelligence={intelligence} />
          </div>
        </div>
      </section>

      {/* ---------------- Journey ----------------
          Numbered because the order is real: each step depends on what the
          one before it established. A rail rather than six loose cards, so
          the sequence is visible rather than asserted. */}
      <section className="mx-auto max-w-7xl px-4 py-14">
        <div className="max-w-2xl">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-500">
            The journey
          </h2>
          <p className="mt-3 text-2xl font-semibold tracking-tight">
            Eight steps, in the order a buyer actually moves
          </p>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Each one depends on what the step before it established. Verify before you compare;
            score before you negotiate.
          </p>
        </div>

        <ol className="relative mt-8 grid gap-px overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--border-subtle)] sm:grid-cols-2 lg:grid-cols-3">
          {JOURNEY.map((step, i) => (
            <li key={step.label} className="group relative bg-[var(--surface-0)] p-5">
              <div className="flex items-baseline gap-3">
                <span data-figure className="text-[11px] font-semibold text-accent-500" aria-hidden>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <p className="text-base font-semibold tracking-tight">{step.label}</p>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                {step.detail}
              </p>
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-accent-500 transition-transform duration-200 group-hover:scale-x-100"
              />
            </li>
          ))}
        </ol>
      </section>

      {/* ---------------- Scored properties ---------------- */}
      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Highest scoring right now</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Every card carries its verdict, its score, and the data status behind it.
            </p>
          </div>
          <Link
            href="/search"
            className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent-500 hover:underline"
          >
            See all <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {featured.map((intel) => (
            <PropertyCard key={intel.property.id} intelligence={intel} />
          ))}
        </div>
      </section>

      {/* ---------------- Free tools ----------------
          The part of the product that needs no account and no dataset. It
          works today for any property in any Indian market, which is why it
          sits on the homepage rather than behind a signup. */}
      <section className="border-y border-[var(--border-subtle)] bg-[var(--surface-1)]">
        <div className="mx-auto max-w-7xl px-4 py-14">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-500">
                Free, no account
              </h2>
              <p className="mt-3 text-2xl font-semibold tracking-tight">
                The arithmetic, open to anyone
              </p>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                These depend on figures you supply, not on our data, so they are correct for any
                property anywhere in India. Nothing you type is sent anywhere or stored — use them
                on a builder&rsquo;s sofa if you like.
              </p>
            </div>
            <Link
              href="/tools"
              className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent-500 hover:underline"
            >
              All tools <ArrowRight aria-hidden className="size-4" />
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FREE_TOOLS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="group rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-4 transition-colors hover:border-accent-500"
              >
                <t.icon aria-hidden className="size-5 text-accent-500" />
                <h3 className="mt-3 text-sm font-semibold">{t.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
                  {t.blurb}
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-500">
                  Open
                  <ArrowRight
                    aria-hidden
                    className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- Commitments ----------------
          Four refusals, each enforced by a test rather than a promise. This
          is the product's central claim, so it gets the weight of one. */}
      <section className="relative overflow-hidden bg-ink-950 text-ink-50">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px),' +
              'linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'radial-gradient(ellipse 70% 100% at 50% 100%, #000 40%, transparent 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 70% 100% at 50% 100%, #000 40%, transparent 100%)',
          }}
        />
        <div className="relative mx-auto max-w-7xl px-4 py-16">
          <div className="max-w-2xl">
            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-400">
              What PropIQ refuses to do
            </h2>
            <p className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              Four refusals, each one a failing build rather than a promise
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-300">
              A measurement product is only worth what its worst incentive lets it be. These are
              enforced in the test suite, so breaking one does not ship.
            </p>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-ink-800 bg-ink-800 sm:grid-cols-2 lg:grid-cols-4">
            <Commitment
              icon={ScanSearch}
              title="No invented facts"
              body="If we do not have a number, the field reads unknown. The scoring engine excludes it and rescales, so a gap never reads as a zero."
            />
            <Commitment
              icon={ShieldCheck}
              title="No black-box scoring"
              body="Every pillar expands into its signals, the raw value observed, and the exact normalisation applied. The weights are published."
            />
            <Commitment
              icon={FileSearch}
              title="No stale data in disguise"
              body="Every figure carries an observation date and decays in confidence against its source's half-life. A year-old asking price is not evidence."
            />
            <Commitment
              icon={Gavel}
              title="No paid verdicts"
              body="Commercial relationships are disclosed on every property and are computed in a system the scoring engine cannot read."
            />
          </div>

          <p className="mt-6 text-xs text-ink-400">
            <Link href="/methodology" className="text-accent-400 hover:underline">
              Read the published methodology
            </Link>{' '}
            — weights, thresholds and evidence half-lives, rendered from the running code.
          </p>
        </div>
      </section>
    </>
  );
}

/**
 * The live figures, in the hero rather than buried below it.
 *
 * Coverage and the insufficient-evidence count sit beside the good news on
 * purpose: a measurement product should be judged on what it could not
 * measure, not only on what it could.
 */
const HeroStrip = ({ market, localityCount }: { market: MarketSummary; localityCount: number }) => {
  const present = market.counts.filter((c) => c.count > 0);
  const gap = market.bestValue;

  return (
    <div className="mt-14 border-t border-ink-800 pt-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            How the verdicts fall right now
          </p>
          <div
            className="mt-3 flex h-2 overflow-hidden rounded-full bg-ink-800"
            role="img"
            aria-label={present.map((c) => `${c.count} ${DECISION_LABELS[c.decision]}`).join(', ')}
          >
            {present.map((c) => (
              <span
                key={c.decision}
                style={{
                  width: `${(c.count / market.total) * 100}%`,
                  background: DECISION_COLOR[c.decision],
                }}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {present.map((c) => (
              <li key={c.decision} className="flex items-center gap-1.5 text-xs text-ink-300">
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ background: DECISION_COLOR[c.decision] }}
                />
                {DECISION_LABELS[c.decision]}
                <span data-figure className="font-semibold text-ink-50">
                  {c.count}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <HeroFigure
            label="Scored"
            value={String(market.total)}
            note={`in ${localityCount} localities`}
          />
          <HeroFigure
            label="Mean score"
            value={market.meanScore === undefined ? '—' : market.meanScore.toFixed(0)}
            note="of 100"
          />
          <HeroFigure
            label="Coverage"
            value={formatPercent(market.meanCoverage * 100, 0)}
            note="of weight"
          />
          <HeroFigure label="Material risks" value={String(market.materialRisks)} note="surfaced" />
        </dl>
      </div>

      {gap && (
        <p className="mt-7 text-sm text-ink-300">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            Widest gap to fair value
          </span>
          <br />
          <Link
            href={`/property/${gap.property.id}`}
            className="font-medium text-ink-50 underline-offset-4 hover:underline"
          >
            {gap.property.title}
          </Link>{' '}
          <span data-figure>
            asks {formatINR(gap.property.askingPrice)} —{' '}
            <span className="font-semibold text-buy">
              {formatPercent(Math.abs(gap.valuation.askingDeviationPercent), 1)} under
            </span>{' '}
            our central estimate.
          </span>
        </p>
      )}
    </div>
  );
};

const HeroFigure = ({ label, value, note }: { label: string; value: string; note: string }) => (
  <div>
    <dt className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
      {label}
    </dt>
    <dd
      data-figure
      className="mt-1 flex items-baseline gap-1.5 text-2xl font-semibold tracking-tight"
    >
      {value}
      <span className="whitespace-nowrap text-[11px] font-normal text-ink-400">{note}</span>
    </dd>
  </div>
);

const Commitment = ({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}) => (
  <article className="bg-ink-950 p-5">
    <Icon aria-hidden className="size-5 text-accent-400" />
    <h3 className="mt-3 text-sm font-semibold text-ink-50">{title}</h3>
    <p className="mt-2 text-xs leading-relaxed text-ink-400">{body}</p>
  </article>
);
