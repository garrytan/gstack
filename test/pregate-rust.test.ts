/**
 * C8 `lanes` for a Rust repo: a `.rs` file of a crate (the nearest Cargo.toml
 * with `[package]`) is a test when it sits under `<crate>/tests/` or holds a
 * `#[cfg(test)]`; every `.rs` file of a crate and its Cargo.toml select that
 * crate's tests and the tests of every crate depending on it; selected tests
 * run as `cargo test -p <name>` from the workspace root, judged on the summed
 * `test result:` lines. The end-to-end fixture carries no workflows, so every
 * selected test is a local lane on any host platform; `cargo` is a PATH shim.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { parseSummary, planRuns } from '../lib/pregate/checks/lanes';
import { DEFAULT_CONFIG } from '../lib/pregate/config';
import { buildGraph, testsFor } from '../lib/pregate/import-graph';
import { draftConfig } from '../lib/pregate/init-draft';
import type { PregateContext } from '../lib/pregate/types';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const RUST_FILES: Record<string, string> = {
  'engine/Cargo.toml': '[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nalpha = { path = "crates/alpha" }\n',
  'engine/crates/alpha/Cargo.toml': '[package]\nname = "alpha"\nversion = "0.1.0"\nedition = "2024"\n',
  'engine/crates/alpha/src/lib.rs': 'pub mod util;\npub fn one() -> u32 { 1 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn one_is_one() { assert_eq!(super::one(), 1); }\n}\n',
  'engine/crates/alpha/src/util.rs': 'pub fn two() -> u32 { 2 }\n',
  'engine/crates/alpha/src/flags.rs': '#[cfg(feature = "test")]\npub fn only_with_the_test_feature() {}\n',
  'engine/crates/alpha/tests/it.rs': '#[test]\nfn it() { assert_eq!(alpha::one(), 1); }\n',
  'engine/crates/beta/Cargo.toml': '[package]\nname = "beta-core"\nversion = "0.1.0"\n\n[dependencies]\nalpha = { workspace = true } # the shared base\n',
  'engine/crates/beta/src/lib.rs': 'pub fn b() -> u32 { alpha::one() }\n\n#[cfg(all(test, unix))]\nmod tests {\n    #[test]\n    fn b() {}\n}\n',
  'engine/crates/gamma/Cargo.toml': '[package]\nname = "gamma"\nversion = "0.1.0"\n\n[target.\'cfg(unix)\'.dev-dependencies.base]\npackage = "beta-core"\npath = "../beta"\n',
  'engine/crates/gamma/src/lib.rs': 'pub fn g() {}\n',
  'engine/crates/gamma/tests/g.rs': '#[test]\nfn g() {}\n',
  'engine/crates/lonely/Cargo.toml': '[package]\nname = "lonely"\nversion = "0.1.0"\n',
  'engine/crates/lonely/src/lib.rs': 'pub fn alone() {}\n',
  'standalone/Cargo.toml': '[package]\nname = "standalone"\nversion = "0.1.0"\n',
  'standalone/src/main.rs': 'fn main() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n',
  'tools/tests/loose.rs': 'fn main() {}\n',
};

const ALPHA_TESTS = ['engine/crates/alpha/src/lib.rs', 'engine/crates/alpha/tests/it.rs'];

/** The fixture plus RUST_FILES on main, with no base policy and no workflows, so every selected test runs locally. */
function rustRepo(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: null });
  repos.push(repo);
  commit(repo, { ...RUST_FILES, '.github/workflows/free-tests.yml': null, '.github/workflows/windows.yml': null }, 'rust');
  repo.git('push', '-q', 'origin', 'HEAD:main');
  repo.git('fetch', '-q', 'origin');
  return repo;
}

const CARGO_OK = [
  'echo "ran in $(basename "$PWD"): $*"',
  'echo "running 2 tests"',
  'echo "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"',
  'echo "   Doc-tests $3"',
  'echo "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"',
].join('\n');

