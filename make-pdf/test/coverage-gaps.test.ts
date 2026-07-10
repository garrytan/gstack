/**
 * Coverage-gap fills from the v1.58.0.0 ship audit — the branches the main
 * suites couldn't reach without a live browse tab (mock-tab here), plus the
 * pure-function stragglers (WebP probing, landscape geometry, bundle path
 * resolution, screen CSS).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  RenderCallError,
  type RenderTab,
  landscapeContentBox,
  rasterizeDiagramFigures,
  renderFenceSlots,
  resolveBundlePath,
  substituteSlots,
} from "../src/diagram-prepass";
import { imageDims } from "../src/image-size";
import { screenCss } from "../src/print-css";

/** Duck-typed RenderTab: scripted call results + a loadBundle counter. */
function mockTab(script: (fn: string, ...args: Array<string | number>) => string) {
  const calls: string[] = [];
  let reloads = 0;
  const tab = {
    call: (fn: string, ...args: Array<string | number>) => {
      calls.push(fn);
      return script(fn, ...args);
    },
    loadBundle: () => { reloads++; },
    close: () => {},
  } as unknown as RenderTab;
  return { tab, calls, reloadCount: () => reloads };
}

const fence = (over: Partial<{ lang: string; source: string; ordinal: number }>) => ({
  lang: "mermaid",
  source: "graph LR\n  A --> B",
  render: true as const,
  token: `tok-${over.ordinal ?? 1}`,
  ordinal: over.ordinal ?? 1,
  title: undefined,
  page: undefined,
  ...over,
});

// ─── renderFenceSlots: reset contract + excalidraw branches ───────────

