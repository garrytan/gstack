/**
 * The app profile's contract without a browser (GST-1741 PR 1): usage errors
 * before any render, state-file and waiver validation, the verdict and exit
 * precedence, URL redaction, private trace files, RENDER_UNAVAILABLE for a
 * --url nobody measured, and the scope guard that keeps app rules out of the
 * page and component profiles. A fake runner stands in for the browser; the
 * measured behavior is test/design-lint-app-profile.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RenderResult, RenderSpec } from '../lib/aside-render';
import { parseStateFile, parseViewport, parseWaiverFile, redactText, redactUrl, selectorError, stateNameOf } from '../lib/design-lint/app-input';
import { appMain, renderUnavailable, type AppCliArgs, type AppDeps } from '../lib/design-lint/app-cli';
import { lint } from '../lib/design-lint/index';
import { lintApp, APP_CODES } from '../lib/design-lint/render-app';
import { appInstallScript, composedWaitExpression } from '../lib/design-lint/render-probe-app';
import { installScript } from '../lib/design-lint/render-probe';
import { finalize, Reporter, type Finding } from '../lib/design-lint/report';
import { RULES } from '../lib/design-lint/rules/ids';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-lint');
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'design-lint-app-')); tmp.push(d); return d; };

function runBin(args: string[]) {
  const r = Bun.spawnSync([BIN, ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const APP_IDS = Object.entries(RULES).filter(([, m]) => m.app).map(([id]) => id);
const URL1 = 'http://127.0.0.1:5300/settings?as=owner';

interface Fake { setup?: unknown; measure?: (width: number, call: string) => unknown; fail?: string }
const ok = (findings: unknown[] = [], extra: Record<string, unknown> = {}) => ({ status: 'measured', matched: 1, roots: 1, lists: 1, findings, ...extra });
const f = (rule: string, locator: string, measured = 4, threshold = 8) => ({ rule, sentence: 'a 2-line row leaves ' + measured + 'px between its text and its top edge (under ' + threshold + 'px)', locator, measured, threshold });

/** A runner that answers every step the scheduler plans, and records each spec it was handed. */
function fakeRun(fake: Fake, specs: RenderSpec[] = []) {
  return async (spec: RenderSpec): Promise<RenderResult> => {
    specs.push(spec);
    if (fake.fail) return { ok: false, outputs: [], evals: {}, stdout: '', error: fake.fail };
    const evals: Record<number, string> = {};
    spec.steps.forEach((s, i) => {
      if (s.kind !== 'eval') return;
      if (i === 0) evals[i] = '1';
      else if (s.expression.includes('P.setup(P)')) evals[i] = JSON.stringify(fake.setup ?? { lostSheets: [], lostFonts: [] });
      else evals[i] = JSON.stringify(fake.measure ? fake.measure(s.width ?? 0, s.expression) : ok());
    });
    return { ok: true, outputs: [], evals, stdout: '' };
  };
}

const args = (over: Partial<AppCliArgs> = {}): AppCliArgs => ({ paths: [], urls: [URL1], within: '.sharing', viewports: [], verbose: false, json: false, ...over });