/** A `cargo` on PATH running `body` (default: reports its cwd and argv, then two passed tests and an empty doc-test binary). */
function cargoShim(repo: FixtureRepo, body = CARGO_OK): { PATH: string } {
  const dir = path.join(repo.root, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cargo'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

const rustTests = (tests: Iterable<string>) => [...tests].filter(t => t.endsWith('.rs')).sort();

describe('Rust import graph', () => {
  // Value: protects=in-source `#[cfg(test)]` modules and `<crate>/tests/` files are tests only inside a crate, and a cfg naming a
  //   feature called "test" is not; fails_when=Rust tests are never recognised (every touched .rs is PREGATE_NO_LANE) or any
  //   tests/*.rs counts without a Cargo.toml; why_new=no Rust support existed; seam=none; no_claim=a Rust parser (a cfg attribute scan)
  test('cfg(test) files and <crate>/tests/ files are tests; a loose tests/*.rs and a cfg(feature = "test") file are not', () => {
    const g = buildGraph(rustRepo().work);
    expect(rustTests(g.tests)).toEqual([...ALPHA_TESTS, 'engine/crates/beta/src/lib.rs', 'engine/crates/gamma/tests/g.rs', 'standalone/src/main.rs']);
  });

  // Value: protects=a src file without its own tests selects its crate's tests and, transitively, the tests of crates depending on it
  //   (workspace = true, a renamed target-specific dev-dependency); an in-source test selects itself; a crate with no tests stays
  //   no-lane; fails_when=the mapping narrows to the file, misses dependents, or invents a lane; why_new=no Rust mapping existed;
  //   seam=none; no_claim=cargo's own resolver (manifest dependency keys are read)
  test('a crate file selects its crate and every crate depending on it; a crate without tests has no lane', () => {
    const g = buildGraph(rustRepo().work);
    const everyAlphaDependent = [...ALPHA_TESTS, 'engine/crates/beta/src/lib.rs', 'engine/crates/gamma/tests/g.rs'];
    expect(testsFor(g, 'engine/crates/alpha/src/util.rs').tests).toEqual(everyAlphaDependent);
    expect(testsFor(g, 'engine/crates/alpha/src/lib.rs').tests).toEqual(everyAlphaDependent);
    expect(testsFor(g, 'engine/crates/alpha/Cargo.toml').tests).toEqual(everyAlphaDependent);
    expect(testsFor(g, 'engine/crates/beta/src/lib.rs').tests).toEqual(['engine/crates/beta/src/lib.rs', 'engine/crates/gamma/tests/g.rs']);
    expect(testsFor(g, 'engine/crates/gamma/src/lib.rs').tests).toEqual(['engine/crates/gamma/tests/g.rs']);
    expect(testsFor(g, 'standalone/src/main.rs').tests).toEqual(['standalone/src/main.rs']);
    expect(testsFor(g, 'engine/crates/lonely/src/lib.rs').tests).toEqual([]);
    expect(testsFor(g, 'tools/tests/loose.rs').tests).toEqual([]);
  });

  // Value: protects=`gstack-pregate init` tells a Rust repo its tests run per crate (no runner to declare), and Rust does not make a
  //   JS selection "mixed"; fails_when=init tells the user to set a runner for Rust tests, which would override the per-crate plan;
  //   why_new=init grouped .rs tests as "other"; seam=none; no_claim=none beyond protects
  test('init notes that Rust tests run per crate with cargo test, not that a runner must be set', () => {
    const note = draftConfig(rustRepo().work).runnerNote;
    expect(note).toContain('5 Rust test file(s) run per crate with cargo test -p');
    expect(note).not.toContain('needs runner set');
    expect(note).not.toMatch(/no runner detected for \d+ (?:other|rust)/);
  });
});

describe('Rust runner and summary (pure)', () => {
  // Value: protects=cargo prints one `test result:` line per test binary (unit, each integration test, doc-tests); all are summed,
  //   ignored and filtered tests are not runs, and an all-zero run is ZERO-RUN; fails_when=only the first or last line counts, or the
  //   generic `N passed` fallback reads cargo output; why_new=cargo output was unparsed (ran: null); seam=none; no_claim=a real cargo
  test('cargo test: every test result line counts, doc-tests included; all zeros are a zero run', () => {
    const cargo = 'cargo test -p alpha';
    const ok = [
      '   Compiling alpha v0.1.0', '     Running unittests src/lib.rs (target/debug/deps/alpha-1)', '', 'running 2 tests', 'test tests::a ... ok', 'test tests::b ... ok', '',
      'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s', '',
      '     Running tests/it.rs (target/debug/deps/it-2)', '', 'running 2 tests', 'test it ... ok', 'test slow ... ignored', '',
      'test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s', '',
      '   Doc-tests alpha', '', 'running 3 tests', 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.31s',
    ].join('\n');
    expect(parseSummary(ok, cargo)).toEqual({ ran: 6, failed: 0 });
    const failed = 'test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nfailures:\n    tests::b\n\ntest result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\nerror: test failed, to rerun pass `-p alpha --lib`';
    expect(parseSummary(failed, cargo)).toEqual({ ran: 7, failed: 2 });
    const zero = 'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n   Doc-tests alpha\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s';
    expect(parseSummary(zero, cargo)).toEqual({ ran: 0, failed: 0 });
    expect(parseSummary('\x1b[1m\x1b[32mtest result: ok\x1b[0m. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s', cargo)).toEqual({ ran: 5, failed: 0 });
    expect(parseSummary('error[E0425]: cannot find value `x` in this scope\nerror: could not compile `alpha`', cargo)).toEqual({ ran: null, failed: null });
  });

  // Value: protects=each selected crate runs once as `cargo test -p <name>` from its workspace root (else its own directory), crates
  //   group apart, a .rs file outside any crate is unclaimed, and a missing cargo is incomplete; fails_when=.rs files reach the JS
  //   runner, run from the repo root, merge across crates, or a missing cargo is judged as a test failure (exit 127); why_new=no cargo
  //   runner existed; seam=none; no_claim=the runners themselves (plan only)
  test('without a declared runner, Rust tests group by crate from the workspace root; a declared runner takes every file', () => {
    const repo = rustRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: cargoShim(repo) } as unknown as PregateContext;
    const files = [...ALPHA_TESTS, 'engine/crates/beta/src/lib.rs', 'standalone/src/main.rs', 'tools/tests/loose.rs'];
    expect(planRuns(ctx, files)).toEqual({ groups: [
      { runner: 'cargo test -p alpha', cwd: 'engine', files: ['crates/alpha/src/lib.rs', 'crates/alpha/tests/it.rs'] },
      { runner: 'cargo test -p beta-core', cwd: 'engine', files: ['crates/beta/src/lib.rs'] },
      { runner: 'cargo test -p standalone', cwd: 'standalone', files: ['src/main.rs'] },
    ], unclaimed: ['tools/tests/loose.rs'], missing: [], noPubspec: [] });
    const noCargo = { ...ctx, env: { PATH: path.join(repo.root, 'empty-path') } } as PregateContext;
    expect(planRuns(noCargo, ALPHA_TESTS)).toEqual({ groups: [], unclaimed: ALPHA_TESTS, missing: ['cargo'], noPubspec: [] });
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: 'bash scripts/test.sh {files}' } } as PregateContext;
    expect(planRuns(declared, files).groups).toEqual([{ runner: 'bash scripts/test.sh {files}', cwd: '', files }]);
  });
});

