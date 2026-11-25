/**
 * TOC page-number gate (#2903) — through the compiled binary and a real
 * browser (Aside when it runs, otherwise gstack's own; CI uses the latter).
 *
 * Before the fix every `.toc-page` cell printed empty: no pagination engine
 * shipped and the print went ahead after a 3s Paged.js wait. Now each cell
 * must hold the page its heading prints on and each TOC link must land there.
 *
 * Oracles (independent of make-pdf's own PDF reader where it matters):
 *   - pdftotext: the number printed next to each TOC label, and the page
 *     whose text actually contains that heading;
 *   - pdfinfo: page boxes, so the fixture provably spans a landscape page;
 *   - the PDF's link annotations: one per entry, in TOC order, each naming a
 *     destination on the page its entry prints.
 *
 * The fixture covers a multi-page TOC, a cover (and none), custom ids, a
 * duplicate id, a user id squatting the generated `toc-N` scheme, a non-ASCII
 * id, an empty heading, and a forced landscape page between headings.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolvePopplerTool } from "../../src/pdftotext";
import { pdfDestinationPages } from "../../src/toc-pages";
import { browserAvailable, NO_BROWSER_REASON } from "../../../test/helpers/browser-available";

const ROOT = path.resolve(__dirname, "../../..");
const PDF_BIN = path.join(ROOT, "make-pdf/dist/pdf");
const RED_BOX = path.resolve(__dirname, "../fixtures/diagram-assets/red-box.png");
const CHILD_TIMEOUT_MS = 60_000;

function prerequisitesAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PDF_BIN)) return { ok: false, reason: `make-pdf binary missing (${PDF_BIN}). Run bun run build.` };
  if (!browserAvailable()) return { ok: false, reason: NO_BROWSER_REASON };
  if (!resolvePopplerTool("pdfinfo")) return { ok: false, reason: "pdfinfo not found (install poppler-utils)." };
  if (!resolvePopplerTool("pdftotext")) return { ok: false, reason: "pdftotext not found (install poppler-utils)." };
  return { ok: true };
}

const LABELS = [
  "Gate Intro", "Squatter Heading", "Custom Heading", "Duplicate Heading", "Unicode Heading",
  "Landscape Heading", "After Landscape",
  ...Array.from({ length: 48 }, (_, i) => (i % 6 === 0 ? `Chapter ${String(i + 1).padStart(2, "0")}` : `Section ${String(i + 1).padStart(2, "0")}`)),
];

function fixtureMarkdown(): string {
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(24);
  const lines = [
    "# Gate Intro", "", "Intro paragraph.", "",
    "#", "",
    `<h2 id="toc-1">Squatter Heading</h2>`, "", "Body.", "",
    `<h2 id="custom-id">Custom Heading</h2>`, "", "Body.", "",
    `<h2 id="custom-id">Duplicate Heading</h2>`, "", "Body.", "",
    `<h2 id="café-ü">Unicode Heading</h2>`, "", "Body.", "",
    "## Landscape Heading", "", "![forced](./red-box.png){page=landscape}", "",
    "## After Landscape", "", "Body.", "",
  ];
  for (const label of LABELS.slice(7)) lines.push(`${label.startsWith("Chapter") ? "#" : "##"} ${label}`, "", filler, "");
  return lines.join("\n");
}

const run = (tool: "pdfinfo" | "pdftotext", args: string[]) => execFileSync(resolvePopplerTool(tool)!, args, { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
const pageText = (pdf: string, page: number, layout = false) =>
  run("pdftotext", [...(layout ? ["-layout"] : []), "-f", String(page), "-l", String(page), pdf, "-"]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function checkToc(pdf: string): void {
  const info = run("pdfinfo", ["-f", "1", "-l", "999", pdf]);
  const boxes = [...info.matchAll(/Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/g)].map((m) => ({ page: Number(m[1]), landscape: parseFloat(m[2]) > parseFloat(m[3]) }));
  expect(boxes.length).toBeGreaterThan(10);
  expect(boxes.some((b) => b.landscape)).toBe(true);

  // The number printed beside each label, read from the TOC pages' layout text.
  const tocPages = new Set<number>();
  const printed = new Map<string, number>();
  for (const { page } of boxes) {
    const text = pageText(pdf, page, true);
    for (const label of LABELS) {
      const m = text.match(new RegExp(`^\\s*${escapeRe(label)}\\s+(\\d+)\\s*$`, "m"));
      if (!m || printed.has(label)) continue;
      printed.set(label, Number(m[1]));
      tocPages.add(page);
    }
  }
  expect([...printed.keys()]).toEqual(LABELS);
  expect(tocPages.size).toBeGreaterThanOrEqual(2); // a multi-page TOC

  // Each number names the page whose own text holds that heading.
  for (const label of LABELS) {
    const page = printed.get(label)!;
    expect(tocPages.has(page)).toBe(false);
    const lines = pageText(pdf, page).split("\n").map((l) => l.trim());
    expect({ label, page, found: lines.includes(label) }).toEqual({ label, page, found: true });
  }
  const landscapePage = boxes.find((b) => b.landscape)!.page;
  expect(printed.get("Landscape Heading")!).toBeLessThan(landscapePage);
  expect(printed.get("After Landscape")!).toBeGreaterThan(landscapePage);

  // One link per entry, in TOC order, each to a destination on its entry's page.
  const raw = fs.readFileSync(pdf);
  const links = [...raw.toString("latin1").matchAll(/\/Subtype \/Link\b[^>]*?\/Dest \/([^\s/>\]]+)/g)].map((m) => m[1]);
  expect(links).toHaveLength(LABELS.length);
  const dests = pdfDestinationPages(raw);
  const decoded = links.map((n) => decodeURIComponent(Buffer.from(n.replace(/#([0-9a-fA-F]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8")));
  expect(decoded.map((d) => dests.get(d))).toEqual(LABELS.map((l) => printed.get(l)));
  expect(new Set(decoded).size).toBe(LABELS.length);
}

describe("TOC page-number gate (#2903)", () => {
  const avail = prerequisitesAvailable();

  for (const variant of [
    { name: "cover + toc", args: ["--cover", "--toc"] },
    { name: "toc only", args: ["--toc"] },
    { name: "plain cover + toc", args: ["--cover", "--toc", "--style", "plain"] },
  ]) {
    test.skipIf(!avail.ok)(`${variant.name}: every TOC cell holds its heading's printed page and every link lands there`, () => {
      if (!avail.ok) return;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-toc-gate-"));
      try {
        fs.copyFileSync(RED_BOX, path.join(dir, "red-box.png"));
        fs.writeFileSync(path.join(dir, "toc.md"), fixtureMarkdown());
        const out = path.join(dir, "out.pdf");
        execFileSync(PDF_BIN, ["generate", path.join(dir, "toc.md"), out, "--quiet", "--title", "Gate Doc", ...variant.args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: CHILD_TIMEOUT_MS,
        });
        checkToc(out);
        if (variant.args.includes("--cover")) expect(pageText(out, 1)).not.toMatch(/CONTENTS/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }

  if (!avail.ok) {
    // A visible skip: ci-prereqs.test.ts is the CI tripwire for the binaries + poppler.
    test("toc gate prerequisites are present", () => {
      console.warn(`[skip] ${avail.reason}`);
    });
  }
});
