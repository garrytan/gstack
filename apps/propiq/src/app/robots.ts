import type { MetadataRoute } from 'next';
import { clientEnv } from '@/lib/env';

/**
 * Robots.
 *
 * AI crawlers are named explicitly rather than left to the wildcard. Not
 * because the rules differ — they do not — but because being silently blocked
 * by a default somewhere downstream is a failure mode nobody notices, and an
 * explicit allow is a statement of intent that survives a proxy or a CDN rule
 * being added later.
 *
 * This product wants to be read by answer engines. Its claims are dated,
 * sourced and methodology-backed, which is precisely the shape that should be
 * citable, and there is nothing here worth hiding from a model that a human
 * reader is not also shown.
 */

/** Crawlers that feed answer engines and model training corpora. */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'meta-externalagent',
  'Bingbot',
  'CCBot',
] as const;

/** Account surfaces carry a user's own data and have no business in any index. */
const PRIVATE_PATHS = ['/dashboard', '/dashboard/', '/login', '/preferences', '/api/'];

export default function robots(): MetadataRoute.Robots {
  const base = clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS },
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: '/',
        disallow: PRIVATE_PATHS,
      })),
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
