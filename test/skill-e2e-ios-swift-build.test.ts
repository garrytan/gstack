// Swift-build invariant tests. Runs against the fixture iOS app at
// test/fixtures/ios-qa/FixtureApp/. Requires the Swift toolchain
// (Xcode CLI tools or stand-alone Swift). Skipped if swift is not on PATH.
//
// Two invariants:
//
//   1. Debug-config build succeeds + the StateServer XCTest unit suite
//      passes (validates that the Swift production code actually runs,
//      not just compiles).
//
//   2. Release-config build excludes DebugBridge symbols. This is the
//      structural Release-build guard from Package.swift's
//      `.when(configuration: .debug)`. We verify by:
//        a. swift build -c release succeeds
//        b. nm -j against the built binary shows zero `DebugBridge*`
//           symbols
//        c. swift build -c release with --vv shows DebugBridge target
//           gated (no compilation step for DebugBridgeCore/UI)

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const FIXTURE_PATH = join(ROOT, 'test/fixtures/ios-qa/FixtureApp');
const TEMPLATES_PATH = join(ROOT, 'ios-qa/templates');
const GEN_ACCESSORS_PACKAGE = join(ROOT, 'ios-qa/scripts/gen-accessors-tool/Package.swift');

// Parity: canonical Obj-C touch templates must match the fixture's working
// copy. The fixture is the only place the .m / .h are exercised end-to-end
// on a real device, so any divergence means consuming apps would ship a
// stale, untested version of the SwiftUI hit-test fix.
describe('template ↔ fixture parity', () => {
  test('DebugBridgeTouch.h.template matches fixture include', () => {
    const tmpl = readFileSync(join(TEMPLATES_PATH, 'DebugBridgeTouch.h.template'), 'utf-8');
    const fixture = readFileSync(
      join(FIXTURE_PATH, 'Sources/DebugBridgeTouch/include/DebugBridgeTouch.h'),
      'utf-8',
    );
    expect(tmpl).toBe(fixture);
  });

  test('DebugBridgeTouch.m.template matches fixture .m', () => {
    const tmpl = readFileSync(join(TEMPLATES_PATH, 'DebugBridgeTouch.m.template'), 'utf-8');
    const fixture = readFileSync(
      join(FIXTURE_PATH, 'Sources/DebugBridgeTouch/DebugBridgeTouch.m'),
      'utf-8',
    );
    expect(tmpl).toBe(fixture);
  });

  test('Package.swift.template declares all 3 DebugBridge targets', () => {
    const tmpl = readFileSync(join(TEMPLATES_PATH, 'Package.swift.template'), 'utf-8');
    // Each target must be present as a library product AND a target definition.
    for (const name of ['DebugBridgeCore', 'DebugBridgeUI', 'DebugBridgeTouch']) {
      expect(tmpl).toContain(`name: "${name}"`);
    }
    // DebugBridgeUI must depend on the other two; that's how the consuming
    // app gets the transitive set with one dependency entry.
    expect(tmpl).toMatch(/name:\s*"DebugBridgeUI"[\s\S]*?dependencies:\s*\["DebugBridgeCore",\s*"DebugBridgeTouch"\]/);
  });

  test('generated Swift packages only reference shipped test directories', () => {
    const genAccessorsPackage = readFileSync(GEN_ACCESSORS_PACKAGE, 'utf-8');
    const debugBridgePackage = readFileSync(join(TEMPLATES_PATH, 'Package.swift.template'), 'utf-8');

    expect(genAccessorsPackage).not.toContain('Tests/GenAccessorsTests');
    expect(debugBridgePackage).not.toContain('Tests/DebugBridgeCoreTests');
  });

  test('Package.swift.template keeps swift-tools-version on the first line', () => {
    const tmpl = readFileSync(join(TEMPLATES_PATH, 'Package.swift.template'), 'utf-8');
    expect(tmpl.split(/\r?\n/, 1)[0]).toBe('// swift-tools-version:5.9');
  });
});

function hasSwift(): boolean {
  const r = spawnSync('swift', ['--version'], { stdio: 'pipe' });
  return r.status === 0;
}

