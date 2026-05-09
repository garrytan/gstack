/**
 * Stealth init script — webdriver-mask only (D7, codex narrowed).
 *
 * Modern anti-bot fingerprinters check consistency between navigator
 * properties (plugins.length, languages, userAgent, platform). Faking those
 * to fixed values (the wintermute approach) can flag MORE bot-like, not
 * less, and breaks legitimate sites that reflect on these properties.
 *
 * The honest minimum is masking navigator.webdriver, which Chromium exposes
 * as a known automation tell. Letting plugins/languages/chrome.runtime
 * surface their native Chromium values keeps the fingerprint internally
 * consistent.
 */

import type { Browser, BrowserContext } from 'playwright';

/**
 * Init script applied to every page in a context. Runs in the page's main
 * world before any other scripts. Idempotent — defining the same property
 * twice in different contexts is fine.
 */
export const WEBDRIVER_MASK_SCRIPT = `Object.defineProperty(navigator, 'webdriver', { get: () => false });`;

/**
 * Apply stealth patches to a fresh BrowserContext (or persistent context).
 * Called by browser-manager.launch() and launchHeaded().
 */
export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: WEBDRIVER_MASK_SCRIPT });
}

/**
 * Args added to chromium.launch's `args` to suppress the
 * AutomationControlled blink feature. This is independent of the init
 * script — it changes how Chromium identifies itself in the protocol layer.
 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
];
