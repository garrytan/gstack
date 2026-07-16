/**
 * Image width policy + conservative auto-landscape (eng-review P4, D4 spec).
 *
 * Two pure passes over rendered HTML:
 *
 *  1. applyImageDirectives — runs inside render() right after marked, before
 *     the sanitizer. Translates the markdown-adjacent directive suffix
 *     `![alt](x.png){width=50%}` / `{page=landscape}` into data-gstack-*
 *     attributes (the sanitizer keeps data- attributes; the brace text is
 *     consumed so it never reaches smartypants or the page).
 *
 *  2. applyImagePolicy — runs in the orchestrator after image inlining (which
 *     annotates data-gstack-px-width/-height from real bytes). Applies the
 *     width rule and decides landscape promotion:
 *
 *     WIDTH RULE: render at intrinsic CSS-px width, capped at the content box,
 *     never upscaled — that is exactly `figure img { max-width: 100% }` doing
 *     its job, so the default needs no inline style. Directives opt into more:
 *     width=full stretches to the content box; <pct>/<dim> set explicit width.
 *
 *     LANDSCAPE (conservative, false negatives are cheap):
 *       promote only when ALL hold —
 *         aspect ratio ≥ 1.8
 *         AND intrinsic CSS-px width > SHRINK_LIMIT × content box
 *             (content shrunk below ~40% of natural size = unreadable)
 *         AND diagram provenance (rendered fence) or an alt-text token from
 *             ALT_HINT_TOKENS (plain images)
 *       `{page=landscape}` forces, `{page=portrait}` vetoes — both skip the
 *       heuristics entirely.
 *
 *     Promotion wraps the block in <div class="page-wide"> whose CSS named
 *     page (`@page wide { size: <size> landscape }`, print-css.ts) rotates
 *     just that page. Chromium only honors CSS page sizes when the print call
 *     passes preferCSSPageSize — the orchestrator sets it when hasLandscape.
 */

import { svgTagDims } from "./image-size";

export interface ImagePolicyOptions {
  /** Physical content-box width in inches (page width minus margins). */
  contentWidthIn: number;
  /**
   * Landscape named-page content box (inches). Used to vertically center a
   * promoted block via a computed inline margin-top — CSS flex/min-height
   * centering fragments into phantom landscape pages in Chromium, so the
   * margin is computed here from the block's known aspect ratio instead.
   */
  landscape: { contentWIn: number; contentHIn: number };
  warn: (msg: string) => void;
}

export interface ImagePolicyResult {
  html: string;
  /** True when at least one block was promoted to the landscape named page. */
  hasLandscape: boolean;
}

/** Aspect ratio floor for auto-promotion. */
const MIN_ASPECT = 1.8;
/**
 * Auto-promote only when the intrinsic CSS-px width exceeds this multiple of
 * the content box (in CSS px @96dpi). 2.5 ≈ the plan's ~1600px threshold on a
 * 6.5in letter box; calibrated against fixtures (design doc Open Question 4).
 */
const SHRINK_LIMIT = 2.5;
/** Alt-text tokens that mark a plain image as diagram-like (case-insensitive). */
const ALT_HINT_TOKENS = ["diagram", "architecture", "flowchart", "chart", "graph"];

// ─── Pass 1: directive suffixes ───────────────────────────────────────

const IMG_WITH_SUFFIX_RE = /(<img\b[^>]*>)\s*\{([^{}<>\n]{1,120})\}/gi;

/**
 * Consume `{...}` directive suffixes adjacent to <img> tags. Unrecognized
 * brace groups are left untouched (someone's literal prose).
 */
export function applyImageDirectives(html: string): string {
  return html.replace(IMG_WITH_SUFFIX_RE, (full, imgTag: string, body: string) => {
    const parsed = parseDirectives(body);
    if (!parsed) return full;
    let tag = imgTag;
    if (parsed.width) tag = addAttr(tag, "data-gstack-width", parsed.width);
    if (parsed.page) tag = addAttr(tag, "data-gstack-page", parsed.page);
    return tag;
  });
}

export function parseDirectives(body: string): { width?: string; page?: string } | null {
  let width: string | undefined;
  let page: string | undefined;
  let recognized = false;
  for (const part of body.trim().split(/\s+/)) {
    const m = part.match(/^(width|page)=(.+)$/i);
    if (!m) return null; // any unknown token ⇒ not a directive group
    const key = m[1].toLowerCase();
    const value = m[2].toLowerCase();
    if (key === "width" && /^(full|\d{1,3}%|[0-9.]+(in|cm|mm|pt|px))$/.test(value)) {
      width = value;
      recognized = true;
    } else if (key === "page" && /^(landscape|portrait)$/.test(value)) {
      page = value;
      recognized = true;
    } else {
      return null; // recognized key, malformed value ⇒ leave visible, not silent
    }
  }
  return recognized ? { width, page } : null;
}

function addAttr(imgTag: string, name: string, value: string): string {
  return imgTag.replace(/^<img\b/i, `<img ${name}="${value}"`);
}

// ─── Pass 2: width styles + landscape promotion ───────────────────────

