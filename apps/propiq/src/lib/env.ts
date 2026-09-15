/**
 * Environment validation.
 *
 * Fails fast and loudly at startup rather than producing a mystery 500 on the
 * first Supabase call. Server-only secrets are kept in a separate schema from
 * the `NEXT_PUBLIC_*` values so a client bundle can never pull one in.
 */

import { z } from 'zod';

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_MAPS_PROVIDER: z.enum(['mapbox', 'google', 'none']).default('none'),
  NEXT_PUBLIC_MAPS_TOKEN: z.string().optional(),
  NEXT_PUBLIC_ANALYTICS_DEBUG: z.enum(['0', '1']).default('0'),
});

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Which property data adapter to use. `fixture` serves the labelled demo
   * dataset; `supabase` serves real records. Production refuses `fixture`.
   */
  PROPIQ_DATA_ADAPTER: z.enum(['fixture', 'supabase']).default('fixture'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  /** AI provider configuration. Model IDs never appear in domain code. */
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'none']).default('none'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_FALLBACK_MODEL: z.string().optional(),
  /** Requests per minute per user for AI endpoints. */
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /**
   * Shared secret for scheduled endpoints. Unset means scheduled evaluation is
   * refused outright — it never defaults open.
   */
  CRON_SECRET: z.string().min(16).optional(),
  /**
   * Alert delivery. A webhook URL enables the webhook channel; the secret, when
   * present, signs each payload with HMAC-SHA256 so the receiver can verify it.
   * Both absent means the channel reports itself unconfigured rather than
   * silently dropping digests.
   */
  ALERT_WEBHOOK_URL: z.url().optional(),
  ALERT_WEBHOOK_SECRET: z.string().min(16).optional(),
});

/** Where the app is served from, when nothing better is configured. */
const DEV_SITE_URL = 'http://localhost:3000';

const isLoopback = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
};

export type ClientEnv = Omit<z.infer<typeof clientSchema>, 'NEXT_PUBLIC_SITE_URL'> & {
  readonly NEXT_PUBLIC_SITE_URL: string;
};
export type ServerEnv = z.infer<typeof serverSchema>;

const formatIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');

/**
 * Client-safe env. Next inlines `process.env.NEXT_PUBLIC_*` at build time, so
 * these must be referenced by their literal names rather than read dynamically.
 */
export const clientEnv: ClientEnv = (() => {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_MAPS_PROVIDER: process.env.NEXT_PUBLIC_MAPS_PROVIDER,
    NEXT_PUBLIC_MAPS_TOKEN: process.env.NEXT_PUBLIC_MAPS_TOKEN,
    NEXT_PUBLIC_ANALYTICS_DEBUG: process.env.NEXT_PUBLIC_ANALYTICS_DEBUG,
  });
  if (!parsed.success) {
    throw new Error(`Invalid public environment configuration:\n${formatIssues(parsed.error)}`);
  }

  const configured = parsed.data.NEXT_PUBLIC_SITE_URL;

  // `NEXT_PUBLIC_*` is inlined into both bundles at build time, so a production
  // build without this value bakes `localhost` into every canonical link, the
  // sitemap, `llms.txt`, the JSON-LD `@id` and — the one that actually hurts a
  // real user — the auth email redirect. A crawler told the canonical URL is
  // localhost de-indexes the real page; a buyer sent to localhost after
  // confirming their address is simply stranded. Better to refuse the build.
  //
  // The check runs on the server only. By the time this module evaluates in a
  // browser the value is already baked, so throwing there would punish the
  // visitor for a mistake made at build time. And it is skipped under `next
  // build`'s own phase so `npm run build` stays runnable with no environment
  // at all, which is how CI and a fresh clone both invoke it.
  const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
  if (
    typeof window === 'undefined' &&
    process.env.NODE_ENV === 'production' &&
    !isBuildPhase &&
    (configured === undefined || isLoopback(configured))
  ) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must be set to this deployment's public origin " +
        `(got ${configured ?? 'nothing'}). It is baked into canonical links, the ` +
        'sitemap, llms.txt, structured data and the auth email redirect, so a ' +
        'loopback value silently points real users and crawlers at localhost.',
    );
  }

  return { ...parsed.data, NEXT_PUBLIC_SITE_URL: configured ?? DEV_SITE_URL };
})();

let cachedServerEnv: ServerEnv | undefined;

/**
 * Server-only env. Call this from server components, route handlers and
 * actions. It throws if invoked in a browser bundle.
 */
export const getServerEnv = (): ServerEnv => {
  if (typeof window !== 'undefined') {
    throw new Error('getServerEnv() was called in the browser. Server env must never be bundled.');
  }
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment configuration:\n${formatIssues(parsed.error)}`);
  }

  // The truthfulness rule, enforced by configuration: production must never be
  // able to serve fixture data as if it were live market intelligence.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.PROPIQ_DATA_ADAPTER === 'fixture') {
    throw new Error(
      'PROPIQ_DATA_ADAPTER=fixture is not permitted when NODE_ENV=production. ' +
        'The fixture adapter serves demo data and must never back a production deployment.',
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
};

export const isSupabaseConfigured = (): boolean =>
  Boolean(clientEnv.NEXT_PUBLIC_SUPABASE_URL && clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** Test-only: clears the memoised server env so a test can vary process.env. */
export const __resetServerEnvCache = (): void => {
  cachedServerEnv = undefined;
};
