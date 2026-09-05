/**
 * lib/aside-render.ts — render local HTML through the Aside browser.
 *
 * gstack has no browser engine of its own: the Aside AI browser (macOS 15+,
 * aside.com) is the one browser every skill drives. Local-HTML jobs that used
 * to go through the retired `browse` daemon (make-pdf's print pipeline, the
 * diagram render bundle, design previews) now go through here.
 *
 * How it works (every fact verified against Aside CLI 1.26):
 *   1. Aside refuses `file://` URLs ("Cannot navigate to a file URL without
 *      local file access"), so the HTML's directory is served over loopback
 *      with Bun.serve on an ephemeral port for the duration of ONE render.
 *   2. One `aside repl` process runs ONE generated script: open the page,
 *      wait, run the steps in order, close the tab. Nothing persists between
 *      `aside repl` calls and tabs die with the script, so a render is always
 *      a single script.
 *   3. Artifacts are written inside Aside's sandbox (`pwd` = the per-run
 *      session directory; the sandbox `fs` cannot write anywhere else), the
 *      script prints `ASIDE_DIR=<pwd>`, and this module copies them out.
 *   4. PDFs go through raw CDP `Page.printToPDF` (via `page._sendToTarget`)
 *      so header/footer templates, tagged PDF, and document outline keep
 *      working — `page.pdf()` exposes only the Playwright subset.
 *   5. Screenshots at a given width use CDP `Emulation.setDeviceMetricsOverride`
 *      (there is no `setViewportSize`).
 *   6. The CLI exit code is 0 even when the script throws; truth is the
 *      `GSTACK_RENDER_OK` sentinel on stdout. A `[error` line means failure.
 *
 * Node builtins + Bun only (bun build --compile embeds this into make-pdf).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const RENDER_SENTINEL = 'GSTACK_RENDER_OK';
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Availability ────────────────────────────────────────────────────────────

export type AsideProbe =
  | { ok: true; version: string }
  | { ok: false; reason: 'NEEDS_ASIDE' | 'ASIDE_NOT_RUNNING'; detail: string };

/** Same probe the skills run in BROWSER SETUP: binary present, app answering. */
export function probeAside(timeoutMs = 30_000): AsideProbe {
  const which = spawnSync('aside', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (which.error || which.status !== 0) {
    return { ok: false, reason: 'NEEDS_ASIDE', detail: 'the `aside` CLI is not on PATH — install the Aside browser (macOS 15+) from aside.com' };
  }
  const probe = spawnSync('aside', ['repl', 'console.log("ASIDE_READY " + pwd)'], { encoding: 'utf8', timeout: timeoutMs });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (!/^ASIDE_READY /m.test(out)) {
    return { ok: false, reason: 'ASIDE_NOT_RUNNING', detail: (out.trim() || probe.error?.message || 'no answer from the Aside app').slice(0, 400) };
  }
  return { ok: true, version: (which.stdout ?? '').trim() };
}

// ─── Spec ────────────────────────────────────────────────────────────────────

/** CDP Page.printToPDF options, plus make-pdf's Paged.js wait. Inches for paper/margins. */
export interface PdfStepOptions {
  paperWidth?: number;
  paperHeight?: number;
  landscape?: boolean;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  printBackground?: boolean;
  preferCSSPageSize?: boolean;
  generateTaggedPDF?: boolean;
  generateDocumentOutline?: boolean;
  pageRanges?: string;
  scale?: number;
  /** Wait (≤3s, non-fatal) for `window.__pagedjsAfterFired` before printing. */
  waitForPagedJs?: boolean;
}

export type RenderStep =
  | { kind: 'pdf'; out: string; options?: PdfStepOptions }
  | { kind: 'screenshot'; out: string; width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean; fullPage?: boolean; selector?: string; type?: 'png' | 'jpeg'; quality?: number }
  /**
   * Evaluate a JS expression in the page (promises are awaited). With `out`,
   * the result is written to that file: strings verbatim; `data:` URLs are
   * decoded to bytes; other values as JSON. Without `out`, the result comes
   * back in `RenderResult.evals` (strings are truncated to `maxInline` chars).
   */
  | { kind: 'eval'; expression: string; out?: string; maxInline?: number };

export interface RenderSpec {
  /** Absolute path of the HTML file to open. */
  file: string;
  /** Directory served over loopback (default: the file's directory). Must contain `file`. */
  serveRoot?: string;
  /** Readiness: a selector that must be attached, and/or an expression that must be truthy. */
  waitFor?: { selector?: string; expression?: string; timeoutMs?: number };
  steps: RenderStep[];
  /** Whole-script budget passed to the `aside repl` process. Aside caps a script at 120s. */
  timeoutMs?: number;
}

export interface RenderResult {
  ok: boolean;
  /** Files written on the caller's side, in step order (steps without `out` contribute nothing). */
  outputs: string[];
  /** Inline eval results keyed by step index. */
  evals: Record<number, string>;
  stdout: string;
  error?: string;
}

// ─── Paper + margin helpers (make-pdf's option shapes → CDP inches) ──────────

const PAPER_INCHES: Record<string, [number, number]> = {
  letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11],
  a0: [33.1, 46.8], a1: [23.4, 33.1], a2: [16.54, 23.4], a3: [11.7, 16.54], a4: [8.27, 11.7], a5: [5.83, 8.27], a6: [4.13, 5.83],
};

