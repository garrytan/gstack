/**
 * Unit tests for the image width policy + conservative auto-landscape
 * (image-policy.ts). Pure HTML-in/HTML-out — no browse daemon.
 *
 * The promotion heuristic is deliberately conservative (eng-review P4):
 * false negatives are cheap (add {page=landscape}), false positives feel
 * broken. The negative cases here are the load-bearing ones.
 */
import { describe, expect, test } from "bun:test";

import {
  applyImageDirectives,
  applyImagePolicy,
  parseDirectives,
} from "../src/image-policy";

const silent = { warn: () => {} };

// 6.5in content box → threshold = 6.5 × 96 × 2.5 = 1560 CSS px.
// Letter landscape content box: 9in wide × 6.5in tall.
const LANDSCAPE = { contentWIn: 9, contentHIn: 6.5 };
const OPTS = { contentWidthIn: 6.5, landscape: LANDSCAPE, ...silent };

function img(attrs: string): string {
  return `<p><img ${attrs}></p>`;
}

// ─── directive parsing ────────────────────────────────────────────────

describe("parseDirectives", () => {
  test("width grammar", () => {
    expect(parseDirectives("width=full")).toEqual({ width: "full", page: undefined });
    expect(parseDirectives("width=50%")).toEqual({ width: "50%", page: undefined });
    expect(parseDirectives("width=3in")).toEqual({ width: "3in", page: undefined });
    expect(parseDirectives("width=2.5cm")).toEqual({ width: "2.5cm", page: undefined });
  });
  test("page grammar + combination", () => {
    expect(parseDirectives("page=landscape")).toEqual({ width: undefined, page: "landscape" });
    expect(parseDirectives("width=full page=portrait")).toEqual({ width: "full", page: "portrait" });
  });
  test("unknown tokens reject the whole group (stays visible text)", () => {
    expect(parseDirectives("widht=full")).toBeNull();
    expect(parseDirectives("width=full caption=x")).toBeNull();
  });
  test("malformed values reject", () => {
    expect(parseDirectives("width=banana")).toBeNull();
    expect(parseDirectives("page=sideways")).toBeNull();
  });
});

describe("applyImageDirectives", () => {
  test("brace suffix becomes data attrs and is consumed", () => {
    const out = applyImageDirectives(`<p><img src="x.png" alt="a">{width=50%}</p>`);
    expect(out).toContain('data-gstack-width="50%"');
    expect(out).not.toContain("{width=50%}");
  });
  test("unrecognized brace group is left as literal text", () => {
    const html = `<p><img src="x.png">{not a directive}</p>`;
    expect(applyImageDirectives(html)).toBe(html);
  });
  test("non-adjacent braces untouched", () => {
    const html = `<p>set {width=full} in config</p>`;
    expect(applyImageDirectives(html)).toBe(html);
  });
});

// ─── width policy ─────────────────────────────────────────────────────

describe("width styles", () => {
  test("width=full → inline 100% style", () => {
    const { html } = applyImagePolicy(img(`src="x" data-gstack-width="full"`), OPTS);
    expect(html).toContain("width: 100%");
  });
  test("explicit dimension passes through", () => {
    const { html } = applyImagePolicy(img(`src="x" data-gstack-width="3in"`), OPTS);
    expect(html).toContain("width: 3in");
  });
  test("width directive merges with an existing style attribute, preserving it", () => {
    const { html } = applyImagePolicy(
      img(`src="x" style="border: 1px solid" data-gstack-width="50%"`),
      OPTS,
    );
    expect(html).toContain("border: 1px solid");
    expect(html).toContain("width: 50%");
  });
  test("no directive → no inline style (CSS max-width owns the default)", () => {
    const { html } = applyImagePolicy(img(`src="x" data-gstack-px-width="40" data-gstack-px-height="20"`), OPTS);
    expect(html).not.toContain("style=");
  });
});

// ─── landscape promotion ──────────────────────────────────────────────

