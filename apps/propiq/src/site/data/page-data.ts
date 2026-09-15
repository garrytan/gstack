/**
 * Homepage data.
 *
 * One scoring pass feeds every section, so the hero, the map, the cards, the
 * comparison and the command centre cannot disagree about the same property.
 * The single exception is the showcase property, which is re-run through the
 * full use case because the hero needs the negotiation ladder that
 * `buildSummaries` deliberately skips.
 */

import 'server-only';
import { getPropertyRepository } from '@/data';
import { buildPropertyIntelligence, buildSummaries, summariseMarket } from '@/server/intelligence';
import { loadBuyerProfile } from '@/server/actions';
import { toDeveloperProfile, toSiteLocality, toSiteProperty } from '@/site/data/project';
import { RESEARCH } from '@/site/data/research';
import type {
  CommandCentreSnapshot,
  DeveloperProfile,
  ResearchArticle,
  SiteLocality,
  SiteProperty,
} from '@/site/types';
import type { PropertyIntelligence } from '@/server/intelligence';

export interface HomePageData {
  readonly properties: readonly SiteProperty[];
  readonly localities: readonly SiteLocality[];
  readonly developers: readonly DeveloperProfile[];
  readonly research: readonly ResearchArticle[];
  readonly commandCentre: CommandCentreSnapshot;
  /** Full payload for the one property the hero and verdict sections lead on. */
  readonly showcase: PropertyIntelligence | undefined;
  readonly showcaseSite: SiteProperty | undefined;
  readonly servesDemoData: boolean;
}

export const loadHomePageData = async (): Promise<HomePageData> => {
  const repo = getPropertyRepository();

  const [{ items }, localities, profile] = await Promise.all([
    repo.search({ pageSize: 48 }),
    repo.listLocalities(),
    loadBuyerProfile(),
  ]);

  const intelligence = await buildSummaries(items, {
    persona: profile?.persona,
    buyer: profile,
  });
  const market = summariseMarket(intelligence);

  const ranked = [...intelligence].sort((a, b) => (b.score.score ?? -1) - (a.score.score ?? -1));
  const lead = ranked[0];

  const showcase = lead
    ? await buildPropertyIntelligence(lead.property.id, {
        persona: profile?.persona,
        buyer: profile,
        includeAlternatives: false,
      })
    : undefined;

  // One profile per developer that actually appears in the covered set.
  const seen = new Set<string>();
  const developers: DeveloperProfile[] = [];
  for (const intel of ranked) {
    if (!intel.developer || seen.has(intel.developer.id)) continue;
    seen.add(intel.developer.id);
    developers.push(toDeveloperProfile(intel.developer, intel.property.dataStatus));
  }

  const properties = ranked.map(toSiteProperty);

  return {
    properties,
    localities: localities.map(toSiteLocality),
    developers,
    research: RESEARCH,
    commandCentre: {
      meanScore: market.meanScore,
      tracked: market.total,
      opportunities: properties.filter((p) => p.priceDeviationPercent < -5).length,
      materialRisks: market.materialRisks,
      verdictCounts: market.counts,
      // Derived from the covered set rather than authored, so the panel is
      // never claiming activity the data does not show.
      alerts: [
        {
          label: `${properties.filter((p) => p.decision === 'BUY').length} properties clear the buy band`,
          detail: 'Scored above the published threshold on the current weighting.',
        },
        {
          label: `${properties.filter((p) => p.priceDeviationPercent < -5).length} priced under fair value`,
          detail: 'More than 5% below the central estimate from the comparable set.',
        },
        {
          label: `${properties.filter((p) => p.decision === 'INSUFFICIENT_EVIDENCE').length} withheld for thin evidence`,
          detail: 'Below the reporting floor for coverage or confidence.',
        },
      ],
      dataStatus: repo.servesDemoData ? 'demo' : 'derived',
    },
    showcase,
    showcaseSite: showcase ? toSiteProperty(showcase) : undefined,
    servesDemoData: repo.servesDemoData,
  };
};
