/**
 * Lighthouse, against a production build.
 *
 * Run `next build && next start` first, or pass an origin:
 *   node scripts/lighthouse.mjs http://127.0.0.1:3411
 *
 * It audits the routes that carry the most weight — the homepage, a property
 * page, search and a tool — and exits non-zero if any category falls under the
 * floor. The floors are the brief's, not aspirational ones: a target nobody
 * enforces is a target nobody hits.
 */

import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { writeFileSync, mkdirSync } from 'node:fs';

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:3411';
const CHROME = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const ROUTES = ['/', '/search', '/property/prop-nm-3a', '/tools/emi'];

const FLOORS = {
  performance: 0.9,
  accessibility: 0.95,
  'best-practices': 0.95,
  seo: 0.95,
};

const pct = (n) => Math.round((n ?? 0) * 100);

// An unreachable origin used to come back as four rows of zeros, which reads
// as "the site scores nothing" rather than "nothing was measured". Check once,
// loudly, before spending five minutes proving it.
const probe = await fetch(ORIGIN, { redirect: 'manual' }).catch(() => undefined);
if (!probe) {
  console.error(
    `Nothing is serving at ${ORIGIN}. Start a production server first:\n` +
      '  npm run build && PROPIQ_ALLOW_LOOPBACK_ORIGIN=1 npx next start -p 3411',
  );
  process.exit(2);
}

const chrome = await launch({
  chromePath: CHROME,
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
});

const rows = [];
let failed = false;

try {
  for (const route of ROUTES) {
    const result = await lighthouse(
      `${ORIGIN}${route}`,
      { port: chrome.port, output: 'json', logLevel: 'error' },
      // Mobile emulation is the default and the honest one: it is the slower
      // device and the one most Indian property buyers are actually holding.
      undefined,
    );

    const scores = Object.fromEntries(
      Object.entries(result.lhr.categories).map(([k, v]) => [k, v.score]),
    );
    const audits = result.lhr.audits;

    rows.push({
      route,
      ...Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, pct(v)])),
      lcp: audits['largest-contentful-paint']?.displayValue ?? '—',
      cls: audits['cumulative-layout-shift']?.displayValue ?? '—',
      tbt: audits['total-blocking-time']?.displayValue ?? '—',
    });

    for (const [category, floor] of Object.entries(FLOORS)) {
      const score = scores[category];
      if (score !== undefined && score < floor) {
        console.error(
          `FAIL ${route} ${category} ${pct(score)} is below the floor of ${pct(floor)}`,
        );
        failed = true;
      }
    }

    mkdirSync('.lighthouse', { recursive: true });
    writeFileSync(
      `.lighthouse/${route === '/' ? 'home' : route.replace(/\//g, '-').replace(/^-/, '')}.json`,
      JSON.stringify(result.lhr),
    );
  }
} finally {
  await chrome.kill();
}

console.table(rows);
process.exit(failed ? 1 : 0);
