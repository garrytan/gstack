/**
 * A test a branch removes (deleted, or the old name of a rename) owes no lane
 * when nothing remaining imports it (issue #3529, gbrain#7829); any other
 * removal, a renamed source's old name included, owes what an edit owes, as on
 * main. Each waived test prints a visible `removed (no lane owed): <path> — <why>`
 * line: it runs the tests of files that still name it, and a deleted test runs
 * its owning suite (the remaining tests of the files it exercised) or says which
 * subjects lost their last test; a modified file whose only test was deleted
 * still fails, and an unreadable deleted test fails closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const UTIL_V2 = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../lib/util.js');\ntest('adds again', () => assert.strictEqual(add(2, 2), 4));\n";

function lanes(repo: FixtureRepo) {
  const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests']);
  const out = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
  const check = out.checks.find((c: { id: string }) => c.id === 'lanes');
  const lines: string[] = check.lines ?? [];
  return { status: r.status, check, lines, removed: lines.filter(l => l.startsWith('removed (no lane owed): ')), ran: lines.find(l => l.startsWith('ran: ')) ?? '' };
}

function move(repo: FixtureRepo, from: string, to: string, edit?: [string, (text: string) => string]) {
  repo.git('mv', from, to);
  if (edit) { const file = path.join(repo.work, edit[0]); fs.writeFileSync(file, edit[1](fs.readFileSync(file, 'utf8'))); }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'move');
}

describe('removed paths in lanes (#3529)', () => {
  test('a deleted test runs its owning suite: the remaining tests of the files it exercised', () => {
    const repo = fixture({ baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.code).not.toBe('PREGATE_NO_LANE');
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).toContain('test/util-v2.test.js');
    expect(r.ran).not.toContain("'test/util.test.js'");
    expect(r.check.detail).toContain('1 removed path(s)');
  });

  test('deleting the only test of a file says coverage removed, in the line and in the detail', () => {
    const repo = fixture();
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — coverage removed: lib/util.js has no remaining test']);
    expect(r.check.detail).toContain('1 removed path(s); 1 subject(s) lost their last test');
  });

  test('deleting a file and its test together waives the test; the deleted file still owes a lane', () => {
    const repo = fixture();
    commit(repo, { 'test/util.test.js': null, 'lib/util.js': null });
    const r = lanes(repo);
    expect(r.check.code).toBe('PREGATE_NO_LANE');
    expect(r.check.detail).toContain('1 touched file(s) with no test lane: lib/util.js');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — it exercised no file still in the tree']);
    expect(r.check.detail).not.toContain('lost their last test');
  });

  test('a renamed test runs under its new name; its old name is noted', () => {
    const repo = fixture();
    move(repo, 'test/util.test.js', 'test/util2.test.js');
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — old name of test/util2.test.js']);
    expect(r.ran).toContain('test/util2.test.js');
  });

  test('an unstaged deletion behaves like a committed one: the missing test is never selected', () => {
    const repo = fixture({ baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    fs.rmSync(path.join(repo.work, 'test/util.test.js'));
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).not.toContain("'test/util.test.js'");
  });

  test('a deleted executable test is read at its merge-base mode', () => {
    const repo = fixture({ baseFiles: { 'test/util-v2.test.js': UTIL_V2 } });
    fs.chmodSync(path.join(repo.work, 'test/util.test.js'), 0o755);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'exec'); repo.git('push', '-q', 'origin', 'HEAD:main');
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
  });

  test('a shared test helper the deleted test imported selects no suite and never reads as lost coverage', () => {
    const helper = "exports.check = (a, b) => a === b;\n";
    const usesHelper = "const test = require('node:test');\nconst { check } = require('./helpers/h.js');\ntest('helper', () => check(1, 1));\n";
    const util = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { check } = require('./helpers/h.js');\nconst { add } = require('../lib/util.js');\ntest('adds', () => assert.ok(check(add(1, 2), 3)));\n";
    const repo = fixture({ baseFiles: { 'test/helpers/h.js': helper, 'test/helper-user.test.js': usesHelper, 'test/util.test.js': util, 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).not.toContain('helper-user');
  });

  test('a deleted test named after a bin/ entrypoint reports that bin when it loses its last test', () => {
    const repo = fixture({ baseFiles: { 'bin/gstack-foo': '#!/bin/sh\necho foo\n', 'test/gstack-foo.test.js': "const test = require('node:test');\ntest('foo', () => {});\n" } });
    commit(repo, { 'test/gstack-foo.test.js': null });
    expect(lanes(repo).removed).toEqual(['removed (no lane owed): test/gstack-foo.test.js — coverage removed: bin/gstack-foo has no remaining test']);
  });

  test('a file declared no lane needed never reads as lost coverage', () => {
    const repo = fixture({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'lib/util.js': [] } } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.check.status).toBe('pass');
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — its files keep indirect or declared coverage']);
    expect(r.check.detail).not.toContain('lost their last test');
  });

  test('the owning suite is the tests that exercise the same files directly, not every test that reaches them', () => {
    const wrap = "exports.addTwice = (a) => require('./util.js').add(a, a);\n";
    const wrapTest = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { addTwice } = require('../lib/wrap.js');\ntest('twice', () => assert.strictEqual(addTwice(2), 4));\n";
    const repo = fixture({ baseFiles: { 'lib/wrap.js': wrap, 'test/wrap.test.js': wrapTest, 'test/util-v2.test.js': UTIL_V2 } });
    commit(repo, { 'test/util.test.js': null });
    const r = lanes(repo);
    expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — owning suite runs: test/util-v2.test.js']);
    expect(r.ran).not.toContain('test/wrap.test.js');
  });

  test('a test renamed to a non-test path is accounted for like a deleted test', () => {
    const repo = fixture();
    move(repo, 'test/util.test.js', 'docs/util-notes.md');
    expect(lanes(repo).removed).toEqual(['removed (no lane owed): test/util.test.js — coverage removed: lib/util.js has no remaining test']);
  });

  describe('negative controls', () => {
    test('deleting every file of a fixture directory a remaining test reads selects that test', () => {
      const reader = "const test = require('node:test');\nconst fs = require('node:fs');\ntest('reads the fixture dir', () => { fs.readdirSync('test/fixtures/data'); });\n";
      const repo = fixture({ baseFiles: { 'test/fixtures/data/a.json': '{}\n', 'test/fixtures/data/b.json': '{}\n', 'test/fixture-dir.test.js': reader } });
      commit(repo, { 'test/fixtures/data/a.json': null, 'test/fixtures/data/b.json': null });
      const r = lanes(repo);
      expect(r.removed).toEqual([]);
      expect(r.ran).toContain('test/fixture-dir.test.js');
    });

    test.each(['package.json', '.github/workflows/windows.yml', 'test/golden/digest.txt'])('deleting %s owes what editing it owes: PREGATE_NO_LANE', file => {
      const repo = fixture();
      commit(repo, { [file]: null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain(file);
      expect(r.removed).toEqual([]);
    });

    test('a deleted source file a remaining config still names fails closed', () => {
      const repo = fixture({ baseFiles: { 'scripts/setup.js': "console.log('setup');\n", 'bunfig.toml': '[test]\npreload = ["./scripts/setup.js"]\n' } });
      commit(repo, { 'scripts/setup.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('scripts/setup.js');
    });

    test('a deleted test that remaining code still imports fails closed', () => {
      const repo = fixture({ baseFiles: { 'lib/uses-test.js': "exports.cases = require('../test/util.test.js');\n" } });
      commit(repo, { 'test/util.test.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const why = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(`${why.out}${why.err}`).toContain('test/util.test.js: removed, but still imported by lib/uses-test.js');
    });

    const GO_MOD = 'module example.com/demo\n\ngo 1.22\n';
    const NOT_A_TEST = 'removed, but only a removed test is waived; any other removal owes what an edit owes';
    test.each([
      ['a file nothing references', { 'lib/orphan.js': 'exports.o = 1;\n' }, 'lib/orphan.js'],
      ['a file untested code imports without an extension', { 'src/d.ts': 'export const d = 1;\n', 'src/u.ts': "import { d } from './d';\nexport const u = d + 1;\n" }, 'src/d.ts'],
      ['a module untested code imports by its dotted name', { 'pkg/__init__.py': '', 'pkg/m.py': 'X = 1\n', 'app.py': 'from pkg import m\nprint(m.X)\n' }, 'pkg/m.py'],
      ['a module run by its dotted name', { 'tools/__init__.py': '', 'tools/cli.py': 'print(1)\n', 'Makefile': 'run:\n\tpython3 -m tools.cli\n' }, 'tools/cli.py'],
      ['a Go file its package still uses', { 'go.mod': GO_MOD, 'pkg/value.go': 'package pkg\n\nfunc value() int { return 1 }\n', 'pkg/main.go': 'package pkg\n\nfunc Main() int { return value() }\n' }, 'pkg/value.go'],
      ['a Ruby file loaded by require_relative', { 'lib/value.rb': 'VALUE = 1\n', 'lib/main.rb': "require_relative 'value'\n" }, 'lib/value.rb'],
      ['a shell helper a bin sources', { 'bin/helper.sh': 'greet() { echo hi; }\n', 'bin/tool': '#!/bin/sh\nDIR=$(dirname "$0")\n. "$DIR/helper.sh"\ngreet\n' }, 'bin/helper.sh'],
      ['a config its runner loads by name', { 'vitest.config.ts': 'export default {};\n' }, 'vitest.config.ts'],
      ['a Python startup file', { 'sitecustomize.py': 'import builtins\nbuiltins.FEATURE = True\n' }, 'sitecustomize.py'],
      ['a setup file a nested config names relative to itself', { 'packages/app/setup.ts': 'export {};\n', 'packages/app/bunfig.toml': '[test]\npreload = ["./setup.ts"]\n' }, 'packages/app/setup.ts'],
    ])('deleting %s still owes a lane, as on main', (_what, files, deleted) => {
      const repo = fixture({ baseFiles: files });
      commit(repo, { [deleted]: null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain(`${deleted}: ${NOT_A_TEST}`);
    });

    test('deleting a Go test whose package may share its helpers fails closed', () => {
      const repo = fixture({ baseFiles: { 'go.mod': GO_MOD, 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n\nfunc helper() {}\n', 'pkg/b_test.go': 'package pkg\n' } });
      commit(repo, { 'pkg/a_test.go': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain('pkg/a_test.go: removed, but a Go or Ruby test may define helpers');
    });

    test('a renamed source\'s old name still owes a lane, as on main', () => {
      const repo = fixture();
      move(repo, 'lib/util.js', 'lib/util2.js', ['test/util.test.js', t => t.replace('../lib/util.js', '../lib/util2.js')]);
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('lib/util.js');
      expect(r.removed).toEqual([]);
    });

    const CURATION = "exports.SKIP = ['test/util.test.js'];\n";
    const CURATION_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst { SKIP } = require('../scripts/curation.js');\ntest('every entry names a real test', () => assert.deepStrictEqual(SKIP.filter(f => !fs.existsSync(path.join(__dirname, '..', f))), []));\n";
    test.each([
      ['deleted test', (repo: FixtureRepo) => commit(repo, { 'test/util.test.js': null })],
      ['test renamed to another test', (repo: FixtureRepo) => move(repo, 'test/util.test.js', 'test/util2.test.js')],
    ])('a %s that a tested curation list still names runs that list\'s test, which fails loudly', (_how, change) => {
      const repo = fixture({ baseFiles: { 'scripts/curation.js': CURATION, 'test/curation.test.js': CURATION_TEST } });
      change(repo);
      const r = lanes(repo);
      expect(r.ran).toContain('test/curation.test.js');
      expect(r.check.status).toBe('fail');
      expect(r.removed[0]).toContain('files naming it run: test/curation.test.js');
    });

    describe('mapped removed tests (#3536)', () => {
      // Value: protects=mapped removals still run a stale curation list's test without losing the original selection;
      //   fails_when=the mapped-test fast path skips namer coverage; why_new=existing curation cases have no mapping; seam=none
      test.each([
        ['dependencies', 'deleted'],
        ['dependencies', 'renamed'],
        ['remaining test', 'deleted'],
        ['remaining test', 'renamed'],
      ] as const)('a %s mapping does not hide a %s test from curation checks', (mapping, change) => {
        const mapped = mapping === 'dependencies' ? 'test/retry.test.js' : 'test/referrer.test.js';
        const referrer = "const test = require('node:test');\nconst assert = require('node:assert');\nconst retired = ['test/util.test.js'];\ntest('records retired test paths', () => assert.strictEqual(retired.length, 1));\n";
        const repo = fixture({
          pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, ...(mapping === 'dependencies' ? { 'test/util.test.js': [mapped] } : {}) } },
          baseFiles: { 'scripts/curation.js': CURATION, 'test/curation.test.js': CURATION_TEST, ...(mapping === 'remaining test' ? { [mapped]: referrer } : {}) },
        });
        if (change === 'deleted') commit(repo, { 'test/util.test.js': null });
        else move(repo, 'test/util.test.js', 'test/util2.test.js');
        const r = lanes(repo);
        expect(r.ran).toContain(mapped);
        expect(r.ran).toContain('test/curation.test.js');
        expect(r.status).toBe(1);
        expect(r.check.code).toBe('PREGATE_LANE_FAILED');
      });

      // Value: protects=ignoring dependency keys never hides a policy runner's or dependency target's removed-test reference;
      //   fails_when=the whole policy file or its dependency values are exempted; why_new=mappings name removed tests in that same file; seam=none
      test.each(['runner', 'dependency target'] as const)('a mapped deletion keeps a policy %s reference uncovered', reference => {
        const repo = fixture({ pregate: {
          ...BASE_PREGATE,
          ...(reference === 'runner' ? { runner: 'node --test test/util.test.js {files}' } : {}),
          dependencies: { ...BASE_PREGATE.dependencies, 'test/util.test.js': ['test/retry.test.js'], ...(reference === 'dependency target' ? { 'lib/retry.js': ['test/util.test.js'] } : {}) },
        } });
        commit(repo, { 'test/util.test.js': null });
        const r = lanes(repo);
        expect(r.check.code).toBe('PREGATE_NO_LANE');
        expect(r.ran).toBe('');
      });

      // Value: protects=mapped removals refuse uncovered namers but honor explicit no-test declarations;
      //   fails_when=namers are ignored or declaredNone is discarded; why_new=existing refusals use unmapped removals; seam=none
      test.each([['without', false], ['with', true]] as const)('a mapped deletion %s a namer no-test declaration keeps its contract', (_label, declaredNone) => {
        const repo = fixture({
          pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'test/util.test.js': ['test/retry.test.js'], ...(declaredNone ? { 'scripts/skip-list.txt': [] } : {}) } },
          baseFiles: { 'scripts/skip-list.txt': 'test/util.test.js\n' },
        });
        commit(repo, { 'test/util.test.js': null });
        const r = lanes(repo);
        if (declaredNone) {
          expect(r.check.status).toBe('pass');
          expect(r.ran).toContain('test/retry.test.js');
        } else {
          expect(r.status).toBe(1);
          expect(r.check.code).toBe('PREGATE_NO_LANE');
          const why = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
          expect(why.out + why.err).toContain('scripts/skip-list.txt');
          expect(r.ran).toBe('');
        }
      });
    });

    test.each([
      ['an extensionless path in package.json', 'test/util.test.js', { 'package.json': '{ "name": "fixture", "scripts": { "smoke": "node --test test/util.test" } }\n' }],
      ['a dotted module name in a Makefile', 'tests/test_alpha.py', { 'tests/__init__.py': '', 'tests/test_alpha.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n', 'Makefile': 'smoke:\n\tpython3 -m unittest tests.test_alpha\n' }],
      ['a dotted module name untested code imports at run time', 'app/test_handlers.py', { 'app/__init__.py': '', 'app/test_handlers.py': 'X = 1\n', 'app/registry.py': 'import importlib\nH = importlib.import_module("app.test_handlers")\n' }],
      ['a JSON-escaped tab before the name', 'alpha.test.js', { 'alpha.test.js': "const test = require('node:test');\ntest('a', () => {});\n", 'package.json': '{ "name": "fixture", "scripts": { "smoke": "node --test\\talpha.test.js" } }\n' }],
      ['a URL-encoded path', 'test/alpha.test.js', { 'test/alpha.test.js': "const test = require('node:test');\ntest('a', () => {});\n", 'ci/links.txt': 'https://example.test/run?file=test%2Falpha.test.js\n' }],
    ])('a removed test named only by %s that no test covers fails closed', (_how, removed, files) => {
      const repo = fixture({ baseFiles: files });
      commit(repo, { [removed]: null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain(`${removed}: removed, but still named by`);
    });

    test('a removed test a file no test covers still names fails closed', () => {
      const repo = fixture({ baseFiles: { 'scripts/skip-list.txt': 'test/util.test.js\n' } });
      commit(repo, { 'test/util.test.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain('test/util.test.js: removed, but still named by scripts/skip-list.txt, which no test covers');
    });

    test('a rename into a waived path does not waive the old name: package.json renamed to Markdown fails closed', () => {
      const repo = fixture();
      move(repo, 'package.json', 'docs/package.md');
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('package.json');
      expect(r.removed).toEqual([]);
    });

    test('a renamed source remaining untested code still imports by its old name fails closed', () => {
      const repo = fixture({ baseFiles: { 'lib/a.js': 'exports.a = 1;\n', 'lib/u.js': "exports.u = require('./a.js').a;\n", 'notes/plan.md': '# plan\n' } });
      move(repo, 'lib/a.js', 'notes/a.md');
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('lib/a.js');
      expect(r.removed).toEqual([]);
    });

    test('a deleted file a remaining bin reads through its directory fails closed', () => {
      const repo = fixture({ baseFiles: { 'lib/plugins/a.js': 'exports.a = 1;\n', 'lib/plugins/b.js': 'exports.b = 2;\n', 'bin/load.js': "const fs = require('node:fs');\nfor (const f of fs.readdirSync('lib/plugins')) require('../lib/plugins/' + f);\n" } });
      commit(repo, { 'lib/plugins/a.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain(`lib/plugins/a.js: ${NOT_A_TEST}`);
    });

    test('a deleted file a tested loader reaches by a computed path fails closed', () => {
      const loader = "const path = require('node:path');\nexports.value = () => require(path.join(__dirname, 'lib', 'value.js')).value;\n";
      const loaderTest = "const test = require('node:test');\nconst { value } = require('../loader.js');\ntest('loads', () => value());\n";
      const repo = fixture({ baseFiles: { 'lib/value.js': 'exports.value = 1;\n', 'loader.js': loader, 'test/loader.test.js': loaderTest } });
      commit(repo, { 'lib/value.js': null });
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.removed).toEqual([]);
      const explain = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--explain']);
      expect(explain.out + explain.err).toContain(`lib/value.js: ${NOT_A_TEST}`);
    });

    test('a Go test renamed into another directory is refused: its old package may still call its helpers', () => {
      const repo = fixture({ baseFiles: { 'go.mod': 'module example.com/demo\n\ngo 1.22\n', 'pkg/a.go': 'package pkg\n', 'pkg/a_test.go': 'package pkg\n\nfunc helper() {}\n', 'pkg/b_test.go': 'package pkg\n\nfunc TestB(t *testing.T) { helper() }\n', 'isolated/keep.go': 'package isolated\n' } });
      move(repo, 'pkg/a_test.go', 'isolated/a_test.go');
      const r = lanes(repo);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('pkg/a_test.go');
      expect(r.removed).toEqual([]);
    });

    test('a modified file whose only test was deleted still fails PREGATE_NO_LANE', () => {
      const repo = fixture();
      commit(repo, { 'test/util.test.js': null, 'lib/util.js': "exports.add = (a, b) => b + a;\n" });
      const r = lanes(repo);
      expect(r.status).toBe(1);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('lib/util.js');
      expect(r.check.detail).not.toContain('test/util.test.js');
      expect(r.check.detail).toContain('1 removed path(s); 1 subject(s) lost their last test');
      expect(r.removed).toEqual(['removed (no lane owed): test/util.test.js — coverage removed: lib/util.js has no remaining test']);
    });

    test('a deleted file a remaining test still imports selects that test, which fails loudly', () => {
      const repo = fixture();
      commit(repo, { 'lib/util.js': null });
      const r = lanes(repo);
      expect(r.removed).toEqual([]);
      expect(r.ran).toContain('test/util.test.js');
      expect(r.check.code).toBe('PREGATE_LANE_FAILED');
    });

    test('an explicit dependencies mapping for a deleted path still selects its mapped test', () => {
      const repo = fixture({ pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'test/util.test.js': ['test/retry.test.js'] } } });
      commit(repo, { 'test/util.test.js': null });
      const r = lanes(repo);
      expect(r.check.status).toBe('pass');
      expect(r.removed).toEqual([]);
      expect(r.ran).toContain('test/retry.test.js');
    });

    test('a deleted markdown file keeps its docs/no-tests label', () => {
      const repo = fixture({ baseFiles: { 'notes/plan.md': '# plan\n' } });
      commit(repo, { 'notes/plan.md': null });
      const r = lanes(repo);
      expect(r.check.status).toBe('pass');
      expect(r.removed).toEqual([]);
      expect(r.lines).toContain('docs/no-tests (empty lane): notes/plan.md');
    });

    test('a deleted test whose merge-base text cannot be read (over 1 MiB) fails closed', () => {
      const big = "const test = require('node:test');\nrequire('../lib/util.js');\n// " + 'x'.repeat(1024 * 1024) + '\n';
      const repo = fixture({ baseFiles: { 'test/big.test.js': big } });
      commit(repo, { 'test/big.test.js': null });
      const r = lanes(repo);
      expect(r.status).toBe(1);
      expect(r.check.code).toBe('PREGATE_NO_LANE');
      expect(r.check.detail).toContain('test/big.test.js');
    });
  });
});
