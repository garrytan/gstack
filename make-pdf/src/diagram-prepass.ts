/**
 * Diagram + image pre-pass. Runs between "read markdown" and render() in the
 * orchestrator, and owns everything that needs the diagram-render bundle.
 *
 *   markdown ─▶ extractDiagramFences() ──▶ render() (marked+sanitize+smarty)
 *        │        fences → placeholder tokens        │
 *        │                                           ▼
 *        └─▶ renderFenceSlots() ───────────▶ substituteSlots(html, slots)
 *             one browser render per batch           │
 *             error ⇒ diagnostic block               ▼
 *                                          inlineLocalImages(html)
 *                                            data URIs, probe dims from bytes,
 *                                            downscale >2x content box @300dpi,
 *                                            remote warn / missing placeholder /
 *                                            --strict hard-fail
 *
 * Placeholders survive marked, the sanitizer, and smartypants because they are
 * plain hyphenated lowercase tokens with no quotes or HTML. Slot HTML is run
 * through the same sanitizer as user content before substitution (the bundle
 * renders with securityLevel strict — the sanitizer is the second layer).
 *
 * Bundle calls are batched: one render per batch (Aside runs one script per `aside repl` process) and
 * nothing survives it, so every consumer collects its calls, runs them in one
 * script (`BundleRun`), and substitutes the results. A failed call is data
 * (diagnostic block / warning), never an abort. Each PDF run gets a fresh
 * bundle page and each fence a fresh mermaid.render id (eng-review D6.2).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { render as renderHtml, renderTmpDir } from "../../lib/aside-render";
import { escapeHtml, sanitizeUntrustedHtml } from "./render";
import { imageDims } from "./image-size";

// ─── Types ────────────────────────────────────────────────────────────

export interface DiagramFence {
  /** "mermaid" | "excalidraw" */
  lang: string;
  /** Fence body (the diagram source). */
  source: string;
  /** Optional title="..." from the fence info string (a11y label, D6.4). */
  title?: string;
  /** Optional page=landscape|portrait fence directive (image-policy override). */
  page?: "landscape" | "portrait";
  /** render=false → leave as a plain code block (escape hatch, D6.3). */
  render: boolean;
  /** Placeholder token substituted into the markdown. */
  token: string;
  /** 1-based ordinal among rendered fences (unique ids, aria fallback). */
  ordinal: number;
}

export interface FenceExtraction {
  markdown: string;
  fences: DiagramFence[];
}

export interface PrepassWarnings {
  warn: (msg: string) => void;
}

export interface PrepassImageOptions {
  /** Directory of the source markdown — relative image paths resolve here. */
  inputDir: string;
  /** Hard-fail on missing/remote images instead of warn (D6.1). */
  strict: boolean;
  /** Remote images are left untouched when network is explicitly allowed. */
  allowNetwork: boolean;
  /** Physical content-box width in inches (page width minus margins). */
  contentWidthIn: number;
  warn: (msg: string) => void;
  /** Bundle runner for print-resolution downscaling; null = inline at full size. */
  run: BundleRun | null;
}

/** Print-resolution policy (eng-review D4): downscale rasters wider than
 * 2 × contentWidth × 300dpi down to contentWidth × 300dpi. */
const PRINT_DPI = 300;
const DOWNSCALE_FACTOR = 2;
/** Per-image read ceiling — bounds memory before any policy runs. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export class StrictModeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StrictModeError";
  }
}

// ─── Fence extraction (pure) ──────────────────────────────────────────

const DIAGRAM_LANGS = new Set(["mermaid", "excalidraw"]);

/**
 * Extract column-0 ```mermaid / ```excalidraw fences, replacing each with a
 * unique placeholder token paragraph. Backtick and tilde fences, any length
 * >= 3; closers must be at least as long as the opener (CommonMark). Fences
 * with `render=false` are left untouched.
 *
 * Two deliberate conservatisms (red-team finding — the original version
 * reconstructed fences at column 0 and restructured lists):
 *  - Non-diagram fences replay as their ORIGINAL raw lines, byte-for-byte
 *    (only a render=false flag is removed, in place, preserving indent).
 *  - INDENTED diagram fences (inside lists/quotes) are NOT extracted — a
 *    column-0 placeholder would split the list. They replay verbatim as code.
 */