async function app(over: Partial<AppCliArgs>, deps: AppDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await appMain(args(over), { out: (s) => out.push(s), err: (s) => err.push(s) }, { reach: async () => null, traceDir: tmpDir(), ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const neverRun = async (): Promise<RenderResult> => { throw new Error('the runner must not be called for a usage error'); };

describe('app profile contract: usage errors exit 3 before any render (T24, T30)', () => {
  test('the bin refuses paths, a missing --within, a bad selector, a bad viewport and both or neither target', () => {
    for (const [argv, code] of [
      [['--scope', 'app', 'x.html', '--within', 'main'], 'APP_PATHS'],
      [['--scope', 'app', '--url', URL1], 'NO_WITHIN'],
      [['--scope', 'app', '--url', URL1, '--within', '.rows['], 'BAD_SELECTOR'],
      [['--scope', 'app', '--url', URL1, '--within', 'main', '--wait-for', 'a >'], 'BAD_SELECTOR'],
      [['--scope', 'app', '--url', URL1, '--within', 'main', '--viewport', '100x900'], 'BAD_VIEWPORT'],
      [['--scope', 'app', '--url', URL1, '--within', 'main', '--viewport', '1440x900x'], 'BAD_VIEWPORT'],
      [['--scope', 'app', '--url', URL1, '--within', 'main', '--viewport', '4000x900'], 'BAD_VIEWPORT'],
      [['--scope', 'app', '--within', 'main'], 'NO_TARGET'],
      [['--scope', 'app', '--url', 'ftp://x.test/p', '--within', 'main'], 'BAD_URL'],
      [['--scope', 'app', '--url', URL1, '--state-file', 'x.json', '--within', 'main'], 'BOTH_TARGETS'],
      [['--scope', 'app', '--state-file', '/nowhere/states.json', '--within', 'main'], 'BAD_STATE_FILE'],
    ] as Array<[string[], string]>) {
      const r = runBin(argv);
      expect([argv.join(' '), r.code, r.out]).toEqual([argv.join(' '), 3, '']);
      expect(r.err).toMatch(new RegExp('^gstack-design-lint: ' + code + ': .+ \\| fix: .+$', 'm'));
    }
  });

  test('every app-only flag without --scope app exits 3 naming the flag; --verbose works anywhere', () => {
    for (const flag of ['--within', '--viewport', '--wait-for', '--waivers', '--state-file']) {
      const r = runBin(['test/fixtures/design-lint/clean', flag, 'x']);
      expect([r.code, r.err.trim()]).toEqual([3, 'gstack-design-lint: APP_ONLY: ' + flag + ' only with --scope app | fix: add --scope app, or drop ' + flag]);
    }
    const plain = runBin(['test/fixtures/design-lint/clean']);
    const verbose = runBin(['test/fixtures/design-lint/clean', '--verbose']);
    expect([verbose.code, verbose.out]).toEqual([plain.code, plain.out]);
    const usage = runBin(['--help']);
    expect(usage.out).toContain('gstack-design-lint --scope app (--url <http://…> ... | --state-file <states.json>) --within <selector>');
  });

  test('an invalid selector never reaches the runner', async () => {
    const r = await app({ within: 'div > > p' }, { run: neverRun });
    expect(r.code).toBe(3);
    expect(r.err).toContain('BAD_SELECTOR');
  });

  test('selector and viewport grammar', () => {
    for (const ok of ['.sharing', 'qm-sharing', 'main .rows > .row:nth-of-type(2)', '[data-x="a]b"]', 'a, b', ':is(.a, .b) li', 'x-y\\:z', '#main']) expect([ok, selectorError(ok)]).toEqual([ok, null]);
    for (const bad of ['', '.rows[', 'div >', '> div', 'a,,b', 'a {}', 'p:', '.', '#', '(a', 'a)', 'a !b', '"q"']) expect([bad, selectorError(bad)]).not.toEqual([bad, null]);
    expect(parseViewport('375x812')).toEqual({ width: 375, height: 812 });
    expect(parseViewport('3840x2400')).toEqual({ width: 3840, height: 2400 });
    for (const bad of ['319x900', '1440x479', '1440x2401', '14400x900', '1440X900', ' 1440x900', '1440x900.5']) expect(() => parseViewport(bad)).toThrow(/--viewport/);
  });
});

describe('app profile contract: state files and waivers (T12, T23, T30, T36)', () => {
  test('a state file is validated whole: unknown keys, no url, a bad version or selector, a duplicate name; a non-loopback URL is noted', () => {
    const good = parseStateFile(JSON.stringify({ version: 1, states: [{ name: 'owner', url: URL1, expect: '.owner-note' }, { url: 'https://staging.example.test/p?as=reader&token=abc' }] }));
    expect(good.states.map((s) => s.name)).toEqual(['owner', '/p?as=reader&token=REDACTED']);
    expect(good.notes).toEqual(['state /p?as=reader&token=REDACTED is not on a loopback address (https://staging.example.test/p?as=reader&token=REDACTED)']);
    for (const [doc, why] of [
      ['{', 'not JSON'],
      [{ version: 1, states: [], extra: 1 }, 'unknown key extra'],
      [{ version: 2, states: [{ url: URL1 }] }, 'version must be 1'],
      [{ version: 1, states: [] }, 'states is empty'],
      [{ version: 1, states: [{ name: 'a' }] }, 'states[0] has no url'],
      [{ version: 1, states: [{ url: 'file:///x.html' }] }, 'not an http or https address'],
      [{ version: 1, states: [{ url: URL1, wait: 1 }] }, 'states[0] has unknown key wait'],
      [{ version: 1, states: [{ url: URL1, expect: 'a >' }] }, 'not a valid selector'],
      [{ version: 1, states: [{ url: URL1, name: 'a' }, { url: URL1, name: 'a' }] }, 'two states are named a'],
    ] as Array<[unknown, string]>) {
      expect(() => parseStateFile(typeof doc === 'string' ? doc : JSON.stringify(doc))).toThrow(why);
    }
  });

  test('a bad state file through the bin exits 3 with its reason', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ version: 1, states: [{ url: URL1, color: 'red' }] }));
    const r = runBin(['--scope', 'app', '--state-file', path.join(dir, 's.json'), '--within', 'main']);
    expect([r.code, r.err.trim()]).toEqual([3, expect.stringMatching(/^gstack-design-lint: BAD_STATE_FILE: --state-file: states\[0\] has unknown key color \| fix: /)]);
  });

  test('a waiver file names an app rule, a locator and a reason of 8 characters or more; anything else exits 3', async () => {
    const isApp = (id: string) => !!RULES[id]?.app;
    expect(parseWaiverFile(JSON.stringify({ version: 1, waivers: [{ rule: 'small-hit-area', locator: 'button.x', reason: 'the glyph sits in a 44px label target' }] }), isApp)).toHaveLength(1);
    for (const [w, why] of [
      [{ rule: 'low-contrast', locator: 'a', reason: 'long enough reason' }, 'is not an app rule'],
      [{ rule: 'nope', locator: 'a', reason: 'long enough reason' }, 'is not an app rule'],
      [{ rule: 'small-hit-area', locator: 'a', reason: 'short' }, '8 characters or more'],
      [{ rule: 'small-hit-area', locator: ' ', reason: 'long enough reason' }, 'locator must be'],
      [{ rule: 'small-hit-area', locator: 'a', reason: 'long enough reason', page: 'x' }, 'unknown key page'],
    ] as Array<[unknown, string]>) expect(() => parseWaiverFile(JSON.stringify({ version: 1, waivers: [w] }), isApp)).toThrow(why);
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'w.json'), JSON.stringify({ version: 1, waivers: [{ rule: 'row-crowding', locator: 'a', reason: 'tiny' }] }));
    const r = await app({ waivers: path.join(dir, 'w.json') }, { run: neverRun });
    expect([r.code, r.err]).toEqual([3, expect.stringContaining('BAD_WAIVERS')]);
  });

  test('a matched waiver prints at waived with its reason and leaves the verdict clean; an unused one is a waiver finding (T6, T23, T28, T35)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'w.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, waivers: [
      { rule: 'small-hit-area', locator: 'button.remove', reason: 'the remove glyph sits inside a 44px label target' },
      { rule: 'row-crowding', locator: 'div.never', reason: 'kept to show an unused waiver' },
    ] }));
    const run = fakeRun({ measure: (w) => ok(w === 375 ? [f('small-hit-area', 'qm-x >>> div.row > button.remove "Remove Dana"', 18, 32)] : []) });
    const r = await app({ waivers: file }, { run });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^LINT: waived small-hit-area .+ \| fix: waived \(the remove glyph sits inside a 44px label target\)$/m);
    expect(r.out).toMatch(/^LINT: ask waiver --waivers:2 waiver on row-crowding at "div\.never" matched no finding \(unused\) \| fix: /m);
    expect(r.out).toMatch(/^LINT_APP: verdict=clean code=OK states=1\/1 viewports=1440x900,375x812 within=\.sharing matched=1 open=0 waived=1$/m);
  });
});