describe("renderFenceSlots (mock tab)", () => {
  test("reset contract: a failure reloads the bundle and the NEXT fence still renders", () => {
    const { tab, reloadCount } = mockTab((fn, ...args) => {
      if (String(args[1] ?? "").includes("BROKEN")) throw new RenderCallError("Parse error on line 1");
      return "<svg><g/></svg>";
    });
    const warnings: string[] = [];
    const slots = renderFenceSlots(
      [
        fence({ ordinal: 1 }),
        fence({ ordinal: 2, source: "BROKEN" }),
        fence({ ordinal: 3 }),
      ],
      tab,
      (m) => warnings.push(m),
    );
    expect(slots.get("tok-1")).toContain("<svg>");
    expect(slots.get("tok-2")).toContain("diagram-error");
    expect(slots.get("tok-3")).toContain("<svg>"); // post-failure fence rendered
    expect(reloadCount()).toBe(1);                 // exactly one reset reload
    expect(warnings[0]).toContain("failed to render");
  });

  test("excalidraw fence renders via __excalidrawToSvg", () => {
    const { tab, calls } = mockTab(() => "<svg data-x><g/></svg>");
    const slots = renderFenceSlots(
      [fence({ lang: "excalidraw", source: '{"type":"excalidraw","elements":[]}' })],
      tab,
      () => {},
    );
    expect(calls).toEqual(["__excalidrawToSvg"]);
    expect(slots.get("tok-1")).toContain("<svg");
  });

  test("invalid excalidraw JSON fails fast into a diagnostic WITHOUT calling the tab", () => {
    const { tab, calls, reloadCount } = mockTab(() => "<svg/>");
    const warnings: string[] = [];
    const slots = renderFenceSlots(
      [fence({ lang: "excalidraw", source: "{not json" })],
      tab,
      (m) => warnings.push(m),
    );
    expect(calls).toEqual([]); // JSON.parse threw before any bundle call
    expect(slots.get("tok-1")).toContain("diagram-error");
    expect(reloadCount()).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});

// ─── rasterizeDiagramFigures: svg-data-URI + error fallbacks ──────────

describe("rasterizeDiagramFigures (mock tab)", () => {
  const figure = `<figure class="diagram" role="img" aria-label="flow"><svg viewBox="0 0 10 10"><g/></svg></figure>`;

  test("svg data-URI images rasterize to PNG", () => {
    const svgUri = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const { tab } = mockTab(() => "data:image/png;base64,AAAA");
    const out = rasterizeDiagramFigures(`<img src="${svgUri}" alt="v">`, tab, 6.5, () => {});
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  test("figure rasterization failure surfaces the SOURCE as text (never silent loss)", () => {
    // Returning the figure unchanged would make the diagram vanish in DOCX
    // (the converter drops <figure>/<svg>) — the failure must be visible.
    const { tab } = mockTab(() => { throw new RenderCallError("tainted"); });
    const warnings: string[] = [];
    const srcFigure = figure.replace(
      '<figure class="diagram"',
      `<figure class="diagram" data-gstack-source="${Buffer.from("graph LR\n  A --> B").toString("base64")}"`,
    );
    const out = rasterizeDiagramFigures(srcFigure, tab, 6.5, (m) => warnings.push(m));
    expect(out).toContain("could not be rasterized");
    expect(out).toContain("A --&gt; B"); // source visible (escaped), not dropped
    expect(out).not.toContain("<figure");
    expect(warnings[0]).toContain("rasterization failed");
  });

  test("svg data-URI rasterization failure keeps the original tag", () => {
    const svgUri = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const { tab } = mockTab(() => { throw new RenderCallError("decode failed"); });
    const tagIn = `<img src="${svgUri}">`;
    const out = rasterizeDiagramFigures(tagIn, tab, 6.5, () => {});
    expect(out).toBe(tagIn);
  });
});

// ─── image-size: WebP variants ────────────────────────────────────────

describe("imageDims WebP", () => {
  function riff(fmt: string, body: Buffer): Buffer {
    const b = Buffer.alloc(12 + 4 + body.length);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(4 + body.length + 4, 4);
    b.write("WEBP", 8, "ascii");
    b.write(fmt, 12, "ascii");
    body.copy(b, 16);
    return b;
  }

  test("VP8 (lossy)", () => {
    const body = Buffer.alloc(16);
    body.writeUInt16LE(800 & 0x3fff, 10); // width at chunk offset 26 = body offset 10
    body.writeUInt16LE(600 & 0x3fff, 12);
    expect(imageDims(riff("VP8 ", body))).toEqual({ width: 800, height: 600, mime: "image/webp" });
  });

  test("VP8L (lossless)", () => {
    const body = Buffer.alloc(10);
    body[4] = 0x2f; // signature at chunk offset 20 = body offset 4
    const w = 1023, h = 511;
    const bits = (w - 1) | ((h - 1) << 14);
    body.writeUInt32LE(bits >>> 0, 5);
    expect(imageDims(riff("VP8L", body))).toEqual({ width: 1023, height: 511, mime: "image/webp" });
  });

  test("VP8X (extended)", () => {
    const body = Buffer.alloc(14);
    const w = 4000 - 1, h = 250 - 1; // 24-bit minus-one at offsets 24/27 = body 8/11
    body[8] = w & 0xff; body[9] = (w >> 8) & 0xff; body[10] = (w >> 16) & 0xff;
    body[11] = h & 0xff; body[12] = (h >> 8) & 0xff; body[13] = (h >> 16) & 0xff;
    expect(imageDims(riff("VP8X", body))).toEqual({ width: 4000, height: 250, mime: "image/webp" });
  });

  test("unknown RIFF subtype → null", () => {
    expect(imageDims(riff("XXXX", Buffer.alloc(14)))).toBeNull();
  });
});

// ─── landscape geometry + slot fallback + bundle path + screen css ────

describe("pure-function stragglers", () => {
  test("landscapeContentBox letter defaults: 9in × 6.5in", () => {
    expect(landscapeContentBox({})).toEqual({ contentWIn: 9, contentHIn: 6.5 });
  });
  test("landscapeContentBox a4 + asymmetric margins", () => {
    const box = landscapeContentBox({ pageSize: "a4", marginLeft: "0.5in", marginRight: "0.5in", marginTop: "25mm", marginBottom: "1in" });
    expect(box.contentWIn).toBeCloseTo(11.69 - 1, 2);
    expect(box.contentHIn).toBeCloseTo(8.27 - 25 / 25.4 - 1, 2);
  });

  test("substituteSlots bare-token fallback (token not <p>-wrapped)", () => {
    const slots = new Map([["gstack-diagram-slot-x-1", "<figure>D</figure>"]]);
    const out = substituteSlots("<li>gstack-diagram-slot-x-1</li>", slots);
    expect(out).toBe("<li><figure>D</figure></li>");
  });

  test("resolveBundlePath honors the env override", () => {
    const tmp = path.join(os.tmpdir(), `bundle-override-${process.pid}.html`);
    fs.writeFileSync(tmp, "<!doctype html>");
    try {
      expect(resolveBundlePath({ GSTACK_DIAGRAM_BUNDLE: tmp } as NodeJS.ProcessEnv)).toBe(tmp);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
  // NOTE: resolveBundlePath's not-found error shape is untestable from inside
  // this checkout (the repo-relative candidate always exists), and a vacuous
  // if-guarded assertion was worse than none. The env-override test above is
  // the honest coverage; the error path is exercised manually via
  // GSTACK_DIAGRAM_BUNDLE pointing at a missing file outside a repo.

  test("screenCss is media-scoped and readable-width", () => {
    const css = screenCss();
    expect(css).toContain("@media screen");
    // 42em at 12pt ≈ 70-75 chars/line — the readable ceiling (design review).
    expect(css).toContain("max-width: 42em");
    expect(css).toContain(".watermark { display: none; }");
  });
});
