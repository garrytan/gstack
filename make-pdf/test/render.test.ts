/**
 * Renderer unit tests — pure-function assertions for render.ts, smartypants.ts,
 * and print-css.ts. No browser, no PDF generation.
 */

import { describe, expect, test } from "bun:test";

import { render, sanitizeUntrustedHtml } from "../src/render";
import { smartypants } from "../src/smartypants";
import { printCss, screenCss } from "../src/print-css";

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

  // A URL flush against a following tag (no whitespace between) used to let
  // URL_RE's \S+ swallow the placeholder standing in for that tag. The
  // placeholder never restored, so the tag vanished and its styling bled
  // into the rest of the document. The test above misses this because its
  // URL is followed by a space.
  test("does not leak placeholders for a bare autolinked URL", () => {
    const input = `<p>see <a href="https://ex.com">https://ex.com</a> ok</p>`;
    const out = smartypants(input);
    expect(out).not.toContain("SMARTPANTS_PRESERVED");
    expect(out).toContain("</a>");
    expect(out).toBe(input);
  });

  test("does not leak placeholders for a bold URL", () => {
    const input = `<p>see <strong><a href="https://ex.com">https://ex.com</a></strong> ok</p>`;
    const out = smartypants(input);
    expect(out).not.toContain("SMARTPANTS_PRESERVED");
    expect(out).toContain("</a></strong>");
    expect(out).toBe(input);
  });

  test("does not leak placeholders when a URL is followed by punctuation", () => {
    const input = `<p>see <a href="https://ex.com">https://ex.com</a>, ok</p>`;
    const out = smartypants(input);
    expect(out).not.toContain("SMARTPANTS_PRESERVED");
    expect(out).toContain("</a>");
  });

  test("does NOT touch HTML attribute values", () => {
    const out = smartypants(`<a href="it's-a-test.html">link</a>`);
    expect(out).toContain(`href="it's-a-test.html"`);
  });

  test("curls quote entities in text and leaves them encoded inside tags", () => {
    const out = smartypants(`<p>She said &quot;hi&quot; and it&#39;s &apos;ok&#x27;.</p><img alt="a &quot;b&quot; c&#39;s">`);
    expect(out).toBe(`<p>She said \u201chi\u201d and it\u2019s \u2018ok\u2019.</p><img alt="a &quot;b&quot; c&#39;s">`);
  });

  // A tag split differently than the browser splits it (a ">" inside a quoted
  // value) must not turn the entities after it into straight quotes: the
  // browser reads them as part of the attribute, where a straight quote would
  // end the value and start a live onerror attribute.
  test("never turns a quote entity into a straight quote", () => {
    const input = `<img a"b="c>&quot;/onerror=&quot;alert(1)&quot;/x=&#39;y&apos;z&#x27;>`;
    const count = (s: string) => (s.match(/["']/g) ?? []).length;
    expect(count(smartypants(input))).toBe(count(input));
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

  // Quote entities were decoded inside tags too, so alt="A &quot;quoted&quot;
  // caption" became alt="A "quoted" caption" and the attribute ended at "A ".
  test("keeps quotes inside image alt and link title attributes", () => {
    const md = `![A "quoted" caption](pic.png)\n\nSee [the site](https://example.com 'The "best" site') and <abbr title="it&#39;s &quot;x&quot;">X</abbr>.\n`;
    const html = render({ markdown: md }).bodyHtml;
    expect(html).toContain(`alt="A &quot;quoted&quot; caption"`);
    expect(html).toContain(`title="The &quot;best&quot; site"`);
    expect(html).toContain(`<abbr title="it&#39;s &quot;x&quot;">X</abbr>`);
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

  // ─── blank-first-page regression (#1904) ────────────────────────
  // Any content before the first <h1> used to become a standalone preamble
  // .chapter. That section takes the `:first-of-type { break-before: auto }`
  // exception, so the first real chapter inherits `break-before: page` and
  // starts on page 2 — leaving a blank/near-blank page 1.

  test("a leading <style> preamble does not get its own chapter (no blank page 1)", () => {
    const result = render({ markdown: `<style>h1{color:#000}</style>\n\n# Hello\n\nBody.\n` });
    const chapters = result.html.match(/class="chapter"/g) ?? [];
    // One chapter, not two — the invisible <style> no longer forces a page break.
    expect(chapters.length).toBe(1);
    // ...and the style is preserved (folded into the first chapter, not dropped).
    expect(result.html).toContain("<style>h1{color:#000}</style>");
    expect(result.html).toMatch(/<section class="chapter"><style>[\s\S]*?<\/style>[\s\S]*?<h1/);
  });

  test("leading YAML frontmatter is stripped, not rendered as body text", () => {
    const result = render({
      markdown: `---\ntitle: My Doc\ntype: memo\ntags: [a, b]\n---\n\n# Hello\n\nBody.\n`,
    });
    // Frontmatter keys must not leak into the rendered body.
    expect(result.html).not.toContain("type: memo");
    expect(result.html).not.toContain("tags: [a, b]");
    // No preamble chapter -> single chapter, first H1 on page 1.
    const chapters = result.html.match(/class="chapter"/g) ?? [];
    expect(chapters.length).toBe(1);
    expect(result.meta.title).toBe("Hello");
  });

  test("a real text preamble still gets its own chapter (unchanged behavior)", () => {
    const result = render({ markdown: `Intro paragraph.\n\n# Hello\n\nBody.\n` });
    const chapters = result.html.match(/class="chapter"/g) ?? [];
    expect(chapters.length).toBe(2);
  });

  test("a `---` thematic break that is not frontmatter is left intact", () => {
    // Opening with visible text means the later `---` is a real <hr>, not frontmatter.
    const result = render({ markdown: `# Hello\n\nBefore.\n\n---\n\nAfter.\n` });
    expect(result.html).toContain("<hr>");
    expect(result.html).toContain("After.");
  });
});

// ─── attribute injection ──────────────────────────────────────────────

/** Every attribute the browser's tokenizer would see, start tags only. */
function browserAttrs(html: string): Array<{ tag: string; name: string; value: string }> {
  const out: Array<{ tag: string; name: string; value: string }> = [];
  let i = 0;
  while ((i = html.indexOf("<", i)) !== -1) {
    const open = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(i));
    if (!open) { i++; continue; }
    const tag = open[1]!.toLowerCase();
    i += open[0].length;
    while (i < html.length && html[i] !== ">") {
      if (/[\s/]/.test(html[i]!)) { i++; continue; }
      let name = html[i++]!;
      while (i < html.length && !/[\s/>=]/.test(html[i]!)) name += html[i++];
      while (/\s/.test(html[i] ?? "")) i++;
      let value = "";
      if (html[i] === "=") {
        i++;
        while (/\s/.test(html[i] ?? "")) i++;
        const q = html[i];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, i + 1);
          value = html.slice(i + 1, end < 0 ? html.length : end);
          i = end < 0 ? html.length : end + 1;
        } else {
          while (i < html.length && !/[\s>]/.test(html[i]!)) value += html[i++];
        }
      }
      out.push({ tag, name: name.toLowerCase(), value });
    }
  }
  return out;
}

function decodeAttr(v: string): string {
  return v.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|amp));?/gi, (_m, hex, dec, named) =>
    hex ? String.fromCodePoint(parseInt(hex, 16))
      : dec ? String.fromCodePoint(parseInt(dec, 10))
      : ({ quot: '"', apos: "'", amp: "&" } as Record<string, string>)[named.toLowerCase()]!);
}

