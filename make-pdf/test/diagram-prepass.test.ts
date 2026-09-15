/**
 * Unit tests for the diagram pre-pass: fence extraction, info-string parsing,
 * slot substitution, diagnostic blocks, image inlining policy, and the
 * byte-level image dimension prober, and the bundle runner's script shape
 * (render function injected). No live Aside required — `run: null` makes
 * downscale paths no-ops.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import zlib from "node:zlib";

import {
  StrictModeError,
  buildDiagnosticBlock,
  bundleRunner,
  buildDiagramFigure,
  contentWidthInches,
  dimToInches,
  extractDiagramFences,
  inlineLocalImages,
  parseInfoString,
  substituteSlots,
  decodeFigureSource,
} from "../src/diagram-prepass";
import { imageDims } from "../src/image-size";
import type { RenderResult, RenderSpec } from "../../lib/aside-render";

// ─── fence extraction ─────────────────────────────────────────────────

describe("extractDiagramFences", () => {
  test("extracts a mermaid fence and replaces it with a token paragraph", () => {
    const md = "# T\n\n```mermaid\ngraph LR\n  A --> B\n```\n\ntail";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(1);
    expect(fences[0].lang).toBe("mermaid");
    expect(fences[0].source).toBe("graph LR\n  A --> B");
    expect(markdown).toContain(fences[0].token);
    expect(markdown).not.toContain("```mermaid");
  });

  test("extracts excalidraw fences", () => {
    const md = '```excalidraw\n{"type":"excalidraw","elements":[]}\n```';
    const { fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(1);
    expect(fences[0].lang).toBe("excalidraw");
  });

  test("render=false keeps the fence as code and strips the flag", () => {
    const md = "```mermaid render=false\ngraph LR\n  X --> Y\n```";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(0);
    expect(markdown).toContain("```mermaid\ngraph LR");
    expect(markdown).not.toContain("render=false");
  });

  test("title is captured from the info string", () => {
    const md = '```mermaid title="Auth flow"\ngraph LR\n  A --> B\n```';
    const { fences } = extractDiagramFences(md);
    expect(fences[0].title).toBe("Auth flow");
  });

  test("non-diagram fences pass through untouched", () => {
    const md = "```js\nconst a = 1;\n```";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(0);
    expect(markdown).toBe(md);
  });

  test("a mermaid example inside a plain fence is never extracted", () => {
    const md = "````\n```mermaid\ngraph LR\n```\n````";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(0);
    expect(markdown).toBe(md);
  });

  test("tilde fences work", () => {
    const md = "~~~mermaid\ngraph TD\n  A --> B\n~~~";
    const { fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(1);
  });

  test("unclosed fence at EOF replays verbatim", () => {
    const md = "```mermaid\ngraph LR\n  A --> B";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(0);
    expect(markdown).toBe(md);
  });

  test("multiple fences get distinct ordinals and tokens", () => {
    const md = "```mermaid\nA\n```\n\nmiddle\n\n```mermaid\nB\n```";
    const { fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(2);
    expect(fences[0].ordinal).toBe(1);
    expect(fences[1].ordinal).toBe(2);
    expect(fences[0].token).not.toBe(fences[1].token);
  });
});

describe("parseInfoString", () => {
  test("plain language", () => {
    expect(parseInfoString("mermaid")).toEqual({ lang: "mermaid", render: true, title: undefined });
  });
  test("render=false", () => {
    expect(parseInfoString("mermaid render=false").render).toBe(false);
  });
  test("single-quoted title", () => {
    expect(parseInfoString("mermaid title='Hi there'").title).toBe("Hi there");
  });
});

// ─── slots ────────────────────────────────────────────────────────────

describe("substituteSlots", () => {
  test("replaces the <p>-wrapped token with slot HTML", () => {
    const slots = new Map([["gstack-diagram-slot-ab-1", "<figure>X</figure>"]]);
    const html = "<h1>T</h1>\n<p>gstack-diagram-slot-ab-1</p>\n<p>tail</p>";
    const out = substituteSlots(html, slots);
    expect(out).toContain("<figure>X</figure>");
    expect(out).not.toContain("gstack-diagram-slot");
    expect(out).not.toContain("<p><figure>");
  });
});

describe("diagnostic + figure blocks", () => {
  const fence = {
    lang: "mermaid", source: "graph LR\n  A --> B", render: true,
    token: "t", ordinal: 3, title: undefined,
  };
  test("diagnostic block escapes error content and names the lang", () => {
    const block = buildDiagnosticBlock(fence, 'Parse <error> "quoted"');
    expect(block).toContain("diagram-error");
    expect(block).toContain("Diagram failed to render (mermaid)");
    expect(block).toContain("Parse &lt;error&gt;");
    expect(block).not.toContain("<error>");
  });
  test("figure carries role=img and ordinal-based aria-label fallback", () => {
    const fig = buildDiagramFigure(fence, "<svg></svg>");
    expect(fig).toContain('role="img"');
    expect(fig).toContain('aria-label="diagram 3"');
    expect(fig).toContain("<svg></svg>");
  });
  test("figure strips scripts from SVG (sanitizer second layer)", () => {
    const fig = buildDiagramFigure(fence, "<svg><script>alert(1)</script><g/></svg>");
    expect(fig).not.toContain("<script>");
  });
  test("title becomes aria-label and caption", () => {
    const fig = buildDiagramFigure({ ...fence, title: "Auth flow" }, "<svg></svg>");
    expect(fig).toContain('aria-label="Auth flow"');
    expect(fig).toContain("diagram-caption");
  });
  test("embedded source round-trips mermaid arrows exactly", () => {
    const source = "graph LR\n  A --> B\n  B -->|label with $& and `ticks`| C";
    const fig = buildDiagramFigure({ ...fence, source }, "<svg></svg>");
    expect(decodeFigureSource(fig)).toBe(source);
  });
  test("slot substitution is immune to $-replacement patterns in labels", () => {
    const slotHtml = `<figure>label says $' and $& here</figure>`;
    const out = substituteSlots("<p>tok-x</p><p>tail</p>", new Map([["tok-x", slotHtml]]));
    expect(out).toContain("label says $' and $& here");
    expect(out).toContain("<p>tail</p>");
    expect(out).not.toContain("tailtail"); // $' expansion would duplicate the tail
  });
});

// ─── image dimension probing ──────────────────────────────────────────

function tinyPng(w: number, h: number): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const body = Buffer.concat([Buffer.from(t, "ascii"), d]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(
    Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("imageDims", () => {
  test("PNG", () => {
    expect(imageDims(tinyPng(640, 480))).toEqual({ width: 640, height: 480, mime: "image/png" });
  });
  test("GIF", () => {
    const b = Buffer.alloc(13);
    b.write("GIF89a", 0, "ascii");
    b.writeUInt16LE(320, 6);
    b.writeUInt16LE(200, 8);
    expect(imageDims(b)).toEqual({ width: 320, height: 200, mime: "image/gif" });
  });
  test("JPEG (SOF0)", () => {
    const b = Buffer.from([
      0xff, 0xd8,                                  // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,          // APP0 len 4
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00, // SOF0 h=256 w=512
    ]);
    expect(imageDims(b)).toEqual({ width: 512, height: 256, mime: "image/jpeg" });
  });
  test("SVG via width/height attrs", () => {
    const b = Buffer.from('<svg xmlns="x" width="800" height="400"></svg>');
    expect(imageDims(b)).toEqual({ width: 800, height: 400, mime: "image/svg+xml" });
  });
  test("SVG via viewBox", () => {
    const b = Buffer.from('<svg viewBox="0 0 1200 600"></svg>');
    expect(imageDims(b)).toEqual({ width: 1200, height: 600, mime: "image/svg+xml" });
  });
  test("unknown bytes → null", () => {
    expect(imageDims(Buffer.from("definitely not an image, sorry"))).toBeNull();
  });
});

// ─── content-box math ─────────────────────────────────────────────────

describe("content width", () => {
  test("letter with 1in margins = 6.5in", () => {
    expect(contentWidthInches({})).toBeCloseTo(6.5);
  });
  test("a4 with 25mm margins", () => {
    expect(contentWidthInches({ pageSize: "a4", margins: "25mm" })).toBeCloseTo(8.27 - 50 / 25.4, 2);
  });
  test("dimToInches parses pt/cm/mm/px", () => {
    expect(dimToInches("72pt", 1)).toBeCloseTo(1);
    expect(dimToInches("2.54cm", 1)).toBeCloseTo(1);
    expect(dimToInches("25.4mm", 1)).toBeCloseTo(1);
    expect(dimToInches("96px", 1)).toBeCloseTo(1);
    expect(dimToInches("garbage", 1.5)).toBe(1.5);
  });
});

// ─── image inlining ───────────────────────────────────────────────────

describe("inlineLocalImages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-img-"));
  fs.writeFileSync(path.join(dir, "ok.png"), tinyPng(40, 20));
  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const base = {
    inputDir: dir,
    strict: false,
    allowNetwork: false,
    contentWidthIn: 6.5,
    run: null,
  };

  test("local image becomes a data URI with probed dimensions", async () => {
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="ok.png" alt="x">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("data:image/png;base64,");
    expect(out).toContain('data-gstack-px-width="40"');
    expect(out).toContain('data-gstack-px-height="20"');
    expect(warnings).toHaveLength(0);
  });

  test("missing image → visible placeholder + warning", async () => {
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="nope.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
    expect(out).toContain("nope.png");
    expect(warnings.length).toBe(1);
  });

  test("missing image + --strict → StrictModeError", async () => {
    await expect(
      inlineLocalImages(`<img src="nope.png">`, { ...base, strict: true, warn: () => {} }),
    ).rejects.toThrow(StrictModeError);
  });

  test("remote image is BLOCKED with a visible placeholder (offline posture)", async () => {
    // Leaving the tag would make Chromium fetch it at print time anyway —
    // the offline posture must remove the src, not just warn about it.
    const warnings: string[] = [];
    const tag = `<img src="https://example.com/x.png">`;
    const out = await inlineLocalImages(tag, { ...base, warn: (m) => warnings.push(m) });
    expect(out).not.toContain("https://example.com/x.png\"");
    expect(out).toContain("remote image blocked");
    expect(warnings[0]).toContain("offline");
  });

  test("symlink escaping the input dir is caught by the realpath check", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-symlink-"));
    fs.writeFileSync(path.join(outside, "secret.png"), tinyPng(5, 5));
    const link = path.join(dir, "innocent.png");
    try {
      fs.symlinkSync(path.join(outside, "secret.png"), link);
      const warnings: string[] = [];
      await inlineLocalImages(`<img src="innocent.png">`, { ...base, warn: (m) => warnings.push(m) });
      expect(warnings.some((w) => w.includes("OUTSIDE the input directory"))).toBe(true);
    } finally {
      try { fs.unlinkSync(link); } catch { /* ignore */ }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("special files and oversized images degrade to placeholders, never hang", async () => {
    // Directory masquerading as an image — not a regular file.
    fs.mkdirSync(path.join(dir, "dir.png"), { recursive: true });
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="dir.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
    expect(warnings.some((w) => w.includes("not a regular file"))).toBe(true);
  });

  test("malformed percent-encoding degrades to missing-image, never throws", async () => {
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="foo%zz.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
  });

  test("remote image + --allow-network passes silently", async () => {
    const warnings: string[] = [];
    const tag = `<img src="https://example.com/x.png">`;
    const out = await inlineLocalImages(tag, { ...base, allowNetwork: true, warn: (m) => warnings.push(m) });
    expect(out).toBe(tag);
    expect(warnings).toHaveLength(0);
  });

  test("remote image + --strict → StrictModeError", async () => {
    await expect(
      inlineLocalImages(`<img src="https://example.com/x.png">`, { ...base, strict: true, warn: () => {} }),
    ).rejects.toThrow(StrictModeError);
  });

  test("existing data URI gets dimension annotations only", async () => {
    const uri = `data:image/png;base64,${tinyPng(33, 44).toString("base64")}`;
    const out = await inlineLocalImages(`<img src="${uri}">`, { ...base, warn: () => {} });
    expect(out).toContain('data-gstack-px-width="33"');
    expect(out).toContain('data-gstack-px-height="44"');
  });

  test("out-of-tree image reads warn (never silent) and still inline", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-outside-"));
    fs.writeFileSync(path.join(outside, "ext.png"), tinyPng(10, 10));
    try {
      const warnings: string[] = [];
      const out = await inlineLocalImages(`<img src="${path.join(outside, "ext.png")}">`, {
        ...base, warn: (m) => warnings.push(m),
      });
      expect(out).toContain("data:image/png;base64,");
      expect(warnings.some((w) => w.includes("OUTSIDE the input directory"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("out-of-tree image + --strict → StrictModeError", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-outside-"));
    fs.writeFileSync(path.join(outside, "ext.png"), tinyPng(10, 10));
    try {
      await expect(
        inlineLocalImages(`<img src="${path.join(outside, "ext.png")}">`, {
          ...base, strict: true, warn: () => {},
        }),
      ).rejects.toThrow(StrictModeError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Windows drive-letter src is treated as a local path, not a URL scheme", async () => {
    // C:/x.png matches the single-letter-scheme regex — it must reach the
    // local-path branch (and the missing-file placeholder), never silently
    // pass through as an unknown URL.
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="C:/missing/x.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
    // Two warnings: it's out-of-tree (resolved outside inputDir) AND missing.
    expect(warnings.some((w) => w.includes("image not found"))).toBe(true);
  });

  test("indented fences inside lists replay byte-for-byte (no list splitting)", () => {
    const md = "- item\n\n  ```js\n  code();\n  ```\n\n- next";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(0);
    expect(markdown).toBe(md);
  });

  test("indented mermaid fences are NOT extracted (column-0 placeholder would split the list)", () => {
    const md = "- item\n\n  ```mermaid\n  graph LR\n  ```\n";
    const { markdown, fences } = extractDiagramFences(md);
    expect(fences).toHaveLength(0);
    expect(markdown).toBe(md);
  });

  test("oversized raster without a tab inlines at full size with no downscale", async () => {
    // 6000px-wide PNG header (body irrelevant for probing; file must exist)
    fs.writeFileSync(path.join(dir, "wide.png"), tinyPng(6000, 100));
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="wide.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain('data-gstack-px-width="6000"');
  });

  test("oversized raster WITH a runner: one __downscaleRaster batch, token swapped for the scaled bytes", async () => {
    fs.writeFileSync(path.join(dir, "wide2.png"), tinyPng(6000, 100));
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const run = async (batch: Array<{ fn: string; args: unknown[] }>) => {
      calls.push(...batch);
      return batch.map(() => ({ ok: true as const, value: "data:image/png;base64,U0NBTEVE" }));
    };
    const warnings: string[] = [];
    // Same image twice: read/downscaled once, both tags rewritten.
    const out = await inlineLocalImages(`<img src="wide2.png"> <img src="wide2.png" alt="b">`, { ...base, run, warn: (m) => warnings.push(m) });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("__downscaleRaster");
    expect(String(calls[0].args[0])).toStartWith("data:image/png;base64,");
    expect(calls[0].args[1]).toBe(1950); // 6.5in × 300dpi
    expect(out.match(/data:image\/png;base64,U0NBTEVE/g)).toHaveLength(2);
    expect(out).toContain('data-gstack-px-width="1950"');
    expect(out).not.toContain("gstack-downscale-slot");
    expect(warnings.some((w) => w.includes("downscaled wide2.png 6000px"))).toBe(true);
  });

  test("a failed downscale falls back to the full-size bytes with a warning", async () => {
    fs.writeFileSync(path.join(dir, "wide3.png"), tinyPng(6000, 100));
    const run = async (batch: unknown[]) => batch.map(() => ({ ok: false as const, error: "image decode failed" }));
    const warnings: string[] = [];
    const out = await inlineLocalImages(`<img src="wide3.png">`, { ...base, run, warn: (m) => warnings.push(m) });
    expect(out).toContain('data-gstack-px-width="6000"');
    expect(out).toContain("data:image/png;base64,");
    expect(out).not.toContain("gstack-downscale-slot");
    expect(warnings.some((w) => w.includes("downscale failed"))).toBe(true);
  });
});

// ─── bundle runner (script shape, injected render) ────────────────────

describe("bundleRunner", () => {
  const bundle = path.join(os.tmpdir(), `fake-bundle-${process.pid}.html`);
  fs.writeFileSync(bundle, "<!doctype html><div id=done>ready</div>");
  afterAll(() => { try { fs.unlinkSync(bundle); } catch { /* best-effort */ } });

  /** Fake Aside: asserts the spec shape and writes OK:/ERR: result files. */
  function fakeRender(script: (fn: string, args: unknown[]) => string) {
    const specs: RenderSpec[] = [];
    const render = async (spec: RenderSpec): Promise<RenderResult> => {
      specs.push(spec);
      for (const step of spec.steps) {
        if (step.kind !== "eval" || !step.out) throw new Error("expected eval steps with out files");
        const i = Number(step.expression.match(/call-(\d+)\.json/)![1]);
        const fn = step.expression.match(/window\["(__\w+)"\]/)![1];
        const args = JSON.parse(fs.readFileSync(path.join(spec.serveRoot!, `call-${i}.json`), "utf8"));
        let text: string;
        try { text = "OK:" + script(fn, args); } catch (e: any) { text = "ERR:" + e.message; }
        fs.writeFileSync(step.out, text);
      }
      return { ok: true, outputs: [], evals: {}, stdout: "" };
    };
    return { render, specs };
  }

  test("stages the bundle + one JSON args file per call in a served dir, waits for #done, reads results back", async () => {
    const { render, specs } = fakeRender((fn, args) => `${fn}(${args.join(",")})`);
    const run = bundleRunner({ bundlePath: bundle, render });
    const results = await run([
      { fn: "__renderMermaid", args: ["mermaid-fence-1", "graph LR"] },
      { fn: "__excalidrawToSvg", args: ["{}"] },
    ]);
    expect(results).toEqual([
      { ok: true, value: "__renderMermaid(mermaid-fence-1,graph LR)" },
      { ok: true, value: "__excalidrawToSvg({})" },
    ]);
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec.waitFor).toEqual({ selector: "#done", timeoutMs: 20_000 });
    expect(path.dirname(spec.file)).toBe(spec.serveRoot);
    expect(spec.steps).toHaveLength(2);
    // Payload rides the served dir, not argv: the expression stays tiny.
    for (const step of spec.steps) expect(step.kind === "eval" && step.expression.length < 300).toBe(true);
    // Private per-script dir is cleaned up.
    expect(fs.existsSync(spec.serveRoot!)).toBe(false);
  });

  test("a throwing call is an ERR result; the other calls in the script still succeed", async () => {
    const { render } = fakeRender((_fn, args) => {
      if (String(args[1]).includes("BROKEN")) throw new Error("Parse error on line 1");
      return "<svg/>";
    });
    const run = bundleRunner({ bundlePath: bundle, render });
    const results = await run([
      { fn: "__renderMermaid", args: ["a", "ok"] },
      { fn: "__renderMermaid", args: ["b", "BROKEN"] },
      { fn: "__renderMermaid", args: ["c", "ok"] },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toEqual({ ok: false, error: "Parse error on line 1" });
  });

  test("chunks at 40 calls per script (Aside's 120s script cap)", async () => {
    const { render, specs } = fakeRender(() => "x");
    const run = bundleRunner({ bundlePath: bundle, render });
    const results = await run(Array.from({ length: 85 }, (_, i) => ({ fn: "__renderMermaid", args: [`m${i}`, "g"] })));
    expect(results).toHaveLength(85);
    expect(specs.map((s) => s.steps.length)).toEqual([40, 40, 5]);
  });

  test("a whole-script failure fails every call in it with the renderer's message", async () => {
    const render = async (): Promise<RenderResult> => ({ ok: false, outputs: [], evals: {}, stdout: "", error: "aside repl did not run: spawn aside ENOENT" });
    const run = bundleRunner({ bundlePath: bundle, render });
    const results = await run([{ fn: "__renderMermaid", args: ["a", "g"] }, { fn: "__renderMermaid", args: ["b", "g"] }]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("diagram renderer: aside repl did not run");
    }
  });

  test("an unreadable bundle fails every call without touching Aside; zero calls run nothing", async () => {
    let rendered = 0;
    const render = async (): Promise<RenderResult> => { rendered++; return { ok: true, outputs: [], evals: {}, stdout: "" }; };
    const run = bundleRunner({ bundlePath: "/nonexistent/diagram-render.html", render });
    expect(await run([])).toEqual([]);
    const results = await run([{ fn: "__renderMermaid", args: ["a", "g"] }, { fn: "__renderMermaid", args: ["b", "g"] }]);
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    if (!results[0].ok) expect(results[0].error).toContain("ENOENT");
    expect(rendered).toBe(0);
  });

});
