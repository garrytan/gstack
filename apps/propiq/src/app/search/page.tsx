import type { Metadata } from 'next';
import Link from 'next/link';
import { z } from 'zod';
import { getPropertyRepository } from '@/data';
import { buildSummaries } from '@/server/intelligence';
import { loadBuyerProfile } from '@/server/actions';
import { BUYER_PERSONAS } from '@/domain/buyer/types';
import type { BuyerPersona } from '@/domain/buyer/types';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { PropertyCard } from '@/components/propiq/property-card';
import { SearchBar } from '@/components/propiq/search-bar';
import { SearchFilters } from '@/components/propiq/search-filters';
import { TrackView } from '@/components/propiq/track-view';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Search properties',
  description:
    'Search scored properties. Every result carries its PropIQ verdict, score and data status.',
  alternates: { canonical: '/search' },
};

/**
 * Search params are user input, so they are parsed rather than trusted.
 * An unparseable value falls back to the default instead of failing the page.
 */
const searchSchema = z.object({
  q: z.string().max(120).optional(),
  locality: z.string().max(64).optional(),
  priceMin: z.coerce.number().nonnegative().optional(),
  priceMax: z.coerce.number().positive().optional(),
  beds: z.coerce.number().int().min(0).max(10).optional(),
  sort: z.enum(['relevance', 'priceAsc', 'priceDesc', 'scoreDesc', 'newest']).default('scoreDesc'),
  // Optional: an explicit persona in the URL overrides the saved profile, so a
  // user can try another lens without editing their preferences.
  persona: z.enum(BUYER_PERSONAS).optional(),
  page: z.coerce.number().int().positive().default(1),
});

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = searchSchema.safeParse(raw);
  const params = parsed.success ? parsed.data : searchSchema.parse({});

  const repo = getPropertyRepository();
  const [localities, profile] = await Promise.all([repo.listLocalities(), loadBuyerProfile()]);

  // Precedence: an explicit persona in the URL, then the saved profile, then
  // the default. The full profile is passed whenever it matches the persona in
  // play, so buyer-fit signals score against real preferences rather than
  // being dropped for want of data.
  const persona: BuyerPersona = params.persona ?? profile?.persona ?? 'homebuyer';
  const buyer = profile && profile.persona === persona ? profile : undefined;

  const result = await repo.search({
    text: params.q,
    localityIds: params.locality ? [params.locality as never] : undefined,
    priceMin: params.priceMin,
    priceMax: params.priceMax,
    bedroomsMin: params.beds,
    sort: params.sort === 'scoreDesc' ? 'relevance' : params.sort,
    page: params.page,
    pageSize: 12,
  });

  let scored = await buildSummaries(result.items, { persona, buyer });

  // Score ordering is applied here, not in the repository: the repository is a
  // data port and has no business knowing about the scoring engine.
  if (params.sort === 'scoreDesc') {
    scored = [...scored].sort((a, b) => (b.score.score ?? -1) - (a.score.score ?? -1));
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <TrackView
        event="search_submitted"
        properties={{
          query: params.q ?? '',
          results: result.total,
          persona,
          hasProfile: Boolean(buyer),
        }}
      />

      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Results are scored for a <strong>{persona}</strong>.{' '}
        {buyer ? (
          <>
            Your saved preferences are applied, so buyer fit is scored against your budget, commute
            and requirements.{' '}
            <Link href="/preferences" className="text-accent-500 hover:underline">
              Edit them
            </Link>
            .
          </>
        ) : (
          <>
            <Link href="/preferences" className="text-accent-500 hover:underline">
              Tell PropIQ how you buy
            </Link>{' '}
            and buyer fit is scored against your budget and commute instead of being left unscored.
          </>
        )}
      </p>

      <div className="mt-5">
        <SearchBar />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside>
          <SearchFilters localities={localities} current={{ ...params, persona }} />
        </aside>

        <div>
          <div className="flex items-baseline justify-between gap-4">
            <p data-figure className="text-sm text-[var(--text-secondary)]">
              {result.total} propert{result.total === 1 ? 'y' : 'ies'}
              {params.q ? ` matching “${params.q}”` : ''}
            </p>
          </div>

          {scored.length === 0 ? (
            <EmptyState query={params.q} />
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {scored.map((intel) => (
                <PropertyCard key={intel.property.id} intelligence={intel} />
              ))}
            </div>
          )}

          {scored.length > 1 && (
            <Link
              href={`/compare?ids=${scored
                .slice(0, 3)
                .map((s) => s.property.id)
                .join(',')}`}
              className="mt-6 inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
            >
              Compare the top {Math.min(3, scored.length)} in the Decision Room
            </Link>
          )}

          {result.hasMore && (
            <nav aria-label="Pagination" className="mt-6">
              <Link
                href={{ pathname: '/search', query: { ...raw, page: params.page + 1 } }}
                className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                Next page
              </Link>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

const EmptyState = ({ query }: { query?: string }) => (
  <div className="mt-4 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <p className="text-sm font-medium">No properties match those filters</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
      {query
        ? `Nothing in the current coverage matches “${query}”. PropIQ covers Bengaluru densely rather than every city thinly, so a property outside that market will not appear here.`
        : 'Try widening the price range or clearing the locality filter.'}
    </p>
    <Link
      href="/search"
      className="mt-4 inline-block text-sm font-medium text-accent-500 hover:underline"
    >
      Clear all filters
    </Link>
  </div>
);
