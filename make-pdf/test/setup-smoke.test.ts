/**
 * `$P setup` smoke flow — make-pdf/src/setup.ts runSetup() — with no real
 * browser probed or launched.
 *
 * runSetup() reads the engine through lib/aside-render's process-wide cache
 * (pickEngine() with no arguments, and render() which consults the same
 * cache), so `pickEngine(true, deps)` is the intended seam: prime it once with
 * a stubbed Aside probe and a stubbed browse-binary resolver, then call
 * runSetup(). A fake `browse` shell script plays gstack's own headless
 * browser for the [2/5] render smoke and the [4/5] smoke PDF. process.exit is
 * stubbed to throw so the exit code is observable; process.stderr.write is
 * captured for the step lines.
 *
 * Also pins renderPdf()'s return value — the engine that actually rendered —
 * which the orchestrator compares against the engine it announced.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  NO_BROWSER,
  NO_BROWSER_HELP,
  pickEngine,
  renderTmpDir,
  type AsideProbe,
  type RenderResult,
  type RenderSpec,
} from "../../lib/aside-render";
import { renderPdf } from "../src/asideClient";
import { OUTPUT_TMP_DIR } from "../src/orchestrator";
import { runSetup } from "../src/setup";
import { ExitCode } from "../src/types";

const isWin = process.platform === "win32";
const PROBE_DETAIL = "primed by setup-smoke.test.ts";
const noAside = (): AsideProbe => ({ ok: false, reason: "NEEDS_ASIDE", detail: PROBE_DETAIL });

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-setup-smoke-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  // The engine cache is process-wide. The free runner gives every test file
  // its own process, but under a bare multi-file `bun test` a later in-process
  // caller must not inherit a fake binary that no longer exists: re-resolve
  // gstack's real browse binary (Aside probe still stubbed — never a round-trip).
  pickEngine(true, { probe: noAside });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ExitSentinel";
  }
}

/** Run `fn` with process.exit throwing a sentinel and process.stderr.write captured. Restores both. */
async function captureRun<T>(fn: () => Promise<T>): Promise<{ result?: T; exit?: number; error?: unknown; stderr: string }> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write;
  const origExit = process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as typeof process.exit;
  try {
    const result = await fn();
    return { result, stderr: chunks.join("") };
  } catch (e) {
    if (e instanceof ExitSentinel) return { exit: e.code, stderr: chunks.join("") };
    return { error: e, stderr: chunks.join("") };
  } finally {
    process.stderr.write = origWrite;
    process.exit = origExit;
  }
}

/**
 * A stand-in for gstack's browse daemon CLI: `newtab --json` hands out a tab,
 * `js` answers with `pageText`, `pdf --from-file <payload>` writes a fake PDF
 * at the payload's `output` path when `pdf` is set (and nothing otherwise).
 */
function writeFakeBrowse(name: string, opts: { pageText?: string; pdf?: boolean; newtabFails?: boolean }): string {
  const body = ["#!/bin/sh", 'case "$1" in'];
  body.push(opts.newtabFails
    ? '  newtab) echo "daemon refused: boom" >&2; exit 1 ;;'
    : `  newtab) echo '{"tabId":7}' ;;`);
  body.push(`  js) echo '${opts.pageText ?? "browser-ok"}' ;;`);
  if (opts.pdf) {
    body.push(
      "  pdf)",
      '    read -r payload < "$3"',
      '    out="${payload#*\\"output\\":\\"}"',
      '    out="${out%%\\"*}"',
      "    printf '%%PDF-1.4 fake\\n' > \"$out\"",
      "    ;;",
    );
  }
  body.push("esac", "exit 0", "");
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body.join("\n"), { mode: 0o755 });
  return file;
}

/** The [2/5] smoke staging dirs currently under renderTmpDir(). */
function smokeDirs(stage: string): string[] {
  return fs.readdirSync(stage).filter((n) => n.startsWith("make-pdf-setup-")).sort();
}

const smokePdf = () => path.join(OUTPUT_TMP_DIR, `make-pdf-smoke-${process.pid}.pdf`);
const smokeFixture = () => path.join(OUTPUT_TMP_DIR, `make-pdf-smoke-${process.pid}.md`);

