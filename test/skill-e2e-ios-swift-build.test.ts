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
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const FIXTURE_PATH = join(ROOT, 'test/fixtures/ios-qa/FixtureApp');
const TEMPLATES_PATH = join(ROOT, 'ios-qa/templates');
const GEN_ACCESSORS_PACKAGE = join(ROOT, 'ios-qa/scripts/gen-accessors-tool/Package.swift');

const COPIED_BRIDGE_TEMPLATES = [
  ['StateServer.swift.template', 'Sources/DebugBridgeCore/StateServer.swift'],
  ['DebugBridgeManager.swift.template', 'Sources/DebugBridgeCore/DebugBridgeManager.swift'],
  ['DebugOverlay.swift.template', 'Sources/DebugBridgeUI/DebugOverlay.swift'],
  ['Bridges.swift.template', 'Sources/DebugBridgeUI/Bridges.swift'],
  ['DebugBridgeTouch.h.template', 'Sources/DebugBridgeTouch/include/DebugBridgeTouch.h'],
  ['DebugBridgeTouch.m.template', 'Sources/DebugBridgeTouch/DebugBridgeTouch.m'],
] as const;

function readTemplate(name: string): string {
  return readFileSync(join(TEMPLATES_PATH, name), 'utf-8');
}

function normalizeBridgePackage(source: string): string {
  // Package.swift.template has a generated-file prologue while the fixture has
  // a fixture-specific one. The tools-version declaration must remain first in
  // both real files, but neither header is part of the copied bridge surface.
  const importOffset = source.indexOf('import PackageDescription');
  expect(importOffset).toBeGreaterThanOrEqual(0);
  let packageBody = source.slice(importOffset);

  // The fixture deliberately has its own package identity and XCTest target.
  // Normalize only those fixture concerns; all three bridge products, targets,
  // dependencies, settings, and paths must otherwise stay in lockstep.
  packageBody = packageBody.replace(
    /(let package = Package\(\s*name:)\s*"[^"]+"/,
    '$1 "<bridge-package>"',
  );
  packageBody = packageBody.replace(
    /\n\s*\.testTarget\(\s*\n\s*name:\s*"DebugBridgeCoreTests",[\s\S]*?\n\s{8}\),?/,
    '',
  );

  // Ignore prose and formatting so a template-only explanatory comment does
  // not conceal a meaningful manifest mismatch.
  return packageBody
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, '')
    .replace(/,([\])])/g, '$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bracedBlock(source: string, openBraceOffset: number): string {
  let depth = 0;
  for (let offset = openBraceOffset; offset < source.length; offset++) {
    if (source[offset] === '{') depth++;
    if (source[offset] !== '}') continue;
    depth--;
    if (depth === 0) return source.slice(openBraceOffset, offset + 1);
  }
  return '';
}

// The fixture is where the bridge is compiled and exercised end-to-end. Every
// source copied into consuming apps must therefore be the canonical template,
// or device QA can pass against code that /ios-qa never installs.
describe('template ↔ fixture parity', () => {
  for (const [templateName, fixtureDestination] of COPIED_BRIDGE_TEMPLATES) {
    test(`${templateName} matches ${fixtureDestination}`, () => {
      expect(readTemplate(templateName)).toBe(
        readFileSync(join(FIXTURE_PATH, fixtureDestination), 'utf-8'),
      );
    });
  }

  test('Package.swift bridge declarations match after fixture-only normalization', () => {
    const template = readTemplate('Package.swift.template');
    const fixture = readFileSync(join(FIXTURE_PATH, 'Package.swift'), 'utf-8');
    expect(normalizeBridgePackage(template)).toBe(normalizeBridgePackage(fixture));
  });

  test('Package.swift.template declares all 3 DebugBridge targets', () => {
    const tmpl = readTemplate('Package.swift.template');
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
    const tmpl = readTemplate('Package.swift.template');
    expect(tmpl.split(/\r?\n/, 1)[0]).toBe('// swift-tools-version:5.9');
  });
});

