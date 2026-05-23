/**
 * Stealth init scripts — anti-bot detection countermeasures.
 *
 * Two modes:
 *
 *   1. DEFAULT (consistency-first, always on): masks navigator.webdriver
 *      and adds --disable-blink-features=AutomationControlled. This is
 *      the original "codex narrowed" minimum that preserves fingerprint
 *      consistency — letting plugins/languages/chrome.runtime surface
 *      native Chromium values keeps the fingerprint internally coherent.
 *
 *   2. EXTENDED (opt-in via GSTACK_STEALTH=extended): six additional
 *      detection-vector patches on top of the default. Closes the
 *      SannySoft test corpus to a 100% pass rate. Originally proposed in
 *      PR #1112 (garrytan, Apr 2026).
 *
 *      Vectors patched in extended mode:
 *        - navigator.webdriver property fully deleted from prototype
 *          (not just `false` — detectors check `"webdriver" in navigator`)
 *        - WebGL renderer spoofed to a plausible Apple M1 Pro string
 *          (SwiftShader was the #1 software-GPU giveaway in containers)
 *        - navigator.plugins returns a real PluginArray with proper
 *          MimeType objects and namedItem() — `instanceof PluginArray`
 *          passes
 *        - window.chrome populated with chrome.app, chrome.runtime,
 *          chrome.loadTimes(), chrome.csi() with correct shapes
 *        - navigator.mediaDevices present (some headless builds drop it)
 *        - CDP cdc_* property names cleared from window
 *
 *      Trade-off: extended mode actively LIES about the browser
 *      environment. Sites that reflect on these properties can break or
 *      misbehave. Use only when the default mode triggers detection AND
 *      the target is anti-bot-protected. Not recommended as a global
 *      default.
 */

import type { BrowserContext } from 'playwright';

/**
 * Always-on default mask: navigator.webdriver returns false. Modern
 * fingerprinters check the property accessor, so a one-line getter is
 * sufficient when consistency with the rest of the navigator surface is
 * preserved.
 */
export const WEBDRIVER_MASK_SCRIPT = `Object.defineProperty(navigator, 'webdriver', { get: () => false });`;

/**
 * Extended-mode init script — six detection-vector patches. Applied
 * AFTER the default mask, so the property-getter version remains in
 * place if any of the deletion paths fail.
 *
 * Self-contained string so it can be passed to addInitScript({ content })
 * without bundling concerns.
 */
export const EXTENDED_STEALTH_SCRIPT = `
(() => {
  try {
    // 1. Fully delete navigator.webdriver from the prototype so
    //    \`"webdriver" in navigator\` returns false (not just falsy).
    delete Object.getPrototypeOf(navigator).webdriver;
  } catch {}

  try {
    // 2. WebGL renderer spoof — SwiftShader is the canonical software-GPU
    //    tell. Spoof to a plausible Apple M1 Pro string.
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      // UNMASKED_VENDOR_WEBGL (37445) → 'Apple Inc.'
      if (parameter === 37445) return 'Apple Inc.';
      // UNMASKED_RENDERER_WEBGL (37446) → realistic Apple silicon string
      if (parameter === 37446) return 'Apple M1 Pro, OpenGL 4.1';
      return getParameter.call(this, parameter);
    };
  } catch {}

  try {
    // 3. navigator.plugins: real PluginArray with MimeType objects.
    const makePlugin = (name, filename, desc, mimes) => {
      const p = Object.create(Plugin.prototype);
      Object.defineProperties(p, {
        name: { get: () => name },
        filename: { get: () => filename },
        description: { get: () => desc },
        length: { get: () => mimes.length },
      });
      mimes.forEach((m, i) => { p[i] = m; });
      p.item = (i) => mimes[i];
      p.namedItem = (n) => mimes.find((m) => m.type === n);
      return p;
    };
    const makeMime = (type, suffixes, desc) => {
      const m = Object.create(MimeType.prototype);
      Object.defineProperties(m, {
        type: { get: () => type },
        suffixes: { get: () => suffixes },
        description: { get: () => desc },
      });
      return m;
    };
    const pdfMime = makeMime('application/pdf', 'pdf', '');
    const cpdfMime = makeMime('application/x-google-chrome-pdf', 'pdf', 'Portable Document Format');
    const plugins = [
      makePlugin('PDF Viewer', 'internal-pdf-viewer', '', [pdfMime]),
      makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', '', [cpdfMime]),
      makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', '', [cpdfMime]),
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = Object.create(PluginArray.prototype);
        Object.defineProperty(arr, 'length', { get: () => plugins.length });
        plugins.forEach((p, i) => { arr[i] = p; });
        arr.item = (i) => plugins[i];
        arr.namedItem = (n) => plugins.find((p) => p.name === n);
        arr.refresh = () => {};
        return arr;
      },
    });
  } catch {}

  try {
    // 4. window.chrome shape — chrome.app + chrome.runtime + loadTimes/csi.
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = { OnInstalledReason: {}, OnRestartRequiredReason: {} };
    }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function () {
        return { commitLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000 };
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function () {
        return { startE: Date.now(), onloadT: Date.now(), pageT: 0, tran: 15 };
      };
    }
  } catch {}

  try {
    // 5. mediaDevices — some headless builds drop it entirely.
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        get: () => ({ enumerateDevices: () => Promise.resolve([]) }),
      });
    }
  } catch {}

  try {
    // 6. CDP cdc_* property cleanup. Chromium under CDP sets cdc_*-prefixed
    //    globals (driver injection markers); a bot detector finds them by
    //    iterating window keys. Strip all matching keys.
    for (const k of Object.keys(window)) {
      if (k.startsWith('cdc_')) {
        try { delete window[k]; } catch {}
      }
    }
  } catch {}
})();
`;

function extendedModeEnabled(): boolean {
  const v = process.env.GSTACK_STEALTH;
  return v === 'extended' || v === '1' || v === 'true';
}

/**
 * Apply stealth patches to a fresh BrowserContext (or persistent
 * context). Called by browser-manager.launch() and launchHeaded().
 * Always applies the WEBDRIVER_MASK_SCRIPT; only applies the
 * EXTENDED_STEALTH_SCRIPT when GSTACK_STEALTH=extended.
 */
export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: WEBDRIVER_MASK_SCRIPT });
  if (extendedModeEnabled()) {
    await context.addInitScript({ content: EXTENDED_STEALTH_SCRIPT });
  }
}

/**
 * Args added to chromium.launch's `args` to suppress the
 * AutomationControlled blink feature. This is independent of the init
 * script — it changes how Chromium identifies itself in the protocol
 * layer.
 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
];

/** Test-only helper: report whether extended mode is currently active. */
export function isExtendedStealthEnabled(): boolean {
  return extendedModeEnabled();
}
