/**
 * End-to-end configuration.
 *
 * Two things worth knowing before running this.
 *
 * The browser is not downloaded. The container ships Chromium at
 * `/opt/pw-browsers`, so `launchOptions.executablePath` points at it and
 * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` keeps `npm i` from fetching another copy.
 * On a machine without that layout, run `npx playwright install chromium` once
 * and drop the env var.
 *
 * The suite runs against a production build, not `next dev`. Dev serves an
 * un-minified bundle through a compiler that recompiles mid-request, which is
 * exactly the thing that produced three phantom `document-title` failures in an
 * earlier accessibility run. What CI should assert on is what a visitor gets.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3411);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: CHROMIUM },
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    // `demo` and not the default: an E2E run against the empty adapter proves
    // the empty state renders and nothing else. The mode is declared here the
    // same way a deployment declares it, so the badge is part of what is tested.
    command: `npm run build && npx next start -p ${PORT}`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_DATA_MODE: 'demo',
      NEXT_PUBLIC_SITE_URL: BASE,
      // The loopback guard exists so a real deployment cannot bake localhost
      // into its canonical links. Verifying the build is the one case where
      // localhost is the point, so it is opted out of explicitly and loudly.
      PROPIQ_ALLOW_LOOPBACK_ORIGIN: '1',
    },
  },
});
