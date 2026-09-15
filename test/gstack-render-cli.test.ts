/**
 * bin/gstack-render.ts — the CLI skills shell out to for rendering local HTML
 * (make-pdf's print pipeline, the diagram bundle, design previews).
 *
 * Everything here is hermetic: GSTACK_SKIP_ASIDE=1 forces the browse fallback,
 * and GSTACK_BROWSE_BIN points at a fake `browse` shell script that answers the
 * daemon CLI's contract (newtab --json, goto, js, pdf --from-file, viewport,
 * screenshot, closetab) and logs every argv line it receives. No real browser,
 * no network beyond the CLI's own loopback server.
 *
 * Pinned contracts:
 *   - argument guards exit 1 with `ERROR: <msg>` + the usage line on stderr and
 *     never touch a browser;
 *   - `--help` / `-h` print the usage line to STDOUT, exit 0;
 *   - success output: `ENGINE=browse` first, one `OK <abs path>` per artifact,
 *     then EVAL / PAGE_ERRORS lines fenced as UNTRUSTED WEB CONTENT;
 *   - failure output: `ENGINE=browse` still first, `ERROR: browse <cmd> failed:`
 *     plus a transcript tail on stderr (suppressed by --quiet), exit 1;
 *   - `--serve-root` containment;
 *   - the BROWSER SETUP first-line contract when neither browser resolves.
 *
 * Process shape: every path that ends in `process.exit` (guards, --help, every
 * failure) is run with spawnSync. A SUCCESSFUL render has no process.exit — the
 * CLI falls off the end of the module, so bun exits only when the event loop is
 * empty. A dangling timer in lib/aside-render's runProc once kept it alive for
 * `min(120s, --timeout) + 10s` after the output was printed (2m10s at the
 * default budget; 25s floor from closetab's fixed 15s); runProc now clears every
 * timer it sets, and `exits promptly` below pins that. The success cases still
 * pass `--timeout 5000` and run as ONE concurrent batch: if the leak ever comes
 * back, one test fails with a clear message in ~30s instead of every success
 * test stalling to its own timeout.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBrowseBin } from '../lib/aside-render';

const ROOT = path.resolve(import.meta.dir, '..');
// The fake `browse` is a shebang shell script: Windows' CreateProcess cannot
// exec it (spawn reports "Executable not found"), so every describe that drives
// the CLI through the fake self-skips on win32. The argument guards, --help,
// and the no-browser case need no fake and run everywhere.
const isWin = process.platform === 'win32';
const CLI = path.join(ROOT, 'bin/gstack-render.ts');
// The same bun that runs this test file, by absolute path: a scrubbed PATH in a
// child env must never decide whether the CLI itself can start.
const BUN = process.execPath;
const USAGE_PREFIX = 'usage: gstack-render';
const FENCE_BEGIN = '═══ BEGIN UNTRUSTED WEB CONTENT ═══';
const FENCE_END = '═══ END UNTRUSTED WEB CONTENT ═══';
const TEST_TIMEOUT = 30_000;
/** Ceiling for the concurrent success batch: the old 25s linger + slack; a hang past it is a test failure, not a stall. */
const BATCH_TIMEOUT = 90_000;
/**
 * A successful render takes well under a second against the fake; the timer leak
 * described in the header made it take 25s or more. 15s sits between the two
 * with room for a loaded CI box.
 */
const PROMPT_EXIT_MS = 15_000;

// ─── The fake browse daemon CLI ──────────────────────────────────────────────

/**
 * Answers exactly what lib/aside-render's browse path asks for. Every call
 * appends its argv to $FAKE_BROWSE_DIR/argv.log; FAKE_BROWSE_FAIL=<cmd> makes
 * that one command exit 1; FAKE_PAGE_ERRS is what the PAGE_ERRORS probe returns.
 */
const FAKE_BROWSE = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_BROWSE_DIR/argv.log"
cmd="$1"
if [ -n "$FAKE_BROWSE_FAIL" ] && [ "$cmd" = "$FAKE_BROWSE_FAIL" ]; then
  echo "fake browse: $cmd refused" >&2
  exit 1
