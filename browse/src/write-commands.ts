/**
 * Write commands — navigate and interact with pages (side effects)
 *
 * goto, back, forward, reload, click, fill, select, hover, type,
 * press, scroll, wait, viewport, cookie, header, useragent
 */

import type { TabSession } from './tab-session';
import type { BrowserManager } from './browser-manager';
import { findInstalledBrowsers, importCookies, importCookiesViaCdp, hasV20Cookies, listSupportedBrowserNames } from './cookie-import-browser';
import { generatePickerCode } from './cookie-picker-routes';
import { validateNavigationUrl } from './url-validation';
import { validateOutputPath, validateReadPath } from './path-security';
import * as fs from 'fs';
import * as path from 'path';
import type { SetContentWaitUntil } from './tab-session';
import { TEMP_DIR, isPathWithin } from './platform';
import { SAFE_DIRECTORIES } from './path-security';
import { modifyStyle, undoModification, resetModifications, getModificationHistory } from './cdp-inspector';

/**
 * Aggressive page cleanup selectors and heuristics.
 * Goal: make the page readable and clean while keeping it recognizable.
 * Inspired by uBlock Origin filter lists, Readability.js, and reader mode heuristics.
 */
const CLEANUP_SELECTORS = {
  ads: [
    // Google Ads
    'ins.adsbygoogle', '[id^="google_ads"]', '[id^="div-gpt-ad"]',
    'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
    '[data-google-query-id]', '.google-auto-placed',
    // Generic ad patterns (uBlock Origin common filters)
    '[class*="ad-banner"]', '[class*="ad-wrapper"]', '[class*="ad-container"]',
    '[class*="ad-slot"]', '[class*="ad-unit"]', '[class*="ad-zone"]',
    '[class*="ad-placement"]', '[class*="ad-holder"]', '[class*="ad-block"]',
    '[class*="adbox"]', '[class*="adunit"]', '[class*="adwrap"]',
    '[id*="ad-banner"]', '[id*="ad-wrapper"]', '[id*="ad-container"]',
    '[id*="ad-slot"]', '[id*="ad_banner"]', '[id*="ad_container"]',
    '[data-ad]', '[data-ad-slot]', '[data-ad-unit]', '[data-adunit]',
    '[class*="sponsored"]', '[class*="Sponsored"]',
    '.ad', '.ads', '.advert', '.advertisement',
    '#ad', '#ads', '#advert', '#advertisement',
    // Common ad network iframes
    'iframe[src*="amazon-adsystem"]', 'iframe[src*="outbrain"]',
    'iframe[src*="taboola"]', 'iframe[src*="criteo"]',
    'iframe[src*="adsafeprotected"]', 'iframe[src*="moatads"]',
    // Promoted/sponsored content
    '[class*="promoted"]', '[class*="Promoted"]',
    '[data-testid*="promo"]', '[class*="native-ad"]',
    // Empty ad placeholders (divs with only ad classes, no real content)
    'aside[class*="ad"]', 'section[class*="ad-"]',
  ],
  cookies: [
    // Cookie consent frameworks
    '[class*="cookie-consent"]', '[class*="cookie-banner"]', '[class*="cookie-notice"]',
    '[id*="cookie-consent"]', '[id*="cookie-banner"]', '[id*="cookie-notice"]',
    '[class*="consent-banner"]', '[class*="consent-modal"]', '[class*="consent-wall"]',
    '[class*="gdpr"]', '[id*="gdpr"]', '[class*="GDPR"]',
    '[class*="CookieConsent"]', '[id*="CookieConsent"]',
    // OneTrust (very common)
    '#onetrust-consent-sdk', '.onetrust-pc-dark-filter', '#onetrust-banner-sdk',
    // Cookiebot
    '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
    // TrustArc / TRUSTe
    '#truste-consent-track', '.truste_overlay', '.truste_box_overlay',
    // Quantcast
    '.qc-cmp2-container', '#qc-cmp2-main',
    // Generic patterns
    '[class*="cc-banner"]', '[class*="cc-window"]', '[class*="cc-overlay"]',
    '[class*="privacy-banner"]', '[class*="privacy-notice"]',
    '[id*="privacy-banner"]', '[id*="privacy-notice"]',
    '[class*="accept-cookies"]', '[id*="accept-cookies"]',
  ],
  overlays: [
    // Paywall / subscription overlays
    '[class*="paywall"]', '[class*="Paywall"]', '[id*="paywall"]',
    '[class*="subscribe-wall"]', '[class*="subscription-wall"]',
    '[class*="meter-wall"]', '[class*="regwall"]', '[class*="reg-wall"]',
    // Newsletter / signup popups
    '[class*="newsletter-popup"]', '[class*="newsletter-modal"]',
    '[class*="signup-modal"]', '[class*="signup-popup"]',
    '[class*="email-capture"]', '[class*="lead-capture"]',
    '[class*="popup-modal"]', '[class*="modal-overlay"]',
    // Interstitials
    '[class*="interstitial"]', '[id*="interstitial"]',
    // Push notification prompts
    '[class*="push-notification"]', '[class*="notification-prompt"]',
    '[class*="web-push"]',
    // Survey / feedback popups
    '[class*="survey-"]', '[class*="feedback-modal"]',
    '[id*="survey-"]', '[class*="nps-"]',
    // App download banners
    '[class*="app-banner"]', '[class*="smart-banner"]', '[class*="app-download"]',
    '[id*="branch-banner"]', '.smartbanner',
    // Cross-promotion / "follow us" / "preferred source" widgets
    '[class*="promo-banner"]', '[class*="cross-promo"]', '[class*="partner-promo"]',
    '[class*="preferred-source"]', '[class*="google-promo"]',
  ],
  clutter: [
    // Audio/podcast player widgets (not part of the article text)
    '[class*="audio-player"]', '[class*="podcast-player"]', '[class*="listen-widget"]',
    '[class*="everlit"]', '[class*="Everlit"]',
    'audio', // bare audio elements
    // Sidebar games/puzzles widgets
    '[class*="puzzle"]', '[class*="daily-game"]', '[class*="games-widget"]',
    '[class*="crossword-promo"]', '[class*="mini-game"]',
    // "Most Popular" / "Trending" sidebar recirculation (not the top nav trending bar)
    'aside [class*="most-popular"]', 'aside [class*="trending"]',
    'aside [class*="most-read"]', 'aside [class*="recommended"]',
    // Related articles / recirculation at bottom
    '[class*="related-articles"]', '[class*="more-stories"]',
    '[class*="recirculation"]', '[class*="taboola"]', '[class*="outbrain"]',
    // Hearst-specific (SF Chronicle, etc.)
    '[class*="nativo"]', '[data-tb-region]',
  ],
  sticky: [
    // Handled via JavaScript evaluation, not pure selectors
  ],
  social: [
    '[class*="social-share"]', '[class*="share-buttons"]', '[class*="share-bar"]',
    '[class*="social-widget"]', '[class*="social-icons"]', '[class*="share-tools"]',
    'iframe[src*="facebook.com/plugins"]', 'iframe[src*="platform.twitter"]',
    '[class*="fb-like"]', '[class*="tweet-button"]',
    '[class*="addthis"]', '[class*="sharethis"]',
    // Follow prompts
    '[class*="follow-us"]', '[class*="social-follow"]',
  ],
};

