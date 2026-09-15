/**
 * Navigation integrity.
 *
 * A link in the header, the footer or a dashboard card is a promise that a
 * route exists. Breaking that promise is the cheapest way to make a product
 * feel unfinished, and it is exactly the failure a test can prevent: every
 * internal href in a navigation surface must resolve to a real route file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const appDir = join(root, 'src/app');

/** Every routable path in the App Router, as a matcher. */
const collectRoutes = (dir: string): string[] => {
  const routes: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routes.push(...collectRoutes(full));
    } else if (entry === 'page.tsx' || entry === 'route.ts') {
      const segment = relative(appDir, dir).split(/[\\/]/).filter(Boolean);
      // Route groups — (marketing) and the like — do not appear in the URL.
      routes.push('/' + segment.filter((s) => !s.startsWith('(')).join('/'));
    }
  }
  return routes;
};

const ROUTES = collectRoutes(appDir).map((r) => (r === '/' ? '/' : r.replace(/\/$/, '')));

/** `/property/[id]` matches `/property/anything`; static segments must match exactly. */
const routeExists = (href: string): boolean => {
  const wanted = href.split('/').filter(Boolean);
  return ROUTES.some((route) => {
    const parts = route.split('/').filter(Boolean);
    if (parts.length !== wanted.length) return false;
    return parts.every((part, i) => part.startsWith('[') || part === wanted[i]);
  });
};

/** Internal hrefs only: external links and anchors are not this test's business. */
const hrefsIn = (file: string): string[] => {
  const source = readFileSync(join(root, file), 'utf-8');
  const matches = source.match(/href(?::|=)\s*['"](\/[^'"#?]*)['"]/g) ?? [];
  return [
    ...new Set(
      matches
        .map((m) => m.replace(/^href(?::|=)\s*['"]/, '').replace(/['"]$/, ''))
        .map((h) => (h.length > 1 ? h.replace(/\/$/, '') : h)),
    ),
  ];
};

const NAV_SURFACES = [
  'src/app/layout.tsx',
  'src/app/page.tsx',
  'src/app/dashboard/page.tsx',
] as const;

describe('navigation integrity', () => {
  it('finds routes to check against', () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it.each(NAV_SURFACES)('every internal link in %s resolves to a route', (file) => {
    const broken = hrefsIn(file).filter((href) => !routeExists(href));
    expect(broken, `dead links in ${file}`).toEqual([]);
  });

  it('rejects a link to a route that does not exist', () => {
    // Guards the matcher itself: a test that cannot fail is not a test.
    expect(routeExists('/not-a-real-route')).toBe(false);
    expect(routeExists('/search')).toBe(true);
    expect(routeExists('/property/prop-nm-3a')).toBe(true);
  });

  it('keeps the spec-named URLs reachable, whether or not they are canonical', () => {
    // Both are labels the product uses out loud, so both must resolve.
    for (const href of ['/decision-room', '/reports', '/dashboard/notifications']) {
      expect(routeExists(href), `${href} is unreachable`).toBe(true);
    }
  });
});
