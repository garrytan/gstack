/**
 * C8 `lanes` selection and the mechanical preflight checks, pinned on tokens,
 * exit codes and the pregate.json contract. Fixture repos live under
 * os.tmpdir() (test/helpers/pregate-fixture.ts). Incident replays named in
 * the plan's P0-4 section, each caught locally before any remote gate:
 *   p0-4-stale-goldens          regen: a changed input, an unchanged output
 *   p0-4-scratch-script         strays: zz-probe.sh at the repository root
 *   p0-4-heavy-old-constant     literals: a nightly-only test keeps the old number
 *   p0-4-windows-lane-unrun     lanes: a Windows-only test file changes on Linux
 *   p0-4-pipe-hidden-failure    lanes: `false | tail` under pipefail is red
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { changedLiterals, constantsIn } from '../lib/pregate/checks/literals';
import { parseSummary } from '../lib/pregate/checks/lanes';
import { validateConfig } from '../lib/pregate/config';
import { isDocsEmptyLane } from '../lib/pregate/docs-lane';
import { buildGraph, testsFor } from '../lib/pregate/import-graph';
import { CHECK_IDS } from '../lib/pregate/index';
import { parseWorkflow } from '../lib/pregate/workflows';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', ...args]);
const readOut = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8'));
const check = (repo: FixtureRepo, id: string) => readOut(repo).checks.find((c: any) => c.id === id);

describe('workflow lanes (parser over .github/workflows)', () => {
  test('platform from runs-on, planner-computed matrix kept as an expression, test files from run steps and package scripts, manual jobs flagged', () => {
    const text = `name: CI\njobs:\n  unit:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: bun test test/a.test.ts\n  win:\n    runs-on: windows-latest\n    strategy:\n      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}\n    steps:\n      - run: |\n          bun run test:win\n  record:\n    if: \${{ inputs.record }}\n    runs-on: windows-latest\n    steps:\n      - run: bun run test:win --record\n  serial:\n    runs-on: macos-latest\n    strategy:\n      max-parallel: 1\n    steps:\n      - run: npm test\n`;
    const lanes = parseWorkflow('ci.yml', text, 'linux', { 'test:win': 'bun test test/win.test.ts' });
    expect(lanes.map(l => [l.id, l.platform, l.tier, l.runsTests, l.manual])).toEqual([
      ['ci.yml/unit', 'linux', 'unit', true, false], ['ci.yml/win', 'windows', 'platform', true, false], ['ci.yml/record', 'windows', 'platform', true, true], ['ci.yml/serial', 'macos', 'platform', true, false],
    ]);
    expect(lanes[0]!.testFiles).toEqual(['test/a.test.ts']);
    expect(lanes[1]!.matrixExpression).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    expect(lanes[1]!.testFiles).toEqual(['test/win.test.ts']);
    expect(parseWorkflow('ci.yml', text, 'win32')[1]!.tier).toBe('unit');
    expect(parseWorkflow('ci.yml', text, 'win32')[0]!.tier).toBe('platform');
  });

  test('a verify-only shard step is not a test lane', () => {
    const lanes = parseWorkflow('w.yml', 'jobs:\n  v:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: bun run scripts/test-free-shards.ts --windows-only --ci-verify x\n');
    expect(lanes[0]!.runsTests).toBe(false);
  });
});

describe('import graph (static imports ∪ repo-path literals ∪ bin convention ∪ declarations)', () => {
  test('imports, a joined literal read, the bin/<name> convention, a declared dependency and a deleted file all map; an orphan does not', () => {
    const repo = fixture();
    commit(repo, { 'lib/gone.js': null, 'test/gone.test.js': "const test = require('node:test');\ntest('reads a path', () => { require('node:fs').existsSync('lib/gone.js'); });\n" });
    const g = buildGraph(repo.work, { declarations: BASE_PREGATE.dependencies, extraFiles: ['lib/gone.js'] });
    expect(testsFor(g, 'lib/retry.js').tests).toEqual(['test/nightly/retry-heavy.test.js', 'test/retry.test.js']);
    expect(testsFor(g, 'lib/config.json').tests).toEqual(['test/config-read.test.js']);
    expect(testsFor(g, 'bin/tool').tests).toEqual(['test/tool-cli.test.js']);
    const declared = buildGraph(repo.work, { declarations: { 'lib/orphan.js': ['test/util.test.js'] } });
    expect(testsFor(declared, 'lib/orphan.js').provenance).toEqual(['test/util.test.js ← lib/orphan.js (declared)']);
    expect(testsFor(g, 'lib/gone.js').tests).toEqual(['test/gone.test.js']);
    expect(testsFor(g, 'lib/orphan.js')).toMatchObject({ tests: [], declaredNone: false });
    expect(testsFor(g, 'docs/README.md', BASE_PREGATE.dependencies)).toMatchObject({ tests: [], declaredNone: true });
    expect(testsFor(g, 'test/util.test.js').tests).toEqual(['test/util.test.js']);
  });

  test('markdown a test reads maps through the same literal and join edges; an unreferenced markdown file does not', () => {
    const repo = fixture();
    commit(repo, {
      'prompts/system.md': '# system\n',
      'notes/scratch.md': '# scratch\n',
      'test/fixtures/sample.md': '# sample\n',
      'test/prompt-doc.test.js': "const test = require('node:test');\nconst fs = require('node:fs');\ntest('reads the prompt', () => { fs.readFileSync('prompts/system.md', 'utf8'); });\n",
      'test/fixture-doc.test.js': "const test = require('node:test');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('reads the fixture', () => { fs.readFileSync(path.join('test', 'fixtures', 'sample.md'), 'utf8'); });\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'prompts/system.md').tests).toEqual(['test/prompt-doc.test.js']);
    expect(testsFor(g, 'prompts/system.md').provenance[0]).toContain('(literal)');
    expect(testsFor(g, 'test/fixtures/sample.md').tests).toEqual(['test/fixture-doc.test.js']);
    expect(testsFor(g, 'test/fixtures/sample.md').provenance[0]).toContain('(literal)');
    expect(testsFor(g, 'notes/scratch.md')).toMatchObject({ tests: [], declaredNone: false });
  });

  test('python: absolute, from-import submodule, relative and parenthesised imports and mock.patch targets map; stdlib, comments and docstrings do not', () => {
    const repo = fixture();
    commit(repo, {
      'pkg/__init__.py': '',
      'pkg/core.py': 'import os\nfrom pkg.util import helper\n',
      'pkg/util.py': 'def helper():\n    return 1\n',
      'pkg/multi.py': 'X = 1\n',
      'pkg/patched.py': 'class Thing:\n    def run(self):\n        return 1\n',
      'pkg/ghost.py': 'G = 1\n',
      'pkg/sub/__init__.py': '',
      'pkg/sub/sibling.py': 'S = 1\n',
      'pkg/sub/leaf.py': 'from .. import core\nfrom . import sibling\n',
      'tests/test_core.py': 'import pkg.core as core\n',
      'tests/test_leaf.py': 'from pkg.sub import leaf\n',
      'tests/test_multi.py': 'from pkg import (\n    multi,  # the module\n    util,\n)\nimport json, os.path\n',
      'tests/test_patch.py': "from unittest import mock\n\n@mock.patch('pkg.patched.Thing.run')\ndef test_run(run):\n    pass\n",
      'tests/test_ghost.py': '"""\nimport pkg.ghost\n"""\n# from pkg import ghost\nX = "from pkg import ghost"\n',
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'pkg/core.py').tests).toEqual(['tests/test_core.py', 'tests/test_leaf.py']);
    expect(testsFor(g, 'pkg/util.py').tests).toEqual(['tests/test_core.py', 'tests/test_leaf.py', 'tests/test_multi.py']);
    expect(testsFor(g, 'pkg/sub/sibling.py').tests).toEqual(['tests/test_leaf.py']);
    expect(testsFor(g, 'pkg/multi.py').tests).toEqual(['tests/test_multi.py']);
    expect(testsFor(g, 'pkg/patched.py').provenance).toEqual(['tests/test_patch.py ← pkg/patched.py (literal)']);
    expect(testsFor(g, 'pkg/sub/__init__.py').tests).toEqual(['tests/test_leaf.py']);
    expect(testsFor(g, 'pkg/__init__.py').tests).toEqual(['tests/test_core.py', 'tests/test_leaf.py', 'tests/test_multi.py', 'tests/test_patch.py']);
    expect(testsFor(g, 'pkg/ghost.py').tests).toEqual([]);
    expect([...g.reverse.keys()].filter(k => k.endsWith('.py')).sort()).toEqual([
      'pkg/__init__.py', 'pkg/core.py', 'pkg/multi.py', 'pkg/patched.py', 'pkg/sub/__init__.py', 'pkg/sub/leaf.py', 'pkg/sub/sibling.py', 'pkg/util.py',
    ]);
  });

  test('python: a package and a same-named module both map, statements after ; and : map, escaped triple quotes and deep modules map, a path literal does not hide its patch target, and adversarial input stays linear', () => {
    const repo = fixture();
    commit(repo, {
      'app.py': 'A = 1\n',
      'app/__init__.py': '',
      'pkg/__init__.py': '',
      'pkg/core.py': 'C = 1\n',
      'pkg/patched.py': 'class Thing:\n    pass\n',
      'pkg.patched.Thing.run': 'a file whose name is also a patch target\n',
      'tests/test_app.py': 'import app\n',
      'tests/test_semicolon.py': 'import os; import pkg.core\n',
      'tests/test_inline.py': 'def test_core():\n    if True: from pkg.core import C\n',
      'tests/test_patch.py': "from unittest import mock\n\n@mock.patch('pkg.patched.Thing.run')\ndef test_run(run):\n    pass\n",
      'tests/test_adversarial.py': `from ${'.'.repeat(100_000)}x\nfrom ${' '.repeat(100_000)}x\nX = '${Array.from({ length: 20_000 }, () => 'pkg').join('.')}'\n${'\\"""'.repeat(20_000)}\n`,
      'tests/test_escaped.py': 'DOC = """text \\"""\nstill doc"""\nimport pkg.core\nTAIL = """x"""\n',
      [`${Array.from({ length: 33 }, (_, i) => `d${i}`).join('/')}/leaf.py`]: 'L = 1\n',
      'tests/test_deep.py': `import ${Array.from({ length: 33 }, (_, i) => `d${i}`).join('.')}.leaf\n`,
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'app/__init__.py').tests).toEqual(['tests/test_app.py']);
    expect(testsFor(g, 'app.py').tests).toEqual(['tests/test_app.py']);
    expect(testsFor(g, 'pkg/core.py').tests).toEqual(['tests/test_escaped.py', 'tests/test_inline.py', 'tests/test_semicolon.py']);
    expect(testsFor(g, `${Array.from({ length: 33 }, (_, i) => `d${i}`).join('/')}/leaf.py`).tests).toEqual(['tests/test_deep.py']);
    expect(testsFor(g, 'pkg/patched.py').tests).toEqual(['tests/test_patch.py']);
    expect(testsFor(g, 'pkg.patched.Thing.run').tests).toEqual(['tests/test_patch.py']);
    expect(testsFor(g, 'pkg/__init__.py').tests).toEqual(['tests/test_adversarial.py', 'tests/test_escaped.py', 'tests/test_inline.py', 'tests/test_patch.py', 'tests/test_semicolon.py']);
  });
});

describe('literals (pure)', () => {
  test('exported constants with literal values are extracted; a changed one pairs old and new; functions are ignored', () => {
    expect([...constantsIn("export const MAX = 3;\nexport const NAME = 'x';\nexports.LIMIT = 10;\nexport const fn = () => 1;\nTIMEOUT_MS = 5000\n").entries()]).toEqual([['MAX', '3'], ['NAME', "'x'"], ['LIMIT', '10'], ['TIMEOUT_MS', '5000']]);
    expect(changedLiterals('f.ts', 'export const MAX = 3;\nconst x = { timeout: 5000 };', 'export const MAX = 4;\nconst x = { timeout: 9000 };')).toEqual([
      { name: 'MAX', old: '3', new: '4', file: 'f.ts' }, { name: 'timeout', old: '5000', new: '9000', file: 'f.ts' },
    ]);
  });
  test('runner summaries: bun, node --test, vitest, jest, pytest, zero-run', () => {
    expect(parseSummary(' 12 pass\n 1 fail\nRan 13 tests across 2 files.')).toEqual({ ran: 13, failed: 1 });
    expect(parseSummary('# tests 4\n# pass 4\n# fail 0')).toEqual({ ran: 4, failed: 0 });
    expect(parseSummary('Tests  2 failed | 8 passed (10)')).toEqual({ ran: 10, failed: 2 });
    expect(parseSummary('Tests:       1 failed, 7 passed, 8 total')).toEqual({ ran: 8, failed: 1 });
    expect(parseSummary('===== 3 passed in 0.1s =====')).toEqual({ ran: 3, failed: 0 });
    expect(parseSummary('No tests found')).toEqual({ ran: 0, failed: 0 });
    expect(parseSummary('ok')).toEqual({ ran: null, failed: null });
  });
  test('config: unknown keys, secrets in warn, a runner without {files} and an uncontained glob are PREGATE_CONFIG_INVALID', () => {
    const codes = (c: unknown) => validateConfig(c, CHECK_IDS).map(e => `${e.code}:${e.path}`);
    expect(codes(BASE_PREGATE)).toEqual([]);
    expect(codes({ warn: ['secrets'] })).toEqual(['PREGATE_CONFIG_INVALID:warn']);
    expect(codes({ warn: ['bogus'] })).toEqual(['PREGATE_CONFIG_INVALID:warn']);
    expect(codes({ runner: 'bun test' })).toEqual(['PREGATE_CONFIG_INVALID:runner']);
    expect(codes({ dependencies: { '../x': [] } })).toEqual(['PREGATE_CONFIG_INVALID:dependencies["../x"]']);
    expect(codes({ empty_lanes: 'docs/**' })).toEqual(['PREGATE_CONFIG_INVALID:empty_lanes']);
    expect(codes({ empty_lanes: ['../x'] })).toEqual(['PREGATE_CONFIG_INVALID:empty_lanes[0]']);
    expect(codes({ empty_lanes: ['notes/**/*.md'] })).toEqual([]);
    expect(codes({ selection: { 'ci/job': 'x' } })).toEqual(['PREGATE_CONFIG_INVALID:selection["ci/job"]']);
    expect(codes({ extra: 1 })).toEqual(['PREGATE_CONFIG_INVALID:extra']);
  });
});

