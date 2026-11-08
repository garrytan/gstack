/**
 * The /design-review --build receipt (bin/gstack-design-build,
 * lib/design-build.ts) without a browser: the outcome is decided in code from
 * the lint's JSON, the screenshots on disk, the preview's record of requests
 * it could not answer and the measured tree identity. Skipped renders,
 * partial coverage, screenshot-only states, a 501 the page swallowed, stale
 * evidence and a later edit can never print clean. Also: preflight order and
 * target authorization, the INSTALL mapping of a refused skill start, and a
 * dirty tree left exactly as it was.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { admit, buildLine, check, parseInventory, plan, preflight, receipt, servedStates, treeIdentity, verifyStart, type Inventory } from '../lib/design-build';
import { redactText } from '../lib/design-lint/app-input';
import { PREVIEW_TEMPLATE, runPreview, startPreview, type Preview } from './helpers/preview-template';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-build');
const VPS = ['1440x900', '375x812'];
const tmp: string[] = [];
const live: Preview[] = [];
afterAll(() => { for (const p of live) p.proc.kill(); for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = (p = 'design-build-'): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };

const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000 });

/** A standalone repo outside any checkout, with one commit, a dirty tracked file and an untracked component. */
function fixtureRepo(): string {
  const repo = tmpDir('design-build-repo-');
  git(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'fixtures'));
  fs.writeFileSync(path.join(repo, 'src', 'app.css'), '.row { padding: 4px; }\n');
  fs.writeFileSync(path.join(repo, 'fixtures', 'owner.json'), '{"version":1,"routes":{}}\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=gstack test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed');
  fs.writeFileSync(path.join(repo, 'src', 'app.css'), '.row { padding: 12px; }\n');
  fs.writeFileSync(path.join(repo, 'src', 'access.ts'), 'export const rows = 3;\n');
  return repo;
}

const URL_OWNER = 'http://127.0.0.1:5300/settings?as=owner';
const URL_LAST = 'http://127.0.0.1:5300/settings?as=lastowner&token=RECEIPTSENTINEL';
function inventory(over: Partial<Inventory> = {}): Inventory {
  return parseInventory(JSON.stringify({
    version: 1, within: 'section.access', fixtures: 'fixtures', touched: ['src/access.ts'],
    states: [{ name: 'owner', url: URL_OWNER, expect: '.rows .row' }, { name: 'lastowner', url: URL_LAST, expect: '.only-owner' }],
    ...over,
  }));
}

type Cov = [name: string, viewport: string, status: 'measured' | 'incomplete', code: string];
function lintJson(verdict: string, cov: Cov[], findings: unknown[] = []): string {
  const states = cov.map(([name, viewport, status, code]) => ({ name, url: 'x', viewport, status, code, matched: 1 }));
  return JSON.stringify({ summary: {}, files: 0, findings, app: { verdict, code: verdict === 'clean' ? 'OK' : verdict === 'open' ? 'OPEN' : cov.find((c) => c[2] !== 'measured')?.[3] ?? 'X', codes: [], within: 'section.access', matched: 1, viewports: VPS, states, open: 0, waived: 0, notes: [] } });
}
const allMeasured = (names = ['owner', 'lastowner']): Cov[] => names.flatMap((n) => VPS.map((v): Cov => [n, v, 'measured', 'OK']));
const finding = (rule: string, grade = 'ask', state = 'owner') => ({ rule, tier: grade === 'waived' ? 'ask' : grade, grade, file: 'x', line: 0, evidence: '[owner 1440px] a 2-line row leaves 4px', fix: 'f', source: 'render', ...(grade === 'waived' ? { waiver: 'house style here' } : {}), app: { state, viewport: '1440x900', locator: 'section.access > div.row', measured: 4, threshold: 8 } });

interface RunOpts { inv?: Inventory; lint?: string | null; shots?: string[] | 'all'; rounds?: number; unhandled?: object[]; beforeReceipt?: (repo: string, runDir: string) => void; repo?: string }
function run(o: RunOpts = {}) {
  const repo = o.repo ?? fixtureRepo();
  const inv = o.inv ?? inventory();
  const runDir = tmpDir('design-build-run-');
  plan(inv, runDir);
  verifyStart(repo, inv, runDir);
  if (o.lint !== null) fs.writeFileSync(path.join(runDir, 'lint.json'), o.lint ?? lintJson('clean', allMeasured()));
  const shots = o.shots ?? 'all';
  for (const s of inv.states) for (const v of VPS) if (shots === 'all' || shots.includes(`${s.name}-${v}`)) fs.writeFileSync(path.join(runDir, 'shots', `${s.name}-${v}.png`), 'png');
  const previewDir = tmpDir('design-build-preview-');
  if (o.unhandled) fs.writeFileSync(path.join(previewDir, 'unhandled.jsonl'), o.unhandled.map((u) => JSON.stringify(u)).join('\n') + '\n');
  o.beforeReceipt?.(repo, runDir);
  const r = receipt({ repo, inv, runDir, rounds: o.rounds ?? 1, previewDir, outRoot: path.join(runDir, 'out') });
  return { ...r, repo, inv, runDir };
}