/** "1in" | "20mm" | "72px" | "2cm" | "12pt" | bare number (px) → inches. */
export function lengthToInches(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v / 96;
  const m = String(v).trim().match(/^([0-9]*\.?[0-9]+)\s*(in|mm|cm|px|pt)?$/i);
  if (!m) throw new Error(`unsupported length: ${v}`);
  const n = parseFloat(m[1]);
  switch ((m[2] || 'px').toLowerCase()) {
    case 'in': return n;
    case 'mm': return n / 25.4;
    case 'cm': return n / 2.54;
    case 'pt': return n / 72;
    default: return n / 96;
  }
}

/** Paper format name → [width, height] in inches; undefined for unknown names. */
export function paperInches(format: string | undefined): [number, number] | undefined {
  if (!format) return undefined;
  return PAPER_INCHES[format.toLowerCase()];
}

// ─── Script generation ───────────────────────────────────────────────────────

const HOOK = `(() => { window.__gstackErrs = window.__gstackErrs || []; const oe = console.error; console.error = (...a) => { window.__gstackErrs.push(a.map(String).join(" ")); oe.apply(console, a); }; window.addEventListener("error", e => window.__gstackErrs.push("uncaught: " + e.message)); })()`;

function artifactName(i: number, out: string): string {
  const ext = path.extname(out) || '.bin';
  return `gstack-render-${i}${ext}`;
}

