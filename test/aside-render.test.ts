/**
 * lib/aside-render.ts — the local-HTML renderer for make-pdf, diagrams, and
 * design previews: Aside first, gstack's own browse daemon as the fallback.
 *
 * Pure pins run everywhere; the live Aside render runs only where Aside is
 * installed and open (macOS dev machines); the live fallback render runs
 * wherever a browse binary resolves (Linux CI builds one via build:gates).
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  buildRenderScript, lengthToInches, paperInches, renderWithAside, RENDER_SENTINEL,
  resolveBrowseBin, browsePdfPayload, browseScreenshotArgs, renderWithBrowse, NO_BROWSER,
  serveDir, pickEngine, SAFE_TMP_DIR,
  type RenderSpec, type RenderResult, type AsideProbe, type EngineChoice,
} from '../lib/aside-render';
import { asideAvailable } from './helpers/aside-available';

const LIVE_HTML = '<!doctype html><title>Live Probe</title><h1>Hello</h1><div id="done"></div><script>window.__v = "x".repeat(200000)</script>';

describe('aside-render: option mapping', () => {
  test('lengths convert to inches (CDP unit)', () => {
    expect(lengthToInches('1in')).toBe(1);
    expect(lengthToInches('25.4mm')).toBeCloseTo(1, 6);
    expect(lengthToInches('2.54cm')).toBeCloseTo(1, 6);
    expect(lengthToInches('72pt')).toBe(1);
    expect(lengthToInches('96px')).toBe(1);
    expect(lengthToInches(48)).toBe(0.5);
    expect(lengthToInches(undefined)).toBeUndefined();
    expect(() => lengthToInches('1 furlong')).toThrow();
  });

  test('paper formats resolve case-insensitively', () => {
    expect(paperInches('Letter')).toEqual([8.5, 11]);
    expect(paperInches('a4')![0]).toBeCloseTo(8.27, 2);
    expect(paperInches('tabloid')).toEqual([11, 17]);
    expect(paperInches('napkin')).toBeUndefined();
  });
});

describe('aside-render: generated script follows the Aside contract', () => {
  const script = buildRenderScript('http://127.0.0.1:1/x.html', {
    file: '/x.html',
    waitFor: { selector: '#done', expression: 'window.ready' },
    steps: [
      { kind: 'pdf', out: '/tmp/a.pdf', options: { paperWidth: 8.5, paperHeight: 11, generateTaggedPDF: true, headerTemplate: '<b>h</b>', displayHeaderFooter: true, waitForPagedJs: true } },
      { kind: 'screenshot', out: '/tmp/m.jpg', width: 375, type: 'jpeg', quality: 60 },
      { kind: 'screenshot', out: '/tmp/el.png', selector: '#hero' },
      { kind: 'eval', expression: 'window.__svg', out: '/tmp/d.svg' },
      { kind: 'eval', expression: 'document.title' },
    ],
  });

  test('opens about:blank, installs the console hook, then loads with waitUntil load', () => {
    expect(script).toContain('openTab("about:blank")');
    expect(script.indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(script.indexOf('pg.goto('));
    expect(script).toContain('waitUntil: "load"');
    expect(script).toContain('waitForSelector("#done", { state: "attached"');
    expect(script).toContain('waitFor expression never became truthy');
  });

  test('pdf goes through CDP printToPDF with the full option set and the Paged.js wait', () => {
    expect(script).toContain('Page.printToPDF');
    expect(script).toContain('"generateTaggedPDF":true');
    expect(script).toContain('"headerTemplate":"<b>h</b>"');
    expect(script).toContain('__pagedjsAfterFired');
    expect(script).not.toContain('pg.pdf(');
  });

  test('sized screenshots emulate device metrics and clear them; element shots use the locator', () => {
    expect(script).toContain('Emulation.setDeviceMetricsOverride');
    expect(script).toContain('"width":375');
    expect(script).toContain('"mobile":true');
    expect(script).toContain('Emulation.clearDeviceMetricsOverride');
    expect(script).toContain('pg.locator("#hero").screenshot(');
    expect(script).not.toContain('setViewportSize');
  });

  test('evals run in-page via eval, data URLs decode to bytes, inline results are fenced', () => {
    expect(script).toContain('(0, eval)(src)');
    expect(script).toContain('/^data:[^;]+;base64,/');
    // One base64 token per inline eval: page text can never forge a control line.
    expect(script).toContain('console.log("EVAL 4 " + Buffer.from(');
    expect(script).not.toContain('EVAL_START');
  });

  test('every artifact stays inside the sandbox dir and the script ends with close + sentinel', () => {
    expect(script).toContain('path.join(pwd, "gstack-render-0.pdf")');
    expect(script).toContain('"gstack-render-3.svg"');
    expect(script).toContain('console.log("ASIDE_DIR=" + pwd)');
    const tail = script.trim().split('\n').slice(-2);
    expect(tail[0]).toBe('await closeTab(pg);');
    expect(tail[1]).toBe(`console.log(${JSON.stringify(RENDER_SENTINEL)});`);
  });
});

/** The same spec both engines must satisfy: PDF, sized JPEG, eval-to-file (200KB string + data URL), inline eval. */
async function liveRoundTrip(engine: 'aside' | 'browse', renderFn: typeof renderWithAside): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${engine}-render-live-`));
  fs.writeFileSync(path.join(dir, 'doc.html'), LIVE_HTML);
  try {
    const out = await renderFn({
      file: path.join(dir, 'doc.html'),
      waitFor: { selector: '#done', expression: 'window.__v.length === 200000' },
      steps: [
        { kind: 'pdf', out: path.join(dir, 'out.pdf'), options: { paperWidth: 8.5, paperHeight: 11, generateTaggedPDF: true, printBackground: true, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: '<div style="font-size:8pt">f</div>' } },
        { kind: 'screenshot', out: path.join(dir, 'm.jpg'), width: 375, type: 'jpeg', quality: 50 },
        { kind: 'eval', expression: 'window.__v', out: path.join(dir, 'v.txt') },
        { kind: 'eval', expression: 'document.title' },
        { kind: 'eval', expression: '"data:application/octet-stream;base64," + btoa("hello")', out: path.join(dir, 'bytes.bin') },
      ],
      timeoutMs: 90_000,
    });
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.engine).toBe(engine);
    expect(out.outputs).toEqual([path.join(dir, 'out.pdf'), path.join(dir, 'm.jpg'), path.join(dir, 'v.txt'), path.join(dir, 'bytes.bin')]);
    expect(fs.readFileSync(path.join(dir, 'out.pdf')).subarray(0, 4).toString()).toBe('%PDF');
    expect(fs.readFileSync(path.join(dir, 'm.jpg')).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI
    expect(fs.statSync(path.join(dir, 'v.txt')).size).toBe(200000);
    expect(fs.readFileSync(path.join(dir, 'bytes.bin'), 'utf8')).toBe('hello'); // data URL decoded to bytes
    expect(out.evals[3]).toBe('Live Probe');
    expect(out.stdout).toMatch(/^PAGE_ERRORS=\[\]$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `--wait-expr` is poll-until-truthy: an expression that THROWS until its object exists must not fail the render. */
async function lateReadiness(engine: 'aside' | 'browse', renderFn: typeof renderWithAside): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${engine}-render-late-`));
  fs.writeFileSync(path.join(dir, 'late.html'), '<!doctype html><title>Late</title><body><script>setTimeout(() => { window.later = { ok: true }; }, 800);</script></body>');
  try {
    const out = await renderFn({ file: path.join(dir, 'late.html'), waitFor: { expression: 'window.later.ok', timeoutMs: 10_000 }, steps: [{ kind: 'eval', expression: 'document.title' }], timeoutMs: 60_000 });
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.engine).toBe(engine);
    expect(out.evals[0]).toBe('Late');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('aside-render: live render (needs the Aside app)', () => {
  test.skipIf(!asideAvailable())('renders a served HTML file to PDF, screenshot, and eval outputs', () => liveRoundTrip('aside', renderWithAside), 120_000);
  test.skipIf(!asideAvailable())('--wait-expr polls through a throwing expression until it becomes truthy', () => lateReadiness('aside', renderWithAside), 60_000);
});

