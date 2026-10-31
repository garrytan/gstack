/**
 * `lanes` for a Swift repo: a `*Tests.swift` (or `*Test.swift`) file under a
 * `*Tests/` directory is a test (SwiftPM's `Tests/<Target>/`, Xcode's
 * `<App>Tests/`), so a `dependencies` entry naming one selects it. Swift
 * tests import whole modules, so the import graph never maps a source file to
 * them by itself, and SwiftPM filters by suite name rather than file: there is
 * no detected runner, and a repo declares `runner` (with {files}). The Swift
 * Testing and XCTest summaries are counted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { parseSummary, planRuns } from '../lib/pregate/checks/lanes';
import { DEFAULT_CONFIG } from '../lib/pregate/config';
import { buildGraph, isTestFile, testsFor } from '../lib/pregate/import-graph';
import type { PregateContext } from '../lib/pregate/types';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SWIFT_FILES: Record<string, string> = {
  'Package.swift': '// swift-tools-version: 6.0\nimport PackageDescription\n',
  'Sources/Agent/Launch.swift': 'public struct Launch {}\n',
  'Sources/Agent/LaunchTests.swift': 'struct NotATest {}\n',
  'Tests/AgentTests/LaunchTests.swift': 'import Testing\n@testable import Agent\nstruct LaunchTests { @Test func runs() {} }\n',
  'Tests/AgentTests/Fixtures.swift': 'enum Fixtures {}\n',
  'Tests/TestSupport/HelperTests.swift': 'enum Helpers {}\n',
};

function swiftRepo(): FixtureRepo {
  const repo = makeFixtureRepo({});
  repos.push(repo);
  commit(repo, SWIFT_FILES, 'swift');
  return repo;
}

describe('Swift test files are tests', () => {
  test('SwiftPM and Xcode test files match; sources, helpers and files outside a *Tests directory do not', () => {
    // Value: protects=a Swift test named by a `dependencies` entry selects a lane instead of leaving the source laneless;
    //   fails_when=the Swift pattern is dropped and every Swift source fails PREGATE_NO_LANE; why_new=no Swift test matched before;
    //   seam=none; no_claim=other test naming schemes (Quick/Nimble `*Spec.swift`)
    for (const file of [
      'Tests/MLXVideoCatalogKitCoreTests/NativeAgentTransportTests.swift',
      'Tests/AgentTests/Nested/LaunchTest.swift',
      'SightRollTests/ExternalAgentSkillsPackTests.swift',
      'SightRollUITests/SyncSettingsUITests.swift',
    ]) expect(isTestFile(file)).toBe(true);
    for (const file of [
      'Sources/Agent/LaunchTests.swift',
      'Tests/AgentTests/Fixtures.swift',
      'Tests/MLXVideoCatalogKitCoreTests/ExternalAgentFixtures.swift',
      'Tests/TestSupport/Fixtures.swift',
      'Tests/AgentTests/LaunchTests.swift.orig',
    ]) expect(isTestFile(file)).toBe(false);
  });

  test('a dependencies entry maps a Swift source to its suite', () => {
    const repo = swiftRepo();
    const graph = buildGraph(repo.work, { declarations: { 'Sources/Agent/**': ['Tests/AgentTests/LaunchTests.swift'] } });
    // Value: protects=the kit's declared Swift lanes take effect; fails_when=a declared Swift test is not a test and is dropped;
    //   why_new=declared Swift tests selected nothing; seam=none; no_claim=module-level import edges (Swift imports modules, not files)
    expect(testsFor(graph, 'Sources/Agent/Launch.swift', { 'Sources/Agent/**': ['Tests/AgentTests/LaunchTests.swift'] }).tests)
      .toEqual(['Tests/AgentTests/LaunchTests.swift']);
    expect(testsFor(graph, 'Tests/AgentTests/LaunchTests.swift').tests).toEqual(['Tests/AgentTests/LaunchTests.swift']);
  });

  test('there is no detected Swift runner: unclaimed until the repo declares one', () => {
    const repo = swiftRepo();
    const ctx = { repoRoot: repo.work, config: DEFAULT_CONFIG, env: process.env } as unknown as PregateContext;
    // Value: protects=a selected Swift test without a runner is an incomplete lane naming the fix, never a silent pass;
    //   fails_when=a guessed `swift test` runner runs unfiltered or with file paths SwiftPM cannot take; why_new=Swift tests were never selected;
    //   seam=none; no_claim=what a declared runner does with the files
    expect(planRuns(ctx, ['Tests/AgentTests/LaunchTests.swift'])).toEqual({ groups: [], unclaimed: ['Tests/AgentTests/LaunchTests.swift'], missing: [], noPubspec: [] });
    const declared = { ...ctx, config: { ...DEFAULT_CONFIG, runner: './Scripts/test.sh --files {files}' } } as PregateContext;
    expect(planRuns(declared, ['Tests/AgentTests/LaunchTests.swift']).groups)
      .toEqual([{ runner: './Scripts/test.sh --files {files}', cwd: '', files: ['Tests/AgentTests/LaunchTests.swift'] }]);
  });
});

describe('Swift summaries', () => {
  test('Swift Testing and XCTest counts are summed; failures are counted per failed test', () => {
    // Value: protects=a Swift lane reports tests_ran and its failures instead of `count unavailable`;
    //   fails_when=the summary is unparsed, or a recorded-issue line counts as a failed test; why_new=no Swift summary was parsed;
    //   seam=none; no_claim=xcodebuild's xcresult summary (read from the log line only)
    expect(parseSummary([
      'Test Suite \'All tests\' passed at 2026-11-01 10:00:00.000.',
      '\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds',
      '✔ Test run with 1539 tests in 119 suites passed after 85.180 seconds.',
    ].join('\n'), './Scripts/test-agent-skeleton.sh --core {files}')).toEqual({ ran: 1539, failed: 0 });
    expect(parseSummary([
      '✘ Test codexAsks(allow:) recorded an issue with 1 argument allow → false at A.swift:161:9: Expectation failed',
      '✘ Test codexAsks(allow:) with 2 test cases failed after 0.388 seconds with 4 issues.',
      '✘ Test showsScript() failed after 0.001 seconds with 2 issues.',
      '✔ Test claudeAsks(allow:) with 2 test cases passed after 0.567 seconds.',
      '✘ Test run with 7 tests in 2 suites failed after 0.567 seconds with 6 issues.',
    ].join('\n'))).toEqual({ ran: 7, failed: 2 });
    expect(parseSummary("Test Suite 'All tests' failed.\n\t Executed 12 tests, with 3 failures (0 unexpected) in 1.2 (1.3) seconds")).toEqual({ ran: 12, failed: 3 });
    // Value: protects=a filter that matches nothing is ZERO-RUN, not a pass; fails_when=a zero count reads as unknown;
    //   why_new=Swift output was never parsed; seam=none; no_claim=none
    expect(parseSummary('✔ Test run with 0 tests passed after 0.001 seconds.\n\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.000) seconds'))
      .toEqual({ ran: 0, failed: 0 });
  });
});