describe('the build receipt decides the outcome in code (T17, T18, T8, T12)', () => {
  test('complete coverage with a clean lint verdict is clean; the line counts linted states, and the receipt is private and redacted', () => {
    const r = run();
    expect(r.exit).toBe(0);
    expect(r.line).toMatch(/^DESIGN_BUILD: clean code=OK linted=2\/2 shot=2\/2 screenshot_only=0 open=0 waived=0 rounds=1 viewports=1440x900,375x812 tree=[0-9a-f]{12} receipt=\S+receipt\.json$/);
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(r.file, 'utf8');
    expect(text).not.toContain('RECEIPTSENTINEL');
    const rec = JSON.parse(text);
    expect(rec).toMatchObject({ version: 1, outcome: 'clean', rounds: 1, viewports: VPS, counts: { planned: 2, url: 2, linted: 2 } });
    expect(rec.states.map((s: { name: string; expect: unknown }) => [s.name, s.expect])).toEqual([['owner', { selector: '.rows .row', passed: true }], ['lastowner', { selector: '.only-owner', passed: true }]]);
  });

  test('the verdict comes from the JSON: open findings make it open whatever the lint exited; waived findings alone make it waived', () => {
    const open = run({ lint: lintJson('open', allMeasured(), [finding('row-crowding'), finding('small-hit-area', 'waived')]) });
    expect([open.exit, open.line.split(' ').slice(0, 3).join(' ')]).toEqual([1, 'DESIGN_BUILD: open code=OPEN']);
    expect(open.line).toContain('open=1 waived=1');
    const waived = run({ lint: lintJson('clean', allMeasured(), [finding('small-hit-area', 'waived')]) });
    expect(waived.line).toStartWith('DESIGN_BUILD: waived code=OK');
    expect(waived.receipt.waived).toEqual([expect.objectContaining({ rule: 'small-hit-area', reason: 'house style here' })]);
  });

  test('a skipped render or partial coverage is never clean', () => {
    const skipped = run({ lint: lintJson('incomplete', allMeasured().map(([n, v]): Cov => [n, v, 'incomplete', 'NO_BROWSER'])) });
    expect(skipped.line).toStartWith('DESIGN_BUILD: incomplete code=NO_BROWSER linted=0/2');
    const partial = run({ lint: lintJson('clean', allMeasured().filter(([n, v]) => !(n === 'lastowner' && v === '375x812'))) });
    expect(partial.line).toStartWith('DESIGN_BUILD: incomplete code=NOT_LINTED linted=1/2');
    const missing = run({ lint: null });
    expect(missing.line).toStartWith('DESIGN_BUILD: incomplete code=LINT_MISSING');
    const noShot = run({ shots: ['owner-1440x900', 'owner-375x812', 'lastowner-1440x900'] });
    expect(noShot.line).toStartWith('DESIGN_BUILD: incomplete code=NOT_SHOT linted=2/2 shot=1/2');
    const mismatch = run({ lint: lintJson('incomplete', [...allMeasured(['owner']), ['lastowner', '1440x900', 'incomplete', 'STATE_MISMATCH'], ['lastowner', '375x812', 'incomplete', 'STATE_MISMATCH']]) });
    expect(mismatch.line).toStartWith('DESIGN_BUILD: incomplete code=STATE_MISMATCH');
    expect(mismatch.receipt.states[1].expect).toEqual({ selector: '.only-owner', passed: false });
    for (const r of [skipped, partial, missing, noShot, mismatch]) expect(r.exit).toBe(4);
  });

  test('a screenshot-only state is never counted as linted, and an unreached one makes the run incomplete', () => {
    const inv = inventory({ states: [{ name: 'owner', url: URL_OWNER, mode: 'url' }, { name: 'confirm', mode: 'screenshot', steps: 'click Remove on Dana' }] as Inventory['states'] });
    const shot = run({ inv, lint: lintJson('clean', allMeasured(['owner'])) });
    expect(shot.line).toStartWith('DESIGN_BUILD: clean code=OK linted=1/1 shot=2/2 screenshot_only=1');
    expect(shot.receipt.states[1]).toMatchObject({ name: 'confirm', mode: 'screenshot', linted: false });
    const unreached = run({ inv, lint: lintJson('clean', allMeasured(['owner'])), shots: ['owner-1440x900', 'owner-375x812'] });
    expect(unreached.line).toStartWith('DESIGN_BUILD: incomplete code=NOT_SHOT');
    expect(() => parseInventory(JSON.stringify({ version: 1, within: 'main', states: [{ name: 'confirm', mode: 'screenshot', steps: 'click' }] }))).toThrow('at least one url state');
  });

  test('round 3 ends editing: open after round 3 is reported open, and a fourth round is refused', () => {
    expect(run({ rounds: 3, lint: lintJson('open', allMeasured(), [finding('copy-flush-under-list')]) }).line).toContain('DESIGN_BUILD: open code=OPEN');
    expect(() => run({ rounds: 4 })).toThrow('--rounds 4 is outside 0 to 3');
  });
});

