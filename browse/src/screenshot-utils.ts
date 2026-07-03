/**
 * Shared screenshot pre-flight helpers.
 */

import type { Page } from 'playwright';

/**
 * Wait for web fonts to finish loading before capturing a screenshot.
 *
 * Without this, `page.screenshot()` can fire mid-FOIT (flash of invisible /
 * fallback text): `@font-face` and Google-Font glyphs haven't downloaded yet,
 * so text renders in a system fallback or blank — the "bad images" seen from
 * qa / design-review / responsive captures. `document.fonts.ready` resolves
 * once all pending font loads settle. Best-effort and capped so a page that
 * never settles (streaming/lazy fonts) can't hang the capture.
 */
export async function waitForFonts(page: Page, timeoutMs = 3000): Promise<void> {
  try {
    await page.evaluate(
      (ms) =>
        Promise.race([
          (document as any).fonts?.ready ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, ms)),
        ]).then(() => undefined),
      timeoutMs,
    );
  } catch {
    // Navigation/context teardown races are non-fatal — proceed with capture.
  }
}
