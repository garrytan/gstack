/**
 * diagram-render bundle entry.
 *
 * Built into a single self-contained HTML page (dist/diagram-render.html) that
 * make-pdf and /diagram load into a browse daemon tab via `load-html`. Every
 * capability is exposed as a window.__* function and driven through `browse js`;
 * binary results return as data URLs that `js --out` decodes to bytes on disk.
 *
 *   page lifecycle (one tab per make-pdf run, reused across fences):
 *     load-html dist copy ─▶ poll #status == "ready" ─▶ N × __renderMermaid/
 *     __excalidrawToSvg/__rasterize ─▶ close tab (orchestrator finally)
 *     render error ─▶ caller reloads the page before the next fence
 *     (reset contract: no poisoned mermaid global survives, eng-review D6.2)
 *
 * Render contract (eng-review D3):
 *  - securityLevel "strict": no click callbacks, no HTML label injection in
 *    this tab. The make-pdf sanitizer is the second defense layer downstream.
 *  - Callers pass a unique id per fence (mermaid-fence-<n>); mermaid bakes it
 *    into every internal SVG id, so two diagrams inlined into one document
 *    can't collide on gradients/markers.
 *  - Font stacks mirror make-pdf/src/print-css.ts so text measured here lays
 *    out identically in the printed document.
 *  - htmlLabels false: foreignObject labels taint canvases (blocks toDataURL
 *    rasterization) and break when the SVG is inlined into another document.
 */
import mermaid from "mermaid";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw";

declare global {
  interface Window {
    __bundleInfo: { name: string; deps: Record<string, string> };
    __renderMermaid: (id: string, text: string) => Promise<string>;
    __mermaidToExcalidraw: (text: string) => Promise<string>;
    __excalidrawToSvg: (sceneJson: string) => Promise<string>;
    __rasterize: (svgText: string, targetWidthPx: number) => Promise<string>;
    __downscaleRaster: (dataUri: string, targetWidthPx: number, mime: string) => Promise<string>;
    __mountForScreenshot: (svgText: string, targetWidthPx: number) => string;
    __probeImage: (src: string) => Promise<string>;
    EXCALIDRAW_ASSET_PATH?: string;
    __errors: string[];
  }
}

// Excalidraw's font registry builds URLs from this against the document base.
// The host must be absolute and never resolves — the page is offline by design;
// exportToSvg embeds the bundled Excalifont glyphs without fetching.
window.EXCALIDRAW_ASSET_PATH = "https://gstack-render.localhost/excalidraw-assets/";

// Font stacks must match make-pdf/src/print-css.ts (sans + CJK + emoji) so
// mermaid's text measurement in this tab matches the print document's layout.
const PRINT_SANS =
  'Helvetica, "Liberation Sans", Arial, "Hiragino Kaku Gothic ProN", ' +
  '"Noto Sans CJK JP", "Microsoft YaHei", "Apple Color Emoji", ' +
  '"Segoe UI Emoji", "Noto Color Emoji", sans-serif';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  fontFamily: PRINT_SANS,
  htmlLabels: false,
  flowchart: { htmlLabels: false },
});

window.__renderMermaid = async (id: string, text: string): Promise<string> => {
  if (!/^[A-Za-z][\w-]*$/.test(id)) throw new Error(`invalid mermaid render id: ${id}`);
  const { svg } = await mermaid.render(id, text);
  return svg;
};

window.__mermaidToExcalidraw = async (text: string): Promise<string> => {
  const { elements, files } = await parseMermaidToExcalidraw(text);
  const converted = convertToExcalidrawElements(elements);
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "gstack-diagram-render",
    elements: converted,
    appState: { viewBackgroundColor: "#ffffff" },
    files: files ?? {},
  };
  return JSON.stringify(scene);
};