describe('aside-render: browse fallback — binary resolution', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-resolve-'));
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
  const fakeBin = (root: string, rel: string): string => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/bin/sh\necho fake\n', { mode: 0o755 });
    return p;
  };
  const rootA = path.join(home, 'a');
  const rootB = path.join(home, 'b');
  const builtA = fakeBin(rootA, 'browse/dist/browse');
  const builtB = fakeBin(rootB, 'browse/dist/browse');
  const override = fakeBin(home, 'elsewhere/browse');
  const legacy = fakeBin(home, 'legacy/browse');
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  const noPath = { PATH: '' };

  test('GSTACK_BROWSE_BIN wins, then BROWSE_BIN, then the first root with browse/dist/browse', () => {
    expect(resolveBrowseBin({ ...noPath, GSTACK_BROWSE_BIN: override, BROWSE_BIN: legacy }, [rootA])).toBe(override);
    expect(resolveBrowseBin({ ...noPath, BROWSE_BIN: legacy }, [rootA])).toBe(legacy);
    expect(resolveBrowseBin(noPath, [rootA, rootB])).toBe(builtA);
    expect(resolveBrowseBin(noPath, [empty, rootB])).toBe(builtB);
  });

  test('an override that does not exist falls through (main parity); nothing anywhere is null, never a throw', () => {
    expect(resolveBrowseBin({ ...noPath, GSTACK_BROWSE_BIN: path.join(home, 'nope') }, [rootA])).toBe(builtA);
    expect(resolveBrowseBin(noPath, [empty])).toBeNull();
    expect(resolveBrowseBin({ ...noPath, GSTACK_BROWSE_BIN: '   ' }, [empty])).toBeNull();
  });

  test('the find-browse shim is consulted when a root has no built binary', () => {
    const rootC = path.join(home, 'c');
    const shim = path.join(rootC, 'browse/bin/find-browse');
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, `#!/bin/sh\necho ${builtB}\n`, { mode: 0o755 });
    expect(resolveBrowseBin(noPath, [rootC])).toBe(builtB);
  });

  test('directories are never "executables"', () => {
    const rootD = path.join(home, 'd');
    fs.mkdirSync(path.join(rootD, 'browse/dist/browse'), { recursive: true });
    expect(resolveBrowseBin(noPath, [rootD])).toBeNull();
  });
});

describe('aside-render: browse fallback — command builders (pure)', () => {
  test('pdf payload: CDP inches → browse string lengths, empty header/footer slots filled, flags mapped by name', () => {
    const p = browsePdfPayload({
      paperWidth: 8.5, paperHeight: 11, marginTop: 1, marginRight: 0, marginBottom: 0.5, marginLeft: 0,
      displayHeaderFooter: true, footerTemplate: '<i>f</i>',
      generateTaggedPDF: true, generateDocumentOutline: true, printBackground: true, preferCSSPageSize: true, waitForPagedJs: true,
    }, '/tmp/x/out.pdf');
    expect(p).toEqual({
      output: '/tmp/x/out.pdf', width: '8.5in', height: '11in',
      marginTop: '1in', marginRight: '0in', marginBottom: '0.5in', marginLeft: '0in',
      headerTemplate: '<div></div>', footerTemplate: '<i>f</i>',
      tagged: true, outline: true, printBackground: true, preferCSSPageSize: true, toc: true,
    });
  });

  test('pdf payload: no header/footer unless displayHeaderFooter; landscape swaps width/height (Letter when unset)', () => {
    expect(browsePdfPayload({ paperWidth: 8.5, paperHeight: 11, headerTemplate: '<b>h</b>' }, 'o.pdf')).toEqual({ output: 'o.pdf', width: '8.5in', height: '11in' });
    expect(browsePdfPayload({ paperWidth: 8.5, paperHeight: 11, landscape: true }, 'o.pdf')).toEqual({ output: 'o.pdf', width: '11in', height: '8.5in' });
    expect(browsePdfPayload({ landscape: true }, 'o.pdf')).toEqual({ output: 'o.pdf', width: '11in', height: '8.5in' });
    expect(browsePdfPayload({}, 'o.pdf')).toEqual({ output: 'o.pdf' });
  });

  test('screenshot args: full page by default, --viewport for viewport-only, --selector for element shots, path last', () => {
    expect(browseScreenshotArgs({ kind: 'screenshot', out: '/x/a.png' }, '/tmp/w/gstack-render-0.png')).toEqual(['screenshot', '/tmp/w/gstack-render-0.png']);
    expect(browseScreenshotArgs({ kind: 'screenshot', out: '/x/a.png', fullPage: false }, '/tmp/w/s.png')).toEqual(['screenshot', '--viewport', '/tmp/w/s.png']);
    expect(browseScreenshotArgs({ kind: 'screenshot', out: '/x/a.png', selector: '#hero' }, '/tmp/w/s.png')).toEqual(['screenshot', '--selector', '#hero', '/tmp/w/s.png']);
  });

  test('renderWithBrowse with no binary reports the no-browser error without touching the filesystem', async () => {
    const r = await renderWithBrowse({ file: '/nonexistent/x.html', steps: [] }, null);
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('browse');
    expect(r.error?.startsWith(NO_BROWSER)).toBe(true);
    expect(r.error).toContain('./setup');
  });
});

describe('aside-render: live fallback render (needs a browse binary)', () => {
  const bin = resolveBrowseBin();
  // A binary on disk is not a reachable daemon: warm it up first (the first
  // command auto-starts the server) and skip, never fail, when it cannot come
  // up — a cold daemon is an environment fact, not a renderer defect.
  let daemonUp = false;
  if (bin) {
    for (let attempt = 0; attempt < 2 && !daemonUp; attempt++) {
      const r = spawnSync(bin, ['goto', 'about:blank'], { encoding: 'utf8', timeout: 90_000 });
      daemonUp = r.status === 0;
    }
    if (!daemonUp) console.warn('[aside-render] browse daemon did not come up after two attempts — live fallback cases skipped');
  }
  test.skipIf(!bin || !daemonUp)("renders the same spec through gstack's own browser", () => liveRoundTrip('browse', (spec) => renderWithBrowse(spec, bin)), 180_000);
  test.skipIf(!bin || !daemonUp)('--wait-expr polls through a throwing expression until it becomes truthy (Aside parity)', () => lateReadiness('browse', (spec) => renderWithBrowse(spec, bin)), 60_000);
});