export function applyImagePolicy(html: string, opts: ImagePolicyOptions): ImagePolicyResult {
  let hasLandscape = false;
  const boxCssPx = opts.contentWidthIn * 96;
  const widthThresholdPx = boxCssPx * SHRINK_LIMIT;

  // 2a. width directives → inline styles on the img.
  let out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const width = attrValue(tag, "data-gstack-width");
    if (!width) return tag;
    const css = width === "full" ? "100%" : width;
    return mergeStyle(tag, `width: ${css}; height: auto;`);
  });

  // 2b. landscape promotion — standalone images (markdown images render as
  // <p><img …></p>; promote by swapping the paragraph for the wide wrapper).
  out = out.replace(/<p>\s*(<img\b[^>]*>)\s*<\/p>/gi, (full, tag: string) => {
    const decision = decideImagePromotion(tag, widthThresholdPx);
    if (!decision.promote) return full;
    hasLandscape = true;
    opts.warn(`promoting image to a landscape page (${decision.reason})`);
    const w = num(attrValue(tag, "data-gstack-px-width"));
    const h = num(attrValue(tag, "data-gstack-px-height"));
    return wrapPageWide(tag, w && h ? h / w : null, opts.landscape);
  });

  // 2c. landscape promotion — rendered diagram figures (provenance is
  // automatic; dims come from the SVG's width/height or viewBox).
  out = out.replace(
    /<figure class="diagram[^"]*"[^>]*>[\s\S]*?<\/figure>/gi,
    (figure) => {
      if (figure.includes("diagram-error")) return figure;
      const decision = decideDiagramPromotion(figure, widthThresholdPx);
      if (!decision.promote) return figure;
      hasLandscape = true;
      opts.warn(`promoting diagram to a landscape page (${decision.reason})`);
      const dims = svgCssDims(figure);
      return wrapPageWide(figure, dims ? dims.height / dims.width : null, opts.landscape);
    },
  );

  return { html: out, hasLandscape };
}

/**
 * Wrap a promoted block in the wide-page div, vertically centered via a
 * computed margin-top: placed height = landscape content width × aspect,
 * centered in the landscape content height. Unknown aspect → no margin
 * (top placement beats a wrong guess).
 */
function wrapPageWide(
  inner: string,
  aspectHoverW: number | null,
  landscape: { contentWIn: number; contentHIn: number },
): string {
  if (!aspectHoverW) return `<div class="page-wide">${inner}</div>`;
  const placedHIn = landscape.contentWIn * aspectHoverW;
  const marginIn = Math.max(0, (landscape.contentHIn - placedHIn) / 2);
  if (marginIn < 0.1) return `<div class="page-wide">${inner}</div>`;
  return `<div class="page-wide" style="margin-top: ${marginIn.toFixed(2)}in">${inner}</div>`;
}

interface PromotionDecision {
  promote: boolean;
  reason: string;
}

function decideImagePromotion(tag: string, widthThresholdPx: number): PromotionDecision {
  const page = attrValue(tag, "data-gstack-page");
  if (page === "portrait") return { promote: false, reason: "page=portrait veto" };
  if (page === "landscape") return { promote: true, reason: "page=landscape directive" };

  const w = num(attrValue(tag, "data-gstack-px-width"));
  const h = num(attrValue(tag, "data-gstack-px-height"));
  if (!w || !h) return { promote: false, reason: "no intrinsic dimensions" };
  if (w / h < MIN_ASPECT) return { promote: false, reason: "aspect below floor" };
  if (w <= widthThresholdPx) return { promote: false, reason: "fits portrait readably" };

  const alt = (attrValue(tag, "alt") ?? "").toLowerCase();
  const hinted = ALT_HINT_TOKENS.some((t) => new RegExp(`\\b${t}\\b`).test(alt));
  if (!hinted) return { promote: false, reason: "no diagram hint in alt text" };

  return { promote: true, reason: `wide diagram-like image (${Math.round(w)}px, alt hint)` };
}

function decideDiagramPromotion(figure: string, widthThresholdPx: number): PromotionDecision {
  const page = attrValue(figure, "data-gstack-page");
  if (page === "portrait") return { promote: false, reason: "page=portrait veto" };
  if (page === "landscape") return { promote: true, reason: "page=landscape fence directive" };

  const dims = svgCssDims(figure);
  if (!dims) return { promote: false, reason: "no measurable SVG dimensions" };
  if (dims.width / dims.height < MIN_ASPECT) return { promote: false, reason: "aspect below floor" };
  if (dims.width <= widthThresholdPx) return { promote: false, reason: "fits portrait readably" };
  return { promote: true, reason: `wide diagram (${Math.round(dims.width)}px)` };
}

/** SVG dimension probing is shared with the byte prober — see image-size.ts. */
const svgCssDims = svgTagDims;

function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))
    ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? m[1] : null;
}

function num(s: string | null): number | null {
  if (s === null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mergeStyle(tag: string, css: string): string {
  const existing = attrValue(tag, "style");
  if (existing !== null) {
    // Function replacement (no $-pattern expansion from user-controlled style
    // values) and the existing declarations are preserved verbatim — attrValue
    // already returned the unquoted inner value.
    return tag.replace(/\bstyle\s*=\s*(".*?"|'.*?')/i, () => `style="${existing}; ${css}"`);
  }
  return tag.replace(/^<img\b/i, () => `<img style="${css}"`);
}
