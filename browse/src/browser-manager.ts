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

import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { addConsoleEntry, addNetworkEntry, addDialogEntry, networkBuffer, type DialogEntry } from './buffers';

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
  private refMap: Map<string, Locator> = new Map();

  // ─── Snapshot Diffing ─────────────────────────────────────
  // NOT cleared on navigation — it's a text baseline for diffing
  private lastSnapshot: string | null = null;

  // ─── Dialog Handling ──────────────────────────────────────
  private dialogAutoAccept: boolean = true;
  private dialogPromptText: string | null = null;

  async launch() {
    this.browser = await chromium.launch({ headless: true });

    // Chromium crash → exit with clear message
    this.browser.on('disconnected', () => {
      console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      console.error('[browse] Console/network logs flushed to .gstack/browse-*.log');
      process.exit(1);
    });

    const contextOptions: any = {
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
    if (this.browser) {
      // Remove disconnect handler to avoid exit during intentional close
      this.browser.removeAllListeners('disconnected');
      await this.browser.close();
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
  setRefMap(refs: Map<string, Locator>) {
    this.refMap = refs;
  }

  clearRefs() {
    this.refMap.clear();
  }

  /**
   * Resolve a selector that may be a @ref (e.g., "@e3", "@c1") or a CSS selector.
   * Returns { locator } for refs or { selector } for CSS selectors.
   */
  resolveRef(selector: string): { locator: Locator } | { selector: string } {
    if (selector.startsWith('@e') || selector.startsWith('@c')) {
      const ref = selector.slice(1); // "e3" or "c1"
      const locator = this.refMap.get(ref);
      if (!locator) {
        throw new Error(
          `Ref ${selector} not found. Page may have changed — run 'snapshot' to get fresh refs.`
        );
      }
      return { locator };
    }
    return { selector };
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

      // 2. Close old pages and context
      for (const page of this.pages.values()) {
        await page.close().catch(() => {});
      }
      this.pages.clear();
      await this.context.close().catch(() => {});

      // 3. Create new context with updated settings
      const contextOptions: any = {
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
        this.wirePageEvents(page);

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

      // Clear refs — pages are new, locators are stale
      this.clearRefs();

      return null; // success
    } catch (err: any) {
      // Fallback: create a clean context + blank tab
      try {
        this.pages.clear();
        if (this.context) await this.context.close().catch(() => {});

        const contextOptions: any = {
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
      return `Context recreation failed: ${err.message}. Browser reset to blank tab.`;
    }
  }

  // ─── Console/Network/Dialog/Ref Wiring ────────────────────
  private wirePageEvents(page: Page) {
    // Clear ref map on navigation — refs point to stale elements after page change
    // (lastSnapshot is NOT cleared — it's a text baseline for diffing)
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs();
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