window.__excalidrawToSvg = async (sceneJson: string): Promise<string> => {
  const scene = JSON.parse(sceneJson);
  if (!Array.isArray(scene.elements)) throw new Error("excalidraw scene has no elements array");
  const svg = await exportToSvg({
    elements: scene.elements,
    appState: { ...(scene.appState ?? {}), exportBackground: true },
    files: scene.files ?? null,
    exportPadding: 16,
  });
  return new XMLSerializer().serializeToString(svg);
};

/**
 * SVG → PNG data URL at an explicit pixel width. Callers own the DPI math:
 * targetWidthPx = placed physical width (in) × 300dpi (eng-review D6.5) —
 * the bundle never guesses a viewport.
 */
/** Shared ceiling for rasterization targets (both window functions). */
const MAX_TARGET_PX = 10_000;
function assertTargetWidth(px: number): void {
  if (!(px > 0 && px <= MAX_TARGET_PX)) {
    throw new Error(`targetWidthPx out of range: ${px}`);
  }
}

window.__rasterize = async (svgText: string, targetWidthPx: number): Promise<string> => {
  assertTargetWidth(targetWidthPx);
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG image decode failed (malformed SVG or foreignObject content)"));
      img.src = url;
    });
    const naturalW = img.naturalWidth || 800;
    const naturalH = img.naturalHeight || 600;
    const scale = targetWidthPx / naturalW;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(naturalW * scale);
    canvas.height = Math.round(naturalH * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Throws on tainted canvas — callers fall back to __mountForScreenshot +
    // `browse screenshot --selector "#raster-stage"`.
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * Fallback rasterization stage: mount the SVG in the DOM so the caller can
 * take an element screenshot (no canvas, no taint rules). Returns a marker
 * string; the artifact is the screenshot, not the return value.
 */
window.__mountForScreenshot = (svgText: string, targetWidthPx: number): string => {
  document.getElementById("raster-stage")?.remove();
  const stage = document.createElement("div");
  stage.id = "raster-stage";
  stage.style.cssText = `display:inline-block;background:#fff;width:${targetWidthPx}px`;
  stage.innerHTML = svgText;
  const svg = stage.querySelector("svg");
  if (svg) {
    svg.setAttribute("width", String(targetWidthPx));
    svg.removeAttribute("height");
    svg.style.height = "auto";
  }
  document.body.appendChild(stage);
  return `mounted:${targetWidthPx}`;
};

/**
 * Downscale a raster image (data URI) to targetWidthPx, preserving aspect.
 * Re-encodes in the requested mime — JPEG photos stay JPEG (q0.9); PNG-encoding
 * a photo would bloat it past the original. Data URIs are same-origin, so the
 * canvas never taints.
 */
window.__downscaleRaster = async (
  dataUri: string,
  targetWidthPx: number,
  mime: string,
): Promise<string> => {
  assertTargetWidth(targetWidthPx);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUri;
  });
  const scale = targetWidthPx / (img.naturalWidth || targetWidthPx);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const outMime = mime === "image/jpeg" ? "image/jpeg" : "image/png";
  return outMime === "image/jpeg" ? canvas.toDataURL(outMime, 0.9) : canvas.toDataURL(outMime);
};

/** Probe intrinsic dimensions of an image (data URI or URL). Returns JSON. */
window.__probeImage = async (src: string): Promise<string> => {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
  return JSON.stringify({ width: img.naturalWidth, height: img.naturalHeight });
};

// __BUNDLE_INFO__ is replaced at build time with the pinned dependency map.
window.__bundleInfo = { name: "gstack-diagram-render", deps: __BUNDLE_INFO_DEPS__ };

// Readiness signal: pollable text beats a bare invisible div (Playwright's
// visibility-based `wait` never fires on an empty element).
const status = document.getElementById("status");
if (status) status.textContent = "ready";
const done = document.createElement("div");
done.id = "done";
done.textContent = "ready";
done.style.cssText = "position:absolute;left:-9999px";
document.body.appendChild(done);

declare const __BUNDLE_INFO_DEPS__: Record<string, string>;
