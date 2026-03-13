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

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Page,
  type Request,
} from 'playwright';
import {
  addConsoleEntry,
  addDialogEntry,
  addNetworkEntry,
  type DialogEntry,
  type NetworkEntry,
} from './buffers';
import * as fs from 'fs';

interface BrowserSettings {
  userAgent?: string | null;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<number, Page> = new Map();
  private activeTabId: number = 0;
  private nextTabId: number = 1;
  private extraHeaders: Record<string, string> = {};
  private customUserAgent: string | null = null;
  private readonly settingsFile: string | null;

  /** Server port — set after server starts, used by cookie-import-browser command */
  public serverPort: number = 0;

  // ─── Ref Map (tab → snapshot refs → frozen element handles) ─────────────
  private refMaps: Map<number, Map<string, ElementHandle<Node>>> = new Map();
  // Request identity is stable even when multiple requests share the same URL.
  private requestEntries: WeakMap<Request, NetworkEntry> = new WeakMap();

  // ─── Snapshot Diffing ─────────────────────────────────────
  // NOT cleared on navigation — it's a text baseline for diffing
  private lastSnapshot: string | null = null;

  // ─── Dialog Handling ──────────────────────────────────────
  private dialogAutoAccept: boolean = true;
  private dialogPromptText: string | null = null;

  constructor(settingsFile?: string | null) {
    this.settingsFile = settingsFile ?? process.env.BROWSE_SETTINGS_FILE ?? null;
  }