export async function handleWriteCommand(
  command: string,
  args: string[],
  session: TabSession,
  bm: BrowserManager
): Promise<string> {
  const page = session.getPage();
  // Frame-aware target for locator-based operations (click, fill, etc.)
  const target = session.getActiveFrameOrPage();
  const inFrame = session.getFrame() !== null;

  switch (command) {
    case 'goto': {
      if (inFrame) throw new Error('Cannot use goto inside a frame. Run \'frame main\' first.');
      const url = args[0];
      if (!url) throw new Error('Usage: browse goto <url>');
      // Clear loadedHtml BEFORE navigation — a timeout after the main-frame commit
      // must not leave stale content that could resurrect on a later context recreation.
      session.clearLoadedHtml();
      const normalizedUrl = await validateNavigationUrl(url);
      const response = await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = response?.status() || 'unknown';
      return `Navigated to ${normalizedUrl} (${status})`;
    }

    case 'back': {
      if (inFrame) throw new Error('Cannot use back inside a frame. Run \'frame main\' first.');
      session.clearLoadedHtml();
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Back → ${page.url()}`;
    }

    case 'forward': {
      if (inFrame) throw new Error('Cannot use forward inside a frame. Run \'frame main\' first.');
      session.clearLoadedHtml();
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Forward → ${page.url()}`;
    }

    case 'reload': {
      if (inFrame) throw new Error('Cannot use reload inside a frame. Run \'frame main\' first.');
      session.clearLoadedHtml();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return `Reloaded ${page.url()}`;
    }

    case 'load-html': {
      if (inFrame) throw new Error('Cannot use load-html inside a frame. Run \'frame main\' first.');

      // --from-file <path.json>: read inline HTML from a JSON payload. Used by
      // make-pdf to dodge Windows argv size limits on large rendered HTML.
      // The JSON shape is { html: string, waitUntil?: "load"|"domcontentloaded"|"networkidle" }.
      // The safe-dirs + magic-byte + size-cap checks below still apply to the
      // INLINE HTML content, not to the payload file path itself.
      let fromFilePayload: { html: string; waitUntil?: SetContentWaitUntil } | null = null;
      let filePath: string | undefined;
      let waitUntil: SetContentWaitUntil = 'domcontentloaded';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--from-file') {
          const payloadPath = args[++i];
          if (!payloadPath) throw new Error('load-html: --from-file requires a path');
          // Parity with the sibling `load-html <file>` path below (line 249):
          // that branch runs every `file://` target through validateReadPath
          // so the safe-dirs policy can't be side-stepped. Same policy must
          // apply here — otherwise --from-file becomes a read-anywhere escape
          // hatch for any caller that can pick the payload path (e.g., an
          // MCP caller issuing load-html with an attacker-influenced path).
          try {
            validateReadPath(path.resolve(payloadPath));
          } catch {
            throw new Error(
              `load-html: --from-file ${payloadPath} must be under ${SAFE_DIRECTORIES.join(' or ')} (security policy). Copy the payload into the project tree or /tmp first.`
            );
          }
          const raw = fs.readFileSync(payloadPath, 'utf8');
          let json: any;
          try { json = JSON.parse(raw); }
          catch (e: any) { throw new Error(`load-html: --from-file JSON parse failed: ${e.message}`); }
          if (typeof json.html !== 'string') {
            throw new Error('load-html: --from-file JSON must have a "html" string field');
          }
          if (json.waitUntil && json.waitUntil !== 'load'
              && json.waitUntil !== 'domcontentloaded' && json.waitUntil !== 'networkidle') {
            throw new Error(`load-html: --from-file waitUntil '${json.waitUntil}' invalid`);
          }
          fromFilePayload = { html: json.html, waitUntil: json.waitUntil };
        } else if (args[i] === '--wait-until') {
          const val = args[++i];
          if (val !== 'load' && val !== 'domcontentloaded' && val !== 'networkidle') {
            throw new Error(`Invalid --wait-until '${val}'. Must be one of: load, domcontentloaded, networkidle.`);
          }
          waitUntil = val;
        } else if (args[i].startsWith('--')) {
          throw new Error(`Unknown flag: ${args[i]}`);
        } else if (!filePath) {
          filePath = args[i];
        }
      }

      // Inline HTML path: validate size + magic byte, then setContent directly.
      if (fromFilePayload) {
        const MAX_BYTES = parseInt(process.env.GSTACK_BROWSE_MAX_HTML_BYTES || '', 10) || (50 * 1024 * 1024);
        if (Buffer.byteLength(fromFilePayload.html, 'utf8') > MAX_BYTES) {
          throw new Error(
            `load-html: --from-file html too large (> ${MAX_BYTES} bytes). ` +
            'Raise with GSTACK_BROWSE_MAX_HTML_BYTES=<N>.'
          );
        }
        const peek = fromFilePayload.html.trimStart();
        if (!/^<[a-zA-Z!?]/.test(peek)) {
          throw new Error('load-html: --from-file html does not start with a valid markup opener');
        }
        const finalWaitUntil = fromFilePayload.waitUntil ?? waitUntil;
        await session.setTabContent(fromFilePayload.html, { waitUntil: finalWaitUntil });
        return `Loaded HTML: (inline from --from-file, ${fromFilePayload.html.length} chars)`;
      }

      if (!filePath) throw new Error('Usage: browse load-html <file> [--wait-until load|domcontentloaded|networkidle] [--tab-id <N>]  |  load-html --from-file <payload.json> [--tab-id <N>]');

      // Extension allowlist
      const ALLOWED_EXT = ['.html', '.htm', '.xhtml', '.svg'];
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) {
        throw new Error(
          `load-html: file does not appear to be HTML. Expected .html/.htm/.xhtml/.svg, got ${ext || '(no extension)'}. Rename the file if it's really HTML.`
        );
      }

      const absolutePath = path.resolve(filePath);

      // Safe-dirs check (reuses canonical read-side policy)
      try {
        validateReadPath(absolutePath);
      } catch (e: any) {
        throw new Error(
          `load-html: ${absolutePath} must be under ${SAFE_DIRECTORIES.join(' or ')} (security policy). Copy the file into the project tree or /tmp first.`
        );
      }

      // stat check — reject non-file targets with actionable error
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          throw new Error(
            `load-html: file not found at ${absolutePath}. Check spelling or copy the file under ${process.cwd()} or ${TEMP_DIR}.`
          );
        }
        throw e;
      }
      if (stat.isDirectory()) {
        throw new Error(`load-html: ${absolutePath} is a directory, not a file. Pass a .html file.`);
      }
      if (!stat.isFile()) {
        throw new Error(`load-html: ${absolutePath} is not a regular file.`);
      }

      // Size cap
      const MAX_BYTES = parseInt(process.env.GSTACK_BROWSE_MAX_HTML_BYTES || '', 10) || (50 * 1024 * 1024);
      if (stat.size > MAX_BYTES) {
        throw new Error(
          `load-html: file too large (${stat.size} bytes > ${MAX_BYTES} cap). Raise with GSTACK_BROWSE_MAX_HTML_BYTES=<N> or split the HTML.`
        );
      }

      // Single read: Buffer → magic-byte peek → utf-8 string
      const buf = await fs.promises.readFile(absolutePath);

      // Magic-byte check: strip UTF-8 BOM + leading whitespace, then verify the first
      // non-whitespace byte starts a markup construct. Accepts any <tag, <!doctype,
      // <!-- comment, <?xml prolog — including bare HTML fragments like `<div>...</div>`
      // which setContent wraps in a full document. Rejects binary files mis-renamed .html
      // (first byte won't be `<`).
      let peek = buf.slice(0, 200);
      if (peek[0] === 0xEF && peek[1] === 0xBB && peek[2] === 0xBF) {
        peek = peek.slice(3);
      }
      const peekStr = peek.toString('utf8').trimStart();
      // Valid markup opener: '<' followed by alpha (tag), '!' (doctype/comment), or '?' (xml prolog)
      const looksLikeMarkup = /^<[a-zA-Z!?]/.test(peekStr);
      if (!looksLikeMarkup) {
        const hexDump = Array.from(buf.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        throw new Error(
          `load-html: ${absolutePath} has ${ext} extension but content does not look like HTML. First bytes: ${hexDump}`
        );
      }

      const html = buf.toString('utf8');
      await session.setTabContent(html, { waitUntil });
      return `Loaded HTML: ${absolutePath} (${stat.size} bytes)`;
    }

    case 'click': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse click <selector>');

      // Auto-route: if ref points to a real <option> inside a <select>, use selectOption
      const role = session.getRefRole(selector);
      if (role === 'option') {
        const resolved = await session.resolveRef(selector);
        if ('locator' in resolved) {
          const optionInfo = await resolved.locator.evaluate(el => {
            if (el.tagName !== 'OPTION') return null; // custom [role=option], not real <option>
            const option = el as HTMLOptionElement;
            const select = option.closest('select');
            if (!select) return null;
            return { value: option.value, text: option.text };
          });
          if (optionInfo) {
            await resolved.locator.locator('xpath=ancestor::select').selectOption(optionInfo.value, { timeout: 5000 });
            return `Selected "${optionInfo.text}" (auto-routed from click on <option>) → now at ${page.url()}`;
          }
          // Real <option> with no parent <select> or custom [role=option] — fall through to normal click
        }
      }

      const resolved = await session.resolveRef(selector);
      try {
        if ('locator' in resolved) {
          await resolved.locator.click({ timeout: 5000 });
        } else {
          await target.locator(resolved.selector).click({ timeout: 5000 });
        }
      } catch (err: any) {
        // Enhanced error guidance: clicking <option> elements always fails (not visible / timeout)
        const isOption = 'locator' in resolved
          ? await resolved.locator.evaluate(el => el.tagName === 'OPTION').catch(() => false)
          : await target.locator(resolved.selector).evaluate(
              el => el.tagName === 'OPTION'
            ).catch(() => false);
        if (isOption) {
          throw new Error(
            `Cannot click <option> elements. Use 'browse select <parent-select> <value>' instead of 'click' for dropdown options.`
          );
        }
        throw err;
      }
      // Wait for network to settle (catches XHR/fetch triggered by clicks)
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      return `Clicked ${selector} → now at ${page.url()}`;
    }

    case 'fill': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || !value) throw new Error('Usage: browse fill <selector> <value>');
      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.fill(value, { timeout: 5000 });
      } else {
        await target.locator(resolved.selector).fill(value, { timeout: 5000 });
      }
      // Wait for network to settle (form validation XHRs)
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      return `Filled ${selector}`;
    }

    case 'select': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || !value) throw new Error('Usage: browse select <selector> <value>');
      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.selectOption(value, { timeout: 5000 });
      } else {
        await target.locator(resolved.selector).selectOption(value, { timeout: 5000 });
      }
      // Wait for network to settle (dropdown-triggered requests)
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      return `Selected "${value}" in ${selector}`;
    }

    case 'hover': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse hover <selector>');
      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.hover({ timeout: 5000 });
      } else {
        await target.locator(resolved.selector).hover({ timeout: 5000 });
      }
      return `Hovered ${selector}`;
    }

    case 'type': {
      const text = args.join(' ');
      if (!text) throw new Error('Usage: browse type <text>');
      await page.keyboard.type(text);
      return `Typed ${text.length} characters`;
    }

    case 'press': {
      const key = args[0];
      if (!key) throw new Error('Usage: browse press <key> (e.g., Enter, Tab, Escape)');
      await page.keyboard.press(key);
      return `Pressed ${key}`;
    }

    case 'scroll': {
      // Parse --times N and --wait ms flags
      const timesIdx = args.indexOf('--times');
      const times = timesIdx >= 0 ? parseInt(args[timesIdx + 1], 10) || 1 : 0;
      const waitIdx = args.indexOf('--wait');
      const waitMs = waitIdx >= 0 ? parseInt(args[waitIdx + 1], 10) || 1000 : 1000;
      const selector = args.find(a => !a.startsWith('--') && args.indexOf(a) !== timesIdx + 1 && args.indexOf(a) !== waitIdx + 1);

      if (times > 0) {
        // Repeated scroll mode
        for (let i = 0; i < times; i++) {
          if (selector) {
            const resolved = await bm.resolveRef(selector);
            if ('locator' in resolved) {
              await resolved.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
            } else {
              await target.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
            }
          } else {
            await target.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          }
          if (i < times - 1) await new Promise(r => setTimeout(r, waitMs));
        }
        return `Scrolled ${times} times${selector ? ` (${selector})` : ''} with ${waitMs}ms delay`;
      }

      // Single scroll (original behavior)
      if (selector) {
        const resolved = await session.resolveRef(selector);
        if ('locator' in resolved) {
          await resolved.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
        } else {
          await target.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: 5000 });
        }
        return `Scrolled ${selector} into view`;
      }
      await target.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      return 'Scrolled to bottom';
    }

    case 'wait': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse wait <selector|--networkidle|--load|--domcontentloaded>');
      if (selector === '--networkidle') {
        const MAX_WAIT_MS = 300_000;
        const MIN_WAIT_MS = 1_000;
        const timeout = Math.min(Math.max(args[1] ? parseInt(args[1], 10) || MIN_WAIT_MS : 15000, MIN_WAIT_MS), MAX_WAIT_MS);
        await page.waitForLoadState('networkidle', { timeout });
        return 'Network idle';
      }
      if (selector === '--load') {
        await page.waitForLoadState('load');
        return 'Page loaded';
      }
      if (selector === '--domcontentloaded') {
        await page.waitForLoadState('domcontentloaded');
        return 'DOM content loaded';
      }
      const MAX_WAIT_MS = 300_000;
      const MIN_WAIT_MS = 1_000;
      const timeout = Math.min(Math.max(args[1] ? parseInt(args[1], 10) || MIN_WAIT_MS : 15000, MIN_WAIT_MS), MAX_WAIT_MS);
      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.waitFor({ state: 'visible', timeout });
      } else {
        await target.locator(resolved.selector).waitFor({ state: 'visible', timeout });
      }
      return `Element ${selector} appeared`;
    }

    case 'viewport': {
      // Parse args: [<WxH>] [--scale <n>]. Either may be omitted, but NOT both.
      let sizeArg: string | undefined;
      let scaleArg: number | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--scale') {
          const val = args[++i];
          if (val === undefined || val === '') {
            throw new Error('viewport --scale: missing value. Usage: viewport [WxH] --scale <n>');
          }
          const parsed = Number(val);
          if (!Number.isFinite(parsed)) {
            throw new Error(`viewport --scale: value '${val}' is not a finite number.`);
          }
          scaleArg = parsed;
        } else if (args[i].startsWith('--')) {
          throw new Error(`Unknown viewport flag: ${args[i]}`);
        } else if (sizeArg === undefined) {
          sizeArg = args[i];
        } else {
          throw new Error(`Unexpected positional arg: ${args[i]}. Usage: viewport [WxH] [--scale <n>]`);
        }
      }

      if (sizeArg === undefined && scaleArg === undefined) {
        throw new Error('Usage: browse viewport [<WxH>] [--scale <n>]  (e.g. 375x812, or --scale 2 to keep current size)');
      }

      // Resolve width/height: either from sizeArg or from current viewport if --scale-only.
      let w: number, h: number;
      if (sizeArg) {
        if (!sizeArg.includes('x')) throw new Error('Usage: browse viewport [<WxH>] [--scale <n>] (e.g., 375x812)');
        const [rawW, rawH] = sizeArg.split('x').map(Number);
        w = Math.min(Math.max(Math.round(rawW) || 1280, 1), 16384);
        h = Math.min(Math.max(Math.round(rawH) || 720, 1), 16384);
      } else {
        // --scale without WxH → use BrowserManager's tracked viewport (source of truth
        // since setViewport + launchContext keep it in sync). Falls back reliably on
        // headed → headless transitions or contexts with viewport:null.
        const current = bm.getCurrentViewport();
        w = current.width;
        h = current.height;
      }

      if (scaleArg !== undefined) {
        const err = await bm.setDeviceScaleFactor(scaleArg, w, h);
        if (err) return `Viewport partially set: ${err}`;
        return `Viewport set to ${w}x${h} @ ${scaleArg}x (context recreated; refs and load-html content replayed)`;
      }

      await bm.setViewport(w, h);
      return `Viewport set to ${w}x${h}`;
    }

    case 'cookie': {
      const cookieStr = args[0];
      if (!cookieStr || !cookieStr.includes('=')) throw new Error('Usage: browse cookie <name>=<value>');
      const eq = cookieStr.indexOf('=');
      const name = cookieStr.slice(0, eq);
      const value = cookieStr.slice(eq + 1);
      const url = new URL(page.url());
      await page.context().addCookies([{
        name,
        value,
        domain: url.hostname,
        path: '/',
      }]);
      return `Cookie set: ${name}=****`;
    }

    case 'header': {
      const headerStr = args[0];
      if (!headerStr || !headerStr.includes(':')) throw new Error('Usage: browse header <name>:<value>');
      const sep = headerStr.indexOf(':');
      const name = headerStr.slice(0, sep).trim();
      const value = headerStr.slice(sep + 1).trim();
      await bm.setExtraHeader(name, value);
      const sensitiveHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'];
      const redactedValue = sensitiveHeaders.includes(name.toLowerCase()) ? '****' : value;
      return `Header set: ${name}: ${redactedValue}`;
    }

    case 'useragent': {
      const ua = args.join(' ');
      if (!ua) throw new Error('Usage: browse useragent <string>');
      bm.setUserAgent(ua);
      const error = await bm.recreateContext();
      if (error) {
        return `User agent set to "${ua}" but: ${error}`;
      }
      return `User agent set: ${ua}`;
    }

    case 'upload': {
      const [selector, ...filePaths] = args;
      if (!selector || filePaths.length === 0) throw new Error('Usage: browse upload <selector> <file1> [file2...]');

      // Validate paths are within safe directories (same check as cookie-import)
      for (const fp of filePaths) {
        if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
        if (path.isAbsolute(fp)) {
          let resolvedFp: string;
          try { resolvedFp = fs.realpathSync(path.resolve(fp)); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; resolvedFp = path.resolve(fp); }
          if (!SAFE_DIRECTORIES.some(dir => isPathWithin(resolvedFp, dir))) {
            throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
          }
        }
        if (path.normalize(fp).includes('..')) {
          throw new Error('Path traversal sequences (..) are not allowed');
        }
      }

      const resolved = await session.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.setInputFiles(filePaths);
      } else {
        await target.locator(resolved.selector).setInputFiles(filePaths);
      }

      const fileInfo = filePaths.map(fp => {
        const stat = fs.statSync(fp);
        return `${path.basename(fp)} (${stat.size}B)`;
      }).join(', ');
      return `Uploaded: ${fileInfo}`;
    }

    case 'dialog-accept': {
      const text = args.length > 0 ? args.join(' ') : null;
      bm.setDialogAutoAccept(true);
      bm.setDialogPromptText(text);
      return text
        ? `Dialogs will be accepted with text: "${text}"`
        : 'Dialogs will be accepted';
    }

    case 'dialog-dismiss': {
      bm.setDialogAutoAccept(false);
      bm.setDialogPromptText(null);
      return 'Dialogs will be dismissed';
    }

    case 'cookie-import': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse cookie-import <json-file>');
      // Path validation — resolve to absolute and check against safe dirs.
      // Fixes #707: relative paths previously bypassed the safe directory check.
      // Mirrors validateOutputPath() — resolves symlinks (e.g., macOS /tmp → /private/tmp).
      const resolved = path.resolve(filePath);
      let resolvedReal = resolved;
      try { resolvedReal = fs.realpathSync(resolved); } catch {
        // File may not exist yet — resolve parent dir instead
        try { resolvedReal = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch {}
      }
      if (!SAFE_DIRECTORIES.some(dir => isPathWithin(resolvedReal, dir))) {
        throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
      }
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      let cookies: any[];
      try { cookies = JSON.parse(raw); } catch (err: any) { throw new Error(`Invalid JSON in ${filePath}: ${err?.message || err}`); }
      if (!Array.isArray(cookies)) throw new Error('Cookie file must contain a JSON array');

      // Auto-fill domain from current page URL when missing (consistent with cookie command)
      const pageUrl = new URL(page.url());
      const defaultDomain = pageUrl.hostname;

      for (const c of cookies) {
        if (!c.name || c.value === undefined) throw new Error('Each cookie must have "name" and "value" fields');
        if (!c.domain) {
          c.domain = defaultDomain;
        } else {
          const cookieDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
          if (cookieDomain !== defaultDomain && !defaultDomain.endsWith('.' + cookieDomain)) {
            throw new Error(`Cookie domain "${c.domain}" does not match current page domain "${defaultDomain}". Use the target site first.`);
          }
        }
        if (!c.path) c.path = '/';
      }

      await page.context().addCookies(cookies);
      const importedDomains = [...new Set(cookies.map((c: any) => c.domain).filter(Boolean))];
      if (importedDomains.length > 0) bm.trackCookieImportDomains(importedDomains);
      return `Loaded ${cookies.length} cookies from ${filePath}`;
    }

    case 'cookie-import-browser': {
      // Two modes:
      // 1. Direct CLI import: cookie-import-browser <browser> --domain <domain> [--profile <profile>]
      //    Requires --domain (or --all to explicitly import everything).
      // 2. Open picker UI: cookie-import-browser [browser] (interactive domain selection)
      const browserArg = args[0];
      const domainIdx = args.indexOf('--domain');
      const profileIdx = args.indexOf('--profile');
      const hasAll = args.includes('--all');
      const profile = (profileIdx !== -1 && profileIdx + 1 < args.length) ? args[profileIdx + 1] : 'Default';

      if (domainIdx !== -1 && domainIdx + 1 < args.length) {
        // Direct import mode — scoped to specific domain
        const domain = args[domainIdx + 1];
        // Validate --domain against current page hostname to prevent cross-site cookie injection
        const pageHostname = new URL(page.url()).hostname;
        const normalizedDomain = domain.startsWith('.') ? domain.slice(1) : domain;
        if (normalizedDomain !== pageHostname && !pageHostname.endsWith('.' + normalizedDomain)) {
          throw new Error(`--domain "${domain}" does not match current page domain "${pageHostname}". Navigate to the target site first.`);
        }
        const browser = browserArg || 'comet';
        let result = await importCookies(browser, [domain], profile);
        // If all cookies failed and v20 is detected, try CDP extraction
        if (result.cookies.length === 0 && result.failed > 0 && hasV20Cookies(browser, profile)) {
          result = await importCookiesViaCdp(browser, [domain], profile);
        }
        if (result.cookies.length > 0) {
          await page.context().addCookies(result.cookies);
          bm.trackCookieImportDomains([domain]);
        }
        const msg = [`Imported ${result.count} cookies for ${domain} from ${browser}`];
        if (result.failed > 0) msg.push(`(${result.failed} failed to decrypt)`);
        return msg.join(' ');
      }

      if (hasAll) {
        // Explicit all-cookies import — requires --all flag as a deliberate opt-in.
        // Imports every non-expired cookie domain from the browser.
        const browser = browserArg || 'comet';
        const { listDomains } = await import('./cookie-import-browser');
        const { domains } = listDomains(browser, profile);
        const allDomainNames = domains.map((d: any) => d.domain);
        if (allDomainNames.length === 0) {
          return `No cookies found in ${browser} (profile: ${profile})`;
        }
        const result = await importCookies(browser, allDomainNames, profile);
        if (result.cookies.length > 0) {
          await page.context().addCookies(result.cookies);
          bm.trackCookieImportDomains(allDomainNames);
        }
        const msg = [`Imported ${result.count} cookies across ${Object.keys(result.domainCounts).length} domains from ${browser}`];
        msg.push('(used --all: all browser cookies imported, consider --domain for tighter scoping)');
        if (result.failed > 0) msg.push(`(${result.failed} failed to decrypt)`);
        return msg.join(' ');
      }

      // Picker UI mode — open in user's browser for interactive domain selection
      const port = bm.serverPort;
      if (!port) throw new Error('Server port not available');

      const browsers = findInstalledBrowsers();
      if (browsers.length === 0) {
        throw new Error(`No Chromium browsers found. Supported: ${listSupportedBrowserNames().join(', ')}`);
      }

      const code = generatePickerCode();
      const pickerUrl = `http://127.0.0.1:${port}/cookie-picker?code=${code}`;
      try {
        Bun.spawn(['open', pickerUrl], { stdout: 'ignore', stderr: 'ignore' });
      } catch (err: any) {
        // open may fail on non-macOS or if 'open' binary is missing — URL is in the message below
        if (err?.code !== 'ENOENT' && !err?.message?.includes('spawn')) throw err;
      }

      return `Cookie picker opened at http://127.0.0.1:${port}/cookie-picker\nDetected browsers: ${browsers.map(b => b.name).join(', ')}\nSelect domains to import, then close the picker when done.\n\nTip: For scripted imports, use --domain <domain> to scope cookies to a single domain.`;
    }

    case 'style': {
      // style --undo [N] → revert modification
      if (args[0] === '--undo') {
        const idx = args[1] ? parseInt(args[1], 10) : undefined;
        await undoModification(page, idx);
        return idx !== undefined ? `Reverted modification #${idx}` : 'Reverted last modification';
      }

      // style <selector> <property> <value>
      const [selector, property, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector || !property || !value) {
        throw new Error('Usage: browse style <sel> <prop> <value> | style --undo [N]');
      }

      // Validate CSS property name
      if (!/^[a-zA-Z-]+$/.test(property)) {
        throw new Error(`Invalid CSS property name: ${property}. Only letters and hyphens allowed.`);
      }

      // Validate CSS value — block data exfiltration patterns
      const DANGEROUS_CSS = /url\s*\(|expression\s*\(|@import|javascript:|data:/i;
      if (DANGEROUS_CSS.test(value)) {
        throw new Error('CSS value rejected: contains potentially dangerous pattern.');
      }

      const mod = await modifyStyle(page, selector, property, value);
      return `Style modified: ${selector} { ${property}: ${mod.oldValue || '(none)'} → ${value} } (${mod.method})`;
    }

    case 'cleanup': {
      // Parse flags
      let doAds = false, doCookies = false, doSticky = false, doSocial = false;
      let doOverlays = false, doClutter = false;
      let doAll = false;

      // Default to --all if no args (most common use case from sidebar button)
      if (args.length === 0) {
        doAll = true;
      }

      for (const arg of args) {
        switch (arg) {
          case '--ads': doAds = true; break;
          case '--cookies': doCookies = true; break;
          case '--sticky': doSticky = true; break;
          case '--social': doSocial = true; break;
          case '--overlays': doOverlays = true; break;
          case '--clutter': doClutter = true; break;
          case '--all': doAll = true; break;
          default:
            throw new Error(`Unknown cleanup flag: ${arg}. Use: --ads, --cookies, --sticky, --social, --overlays, --clutter, --all`);
        }
      }

      if (doAll) {
        doAds = doCookies = doSticky = doSocial = doOverlays = doClutter = true;
      }

      const removed: string[] = [];

      // Build selector list for categories to clean
      const selectors: string[] = [];
      if (doAds) selectors.push(...CLEANUP_SELECTORS.ads);
      if (doCookies) selectors.push(...CLEANUP_SELECTORS.cookies);
      if (doSocial) selectors.push(...CLEANUP_SELECTORS.social);
      if (doOverlays) selectors.push(...CLEANUP_SELECTORS.overlays);
      if (doClutter) selectors.push(...CLEANUP_SELECTORS.clutter);

      if (selectors.length > 0) {
        const count = await page.evaluate((sels: string[]) => {
          let removed = 0;
          for (const sel of sels) {
            try {
              const els = document.querySelectorAll(sel);
              els.forEach(el => {
                (el as HTMLElement).style.setProperty('display', 'none', 'important');
                removed++;
              });
            } catch (err: any) {
              // querySelectorAll throws DOMException on invalid CSS selectors — skip those
              if (!(err instanceof DOMException)) throw err;
            }
          }
          return removed;
        }, selectors);
        if (count > 0) {
          if (doAds) removed.push('ads');
          if (doCookies) removed.push('cookie banners');
          if (doSocial) removed.push('social widgets');
          if (doOverlays) removed.push('overlays/popups');
          if (doClutter) removed.push('clutter');
        }
      }

      // Sticky/fixed elements — handled separately with computed style check
      if (doSticky) {
        const stickyCount = await page.evaluate(() => {
          let removed = 0;
          // Collect all sticky/fixed elements, sort by vertical position
          const stickyEls: Array<{ el: Element; top: number; width: number; height: number }> = [];
          const allElements = document.querySelectorAll('*');
          const viewportWidth = window.innerWidth;
          for (const el of allElements) {
            const style = getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const rect = el.getBoundingClientRect();
              stickyEls.push({ el, top: rect.top, width: rect.width, height: rect.height });
            }
          }
          // Sort by vertical position (topmost first)
          stickyEls.sort((a, b) => a.top - b.top);
          let preservedTopNav = false;
          for (const { el, top, width, height } of stickyEls) {
            const tag = el.tagName.toLowerCase();
            // Always skip nav/header semantic elements
            if (tag === 'nav' || tag === 'header') continue;
            if (el.getAttribute('role') === 'navigation') continue;
            // Skip the gstack control indicator
            if ((el as HTMLElement).id === 'gstack-ctrl') continue;
            // Preserve the FIRST full-width element near the top (site's main nav bar)
            // This catches divs that act as navbars but aren't semantic <nav> elements
            if (!preservedTopNav && top <= 50 && width > viewportWidth * 0.8 && height < 120) {
              preservedTopNav = true;
              continue;
            }
            (el as HTMLElement).style.setProperty('display', 'none', 'important');
            removed++;
          }
          return removed;
        });
        if (stickyCount > 0) removed.push(`${stickyCount} sticky/fixed elements`);
      }

      // Unlock scrolling (many sites lock body scroll when modals are open)
      const scrollFixed = await page.evaluate(() => {
        let fixed = 0;
        // Unlock body and html scroll
        for (const el of [document.body, document.documentElement]) {
          if (!el) continue;
          const style = getComputedStyle(el);
          if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
            (el as HTMLElement).style.setProperty('overflow', 'auto', 'important');
            (el as HTMLElement).style.setProperty('overflow-y', 'auto', 'important');
            fixed++;
          }
          // Remove height:100% + position:fixed that locks scroll
          if (style.position === 'fixed' && (el === document.body || el === document.documentElement)) {
            (el as HTMLElement).style.setProperty('position', 'static', 'important');
            fixed++;
          }
        }
        // Remove blur/filter effects (paywalls often blur the content)
        const blurred = document.querySelectorAll('[style*="blur"], [style*="filter"]');
        blurred.forEach(el => {
          const s = (el as HTMLElement).style;
          if (s.filter?.includes('blur') || s.webkitFilter?.includes('blur')) {
            s.setProperty('filter', 'none', 'important');
            s.setProperty('-webkit-filter', 'none', 'important');
            fixed++;
          }
        });
        // Remove max-height truncation (article truncation)
        const truncated = document.querySelectorAll('[class*="truncat"], [class*="preview"], [class*="teaser"]');
        truncated.forEach(el => {
          const s = getComputedStyle(el);
          if (s.maxHeight && s.maxHeight !== 'none' && parseInt(s.maxHeight) < 500) {
            (el as HTMLElement).style.setProperty('max-height', 'none', 'important');
            (el as HTMLElement).style.setProperty('overflow', 'visible', 'important');
            fixed++;
          }
        });
        return fixed;
      });
      if (scrollFixed > 0) removed.push('scroll unlocked');

      // Remove "ADVERTISEMENT" / "Article continues below" text labels
      const adLabelCount = await page.evaluate(() => {
        let removed = 0;
        const adTextPatterns = [
          /^advertisement$/i, /^sponsored$/i, /^promoted$/i,
          /article continues/i, /continues below/i,
          /^ad$/i, /^paid content$/i, /^partner content$/i,
        ];
        // Walk text-heavy small elements looking for ad labels
        const candidates = document.querySelectorAll('div, span, p, figcaption, label');
        for (const el of candidates) {
          const text = (el.textContent || '').trim();
          if (text.length > 50) continue; // Too much text, probably real content
          if (adTextPatterns.some(p => p.test(text))) {
            // Also hide the parent if it's a wrapper with little else
            const parent = el.parentElement;
            if (parent && (parent.textContent || '').trim().length < 80) {
              (parent as HTMLElement).style.setProperty('display', 'none', 'important');
            } else {
              (el as HTMLElement).style.setProperty('display', 'none', 'important');
            }
            removed++;
          }
        }
        return removed;
      });
      if (adLabelCount > 0) removed.push(`${adLabelCount} ad labels`);

      // Remove empty ad placeholder whitespace (divs that are now empty after ad removal)
      const collapsedCount = await page.evaluate(() => {
        let collapsed = 0;
        const candidates = document.querySelectorAll(
          'div[class*="ad"], div[id*="ad"], aside[class*="ad"], div[class*="sidebar"], ' +
          'div[class*="rail"], div[class*="right-col"], div[class*="widget"]'
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          // If the element has significant height but no visible text content, collapse it
          if (rect.height > 50 && rect.width > 0) {
            const text = (el.textContent || '').trim();
            const images = el.querySelectorAll('img:not([src*="logo"]):not([src*="icon"])');
            const links = el.querySelectorAll('a');
            // Empty or mostly empty: collapse
            if (text.length < 20 && images.length === 0 && links.length < 2) {
              (el as HTMLElement).style.setProperty('display', 'none', 'important');
              collapsed++;
            }
          }
        }
        return collapsed;
      });
      if (collapsedCount > 0) removed.push(`${collapsedCount} empty placeholders`);

      if (removed.length === 0) return 'No clutter elements found to remove.';
      return `Cleaned up: ${removed.join(', ')}`;
    }

    case 'prettyscreenshot': {
      // Parse flags
      let scrollTo: string | undefined;
      let doCleanup = false;
      const hideSelectors: string[] = [];
      let viewportWidth: number | undefined;
      let outputPath: string | undefined;

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--scroll-to' && i + 1 < args.length) {
          scrollTo = args[++i];
        } else if (args[i] === '--cleanup') {
          doCleanup = true;
        } else if (args[i] === '--hide' && i + 1 < args.length) {
          // Collect all following non-flag args as selectors to hide
          i++;
          while (i < args.length && !args[i].startsWith('--')) {
            hideSelectors.push(args[i]);
            i++;
          }
          i--; // Back up since the for loop will increment
        } else if (args[i] === '--width' && i + 1 < args.length) {
          viewportWidth = parseInt(args[++i], 10);
          if (isNaN(viewportWidth)) throw new Error('--width must be a number');
        } else if (!args[i].startsWith('--')) {
          outputPath = args[i];
        } else {
          throw new Error(`Unknown prettyscreenshot flag: ${args[i]}`);
        }
      }

      // Default output path
      if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outputPath = `${TEMP_DIR}/browse-pretty-${timestamp}.png`;
      }
      validateOutputPath(outputPath);

      const originalViewport = page.viewportSize();

      // Set viewport width if specified
      if (viewportWidth && originalViewport) {
        await page.setViewportSize({ width: viewportWidth, height: originalViewport.height });
      }

      // Run cleanup if requested
      if (doCleanup) {
        const allSelectors = [
          ...CLEANUP_SELECTORS.ads,
          ...CLEANUP_SELECTORS.cookies,
          ...CLEANUP_SELECTORS.social,
        ];
        await page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            try {
              document.querySelectorAll(sel).forEach(el => {
                (el as HTMLElement).style.display = 'none';
              });
            } catch (err: any) {
              if (!(err instanceof DOMException)) throw err;
            }
          }
          // Also hide fixed/sticky (except nav)
          for (const el of document.querySelectorAll('*')) {
            const style = getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const tag = el.tagName.toLowerCase();
              if (tag === 'nav' || tag === 'header') continue;
              if (el.getAttribute('role') === 'navigation') continue;
              (el as HTMLElement).style.display = 'none';
            }
          }
        }, allSelectors);
      }

      // Hide specific elements
      if (hideSelectors.length > 0) {
        await page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            try {
              document.querySelectorAll(sel).forEach(el => {
                (el as HTMLElement).style.display = 'none';
              });
            } catch (err: any) {
              if (!(err instanceof DOMException)) throw err;
            }
          }
        }, hideSelectors);
      }

      // Scroll to target
      if (scrollTo) {
        // Try as CSS selector first, then as text content
        const scrolled = await page.evaluate((target: string) => {
          // Try CSS selector
          let el = document.querySelector(target);
          if (el) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            return true;
          }
          // Try text match
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
          );
          let node: Node | null;
          while ((node = walker.nextNode())) {
            if (node.textContent?.includes(target)) {
              const parent = node.parentElement;
              if (parent) {
                parent.scrollIntoView({ behavior: 'instant', block: 'center' });
                return true;
              }
            }
          }
          return false;
        }, scrollTo);

        if (!scrolled) {
          // Restore viewport before throwing
          if (viewportWidth && originalViewport) {
            await page.setViewportSize(originalViewport);
          }
          throw new Error(`Could not find element or text to scroll to: ${scrollTo}`);
        }
        // Brief wait for scroll to settle
        await page.waitForTimeout(300);
      }

      // Take screenshot
      await page.screenshot({ path: outputPath, fullPage: !scrollTo });

      // Restore viewport
      if (viewportWidth && originalViewport) {
        await page.setViewportSize(originalViewport);
      }

      const parts = ['Screenshot saved'];
      if (doCleanup) parts.push('(cleaned)');
      if (scrollTo) parts.push(`(scrolled to: ${scrollTo})`);
      parts.push(`: ${outputPath}`);
      return parts.join(' ');
    }

    case 'download': {
      if (args.length === 0) throw new Error('Usage: download <url|@ref> [path] [--base64] [--navigate]');
      const isBase64 = args.includes('--base64');
      const useNavigate = args.includes('--navigate');
      const filteredArgs = args.filter(a => a !== '--base64' && a !== '--navigate');
      let url = filteredArgs[0];
      const outputPath = filteredArgs[1];

      // Resolve @ref to element src
      if (url.startsWith('@')) {
        const resolved = await bm.resolveRef(url);
        if (!('locator' in resolved)) throw new Error(`Expected @ref, got CSS selector: ${url}`);
        const locator = resolved.locator;
        const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
        if (tagName === 'img') {
          url = await locator.evaluate(el => {
            const img = el as HTMLImageElement;
            return img.currentSrc || img.src || img.getAttribute('data-src') || '';
          });
        } else if (tagName === 'video') {
          url = await locator.evaluate(el => (el as HTMLVideoElement).currentSrc || (el as HTMLVideoElement).src || '');
        } else if (tagName === 'audio') {
          url = await locator.evaluate(el => (el as HTMLAudioElement).currentSrc || (el as HTMLAudioElement).src || '');
        } else {
          // Try src attribute on any element
          url = await locator.evaluate(el => el.getAttribute('src') || '');
        }
        if (!url) throw new Error(`Could not extract URL from ${filteredArgs[0]} (${tagName})`);
      }

      // Check for HLS/DASH
      if (url.includes('.m3u8') || url.includes('.mpd')) {
        throw new Error('This is an HLS/DASH stream. Use yt-dlp or ffmpeg for adaptive stream downloads.');
      }

      // Determine output path and extension
      const page = bm.getPage();
      let contentType = 'application/octet-stream';
      let buffer: Buffer;

      if (url.startsWith('blob:')) {
        // Strategy 3: Blob URL -- in-page fetch + base64
        const dataUrl = await page.evaluate(async (blobUrl) => {
          try {
            const resp = await fetch(blobUrl);
            const blob = await resp.blob();
            if (blob.size > 100 * 1024 * 1024) return 'ERROR:TOO_LARGE';
            return new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.onerror = () => reject('Failed to read blob');
              reader.readAsDataURL(blob);
            });
          } catch (err: any) {
            return `ERROR:EXPIRED:${err?.message || 'unknown'}`;
          }
        }, url);

        if (dataUrl === 'ERROR:TOO_LARGE') throw new Error('Blob too large (>100MB). Use a different approach.');
        if (dataUrl.startsWith('ERROR:EXPIRED')) throw new Error(`Blob URL expired or inaccessible: ${dataUrl.slice('ERROR:EXPIRED:'.length)}`);

        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) throw new Error('Failed to decode blob data');
        contentType = match[1];
        buffer = Buffer.from(match[2], 'base64');
      } else if (useNavigate) {
        // Strategy 2: Navigate to URL and capture browser-triggered download.
        // Handles URLs that trigger file downloads via redirects,
        // Content-Disposition headers, or anti-bot CDN chains where
        // page.request.fetch() can't follow the auth/redirect chain.
        await validateNavigationUrl(url);
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
        // Use goto with 'commit' wait — the page may redirect to trigger
        // the download, so 'domcontentloaded' may never fire.
        page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch(() => {
          // Navigation may "fail" because the response is a download,
          // not a page. The download event handles it.
        });
        const download = await downloadPromise;
        const failure = await download.failure();
        if (failure) {
          throw new Error(`Download failed: ${failure}`);
        }
        // Save to temp location first, then read into buffer
        const tempPath = path.join(TEMP_DIR, `browse-nav-download-${Date.now()}`);
        await download.saveAs(tempPath);
        buffer = fs.readFileSync(tempPath);
        // Try to infer content type from suggested filename
        const suggested = download.suggestedFilename();
        if (suggested) {
          const extMatch = suggested.match(/\.([a-z0-9]+)$/i);
          if (extMatch) {
            const extLower = extMatch[1].toLowerCase();
            const mimeMap: Record<string, string> = {
              epub: 'application/epub+zip', pdf: 'application/pdf',
              zip: 'application/zip', gz: 'application/gzip',
              mp3: 'audio/mpeg', mp4: 'video/mp4',
              jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
              txt: 'text/plain', html: 'text/html', json: 'application/json',
            };
            contentType = mimeMap[extLower] || 'application/octet-stream';
          }
        }
        // Clean up temp file if we're going to write elsewhere
        if (outputPath || isBase64) {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        } else {
          // No explicit output path — rename temp file with inferred extension.
          const ext = contentType.split(';')[0].includes('/')
            ? mimeToExt(contentType.split(';')[0].trim())
            : '.bin';
          const finalPath = path.join(TEMP_DIR, `browse-download-${Date.now()}${ext}`);
          fs.renameSync(tempPath, finalPath);
          const sizeKB = Math.round(buffer.length / 1024);
          return `Downloaded: ${finalPath} (${sizeKB}KB, ${contentType.split(';')[0].trim()})${suggested ? ` [${suggested}]` : ''}`;
        }
        if (buffer.length > 200 * 1024 * 1024) {
          throw new Error('File too large (>200MB).');
        }
      } else {
        // Strategy 1: Direct URL via page.request.fetch().
        // Gate the URL through the same validator `goto` uses. Without
        // this check, download + scrape bypass the navigation
        // blocklist and a caller with write scope can read
        // http://169.254.169.254/latest/meta-data/ (AWS IMDSv1), the
        // GCP/Azure metadata equivalents, or any internal IPv4/IPv6
        // the server happens to route to. The response body is then
        // returned to the caller (base64) or written to disk where
        // GET /file serves it back.
        await validateNavigationUrl(url);
        const response = await page.request.fetch(url, { timeout: 30000 });
        const status = response.status();
        if (status >= 400) {
          throw new Error(`Download failed: HTTP ${status} ${response.statusText()}`);
        }
        contentType = response.headers()['content-type'] || 'application/octet-stream';
        buffer = Buffer.from(await response.body());
        if (buffer.length > 200 * 1024 * 1024) {
          throw new Error('File too large (>200MB).');
        }
      }

      // --base64 mode: return inline
      if (isBase64) {
        if (buffer.length > 10 * 1024 * 1024) {
          throw new Error('File too large for --base64 (>10MB). Use disk download + GET /file instead.');
        }
        const mimeType = contentType.split(';')[0].trim();
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
      }

      // Write to disk
      const ext = contentType.split(';')[0].includes('/')
        ? mimeToExt(contentType.split(';')[0].trim())
        : '.bin';
      const destPath = outputPath || path.join(TEMP_DIR, `browse-download-${Date.now()}${ext}`);
      validateOutputPath(destPath);
      fs.writeFileSync(destPath, buffer);
      const sizeKB = Math.round(buffer.length / 1024);
      return `Downloaded: ${destPath} (${sizeKB}KB, ${contentType.split(';')[0].trim()})`;
    }

    case 'scrape': {
      if (args.length === 0) throw new Error('Usage: scrape <images|videos|media> [--selector sel] [--dir path] [--limit N]');
      const mediaType = args[0];
      if (!['images', 'videos', 'media'].includes(mediaType)) {
        throw new Error(`Invalid type: ${mediaType}. Use: images, videos, or media`);
      }

      // Parse flags
      const selectorIdx = args.indexOf('--selector');
      const selector = selectorIdx >= 0 ? args[selectorIdx + 1] : undefined;
      const dirIdx = args.indexOf('--dir');
      const dir = dirIdx >= 0 ? args[dirIdx + 1] : path.join(TEMP_DIR, `browse-scrape-${Date.now()}`);
      const limitIdx = args.indexOf('--limit');
      const limit = Math.min(limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 50 : 50, 200);

      validateOutputPath(dir);
      fs.mkdirSync(dir, { recursive: true });

      const { extractMedia } = await import('./media-extract');
      const target = bm.getActiveFrameOrPage();
      const filter = mediaType === 'images' ? 'images' as const
        : mediaType === 'videos' ? 'videos' as const
        : undefined;
      const mediaResult = await extractMedia(target, { selector, filter });

      // Collect URLs to download
      const urls: Array<{ url: string; type: string }> = [];
      const seen = new Set<string>();

      for (const img of mediaResult.images) {
        const url = img.currentSrc || img.src || img.dataSrc;
        if (url && !seen.has(url) && !url.startsWith('data:')) {
          seen.add(url);
          urls.push({ url, type: 'image' });
        }
      }
      for (const vid of mediaResult.videos) {
        const url = vid.currentSrc || vid.src;
        if (url && !seen.has(url) && !url.startsWith('blob:') && !vid.isHLS && !vid.isDASH) {
          seen.add(url);
          urls.push({ url, type: 'video' });
        }
      }
      for (const bg of mediaResult.backgroundImages) {
        if (bg.url && !seen.has(bg.url)) {
          seen.add(bg.url);
          urls.push({ url: bg.url, type: 'image' });
        }
      }

      const toDownload = urls.slice(0, limit);
      const page = bm.getPage();
      const manifest: any = {
        url: page.url(),
        scraped_at: new Date().toISOString(),
        files: [] as any[],
        total_size: 0,
        succeeded: 0,
        failed: 0,
      };

      const lines: string[] = [];
      for (let i = 0; i < toDownload.length; i++) {
        const { url, type } = toDownload[i];
        try {
          // Same gate as the download command — page.request.fetch
          // must not reach cloud metadata, ULA ranges, or the rest of
          // the blocklist. See url-validation.ts for the full list.
          await validateNavigationUrl(url);
          const response = await page.request.fetch(url, { timeout: 30000 });
          if (response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
          const ct = response.headers()['content-type'] || 'application/octet-stream';
          const ext = mimeToExt(ct.split(';')[0].trim());
          const filename = `${type}-${String(i + 1).padStart(3, '0')}${ext}`;
          const filePath = path.join(dir, filename);
          const body = Buffer.from(await response.body());
          try {
            fs.writeFileSync(filePath, body);
          } catch (writeErr: any) {
            throw new Error(`Disk write failed: ${writeErr.message}`);
          }
          manifest.files.push({ path: filename, src: url, size: body.length, type: ct.split(';')[0].trim() });
          manifest.total_size += body.length;
          manifest.succeeded++;
          lines.push(`  [${i + 1}/${toDownload.length}] ${filename} (${Math.round(body.length / 1024)}KB)`);
        } catch (err: any) {
          manifest.files.push({ path: null, src: url, size: 0, type: '', error: err.message });
          manifest.failed++;
          lines.push(`  [${i + 1}/${toDownload.length}] FAILED: ${err.message}`);
        }
        // 100ms delay between downloads
        if (i < toDownload.length - 1) await new Promise(r => setTimeout(r, 100));
      }

      // Write manifest
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      return `Scraped ${toDownload.length} items to ${dir}/\n${lines.join('\n')}\n\nSummary: ${manifest.succeeded} succeeded, ${manifest.failed} failed, ${Math.round(manifest.total_size / 1024)}KB total`;
    }

    case 'archive': {
      const page = bm.getPage();
      const outputPath = args[0] || path.join(TEMP_DIR, `browse-archive-${Date.now()}.mhtml`);
      validateOutputPath(outputPath);

      try {
        const cdp = await page.context().newCDPSession(page);
        const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
        await cdp.detach();
        fs.writeFileSync(outputPath, data);
        return `Archive saved: ${outputPath} (${Math.round(data.length / 1024)}KB, MHTML)`;
      } catch (err: any) {
        throw new Error(`MHTML archive requires Chromium CDP. Use 'text' or 'html' for raw page content. (${err.message})`);
      }
    }

    default:
      throw new Error(`Unknown write command: ${command}`);
  }
}

/** Map MIME type to file extension. */
function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'application/pdf': '.pdf', 'application/json': '.json',
    'text/html': '.html', 'text/plain': '.txt',
  };
  return map[mime] || '.bin';
}
