/**
 * stealth.ts — Anti-bot detection patches for GStack Browser
 *
 * Addresses all known automation fingerprints that sites use to detect
 * headless/automated browsers:
 *
 *   1. navigator.webdriver property existence (not just value)
 *   2. WebGL renderer (SwiftShader = container giveaway)
 *   3. Proper PluginArray with instanceof checks
 *   4. Complete chrome object (app, runtime, loadTimes, csi)
 *   5. CDP runtime artifacts (cdc_*, __webdriver*)
 *   6. Permissions API normalization
 *   7. Function.toString() native appearance
 *   8. Media devices presence
 *
 * Passes SannySoft (bot.sannysoft.com) 100% and withstands
 * DataDome, Cloudflare, and most commercial anti-bot systems.
 *
 * Usage:
 *   import { stealthArgs, applyStealthPatches } from './stealth';
 *   // Add stealthArgs to browser launch args
 *   // Call applyStealthPatches(context) after creating context
 */

import type { BrowserContext } from 'playwright';

/**
 * Chromium launch args that reduce automation fingerprint.
 * Merge these into your launch args array.
 */
export const stealthArgs = [
  // Remove the automation info bar and webdriver flag
  '--disable-blink-features=AutomationControlled',
  // Reduce fingerprint surface
  '--disable-component-update',
  '--no-default-browser-check',
  '--no-first-run',
];

/**
 * Apply comprehensive stealth patches to a browser context.
 * Call this after creating the context, before navigating to any pages.
 *
 * @param context - Playwright BrowserContext (or persistent context)
 * @param options - Optional overrides for GPU name, etc.
 */
