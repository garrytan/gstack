/**
 * GST-2500: a `[]` declaration on a test-tree glob (one naming a test/, tests/,
 * spec/ or __tests__/ directory) keeps the selected tests under it out of the
 * local lane, and pregate says so. alphaclaw's tests/live/** and
 * tests/container/** need their own tier; before this the lane ran them and the
 * repo's runner found no test files. Fixture code only, never alphaclaw's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
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
    expect(r.out).toContain('tests/live/x.test.js: not run here; tests/live/** is declared [] in .gstack/pregate.json (its own tier)');
    expect(r.out).toContain('1 test file(s) in declared test trees not run here');
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

  test('with no declaration, or a glob that does not match, the tier test is still selected and run', () => {
    for (const declared of [{}, { 'tests/container/**': [] }] as Array<Record<string, string[]>>) {
      const repo = fixture(declared);
      commit(repo, { 'tests/live/x.test.js': TIER_TEST + '\n' });
      const r = lanes(repo);
      expect(r.status).not.toBe(EXIT.ok);
      expect(r.out).toContain('tests/live/x.test.js (itself a test)');
      expect(r.out).not.toContain('declared test tree');
    }
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
