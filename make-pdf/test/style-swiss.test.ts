/**
 * The swiss style (make-pdf's default since GSTA-849) and the plain style
 * that keeps the look from before it.
 *
 * plain is pinned byte for byte: the golden files under
 * fixtures/print-css-plain/ were captured from printCss()/screenCss() on main
 * before swiss existed, so any drift in the plain look fails here.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { printCss, resolveMargins, screenCss } from "../src/print-css";
import { keepFieldHeadingsWithText, render } from "../src/render";
import { contentWidthInches, landscapeContentBox } from "../src/diagram-prepass";
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
    expect(css).toMatch(/\.chapter > h3, \.swiss-keep > h3 \{ float: none; position: static;/);
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
  test("a long sub-heading reserves more lines than a short one", () => {
    expect(swissFieldHeadingLines("Example")).toBe(1);
    expect(swissFieldHeadingLines("A long left-field sub-heading that wraps over several lines in the narrow field")).toBeGreaterThanOrEqual(4);
  });
  test("plain renders never get the wrapper", () => {
    expect(render({ markdown: "### H\n\ntext", style: "plain" }).html).not.toContain("swiss-keep");
    expect(render({ markdown: "### H\n\ntext" }).html).toContain('<div class="swiss-keep"');
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
  test("swiss render emits the computed size inline on the cover title", () => {
    const r = render({ markdown: "# T", cover: true, title: "gstack ethos" });
    expect(r.html).toContain('<h1 class="cover-title" style="font-size: 96pt; padding-top: 3.2in;">gstack ethos</h1>');
  });
});
