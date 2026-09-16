/**
 * Environment validation.
 *
 * Fails fast and loudly at startup rather than producing a mystery 500 on the
 * first Supabase call. Server-only secrets are kept in a separate schema from
 * the `NEXT_PUBLIC_*` values so a client bundle can never pull one in.
 */

import { z } from 'zod';
import { ADAPTER_FOR_MODE, DATA_MODES, MODE_FOR_ADAPTER, type DataMode } from './data-mode';

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_MAPS_PROVIDER: z.enum(['mapbox', 'google', 'none']).default('none'),
  NEXT_PUBLIC_MAPS_TOKEN: z.string().optional(),
  /**
   * The declared data mode — see `data-mode.ts`. Public on purpose: it is what
   * lets the demo badge render on every surface, so a deployment serving
   * synthetic figures cannot do it quietly.
   */
  NEXT_PUBLIC_DATA_MODE: z.enum(DATA_MODES).optional(),
  NEXT_PUBLIC_ANALYTICS_DEBUG: z.enum(['0', '1']).default('0'),
});

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Which property data adapter to use.
   *
   * `fixture` serves the labelled demo dataset, `supabase` serves real records,
   * and `none` serves nothing at all. Production refuses `fixture` — asking for
   * demo data on a public deployment is the one configuration this product
   * cannot honour — but `none` is perfectly valid and is what production gets
   * by default. A site with no property source should say so and keep serving
   * the surfaces that need no source (the free tools, the methodology, the
   * marketing pages), not refuse to start.
   */
  PROPIQ_DATA_ADAPTER: z.enum(['fixture', 'supabase', 'none']).optional(),
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
export type ServerEnv = Omit<z.infer<typeof serverSchema>, 'PROPIQ_DATA_ADAPTER'> & {
  /** Always resolved: unset becomes `fixture` in development, `none` in production. */
  readonly PROPIQ_DATA_ADAPTER: 'fixture' | 'supabase' | 'none';
  /** The public name for the same thing. Always agrees with the adapter. */
  readonly DATA_MODE: DataMode;
};

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
    NEXT_PUBLIC_DATA_MODE: process.env.NEXT_PUBLIC_DATA_MODE,
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
  //
  // One opt-out, and it is deliberately awkward to set by accident:
  // `PROPIQ_ALLOW_LOOPBACK_ORIGIN=1`. Verifying a production build is part of
  // shipping — the E2E suite and the Lighthouse run both need `next start` on
  // 127.0.0.1, and without an escape hatch this guard makes the one check that
  // matters most impossible to run. A real deployment never sets it; a local
  // one announces itself on stdout every boot, so it cannot be forgotten.
  const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
  const loopbackAllowed = process.env.PROPIQ_ALLOW_LOOPBACK_ORIGIN === '1';
  if (typeof window === 'undefined' && loopbackAllowed && configured && isLoopback(configured)) {
    console.warn(
      `[propiq] PROPIQ_ALLOW_LOOPBACK_ORIGIN=1 — serving with a loopback origin (${configured}). ` +
        'Canonical links, the sitemap, llms.txt and auth redirects all point at it. ' +
        'This is for local production verification only and must never be set on a deployment.',
    );
  }
  if (
    typeof window === 'undefined' &&
    process.env.NODE_ENV === 'production' &&
    !isBuildPhase &&
    !loopbackAllowed &&
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

  // Where the mode comes from, in order.
  //
  // `NEXT_PUBLIC_DATA_MODE` is the declaration and wins. It is public, so
  // choosing `demo` is the same act as telling every visitor the figures are
  // synthetic — the badge is not a separate thing someone can forget to switch
  // on. `PROPIQ_DATA_ADAPTER` still works for tests and for a deployment that
  // pins the adapter directly; when both are present they must agree, because
  // a silent winner between "what we serve" and "what we say we serve" is
  // exactly the failure this product cannot have.
  const declared = clientEnv.NEXT_PUBLIC_DATA_MODE;
  const pinned = parsed.data.PROPIQ_DATA_ADAPTER;

  if (declared && pinned && ADAPTER_FOR_MODE[declared] !== pinned) {
    throw new Error(
      `NEXT_PUBLIC_DATA_MODE=${declared} expects the ${ADAPTER_FOR_MODE[declared]} adapter, ` +
        `but PROPIQ_DATA_ADAPTER=${pinned} was also set. The declared mode and the adapter ` +
        'backing it must agree — set one or the other, not two that disagree.',
    );
  }

  // The truthfulness rule, enforced by configuration. The rule is "never
  // present sample data as live intelligence", not "never show sample data",
  // so a production deployment MAY serve the labelled demo set — but only by
  // declaring it publicly, which is what renders the badge. Reaching for the
  // fixture adapter alone in production is still refused: that is the quiet
  // path, and the quiet path is the one that ships synthetic prices to a buyer
  // with nothing on screen to tell them.
  if (parsed.data.NODE_ENV === 'production' && pinned === 'fixture' && declared !== 'demo') {
    throw new Error(
      'PROPIQ_DATA_ADAPTER=fixture is not permitted when NODE_ENV=production. ' +
        'The fixture adapter serves demo data and must never back a production ' +
        'deployment unless the deployment says so: set NEXT_PUBLIC_DATA_MODE=demo, ' +
        'which labels every figure on every surface. For real records set ' +
        'PROPIQ_DATA_ADAPTER=supabase, or leave it unset to serve no property data.',
    );
  }

  // Unset means "the labelled demo set" while developing and "nothing" in
  // production. A public deployment that has not been pointed at a database
  // has no Indian property facts, and the honest default is to have none.
  const adapter: 'fixture' | 'supabase' | 'none' =
    declared !== undefined
      ? ADAPTER_FOR_MODE[declared]
      : (pinned ?? (parsed.data.NODE_ENV === 'production' ? 'none' : 'fixture'));

  cachedServerEnv = {
    ...parsed.data,
    PROPIQ_DATA_ADAPTER: adapter,
    DATA_MODE: MODE_FOR_ADAPTER[adapter],
  };
  return cachedServerEnv;
};

export const isSupabaseConfigured = (): boolean =>
  Boolean(clientEnv.NEXT_PUBLIC_SUPABASE_URL && clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** Test-only: clears the memoised server env so a test can vary process.env. */
export const __resetServerEnvCache = (): void => {
  cachedServerEnv = undefined;
};