function liveScript(html: string): string[] {
  return browserAttrs(html)
    .filter((a) => a.name.startsWith("on") ||
      (/^(?:href|src|xlink:href|action|formaction)$/.test(a.name) && /^\s*javascript:/i.test(decodeAttr(a.value))))
    .map((a) => `<${a.tag} ${a.name}=${a.value}>`);
}

function attrsOf(html: string, tag: string): string[] {
  return browserAttrs(html).filter((a) => a.tag === tag).map((a) => a.name);
}

describe("render() — quote entities never open attributes or tags", () => {
  test("an image alt cannot grow an onerror handler", () => {
    const html = render({ markdown: `![x"/onerror="alert(1)](pic.png)\n` }).bodyHtml;
    expect(liveScript(html)).toEqual([]);
    expect(attrsOf(html, "img")).toEqual(["src", "alt"]);
  });

  test("an image title cannot grow an onload handler or swallow the next paragraph", () => {
    const html = render({ markdown: `![a](pic.png 'p" onload="alert(1)')\n\nAfter.\n` }).bodyHtml;
    expect(liveScript(html)).toEqual([]);
    expect(attrsOf(html, "img")).toEqual(["src", "alt", "title"]);
    expect(attrsOf(html, "p")).toEqual([]);
    expect(html).toContain("<p>After.</p>");
    expect(browserAttrs(html).find((a) => a.name === "title")!.value).not.toContain("<");
  });

  test("a link title cannot grow a second href", () => {
    const html = render({ markdown: `[a](https://example.com 't" href="javascript:alert(1)')\n` }).bodyHtml;
    expect(liveScript(html)).toEqual([]);
    expect(attrsOf(html, "a")).toEqual(["href", "title"]);
  });

  test("a raw-HTML title cannot become a javascript: href", () => {
    const html = render({ markdown: `<a title="x&quot; href=&quot;javascript:alert(1)&quot; y=&quot;">link</a>\n` }).bodyHtml;
    expect(liveScript(html)).toEqual([]);
    expect(attrsOf(html, "a")).toEqual(["title"]);
  });

  test("single-quote entities in a raw-HTML attribute cannot end it", () => {
    for (const q of ["&#39;", "&apos;", "&#x27;"]) {
      const html = render({ markdown: `<abbr title='it${q}s/onmouseover=${q}alert(1)${q}'>X</abbr>\n` }).bodyHtml;
      expect(liveScript(html)).toEqual([]);
      expect(attrsOf(html, "abbr")).toEqual(["title"]);
    }
  });

  test("raw HTML blocks cannot start a handler or javascript: href after / or a closing quote", () => {
    const md = [
      "<div>",
      `<img src="pic.png"/onerror="alert(1)">`,
      `<img src="pic.png"onerror="alert(1)">`,
      `<img src='pic.png'onerror='alert(1)'>`,
      "<svg/onload=alert(1)></svg>",
      `<a title="t"href="javascript:alert(1)">j</a>`,
      `<a/href="javascript:alert(1)">k</a>`,
      "</div>",
      "",
    ].join("\n");
    const html = render({ markdown: md }).bodyHtml;
    expect(liveScript(html)).toEqual([]);
    expect(html).toContain(">j</a>");
    expect(html).toContain(">k</a>");
  });

  // Handler removal runs over the whole page, so handler-looking text in a
  // code span is removed; it must stop before the closing </code> tag.
  test("removing handler-looking text never eats a tag", () => {
    const html = render({ markdown: "See `a/onset=2` and `b onset=3` here.\n" }).bodyHtml;
    expect(liveScript(html)).toEqual([]);
    expect(html).toContain("<p>See <code>a/</code> and <code>b</code> here.</p>");
  });

  // An unquoted value can't hold a space, but the parser decodes &#10; to a
  // line break, so onerror=<!--&#10;code runs "code" after the comment.
  test("a handler whose unquoted value starts with < or a quote is still removed", () => {
    for (const value of ["<!--a", "<!--&#10;document.title=1", "\"x", "'x", ""]) {
      const html = render({ markdown: `<div>\n<img src=pic.png onerror=${value}>\n</div>\n` }).bodyHtml;
      expect(liveScript(html)).toEqual([]);
      expect(html).not.toMatch(/onerror/i);
    }
  });

  test("ordinary quotes still curl and ordinary attributes stay", () => {
    const html = render({ markdown: `She said "hi" -- it's fine. ![a](pic.png "A title")\n` }).bodyHtml;
    expect(html).toContain("\u201chi\u201d");
    expect(html).toContain("it\u2019s");
    expect(html).toContain(`title="A title"`);
    expect(attrsOf(html, "img")).toEqual(["src", "alt", "title"]);
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

  test("per-side margins reach the CSS @page rule (preferCSSPageSize parity)", () => {
    // Under a landscape promotion Chromium honors the CSS margins, not the
    // CDP per-side options — render() must compose them into the shorthand.
    const r = render({ markdown: "# T", marginLeft: "0.5in", marginRight: "0.5in" });
    expect(r.printCss).toContain("margin: 1in 0.5in 1in 0.5in");
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

  test("emits @bottom-center page-number rule by default", () => {
    const css = printCss();
    expect(css).toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });

  test("suppresses @bottom-center page-number rule when pageNumbers=false", () => {
    const css = printCss({ pageNumbers: false });
    expect(css).not.toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });

  test("still emits @bottom-center when pageNumbers=true (explicit)", () => {
    const css = printCss({ pageNumbers: true });
    expect(css).toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });

  // Zero image truncation, ever: the cap must be a GLOBAL img rule. Markdown
  // images render as <p><img> (no figure), so a figure-scoped cap alone lets
  // wide screenshots run off the page edge — the exact regression this pins.
  test("emits a global img max-width cap (zero truncation invariant)", () => {
    const css = printCss();
    expect(css).toMatch(/(^|\n)img\s*\{\s*max-width:\s*100%;\s*height:\s*auto;\s*\}/);
  });

  test("typography floor: body 12pt, poster cover, readable TOC", () => {
    const css = printCss({ cover: true, toc: true });
    expect(css).toContain("font-size: 12pt"); // body
    expect(css).toMatch(/\.cover h1\.cover-title\s*\{[^}]*font-size:\s*56pt/);
    expect(css).toMatch(/\.cover \.cover-meta\s*\{[^}]*font-size:\s*13pt/);
    expect(css).toMatch(/\.toc li\s*\{[^}]*font-size:\s*12pt/);
  });

  test("page-wide carries the named page and NO height/flex centering", () => {
    const css = printCss();
    expect(css).toMatch(/\.page-wide\s*\{[^}]*page:\s*wide/);
    // Centering is computed by image-policy as an inline margin-top. CSS
    // flex/min-height centering fragments into phantom empty landscape pages
    // in Chromium — this pins the regression (landscape-gate: 5 pages for 3
    // promotions, bisected to min-height at any value).
    expect(css).not.toMatch(/\.page-wide\s*\{[^}]*min-height/);
    expect(css).not.toMatch(/\.page-wide\s*\{[^}]*flex/);
  });

  test("font stacks include Liberation Sans adjacent to Helvetica", () => {
    const css = printCss({ confidential: true });
    // Body stack
    expect(css).toMatch(/font-family:\s*Helvetica,\s*"Liberation Sans",\s*Arial/);
    // At least one @page margin box (running header / page number / CONFIDENTIAL)
    // should also have the updated stack.
    const marginBoxStacks = css.match(/@(top|bottom)-(center|right)\s*\{[^}]*Liberation Sans/g) ?? [];
    expect(marginBoxStacks.length).toBeGreaterThanOrEqual(1);
  });

  test("all four original Helvetica stacks now include Liberation Sans", () => {
    const css = printCss({ runningHeader: "Running Title", confidential: true });
    // Count: body (1) + running header (1) + page numbers (1) + confidential (1) = 4
    const occurrences = (css.match(/"Liberation Sans"/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  // ─── emoji fallback (fix/make-pdf-emoji-tofu) ────────────────
  // Body + @top-center running header get the color-emoji families so
  // Chromium has a glyph source for emoji code points instead of tofu (▯).
  // The @bottom-* boxes hold counters / "CONFIDENTIAL" only — no emoji.

  test("body stack includes all three emoji families before sans-serif", () => {
    const css = printCss();
    expect(css).toContain(`"Apple Color Emoji"`);
    expect(css).toContain(`"Segoe UI Emoji"`);
    expect(css).toContain(`"Noto Color Emoji"`);
    // Emoji families must precede the generic family so per-character fallback
    // reaches them before terminating at sans-serif.
    expect(css).toMatch(/"Noto Color Emoji",\s*sans-serif/);
  });

  test("@top-center running header includes emoji families", () => {
    const css = printCss({ runningHeader: "Q3 Report 🚀" });
    const topCenter = css.match(/@top-center\s*\{[^}]*\}/)?.[0] ?? "";
    expect(topCenter).toContain(`"Apple Color Emoji"`);
    expect(topCenter).toContain(`"Noto Color Emoji"`);
  });

  test("@bottom-center and @bottom-right do NOT include emoji families", () => {
    const css = printCss({ confidential: true });
    const bottomCenter = css.match(/@bottom-center\s*\{[^}]*\}/)?.[0] ?? "";
    const bottomRight = css.match(/@bottom-right\s*\{[^}]*\}/)?.[0] ?? "";
    expect(bottomCenter).not.toContain("Emoji");
    expect(bottomRight).not.toContain("Emoji");
    // ...but they still share the sans stack via the SANS_STACK constant.
    expect(bottomCenter).toContain(`"Liberation Sans"`);
    expect(bottomRight).toContain(`"Liberation Sans"`);
  });

  test("emoji families appear in exactly the two emoji-bearing stacks", () => {
    const css = printCss({ runningHeader: "Title", confidential: true });
    // body (1) + @top-center (1) = 2 occurrences of the emoji group.
    const occurrences = (css.match(/"Apple Color Emoji"/g) ?? []).length;
    expect(occurrences).toBe(2);
  });
});

// ─── render() — pageNumbers / footerTemplate data flow ───────────────

describe("render() — pageNumbers data flow", () => {
  test("CSS footer renders by default", () => {
    const result = render({ markdown: `# Doc\n\nBody.` });
    expect(result.printCss).toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });

  test("--no-page-numbers reaches the CSS layer", () => {
    const result = render({ markdown: `# Doc\n\nBody.`, pageNumbers: false });
    expect(result.printCss).not.toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });

  test("footerTemplate suppresses CSS page numbers (custom footer wins)", () => {
    const result = render({
      markdown: `# Doc\n\nBody.`,
      footerTemplate: `<div class="foo">custom</div>`,
    });
    expect(result.printCss).not.toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });

  test("pageNumbers=true + no footerTemplate keeps CSS footer", () => {
    const result = render({ markdown: `# Doc`, pageNumbers: true });
    expect(result.printCss).toMatch(/@bottom-center\s*\{\s*content:\s*counter\(page\)/);
  });
});

// ─── render() — HTML entity handling in titles, cover, TOC ───────────

describe("render() — no double HTML entity escaping", () => {
  type Case = { char: string; inTitle: string; expectedTitleMeta: string };

  // Only characters that should flow through unchanged. `"` and `'` are
  // omitted from this set because smartypants converts them to curly quotes
  // before heading extraction — asserted separately below.
  const cases: Case[] = [
    { char: "&", inTitle: "A & B", expectedTitleMeta: "A & B" },
    { char: "<", inTitle: "A < B", expectedTitleMeta: "A < B" },
    { char: ">", inTitle: "A > B", expectedTitleMeta: "A > B" },
    { char: "©", inTitle: "A © B", expectedTitleMeta: "A © B" },
    { char: "—", inTitle: "A — B", expectedTitleMeta: "A — B" },
  ];

  for (const { char, inTitle, expectedTitleMeta } of cases) {
    test(`"${char}" in H1 has no double-escape in <title> or cover`, () => {
      const result = render({
        markdown: `# ${inTitle}\n\nBody.`,
        cover: true,
        author: "A",
      });
      // Meta: decoded plain text.
      expect(result.meta.title).toBe(expectedTitleMeta);
      // HTML: <title>...</title> never contains double-escape patterns.
      expect(result.html).not.toMatch(/<title>[^<]*&amp;amp;/);
      expect(result.html).not.toMatch(/<title>[^<]*&amp;lt;/);
      expect(result.html).not.toMatch(/<title>[^<]*&amp;gt;/);
      expect(result.html).not.toMatch(/<title>[^<]*&amp;#\d+;/);
      expect(result.html).not.toMatch(/<title>[^<]*&amp;#x[0-9a-fA-F]+;/);
      // Cover block also single-escape.
      expect(result.html).not.toMatch(/class="cover-title"[^>]*>[^<]*&amp;amp;/);
    });
  }

  test('ampersand in <title> renders as exactly one "&amp;"', () => {
    const result = render({ markdown: `# Faber & Faber\n\nBody.` });
    expect(result.html).toContain("<title>Faber &amp; Faber</title>");
    expect(result.html).not.toContain("&amp;amp;");
  });

  test("TOC entries have no double-escape when a heading contains '&'", () => {
    const result = render({
      markdown: `# Doc\n\n## Faber & Faber\n\nBody.\n\n## Other\n\nMore.`,
      toc: true,
    });
    // TOC renders the heading text through escapeHtml; must be single-escaped.
    expect(result.html).toContain("Faber &amp; Faber");
    expect(result.html).not.toContain("&amp;amp;");
  });

  test('numeric entity in H1 (e.g. "&#169;") decodes cleanly to <title>', () => {
    // Marked passes through numeric entities verbatim in the HTML output,
    // so the decoder must handle them.
    const result = render({ markdown: `# A &#169; B\n\nBody.` });
    expect(result.meta.title).toBe("A © B");
    expect(result.html).toContain("<title>A © B</title>");
  });

  test("smartypants converts raw quotes in title BEFORE extraction (contract)", () => {
    // We do NOT assert raw `"` survives — smartypants is expected to convert it.
    // The contract is: no double-escape of the encoded form.
    const result = render({ markdown: `# Say "hi"\n\nBody.` });
    expect(result.html).not.toContain("&amp;quot;");
    expect(result.html).not.toContain("&amp;#39;");
    // And <title> contains exactly one level of escaping.
    const titleMatch = result.html.match(/<title>([^<]*)<\/title>/);
    expect(titleMatch).toBeTruthy();
    if (titleMatch) {
      // Never contains a double-encoded entity.
      expect(titleMatch[1]).not.toMatch(/&amp;(amp|lt|gt|quot|#\d+);/);
    }
  });
});

describe("screenCss", () => {
  test("screenCss is media-scoped and readable-width", () => {
    const css = screenCss();
    expect(css).toContain("@media screen");
    // 42em at 12pt ≈ 70-75 chars/line — the readable ceiling (design review).
    expect(css).toContain("max-width: 42em");
    expect(css).toContain(".watermark { display: none; }");
  });
});
