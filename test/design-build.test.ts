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
import { admit, buildLine, check, parseInventory, plan, preflight, receipt, treeIdentity, verifyStart, type Inventory } from '../lib/design-build';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-design-build');
const VPS = ['1440x900', '375x812'];
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
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
const finding = (rule: string, tier = 'ask', state = 'owner') => ({ rule, tier, grade: 'D', file: 'x', line: 0, evidence: '[owner 1440px] a 2-line row leaves 4px', fix: 'f', source: 'render', ...(tier === 'waived' ? { waiver: 'house style here' } : {}), app: { state, viewport: '1440x900', locator: 'section.access > div.row', measured: 4, threshold: 8 } });

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

describe('preflight, authorization and install (T14, T38, T31)', () => {
  const engine = () => ({ engine: 'browse' as const, bin: '/x/browse' });
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
    const refused = await preflight(inv, [], { engine, reach });
    expect(refused.exit).toBe(4);
    expect(refused.lines[0]).toStartWith('DESIGN_BUILD: incomplete code=UNAUTHORIZED_TARGET (prod at https://app.example.com/settings?as=owner is not on loopback and has no grant; no page was opened and no action ran)');
    expect(reached).toEqual([]);
    expect((await preflight(inv, ['other.example.com'], { engine, reach })).exit).toBe(4);
    const probed: string[] = [];
    const granted = await preflight(inv, ['app.example.com'], { engine, reach, preview: async (u) => { probed.push(u); return true; } });
    expect(granted.lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback+granted mutations=fixtures+granted']);
    expect(probed).toEqual([URL_OWNER]);
    expect((await preflight(inv, ['app.example.com'], { engine, reach, preview: async () => false })).lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback+granted mutations=unknown']);
    expect((await preflight(inventory(), [], { engine, reach, preview: async () => true })).lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback mutations=fixtures-only']);
    expect((await preflight(inventory(), [], { engine, reach, preview: async (u) => !u.includes('lastowner') })).lines).toEqual(['PREFLIGHT: ok engine=browse states=2 targets=loopback mutations=unknown']);
  });

  test('only the preview\'s own probe answer proves fixtures-only: a marker in the HTML or a redirect does not', async () => {
    const page = '<!doctype html><!-- data-gstack-preview --><script data-gstack-preview></script><title>app</title>';
    const marked = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }) });
    const preview = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => (new URL(req.url).pathname === '/api/__gstack-preview' ? new Response(null, { status: 204, headers: { 'x-gstack-preview': 'ready' } }) : new Response(page, { headers: { 'content-type': 'text/html' } })) });
    const bounce = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => Response.redirect(`http://127.0.0.1:${preview.port}${new URL(req.url).pathname}`, 302) });
    try {
      const at = (port: number) => inventory({ states: [{ name: 'owner', url: `http://127.0.0.1:${port}/settings?as=owner`, mode: 'url' }] as Inventory['states'] });
      for (const port of [marked.port, bounce.port]) expect((await preflight(at(port), [], { engine, reach: async () => null })).lines).toEqual(['PREFLIGHT: ok engine=browse states=1 targets=loopback mutations=unknown']);
      expect((await preflight(at(preview.port), [], { engine, reach: async () => null })).lines).toEqual(['PREFLIGHT: ok engine=browse states=1 targets=loopback mutations=fixtures-only']);
    } finally { for (const s of [marked, preview, bounce]) s.stop(true); }
  });

  test('a URL that does not answer is unrendered NO_PREVIEW, redacted', async () => {
    const r = await preflight(inventory(), [], { engine, reach: async (u) => (u.includes('lastowner') ? 'connect ECONNREFUSED ' + u : null) });
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