export function buildRenderScript(url: string, spec: RenderSpec): string {
  const L: string[] = [];
  L.push(`const HOOK = ${JSON.stringify(HOOK)};`);
  L.push(`const pg = await openTab("about:blank");`);
  L.push(`await pg._sendToTarget("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });`);
  // "load", not Aside's default "interactive" readiness: a 9MB single-file
  // bundle (lib/diagram-render) never satisfies the interactive heuristic and
  // times out at 30s, while `load` fires in ~0.5s. Readiness is then explicit
  // via waitFor (selector attached / expression truthy).
  L.push(`await pg.goto(${JSON.stringify(url)}, { waitUntil: "load", timeout: ${spec.waitFor?.timeoutMs ?? 90_000} });`);
  const wait = spec.waitFor;
  if (wait?.selector) {
    L.push(`await pg.waitForSelector(${JSON.stringify(wait.selector)}, { state: "attached", timeout: ${wait.timeoutMs ?? 30_000} });`);
  }
  if (wait?.expression) {
    L.push(`{ const deadline = Date.now() + ${wait.timeoutMs ?? 30_000}; let ok = false; while (Date.now() < deadline) { try { ok = !!(await pg.evaluate((src) => (0, eval)(src), ${JSON.stringify(wait.expression)})); } catch (e) {} if (ok) break; await sleep(150); } if (!ok) throw new Error("waitFor expression never became truthy: " + ${JSON.stringify(wait.expression)}); }`);
  }
  spec.steps.forEach((step, i) => {
    if (step.kind === 'pdf') {
      const o = step.options ?? {};
      if (o.waitForPagedJs) {
        L.push(`{ const deadline = Date.now() + 3000; let ready = false; while (Date.now() < deadline) { try { ready = await pg.evaluate(() => !!window.__pagedjsAfterFired); } catch (e) {} if (ready) break; await sleep(150); } }`);
      }
      const cdp: Record<string, unknown> = {};
      for (const k of ['paperWidth', 'paperHeight', 'landscape', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'displayHeaderFooter', 'headerTemplate', 'footerTemplate', 'printBackground', 'preferCSSPageSize', 'generateTaggedPDF', 'generateDocumentOutline', 'pageRanges', 'scale'] as const) {
        if (o[k] !== undefined) cdp[k] = o[k];
      }
      L.push(`{ const r = await pg._sendToTarget("Page.printToPDF", ${JSON.stringify(cdp)}); await fs.writeFile(path.join(pwd, ${JSON.stringify(artifactName(i, step.out))}), Buffer.from(r.data, "base64")); console.log("STEP_OK ${i}"); }`);
    } else if (step.kind === 'screenshot') {
      const name = artifactName(i, step.out);
      const shot: Record<string, unknown> = { path: name, fullPage: step.fullPage !== false };
      if (step.type) shot.type = step.type;
      if (step.quality !== undefined) shot.quality = step.quality;
      if (step.width) {
        L.push(`await pg._sendToTarget("Emulation.setDeviceMetricsOverride", ${JSON.stringify({ width: step.width, height: step.height ?? Math.round(step.width * 0.75), deviceScaleFactor: step.deviceScaleFactor ?? 2, mobile: step.mobile ?? step.width < 1024 })}); await sleep(250);`);
      }
      if (step.selector) {
        const sel: Record<string, unknown> = { path: name };
        if (step.type) sel.type = step.type;
        L.push(`await pg.locator(${JSON.stringify(step.selector)}).screenshot(${JSON.stringify(sel)});`);
      } else {
        L.push(`await pg.screenshot(${JSON.stringify(shot)});`);
      }
      if (step.width) L.push(`await pg._sendToTarget("Emulation.clearDeviceMetricsOverride", {});`);
      L.push(`console.log("STEP_OK ${i}");`);
    } else {
      // eval: promises are awaited by evaluate; write or inline the result
      L.push(`{ const v = await pg.evaluate((src) => (0, eval)(src), ${JSON.stringify(step.expression)});`);
      if (step.out) {
        L.push(`  const name = ${JSON.stringify(artifactName(i, step.out))};`);
        L.push(`  if (typeof v === "string" && /^data:[^;]+;base64,/.test(v)) await fs.writeFile(path.join(pwd, name), Buffer.from(v.slice(v.indexOf(",") + 1), "base64"));`);
        L.push(`  else if (typeof v === "string") await fs.writeFile(path.join(pwd, name), v);`);
        L.push(`  else await fs.writeFile(path.join(pwd, name), JSON.stringify(v));`);
        L.push(`  console.log("STEP_OK ${i}"); }`);
      } else {
        const max = step.maxInline ?? 20_000;
        L.push(`  const s = typeof v === "string" ? v : JSON.stringify(v); console.log("EVAL_START ${i}"); console.log(String(s ?? "").slice(0, ${max})); console.log("EVAL_END ${i}"); console.log("STEP_OK ${i}"); }`);
      }
    }
  });
  L.push(`console.log("PAGE_ERRORS=" + JSON.stringify(await pg.evaluate(() => window.__gstackErrs || [])));`);
  L.push(`console.log("ASIDE_DIR=" + pwd);`);
  L.push(`await closeTab(pg);`);
  L.push(`console.log(${JSON.stringify(RENDER_SENTINEL)});`);
  return L.join('\n');
}