export function extractDiagramFences(markdown: string): FenceExtraction {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const fences: DiagramFence[] = [];
  const runId = crypto.randomBytes(4).toString("hex");

  let i = 0;
  let openFence: {
    char: string; len: number; indent: number; info: string;
    rawOpener: string; body: string[];
  } | null = null;
  let ordinal = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (openFence) {
      const close = matchFenceLine(line);
      if (close && close.char === openFence.char && close.len >= openFence.len && close.info === "") {
        const info = parseInfoString(openFence.info);
        if (DIAGRAM_LANGS.has(info.lang) && info.render && openFence.indent === 0) {
          ordinal++;
          const token = `gstack-diagram-slot-${runId}-${ordinal}`;
          fences.push({
            lang: info.lang,
            source: openFence.body.join("\n"),
            title: info.title,
            page: info.page,
            render: true,
            token,
            ordinal,
          });
          out.push("", token, "");
        } else {
          // Not extracted (other language, render=false, or indented): replay
          // the ORIGINAL lines verbatim; only strip a render=false flag.
          out.push(stripRenderFalse(openFence.rawOpener));
          out.push(...openFence.body);
          out.push(line);
        }
        openFence = null;
        i++;
        continue;
      }
      openFence.body.push(line);
      i++;
      continue;
    }

    const open = matchFenceLine(line);
    if (open && open.info !== "") {
      openFence = { ...open, rawOpener: line, body: [] };
      i++;
      continue;
    }
    if (open) {
      // Anonymous fence (plain code block) — copy through to its closer so a
      // ```mermaid example INSIDE a plain fence is never extracted.
      out.push(line);
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = matchFenceLine(l);
        out.push(l);
        i++;
        if (close && close.char === open.char && close.len >= open.len && close.info === "") break;
      }
      continue;
    }

    out.push(line);
    i++;
  }

  // Unclosed fence at EOF: replay verbatim (CommonMark treats it as code to EOF).
  if (openFence) {
    out.push(openFence.rawOpener);
    out.push(...openFence.body);
  }

  return { markdown: out.join("\n"), fences };
}

