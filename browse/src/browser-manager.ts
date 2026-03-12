/**
 * Browser lifecycle manager
 *
 * Chromium crash handling:
 *   browser.on('disconnected') → log error → process.exit(1)
 *   CLI detects dead server → auto-restarts on next command
 *   We do NOT try to self-heal — don't hide failure.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Page,
  type Request,
} from 'playwright';
import { addConsoleEntry, addNetworkEntry, type NetworkEntry } from './buffers';
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

  // ─── Ref Map (tab → snapshot refs → frozen element handles) ─────────────
  private refMaps: Map<number, Map<string, ElementHandle<Node>>> = new Map();
  // Request object identity is stable even when multiple requests share a URL.
  private requestEntries: WeakMap<Request, NetworkEntry> = new WeakMap();

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

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
    });

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

  isHealthy(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  // ─── Tab Management ────────────────────────────────────────
  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');

    const page = await this.context.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;

    // Wire up console/network capture
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

  getTabList(): Array<{ id: number; url: string; title: string; active: boolean }> {
    const tabs: Array<{ id: number; url: string; title: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: '', // title requires await, populated by caller
        active: id === this.activeTabId,
      });
    }
    return tabs;
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
   * Resolve a selector that may be a @ref (e.g., "@e3") or a CSS selector.
   * Returns { handle } for refs or { selector } for CSS selectors.
   */
  resolveRef(selector: string): { handle: ElementHandle<Node> } | { selector: string } {
    if (selector.startsWith('@e')) {
      const ref = selector.slice(1); // "e3"
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

    if (selector.startsWith('@e') && isStale) {
      // Normalize detached-handle errors back to the same stale-ref guidance
      // the old locator-based implementation returned after navigation.
      this.removeRef(selector);
      throw new Error(`Ref ${selector} not found. Page may have changed — run 'snapshot' to get fresh refs.`);
    }
    throw err;
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
  // Note: user agent changes require a new context in Playwright
  // For simplicity, we just store it and apply on next "restart"
  setUserAgent(ua: string) {
    this.customUserAgent = ua;
    this.persistSettings();
  }

  // ─── Console/Network/Ref Wiring ────────────────────────────
  private wirePageEvents(tabId: number, page: Page) {
    // Clear this tab's ref map on navigation — refs point to stale elements after page change
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.clearRefs(tabId);
      }
    });

    page.on('close', () => {
      this.clearRefs(tabId);
    });

    page.on('console', (msg) => {
      addConsoleEntry({
        timestamp: Date.now(),
        level: msg.type(),
        text: msg.text(),
      });
    });

    page.on('request', (req) => {
      const entry = {
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
    if (!selector.startsWith('@e')) return;
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
    fs.writeFileSync(this.settingsFile, JSON.stringify({ userAgent: this.customUserAgent } satisfies BrowserSettings, null, 2), {
      mode: 0o600,
    });
  }
}
