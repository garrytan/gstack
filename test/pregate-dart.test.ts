/**
 * C8 `lanes` for a Dart/Flutter repo: `package:` directives resolve through
 * every tracked pubspec.yaml, `_test.dart` files under `test/` are tests,
 * each package's tests run from its own root, and the runner's `+N -M:`
 * verdict is judged. The end-to-end fixture commits its policy on the base
 * and carries no workflows, so every selected test is a local lane on any
 * host platform.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { dartRunner, parseSummary, planRuns } from '../lib/pregate/checks/lanes';
import { laneFileSet } from '../lib/pregate/lane-selection';
import type { Lane } from '../lib/pregate/workflows';
import { ROOT_OK } from '../lib/pregate/checks/strays';
import { DEFAULT_CONFIG } from '../lib/pregate/config';
import { blankDartComments, buildGraph, dartPackages, isTestFile, readRepoFile, testsFor } from '../lib/pregate/import-graph';
import type { PregateContext } from '../lib/pregate/types';
import { parseWorkflow } from '../lib/pregate/workflows';
import { cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const DART_FILES: Record<string, string> = {
  'pubspec.yaml': 'name: app\ndependencies:\n  core:\n    path: packages/core\n',
  'lib/theme.dart': "const double gap = 8;\n",
  'lib/widgets/drawer.dart': "import 'package:app/theme.dart';\nimport 'package:core/core.dart' if (dart.library.io) 'package:core/core_io.dart';\nimport 'dart:math';\npart 'drawer_parts.dart';\n",
  'lib/widgets/drawer_parts.dart': "part of 'drawer.dart';\n",
  'lib/widgets/widgets.dart': "export 'drawer.dart';\n",
  'test/ui/drawer_widget_test.dart': "import 'package:app/widgets/widgets.dart';\nimport 'package:flutter_test/flutter_test.dart';\nvoid main() {}\n",
  'test/helpers/pump.dart': "import '../../lib/theme.dart';\n",
  'packages/core/pubspec.yaml': 'name: core\n',
  'packages/core/lib/core.dart': "int one() => 1;\n",
  'packages/core/lib/core_io.dart': "int one() => 1;\n",
  'packages/core/test/core_test.dart': "import 'package:core/core.dart';\nvoid main() {}\n",
};

/** A base policy with no declared runner, so Dart files are planned per package. */
const DART_PREGATE = { $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#pregate-v1', dependencies: { 'docs/**': [], 'README.md': [] } };

/**
 * The fixture plus DART_FILES on main. `policy` is committed as the base's
 * .gstack/pregate.json; the fixture's workflows are removed so no lane is
 * platform-tier on any host (every selected test runs locally).
 */
function dartRepo(policy: Record<string, unknown> = DART_PREGATE): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: policy });
  repos.push(repo);
  commit(repo, { ...DART_FILES, '.github/workflows/free-tests.yml': null, '.github/workflows/windows.yml': null }, 'dart');
  repo.git('push', '-q', 'origin', 'HEAD:main');
  repo.git('fetch', '-q', 'origin');
  return repo;
}

function sleepCommand(sleepS: number | Record<string, number>): string {
  if (typeof sleepS === 'number') return `sleep ${sleepS}`;
  const { '*': other = 0, ...named } = sleepS;
  return `case "$(basename "$PWD")" in ${Object.entries(named).map(([dir, n]) => `${dir}) sleep ${n};;`).join(' ')} *) sleep ${other};; esac`;
}

/** A `dart` and `flutter` on PATH that report its cwd and passes every file it is given, after `sleepS` seconds (per package directory name when an object). */
function dartShim(repo: FixtureRepo, sleepS: number | Record<string, number> = 0): { PATH: string } {
  const dir = path.join(repo.root, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of ['dart', 'flutter']) fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env bash\nshift\n${sleepCommand(sleepS)}\necho "ran in $(basename "$PWD"): $*"\necho "00:01 +$#: All tests passed!"\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

/** The shim dir, filled with links to every host PATH tool except fvm/dart/flutter: pregate and git still run, no real Dart tool is reachable. */
function pathWithoutDartTools(repo: FixtureRepo): string {
  const bin = path.join(repo.root, 'shim');
  fs.mkdirSync(bin, { recursive: true });
  for (const dir of (process.env.PATH ?? '').split(':')) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) if (!['fvm', 'dart', 'flutter'].includes(name) && !fs.lstatSync(path.join(bin, name), { throwIfNoEntry: false })) fs.symlinkSync(path.join(dir, name), path.join(bin, name));
  }
  return bin;
}

