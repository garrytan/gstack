/**
 * Stealth init script — Layer C of GBrowser's anti-detection plan.
 *
 * D7 (codex correction, kept): Layer C (the always-on default built by
 * buildStealthScript) does NOT fake navigator.plugins or
 * navigator.languages — modern fingerprinters cross-check those against
 * userAgent / platform / OS, and synthesizing fixed values flags MORE
 * bot-like, not less. Plugins and languages surface their native
 * Chromium values. The opt-in EXTENDED_STEALTH_SCRIPT below (gated on
 * GSTACK_STEALTH=extended, off by default) DOES fake plugins — that mode
 * is the documented "actively lies, may break sites" escape hatch, not
 * the default posture.
 *
 * What this script DOES do (the new additions for Phase 1):
 *   1. Mask navigator.webdriver (the canonical headless tell).
 *   2. Restore window.chrome.runtime / app / csi / loadTimes — real
 *      Chrome ships them; their absence in headless/automation is a
 *      universally-checked tell. (Vendor research: Cloudflare + DataDome
 *      check chrome.runtime presence + enum shape.)
 *   3. Align Notification.permission with the Permissions API spoof
 *      that the inline addInitScript already applies — `denied` while
 *      Permissions returns `prompt` is a cross-source inconsistency
 *      detectors flag.
 *   4. Report per-install hardware values via GSTACK_HW_CONCURRENCY /
 *      GSTACK_DEVICE_MEMORY env vars (set by gbd at startup via
 *      system_profiler + sysctl). Per-install honesty avoids the
 *      cross-user fingerprint cluster a hardcoded default would create.
 *   5. Install a Function.prototype.toString Proxy that makes every
 *      patched getter report `function ... { [native code] }` at every
 *      recursion depth — defeats the well-known depth-3 detection trick
 *      (`fn.toString.toString.toString().includes('[native code]')`)
 *      that breaks naive stealth tooling.
 *
 * Codex caveat (acknowledged): a Proxy on Function.prototype.toString
 * still has detection surfaces (descriptors, Reflect.ownKeys, cross-
 * realm identity). Phase 2's C++ patches make this layer obsolete by
 * pushing the spoofs to native code where toString is truly native.
 * Until then, this is the best JS-only approach.
 */

import type { BrowserContext } from 'playwright';

/**
 * Host hardware values resolved at browser-manager startup. Values come
 * from the gbd `host_profile.go` detection (system_profiler + sysctl
 * on macOS), passed through the GSTACK_* env vars. Each field falls
 * back to a documented default if the env var is missing or unparseable.
 */
interface HostProfile {
  hwConcurrency: number;
  deviceMemory: number;
}

// Exported for the clamp/fallback unit test. The platform spoof is owned by
// the UA-CH cmdline switch in buildGStackLaunchArgs (which reads GSTACK_PLATFORM
// directly), so this profile only carries the values buildStealthScript bakes
// into the page-world script.
export function readHostProfile(): HostProfile {
  const env = (globalThis as any).process?.env ?? {};
  const concurrency = Number(env.GSTACK_HW_CONCURRENCY);
  const memory = Number(env.GSTACK_DEVICE_MEMORY);
  return {
    // Clamp to a plausible default: 0/NaN/negative/missing all fall back to 8.
    // deviceMemory=0 or NaN would be a glaring bot tell, so never report it.
    hwConcurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 8,
    deviceMemory: Number.isFinite(memory) && memory > 0 ? memory : 8,
  };
}

/**
 * Build the full Layer C stealth init script. The function template-
 * literal-interpolates the host values so they bake into the script the
 * page sees — process.env is not accessible from a page-world init script,
 * so values must be resolved by the browser-manager process before
 * injection.
 *
 * The script is one big self-invoking function so all the patches
 * happen atomically before any page code runs. Order matters: the
 * Function.prototype.toString Proxy installs FIRST so all subsequent
 * defineProperty getters are covered by its native-code lie.
 */
