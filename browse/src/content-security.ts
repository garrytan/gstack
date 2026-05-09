/**
 * Content security layer for pair-agent browser sharing.
 *
 * Four defense layers:
 *   1. Datamarking — watermark text output to detect exfiltration
 *   2. Hidden element stripping — remove invisible/deceptive elements from output
 *   3. Content filter hooks — extensible URL/content filter pipeline
 *   4. Instruction block hardening — SECURITY section in agent instructions
 *
 * This module handles layers 1-3. Layer 4 is in cli.ts.
 */

import { randomBytes } from 'crypto';
import type { Page, Frame } from 'playwright';

// ─── Datamarking (Layer 1) ──────────────────────────────────────

/** Session-scoped random marker for text watermarking */
let sessionMarker: string | null = null;

function ensureMarker(): string {
  if (!sessionMarker) {
    sessionMarker = randomBytes(3).toString('base64').slice(0, 4);
  }
  return sessionMarker;
}

/** Exported for tests only */
export function getSessionMarker(): string {
  return ensureMarker();
}

/** Reset marker (for testing) */
export function resetSessionMarker(): void {
  sessionMarker = null;
}

/**
 * Insert invisible watermark into text content.
 * Places the marker as zero-width characters between words.
 * Only applied to `text` command output (not html, forms, or structured data).
 */
export function datamarkContent(content: string): string {
  const marker = ensureMarker();
  // Insert marker as a Unicode tag sequence between sentences (after periods followed by space)
  // This is subtle enough to not corrupt output but detectable if exfiltrated
  const zwsp = '\u200B'; // zero-width space
  const taggedMarker = marker.split('').map(c => zwsp + c).join('');
  // Insert after every 3rd sentence-ending period
  let count = 0;
  return content.replace(/(\. )/g, (match) => {
    count++;
    if (count % 3 === 0) {
      return match + taggedMarker;
    }
    return match;
  });
}

// ─── Hidden Element Stripping (Layer 2) ─────────────────────────

/** Injection-like patterns in ARIA labels */
const ARIA_INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+instructions?/i,
  /you\s+are\s+(now|a)\s+/i,
  /system\s*:\s*/i,
  /\bdo\s+not\s+(follow|obey|listen)/i,
  /\bexecute\s+(the\s+)?following/i,
  /\bforget\s+(everything|all|your)/i,
  /\bnew\s+instructions?\s*:/i,
];

/**
 * Detect hidden elements and ARIA injection on a page.
 * Marks hidden elements with data-gstack-hidden attribute.
 * Returns descriptions of what was found for logging.
 *
 * Detection criteria:
 *   - opacity < 0.1
 *   - font-size < 1px
 *   - off-screen (positioned far outside viewport)
 *   - visibility:hidden or display:none with text content
 *   - same foreground/background color
 *   - clip/clip-path hiding
 *   - ARIA labels with injection patterns
 */
export async function markHiddenElements(page: Page | Frame): Promise<string[]> {
  return page.evaluate((ariaPatterns: string[]) => {
    const found: string[] = [];
    const elements = document.querySelectorAll('body *');

    for (const el of elements) {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        const text = el.textContent?.trim() || '';
        if (!text) continue; // skip empty elements

        let isHidden = false;
        let reason = '';

        // Check opacity
        if (parseFloat(style.opacity) < 0.1) {
          isHidden = true;
          reason = 'opacity < 0.1';
        }
        // Check font-size
        else if (parseFloat(style.fontSize) < 1) {
          isHidden = true;
          reason = 'font-size < 1px';
        }
        // Check off-screen positioning
        else if (style.position === 'absolute' || style.position === 'fixed') {
          const rect = el.getBoundingClientRect();
          if (rect.right < -100 || rect.bottom < -100 || rect.left > window.innerWidth + 100 || rect.top > window.innerHeight + 100) {
            isHidden = true;
            reason = 'off-screen';
          }
        }
        // Check same fg/bg color (text hiding)
        else if (style.color === style.backgroundColor && text.length > 10) {
          isHidden = true;
          reason = 'same fg/bg color';
        }
        // Check clip-path hiding
        else if (style.clipPath === 'inset(100%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') {
          isHidden = true;
          reason = 'clip hiding';
        }
        // Check visibility: hidden
        else if (style.visibility === 'hidden') {
          isHidden = true;
          reason = 'visibility hidden';
        }

        if (isHidden) {
          el.setAttribute('data-gstack-hidden', 'true');
          found.push(`[${el.tagName.toLowerCase()}] ${reason}: "${text.slice(0, 60)}..."`);
        }

        // Check ARIA labels for injection patterns
        const ariaLabel = el.getAttribute('aria-label') || '';
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        let labelText = ariaLabel;
        if (ariaLabelledBy) {
          const labelEl = document.getElementById(ariaLabelledBy);
          if (labelEl) labelText += ' ' + (labelEl.textContent || '');
        }

        if (labelText) {
          for (const pattern of ariaPatterns) {
            if (new RegExp(pattern, 'i').test(labelText)) {
              el.setAttribute('data-gstack-hidden', 'true');
              found.push(`[${el.tagName.toLowerCase()}] ARIA injection: "${labelText.slice(0, 60)}..."`);
              break;
            }
          }
        }
      }
    }

    return found;
  }, ARIA_INJECTION_PATTERNS.map(p => p.source));
}

/**
 * Get clean text with hidden elements stripped (for `text` command).
 * Uses clone + remove approach: clones body, removes marked elements, returns innerText.
 */