// ─── Hermetic fixtures: fake `aside` / `browse` executables ──────────────────
//
// Bun resolves a bare command name against the PATH the process STARTED with
// whenever a spawn carries no `env` option (verified on Bun 1.3.10: mutating
// process.env.PATH does not make a fake visible to spawnSync or Bun.spawn).
// probeAside() and the `aside repl` spawn inside renderWithAside() are exactly
// such spawns, so those cases run in a short-lived `bun` driver whose env.PATH
// names a temp bin dir (the pattern test/claude-provider-keychain.test.ts uses).
// Everything that takes the binary as an argument (renderWithBrowse) or a deps
// seam (pickEngine) runs in-process. The fakes are /bin/sh scripts.

const HERMETIC = process.platform !== 'win32';
const LIB = path.resolve(import.meta.dir, '../lib/aside-render.ts');
/** Enough PATH for the fakes' own sed/sleep/printf — never the operator's real bin dirs. */
const SYSTEM_PATH = '/usr/bin:/bin';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const NONCE_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{32})\/doc\.html$/;

function writeExecutable(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 });
  return file;
}

/** A fake `aside` CLI: `--version` answers (or exits `versionExit` with stderr), `repl` runs `repl` with the script in $2; argv is appended to `log`. */
function writeFakeAside(binDir: string, opts: { version?: string; versionExit?: number; repl?: string; log?: string } = {}): string {
  const versionCase = opts.versionExit ? `echo "app not running" >&2; exit ${opts.versionExit}` : `echo ${JSON.stringify(opts.version ?? 'aside 1.26.0 (fake)')}`;
  const log = opts.log ? `printf '%s\\n' "$*" >> ${JSON.stringify(opts.log)}\n` : '';
  return writeExecutable(path.join(binDir, 'aside'), `${log}case "$1" in\n  --version) ${versionCase} ;;\n  repl) ${opts.repl ?? ':'} ;;\n  *) echo "fake aside: unknown $1" >&2; exit 2 ;;\nesac\n`);
}

type BrowseCmd = 'newtab' | 'goto' | 'js' | 'pdf' | 'viewport' | 'screenshot' | 'closetab';
/** What a healthy daemon CLI does for each subcommand the renderer issues (after `cmd="$1"; shift`). */
const BROWSE_DEFAULTS: Record<BrowseCmd, string> = {
  newtab: `echo '{"tabId":7}'`,
  goto: ':',
  js: `expr="$1"; shift; out=""
    while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift ;; esac; shift; done
    if [ -n "$out" ]; then printf 'fake-eval-bytes' > "$out"
    elif [ "$expr" = "document.title" ]; then echo "Fake Title"
    else echo true; fi`,
  pdf: `cat "$2" >> "$LOG.payloads"; echo >> "$LOG.payloads"
    out=$(sed -n 's/.*"output":"\\([^"]*\\)".*/\\1/p' "$2")
    printf '%%PDF-1.4 fake-browse-pdf' > "$out"`,
  viewport: ':',
  screenshot: `out=""
    while [ $# -gt 0 ]; do case "$1" in --viewport) ;; --selector|--tab-id) shift ;; *) out="$1" ;; esac; shift; done
    printf 'fake-browse-shot' > "$out"`,
  closetab: ':',
};

/** A fake `browse` CLI that appends every argv line to `log`; `overrides` replace a subcommand's body. */
function writeFakeBrowse(binDir: string, log: string, overrides: Partial<Record<BrowseCmd, string>> = {}): string {
  const cases = (Object.keys(BROWSE_DEFAULTS) as BrowseCmd[]).map((c) => `  ${c}) ${overrides[c] ?? BROWSE_DEFAULTS[c]} ;;`).join('\n');
  return writeExecutable(path.join(binDir, 'browse'), `LOG=${JSON.stringify(log)}\nprintf '%s\\n' "$*" >> "$LOG"\ncmd="$1"; shift\ncase "$cmd" in\n${cases}\n  *) echo "fake browse: unknown $cmd" >&2; exit 2 ;;\nesac\n`);
}

const readLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
/** A failed render names its error and the browse transcript in the assertion, not a bare `false`. */
const expectOk = (r: RenderResult): void => {
  expect(r.error, `render failed: ${r.error}\n${r.stdout}`).toBeUndefined();
  expect(r.ok).toBe(true);
};

// These cases drive fakes and a loopback server; the subject is the CLI contract,
// not latency. Bun's 5s default once failed a CI run whose render was merely slow
// under a full six-shard load, so the budget is generous and hangs still fail.
setDefaultTimeout(30_000);
const browseWorkDirs = (): string[] => fs.readdirSync(SAFE_TMP_DIR).filter((n) => n.startsWith('gstack-render-browse-'));

/** The subprocess driver: one job per process, so the module's engine cache and the spawn-time PATH are both under the test's control. */
function writeDriver(dir: string): string {
  const driver = path.join(dir, 'driver.ts');
  fs.writeFileSync(driver, `const M = await import(${JSON.stringify(LIB)});
const job = JSON.parse(process.argv[2]);
let out;
if (job.fn === 'probeAside') out = M.probeAside(job.timeoutMs);
else if (job.fn === 'renderWithAside') out = await M.renderWithAside(job.spec);
else if (job.fn === 'render') {
  if (job.primeAside) M.pickEngine(true, { probe: () => ({ ok: true, version: 'fake-aside' }) });
  const results = [];
  for (let i = 0; i < (job.repeat ?? 1); i++) results.push(await M.render(job.spec));
  out = { results, chosenAfter: M.pickEngine() };
}
// Exit explicitly: runProc leaves its giveUp/exit-code timers armed after a render, which keeps this process alive for up to timeoutMs + 20s.
await Bun.write(Bun.stdout, 'RESULT ' + JSON.stringify(out) + '\\n');
process.exit(0);
`);
  return driver;
}

function runDriver<T>(driver: string, job: Record<string, unknown>, opts: { binDir?: string; env?: Record<string, string> } = {}): T {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: opts.binDir ? `${opts.binDir}:${SYSTEM_PATH}` : SYSTEM_PATH };
  for (const k of ['GSTACK_SKIP_ASIDE', 'GSTACK_BROWSE_BIN', 'BROWSE_BIN']) delete env[k]; // the operator's shell must not steer the fakes
  Object.assign(env, opts.env ?? {});
  // process.execPath: an absolute bun, since the child PATH deliberately omits the operator's bin dirs. cwd is the temp dir so no repo .env is auto-loaded.
  const r = spawnSync(process.execPath, [driver, JSON.stringify(job)], { encoding: 'utf8', timeout: 60_000, cwd: path.dirname(driver), env });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (r.status !== 0 || !line) throw new Error(`driver failed (status ${r.status}): ${r.stderr}\n${r.stdout}`);
  return JSON.parse(line.slice('RESULT '.length)) as T;
}

