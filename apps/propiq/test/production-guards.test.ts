/**
 * Production configuration guards.
 *
 * Both of these exist because of a specific observed failure. A production
 * server running the fixture adapter answered the tool pages with 200, every
 * data-backed route with a 500, and four more routes with a *200* carrying a
 * permanently stuck loading skeleton — the error was raised inside a Suspense
 * boundary after the shell had already flushed. An uptime check on `/search`
 * reported a healthy service. And a production build with no site URL baked
 * `localhost` into every canonical link, the sitemap and the auth email
 * redirect, silently.
 *
 * These tests read the source rather than booting a server, because the
 * behaviour being pinned is "the process refuses to start", which a test
 * runner cannot observe from inside the process it is already running in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

describe('startup configuration guards', () => {
  const instrumentation = read('src/instrumentation.ts');
  const env = read('src/lib/env.ts');

  it('runs the server env check from the instrumentation hook', () => {
    // Next calls `register()` once before serving anything, which is the only
    // place a misconfiguration can fail the whole process rather than leaking
    // out one route at a time.
    expect(instrumentation).toMatch(/export async function register/);
    expect(instrumentation).toMatch(/getServerEnv\(\)/);
  });

  it('skips the startup check outside a production node server', () => {
    // A build must stay runnable with no environment at all: that is how CI and
    // a fresh clone invoke it.
    expect(instrumentation).toMatch(/NEXT_RUNTIME !== 'nodejs'/);
    expect(instrumentation).toMatch(/NODE_ENV !== 'production'/);
    expect(instrumentation).toMatch(/phase-production-build/);
  });

  it('refuses a loopback site URL in production', () => {
    expect(env).toMatch(/NEXT_PUBLIC_SITE_URL must be set/);
    expect(env).toMatch(/isLoopback/);
    // Only on the server. By the time the module evaluates in a browser the
    // value is already baked, so throwing there punishes the visitor for a
    // mistake made at build time.
    expect(env).toMatch(/typeof window === 'undefined'/);
  });

  it('treats every loopback spelling as unset', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(env).toContain(host);
    }
  });

  it('still refuses the fixture adapter in production', () => {
    // The original guard. Unchanged; only where it fires has moved.
    expect(env).toMatch(/PROPIQ_DATA_ADAPTER=fixture is not permitted when NODE_ENV=production/);
  });
});

describe('share and icon surfaces', () => {
  it('ships an Open Graph card with no figures on it', () => {
    const og = read('src/app/opengraph-image.tsx');
    expect(og).toMatch(/ImageResponse/);
    expect(og).toMatch(/width: 1200, height: 630/);
    // A share card travels with no banner, no data-status chip and no
    // methodology link beside it, so no number may ride on it.
    expect(og).not.toMatch(/₹|\d+\s*\/\s*100|sqft/);
  });

  it('ships a tab icon', () => {
    expect(read('src/app/icon.tsx')).toMatch(/ImageResponse/);
  });
});

describe('legal links go where their label says', () => {
  const footer = read('src/components/site/site-footer.tsx');

  it('points Privacy at the privacy page, not at About', () => {
    expect(footer).toMatch(/href="\/privacy"[\s\S]{0,120}Privacy/);
  });

  it('groups the legal links under a labelled nav', () => {
    expect(footer).toMatch(/aria-label="Legal"/);
  });

  it('offers no Terms link while no terms exist', () => {
    // A link that lands somewhere other than its label is worse than no link.
    expect(footer).not.toMatch(/>\s*Terms\s*</);
  });

  it('states what the privacy page does not yet cover', () => {
    const privacy = read('src/app/(app)/privacy/page.tsx');
    expect(privacy).toMatch(/Not published yet/);
    expect(privacy.replace(/\s+/g, ' ')).toMatch(/Digital Personal Data Protection Act/);
  });
});
