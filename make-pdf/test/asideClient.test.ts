/**
 * asideClient unit tests — PdfOptions → CDP Page.printToPDF mapping, the
 * staging/failure shape of renderPdf (render function injected), and the
 * no-browser classification (BrowserUnavailableError, exit 4). No live
 * browser needed.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pdfStepOptions, renderFailure, renderPdf } from "../src/asideClient";
import { BrowserUnavailableError, ExitCode } from "../src/types";
import { NO_BROWSER, NO_BROWSER_HELP, type RenderResult, type RenderSpec } from "../../lib/aside-render";

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

  test("a failed render with a browser up is a plain render error (exit 2 class), never silent", async () => {
    const failing = async (): Promise<RenderResult> => ({ ok: false, engine: "aside", outputs: [], evals: {}, stdout: "", error: "render script did not finish" });
    const err = await renderPdf("<p></p>", { output: "/tmp/never.pdf" }, failing).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toMatch(/PDF render failed: render script did not finish/);
  });

  test("no browser at all (render() found neither Aside nor the browse binary) is BrowserUnavailableError", async () => {
    const none = async (): Promise<RenderResult> => ({ ok: false, outputs: [], evals: {}, stdout: "", error: `${NO_BROWSER}: ${NO_BROWSER_HELP} (NEEDS_ASIDE: aside not on PATH)` });
    const err = await renderPdf("<p></p>", { output: "/tmp/never.pdf" }, none).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toContain("aside.com");
    expect((err as Error).message).toContain("./setup");
    expect((err as Error).message).toContain("GSTACK_BROWSE_BIN");
  });

  test("the fallback engine's failures are render errors too (engine picked ≠ engine missing)", async () => {
    const browseFail = async (): Promise<RenderResult> => ({ ok: false, engine: "browse", outputs: [], evals: {}, stdout: "", error: "browse pdf failed: boom" });
    await expect(renderPdf("<p></p>", { output: "/tmp/never.pdf" }, browseFail)).rejects.toThrow(/PDF render failed: browse pdf failed: boom/);
  });
});

describe("BrowserUnavailableError", () => {
  test("renderFailure classifies on the NO_BROWSER prefix only", () => {
    expect(renderFailure(`${NO_BROWSER}: x`)).toBeInstanceOf(BrowserUnavailableError);
    expect(renderFailure("no browser available")).toBeInstanceOf(BrowserUnavailableError);
    expect(renderFailure("Aside closed mid-run")).not.toBeInstanceOf(BrowserUnavailableError);
    expect(new BrowserUnavailableError("m").name).toBe("BrowserUnavailableError");
  });

  test("exit code 4 is no-browser (the old Aside/browse slot, same value)", () => {
    expect(ExitCode.BrowserUnavailable).toBe(4);
    expect((ExitCode as Record<string, number>).AsideUnavailable).toBeUndefined();
    expect((ExitCode as Record<string, number>).BrowseUnavailable).toBeUndefined();
  });
});