describe('app profile contract: verdict, codes and exit precedence (T8, T15, T16, T19, T27)', () => {
  test('clean is 0 only on complete coverage with nothing open; any unwaived app finding is open (1) whatever its tier', async () => {
    const clean = await app({}, { run: fakeRun({}) });
    expect([clean.code, clean.out.split('\n').slice(-1)[0]]).toEqual([0, 'LINT_APP: verdict=clean code=OK states=1/1 viewports=1440x900,375x812 within=.sharing matched=1 open=0 waived=0']);
    const open = await app({ json: true }, { run: fakeRun({ measure: () => ok([f('row-crowding', 'div.rows > div.row:nth-of-type(1) "Deploy key"')]) }) });
    expect(open.code).toBe(1);
    const json = JSON.parse(open.out);
    expect(json.app).toMatchObject({ verdict: 'open', code: 'OPEN', open: 2, waived: 0, codes: [] });
    expect(json.app.states.map((s: { viewport: string; status: string; code: string }) => [s.viewport, s.status, s.code])).toEqual([['1440x900', 'measured', 'OK'], ['375x812', 'measured', 'OK']]);
    expect(json.summary.ask).toBe(2);
  });

  test('incomplete wins over open and is never printed clean: one viewport not measured exits 4', async () => {
    const run = fakeRun({ measure: (w) => (w === 375 ? { status: 'incomplete', code: 'NOT_READY', detail: 'no list', matched: 1, roots: 1, lists: 0, findings: [] } : ok([f('row-crowding', 'div.row "A"')])) });
    const r = await app({}, { run });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/^LINT_APP_STATE: state=\/settings\?as=owner viewport=375x812 status=incomplete code=NOT_READY matched=1 no list \| fix: pass --wait-for .+ \(docs\/design-lint\.md#app-code-not_ready\)$/m);
    expect(r.out).toMatch(/^LINT_APP: verdict=incomplete code=NOT_READY states=0\/1 .* open=1 waived=0$/m);
  });

  test('several codes report the first in the documented order and list them all', async () => {
    const result = await lintApp({
      states: [{ name: 'a', url: 'http://127.0.0.1:1/a' }, { name: 'b', url: URL1 }, { name: 'c', url: 'http://127.0.0.1:5300/c' }],
      within: 'main', traceDir: tmpDir(),
      reach: async (u) => (u.endsWith('/a') ? 'connection refused' : null),
      run: fakeRun({ measure: (w, call) => (call.includes('"expect":null') && w === 1440 ? { status: 'incomplete', code: 'STATE_MISMATCH', matched: 1, roots: 1, lists: 1, findings: [] } : { error: 'TypeError: x is not a function', stack: 'TypeError: x\n    at http://127.0.0.1:5300/app.js?token=SECRET:1:1' }) }),
    });
    expect(result.exitCode).toBe(4);
    expect(result.app.code).toBe('UNREACHABLE');
    expect(result.app.codes).toEqual(['UNREACHABLE', 'STATE_MISMATCH', 'PROBE_ERROR']);
    expect(APP_CODES.indexOf('UNREACHABLE')).toBeLessThan(APP_CODES.indexOf('PROBE_ERROR'));
  });

  test('a failed render maps to its code: no browser, timeout, the --wait-for never matching, anything else unreachable', async () => {
    const codeOf = async (fail: string, waitFor?: string) => (await lintApp({ states: [{ name: 's', url: URL1 }], within: 'main', waitFor, reach: async () => null, run: fakeRun({ fail }) })).app.code;
    expect(await codeOf('no browser available: run ./setup')).toBe('NO_BROWSER');
    expect(await codeOf('aside repl did not run: timed out after 130000ms')).toBe('TIMEOUT');
    expect(await codeOf('waitFor expression never became truthy: (() => …)() (waited 15000ms)', '.ready')).toBe('NOT_READY');
    expect(await codeOf('browse goto failed: net::ERR_CONNECTION_REFUSED')).toBe('UNREACHABLE');
  });

  test('a stylesheet that did not load is ASSET_MISSING; a font that did not load is a note and the state stays measured', async () => {
    const sheet = await lintApp({ states: [{ name: 's', url: URL1 }], within: 'main', reach: async () => null, run: fakeRun({ setup: { lostSheets: ['app.css'], lostFonts: [] } }) });
    expect([sheet.app.code, sheet.app.states[0].detail]).toEqual(['ASSET_MISSING', 'stylesheets did not load: app.css']);
    const font = await lintApp({ states: [{ name: 's', url: URL1 }], within: 'main', reach: async () => null, run: fakeRun({ setup: { lostSheets: [], lostFonts: ['Inter'] } }) });
    expect([font.app.verdict, font.app.notes]).toEqual(['clean', ['s: fonts did not load (Inter); measured with a fallback face']]);
  });

  test('a probe answer the lint does not know is PROBE_ERROR, never a finding: a page rule, an unknown code, a malformed list', async () => {
    for (const answer of [ok([f('low-contrast', 'p')]), ok([{ rule: 'row-crowding' }]), { status: 'incomplete', code: 'FINE', matched: 1, findings: [] }, [1, 2], 'x']) {
      const r = await lintApp({ states: [{ name: 's', url: URL1 }], within: 'main', reach: async () => null, run: fakeRun({ measure: () => answer }) });
      expect([JSON.stringify(answer), r.app.code, r.findings]).toEqual([JSON.stringify(answer), 'PROBE_ERROR', []]);
    }
  });
});

describe('app profile contract: the plan handed to the browser (T2, T25, T32)', () => {
  test('one render per state: the app install, setup, one measure per viewport at its size; readiness waits on the section through shadow roots', async () => {
    const specs: RenderSpec[] = [];
    await lintApp({ states: [{ name: 's', url: URL1, expect: '.owner' }], within: 'qm-sharing', viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844 }], reach: async () => null, run: fakeRun({}, specs) });
    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec.file).toBe(URL1);
    expect(spec.steps.map((s) => (s.kind === 'eval' ? [s.width, s.height, s.expression.includes('P.setup(P)') ? 'setup' : s.expression.includes('P.measure(P') ? 'measure' : 'install'] : s.kind))).toEqual([[1280, 800, 'install'], [1280, 800, 'setup'], [1280, 800, 'measure'], [390, 844, 'measure']]);
    const first = spec.steps[0];
    expect(first.kind === 'eval' && first.expression).toBe(appInstallScript());
    const measure = spec.steps[2];
    expect(measure.kind === 'eval' && measure.expression).toContain('"within":"qm-sharing","expect":".owner","explicitWait":false,"readyMs":5000');
    expect(spec.waitFor?.selector).toBeUndefined();
    expect(spec.waitFor?.timeoutMs).toBe(16_000);
    expect(spec.waitFor?.expression).toContain('"qm-sharing"');
    expect(spec.waitFor?.expression).toContain('shadowRoot');
    expect(spec.waitFor?.expression).toContain('> 15000');
    const explicit: RenderSpec[] = [];
    await lintApp({ states: [{ name: 's', url: URL1 }], within: 'main', waitFor: '.loaded', reach: async () => null, run: fakeRun({}, explicit) });
    expect(explicit[0].waitFor?.timeoutMs).toBe(15_000);
    expect(explicit[0].waitFor?.expression).not.toContain('> 15000');
    expect(explicit[0].steps[2].kind === 'eval' && explicit[0].steps[2].expression).toContain('"explicitWait":true');
  });

  test('the scripted variants build the same Sharing section the static replica holds', () => {
    const sandbox: { SHARING_HTML?: string } = {};
    new Function('window', fs.readFileSync(path.join(ROOT, 'test/fixtures/ui-spacing/sharing.js'), 'utf8'))(sandbox);
    expect(sandbox.SHARING_HTML!.length).toBeGreaterThan(1000);
    expect(fs.readFileSync(path.join(ROOT, 'test/fixtures/ui-spacing/replica.html'), 'utf8')).toContain(sandbox.SHARING_HTML!);
  });

  test('the page probes are untouched: the page install script carries no app probe, and the app install no page probe', () => {
    expect(installScript()).not.toContain('__gstackLintApp');
    expect(appInstallScript()).not.toContain('__gstackLint =');
    expect(appInstallScript()).toContain('window.__gstackLintApp = { H: (');
  });
});

