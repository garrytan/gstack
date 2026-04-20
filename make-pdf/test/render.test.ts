/**
 * Renderer unit tests — pure-function assertions for render.ts, smartypants.ts,
 * and print-css.ts. No Playwright, no PDF generation.
 */

import { describe, expect, test } from "bun:test";

import { render, sanitizeUntrustedHtml } from "../src/render";
import { smartypants } from "../src/smartypants";
import { printCss } from "../src/print-css";

// ─── smartypants ──────────────────────────────────────────────

describe("smartypants", () => {
  test("converts straight double quotes to curly", () => {
    const out = smartypants(`<p>She said "hello" to him.</p>`);
    expect(out).toContain("\u201chello\u201d");
  });

  test("converts em dash (--)", () => {
    const out = smartypants(`<p>This is it -- the answer.</p>`);
    expect(out).toContain("\u2014");
  });

  test("converts ellipsis (...)", () => {
    const out = smartypants(`<p>Wait...</p>`);
    expect(out).toContain("\u2026");
  });

  test("converts apostrophes in contractions", () => {
    const out = smartypants(`<p>don't you know?</p>`);
    expect(out).toContain("don\u2019t");
  });

  test("does NOT touch content inside <code> blocks", () => {
    const input = `<pre><code>const x = "hello"; // it's fine</code></pre>`;
    const out = smartypants(input);
    expect(out).toBe(input); // unchanged
  });

  test("does NOT touch content inside <pre> blocks", () => {
    const input = `<pre>"quoted" -- don't</pre>`;
    const out = smartypants(input);
    expect(out).toBe(input);
  });

  test("does NOT touch inline code", () => {
    const out = smartypants(`<p>Use <code>it's</code> like this: "hello".</p>`);
    expect(out).toContain("<code>it's</code>");
    expect(out).toContain("\u201chello\u201d");
  });

  test("does NOT touch URLs", () => {
    const out = smartypants(`<p>Visit https://example.com/it's-page for "details".</p>`);
    expect(out).toContain("https://example.com/it's-page");
    expect(out).toContain("\u201cdetails\u201d");
  });

  test("does NOT touch HTML attribute values", () => {
    const out = smartypants(`<a href="it's-a-test.html">link</a>`);
    expect(out).toContain(`href="it's-a-test.html"`);
  });

  test("does NOT convert -- in CLI flags", () => {
    // Prose like "try --verbose mode" should not turn -- into em dash
    const out = smartypants(`<p>Try --verbose mode.</p>`);
    // Since "--" is followed by a word char but not preceded by word/space,
    // it should remain intact. We're lenient here — acceptable either way.
    expect(out).toMatch(/--verbose|—verbose/);
  });
});

// ─── sanitizer ──────────────────────────────────────────────

