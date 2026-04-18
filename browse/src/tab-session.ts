/**
 * Per-tab session state.
 *
 * Extracted from BrowserManager to enable parallel tab execution in /batch.
 * Each TabSession holds the state that is scoped to a single browser tab:
 * page reference, element refs, snapshot baseline, and frame context.
 *
 *   BrowserManager (global)
 *     └── tabSessions: Map<number, TabSession>
 *           ├── TabSession(page1)  ←  refMap, lastSnapshot, frame
 *           ├── TabSession(page2)  ←  refMap, lastSnapshot, frame
 *           └── TabSession(page3)  ←  refMap, lastSnapshot, frame
 *
 * The /command path gets the active session via bm.getActiveSession().
 * The /batch path gets specific sessions via bm.getSession(tabId).
 * Both paths pass TabSession to the same handler functions.
 */

import type { Page, Locator, Frame } from 'playwright';

export interface RefEntry {
  locator: Locator;
  role: string;
  name: string;
}

export type SetContentWaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

export class TabSession {
  readonly page: Page;

  // ─── Ref Map (snapshot → @e1, @e2, @c1, @c2, ...) ────────
  private refMap: Map<string, RefEntry> = new Map();

  // ─── Snapshot Diffing ─────────────────────────────────────
  // NOT cleared on navigation — it's a text baseline for diffing
  private lastSnapshot: string | null = null;

  // ─── Frame context ─────────────────────────────────────────
  private activeFrame: Frame | null = null;

  // ─── Loaded HTML (for load-html replay across context recreation) ─
  //
  // loadedHtml lifecycle:
  //
  //   load-html cmd ──▶ session.setTabContent(html, opts)
  //                          ├─▶ page.setContent(html, opts)
  //                          └─▶ this.loadedHtml = html
  //                              this.loadedHtmlWaitUntil = opts.waitUntil
  //
  //   goto/back/forward/reload ──▶ session.clearLoadedHtml()
  //                                     (BEFORE Playwright call, so timeouts
  //                                      don't leave stale state)
  //
  //   viewport --scale ──▶ recreateContext()
  //                             ├─▶ saveState() captures { url, loadedHtml } per tab
  //                             │        (in-memory only, never to disk)
  //                             └─▶ restoreState():
  //                                    for each tab with loadedHtml:
  //                                       newSession.setTabContent(html, opts)
  //                                    (NOT page.setContent — must rehydrate
  //                                     TabSession.loadedHtml too)
  private loadedHtml: string | null = null;
  private loadedHtmlWaitUntil: SetContentWaitUntil | undefined;

  constructor(page: Page) {
    this.page = page;
  }

  // ─── Page Access ───────────────────────────────────────────
  getPage(): Page {
    return this.page;
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

  /** Get all ref entries for the /refs endpoint. */
  getRefEntries(): Array<{ ref: string; role: string; name: string }> {
    return Array.from(this.refMap.entries()).map(([ref, entry]) => ({
      ref, role: entry.role, name: entry.name,
    }));
  }

  // ─── Snapshot Diffing ─────────────────────────────────────
  setLastSnapshot(text: string | null) {
    this.lastSnapshot = text;
  }

  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  // ─── Frame context ─────────────────────────────────────────
  setFrame(frame: Frame | null): void {
    this.activeFrame = frame;
  }

  getFrame(): Frame | null {
    return this.activeFrame;
  }

  /**
   * Returns the active frame if set, otherwise the current page.
   * Use this for operations that work on both Page and Frame (locator, evaluate, etc.).
   */
  getActiveFrameOrPage(): Page | Frame {
    // Auto-recover from detached frames (iframe removed/navigated)
    if (this.activeFrame?.isDetached()) {
      this.activeFrame = null;
    }
    return this.activeFrame ?? this.page;
  }

  /**
   * Called on main-frame navigation to clear stale refs, frame context, and any
   * load-html replay metadata. Runs for every main-frame nav — explicit goto/back/
   * forward/reload AND browser-emitted navigations (link clicks, form submits, JS
   * redirects, OAuth). Without clearing loadedHtml here, a user who load-html'd and
   * then clicked a link would silently revert to the original HTML on the next
   * viewport --scale.
   */
  onMainFrameNavigated(): void {
    this.clearRefs();
    this.activeFrame = null;
    this.loadedHtml = null;
    this.loadedHtmlWaitUntil = undefined;
  }

  // ─── Loaded HTML (load-html replay) ───────────────────────

  /**
   * Load HTML content into the tab AND store it for replay after context recreation
   * (e.g. viewport --scale). Unlike page.setContent() alone, this rehydrates
   * TabSession.loadedHtml so the next saveState()/restoreState() round-trip preserves
   * the content.
   */
  async setTabContent(html: string, opts: { waitUntil?: SetContentWaitUntil } = {}): Promise<void> {
    const waitUntil = opts.waitUntil ?? 'domcontentloaded';
    // Call setContent FIRST — only record the replay metadata after a successful load.
    // If setContent throws (timeout, crash), we must not leave phantom HTML that a
    // later viewport --scale would replay.
    await this.page.setContent(html, { waitUntil, timeout: 15000 });
    this.loadedHtml = html;
    this.loadedHtmlWaitUntil = waitUntil;
  }

  /** Get stored HTML + waitUntil for state replay. Returns null if no load-html happened. */
  getLoadedHtml(): { html: string; waitUntil?: SetContentWaitUntil } | null {
    if (this.loadedHtml === null) return null;
    return { html: this.loadedHtml, waitUntil: this.loadedHtmlWaitUntil };
  }

  /** Clear stored HTML. Called BEFORE goto/back/forward/reload navigation. */
  clearLoadedHtml(): void {
    this.loadedHtml = null;
    this.loadedHtmlWaitUntil = undefined;
  }
}