function matchFenceLine(line: string): { char: string; len: number; indent: number; info: string } | null {
  const m = line.match(/^( {0,3})(`{3,}|~{3,})\s*(.*)$/);
  if (!m) return null;
  return { indent: m[1].length, char: m[2][0], len: m[2].length, info: m[3].trim() };
}

/** Remove a render=false flag from a raw opener line, preserving everything else. */
function stripRenderFalse(rawOpener: string): string {
  return rawOpener.replace(/\s*\brender\s*=\s*false\b/i, "");
}

/** Parse a fence info string: `mermaid`, `mermaid render=false`,
 *  `mermaid title="Auth flow"`, `mermaid page=landscape`. */
export function parseInfoString(info: string): {
  lang: string; render: boolean; title?: string; page?: "landscape" | "portrait";
} {
  const lang = (info.match(/^\S+/)?.[0] ?? "").toLowerCase();
  const render = !/\brender\s*=\s*false\b/i.test(info);
  const title = info.match(/\btitle\s*=\s*"([^"]*)"/i)?.[1]
    ?? info.match(/\btitle\s*=\s*'([^']*)'/i)?.[1];
  const pageRaw = info.match(/\bpage\s*=\s*(landscape|portrait)\b/i)?.[1]?.toLowerCase();
  const page = pageRaw === "landscape" || pageRaw === "portrait" ? pageRaw : undefined;
  return { lang, render, title, page };
}

// ─── Slot substitution (pure) ─────────────────────────────────────────

/**
 * Replace placeholder tokens in rendered HTML with their final slot HTML.
 * marked wraps the bare token line in <p>…</p>; replace the wrapper too so
 * the figure isn't nested inside a paragraph.
 */
export function substituteSlots(html: string, slots: Map<string, string>): string {
  let s = html;
  for (const [token, slotHtml] of slots) {
    // Function replacement is load-bearing: slot HTML carries user/LLM-authored
    // diagram label text, and string-form replace() expands $&, $', $` patterns
    // inside it — a label containing "$'" would duplicate the document tail.
    const wrapped = new RegExp(`<p>\\s*${token}\\s*</p>`, "g");
    const replaced = s.replace(wrapped, () => slotHtml);
    s = replaced !== s ? replaced : s.split(token).join(slotHtml);
  }
  return s;
}

/**
 * Visible diagnostic block for a failed fence render — never silent raw code
 * (eng-review: explicit error blocks). Sanitizer-safe: all dynamic content is
 * HTML-escaped.
 */
export function buildDiagnosticBlock(fence: DiagramFence, errorMessage: string): string {
  const excerpt = fence.source.split("\n").slice(0, 8).join("\n");
  const truncated = fence.source.split("\n").length > 8 ? "\n…" : "";
  return [
    `<figure class="diagram diagram-error" role="img" aria-label="${escapeHtml(diagramLabel(fence))} (failed to render)">`,
    `<figcaption class="diagram-error-title">Diagram failed to render (${escapeHtml(fence.lang)})</figcaption>`,
    `<pre class="diagram-error-detail">${escapeHtml(errorMessage.trim())}\n\n${escapeHtml(excerpt + truncated)}</pre>`,
    `</figure>`,
  ].join("\n");
}

/**
 * Wrap a rendered SVG in an accessible figure (D6.4). The raw fence source is
 * preserved base64-encoded in a data attribute — an HTML comment would need
 * `--` escaping, which corrupts every mermaid arrow (`-->`) and breaks
 * round-trip recovery.
 */
export function buildDiagramFigure(fence: DiagramFence, svg: string): string {
  const label = diagramLabel(fence);
  const cleanSvg = sanitizeUntrustedHtml(svg);
  const captioned = fence.title
    ? `\n<figcaption class="diagram-caption">${escapeHtml(fence.title)}</figcaption>`
    : "";
  const pageAttr = fence.page ? ` data-gstack-page="${fence.page}"` : "";
  const sourceB64 = Buffer.from(fence.source, "utf8").toString("base64");
  return [
    `<figure class="diagram" role="img" aria-label="${escapeHtml(label)}"${pageAttr}` +
      ` data-gstack-lang="${escapeHtml(fence.lang)}" data-gstack-source="${sourceB64}">`,
    cleanSvg,
    captioned,
    `</figure>`,
  ].join("\n");
}

/** Recover the original fence source from a rendered figure (round-trip). */
export function decodeFigureSource(figureHtml: string): string | null {
  const m = figureHtml.match(/\bdata-gstack-source="([A-Za-z0-9+/=]*)"/);
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
}

function diagramLabel(fence: DiagramFence): string {
  return fence.title ?? `diagram ${fence.ordinal}`;
}

// ─── Bundle runner (diagram-render page, driven through Aside or gstack's browser) ────────

export type BundleCall = { fn: string; args: unknown[] };
export type BundleResult =
  | { ok: true; value: string }
  | { ok: false; error: string };
/** Run bundle calls in order. Every call gets a result; failures are data. */
export type BundleRun = (calls: BundleCall[]) => Promise<BundleResult[]>;

const READY_TIMEOUT_MS = 20_000;
/** Aside caps a script at 120s (the browse path shares the budget); ~40 mermaid renders fit with room to spare. */
const CALLS_PER_SCRIPT = 40;

/**
 * Build the runner. The bundle path resolves lazily on the first call so an
 * image-only document never touches it; a missing bundle fails every call
 * with the resolver's message instead of throwing.
 */
export function bundleRunner(opts: { bundlePath?: string; render?: typeof renderHtml } = {}): BundleRun {
  const render = opts.render ?? renderHtml;
  let bundlePath = opts.bundlePath;
  return async (calls) => {
    const results: BundleResult[] = [];
    try {
      if (calls.length > 0) bundlePath ??= resolveBundlePath();
      for (let i = 0; i < calls.length; i += CALLS_PER_SCRIPT) {
        results.push(...await runScript(bundlePath!, calls.slice(i, i + CALLS_PER_SCRIPT), render));
      }
    } catch (err: any) {
      // Unresolvable/unreadable bundle, staging failure: fail what's left as data.
      const error = firstLine(err?.message ?? String(err));
      while (results.length < calls.length) results.push({ ok: false, error });
    }
    return results;
  };
}

/**
 * One render (an Aside script, or a browse tab): open the bundle, wait for #done, evaluate one expression
 * per call, write each result to a file and read them back. The bundle copy
 * and one JSON args file per call sit in a private dir served over loopback,
 * so multi-MB payloads (data URIs, scene JSON) never ride argv; results are
 * files too (never inline stdout) so SVG/PNG text survives intact.
 */
async function runScript(
  bundlePath: string,
  calls: BundleCall[],
  render: typeof renderHtml,
): Promise<BundleResult[]> {
  const dir = fs.mkdtempSync(path.join(renderTmpDir(), "make-pdf-diagrams-"));
  try {
    const bundle = path.join(dir, "diagram-render.html");
    fs.copyFileSync(bundlePath, bundle, fs.constants.COPYFILE_FICLONE);
    const steps = calls.map((call, i) => {
      fs.writeFileSync(path.join(dir, `call-${i}.json`), JSON.stringify(call.args));
      // try/catch INSIDE the expression: a throwing fence returns an ERR
      // marker and the script keeps going for the other fences. The URL is
      // resolved against location.href, not the document base: the bundle
      // sets <base href="https://gstack-render.localhost/"> for excalidraw.
      const expression =
        `(async () => { try { const a = await (await fetch(new URL("call-${i}.json", location.href).href)).json(); ` +
        `return "OK:" + await window[${JSON.stringify(call.fn)}](...a); } ` +
        `catch (e) { return "ERR:" + String((e && e.message) || e); } })()`;
      return { kind: "eval" as const, expression, out: path.join(dir, `result-${i}.txt`) };
    });
    const r = await render({
      file: bundle,
      serveRoot: dir,
      waitFor: { selector: "#done", timeoutMs: READY_TIMEOUT_MS },
      steps,
    });
    if (!r.ok) {
      const error = `diagram renderer: ${firstLine(r.error ?? "unknown error")}`;
      return calls.map(() => ({ ok: false, error }));
    }
    return calls.map((_, i) => {
      const text = fs.readFileSync(path.join(dir, `result-${i}.txt`), "utf8");
      if (text.startsWith("OK:")) return { ok: true, value: text.slice(3) };
      if (text.startsWith("ERR:")) return { ok: false, error: text.slice(4) };
      return { ok: false, error: `unexpected bundle result: ${text.slice(0, 200)}` };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve dist/diagram-render.html: env override → repo-relative (dev) → global install. */
export function resolveBundlePath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.GSTACK_DIAGRAM_BUNDLE,
    // dev: make-pdf/src/* → repo root lib/. (In a compiled binary this is the
    // virtual /$bunfs/root and simply never exists — harmless.)
    path.resolve(import.meta.dir, "../../lib/diagram-render/dist/diagram-render.html"),
    // compiled binary at <root>/make-pdf/dist/pdf → <root>/lib/… — same shape
    // in the repo and in the ~/.claude/skills/gstack global install. argv[0]
    // is the literal string "bun" in compiled binaries; execPath is real.
    path.resolve(path.dirname(process.execPath), "../../lib/diagram-render/dist/diagram-render.html"),
    path.join(os.homedir(), ".claude/skills/gstack/lib/diagram-render/dist/diagram-render.html"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "diagram-render bundle not found. Tried:\n" +
    candidates.map((c) => `  - ${c}`).join("\n") +
    "\nRun `bun run build:diagram-render` (repo) or re-run ./setup (install).",
  );
}

// ─── Fence rendering ──────────────────────────────────────────────────

/**
 * Render every extracted fence to its slot HTML in one batch. A failed fence
 * yields a visible diagnostic block; the others still render.
 */
export async function renderFenceSlots(
  fences: DiagramFence[],
  run: BundleRun,
  warn: (msg: string) => void,
): Promise<Map<string, string>> {
  const slots = new Map<string, string>();
  const fail = (fence: DiagramFence, msg: string) => {
    warn(`diagram ${fence.ordinal} (${fence.lang}) failed to render: ${firstLine(msg)}`);
    slots.set(fence.token, buildDiagnosticBlock(fence, msg));
  };
  const todo: DiagramFence[] = [];
  for (const fence of fences) {
    if (fence.lang !== "mermaid") {
      try {
        JSON.parse(fence.source); // fail fast with a JSON diagnostic, not a bundle stack
      } catch (err: any) {
        fail(fence, err?.message ?? String(err));
        continue;
      }
    }
    todo.push(fence);
  }
  const results = await run(todo.map((f) => f.lang === "mermaid"
    ? { fn: "__renderMermaid", args: [`mermaid-fence-${f.ordinal}`, f.source] }
    : { fn: "__excalidrawToSvg", args: [f.source] }));
  todo.forEach((fence, i) => {
    const r = results[i];
    if (r.ok) slots.set(fence.token, buildDiagramFigure(fence, r.value));
    else fail(fence, r.error);
  });
  return slots;
}

// ─── DOCX rasterization (eng-review D6.5, P8) ─────────────────────────

/**
 * Replace inline diagram SVGs (and svg data-URI images) with PNG <img> tags
 * for the DOCX export — Word's SVG support is unreliable, so the content-
 * fidelity contract embeds rasters at 300dpi of the placed width (the
 * content box). Diagnostic blocks keep their text form. Two passes: swap
 * each target for a token while collecting its bundle call, run the batch,
 * substitute results.
 */
export async function rasterizeDiagramFigures(
  html: string,
  run: BundleRun,
  contentWidthIn: number,
  warn: (msg: string) => void,
): Promise<string> {
  const targetPx = Math.round(contentWidthIn * PRINT_DPI);
  const runId = crypto.randomBytes(4).toString("hex");
  const calls: BundleCall[] = [];
  const pending: Array<{ token: string; onOk: (png: string) => string; onErr: (reason: string) => string }> = [];
  const enqueue = (svgText: string, onOk: (png: string) => string, onErr: (reason: string) => string): string => {
    const token = `gstack-raster-slot-${runId}-${calls.length}`;
    calls.push({ fn: "__rasterize", args: [svgText, targetPx] });
    pending.push({ token, onOk, onErr });
    return token;
  };

  // 1. Rendered diagram figures → <img> with the figure's aria-label as alt.
  let out = html.replace(
    /<figure class="diagram"[^>]*>[\s\S]*?<\/figure>/gi,
    (figure) => {
      const svgMatch = figure.match(/<svg\b[\s\S]*<\/svg>/i);
      if (!svgMatch) return figure;
      const label = figure.match(/\baria-label\s*=\s*"([^"]*)"/i)?.[1] ?? "diagram";
      return enqueue(
        svgMatch[0],
        (png) => `<p><img src="${png}" alt="${label}"></p>`,
        (reason) => {
          warn(`docx: diagram rasterization failed (${reason}); embedding source text instead`);
          // The converter drops <figure>/<svg> entirely, so returning the figure
          // would make the diagram vanish without a trace — the exact invisible
          // failure the diagnostic contract forbids. Surface the source.
          const source = decodeFigureSource(figure) ?? "(source unavailable)";
          return [
            `<p><strong>Diagram could not be rasterized for DOCX (${escapeHtml(reason)}) — source:</strong></p>`,
            `<pre>${escapeHtml(source)}</pre>`,
          ].join("\n");
        },
      );
    },
  );

  // 2. SVG data-URI images (inlined .svg files) → PNG.
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(SRC_RE);
    const src = m?.[2] ?? m?.[3] ?? "";
    if (!src.startsWith("data:image/svg+xml")) return tag;
    const svgText = Buffer.from(src.slice(src.indexOf(",") + 1), "base64").toString("utf8");
    return enqueue(
      svgText,
      // Function replacement: data URIs can contain $-patterns.
      (png) => tag.replace(SRC_RE, () => `src="${png}"`),
      (reason) => {
        warn(`docx: svg image rasterization failed (${reason})`);
        return tag;
      },
    );
  });

  if (calls.length === 0) return out;
  const results = await run(calls);
  pending.forEach((p, i) => {
    const r = results[i];
    // split/join, not replace(): the replacement carries user content.
    out = out.split(p.token).join(r.ok ? p.onOk(r.value) : p.onErr(firstLine(r.error)));
  });
  return out;
}

/**
 * Diagnostic figures → plain <p>/<pre> for the DOCX converter, which drops
 * <figure> elements it can't map. An invisible error is the one thing the
 * diagnostic contract forbids. Pure — no render tab needed.
 */
export function convertDiagnosticsForDocx(html: string): string {
  return html.replace(
    /<figure class="diagram diagram-error"[^>]*>([\s\S]*?)<\/figure>/gi,
    (_full, body: string) => {
      const title = body.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] ?? "Diagram failed to render";
      const detail = body.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1] ?? "";
      return `<p><strong>${title}</strong></p>\n<pre>${detail}</pre>`;
    },
  );
}

