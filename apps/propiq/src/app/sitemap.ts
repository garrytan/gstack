import type { MetadataRoute } from 'next';
import { getPropertyRepository } from '@/data';
import { SCORING_VERSIONS } from '@/domain/scoring/weights';
import { clientEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Kept in step with the routed slugs in `app/checks/[kind]/page.tsx`. */
const DOCUMENT_CHECK_SLUGS = [
  'sale-deed',
  'encumbrance-certificate',
  'khata',
  'agreement-to-sell',
  'rera-certificate',
  'cost-sheet',
] as const;

/**
 * Sitemap.
 *
 * Only pages backed by real evidence are listed. Demo-backed property and
 * locality pages are excluded: an indexable page built on fixture data would
 * put synthetic figures into search results and AI answers, which is the exact
 * failure the truthfulness rule exists to prevent.
 *
 * The free tools and the document-check pages are always listed, whichever
 * adapter is running. They are arithmetic and published rules rather than
 * market claims, so they are correct regardless of what backs the property
 * data — which is also why they are the part of this product that can be
 * cited today.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/search`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/localities`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${base}/methodology`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/data-sources`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${base}/valuation`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/investment`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${base}/signup`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },

    // Free tools: no data dependency, so always indexable.
    { url: `${base}/tools`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    {
      url: `${base}/tools/carpet-area`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.9,
    },
    { url: `${base}/tools/emi`, lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
    {
      url: `${base}/tools/rental-yield`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.9,
    },
    { url: `${base}/document-ai`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    {
      url: `${base}/site-visit-checklist`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.8,
    },

    // One page per document type, each answering a question people type.
    ...DOCUMENT_CHECK_SLUGS.map((slug) => ({
      url: `${base}/checks/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),

    // Frozen methodology permalinks, so a citation survives the next version.
    ...SCORING_VERSIONS.map((v) => ({
      url: `${base}/methodology/v${v.version}`,
      lastModified: now,
      changeFrequency: 'yearly' as const,
      priority: 0.6,
    })),
  ];

  const repo = getPropertyRepository();
  if (repo.servesDemoData) return staticRoutes;

  const [{ items }, localities] = await Promise.all([
    repo.search({ pageSize: 48 }),
    repo.listLocalities(),
  ]);

  return [
    ...staticRoutes,
    ...localities
      .filter((l) => l.dataStatus !== 'demo')
      .map((l) => ({
        url: `${base}/locality/${l.slug}`,
        lastModified: now,
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      })),
    ...items
      .filter((p) => p.dataStatus !== 'demo')
      .map((p) => ({
        url: `${base}/property/${p.id}`,
        lastModified: p.listedAt ? new Date(p.listedAt) : now,
        changeFrequency: 'weekly' as const,
        priority: 0.6,
      })),
  ];
}