describe('iOS tap harness regressions', () => {
  test('manager receives app-owned generated accessors instead of a no-op package stub', () => {
    const manager = readTemplate('DebugBridgeManager.swift.template');
    const wiring = readTemplate('DebugBridgeWiring.swift.template');
    const fixtureApp = readFileSync(
      join(FIXTURE_PATH, 'Sources/FixtureApp/FixtureAppApp.swift'),
      'utf-8',
    );

    expect(manager).toContain('func start<State>');
    expect(manager).toContain('register: (State) -> Void');
    expect(manager).toContain('register(appState)');
    expect(manager).not.toContain('public enum AppStateAccessor');
    expect(manager).not.toContain('protocol AppState');

    expect(wiring).toContain('import DebugBridgeCore');
    expect(wiring).toContain('import DebugBridgeUI');
    expect(wiring).toContain('DebugBridgeUIWiring.installAll()');
    expect(wiring.indexOf('DebugBridgeUIWiring.installAll()')).toBeLessThan(
      wiring.indexOf('DebugBridgeManager.shared.start'),
    );
    expect(fixtureApp.indexOf('DebugBridgeUIWiring.installAll()')).toBeLessThan(
      fixtureApp.indexOf('DebugBridgeManager.shared.start'),
    );
    expect(wiring).not.toContain('import DebugBridge\n');
    expect(wiring).not.toContain('AccessibilityScanner');
    expect(wiring).not.toContain('MutationDispatcher');
  });

  test('fixture uses an @Observable-compatible source marker, not a property wrapper', () => {
    const state = readFileSync(
      join(FIXTURE_PATH, 'Sources/FixtureApp/FixtureAppState.swift'),
      'utf-8',
    );
    expect(state).toContain('@Observable');
    expect(state.match(/\/\/ @Snapshotable/g)?.length).toBe(4);
    expect(state).not.toContain('@propertyWrapper');
    expect(state).not.toMatch(/^[\t ]*@Snapshotable[\t ]+(?:public[\t ]+)?var/m);
  });

  test('recurses through iOS automation elements to expose nested SwiftUI controls', () => {
    const bridges = readTemplate('Bridges.swift.template');
    expect(bridges).toContain('element.automationElements');
    expect(bridges).toContain('debugBridgeAccessibilityChildren(of: element)');
    expect(bridges).toContain('visited.insert(ObjectIdentifier(element)).inserted');
    expect(bridges).toContain('var remaining = 2_048');
  });

  test('enables accessibility automation before SwiftUI AX is installed', () => {
    const implementation = readTemplate('DebugBridgeTouch.m.template');
    const bridges = readTemplate('Bridges.swift.template');
    const helper = [...implementation.matchAll(
      /static\s+void\s+([A-Za-z_]\w*)\s*\(\s*void\s*\)\s*\{/g,
    )].find((candidate) => {
      const body = bracedBlock(
        implementation,
        candidate.index! + candidate[0].lastIndexOf('{'),
      );
      return body.includes('_AXSAutomationEnabled') && body.includes('_AXSSetAutomationEnabled');
    });
    expect(helper).toBeDefined();

    const helperName = helper![1];
    const helperBody = bracedBlock(
      implementation,
      helper!.index! + helper![0].lastIndexOf('{'),
    );
    expect(helperBody).toContain('_AXSAutomationEnabled');
    expect(helperBody).toContain('_AXSSetAutomationEnabled');

    // Accept either Objective-C's eager +load hook or an explicit public
    // bootstrap selector, but require the enabling helper to be called before
    // Swift installs the resolver that walks SwiftUI's accessibility tree.
    const bootstrap = [...implementation.matchAll(/\+\s*\(void\)\s*([A-Za-z_]\w*)\s*\{/g)]
      .find((candidate) => bracedBlock(
        implementation,
        candidate.index! + candidate[0].lastIndexOf('{'),
      ).match(new RegExp(`\\b${escapeRegExp(helperName)}\\s*\\(`)));
    expect(bootstrap).toBeDefined();

    if (bootstrap![1] === 'load') {
      expect(bootstrap!.index!).toBeLessThan(implementation.indexOf('+ (BOOL)sendTapAtPoint:'));
    } else {
      const bootstrapCall = bridges.search(
        new RegExp(`DebugBridgeTouch\\.${escapeRegExp(bootstrap![1])}\\s*\\(`),
      );
      expect(bootstrapCall).toBeGreaterThanOrEqual(0);
      expect(bootstrapCall).toBeLessThan(bridges.indexOf('ElementsBridge.resolver'));
    }
  });

  test('renders screenshots at one pixel per window point', () => {
    const bridges = readTemplate('Bridges.swift.template');
    const declaration = bridges.match(
      /(?:let|var)\s+([A-Za-z_]\w*)\s*=\s*UIGraphicsImageRendererFormat(?:\.default)?\(\)/,
    );
    expect(declaration).not.toBeNull();

    const formatName = declaration![1];
    const scalePattern = new RegExp(`\\b${escapeRegExp(formatName)}\\.scale\\s*=\\s*1(?:\\.0)?\\b`);
    const rendererPattern = new RegExp(
      `UIGraphicsImageRenderer\\(\\s*bounds:\\s*bounds,\\s*format:\\s*${escapeRegExp(formatName)}\\s*\\)`,
    );
    const declarationOffset = declaration!.index!;
    const scaleOffset = bridges.search(scalePattern);
    const rendererOffset = bridges.search(rendererPattern);

    expect(scaleOffset).toBeGreaterThan(declarationOffset);
    expect(rendererOffset).toBeGreaterThan(scaleOffset);
  });

  test('uses accessibilityActivate for SwiftUI while retaining synthesized-touch delivery', () => {
    const bridges = readTemplate('Bridges.swift.template');
    const tapStart = bridges.indexOf('private static func handleTap');
    const tapEnd = bridges.indexOf('private static func handleType', tapStart);
    expect(tapStart).toBeGreaterThanOrEqual(0);
    expect(tapEnd).toBeGreaterThan(tapStart);
    const handleTap = bridges.slice(tapStart, tapEnd);

    const synthesizedTouchOffset = handleTap.indexOf('DebugBridgeTouch.sendTap');
    const fallbackCall = handleTap.match(
      /\b([A-Za-z_]\w*)\s*\(\s*at:\s*point\s*,\s*in:\s*window\s*\)/,
    );
    const activationOffset = handleTap.indexOf('.accessibilityActivate()');
    expect(synthesizedTouchOffset).toBeGreaterThanOrEqual(0);
    expect(fallbackCall).not.toBeNull();
    expect(activationOffset).toBeGreaterThan(fallbackCall!.index!);

    const fallbackName = fallbackCall![1];
    expect(bridges).toMatch(
      new RegExp(`(?:private\\s+)?static\\s+func\\s+${escapeRegExp(fallbackName)}\\s*\\(`),
    );
  });

  test('finishes programmatic scrolls before returning success to the next tap', () => {
    const bridges = readTemplate('Bridges.swift.template');
    expect(bridges).toContain('setContentOffset(off, animated: false)');
    expect(bridges).not.toContain('setContentOffset(off, animated: true)');
  });

  test('serializes accessibility traits without signed Int truncation', () => {
    const bridges = readTemplate('Bridges.swift.template');
    expect(bridges).toMatch(/\btraits\s*:\s*UInt64\b/);
    expect(bridges).toContain('.uint64Value');
    expect(bridges).not.toMatch(/\bInt(?:64)?\s*\(\s*view\.accessibilityTraits\.rawValue\s*\)/);
    expect(bridges).not.toMatch(/accessibilityTraits[\s\S]{0,120}?\.intValue\b/);
  });

  test('validates every generated model before applying any snapshot state', () => {
    const server = readTemplate('StateServer.swift.template');
    const validationLoop = server.indexOf('for restore in atomicRestores');
    const applyComment = server.indexOf('Phase two applies only after every model accepted');
    const applyLoop = server.indexOf('for restore in atomicRestores', validationLoop + 1);

    expect(server).toContain('typealias AtomicRestoreFn = (JSONDict, Bool) -> RestoreResult');
    expect(server).toContain('restore(keys, false)');
    expect(server).toContain('restore(keys, true)');
    expect(validationLoop).toBeGreaterThanOrEqual(0);
    expect(applyComment).toBeGreaterThan(validationLoop);
    expect(applyLoop).toBeGreaterThan(applyComment);
  });

  test('turns non-JSON response bodies into an explicit HTTP 500', () => {
    const server = readTemplate('StateServer.swift.template');
    expect(server).toContain('JSONSerialization.isValidJSONObject(body)');
    expect(server).toContain('responseStatus = 500');
    expect(server).toContain('response_not_json_serializable');
    expect(server).not.toContain('?? Data("{}".utf8)');
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