// ─── Image inlining (eng-review D1 + D4 + D6.1) ───────────────────────

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_RE = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i;

/**
 * Inline every local <img> as a data URI, probe intrinsic dimensions from the
 * bytes, and annotate the tag with data-gstack-px-width/-height for the width
 * policy. Oversized rasters are downscaled to print resolution via the bundle
 * tab. Missing files become visible placeholders (or throw under --strict);
 * remote URLs warn (offline posture) unless --allow-network.
 */
export async function inlineLocalImages(html: string, opts: PrepassImageOptions): Promise<string> {
  const maxPx = Math.round(opts.contentWidthIn * PRINT_DPI * DOWNSCALE_FACTOR);
  const targetPx = Math.round(opts.contentWidthIn * PRINT_DPI);
  // An image referenced N times is read/probed/downscaled once; the same data
  // URI string is reused (also dedupes memory until the final join).
  const memo = new Map<string, { dataUri: string; attrs: string }>();
  // Oversized rasters get a token src in this pass and their downscaled bytes
  // in the second — one bundle batch for the whole document.
  const runId = crypto.randomBytes(4).toString("hex");
  const downscales: Array<{
    token: string; src: string; name: string; buf: Buffer; mime: string;
    dims: { width: number; height: number };
  }> = [];

  const out = html.replace(IMG_TAG_RE, (tag) => {
    const srcMatch = tag.match(SRC_RE);
    if (!srcMatch) return tag;
    const src = srcMatch[2] ?? srcMatch[3] ?? "";

    if (src.startsWith("data:")) return annotateFromDataUri(tag, src);

    // Windows drive-letter paths (C:/x.png, C:\x.png) look like single-letter
    // URL schemes — they are local paths, not URLs.
    const isDrivePath = /^[a-zA-Z]:[\\/]/.test(src);

    if (!isDrivePath && /^[a-z][a-z0-9+.-]*:/i.test(src)) {
      // Absolute URL with a scheme (http, https, file, …)
      if (opts.allowNetwork && /^https?:/i.test(src)) return tag;
      if (/^https?:/i.test(src)) {
        const msg = `remote image blocked (offline posture): ${src}`;
        if (opts.strict) throw new StrictModeError(msg + " — re-run without --strict or pass --allow-network");
        opts.warn(msg);
        // Leaving the tag would make Chromium fetch it at print time anyway —
        // the warn would be a lie. Replace with a visible placeholder.
        return buildBlockedRemotePlaceholder(src);
      }
      // file:// and friends fall through to the local path branch
      if (!src.startsWith("file:")) return tag;
    }

    // decodeURIComponent throws on malformed escapes (foo%zz.png) — a broken
    // URL must degrade to the missing-image path, not crash the run.
    let decodedSrc = src;
    try {
      decodedSrc = decodeURIComponent(src);
    } catch { /* keep raw src */ }

    const filePath = src.startsWith("file:")
      ? fileURLToPath(src)
      : isDrivePath
        ? path.resolve(src)
        : path.resolve(opts.inputDir, decodedSrc);

    const cached = memo.get(filePath);
    if (cached !== undefined) return rewriteImgTag(tag, cached);

    if (!fs.existsSync(filePath)) {
      const msg = `image not found: ${src} (resolved to ${filePath})`;
      if (opts.strict) throw new StrictModeError(msg);
      opts.warn(msg);
      return buildMissingImagePlaceholder(src);
    }

    // Out-of-tree reads are legal (local CLI semantics — like pandoc) but
    // never silent: an agent PDF-ing untrusted markdown should not quietly
    // embed ~/.ssh/config into a shareable document. --strict makes it fatal.
    // Compare REAL paths — a symlink inside the input dir pointing outside
    // would otherwise pass a string-prefix check (Codex adversarial finding).
    // Runs after the existence check: realpath of a missing file can't
    // resolve, and on macOS /var vs /private/var would false-positive.
    const inputRoot = safeRealpath(path.resolve(opts.inputDir)) + path.sep;
    const realFilePath = safeRealpath(filePath);
    if (!realFilePath.startsWith(inputRoot)) {
      const msg = `image resolves OUTSIDE the input directory: ${src} → ${realFilePath}`;
      if (opts.strict) throw new StrictModeError(msg + " — move it under the markdown's directory or drop --strict");
      opts.warn(msg);
    }

    // Bound the read BEFORE reading: a markdown image pointing at a special
    // file (fifo, device) would hang readFileSync, and a multi-GB file would
    // exhaust memory before any policy ran.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      opts.warn(`image unreadable: ${src}`);
      return buildMissingImagePlaceholder(src);
    }
    if (!stat.isFile()) {
      const msg = `image is not a regular file: ${src}`;
      if (opts.strict) throw new StrictModeError(msg);
      opts.warn(msg);
      return buildMissingImagePlaceholder(src);
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      const msg = `image exceeds ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB cap: ${src} (${Math.round(stat.size / 1024 / 1024)}MB)`;
      if (opts.strict) throw new StrictModeError(msg);
      opts.warn(msg);
      return buildMissingImagePlaceholder(src);
    }

    const buf = fs.readFileSync(filePath);
    const dims = imageDims(buf);
    const mime = dims?.mime ?? mimeFromExtension(filePath);

    // Print-resolution normalization (D4): rasters only — SVG scales free.
    if (dims && mime !== "image/svg+xml" && dims.width > maxPx && opts.run) {
      const token = `gstack-downscale-slot-${runId}-${downscales.length}`;
      downscales.push({ token, src, name: path.basename(filePath), buf, mime, dims });
      memo.set(filePath, { dataUri: token, attrs: "" });
      return rewriteImgTag(tag, memo.get(filePath)!);
    }

    memo.set(filePath, inlineEntry(buf, mime, dims));
    return rewriteImgTag(tag, memo.get(filePath)!);
  });

  if (downscales.length === 0) return out;
  const results = await opts.run!(downscales.map((d) => ({
    fn: "__downscaleRaster",
    args: [`data:${d.mime};base64,${d.buf.toString("base64")}`, targetPx, d.mime],
  })));
  const byToken = new Map<string, { dataUri: string; attrs: string }>();
  downscales.forEach((d, i) => {
    const r = results[i];
    if (r.ok) {
      opts.warn(
        `downscaled ${d.name} ${d.dims.width}px → ${targetPx}px ` +
        `(print is ${PRINT_DPI}dpi; original exceeds ${maxPx}px content-box ceiling)`,
      );
      const height = Math.round((d.dims.height * targetPx) / d.dims.width);
      byToken.set(d.token, { dataUri: r.value, attrs: dimAttrs({ width: targetPx, height }) });
    } else {
      opts.warn(`downscale failed for ${d.src}, inlining at full size: ${firstLine(r.error)}`);
      byToken.set(d.token, inlineEntry(d.buf, d.mime, d.dims));
    }
  });
  return out.replace(IMG_TAG_RE, (tag) => {
    const entry = byToken.get(tag.match(SRC_RE)?.[2] ?? "");
    return entry ? rewriteImgTag(tag, entry) : tag;
  });
}