fi
case "$cmd" in
  newtab) echo '{"tabId":7}' ;;
  goto|viewport|closetab) ;;
  js)
    expr="$2"
    case "$expr" in
      'JSON.stringify(window.__gstackErrs || [])') echo "\${FAKE_PAGE_ERRS:-[]}" ;;
      '(() => { try { return !!('*) echo true ;;
      '(() => { window.__gstackErrs'*) echo undefined ;;
      *)
        shift 2
        out=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "--out" ]; then out="$2"; shift 2; continue; fi
          shift
        done
        if [ -n "$out" ]; then printf 'written-by-fake' > "$out"; else echo "Hello From Page"; fi
        ;;
    esac
    ;;
  pdf)
    payload="$3"
    cp "$payload" "$FAKE_BROWSE_DIR/pdf-payload.json"
    out=$(sed -n 's/.*"output":"\\([^"]*\\)".*/\\1/p' "$payload")
    printf '%%PDF-1.4 fake\\n' > "$out"
    ;;
  screenshot)
    shift
    target=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --tab-id|--selector) shift 2 ;;
        --*) shift ;;
        *) target="$1"; shift ;;
      esac
    done
    printf '\\x89PNG fake' > "$target"
    ;;
  *) echo "fake browse: unknown command $cmd" >&2; exit 2 ;;