describe('gstack-pregate on a Rust workspace', () => {
  const run = (repo: FixtureRepo, env: Record<string, string>) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--only', 'lanes'], env);
  const log = (out: string) => fs.readFileSync(/log: (\S+)/.exec(out)![1]!, 'utf8');

  // Value: protects=the reported case end to end: a touched src file of a workspace crate is not PREGATE_NO_LANE, its crate and the
  //   dependent crates run with `cargo test -p` from the workspace root, and the summed count is reported; fails_when=any link of
  //   graph, plan or summary regresses; why_new=no Rust run existed; seam=none; no_claim=a real cargo (PATH shim reports cwd and argv)
  test('a touched src file runs its crate and the crates depending on it from the workspace root', () => {
    const repo = rustRepo();
    commit(repo, { 'engine/crates/alpha/src/util.rs': 'pub fn two() -> u32 { 1 + 1 }\n' });
    const r = run(repo, cargoShim(repo));
    expect(r.out).not.toContain('has no test lane');
    expect(r.out).toMatch(/^tests {6}lanes {5}pass .*6 tests ran in 4 file\(s\), exit 0/m);
    expect(r.out).toContain("ran: (cd 'engine' && cargo test -p alpha) && (cd 'engine' && cargo test -p beta-core) && (cd 'engine' && cargo test -p gamma)");
    expect(log(r.out)).toContain('ran in engine: test -p alpha');
    expect(r.status).toBe(EXIT.ok);
  }, 60_000);

  // Value: protects=a crate whose test binaries all report 0 tests is ZERO-RUN (exit 0 is not a pass), and a failing cargo run is
  //   PREGATE_LANE_FAILED with its counts; fails_when=cargo's summary is unparsed (count unavailable passes) or the exit is ignored;
  //   why_new=the pure parser test does not run the lane; seam=none; no_claim=a real cargo (PATH shim)
  test('zero tests is ZERO-RUN; a failing cargo run is PREGATE_LANE_FAILED', () => {
    const repo = rustRepo();
    commit(repo, { 'engine/crates/gamma/src/lib.rs': 'pub fn g() { }\n' });
    const zero = run(repo, cargoShim(repo, 'echo "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"'));
    expect(zero.status).not.toBe(EXIT.ok);
    expect(zero.out).toMatch(/^tests {6}lanes {5}fail .*ZERO-RUN: the runner reported 0 tests in \(cd 'engine' && cargo test -p gamma\)/m);
    const red = run(repo, cargoShim(repo, 'echo "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"\nexit 101'));
    expect(red.status).not.toBe(EXIT.ok);
    expect(red.out).toMatch(/^tests {6}lanes {5}fail .*local lane exited 101 \(1 failed of 2 ran; 1 files; pipefail\)/m);
  }, 60_000);

  // Value: protects=a crate with no tests still fails closed (no lane), so the crate mapping never invents coverage;
  //   fails_when=crate membership alone counts as a lane; why_new=negative control for the new mapping; seam=none; no_claim=none
  test('a touched file of a crate without tests still has no test lane', () => {
    const repo = rustRepo();
    commit(repo, { 'engine/crates/lonely/src/lib.rs': 'pub fn alone() { }\n' });
    const r = run(repo, cargoShim(repo));
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.out).toContain('FAIL lanes — engine/crates/lonely/src/lib.rs has no test lane');
  }, 60_000);
});