function inlineEntry(buf: Buffer, mime: string, dims: { width: number; height: number } | null): { dataUri: string; attrs: string } {
  return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, attrs: dims ? dimAttrs(dims) : "" };
}

function dimAttrs(dims: { width: number; height: number }): string {
  return ` data-gstack-px-width="${Math.round(dims.width)}" data-gstack-px-height="${Math.round(dims.height)}"`;
}

/** Apply a memoized inline result to an img tag. */
function rewriteImgTag(tag: string, entry: { dataUri: string; attrs: string }): string {
  // Function replacement: data URIs are user-content-derived; string-form
  // replace() would expand $-patterns inside them.
  let out = tag.replace(SRC_RE, () => `src="${entry.dataUri}"`);
  if (entry.attrs) out = out.replace(/^<img\b/i, () => `<img${entry.attrs}`);
  return out;
}

function annotateFromDataUri(tag: string, src: string): string {
  try {
    const b64 = src.slice(src.indexOf(",") + 1);
    const head = Buffer.from(b64.slice(0, 8192), "base64");
    const dims = imageDims(head);
    if (!dims) return tag;
    return tag.replace(
      /^<img\b/i,
      `<img data-gstack-px-width="${Math.round(dims.width)}" data-gstack-px-height="${Math.round(dims.height)}"`,
    );
  } catch {
    return tag;
  }
}

