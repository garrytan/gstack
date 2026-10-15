/**
 * C8 `lanes` for a Dart/Flutter repo: `package:` directives resolve through
 * every tracked pubspec.yaml, `_test.dart` files are tests, each package's
 * tests run from its own root, and the runner's `+N -M:` verdict is judged.
 * A repo that keeps `.gstack/` out of git declares its policy at
 * `<GSTACK_HOME>/projects/<slug>/pregate.json`, and `local` lanes run here
 * instead of becoming requires-remote. Every assertion holds on any host
 * platform: the fixture's lanes are named in `local` or not selected.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { dartRunner, parseSummary, planRuns } from '../lib/pregate/checks/lanes';
import { laneFileSet } from '../lib/pregate/lane-selection';
import type { Lane } from '../lib/pregate/workflows';
import { ROOT_OK } from '../lib/pregate/checks/strays';
import { DEFAULT_CONFIG, validateConfig } from '../lib/pregate/config';
import { buildGraph, dartPackages, isTestFile, testsFor } from '../lib/pregate/import-graph';
import type { PregateContext } from '../lib/pregate/types';
import { parseWorkflow } from '../lib/pregate/workflows';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, write, type FixtureRepo } from './helpers/pregate-fixture';

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

function dartRepo(pregate: Record<string, unknown> | null = null): FixtureRepo {
  const repo = makeFixtureRepo({ pregate });
  repos.push(repo);
  commit(repo, DART_FILES, 'dart');
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
    });
    expect(testsFor(buildGraph(repo.work), 'lib/multi.dart').tests).toEqual(['test/multi_test.dart']);
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
    expect([...dartPackages(repo.work, files)]).toEqual([['app', ''], ['core', 'packages/core']]);
    const env = dartShim(repo);
    expect(dartRunner(repo.work, 'packages/ext', env)).toEqual({ runner: 'dart test {files}' });
    expect(dartRunner(repo.work, 'packages/dir', env)).toEqual({ runner: 'dart test {files}' });
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
  });

  test('without a declared runner, Dart tests group by package root; a declared runner takes every file', () => {
    const repo = dartRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: dartShim(repo) } as unknown as PregateContext;
    expect(planRuns(ctx, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual([
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'dart test {files}', cwd: 'packages/core', files: ['test/core_test.dart'] },
    ]);
    // Value: protects=non-Dart files beside Dart ones go to the detected runner, and a file no runner claims makes the plan null (incomplete);
    //   fails_when=the rest group is dropped or an unclaimed file is silently skipped; why_new=only all-Dart lists were planned;
    //   seam=none; no_claim=the runners themselves (plan only)
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'test/util.test.js'])).toEqual([
      { runner: 'dart test {files}', cwd: '', files: ['test/ui/drawer_widget_test.dart'] },
      { runner: 'node --test {files}', cwd: '', files: ['test/util.test.js'] },
    ]);
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart', 'spec/drawer_spec.rb'])).toEqual({ unclaimed: ['spec/drawer_spec.rb'], missing: [] });
    // Value: protects=a machine without the Dart SDK gets an incomplete lane naming the missing tool, never a test failure (exit 127);
    //   fails_when=the PATH check is dropped and the runner is planned anyway; why_new=every earlier plan had the SDK on PATH;
    //   seam=none; no_claim=a real SDK install (an empty PATH stands in for a machine without one)
    const noSdk = { ...ctx, env: { PATH: path.join(repo.root, 'empty-path') } } as PregateContext;
    expect(planRuns(noSdk, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual({ unclaimed: ['test/ui/drawer_widget_test.dart', 'packages/core/test/core_test.dart'], missing: ['dart'] });
    write(repo.work, 'pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
    expect(planRuns(ctx, ['test/ui/drawer_widget_test.dart'])).toMatchObject([{ runner: 'flutter test {files}' }]);
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: 'bash scripts/test.sh {files}' } } as PregateContext;
    expect(planRuns(declared, ['packages/core/test/core_test.dart', 'test/ui/drawer_widget_test.dart'])).toEqual([
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
      '  abs:', '    runs-on: ubuntu-24.04', '    steps:', '      - run: dart test test/a_test.dart', '        working-directory: /home/runner/work/pkg', '',
    ].join('\n');
    const [step, job, top, cmt, abs] = parseWorkflow('w.yml', wf, 'darwin');
    // A trailing YAML comment is not part of the directory; an absolute directory stays unresolved (as before) rather than unmatchable.
    expect(cmt!.testFiles).toEqual(['packages/core/test/core_test.dart']);
    expect(abs!.testFiles).toEqual(['test/a_test.dart']);
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

  test('config: local takes <workflow>/<job> ids only', () => {
    expect(validateConfig({ local: ['test.yml/flutter'] })).toEqual([]);
    expect(validateConfig({ local: ['flutter'] }).map(e => e.path)).toEqual(['local[0]']);
    expect(validateConfig({ local: 'test.yml/flutter' }).map(e => e.path)).toEqual(['local']);
  });
});

describe('gstack-pregate on a Dart repo with no committed policy', () => {
  test('the user-owned policy is read when the base has none; local lanes run here; the base copy wins when present', () => {
    const repo = dartRepo(null);
    const env = { ...dartShim(repo), GSTACK_PROJECT_SLUG: 'dartfix' };
    const userPolicy = path.join(repo.home, 'projects', 'dartfix', 'pregate.json');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const run = () => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], env);

    // No policy anywhere: every lane is the host's call, so only the label is asserted.
    expect(run().out).toContain('(no .gstack/pregate.json)');

    // Value: protects=an invalid user policy refuses and names its path, never runs on defaults; fails_when=user-file errors are ignored or unlabelled;
    //   why_new=only valid user files were tested; seam=none; no_claim=none beyond protects
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['not-a-lane'] }));
    const invalid = run();
    expect(invalid.status).toBe(EXIT.refused);
    expect(invalid.err).toContain('PREGATE_CONFIG_INVALID');
    expect(invalid.err).toContain(`user ${userPolicy}`);
    // Value: protects=sealed in the user file is refused, since the pre-push guard never reads it (it would look active and do nothing);
    //   fails_when=the user loader accepts sealed/price_file silently; why_new=only lane ids were validated; seam=none; no_claim=the sealed guard itself
    fs.writeFileSync(userPolicy, JSON.stringify({ sealed: { paths: ['evals/**'] } }));
    const sealed = run();
    expect(sealed.status).toBe(EXIT.refused);
    expect(sealed.err).toContain('covers gstack-pregate run only; sealed');
    expect(sealed.err).toContain('edit that file directly');
    // Value: protects=a null price_file (the documented default, a no-op) is accepted; fails_when=the check regresses to key presence;
    //   why_new=only a non-null sealed was tested; seam=none; no_claim=none beyond protects
    fs.writeFileSync(userPolicy, JSON.stringify({ price_file: null }));
    expect(run().err).not.toContain('PREGATE_CONFIG_INVALID');
    // Value: protects=a user policy that exists but cannot be read refuses instead of running on defaults (its guards would vanish);
    //   fails_when=every read error is treated as absent; why_new=only missing and parseable files were tested; seam=none; no_claim=EACCES specifically
    fs.rmSync(userPolicy);
    fs.mkdirSync(userPolicy);
    const unreadable = run();
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain('cannot read the user-owned policy');
    fs.rmdirSync(userPolicy);

    // A local lane runs here; a lane not named stays an obligation.
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit'] }));
    const partial = run();
    expect(partial.out).toContain(`policy user ${userPolicy}`);
    expect(partial.out).toContain('requires-remote windows.yml/windows-shard (windows)');
    expect(partial.out).not.toContain('requires-remote free-tests.yml/unit');

    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    const all = run();
    expect(all.status).toBe(EXIT.ok);
    expect(all.out).toContain('Tiers ran: unit; requires-remote: none');
    expect(all.out).toMatch(/^tests {6}lanes {5}pass .*2 tests ran in 2 file\(s\), exit 0/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(all.out)![1]!, 'utf8');
    expect(log).toContain('ran in core: test/core_test.dart');
    expect(log).toMatch(/ran in \S+: test\/ui\/drawer_widget_test\.dart/);

    // Value: protects=--policy-from head reads only the working-tree pin, never the user file; fails_when=the policyFrom guard on the user fallback is dropped;
    //   why_new=only base mode was tested with a user file; seam=none; no_claim=none beyond protects
    const head = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--policy-from', 'head'], env);
    expect(head.out).not.toContain('policy user');
    expect(head.out).toContain('(no .gstack/pregate.json)');

    // A base copy is reviewed policy: it wins, and the user file is not read.
    commit(repo, { '.gstack/pregate.json': JSON.stringify(BASE_PREGATE) + '\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 3;\n' });
    const based = run();
    expect(based.out).toContain('origin/main@');
    expect(based.out).not.toContain('policy user');
  }, 30_000);

  // Value: protects=serial_patterns match repo-relative paths, so a serial file inside a Dart sub-package runs alone from that package root;
  //   fails_when=the pattern is matched against the cwd-relative path and the file joins the unit run; why_new=pregate-guards covers root JS serial files only;
  //   seam=none; no_claim=a real dart runner (PATH shim reports cwd and argv)
  test('a serial file inside a Dart sub-package runs in its own process from that package root', () => {
    const repo = dartRepo(null);
    const env = { ...dartShim(repo), GSTACK_PROJECT_SLUG: 'dartserial' };
    const userPolicy = path.join(repo.home, 'projects', 'dartserial', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'], serial_patterns: ['packages/core/test/slow_test.dart'] }));
    commit(repo, {
      'packages/core/test/slow_test.dart': "import 'package:core/core.dart';\nvoid main() {}\n",
      'packages/core/lib/core.dart': 'int one() => 2;\n',
    });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], env);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*3 tests ran in 3 file\(s\) \(1 serial\), exit 0/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8');
    expect(log).toContain('ran in core: test/core_test.dart\n');
    expect(log).toContain('ran in core: test/slow_test.dart\n');
  }, 30_000);

  // Value: protects=every run group shares one --timeout deadline, so the sum of runs never exceeds it and a late group is cut off (incomplete);
  //   fails_when=each group gets the full --timeout again (a 2-package repo could run 2x the budget and pass); why_new=no multi-group timeout test;
  //   seam=none; no_claim=exact timing (root run sleeps 1 s, core 5 s, deadline 5.5 s: load can only shrink core's budget, never cut the root run)
  test('run groups share the --timeout deadline: a later package past it is incomplete, never a pass', () => {
    const repo = dartRepo(null);
    const env = { ...dartShim(repo, { core: 5, '*': 1 }), GSTACK_PROJECT_SLUG: 'dartdeadline' };
    const userPolicy = path.join(repo.home, 'projects', 'dartdeadline', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--timeout', '5.5'], env);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*local lane timed out/m);
    const log = fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8');
    expect(log).toMatch(/ran in \S+: test\/ui\/drawer_widget_test\.dart/);
    expect(log).not.toContain('ran in core:');
  }, 30_000);

  // Value: protects=one package whose tests all skip (+0) makes the lane ZERO-RUN even when another package ran tests, and a file name
  //   with `$&` reaches the runner verbatim; fails_when=counts are summed before the zero check, or {files} is substituted with a string
  //   replacement; why_new=only single-group zero runs were tested; seam=none; no_claim=a real dart runner (PATH shim)
  test('a package that ran 0 tests is ZERO-RUN even when another package ran tests', () => {
    const repo = dartRepo(null);
    const { PATH } = dartShim(repo);
    const shim = path.join(repo.root, 'shim');
    for (const tool of ['dart', 'flutter']) fs.writeFileSync(path.join(shim, tool), `#!/usr/bin/env bash\nshift\necho "ran in $(basename "$PWD"): $*"\nif [ "$(basename "$PWD")" = core ]; then echo "00:01 +0 ~1: All tests skipped."; else echo "00:01 +$#: All tests passed!"; fi\n`, { mode: 0o755 });
    const userPolicy = path.join(repo.home, 'projects', 'dartzero', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n', 'test/odd$&_test.dart': "import 'package:app/theme.dart';\nvoid main() {}\n" });
    const r = runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], { PATH, GSTACK_PROJECT_SLUG: 'dartzero' });
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN: the runner reported 0 tests in \(cd 'packages\/core'/m);
    expect(fs.readFileSync(/log: (\S+)/.exec(r.out)![1]!, 'utf8')).toContain('test/odd$&_test.dart');
  }, 30_000);

  // Value: protects=a repo pinning its SDK (.fvmrc) runs Dart tests through fvm when fvm is on PATH, and without it when fvm is absent;
  //   fails_when=the fvm prefix or the .fvmrc check is dropped, or fvm is required when absent; why_new=no test had a pin file;
  //   seam=none; no_claim=a real fvm or Dart SDK (PATH holds only shims and the tools pregate spawns)
  test('an .fvmrc pin routes the Dart runner through fvm only when fvm is on PATH', () => {
    const repo = dartRepo(null);
    dartShim(repo);
    const bin = path.join(repo.root, 'shim');
    // The host PATH minus any real fvm/dart/flutter: every other tool pregate and git spawn stays reachable.
    for (const dir of (process.env.PATH ?? '').split(':')) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) if (!['fvm', 'dart', 'flutter'].includes(name) && !fs.lstatSync(path.join(bin, name), { throwIfNoEntry: false })) fs.symlinkSync(path.join(dir, name), path.join(bin, name));
    }
    const userPolicy = path.join(repo.home, 'projects', 'dartfvm', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    commit(repo, { '.fvmrc': '{"flutter":"3.24.0"}\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'packages/core/lib/core.dart': 'int one() => 2;\n' });
    const run = () => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], { PATH: bin, GSTACK_PROJECT_SLUG: 'dartfvm' });

    const bare = run();
    expect(bare.out).toMatch(/^tests {6}lanes {5}pass /m);
    expect(bare.out).toMatch(/lanes: ran: dart test /);

    fs.writeFileSync(path.join(bin, 'fvm'), '#!/bin/sh\necho "via fvm"\nexec "$@"\n', { mode: 0o755 });
    const pinned = run();
    expect(pinned.out).toMatch(/^tests {6}lanes {5}pass /m);
    expect(pinned.out).toMatch(/lanes: ran: fvm dart test /);
    expect(fs.readFileSync(/log: (\S+)/.exec(pinned.out)![1]!, 'utf8')).toContain('via fvm');

    // Value: protects=no SDK and no fvm on PATH is incomplete with an install hint (not exit 127 judged as a test failure), and the
    //   hint offers fvm only because this repo pins it; fails_when=the missing branch or its fix text regresses; why_new=only planRuns'
    //   return value was tested; seam=none; no_claim=a real SDK install
    for (const tool of ['fvm', 'dart', 'flutter']) fs.rmSync(path.join(bin, tool));
    const missing = run();
    expect(missing.status).not.toBe(EXIT.ok);
    expect(missing.out).toMatch(/^tests {6}lanes {5}incomplete .*not on PATH: dart/m);
    expect(missing.out).toContain('fix: install dart (or fvm, which this repo pins) and rerun');
  }, 30_000);

  // Value: protects=a touched device test (integration_test/) is never run locally, fails with a fix naming the active user policy file,
  //   and the documented `[]` declaration clears it; fails_when=the docs' remedy stops working or the fix points at the wrong file;
  //   why_new=device tests were only checked at isTestFile; seam=none; no_claim=CI running the device test
  test('a touched integration test (root or nested package) has no local lane until declared [] in the user policy', () => {
    const repo = dartRepo(null);
    commit(repo, { 'integration_test/app_test.dart': "import 'package:integration_test/integration_test.dart';\nvoid main() {}\n" });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    const env = { ...dartShim(repo), GSTACK_PROJECT_SLUG: 'dartdevice' };
    const userPolicy = path.join(repo.home, 'projects', 'dartdevice', 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'] }));
    commit(repo, {
      'integration_test/app_test.dart': "import 'package:integration_test/integration_test.dart';\nvoid main() { }\n",
      'packages/core/integration_test/core_it_test.dart': "void main() {}\n",
    });
    const run = () => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], env);
    const stuck = run();
    expect(stuck.out).toContain('FAIL lanes — integration_test/app_test.dart has no test lane');
    expect(stuck.out).toContain('FAIL lanes — packages/core/integration_test/core_it_test.dart has no test lane');
    expect(stuck.out).toContain(`under dependencies in ${userPolicy}; pregate does not run device tests`);
    fs.writeFileSync(userPolicy, JSON.stringify({ local: ['free-tests.yml/unit', 'windows.yml/windows-shard'], dependencies: { '**/integration_test/**': [] } }));
    const declared = run();
    expect(declared.status).toBe(EXIT.ok);
    expect(declared.out).not.toContain('has no test lane');
    expect(declared.out).toContain('nothing touched selects a test');
  }, 30_000);
});
