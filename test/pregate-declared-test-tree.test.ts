/**
 * GST-2500: a `[]` declaration on a folder inside a test directory
 * (`tests/live/**`, never the whole `test/**`) keeps the selected tests under it
 * out of the local lane, and pregate says so. alphaclaw's tests/live/** and
 * tests/container/** need their own tier; before this the lane ran them and the
 * repo's runner found no test files. Fixture code only, never alphaclaw's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { lanesCheck } from '../lib/pregate/checks/lanes';
import { buildContext } from '../lib/pregate/context';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const TIER_TEST = "const test = require('node:test');\nconst { v } = require('./fixture');\ntest('needs the live tier', () => { throw new Error('tier test ran in the local lane ' + v); });\n";
const OUTSIDE_TEST = "const test = require('node:test');\nconst { v } = require('../tests/live/fixture');\ntest('reads the live fixture', () => { if (v !== 1) throw new Error('bad'); });\n";
const SCRIPT_TEST = "const test = require('node:test');\ntest('a test under a non-test glob', () => { throw new Error('script test ran'); });\n";
const BASE_FILES = { 'tests/live/fixture.js': 'exports.v = 1;\n', 'tests/live/x.test.js': TIER_TEST, 'test/outside.test.js': OUTSIDE_TEST, 'scripts/z.test.js': SCRIPT_TEST };

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const fixture = (declared: Record<string, string[]>) => {
  const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, ...declared } }, baseFiles: BASE_FILES });
  repos.push(repo);
  return repo;
};
const lanes = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes', '--explain']);
const LINE = /lanes: declared test tree tests\/live\/\*\*: 1 test file\(s\) not run in the local lane \(declared \[\] in origin\/main@[0-9a-f]{12}:\.gstack\/pregate\.json; the repo runs them in their own tier\)/;

describe('declared test trees', () => {
  test('a touched test under a [] test-tree glob is not run and the drop is printed and recorded', () => {
    const repo = fixture({ 'tests/live/**': [] });
    commit(repo, { 'tests/live/x.test.js': TIER_TEST + '\n' });
    const r = lanes(repo);
    expect(r.out).not.toContain('tier test ran in the local lane');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(LINE);
    const recorded = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack', 'tmp', 'pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(recorded.lines.map((l: string) => `lanes: ${l}`).join('\n')).toMatch(LINE);
    expect(r.out).toContain('tests/live/x.test.js: not run in the local lane; tests/live/** is declared [] in .gstack/pregate.json (its own tier)');
    expect(r.out).toContain('no local lane; 0 requires-remote obligation(s); 1 test file(s) in declared test trees not run here');
    expect(r.out).not.toContain('has no test lane');
  });

  test('a test outside the glob that imports a file inside it still runs; the tier test it shares the file with does not', () => {
    const repo = fixture({ 'tests/live/**': [] });
    commit(repo, { 'tests/live/fixture.js': 'exports.v = 1; \n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('test/outside.test.js ← tests/live/fixture.js');
    expect(r.out).toMatch(LINE);
    expect(r.out).toContain("ran: node --test 'test/outside.test.js'");
    expect(r.out).not.toContain('tier test ran in the local lane');
  });

  test('with no declaration, a glob that does not match, or a [] on the whole test directory, the tier test is still selected and run', () => {
    for (const declared of [{}, { 'tests/container/**': [] }, { 'tests/**': [] }, { 'tests/live/x.test.js': [] }] as Array<Record<string, string[]>>) {
      const repo = fixture(declared);
      commit(repo, { 'tests/live/x.test.js': TIER_TEST + '\n' });
      const r = lanes(repo);
      expect(r.status).not.toBe(EXIT.ok);
      expect(r.out).toContain('tests/live/x.test.js (itself a test)');
      expect(r.out).not.toContain('declared test tree');
    }
  });

  test('touching only a declared-tier test still runs the always_run tests', () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'tests/live/**': [] } }, baseFiles: { ...BASE_FILES, 'test/tree-tripwire.test.js': "const test = require('node:test');\ntest('scans the tree', () => {});\n", '.gstack/always-run.json': JSON.stringify({ tests: ['test/*-tripwire.test.js'] }) } });
    repos.push(repo);
    commit(repo, { 'tests/live/x.test.js': TIER_TEST + '\n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('test/tree-tripwire.test.js (always_run, .gstack/always-run.json)');
    expect(r.out).toContain("ran: node --test 'test/tree-tripwire.test.js'");
    expect(r.out).toMatch(LINE);
    expect(r.out).not.toContain('tier test ran in the local lane');
  });

  test('a [] for a test folder added only on the branch is refused under --policy-from head', () => {
    const repo = fixture({});
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'tests/live/**': [] } }) + '\n', 'tests/live/x.test.js': TIER_TEST + '\n' });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes', '--policy-from', 'head']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(PREGATE_HEAD_POLICY_LOOSENS');
  });

  test('an always_run test inside the declared tree still runs, whether always_run added it or the diff selected it first', () => {
    for (const touched of <Array<Record<string, string>>>[{ 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, { 'tests/live/x.test.js': TIER_TEST + '\n' }]) {
      const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'tests/live/**': [] } }, baseFiles: { ...BASE_FILES, '.gstack/always-run.json': JSON.stringify({ tests: ['tests/live/**'] }) } });
      repos.push(repo);
      commit(repo, touched);
      const r = lanes(repo);
      expect(r.status).not.toBe(EXIT.ok);
      expect(r.out).toContain('tier test ran in the local lane');
      expect(r.out).not.toContain('declared test tree');
    }
  });

  test('with no base or user policy, a [] the branch adds in its bootstrap policy drops nothing under --policy-from head', () => {
    const repo = makeFixtureRepo({ pregate: null, baseFiles: BASE_FILES });
    repos.push(repo);
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'tests/live/**': [] } }) + '\n', 'tests/live/x.test.js': TIER_TEST + '\n' });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--only', 'lanes', '--policy-from', 'head']);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toContain('tier test ran in the local lane');
    expect(r.out).not.toContain('declared test tree');
  });

  test('on a small machine the remote gate still owes a declared-tree test: the exclusion is local-only', async () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js', dependencies: { ...BASE_PREGATE.dependencies, 'tests/live/**': [] } }, baseFiles: BASE_FILES });
    repos.push(repo);
    commit(repo, { 'tests/live/x.test.js': TIER_TEST + '\n' });
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 4, testBackend: 'local' });
    if (!('ctx' in loaded)) throw new Error('fixture context refused');
    const r = await lanesCheck.run(loaded.ctx);
    expect(r.status).toBe('requires-remote');
    expect(r.remote?.find(o => o.lane === 'pregate.json/remote_gate')?.tests).toEqual(['tests/live/x.test.js']);
  });

  test('a [] declaration on a glob that names no test directory keeps running the tests under it', () => {
    const repo = fixture({ 'scripts/**': [] });
    commit(repo, { 'scripts/z.test.js': SCRIPT_TEST + '\n' });
    const r = lanes(repo);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toContain('scripts/z.test.js (itself a test)');
    expect(r.out).not.toContain('declared test tree');
  });
});
