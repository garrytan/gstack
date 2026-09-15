import type { MetadataRoute } from 'next';
import { getPropertyRepository } from '@/data';
import { clientEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Sitemap.
 *
 * Only pages backed by real evidence are listed. Demo-backed property and
 * locality pages are excluded: an indexable page built on fixture data would
 * put synthetic figures into search results and AI answers, which is the exact
 * failure the truthfulness rule exists to prevent.
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