describe('app profile contract: findings, redaction and traces (T22, T29, T34, T19)', () => {
  test('findings keep state, viewport, locator, measured px and threshold whole; distinct rows and viewports are never merged', async () => {
    const long = 'qm-panel >>> ' + Array.from({ length: 12 }, (_, i) => 'div.level-' + i).join(' > ') + ' > div.row:nth-of-type(2) "Deploy key Read-only access to the repo"';
    const run = fakeRun({ measure: () => ok([f('row-crowding', long), f('row-crowding', long.replace('nth-of-type(2)', 'nth-of-type(3)'))]) });
    const r = await lintApp({ states: [{ name: 'owner', url: URL1 }], within: 'main', reach: async () => null, run });
    const rows = r.findings.filter((x) => x.rule === 'row-crowding');
    expect(rows).toHaveLength(4);
    expect(rows[0].app).toEqual({ state: 'owner', viewport: '1440x900', locator: long, measured: 4, threshold: 8 });
    expect(rows[0].evidence).toBe('[owner 1440px] a 2-line row leaves 4px between its text and its top edge (under 8px) at ' + long);
    expect(new Set(rows.map((x) => x.app!.viewport + x.app!.locator)).size).toBe(4);
    const dup: Finding = { ...rows[0] };
    expect(finalize([rows[0], dup])).toHaveLength(1);
  });

  test('credentials in a URL never reach text, JSON, stderr or a trace; navigation and the reachability check use the real URL', async () => {
    const userinfo = ['dana', 'PWSENTINEL'].join(':') + '@';
    const secret = 'http://' + userinfo + '127.0.0.1:5300/settings?as=owner&token=TOKSENTINEL&sig=SIGSENTINEL&session_id=SESSENTINEL';
    const reached: string[] = [];
    const specs: RenderSpec[] = [];
    const run = fakeRun({ measure: (w) => (w === 375 ? { error: 'Error: boom at ' + secret, stack: 'Error: boom\n    at ' + secret + ':1:1' } : ok([f('row-crowding', 'div.row "x"')])) }, specs);
    const traceDir = tmpDir();
    for (const json of [false, true]) {
      const out: string[] = [];
      const err: string[] = [];
      await appMain(args({ urls: [secret], json, verbose: true }), { out: (s) => out.push(s), err: (s) => err.push(s) }, { run, traceDir, reach: async (u) => { reached.push(u); return null; } });
      const all = out.join('\n') + err.join('\n') + fs.readdirSync(traceDir).map((t) => fs.readFileSync(path.join(traceDir, t), 'utf8')).join('');
      for (const s of ['PWSENTINEL', 'TOKSENTINEL', 'SIGSENTINEL', 'SESSENTINEL', 'dana:']) expect([json, s, all.includes(s)]).toEqual([json, s, false]);
      expect(all).toContain('token=REDACTED');
    }
    expect(specs.map((s) => s.file)).toEqual([secret, secret]);
    expect(reached).toEqual([secret, secret]);
    expect(redactUrl('https://' + ['u', 'p'].join(':') + '@h.test/a?code=1&next=/b')).toBe('https://h.test/a?code=REDACTED&next=%2Fb');
    expect(redactText('see http://h.test/?jwt=abc and https://k.test/x?api_key=1')).toBe('see http://h.test/?jwt=REDACTED and https://k.test/x?api_key=REDACTED');
    expect(stateNameOf('http://h.test/p?as=owner&password=x')).toBe('/p?as=owner&password=REDACTED');
    expect(redactUrl('http://127.0.0.1:5300/cb#access_token=FRAGSENTINEL&state=x')).toBe('http://127.0.0.1:5300/cb#access_token=REDACTED&state=x');
    expect(redactText('at http://h.test/#id_token=FRAGSENTINEL')).toBe('at http://h.test/#id_token=REDACTED');
    expect(redactUrl('http://h.test/p#rows')).toBe('http://h.test/p#rows');
    const hashed = await app({ urls: ['http://127.0.0.1:5300/cb#access_token=FRAGSENTINEL'], json: true }, { run: fakeRun({ measure: () => ok([f('row-crowding', 'div.row "x"')]) }) });
    expect(hashed.out + hashed.err).not.toContain('FRAGSENTINEL');
  });

  test('a URL that does not parse and a token value holding ")" are redacted by pattern in text, JSON, stderr and traces', async () => {
    expect(redactUrl('http://' + ['u', 'PW'].join(':') + '@localhost:99999/p?a=1&token=BADSENTINEL#sig=FRAGBAD')).toBe('http://localhost:99999/p?a=1&token=REDACTED#sig=REDACTED');
    expect(stateNameOf('http://localhost:99999/p?token=BADSENTINEL')).toBe('http://localhost:99999/p?token=REDACTED');
    expect(redactText('fetch failed at http://h.test/p?token=prefix)PARENSENTINEL_TAIL (x)')).toBe('fetch failed at http://h.test/p?token=REDACTED (x)');
    expect(redactText('GET /api?api_key=a:b)c&as=owner failed')).toBe('GET /api?api_key=REDACTED&as=owner failed');
    const bad = 'http://localhost:99999/p?token=SENTINEL_INVALID';
    for (const argv of [[], ['--json']]) {
      const r = runBin(['--scope', 'app', '--url', bad, '--within', 'body', ...argv]);
      expect(r.code).toBe(4);
      expect(r.out + r.err).not.toContain('SENTINEL_INVALID');
      expect(r.out + r.err).toContain('token=REDACTED');
    }
    const paren = 'http://127.0.0.1:5300/p?as=owner&token=prefix)PARENSENTINEL';
    const traceDir = tmpDir();
    const run = fakeRun({ measure: (w) => (w === 375 ? { error: 'Error: boom at ' + paren, stack: 'Error: boom\n    at ' + paren + ':1:1' } : ok()) });
    for (const json of [false, true]) {
      const out: string[] = [];
      const err: string[] = [];
      await appMain(args({ urls: [paren], json, verbose: true }), { out: (s) => out.push(s), err: (s) => err.push(s) }, { run, traceDir, reach: async () => 'connect ECONNREFUSED for ' + paren });
      await appMain(args({ urls: [paren], json, verbose: true }), { out: (s) => out.push(s), err: (s) => err.push(s) }, { run, traceDir, reach: async () => null });
      const traces = fs.readdirSync(traceDir).map((t) => fs.readFileSync(path.join(traceDir, t), 'utf8')).join('');
      expect(traces.length).toBeGreaterThan(0);
      expect([json, (out.join('\n') + err.join('\n') + traces).includes('PARENSENTINEL')]).toEqual([json, false]);
    }
  });

  test('two --url states that share a redacted name stay two states; the same URL twice is DUPLICATE_STATE', async () => {
    const seen: string[] = [];
    const two = await app({ urls: ['http://127.0.0.1:5300/p?session=owner', 'http://127.0.0.1:5300/p?session=viewer'] }, { run: async (spec) => { seen.push(spec.file); return fakeRun({})(spec); } });
    expect(two.code).toBe(0);
    expect(seen).toEqual(['http://127.0.0.1:5300/p?session=owner', 'http://127.0.0.1:5300/p?session=viewer']);
    expect(two.out).toMatch(/^LINT_APP: verdict=clean code=OK states=2\/2 /m);
    expect(two.out).toContain('state=/p?session=REDACTED~2 viewport=1440x900');
    const literal = await app({ urls: ['http://127.0.0.1:5300/p', 'http://127.0.0.1:5300/p#x', 'http://127.0.0.1:5300/p~2'] }, { run: fakeRun({}) });
    expect(literal.out).toMatch(/^LINT_APP: verdict=clean code=OK states=3\/3 /m);
    expect([...new Set(literal.out.split('\n').filter((l) => l.startsWith('LINT_APP_STATE:')).map((l) => l.split(' ')[1]))]).toEqual(['state=/p', 'state=/p~2', 'state=/p~2~2']);
    const dup = await app({ urls: [URL1, URL1] }, { run: neverRun });
    expect([dup.code, dup.err]).toEqual([3, 'gstack-design-lint: DUPLICATE_STATE: --url ' + URL1 + ' is given twice | fix: measure each URL once']);
  });

  test('a probe that throws writes a 0600 trace under a private directory, names it, and prints its stack only with --verbose', async () => {
    const traceDir = path.join(tmpDir(), 'traces');
    const run = fakeRun({ measure: (w) => (w === 375 ? { error: 'TypeError: rows is undefined', stack: 'TypeError: rows is undefined\n    at glAppRows (eval:1:2)' } : ok()) });
    const quiet = await app({}, { run, traceDir });
    expect(quiet.code).toBe(4);
    const [trace] = fs.readdirSync(traceDir).map((t) => path.join(traceDir, t));
    if (process.platform !== 'win32') {
      expect(fs.statSync(trace).mode & 0o777).toBe(0o600);
      expect(fs.statSync(traceDir).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(fs.readFileSync(trace, 'utf8'))).toEqual({ probe: 'measure', state: '/settings?as=owner', viewport: '375x812', stack: 'TypeError: rows is undefined\n    at glAppRows (eval:1:2)', url: URL1 });
    expect(quiet.out).toContain('code=PROBE_ERROR matched=0 the measure probe failed: TypeError: rows is undefined (trace: ' + trace + ')');
    expect(quiet.err).toBe('gstack-design-lint: PROBE_ERROR: the measure probe threw at /settings?as=owner 375x812; trace ' + trace);
    const loud = await app({ verbose: true }, { run, traceDir: path.join(tmpDir(), 'traces') });
    expect(loud.err).toContain('at glAppRows (eval:1:2)');
    const blocker = path.join(tmpDir(), 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const unwritable = await app({ verbose: true }, { run, traceDir: path.join(blocker, 'traces') });
    expect(unwritable.code).toBe(4);
    expect(unwritable.out).toMatch(/^LINT_APP: verdict=incomplete code=PROBE_ERROR /m);
    expect(unwritable.err).toContain('gstack-design-lint: PROBE_ERROR: the measure probe threw at /settings?as=owner 375x812; no trace written (');
  });

  test('a section selector the browser refuses never holds readiness: the soft wait goes on to the probe, an explicit --wait-for stays not ready', async () => {
    const refuses = { querySelector: () => { throw new SyntaxError("'main:foo' is not a valid selector"); }, querySelectorAll: () => [] };
    const evaluate = (expression: string) => new Function('document', 'window', 'return ' + expression)(refuses, {});
    expect(evaluate(composedWaitExpression('main:foo', 15_000))).toBe(true);
    expect(evaluate(composedWaitExpression('main:foo', null))).toBe(false);
    const late = await lintApp({ states: [{ name: 's', url: URL1 }], within: 'main', reach: async () => null, run: fakeRun({ fail: 'waitFor expression never became truthy: x (waited 16000ms)' }) });
    expect([late.app.code, late.app.states[0].detail]).toEqual(['NOT_READY', 'the section main did not match within 15s']);
  });
});

describe('app profile contract: no browser and the scope guard (T15, T20, T33)', () => {
  const noBrowser = () => ({ engine: null, probe: { ok: false as const, reason: 'NEEDS_ASIDE' as const, detail: 'test' }, error: 'no browser available: run ./setup (NEEDS_ASIDE: test)' });

  test('--url with no browser under page scope: RENDER_UNAVAILABLE names the redacted URL; --render over files keeps today\'s skip', async () => {
    const url = 'http://127.0.0.1:5300/p?token=SECRET';
    const r = await lint([], { urls: [url], engine: noBrowser, warn: () => {} });
    expect(r.summary.render).toBe('skipped: no browser available: run ./setup (NEEDS_ASIDE: test)');
    expect(renderUnavailable([url], r.summary.render)).toBe('gstack-design-lint: RENDER_UNAVAILABLE: nothing was measured at http://127.0.0.1:5300/p?token=REDACTED (no browser available: run ./setup (NEEDS_ASIDE: test)) | fix: gstack-browser-ensure, then rerun');
    const files = await lint([path.join(ROOT, 'test/fixtures/design-lint/clean')], { cwd: ROOT, render: true, engine: noBrowser, warn: () => {} });
    expect(renderUnavailable([], files.summary.render)).toBeNull();
    expect(files.exitCode).toBe(0);
    expect(renderUnavailable([url], 'ran')).toBeNull();
  });

  test('--scope app with no browser: every state x viewport NO_BROWSER, exit 4 and RENDER_UNAVAILABLE on stderr', async () => {
    const r = await app({}, { engine: noBrowser });
    expect(r.code).toBe(4);
    expect(r.err).toBe('gstack-design-lint: RENDER_UNAVAILABLE: nothing was measured at ' + URL1 + ' (no browser available: run ./setup (NEEDS_ASIDE: test)) | fix: gstack-browser-ensure, then rerun');
    expect(r.out).toMatch(/LINT_SUMMARY: blocks=0 ask=0 waived=0 polish=0 render=skipped: no browser available/);
    expect(r.out).toMatch(/^LINT_APP: verdict=incomplete code=NO_BROWSER states=0\/1 /m);
  });

  test('app rules are app-only: tier ask, render, never reported by a page or component reporter; nothing else carries the marker', () => {
    expect(APP_IDS.sort()).toEqual(['copy-flush-under-list', 'note-in-row-weight', 'row-crowding', 'section-overflow', 'small-hit-area']);
    for (const id of APP_IDS) expect([id, RULES[id].tier, RULES[id].render]).toEqual([id, 'ask', true]);
    for (const scope of ['page', 'component'] as const) expect(new Reporter(scope).report('row-crowding', 'x.html', 1, 'e')).toBeNull();
    expect(new Reporter('app').report('row-crowding', 'x.html', 1, 'e')?.rule).toBe('row-crowding');
  });

});