esac
`;

interface Fixture {
  dir: string;
  /** <dir>/site/doc.html — one level down so --serve-root <dir> has a relative path to show. */
  html: string;
  fakeDir: string;
  fake: string;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-cli-'));
  const sub = path.join(dir, 'site');
  fs.mkdirSync(sub);
  const html = path.join(sub, 'doc.html');
  fs.writeFileSync(html, '<!doctype html><title>Doc</title><div id="done"></div>');
  const fakeDir = path.join(dir, 'fake');
  fs.mkdirSync(fakeDir);
  const fake = path.join(fakeDir, 'browse');
  fs.writeFileSync(fake, FAKE_BROWSE, { mode: 0o755 });
  return { dir, html, fakeDir, fake };
}

/** Forget what the fake saw in an earlier run of the same fixture. */
function resetFake(f: Fixture) {
  fs.rmSync(path.join(f.fakeDir, 'argv.log'), { force: true });
  fs.rmSync(path.join(f.fakeDir, 'pdf-payload.json'), { force: true });
}

function argvLog(f: Fixture): string[] {
  const p = path.join(f.fakeDir, 'argv.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
}

interface RunOpts {
  /** The fake exits 1 on this daemon command. */
  fail?: string;
  /** What the fake returns for the PAGE_ERRORS probe (default `[]`). */
  pageErrs?: string;
  env?: Record<string, string | undefined>;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  stdoutLines: string[];
  stderrLines: string[];
  /** Spawn-to-exit wall clock. */
  durationMs: number;
}

function cliEnv(f: Fixture, opts: RunOpts): Record<string, string | undefined> {
  return {
    ...process.env,
    GSTACK_SKIP_ASIDE: '1',
    GSTACK_BROWSE_BIN: f.fake,
    BROWSE_BIN: undefined,
    FAKE_BROWSE_DIR: f.fakeDir,
    FAKE_BROWSE_FAIL: opts.fail,
    FAKE_PAGE_ERRS: opts.pageErrs,
    ...opts.env,
  };
}

function shape(status: number | null, stdout: string, stderr: string, durationMs: number): CliResult {
  return { status, stdout, stderr, stdoutLines: stdout.split('\n').filter(Boolean), stderrLines: stderr.split('\n').filter(Boolean), durationMs };
}

/** Synchronous run: for every path that ends in process.exit (guards, --help, failures). */
function runCli(f: Fixture, args: string[], opts: RunOpts = {}): CliResult {
  resetFake(f);
  const started = Date.now();
  const r = spawnSync(BUN, [CLI, ...args], { encoding: 'utf8', env: cliEnv(f, opts), timeout: TEST_TIMEOUT });
  return shape(r.status, r.stdout ?? '', r.stderr ?? '', Date.now() - started);
}

/** Async run for the success path (see the header on why these overlap). */
async function runCliAsync(f: Fixture, args: string[], opts: RunOpts = {}): Promise<CliResult> {
  resetFake(f);
  const started = Date.now();
  const proc = Bun.spawn([BUN, CLI, ...args], { env: cliEnv(f, opts), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const killer = setTimeout(() => proc.kill('SIGKILL'), BATCH_TIMEOUT - 5_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const status = await proc.exited;
  clearTimeout(killer);
  return shape(status, stdout, stderr, Date.now() - started);
}

// ─── Argument guards ─────────────────────────────────────────────────────────

describe('gstack-render CLI: argument guards', () => {
  let f: Fixture;
  beforeAll(() => { f = makeFixture(); });
  afterAll(() => { fs.rmSync(f.dir, { recursive: true, force: true }); });

  /** exit 1, stderr = `ERROR: <msg>` then the usage line, nothing on stdout, browser never spawned. */
  function expectGuard(args: string[], msg: string) {
    const r = runCli(f, args);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderrLines.length).toBe(2);
    expect(r.stderrLines[0]).toStartWith('ERROR: ');
    expect(r.stderrLines[0]).toContain(msg);
    expect(r.stderrLines[1]).toStartWith(USAGE_PREFIX);
    expect(argvLog(f)).toEqual([]);
  }

  test('no arguments: just the usage line on stderr, exit 1, no browser spawned', () => {
    const r = runCli(f, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderrLines.length).toBe(1);
    expect(r.stderrLines[0]).toStartWith(USAGE_PREFIX);
    expect(argvLog(f)).toEqual([]);
  }, TEST_TIMEOUT);

  test('a pdf option before any --pdf', () => {
    expectGuard([f.html, '--margin', '1in', '--pdf', 'out.pdf'], 'pdf option given before --pdf');
  }, TEST_TIMEOUT);

  test('--out without a preceding --eval', () => {
    expectGuard([f.html, '--pdf', 'out.pdf', '--out', 'f.txt'], '--out belongs to --eval');
  }, TEST_TIMEOUT);

  test('unknown paper format', () => {
    expectGuard([f.html, '--pdf', 'out.pdf', '--paper', 'napkin'], 'unknown paper format napkin');
  }, TEST_TIMEOUT);

  test('--paper-in that is not WxH', () => {
    expectGuard([f.html, '--pdf', 'out.pdf', '--paper-in', '8x'], '--paper-in wants WxH');
  }, TEST_TIMEOUT);

  test('--pdf with no value', () => {
    expectGuard([f.html, '--pdf'], '--pdf needs a value');
  }, TEST_TIMEOUT);

  test('unknown flag', () => {
    expectGuard([f.html, '--bogus', '--pdf', 'out.pdf'], 'unknown argument --bogus');
  }, TEST_TIMEOUT);

  test('a file with no steps', () => {
    expectGuard([f.html], 'no steps given');
  }, TEST_TIMEOUT);

  test('numeric flags refuse non-numbers: --timeout, --wait-timeout, --width, --quality', () => {
    expectGuard([f.html, '--timeout', 'abc', '--pdf', 'out.pdf'], '--timeout wants a number');
    expectGuard([f.html, '--wait-timeout', 'abc', '--pdf', 'out.pdf'], '--wait-timeout wants a number');
    // --width / --quality are screenshot options: they need a --screenshot in
    // flight first, otherwise the "option before --screenshot" guard fires.
    expectGuard([f.html, '--screenshot', 'shot.png', '--width', 'abc'], '--width wants a number');
    expectGuard([f.html, '--screenshot', 'shot.png', '--quality', 'abc'], '--quality wants a number');
  }, TEST_TIMEOUT);

  test('screenshot option before any --screenshot', () => {
    expectGuard([f.html, '--width', '800', '--screenshot', 'shot.png'], 'screenshot option given before --screenshot');
  }, TEST_TIMEOUT);
});

// ─── --help ──────────────────────────────────────────────────────────────────

describe('gstack-render CLI: --help', () => {
  let f: Fixture;
  beforeAll(() => { f = makeFixture(); });
  afterAll(() => { fs.rmSync(f.dir, { recursive: true, force: true }); });

  for (const flag of ['--help', '-h']) {
    test(`${flag} prints the usage line to STDOUT and exits 0`, () => {
      const r = runCli(f, [flag]);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdoutLines.length).toBe(1);
      expect(r.stdoutLines[0]).toStartWith(USAGE_PREFIX);
      expect(argvLog(f)).toEqual([]);
    }, TEST_TIMEOUT);
  }
});

// ─── Success output contract ─────────────────────────────────────────────────

/** One success-path invocation: its own fixture (the fake's log is per fixture) and its own argv. */
interface SuccessCase {
  args: (f: Fixture) => string[];
  opts?: RunOpts;
}

const SUCCESS_CASES = {
  artifacts: {
    args: (f) => [
      f.html, '--timeout', '5000',
      '--pdf', path.join(f.dir, 'out', 'doc.pdf'), '--paper', 'letter', '--margin', '1in', '--page-numbers', '--tagged',
      '--screenshot', path.join(f.dir, 'out', 'shot.png'), '--width', '800', '--height', '600',
      '--eval', 'window.__svg', '--out', path.join(f.dir, 'out', 'd.svg'),
    ],
  },
  inlineEval: { args: (f) => [f.html, '--timeout', '5000', '--eval', 'document.title'] },
  evalAfterPdf: { args: (f) => [f.html, '--timeout', '5000', '--pdf', path.join(f.dir, 'idx.pdf'), '--eval', 'document.title'] },
  evalWithErrors: { args: (f) => [f.html, '--timeout', '5000', '--eval', 'document.title'], opts: { pageErrs: '["boom"]' } },
  errorsOnly: { args: (f) => [f.html, '--timeout', '5000', '--pdf', path.join(f.dir, 'errs.pdf')], opts: { pageErrs: '["boom"]' } },
  cleanPdf: { args: (f) => [f.html, '--timeout', '5000', '--pdf', path.join(f.dir, 'clean.pdf')], opts: { pageErrs: '[]' } },
  waitSelector: { args: (f) => [f.html, '--timeout', '5000', '--wait-selector', '#done', '--eval', 'document.title'] },
  serveRoot: { args: (f) => [f.html, '--timeout', '5000', '--serve-root', f.dir, '--pdf', path.join(f.dir, 'root.pdf')] },
} satisfies Record<string, SuccessCase>;

type SuccessKey = keyof typeof SUCCESS_CASES;
type Done = { f: Fixture; r: CliResult };

const successFixtures: Fixture[] = [];
let successBatch: Promise<Record<SuccessKey, Done>> | undefined;
/** Start every success case at once on first use; every test then awaits the same batch. */
function successRuns(): Promise<Record<SuccessKey, Done>> {
  successBatch ??= (async () => {
    const entries = await Promise.all((Object.keys(SUCCESS_CASES) as SuccessKey[]).map(async (key) => {
      const c: SuccessCase = SUCCESS_CASES[key];
      const f = makeFixture();
      successFixtures.push(f);
      return [key, { f, r: await runCliAsync(f, c.args(f), c.opts) }] as const;
    }));
    return Object.fromEntries(entries) as Record<SuccessKey, Done>;
  })();
  return successBatch;
}
// File-level: the batch is shared by two describes (--serve-root reads its fixture too).
afterAll(() => { for (const f of successFixtures) fs.rmSync(f.dir, { recursive: true, force: true }); });

describe.skipIf(isWin)('gstack-render CLI: output contract through the browse fallback', () => {
  test('pdf + screenshot + eval --out: ENGINE=browse first, one OK per artifact, files exist, no fence without inline evals', async () => {
    const { f, r } = (await successRuns()).artifacts;
    const pdf = path.join(f.dir, 'out', 'doc.pdf');
    const shot = path.join(f.dir, 'out', 'shot.png');
    const svg = path.join(f.dir, 'out', 'd.svg');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', `OK ${pdf}`, `OK ${shot}`, `OK ${svg}`]);
    expect(r.stdout).not.toContain(FENCE_BEGIN);
    expect(r.stdout).not.toContain('PAGE_ERRORS');
    expect(fs.readFileSync(pdf, 'utf8')).toStartWith('%PDF');
    expect(fs.readFileSync(shot).subarray(1, 4).toString()).toBe('PNG');
    expect(fs.readFileSync(svg, 'utf8')).toBe('written-by-fake');

    // The daemon conversation the CLI drove: tab 7 throughout, served URL on
    // loopback pointing at the file inside its own directory, tab closed last.
    const log = argvLog(f);
    expect(log[0]).toBe('newtab --json');
    expect(log[1]).toMatch(/^goto http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/doc\.html --tab-id 7$/);
    expect(log.some((l) => l.startsWith('pdf --from-file ') && l.endsWith(' --tab-id 7'))).toBe(true);
    expect(log).toContain('viewport 800x600 --tab-id 7');
    expect(log.some((l) => /^screenshot \/tmp\/gstack-render-browse-[^ ]+\/gstack-render-1\.png --tab-id 7$/.test(l))).toBe(true);
    expect(log).toContain('viewport 1280x720 --tab-id 7'); // default restored after a sized shot
    expect(log.some((l) => l.startsWith('js window.__svg --out ') && l.endsWith(' --tab-id 7'))).toBe(true);
    expect(log[log.length - 1]).toBe('closetab 7');

    // The pdf options the CLI parsed reached the daemon as a --from-file payload.
    const payload = JSON.parse(fs.readFileSync(path.join(f.fakeDir, 'pdf-payload.json'), 'utf8'));
    expect(payload.width).toBe('8.5in');
    expect(payload.height).toBe('11in');
    expect(payload.marginTop).toBe('1in');
    expect(payload.marginLeft).toBe('1in');
    expect(payload.tagged).toBe(true);
    expect(payload.footerTemplate).toContain('pageNumber');
    expect(payload.headerTemplate).toBe('<div></div>');
  }, BATCH_TIMEOUT);

  test('inline --eval prints EVAL <i>: <text> inside the UNTRUSTED WEB CONTENT fence', async () => {
    const { r } = (await successRuns()).inlineEval;
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', FENCE_BEGIN, 'EVAL 0: Hello From Page', FENCE_END]);
  }, BATCH_TIMEOUT);

  test('eval index follows step order: an artifact step before it keeps its slot', async () => {
    const { f, r } = (await successRuns()).evalAfterPdf;
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', `OK ${path.join(f.dir, 'idx.pdf')}`, FENCE_BEGIN, 'EVAL 1: Hello From Page', FENCE_END]);
  }, BATCH_TIMEOUT);

  test('page errors appear as PAGE_ERRORS=[...] inside the same fence as the evals', async () => {
    const { r } = (await successRuns()).evalWithErrors;
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', FENCE_BEGIN, 'EVAL 0: Hello From Page', 'PAGE_ERRORS=["boom"]', FENCE_END]);
  }, BATCH_TIMEOUT);

  test('page errors with no evals still get a fence of their own', async () => {
    const { f, r } = (await successRuns()).errorsOnly;
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', `OK ${path.join(f.dir, 'errs.pdf')}`, FENCE_BEGIN, 'PAGE_ERRORS=["boom"]', FENCE_END]);
  }, BATCH_TIMEOUT);

  test('an empty error list prints no PAGE_ERRORS line and, with no evals, no fence at all', async () => {
    const { f, r } = (await successRuns()).cleanPdf;
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', `OK ${path.join(f.dir, 'clean.pdf')}`]);
  }, BATCH_TIMEOUT);

  test('--wait-selector polls the page through js before the first step', async () => {
    const { f, r } = (await successRuns()).waitSelector;
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toContain('EVAL 0: Hello From Page');
    const log = argvLog(f);
    const gotoAt = log.findIndex((l) => l.startsWith('goto '));
    const pollAt = log.findIndex((l) => l.startsWith('js (() => { try { return !!(document.querySelector("#done")); }'));
    const evalAt = log.findIndex((l) => l === 'js document.title --tab-id 7');
    expect(gotoAt).toBeGreaterThan(-1);
    expect(pollAt).toBeGreaterThan(gotoAt);
    expect(evalAt).toBeGreaterThan(pollAt);
  }, BATCH_TIMEOUT);

  test('a successful render exits promptly: no dangling runProc timer holds the process after its output', async () => {
    const runs = await successRuns();
    for (const [key, { r }] of Object.entries(runs)) {
      expect(r.status).toBe(0);
      if (r.durationMs >= PROMPT_EXIT_MS) {
        throw new Error(`${key}: exited 0 after ${r.durationMs}ms — output was complete long before; a timer in lib/aside-render.ts runProc is being left uncleared again (the CLI has no process.exit(0) on success)`);
      }
    }
  }, BATCH_TIMEOUT);
});

// ─── Failure path ────────────────────────────────────────────────────────────

describe.skipIf(isWin)('gstack-render CLI: failure path', () => {
  let f: Fixture;
  beforeAll(() => { f = makeFixture(); });
  afterAll(() => { fs.rmSync(f.dir, { recursive: true, force: true }); });

  test('a failing goto: ENGINE=browse still first on stdout, ERROR + transcript tail on stderr, exit 1, tab closed', () => {
    const pdf = path.join(f.dir, 'never.pdf');
    const r = runCli(f, [f.html, '--pdf', pdf], { fail: 'goto' });
    expect(r.status).toBe(1);
    expect(r.stdoutLines).toEqual(['ENGINE=browse']);
    expect(r.stderrLines[0]).toBe('ERROR: browse goto failed: fake browse: goto refused');
    // The transcript tail: the daemon calls the render made, verbatim.
    expect(r.stderr).toContain('$ browse newtab --json');
    expect(r.stderr).toMatch(/\$ browse goto http:\/\/127\.0\.0\.1:/);
    expect(fs.existsSync(pdf)).toBe(false);
    const log = argvLog(f);
    expect(log[log.length - 1]).toBe('closetab 7');
  }, TEST_TIMEOUT);

  test('--quiet drops the transcript tail but keeps ERROR:', () => {
    const r = runCli(f, [f.html, '--quiet', '--pdf', path.join(f.dir, 'never2.pdf')], { fail: 'goto' });
    expect(r.status).toBe(1);
    expect(r.stdoutLines).toEqual(['ENGINE=browse']);
    expect(r.stderrLines).toEqual(['ERROR: browse goto failed: fake browse: goto refused']);
    expect(r.stderr).not.toContain('$ browse');
  }, TEST_TIMEOUT);

  test('a missing HTML file fails before any daemon call', () => {
    const missing = path.join(f.dir, 'nope.html');
    const r = runCli(f, [missing, '--pdf', path.join(f.dir, 'x.pdf')]);
    expect(r.status).toBe(1);
    expect(r.stdoutLines).toEqual(['ENGINE=browse']);
    expect(r.stderrLines[0]).toBe(`ERROR: HTML file not found: ${missing}`);
    expect(argvLog(f)).toEqual([]);
  }, TEST_TIMEOUT);
});

// ─── --serve-root ────────────────────────────────────────────────────────────

describe.skipIf(isWin)('gstack-render CLI: --serve-root', () => {
  let f: Fixture;
  beforeAll(() => { f = makeFixture(); });
  afterAll(() => { fs.rmSync(f.dir, { recursive: true, force: true }); });

  test('a serve root containing the file serves it by its path relative to that root', async () => {
    const { f: sf, r } = (await successRuns()).serveRoot;
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdoutLines).toEqual(['ENGINE=browse', `OK ${path.join(sf.dir, 'root.pdf')}`]);
    expect(argvLog(sf).some((l) => /^goto http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/site\/doc\.html --tab-id 7$/.test(l))).toBe(true);
  }, BATCH_TIMEOUT);

  test('a serve root that does not contain the file is refused before any daemon call', () => {
    const elsewhere = path.join(f.dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const r = runCli(f, [f.html, '--serve-root', elsewhere, '--pdf', path.join(f.dir, 'no.pdf')]);
    expect(r.status).toBe(1);
    expect(r.stdoutLines).toEqual(['ENGINE=browse']);
    expect(r.stderrLines[0]).toBe(`ERROR: file ${f.html} is outside serveRoot ${elsewhere}`);
    expect(argvLog(f)).toEqual([]);
  }, TEST_TIMEOUT);
});

// ─── Neither browser ─────────────────────────────────────────────────────────

describe('gstack-render CLI: neither browser available', () => {
  // resolveBrowseBin also searches <repo>/browse/dist/browse (via import.meta.dir)
  // and ~/.claude/skills/gstack/browse/dist/browse — both usually built on a dev
  // box, so the environment alone cannot force "no engine". The CLI imports only
  // ../lib/aside-render, which imports only builtins, so byte-identical copies of
  // the two files staged in a temp tree move the repo root somewhere empty; HOME
  // moves the install root; PATH is a dir with no `browse`. The one root left
  // (process.execPath/../..) is probed and skips this case if it holds a browse.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-stage-'));
  const emptyBin = path.join(stage, 'empty-bin');
  const fakeHome = path.join(stage, 'home');
  fs.mkdirSync(emptyBin);
  fs.mkdirSync(fakeHome);
  const execRoot = path.resolve(path.dirname(process.execPath), '../..');
  const uncontrollable = resolveBrowseBin({ PATH: emptyBin }, [execRoot]);
  afterAll(() => { fs.rmSync(stage, { recursive: true, force: true }); });

  test.skipIf(!!uncontrollable)('first line is NEEDS_ASIDE and the error names both remedies', () => {
    for (const rel of ['bin/gstack-render.ts', 'lib/aside-render.ts']) {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(stage, rel));
    }
    const html = path.join(stage, 'doc.html');
    fs.writeFileSync(html, '<!doctype html><title>Doc</title>');
    const env: Record<string, string | undefined> = {
      ...process.env,
      GSTACK_SKIP_ASIDE: '1',
      GSTACK_BROWSE_BIN: path.join(stage, 'does-not-exist', 'browse'),
      BROWSE_BIN: undefined,
      PATH: emptyBin,
      HOME: fakeHome,
    };
    const r = spawnSync(BUN, [path.join(stage, 'bin/gstack-render.ts'), html, '--pdf', path.join(stage, 'out.pdf')], { encoding: 'utf8', env, timeout: TEST_TIMEOUT });
    const out = shape(r.status, r.stdout ?? '', r.stderr ?? '');
    expect(out.status).toBe(1);
    expect(out.stdoutLines).toEqual(['NEEDS_ASIDE']);
    expect(out.stderrLines.length).toBe(1);
    expect(out.stderrLines[0]).toStartWith('ERROR: no browser available: ');
    expect(out.stderrLines[0]).toContain('Aside');
    expect(out.stderrLines[0]).toContain('./setup');
    expect(out.stderrLines[0]).toContain('GSTACK_BROWSE_BIN');
    expect(out.stderrLines[0]).toContain('(NEEDS_ASIDE: GSTACK_SKIP_ASIDE=1');
    expect(fs.existsSync(path.join(stage, 'out.pdf'))).toBe(false);
  }, TEST_TIMEOUT);
});