describe('an unsupported fixture route never yields a complete receipt (T26)', () => {
  test('a 501 the page caught still makes its state incomplete, while a declared error fixture does not', () => {
    const r = run({ unhandled: [{ scenario: 'lastowner', method: 'GET', path: '/api/audit', code: 'PREVIEW_UNHANDLED' }] });
    expect(r.exit).toBe(4);
    expect(r.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNHANDLED linted=2/2');
    expect(r.line).toContain('lastowner: GET /api/audit (scenario lastowner)');
    expect(r.line).toContain('| fix: add the named route');
    expect(r.receipt.states[0].unhandled).toEqual([]);
    const unknown = run({ unhandled: [{ scenario: 'owner', method: 'GET', path: '/api/members', code: 'PREVIEW_UNKNOWN_SCENARIO' }] });
    expect(unknown.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNKNOWN_SCENARIO');
    expect(run({ unhandled: [] }).line).toStartWith('DESIGN_BUILD: clean');
  });

  test('a 501 recorded at any point in the run keeps the receipt incomplete, and a scenario-less one blocks every URL state', () => {
    const early = run({ unhandled: [{ scenario: 'owner', method: 'DELETE', path: '/api/teams/7', code: 'PREVIEW_UNHANDLED', at: 1 }] });
    expect(early.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNHANDLED');
    expect(early.line).toContain('restart the preview, then start a fresh run from preflight');
    const none = run({ unhandled: [{ scenario: '', method: 'GET', path: '/api/members', code: 'PREVIEW_NO_SCENARIO' }] });
    expect(none.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_NO_SCENARIO');
    expect(none.receipt.states.map((s) => (s.unhandled as unknown[]).length)).toEqual([1, 1]);
  });
});

describe('the receipt is bound to the measured tree (T7, T29, T37)', () => {
  test('a regression the last round introduced is what the final pass reports', () => {
    const repo = fixtureRepo();
    fs.writeFileSync(path.join(repo, 'src', 'app.css'), '.row { padding: 2px; }\n');
    const r = run({ repo, rounds: 3, lint: lintJson('open', allMeasured(), [finding('row-crowding', 'ask', 'lastowner')]) });
    expect(r.line).toStartWith('DESIGN_BUILD: open code=OPEN');
    expect(r.receipt.open).toEqual([expect.objectContaining({ rule: 'row-crowding', state: 'lastowner' })]);
  });

  test('evidence older than the final pass, or a tree that moved during it, is stale', () => {
    const old = run({ beforeReceipt: (_repo, dir) => { const past = new Date(Date.now() - 60_000); fs.utimesSync(path.join(dir, 'lint.json'), past, past); } });
    expect(old.line).toStartWith('DESIGN_BUILD: incomplete code=STALE_EVIDENCE');
    for (const edit of ['src/app.css', 'src/access.ts', 'fixtures/owner.json']) {
      const moved = run({ beforeReceipt: (repo) => fs.appendFileSync(path.join(repo, edit), '/* later */\n') });
      expect([edit, moved.line.split(' ').slice(0, 3).join(' ')]).toEqual([edit, 'DESIGN_BUILD: incomplete code=TREE_CHANGED']);
    }
  });

  test('check keeps the line while the tree is unchanged and calls it stale after any later edit', () => {
    const r = run();
    expect(check(r.repo, r.inv, r.file)).toEqual({ line: r.line, exit: 0 });
    fs.writeFileSync(path.join(r.repo, 'fixtures', 'lastowner.json'), '{}\n');
    const stale = check(r.repo, r.inv, r.file);
    expect(stale.exit).toBe(4);
    expect(stale.line).toStartWith('DESIGN_BUILD: stale code=TREE_CHANGED');
  });

  test('the identity covers tracked diffs, the touched untracked files and fixture content, and nothing else', () => {
    const repo = fixtureRepo();
    const inv = inventory();
    const a = treeIdentity(repo, inv);
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'not touched by the loop\n');
    expect(treeIdentity(repo, inv)).toBe(a);
    fs.writeFileSync(path.join(repo, 'src', 'access.ts'), 'export const rows = 4;\n');
    expect(treeIdentity(repo, inv)).not.toBe(a);
  });
});

describe('preflight starts the browser it found (GST-1906)', () => {
  const RAW = '  - [pid=4242][err] [1108/102007.815666:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:144] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md';
  const fakeBrowse = (body: string): string => {
    const dir = tmpDir('design-build-browse-');
    const bin = path.join(dir, 'browse');
    fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${dir}/calls"\n${body}\n`, { mode: 0o755 });
    return bin;
  };

  test('a Chromium that cannot start its sandbox fails preflight with the actionable sandbox error before any URL is touched', async () => {
    const bin = fakeBrowse(`printf '%s\\n' '[browse] Starting server...' '[browse] Server failed to start:' 'browserType.launch: Target page, context or browser has been closed' '${RAW}' >&2\nexit 1`);
    const reached: string[] = [];
    const r = await preflight(inventory(), [], { engine: () => ({ engine: 'browse', bin }), reach: async (u) => { reached.push(u); return null; } });
    expect(r.exit).toBe(4);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toStartWith('DESIGN_BUILD: unrendered code=BROWSER_SANDBOX (Chromium could not start its sandbox');
    expect(r.lines[0]).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
    expect(r.lines[0]).toContain('pages you trust');
    expect(r.lines[0]).toContain('No usable sandbox!');
    expect(reached).toEqual([]);
  });

  test('a browser that opens a tab passes preflight, and preflight closes the tab it opened', async () => {
    const bin = fakeBrowse(`case "$1" in newtab) echo '{"tabId":7}' ;; closetab) ;; *) exit 9 ;; esac`);
    const r = await preflight(inventory(), [], { engine: () => ({ engine: 'browse', bin }), reach: async () => null, preview: async () => false });
    expect(r).toEqual({ lines: ['PREFLIGHT: ok engine=browse states=2 targets=loopback mutations=unknown'], exit: 0 });
    expect(fs.readFileSync(path.join(path.dirname(bin), 'calls'), 'utf8')).toBe('newtab --json\nclosetab 7\n');
  });

  test('any other launch failure is unrendered NO_BROWSER carrying the browser\'s own line', async () => {
    const r = await preflight(inventory(), [], { engine: () => ({ engine: 'browse', bin: '/x/browse' }), launch: async () => 'browse newtab failed: Chromium exited with code 127', reach: async () => null });
    expect(r).toEqual({ lines: [buildLine({ outcome: 'unrendered', code: 'NO_BROWSER', detail: 'browse newtab failed: Chromium exited with code 127' })], exit: 4 });
  });
});

describe('preflight, authorization and install (T14, T38, T31)', () => {
  const engine = () => ({ engine: 'browse' as const, bin: '/x/browse' });
  const launch = async () => null;
  test('the browser comes first: no engine is unrendered NO_BROWSER before any URL is touched', async () => {
    const reached: string[] = [];
    const r = await preflight(inventory(), [], { engine: () => ({ engine: null, probe: { ok: false, reason: 'NEEDS_ASIDE', detail: 't' }, error: 'no browser available: run ./setup' }) as never, reach: async (u) => { reached.push(u); return null; } });
    expect(r).toEqual({ lines: ['DESIGN_BUILD: unrendered code=NO_BROWSER (no browser available: run ./setup) | fix: gstack-browser-ensure, then rerun /design-review --build'], exit: 4 });
    expect(reached).toEqual([]);
  });

  test('a non-loopback target without a grant stops incomplete before any request; a named grant allows only that host', async () => {
    const inv = inventory({ states: [{ name: 'prod', url: 'https://app.example.com/settings?as=owner', mode: 'url' }, { name: 'owner', url: URL_OWNER, mode: 'url' }] as Inventory['states'] });
    const reached: string[] = [];
    const reach = async (u: string) => { reached.push(u); return null; };
    const refused = await preflight(inv, [], { engine, launch, reach });
    expect(refused.exit).toBe(4);
    expect(refused.lines[0]).toStartWith('DESIGN_BUILD: incomplete code=UNAUTHORIZED_TARGET (prod at https://app.example.com/settings?as=owner is not on loopback and has no grant; no page was opened and no action ran)');
    expect(reached).toEqual([]);
    expect((await preflight(inv, ['other.example.com'], { engine, launch, reach })).exit).toBe(4);
    const probed: string[] = [];
    const granted = await preflight(inv, ['app.example.com'], { engine, launch, reach, preview: async (u) => { probed.push(u); return true; } });
    expect(granted.lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback+granted mutations=fixtures+granted']);
    expect(probed).toEqual([URL_OWNER]);
    expect((await preflight(inv, ['app.example.com'], { engine, launch, reach, preview: async () => false })).lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback+granted mutations=unknown']);
    expect((await preflight(inventory(), [], { engine, launch, reach, preview: async () => true })).lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback mutations=fixtures-only']);
    expect((await preflight(inventory(), [], { engine, launch, reach, preview: async (u) => !u.includes('lastowner') })).lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback mutations=unknown']);
  });

  test('only the preview\'s own probe answer proves fixtures-only: a marker in the HTML or a redirect does not', async () => {
    const page = '<!doctype html><!-- data-gstack-preview --><script data-gstack-preview></script><title>app</title>';
    const marked = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }) });
    const preview = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => (new URL(req.url).pathname === '/api/__gstack-preview' ? new Response(null, { status: 204, headers: { 'x-gstack-preview': 'ready' } }) : new Response(page, { headers: { 'content-type': 'text/html' } })) });
    const bounce = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => Response.redirect(`http://127.0.0.1:${preview.port}${new URL(req.url).pathname}`, 302) });
    try {
      const at = (port?: number) => inventory({ states: [{ name: 'owner', url: `http://127.0.0.1:${port}/settings?as=owner`, mode: 'url' }] as Inventory['states'] });
      for (const port of [marked.port, bounce.port]) expect((await preflight(at(port), [], { engine, launch, reach: async () => null })).lines).toEqual(['PREFLIGHT: ok engine=browse states=1 targets=loopback mutations=unknown']);
      expect((await preflight(at(preview.port), [], { engine, launch, reach: async () => null })).lines).toEqual(['PREFLIGHT: ok engine=browse states=1 targets=loopback mutations=fixtures-only']);
    } finally { for (const s of [marked, preview, bounce]) s.stop(true); }
  });

  test('a URL that does not answer is unrendered NO_PREVIEW, redacted', async () => {
    const r = await preflight(inventory(), [], { engine, launch, reach: async (u) => (u.includes('lastowner') ? 'connect ECONNREFUSED ' + u : null) });
    expect(r.lines[0]).toStartWith('DESIGN_BUILD: unrendered code=NO_PREVIEW (no answer from lastowner');
    expect(r.lines[0]).not.toContain('RECEIPTSENTINEL');
  });

  test('a design-review start the install admission refused maps to unrendered code=INSTALL (real gstack-skill-start, mismatched verdict)', () => {
    const gh = tmpDir('design-build-gh-');
    fs.writeFileSync(path.join(gh, 'config.yaml'), 'update_check: false\n');
    const real = fs.realpathSync(ROOT);
    const verdict = path.join(gh, 'install-verdicts', `${createHash('sha256').update(real).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(verdict), { recursive: true });
    fs.writeFileSync(verdict, JSON.stringify({ schema_version: 1, checkout: real, head: '0'.repeat(40), for: 'design-review', required: ['runtime'], pins_planning_only: false, ok: true, trailer: 'gstack: ok 1.98.0.0 for=design-review', min_revision: '1.91.95.0', launch_path: '', time: '2026-11-07T00:00:00Z' }));
    const home = tmpDir('design-build-home-');
    const start = spawnSync(path.join(ROOT, 'bin', 'gstack-skill-start'), ['--skill', 'design-review'], { cwd: home, encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: gh, GSTACK_LEASE_DIR: path.join(gh, 'leases'), GSTACK_SESSION_KIND: 'unattended', GSTACK_CAPY: '1' } });
    expect(start.status, start.stdout + start.stderr).toBe(3);
    expect(start.stdout).toContain('GSTACK_RESULT: skill=design-review status=refused');
    const out = path.join(home, 'start.txt');
    fs.writeFileSync(out, start.stdout);
    const r = spawnSync(BIN, ['admit', out], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/^DESIGN_BUILD: unrendered code=INSTALL \(INSTALL: fail verdict .*another HEAD.*\) \| fix: run install\.sh --for design-review/);
    expect(admit('GSTACK_RESULT: skill=design-review status=complete run=x').lines).toEqual(['ADMIT: ok']);
  }, 30_000);
});

describe('the bin: one line, exit codes, and a dirty tree left as it was (T17, T38)', () => {
  test('plan prints the exact lint invocation, state file and every screenshot path; receipt and check print one DESIGN_BUILD line; git state is untouched', () => {
    const repo = fixtureRepo();
    const before = { status: git(repo, 'status', '--porcelain'), css: fs.readFileSync(path.join(repo, 'src', 'app.css'), 'utf8'), stash: git(repo, 'stash', 'list'), log: git(repo, 'log', '--oneline') };
    const work = tmpDir('design-build-bin-');
    const inv = path.join(work, 'inventory.json');
    fs.writeFileSync(inv, JSON.stringify({ version: 1, within: 'section.access', fixtures: 'fixtures', touched: ['src/access.ts'], states: [{ name: 'owner', url: URL_OWNER, expect: '.rows .row' }] }));
    const runDir = path.join(work, 'run');
    const sh = (args: string[]) => spawnSync(BIN, args, { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: path.join(work, 'state') } });
    const p = sh(['plan', '--inventory', inv, '--run-dir', runDir]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stdout).toContain(`LINT_CMD: '${path.join(ROOT, 'bin', 'gstack-design-lint')}' --scope app --state-file '${runDir}/states.json' --within 'section.access' --viewport 1440x900 --viewport 375x812 --json > '${runDir}/lint.json'`);
    expect(p.stdout).toContain(`SHOT: owner 375x812 ${URL_OWNER} -> ${runDir}/shots/owner-375x812.png`);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'states.json'), 'utf8'))).toEqual({ version: 1, states: [{ name: 'owner', url: URL_OWNER, expect: '.rows .row' }] });
    expect(sh(['verify-start', '--inventory', inv, '--run-dir', runDir]).stdout).toMatch(/^VERIFY: tree=[0-9a-f]{12} /);
    fs.writeFileSync(path.join(runDir, 'lint.json'), lintJson('clean', allMeasured(['owner'])));
    for (const v of VPS) fs.writeFileSync(path.join(runDir, 'shots', `owner-${v}.png`), 'png');
    const rc = sh(['receipt', '--inventory', inv, '--run-dir', runDir, '--rounds', '2']);
    expect(rc.status, rc.stderr).toBe(0);
    expect(rc.stdout.trim().split('\n')).toHaveLength(1);
    expect(rc.stdout).toMatch(new RegExp(`^DESIGN_BUILD: clean code=OK linted=1/1 .* receipt=${path.join(work, 'state', 'projects')}/[^/]+/designs/design-build-[0-9a-f]{12}-[0-9a-f]{12}/receipt\\.json\n$`));
    const file = /receipt=(\S+)/.exec(rc.stdout)![1]!;
    expect(sh(['check', '--inventory', inv, '--receipt', file]).stdout).toBe(rc.stdout);
    const fourth = sh(['receipt', '--inventory', inv, '--run-dir', runDir, '--rounds', '4']);
    expect([fourth.status, fourth.stderr.trim()]).toEqual([3, 'gstack-design-build: ROUNDS: --rounds 4 is outside 0 to 3 | fix: the loop stops editing after round 3; report the open list instead of a fourth round']);
    expect({ status: git(repo, 'status', '--porcelain'), css: fs.readFileSync(path.join(repo, 'src', 'app.css'), 'utf8'), stash: git(repo, 'stash', 'list'), log: git(repo, 'log', '--oneline') }).toEqual(before);
    fs.appendFileSync(path.join(repo, 'src', 'access.ts'), '// edited after the receipt\n');
    const stale = sh(['check', '--inventory', inv, '--receipt', file]);
    expect([stale.status, stale.stdout.split(' ').slice(0, 3).join(' ')]).toEqual([4, 'DESIGN_BUILD: stale code=TREE_CHANGED']);
  }, 30_000);

  test('inventory errors are usage errors with a fix line', () => {
    for (const [inv, msg] of [
      [{ version: 1, within: 'main', states: [{ name: 'a', url: URL_OWNER }], extra: 1 }, 'unknown inventory key extra'],
      [{ version: 1, within: 'main', states: [{ name: 'a', url: URL_OWNER }, { name: 'a', url: URL_OWNER }] }, 'listed twice'],
      [{ version: 1, within: 'main', states: [{ name: 'a', url: URL_OWNER }, { name: 'b', mode: 'screenshot' }] }, 'needs steps'],
      [{ version: 1, within: 'main', touched: ['../x'], states: [{ name: 'a', url: URL_OWNER }] }, 'repo-relative'],
      [{ version: 1, within: 'main', viewports: ['10x10'], states: [{ name: 'a', url: URL_OWNER }] }, 'width 320 to 3840'],
    ] as const) expect(() => parseInventory(JSON.stringify(inv))).toThrow(msg);
    expect(buildLine({ outcome: 'unrendered', code: 'NO_PREVIEW', detail: 'x | fix: y' })).toBe('DESIGN_BUILD: unrendered code=NO_PREVIEW (x / fix: y) | fix: start the preview (docs/howto-preview-a-frontend.md), then rerun');
  });
});

/**
 * design-review/templates/preview-fixtures.mjs without a browser: the shim in
 * every page, scenarios by header, query or Referer, 501 problem documents
 * that name the route and the file to edit (recorded for the build receipt),
 * declared error fixtures passed through, SPA routes still served, loopback
 * only, an owned port, a private redacted log and a clean stop. The shim
 * itself runs in a VM with stand-in fetch and XHR.
 */
const PAGE = path.join(ROOT, 'test', 'fixtures', 'ui-spacing', 'preview');
const FIXTURES = path.join(PAGE, 'fixtures');

async function begin(extra: string[] = []) {
  const state = tmpDir('pv-');
  const p = await startPreview(['--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', '0', '--state', state, ...extra]);
  live.push(p);
  return { ...p, state };
}

describe('preview template: scenarios and the fixture API (T3, T21, T22, T26, T36)', () => {
  test('a malformed path escape gets a 400 and a fixture with a bad status gets a recorded 501, and the preview keeps serving', async () => {
    const fixtures = tmpDir('pv-');
    fs.cpSync(FIXTURES, fixtures, { recursive: true });
    const owner = JSON.parse(fs.readFileSync(path.join(fixtures, 'owner.json'), 'utf8'));
    owner.routes['GET /api/teams'] = { status: 'ok', json: [] };
    fs.writeFileSync(path.join(fixtures, 'owner.json'), JSON.stringify(owner));
    const state = tmpDir('pv-');
    const p = await startPreview(['--static', '--root', PAGE, '--fixtures', fixtures, '--port', '0', '--state', state]);
    live.push(p);
    expect((await fetch(p.url + '%E0%A4%A')).status).toBe(400);
    const probe = await fetch(p.url + 'api/__gstack-preview', { redirect: 'manual' });
    expect([probe.status, probe.headers.get('x-gstack-preview')]).toEqual([204, 'ready']);
    const bad = await fetch(p.url + 'api/teams?as=owner');
    expect([bad.status, bad.headers.get('x-gstack-preview')]).toEqual([501, 'PREVIEW_UNKNOWN_SCENARIO']);
    expect((await bad.json()).detail).toContain('has a bad status or header');
    expect((await fetch(p.url + 'api/members?as=owner')).status).toBe(200);
    expect(fs.readFileSync(path.join(state, 'unhandled.jsonl'), 'utf8')).toContain('"path":"/api/teams","code":"PREVIEW_UNKNOWN_SCENARIO"');
    expect(fs.readFileSync(path.join(state, 'unhandled.jsonl'), 'utf8')).not.toContain('__gstack-preview');
  });

  test('pages get the shim; API calls are answered by header, ?as= or Referer; anything unsupported is a recorded 501', async () => {
    const p = await begin();
    expect(p.ready).toMatch(/^PREVIEW: ready url=http:\/\/127\.0\.0\.1:\d+\/ mode=static state=\S+ log=\S+preview\.log$/);
    const html = await (await fetch(p.url + '?as=owner')).text();
    expect(html.match(/data-gstack-preview/g)).toHaveLength(1);
    expect(html.indexOf('data-gstack-preview')).toBeLessThan(html.indexOf('<title>'));
    const spa = await fetch(p.url + 'settings/team?as=owner');
    expect([spa.status, (await spa.text()).includes('Who has access')]).toEqual([200, true]);

    const byHeader = await fetch(p.url + 'api/members', { headers: { 'x-gstack-scenario': 'owner' } });
    expect((await byHeader.json()).map((m: { name: string }) => m.name)).toEqual(['Dana Whitfield', 'Omar Haddad', 'Lena Park']);
    expect((await (await fetch(p.url + 'api/members?as=lastowner')).json())).toHaveLength(2);
    expect((await (await fetch(p.url + 'api/members', { headers: { referer: p.url + 'settings?as=lastowner' } })).json())).toHaveLength(2);
    const declared = await fetch(p.url + 'api/members/7', { method: 'DELETE', headers: { 'x-gstack-scenario': 'owner' } });
    expect([declared.status, (await declared.json()).error]).toEqual([409, 'The only owner cannot be removed.']);

    const problems = [
      [await fetch(p.url + 'api/members'), 'PREVIEW_NO_SCENARIO', 'arrived with no scenario'],
      [await fetch(p.url + 'api/members', { headers: { 'x-gstack-scenario': 'nobody' } }), 'PREVIEW_UNKNOWN_SCENARIO', 'scenario "nobody" has no fixture file'],
      [await fetch(p.url + 'api/audit?token=SEKRETSENTINEL', { headers: { referer: p.url + '?as=lastowner&session=REFSENTINEL' } }), 'PREVIEW_UNHANDLED', 'scenario "lastowner" has no route "GET /api/audit"'],
    ] as const;
    for (const [res, code, detail] of problems) {
      expect([code, res.status, res.headers.get('content-type'), res.headers.get('x-gstack-preview')]).toEqual([code, 501, 'application/problem+json', code]);
      const body = await res.json();
      expect(body).toMatchObject({ status: 501, code, type: expect.stringMatching(/howto-preview-a-frontend\.md#preview-/) });
      expect(body.detail).toContain(detail);
    }
    const unhandled = fs.readFileSync(path.join(p.state, 'unhandled.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(unhandled).toEqual([
      { scenario: '', method: 'GET', path: '/api/members', code: 'PREVIEW_NO_SCENARIO' },
      { scenario: 'nobody', method: 'GET', path: '/api/members', code: 'PREVIEW_UNKNOWN_SCENARIO' },
      { scenario: 'lastowner', method: 'GET', path: '/api/audit', code: 'PREVIEW_UNHANDLED' },
    ]);
    const fixLine = (await (await fetch(p.url + 'api/audit?as=lastowner')).json()).fix;
    expect(fixLine).toBe(`add "GET /api/audit": {"status":200,"json":…} to ${path.join(FIXTURES, 'lastowner.json')}`);

    const log = path.join(p.state, 'preview.log');
    expect([fs.statSync(p.state).mode & 0o777, fs.statSync(log).mode & 0o777]).toEqual([0o700, 0o600]);
    const text = fs.readFileSync(log, 'utf8');
    expect(text).toContain('GET /api/audit?token=REDACTED 501 PREVIEW_UNHANDLED scenario=lastowner');
    expect(text).not.toContain('SEKRETSENTINEL');

    const stop = runPreview(['stop', '--state', p.state]);
    expect(stop.out.trim()).toBe(`PREVIEW: stopped port=${p.port}`);
    expect(await p.proc.exited).toBe(0);
    expect(fs.existsSync(path.join(p.state, 'preview.json'))).toBe(false);
    expect(await fetch(p.url).then(() => 'answered', () => 'closed')).toBe('closed');
  }, 30_000);

  test('loopback only, an owned port, and a named failure when the app has no Vite', async () => {
    const p = await begin();
    const taken = runPreview(['start', '--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', String(p.port), '--state', tmpDir('pv-')]);
    expect([taken.code, taken.err.trim()]).toEqual([4, `PREVIEW: fail code=PREVIEW_PORT port ${p.port} on 127.0.0.1 is taken | fix: stop whatever holds the port, or pass another --port`]);
    const host = runPreview(['start', '--static', '--root', PAGE, '--fixtures', FIXTURES, '--host', '0.0.0.0']);
    expect([host.code, host.err]).toEqual([3, 'PREVIEW: fail code=PREVIEW_HOST --host 0.0.0.0 is not loopback | fix: the preview listens on 127.0.0.1 only; drop --host\n']);
    const app = tmpDir('pv-');
    fs.writeFileSync(path.join(app, 'package.json'), '{"name":"no-vite","private":true}\n');
    const noVite = runPreview(['start', '--root', app, '--fixtures', FIXTURES, '--port', '0', '--state', tmpDir('pv-')]);
    expect(noVite.code).toBe(4);
    expect(noVite.err).toStartWith(`PREVIEW: fail code=PREVIEW_NO_VITE no vite package resolves from ${app} | fix: install vite`);
    p.proc.kill('SIGTERM');
    expect(await p.proc.exited).toBe(0);
  }, 30_000);
});

describe('preview template: the shim and the Vite plugin (T3, T21)', () => {
  test('the shim adds x-gstack-scenario to same-origin fetch and XHR only, and keeps ?as= for the tab', async () => {
    const mod = await import(PREVIEW_TEMPLATE);
    const seen: Array<[string, string | null]> = [];
    const store = new Map<string, string>();
    class FakeXHR { headers: Record<string, string> = {}; open(_m: string, _u: string) {} send() { seen.push(['xhr', this.headers['x-gstack-scenario'] ?? null]); } setRequestHeader(k: string, v: string) { this.headers[k] = v; } }
    const ctx = (search: string) => {
      const window: Record<string, unknown> = {
        location: { search, href: 'http://127.0.0.1:5300/settings' + search, origin: 'http://127.0.0.1:5300' },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
        fetch: async (u: string, init?: { headers?: Headers }) => { seen.push([u, init?.headers?.get('x-gstack-scenario') ?? null]); return 'ok'; },
        XMLHttpRequest: FakeXHR, URL, URLSearchParams, Headers,
      };
      window.window = window;
      vm.runInNewContext(mod.SHIM, { ...window, window });
      return window;
    };
    const w = ctx('?as=lastowner');
    await (w.fetch as (u: string) => Promise<unknown>)('/api/members');
    await (w.fetch as (u: string) => Promise<unknown>)('https://api.example.com/x');
    const x = new (w.XMLHttpRequest as typeof FakeXHR)();
    x.open('GET', '/api/audit');
    x.send();
    const later = ctx('');
    await (later.fetch as (u: string) => Promise<unknown>)('/api/members');
    expect(seen).toEqual([['/api/members', 'lastowner'], ['https://api.example.com/x', null], ['xhr', 'lastowner'], ['/api/members', 'lastowner']]);
  });

  test('the plugin prepends the shim and mounts the fixture API on the dev server', async () => {
    const mod = await import(PREVIEW_TEMPLATE);
    const plugin = mod.gstackPreviewFixtures({ fixtures: FIXTURES });
    expect(plugin.name).toBe('gstack-preview-fixtures');
    expect(plugin.apply).toBe('serve');
    expect(plugin.transformIndexHtml()).toEqual([{ tag: 'script', attrs: { 'data-gstack-preview': '' }, children: mod.SHIM, injectTo: 'head-prepend' }]);
    const used: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    plugin.configureServer({ middlewares: { use: (fn: (typeof used)[number]) => used.push(fn) } });
    let status = 0;
    let body = '';
    let passed = false;
    used[0]!({ url: '/api/members', method: 'GET', headers: { 'x-gstack-scenario': 'owner' }, resume() {} }, { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } }, () => { passed = true; });
    expect([status, JSON.parse(body).length, passed]).toEqual([200, 3, false]);
    used[0]!({ url: '/src/main.ts', method: 'GET', headers: {} }, {}, () => { passed = true; });
    expect(passed).toBe(true);
    expect(mod.redact('http://' + ['u', 'p'].join(':') + '@h/x?api_key=a)b&ok=1#sig=c')).toBe('http://h/x?api_key=REDACTED&ok=1#sig=REDACTED');
  });
});

describe('the receipt binds what it measured and reads the lint and preview as they are written', () => {
  const PORT = 40000 + (process.pid % 20000);
  const LOCAL = (as: string) => `http://127.0.0.1:${PORT}/settings?as=${as}`;
  function measure(repo: string, inv: Inventory, recordedStates: string[]) {
    const runDir = tmpDir('design-build-run-');
    plan(inv, runDir);
    verifyStart(repo, inv, runDir);
    fs.writeFileSync(path.join(runDir, 'lint.json'), lintJson('clean', allMeasured(recordedStates)));
    for (const s of recordedStates) for (const v of VPS) fs.writeFileSync(path.join(runDir, 'shots', `${s}-${v}.png`), 'png');
    return runDir;
  }

  test('an edit inside a touched directory changes the tree identity, so the receipt is TREE_CHANGED', () => {
    const repo = fixtureRepo();
    fs.mkdirSync(path.join(repo, 'src', 'panel'));
    fs.writeFileSync(path.join(repo, 'src', 'panel', 'a.tsx'), 'export const a = 1;\n');
    const r = run({ repo, inv: inventory({ touched: ['src/panel'] }), beforeReceipt: (rp) => fs.writeFileSync(path.join(rp, 'src', 'panel', 'a.tsx'), 'export const a = 2;\n') });
    expect(r.line).toStartWith('DESIGN_BUILD: incomplete code=TREE_CHANGED');
  });

  test('an inventory edited after verify-start is never clean, and check refuses a receipt measured on another inventory', () => {
    const repo = fixtureRepo();
    const inv = inventory();
    const fewer = inventory({ states: [{ name: 'owner', url: URL_OWNER, mode: 'url', expect: '.rows .row' }] });
    const runDir = measure(repo, inv, ['owner']);
    const r = receipt({ repo, inv: fewer, runDir, rounds: 1, previewDir: tmpDir('design-build-preview-'), outRoot: path.join(runDir, 'out') });
    expect(r.line).toStartWith('DESIGN_BUILD: incomplete code=INVENTORY_CHANGED linted=1/1');
    const clean = run({ repo, inv });
    expect(clean.line).toStartWith('DESIGN_BUILD: clean');
    expect(check(repo, fewer, clean.file).line).toStartWith('DESIGN_BUILD: stale code=INVENTORY_CHANGED');
    expect(check(repo, inv, clean.file).line).toBe(clean.line);
  });

  test('without --preview the receipt reads the default preview state for each loopback port, so a recorded 501 is never clean', () => {
    const repo = fixtureRepo();
    const inv = inventory({ states: [{ name: 'owner', url: LOCAL('owner'), mode: 'url' }, { name: 'lastowner', url: LOCAL('lastowner'), mode: 'url' }] });
    const state = path.join(os.tmpdir(), `gstack-preview-${PORT}`);
    fs.mkdirSync(state, { recursive: true });
    tmp.push(state);
    fs.writeFileSync(path.join(state, 'unhandled.jsonl'), JSON.stringify({ scenario: 'lastowner', method: 'GET', path: '/api/audit', code: 'PREVIEW_UNHANDLED' }) + '\n');
    const runDir = measure(repo, inv, ['owner', 'lastowner']);
    const r = receipt({ repo, inv, runDir, rounds: 1, outRoot: path.join(runDir, 'out') });
    expect(r.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNHANDLED linted=2/2');
  });

  test("a path the app's own dev proxy forwards gets a recorded 501 instead of reaching the live backend", async () => {
    const mod = await import(PREVIEW_TEMPLATE);
    const state = tmpDir('pv-');
    const used: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    mod.gstackPreviewFixtures({ fixtures: FIXTURES, stateDir: state }).configureServer({ config: { server: { proxy: { '/graphql': 'https://staging.example.com', '^/v1/.*': {} } } }, middlewares: { use: (fn: (typeof used)[number]) => used.push(fn) } });
    const hit = (url: string, method: string): [number, boolean] => {
      let status = 0;
      let passed = false;
      used[0]!({ url, method, headers: { 'x-gstack-scenario': 'owner' }, resume() {} }, { writeHead: (s: number) => { status = s; }, end: () => {} }, () => { passed = true; });
      return [status, passed];
    };
    expect([hit('/graphql', 'POST'), hit('/v1/teams/7', 'DELETE'), hit('/src/main.ts', 'GET'), hit('/api/members', 'GET')]).toEqual([[501, false], [501, false], [0, true], [200, false]]);
    expect(fs.readFileSync(path.join(state, 'unhandled.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).code)).toEqual(['PREVIEW_LIVE_PROXY', 'PREVIEW_LIVE_PROXY']);
  });

  test('start refuses a state directory that is a symlink', () => {
    const link = path.join(tmpDir('pv-'), 'state');
    fs.symlinkSync(tmpDir('pv-'), link);
    const r = runPreview(['start', '--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', '0', '--state', link]);
    expect(r.code).toBe(4);
    expect(r.err).toStartWith('PREVIEW: fail code=PREVIEW_STATE');
  });
});

describe('round 3 (granted fix-check): the proxy catch-all, the preview record without --preview, and URL userinfo', () => {
  test("an empty-string proxy key is a catch-all proxy and still gets the recorded 501", async () => {
    const mod = await import(PREVIEW_TEMPLATE);
    const state = tmpDir('pv-');
    const used: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    mod.gstackPreviewFixtures({ fixtures: FIXTURES, stateDir: state }).configureServer({ config: { server: { proxy: { '': 'https://production.example' } } }, middlewares: { use: (fn: (typeof used)[number]) => used.push(fn) } });
    let status = 0;
    let passed = false;
    used[0]!({ url: '/graphql', method: 'POST', headers: { 'x-gstack-scenario': 'owner' }, resume() {} }, { writeHead: (s: number) => { status = s; }, end: () => {} }, () => { passed = true; });
    expect([status, passed]).toEqual([501, false]);
  });

  test('the probe names the state directory, so the receipt finds a --state or --port 0 preview without --preview; a preview with no record is never clean', async () => {
    const state = tmpDir('pv-');
    const p = await startPreview(['--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', '0', '--state', state]);
    live.push(p);
    const at = (as: string) => `${p.url}settings?as=${as}`;
    const inv = inventory({ states: [{ name: 'owner', url: at('owner'), mode: 'url' }, { name: 'lastowner', url: at('lastowner'), mode: 'url' }] });
    expect(await servedStates(inv)).toEqual([{ origin: new URL(p.url).origin, state }]);
    await fetch(p.url + 'api/audit?as=lastowner');
    const repo = fixtureRepo();
    const runDir = tmpDir('design-build-run-');
    plan(inv, runDir);
    verifyStart(repo, inv, runDir);
    fs.writeFileSync(path.join(runDir, 'lint.json'), lintJson('clean', allMeasured()));
    for (const s of inv.states) for (const v of VPS) fs.writeFileSync(path.join(runDir, 'shots', `${s.name}-${v}.png`), 'png');
    const found = receipt({ repo, inv, runDir, rounds: 1, served: await servedStates(inv), outRoot: path.join(runDir, 'out') });
    expect(found.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNHANDLED');
    const unrecorded = receipt({ repo, inv, runDir, rounds: 1, served: [{ origin: new URL(p.url).origin, state: null }], outRoot: path.join(runDir, 'out2') });
    expect(unrecorded.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNRECORDED');
    const mod = await import(PREVIEW_TEMPLATE);
    const used: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    mod.gstackPreviewFixtures({ fixtures: FIXTURES }).configureServer({ middlewares: { use: (fn: (typeof used)[number]) => used.push(fn) } });
    const headers: Record<string, string> = {};
    used[0]!({ url: '/api/__gstack-preview', method: 'GET', headers: {} }, { writeHead: (_s: number, h: Record<string, string>) => Object.assign(headers, h), end: () => {} }, () => {});
    expect([headers['x-gstack-preview'], headers['x-gstack-preview-state']]).toEqual(['ready', '']);
  });

  test('redactText drops userinfo up to the last @ before the host and redacts a percent-encoded secret key', () => {
    expect(redactText('fetch http://' + ['user', 'p@ssw0rd'].join(':') + '@db.internal/x failed')).toBe('fetch http://db.internal/x failed');
    expect(redactText('GET http://h.test/p?%74oken=PCTSENTINEL&as=owner')).toBe('GET http://h.test/p?%74oken=REDACTED&as=owner');
  });
});

describe('round 4 (granted fix-check): a stopped preview on another origin keeps its default record', () => {
  test('when one origin answers the probe, a loopback origin that does not answer still has its default gstack-preview-<port> record read', async () => {
    const state = tmpDir('pv-');
    const p = await startPreview(['--static', '--root', PAGE, '--fixtures', FIXTURES, '--port', '0', '--state', state]);
    live.push(p);
    const gone = Bun.serve({ port: 0, fetch: () => new Response('') });
    const stoppedPort = gone.port;
    gone.stop(true);
    const stoppedDir = path.join(os.tmpdir(), `gstack-preview-${stoppedPort}`);
    fs.mkdirSync(stoppedDir, { recursive: true });
    fs.writeFileSync(path.join(stoppedDir, 'unhandled.jsonl'), JSON.stringify({ scenario: 'lastowner', method: 'GET', path: '/api/audit', code: 'PREVIEW_UNHANDLED' }) + '\n');
    try {
      const inv = inventory({ states: [{ name: 'owner', url: `${p.url}settings?as=owner`, mode: 'url' }, { name: 'lastowner', url: `http://127.0.0.1:${stoppedPort}/settings?as=lastowner`, mode: 'url' }] });
      const repo = fixtureRepo();
      const runDir = tmpDir('design-build-run-');
      plan(inv, runDir);
      verifyStart(repo, inv, runDir);
      fs.writeFileSync(path.join(runDir, 'lint.json'), lintJson('clean', allMeasured()));
      for (const s of inv.states) for (const v of VPS) fs.writeFileSync(path.join(runDir, 'shots', `${s.name}-${v}.png`), 'png');
      const r = receipt({ repo, inv, runDir, rounds: 1, served: await servedStates(inv), outRoot: path.join(runDir, 'out') });
      expect(r.line).toStartWith('DESIGN_BUILD: incomplete code=PREVIEW_UNHANDLED');
    } finally {
      fs.rmSync(stoppedDir, { recursive: true, force: true });
    }
  });
});
