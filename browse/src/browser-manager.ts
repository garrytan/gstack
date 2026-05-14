/**
 * Browser lifecycle manager
 *
 * Chromium crash handling:
 *   browser.on('disconnected') → log error → process.exit(1)
 *   CLI detects dead server → auto-restarts on next command
 *   We do NOT try to self-heal — don't hide failure.
 *
 * Dialog handling:
 *   page.on('dialog') → auto-accept by default → store in dialog buffer
 *   Prevents browser lockup from alert/confirm/prompt
 *
 * Context recreation (useragent):
 *   recreateContext() saves cookies/storage/URLs, creates new context,
 *   restores state. Falls back to clean slate on any failure.
 */

import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Locator, type Cookie } from 'playwright';
import { writeSecureFile, mkdirSecure } from './file-permissions';
import { addConsoleEntry, addNetworkEntry, addDialogEntry, networkBuffer, type DialogEntry } from './buffers';
import { validateNavigationUrl } from './url-validation';
import { TabSession, type RefEntry } from './tab-session';
import { resolveChromiumProfile, cleanSingletonLocks } from './config';

/**
 * Detect whether GSTACK_CHROMIUM_PATH points at a custom Chromium build that
 * already bakes the gstack extension in as a component extension (e.g.,
 * GStack Browser.app / GBrowser). Passing --load-extension against such a
 * binary triggers a ServiceWorkerState::SetWorkerId DCHECK because two
 * copies of the same service worker try to register.
 *
 * Resolution:
 *   1. GSTACK_CHROMIUM_KIND === 'custom-extension-baked' (preferred, explicit)
 *   2. GSTACK_CHROMIUM_PATH path substring contains 'GBrowser' or 'gbrowser'
 *      (fallback for callers that only set the path)
 */
export function isCustomChromium(): boolean {
  if (process.env.GSTACK_CHROMIUM_KIND === 'custom-extension-baked') return true;
  const p = process.env.GSTACK_CHROMIUM_PATH || '';
  return p.includes('GBrowser') || p.includes('gbrowser');
}

export type { RefEntry };

// Re-export TabSession for consumers
export { TabSession };

export interface BrowserState {
  cookies: Cookie[];
  pages: Array<{
    url: string;
    isActive: boolean;
    storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null;
    /**
     * HTML content loaded via load-html (setContent), replayed after context recreation.
     * In-memory only — never persisted to disk (HTML may contain secrets or customer data).
     */
    loadedHtml?: string;
    loadedHtmlWaitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
    /**
     * Tab owner clientId for multi-agent isolation. Survives context recreation so
     * scoped agents don't get locked out of their own tabs after viewport --scale.
     * In-memory only.
     */
    owner?: string;
  }>;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  // Proxy config applied to chromium.launch() when set (D8). Set by server.ts
  // at startup based on BROWSE_PROXY_URL. For SOCKS5 with auth, server.ts
  // points this at the local bridge (socks5://127.0.0.1:<bridgePort>); for
  // HTTP/HTTPS or unauth SOCKS5, it's the upstream URL directly.
  private proxyConfig: { server: string; username?: string; password?: string } | null = null;
  private pages: Map<number, Page> = new Map();
  private tabSessions: Map<number, TabSession> = new Map();
  private activeTabId: number = 0;
  private nextTabId: number = 1;
  private extraHeaders: Record<string, string> = {};
  private customUserAgent: string | null = null;

  // ─── Viewport + deviceScaleFactor (context options) ──────────
  // Tracked at the manager level so recreateContext() preserves them.
  // deviceScaleFactor is a *context* option, not a page-level setter — changes
  // require recreateContext(). Viewport width/height can change on-page, but we
  // track the latest so context recreation restores it instead of hardcoding 1280x720.
  private deviceScaleFactor: number = 1;
  private currentViewport: { width: number; height: number } = { width: 1280, height: 720 };

  /** Server port — set after server starts, used by cookie-import-browser command */
  public serverPort: number = 0;

  // ─── Tab Ownership (multi-agent isolation) ──────────────
  // Maps tabId → clientId. Unowned tabs (not in this map) are root-only for writes.
  private tabOwnership: Map<number, string> = new Map();

  // ─── Dialog Handling (global, not per-tab) ──────────────────
  private dialogAutoAccept: boolean = true;
  private dialogPromptText: string | null = null;

  // ─── Cookie Origin Tracking ────────────────────────────────
  private cookieImportedDomains: Set<string> = new Set();

  // ─── Handoff State ─────────────────────────────────────────
  private isHeaded: boolean = false;
  private consecutiveFailures: number = 0;

  // ─── Watch Mode ─────────────────────────────────────────
  private watching = false;
  public watchInterval: ReturnType<typeof setInterval> | null = null;
  private watchSnapshots: string[] = [];
  private watchStartTime: number = 0;

  // ─── Headed State ────────────────────────────────────────
  private connectionMode: 'launched' | 'headed' = 'launched';
  private intentionalDisconnect = false;

  // Called when the headed browser disconnects without intentional teardown
  // (user closed the window). Wired up by server.ts to run full cleanup
  // (sidebar-agent, state file, profile locks) before exiting with code 2.
  // Returns void or a Promise; rejections are caught and fall back to exit(2).
  public onDisconnect: (() => void | Promise<void>) | null = null;

  getConnectionMode(): 'launched' | 'headed' { return this.connectionMode; }

  // ─── Watch Mode Methods ─────────────────────────────────
  isWatching(): boolean { return this.watching; }

  startWatch(): void {
    this.watching = true;
    this.watchSnapshots = [];
    this.watchStartTime = Date.now();
  }

  stopWatch(): { snapshots: string[]; duration: number } {
    this.watching = false;
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    const snapshots = this.watchSnapshots;
    const duration = Date.now() - this.watchStartTime;
    this.watchSnapshots = [];
    this.watchStartTime = 0;
    return { snapshots, duration };
  }

  addWatchSnapshot(snapshot: string): void {
    this.watchSnapshots.push(snapshot);
  }