export async function getCleanTextWithStripping(page: Page | Frame): Promise<string> {
  return page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true) as HTMLElement;
    // Remove standard noise elements
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    // Remove hidden-marked elements
    clone.querySelectorAll('[data-gstack-hidden]').forEach(el => el.remove());
    return clone.innerText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  });
}

/**
 * Clean up data-gstack-hidden attributes from the page.
 * Should be called after extraction is complete.
 */
export async function cleanupHiddenMarkers(page: Page | Frame): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[data-gstack-hidden]').forEach(el => {
      el.removeAttribute('data-gstack-hidden');
    });
  });
}

// ─── Content Envelope (wrapping) ────────────────────────────────

const ENVELOPE_BEGIN = '═══ BEGIN UNTRUSTED WEB CONTENT ═══';
const ENVELOPE_END = '═══ END UNTRUSTED WEB CONTENT ═══';

/**
 * Defuse envelope sentinels that appear inside attacker-controlled page
 * content. Any raw BEGIN/END marker inside `content` gets a zero-width
 * space spliced through CONTENT so the marker still renders visibly but
 * no longer matches the envelope grep the LLM anchors on.
 *
 * Both the wrap path (full-page content) and the split path (scoped
 * snapshots) must funnel untrusted text through this helper before
 * emitting the outer envelope, otherwise a page whose accessibility
 * tree contains the literal sentinel can close the envelope early and
 * forge a fake "trusted" section in the LLM's view.
 */
export function escapeEnvelopeSentinels(content: string): string {
  const zwsp = '\u200B';
  return content
    .replace(/═══ BEGIN UNTRUSTED WEB CONTENT ═══/g, `═══ BEGIN UNTRUSTED WEB C${zwsp}ONTENT ═══`)
    .replace(/═══ END UNTRUSTED WEB CONTENT ═══/g, `═══ END UNTRUSTED WEB C${zwsp}ONTENT ═══`);
}

/**
 * Wrap page content in a trust boundary envelope for scoped tokens.
 * Escapes envelope markers in content to prevent boundary escape attacks.
 */
export function wrapUntrustedPageContent(
  content: string,
  command: string,
  filterWarnings?: string[],
): string {
  const safeContent = escapeEnvelopeSentinels(content);

  const parts: string[] = [];

  if (filterWarnings && filterWarnings.length > 0) {
    parts.push(`⚠ CONTENT WARNINGS: ${filterWarnings.join('; ')}`);
  }

  parts.push(ENVELOPE_BEGIN);
  parts.push(safeContent);
  parts.push(ENVELOPE_END);

  return parts.join('\n');
}

// ─── Content Filter Hooks (Layer 3) ─────────────────────────────

export interface ContentFilterResult {
  safe: boolean;
  warnings: string[];
  blocked?: boolean;
  message?: string;
}

export type ContentFilter = (
  content: string,
  url: string,
  command: string,
) => ContentFilterResult;

const registeredFilters: ContentFilter[] = [];

export function registerContentFilter(filter: ContentFilter): void {
  registeredFilters.push(filter);
}

export function clearContentFilters(): void {
  registeredFilters.length = 0;
}

/** Get current filter mode from env */
export function getFilterMode(): 'off' | 'warn' | 'block' {
  const mode = process.env.BROWSE_CONTENT_FILTER?.toLowerCase();
  if (mode === 'off' || mode === 'block') return mode;
  return 'warn'; // default
}

/**
 * Run all registered content filters against content.
 * Returns aggregated result with all warnings.
 */
export function runContentFilters(
  content: string,
  url: string,
  command: string,
): ContentFilterResult {
  const mode = getFilterMode();
  if (mode === 'off') {
    return { safe: true, warnings: [] };
  }

  const allWarnings: string[] = [];
  let blocked = false;

  for (const filter of registeredFilters) {
    const result = filter(content, url, command);
    if (!result.safe) {
      allWarnings.push(...result.warnings);
      if (mode === 'block') {
        blocked = true;
      }
    }
  }

  if (blocked && allWarnings.length > 0) {
    return {
      safe: false,
      warnings: allWarnings,
      blocked: true,
      message: `Content blocked: ${allWarnings.join('; ')}`,
    };
  }

  return {
    safe: allWarnings.length === 0,
    warnings: allWarnings,
  };
}

// ─── Built-in URL Blocklist Filter ──────────────────────────────

const BLOCKLIST_DOMAINS = [
  'requestbin.com',
  'pipedream.com',
  'webhook.site',
  'hookbin.com',
  'requestcatcher.com',
  'burpcollaborator.net',
  'interact.sh',
  'canarytokens.com',
  'ngrok.io',
  'ngrok-free.app',
];

/** Check if URL matches any blocklisted exfiltration domain */
export function urlBlocklistFilter(content: string, url: string, _command: string): ContentFilterResult {
  const warnings: string[] = [];

  // Check page URL
  for (const domain of BLOCKLIST_DOMAINS) {
    if (url.includes(domain)) {
      warnings.push(`Page URL matches blocklisted domain: ${domain}`);
    }
  }

  // Check for blocklisted URLs in content (links, form actions)
  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  const contentUrls = content.match(urlPattern) || [];
  for (const contentUrl of contentUrls) {
    for (const domain of BLOCKLIST_DOMAINS) {
      if (contentUrl.includes(domain)) {
        warnings.push(`Content contains blocklisted URL: ${contentUrl.slice(0, 100)}`);
        break;
      }
    }
  }

  return { safe: warnings.length === 0, warnings };
}

// Register the built-in filter on module load
registerContentFilter(urlBlocklistFilter);