describe.skipIf(!HERMETIC)('aside-render: probeAside classifies a fake CLI the way the skills\' bash probe does', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-probe-'));
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'aside-argv.log');
  let driver: string;
  beforeAll(() => { fs.mkdirSync(bin); driver = writeDriver(tmp); });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const probe = (env?: Record<string, string>): AsideProbe => {
    fs.rmSync(log, { force: true });
    return runDriver<AsideProbe>(driver, { fn: 'probeAside', timeoutMs: 5_000 }, { binDir: bin, env });
  };

  test('no `aside` on PATH → NEEDS_ASIDE (install it), never "not running"', () => {
    fs.rmSync(path.join(bin, 'aside'), { force: true });
    const r = probe();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('NEEDS_ASIDE');
    expect(r.detail).toContain('not on PATH');
  });

  test('`aside --version` exiting non-zero → ASIDE_NOT_RUNNING with the exit code and the CLI\'s own stderr', () => {
    writeFakeAside(bin, { versionExit: 1, log });
    const r = probe();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ASIDE_NOT_RUNNING');
    expect(r.detail).toContain('`aside --version` exited 1');
    expect(r.detail).toContain('app not running');
    expect(readLines(log)).toEqual(['--version']); // repl is never attempted once --version fails
  });

  test('a CLI that answers --version but whose repl prints nothing → ASIDE_NOT_RUNNING ("no answer")', () => {
    writeFakeAside(bin, { repl: ':', log });
    const r = probe();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ASIDE_NOT_RUNNING');
    expect(r.detail).toBe('no answer from the Aside app');
  });

  test('a repl that answers without the READY marker → ASIDE_NOT_RUNNING carrying the CLI\'s text', () => {
    writeFakeAside(bin, { repl: 'echo "Cannot connect to the Aside app"', log });
    const r = probe();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ASIDE_NOT_RUNNING');
    expect(r.detail).toBe('Cannot connect to the Aside app');
  });

  test('repl printing ASIDE_READY <dir> → ok with the trimmed --version string; the probe runs the exact READY expression', () => {
    writeFakeAside(bin, { version: 'aside 1.26.0 (fake)', repl: 'echo "ASIDE_READY /Users/x/Library/Aside/session-1"', log });
    const r = probe();
    expect(r).toEqual({ ok: true, version: 'aside 1.26.0 (fake)' });
    expect(readLines(log)).toEqual(['--version', 'repl console.log("ASIDE_READY " + pwd)']);
  });

  test('GSTACK_SKIP_ASIDE=1 → NEEDS_ASIDE regardless, and the CLI is never invoked', () => {
    writeFakeAside(bin, { repl: 'echo "ASIDE_READY /x"', log });
    const r = probe({ GSTACK_SKIP_ASIDE: '1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('NEEDS_ASIDE');
    expect(r.detail).toContain('GSTACK_SKIP_ASIDE=1');
    expect(fs.existsSync(log)).toBe(false);
  });
});

describe.skipIf(!HERMETIC)('aside-render: serveDir — loopback server contract (nonce, containment, no listings)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-root-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-elsewhere-'));
  const NONCE = '0123456789abcdef'.repeat(2);
  beforeAll(() => {
    fs.writeFileSync(path.join(root, 'ok.html'), '<h1>ok</h1>');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'inner.html'), '<p>inner</p>');
    fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'SECRET');
    fs.symlinkSync(path.join(elsewhere, 'secret.txt'), path.join(root, 'leak.html'));
    fs.symlinkSync(elsewhere, path.join(root, 'leakdir'));
    fs.symlinkSync(path.join(root, 'ok.html'), path.join(root, 'alias.html'));
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); });

  /** `nonce: null` lets serveDir mint its own. */
  async function withServer<T>(fn: (srv: { url: string; stop: () => void }, port: string) => Promise<T>, nonce: string | null = NONCE): Promise<T> {
    const srv = nonce === null ? serveDir(root) : serveDir(root, nonce);
    try { return await fn(srv, new URL(srv.url).port); } finally { srv.stop(); }
  }
  const status = async (url: string): Promise<number> => (await fetch(url)).status;

  test('serves a file under the nonce prefix and the URL is exactly host:port/<nonce>', () => withServer(async (srv, port) => {
    expect(srv.url).toBe(`http://127.0.0.1:${port}/${NONCE}`);
    const res = await fetch(`${srv.url}/ok.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>ok</h1>');
    expect(res.headers.get('content-type')).toContain('html');
    expect(await status(`${srv.url}/sub/inner.html`)).toBe(200);
  }));

  test('the default nonce is 32 hex chars and differs per server', () => withServer(async (a) => withServer(async (b) => {
    expect(a.url).toMatch(/\/[0-9a-f]{32}$/);
    expect(b.url).toMatch(/\/[0-9a-f]{32}$/);
    expect(a.url.slice(-32)).not.toBe(NONCE);
    expect(a.url.slice(-32)).not.toBe(b.url.slice(-32));
  }, null), null));

  test('without the nonce prefix (or with a wrong one) every path is 404, even a file that exists', () => withServer(async (srv, port) => {
    expect(await status(`http://127.0.0.1:${port}/ok.html`)).toBe(404);
    expect(await status(`http://127.0.0.1:${port}/${'f'.repeat(32)}/ok.html`)).toBe(404);
    expect(await status(`http://127.0.0.1:${port}/${NONCE}`)).toBe(404); // the nonce alone, no trailing slash
    expect(await status(`http://127.0.0.1:${port}/`)).toBe(404);
  }));

  test('encoded traversal never escapes the root (403/404, never 200)', () => withServer(async (srv, port) => {
    for (const p of ['a%2f..%2f..%2f..%2fetc%2fhostname', '..%2f..%2fetc%2fhostname', '%2e%2e%2f%2e%2e%2fetc%2fhostname', '..%2f']) {
      const s = await status(`${srv.url}/${p}`);
      expect([403, 404]).toContain(s);
    }
    // A literal `..` is collapsed by the URL parser before it is sent: the nonce falls off → 404.
    expect(await status(`http://127.0.0.1:${port}/${NONCE}/../../etc/hostname`)).toBe(404);
  }));

  test('malformed percent-encoding is a 400 and the server keeps serving afterwards', () => withServer(async (srv) => {
    expect(await status(`${srv.url}/%zz`)).toBe(400);
    expect(await status(`${srv.url}/ok%E0%A4%A.html`)).toBe(400);
    expect(await status(`${srv.url}/ok.html`)).toBe(200);
  }));

  test('a symlink that resolves outside the root is 403; one that stays inside is 200; a symlinked dir that escapes is 403', () => withServer(async (srv) => {
    expect(await status(`${srv.url}/leak.html`)).toBe(403);
    expect(await status(`${srv.url}/leakdir/secret.txt`)).toBe(403);
    const inside = await fetch(`${srv.url}/alias.html`);
    expect(inside.status).toBe(200);
    expect(await inside.text()).toBe('<h1>ok</h1>');
  }));

  test('directories (including the root) and missing files are 404 — never a listing', () => withServer(async (srv) => {
    expect(await status(`${srv.url}/sub`)).toBe(404);
    expect(await status(`${srv.url}/sub/`)).toBe(404);
    expect(await status(`${srv.url}/`)).toBe(404);
    expect(await status(`${srv.url}/missing.html`)).toBe(404);
  }));

  test('stop() closes the port: a request after stop is refused, not served', async () => {
    const url = await withServer(async (srv) => { expect(await status(`${srv.url}/ok.html`)).toBe(200); return srv.url; });
    await expect(fetch(`${url}/ok.html`)).rejects.toThrow();
  });
});

