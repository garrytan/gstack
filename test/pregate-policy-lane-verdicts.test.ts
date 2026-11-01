/**
 * GST-775 (from GBEV-3, gbrain-evals #272 and GBEV-22): `.gstack/pregate.json` could not raise the test timeout without
 * changing lane verdicts. (1) Any policy file, even `{"timeout_s": 1800}`, turned a touched file with no test lane into a
 * hard PREGATE_NO_LANE that returned before any test ran; with no file it only warned. (2) `warn: ["lanes"]` failed open:
 * the downgraded PREGATE_NO_LANE returned before the selected tests ran, so a red test beside an unmapped file passed.
 * (3) A `[]` declaration that matched a deleted test (the `"**": []` workaround) cleared it before the removed-test
 * handling, so the deleted test's owning suite no longer ran. A policy that declares lanes (a `dependencies`,
 * `empty_lanes`, `selection` or `local` key) keeps the hard PREGATE_NO_LANE.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

/** The fixture's planner-computed Windows lane replaced by a lint job, so the selected tests run here instead of becoming a requires-remote obligation. */
const NO_PLATFORM_LANE = { '.github/workflows/windows.yml': 'name: Lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo lint\n' };
const SCHEMA = BASE_PREGATE.$schema;
const UNMAPPED = { 'lib/orphan.js': 'exports.lonely = () => 2;\n' };
const GREEN = { ...UNMAPPED, 'lib/util.js': 'exports.add = (a, b) => b + a;\n' };
const RED = { ...UNMAPPED, 'lib/util.js': 'exports.add = (a, b) => a - b;\n' };
const UTIL_V2 = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../lib/util.js');\ntest('adds again', () => assert.strictEqual(add(2, 2), 4));\n";

function lanes(repo: FixtureRepo, extra: string[] = [], env: Record<string, string> = {}) {
  const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes', ...extra], env);
  const out = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
  const row = out.checks.find((c: { id: string }) => c.id === 'lanes');
  const lines: string[] = row.lines ?? [];
  return { ...r, row, lines, ran: lines.find(l => l.startsWith('ran: ')) ?? '', removed: lines.filter(l => l.startsWith('removed (no lane owed): ')) };
}

describe('a policy that declares no lanes keeps the no-policy lane verdicts (GST-775 bug 1)', () => {
  // Value: protects=a timeout-only policy (gbrain-evals #272's intent) leaves an unmapped file a warning with the selected tests run,
  //   exactly as with no policy; fails_when=any policy file turns the unmapped file into a hard PREGATE_NO_LANE before the tests run;
  //   why_new=the lane-requirement condition is new; seam=none; no_claim=the 600 s default changes
  test.each([
    ['timeout-only', { $schema: SCHEMA, timeout_s: 1800 }],
    ['runner, warn and strays', { $schema: SCHEMA, runner: 'node --test {files}', warn: ['strays'], strays: { allow: ['Makefile'] } }],
  ])('%s policy: unmapped file warns and the selected test runs, like no policy', (_name, policy) => {
    const none = fixture({ pregate: null, baseFiles: NO_PLATFORM_LANE });
    commit(none, GREEN);
    const n = lanes(none);
    const withPolicy = fixture({ pregate: policy, baseFiles: NO_PLATFORM_LANE });
    commit(withPolicy, GREEN);
    const p = lanes(withPolicy);
    expect(p.err).not.toContain('PREGATE_NO_LANE');
    expect([p.status, p.row.status, p.row.code]).toEqual([n.status, n.row.status, n.row.code]);
    expect([p.status, p.row.status, p.row.code]).toEqual([EXIT.ok, 'warn', 'PREGATE_NO_POLICY']);
    expect(p.ran).toContain('test/util.test.js');
    expect(p.row.detail).toMatch(/\d+ tests ran in \d+ file\(s\)/);
    expect(p.lines.some(l => l.startsWith('PREGATE_STARTER: '))).toBe(true);
  });

  // Value: protects=the warning never hides a red test under a lane-less policy; fails_when=the timeout-only branch returns warn for a
  //   failing lane; why_new=new branch; seam=none; no_claim=none
  test('timeout-only policy: a red selected test beside an unmapped file is PREGATE_LANE_FAILED', () => {
    const repo = fixture({ pregate: { $schema: SCHEMA, timeout_s: 1800 }, baseFiles: NO_PLATFORM_LANE });
    commit(repo, RED);
    const r = lanes(repo);
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.fail, 'fail', 'PREGATE_LANE_FAILED']);
    expect(r.ran).toContain('test/util.test.js');
  });

  // Value: protects=a fully mapped change prints no empty "have no test lane" line under no policy or a lane-less one; fails_when=the
  //   no-lane line is rendered for an empty list; why_new=the mode switch is new; seam=none; no_claim=none
  test.each([['no policy', null], ['timeout-only', { $schema: SCHEMA, timeout_s: 1800 }]])('%s: a fully mapped change passes with no no-lane line', (_name, policy) => {
    const repo = fixture({ pregate: policy, baseFiles: NO_PLATFORM_LANE });
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    const r = lanes(repo);
    expect([r.status, r.row.status]).toEqual([EXIT.ok, 'pass']);
    expect(r.lines.some(l => l.includes('have no test lane'))).toBe(false);
  });

  // Value: protects=the starter names the policy that exists instead of claiming there is none; fails_when=the starter header says
  //   "no .gstack/pregate.json" while one is on the base; why_new=new wording; seam=none; no_claim=none
  test('the starter says the active policy declares no lanes, not that there is no policy', () => {
    const repo = fixture({ pregate: { $schema: SCHEMA, timeout_s: 1800 }, baseFiles: NO_PLATFORM_LANE });
    commit(repo, GREEN);
    const r = lanes(repo);
    const header = r.lines.find(l => l.startsWith('PREGATE_STARTER: ')) ?? '';
    expect(header).toContain('declares no lanes');
    expect(header).not.toContain('no .gstack/pregate.json on');
  });
});

