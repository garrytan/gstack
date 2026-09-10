/**
 * cli.ts error → exit code mapping, pinned through the REAL CLI process.
 *
 *   exit 0 success / 1 bad args / 2 render error / 3 Paged.js timeout / 4 no browser
 *
 * `main()` is not exported and runs only under `import.meta.main`, so the
 * catch block cannot be driven in-process. Each case spawns `bun cli.ts`
 * instead, two ways:
 *
 *   1. Stubbed orchestrator. A `--preload` file registers a Bun runtime plugin
 *      whose onLoad swaps make-pdf/src/orchestrator.ts for a module whose
 *      generate()/preview() throw a chosen error class. The stub imports
 *      BrowserUnavailableError from the same types.ts cli.ts uses, so the
 *      `instanceof` check in the catch block is exercised for real.
 *   2. No stubs. Filesystem errors that need no browser (missing input, output
 *      dir that does not exist), bad args, and fake `aside` / `browse` shell
 *      scripts reached via GSTACK_BROWSE_BIN and a scrubbed PATH. The children
 *      never see the real PATH, so no real browser is ever probed or launched.
 *
 * Exit 4 through an UNSTUBBED process is not forceable from inside this
 * checkout: resolveBrowseBin() always finds <repo>/browse/dist/browse (a
 * BROWSE_ROOTS entry computed from import.meta.dir), so the stubbed case (1)
 * is the exit-4 pin here; make-pdf/test/asideClient.test.ts covers the
 * renderFailure() classification that produces the error in the first place.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ExitCode } from "../src/types";
import { NO_BROWSER, NO_BROWSER_HELP } from "../../lib/aside-render";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(ROOT, "make-pdf", "src", "cli.ts");
const TYPES = path.join(ROOT, "make-pdf", "src", "types.ts");
const isWin = process.platform === "win32";

let tmp: string;
/** PATH for children: nothing on it (no `aside`, no `browse`, no `pdftotext`). */
let emptyBin: string;
/** PATH for children: only a fake `aside` that answers the probe but cannot run a script. */
let fakeAsideBin: string;
/** Fake browse daemon CLIs (reached via GSTACK_BROWSE_BIN, never PATH). */
let browseOk: string;
let browseRefusesNewtab: string;
let inputMd: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "make-pdf-cli-exit-"));
  emptyBin = path.join(tmp, "empty-bin");
  fs.mkdirSync(emptyBin);
  fakeAsideBin = path.join(tmp, "fake-aside-bin");
  fs.mkdirSync(fakeAsideBin);
  inputMd = path.join(tmp, "in.md");
  fs.writeFileSync(inputMd, "# Smoke\n\nOne paragraph is enough.\n", "utf8");

  if (!isWin) {
    // Answers `aside --version` and the ASIDE_READY probe like a live app, then
    // fails every render script the way an Aside release that renamed its
    // private CDP bridge would — the exact shape render() retries on browse.
    writeScript(path.join(fakeAsideBin, "aside"), [
      'case "$1" in',
      '  --version) echo "aside 1.26.0-fake" ;;',
      "  repl)",
      '    case "$2" in',
      '      *ASIDE_READY*) echo "ASIDE_READY /fake/aside/session" ;;',
      '      *) echo "ReferenceError: openTab is not defined" ;;',
      "    esac ;;",
      "esac",
      "exit 0",
    ]);
    browseOk = writeFakeBrowse("browse-ok", { pdf: true });
    browseRefusesNewtab = writeFakeBrowse("browse-refuses-newtab", { newtabFails: true });
  }
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function writeScript(file: string, body: string[]): string {
  // Builtins only (case/echo/read/printf): the children run with PATH scrubbed.
  fs.writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"), { mode: 0o755 });
  return file;
}

/**
 * A stand-in for gstack's browse daemon CLI: `newtab --json` hands out a tab,
 * `js` answers with `pageText`, and `pdf --from-file <payload>` writes a fake
 * PDF at the payload's `output` path (JSON parsed with parameter expansion).
 */
function writeFakeBrowse(name: string, opts: { pageText?: string; pdf?: boolean; newtabFails?: boolean }): string {
  const body = ['case "$1" in'];
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
  body.push("esac", "exit 0");
  return writeScript(path.join(tmp, name), body);
}