// ─── Loopback server ─────────────────────────────────────────────────────────

function serveDir(root: string): { url: string; stop: () => void } {
  const realRoot = fs.realpathSync(root);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname);
      const target = path.resolve(realRoot, '.' + pathname);
      if (!target.startsWith(realRoot + path.sep) && target !== realRoot) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return new Response('not found', { status: 404 });
      return new Response(Bun.file(target));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

// ─── Async aside spawn (keeps the loopback server's event loop free) ─────────

async function runAside(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; error?: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(['aside', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  } catch (e) {
    return { stdout: '', stderr: '', error: (e as Error).message };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  clearTimeout(timer);
  return { stdout, stderr, error: timedOut ? `timed out after ${timeoutMs}ms` : undefined };
}

// ─── Render ──────────────────────────────────────────────────────────────────

export async function renderWithAside(spec: RenderSpec): Promise<RenderResult> {
  const file = path.resolve(spec.file);
  if (!fs.existsSync(file)) return { ok: false, outputs: [], evals: {}, stdout: '', error: `HTML file not found: ${file}` };
  const root = path.resolve(spec.serveRoot ?? path.dirname(file));
  const rel = path.relative(root, file);
  if (rel.startsWith('..')) return { ok: false, outputs: [], evals: {}, stdout: '', error: `file ${file} is outside serveRoot ${root}` };

  const srv = serveDir(root);
  try {
    const url = `${srv.url}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
    const script = buildRenderScript(url, spec);
    // Async spawn: a synchronous wait would block this event loop, and the
    // loopback server above runs on it — Page.navigate would then time out.
    const proc = await runAside(['repl', script], spec.timeoutMs ?? DEFAULT_TIMEOUT_MS + 10_000);
    const stdout = `${proc.stdout}${proc.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    const evals: Record<number, string> = {};
    for (const m of stdout.matchAll(/^EVAL_START (\d+)\n([\s\S]*?)\nEVAL_END \1$/gm)) evals[Number(m[1])] = m[2];

    if (proc.error) return { ok: false, outputs: [], evals, stdout, error: `aside repl did not run: ${proc.error}` };
    if (!stdout.split('\n').some((l) => l.trim() === RENDER_SENTINEL)) {
      const errLine = stdout.split('\n').find((l) => /^(\[error|Error:|\w*Error:)/.test(l.trim())) ?? stdout.trim().split('\n').slice(-3).join(' | ');
      return { ok: false, outputs: [], evals, stdout, error: `render script did not finish: ${errLine || 'no output'}` };
    }
    const dir = stdout.match(/^ASIDE_DIR=(.+)$/m)?.[1]?.trim();
    if (!dir) return { ok: false, outputs: [], evals, stdout, error: 'render script printed no ASIDE_DIR' };

    const outputs: string[] = [];
    for (const [i, step] of spec.steps.entries()) {
      if (!('out' in step) || !step.out) continue;
      const src = path.join(dir, artifactName(i, step.out));
      if (!fs.existsSync(src)) return { ok: false, outputs, evals, stdout, error: `step ${i} produced no artifact (${src})` };
      fs.mkdirSync(path.dirname(path.resolve(step.out)), { recursive: true });
      fs.copyFileSync(src, step.out);
      outputs.push(step.out);
    }
    return { ok: true, outputs, evals, stdout };
  } finally {
    srv.stop();
  }
}

/** Where callers may stage HTML so the loopback server can reach it. */
export function renderTmpDir(): string {
  const dir = path.join(os.tmpdir(), 'gstack-render');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
