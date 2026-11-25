/**
 * swiss layout gate: the default look's layout promises, checked on real
 * PDFs through pdftotext -bbox-layout and one pixel sample.
 *
 *   - the text column holds a readable line (median 55-75 characters on
 *     Letter and A4, at most 75 on tabloid, where the column is capped);
 *   - a black bar is never the last text on its page: the paragraph after it
 *     starts on the same page with at least three of its lines there;
 *   - full-width blocks (tables, code) start at the content's left edge, and
 *     left-field sub-headings stay inside the field and above the next bar;
 *   - copy-paste text keeps each sub-heading before its paragraph;
 *   - the bars really print dark;
 *   - a 90-character title keeps the whole cover on page 1.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolvePopplerTool, resolvePdftotext } from "../../src/pdftotext";
import { SWISS_FIELD_IN, SWISS_MARGINS } from "../../src/style-swiss";
import { browserAvailable, NO_BROWSER_REASON } from "../../../test/helpers/browser-available";

const FIXTURE = path.resolve(__dirname, "../fixtures/swiss-gate.md");
const AFTER_H3_FIXTURE = path.resolve(__dirname, "../fixtures/swiss-after-h3.md");
const BUNDLE = path.resolve(__dirname, "../../../lib/diagram-render/dist/diagram-render.html");
const ROOT = path.resolve(__dirname, "../../..");
const PDF_BIN = path.join(ROOT, "make-pdf/dist/pdf");
const CHILD_TIMEOUT_MS = 60_000;
const BARS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"].map((w) => `${w} bar heading`);

const LEFT_PT = parseFloat(SWISS_MARGINS.left) * 72;
const COLUMN_PT = LEFT_PT + SWISS_FIELD_IN * 72;

function prerequisitesAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PDF_BIN)) return { ok: false, reason: `make-pdf binary missing (${PDF_BIN}). Run bun run build.` };
  if (!browserAvailable()) return { ok: false, reason: NO_BROWSER_REASON };
  try { resolvePdftotext(); } catch (err: any) { return { ok: false, reason: err.message }; }
  if (!resolvePopplerTool("pdftoppm")) return { ok: false, reason: "pdftoppm not found." };
  return { ok: true };
}

interface Line { page: number; pageH: number; x0: number; x1: number; y0: number; y1: number; text: string }

function lines(pdf: string): Line[] {
  const xml = execFileSync(resolvePopplerTool("pdftotext")!, ["-bbox-layout", pdf, "-"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  const out: Line[] = [];
  let page = 0;
  let pageH = 0;
  for (const chunk of xml.split(/(?=<page )/)) {
    const ph = chunk.match(/^<page width="[\d.]+" height="([\d.]+)"/);
    if (!ph) continue;
    page++;
    pageH = parseFloat(ph[1]);
    for (const m of chunk.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
      const words = [...m[5].matchAll(/<word[^>]*>([^<]*)<\/word>/g)].map((w) => w[1]);
      out.push({ page, pageH, x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: words.join(" ") });
    }
  }
  return out;
}

/** Body lines: inside the page's type area (no running header or footer). */
const body = (ls: Line[]) => ls.filter((l) => l.y0 > 0.7 * 72 - 1 && l.y1 < l.pageH - 0.85 * 72 + 1);