// ─── [1/5] browser check ──────────────────────────────────────────────────────

describe("runSetup [1/5]: no browser at all", () => {
  test("Aside absent and no browse binary: FAIL, the NO_BROWSER text with both remedies, exit 4, never reaches [2/5]", async () => {
    pickEngine(true, { probe: noAside, resolveBin: () => null });
    const run = await captureRun(() => runSetup());
    expect(run.error).toBeUndefined();
    expect(run.exit).toBe(ExitCode.BrowserUnavailable);
    expect(run.exit).toBe(4);
    expect(run.stderr).toContain("make-pdf setup — verifying install");
    expect(run.stderr).toContain("[1/5] Checking for a browser... FAIL");
    expect(run.stderr).toContain(NO_BROWSER);
    expect(run.stderr).toContain("no browser available");
    expect(run.stderr).toContain(NO_BROWSER_HELP);
    expect(run.stderr).toContain(`(NEEDS_ASIDE: ${PROBE_DETAIL})`);
    expect(run.stderr).not.toContain("[2/5]");
  });
});

// ─── [2/5] render smoke through the fallback browser ──────────────────────────

describe.skipIf(isWin)("runSetup [2/5]: render smoke through gstack's own browser", () => {
  test("a browser that answers but the page text is wrong: FAIL, `could not render a page` + remedy, exit 4, smoke dir removed", async () => {
    const fake = writeFakeBrowse("browse-wrong-text", { pageText: "not-the-smoke-page" });
    pickEngine(true, { probe: noAside, resolveBin: () => fake });
    const stage = renderTmpDir();
    const before = smokeDirs(stage);

    const run = await captureRun(() => runSetup());
    expect(run.error).toBeUndefined();
    expect(run.exit).toBe(ExitCode.BrowserUnavailable);
    expect(run.stderr).toContain(`[1/5] Checking for a browser... gstack browser OK (fallback: ${fake}; Aside is not running)`);
    expect(run.stderr).toContain("[2/5] Rendering through gstack browser... FAIL");
    expect(run.stderr).toContain("gstack browser could not render a page: unexpected page text: not-the-smoke-page");
    expect(run.stderr).toContain(`To fix: ${NO_BROWSER_HELP}`);
    expect(run.stderr).toContain("open the Aside app");
    expect(run.stderr).toContain("./setup");
    expect(run.stderr).not.toContain("[3/5]");
    expect(smokeDirs(stage)).toEqual(before); // finally { rmSync(smokeDir) } ran despite the exit
  });

  test("a daemon that refuses to open a tab surfaces browse's own error on the same FAIL path (exit 4)", async () => {
    const fake = writeFakeBrowse("browse-refuses-newtab", { newtabFails: true });
    pickEngine(true, { probe: noAside, resolveBin: () => fake });
    const stage = renderTmpDir();
    const before = smokeDirs(stage);

    const run = await captureRun(() => runSetup());
    expect(run.exit).toBe(ExitCode.BrowserUnavailable);
    expect(run.stderr).toContain("[2/5] Rendering through gstack browser... FAIL");
    expect(run.stderr).toContain("gstack browser could not render a page: browse newtab failed: daemon refused: boom");
    expect(run.stderr).toContain(`To fix: ${NO_BROWSER_HELP}`);
    expect(smokeDirs(stage)).toEqual(before);
  });
});

// ─── [3/5]–[5/5] the rest of the flow with a fake browser ─────────────────────

