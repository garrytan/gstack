import type { MetadataRoute } from 'next';
import { clientEnv } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  const base = clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Account surfaces carry a user's own data and have no business in an index.
        disallow: ['/dashboard', '/dashboard/', '/login', '/api/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
