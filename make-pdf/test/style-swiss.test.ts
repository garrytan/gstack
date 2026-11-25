/**
 * The swiss style (make-pdf's default since GSTA-849) and the plain style
 * that keeps the look from before it.
 *
 * plain is pinned byte for byte: the golden files under
 * fixtures/print-css-plain/ were captured from printCss()/screenCss() on main
 * before swiss existed, so any drift in the plain look fails here.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { printCss, resolveMargins, screenCss } from "../src/print-css";
import { keepFieldHeadingsWithText, render } from "../src/render";
import { buildDiagramFigure, contentWidthInches, extractDiagramFences, landscapeContentBox, substituteSlots } from "../src/diagram-prepass";
import { applyImagePolicy } from "../src/image-policy";
import { generate } from "../src/orchestrator";
import { DEFAULT_STYLE, SWISS_FIELD_IN, SWISS_MARGIN_SHORTHAND, swissCoverTitle, swissFieldHeadingLines } from "../src/style-swiss";

const GOLDEN = path.join(import.meta.dir, "fixtures", "print-css-plain");
const golden = (name: string) => fs.readFileSync(path.join(GOLDEN, name), "utf8");

describe("plain is today's look, byte for byte", () => {
  test("default options", () => {
    expect(printCss({ style: "plain" })).toBe(golden("default.css"));
  });
  test("every structural flag at once", () => {
    expect(printCss({
      style: "plain", cover: true, toc: true, noChapterBreaks: true, watermark: "DRAFT",
      confidential: false, runningHeader: 'Title "q"', pageSize: "a4", margins: "72pt", pageNumbers: false,
    })).toBe(golden("flags.css"));
  });
  test("screen layer for --to html", () => {
    expect(screenCss("plain")).toBe(golden("screen.css"));
  });
  test("plain cover title carries no inline sizing", () => {
    const r = render({ markdown: "# T", cover: true, title: "gstack ethos", style: "plain" });
    expect(r.html).toContain('<h1 class="cover-title">gstack ethos</h1>');
  });
  test("resolveMargins leaves plain options untouched", () => {
    const o = { marginLeft: "0.5in" };
    expect(resolveMargins(o, "plain")).toBe(o);
  });
});

describe("swiss is the default", () => {
  test("DEFAULT_STYLE is swiss and printCss() uses it", () => {
    expect(DEFAULT_STYLE).toBe("swiss");
    const css = printCss();
    expect(css).toContain(`margin: ${SWISS_MARGIN_SHORTHAND};`);
    expect(css).toContain(`--swiss-field: ${SWISS_FIELD_IN}in`);
    expect(css).toContain("body { font-size: 11pt; line-height: 15pt; }");
  });
  test("swiss appends to the plain rules, so structural rules keep one source", () => {
    const css = printCss({ style: "swiss" });
    const plain = printCss({ style: "plain", margins: SWISS_MARGIN_SHORTHAND });
    expect(css.startsWith(plain)).toBe(true);
  });
  test("explicit --margins overrides every swiss side", () => {
    expect(printCss({ margins: "72pt" })).toContain("margin: 72pt;");
    expect(resolveMargins({ margins: "1in" }, "swiss")).toMatchObject({
      marginTop: "1in", marginRight: "1in", marginBottom: "1in", marginLeft: "1in",
    });
  });
  test("one per-side flag keeps the other swiss defaults", () => {
    const r = render({ markdown: "# T", marginLeft: "0.5in", marginRight: "0.5in" });
    expect(r.printCss).toContain("margin: 0.7in 0.5in 0.85in 0.5in");
  });
  test("content width follows the swiss margins (7in letter, about 6.77in A4)", () => {
    expect(contentWidthInches(resolveMargins({}, "swiss"))).toBeCloseTo(7);
    expect(contentWidthInches(resolveMargins({ pageSize: "a4", margins: undefined }, "swiss"))).toBeCloseTo(6.77, 2);
    expect(landscapeContentBox(resolveMargins({}, "swiss"))).toEqual({ contentWIn: 9.5, contentHIn: 6.95 });
  });
  test("full-width blocks clear the left field; the chapter contains its floats", () => {
    const css = printCss();
    expect(css).toContain(".chapter { display: flow-root; }");
    expect(css).toMatch(/\.chapter > h1, \.chapter > h2, \.chapter > table, \.chapter > pre, \.chapter > figure, \.chapter > \.page-wide, \.chapter > p:has\(> img:only-child\) \{[^}]*clear: left;/);
    expect(css).toMatch(/\.chapter > hr \{[^}]*clear: left;/);
    expect(css).not.toMatch(/hr[^{]*\{[^}]*display: none/);
  });
  test("black bars and the cover block ask the browser to print their backgrounds", () => {
    const css = printCss({ cover: true, toc: true });
    for (const sel of [".chapter > h2", ".cover h1.cover-title", ".toc h2"]) {
      const rule = css.split("\n").find((l) => l.startsWith(`${sel} {`) && l.includes("background"));
      expect(rule).toContain("print-color-adjust: exact");
    }
  });
  test("cover and TOC rules only when those parts exist", () => {
    const css = printCss();
    expect(css).not.toContain(".cover h1.cover-title");
    expect(css).not.toContain(".toc h2");
  });
  test("screen layer collapses the field on narrow screens", () => {
    const css = screenCss();
    expect(css.startsWith(golden("screen.css"))).toBe(true);
    expect(css).toContain("@media screen and (max-width: 48em)");
    expect(css).toMatch(/\.chapter > h3, \.chapter > \.swiss-keep > h3 \{ float: none; position: static;/);
  });
});

describe("swiss field headings stay with their text", () => {
  test("an h3 and the paragraph, list or quote after it share one wrapper", () => {
    const html = "<h3>Short</h3>\n<p>Text.</p><h3>List</h3><ul><li>a<ul><li>b</li></ul></li></ul><p>after</p>";
    const out = keepFieldHeadingsWithText(html);
    expect(out).toBe(
      '<div class="swiss-keep" style="min-height: 15pt;"><h3>Short</h3>\n<p>Text.</p></div>' +
      '<div class="swiss-keep" style="min-height: 15pt;"><h3>List</h3><ul><li>a<ul><li>b</li></ul></li></ul></div><p>after</p>',
    );
  });
  test("code, tables, figures and a following heading get no wrapper", () => {
    const html = "<h3>A</h3><pre>x</pre><h3>B</h3><table><tr><td>1</td></tr></table><h3>C</h3><h3>D</h3><figure></figure>";
    expect(keepFieldHeadingsWithText(html)).toBe(html);
  });
  test("an h3 before an image-only paragraph gets no wrapper, so the image keeps the full width", () => {
    const html = '<h3>Shot</h3><p><img src="x.png" alt="x"></p><h3>Caption</h3><p>see <img src="y.png"> here</p>';
    expect(keepFieldHeadingsWithText(html)).toBe(html);
  });
  test("an h3 inside a quote, list item, table or details block gets no wrapper", () => {
    const html = "<blockquote><h3>Q</h3><p>quoted</p></blockquote><ul><li><h3>L</h3><p>item</p></li></ul>" +
      "<table><tr><td><h3>T</h3><p>cell</p></td></tr></table><details><h3>D</h3><p>more</p></details>";
    expect(keepFieldHeadingsWithText(html)).toBe(html);
    expect(keepFieldHeadingsWithText(html + "<h3>Top</h3><p>body</p>")).toBe(
      html + '<div class="swiss-keep" style="min-height: 15pt;"><h3>Top</h3><p>body</p></div>',
    );
    expect(render({ markdown: "# Doc\n\n> ### Quoted heading\n>\n> Quoted paragraph." }).html).not.toContain('<div class="swiss-keep"');
  });
  test("an h3 inside raw HTML gets no wrapper, and the wrapper CSS only positions top-level wrappers", () => {
    const md = "# Doc\n\n<div align=\"center\">\n\n### Inside div\n\nPara in div.\n\n</div>\n\n<section>\n\n### Inside section\n\nMore.\n\n</section>\n\n### Top\n\nbody";
    const html = render({ markdown: md }).html;
    expect(html.match(/<div class="swiss-keep"/g)?.length).toBe(1);
    expect(html).toContain('<div class="swiss-keep" style="min-height: 15pt;"><h3>Top</h3>');
    const css = printCss();
    expect(css).toContain(".chapter > .swiss-keep > h3 { position: absolute;");
    expect(css).not.toMatch(/(^|\n|, )\.swiss-keep > /);
  });
  test("a </p> inside an HTML comment does not end the paragraph", () => {
    const html = "<h3>A</h3><p>x <!-- </p> --> y</p><table><tr><td>1</td></tr></table>";
    expect(keepFieldHeadingsWithText(html)).toBe(
      '<div class="swiss-keep" style="min-height: 15pt;"><h3>A</h3><p>x <!-- </p> --> y</p></div><table><tr><td>1</td></tr></table>',
    );
  });
  test("unbalanced raw HTML does not switch off later wrappers or wrap nested ones", () => {
    const html = "<ul><li>a<li>b</ul></div><h3>X</h3><p>t</p><blockquote><h3>Q</h3><p>q</p></blockquote>";
    expect(keepFieldHeadingsWithText(html)).toBe(
      '<ul><li>a<li>b</ul></div><div class="swiss-keep" style="min-height: 15pt;"><h3>X</h3><p>t</p></div><blockquote><h3>Q</h3><p>q</p></blockquote>',
    );
  });
  test("one unbroken word wider than the field counts every line it wraps to", () => {
    expect(swissFieldHeadingLines("AVeryLongIdentifierNameThatIsOneWord")).toBeGreaterThanOrEqual(2);
    expect(swissFieldHeadingLines("x".repeat(65))).toBeGreaterThanOrEqual(3);
    expect(swissFieldHeadingLines("Example")).toBe(1);
  });
  test("a long sub-heading reserves more lines than a short one", () => {
    expect(swissFieldHeadingLines("Example")).toBe(1);
    expect(swissFieldHeadingLines("A long left-field sub-heading that wraps over several lines in the narrow field")).toBeGreaterThanOrEqual(4);
  });
  test("plain renders never get the wrapper", () => {
    expect(render({ markdown: "### H\n\ntext", style: "plain" }).html).not.toContain("swiss-keep");
    expect(render({ markdown: "### H\n\ntext" }).html).toContain('<div class="swiss-keep"');
  });
});

describe("blocks after a swiss sub-heading", () => {
  const FIXTURE = path.join(import.meta.dir, "fixtures", "swiss-after-h3.md");
  const rendered = () => {
    const extraction = extractDiagramFences(fs.readFileSync(FIXTURE, "utf8"));
    return { extraction, html: render({ markdown: extraction.markdown }).html };
  };
  const wrapped = (html: string) => [...html.matchAll(/<div class="swiss-keep"[^>]*><h3>([\s\S]*?)<\/h3>/g)].map((m) => m[1]);

  test("only paragraphs, lists and quotes pair with the sub-heading before them", () => {
    const { extraction, html } = rendered();
    expect(extraction.fences.map((f) => f.lang)).toEqual(["mermaid", "excalidraw", "mermaid"]);
    expect(wrapped(html)).toEqual([
      "Paragraph follows",
      "List follows",
      "Ordered list follows",
      "Quote follows",
      "Second heading",
      "Monday<br>Tuesday<br>Wednesday<br>Thursday<br>Friday<br>Saturday",
    ]);
  });

  test("a diagram after a sub-heading stays a top-level block, so it keeps the full width", () => {
    const { extraction, html } = rendered();
    const slots = new Map(extraction.fences.map((f) => [f.token, buildDiagramFigure(f, `<svg width="400" height="100" viewBox="0 0 400 100"><text>${f.lang}</text></svg>`)]));
    const out = substituteSlots(html, slots);
    expect(out).not.toMatch(/<div class="swiss-keep"[^>]*><h3>(Mermaid|Excalidraw) follows/);
    expect(out).toMatch(/<h3>Mermaid follows<\/h3>\s*<figure class="diagram"/);
    expect(out).toMatch(/<h3>Excalidraw follows<\/h3>\s*<figure class="diagram"/);
    expect(printCss()).toContain(".chapter > h3:has(+ figure)");
  });

  test("a landscape-promoted diagram after a sub-heading lands outside the field wrapper", () => {
    const { extraction, html } = rendered();
    const mermaid = extraction.fences[0];
    const figure = buildDiagramFigure({ ...mermaid, page: "landscape" }, '<svg width="2000" height="400" viewBox="0 0 2000 400"></svg>');
    const out = applyImagePolicy(substituteSlots(html, new Map([[mermaid.token, figure]])), {
      contentWidthIn: 7, landscape: { contentWIn: 9.5, contentHIn: 7 }, warn: () => {},
    });
    expect(out.hasLandscape).toBe(true);
    expect(out.html).toMatch(/<h3>Mermaid follows<\/h3>\s*<div class="page-wide"[^>]*>\s*<figure class="diagram"/);
    for (const keep of out.html.match(/<div class="swiss-keep"[\s\S]*?<\/div>/g) ?? []) expect(keep).not.toContain("page-wide");
    expect(printCss()).toMatch(/\.chapter > h3:has\(\+ \.page-wide\) \{[^}]*page: wide;/);
  });

  test("explicit <br> line breaks in a sub-heading count toward its height", () => {
    expect(render({ markdown: "### Monday<br>Tuesday<br>Wednesday\n\nShort." }).html).toContain('<div class="swiss-keep" style="min-height: 41pt;">');
    expect(render({ markdown: "### Monday<br/>Tuesday<BR >Wednesday\n\nShort." }).html).toContain('<div class="swiss-keep" style="min-height: 41pt;">');
    const unbroken = swissFieldHeadingLines("Monday Tuesday Wednesday") * 13 + 2;
    expect(unbroken).toBeLessThan(41);
    expect(render({ markdown: "### Monday Tuesday Wednesday\n\nShort." }).html).toContain(`<div class="swiss-keep" style="min-height: ${unbroken}pt;">`);
  });
});

describe("--to html fits phone screens", () => {
  const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  for (const style of ["swiss", "plain"] as const) {
    test(`${style} HTML export declares one device-width viewport in its head`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-viewport-"));
      try {
        const input = path.join(dir, "doc.md");
        const output = path.join(dir, "doc.html");
        fs.writeFileSync(input, '# Doc\n\n<meta name="viewport" content="width=10">\n\n### Sub\n\nBody text.\n');
        await generate({ input, output, to: "html", quiet: true, style });
        const html = fs.readFileSync(output, "utf8");
        expect(html.split(VIEWPORT).length - 1).toBe(1);
        expect(html).not.toContain("width=10");
        expect(html.indexOf(VIEWPORT)).toBeLessThan(html.indexOf("</head>"));
        expect(html).toContain(screenCss(style));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
  test("the HTML staged for printing carries no viewport", () => {
    expect(render({ markdown: "# Doc" }).html).not.toContain('name="viewport"');
    expect(render({ markdown: "# Doc", style: "plain" }).html).not.toContain('name="viewport"');
  });
});

describe("swiss cover title sizing", () => {
  test("short titles get the full 96pt poster size and the deep top pad", () => {
    expect(swissCoverTitle("gstack ethos")).toEqual({ fontPt: 96, padTopIn: 3.2 });
  });
  test("a 90-character title steps down and lifts the block", () => {
    const t = "The gstack factory: how crews plan, build, review and ship software with agents, end to end";
    expect(t.length).toBeGreaterThanOrEqual(90);
    const s = swissCoverTitle(t);
    expect(s.fontPt).toBeLessThan(96);
    expect(s.padTopIn).toBeLessThan(3.2);
  });
  test("a long unbreakable token falls to the 48pt floor", () => {
    expect(swissCoverTitle("x".repeat(60)).fontPt).toBe(48);
  });
  test("CJK titles are measured as wide glyphs", () => {
    const cjk = "软件工厂如何规划构建审查和发布软件".repeat(2) + "以及更多内容";
    expect(Array.from(cjk).length).toBe(40);
    expect(swissCoverTitle(cjk).fontPt).toBeLessThan(swissCoverTitle("a".repeat(5) + " " + "b".repeat(5)).fontPt);
  });
  test("emoji count as wide glyphs too", () => {
    expect(swissCoverTitle("🚀".repeat(30)).fontPt).toBeLessThan(96);
  });
  test("the cover is sized for the real page box, not swiss Letter", () => {
    const title = "Infrastructure Status for North America";
    const small = swissCoverTitle(title, { contentWIn: 4.5, contentHIn: 7 });
    const letter = swissCoverTitle(title);
    expect(small.fontPt).toBeLessThan(letter.fontPt);
    expect(small.padTopIn).toBeLessThan(letter.padTopIn);
    expect(swissCoverTitle(title, { contentWIn: 7, contentHIn: 9.45 })).toEqual(letter);
    const r = render({ markdown: "# T", cover: true, title, margins: "2in" });
    expect(r.html).toContain(`style="font-size: ${small.fontPt}pt; padding-top: ${small.padTopIn}in;"`);
  });
  test("swiss render emits the computed size inline on the cover title", () => {
    const r = render({ markdown: "# T", cover: true, title: "gstack ethos" });
    expect(r.html).toContain('<h1 class="cover-title" style="font-size: 96pt; padding-top: 3.2in;">gstack ethos</h1>');
  });
});

describe("Word output keeps the plain look", () => {
  const unzip = Bun.which("unzip");
  test.skipIf(!unzip)("--to docx renders the same document.xml with or without --style swiss", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-swiss-docx-"));
    try {
      const input = path.join(dir, "doc.md");
      fs.writeFileSync(input, "# Doc\n\n### Sub\n\nBody text.\n");
      const xml = async (style: "swiss" | "plain" | undefined, name: string) => {
        const out = path.join(dir, `${name}.docx`);
        await generate({ input, output: out, to: "docx", cover: true, title: "Short", date: "2026-11-25", quiet: true, style });
        return execFileSync(unzip!, ["-p", out, "word/document.xml"], { timeout: 30_000 }).toString("utf8");
      };
      const plain = await xml("plain", "plain");
      expect(await xml(undefined, "default")).toBe(plain);
      expect(await xml("swiss", "swiss")).toBe(plain);
      expect(plain).not.toContain('w:val="192"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