describe.skipIf(!HERMETIC)('aside-render: renderWithAside — stdout contract against a fake `aside`', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-fake-render-'));
  const bin = path.join(tmp, 'bin');
  const www = path.join(tmp, 'www');
  const session = path.join(tmp, 'session'); // stands in for Aside's sandbox pwd
  const scriptFile = path.join(tmp, 'script.txt');
  const doc = path.join(www, 'doc.html');
  const pdfOut = path.join(tmp, 'out', 'doc.pdf');
  const svgOut = path.join(tmp, 'out', 'nested', 'd.svg');
  let driver: string;
  beforeAll(() => {
    fs.mkdirSync(bin); fs.mkdirSync(www);
    fs.writeFileSync(doc, '<!doctype html><title>Doc</title>');
    driver = writeDriver(tmp);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const spec: RenderSpec = {
    file: doc,
    steps: [
      { kind: 'pdf', out: pdfOut, options: { paperWidth: 8.5, paperHeight: 11 } },
      { kind: 'eval', expression: 'document.title' },
      { kind: 'eval', expression: 'window.__svg', out: svgOut },
    ],
    timeoutMs: 20_000,
  };
  /** What a real render script leaves behind: the artifacts inside the session dir. */
  const artifacts = `mkdir -p ${JSON.stringify(session)}; printf '%%PDF-1.4 fake-aside-artifact' > ${JSON.stringify(path.join(session, 'gstack-render-0.pdf'))}; printf '<svg/>' > ${JSON.stringify(path.join(session, 'gstack-render-2.svg'))}`;
  const record = `printf '%s' "$2" > ${JSON.stringify(scriptFile)}`;
  const render = (repl: string | null, s: RenderSpec = spec): RenderResult => {
    fs.rmSync(path.join(tmp, 'out'), { recursive: true, force: true });
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(scriptFile, { force: true });
    if (repl === null) fs.rmSync(path.join(bin, 'aside'), { force: true }); else writeFakeAside(bin, { repl });
    return runDriver<RenderResult>(driver, { fn: 'renderWithAside', spec: s }, { binDir: bin });
  };

  test('success: artifacts are copied from ASIDE_DIR to each step.out (nested dirs created) and base64 evals are decoded', () => {
    const r = render(`${record}; ${artifacts}; echo "EVAL 1 ${b64('Doc')}"; echo "PAGE_ERRORS=[]"; echo "ASIDE_DIR=${session}"; echo "${RENDER_SENTINEL}"`);
    expect(r.error).toBeUndefined();
    expectOk(r);
    expect(r.engine).toBe('aside');
    expect(r.outputs).toEqual([pdfOut, svgOut]);
    expect(fs.readFileSync(pdfOut, 'utf8')).toBe('%PDF-1.4 fake-aside-artifact');
    expect(fs.readFileSync(svgOut, 'utf8')).toBe('<svg/>');
    expect(r.evals).toEqual({ 1: 'Doc' });
    expect(r.stdout).toMatch(/^PAGE_ERRORS=\[\]$/m);
    expect(r.stdout).toContain(RENDER_SENTINEL);
  });

  test('the script handed to `aside repl` navigates to http://127.0.0.1:<port>/<32-hex nonce>/<file> and prints via CDP', () => {
    render(`${record}; ${artifacts}; echo "EVAL 1 ${b64('Doc')}"; echo "ASIDE_DIR=${session}"; echo "${RENDER_SENTINEL}"`);
    const script = fs.readFileSync(scriptFile, 'utf8');
    const goto = script.match(/await pg\.goto\("([^"]+)", \{ waitUntil: "load", timeout: 20000 \}\);/);
    expect(goto).not.toBeNull();
    expect(goto![1]).toMatch(NONCE_RE);
    expect(script).toContain('Page.printToPDF');
    expect(script).toContain(`console.log(${JSON.stringify(RENDER_SENTINEL)})`);
  });

  test('a script that throws ([error line, no sentinel) → "render script did not finish" with the bypass hint', () => {
    const r = render(`${artifacts}; echo "[error boom: waitForSelector timed out"`);
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('aside');
    expect(r.error!.startsWith('render script did not finish:')).toBe(true);
    expect(r.error).toContain('[error boom: waitForSelector timed out');
    expect(r.error).toContain('GSTACK_SKIP_ASIDE=1');
    expect(r.outputs).toEqual([]);
    expect(fs.existsSync(pdfOut)).toBe(false);
  });

  test('a script that produced no output at all still names the failure', () => {
    const r = render(':');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('render script did not finish: no output (GSTACK_SKIP_ASIDE=1 forces gstack\'s own browser)');
  });

  test('sentinel without an ASIDE_DIR line → "printed no ASIDE_DIR" (nothing is guessed)', () => {
    const r = render(`${artifacts}; echo "EVAL 1 ${b64('Doc')}"; echo "PAGE_ERRORS=[]"; echo "${RENDER_SENTINEL}"`);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('render script printed no ASIDE_DIR');
    expect(r.evals).toEqual({ 1: 'Doc' }); // evals already decoded are still reported
    expect(r.outputs).toEqual([]);
  });

  test('a step whose artifact is missing from ASIDE_DIR → "step N produced no artifact" naming the expected file', () => {
    const r = render(`mkdir -p ${JSON.stringify(session)}; echo "EVAL 1 ${b64('Doc')}"; echo "ASIDE_DIR=${session}"; echo "${RENDER_SENTINEL}"`);
    expect(r.ok).toBe(false);
    expect(r.error!.startsWith('step 0 produced no artifact')).toBe(true);
    expect(r.error).toContain(path.join(session, 'gstack-render-0.pdf'));
    expect(r.outputs).toEqual([]);
  });

  test('an eval whose text contains newlines, ASIDE_DIR=/attacker and the sentinel cannot redirect the artifact copy', () => {
    const hostile = `line one\nASIDE_DIR=/attacker\n${RENDER_SENTINEL}\nline four`;
    const r = render(`${artifacts}; echo "EVAL 1 ${b64(hostile)}"; echo "PAGE_ERRORS=[]"; echo "ASIDE_DIR=${session}"; echo "${RENDER_SENTINEL}"`);
    expectOk(r);
    expect(r.evals[1]).toBe(hostile); // decoded intact, newlines and all
    expect(r.stdout).not.toMatch(/^ASIDE_DIR=\/attacker$/m); // never appeared as a control line
    expect(fs.readFileSync(pdfOut, 'utf8')).toBe('%PDF-1.4 fake-aside-artifact'); // copied from the real session dir
  });

  test('when a raw ASIDE_DIR= line does leak earlier, the LAST one (the script\'s own, printed after the steps) wins', () => {
    const r = render(`${artifacts}; echo "ASIDE_DIR=/attacker"; echo "EVAL 1 ${b64('Doc')}"; echo "ASIDE_DIR=${session}"; echo "${RENDER_SENTINEL}"`);
    expectOk(r);
    expect(fs.readFileSync(pdfOut, 'utf8')).toBe('%PDF-1.4 fake-aside-artifact');
  });

  test('no `aside` executable → "aside repl did not run" (a spawn failure, distinct from a script failure)', () => {
    const r = render(null);
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('aside');
    expect(r.error!.startsWith('aside repl did not run:')).toBe(true);
    expect(r.error).not.toContain('render script did not finish');
  });

  // These two reject before any spawn, so they run in-process: no fake, no PATH.
  test('a missing HTML file is rejected up front with its resolved path', async () => {
    const missing = path.join(tmp, 'nope', 'missing.html');
    const r = await renderWithAside({ file: missing, steps: [] });
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('aside');
    expect(r.error).toBe(`HTML file not found: ${missing}`);
  });

  test('a file outside serveRoot is rejected up front (the server would never be able to reach it)', async () => {
    const otherRoot = path.join(tmp, 'other');
    fs.mkdirSync(otherRoot, { recursive: true });
    const r = await renderWithAside({ file: doc, serveRoot: otherRoot, steps: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('is outside serveRoot');
    expect(r.error).toContain(otherRoot);
  });
});

describe.skipIf(!HERMETIC)('aside-render: renderWithBrowse — daemon CLI contract against a fake `browse`', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-fake-render-'));
  const bin = path.join(tmp, 'bin');
  const www = path.join(tmp, 'www');
  const log = path.join(tmp, 'browse-argv.log');
  const doc = path.join(www, 'doc.html');
  const outDir = path.join(tmp, 'out');
  beforeAll(() => {
    fs.mkdirSync(bin); fs.mkdirSync(www);
    fs.writeFileSync(doc, '<!doctype html><title>Doc</title>');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const fake = (overrides: Partial<Record<BrowseCmd, string>> = {}): string => {
    fs.rmSync(log, { force: true }); fs.rmSync(`${log}.payloads`, { force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    return writeFakeBrowse(bin, log, overrides);
  };
  const T = '--tab-id 7';

  test('happy path: newtab → goto <nonce URL> → per-step CLI calls → closetab; artifacts copied, evals inline, work dir and server released', async () => {
    const before = browseWorkDirs();
    const b = fake();
    const r = await renderWithBrowse({
      file: doc,
      steps: [
        { kind: 'pdf', out: path.join(outDir, 'doc.pdf'), options: { paperWidth: 8.5, paperHeight: 11 } },
        { kind: 'screenshot', out: path.join(outDir, 'full.png') },
        { kind: 'eval', expression: 'window.__svg', out: path.join(outDir, 'nested', 'd.svg') },
        { kind: 'eval', expression: 'document.title' },
      ],
      timeoutMs: 20_000,
    }, b);
    expect(r.error).toBeUndefined();
    expectOk(r);
    expect(r.engine).toBe('browse');
    expect(r.outputs).toEqual([path.join(outDir, 'doc.pdf'), path.join(outDir, 'full.png'), path.join(outDir, 'nested', 'd.svg')]);
    expect(fs.readFileSync(path.join(outDir, 'doc.pdf'), 'utf8')).toBe('%PDF-1.4 fake-browse-pdf');
    expect(fs.readFileSync(path.join(outDir, 'full.png'), 'utf8')).toBe('fake-browse-shot');
    expect(fs.readFileSync(path.join(outDir, 'nested', 'd.svg'), 'utf8')).toBe('fake-eval-bytes');
    expect(r.evals).toEqual({ 3: 'Fake Title' });
    expect(r.stdout).toContain('$ browse newtab --json');
    expect(r.stdout).toMatch(/^PAGE_ERRORS=/m);

    const lines = readLines(log);
    expect(lines[0]).toBe('newtab --json');
    const goto = lines.find((l) => l.startsWith('goto '))!;
    expect(goto.endsWith(` ${T}`)).toBe(true);
    expect(goto.slice('goto '.length, -` ${T}`.length)).toMatch(NONCE_RE);
    expect(lines.some((l) => /^pdf --from-file \S+\/pdf-0\.json --tab-id 7$/.test(l))).toBe(true);
    expect(lines.some((l) => /^screenshot \/tmp\/gstack-render-browse-[^ ]+\/gstack-render-1\.png --tab-id 7$/.test(l))).toBe(true);
    expect(lines.some((l) => /^js window\.__svg --out \S+\/gstack-render-2\.svg --tab-id 7$/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('viewport '))).toBe(false); // un-sized shot: the daemon's viewport is left alone
    expect(lines.at(-1)).toBe('closetab 7');
    const payload = fs.readFileSync(`${log}.payloads`, 'utf8');
    expect(payload).toContain('"width":"8.5in"');
    expect(payload).toMatch(/"output":"\/tmp\/gstack-render-browse-[^"]+\/gstack-render-0\.pdf"/);
    expect(browseWorkDirs()).toEqual(before); // /tmp staging dir removed
    await expect(fetch(goto.slice('goto '.length, -` ${T}`.length))).rejects.toThrow(); // loopback server stopped
  });

  test('`newtab --json` without a tabId → the named error, no closetab, no staging dir left in /tmp', async () => {
    const before = browseWorkDirs();
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'eval', expression: '1' }] }, fake({ newtab: `echo '{"ok":true}'` }));
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('browse');
    expect(r.error).toBe('browse newtab --json returned no tabId');
    expect(readLines(log)).toEqual(['newtab --json']);
    expect(browseWorkDirs()).toEqual(before);
  });

  test('a failing goto → "browse goto failed: <first stderr line>", the tab is still closed, /tmp is left clean', async () => {
    const before = browseWorkDirs();
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'pdf', out: path.join(outDir, 'x.pdf') }] }, fake({ goto: 'echo "net::ERR_CONNECTION_REFUSED at http://127.0.0.1" >&2; echo "second line" >&2; exit 1' }));
    expect(r.ok).toBe(false);
    expect(r.error!.startsWith('browse goto failed:')).toBe(true);
    expect(r.error).toContain('net::ERR_CONNECTION_REFUSED');
    expect(r.error).not.toContain('second line');
    expect(r.outputs).toEqual([]);
    const lines = readLines(log);
    expect(lines.some((l) => l.startsWith('goto '))).toBe(true);
    expect(lines.at(-1)).toBe('closetab 7');
    expect(lines.some((l) => l.startsWith('pdf '))).toBe(false);
    expect(browseWorkDirs()).toEqual(before);
    expect(fs.existsSync(path.join(outDir, 'x.pdf'))).toBe(false);
  });

  test('a pdf step whose CLI call writes nothing → "step 0 produced no artifact"; later steps do not run', async () => {
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'pdf', out: path.join(outDir, 'x.pdf') }, { kind: 'eval', expression: 'document.title' }] }, fake({ pdf: ':' }));
    expect(r.ok).toBe(false);
    expect(r.error!.startsWith('step 0 produced no artifact')).toBe(true);
    expect(r.error).toContain('gstack-render-0.pdf');
    expect(r.evals).toEqual({});
    expect(readLines(log).some((l) => l.startsWith('js document.title'))).toBe(false);
    expect(readLines(log).at(-1)).toBe('closetab 7');
  });

  test('"JS execution blocked" from the daemon → the cookie-import explanation with the $B stop remedy; the console hook degrades quietly', async () => {
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'eval', expression: 'document.title' }] }, fake({ js: 'echo "JS execution blocked: cookies were imported for another origin" >&2; exit 1' }));
    expect(r.ok).toBe(false);
    expect(r.error!.startsWith('browse js refused:')).toBe(true);
    expect(r.error).toContain('imported cookies');
    expect(r.error).toContain('$B stop');
    expect(r.stdout).toContain('console hook unavailable:'); // best-effort bookkeeping, not a failure
    expect(readLines(log).at(-1)).toBe('closetab 7');
  });

  test('waitFor.selector that never attaches → "never attached" with the budget, after polling more than once', async () => {
    const r = await renderWithBrowse({ file: doc, waitFor: { selector: '#never', timeoutMs: 400 }, steps: [{ kind: 'eval', expression: 'document.title' }] }, fake({ js: 'echo false' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('waitFor selector never attached: #never');
    expect(r.error).toContain('(waited 400ms)');
    const polls = readLines(log).filter((l) => l.includes('document.querySelector("#never")'));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(readLines(log).some((l) => l.startsWith('js document.title'))).toBe(false); // steps never started
  });

  test('waitFor.expression that never becomes truthy → "never became truthy" naming the expression', async () => {
    const r = await renderWithBrowse({ file: doc, waitFor: { expression: 'window.ready', timeoutMs: 300 }, steps: [] }, fake({ js: 'echo false' }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('waitFor expression never became truthy: window.ready (waited 300ms)');
  });

  test('a sized screenshot sets the viewport (no --scale unless asked), shoots, then restores 1280x720', async () => {
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'screenshot', out: path.join(outDir, 'm.png'), width: 375 }] }, fake());
    expectOk(r);
    expect(fs.readFileSync(path.join(outDir, 'm.png'), 'utf8')).toBe('fake-browse-shot');
    const lines = readLines(log);
    const set = lines.indexOf(`viewport 375x281 ${T}`); // 375 * 0.75 rounded, no --scale
    const shot = lines.findIndex((l) => /^screenshot \S+\/gstack-render-0\.png --tab-id 7$/.test(l));
    const restore = lines.indexOf(`viewport 1280x720 ${T}`);
    expect(set).toBeGreaterThan(-1);
    expect(shot).toBeGreaterThan(set);
    expect(restore).toBeGreaterThan(shot);
    expect(lines.filter((l) => l.startsWith('viewport ')).some((l) => l.includes('--scale'))).toBe(false);
  });

  test('deviceScaleFactor and an explicit height are passed through; jpeg type picks the .jpg staging name; the viewport-only flag rides along', async () => {
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'screenshot', out: path.join(outDir, 'm.jpeg'), width: 375, height: 600, deviceScaleFactor: 2, type: 'jpeg', fullPage: false }] }, fake());
    expectOk(r);
    const lines = readLines(log);
    const dump = `browse argv log:\n${lines.join('\n')}\nrender stdout:\n${r.stdout}`;
    expect(lines, dump).toContain(`viewport 375x600 --scale 2 ${T}`);
    expect(lines.filter((l) => l.startsWith('screenshot ')), dump).toEqual(lines.filter((l) => /^screenshot --viewport \S+\/gstack-render-0\.jpg --tab-id 7$/.test(l)));
    expect(lines.filter((l) => l.startsWith('screenshot ')).length, dump).toBe(1);
    expect(lines.indexOf(`viewport 1280x720 ${T}`), dump).toBeGreaterThan(lines.indexOf(`viewport 375x600 --scale 2 ${T}`));
  });

  test('a cold daemon ("Unable to connect" on the first newtab) is retried once and the render proceeds', async () => {
    // First call: the daemon is still booting. Second call: up. The marker file lives next to the argv log.
    const b = fake({ newtab: `if [ ! -f "$LOG.cold" ]; then : > "$LOG.cold"; echo '[browse] Unable to connect. Is the computer able to access the url?' >&2; exit 1; fi; echo '{"tabId":7}'` });
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'eval', expression: 'document.title' }] }, b);
    expectOk(r);
    expect(readLines(log).filter((l) => l === 'newtab --json').length).toBe(2);
    expect(r.stdout).toContain('newtab: daemon not up yet — retrying once');
    expect(r.evals[0]).toBe('Fake Title');
  });

  test('any other newtab failure is not retried', async () => {
    const r = await renderWithBrowse({ file: doc, steps: [] }, fake({ newtab: `echo 'browser launch failed: no display' >&2; exit 1` }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('browse newtab failed: browser launch failed: no display');
    expect(readLines(log).filter((l) => l === 'newtab --json').length).toBe(1);
  });

  // runProc is not exported: its timeout + kill path is observed through a hanging fake.
  test('a CLI call that hangs past spec.timeoutMs is killed and reported as timed out — even when a grandchild keeps the pipes open', async () => {
    const before = browseWorkDirs();
    // `sleep` is a CHILD of the sh fake, so SIGTERM kills sh while sleep still holds stdout/stderr:
    // the read must give up on its own (timeout + 10s) rather than wait for EOF. 14s (not 30s) so no orphan outlives this file.
    const b = fake({ newtab: 'sleep 14' });
    const t0 = Date.now();
    const r = await renderWithBrowse({ file: doc, steps: [{ kind: 'eval', expression: '1' }], timeoutMs: 1_500 }, b);
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.error!.startsWith('browse newtab failed:')).toBe(true);
    expect(r.error).toContain('timed out');
    expect(elapsed).toBeLessThan(25_000);
    expect(readLines(log)).toEqual(['newtab --json']); // no tab → nothing to close
    expect(browseWorkDirs()).toEqual(before);
  }, 40_000);

  test('a hanging CLI that honours SIGTERM is reaped promptly at the budget', async () => {
    const b = fake({ newtab: 'exec sleep 14' }); // exec: sleep IS the child, so the kill closes the pipes at once
    const t0 = Date.now();
    const r = await renderWithBrowse({ file: doc, steps: [], timeoutMs: 1_500 }, b);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out after');
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 20_000);
});