describe('warn: ["lanes"] never lets a red test pass (GST-775 bug 2)', () => {
  const warnLanes = { ...BASE_PREGATE, warn: ['strays', 'lanes'] };

  // Value: protects=the documented escape runs the selected tests and keeps a red lane fail; fails_when=the downgraded PREGATE_NO_LANE
  //   returns before the tests run (GBEV-22's fail-open); why_new=the warn path is new; seam=none; no_claim=none
  test('a red selected test beside an unmapped file fails with PREGATE_LANE_FAILED', () => {
    const repo = fixture({ pregate: warnLanes });
    commit(repo, RED);
    const r = lanes(repo);
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.fail, 'fail', 'PREGATE_LANE_FAILED']);
    expect(r.ran).toContain('test/util.test.js');
  });

  // Value: protects=only the missing-lane condition becomes the warning, after the tests ran green; fails_when=the warn row carries
  //   no test run, or the unmapped file is dropped from the row; why_new=new; seam=none; no_claim=none
  test('a green run with an unmapped file is warn PREGATE_NO_LANE, naming the file, after the tests ran', () => {
    const repo = fixture({ pregate: warnLanes });
    commit(repo, GREEN);
    const r = lanes(repo);
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.ok, 'warn', 'PREGATE_NO_LANE']);
    expect(r.ran).toContain('test/util.test.js');
    expect(r.row.detail).toMatch(/\d+ tests ran in \d+ file\(s\)/);
    expect(r.row.detail).toContain('lib/orphan.js');
    expect(r.row.detail).toContain('downgraded to warn');
  });

  // Value: protects=a selected test this machine cannot run stays a requires-remote obligation under the downgrade, never a warn or a
  //   pass; fails_when=withNoLaneWarning turns an unrun platform lane into warn; why_new=new arm; seam=none; no_claim=none
  test('a selected test only a platform lane runs stays requires-remote, coded PREGATE_NO_LANE', () => {
    const repo = fixture({ pregate: warnLanes });
    commit(repo, { ...UNMAPPED, 'test/windows-paths.test.js': "const test = require('node:test');\ntest('windows paths again', () => {});\n" });
    const r = lanes(repo);
    expect([r.row.status, r.row.code]).toEqual(['requires-remote', 'PREGATE_NO_LANE']);
    expect(r.row.detail).toContain('lib/orphan.js');
  });
});

