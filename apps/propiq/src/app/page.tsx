import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { loadHomePageData } from '@/site/data/page-data';
import { DemoDataBanner, NoDataNotice } from '@/components/propiq/data-status';
import { TrackView } from '@/components/propiq/track-view';
import { SiteHeader } from '@/components/site/site-header';
import { SiteFooter } from '@/components/site/site-footer';
import { HeroSection } from '@/components/site/hero-section';
import { SmartSearch } from '@/components/site/smart-search';
import { SitePropertyRail } from '@/components/site/property-card';
import { Section, SectionHead, DemoNote } from '@/components/site/section';
import { ScoreSection } from '@/components/site/score-section';
import { VerdictSection } from '@/components/site/verdict-section';
import { MapExplorer } from '@/components/site/map-explorer';
import {
  DeveloperIntelligence,
  InvestmentIntelligence,
  LocalityIntelligence,
  PriceIntelligence,
  RiskIntelligence,
} from '@/components/site/intelligence-sections';
import {
  CommandCentre,
  ComparisonSection,
  FinalCTA,
  ResearchSection,
  TrustLayer,
  WhyPropIQ,
} from '@/components/site/closing-sections';
import { ShortlistProvider } from '@/components/site/shortlist';
import { BottomDock } from '@/components/site/bottom-dock';
import { JsonLd, ORGANIZATION } from '@/lib/structured-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'PropIQ by CiteRank AI — Find the right property. Understand the opportunity.',
  description:
    'Discover projects, compare locations, benchmark prices, evaluate developers and uncover ' +
    'investment potential. Twelve scoring pillars, a published formula and the evidence behind ' +
    'every number.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    title: 'PropIQ by CiteRank AI — Cities. Insights. Growth.',
    description:
      'Property decision intelligence for India. Published scoring, confidence bands, and the ' +
      'evidence behind every number.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PropIQ by CiteRank AI',
    description: 'Find the right property. Understand the opportunity.',
  },
};

/**
 * The homepage.
 *
 * Every section is fed from one scoring pass, so the hero, the map, the
 * cards, the comparison and the command centre cannot disagree about the same
 * property. The page owns almost no logic: it loads, then hands each section
 * the slice it renders.
 *
 * It carries its own header and footer rather than the application chrome,
 * because the marketing surface is light-first and the app is dark-led. The
 * root layout renders neither for this route.
 */
export default async function HomePage() {
  const data = await loadHomePageData();
  const showcase = data.showcaseSite;
  const showcaseLocality = data.localities.find((l) => l.slug === showcase?.localitySlug);
  const leadLocality = showcaseLocality ?? data.localities[0];

  return (
    <ShortlistProvider>
      <div className="propiq-site">
        <TrackView event="property_viewed" properties={{ surface: 'home' }} />
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'PropIQ by CiteRank AI',
            description: 'Property decision intelligence for India.',
            publisher: ORGANIZATION(),
          }}
        />

        <SiteHeader />

        <main id="main">
          <HeroSection showcase={showcase} />
          <SmartSearch localities={data.localities.map((l) => l.name)} />

          {data.servesDemoData && (
            <div className="mx-auto max-w-7xl px-4 pt-12">
              <DemoDataBanner />
            </div>
          )}

          {/* With no source connected there is nothing truthful to put in the
              data-backed sections, so they are not rendered at all and this
              says why. The sections that need no dataset carry on below. */}
          {data.servesNoData && (
            <div className="mx-auto max-w-7xl px-4 pt-12">
              <NoDataNotice surface="Property discovery, scoring, the market map and the comparison" />
            </div>
          )}

          {/* ---------------------------------------- recommended properties */}
          {!data.servesNoData && (
            <>
              <Section tone="raise">
                <SectionHead
                  eyebrow="Smart discovery"
                  title="Properties worth a closer look."
                  standfirst="Ranked by the engine on location, pricing, developer confidence, growth potential and risk — not by who paid to appear."
                  action={
                    <Link
                      href="/search"
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
                    >
                      See all <ArrowRight aria-hidden className="size-4" />
                    </Link>
                  }
                />
                <SitePropertyRail properties={data.properties.slice(0, 6)} />
                <DemoNote />
              </Section>

              {showcase && <ScoreSection property={showcase} />}
              {showcase && <VerdictSection property={showcase} />}

              {/* ------------------------------------------------- map + list */}
              <Section tone="raise">
                <SectionHead
                  eyebrow="Explore"
                  title="The covered market, on its real coordinates."
                  standfirst="No map provider is configured, so this is drawn from the coordinates already in the data rather than behind an API key. Pin colour is the verdict the engine reached, not a listing status."
                />
                <div className="mt-10">
                  <MapExplorer properties={data.properties} localities={data.localities} />
                </div>
                <DemoNote />
              </Section>

              {leadLocality && <LocalityIntelligence locality={leadLocality} />}
              {showcase && (
                <PriceIntelligence
                  property={showcase}
                  locality={showcaseLocality}
                  localities={data.localities}
                />
              )}
              {showcase && (
                <InvestmentIntelligence property={showcase} locality={showcaseLocality} />
              )}
              <DeveloperIntelligence developers={data.developers} />
              {showcase && <RiskIntelligence property={showcase} />}
              <ComparisonSection properties={data.properties} />
            </>
          )}
          <WhyPropIQ />
          <ResearchSection articles={data.research} />
          {!data.servesNoData && <CommandCentre snapshot={data.commandCentre} />}
          <TrustLayer />
          <FinalCTA />
        </main>

        <SiteFooter />
        <BottomDock />
      </div>
    </ShortlistProvider>
  );
}