describe('Dart import graph', () => {
  test('_test.dart is a test; package:, relative, conditional, export and part directives all map; dart: and unknown packages do not', () => {
    const repo = dartRepo();
    const g = buildGraph(repo.work);
    expect(isTestFile('test/ui/drawer_widget_test.dart')).toBe(true);
    expect(isTestFile('lib/widgets/drawer.dart')).toBe(false);
    // Value: protects=device-only Flutter tests (integration_test/, test_driver/) are never auto-selected for a local `flutter test`;
    //   fails_when=the exclusion is dropped and touching lib/ launches the app or fails with no device; why_new=no integration test file was classified;
    //   seam=none; no_claim=a device run
    for (const f of ['integration_test/app_test.dart', 'packages/core/integration_test/core_test.dart', 'test_driver/app_test.dart', 'test_driver/integration_test.dart']) expect(isTestFile(f)).toBe(false);
    // Value: protects=dart test only runs files under test/, so a production lib/src/ab_test.dart is never run as a test;
    //   fails_when=the _test.dart arm loses its test/ anchor (false PREGATE_LANE_FAILED on an app file); why_new=only device dirs were excluded;
    //   seam=none; no_claim=none beyond protects
    expect(isTestFile('lib/src/ab_test.dart')).toBe(false);
    expect(isTestFile('packages/core/test/unit/core_test.dart')).toBe(true);
    expect(testsFor(g, 'lib/theme.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'lib/widgets/drawer_parts.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'packages/core/lib/core.dart').tests).toEqual(['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'packages/core/lib/core_io.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
    expect(testsFor(g, 'test/ui/drawer_widget_test.dart').tests).toEqual(['test/ui/drawer_widget_test.dart']);
  });

  // Value: protects=several directives on one line all map, while a directive inside a line comment still does not;
  //   fails_when=the directive regex is anchored to line start again (only the first import of `import 'a'; import 'b';` counts) or
  //   loosened to match after any `;`; why_new=every fixture put one directive per line; seam=none; no_claim=a Dart parser
  test('directives sharing a line all map; a commented-out directive does not', () => {
    const repo = dartRepo();
    commit(repo, {
      'lib/multi.dart': 'int two() => 2;\n',
      'test/multi_test.dart': "import 'package:test/test.dart'; import 'package:app/multi.dart';\nvoid main() {}\n",
      'test/commented_test.dart': "void main() {} // see a; import 'package:app/multi.dart';\n",
      'lib/cond.dart': 'int c() => 1;\n',
      'lib/cond_io.dart': 'int c() => 2;\n',
      'test/cond_test.dart': "import 'package:app/cond.dart'\n    if (dart.library.io) 'package:app/cond_io.dart'\n    show c;\nvoid main() {}\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'lib/multi.dart').tests).toEqual(['test/multi_test.dart']);
    // Value: protects=a directive dart format splits over indented lines (a conditional import) still maps both URIs once the run regex
    //   is bounded for linear time; fails_when=the body stops at the first newline or the continuation rule rejects indented lines;
    //   why_new=every directive fit on one line; seam=none; no_claim=the linear-time bound itself (measured, not asserted)
    expect(testsFor(g, 'lib/cond.dart').tests).toEqual(['test/cond_test.dart']);
    expect(testsFor(g, 'lib/cond_io.dart').tests).toEqual(['test/cond_test.dart']);
    // Value: protects=a `;` inside a comment within a directive does not end it, so the conditional URI after the comment still maps,
    //   while a `//` inside a string is kept; fails_when=comments are not blanked before the directive scan (the comment's `;`
    //   truncates the import and native.dart loses its dependent, failing open); why_new=no fixture put a comment inside a directive;
    //   seam=none; no_claim=nested block comments or triple-quoted strings
    commit(repo, {
      'lib/base.dart': 'int b() => 1;\n',
      'lib/native.dart': 'int b() => 2;\n',
      'lib/web.dart': 'int b() => 3;\n',
      'test/platform_test.dart': "import 'package:app/base.dart' // fallback; platform-specific below\n    if (dart.library.io) 'package:app/native.dart' /* io; */\n    if (dart.library.js_interop) 'package:app/web.dart';\nvoid main() {}\n",
    });
    const h = buildGraph(repo.work);
    for (const f of ['lib/base.dart', 'lib/native.dart', 'lib/web.dart']) expect(testsFor(h, f).tests).toEqual(['test/platform_test.dart']);
    // Value: protects=a comment on its own line inside a multi-line conditional import (whitespace-only once blanked) does not end
    //   the directive, so both URIs map; fails_when=the continuation only accepts an indented non-blank line and the whole directive
    //   drops (base.dart and native.dart lose their dependent, failing open); why_new=the comment fixture kept comments at line ends;
    //   seam=none; no_claim=the linear-time bound itself (measured, not asserted)
    commit(repo, {
      'lib/own_base.dart': 'int b() => 1;\n',
      'lib/own_native.dart': 'int b() => 2;\n',
      'test/own_line_test.dart': "import 'package:app/own_base.dart'\n    // Native implementation.\n\n    if (dart.library.io) 'package:app/own_native.dart';\nvoid main() {}\n",
    });
    const k = buildGraph(repo.work);
    for (const f of ['lib/own_base.dart', 'lib/own_native.dart']) expect(testsFor(k, f).tests).toEqual(['test/own_line_test.dart']);
    expect(blankDartComments("var u = 'http://x'; // c;\n")).toBe("var u = 'http://x';      \n");
  });

  // Value: protects=two tracked pubspecs sharing a `name:` (a fixture copying the app's) keep both roots, so package: imports still
  //   reach the real package; fails_when=the first root in ls-files order wins, so a fixture that mirrors lib/ steals the real package's edges (no lane);
  //   why_new=every fixture package name was unique; seam=none; no_claim=pub's own resolution (the importer's own root first, then the rest; tracked file wins)
  test('a package name two pubspecs share resolves to whichever root holds the file', () => {
    const repo = dartRepo();
    commit(repo, {
      'a_fixture/pubspec.yaml': 'name: app\n',
      'lib/x.dart': 'int x() => 1;\n',
      'test/x_test.dart': "import 'package:app/x.dart';\nvoid main() {}\n",
    });
    expect(dartPackages(repo.work, ['a_fixture/pubspec.yaml', 'pubspec.yaml']).get('app')).toEqual(['a_fixture', '']);
    expect(testsFor(buildGraph(repo.work), 'lib/x.dart').tests).toEqual(['test/x_test.dart']);
    // The fixture mirrors the file: the importer's own package (the deepest root containing it) wins over ls-files order.
    commit(repo, { 'a_fixture/lib/x.dart': 'int x() => 2;\n', 'a_fixture/test/x_test.dart': "import 'package:app/x.dart';\nvoid main() {}\n" });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'lib/x.dart').tests).toEqual(['test/x_test.dart']);
    expect(testsFor(g, 'a_fixture/lib/x.dart').tests).toEqual(['a_fixture/test/x_test.dart']);
  });

  // Value: protects=an importer inside a third package (apps/app) imports a name the repo root and packages/shared both declare, and
  //   both copies select it; fails_when=the importer's own package is taken as the deepest same-name root containing it (the root ''
  //   contains everything), so the root copy steals the import and packages/shared/lib/a.dart has no lane (fail open);
  //   why_new=no fixture nested an importer under a same-name ancestor it does not belong to; seam=none; no_claim=pub's own resolution
  test('an ancestor same-name package does not steal an import from a package that is not its own', () => {
    const repo = dartRepo();
    commit(repo, {
      'pubspec.yaml': 'name: shared\n',
      'lib/a.dart': 'int a() => 1;\n',
      'packages/shared/pubspec.yaml': 'name: shared\n',
      'packages/shared/lib/a.dart': 'int a() => 2;\n',
      'apps/app/pubspec.yaml': 'name: app\n',
      'apps/app/test/x_test.dart': "import 'package:shared/a.dart';\nvoid main() {}\n",
      'test/root_test.dart': "import 'package:shared/a.dart';\nvoid main() {}\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'packages/shared/lib/a.dart').tests).toEqual(['apps/app/test/x_test.dart']);
    // The root package's own test still resolves to its own copy only.
    expect(testsFor(g, 'lib/a.dart').tests).toEqual(['apps/app/test/x_test.dart', 'test/root_test.dart']);
  });

  // Value: protects=a package name two other pubspecs share, imported from outside both, selects the importer for either copy, and a
  //   leading BOM does not hide the file's directives; fails_when=the first root in ls-files order wins (the other copy loses its
  //   dependent) or the BOM stops the line-start match (no edges, fail open); why_new=duplicate names resolved to one root and every
  //   fixture file started at a directive; seam=none; no_claim=pub's own dependency resolution
  test('an ambiguous package: import selects every same-name copy, and a BOM does not hide directives', () => {
    const repo = dartRepo();
    commit(repo, {
      'a_fixture/pubspec.yaml': 'name: shared\n',
      'a_fixture/lib/y.dart': 'int y() => 1;\n',
      'b_fixture/pubspec.yaml': 'name: shared\n',
      'b_fixture/lib/y.dart': 'int y() => 2;\n',
      'test/y_test.dart': "\uFEFFimport 'package:shared/y.dart';\nvoid main() {}\n",
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'a_fixture/lib/y.dart').tests).toEqual(['test/y_test.dart']);
    expect(testsFor(g, 'b_fixture/lib/y.dart').tests).toEqual(['test/y_test.dart']);
  });

  // Value: protects=a pubspec.yaml that is a symlink out of the repo, or not a regular file, is skipped without throwing (a link to a
  //   device or FIFO could hang the read); fails_when=the guard is dropped and the outside file names a package or the read throws;
  //   why_new=every fixture pubspec was a regular in-repo file; seam=none; no_claim=a real /dev/zero or FIFO (a directory and an
  //   outside file stand in)
  test('a pubspec.yaml symlinked outside the repo, or a directory of that name, is skipped', () => {
    const repo = dartRepo();
    fs.mkdirSync(path.join(repo.root, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, 'outside', 'pubspec.yaml'), 'name: outside\ndependencies:\n  flutter:\n    sdk: flutter\n');
    fs.mkdirSync(path.join(repo.work, 'packages', 'ext'), { recursive: true });
    fs.symlinkSync(path.join(repo.root, 'outside', 'pubspec.yaml'), path.join(repo.work, 'packages', 'ext', 'pubspec.yaml'));
    fs.mkdirSync(path.join(repo.work, 'packages', 'dir', 'pubspec.yaml'), { recursive: true });
    const files = ['pubspec.yaml', 'packages/core/pubspec.yaml', 'packages/ext/pubspec.yaml', 'packages/dir/pubspec.yaml'];
    expect([...dartPackages(repo.work, files)]).toEqual([['app', ['']], ['core', ['packages/core']]]);
    const env = dartShim(repo);
    expect(dartRunner(repo.work, 'packages/ext', env)).toEqual({ runner: 'dart test {files}' });
    expect(dartRunner(repo.work, 'packages/dir', env)).toEqual({ runner: 'dart test {files}' });
    // Value: protects=a quoted pubspec `name:` (legal YAML) still registers the package, so its package: imports map to tests;
    //   fails_when=the name regex stops accepting a leading quote and those imports silently resolve nowhere (no lane);
    //   why_new=every fixture pubspec name was bare; seam=none; no_claim=a YAML parser
    write(repo.work, 'packages/q/pubspec.yaml', "name: 'quoted_pkg'\n");
    expect(dartPackages(repo.work, ['packages/q/pubspec.yaml']).get('quoted_pkg')).toEqual(['packages/q']);
    // Value: protects=a pubspec saved with a leading BOM (Windows editors) still registers its package; fails_when=the BOM is not
    //   stripped and `^name:` misses the first line, so the package's imports resolve nowhere (no lane, fail open); why_new=the BOM
    //   fixture covered a Dart source, not a pubspec; seam=none; no_claim=other encodings (UTF-16)
    write(repo.work, 'packages/b/pubspec.yaml', "\uFEFFname: bom_pkg\n");
    expect(dartPackages(repo.work, ['packages/b/pubspec.yaml']).get('bom_pkg')).toEqual(['packages/b']);
    // Value: protects=readRepoFile refuses a file over its byte cap (a huge committed pubspec is not read into memory);
    //   fails_when=the size guard is dropped; why_new=only symlink and directory refusals were tested; seam=none (maxBytes is the
    //   production parameter); no_claim=a real multi-MiB file (a small cap stands in)
    expect(readRepoFile(repo.work, 'pubspec.yaml', 8)).toBeNull();
    expect(readRepoFile(repo.work, 'pubspec.yaml')).toContain('name: app');
  });
});

describe('Dart runner and summary (pure)', () => {
  test('flutter/dart verdict lines: the last one counts, skips are not runs, No tests ran is zero', () => {
    expect(parseSummary('00:01 +3: loading\n00:04 +12 ~1: All tests passed!')).toEqual({ ran: 12, failed: 0 });
    expect(parseSummary('00:02 +5 -1: a test [E]\n00:03 +7 ~2 -2: Some tests failed.')).toEqual({ ran: 9, failed: 2 });
    expect(parseSummary('No tests ran.')).toEqual({ ran: 0, failed: 0 });
    // Value: protects=package:test's all-skipped verdict (exit 0) reads as 0 ran, so the lane is ZERO-RUN; fails_when=the verdict
    //   alternation drops `All tests skipped.` and the lane passes on an unknown count; why_new=only passed/failed verdicts were parsed;
    //   seam=none; no_claim=none beyond protects
    expect(parseSummary('00:00 +0: loading\n00:01 +0 ~3: All tests skipped.')).toEqual({ ran: 0, failed: 0 });
    expect(parseSummary('00:01 +2 -1: Some tests failed.', 'fvm flutter test {files}')).toEqual({ ran: 3, failed: 1 });
    // Value: protects=a bun run whose output echoes a Dart verdict (an assertion message) is judged by bun's own summary, so 0 ran
    //   stays ZERO-RUN; fails_when=the Dart verdict is read first for every runner again; why_new=only Dart output was parsed;
    //   seam=none; no_claim=other runners echoing other runners' formats
    expect(parseSummary('received: "00:01 +2: All tests passed!"\n\n 0 pass\n 0 fail\nRan 0 tests across 1 file.', 'bun test {files}')).toEqual({ ran: 0, failed: 0 });
    // Value: protects=a coloured or carriage-return-redrawn verdict still parses, so an all-skipped coloured run stays ZERO-RUN;
    //   fails_when=colour codes reach the verdict regex, ran is null and exit 0 passes; why_new=only plain output was parsed;
    //   seam=none; no_claim=other control sequences than CSI
    expect(parseSummary('\x1b[32m+0\x1b[0m \x1b[33m~3\x1b[0m: All tests skipped.', 'flutter test {files}')).toEqual({ ran: 0, failed: 0 });
    expect(parseSummary('00:01 +1: a\r00:02 +4 -1: Some tests failed.', 'dart test {files}')).toEqual({ ran: 5, failed: 1 });
  });

  test('without a declared runner, Dart tests group by package root; a declared runner takes every file', () => {
    const repo = dartRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: dartShim(repo) } as unknown as PregateContext;
    expect(planRuns(ctx, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual({ groups: [
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'dart test {files}', cwd: 'packages/core', files: ['test/core_test.dart'] },
    ], unclaimed: [], missing: [], noPubspec: [] });
    // Value: protects=non-Dart files beside Dart ones go to the detected runner, and a file no runner claims is unclaimed (incomplete) beside the runnable groups;
    //   fails_when=the rest group is dropped or an unclaimed file is silently skipped; why_new=only all-Dart lists were planned;
    //   seam=none; no_claim=the runners themselves (plan only)
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'test/util.test.js']).groups).toEqual([
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'node --test {files}', cwd: '', files: ['test/util.test.js'] },
    ]);
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'spec/drawer_spec.rb'])).toEqual({ groups: [{ runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] }], unclaimed: ['spec/drawer_spec.rb'], missing: [], noPubspec: [] });
    // Value: protects=a machine without the Dart SDK gets an incomplete lane naming the missing tool, never a test failure (exit 127);
    //   fails_when=the PATH check is dropped and the runner is planned anyway; why_new=every earlier plan had the SDK on PATH;
    //   seam=none; no_claim=a real SDK install (an empty PATH stands in for a machine without one)
    const noSdk = { ...ctx, env: { PATH: path.join(repo.root, 'empty-path') } } as PregateContext;
    expect(planRuns(noSdk, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual({ groups: [], unclaimed: ['test/ui/drawer_widget_test.dart', 'packages/core/test/core_test.dart'], missing: ['dart'], noPubspec: [] });
    write(repo.work, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart']).groups).toMatchObject([{ runner: 'flutter test {files}' }]);
    // Value: protects=a .dart test with no pubspec.yaml above it is unclaimed (incomplete), never handed to the repo's JS runner;
    //   fails_when=it falls through to detectRunner and a bun repo runs `bun test x_test.dart` (a false PREGATE_LANE_FAILED);
    //   why_new=every Dart fixture had a root pubspec; seam=none; no_claim=the runner itself (plan only)
    fs.rmSync(path.join(repo.work, 'pubspec.yaml'));
    write(repo.work, 'bun.lock', '{}\n');
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'test/util.test.js'])).toEqual({ groups: [{ runner: 'bun test {files}', cwd: '', files: ['test/util.test.js'] }], unclaimed: ['test/ui/drawer_widget_test.dart'], missing: [], noPubspec: ['test/ui/drawer_widget_test.dart'] });
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: 'bash scripts/test.sh {files}' } } as PregateContext;
    expect(planRuns(declared, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart']).groups).toEqual([
      { runner: 'bash scripts/test.sh {files}', cwd: '', files: ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'] },
    ]);
  });

  // Value: protects=a package-local fvm pin routes that package's tests through fvm, and flow-style `flutter: {sdk: flutter}` picks
  //   flutter test; fails_when=only the repo root's .fvmrc is read, or the SDK regex only matches block style; why_new=pins and
  //   pubspecs were root-level and block style; seam=none; no_claim=a real fvm or SDK (PATH shims)
  test('fvm pins are found from the package up to the repo root; flow-style flutter SDK is detected', () => {
    const repo = dartRepo();
    const env = dartShim(repo);
    fs.writeFileSync(path.join(repo.root, 'shim', 'fvm'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    write(repo.work, 'packages/core/.fvmrc', '{"flutter":"3.24.0"}\n');
    expect(dartRunner(repo.work, 'packages/core', env)).toEqual({ runner: 'fvm dart test {files}' });
    expect(dartRunner(repo.work, '', env)).toEqual({ runner: 'dart test {files}' });
    write(repo.work, '.fvmrc', '{"flutter":"3.24.0"}\n');
    expect(dartRunner(repo.work, 'packages/nested/pkg', env)).toEqual({ runner: 'fvm dart test {files}' });
    fs.rmSync(path.join(repo.work, '.fvmrc'));
    fs.rmSync(path.join(repo.work, 'packages/core/.fvmrc'));
    for (const [pubspec, tool] of [
      ['name: core\ndependencies:\n  flutter: {sdk: flutter}\n', 'flutter'],
      ['name: core\ndependencies:\n  flutter: { sdk: flutter }\n', 'flutter'],
      ['name: core\ndependencies:\n  flutter:\n    sdk: flutter\n', 'flutter'],
      ['name: core\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n', 'dart'],
      ['name: core\n# flutter: {sdk: flutter}\ndescription: "x, sdk: flutter"\n', 'dart'],
      ['name: core\ndescription: "use flutter: {sdk: flutter} style"\n', 'dart'],
    ] as const) {
      write(repo.work, 'packages/core/pubspec.yaml', pubspec);
      expect(dartRunner(repo.work, 'packages/core', env)).toEqual({ runner: `${tool} test {files}` });
    }
    // Value: protects=`sdk: flutter` under a dependency not named flutter (flutter_test), flow style, nested or indented, picks
    //   flutter test; fails_when=the flow arm requires the key `flutter:` again and a Flutter package runs under `dart test` (it cannot
    //   load dart:ui, a false lane failure); why_new=every flow-style fixture keyed on `flutter:`; seam=none; no_claim=a YAML parser
    for (const [pubspec, tool] of [
      ['name: core\ndev_dependencies: {flutter_test: {sdk: flutter}}\n', 'flutter'],
      ['name: core\ndev_dependencies:\n  flutter_test: {sdk: flutter}\n', 'flutter'],
      ['name: core\ndev_dependencies:\n  flutter_test: {path: x, sdk: "flutter"}\n', 'flutter'],
      ['name: core\nenvironment: {sdk: ">=3.0.0 <4.0.0"}\n', 'dart'],
      // Value: protects=a quoted `sdk` key (legal YAML, JSON-ish flow) still picks flutter test, flow or block; fails_when=the key
      //   must be bare and a Flutter package runs under `dart test` (a false lane failure); why_new=every fixture key was bare;
      //   seam=none; no_claim=a YAML parser
      ['name: core\ndev_dependencies:\n  flutter_test: {"sdk": flutter}\n', 'flutter'],
      ["name: core\ndev_dependencies:\n  flutter_test: {path: x, 'sdk': flutter}\n", 'flutter'],
      ['name: core\ndependencies:\n  flutter:\n    "sdk": flutter\n', 'flutter'],
      ["name: core\ndependencies:\n  flutter:\n    'sdk': flutter\n", 'flutter'],
      ['name: core\nenvironment:\n  "sdk": ">=3.0.0 <4.0.0"\n', 'dart'],
    ] as const) {
      write(repo.work, 'packages/core/pubspec.yaml', pubspec);
      expect(dartRunner(repo.work, 'packages/core', env)).toEqual({ runner: `${tool} test {files}` });
    }
    // Value: protects=the PATH check looks for the tool the pubspec needs, so a Flutter package on a dart-only machine is missing
    //   `flutter` (incomplete), not planned to exit 127; fails_when=the check is hardcoded to dart or to "any SDK"; why_new=the
    //   no-SDK case had neither tool; seam=none; no_claim=a real SDK (a dart-only PATH shim)
    const dartOnly = path.join(repo.root, 'dart-only');
    fs.mkdirSync(dartOnly, { recursive: true });
    fs.symlinkSync(path.join(repo.root, 'shim', 'dart'), path.join(dartOnly, 'dart'));
    write(repo.work, 'packages/core/pubspec.yaml', 'name: core\ndependencies:\n  flutter:\n    sdk: flutter\n');
    expect(dartRunner(repo.work, 'packages/core', { PATH: dartOnly })).toEqual({ missing: 'flutter' });
    write(repo.work, 'packages/core/pubspec.yaml', 'name: core\n');
    expect(dartRunner(repo.work, 'packages/core', { PATH: dartOnly })).toEqual({ runner: 'dart test {files}' });
  });

  // Value: protects=test paths in a run step resolve against the step's working-directory, else the job's, else the workflow's
  //   defaults, so a platform lane's obligation matches the repo-relative selection; fails_when=the prefix is dropped and the lane file
  //   set never intersects the selection (the obligation silently disappears); why_new=every fixture ran from the repo root;
  //   seam=none; no_claim=a real workflow run
  test('run-step test paths resolve against the step, job or workflow working-directory', () => {
    const wf = [
      'defaults:', '  run:', '    working-directory: ./apps/', 'jobs:',
      '  step:', '    runs-on: ubuntu-24.04', '    steps:',
      '      - run: |', '          dart test test/core_test.dart', '        working-directory: packages/core/',
      '      - name: root', '        working-directory: .', '        run: dart test test/ui/drawer_widget_test.dart',
      '  job:', '    runs-on: windows-latest', '    defaults:', '      run:', '        working-directory: packages/core',
      '    steps:', '      - run: dart test test/core_test.dart',
      '  top:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/app_test.dart',
      '  cmt:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/core_test.dart', '        working-directory: packages/core # the package',
      '  abs:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/a_test.dart', '        working-directory: /home/runner/work/pkg',
      '  up:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/a_test.dart', '        working-directory: ../sibling',
      '  expr:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/a_test.dart', '        working-directory: ${{ matrix.pkg }}',
      '  quoted:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/core_test.dart', '        working-directory: "packages/core"',
      '  win:', '    runs-on: windows-latest', '    steps:', '      - run: dart test test/core_test.dart', '        working-directory: ${{ matrix.pkg }}',
      '      - run: dart test test/ui/drawer_widget_test.dart',
      '  cd:', '    runs-on: windows-latest', '    steps:', '      - working-directory: packages/app', '        run: |', '          cd ../..', '          bun test test/root.test.ts',
      '  sib:', '    runs-on: windows-latest', '    steps:', '      - working-directory: packages/a', '        run: cd ../b; dart test test/core_test.dart',
      '  sub:', '    runs-on: windows-latest', '    steps:', '      - working-directory: .', '        run: dart test test/first_test.dart && cd packages/app && flutter test test/x_test.dart',
      '  var:', '    runs-on: windows-latest', '    steps:', '      - run: cd "$DIR" && dart test test/a_test.dart',
      '  push:', '    runs-on: windows-latest', '    steps:', '      - working-directory: .', '        run: |', '          pushd packages/app > /dev/null', '          cd lib  # into lib', '          cd ..', '          flutter test test/x_test.dart',
      '  shell:', '    runs-on: windows-latest', '    steps:', '      - working-directory: .', '        run: (cd packages/app && flutter test test/x_test.dart) && dart test test/root_test.dart', '',
    ].join('\n');
    const [step, job, top, cmt, abs, up, expr, quoted, win, cd, sib, sub, varCd, push, shell] = parseWorkflow('w.yml', wf, 'darwin');
    // Value: protects=a step naming tests from a working-directory that escapes the repo (`..`), is absolute or is a `${{ }}` expression
    //   leaves the lane's file set unknown, which laneFileSet treats as may-run-any-test, so a Windows lane still owes the selected
    //   packages/core/test/core_test.dart; fails_when=the bare path is recorded as repo-relative again and selectLanes drops the
    //   obligation (fail open); why_new=unresolved directories were recorded as repo-root paths; seam=none; no_claim=expression evaluation
    for (const lane of [up, expr, abs, win]) expect(lane!.testFiles).toEqual([]);
    const sel = { explain: [], config: { ...DEFAULT_CONFIG, selection: {} } } as unknown as PregateContext;
    expect(laneFileSet(sel, win!)).toBe('all');
    expect(quoted!.testFiles).toEqual(['packages/core/test/core_test.dart']);
    // A trailing YAML comment is not part of the directory.
    expect(cmt!.testFiles).toEqual(['packages/core/test/core_test.dart']);
    // Value: protects=a literal `cd`/`pushd` inside a run command moves the directory later test paths resolve against (from the
    //   working-directory or the repo root), a path named before the cd keeps the starting directory, and a non-literal cd target
    //   leaves the lane's set unknown (may run any test); fails_when=the prefix is trusted across a `cd` (packages/app/test/root.test.ts
    //   is claimed and the Windows obligation for test/root.test.ts drops), the cd is ignored, or `cd "$DIR"` is resolved as a
    //   literal; why_new=the cd case claimed both the prefixed and the bare path; seam=none; no_claim=shell semantics beyond
    //   segment-ordered cd/pushd (subshells, functions, popd targets)
    expect(cd!.testFiles).toEqual(['test/root.test.ts']);
    expect(sib!.testFiles).toEqual(['packages/b/test/core_test.dart']);
    expect(sub!.testFiles).toEqual(['test/first_test.dart', 'packages/app/test/x_test.dart']);
    expect(varCd!.testFiles).toEqual([]);
    // Value: protects=a redirect or comment after a cd target is not part of it, and a `( … )` subshell's cd ends at its `)`, so
    //   these common CI forms still resolve instead of leaving the lane may-run-any-test, and a path after the subshell is not
    //   resolved inside it; fails_when=the whole rest of the segment is taken as the target (unknown dir) or the subshell's directory
    //   leaks past `)` (test/root_test.dart claimed as packages/app/test/root_test.dart, its obligation dropped); why_new=only bare
    //   targets and top-level cds were covered; seam=none; no_claim=nested shells, functions
    expect(push!.testFiles).toEqual(['packages/app/test/x_test.dart']);
    expect(shell!.testFiles).toEqual(['packages/app/test/x_test.dart', 'test/root_test.dart']);
    // Value: protects=a root package.json script run from a sub-directory is not resolved against it (npm runs the nearest
    //   package.json's script), so its paths leave the lane unknown, while one run from the root still names its files;
    //   fails_when=the root script's paths are prefixed with the sub-directory and the real file misses the lane; why_new=scripts were
    //   walked from the current directory; seam=none; no_claim=reading sub-directory package.json files
    const scripted = ['jobs:', '  root:', '    runs-on: windows-latest', '    steps:', '      - run: npm run t',
      '  sub:', '    runs-on: windows-latest', '    steps:', '      - working-directory: packages/app', '        run: npm run t', ''].join('\n');
    const [rootRun, subRun] = parseWorkflow('s.yml', scripted, 'darwin', { t: 'bun test test/s.test.ts' });
    expect(rootRun!.testFiles).toEqual(['test/s.test.ts']);
    expect(subRun!.testFiles).toEqual([]);
    expect(step!.testFiles).toEqual(['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart']);
    expect(step!.commands).toEqual(['dart test test/core_test.dart', 'dart test test/ui/drawer_widget_test.dart']);
    expect(job).toMatchObject({ tier: 'platform', testFiles: ['packages/core/test/core_test.dart'] });
    expect(top!.testFiles).toEqual(['apps/test/app_test.dart']);
  });

  test('a workflow run step names its _test.dart files; Dart root manifests are not strays', () => {
    const lanes = parseWorkflow('t.yml', 'jobs:\n  dart:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: fvm flutter test test/ui/drawer_widget_test.dart packages/core/test/core_test.dart\n');
    expect(lanes[0]!.testFiles).toEqual(['test/ui/drawer_widget_test.dart', 'packages/core/test/core_test.dart']);
    // Value: protects=a CI job that runs only flutter/dart test is a test lane (requires-remote off its platform, clearable by local);
    //   fails_when=flutter test / dart test drop out of TEST_COMMAND and the job silently stops being a lane; why_new=fixtures used bun lanes only;
    //   seam=none; no_claim=a real workflow run
    expect(lanes[0]!.runsTests).toBe(true);
    const win = parseWorkflow('w.yml', 'jobs:\n  dart:\n    runs-on: windows-latest\n    steps:\n      - run: dart test\n', 'darwin');
    expect(win[0]).toMatchObject({ tier: 'platform', runsTests: true });
    for (const cmd of ['melos run test', 'melos test', 'very_good test --recursive', 'dart run test']) expect(parseWorkflow('m.yml', `jobs:\n  dart:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${cmd}\n`)[0]!.runsTests).toBe(true);
    for (const f of ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', 'dart_test.yaml']) expect(ROOT_OK.test(f)).toBe(true);
    expect(ROOT_OK.test('scratch.dart')).toBe(false);
    // Value: protects=a selection manifest's *_test.dart lines join the lane's file set; fails_when=the manifest regex drops _test.dart;
    //   why_new=manifests were only tested with .test.js lists; seam=none; no_claim=a real planner (printf stands in)
    const ctx = { repoRoot: process.cwd(), allowRepoCommands: true, timeoutMs: 30_000, env: process.env, explain: [],
      config: { ...DEFAULT_CONFIG, selection: { 't.yml/dart': "printf 'packages/core/test/core_test.dart\\n  shard: test/ui/drawer_widget_test.dart\\nlib/theme.dart\\nintegration_test/app_test.dart\\n'" } } } as unknown as PregateContext;
    expect(laneFileSet(ctx, { id: 't.yml/dart', testFiles: [] } as unknown as Lane)).toEqual(['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart']);
  });
});

describe('gstack-pregate on a Dart repo with a committed policy', () => {
  const run = (repo: FixtureRepo, env: Record<string, string>, extra: string[] = []) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', ...extra], env);

  // Value: protects=a change in a sub-package selects tests in two packages, and each package's tests run from its own root with
  //   package-relative paths (a sub-package's imports resolve against its own pubspec); fails_when=Dart files run from the repo root
  //   or the per-package groups merge; why_new=no end-to-end Dart run; seam=none; no_claim=a real dart runner (PATH shim reports cwd and argv)
  test('each package\'s tests run from that package root', () => {
    const repo = dartRepo();
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const r = run(repo, dartShim(repo));
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*2 tests ran in 2 file\(s\), exit 0/m);
    expect(r.out).toContain("lanes: ran: dart test 'test/ui/drawer_widget_test.dart' && (cd 'packages/core' && dart test 'test/core_test.dart')");
    const log = fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8');
    expect(log).toContain('ran in core: test/core_test.dart');
    expect(log).toMatch(/ran in \S+: test\/ui\/drawer_widget_test\.dart/);
  }, 30_000);

  // Value: protects=serial_patterns match repo-relative paths, so a serial file inside a Dart sub-package runs alone from that package root;
  //   fails_when=the pattern is matched against the cwd-relative path and the file joins the unit run; why_new=pregate-guards covers root JS serial files only;
  //   seam=none; no_claim=a real dart runner (PATH shim reports cwd and argv)
  test('a serial file inside a Dart sub-package runs in its own process from that package root', () => {
    const repo = dartRepo({ ...DART_PREGATE, serial_patterns: ['packages/core/test/slow_test.dart'] });
    commit(repo, {
      'packages/core/test/slow_test.dart': "import 'package:core/core.dart';\nvoid main() {}\n",
      'packages/core/lib/core.dart': 'int one() => 2;\n',
    });
    const r = run(repo, dartShim(repo));
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*3 tests ran in 3 file\(s\) \(1 serial\), exit 0/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8');
    expect(log).toContain('ran in core: test/core_test.dart\n');
    expect(log).toContain('ran in core: test/slow_test.dart\n');
  }, 30_000);

  // Value: protects=--timeout bounds each runner process under supervise(): a package run past it is killed and the lane is incomplete,
  //   while the next package still runs; fails_when=the Dart groups bypass supervise() or a timed-out group ends the lane early or passes;
  //   why_new=main's supervise tests run one group from the repo root; seam=none; no_claim=exact timing (root sleeps 20 s against a 2 s timeout)
  test('a package run past --timeout is incomplete, and the next package still runs', () => {
    const repo = dartRepo();
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const r = run(repo, dartShim(repo, { core: 0, '*': 20 }), ['--timeout', '2']);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*a runner process timed out after 2000 ms/m);
    expect(fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8')).toContain('ran in core: test/core_test.dart');
  }, 60_000);

  // Value: protects=one package whose tests all skip (+0) makes the lane ZERO-RUN even when another package ran tests, and a file name
  //   with `$&` reaches the runner verbatim; fails_when=counts are summed before the zero check, or {files} is substituted with a string
  //   replacement; why_new=only single-group zero runs were tested; seam=none; no_claim=a real dart runner (PATH shim)
  test('a package that ran 0 tests is ZERO-RUN even when another package ran tests', () => {
    const repo = dartRepo();
    const { PATH } = dartShim(repo);
    const shim = path.join(repo.root, 'shim');
    for (const tool of ['dart', 'flutter']) fs.writeFileSync(path.join(shim, tool), `#!/usr/bin/env bash\nshift\necho "ran in $(basename "$PWD"): $*"\nif [ "$(basename "$PWD")" = core ]; then echo "00:01 +0 ~1: All tests skipped."; else echo "00:01 +$#: All tests passed!"; fi\n`, { mode: 0o755 });
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n', 'test/odd$&_test.dart': "import 'package:app/theme.dart';\nvoid main() {}\n" });
    const r = run(repo, { PATH });
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN: the runner reported 0 tests in \(cd 'packages\/core'/m);
    expect(fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8')).toContain('test/odd$&_test.dart');
  }, 30_000);

  // Value: protects=a repo pinning its SDK (.fvmrc) runs Dart tests through fvm when fvm is on PATH, and without it when fvm is absent;
  //   fails_when=the fvm prefix or the .fvmrc check is dropped, or fvm is required when absent; why_new=no test had a pin file;
  //   seam=none; no_claim=a real fvm or Dart SDK (PATH holds only shims and the tools pregate spawns)
  test('an .fvmrc pin routes the Dart runner through fvm only when fvm is on PATH', () => {
    const repo = dartRepo();
    dartShim(repo);
    const bin = pathWithoutDartTools(repo);
    commit(repo, { '.fvmrc': '{"flutter":"3.24.0"}\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const env = { PATH: bin };

    const bare = run(repo, env);
    expect(bare.out).toMatch(/^tests {6}lanes {5}pass /m);
    expect(bare.out).toMatch(/lanes: ran: dart test /);

    fs.writeFileSync(path.join(bin, 'fvm'), '#!/bin/sh\necho "via fvm"\nexec "$@"\n', { mode: 0o755 });
    const pinned = run(repo, env);
    expect(pinned.out).toMatch(/^tests {6}lanes {5}pass /m);
    expect(pinned.out).toMatch(/lanes: ran: fvm dart test /);
    expect(fs.readFileSync(/log: (\S+)/.exec(pinned.out)![1]!, 'utf8')).toContain('via fvm');

    // Value: protects=no SDK and no fvm on PATH is incomplete with an install hint (not exit 127 judged as a test failure), and the
    //   hint offers fvm only because this repo pins it; fails_when=the missing branch or its fix text regresses; why_new=only planRuns'
    //   return value was tested; seam=none; no_claim=a real SDK install
    for (const tool of ['fvm', 'dart', 'flutter']) fs.rmSync(path.join(bin, tool));
    const missing = run(repo, env);
    expect(missing.status).not.toBe(EXIT.ok);
    expect(missing.out).toMatch(/^tests {6}lanes {5}incomplete .*not on PATH: dart.*\(PREGATE_ENVIRONMENT\)/m);
    expect(missing.out).toContain('fix: install dart (or fvm, which this repo pins) on this machine and rerun, or run the lane remotely; the diff is not at fault');
    expect(missing.out).toContain('environment: missing-binary — not on PATH: dart');
  }, 30_000);

  // Value: protects=without an fvm pin the missing-SDK fix names only the SDK, never fvm; fails_when=fvmPinnedFor always reports a pin
  //   (or the hint is unconditional) and an unpinned repo is told to install fvm; why_new=the missing-SDK run had a pin; seam=none;
  //   no_claim=a real SDK install (PATH holds only host tools minus fvm/dart/flutter)
  test('with no fvm pin, a missing Dart SDK is incomplete and the fix does not offer fvm', () => {
    const repo = dartRepo();
    const bin = pathWithoutDartTools(repo);
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const r = run(repo, { PATH: bin });
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*not on PATH: dart.*\(PREGATE_ENVIRONMENT\)/m);
    expect(r.out).toContain('fix: install dart on this machine and rerun, or run the lane remotely; the diff is not at fault');
    expect(r.out).not.toContain('(or fvm');
  }, 30_000);

  // Value: protects=a touched device test (integration_test/) is never run locally, fails with a fix naming .gstack/pregate.json and the
  //   `[]` remedy, and that documented declaration clears it once it is on the base (a branch-only [] under --policy-from head is refused,
  //   GST-419); fails_when=the docs' remedy stops working, the fix loses the device hint, or a head [] runs; why_new=device tests were only
  //   checked at isTestFile; seam=none; no_claim=CI running the device test
  test('a touched integration test (root or nested package) has no local lane until declared []', () => {
    const repo = dartRepo();
    commit(repo, { 'integration_test/app_test.dart': "import 'package:integration_test/integration_test.dart';\nvoid main() {}\n" });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    const env = dartShim(repo);
    commit(repo, {
      'integration_test/app_test.dart': "import 'package:integration_test/integration_test.dart';\nvoid main() { }\n",
      'packages/core/integration_test/core_it_test.dart': "void main() {}\n",
    });
    const stuck = run(repo, env);
    expect(stuck.out).toContain('FAIL lanes — integration_test/app_test.dart has no test lane');
    expect(stuck.out).toContain('FAIL lanes — packages/core/integration_test/core_it_test.dart has no test lane');
    expect(stuck.out).toContain('in .gstack/pregate.json; pregate does not run device tests, so declare "**/integration_test/**": []');
    commit(repo, { '.gstack/pregate.json': JSON.stringify({ ...DART_PREGATE, dependencies: { ...DART_PREGATE.dependencies, '**/integration_test/**': [] } }) + '\n' });
    const headOnly = run(repo, env, ['--policy-from', 'head']);
    expect(headOnly.status).toBe(EXIT.refused);
    expect(headOnly.err).toContain('a [] declaration must land on main first');
    expect(headOnly.err).toContain('(PREGATE_HEAD_POLICY_LOOSENS');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'integration_test/app_test.dart': "import 'package:integration_test/integration_test.dart';\nvoid main() {  }\n", 'packages/core/integration_test/core_it_test.dart': "void main() { }\n" });
    const declared = run(repo, env);
    expect(declared.status).toBe(EXIT.ok);
    expect(declared.out).not.toContain('has no test lane');
    expect(declared.out).toContain('nothing touched selects a test');
  }, 30_000);
  // Value: protects=a .dart test outside any Dart package in a bun repo makes the lane incomplete naming the missing pubspec, never a
  //   bun run of the .dart file; fails_when=the file falls to detectRunner (`bun test 'tools/test/x_test.dart'`, PREGATE_LANE_FAILED);
  //   why_new=planRuns was the only check; seam=none; no_claim=a real Dart SDK
  test('a .dart test with no pubspec.yaml above it is incomplete, not run by bun', () => {
    const repo = makeFixtureRepo({ pregate: DART_PREGATE });
    repos.push(repo);
    commit(repo, { 'bun.lock': '{}\n', '.github/workflows/free-tests.yml': null, '.github/workflows/windows.yml': null }, 'bun');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'tools/test/x_test.dart': 'void main() {}\n' });
    const r = run(repo, dartShim(repo));
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*tools\/test\/x_test\.dart; no pubspec\.yaml above 1 \.dart file\(s\)/m);
    expect(r.out).not.toContain('bun test');
  }, 30_000);

  /** dartRepo plus a Flutter package `packages/ui` with one test; PATH has `dart` (the shim, `script` replacing its body when given) but no flutter. */
  function mixedRepo(script?: string): { repo: FixtureRepo; env: { PATH: string } } {
    const repo = dartRepo();
    commit(repo, { 'packages/ui/pubspec.yaml': 'name: ui\ndependencies:\n  flutter:\n    sdk: flutter\n', 'packages/ui/test/ui_test.dart': 'void main() {}\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    dartShim(repo);
    const bin = pathWithoutDartTools(repo);
    fs.rmSync(path.join(bin, 'flutter'));
    if (script) fs.writeFileSync(path.join(bin, 'dart'), script, { mode: 0o755 });
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n', 'packages/ui/test/ui_test.dart': 'void main() { }\n' });
    return { repo, env: { PATH: bin } };
  }

  // Value: protects=a missing SDK for one package no longer suppresses the packages that can run: they run, and the all-green lane is
  //   incomplete naming the missing tool; fails_when=planning is all-or-nothing again (nothing runs) or the green run passes;
  //   why_new=the missing-SDK runs had no runnable package; seam=none; no_claim=a real Dart or Flutter SDK (PATH shim)
  test('runnable packages run when another package\'s SDK is missing; the lane is incomplete', () => {
    const { repo, env } = mixedRepo();
    const r = run(repo, env);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*2 tests ran in 2 file\(s\), exit 0; no test runner detected for 1 of 3 selected file\(s\): packages\/ui\/test\/ui_test\.dart; not on PATH: flutter/m);
    expect(r.out).toContain('fix: install flutter on this machine and rerun, or run the lane remotely; the diff is not at fault');
    expect(r.out).toContain('(PREGATE_ENVIRONMENT)');
    expect(fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8')).toContain('ran in core: test/core_test.dart');
  }, 30_000);

  // Value: protects=a real failure in a runnable package is reported as PREGATE_LANE_FAILED even when another package's SDK is missing;
  //   fails_when=the missing SDK masks the failure as incomplete; why_new=the mixed plan was only run green; seam=none;
  //   no_claim=a real Dart SDK (PATH shim that fails)
  test('a failing runnable package is a lane failure even when another package\'s SDK is missing', () => {
    const { repo, env } = mixedRepo('#!/usr/bin/env bash\necho "00:01 +0 -1: Some tests failed."\nexit 1\n');
    const r = run(repo, env);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}fail .*local lane exited 1/m);
    expect(r.out).toContain('PREGATE_LANE_FAILED');
  }, 30_000);
});
