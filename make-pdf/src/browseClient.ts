/**
 * Typed shell-out wrapper for the browse CLI.
 *
 * Every browse call goes through this file. Reasons:
 *   - One place to do binary resolution.
 *   - One place to enforce the --from-file convention for large payloads
 *     (Windows argv cap is 8191 chars; 200KB HTML dies without this).
 *   - One place that maps non-zero exit codes to typed errors.
 *
 * Binary resolution order (Codex round 2 #4):
 *   1. $BROWSE_BIN env override
 *   2. sibling dir: dirname(argv[0])/../browse/dist/browse
 *   3. ~/.claude/skills/gstack/browse/dist/browse
 *   4. PATH lookup: `browse`
 *   5. error with setup hint
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { BrowseClientError } from "./types";

export interface LoadHtmlOptions {
  html: string;                   // raw HTML string
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  tabId: number;
}

export interface PdfOptions {
  output: string;
  tabId: number;
  format?: string;
  width?: string;
  height?: string;
  marginTop?: string;
  marginRight?: string;
  marginBottom?: string;
  marginLeft?: string;
  headerTemplate?: string;
  footerTemplate?: string;
  pageNumbers?: boolean;
  tagged?: boolean;
  outline?: boolean;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  toc?: boolean;
}

export interface JsOptions {
  tabId: number;
  expression: string;             // JS expression to evaluate
}

/**
 * Locate the browse binary. Throws a BrowseClientError with a
 * canonical setup message if not found.
 */
export function resolveBrowseBin(): string {
  const envOverride = process.env.BROWSE_BIN;
  if (envOverride && isExecutable(envOverride)) return envOverride;

  // Sibling: look relative to this process's binary
  // (for when make-pdf and browse live next to each other in dist/)
  const selfDir = path.dirname(process.argv[0]);
  const siblingCandidates = [
    path.resolve(selfDir, "../browse/dist/browse"),
    path.resolve(selfDir, "../../browse/dist/browse"),
    path.resolve(selfDir, "../browse"),
  ];
  for (const candidate of siblingCandidates) {
    if (isExecutable(candidate)) return candidate;
  }

  // Global install
  const home = os.homedir();
  const globalPath = path.join(home, ".claude/skills/gstack/browse/dist/browse");
  if (isExecutable(globalPath)) return globalPath;

  // PATH lookup
  try {
    const which = execFileSync("which", ["browse"], { encoding: "utf8" }).trim();
    if (which && isExecutable(which)) return which;
  } catch {
    // `which` exited non-zero; fall through to error
  }

  throw new BrowseClientError(
    /* exitCode */ 127,
    "resolve",
    [
      "browse binary not found.",
      "",
      "make-pdf needs browse (the gstack Chromium daemon) to render PDFs.",
      "Tried:",
      `  - $BROWSE_BIN (${envOverride || "unset"})`,
      `  - sibling: ${siblingCandidates.join(", ")}`,
      `  - global: ${globalPath}`,
      "  - PATH: `browse`",
      "",
      "To fix: run gstack setup from the gstack repo:",
      "  cd ~/.claude/skills/gstack && ./setup",
      "",
      "Or set BROWSE_BIN explicitly:",
      "  export BROWSE_BIN=/path/to/browse",
    ].join("\n"),
  );
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a browse command. Returns stdout on success.
 * Throws BrowseClientError on non-zero exit.
 */
function runBrowse(args: string[]): string {
  const bin = resolveBrowseBin();
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,    // 16MB; tab content can be large
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: any) {
    const exitCode = typeof err.status === "number" ? err.status : 1;
    const stderr = typeof err.stderr === "string"
      ? err.stderr
      : (err.stderr?.toString() ?? "");
    throw new BrowseClientError(exitCode, args[0] || "unknown", stderr);
  }
}

/**
 * Write a payload to a tmp file and return the path. Used for any payload
 * >4KB to avoid Windows argv limits (Codex round 2 #3).
 *
 * Path must be under the browse safe-dirs allowlist (/tmp or cwd on
 * non-Windows; os.tmpdir on Windows).  v1.6.0.0 tightened --from-file
 * validation to close a CLI/API parity gap (PR #1103), so os.tmpdir()
 * on macOS (/var/folders/...) now fails validateReadPath.  Use the same
 * TEMP_DIR convention as browse/src/platform.ts.
 */
const PAYLOAD_TMP_DIR = process.platform === "win32" ? os.tmpdir() : "/tmp";

