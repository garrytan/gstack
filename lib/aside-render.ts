/**
 * lib/aside-render.ts — render local HTML through a browser: Aside first,
 * gstack's own headless browser as the fallback.
 *
 * The Aside AI browser (macOS 15+, aside.com) is the primary browser for
 * every skill. When it is not installed or not running (Linux, Windows, a
 * closed app), the same RenderSpec runs through the `browse` daemon (gstack's
 * Playwright/Chromium engine, built by ./setup) — `render()` picks the engine,
 * `RenderResult.engine` says which one ran. Local-HTML jobs (make-pdf's print
 * pipeline, the diagram render bundle, design previews) all come through here.
 *
 * How the Aside path works (every fact verified against Aside CLI 1.26):
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
 * How the browse path works: the same loopback server (so relative fetches
 * and assets behave identically), then one daemon CLI call per action —
 * `newtab --json`, `goto`, `js` polling for readiness, `pdf --from-file`,
 * `viewport` + `screenshot`, `js --out` (the daemon decodes data: URLs), and
 * `closetab` in a finally. Artifacts are written under /tmp (the daemon's
 * safe-dirs policy) and copied to the caller's paths. The console-error
 * bookkeeping is best-effort: after a `cookie-import` the daemon refuses `js`
 * on other origins, and a pdf/screenshot-only spec must still print. Not
 * mirrored on this path: pageRanges/scale, screenshot quality, the 2x default
 * device scale.
 *
 * Node builtins + Bun only (bun build --compile embeds this into make-pdf).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const RENDER_SENTINEL = 'GSTACK_RENDER_OK';
const DEFAULT_TIMEOUT_MS = 120_000;
/** Slack over the script budget so the `aside repl` process can wind down before we kill it. */
const ASIDE_PROCESS_SLACK_MS = 10_000;
/** Default budget for a waitFor selector/expression, on either engine. */
const DEFAULT_WAIT_MS = 30_000;
/** Default cap (chars) on an inline eval result. */
const DEFAULT_MAX_INLINE = 20_000;
/** Screenshot height when only a width is given (4:3). */
const DEFAULT_ASPECT = 0.75;
/** Widths at or below this emulate a mobile device. */
const MOBILE_MAX_WIDTH = 1024;
/** Device scale for sized screenshots on the Aside path (the daemon keeps its own scale: a change there rebuilds its context). */
const DEFAULT_DEVICE_SCALE = 2;
/** The page-number footer shared by make-pdf, gstack-render and the browse `pdf` command. */
export const PAGE_NUMBER_FOOTER = '<div style="font-size:9pt; font-family:Helvetica,Arial,sans-serif; color:#666; width:100%; text-align:center;"><span class="pageNumber"></span> of <span class="totalPages"></span></div>';

// ─── Availability ────────────────────────────────────────────────────────────

export type AsideProbe =
  | { ok: true; version: string }
  | { ok: false; reason: 'NEEDS_ASIDE' | 'ASIDE_NOT_RUNNING'; detail: string };