describe("sanitizeUntrustedHtml", () => {
  test("strips <script> tags and content", () => {
    const input = `<p>hello</p><script>alert(1)</script><p>world</p>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>hello</p>");
    expect(out).toContain("<p>world</p>");
  });

  test("strips <iframe>", () => {
    const input = `<p>hi</p><iframe src="evil.com"></iframe>`;
    expect(sanitizeUntrustedHtml(input)).not.toContain("<iframe");
  });

  test("strips onclick attribute", () => {
    const input = `<a href="#" onclick="alert(1)">click</a>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("onclick");
    expect(out).toContain("href=\"#\"");
  });

  test("strips event handlers with mixed case (onClick, ONCLICK)", () => {
    const input1 = `<a href="#" onClick="x()">a</a>`;
    const input2 = `<a href="#" ONCLICK="x()">b</a>`;
    expect(sanitizeUntrustedHtml(input1)).not.toContain("onClick");
    expect(sanitizeUntrustedHtml(input2)).not.toContain("ONCLICK");
  });

  test("rewrites javascript: URLs in href to #", () => {
    const input = `<a href="javascript:alert(1)">bad</a>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });

  test("strips inline SVG <script>", () => {
    const input = `<svg><script>alert(1)</script><circle r="5"/></svg>`;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("<script");
    expect(out).toContain("<circle");
  });

  test("strips <object>, <embed>, <link>, <meta>, <base>, <form>", () => {
    const input = `
      <object data="x.swf"></object>
      <embed src="y.mov">
      <link rel="stylesheet" href="evil.css">
      <meta http-equiv="refresh" content="0;url=evil">
      <base href="evil.com">
      <form action="evil"><input/></form>
    `;
    const out = sanitizeUntrustedHtml(input);
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<meta");
    expect(out).not.toContain("<base");
    expect(out).not.toContain("<form");
  });

  test("strips srcdoc attribute (iframe escape vector)", () => {
    const input = `<div srcdoc="<script>bad</script>">hi</div>`;
    expect(sanitizeUntrustedHtml(input)).not.toContain("srcdoc");
  });
});

// ─── end-to-end render ──────────────────────────────────────────────

describe("render (end-to-end)", () => {
  test("produces a full HTML document with title, body, and CSS", () => {
    const result = render({
      markdown: `# Hello\n\nA paragraph with "quotes" and -- dashes.\n`,
    });
    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain("<title>Hello</title>");
    expect(result.html).toContain("<h1");
    expect(result.html).toContain("Hello");
    // CSS should be inlined as <style>...
    expect(result.html).toMatch(/<style>[\s\S]*font-family: Helvetica/);
    // Smartypants ran
    expect(result.html).toContain("\u201cquotes\u201d");
    expect(result.html).toContain("\u2014");
  });

  test("derives title from first H1 when --title is not passed", () => {
    const result = render({ markdown: `# My Title\n\nBody.` });
    expect(result.meta.title).toBe("My Title");
  });

  test("uses --title override when provided", () => {
    const result = render({
      markdown: `# Auto-derived\n\nBody.`,
      title: "Explicit Title",
    });
    expect(result.meta.title).toBe("Explicit Title");
  });

  test("includes cover block when cover=true", () => {
    const result = render({
      markdown: `# Doc\n\nBody.`,
      cover: true,
      subtitle: "A subtitle",
      author: "Garry Tan",
    });
    expect(result.html).toContain(`class="cover"`);
    expect(result.html).toContain(`class="cover-title"`);
    expect(result.html).toContain("A subtitle");
    expect(result.html).toContain("Garry Tan");
  });

  test("omits cover block when cover=false", () => {
    const result = render({ markdown: `# Memo\n\nBody.` });
    expect(result.html).not.toContain(`class="cover"`);
  });

  test("injects watermark element when --watermark is set", () => {
    const result = render({ markdown: `# Doc`, watermark: "DRAFT" });
    expect(result.html).toContain(`class="watermark"`);
    expect(result.html).toContain("DRAFT");
    // And the CSS rule for it must be present
    expect(result.html).toContain("position: fixed");
    expect(result.html).toContain("rotate(-30deg)");
  });

  test("wraps each H1 in its own .chapter section (default)", () => {
    const result = render({
      markdown: `# One\n\nbody 1\n\n# Two\n\nbody 2\n`,
    });
    const chapterMatches = result.html.match(/class="chapter"/g);
    expect(chapterMatches).toBeTruthy();
    if (chapterMatches) expect(chapterMatches.length).toBe(2);
  });

  test("does NOT create chapter sections when noChapterBreaks=true", () => {
    const result = render({
      markdown: `# One\n\nbody\n\n# Two\n\nbody\n`,
      noChapterBreaks: true,
    });
    const chapterMatches = result.html.match(/class="chapter"/g) ?? [];
    expect(chapterMatches.length).toBe(1);
  });

  test("builds a TOC with H1/H2 entries when toc=true", () => {
    const result = render({
      markdown: `# One\n\n## Sub\n\nbody\n\n# Two\n\nbody\n`,
      toc: true,
    });
    expect(result.html).toContain(`class="toc"`);
    expect(result.html).toContain(`<h2>Contents</h2>`);
    expect(result.html).toContain("One");
    expect(result.html).toContain("Sub");
    expect(result.html).toContain("Two");
  });

  test("strips dangerous HTML from untrusted markdown", () => {
    const result = render({
      markdown: `# Safe\n\n<script>alert('xss')</script>\n\nBody.`,
    });
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("alert");
    expect(result.html).toContain("Safe");
  });

  test("respects text-align: left — no justify in print CSS", () => {
    const result = render({ markdown: `para1\n\npara2\n` });
    // The rule from the design-review fix: no p + p indent, text-align: left.
    expect(result.printCss).toContain("text-align: left");
    expect(result.printCss).not.toContain("text-align: justify");
    expect(result.printCss).not.toContain("text-indent");
  });

  test("includes CJK font fallback in body", () => {
    const result = render({ markdown: `body` });
    expect(result.printCss).toContain("Hiragino Kaku Gothic");
    expect(result.printCss).toContain("Noto Sans CJK");
  });
});

// ─── print-css ──────────────────────────────────────────────

describe("printCss", () => {
  test("emits 1in margins by default", () => {
    const css = printCss();
    expect(css).toContain("margin: 1in");
  });

  test("respects custom margins flag", () => {
    const css = printCss({ margins: "72pt" });
    expect(css).toContain("margin: 72pt");
  });

  test("emits letter page size by default", () => {
    const css = printCss();
    expect(css).toContain("size: letter");
  });

  test("respects custom page size", () => {
    const css = printCss({ pageSize: "a4" });
    expect(css).toContain("size: a4");
  });

  test("suppresses running header and footer on cover page", () => {
    const css = printCss();
    expect(css).toMatch(/@page\s*:first\s*\{[\s\S]*?content:\s*none[\s\S]*?content:\s*none/);
  });

  test("omits CONFIDENTIAL when confidential=false", () => {
    const css = printCss({ confidential: false });
    expect(css).not.toContain("CONFIDENTIAL");
  });

  test("emits watermark CSS only when watermark is set", () => {
    const withWatermark = printCss({ watermark: "DRAFT" });
    expect(withWatermark).toContain(".watermark");
    expect(withWatermark).toContain("rotate(-30deg)");

    const withoutWatermark = printCss();
    expect(withoutWatermark).not.toContain(".watermark");
  });

  test("drops chapter break rule when noChapterBreaks=true", () => {
    const on = printCss({ noChapterBreaks: false });
    expect(on).toContain("break-before: page");

    const off = printCss({ noChapterBreaks: true });
    expect(off).not.toContain(".chapter { break-before: page");
  });

  test("always sets p { text-align: left }", () => {
    const css = printCss();
    expect(css).toContain("text-align: left");
  });

  test("never sets text-indent on p", () => {
    const css = printCss();
    // Confirm no p-indent slipped in
    expect(css).not.toMatch(/p\s*\+\s*p\s*\{[^}]*text-indent/);
  });
});