  /**
   * Find the gstack Chrome extension directory.
   * Checks: repo root /extension, global install, dev install.
   */
  private findExtensionPath(): string | null {
    const fs = require('fs');
    const path = require('path');
    const candidates = [
      // Explicit override via env var (used by GStack Browser.app bundle)
      process.env.BROWSE_EXTENSIONS_DIR || '',
      // Relative to this source file (dev mode: browse/src/ -> ../../extension)
      path.resolve(__dirname, '..', '..', 'extension'),
      // Global gstack install
      path.join(process.env.HOME || '', '.claude', 'skills', 'gstack', 'extension'),
      // Git repo root (detected via BROWSE_STATE_FILE location)
      (() => {
        const stateFile = process.env.BROWSE_STATE_FILE || '';
        if (stateFile) {
          const repoRoot = path.resolve(path.dirname(stateFile), '..');
          return path.join(repoRoot, '.claude', 'skills', 'gstack', 'extension');
        }
        return '';
      })(),
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
          return candidate;
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT' && err?.code !== 'EACCES') throw err;
      }
    }
    return null;
  }

  /**
   * Set the proxy config applied to chromium.launch() in launch() and
   * launchHeaded(). Called by server.ts at startup once the (optional) SOCKS5
   * bridge is up.
   */
  setProxyConfig(cfg: { server: string; username?: string; password?: string } | null): void {
    this.proxyConfig = cfg;
  }

  /**
   * Get the ref map for external consumers (e.g., /refs endpoint).
   */
  getRefMap(): Array<{ ref: string; role: string; name: string }> {
    try {
      return this.getActiveSession().getRefEntries();
    } catch {
      return [];
    }
  }

  async launch() {
    // ─── Extension Support ────────────────────────────────────
    // BROWSE_EXTENSIONS_DIR points to an unpacked Chrome extension directory.
    // Extensions only work in headed mode, so we use an off-screen window.
    const extensionsDir = process.env.BROWSE_EXTENSIONS_DIR;
    const { STEALTH_LAUNCH_ARGS } = await import('./stealth');
    const launchArgs: string[] = [...STEALTH_LAUNCH_ARGS];
    let useHeadless = true;

    // Docker/CI/root: Chromium sandbox requires unprivileged user namespaces which
    // are typically disabled in containers and are never available for the root
    // user on Linux. Detect all three cases and add --no-sandbox automatically.
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (process.env.CI || process.env.CONTAINER || isRoot) {
      launchArgs.push('--no-sandbox');
    }

    if (extensionsDir) {
      launchArgs.push(
        `--disable-extensions-except=${extensionsDir}`,
        `--load-extension=${extensionsDir}`,
        '--window-position=-9999,-9999',
        '--window-size=1,1',
      );
      useHeadless = false; // extensions require headed mode; off-screen window simulates headless
      console.log(`[browse] Extensions loaded from: ${extensionsDir}`);
    }

    this.browser = await chromium.launch({
      headless: useHeadless,
      // On Windows, Chromium's sandbox fails when the server is spawned through
      // the Bun→Node process chain (GitHub #276). Disable it — local daemon
      // browsing user-specified URLs has marginal sandbox benefit.
      chromiumSandbox: process.platform !== 'win32',
      ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
      ...(this.proxyConfig ? { proxy: this.proxyConfig } : {}),
    });

    // Chromium crash → exit with clear message
    this.browser.on('disconnected', () => {
      console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      console.error('[browse] Console/network logs flushed to .gstack/browse-*.log');
      process.exit(1);
    });

    const contextOptions: BrowserContextOptions = {
      viewport: { width: this.currentViewport.width, height: this.currentViewport.height },
      deviceScaleFactor: this.deviceScaleFactor,
    };
    if (this.customUserAgent) {
      contextOptions.userAgent = this.customUserAgent;
    }
    this.context = await this.browser.newContext(contextOptions);

    if (Object.keys(this.extraHeaders).length > 0) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }

    // D7: mask navigator.webdriver only. The other 3 wintermute patches
    // (plugins, languages, chrome.runtime) are intentionally NOT applied —
    // faking them to fixed values can flag more bot-like to modern
    // fingerprinters, not less.
    const { applyStealth } = await import('./stealth');
    await applyStealth(this.context);

    // Create first tab
    await this.newTab();
  }

  // ─── Headed Mode ─────────────────────────────────────────────
  /**
   * Launch Playwright's bundled Chromium in headed mode with the gstack
   * Chrome extension auto-loaded. Uses launchPersistentContext() which
   * is required for extension loading (launch() + newContext() can't
   * load extensions).
   *
   * The browser launches headed with a visible window — the user sees
   * every action Claude takes in real time.
   */
  async launchHeaded(authToken?: string): Promise<void> {
    // Clear old state before repopulating
    this.pages.clear();
    this.tabSessions.clear();
    this.nextTabId = 1;

    // Find the gstack extension directory for auto-loading
    const extensionPath = this.findExtensionPath();
    const launchArgs = [
      '--hide-crash-restore-bubble',
      // Anti-bot-detection: remove the navigator.webdriver flag that Playwright sets.
      // Sites like Google and NYTimes check this to block automation browsers.
      '--disable-blink-features=AutomationControlled',
    ];
    if (extensionPath) {
      // Skip --load-extension when running against a custom Chromium build
      // that already bakes the extension in as a component extension
      // (gbrowser / GStack Browser.app). Loading it twice causes a
      // ServiceWorkerState::SetWorkerId DCHECK crash.
      if (!isCustomChromium()) {
        launchArgs.push(`--disable-extensions-except=${extensionPath}`);
        launchArgs.push(`--load-extension=${extensionPath}`);
      }
      // Write auth token for extension bootstrap (still required even when
      // the extension is component-baked — it reads ~/.gstack/.auth.json at
      // startup to learn how to call the daemon).
      // Write to ~/.gstack/.auth.json (not the extension dir, which may be read-only
      // in .app bundles and breaks codesigning).
      if (authToken) {
        const fs = require('fs');
        const path = require('path');
        const gstackDir = path.join(process.env.HOME || '/tmp', '.gstack');
        mkdirSecure(gstackDir);
        const authFile = path.join(gstackDir, '.auth.json');
        try {
          writeSecureFile(authFile, JSON.stringify({ token: authToken, port: this.serverPort || 34567 }));
        } catch (err: any) {
          console.warn(`[browse] Could not write .auth.json: ${err.message}`);
        }
      }
    }

    // Launch headed Chromium via Playwright's persistent context.
    // Extensions REQUIRE launchPersistentContext (not launch + newContext).
    // Real Chrome (executablePath/channel) silently blocks --load-extension,
    // so we use Playwright's bundled Chromium which reliably loads extensions.
    const fs = require('fs');
    const path = require('path');
    const userDataDir = resolveChromiumProfile();
    fs.mkdirSync(userDataDir, { recursive: true });

    // Pre-launch cleanup of stale SingletonLock/Socket/Cookie. Chromium's
    // ProcessSingleton refuses to start when these exist from a prior crash
    // (SIGKILL, hard crash) — the lockfiles point at a PID that may no longer
    // exist. Shutdown cleanup doesn't run on hard crashes, so we clean here
    // too. Safe under external coordination: gbd.lock for gbrowser,
    // single-instance CLI check for gstack.
    cleanSingletonLocks(userDataDir);

    // Support custom Chromium binary via GSTACK_CHROMIUM_PATH env var.
    // Used by GStack Browser.app to point at the bundled Chromium.
    const executablePath = process.env.GSTACK_CHROMIUM_PATH || undefined;

    // Rebrand Chromium → GStack Browser in macOS menu bar / Dock / Cmd+Tab.
    // Patch the Chromium .app's Info.plist so macOS shows our name.
    // This works for both dev mode (system Playwright cache) and .app bundle.
    const chromePath = executablePath || chromium.executablePath();
    try {
      // Walk up from binary to the .app's Info.plist
      // e.g. .../Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
      //   → .../Google Chrome for Testing.app/Contents/Info.plist
      const chromeContentsDir = path.resolve(path.dirname(chromePath), '..');
      const chromePlist = path.join(chromeContentsDir, 'Info.plist');
      if (fs.existsSync(chromePlist)) {
        const plistContent = fs.readFileSync(chromePlist, 'utf-8');
        if (plistContent.includes('Google Chrome for Testing')) {
          const patched = plistContent
            .replace(/Google Chrome for Testing/g, 'GStack Browser');
          fs.writeFileSync(chromePlist, patched);
        }
        // Replace Chromium's Dock icon with ours (Chromium's process owns the Dock icon)
        const iconCandidates = [
          path.join(__dirname, '..', '..', 'scripts', 'app', 'icon.icns'),       // repo dev mode
          path.join(process.env.HOME || '', '.claude', 'skills', 'gstack', 'scripts', 'app', 'icon.icns'), // global install
        ];
        const iconSrc = iconCandidates.find(p => fs.existsSync(p));
        if (iconSrc) {
          const chromeResources = path.join(chromeContentsDir, 'Resources');
          // Read original icon name from plist
          const iconMatch = plistContent.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);
          let origIcon = iconMatch ? iconMatch[1] : 'app';
          if (!origIcon.endsWith('.icns')) origIcon += '.icns';
          const destIcon = path.join(chromeResources, origIcon);
          try {
            fs.copyFileSync(iconSrc, destIcon);
          } catch (err: any) {
            if (err?.code !== 'ENOENT' && err?.code !== 'EACCES') throw err;
          }
        }
      }
    } catch (err: any) {
      // Non-fatal: app name stays as Chrome for Testing (ENOENT/EACCES expected)
      if (err?.code !== 'ENOENT' && err?.code !== 'EACCES') throw err;
    }

    // Build custom user agent: keep Chrome version for site compatibility,
    // but replace "Chrome for Testing" branding with "GStackBrowser"
    let customUA: string | undefined;
    if (!this.customUserAgent) {
      // Detect Chrome version from the Chromium binary
      const chromePath = executablePath || chromium.executablePath();
      try {
        const versionProc = Bun.spawnSync([chromePath, '--version'], {
          stdout: 'pipe', stderr: 'pipe', timeout: 5000,
        });
        const versionOutput = versionProc.stdout.toString().trim();
        // Output like: "Google Chrome for Testing 145.0.6422.0" or "Chromium 145.0.6422.0"
        const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+\.\d+)/);
        const chromeVersion = versionMatch ? versionMatch[1] : '131.0.0.0';
        customUA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 GStackBrowser`;
      } catch {
        // Fallback: generic modern Chrome UA
        customUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 GStackBrowser';
      }
    }

    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: launchArgs,
      viewport: null,  // Use browser's default viewport (real window size)
      userAgent: this.customUserAgent || customUA,
      ...(executablePath ? { executablePath } : {}),
      ...(this.proxyConfig ? { proxy: this.proxyConfig } : {}),
      // Playwright adds flags that block extension loading
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
      ],
    });
    this.browser = this.context.browser();
    this.connectionMode = 'headed';
    this.intentionalDisconnect = false;

    // ─── Anti-bot-detection patches ───────────────────────────────
    // D7 (codex correction): mask navigator.webdriver only. We do NOT fake
    // plugins/languages — modern fingerprinters check consistency between
    // those and userAgent/platform, and synthesizing fixed values can flag
    // MORE bot-like, not less. Let Chromium's natural plugins and languages
    // surface unmodified.
    //
    // What we DO clean up are automation-specific runtime artifacts that
    // shouldn't exist in a real browser at all (Permissions API quirks,
    // ChromeDriver-injected window globals). Those aren't fingerprint
    // synthesis — they're removing leaked automation tells.
    const { applyStealth } = await import('./stealth');
    await applyStealth(this.context);
    await this.context.addInitScript(() => {
      // Remove CDP runtime artifacts that automation detectors look for
      // cdc_ prefixed vars are injected by ChromeDriver/CDP
      const cleanup = () => {
        for (const key of Object.keys(window)) {
          if (key.startsWith('cdc_') || key.startsWith('__webdriver')) {
            try {
              delete (window as any)[key];
            } catch (e: any) {
              if (!(e instanceof TypeError)) throw e;
            }
          }
        }
      };
      cleanup();
      // Re-clean after a tick in case they're injected late
      setTimeout(cleanup, 0);

      // Override Permissions API to return 'prompt' for notifications
      // (automation browsers return 'denied' which is a fingerprint)
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        (window.navigator.permissions as any).query = (params: any) => {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus);
          }
          return originalQuery.call(window.navigator.permissions, params);
        };
      }
    });

    // Inject visual indicator — subtle top-edge amber gradient
    // Extension's content script handles the floating pill
    const indicatorScript = () => {
      const injectIndicator = () => {
        if (document.getElementById('gstack-ctrl')) return;

        const topLine = document.createElement('div');
        topLine.id = 'gstack-ctrl';
        topLine.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; height: 2px;
          background: linear-gradient(90deg, #F59E0B, #FBBF24, #F59E0B);
          background-size: 200% 100%;
          animation: gstack-shimmer 3s linear infinite;
          pointer-events: none; z-index: 2147483647;
          opacity: 0.8;
        `;

        const style = document.createElement('style');
        style.textContent = `
          @keyframes gstack-shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
          @media (prefers-reduced-motion: reduce) {
            #gstack-ctrl { animation: none !important; }
          }
        `;

        document.documentElement.appendChild(style);
        document.documentElement.appendChild(topLine);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectIndicator);
      } else {
        injectIndicator();
      }
    };
    await this.context.addInitScript(indicatorScript);

    // Track user-created tabs automatically (Cmd+T, link opens in new tab, etc.)
    this.context.on('page', (page) => {
      const id = this.nextTabId++;
      this.pages.set(id, page);
      this.tabSessions.set(id, new TabSession(page));
      this.activeTabId = id;
      this.wirePageEvents(page);
      // Inject indicator on the new tab
      page.evaluate(indicatorScript).catch(() => {});
      console.log(`[browse] New tab detected (id=${id}, total=${this.pages.size})`);
    });

    // Persistent context opens a default page — adopt it instead of creating a new one
    const existingPages = this.context.pages();
    if (existingPages.length > 0) {
      const page = existingPages[0];
      const id = this.nextTabId++;
      this.pages.set(id, page);
      this.tabSessions.set(id, new TabSession(page));
      this.activeTabId = id;
      this.wirePageEvents(page);
      // Inject indicator on restored page (addInitScript only fires on new navigations)
      try {
        await page.evaluate(indicatorScript);
      } catch {}
    } else {
      await this.newTab();
    }

    // Browser disconnect handler — exit code 2 distinguishes from crashes (1).
    // Calls onDisconnect() to trigger full shutdown (kill sidebar-agent, save
    // session, clean profile locks + state file) before exit. Falls back to
    // direct process.exit(2) if no callback is wired up, or if the callback
    // throws/rejects — never leave the process running with a dead browser.
    if (this.browser) {
      this.browser.on('disconnected', () => {
        if (this.intentionalDisconnect) return;
        console.error('[browse] Real browser disconnected (user closed or crashed).');
        console.error('[browse] Run `$B connect` to reconnect.');
        if (!this.onDisconnect) {
          process.exit(2);
          return;
        }
        try {
          const result = this.onDisconnect();
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => {
              console.error('[browse] onDisconnect rejected:', err);
              process.exit(2);
            });
          }
        } catch (err) {
          console.error('[browse] onDisconnect threw:', err);
          process.exit(2);
        }
      });
    }

    // Headed mode defaults
    this.dialogAutoAccept = false;  // Don't dismiss user's real dialogs
    this.isHeaded = true;
    this.consecutiveFailures = 0;
  }

  async close() {
    if (this.browser || (this.connectionMode === 'headed' && this.context)) {
      if (this.connectionMode === 'headed') {
        // Headed/persistent context mode: close the context (which closes the browser)
        this.intentionalDisconnect = true;
        if (this.browser) this.browser.removeAllListeners('disconnected');
        await Promise.race([
          this.context ? this.context.close() : Promise.resolve(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]).catch(() => {});
      } else {
        // Launched mode: close the browser we spawned
        this.browser.removeAllListeners('disconnected');
        await Promise.race([
          this.browser.close(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]).catch(() => {});
      }
      this.browser = null;
    }
  }

  /** Health check — verifies Chromium is connected AND responsive */
  async isHealthy(): Promise<boolean> {
    if (!this.browser || !this.browser.isConnected()) return false;
    try {
      const page = this.pages.get(this.activeTabId);
      if (!page) return true; // connected but no pages — still healthy
      await Promise.race([
        page.evaluate('1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Tab Management ────────────────────────────────────────
  async newTab(url?: string, clientId?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');

    // Validate URL before allocating page to avoid zombie tabs on rejection.
    // Use the normalized return value for navigation — it handles file://./x and
    // file://<segment> cwd-relative forms that the standard URL parser doesn't.
    let normalizedUrl: string | undefined;
    if (url) {
      normalizedUrl = await validateNavigationUrl(url);
    }

    const page = await this.context.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.tabSessions.set(id, new TabSession(page));
    this.activeTabId = id;

    // Record tab ownership for multi-agent isolation
    if (clientId) {
      this.tabOwnership.set(id, clientId);
    }

    // Wire up console/network/dialog capture
    this.wirePageEvents(page);

    if (normalizedUrl) {
      await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    return id;
  }

  async closeTab(id?: number): Promise<void> {
    const tabId = id ?? this.activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    await page.close();
    this.pages.delete(tabId);
    this.tabSessions.delete(tabId);
    this.tabOwnership.delete(tabId);

    // Switch to another tab if we closed the active one
    if (tabId === this.activeTabId) {
      const remaining = [...this.pages.keys()];
      if (remaining.length > 0) {
        this.activeTabId = remaining[remaining.length - 1];
      } else {
        // No tabs left — create a new blank one
        await this.newTab();
      }
    }
  }

  switchTab(id: number, opts?: { bringToFront?: boolean }): void {
    if (!this.tabSessions.has(id)) throw new Error(`Tab ${id} not found`);
    this.activeTabId = id;
    // Only bring to front when explicitly requested (user-initiated tab switch).
    // Internal tab pinning (BROWSE_TAB) should NOT steal focus.
    if (opts?.bringToFront !== false) {
      const page = this.pages.get(id);
      if (page) page.bringToFront().catch(() => {});
    }
  }

  /**
   * Sync activeTabId to match the tab whose URL matches the Chrome extension's
   * active tab. Called on every /sidebar-tabs poll so manual tab switches in
   * the browser are detected within ~2s.
   */
  syncActiveTabByUrl(activeUrl: string): void {
    if (!activeUrl || this.pages.size <= 1) return;
    // Try exact match first, then fuzzy match (origin+pathname, ignoring query/fragment)
    let fuzzyId: number | null = null;
    let activeOriginPath = '';
    try {
      const u = new URL(activeUrl);
      activeOriginPath = u.origin + u.pathname;
    } catch (err: any) {
      if (!(err instanceof TypeError)) throw err;
    }

    for (const [id, page] of this.pages) {
      try {
        const pageUrl = page.url();
        // Exact match — best case
        if (pageUrl === activeUrl && id !== this.activeTabId) {
          this.activeTabId = id;
          return;
        }
        // Fuzzy match — origin+pathname (handles query param / fragment differences)
        if (activeOriginPath && fuzzyId === null && id !== this.activeTabId) {
          try {
            const pu = new URL(pageUrl);
            if (pu.origin + pu.pathname === activeOriginPath) {
              fuzzyId = id;
            }
          } catch (err: any) {
            if (!(err instanceof TypeError)) throw err;
          }
        }
      } catch {}
    }
    // Fall back to fuzzy match
    if (fuzzyId !== null) {
      this.activeTabId = fuzzyId;
    }
  }

  getActiveTabId(): number {
    return this.activeTabId;
  }

  getTabCount(): number {
    return this.pages.size;
  }

  // ─── Tab Ownership (multi-agent isolation) ──────────────

  /** Get the owner of a tab, or null if unowned (root-only for writes). */
  getTabOwner(tabId: number): string | null {
    return this.tabOwnership.get(tabId) || null;
  }

  /**
   * Check if a client can access a tab.
   *
   * Two policies, distinguished by `options.ownOnly`:
   *
   *   - **own-only (pair-agent over tunnel):** the strict mode. Token must own
   *     the target tab for any access (reads or writes). Unowned user tabs
   *     and tabs owned by other clients are off-limits. Remote agents must
   *     `newtab` first to get a tab they can drive.
   *
   *   - **shared (local skill spawns, default scoped tokens):** permissive on
   *     tab access. The token can read/write any tab — capability is gated
   *     elsewhere (scope checks at /command, rate limits, the dual-listener
   *     allowlist for tunnel-bound traffic). Tab ownership is not a security
   *     boundary for shared tokens; it only matters for pair-agent isolation.
   *     This matches the contract documented in `skill-token.ts:79`
   *     ("skill scripts may switch tabs as needed").
   *
   * Root is unconstrained.
   *
   * `isWrite` is preserved in the signature for callers that want to log or
   * branch on it elsewhere, but the access decision itself only depends on
   * `ownOnly` + ownership map state.
   */
  checkTabAccess(tabId: number, clientId: string, options: { isWrite?: boolean; ownOnly?: boolean } = {}): boolean {
    if (clientId === 'root') return true;
    if (options.ownOnly) {
      const owner = this.tabOwnership.get(tabId);
      return owner === clientId;
    }
    return true;
  }

  /** Transfer tab ownership to a different client. */
  transferTab(tabId: number, toClientId: string): void {
    if (!this.pages.has(tabId)) throw new Error(`Tab ${tabId} not found`);
    this.tabOwnership.set(tabId, toClientId);
  }

  async getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    const tabs: Array<{ id: number; url: string; title: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: id === this.activeTabId,
      });
    }
    return tabs;
  }

  // ─── Session Access ────────────────────────────────────────
  /** Get the TabSession for the active tab. */
  getActiveSession(): TabSession {
    const session = this.tabSessions.get(this.activeTabId);
    if (!session) throw new Error('No active page. Use "browse goto <url>" first.');
    return session;
  }

  /** Get a TabSession by tab ID. Used by /batch for parallel tab execution. */
  getSession(tabId: number): TabSession {
    const session = this.tabSessions.get(tabId);
    if (!session) throw new Error(`Tab ${tabId} not found`);
    return session;
  }

  /** Get the underlying Page for a tab id. Returns null if the tab doesn't exist.
   *  Used by the CDP bridge (cdp-bridge.ts) to mint per-tab CDPSessions. */
  getPageForTab(tabId: number): Page | null {
    return this.pages.get(tabId) ?? null;
  }

  // ─── Two-tier mutex (Codex T7) ─────────────────────────────
  // Per-tab and global locks for the CDP bridge. tab-scoped methods take the
  // per-tab mutex; browser-scoped methods take the global lock that blocks all
  // tab mutexes. Hard timeout on acquire so silent deadlock can't happen.
  // Every caller MUST use try { ... } finally { release() }.

  private tabLocks: Map<number, Promise<void>> = new Map();
  private globalCdpLockTail: Promise<void> = Promise.resolve();

  /**
   * Acquire the per-tab CDP lock with a timeout. Returns a release fn.
   * Locks chain: each acquire waits on the prior tail's resolution.
   * Browser-scoped global lock takes precedence: while the global lock is
   * held, no tab lock can be acquired (and vice versa).
   */
  async acquireTabLock(tabId: number, timeoutMs: number): Promise<() => void> {
    const existing = this.tabLocks.get(tabId) ?? Promise.resolve();
    // Wait for any held global lock first (cross-tier serialization).
    const tail = Promise.all([existing, this.globalCdpLockTail]).then(() => undefined);
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.tabLocks.set(tabId, tail.then(() => next));

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(
        `CDPMutexAcquireTimeout: tab ${tabId} lock not acquired within ${timeoutMs}ms.\n` +
        'Cause: a prior CDP or browser-scoped operation has held the lock too long.\n' +
        'Action: retry; if this repeats, the prior operation may be hung — file a bug.'
      )), timeoutMs),
    );
    try {
      await Promise.race([tail, timeoutPromise]);
    } catch (e) {
      // Acquisition failed; release the slot we reserved so we don't deadlock the queue.
      release();
      throw e;
    }
    return release;
  }

  /**
   * Acquire the global CDP lock. Blocks until all tab locks are released, and
   * blocks new tab-lock acquisitions until released.
   */
  async acquireGlobalCdpLock(timeoutMs: number): Promise<() => void> {
    const allTabTails = Array.from(this.tabLocks.values());
    const priorGlobal = this.globalCdpLockTail;
    const allPrior = Promise.all([priorGlobal, ...allTabTails]).then(() => undefined);
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.globalCdpLockTail = allPrior.then(() => next);

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(
        `CDPMutexAcquireTimeout: global CDP lock not acquired within ${timeoutMs}ms.\n` +
        'Cause: in-flight tab operations have not completed.\n' +
        'Action: retry; if this repeats, file a bug — a tab op may be hung.'
      )), timeoutMs),
    );
    try {
      await Promise.race([allPrior, timeoutPromise]);
    } catch (e) {
      release();
      throw e;
    }
    return release;
  }

  // ─── Page Access (delegates to active session) ─────────────
  getPage(): Page {
    return this.getActiveSession().page;
  }

  getCurrentUrl(): string {
    try {
      return this.getPage().url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── Ref Map (delegates to active session) ──────────────────
  setRefMap(refs: Map<string, RefEntry>) {
    this.getActiveSession().setRefMap(refs);
  }

  clearRefs() {
    this.getActiveSession().clearRefs();
  }

  async resolveRef(selector: string): Promise<{ locator: Locator } | { selector: string }> {
    return this.getActiveSession().resolveRef(selector);
  }

  getRefRole(selector: string): string | null {
    return this.getActiveSession().getRefRole(selector);
  }

  getRefCount(): number {
    return this.getActiveSession().getRefCount();
  }

  // ─── Snapshot Diffing (delegates to active session) ─────────
  setLastSnapshot(text: string | null) {
    this.getActiveSession().setLastSnapshot(text);
  }

  getLastSnapshot(): string | null {
    return this.getActiveSession().getLastSnapshot();
  }

  // ─── Dialog Control ───────────────────────────────────────
  setDialogAutoAccept(accept: boolean) {
    this.dialogAutoAccept = accept;
  }

  getDialogAutoAccept(): boolean {
    return this.dialogAutoAccept;
  }

  setDialogPromptText(text: string | null) {
    this.dialogPromptText = text;
  }

  getDialogPromptText(): string | null {
    return this.dialogPromptText;
  }

  // ─── Cookie Origin Tracking ────────────────────────────────
  trackCookieImportDomains(domains: string[]): void {
    for (const d of domains) this.cookieImportedDomains.add(d);
  }

  getCookieImportedDomains(): ReadonlySet<string> {
    return this.cookieImportedDomains;
  }

  hasCookieImports(): boolean {
    return this.cookieImportedDomains.size > 0;
  }

  // ─── Viewport ──────────────────────────────────────────────
  async setViewport(width: number, height: number) {
    this.currentViewport = { width, height };
    await this.getPage().setViewportSize({ width, height });
  }

  // ─── Extra Headers ─────────────────────────────────────────
  async setExtraHeader(name: string, value: string) {
    this.extraHeaders[name] = value;
    if (this.context) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }
  }

  // ─── User Agent ────────────────────────────────────────────
  setUserAgent(ua: string) {
    this.customUserAgent = ua;
  }

  getUserAgent(): string | null {
    return this.customUserAgent;
  }

  // ─── Lifecycle helpers ───────────────────────────────
  /**
   * Close all open pages and clear the pages map.
   * Used by state load to replace the current session.
   */
  async closeAllPages(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch(() => {});
    }
    this.pages.clear();
    this.tabSessions.clear();
  }

  // ─── Frame context (delegates to active session) ────────────
  setFrame(frame: import('playwright').Frame | null): void {
    this.getActiveSession().setFrame(frame);
  }

  getFrame(): import('playwright').Frame | null {
    return this.getActiveSession().getFrame();
  }

  getActiveFrameOrPage(): import('playwright').Page | import('playwright').Frame {
    return this.getActiveSession().getActiveFrameOrPage();
  }

  // ─── State Save/Restore (shared by recreateContext + handoff) ─
  /**
   * Capture browser state: cookies, localStorage, sessionStorage, URLs, active tab.
   * Skips pages that fail storage reads (e.g., already closed).
   */
  async saveState(): Promise<BrowserState> {
    if (!this.context) throw new Error('Browser not launched');

    const cookies = await this.context.cookies();
    const pages: BrowserState['pages'] = [];

    for (const [id, page] of this.pages) {
      const url = page.url();
      let storage = null;
      try {
        storage = await page.evaluate(() => ({
          localStorage: { ...localStorage },
          sessionStorage: { ...sessionStorage },
        }));
      } catch {}

      // Capture load-html content so a later context recreation (viewport --scale)
      // can replay it via setTabContent. Never persisted to disk.
      const session = this.tabSessions.get(id);
      const loaded = session?.getLoadedHtml();
      // Preserve tab ownership through recreation so scoped agents aren't locked out.
      const owner = this.tabOwnership.get(id);

      pages.push({
        url: url === 'about:blank' ? '' : url,
        isActive: id === this.activeTabId,
        storage,
        loadedHtml: loaded?.html,
        loadedHtmlWaitUntil: loaded?.waitUntil,
        owner,
      });
    }

    return { cookies, pages };
  }

  /**
   * Restore browser state into the current context: cookies, pages, storage.
   * Navigates to saved URLs, restores storage, wires page events.
   * Failures on individual pages are swallowed — partial restore is better than none.
   */
  async restoreState(state: BrowserState): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');

    // Restore cookies
    if (state.cookies.length > 0) {
      await this.context.addCookies(state.cookies);
    }

    // Clear stale ownership — the old tab IDs are gone. We'll re-add per-tab
    // owners below as each saved tab gets a fresh ID. Without this reset, old
    // tabId → clientId entries would linger and match new tabs with the same
    // sequential IDs, silently granting ownership to the wrong clients.
    this.tabOwnership.clear();

    // Re-create pages
    let activeId: number | null = null;
    for (const saved of state.pages) {
      const page = await this.context.newPage();
      const id = this.nextTabId++;
      this.pages.set(id, page);
      const newSession = new TabSession(page);
      this.tabSessions.set(id, newSession);
      this.wirePageEvents(page);

      // Restore tab ownership for the new ID — preserves scoped-agent isolation
      // across context recreation (viewport --scale, user-agent change, handoff).
      if (saved.owner) {
        this.tabOwnership.set(id, saved.owner);
      }

      if (saved.loadedHtml) {
        // Replay load-html content via setTabContent — this rehydrates
        // TabSession.loadedHtml so the next saveState sees it. page.setContent()
        // alone would restore the DOM but lose the replay metadata.
        try {
          await newSession.setTabContent(saved.loadedHtml, { waitUntil: saved.loadedHtmlWaitUntil });
        } catch (err: any) {
          console.warn(`[browse] Failed to replay loadedHtml for tab ${id}: ${err.message}`);
        }
      } else if (saved.url) {
        // Validate the saved URL before navigating — the state file is user-writable and
        // a tampered URL could navigate to cloud metadata endpoints. Use the normalized
        // return value so file:// forms get consistent treatment with live goto.
        let normalizedUrl: string;
        try {
          normalizedUrl = await validateNavigationUrl(saved.url);
        } catch (err: any) {
          console.warn(`[browse] Skipping invalid URL in state file: ${saved.url} — ${err.message}`);
          continue;
        }
        await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }

      if (saved.storage) {
        try {
          await page.evaluate((s: { localStorage: Record<string, string>; sessionStorage: Record<string, string> }) => {
            if (s.localStorage) {
              for (const [k, v] of Object.entries(s.localStorage)) {
                localStorage.setItem(k, v);
              }
            }
            if (s.sessionStorage) {
              for (const [k, v] of Object.entries(s.sessionStorage)) {
                sessionStorage.setItem(k, v);
              }
            }
          }, saved.storage);
        } catch {}
      }

      if (saved.isActive) activeId = id;
    }

    // If no pages were saved, create a blank one
    if (this.pages.size === 0) {
      await this.newTab();
    } else {
      this.activeTabId = activeId ?? [...this.pages.keys()][0];
    }

    // Clear refs — pages are new, locators are stale
    this.clearRefs();
  }

  /**
   * Recreate the browser context to apply user agent changes.
   * Saves and restores cookies, localStorage, sessionStorage, and open pages.
   * Falls back to a clean slate on any failure.
   */
  async recreateContext(): Promise<string | null> {
    if (this.connectionMode === 'headed') {
      throw new Error('Cannot recreate context in headed mode. Use disconnect first.');
    }
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    try {
      // 1. Save state
      const state = await this.saveState();

      // 2. Close old pages and context
      for (const page of this.pages.values()) {
        await page.close().catch(() => {});
      }
      this.pages.clear();
      this.tabSessions.clear();
      await this.context.close().catch(() => {});

      // 3. Create new context with updated settings
      const contextOptions: BrowserContextOptions = {
        viewport: { width: this.currentViewport.width, height: this.currentViewport.height },
        deviceScaleFactor: this.deviceScaleFactor,
      };
      if (this.customUserAgent) {
        contextOptions.userAgent = this.customUserAgent;
      }
      this.context = await this.browser.newContext(contextOptions);

      if (Object.keys(this.extraHeaders).length > 0) {
        await this.context.setExtraHTTPHeaders(this.extraHeaders);
      }

      // 4. Restore state
      await this.restoreState(state);

      return null; // success
    } catch (err: unknown) {
      // Fallback: create a clean context + blank tab
      try {
        this.pages.clear();
        this.tabSessions.clear();
        if (this.context) await this.context.close().catch(() => {});

        const contextOptions: BrowserContextOptions = {
          viewport: { width: this.currentViewport.width, height: this.currentViewport.height },
          deviceScaleFactor: this.deviceScaleFactor,
        };
        if (this.customUserAgent) {
          contextOptions.userAgent = this.customUserAgent;
        }
        this.context = await this.browser!.newContext(contextOptions);
        await this.newTab();
        this.clearRefs();
      } catch {
        // If even the fallback fails, we're in trouble — but browser is still alive
      }
      return `Context recreation failed: ${err instanceof Error ? err.message : String(err)}. Browser reset to blank tab.`;
    }
  }

  /**
   * Change deviceScaleFactor + viewport size atomically.
   *
   * deviceScaleFactor is a context-level option, so Playwright requires a full context
   * recreation. This method validates the input, stores the new values, calls
   * recreateContext(), and rolls back the fields on failure so a bad call doesn't
   * leave the manager in an inconsistent state.
   *
   * Returns null on success, or an error string if the new context couldn't be built
   * (state may have been lost, per recreateContext's fallback behavior).
   */
  async setDeviceScaleFactor(scale: number, width: number, height: number): Promise<string | null> {
    if (!Number.isFinite(scale)) {
      throw new Error(`viewport --scale: value must be a finite number, got ${scale}`);
    }
    if (scale < 1 || scale > 3) {
      throw new Error(`viewport --scale: value must be between 1 and 3 (gstack policy cap), got ${scale}`);
    }
    if (this.connectionMode === 'headed') {
      throw new Error('viewport --scale is not supported in headed mode — scale is controlled by the real browser window.');
    }

    const prevScale = this.deviceScaleFactor;
    const prevViewport = { ...this.currentViewport };
    this.deviceScaleFactor = scale;
    this.currentViewport = { width, height };

    const err = await this.recreateContext();
    if (err !== null) {
      // recreateContext's fallback path built a blank context using the NEW scale +
      // viewport (the fields we just set). Rolling the fields back without a second
      // recreate would leave the live context at new-scale while state says old-scale.
      // Roll back fields FIRST, then force a second recreate against the old values
      // so live state matches tracked state.
      this.deviceScaleFactor = prevScale;
      this.currentViewport = prevViewport;
      const rollbackErr = await this.recreateContext();
      if (rollbackErr !== null) {
        // Second recreate also failed — we're in a clean blank slate via fallback, but
        // with old scale. Return the original error so the caller sees the primary failure.
        return `${err} (rollback also encountered: ${rollbackErr})`;
      }
      return err;
    }
    return null;
  }

  /** Read current deviceScaleFactor (for tests + debug). */
  getDeviceScaleFactor(): number {
    return this.deviceScaleFactor;
  }

  /** Read current tracked viewport (for tests + `viewport --scale` size fallback). */
  getCurrentViewport(): { width: number; height: number } {
    return { ...this.currentViewport };
  }

  // ─── Handoff: Headless → Headed ─────────────────────────────
  /**
   * Hand off browser control to the user by relaunching in headed mode.
   *
   * Flow (launch-first-close-second for safe rollback):
   *   1. Save state from current headless browser
   *   2. Launch NEW headed browser
   *   3. Restore state into new browser
   *   4. Close OLD headless browser
   *   If step 2 fails → return error, headless browser untouched
   */
  async handoff(message: string): Promise<string> {
    if (this.connectionMode === 'headed' || this.isHeaded) {
      return `HANDOFF: Already in headed mode at ${this.getCurrentUrl()}`;
    }
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    // 1. Save state from current browser
    const state = await this.saveState();
    const currentUrl = this.getCurrentUrl();

    // 2. Launch new headed browser with extension (same as launchHeaded)
    //    Uses launchPersistentContext so the extension auto-loads.
    let newContext: BrowserContext;
    try {
      const fs = require('fs');
      const path = require('path');
      const extensionPath = this.findExtensionPath();
      const launchArgs = ['--hide-crash-restore-bubble'];
      if (extensionPath) {
        launchArgs.push(`--disable-extensions-except=${extensionPath}`);
        launchArgs.push(`--load-extension=${extensionPath}`);
        // Auth token is served via /health endpoint now (no file write needed).
        // Extension reads token from /health on connect.
        console.log(`[browse] Handoff: loading extension from ${extensionPath}`);
      } else {
        console.log('[browse] Handoff: extension not found — headed mode without side panel');
      }

      const userDataDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
      fs.mkdirSync(userDataDir, { recursive: true });

      newContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: launchArgs,
        viewport: null,
        ...(this.proxyConfig ? { proxy: this.proxyConfig } : {}),
        ignoreDefaultArgs: [
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
        ],
        timeout: 15000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: Cannot open headed browser — ${msg}. Headless browser still running.`;
    }

    // 3. Restore state into new headed browser
    try {
      // Swap to new browser/context before restoreState (it uses this.context)
      const oldBrowser = this.browser;

      this.context = newContext;
      this.browser = newContext.browser();
      this.pages.clear();
      this.tabSessions.clear();
      this.connectionMode = 'headed';

      if (Object.keys(this.extraHeaders).length > 0) {
        await newContext.setExtraHTTPHeaders(this.extraHeaders);
      }

      // Register crash handler on new browser
      if (this.browser) {
        this.browser.on('disconnected', () => {
          if (this.intentionalDisconnect) return;
          console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
          process.exit(1);
        });
      }

      await this.restoreState(state);
      this.isHeaded = true;
      this.dialogAutoAccept = false;  // User controls dialogs in headed mode

      // 4. Close old headless browser (fire-and-forget)
      oldBrowser.removeAllListeners('disconnected');
      oldBrowser.close().catch(() => {});

      return [
        `HANDOFF: Browser opened at ${currentUrl}`,
        `MESSAGE: ${message}`,
        `STATUS: Waiting for user. Run 'resume' when done.`,
      ].join('\n');
    } catch (err: unknown) {
      // Restore failed — close the new context, keep old state
      await newContext.close().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: Handoff failed during state restore — ${msg}. Headless browser still running.`;
    }
  }

  /**
   * Resume AI control after user handoff.
   * Clears stale refs and resets failure counter.
   * The meta-command handler calls handleSnapshot() after this.
   */
  resume(): void {
    // Clear refs and frame on the active session
    try {
      const session = this.getActiveSession();
      session.clearRefs();
      session.setFrame(null);
    } catch {}
    this.resetFailures();
  }

  getIsHeaded(): boolean {
    return this.isHeaded;
  }

  // ─── Auto-handoff Hint (consecutive failure tracking) ───────
  incrementFailures(): void {
    this.consecutiveFailures++;
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  getFailureHint(): string | null {
    if (this.consecutiveFailures >= 3 && !this.isHeaded) {
      return `HINT: ${this.consecutiveFailures} consecutive failures. Consider using 'handoff' to let the user help.`;
    }
    return null;
  }

  // ─── Console/Network/Dialog/Ref Wiring ────────────────────
  private wirePageEvents(page: Page) {
    // Track tab close — remove from pages and sessions maps, switch to another tab
    page.on('close', () => {
      for (const [id, p] of this.pages) {
        if (p === page) {
          this.pages.delete(id);
          this.tabSessions.delete(id);
          console.log(`[browse] Tab closed (id=${id}, remaining=${this.pages.size})`);
          // If the closed tab was active, switch to another
          if (this.activeTabId === id) {
            const remaining = [...this.pages.keys()];
            this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : 0;
          }
          break;
        }
      }
    });

    // Clear ref map on navigation — refs point to stale elements after page change
    // (lastSnapshot is NOT cleared — it's a text baseline for diffing)
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        // Find the TabSession for this page and clear its per-tab state
        for (const session of this.tabSessions.values()) {
          if (session.page === page) {
            session.onMainFrameNavigated();
            break;
          }
        }
      }
    });

    // ─── Dialog auto-handling (prevents browser lockup) ─────
    page.on('dialog', async (dialog) => {
      const entry: DialogEntry = {
        timestamp: Date.now(),
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue() || undefined,
        action: this.dialogAutoAccept ? 'accepted' : 'dismissed',
        response: this.dialogAutoAccept ? (this.dialogPromptText ?? undefined) : undefined,
      };
      addDialogEntry(entry);

      try {
        if (this.dialogAutoAccept) {
          await dialog.accept(this.dialogPromptText ?? undefined);
        } else {
          await dialog.dismiss();
        }
      } catch {
        // Dialog may have been dismissed by navigation
      }
    });

    page.on('console', (msg) => {
      addConsoleEntry({
        timestamp: Date.now(),
        level: msg.type(),
        text: msg.text(),
      });
    });

    page.on('request', (req) => {
      addNetworkEntry({
        timestamp: Date.now(),
        method: req.method(),
        url: req.url(),
      });
    });

    page.on('response', (res) => {
      // Find matching request entry and update it (backward scan)
      const url = res.url();
      const status = res.status();
      for (let i = networkBuffer.length - 1; i >= 0; i--) {
        const entry = networkBuffer.get(i);
        if (entry && entry.url === url && !entry.status) {
          networkBuffer.set(i, { ...entry, status, duration: Date.now() - entry.timestamp });
          break;
        }
      }
    });

    // Capture response sizes via response finished
    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (res) {
          const url = req.url();
          const body = await res.body().catch(() => null);
          const size = body ? body.length : 0;
          for (let i = networkBuffer.length - 1; i >= 0; i--) {
            const entry = networkBuffer.get(i);
            if (entry && entry.url === url && !entry.size) {
              networkBuffer.set(i, { ...entry, size });
              break;
            }
          }
        }
      } catch {}
    });
  }
}