export function buildStealthScript(hw: HostProfile): string {
  return `(() => {
  // ──── Function.prototype.toString Proxy (must run first) ────
  // Make every patched getter / function below report
  // 'function NAME() { [native code] }' at every recursion depth.
  // Defeats fn.toString.toString.toString() integrity checks.
  const patchedFns = new WeakSet();
  const nativeToString = Function.prototype.toString;
  const toStringProxy = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      if (patchedFns.has(thisArg)) {
        const name = (thisArg && thisArg.name) || '';
        return 'function ' + name + '() { [native code] }';
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  Object.defineProperty(Function.prototype, 'toString', {
    value: toStringProxy, writable: true, configurable: true,
  });
  const markNative = (fn, name) => {
    if (name) {
      try { Object.defineProperty(fn, 'name', { value: name }); } catch {}
    }
    patchedFns.add(fn);
    return fn;
  };

  // ──── navigator.webdriver (canonical mask, kept from D7) ────
  try {
    const webdriverGetter = markNative(function() { return false; }, 'get webdriver');
    Object.defineProperty(navigator, 'webdriver', { get: webdriverGetter, configurable: true });
  } catch {}

  // ──── window.chrome.* restoration ────
  // Real Chrome ships these objects with rich enum / method shape.
  // Headless Chromium / Playwright's launch strips them. Their absence
  // is a universally-checked tell (verified in Cloudflare + DataDome
  // RE catalogs). We don't try to perfectly mimic — we ship plausible
  // shape with native-code-looking methods.
  try {
    if (!('chrome' in window)) {
      window.chrome = {};
    }
    const chrome = window.chrome;
    if (!chrome.runtime) {
      chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install',
                            SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64',
                       X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64',
                           X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux',
                     MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled',
                                   UPDATE_AVAILABLE: 'update_available' },
        connect: markNative(function connect() {
          throw new TypeError('Error in invocation of runtime.connect: No matching signature.');
        }, 'connect'),
        sendMessage: markNative(function sendMessage() {
          throw new TypeError('Error in invocation of runtime.sendMessage: No matching signature.');
        }, 'sendMessage'),
        id: undefined,
      };
    }
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      };
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = markNative(function csi() {
        return {
          onloadT: Date.now(),
          pageT: performance.now(),
          startE: Date.now() - 1000,
          tran: 15,
        };
      }, 'csi');
    }
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = markNative(function loadTimes() {
        const t = performance.timing;
        return {
          requestTime: t.requestStart / 1000,
          startLoadTime: t.requestStart / 1000,
          commitLoadTime: t.responseStart / 1000,
          finishDocumentLoadTime: t.domContentLoadedEventEnd / 1000,
          finishLoadTime: t.loadEventEnd / 1000,
          firstPaintTime: t.responseEnd / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        };
      }, 'loadTimes');
    }
  } catch (err) {
    // Non-fatal — page might have a stricter Content Security Policy
    // that blocks property mutation on window. Leave chrome.* whatever
    // shape it was; navigator.webdriver mask still applies.
  }

  // ──── Notification.permission align with Permissions API ────
  // The inline addInitScript already overrides permissions.query for
  // notifications → 'prompt'. Notification.permission must match
  // ('default' in real Chrome on pages that haven't asked yet).
  try {
    if (typeof Notification !== 'undefined') {
      const notificationPermissionGetter = markNative(function() { return 'default'; }, 'get permission');
      Object.defineProperty(Notification, 'permission', {
        get: notificationPermissionGetter,
        configurable: true,
      });
    }
  } catch {}

  // ──── Per-install hardware values from GSTACK_* env (T2) ────
  // gbd's host_profile.go fed real host values via cmdline env. Reporting
  // those (not hardcoded defaults) avoids the cross-user GBrowser
  // fingerprint cluster.
  try {
    const hwConcurrencyGetter = markNative(function() { return ${hw.hwConcurrency}; }, 'get hardwareConcurrency');
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: hwConcurrencyGetter,
      configurable: true,
    });
  } catch {}
  try {
    const deviceMemoryGetter = markNative(function() { return ${hw.deviceMemory}; }, 'get deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', {
      get: deviceMemoryGetter,
      configurable: true,
    });
  } catch {}

  // ──── Selenium / Phantom / Nightmare / Playwright global cleanup ────
  // Static known-name list of Selenium / Playwright / PhantomJS / Nightmare
  // globals. AUTOMATION_ARTIFACT_CLEANUP_SCRIPT (applied right after this on
  // every path) covers the cdc_/__webdriver dynamic prefixes; this list is the
  // fixed-name complement.
  try {
    const auto = [
      '__driver_evaluate', '__webdriver_evaluate', '__selenium_evaluate', '__fxdriver_evaluate',
      '__driver_unwrapped', '__webdriver_unwrapped', '__selenium_unwrapped', '__fxdriver_unwrapped',
      '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
      '$chrome_asyncScriptInfo',
      '__$webdriverAsyncExecutor', '__webdriverFunc',
      'domAutomation', 'domAutomationController',
      '__lastWatirAlert', '__lastWatirConfirm', '__lastWatirPrompt',
      '__webdriver_script_fn', '_WEBDRIVER_ELEM_CACHE',
      'callPhantom', '_phantom', 'phantom', '__nightmare',
      '__pwInitScripts', '__playwright__binding__',
    ];
    for (const k of auto) {
      try { delete window[k]; } catch {}
    }
    try { delete document.__webdriver_script_fn; } catch {}
  } catch {}
})();`;
}

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
    //    Note: via applyStealth this is redundant with AUTOMATION_ARTIFACT_
    //    CLEANUP_SCRIPT (which runs first on every path). Kept so this script
    //    is self-sufficient if ever applied standalone.
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
 * Strip automation runtime artifacts that don't belong in a real browser
 * and that no fingerprint-synthesis layer can mask: ChromeDriver/CDP window
 * globals (cdc_*, __webdriver*) and the Permissions API quirk where an
 * automated Chromium reports notifications as 'denied' instead of real
 * Chrome's 'prompt'. The 'prompt' answer is aligned with Layer C's
 * Notification.permission = 'default' so the two surfaces stay consistent.
 *
 * Runs on EVERY launch path via applyStealth (headless launch(),
 * launchHeaded(), handoff()) so the Notification/Permissions pairing never
 * diverges by mode. Previously this lived inline in launchHeaded() only,
 * which left headless and handoff with the Notification value but not the
 * matching Permissions answer.
 */