function writePayloadFile(payload: Record<string, unknown>): string {
  const hash = crypto.createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 12);
  const tmpPath = path.join(PAYLOAD_TMP_DIR, `make-pdf-browse-${process.pid}-${hash}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
  return tmpPath;
}

function cleanupPayloadFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* best-effort */ }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Open a new tab. Returns the tabId.
 * Requires `$B newtab --json` to be available (added in the browse flag
 * extension for this feature). If --json isn't supported yet, the fallback
 * parses "Opened tab N" from stdout.
 */
export function newtab(url?: string): number {
  const args = ["newtab"];
  if (url) args.push(url);
  // Try --json first (preferred path for programmatic use)
  try {
    const out = runBrowse([...args, "--json"]);
    const parsed = JSON.parse(out);
    if (typeof parsed.tabId === "number") return parsed.tabId;
  } catch {
    // Fall back to stdout-string parsing. Brittle, but works on older browse builds.
  }
  const out = runBrowse(args);
  const m = out.match(/tab\s+(\d+)/i);
  if (!m) throw new BrowseClientError(1, "newtab", `could not parse tab id from: ${out}`);
  return parseInt(m[1], 10);
}

/**
 * Close a tab (by id or the active tab).
 */
export function closetab(tabId?: number): void {
  const args = ["closetab"];
  if (tabId !== undefined) args.push(String(tabId));
  runBrowse(args);
}

/**
 * Load raw HTML into a specific tab.
 * Uses --from-file for any payload >4KB (Codex round 2 #3).
 */
export function loadHtml(opts: LoadHtmlOptions): void {
  // Always use --from-file to dodge argv limits. The HTML is almost always >4KB.
  const payload = {
    html: opts.html,
    waitUntil: opts.waitUntil ?? "domcontentloaded",
  };
  const payloadFile = writePayloadFile(payload);
  try {
    runBrowse([
      "load-html",
      "--from-file", payloadFile,
      "--tab-id", String(opts.tabId),
    ]);
  } finally {
    cleanupPayloadFile(payloadFile);
  }
}

/**
 * Evaluate a JS expression in a tab. Returns the serialized result as string.
 */
export function js(opts: JsOptions): string {
  return runBrowse([
    "js",
    opts.expression,
    "--tab-id", String(opts.tabId),
  ]).trim();
}

/**
 * Poll a boolean JS expression until it evaluates to true, or timeout.
 * Returns true if it succeeded, false if timed out.
 */
export function waitForExpression(opts: {
  expression: string;
  tabId: number;
  timeoutMs: number;
  pollIntervalMs?: number;
}): boolean {
  const poll = opts.pollIntervalMs ?? 200;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = js({ expression: opts.expression, tabId: opts.tabId });
      if (result === "true") return true;
    } catch {
      // Tab may still be loading; keep polling
    }
    const wait = Math.min(poll, Math.max(0, deadline - Date.now()));
    if (wait <= 0) break;
    // Synchronous sleep is fine — this only runs once per PDF render
    const end = Date.now() + wait;
    while (Date.now() < end) { /* busy wait */ }
  }
  return false;
}

/**
 * Generate a PDF from the given tab. Uses --from-file when header/footer
 * templates are present (they can be HTML strings of arbitrary size).
 */
export function pdf(opts: PdfOptions): void {
  // If any large payload is present, send via --from-file
  const hasLargePayload =
    (opts.headerTemplate && opts.headerTemplate.length > 1024) ||
    (opts.footerTemplate && opts.footerTemplate.length > 1024);

  if (hasLargePayload) {
    const payloadFile = writePayloadFile({
      output: opts.output,
      tabId: opts.tabId,
      ...optionsToPdfFlags(opts),
    });
    try {
      runBrowse(["pdf", "--from-file", payloadFile]);
    } finally {
      cleanupPayloadFile(payloadFile);
    }
    return;
  }

  // Small payload: pass flags via argv
  const args = ["pdf", opts.output, "--tab-id", String(opts.tabId)];
  pushFlagsFromOptions(args, opts);
  runBrowse(args);
}

function optionsToPdfFlags(opts: PdfOptions): Record<string, unknown> {
  // Shape mirrors what the browse `pdf` case expects when reading --from-file
  const out: Record<string, unknown> = {};
  if (opts.format) out.format = opts.format;
  if (opts.width) out.width = opts.width;
  if (opts.height) out.height = opts.height;
  if (opts.marginTop) out.marginTop = opts.marginTop;
  if (opts.marginRight) out.marginRight = opts.marginRight;
  if (opts.marginBottom) out.marginBottom = opts.marginBottom;
  if (opts.marginLeft) out.marginLeft = opts.marginLeft;
  if (opts.headerTemplate !== undefined) out.headerTemplate = opts.headerTemplate;
  if (opts.footerTemplate !== undefined) out.footerTemplate = opts.footerTemplate;
  if (opts.pageNumbers !== undefined) out.pageNumbers = opts.pageNumbers;
  if (opts.tagged !== undefined) out.tagged = opts.tagged;
  if (opts.outline !== undefined) out.outline = opts.outline;
  if (opts.printBackground !== undefined) out.printBackground = opts.printBackground;
  if (opts.preferCSSPageSize !== undefined) out.preferCSSPageSize = opts.preferCSSPageSize;
  if (opts.toc !== undefined) out.toc = opts.toc;
  return out;
}

function pushFlagsFromOptions(args: string[], opts: PdfOptions): void {
  if (opts.format) { args.push("--format", opts.format); }
  if (opts.width) { args.push("--width", opts.width); }
  if (opts.height) { args.push("--height", opts.height); }
  if (opts.marginTop) { args.push("--margin-top", opts.marginTop); }
  if (opts.marginRight) { args.push("--margin-right", opts.marginRight); }
  if (opts.marginBottom) { args.push("--margin-bottom", opts.marginBottom); }
  if (opts.marginLeft) { args.push("--margin-left", opts.marginLeft); }
  if (opts.headerTemplate !== undefined) {
    args.push("--header-template", opts.headerTemplate);
  }
  if (opts.footerTemplate !== undefined) {
    args.push("--footer-template", opts.footerTemplate);
  }
  if (opts.pageNumbers === true) args.push("--page-numbers");
  if (opts.tagged === true) args.push("--tagged");
  if (opts.outline === true) args.push("--outline");
  if (opts.printBackground === true) args.push("--print-background");
  if (opts.preferCSSPageSize === true) args.push("--prefer-css-page-size");
  if (opts.toc === true) args.push("--toc");
}