describe('a [] declaration does not skip a deleted test\'s owning suite (GST-775 bug 3)', () => {
  const catchAll = { ...BASE_PREGATE, dependencies: { '**': [] } };

  // Value: protects=gbrain-evals' "**": [] catch-all still runs a deleted test's owning suite; fails_when=the [] declaration clears
  //   the deleted test before removedPath(); why_new=the ordering is new; seam=none; no_claim=none
  test('deleting a test under "**": [] runs its owning suite', () => {
    const repo = fixture({ pregate: catchAll, baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.row.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).toContain('test/util-v2.test.js');
  });

  // Value: protects=a file naming the deleted test that [] declares needs no lane (a durations manifest) does not stop the suite;
  //   fails_when=the namer reads as uncovered and the removal is cleared without its suite; why_new=new; seam=none; no_claim=none
  test('a curation file that names the deleted test and is declared [] does not stop the owning suite', () => {
    const repo = fixture({ pregate: catchAll, baseFiles: { 'test/util-v2.test.js': UTIL_V2, 'scripts/durations.json': '{"test/util.test.js": 1}\n' } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.row.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).toContain('test/util-v2.test.js');
  });
});

describe('negative controls: a policy that declares lanes still fails hard', () => {
  // Value: protects=declaring dependencies, empty_lanes, selection or local, even empty, keeps PREGATE_NO_LANE a hard stop before any test runs;
  //   fails_when=the lane-less branch fires for every policy; why_new=the boundary is new; seam=none; no_claim=none
  test.each([
    ['dependencies', { ...BASE_PREGATE }],
    ['an empty dependencies object', { $schema: SCHEMA, timeout_s: 1800, dependencies: {} }],
    ['an empty empty_lanes list', { $schema: SCHEMA, timeout_s: 1800, empty_lanes: [] }],
    ['an empty selection object', { $schema: SCHEMA, timeout_s: 1800, selection: {} }],
    ['an empty local list', { $schema: SCHEMA, timeout_s: 1800, local: [] }],
  ])('a base policy with %s keeps PREGATE_NO_LANE', (_name, policy) => {
    const repo = fixture({ pregate: policy, baseFiles: NO_PLATFORM_LANE });
    commit(repo, GREEN);
    const r = lanes(repo);
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.fail, 'fail', 'PREGATE_NO_LANE']);
    expect(r.ran).toBe('');
    expect(r.lines.some(l => l.startsWith('PREGATE_STARTER: '))).toBe(false);
  });

  // Value: protects=the user-owned policy follows the same boundary; fails_when=the user file is treated differently from the base
  //   copy; why_new=new; seam=none; no_claim=none
  test('a user-owned policy that declares dependencies keeps PREGATE_NO_LANE', () => {
    const repo = fixture({ pregate: null, baseFiles: NO_PLATFORM_LANE });
    commit(repo, GREEN);
    const userPolicy = path.join(repo.home, 'projects', 'gst775slug', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ runner: 'node --test {files}', dependencies: { 'docs/**': [] } }));
    const r = lanes(repo, [], { GSTACK_PROJECT_SLUG: 'gst775slug' });
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.fail, 'fail', 'PREGATE_NO_LANE']);
  });

  // Value: protects=a --policy-from head file that adds a lane over a lane-less base makes the run strict; fails_when=the head merge
  //   keeps the base's declaresLanes only; why_new=the merge is new; seam=none; no_claim=none
  test('--policy-from head adding dependencies over a timeout-only base keeps PREGATE_NO_LANE', () => {
    const repo = fixture({ pregate: { $schema: SCHEMA, timeout_s: 1800 }, baseFiles: NO_PLATFORM_LANE });
    commit(repo, { ...GREEN, '.gstack/pregate.json': JSON.stringify({ $schema: SCHEMA, timeout_s: 1800, dependencies: { 'bin/tool': ['test/util.test.js'] } }) + '\n' });
    const r = lanes(repo, ['--policy-from', 'head']);
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.fail, 'fail', 'PREGATE_NO_LANE']);
  });

  // Value: protects=without a [] declaration a deleted test still runs its owning suite and an unmapped deleted source still fails;
  //   fails_when=moving the removed-test handling waives non-test removals; why_new=new; seam=none; no_claim=none
  test('a deleted source file under a lane-declaring policy still owes a lane', () => {
    const repo = fixture();
    commit(repo, { 'test/util.test.js': null, 'lib/util.js': null });
    const r = lanes(repo);
    expect(r.row.code).toBe('PREGATE_NO_LANE');
    expect(r.row.detail).toContain('lib/util.js');
  });

  // Value: protects=warn: ["lanes"] does not downgrade a red lane even with every file mapped; fails_when=the lanes downgrade starts
  //   applying to PREGATE_LANE_FAILED; why_new=regression guard; seam=none; no_claim=none
  test('warn: ["lanes"] with every file mapped keeps a red lane fail', () => {
    const repo = fixture({ pregate: { ...BASE_PREGATE, warn: ['strays', 'lanes'] } });
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a - b;\n' });
    const r = lanes(repo);
    expect([r.status, r.row.status, r.row.code]).toEqual([EXIT.fail, 'fail', 'PREGATE_LANE_FAILED']);
  });
});