export const AUTOMATION_ARTIFACT_CLEANUP_SCRIPT = `(() => {
  // cdc_/__webdriver globals are injected by ChromeDriver/CDP. A detector
  // finds them by iterating window keys. Strip immediately and again after a
  // tick in case they are injected late.
  const cleanup = () => {
    for (const key of Object.keys(window)) {
      if (key.startsWith('cdc_') || key.startsWith('__webdriver')) {
        try { delete window[key]; } catch (e) { if (!(e instanceof TypeError)) throw e; }
      }
    }
  };
  cleanup();
  setTimeout(cleanup, 0);

  // Permissions API: automated Chromium returns 'denied' for notifications,
  // a known tell. Return 'prompt' to match real Chrome (and Layer C's
  // Notification.permission = 'default'). Tradeoff: this pins the
  // notifications state to fresh-Chrome values for the whole session, so a
  // site that actually grants/denies notifications would see a stale value.
  // Acceptable for the automation/anti-detection use case (which does not
  // drive real notification grants); only notifications is overridden.
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return originalQuery.call(window.navigator.permissions, params);
    };
  }
})();`;

/**
 * Apply stealth patches to a fresh BrowserContext (or persistent context).
 * Called by EVERY context-creation path in browser-manager — launch(),
 * launchHeaded(), handoff(), AND recreateContext() (the useragent /
 * viewport --scale rebuild) — so a context can never reach a page un-stealthed.
 *
 * Injection order (Playwright evaluates init scripts in registration order):
 *   1. Layer C (buildStealthScript) — the always-on consistency-first default.
 *   2. Automation-artifact cleanup (cdc_/__webdriver + Permissions shim),
 *      kept consistent with Layer C's Notification.permission alignment.
 *   3. EXTENDED_STEALTH_SCRIPT — only when GSTACK_STEALTH=extended (off by
 *      default). Its window.chrome.* patches are `if (!...)`-guarded, so
 *      Layer C's richer shapes win; the extended-only additions (WebGL spoof,
 *      faked navigator.plugins, mediaDevices) apply on top.
 *
 * KNOWN LIMITATION (extended mode only, opt-in): extended's functions are NOT
 * wrapped by Layer C's Function.prototype.toString proxy, so they stringify
 * as injected code; its prototype-level navigator.webdriver delete is shadowed
 * by Layer C's own-property getter (net behavior still matches real Chrome:
 * webdriver present and false); and its hardcoded Apple-M1 WebGL string can
 * disagree with the env-driven GPU spoof in buildGStackLaunchArgs on non-Apple
 * hosts. This is acceptable for the documented "actively lies, may break sites"
 * escape hatch; the consistency-first default (Layer C alone) has none of these.
 *
 * Host profile is resolved from process.env at call time so per-install
 * values bake into the script before Playwright sends it to Chromium via
 * Page.addScriptToEvaluateOnNewDocument.
 */