  async launch() {
    this.loadSettings();
    this.browser = await chromium.launch({ headless: true });

    // Chromium crash → exit with clear message
    this.browser.on('disconnected', () => {
      console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      console.error('[browse] Console/network logs flushed to /tmp/browse-*.log');
      process.exit(1);
    });

    const contextOptions: Record<string, unknown> = {
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

  async close() {
    this.clearAllRefs();
    if (this.browser) {
      // Remove disconnect handler to avoid exit during intentional close
      this.browser.removeAllListeners('disconnected');
      await this.browser.close();
      this.browser = null;
    }
    this.context = null;
    this.pages.clear();
    this.activeTabId = 0;
    this.nextTabId = 1;
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

    const page = await this.context.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;

    // Wire up console/network/dialog capture
    this.wirePageEvents(id, page);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    return id;
  }

  async closeTab(id?: number): Promise<void> {
    const tabId = id ?? this.activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    this.clearRefs(tabId);
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
  setRefMap(refs: Map<string, ElementHandle<Node>>, tabId: number = this.activeTabId) {
    this.clearRefs(tabId);
    if (refs.size > 0) {
      this.refMaps.set(tabId, refs);
    }
  }

  clearRefs(tabId: number = this.activeTabId) {
    const refs = this.refMaps.get(tabId);
    if (!refs) return;
    for (const handle of refs.values()) {
      void handle.dispose().catch(() => {});
    }
    this.refMaps.delete(tabId);
  }

  /**
   * Resolve a selector that may be a @ref (e.g., "@e3", "@c1") or a CSS selector.
   * Returns { handle } for refs or { selector } for CSS selectors.
   */
  resolveRef(selector: string): { handle: ElementHandle<Node> } | { selector: string } {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const ref = selector.slice(1);
      const refMap = this.refMaps.get(this.activeTabId);
      const handle = refMap?.get(ref);
      if (!handle) {
        throw new Error(
          `Ref ${selector} not found. Page may have changed — run 'snapshot' to get fresh refs.`
        );
      }
      return { handle };
    }
    return { selector };
  }

  getRefCount(tabId: number = this.activeTabId): number {
    return this.refMaps.get(tabId)?.size ?? 0;
  }

  rethrowIfStaleRef(selector: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    const isStale =
      message.includes('Element is not attached to the DOM') ||
      message.includes('Execution context was destroyed') ||
      message.includes('JSHandle is disposed') ||
      message.includes('Target page, context or browser has been closed');

    if ((selector.startsWith('@e') || selector.startsWith('@c')) && isStale) {
      // Normalize detached-handle errors back to the same stale-ref guidance.
      this.removeRef(selector);
      throw new Error(`Ref ${selector} not found. Page may have changed — run 'snapshot' to get fresh refs.`);
    }
    throw err;
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
    this.persistSettings();
  }

  getUserAgent(): string | null {
    return this.customUserAgent;
  }

  /**
   * Recreate the browser context to apply user agent changes.
   * Saves and restores cookies, localStorage, sessionStorage, and open pages.
   * Falls back to a clean slate on any failure.
   */
  async recreateContext(): Promise<string | null> {
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    try {
      // 1. Save state from current context
      const savedCookies = await this.context.cookies();
      const savedPages: Array<{ url: string; isActive: boolean; storage: any }> = [];

      for (const [id, page] of this.pages) {
        const url = page.url();
        let storage = null;
        try {
          storage = await page.evaluate(() => ({
            localStorage: { ...localStorage },
            sessionStorage: { ...sessionStorage },
          }));
        } catch {}
        savedPages.push({
          url: url === 'about:blank' ? '' : url,
          isActive: id === this.activeTabId,
          storage,
        });
      }

      this.clearAllRefs();

      // 2. Close old pages and context
      for (const page of this.pages.values()) {
        await page.close().catch(() => {});
      }
      this.pages.clear();
      await this.context.close().catch(() => {});

      // 3. Create new context with updated settings
      const contextOptions: Record<string, unknown> = {
        viewport: { width: 1280, height: 720 },
      };
      if (this.customUserAgent) {
        contextOptions.userAgent = this.customUserAgent;
      }
      this.context = await this.browser.newContext(contextOptions);

      if (Object.keys(this.extraHeaders).length > 0) {
        await this.context.setExtraHTTPHeaders(this.extraHeaders);
      }

      // 4. Restore cookies
      if (savedCookies.length > 0) {
        await this.context.addCookies(savedCookies);
      }

      // 5. Re-create pages
      let activeId: number | null = null;
      for (const saved of savedPages) {
        const page = await this.context.newPage();
        const id = this.nextTabId++;
        this.pages.set(id, page);
        this.wirePageEvents(id, page);

        if (saved.url) {
          await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }

        // 6. Restore storage
        if (saved.storage) {
          try {
            await page.evaluate((s: any) => {
              if (s.localStorage) {
                for (const [k, v] of Object.entries(s.localStorage)) {
                  localStorage.setItem(k, v as string);
                }
              }
              if (s.sessionStorage) {
                for (const [k, v] of Object.entries(s.sessionStorage)) {
                  sessionStorage.setItem(k, v as string);
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

      return null;
    } catch (err: any) {
      // Fallback: create a clean context + blank tab
      try {
        this.clearAllRefs();
        this.pages.clear();
        if (this.context) await this.context.close().catch(() => {});

        const contextOptions: Record<string, unknown> = {
          viewport: { width: 1280, height: 720 },
        };
        if (this.customUserAgent) {
          contextOptions.userAgent = this.customUserAgent;
        }
        this.context = await this.browser.newContext(contextOptions);
        if (Object.keys(this.extraHeaders).length > 0) {
          await this.context.setExtraHTTPHeaders(this.extraHeaders);
        }
        this.activeTabId = 0;
        await this.newTab();
      } catch {
        // If even the fallback fails, we're in trouble — but browser is still alive
      }
      return `Context recreation failed: ${err.message}. Browser reset to blank tab.`;
    }
  }

  // ─── Console/Network/Dialog/Ref Wiring ────────────────────
  private wirePageEvents(tabId: number, page: Page) {
    // Clear this tab's ref map on navigation — refs point to stale elements
    // after page change. lastSnapshot is not cleared because it is a text
    // baseline for diffing, not a live DOM pointer.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs(tabId);
      }
    });

    page.on('close', () => {
      this.clearRefs(tabId);
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
      const entry: NetworkEntry = {
        timestamp: Date.now(),
        method: req.method(),
        url: req.url(),
      };
      addNetworkEntry(entry);
      this.requestEntries.set(req, entry);
    });

    page.on('response', (res) => {
      const entry = this.requestEntries.get(res.request());
      if (entry) {
        entry.status = res.status();
      }
    });

    page.on('requestfinished', async (req) => {
      const entry = this.requestEntries.get(req);
      if (!entry) return;

      try {
        const timing = req.timing();
        if (timing.responseEnd >= 0) {
          entry.duration = Math.round(timing.responseEnd);
        }
        const sizes = await req.sizes().catch(() => null);
        if (sizes) {
          entry.size = sizes.responseBodySize;
        }
      } catch {
      } finally {
        this.requestEntries.delete(req);
      }
    });

    page.on('requestfailed', (req) => {
      const entry = this.requestEntries.get(req);
      if (entry) {
        const timing = req.timing();
        if (timing.responseEnd >= 0) {
          entry.duration = Math.round(timing.responseEnd);
        }
      }
      this.requestEntries.delete(req);
    });
  }

  private clearAllRefs() {
    for (const tabId of [...this.refMaps.keys()]) {
      this.clearRefs(tabId);
    }
  }

  private removeRef(selector: string, tabId: number = this.activeTabId) {
    if (!selector.startsWith('@')) return;
    const ref = selector.slice(1);
    const refs = this.refMaps.get(tabId);
    const handle = refs?.get(ref);
    if (!refs || !handle) return;
    void handle.dispose().catch(() => {});
    refs.delete(ref);
    if (refs.size === 0) {
      this.refMaps.delete(tabId);
    }
  }

  private loadSettings() {
    if (!this.settingsFile) return;
    try {
      const settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8')) as BrowserSettings;
      this.customUserAgent = settings.userAgent ?? null;
    } catch {}
  }

  private persistSettings() {
    if (!this.settingsFile) return;
    fs.writeFileSync(
      this.settingsFile,
      JSON.stringify({ userAgent: this.customUserAgent } satisfies BrowserSettings, null, 2),
      { mode: 0o600 }
    );
  }
}