function buildMissingImagePlaceholder(src: string): string {
  return (
    `<span class="image-missing" role="img" aria-label="missing image">` +
    `[missing image: ${escapeHtml(src)}]</span>`
  );
}

function buildBlockedRemotePlaceholder(src: string): string {
  return (
    `<span class="image-missing" role="img" aria-label="remote image blocked">` +
    `[remote image blocked (use --allow-network): ${escapeHtml(src)}]</span>`
  );
}

/** realpath that degrades to the input path when resolution fails. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function mimeFromExtension(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

// ─── Content-box math ─────────────────────────────────────────────────

const PAGE_WIDTHS_IN: Record<string, number> = {
  letter: 8.5,
  a4: 8.27,
  legal: 8.5,
  tabloid: 11,
};

/** Parse a CSS dimension ("1in" | "72pt" | "25mm" | "2.54cm") to inches. */
export function dimToInches(dim: string | undefined, fallbackIn: number): number {
  if (!dim) return fallbackIn;
  const m = dim.trim().match(/^([0-9.]+)\s*(in|pt|cm|mm|px)?$/i);
  if (!m) return fallbackIn;
  const v = parseFloat(m[1]);
  switch ((m[2] ?? "in").toLowerCase()) {
    case "in": return v;
    case "pt": return v / 72;
    case "cm": return v / 2.54;
    case "mm": return v / 25.4;
    case "px": return v / 96;
    default: return fallbackIn;
  }
}