export async function applyStealth(context: BrowserContext): Promise<void> {
  const hw = readHostProfile();
  await context.addInitScript({ content: buildStealthScript(hw) });
  await context.addInitScript({ content: AUTOMATION_ARTIFACT_CLEANUP_SCRIPT });
  if (extendedModeEnabled()) {
    await context.addInitScript({ content: EXTENDED_STEALTH_SCRIPT });
  }
}

/**
 * The legacy single-line webdriver mask, exported for backwards
 * compatibility with any caller that uses it directly. New callers
 * should use applyStealth() which includes this plus the Layer C
 * additions.
 */
export const WEBDRIVER_MASK_SCRIPT = `Object.defineProperty(navigator, 'webdriver', { get: () => false });`;

/**
 * Args added to chromium.launch's `args` to suppress the
 * AutomationControlled blink feature. This is independent of the init
 * script — it changes how Chromium identifies itself in the protocol layer.
 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
];

/**
 * Build the `--gstack-*=` cmdline switches that the Pack 1 Chromium
 * patches read (webgl-vendor-spoof, ua-client-hints-stealth, worker-
 * navigator-stealth). Values come from the GSTACK_* env vars that
 * gbd populates from host_profile.go at startup.
 *
 * Each switch is only emitted when its env var is non-empty — empty
 * env values fall through to the patch's "no override" path, which
 * returns the real Chromium native value. This keeps the helper safe
 * on builds that DO NOT have the C++ patches applied (gbrowser
 * pre-Pack-1) and on hosts where gbd hasn't yet populated some
 * fields (legacy installs).
 *
 * TRUSTED-SOURCE ONLY. These GSTACK_* values are populated by gbd from
 * host_profile.go (system_profiler / sysctl) and become page-visible WebGL /
 * UA-CH surface data. They are NOT sanitized here (passed verbatim into the
 * argv array, which is injection-safe because Playwright spawns Chromium with
 * an argv array, not a shell). NEVER route page content, HTTP headers, or any
 * remote/untrusted input into these env vars — that would turn this into an
 * argv-injection sink. readHostProfile() applies the same trust assumption.
 *
 * Mapping (gbd env → Chromium cmdline switch → C++ patch consumer):
 *   GSTACK_GPU_VENDOR        → --gstack-gpu-vendor        → webgl-vendor-spoof.patch
 *   GSTACK_GPU_RENDERER      → --gstack-gpu-renderer      → webgl-vendor-spoof.patch
 *   GSTACK_PLATFORM          → --gstack-ua-platform       → ua-client-hints-stealth.patch
 *                              (maps MacARM/MacIntel → "macOS")
 *   GSTACK_GPU_CHIPSET       → --gstack-ua-model          → ua-client-hints-stealth.patch
 *   GSTACK_HW_CONCURRENCY    → --gstack-hw-concurrency    → worker-navigator-stealth.patch
 *   GSTACK_DEVICE_MEMORY     → --gstack-device-memory     → worker-navigator-stealth.patch
 */