describe('docs/no-tests empty lane', () => {
  const docs = [
    '.work/round-3-plan.md', 'pkg/.work/notes.md', 'notes/redproof.md', 'notes/REDPROOF.md',
    'notes/round-3.red-proof.md', 'docs/evidence.md', 'docs/guide.md', 'Docs/Guide.MD',
    'documentation/index.md', 'plans/2026-10-16.md', 'README.md', 'lib/README.md',
    'CHANGELOG.md', 'LICENSE', 'notes/implementation-plan.md', 'notes/planning.md', 'src/plan.md',
    'prompts/system.md', 'src/notes.md', 'src/explanation.md', 'planet.md', 'my-docs/guide.md', 'notes/scratch.md',
  ];
  const blocked = [
    'lib/orphan.js', 'src/app.ts', 'bin/tool', 'scripts/gen.sh', 'notes/scratch.txt',
    'docs/example.ts', 'test/fixtures/plan.md', 'test/plans/plan.md', '__tests__/redproof.md',
  ];
  test('markdown qualifies, including unmarked names; source, test trees and non-markdown do not', () => {
    for (const file of docs) expect(isDocsEmptyLane(file)).toBe(true);
    for (const file of blocked) expect(isDocsEmptyLane(file)).toBe(false);
  });
  test('empty_lanes adds documentation globs and cannot clear source code or a test-tree file', () => {
    expect(isDocsEmptyLane('notes/scratch.txt')).toBe(false);
    expect(isDocsEmptyLane('notes/scratch.txt', ['notes/**/*.txt'])).toBe(true);
    expect(isDocsEmptyLane('lib/orphan.js', ['**', 'lib/**', '**/*.js'])).toBe(false);
    expect(isDocsEmptyLane('docs/example.ts', ['docs/**'])).toBe(false);
    expect(isDocsEmptyLane('bin/tool', ['bin/**'])).toBe(false);
    expect(isDocsEmptyLane('test/fixtures/plan.md', ['**/*.md', 'test/**'])).toBe(false);
  });
});

