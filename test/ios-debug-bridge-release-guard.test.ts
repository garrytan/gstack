import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Static tripwire (free tier, runs on every PR): the private-API ObjC touch
// bridge MUST compile out of Release builds. v1.67.0.0 landed the enforcement
// (measured on a real app: `nm -j` on a Release binary previously returned 15
// DebugBridge symbols incl. IOHIDEventCreateDigitizer — a Guideline 2.5.1
// private-API exposure); this tripwire pins its two load-bearing halves
// against regression:
//
//   1. DebugBridgeTouch.m short-circuits Release FIRST: `#if !defined(DEBUG)`
//      emits an empty translation unit, and the implementation lives behind
//      `#elif TARGET_OS_IOS`. A revert to a bare platform-only `#if
//      TARGET_OS_IOS` gate (the original regression) ships the private
//      symbols in Release again.
//   2. The DebugBridgeTouch target in Package.swift carries a cSettings
//      DEBUG define scoped to the debug configuration — SwiftPM's implicit
//      DEBUG for C-family targets is not guaranteed, and without the define
//      `#if DEBUG` is false even in Debug, silently breaking the bridge in
//      the one case it exists to serve.
//
// The full proof — an iOS-SDK Release build asserting `nm`/`strings` of the
// built binary contain none of _touchesEvent / IOHIDEventCreateDigitizer* /
// _AXSSetAutomationEnabled / DebugBridgeTouch — needs an iOS builder and lives
// in the device/periodic tier (the macOS `swift build` lane can't build the
// Touch target). This tripwire guards the source-level invariant everywhere.

const ROOT = path.resolve(import.meta.dir, '..');

const TOUCH_SOURCES = [
  'ios-qa/templates/DebugBridgeTouch.m.template',
  'test/fixtures/ios-qa/FixtureApp/Sources/DebugBridgeTouch/DebugBridgeTouch.m',
];

const PACKAGE_MANIFESTS = [
  'ios-qa/templates/Package.swift.template',
  'test/fixtures/ios-qa/FixtureApp/Package.swift',
];

describe('DebugBridgeTouch Release compile-out guard', () => {
  for (const rel of TOUCH_SOURCES) {
    test(`${rel} short-circuits Release before any platform gate`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // Release short-circuit first, implementation behind the elif.
      expect(src).toContain('#if !defined(DEBUG)');
      expect(src).toContain('#elif TARGET_OS_IOS');
      // The Release branch must come BEFORE the platform branch — order is the
      // property (a platform-first gate compiled private API into Release).
      expect(src.indexOf('#if !defined(DEBUG)')).toBeLessThan(src.indexOf('#elif TARGET_OS_IOS'));
      // And no bare platform-only guard may reappear as the body gate — that
      // was the exact regression (private API shipped in Release).
      expect(src).not.toMatch(/^#if TARGET_OS_IOS$/m);
    });
  }

  for (const rel of PACKAGE_MANIFESTS) {
    test(`${rel} defines DEBUG for the DebugBridgeTouch target in debug config`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      // Anchor on the target's unique `path:` (the `name:` string also appears
      // in the products/.library section). The DEBUG cSettings define sits just
      // after the path line; take a forward window to the next .target( (or end)
      // so the assertion is scoped to THIS target, not the whole manifest.
      const anchor = src.indexOf('path: "Sources/DebugBridgeTouch"');
      expect(anchor).toBeGreaterThan(-1);
      const rest = src.slice(anchor);
      const nextTarget = rest.indexOf('.target(');
      const block = nextTarget > -1 ? rest.slice(0, nextTarget) : rest;
      expect(block).toContain('cSettings:');
      expect(block).toMatch(/\.define\("DEBUG",\s*\.when\(configuration:\s*\.debug\)\)/);
    });
  }
});