export function buildGStackLaunchArgs(): string[] {
  const env = (globalThis as any).process?.env ?? {};
  const args: string[] = [];

  const vendor = env.GSTACK_GPU_VENDOR;
  if (vendor) args.push(`--gstack-gpu-vendor=${vendor}`);

  const renderer = env.GSTACK_GPU_RENDERER;
  if (renderer) args.push(`--gstack-gpu-renderer=${renderer}`);

  // Map gbd's "MacARM"/"MacIntel" classification to the UA-CH "macOS"
  // platform string Chromium emits natively. Other future platforms
  // would map similarly (Win32 → "Windows", Linux → "Linux").
  const platform = env.GSTACK_PLATFORM;
  if (platform === 'MacARM' || platform === 'MacIntel') {
    args.push('--gstack-ua-platform=macOS');
  } else if (platform === 'Win32') {
    args.push('--gstack-ua-platform=Windows');
  } else if (platform && platform.startsWith('Linux')) {
    args.push('--gstack-ua-platform=Linux');
  }

  const chipset = env.GSTACK_GPU_CHIPSET;
  if (chipset) args.push(`--gstack-ua-model=${chipset}`);

  const hw = env.GSTACK_HW_CONCURRENCY;
  if (hw) args.push(`--gstack-hw-concurrency=${hw}`);

  const memory = env.GSTACK_DEVICE_MEMORY;
  if (memory) args.push(`--gstack-device-memory=${memory}`);

  // Pack 2 / B11: suppress user-defined Error.prepareStackTrace during
  // V8 stack-trace formatting. Closes the Cloudflare Bot Management canary
  // trick where a page sets prepareStackTrace and watches for it to fire
  // during CDP serialization.
  //
  // OPT-IN (off by default): only emitted when GSTACK_CDP_STEALTH is
  // on/1/true. This switch is read by a C++ patch that only exists in
  // gbrowser builds; gbd opts in by exporting GSTACK_CDP_STEALTH=on. Stock
  // Playwright Chromium leaves it unset, so the flag never reaches a
  // Chromium that wouldn't understand it. (Previously this was on-by-default
  // unless GSTACK_CDP_STEALTH=off, which contradicted this very comment.)
  const cdpStealth = env.GSTACK_CDP_STEALTH;
  if (cdpStealth === 'on' || cdpStealth === '1' || cdpStealth === 'true') {
    args.push('--gstack-suppress-prepare-stack-trace');
  }

  return args;
}

/**
 * Playwright default args to strip via ignoreDefaultArgs.
 *
 * Playwright passes these by default. Each one is a visible automation
 * tell at some layer:
 *   --enable-automation                              → infobar + chrome shape
 *   --disable-extensions                             → blocks our extension
 *   --disable-component-extensions-with-background-pages → blocks component ext
 *   --disable-popup-blocking                         → automation default
 *   --disable-component-update                       → automation default
 *   --disable-default-apps                           → affects plugin enum
 *
 * Used by browser-manager via spread into ignoreDefaultArgs to keep
 * the list in one place across launchHeaded() and handoff().
 */
export const STEALTH_IGNORE_DEFAULT_ARGS = [
  '--enable-automation',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-default-apps',
];

/** Test-only helper: report whether extended mode is currently active. */
export function isExtendedStealthEnabled(): boolean {
  return extendedModeEnabled();
}
