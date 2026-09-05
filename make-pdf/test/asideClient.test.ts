/**
 * asideClient unit tests — PdfOptions → CDP Page.printToPDF mapping, the
 * staging/failure shape of renderPdf (render function injected), and the
 * AsideClientError class. No live Aside needed.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pdfStepOptions, renderPdf } from "../src/asideClient";
import { ASIDE_HELP, AsideClientError, ExitCode } from "../src/types";
import type { RenderResult, RenderSpec } from "../../lib/aside-render";

describe("pdfStepOptions", () => {
  test("defaults: Letter paper, zero margins, no header/footer, nothing else set", () => {
    const o = pdfStepOptions({ output: "/tmp/x.pdf" });
    expect(o.paperWidth).toBe(8.5);
    expect(o.paperHeight).toBe(11);
    expect([o.marginTop, o.marginRight, o.marginBottom, o.marginLeft]).toEqual([0, 0, 0, 0]);
    expect(o.displayHeaderFooter).toBeUndefined();
    expect(o.generateTaggedPDF).toBeUndefined();
    expect(o.generateDocumentOutline).toBeUndefined();
    expect(o.printBackground).toBeUndefined();
    expect(o.preferCSSPageSize).toBeUndefined();
    expect(o.waitForPagedJs).toBeUndefined();
  });

  test("named formats map to paper inches, case-insensitively", () => {
    expect(pdfStepOptions({ output: "o", format: "a4" }).paperWidth).toBeCloseTo(8.27);
    expect(pdfStepOptions({ output: "o", format: "A4" }).paperHeight).toBeCloseTo(11.7);
    expect(pdfStepOptions({ output: "o", format: "legal" }).paperHeight).toBe(14);
    expect(() => pdfStepOptions({ output: "o", format: "napkin" })).toThrow(/unknown page size/);
  });

  test("explicit width/height lengths win only when no format is given", () => {
    const o = pdfStepOptions({ output: "o", width: "10in", height: "254mm" });
    expect(o.paperWidth).toBe(10);
    expect(o.paperHeight).toBeCloseTo(10);
    const withFormat = pdfStepOptions({ output: "o", format: "letter", width: "10in", height: "10in" });
    expect(withFormat.paperWidth).toBe(8.5);
  });

  test("margins convert per side (in/pt/cm/mm/px)", () => {
    const o = pdfStepOptions({ output: "o", marginTop: "1in", marginRight: "72pt", marginBottom: "2.54cm", marginLeft: "96px" });
    expect(o.marginTop).toBe(1);
    expect(o.marginRight).toBeCloseTo(1);
    expect(o.marginBottom).toBeCloseTo(1);
    expect(o.marginLeft).toBeCloseTo(1);
  });

  test("header only: footer gets the empty <div></div> so Chromium prints no default URL/date", () => {
    const o = pdfStepOptions({ output: "o", headerTemplate: "<b>H</b>" });
    expect(o.displayHeaderFooter).toBe(true);
    expect(o.headerTemplate).toBe("<b>H</b>");
    expect(o.footerTemplate).toBe("<div></div>");
  });

  test("footer only: header gets the empty <div></div>", () => {
    const o = pdfStepOptions({ output: "o", footerTemplate: "<i>F</i>" });
    expect(o.headerTemplate).toBe("<div></div>");
    expect(o.footerTemplate).toBe("<i>F</i>");
  });

  test("pageNumbers builds the 'N of M' footer and overrides a custom footer", () => {
    const o = pdfStepOptions({ output: "o", pageNumbers: true, footerTemplate: "<i>ignored</i>" });
    expect(o.displayHeaderFooter).toBe(true);
    expect(o.headerTemplate).toBe("<div></div>");
    expect(o.footerTemplate).toContain('class="pageNumber"');
    expect(o.footerTemplate).toContain('class="totalPages"');
    expect(o.footerTemplate).not.toContain("ignored");
  });

  test("pageNumbers:false alone does not turn on header/footer", () => {
    expect(pdfStepOptions({ output: "o", pageNumbers: false }).displayHeaderFooter).toBeUndefined();
  });

  test("tagged/outline/printBackground/preferCSSPageSize/toc map to their CDP names", () => {
    const o = pdfStepOptions({ output: "o", tagged: true, outline: true, printBackground: true, preferCSSPageSize: true, toc: true });
    expect(o.generateTaggedPDF).toBe(true);
    expect(o.generateDocumentOutline).toBe(true);
    expect(o.printBackground).toBe(true);
    expect(o.preferCSSPageSize).toBe(true);
    expect(o.waitForPagedJs).toBe(true);
    // false never emits the key (CDP defaults apply)
    expect(pdfStepOptions({ output: "o", tagged: false, outline: false }).generateTaggedPDF).toBeUndefined();
  });
});

describe("renderPdf", () => {
  test("stages the HTML into a private dir, asks for one pdf step, and cleans up", async () => {
    const seen: RenderSpec[] = [];
    const fakeRender = async (spec: RenderSpec): Promise<RenderResult> => {
      seen.push(spec);
      expect(fs.readFileSync(spec.file, "utf8")).toBe("<p>hi</p>");
      return { ok: true, outputs: [], evals: {}, stdout: "" };
    };
    const out = path.join(os.tmpdir(), `aside-client-${process.pid}.pdf`);
    await renderPdf("<p>hi</p>", { output: out, format: "a4", tagged: true }, fakeRender);
    expect(seen).toHaveLength(1);
    expect(seen[0].steps).toHaveLength(1);
    const step = seen[0].steps[0];
    expect(step.kind).toBe("pdf");
    if (step.kind === "pdf") {
      expect(step.out).toBe(out);
      expect(step.options?.generateTaggedPDF).toBe(true);
      expect(step.options?.paperWidth).toBeCloseTo(8.27);
    }
    // Staging dir is gone after the render.
    expect(fs.existsSync(path.dirname(seen[0].file))).toBe(false);
  });

  test("a failed render throws (Aside error or render error), never returns silently", async () => {
    const failing = async (): Promise<RenderResult> => ({ ok: false, outputs: [], evals: {}, stdout: "", error: "render script did not finish" });
    await expect(renderPdf("<p></p>", { output: "/tmp/never.pdf" }, failing)).rejects.toThrow(/render failed|Aside/);
  });
});

describe("AsideClientError", () => {
  test("carries the probe reason and prints the matching help text", () => {
    const err = new AsideClientError("NEEDS_ASIDE", "aside not on PATH");
    expect(err.reason).toBe("NEEDS_ASIDE");
    expect(err.detail).toBe("aside not on PATH");
    expect(err.message).toContain(ASIDE_HELP.NEEDS_ASIDE);
    expect(err.message).toContain("aside.com");
    expect(err.message).toContain("aside not on PATH");
    expect(err.name).toBe("AsideClientError");
    expect(new AsideClientError("ASIDE_NOT_RUNNING", "").message).toBe(ASIDE_HELP.ASIDE_NOT_RUNNING);
  });

  test("exit code 4 is Aside-unavailable (the old browse slot, same value)", () => {
    expect(ExitCode.AsideUnavailable).toBe(4);
    expect((ExitCode as Record<string, number>).BrowseUnavailable).toBeUndefined();
  });
});