function render(dir: string, name: string, args: string[], fixture = FIXTURE): string {
  const out = path.join(dir, `${name}.pdf`);
  execFileSync(PDF_BIN, ["generate", fixture, out, "--quiet", ...args], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  return out;
}

function columnMedian(ls: Line[]): { median: number; n: number } {
  const col = body(ls).filter((l) => Math.abs(l.x0 - COLUMN_PT) < 3 && l.text.split(" ").length >= 4).map((l) => l.text.length).sort((a, b) => a - b);
  return { median: col[Math.floor(col.length / 2)] ?? 0, n: col.length };
}

describe("swiss layout gate", () => {
  const avail = prerequisitesAvailable();
  let dir = "";

  test.skipIf(!avail.ok)("Letter: measure, bars, full-width blocks, field headings, copy order, dark bars", () => {
    if (!avail.ok) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-swiss-gate-"));
    const pdf = render(dir, "letter", []);
    const ls = lines(pdf);
    const all = body(ls);

    const { median, n } = columnMedian(ls);
    expect(n).toBeGreaterThan(20);
    expect(median).toBeGreaterThanOrEqual(55);
    expect(median).toBeLessThanOrEqual(75);

    for (const bar of BARS) {
      const b = all.find((l) => l.text === bar);
      expect({ bar, found: !!b }).toEqual({ bar, found: true });
      const after = all.filter((l) => l.page === b!.page && l.y0 > b!.y1);
      expect({ bar, linesAfterOnPage: Math.min(after.length, 3) }).toEqual({ bar, linesAfterOnPage: 3 });
      expect(b!.x0).toBeGreaterThan(COLUMN_PT - 3);
    }

    const cell = all.find((l) => l.text.includes("tablecellalpha"))!;
    const code = all.find((l) => l.text.includes("codelinealpha"))!;
    expect(cell.x0).toBeLessThan(LEFT_PT + 20);
    expect(code.x0).toBeLessThan(LEFT_PT + 20);

    for (const h of ["Table follows", "Code follows", "First of two", "Second of two"]) {
      const l = all.find((x) => x.text === h)!;
      expect({ h, inField: l.x0 < LEFT_PT + 3 && l.x1 < COLUMN_PT }).toEqual({ h, inField: true });
    }
    const longH = all.filter((l) => l.x0 < LEFT_PT + 3 && l.x1 < COLUMN_PT && /narrow field|several lines|long left-field|wraps over/.test(l.text));
    expect(longH.length).toBeGreaterThanOrEqual(2);
    const beta = all.find((l) => l.text === "Beta bar heading")!;
    const lastH = longH[longH.length - 1];
    expect(lastH.page < beta.page || lastH.y1 < beta.y0).toBe(true);
    const first = all.find((x) => x.text === "First of two")!;
    const second = all.find((x) => x.text === "Second of two")!;
    expect(second.y0).toBeGreaterThanOrEqual(first.y1);

    const text = execFileSync(resolvePopplerTool("pdftotext")!, [pdf, "-"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
    expect(text.indexOf("Table follows")).toBeLessThan(text.indexOf("tablecellalpha"));
    expect(text.indexOf("Code follows")).toBeLessThan(text.indexOf("codelinealpha"));
    expect(text.indexOf("Second of two")).toBeLessThan(text.indexOf("Sentence 1", text.indexOf("Second of two")));

    const alpha = all.find((l) => l.text === "Alpha bar heading")!;
    const prefix = path.join(dir, "bar");
    execFileSync(resolvePopplerTool("pdftoppm")!, ["-r", "36", "-gray", "-f", String(alpha.page), "-l", String(alpha.page), "-singlefile", pdf, prefix], { timeout: CHILD_TIMEOUT_MS });
    const pgm = fs.readFileSync(`${prefix}.pgm`);
    const header = pgm.toString("latin1", 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/)!;
    const w = +header[1];
    const start = header[0].length;
    const s = 36 / 72;
    const y = Math.round(((alpha.y0 + alpha.y1) / 2) * s);
    let dark = 0;
    let total = 0;
    for (let x = Math.round((LEFT_PT + 6) * s); x < Math.round((COLUMN_PT - 10) * s); x++) {
      total++;
      if (pgm[start + y * w + x] < 60) dark++;
    }
    expect(dark / total).toBeGreaterThan(0.9);
  }, 120000);

  for (const [size, args, lo, hi] of [["a4", ["--page-size", "a4"], 55, 75], ["tabloid", ["--page-size", "tabloid"], 0, 75]] as const) {
    test.skipIf(!avail.ok)(`${size}: the text column holds a readable line`, () => {
      if (!avail.ok) return;
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-swiss-gate-"));
      try {
        const { median, n } = columnMedian(lines(render(d, size, [...args])));
        expect(n).toBeGreaterThan(20);
        expect(median).toBeGreaterThanOrEqual(lo);
        expect(median).toBeLessThanOrEqual(hi);
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }, 120000);
  }

  test.skipIf(!avail.ok)("a 90-character title keeps the whole cover on page 1", () => {
    if (!avail.ok) return;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-swiss-gate-"));
    try {
      const title = "The gstack factory: how crews plan, build, review and ship software with agents, end to end";
      const pdf = render(d, "cover", ["--cover", "--title", title, "--author", "Gate Author", "--date", "2026-11-25"]);
      const page = (p: number) => execFileSync(resolvePopplerTool("pdftotext")!, ["-f", String(p), "-l", String(p), pdf, "-"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
      const one = page(1).replace(/\s+/g, " ");
      expect(one).toContain("end to end");
      expect(one).toContain("Gate Author");
      expect(one).toContain("2026-11-25");
      expect(page(2)).not.toContain("Gate Author");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }, 120000);

  test.skipIf(!avail.ok)("the cover fits page 1 of a smaller page box (--margins 2in)", () => {
    if (!avail.ok) return;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-swiss-gate-"));
    try {
      const pdf = render(d, "cover-2in", ["--cover", "--title", "Infrastructure Status for North America", "--author", "Gate Author", "--date", "2026-11-25", "--margins", "2in"]);
      const page = (p: number) => execFileSync(resolvePopplerTool("pdftotext")!, ["-f", String(p), "-l", String(p), pdf, "-"], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
      const one = page(1).replace(/\s+/g, " ");
      expect(one).toContain("Gate Author");
      expect(one).toContain("2026-11-25");
      expect(page(2)).not.toContain("Gate Author");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }, 120000);

  test.skipIf(!avail.ok || !fs.existsSync(BUNDLE))("every block after a sub-heading: diagrams span the full width and no sub-heading overprints", () => {
    if (!avail.ok) return;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-swiss-gate-"));
    try {
      const all = body(lines(render(d, "after-h3", [], AFTER_H3_FIXTURE)));
      const find = (t: string) => {
        const l = all.find((x) => x.text === t);
        expect({ t, found: !!l }).toEqual({ t, found: true });
        return l!;
      };

      for (const labels of [["afterh3alpha", "afterh3beta", "afterh3gamma", "afterh3delta"], ["excalialphanode", "excalibetanode"]]) {
        const ls = all.filter((l) => labels.some((w) => l.text.includes(w)));
        expect({ labels, found: ls.length >= labels.length }).toEqual({ labels, found: true });
        expect({ labels, leftmost: Math.min(...ls.map((l) => l.x0)) < COLUMN_PT - 20 }).toEqual({ labels, leftmost: true });
      }
      for (const h of ["Mermaid follows", "Excalidraw follows"]) {
        const l = find(h);
        const next = all.filter((x) => x.page === l.page && x.y0 > l.y1 - 1 && x !== l);
        expect({ h, labelsBelow: next.some((x) => /afterh3alpha|excalialphanode/.test(x.text)) }).toEqual({ h, labelsBelow: true });
      }

      const landscape = find("Landscape next");
      const landLabels = all.filter((l) => /landalpha|landbeta|landgamma/.test(l.text));
      expect(landLabels.length).toBeGreaterThanOrEqual(3);
      expect({ landscapeHeadingPage: landscape.page }).toEqual({ landscapeHeadingPage: Math.min(...landLabels.map((l) => l.page)) });
      expect(Math.min(...landLabels.map((l) => l.x0))).toBeLessThan(COLUMN_PT - 20);

      const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(find);
      for (const day of days) expect({ day: day.text, inField: day.x0 < LEFT_PT + 3 && day.x1 < COLUMN_PT }).toEqual({ day: day.text, inField: true });
      const closing = find("Closing bar heading");
      const saturday = days[days.length - 1];
      expect(saturday.page < closing.page || saturday.y1 < closing.y0).toBe(true);

      const headings = ["Paragraph follows", "List follows", "Ordered list follows", "Quote follows", "Code follows", "Table follows",
        "Image follows", "Text and image follow", "Mermaid follows", "Excalidraw follows", "Landscape next", "Rule follows", "Raw HTML follows",
        "Heading follows", "Second heading"].map(find);
      for (const h of [...headings, ...days]) {
        const hits = all.filter((x) => x !== h && x.page === h.page && x.x0 < h.x1 - 1 && x.x1 > h.x0 + 1 && x.y0 < h.y1 - 1 && x.y1 > h.y0 + 1);
        expect({ h: h.text, overprints: hits.map((x) => x.text) }).toEqual({ h: h.text, overprints: [] });
      }
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }, 120000);

  test("cleanup", () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  if (!avail.ok) {
    test("prerequisites check", () => {
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