describe.skipIf(isWin)("runSetup [3/5]-[5/5]: pdftotext, smoke PDF, cheatsheet", () => {
  test("happy path: every step reports, the smoke PDF lands at OUTPUT_TMP_DIR, the fixture is removed, no exit", async () => {
    const fake = writeFakeBrowse("browse-happy", { pageText: "browser-ok", pdf: true });
    pickEngine(true, { probe: noAside, resolveBin: () => fake });
    const outPath = smokePdf();
    const fixturePath = smokeFixture();
    try {
      const run = await captureRun(() => runSetup());
      expect(run.error).toBeUndefined();
      expect(run.exit).toBeUndefined();
      expect(run.stderr).toContain(`[1/5] Checking for a browser... gstack browser OK (fallback: ${fake}; Aside is not running)`);
      expect(run.stderr).toContain("[2/5] Rendering through gstack browser... OK");
      // pdftotext is optional: OK where poppler is installed, SKIP with install hints otherwise.
      expect(run.stderr).toMatch(/\[3\/5\] Checking pdftotext \(optional\)\.\.\. (OK \(|SKIP\n)/);
      expect(run.stderr).toContain("[4/5] Generating smoke-test PDF...");
      expect(run.stderr).toContain(`PASSED. Smoke test saved to ${outPath}`);
      expect(run.stderr).toContain("[5/5] All checks passed.");
      expect(run.stderr).toContain("make-pdf is ready. Try:");
      expect(run.stderr).toContain(`Smoke-test PDF: ${outPath}`);
      // The announced engine (browse) is the one that rendered: no mid-run note.
      expect(run.stderr).not.toContain("mid-run");
      expect(fs.readFileSync(outPath, "utf8")).toBe("%PDF-1.4 fake\n");
      expect(fs.existsSync(fixturePath)).toBe(false);
    } finally {
      fs.rmSync(outPath, { force: true });
      fs.rmSync(fixturePath, { force: true });
    }
  });

  test("[4/5] smoke PDF failure (browser up, print produced nothing): FAILED with the render error, exit 2, fixture removed", async () => {
    // Same fake, but `pdf` writes no artifact — a render error, not a missing browser.
    const fake = writeFakeBrowse("browse-no-artifact", { pageText: "browser-ok", pdf: false });
    pickEngine(true, { probe: noAside, resolveBin: () => fake });
    const outPath = smokePdf();
    const fixturePath = smokeFixture();
    try {
      const run = await captureRun(() => runSetup());
      expect(run.error).toBeUndefined();
      expect(run.exit).toBe(ExitCode.RenderError);
      expect(run.exit).toBe(2);
      expect(run.stderr).toContain("[2/5] Rendering through gstack browser... OK");
      expect(run.stderr).toContain("[4/5] Generating smoke-test PDF...");
      expect(run.stderr).toContain("        FAILED: PDF render failed: step 0 produced no artifact");
      expect(run.stderr).not.toContain("[5/5]");
      expect(fs.existsSync(outPath)).toBe(false);
      expect(fs.existsSync(fixturePath)).toBe(false); // finally { unlinkSync(fixturePath) } ran despite the exit
    } finally {
      fs.rmSync(outPath, { force: true });
      fs.rmSync(fixturePath, { force: true });
    }
  });
});

// ─── renderPdf returns the engine that rendered ───────────────────────────────

describe("renderPdf reports which engine rendered", () => {
  const injected = (engine: RenderResult["engine"]) => async (spec: RenderSpec): Promise<RenderResult> => {
    const step = spec.steps[0];
    return { ok: true, engine, outputs: step.kind === "pdf" ? [step.out] : [], evals: {}, stdout: "" };
  };

  test("resolves 'browse' when gstack's own browser printed the PDF", async () => {
    await expect(renderPdf("<p>x</p>", { output: path.join(tmp, "browse.pdf") }, injected("browse"))).resolves.toBe("browse");
  });

  test("resolves 'aside' when Aside printed it", async () => {
    await expect(renderPdf("<p>x</p>", { output: path.join(tmp, "aside.pdf") }, injected("aside"))).resolves.toBe("aside");
  });

  test("resolves undefined when the result names no engine (older render shapes)", async () => {
    await expect(renderPdf("<p>x</p>", { output: path.join(tmp, "none.pdf") }, injected(undefined))).resolves.toBeUndefined();
  });

  test("a failed result still throws (the engine is never returned for a failure)", async () => {
    const failing = async (): Promise<RenderResult> => ({ ok: false, engine: "browse", outputs: [], evals: {}, stdout: "", error: "browse pdf failed: boom" });
    await expect(renderPdf("<p>x</p>", { output: path.join(tmp, "fail.pdf") }, failing)).rejects.toThrow(/PDF render failed: browse pdf failed: boom/);
  });
});