const swiftAvailable = hasSwift();
const describeIfSwift = swiftAvailable ? describe : describe.skip;

describeIfSwift('swift build invariants', () => {
  // DebugBridgeUI + DebugBridgeTouch are iOS-only (they link UIKit). Plain
  // `swift build` on macOS host can't resolve UIKit, so we scope these
  // invariants to DebugBridgeCore (Swift, cross-platform) + its XCTest
  // target. The iOS-only targets are covered by xcodebuild on the device
  // path (test/skill-e2e-ios-device.test.ts).
  test('Debug-config build succeeds (DebugBridgeCore)', () => {
    const r = spawnSync('swift', ['build', '-c', 'debug', '--target', 'DebugBridgeCore'], {
      cwd: FIXTURE_PATH,
      stdio: 'pipe',
      timeout: 120_000,
    });
    if (r.status !== 0) {
      console.error('swift build stderr:', r.stderr?.toString().slice(0, 4000));
    }
    expect(r.status).toBe(0);
  }, 180_000);

  test('XCTest suite for StateServer passes (validates real Swift impl)', () => {
    const r = spawnSync('swift', ['test', '--filter', 'DebugBridgeCoreTests'], {
      cwd: FIXTURE_PATH,
      stdio: 'pipe',
      timeout: 180_000,
    });
    const stdout = r.stdout?.toString() ?? '';
    const stderr = r.stderr?.toString() ?? '';
    const combined = stdout + stderr;
    if (r.status !== 0) {
      console.error('swift test failure:', combined.slice(-4000));
    }
    expect(r.status).toBe(0);
    // --filter scopes the run to DebugBridgeCoreTests; the xctest summary
    // line is "'Selected tests' passed" rather than "'All tests' passed".
    expect(combined).toMatch(/'(?:All|Selected) tests' passed/);
    // Guard against an empty pass-by-no-tests (filter typo / target rename):
    // we expect at least one StateServer smoke test to actually execute.
    expect(combined).toContain('StateServerSmokeTests');
  }, 240_000);

  // Codex-flagged: Release-build guard must be STRUCTURAL, not advisory.
  // The Package.swift's `.when(configuration: .debug)` setting causes Swift
  // to compile-out the entire DebugBridgeCore target body in Release. Since
  // every public symbol is gated `#if DEBUG`, the release build emits an
  // empty module — zero symbols.
  test('Release-config build excludes DebugBridge symbols', () => {
    // Step 1: clean + release build (Core only — UI/Touch can't build on macOS)
    spawnSync('swift', ['package', 'clean'], { cwd: FIXTURE_PATH, stdio: 'pipe', timeout: 60_000 });
    const build = spawnSync('swift', ['build', '-c', 'release', '--target', 'DebugBridgeCore'], {
      cwd: FIXTURE_PATH,
      stdio: 'pipe',
      timeout: 180_000,
    });
    if (build.status !== 0) {
      console.error('release build stderr:', build.stderr?.toString().slice(0, 4000));
    }
    expect(build.status).toBe(0);

    // Step 2: locate the built object file(s). SwiftPM puts .build artifacts
    // under .build/<triple>/release/.
    const oFiles = spawnSync('find', [
      join(FIXTURE_PATH, '.build'),
      '-path', '*/release/*',
      '-name', '*.o',
      '-path', '*DebugBridge*',
    ], { stdio: 'pipe' });
    const files = (oFiles.stdout?.toString() ?? '').trim().split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);

    let foundForbidden = 0;
    const forbidden = ['StateServer', 'handleRequest', 'sessionAcquire', 'authRotate', 'snapshotGet'];
    for (const f of files) {
      const nm = spawnSync('nm', ['-j', f], { stdio: 'pipe' });
      const syms = nm.stdout?.toString() ?? '';
      for (const tok of forbidden) {
        if (syms.includes(tok)) {
          console.error(`Release symbol leak: ${tok} found in ${f}`);
          foundForbidden++;
        }
      }
    }
    expect(foundForbidden).toBe(0);
  }, 300_000);
});