/** Same probe the skills run in BROWSER SETUP: binary present, app answering. */
export function probeAside(timeoutMs = 30_000): AsideProbe {
  if (process.env.GSTACK_SKIP_ASIDE === '1') {
    return { ok: false, reason: 'NEEDS_ASIDE', detail: 'GSTACK_SKIP_ASIDE=1 — Aside skipped by request' };
  }
  const which = spawnSync('aside', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (which.error) {
    return { ok: false, reason: 'NEEDS_ASIDE', detail: 'the `aside` CLI is not on PATH — install the Aside browser (macOS 15+) from aside.com' };
  }
  if (which.status !== 0) {
    // Present but not answering: the same class the skills' bash probe reports
    // (open or repair the app), never "install it".
    return { ok: false, reason: 'ASIDE_NOT_RUNNING', detail: `\`aside --version\` exited ${which.status}: ${(which.stderr || which.stdout || '').trim().slice(0, 300) || 'no output'}` };
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

export type RenderEngine = 'aside' | 'browse';

export interface RenderResult {
  ok: boolean;
  /** Which browser ran the spec (absent when none could). */
  engine?: RenderEngine;
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
  L.push(`await pg.goto(${JSON.stringify(url)}, { waitUntil: "load", timeout: ${Math.min(90_000, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)} });`);
  const wait = spec.waitFor;
  if (wait?.selector) {
    L.push(`await pg.waitForSelector(${JSON.stringify(wait.selector)}, { state: "attached", timeout: ${wait.timeoutMs ?? DEFAULT_WAIT_MS} });`);
  }
  if (wait?.expression) {
    L.push(`{ const deadline = Date.now() + ${wait.timeoutMs ?? DEFAULT_WAIT_MS}; let ok = false; while (Date.now() < deadline) { try { ok = !!(await pg.evaluate((src) => (0, eval)(src), ${JSON.stringify(wait.expression)})); } catch (e) {} if (ok) break; await sleep(150); } if (!ok) throw new Error("waitFor expression never became truthy: " + ${JSON.stringify(wait.expression)}); }`);
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
        L.push(`await pg._sendToTarget("Emulation.setDeviceMetricsOverride", ${JSON.stringify({ width: step.width, height: step.height ?? Math.round(step.width * DEFAULT_ASPECT), deviceScaleFactor: step.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE, mobile: step.mobile ?? step.width <= MOBILE_MAX_WIDTH })}); await sleep(250);`);
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
        const max = step.maxInline ?? DEFAULT_MAX_INLINE;
        // One base64 line: the value is page-controlled text, and a newline in it
        // must never be able to forge ASIDE_DIR= or the sentinel below.
        L.push(`  const s = typeof v === "string" ? v : JSON.stringify(v); console.log("EVAL ${i} " + Buffer.from(String(s ?? "").slice(0, ${max}), "utf8").toString("base64")); console.log("STEP_OK ${i}"); }`);
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

/**
 * Serve `root` on 127.0.0.1 for one render. The URL carries a per-render secret
 * as its first path segment: a local process that does not know it gets 404 for
 * everything, so the render window exposes nothing to neighbours on the box.
 * Containment is checked on the REAL path (symlinks are followed only when they
 * stay inside the root), and directories are never listed.
 */
export function serveDir(root: string, nonce: string = randomBytes(16).toString('hex')): { url: string; stop: () => void } {
  const realRoot = fs.realpathSync(root);
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const inside = (p: string) => p === realRoot || p.startsWith(prefix);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response('bad request', { status: 400 }); }
      if (!pathname.startsWith(`/${nonce}/`)) return new Response('not found', { status: 404 });
      pathname = pathname.slice(nonce.length + 1);
      const target = path.resolve(realRoot, '.' + pathname);
      if (!inside(target)) return new Response('forbidden', { status: 403 });
      let real: string;
      try { real = fs.realpathSync(target); } catch { return new Response('not found', { status: 404 }); }
      if (!inside(real)) return new Response('forbidden', { status: 403 });
      if (fs.statSync(real).isDirectory()) return new Response('not found', { status: 404 });
      return new Response(Bun.file(real));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/${nonce}`, stop: () => server.stop(true) };
}

// ─── Async spawn (keeps the loopback server's event loop free) ────────────────

async function runProc(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  } catch (e) {
    return { code: null, stdout: '', stderr: '', error: (e as Error).message };
  }
  let timedOut = false;
  // Every timer is tracked and cleared on exit: a dangling one keeps the event
  // loop alive and a CLI with no explicit process.exit (gstack-render) would sit
  // for up to timeoutMs after printing its result.
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
  after(timeoutMs, () => { timedOut = true; try { child.kill(); } catch {} });
  // A child that ignores SIGTERM (a CLI blocked on its app) gets SIGKILL; a
  // grandchild holding the pipes open must not hang the render either.
  after(timeoutMs + 5_000, () => { try { child.kill('SIGKILL'); } catch {} });
  const read = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const giveUp = new Promise<[string, string]>((resolve) => after(timeoutMs + 10_000, () => resolve(['', ''])));
  const [stdout, stderr] = await Promise.race([read, giveUp]);
  // Pipes at EOF means the child is exiting; wait for the exit code until the
  // SIGKILL above has had its turn. A flat 5s bound here once failed a CI render
  // whose fake had already written its artifact — under a 6-shard load the
  // reaper needed longer than that, and a null code reads as a failed command.
  const code = await Promise.race([child.exited, new Promise<null>((resolve) => after(timeoutMs + 6_000, () => resolve(null)))]);
  for (const t of timers) clearTimeout(t);
  return { code, stdout, stderr, error: timedOut ? `timed out after ${timeoutMs}ms` : undefined };
}

// ─── Render: Aside ───────────────────────────────────────────────────────────

export async function renderWithAside(spec: RenderSpec): Promise<RenderResult> {
  return { ...(await asideRender(spec)), engine: 'aside' };
}

async function asideRender(spec: RenderSpec): Promise<RenderResult> {
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
    const proc = await runProc('aside', ['repl', script], (spec.timeoutMs ?? DEFAULT_TIMEOUT_MS) + ASIDE_PROCESS_SLACK_MS);
    const stdout = `${proc.stdout}${proc.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    const evals: Record<number, string> = {};
    for (const m of stdout.matchAll(/^EVAL (\d+) ([A-Za-z0-9+/=]*)$/gm)) evals[Number(m[1])] = Buffer.from(m[2], 'base64').toString('utf8');

    if (proc.error) return { ok: false, outputs: [], evals, stdout, error: `aside repl did not run: ${proc.error}` };
    if (!stdout.split('\n').some((l) => l.trim() === RENDER_SENTINEL)) {
      const errLine = stdout.split('\n').find((l) => /^(\[error|Error:|\w*Error:)/.test(l.trim())) ?? stdout.trim().split('\n').slice(-3).join(' | ');
      return { ok: false, outputs: [], evals, stdout, error: `render script did not finish: ${errLine || 'no output'} (GSTACK_SKIP_ASIDE=1 forces gstack's own browser)` };
    }
    // Control lines are ours alone (eval output is one base64 token, PAGE_ERRORS
    // is one JSON line); still take the LAST ASIDE_DIR so nothing earlier wins.
    const dirs = [...stdout.matchAll(/^ASIDE_DIR=(.+)$/gm)];
    const dir = dirs.length ? dirs[dirs.length - 1][1].trim() : undefined;
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
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  // Ours: a real directory we own. Anything else at the shared name (another
  // user's directory, a planted symlink) is never staged into — fall back to a
  // private mkdtemp so a neighbour on the box cannot swap files under a render.
  const ours = (): boolean => {
    try { const st = fs.lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid); } catch { return false; }
  };
  if (ours()) return dir;
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch { /* exists or unwritable — decided below */ }
  return ours() ? dir : fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-'));
}

// ─── Render: browse (gstack's own headless browser, the fallback) ────────────

/** Roots that may hold browse/dist/browse or the browse/bin/find-browse shim. */
const BROWSE_ROOTS = [
  path.resolve(import.meta.dir, '..'),                    // repo checkout: lib/ → root
  path.resolve(path.dirname(process.execPath), '../..'),  // compiled make-pdf/dist/pdf → root (repo and global install alike)
  path.join(os.homedir(), '.claude/skills/gstack'),
];
/** The daemon only reads/writes under its safe dirs; /tmp is always one of them. */
export const SAFE_TMP_DIR = process.platform === 'win32' ? os.tmpdir() : '/tmp';

/** A regular, executable file — probing .exe/.cmd/.bat on Windows, where X_OK degrades to an existence check. */
function executable(p: string): string | null {
  for (const c of process.platform === 'win32' ? [p, `${p}.exe`, `${p}.cmd`, `${p}.bat`] : [p]) {
    try {
      if (fs.statSync(c).isFile()) { fs.accessSync(c, fs.constants.X_OK); return c; }
    } catch { /* next candidate */ }
  }
  return null;
}

/**
 * Locate gstack's own browse binary: $GSTACK_BROWSE_BIN → $BROWSE_BIN →
 * <root>/browse/dist/browse → <root>/browse/bin/find-browse (per root, repo
 * then install) → `browse` on PATH. Null when nothing resolves.
 */
export function resolveBrowseBin(env: NodeJS.ProcessEnv = process.env, roots: string[] = BROWSE_ROOTS): string | null {
  const PATH = env.PATH ?? env.Path ?? '';
  const override = (env.GSTACK_BROWSE_BIN ?? env.BROWSE_BIN ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (override) {
    const found = path.isAbsolute(override) ? executable(override) : Bun.which(override, { PATH });
    if (found) return found;
  }
  for (const root of roots) {
    const built = executable(path.join(root, 'browse/dist/browse'));
    if (built) return built;
    const shim = executable(path.join(root, 'browse/bin/find-browse'));
    if (!shim) continue;
    const r = spawnSync(shim, [], { encoding: 'utf8', timeout: 10_000 });
    const found = r.status === 0 ? executable((r.stdout ?? '').trim()) : null;
    if (found) return found;
  }
  return Bun.which('browse', { PATH }) ?? null;
}

/** PdfStepOptions (CDP, inches) → the browse `pdf --from-file` payload (Playwright shapes, string lengths). */
export function browsePdfPayload(o: PdfStepOptions, output: string): Record<string, unknown> {
  const p: Record<string, unknown> = { output };
  let [w, h] = [o.paperWidth, o.paperHeight];
  if (o.landscape) [w, h] = [h ?? 11, w ?? 8.5]; // browse has no landscape flag: swap (Letter when unset)
  if (w !== undefined && h !== undefined) { p.width = `${w}in`; p.height = `${h}in`; }
  for (const k of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const) {
    if (o[k] !== undefined) p[k] = `${o[k]}in`;
  }
  if (o.displayHeaderFooter) {
    p.headerTemplate = o.headerTemplate ?? '<div></div>';
    p.footerTemplate = o.footerTemplate ?? '<div></div>';
  }
  if (o.generateTaggedPDF) p.tagged = true;
  if (o.generateDocumentOutline) p.outline = true;
  if (o.printBackground) p.printBackground = true;
  if (o.preferCSSPageSize) p.preferCSSPageSize = true;
  if (o.waitForPagedJs) p.toc = true;
  return p;
}

type ScreenshotStep = Extract<RenderStep, { kind: 'screenshot' }>;

/** Screenshot step → browse `screenshot` args (the path's extension picks png/jpeg). */
export function browseScreenshotArgs(step: ScreenshotStep, output: string): string[] {
  const args = ['screenshot'];
  if (step.fullPage === false) args.push('--viewport');
  if (step.selector) args.push('--selector', step.selector);
  args.push(output);
  return args;
}

function screenshotName(i: number, step: ScreenshotStep): string {
  const ext = step.type === 'jpeg' ? '.jpg' : step.type === 'png' ? '.png' : (path.extname(step.out) || '.png');
  return `gstack-render-${i}${ext}`;
}

/**
 * Run a RenderSpec through the browse daemon. Same loopback server as the
 * Aside path, one CLI call per action, artifacts staged under /tmp and copied
 * to the caller's paths. The tab is closed in a finally; the daemon stays up.
 */
export async function renderWithBrowse(spec: RenderSpec, bin: string | null = resolveBrowseBin()): Promise<RenderResult> {
  const outputs: string[] = [];
  const evals: Record<number, string> = {};
  const log: string[] = [];
  const fail = (error: string): RenderResult => ({ ok: false, engine: 'browse', outputs, evals, stdout: log.join('\n'), error });
  if (!bin) return fail(`${NO_BROWSER}: ${NO_BROWSER_HELP}`);
  const file = path.resolve(spec.file);
  if (!fs.existsSync(file)) return fail(`HTML file not found: ${file}`);
  const root = path.resolve(spec.serveRoot ?? path.dirname(file));
  const rel = path.relative(root, file);
  if (rel.startsWith('..')) return fail(`file ${file} is outside serveRoot ${root}`);

  const deadline = Date.now() + (spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const run = async (args: string[]): Promise<string> => {
    const r = await runProc(bin, args, Math.max(1_000, Math.min(120_000, deadline - Date.now())));
    log.push(`$ browse ${args.join(' ').slice(0, 300)}\n${r.stdout}${r.stderr}`.trim());
    if (r.error || r.code !== 0) {
      const first = (r.stderr || r.stdout || r.error || '').trim().split('\n')[0];
      if (/JS execution blocked/.test(`${r.stderr}${r.stdout}`)) {
        // After `$B cookie-import` the daemon refuses page JS on every other
        // origin, 127.0.0.1 included; a local-HTML render cannot proceed in it.
        throw new Error(`browse ${args[0]} refused: the daemon has imported cookies and blocks page JS on other origins (127.0.0.1 included) — restart it ($B stop) before rendering local HTML, or open Aside`);
      }
      throw new Error(`browse ${args[0]} failed: ${first}`);
    }
    return r.stdout;
  };
  const copyOut = (src: string, out: string, i: number) => {
    if (!fs.existsSync(src)) throw new Error(`step ${i} produced no artifact (${src})`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.copyFileSync(src, out);
    outputs.push(out);
  };

  let work: string | undefined;
  let srv: { url: string; stop: () => void } | undefined;
  let tab: number | undefined;
  try {
    work = fs.mkdtempSync(path.join(SAFE_TMP_DIR, 'gstack-render-browse-'));
    srv = serveDir(root);
    // The first CLI call auto-starts the daemon; on a cold start it can answer
    // "Unable to connect" once while the server is still coming up. One retry
    // after a short pause turns that into the wait it really is.
    const openTab = async () => (await run(['newtab', '--json'])).match(/\{[^\n]*"tabId"[^\n]*\}/)?.[0];
    let opened: string | undefined;
    try {
      opened = await openTab();
    } catch (e) {
      if (!/Unable to connect/.test((e as Error).message)) throw e;
      log.push('newtab: daemon not up yet — retrying once');
      await Bun.sleep(1_500);
      opened = await openTab();
    }
    tab = opened ? JSON.parse(opened).tabId : undefined;
    if (typeof tab !== 'number') throw new Error('browse newtab --json returned no tabId');
    const T = ['--tab-id', String(tab)];
    const js = async (expr: string, extra: string[] = []) => (await run(['js', expr, ...extra, ...T])).replace(/\n$/, '');
    // Poll until truthy. A throw inside the page (e.g. `window.later.ok` before
    // `later` exists) is "not yet", exactly as the Aside script treats it —
    // never a render failure. `run` still throws when the daemon itself refuses.
    const until = async (expr: string, what: string, timeoutMs: number) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if ((await js(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`)) === 'true') return;
        await Bun.sleep(150);
      }
      throw new Error(`${what} (waited ${timeoutMs}ms)`);
    };

    await run(['goto', `${srv.url}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`, ...T]);
    // Best-effort: once `$B cookie-import` has run, the daemon blocks `js` on
    // every other origin (127.0.0.1 included). pdf/screenshot/`js --out` steps
    // must still run; a waitFor or eval step that is genuinely blocked fails
    // below with the daemon's own message.
    const bestEffortJs = async (expr: string, what: string) => { try { return await js(expr); } catch (e) { log.push(`${what} unavailable: ${(e as Error).message}`); return null; } };
    // Known divergence from the Aside path: the daemon exposes no
    // pre-navigation hook, so errors logged during load are not captured here.
    await bestEffortJs(HOOK, 'console hook');
    const wait = spec.waitFor;
    if (wait?.selector) await until(`document.querySelector(${JSON.stringify(wait.selector)})`, `waitFor selector never attached: ${wait.selector}`, wait.timeoutMs ?? DEFAULT_WAIT_MS);
    if (wait?.expression) await until(wait.expression, `waitFor expression never became truthy: ${wait.expression}`, wait.timeoutMs ?? DEFAULT_WAIT_MS);

    for (const [i, step] of spec.steps.entries()) {
      if (step.kind === 'pdf') {
        const tmp = path.join(work, artifactName(i, step.out));
        const payload = path.join(work, `pdf-${i}.json`);
        fs.writeFileSync(payload, JSON.stringify(browsePdfPayload(step.options ?? {}, tmp)));
        await run(['pdf', '--from-file', payload, ...T]);
        copyOut(tmp, step.out, i);
      } else if (step.kind === 'screenshot') {
        const tmp = path.join(work, screenshotName(i, step));
        if (step.width) {
          const vp = [`${step.width}x${step.height ?? Math.round(step.width * DEFAULT_ASPECT)}`];
          // `--scale` recreates the daemon's browser context (and is refused in
          // headed mode), so it is passed only when the caller asked for it; the
          // 2x default stays Aside-only (see the header's "not mirrored" list).
          if (step.deviceScaleFactor) vp.push('--scale', String(step.deviceScaleFactor));
          await run(['viewport', ...vp, ...T]);
        }
        await run([...browseScreenshotArgs(step, tmp), ...T]);
        copyOut(tmp, step.out, i);
        // Aside clears its device override after each shot; restore the daemon's
        // default so a later un-sized screenshot is not taken at this width.
        if (step.width) await run(['viewport', '1280x720', ...T]);
      } else if (step.out) {
        const tmp = path.join(work, artifactName(i, step.out));
        await js(step.expression, ['--out', tmp]); // the daemon decodes data: URLs to bytes itself
        copyOut(tmp, step.out, i);
      } else {
        evals[i] = (await js(step.expression)).slice(0, step.maxInline ?? DEFAULT_MAX_INLINE);
      }
    }
    const errs = await bestEffortJs('JSON.stringify(window.__gstackErrs || [])', 'PAGE_ERRORS');
    if (errs !== null) log.push(`PAGE_ERRORS=${errs}`);
    return { ok: true, engine: 'browse', outputs, evals, stdout: log.join('\n') };
  } catch (e) {
    return fail((e as Error).message);
  } finally {
    if (tab !== undefined) await runProc(bin, ['closetab', String(tab)], 15_000);
    srv?.stop();
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

// ─── Engine choice ───────────────────────────────────────────────────────────

export const NO_BROWSER = 'no browser available';
export const NO_BROWSER_HELP = "open the Aside app (macOS 15+, aside.com), or run ./setup in the gstack repo to build gstack's own headless browser (or point GSTACK_BROWSE_BIN at a browse binary)";

export type EngineChoice =
  | { engine: 'aside'; version: string }
  | { engine: 'browse'; bin: string }
  | { engine: null; probe: AsideProbe; error: string };

let chosen: EngineChoice | undefined;

/** Aside when it answers, else gstack's own browser, else neither. Cached per process (the Aside probe is a round-trip). */
export function pickEngine(fresh = false, deps: { probe?: () => AsideProbe; resolveBin?: () => string | null } = {}): EngineChoice {
  if (chosen && !fresh) return chosen;
  const probe = (deps.probe ?? probeAside)();
  if (probe.ok) return (chosen = { engine: 'aside', version: probe.version });
  const bin = (deps.resolveBin ?? resolveBrowseBin)();
  if (bin) return (chosen = { engine: 'browse', bin });
  return (chosen = { engine: null, probe, error: `${NO_BROWSER}: ${NO_BROWSER_HELP} (${probe.reason}: ${probe.detail})` });
}

/**
 * Render through whichever browser is available; `error` starts with NO_BROWSER
 * when neither is. If Aside was chosen but its process could not run (the app
 * quit mid-job, the CLI hung past its budget), the same spec is retried once on
 * gstack's own browser when that is built, and the choice sticks for the rest
 * of the process. A script-level failure (the page itself) is NOT retried.
 */
export async function render(spec: RenderSpec): Promise<RenderResult> {
  const c = pickEngine();
  if (c.engine === 'aside') {
    const r = await renderWithAside(spec);
    // Retry on gstack's own browser when Aside could not START (spawn error,
    // not a timeout of a script that was already navigating) or its private
    // CDP bridge is gone (an Aside release renamed `_sendToTarget`). A page
    // failure is the page's, on either engine.
    if (!r.ok && /^aside repl did not run: (?!timed out)|_sendToTarget|openTab is not defined/.test(r.error ?? '')) {
      const bin = resolveBrowseBin();
      if (bin) {
        chosen = { engine: 'browse', bin };
        const fb = await renderWithBrowse(spec, bin);
        return { ...fb, stdout: `[aside unavailable mid-run: ${r.error}] retried on gstack's own browser\n${fb.stdout}` };
      }
    }
    return r;
  }
  if (c.engine === 'browse') return renderWithBrowse(spec, c.bin);
  return { ok: false, outputs: [], evals: {}, stdout: '', error: c.error };
}
