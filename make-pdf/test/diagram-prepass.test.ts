/**
 * Unit tests for the diagram pre-pass: fence extraction, info-string parsing,
 * slot substitution, diagnostic blocks, image inlining policy, and the
 * byte-level image dimension prober. No browse daemon required — the tab
 * factory returns null so downscale paths are exercised as no-ops.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import zlib from "node:zlib";

import {
  StrictModeError,
  buildDiagnosticBlock,
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
    getTab: () => null,
  };

  test("local image becomes a data URI with probed dimensions", () => {
    const warnings: string[] = [];
    const out = inlineLocalImages(`<img src="ok.png" alt="x">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("data:image/png;base64,");
    expect(out).toContain('data-gstack-px-width="40"');
    expect(out).toContain('data-gstack-px-height="20"');
    expect(warnings).toHaveLength(0);
  });

  test("missing image → visible placeholder + warning", () => {
    const warnings: string[] = [];
    const out = inlineLocalImages(`<img src="nope.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
    expect(out).toContain("nope.png");
    expect(warnings.length).toBe(1);
  });

  test("missing image + --strict → StrictModeError", () => {
    expect(() =>
      inlineLocalImages(`<img src="nope.png">`, { ...base, strict: true, warn: () => {} }),
    ).toThrow(StrictModeError);
  });

  test("remote image is BLOCKED with a visible placeholder (offline posture)", () => {
    // Leaving the tag would make Chromium fetch it at print time anyway —
    // the offline posture must remove the src, not just warn about it.
    const warnings: string[] = [];
    const tag = `<img src="https://example.com/x.png">`;
    const out = inlineLocalImages(tag, { ...base, warn: (m) => warnings.push(m) });
    expect(out).not.toContain("https://example.com/x.png\"");
    expect(out).toContain("remote image blocked");
    expect(warnings[0]).toContain("offline");
  });

  test("symlink escaping the input dir is caught by the realpath check", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-symlink-"));
    fs.writeFileSync(path.join(outside, "secret.png"), tinyPng(5, 5));
    const link = path.join(dir, "innocent.png");
    try {
      fs.symlinkSync(path.join(outside, "secret.png"), link);
      const warnings: string[] = [];
      inlineLocalImages(`<img src="innocent.png">`, { ...base, warn: (m) => warnings.push(m) });
      expect(warnings.some((w) => w.includes("OUTSIDE the input directory"))).toBe(true);
    } finally {
      try { fs.unlinkSync(link); } catch { /* ignore */ }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("special files and oversized images degrade to placeholders, never hang", () => {
    // Directory masquerading as an image — not a regular file.
    fs.mkdirSync(path.join(dir, "dir.png"), { recursive: true });
    const warnings: string[] = [];
    const out = inlineLocalImages(`<img src="dir.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
    expect(warnings.some((w) => w.includes("not a regular file"))).toBe(true);
  });

  test("malformed percent-encoding degrades to missing-image, never throws", () => {
    const warnings: string[] = [];
    const out = inlineLocalImages(`<img src="foo%zz.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain("image-missing");
  });

  test("remote image + --allow-network passes silently", () => {
    const warnings: string[] = [];
    const tag = `<img src="https://example.com/x.png">`;
    const out = inlineLocalImages(tag, { ...base, allowNetwork: true, warn: (m) => warnings.push(m) });
    expect(out).toBe(tag);
    expect(warnings).toHaveLength(0);
  });

  test("remote image + --strict → StrictModeError", () => {
    expect(() =>
      inlineLocalImages(`<img src="https://example.com/x.png">`, { ...base, strict: true, warn: () => {} }),
    ).toThrow(StrictModeError);
  });

  test("existing data URI gets dimension annotations only", () => {
    const uri = `data:image/png;base64,${tinyPng(33, 44).toString("base64")}`;
    const out = inlineLocalImages(`<img src="${uri}">`, { ...base, warn: () => {} });
    expect(out).toContain('data-gstack-px-width="33"');
    expect(out).toContain('data-gstack-px-height="44"');
  });

  test("out-of-tree image reads warn (never silent) and still inline", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-outside-"));
    fs.writeFileSync(path.join(outside, "ext.png"), tinyPng(10, 10));
    try {
      const warnings: string[] = [];
      const out = inlineLocalImages(`<img src="${path.join(outside, "ext.png")}">`, {
        ...base, warn: (m) => warnings.push(m),
      });
      expect(out).toContain("data:image/png;base64,");
      expect(warnings.some((w) => w.includes("OUTSIDE the input directory"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("out-of-tree image + --strict → StrictModeError", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepass-outside-"));
    fs.writeFileSync(path.join(outside, "ext.png"), tinyPng(10, 10));
    try {
      expect(() =>
        inlineLocalImages(`<img src="${path.join(outside, "ext.png")}">`, {
          ...base, strict: true, warn: () => {},
        }),
      ).toThrow(StrictModeError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("Windows drive-letter src is treated as a local path, not a URL scheme", () => {
    // C:/x.png matches the single-letter-scheme regex — it must reach the
    // local-path branch (and the missing-file placeholder), never silently
    // pass through as an unknown URL.
    const warnings: string[] = [];
    const out = inlineLocalImages(`<img src="C:/missing/x.png">`, { ...base, warn: (m) => warnings.push(m) });
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

  test("oversized raster without a tab inlines at full size with no downscale", () => {
    // 6000px-wide PNG header (body irrelevant for probing; file must exist)
    fs.writeFileSync(path.join(dir, "wide.png"), tinyPng(6000, 100));
    const warnings: string[] = [];
    const out = inlineLocalImages(`<img src="wide.png">`, { ...base, warn: (m) => warnings.push(m) });
    expect(out).toContain('data-gstack-px-width="6000"');
  });
});