export function contentWidthInches(opts: {
  pageSize?: string;
  margins?: string;
  marginLeft?: string;
  marginRight?: string;
}): number {
  const pageW = PAGE_WIDTHS_IN[opts.pageSize ?? "letter"] ?? 8.5;
  const left = dimToInches(opts.marginLeft ?? opts.margins, 1);
  const right = dimToInches(opts.marginRight ?? opts.margins, 1);
  return Math.max(1, pageW - left - right);
}

const PAGE_HEIGHTS_IN: Record<string, number> = {
  letter: 11,
  a4: 11.69,
  legal: 14,
  tabloid: 17,
};

/**
 * Content box of the rotated (landscape) named page: portrait page HEIGHT
 * becomes the landscape width; portrait WIDTH becomes the landscape height.
 * Used by image-policy to vertically center promoted blocks.
 */
export function landscapeContentBox(opts: {
  pageSize?: string;
  margins?: string;
  marginLeft?: string;
  marginRight?: string;
  marginTop?: string;
  marginBottom?: string;
}): { contentWIn: number; contentHIn: number } {
  const size = opts.pageSize ?? "letter";
  const pageH = PAGE_HEIGHTS_IN[size] ?? 11;
  const pageW = PAGE_WIDTHS_IN[size] ?? 8.5;
  const left = dimToInches(opts.marginLeft ?? opts.margins, 1);
  const right = dimToInches(opts.marginRight ?? opts.margins, 1);
  const top = dimToInches(opts.marginTop ?? opts.margins, 1);
  const bottom = dimToInches(opts.marginBottom ?? opts.margins, 1);
  return {
    contentWIn: Math.max(1, pageH - left - right),
    contentHIn: Math.max(1, pageW - top - bottom),
  };
}

// ─── tiny helpers ─────────────────────────────────────────────────────
// escapeHtml is imported from ./render — single definition, no drift.

function firstLine(s: string): string {
  return s.split("\n")[0].slice(0, 200);
}