describe('aside-render: pickEngine — cached engine choice through the probe/resolver seam', () => {
  const notRunning: AsideProbe = { ok: false, reason: 'ASIDE_NOT_RUNNING', detail: 'the app is closed' };
  const noBin = (): null => null;

  test('a probe that answers picks aside with its version; the browse resolver is not even consulted', () => {
    const c = pickEngine(true, { probe: () => ({ ok: true, version: 'aside 9.9 (fake)' }), resolveBin: () => { throw new Error('resolveBin must not run when Aside answers'); } });
    expect(c).toEqual({ engine: 'aside', version: 'aside 9.9 (fake)' });
  });

  test('a failed probe plus a resolvable binary picks browse with that exact path', () => {
    const c = pickEngine(true, { probe: () => notRunning, resolveBin: () => '/fake/browse/dist/browse' });
    expect(c).toEqual({ engine: 'browse', bin: '/fake/browse/dist/browse' });
  });

  test('neither available → engine null; the error opens with NO_BROWSER and carries the probe reason + detail', () => {
    const c = pickEngine(true, { probe: () => notRunning, resolveBin: noBin });
    expect(c.engine).toBeNull();
    if (c.engine !== null) return;
    expect(c.probe).toEqual(notRunning);
    expect(c.error.startsWith('no browser available')).toBe(true);
    expect(c.error).toContain('ASIDE_NOT_RUNNING: the app is closed');
    expect(c.error).toContain('./setup');
  });

  test('the choice is cached (deps ignored) until fresh=true re-probes', () => {
    let probes = 0;
    const primed = pickEngine(true, { probe: () => ({ ok: true, version: 'primed' }) });
    expect(primed.engine).toBe('aside');
    const cached = pickEngine(false, { probe: () => { probes++; return notRunning; }, resolveBin: () => '/never' });
    expect(cached).toBe(primed);
    expect(pickEngine()).toBe(primed);
    expect(probes).toBe(0);
    const fresh: EngineChoice = pickEngine(true, { probe: () => { probes++; return notRunning; }, resolveBin: () => '/x/browse' });
    expect(probes).toBe(1);
    expect(fresh).toEqual({ engine: 'browse', bin: '/x/browse' });
    expect(pickEngine()).toBe(fresh);
  });
});