describe('gstack-pregate (bin)', () => {
  test('--help prints the exit table and both stages; unknown commands and checks are usage (2)', () => {
    const repo = fixture();
    const help = runBin(repo, 'gstack-pregate', ['--help']);
    expect(help.out).toContain('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag');
    expect(help.out).toContain('stage 1 mechanical preflight (regen, secrets, strays, literals, timing, guards)');
    expect(help.out).toContain('stage 2 test execution (lanes)');
    expect(runBin(repo, 'gstack-pregate', ['bogus']).status).toBe(EXIT.usage);
    expect(pregate(repo, ['--only', 'hermetic']).status).toBe(EXIT.usage);
  });

  test('a clean branch passes every check, runs the selected local lane under pipefail and writes a valid pregate.json with both clocks', () => {
    const repo = fixture();
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^preflight {2}regen {5}pass /m);
    expect(r.out).toMatch(/^preflight {2}secrets {3}pass /m);
    expect(r.out).toMatch(/^preflight {2}strays {4}pass /m);
    expect(r.out).toMatch(/^preflight {2}literals {2}pass /m);
    expect(r.out).toMatch(/^preflight {2}guards {4}pass .*no guards declared/m);
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*1 tests ran in 1 file\(s\), exit 0/m);
    expect(r.out).toMatch(/^stage 1 \(mechanical preflight\): \d+ ms$/m);
    expect(r.out).toMatch(/^stage 2 \(test execution\): \d+ ms$/m);
    expect(r.out).toContain('Tiers ran: unit; requires-remote: none');
    expect(r.out).toMatch(/GSTACK_RESULT: skill=pregate status=complete run=.*pregate\.json/);
    const out = readOut(repo);
    expect(out.schema_version).toBe(1);
    expect(out.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(out.checks.map((c: any) => [c.id, c.status, c.stage])).toEqual([['regen', 'pass', 'preflight'], ['secrets', 'pass', 'preflight'], ['strays', 'pass', 'preflight'], ['literals', 'pass', 'preflight'], ['timing', 'pass', 'preflight'], ['guards', 'pass', 'preflight'], ['lanes', 'pass', 'tests']]);
    for (const c of out.checks) { expect(c.inputs.tree).toBe(out.tree); expect(typeof c.ms).toBe('number'); }
    expect(check(repo, 'lanes').inputs.command).toMatch(/^[0-9a-f]{64}$/);
    expect(out.verdict).toBe('pass');
    expect(runBin(repo, 'gstack-artifact', ['validate', path.join(repo.work, '.gstack/tmp/pregate.json'), '--as', 'pregate']).status).toBe(EXIT.ok);
  });

  test('p0-4-stale-goldens: regen fails with the exact write command; the tree is untouched', () => {
    const repo = fixture();
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n" });
    const r = pregate(repo, ['--stage', 'preflight']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^preflight {2}regen {5}fail .*1 stale: generated\/digest\.md \(REGEN_STALE\)/m);
    expect(r.out).toContain('regen: regen digest: stale');
    expect(r.out).toContain('fix: node gen.js  # then commit generated/**');
    expect(r.err).toContain('(REGEN_STALE)');
    expect(fs.readFileSync(path.join(repo.work, 'generated/digest.md'), 'utf8')).toBe('# digest v1.0.0\n');
    expect(readOut(repo).stage2_ms).toBeUndefined();
  });

  test('missing dependencies: regen is incomplete with REGEN_DEPS_MISSING and the install command, not REGEN_STALE', () => {
    const repo = fixture({
      registry: { entries: [{ id: 'digest', command: 'node gen.js', outputs: ['generated/**'], inputs: ['src/version.js', 'gen.js'] }] },
      baseFiles: {
        'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test test/*.test.js' }, devDependencies: { 'fixture-dep': '1.0.0' } }, null, 2) + '\n',
        'gen.js': "const fs=require('fs');const {VERSION}=require('./src/version.js');let style='plain';try{style=require('fixture-dep').style;}catch{}fs.writeFileSync('generated/digest.md',`# digest v${VERSION} (${style})\\n`);\n",
        'generated/digest.md': '# digest v1.0.0 (fancy)\n',
      },
    });
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.0.0' };\n// touched\n" });
    const r = pregate(repo, ['--stage', 'preflight', '--only', 'regen']);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^preflight {2}regen {5}incomplete .*dependencies missing; run bun install, then rerun the check \(1 entry unverified: digest\) \(REGEN_DEPS_MISSING\)/m);
    expect(r.err).toContain('(REGEN_DEPS_MISSING)');
    expect(r.out + r.err).not.toContain('REGEN_STALE');
  });

  test('p0-4-scratch-script: zz-probe.sh at the root fails strays (downgraded to warn only when the base config says so); a conventional root file passes', () => {
    const strict = fixture({ pregate: { ...BASE_PREGATE, warn: [] } });
    commit(strict, { 'zz-probe.sh': '#!/bin/sh\necho hi\n', 'CONTRIBUTING.md': '# c\n', 'notes.txt': 'x\n', 'newtop/thing.js': 'module.exports = 1;\n' });
    const r = pregate(strict, ['--stage', 'preflight', '--only', 'strays']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^preflight {2}strays {4}fail .*2 stray file\(s\): notes\.txt zz-probe\.sh \(PREGATE_STRAYS\)/m);
    expect(r.out).toContain('strays: zz-probe.sh: scratch name (zz-probe.sh)');
    expect(r.out).toContain('strays: notes.txt: new file at the repository root');
    expect(r.out).toContain('newtop/thing.js: new top-level directory newtop/');
    expect(r.out).not.toContain('CONTRIBUTING.md:');
    const lenient = fixture();
    commit(lenient, { 'zz-probe.sh': '#!/bin/sh\n' });
    const w = pregate(lenient, ['--stage', 'preflight', '--only', 'strays']);
    expect(w.status).toBe(EXIT.ok);
    expect(w.out).toMatch(/^preflight {2}strays {4}warn .*downgraded to warn by origin\/main@/m);
  });

  test('p0-4-heavy-old-constant: a nightly-only test still asserting the old literal fails literals with file:line', () => {
    const repo = fixture();
    commit(repo, { 'lib/retry.js': "exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 9000;\nexports.retry = (fn) => fn();\n" });
    const r = pregate(repo, ['--stage', 'preflight', '--only', 'literals']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('literals: test/nightly/retry-heavy.test.js:3: TIMEOUT_MS still 5000 (now 9000 in lib/retry.js)');
    expect(r.out).not.toContain('test/retry.test.js');
    expect(r.err).toContain('(PREGATE_LITERALS)');
    // Updating the consumer clears it.
    commit(repo, { 'test/nightly/retry-heavy.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('heavy', () => assert.strictEqual(require('../../lib/retry.js').TIMEOUT_MS, 9000));\n" });
    expect(pregate(repo, ['--stage', 'preflight', '--only', 'literals']).status).toBe(EXIT.ok);
  });

  test('secrets: a credential in an added line fails and cannot be downgraded; a committed-then-removed line is clean', () => {
    const repo = fixture({ pregate: { ...BASE_PREGATE, warn: ['secrets'] } });
    const bad = pregate(repo, ['--stage', 'preflight', '--only', 'secrets']);
    expect(bad.status).toBe(EXIT.refused);
    expect(bad.err).toContain('secrets cannot be downgraded to warn');
    const ok = fixture();
    write(ok.work, 'lib/token.js', `exports.T = 'ghp_${'A'.repeat(36)}';\n`);
    const r = pregate(ok, ['--stage', 'preflight', '--only', 'secrets']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^preflight {2}secrets {3}fail .*credential finding\(s\) in added lines \(github\.pat\) \(PREGATE_SECRETS\)/m);
    expect(r.out).toContain('HIGH github.pat [secret]');
    fs.rmSync(path.join(ok.work, 'lib/token.js'));
    expect(pregate(ok, ['--stage', 'preflight', '--only', 'secrets']).status).toBe(EXIT.ok);
  });

  test('lanes: tracked planning and evidence markdown is docs/no-tests, and an unmapped source file still fails closed', () => {
    // No .gstack/pregate.json on the base: documentation cannot be declared as [].
    const docs = fixture({ pregate: null });
    commit(docs, {
      '.work/round-3-plan.md': '# plan\n\nImplementation notes, not a test subject.\n',
      'notes/redproof.md': '# redproof\n\nThe lane failed, then this note recorded the green run.\n',
      'docs/evidence.md': '# evidence\n',
    });
    const ok = pregate(docs, ['--only', 'lanes', '--explain']);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.err).not.toContain('PREGATE_NO_LANE');
    expect(ok.out).toMatch(/docs\/no-tests: 3 documentation file\(s\)/);
    expect(ok.out).toContain('.work/round-3-plan.md: docs/no-tests (empty lane)');
    expect(ok.out).toContain('notes/redproof.md: docs/no-tests (empty lane)');
    expect(ok.out).toContain('docs/evidence.md: docs/no-tests (empty lane)');
    expect(ok.out).not.toContain('has no test lane');

    const mixed = fixture({ pregate: null });
    commit(mixed, {
      '.work/round-3-plan.md': '# plan\n',
      'lib/orphan.js': 'exports.lonely = () => 2;\n',
    });
    const bad = pregate(mixed, ['--only', 'lanes']);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain('(PREGATE_NO_LANE)');
    expect(bad.out).toContain('lanes: FAIL lanes — lib/orphan.js has no test lane');
    expect(bad.out).toContain('docs/no-tests (empty lane): .work/round-3-plan.md');
    expect(bad.out).not.toContain('.work/round-3-plan.md has no test lane');

    const extra = fixture({ pregate: { empty_lanes: ['notes/**/*.txt'], runner: 'node --test {files}' } });
    commit(extra, { 'notes/sketch.txt': 'a note that is not markdown\n' });
    const declared = pregate(extra, ['--only', 'lanes']);
    expect(declared.status).toBe(EXIT.ok);
    expect(declared.err).not.toContain('PREGATE_NO_LANE');
    expect(declared.out).toContain('docs/no-tests (empty lane): notes/sketch.txt');
  });

  test('lanes: unreferenced markdown is docs/no-tests; markdown a test reads selects that test', () => {
    const unread = fixture({ pregate: null });
    commit(unread, {
      'prompts/system.md': '# system\n\nAn unmarked prompt, not a plan or a redproof.\n',
      'notes/scratch.md': '# scratch\n',
    });
    const idle = pregate(unread, ['--only', 'lanes', '--explain']);
    expect(idle.status).toBe(EXIT.ok);
    expect(idle.err).not.toContain('PREGATE_NO_LANE');
    expect(idle.out).toMatch(/docs\/no-tests: 2 documentation file\(s\)/);
    expect(idle.out).toContain('prompts/system.md: docs/no-tests (empty lane)');
    expect(idle.out).toContain('notes/scratch.md: docs/no-tests (empty lane)');
    expect(idle.out).not.toContain('has no test lane');

    const named = fixture({ pregate: null });
    named.git('checkout', '-q', 'main');
    write(named.work, 'prompts/system.md', '# system\n');
    write(named.work, 'test/fixtures/sample.md', '# sample\n');
    write(named.work, 'test/prompt-doc.test.js', "const test = require('node:test');\nconst fs = require('node:fs');\ntest('reads the prompt', () => { fs.readFileSync('prompts/system.md', 'utf8'); });\n");
    write(named.work, 'test/fixture-doc.test.js', "const test = require('node:test');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('reads the fixture', () => { fs.readFileSync(path.join('test', 'fixtures', 'sample.md'), 'utf8'); });\n");
    named.git('add', '-A');
    named.git('commit', '-q', '-m', 'tests read markdown');
    named.git('push', '-q', 'origin', 'main');
    named.git('checkout', '-q', 'feature');
    named.git('reset', '--hard', 'main');
    commit(named, {
      'prompts/system.md': '# system\n\nupdated\n',
      'test/fixtures/sample.md': '# sample\n\nupdated\n',
    });
    const r = pregate(named, ['--only', 'lanes', '--explain']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('test/prompt-doc.test.js ← prompts/system.md');
    expect(r.out).toContain('test/fixture-doc.test.js ← test/fixtures/sample.md');
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.out).not.toContain('docs/no-tests');
  });

  test('lanes: a test that names a markdown file still runs that test', () => {
    const repo = fixture({ pregate: null });
    repo.git('checkout', '-q', 'main');
    write(repo.work, 'test/readme-doc.test.js', "const test = require('node:test');\nconst fs = require('node:fs');\ntest('reads the readme', () => { fs.readFileSync('docs/README.md', 'utf8'); });\n");
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'name the doc');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('reset', '--hard', 'main');
    commit(repo, { 'docs/README.md': '# docs\n\nupdated evidence\n' });
    const r = pregate(repo, ['--only', 'lanes', '--explain']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('test/readme-doc.test.js ← docs/README.md');
    expect(r.err).not.toContain('PREGATE_NO_LANE');
    expect(r.out).not.toContain('docs/no-tests');
  });

  test('lanes: a touched file with no test lane is FAIL lanes — <file> has no test lane; a declaration or an explicit [] clears it', () => {
    const repo = fixture();
    commit(repo, { 'lib/orphan.js': "exports.lonely = () => 2;\n", 'docs/guide.md': '# guide\n' });
    const r = pregate(repo, ['--stage', 'tests']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('lanes: FAIL lanes — lib/orphan.js has no test lane');
    expect(r.out).not.toContain('docs/guide.md has no test lane');
    expect(r.err).toContain('(PREGATE_NO_LANE)');
    // A declaration on the BASE branch maps it; a declaration only on the branch is unreviewed and ignored.
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'lib/orphan.js': ['test/util.test.js'] } }) + '\n' });
    expect(pregate(repo, ['--stage', 'tests']).status).toBe(EXIT.fail);
    const head = pregate(repo, ['--stage', 'tests', '--policy-from', 'head']);
    expect(head.status).toBe(EXIT.ok);
    expect(head.out).toContain('policy head (unreviewed) .gstack/pregate.json');
    expect(head.out).toMatch(/^tests {6}lanes {5}pass /m);
  });

  test('lanes: deleted and renamed files select the tests that named them; subprocess targets and computed reads map through declarations and joined literals', () => {
    const repo = fixture();
    repo.git('mv', 'lib/util.js', 'lib/maths.js');
    commit(repo, { 'lib/config.json': '{"limit": 11}\n', 'bin/tool': "#!/usr/bin/env node\nconsole.log('tool');\n// touched\n" });
    const r = pregate(repo, ['--stage', 'tests', '--explain']);
    expect(r.out).toContain('test/util.test.js ← lib/util.js (import) [renamed to lib/maths.js]');
    expect(r.out).toContain('test/config-read.test.js ← lib/config.json (literal) [touched]');
    expect(r.out).toContain('test/tool-cli.test.js ← bin/tool (literal) [touched]');
    expect(r.out).toMatch(/^tests {6}lanes {5}fail /m); // util.test.js still requires ../lib/util.js, which is gone: the lane ran and caught it
    expect(r.out).toContain('(PREGATE_LANE_FAILED)');
    const del = fixture();
    commit(del, { 'lib/config.json': null });
    const d = pregate(del, ['--stage', 'tests', '--explain']);
    expect(d.out).toContain('test/config-read.test.js ← lib/config.json (literal) [deleted]');
  });

  test('p0-4-windows-lane-unrun: a Windows-only test changed on Linux is a persisted requires-remote obligation named by workflow/job, and unsupported expressions are explained', () => {
    const repo = fixture();
    commit(repo, { 'test/windows-paths.test.js': "const test = require('node:test');\ntest('windows paths', () => { /* touched */ });\n" });
    const r = pregate(repo, ['--stage', 'tests', '--explain']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}requires-remote .*1 requires-remote obligation\(s\)/m);
    expect(r.out).toContain('requires-remote windows.yml/windows-shard (windows): 1 test(s) — test/windows-paths.test.js');
    expect(r.out).toContain('Tiers ran: unit; requires-remote: windows');
    expect(r.out).toContain('lane windows.yml/windows-shard: 1 files from manifest `node scripts/windows-list.js`');
    expect(r.out).toContain('PREGATE: requires-remote (1 uncleared)');
    const out = readOut(repo);
    expect(out.requires_remote).toEqual([{ lane: 'windows.yml/windows-shard', platform: 'windows', workflow: 'windows.yml', job: 'windows-shard', tests: ['test/windows-paths.test.js'], receipt: null }]);
    // Without a manifest the planner-computed matrix is an unsupported expression: every selected test is conservatively in the lane.
    const bare = fixture({ pregate: { ...BASE_PREGATE, selection: {} } });
    commit(bare, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const b = pregate(bare, ['--stage', 'tests', '--explain']);
    expect(b.out).toContain('unsupported workflow expression "${{ fromJSON(needs.windows-plan.outputs.matrix) }}" and no selection manifest; treated as unknown');
    expect(b.out).toContain('requires-remote windows.yml/windows-shard (windows): 1 test(s) — test/util.test.js');
  });

  test('p0-4-pipe-hidden-failure: a runner whose failure hides behind | tail is red under pipefail; a zero-run lane is red with exit 0', () => {
    const piped = fixture({ pregate: { ...BASE_PREGATE, runner: 'node --test {files} 2>&1 | tail -n 1' } });
    commit(piped, { 'lib/util.js': "exports.add = (a, b) => a - b;\n" });
    const r = pregate(piped, ['--stage', 'tests']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^tests {6}lanes {5}fail .*local lane exited 1 .*pipefail\) \(PREGATE_LANE_FAILED\)/m);
    expect(r.out).toMatch(/lanes: log: .*lanes\.log/);
    const zero = fixture({ pregate: { ...BASE_PREGATE, runner: 'true {files} && echo "# tests 0"' } });
    commit(zero, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const z = pregate(zero, ['--stage', 'tests']);
    expect(z.status).toBe(EXIT.fail);
    expect(z.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN: the runner reported 0 tests/m);
  });

  test('trust boundary: without --allow-repo-commands the pin-file commands and the runner do not run; regen and lanes are incomplete, never pass', () => {
    const repo = fixture();
    commit(repo, { 'src/version.js': "module.exports = { VERSION: '1.1.0' };\n", 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main']);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toMatch(/^preflight {2}regen {5}incomplete .*repo commands not executed \(pass --allow-repo-commands\).*\(REPO_COMMANDS_NOT_ALLOWED\)/m);
    expect(r.out).toContain('regen: COMMAND: digest="node gen.js"');
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*1 local test file\(s\) selected but not run/m);
    expect(r.out).toContain('GSTACK_RESULT: skill=pregate status=incomplete');
    expect(fs.readFileSync(path.join(repo.work, 'generated/digest.md'), 'utf8')).toBe('# digest v1.0.0\n');
    expect(runBin(repo, 'gstack-pregate', ['--base', 'main', '--policy-from', 'head']).status).toBe(EXIT.refused);
    const gone = runBin(repo, 'gstack-pregate', ['--base', 'nope']);
    expect(gone.status).toBe(EXIT.refused);
    expect(gone.err).toContain('(POLICY_SOURCE_UNAVAILABLE)');
  });

  test('a working-tree change during a check makes it incomplete (the fingerprint moved), and --json carries the file', () => {
    const repo = fixture({ pregate: { ...BASE_PREGATE, runner: 'echo touched >> lib/util.js && node --test {files}' } });
    commit(repo, { 'lib/util.js': "exports.add = (a, b) => a + b + 0;\n" });
    const r = pregate(repo, ['--stage', 'tests', '--json']);
    expect(r.status).toBe(EXIT.fail);
    const parsed = JSON.parse(r.out);
    const lanes = parsed.checks.find((c: any) => c.id === 'lanes');
    expect(lanes.status).toBe('incomplete');
    expect(lanes.detail).toContain('working tree changed during the check');
    expect(lanes.code).toBe('PREGATE_INCOMPLETE');
    expect(parsed.ok).toBe(false);
  });

  test('lanes prints the lane list with platform tiers; validate and init cover the working-tree config', () => {
    const repo = fixture();
    const l = runBin(repo, 'gstack-pregate', ['lanes']);
    expect(l.out).toContain('free-tests.yml/unit: tier=unit platform=linux runs-on=ubuntu-24.04 tests=yes (.github/workflows/free-tests.yml:4)');
    expect(l.out).toContain('windows.yml/windows-shard: tier=platform platform=windows runs-on=windows-latest tests=yes matrix="${{ fromJSON(needs.windows-plan.outputs.matrix) }}"');
    expect(l.out).toMatch(/^LANES: 3 jobs; tests 2; platform 1$/m);
    expect(runBin(repo, 'gstack-pregate', ['validate']).out).toContain('PREGATE_CONFIG_VALID: .gstack/pregate.json');
    write(repo.work, '.gstack/pregate.json', '{"warn": ["secrets"]}\n');
    const v = runBin(repo, 'gstack-pregate', ['validate']);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toContain('secrets cannot be downgraded to warn');
    expect(runBin(repo, 'gstack-pregate', ['init']).status).toBe(EXIT.refused);
    fs.rmSync(path.join(repo.work, '.gstack/pregate.json'));
    expect(runBin(repo, 'gstack-pregate', ['init']).out).toContain('PREGATE_CONFIG_WRITTEN');
    expect(runBin(repo, 'gstack-pregate', ['validate']).status).toBe(EXIT.ok);
  });
});
