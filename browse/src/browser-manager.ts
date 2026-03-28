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
import { addConsoleEntry, addNetworkEntry, addDialogEntry, networkBuffer, type DialogEntry } from './buffers';
import { validateNavigationUrl } from './url-validation';

export interface RefEntry {
  locator: Locator;
  role: string;
  name: string;
}

export interface BrowserState {
  cookies: Cookie[];
  pages: Array<{
    url: string;
    isActive: boolean;
    storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null;
  }>;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<number, Page> = new Map();
  private activeTabId: number = 0;
  private nextTabId: number = 1;
  private extraHeaders: Record<string, string> = {};
  private customUserAgent: string | null = null;

  /** Server port — set after server starts, used by cookie-import-browser command */
  public serverPort: number = 0;

  // ─── Ref Map (snapshot → @e1, @e2, @c1, @c2, ...) ────────
  private refMap: Map<string, RefEntry> = new Map();

  // ─── Snapshot Diffing ─────────────────────────────────────
  // NOT cleared on navigation — it's a text baseline for diffing
  private lastSnapshot: string | null = null;

  // ─── Dialog Handling ──────────────────────────────────────
  private dialogAutoAccept: boolean = true;
  private dialogPromptText: string | null = null;

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
      } catch {}
    }
    return null;
  }

  /**
   * Get the ref map for external consumers (e.g., /refs endpoint).
   */
  getRefMap(): Array<{ ref: string; role: string; name: string }> {
    const refs: Array<{ ref: string; role: string; name: string }> = [];
    for (const [ref, entry] of this.refMap) {
      refs.push({ ref, role: entry.role, name: entry.name });
    }
    return refs;
  }

  async launch() {
    // ─── Extension Support ────────────────────────────────────
    // BROWSE_EXTENSIONS_DIR points to an unpacked Chrome extension directory.
    // Extensions only work in headed mode, so we use an off-screen window.
    const extensionsDir = process.env.BROWSE_EXTENSIONS_DIR;
    const launchArgs: string[] = [];
    let useHeadless = true;

    // Docker/CI: Chromium sandbox requires unprivileged user namespaces which
    // are typically disabled in containers. Detect container environment and
    // add --no-sandbox automatically.
    if (process.env.CI || process.env.CONTAINER) {
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
    });

    // Chromium crash → exit with clear message
    this.browser.on('disconnected', () => {
      console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      console.error('[browse] Console/network logs flushed to .gstack/browse-*.log');
      process.exit(1);
    });

    const contextOptions: BrowserContextOptions = {
      viewport: { width: 1280, height: 720 },
    };
    if (this.customUserAgent) {
      contextOptions.userAgent = this.customUserAgent;
    }
    this.context = await this.browser.newContext(contextOptions);

    if (Object.keys(this.extraHeaders).length > 0) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }

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
    this.refMap.clear();
    this.nextTabId = 1;

    // Find the gstack extension directory for auto-loading
    const extensionPath = this.findExtensionPath();
    const launchArgs = ['--hide-crash-restore-bubble'];
    if (extensionPath) {
      launchArgs.push(`--disable-extensions-except=${extensionPath}`);
      launchArgs.push(`--load-extension=${extensionPath}`);
      // Write auth token for extension bootstrap (read via chrome.runtime.getURL)
      if (authToken) {
        const fs = require('fs');
        const path = require('path');
        const authFile = path.join(extensionPath, '.auth.json');
        try {
          fs.writeFileSync(authFile, JSON.stringify({ token: authToken }), { mode: 0o600 });
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
    const userDataDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
    fs.mkdirSync(userDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: launchArgs,
      viewport: null,  // Use browser's default viewport (real window size)
      // Playwright adds flags that block extension loading
      ignoreDefaultArgs: [
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
      ],
    });
    this.browser = this.context.browser();
    this.connectionMode = 'headed';
    this.intentionalDisconnect = false;

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

    // Persistent context opens a default page — adopt it instead of creating a new one
    const existingPages = this.context.pages();
    if (existingPages.length > 0) {
      const page = existingPages[0];
      const id = this.nextTabId++;
      this.pages.set(id, page);
      this.activeTabId = id;
      this.wirePageEvents(page);
      // Inject indicator on restored page (addInitScript only fires on new navigations)
      try { await page.evaluate(indicatorScript); } catch {}
    } else {
      await this.newTab();
    }

    // Browser disconnect handler — exit code 2 distinguishes from crashes (1)
    if (this.browser) {
      this.browser.on('disconnected', () => {
        if (this.intentionalDisconnect) return;
        console.error('[browse] Real browser disconnected (user closed or crashed).');
        console.error('[browse] Run `$B connect` to reconnect.');
        process.exit(2);
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
  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');

    // Validate URL before allocating page to avoid zombie tabs on rejection
    if (url) {
      await validateNavigationUrl(url);
    }

    const page = await this.context.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;

    // Wire up console/network/dialog capture
    this.wirePageEvents(page);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    return id;
  }

  async closeTab(id?: number): Promise<void> {
    const tabId = id ?? this.activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    await page.close();
    this.pages.delete(tabId);

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

  switchTab(id: number): void {
    if (!this.pages.has(id)) throw new Error(`Tab ${id} not found`);
    this.activeTabId = id;
    this.activeFrame = null; // Frame context is per-tab
  }

  getTabCount(): number {
    return this.pages.size;
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

  // ─── Page Access ───────────────────────────────────────────
  getPage(): Page {
    const page = this.pages.get(this.activeTabId);
    if (!page) throw new Error('No active page. Use "browse goto <url>" first.');
    return page;
  }

  getCurrentUrl(): string {
    try {
      return this.getPage().url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── Ref Map ──────────────────────────────────────────────
  setRefMap(refs: Map<string, RefEntry>) {
    this.refMap = refs;
  }

  clearRefs() {
    this.refMap.clear();
  }

  /**
   * Resolve a selector that may be a @ref (e.g., "@e3", "@c1") or a CSS selector.
   * Returns { locator } for refs or { selector } for CSS selectors.
   */
  async resolveRef(selector: string): Promise<{ locator: Locator } | { selector: string }> {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const ref = selector.slice(1); // "e3" or "c1"
      const entry = this.refMap.get(ref);
      if (!entry) {
        throw new Error(
          `Ref ${selector} not found. Run 'snapshot' to get fresh refs.`
        );
      }
      const count = await entry.locator.count();
      if (count === 0) {
        throw new Error(
          `Ref ${selector} (${entry.role} "${entry.name}") is stale — element no longer exists. ` +
          `Run 'snapshot' for fresh refs.`
        );
      }
      return { locator: entry.locator };
    }
    return { selector };
  }

  /** Get the ARIA role for a ref selector, or null for CSS selectors / unknown refs. */
  getRefRole(selector: string): string | null {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const entry = this.refMap.get(selector.slice(1));
      return entry?.role ?? null;
    }
    return null;
  }

  getRefCount(): number {
    return this.refMap.size;
  }

  // ─── Snapshot Diffing ─────────────────────────────────────
  setLastSnapshot(text: string | null) {
    this.lastSnapshot = text;
  }

  getLastSnapshot(): string | null {
    return this.lastSnapshot;
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

  // ─── Viewport ──────────────────────────────────────────────
  async setViewport(width: number, height: number) {
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
    this.clearRefs();
  }

  // ─── Frame context ─────────────────────────────────
  private activeFrame: import('playwright').Frame | null = null;

  setFrame(frame: import('playwright').Frame | null): void {
    this.activeFrame = frame;
  }

  getFrame(): import('playwright').Frame | null {
    return this.activeFrame;
  }

  /**
   * Returns the active frame if set, otherwise the current page.
   * Use this for operations that work on both Page and Frame (locator, evaluate, etc.).
   */
  getActiveFrameOrPage(): import('playwright').Page | import('playwright').Frame {
    // Auto-recover from detached frames (iframe removed/navigated)
    if (this.activeFrame?.isDetached()) {
      this.activeFrame = null;
    }
    return this.activeFrame ?? this.getPage();
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
      pages.push({
        url: url === 'about:blank' ? '' : url,
        isActive: id === this.activeTabId,
        storage,
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

    // Re-create pages
    let activeId: number | null = null;
    for (const saved of state.pages) {
      const page = await this.context.newPage();
      const id = this.nextTabId++;
      this.pages.set(id, page);
      this.wirePageEvents(page);

      if (saved.url) {
        await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
      await this.context.close().catch(() => {});

      // 3. Create new context with updated settings
      const contextOptions: BrowserContextOptions = {
        viewport: { width: 1280, height: 720 },
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
        if (this.context) await this.context.close().catch(() => {});

        const contextOptions: BrowserContextOptions = {
          viewport: { width: 1280, height: 720 },
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
        // Write auth token for extension bootstrap during handoff
        if (this.serverPort) {
          try {
            const { resolveConfig } = require('./config');
            const config = resolveConfig();
            const stateFile = path.join(config.stateDir, 'browse.json');
            if (fs.existsSync(stateFile)) {
              const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              if (stateData.token) {
                fs.writeFileSync(path.join(extensionPath, '.auth.json'), JSON.stringify({ token: stateData.token }), { mode: 0o600 });
              }
            }
          } catch {}
        }
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
    this.clearRefs();
    this.resetFailures();
    this.activeFrame = null;
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
    // Clear ref map on navigation — refs point to stale elements after page change
    // (lastSnapshot is NOT cleared — it's a text baseline for diffing)
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs();
        this.activeFrame = null; // Navigation invalidates frame context
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
        // Dialog may have been dismissed by navigation — ignore
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