describe("auto-landscape: negative cases (the load-bearing ones)", () => {
  test("wide screenshot with no alt hint stays portrait", () => {
    const r = applyImagePolicy(
      img(`src="x" alt="screenshot of the app" data-gstack-px-width="3000" data-gstack-px-height="900"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false);
    expect(r.html).not.toContain("page-wide");
  });
  test("wide banner with hint but below width threshold stays portrait", () => {
    const r = applyImagePolicy(
      img(`src="x" alt="chart" data-gstack-px-width="1200" data-gstack-px-height="400"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false);
  });
  test("tall diagram (aspect below 1.8) stays portrait", () => {
    const r = applyImagePolicy(
      img(`src="x" alt="architecture diagram" data-gstack-px-width="2000" data-gstack-px-height="1500"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false);
  });
  test("no intrinsic dimensions stays portrait", () => {
    const r = applyImagePolicy(img(`src="x" alt="diagram"`), OPTS);
    expect(r.hasLandscape).toBe(false);
  });
  test("page=portrait vetoes everything", () => {
    const r = applyImagePolicy(
      img(`src="x" alt="diagram" data-gstack-page="portrait" data-gstack-px-width="4000" data-gstack-px-height="1000"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false);
  });
  test("threshold boundary is deterministic: exactly at threshold stays portrait", () => {
    // threshold = 6.5 × 96 × 2.5 = 1560
    const r = applyImagePolicy(
      img(`src="x" alt="diagram" data-gstack-px-width="1560" data-gstack-px-height="600"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false);
    const r2 = applyImagePolicy(
      img(`src="x" alt="diagram" data-gstack-px-width="1561" data-gstack-px-height="600"`),
      OPTS,
    );
    expect(r2.hasLandscape).toBe(true);
  });
});

describe("auto-landscape: positive cases", () => {
  test("wide + alt hint + over threshold promotes, wraps, and vertically centers", () => {
    const warnings: string[] = [];
    const r = applyImagePolicy(
      img(`src="x" alt="architecture diagram" data-gstack-px-width="2400" data-gstack-px-height="1000"`),
      { contentWidthIn: 6.5, landscape: LANDSCAPE, warn: (m) => warnings.push(m) },
    );
    expect(r.hasLandscape).toBe(true);
    // placed height = 9in × (1000/2400) = 3.75in → margin-top = (6.5−3.75)/2 ≈ 1.38in
    expect(r.html).toContain('<div class="page-wide" style="margin-top: 1.38in"><img');
    expect(r.html).not.toContain("<p><img");
    expect(warnings[0]).toContain("landscape");
  });

  test("directive-forced tall block that fills the page gets no centering margin", () => {
    // aspect 0.9 → placed height 9×0.9 = 8.1in > 6.5in box → margin clamps to 0
    const r = applyImagePolicy(
      img(`src="x" data-gstack-page="landscape" data-gstack-px-width="1000" data-gstack-px-height="900"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(true);
    expect(r.html).toContain('<div class="page-wide"><img');
    expect(r.html).not.toContain("margin-top");
  });
  test("page=landscape forces promotion regardless of size", () => {
    const r = applyImagePolicy(img(`src="x" data-gstack-page="landscape"`), OPTS);
    expect(r.hasLandscape).toBe(true);
    // no intrinsic dims → no centering guess, top placement
    expect(r.html).toContain('<div class="page-wide"><img');
  });
  test("alt hint matches whole words only", () => {
    const r = applyImagePolicy(
      img(`src="x" alt="photographic" data-gstack-px-width="2400" data-gstack-px-height="1000"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false); // "graph" inside "photographic" must not match
  });
});

describe("auto-landscape: diagram figures", () => {
  const fig = (svgAttrs: string, figAttrs = "") =>
    `<figure class="diagram" role="img" aria-label="d"${figAttrs}>\n<svg ${svgAttrs}><g/></svg>\n</figure>`;

  test("wide diagram via viewBox promotes and centers (provenance automatic, no alt needed)", () => {
    const r = applyImagePolicy(fig(`width="100%" viewBox="0 0 2050 600"`), OPTS);
    expect(r.hasLandscape).toBe(true);
    // placed height = 9 × 600/2050 ≈ 2.63in → margin-top = (6.5−2.63)/2 ≈ 1.93in
    expect(r.html).toContain('<div class="page-wide" style="margin-top: 1.93in"><figure');
  });
  test("normal flowchart stays portrait", () => {
    const r = applyImagePolicy(fig(`width="100%" viewBox="0 0 800 400"`), OPTS);
    expect(r.hasLandscape).toBe(false);
  });
  test("fence page=portrait vetoes a wide diagram", () => {
    const r = applyImagePolicy(
      fig(`width="100%" viewBox="0 0 3000 600"`, ` data-gstack-page="portrait"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(false);
  });
  test("fence page=landscape forces a small diagram", () => {
    const r = applyImagePolicy(
      fig(`width="100%" viewBox="0 0 400 300"`, ` data-gstack-page="landscape"`),
      OPTS,
    );
    expect(r.hasLandscape).toBe(true);
  });
  test("diagnostic blocks are never promoted", () => {
    const html = `<figure class="diagram diagram-error" role="img" aria-label="x"><svg viewBox="0 0 4000 600"></svg></figure>`;
    const r = applyImagePolicy(html, OPTS);
    expect(r.hasLandscape).toBe(false);
  });
});