describe.skipIf(!HERMETIC)('aside-render: render() — mid-run fallback from Aside to gstack\'s own browser', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-fallback-'));
  const asideBin = path.join(tmp, 'aside-bin');
  const browseBin = path.join(tmp, 'browse-bin');
  const browseLog = path.join(tmp, 'browse-argv.log');
  const www = path.join(tmp, 'www');
  const doc = path.join(www, 'doc.html');
  const pdfOut = path.join(tmp, 'out', 'doc.pdf');
  let driver: string;
  let fakeBrowse: string;
  beforeAll(() => {
    fs.mkdirSync(asideBin); fs.mkdirSync(www);
    fs.writeFileSync(doc, '<!doctype html><title>Doc</title>');
    fakeBrowse = writeFakeBrowse(browseBin, browseLog);
    driver = writeDriver(tmp);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  type Out = { results: RenderResult[]; chosenAfter: EngineChoice };
  const spec: RenderSpec = { file: doc, steps: [{ kind: 'pdf', out: pdfOut }], timeoutMs: 20_000 };
  /** Prime the engine cache to Aside inside the driver, then render with the given fake `aside` (null = none on PATH) and the fake browse reachable via GSTACK_BROWSE_BIN. */
  const run = (asideRepl: string | null, s: RenderSpec = spec, repeat = 1): Out => {
    fs.rmSync(browseLog, { force: true }); fs.rmSync(`${browseLog}.payloads`, { force: true });
    fs.rmSync(path.join(tmp, 'out'), { recursive: true, force: true });
    if (asideRepl === null) fs.rmSync(path.join(asideBin, 'aside'), { force: true }); else writeFakeAside(asideBin, { repl: asideRepl });
    return runDriver<Out>(driver, { fn: 'render', primeAside: true, repeat, spec: s }, { binDir: asideBin, env: { GSTACK_BROWSE_BIN: fakeBrowse } });
  };

  test('Aside chosen but its CLI cannot start → retried once on gstack\'s own browser, and browse stays chosen afterwards', () => {
    const { results, chosenAfter } = run(null, spec, 2);
    const [first, second] = results;
    expect(first.ok).toBe(true);
    expect(first.engine).toBe('browse');
    expect(first.stdout.startsWith('[aside unavailable mid-run: aside repl did not run:')).toBe(true);
    expect(first.stdout).toContain("retried on gstack's own browser");
    expect(first.outputs).toEqual([pdfOut]);
    expect(fs.readFileSync(pdfOut, 'utf8')).toBe('%PDF-1.4 fake-browse-pdf');
    // The switch sticks: the second render goes straight to browse, no Aside attempt, no fallback banner.
    expect(second.ok).toBe(true);
    expect(second.engine).toBe('browse');
    expect(second.stdout.startsWith('[aside unavailable')).toBe(false);
    expect(chosenAfter).toEqual({ engine: 'browse', bin: fakeBrowse });
    expect(readLines(browseLog).filter((l) => l === 'newtab --json')).toHaveLength(2);
  });

  test('a script-level failure is the page\'s: not retried, Aside stays the chosen engine, browse never runs', () => {
    const { results: [r], chosenAfter } = run('echo "[error boom"');
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('aside');
    expect(r.error!.startsWith('render script did not finish:')).toBe(true);
    expect(r.stdout.startsWith('[aside unavailable')).toBe(false);
    expect(chosenAfter.engine).toBe('aside');
    expect(fs.existsSync(browseLog)).toBe(false);
    expect(fs.existsSync(pdfOut)).toBe(false);
  });

  test('a vanished private API (openTab / _sendToTarget) counts as Aside gone → falls back to browse', () => {
    for (const line of ['ReferenceError: openTab is not defined', 'TypeError: pg._sendToTarget is not a function']) {
      const { results: [r], chosenAfter } = run(`echo ${JSON.stringify(line)}`);
      expectOk(r);
      expect(r.engine).toBe('browse');
      expect(r.stdout.startsWith(`[aside unavailable mid-run: render script did not finish: ${line}`)).toBe(true);
      expect(chosenAfter.engine).toBe('browse');
      expect(fs.readFileSync(pdfOut, 'utf8')).toBe('%PDF-1.4 fake-browse-pdf');
    }
  });

  test('an Aside script that times out was already navigating → NOT retried (the page\'s failure), Aside stays chosen', () => {
    // timeoutMs 100 + the process slack (10s) is the whole wait; exec so the kill closes the pipes at once.
    const { results: [r], chosenAfter } = run('exec sleep 14', { ...spec, timeoutMs: 100 });
    expect(r.ok).toBe(false);
    expect(r.engine).toBe('aside');
    expect(r.error!.startsWith('aside repl did not run: timed out after')).toBe(true);
    expect(r.stdout.startsWith('[aside unavailable')).toBe(false);
    expect(chosenAfter.engine).toBe('aside');
    expect(fs.existsSync(browseLog)).toBe(false);
  }, 30_000);
});