/** Hermetic child env: no real PATH, Aside skipped unless a test opts back in. */
function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: emptyBin,
    HOME: process.env.HOME ?? tmp,
    TMPDIR: os.tmpdir(),
    GSTACK_SKIP_ASIDE: "1",
    NO_COLOR: "1",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runCli(args: string[], opts: { preload?: string; env?: Record<string, string> } = {}) {
  const argv = [process.execPath, ...(opts.preload ? ["--preload", opts.preload] : []), CLI, ...args];
  const r = Bun.spawnSync(argv, { cwd: ROOT, env: opts.env ?? childEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const ORCHESTRATOR_FILTER = String.raw`make-pdf[/\\]src[/\\]orchestrator\.ts$`;

/**
 * Write a --preload file whose Bun plugin replaces the orchestrator module with
 * one whose generate()/preview() `throw <throwExpr>`. `throwExpr` may reference
 * BrowserUnavailableError (imported from the real types.ts, so instanceof holds).
 */
function stubOrchestrator(name: string, throwExpr: string): string {
  const module = [
    `import { BrowserUnavailableError } from ${JSON.stringify(TYPES)};`,
    `export const OUTPUT_TMP_DIR = ${JSON.stringify(os.tmpdir())};`,
    `export async function generate() { throw ${throwExpr}; }`,
    `export async function preview() { throw ${throwExpr}; }`,
    "",
  ].join("\n");
  const preload = [
    "// Generated by make-pdf/test/cli-exit-codes.test.ts",
    "Bun.plugin({",
    '  name: "make-pdf-test-stub-orchestrator",',
    "  setup(build) {",
    `    build.onLoad({ filter: new RegExp(${JSON.stringify(ORCHESTRATOR_FILTER)}) }, () => ({ loader: "ts", contents: ${JSON.stringify(module)} }));`,
    "  },",
    "});",
    "",
  ].join("\n");
  const file = path.join(tmp, `stub-${name}.preload.ts`);
  fs.writeFileSync(file, preload, "utf8");
  return file;
}

// ─── 1. error class → exit code (orchestrator stubbed) ────────────────────────

describe("cli.ts maps the thrown error class to the exit code (orchestrator stubbed)", () => {
  test("BrowserUnavailableError → exit 4, stderr is `$P: <message>`, stdout stays empty", () => {
    const msg = `${NO_BROWSER}: ${NO_BROWSER_HELP} (NEEDS_ASIDE: stubbed)`;
    const r = runCli(["generate", inputMd], {
      preload: stubOrchestrator("no-browser", `new BrowserUnavailableError(${JSON.stringify(msg)})`),
    });
    expect(r.code).toBe(ExitCode.BrowserUnavailable);
    expect(r.code).toBe(4);
    expect(r.stderr.trim()).toBe(`$P: ${msg}`);
    expect(r.stdout).toBe("");
  });

  test("a plain Error → exit 2 (render error): message only, the stack only with --verbose", () => {
    const preload = stubOrchestrator("render-error", `new Error("PDF render failed: render script did not finish")`);
    const quiet = runCli(["generate", inputMd], { preload });
    expect(quiet.code).toBe(ExitCode.RenderError);
    expect(quiet.code).toBe(2);
    expect(quiet.stderr.trim()).toBe("$P: PDF render failed: render script did not finish");
    expect(quiet.stdout).toBe("");

    const verbose = runCli(["generate", inputMd, "--verbose"], { preload });
    expect(verbose.code).toBe(ExitCode.RenderError);
    const lines = verbose.stderr.trim().split("\n");
    expect(lines[0]).toBe("$P: PDF render failed: render script did not finish");
    expect(lines.length).toBeGreaterThan(1); // err.stack follows
    expect(verbose.stderr).toMatch(/\bat\b/);
    expect(verbose.stdout).toBe("");
  });

  test("an ENOENT-coded error → exit 1 (bad args) with `file not found: <path>`", () => {
    const withPath = runCli(["generate", inputMd], {
      preload: stubOrchestrator("enoent-path",
        `Object.assign(new Error("ENOENT: no such file or directory, open '/x/in.md'"), { code: "ENOENT", errno: -2, syscall: "open", path: "/x/in.md" })`),
    });
    expect(withPath.code).toBe(ExitCode.BadArgs);
    expect(withPath.code).toBe(1);
    expect(withPath.stderr.trim()).toBe("$P: file not found: /x/in.md");
    expect(withPath.stdout).toBe("");

    // No `path` on the error: the message stands in.
    const noPath = runCli(["generate", inputMd], {
      preload: stubOrchestrator("enoent-nopath", `Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })`),
    });
    expect(noPath.code).toBe(ExitCode.BadArgs);
    expect(noPath.stderr.trim()).toBe("$P: file not found: ENOENT: no such file or directory");
  });

  test("an error named PagedJsTimeout → exit 3", () => {
    const r = runCli(["generate", inputMd], {
      preload: stubOrchestrator("pagedjs", `Object.assign(new Error("Paged.js did not finish within 3000ms"), { name: "PagedJsTimeout" })`),
    });
    expect(r.code).toBe(ExitCode.PagedJsTimeout);
    expect(r.code).toBe(3);
    expect(r.stderr.trim()).toBe("$P: Paged.js did not finish within 3000ms");
    expect(r.stdout).toBe("");
  });

  test("a non-Error throw is still reported (String(err)) and exits 2", () => {
    const r = runCli(["generate", inputMd], { preload: stubOrchestrator("string-throw", `"boom"`) });
    expect(r.code).toBe(ExitCode.RenderError);
    expect(r.stderr.trim()).toBe("$P: boom");
    expect(r.stdout).toBe("");
  });

  test("preview shares the same catch block: BrowserUnavailableError → exit 4", () => {
    const r = runCli(["preview", inputMd], {
      preload: stubOrchestrator("preview-no-browser", `new BrowserUnavailableError("${NO_BROWSER}: stubbed")`),
    });
    expect(r.code).toBe(ExitCode.BrowserUnavailable);
    expect(r.stderr.trim()).toBe(`$P: ${NO_BROWSER}: stubbed`);
    expect(r.stdout).toBe("");
  });
});

// ─── 2. real error paths that need no browser (no stubs) ──────────────────────

describe("cli.ts exit codes end to end (no stubs, no browser touched)", () => {
  test("a missing input is the orchestrator's own guard: exit 2 `input file not found` — NOT the ENOENT branch", () => {
    // generate() checks existsSync before any fs call can throw ENOENT, so a
    // typo'd input reads as a render error (2), not bad args (1). Pinned as-is.
    const missing = path.join(tmp, "does-not-exist.md");
    const r = runCli(["generate", missing, "--quiet"]);
    expect(r.code).toBe(ExitCode.RenderError);
    expect(r.stderr.trim()).toBe(`$P: input file not found: ${missing}`);
    expect(r.stdout).toBe("");
  });

  test("a real ENOENT (output directory does not exist; --to html needs no browser) → exit 1 `file not found`", () => {
    const out = path.join(tmp, "no-such-dir", "out.html");
    const r = runCli(["generate", inputMd, out, "--to", "html", "--quiet"]);
    expect(r.code).toBe(ExitCode.BadArgs);
    expect(r.stderr.trim()).toBe(`$P: file not found: ${out}`);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("bad args → exit 1: no input, unknown command (with usage), invalid --to", () => {
    const noInput = runCli(["generate"]);
    expect(noInput.code).toBe(ExitCode.BadArgs);
    expect(noInput.stderr).toContain("$P generate: missing <input.md>");
    expect(noInput.stdout).toBe("");

    const unknown = runCli(["frobnicate"]);
    expect(unknown.code).toBe(ExitCode.BadArgs);
    expect(unknown.stderr).toContain("$P: unknown command: frobnicate");
    expect(unknown.stderr).toContain("Usage:");
    expect(unknown.stdout).toBe("");

    const badTo = runCli(["generate", inputMd, "--to", "xml"]);
    expect(badTo.code).toBe(ExitCode.BadArgs);
    expect(badTo.stderr).toContain("invalid --to 'xml'");
    expect(badTo.stdout).toBe("");
  });

  test("exit 0 paths: no arguments prints usage (stderr); version prints VERSION on stdout only", () => {
    const usage = runCli([]);
    expect(usage.code).toBe(ExitCode.Success);
    expect(usage.stderr).toContain("Usage:");
    expect(usage.stdout).toBe("");

    const version = runCli(["version"]);
    expect(version.code).toBe(ExitCode.Success);
    expect(version.stdout.trim()).toBe(fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim());
    expect(version.stderr).toBe("");
  });
});

// ─── 3. fake browsers: success contract, render error vs no browser, mid-run note ─

describe.skipIf(isWin)("cli.ts through fake browsers (GSTACK_BROWSE_BIN + a scrubbed PATH)", () => {
  test("gstack's own browser renders: exit 0, stdout is the output path and nothing else, --quiet keeps stderr empty", () => {
    const out = path.join(tmp, "steady", "out.pdf");
    const r = runCli(["generate", inputMd, out, "--quiet"], { env: childEnv({ GSTACK_BROWSE_BIN: browseOk }) });
    expect(r.code).toBe(ExitCode.Success);
    expect(r.stdout).toBe(`${out}\n`);
    expect(r.stderr).toBe("");
    expect(fs.readFileSync(out, "utf8")).toBe("%PDF-1.4 fake\n");
  });

  test("a browser that is up but cannot render is a render error (exit 2), never `no browser` (exit 4)", () => {
    const out = path.join(tmp, "refused", "out.pdf");
    const r = runCli(["generate", inputMd, out, "--quiet"], { env: childEnv({ GSTACK_BROWSE_BIN: browseRefusesNewtab }) });
    expect(r.code).toBe(ExitCode.RenderError);
    expect(r.stderr.trim()).toBe("$P: PDF render failed: browse newtab failed: daemon refused: boom");
    expect(r.stderr).not.toContain(NO_BROWSER);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("Aside answers the probe but cannot run the script: the PDF comes from gstack's browser, stderr says so, exit 0", () => {
    const out = path.join(tmp, "mid-run", "out.pdf");
    const r = runCli(["generate", inputMd, out, "--quiet"], {
      env: childEnv({ PATH: fakeAsideBin, GSTACK_SKIP_ASIDE: undefined, GSTACK_BROWSE_BIN: browseOk }),
    });
    expect(r.code).toBe(ExitCode.Success);
    expect(r.stdout).toBe(`${out}\n`);
    expect(r.stderr).toContain("Aside was unavailable mid-run; the PDF was rendered through gstack's own browser.");
    expect(fs.readFileSync(out, "utf8")).toBe("%PDF-1.4 fake\n");
  });
});