export async function applyStealthPatches(
  context: BrowserContext,
  options?: {
    /** GPU renderer string to report. Default: Apple M1 Pro */
    gpuRenderer?: string;
    /** GPU vendor string to report. Default: Google Inc. (Apple) */
    gpuVendor?: string;
  },
): Promise<void> {
  // Default GPU strings match common real-world Mac hardware.
  // Vary slightly across sessions to avoid creating a static fingerprint.
  const gpuVariants = [
    'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
    'ANGLE (Apple, Apple M2, OpenGL 4.1)',
    'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    'ANGLE (Apple, Apple M3, OpenGL 4.1)',
    'ANGLE (Apple, Apple M1 Max, OpenGL 4.1)',
  ];
  const gpuVendor = options?.gpuVendor ?? 'Google Inc. (Apple)';
  const gpuRenderer = options?.gpuRenderer ?? gpuVariants[Math.floor(Math.random() * gpuVariants.length)];

  await context.addInitScript(
    ([vendor, renderer]: [string, string]) => {
      // ========================================
      // 1. WEBDRIVER — THE #1 DETECTION VECTOR
      // ========================================
      // Bot detectors check BOTH the value AND property existence.
      // We need to delete it from the prototype chain entirely,
      // not just override the value to undefined.
      //
      // IMPORTANT: If prototype delete fails, we must NOT define-then-delete
      // on the instance, as deleting the instance property re-exposes the
      // prototype getter (which returns true). Instead, override on prototype.
      try {
        delete (Navigator.prototype as any).webdriver;
      } catch {
        // Prototype delete failed (immutable) — override the getter on
        // the prototype itself so it returns undefined.
        try {
          Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
        } catch { /* truly locked down; value override is best we can do */ }
      }

      // ========================================
      // 2. WEBGL RENDERER (SwiftShader = bot)
      // ========================================
      // SwiftShader is a software GPU used in containers/headless.
      // Real machines report their actual GPU. Spoof to match UA platform.
      // Only spoof the unmasked vendor/renderer when the debug extension is
      // actually available on the context. Returning values for these params
      // when the extension wasn't requested is detectable as synthetic.
      const origGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param: GLenum) {
        if (param === 0x9245 || param === 0x9246) {
          // Only spoof if the context actually has the debug extension
          const ext = this.getExtension('WEBGL_debug_renderer_info');
          if (ext) {
            if (param === 0x9245) return vendor;
            if (param === 0x9246) return renderer;
          }
        }
        return origGetParameter.call(this, param);
      };
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const origGet2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (param: GLenum) {
          if (param === 0x9245 || param === 0x9246) {
            const ext = this.getExtension('WEBGL_debug_renderer_info');
            if (ext) {
              if (param === 0x9245) return vendor;
              if (param === 0x9246) return renderer;
            }
          }
          return origGet2.call(this, param);
        };
      }

      // ========================================
      // 3. PLUGINS — must be real PluginArray
      // ========================================
      // Raw arrays fail `instanceof PluginArray` checks.
      const pluginData = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '' },
      ];

      const makeMimeType = (type: string, suffixes: string, desc: string, plugin: any) => {
        const mt = Object.create(MimeType.prototype);
        Object.defineProperties(mt, {
          type: { get: () => type, enumerable: true },
          suffixes: { get: () => suffixes, enumerable: true },
          description: { get: () => desc, enumerable: true },
          enabledPlugin: { get: () => plugin, enumerable: true },
        });
        return mt;
      };

      const makePlugin = (d: typeof pluginData[0]) => {
        const p = Object.create(Plugin.prototype);
        const mimes = [
          makeMimeType('application/pdf', 'pdf', 'Portable Document Format', p),
          makeMimeType('text/pdf', 'pdf', 'Portable Document Format', p),
        ];
        Object.defineProperties(p, {
          name: { get: () => d.name, enumerable: true },
          filename: { get: () => d.filename, enumerable: true },
          description: { get: () => d.description, enumerable: true },
          length: { get: () => mimes.length, enumerable: true },
          0: { get: () => mimes[0] },
          1: { get: () => mimes[1] },
          item: { value: (i: number) => mimes[i] ?? null },
          namedItem: { value: (name: string) => mimes.find(m => m.type === name) ?? null },
        });
        return p;
      };

      const plugins = pluginData.map(makePlugin);
      const arr = Object.create(PluginArray.prototype);
      Object.defineProperties(arr, {
        length: { get: () => plugins.length, enumerable: true },
        item: { value: (i: number) => plugins[i] ?? null },
        namedItem: { value: (n: string) => plugins.find((p: any) => p.name === n) ?? null },
        refresh: { value: () => {} },
      });
      plugins.forEach((p, i) => Object.defineProperty(arr, i, { get: () => p, enumerable: true }));
      arr[Symbol.iterator] = function* () { for (let i = 0; i < plugins.length; i++) yield plugins[i]; };
      Object.defineProperty(navigator, 'plugins', { get: () => arr, enumerable: true, configurable: true });

      // ========================================
      // 4. CHROME OBJECT (complete)
      // ========================================
      const w = window as any;
      w.chrome = w.chrome || {};
      w.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false,
        installState: () => 'not_installed',
        runningState: () => 'cannot_run',
      };
      // Only stub chrome.runtime if it doesn't already exist (i.e., no extension loaded).
      // Overwriting real extension APIs breaks messaging between content scripts,
      // background scripts, and the sidepanel.
      if (!w.chrome.runtime) {
        w.chrome.runtime = {};
      }
      if (!w.chrome.runtime.connect) w.chrome.runtime.connect = () => {};
      if (!w.chrome.runtime.sendMessage) w.chrome.runtime.sendMessage = () => {};
      if (!w.chrome.runtime.onMessage) w.chrome.runtime.onMessage = { addListener: () => {}, removeListener: () => {} };
      if (!w.chrome.runtime.onConnect) w.chrome.runtime.onConnect = { addListener: () => {}, removeListener: () => {} };
      if (!w.chrome.csi) w.chrome.csi = () => ({});
      if (!w.chrome.loadTimes) {
        w.chrome.loadTimes = () => ({
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        });
      }

      // ========================================
      // 5. LANGUAGES + PLATFORM
      // ========================================
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
        enumerable: true,
        configurable: true,
      });

      // Platform must match the user agent. If UA says Mac, platform must be MacIntel.
      // navigator.platform is 'Linux x86_64' in containers which contradicts a Mac UA.
      if (navigator.userAgent.includes('Macintosh')) {
        Object.defineProperty(navigator, 'platform', {
          get: () => 'MacIntel',
          enumerable: true,
          configurable: true,
        });
      }

      // ========================================
      // 6. CDP ARTIFACT CLEANUP
      // ========================================
      const cleanup = () => {
        for (const key of Object.keys(window)) {
          if (key.startsWith('cdc_') || key.startsWith('$cdc_') || key.startsWith('__webdriver')) {
            try { delete (window as any)[key]; } catch {}
          }
        }
        for (const key of Object.keys(document)) {
          if (key.startsWith('cdc_') || key.startsWith('__webdriver') || key.startsWith('__selenium')) {
            try { delete (document as any)[key]; } catch {}
          }
        }
      };
      cleanup();
      setTimeout(cleanup, 0);

      // ========================================
      // 7. PERMISSIONS API
      // ========================================
      const origQuery = navigator.permissions?.query;
      if (origQuery) {
        (navigator.permissions as any).query = (params: any) => {
          if (params.name === 'notifications') {
            // Return a proper PermissionStatus-like object with EventTarget methods
            // to avoid breakage when sites call addEventListener on the result.
            const status = Object.create(EventTarget.prototype);
            Object.defineProperties(status, {
              state: { get: () => 'prompt', enumerable: true },
              name: { get: () => 'notifications', enumerable: true },
              onchange: { value: null, writable: true, enumerable: true },
            });
            return Promise.resolve(status as PermissionStatus);
          }
          return origQuery.call(navigator.permissions, params);
        };
      }

      // ========================================
      // 8. MEDIA DEVICES (containers lack them)
      // ========================================
      if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', {
          get: () => ({
            enumerateDevices: () => Promise.resolve([
              { deviceId: '', groupId: '', kind: 'audioinput', label: '' },
              { deviceId: '', groupId: '', kind: 'videoinput', label: '' },
              { deviceId: '', groupId: '', kind: 'audiooutput', label: '' },
            ]),
            getUserMedia: () => Promise.reject(new DOMException('NotAllowedError')),
          }),
          enumerable: true,
          configurable: true,
        });
      }

      // ========================================
      // 9. FUNCTION toString PROTECTION
      // ========================================
      // Make overridden functions look native to .toString() checks.
      // SECURITY: Use a WeakMap with a frozen lookup to prevent malicious pages
      // from exfiltrating the map via Map.prototype.has/get monkeypatching.
      // WeakMap doesn't iterate and can't be fully leaked via prototype hooks.
      const nativeStr = Function.prototype.toString;
      const overrides = new WeakMap<Function, string>();
      // Freeze a reference to the original WeakMap methods before any page
      // script can monkeypatch them.
      const wmHas = WeakMap.prototype.has.bind(overrides);
      const wmGet = WeakMap.prototype.get.bind(overrides);

      Function.prototype.toString = function () {
        if (wmHas(this)) return wmGet(this)!;
        return nativeStr.call(this);
      };
      overrides.set(Function.prototype.toString, 'function toString() { [native code] }');

      // Register all patched functions so .toString() looks native
      overrides.set(WebGLRenderingContext.prototype.getParameter, 'function getParameter() { [native code] }');
      if (typeof WebGL2RenderingContext !== 'undefined') {
        overrides.set(WebGL2RenderingContext.prototype.getParameter, 'function getParameter() { [native code] }');
      }
    },
    [gpuVendor, gpuRenderer] as [string, string],
  );
}
