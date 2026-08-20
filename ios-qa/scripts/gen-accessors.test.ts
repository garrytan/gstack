// Tests for the gen-accessors TS port. Covers:
//
//   - Parse: lexical marker isolation + invalid declaration diagnostics
//   - Cache: same input → same key; different swift version → different key;
//     different tool rev/build provenance → different key
//   - Schema: stable hash depends only on ordered accessor signatures
//   - Optional: NSNull read/write/restore behavior and Swift type checking
//   - Prune: >30d entries removed, recent kept

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectSwiftFiles,
  parseSwift,
  computeCacheKey,
  computeAccessorHash,
  generate,
  pruneCache,
  render,
  AccessorGenerationError,
  type AccessorSpec,
} from './gen-accessors';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'gen-accessors-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('parseSwift — fork regex-failure-mode fixtures', () => {
  test('parses @Observable class with source-marker comments', () => {
    const src = `
@Observable
final class AppState {
    // @Snapshotable
    var isLoggedIn: Bool = false
    // @Snapshotable
    var username: String = ""
    var notSnapshotable: Int = 0
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.className).toBe('AppState');
    expect(specs[0]!.fields.map(f => f.name)).toEqual(['isLoggedIn', 'username']);
    expect(specs[0]!.fields.find(f => f.name === 'isLoggedIn')!.typeText).toBe('Bool');
  });

  test('retains legacy @Snapshotable attribute parsing', () => {
    const specs = parseSwift(`
@Observable
final class LegacyState {
    @Snapshotable var counter: Int = 0
}
`);
    expect(specs).toEqual([{
      className: 'LegacyState',
      fields: [{ name: 'counter', typeText: 'Int' }],
    }]);
  });

  test('does not treat documentation prose as a source marker', () => {
    const specs = parseSwift(`
@Observable
final class PrivateState {
    /// Do not expose this field through @Snapshotable.
    var token: String = "secret"
}
`);
    expect(specs).toHaveLength(0);
  });

  test('does not let a trailing marker comment bleed into the next field', () => {
    const specs = parseSwift(`
@Observable
final class PrivateState {
    var oldValue: Int = 0 // @Snapshotable
    var nextValue: Int = 1
}
`);
    expect(specs).toHaveLength(0);
  });

  test('ignores exact-looking markers inside nested block comments', () => {
    const specs = parseSwift(`
@Observable
final class PrivateState {
    /*
      /* // @Snapshotable */
      // @Snapshotable
      var leaked: String = "secret"
    */
    // @Snapshotable
    var visible: Int = 1
}
`);
    expect(specs).toEqual([{
      className: 'PrivateState',
      fields: [{ name: 'visible', typeText: 'Int' }],
    }]);
  });

  test('ignores declarations and markers inside multiline and raw strings', () => {
    const specs = parseSwift(`
let ordinary = """
@Observable class FakeA {
  // @Snapshotable
  var leaked: Int = 0
}
"""
let raw = #"""
@Observable class FakeB { @Snapshotable var leaked: String = "" }
"""#
@Observable
final class RealState {
  // @Snapshotable
  var safe: Bool = true
}
`);
    expect(specs).toEqual([{
      className: 'RealState',
      fields: [{ name: 'safe', typeText: 'Bool' }],
    }]);
  });

  test('ignores marker words in standalone trailing prose', () => {
    const specs = parseSwift(`
@Observable
final class PrivateState {
    // @Snapshotable fields are intentionally disabled here.
    var token: String = "secret"
}
`);
    expect(specs).toHaveLength(0);
  });

  test('handles @Snapshotable on multi-line type signatures', () => {
    const src = `
@Observable
class Cart {
    @Snapshotable var items:
        [Dictionary<String, [Int]>]
        = []
    var unrelated: Int = 0
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.fields).toHaveLength(1);
    expect(specs[0]!.fields[0]!.name).toBe('items');
    expect(specs[0]!.fields[0]!.typeText).toContain('Dictionary');
  });

  test('handles JSON-compatible generic types in property signatures', () => {
    const src = `
@Observable
class Repo {
    @Snapshotable var pages: Dictionary<String, [Optional<Int>]> = [:]
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.fields[0]!.typeText).toContain('Dictionary');
    expect(specs[0]!.fields[0]!.typeText).toContain('Optional');
  });

  test('accepts qualified JSON-native scalar and collection spellings', () => {
    const specs = parseSwift(`
@Observable
class Metrics {
    // @Snapshotable
    var ratio: CoreGraphics.CGFloat = 0
    // @Snapshotable
    var counts: Swift.Array<Swift.Int> = []
}
`);
    expect(specs[0]!.fields.map((field) => field.typeText)).toEqual([
      'CoreGraphics.CGFloat',
      'Swift.Array<Swift.Int>',
    ]);
  });

  test('rejects custom values that Foundation JSON cannot serialize', () => {
    expect(() => parseSwift(`
@Observable
class Repo {
    // @Snapshotable
    var pages: Dictionary<String, [Result<Item, Error>]> = [:]
}
`)).toThrow("unsupported snapshot type 'Result<Item,Error>'");
  });

  test('rejects nested observable types instead of emitting an unqualified reference', () => {
    expect(() => parseSwift(`
enum Namespace {
    @Observable
    class State {
        // @Snapshotable
        var count: Int = 0
    }
}
`)).toThrow('nested @Observable types are not supported');
  });

  test('ignores nested observable types that expose no snapshot fields', () => {
    expect(parseSwift(`
enum Namespace {
    @Observable
    class State { var transient: Int = 0 }
}
`)).toEqual([]);
  });

  test('ignores fields without @Snapshotable marker', () => {
    const src = `
@Observable
class M {
    var plain: Int = 0
    @State var stateBacked: String = ""
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(0);
  });

  test('ignores non-@Observable classes', () => {
    const src = `
class Plain {
    @Snapshotable var should: Int = 0
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(0);
  });

  test('handles multiple @Observable classes in one file', () => {
    const src = `
@Observable
class A {
    @Snapshotable var a: Int = 0
}
@Observable
class B {
    @Snapshotable var b: String = ""
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.className).sort()).toEqual(['A', 'B']);
  });

  test('diagnoses fields with computed body braces', () => {
    const src = `
@Observable
class M {
    @Snapshotable var snapshotted: Int = 0
    @Snapshotable var computed: Int {
        get { 42 }
    }
}
`;
    expect(() => parseSwift(src)).toThrow("field 'computed' must be stored and writable");
  });

  test.each([
    ['let', '// @Snapshotable\n let immutable: Int = 1', 'must be declared var, not let'],
    ['private', '// @Snapshotable\n private var secret: String = ""', 'cannot be private'],
    ['fileprivate', '// @Snapshotable\n fileprivate var secret: String = ""', 'cannot be private'],
    ['private(set)', '// @Snapshotable\n public private(set) var count: Int = 0', 'cannot be private'],
    ['fileprivate(set)', '// @Snapshotable\n fileprivate(set) var count: Int = 0', 'cannot be private'],
    ['inferred type', '// @Snapshotable\n var inferred = 42', 'requires an explicit type annotation'],
    ['multiple bindings', '// @Snapshotable\n var a: Int = 1, b: Int = 2', 'exactly one binding'],
    ['static', '// @Snapshotable\n static var shared: Int = 0', 'must be an instance property'],
    ['nested Optional', '// @Snapshotable\n var nested: String?? = nil', 'cannot use a nested Optional'],
    ['nested Optional in collection', '// @Snapshotable\n var nestedItems: [String??] = []', 'cannot use a nested Optional'],
    ['implicitly unwrapped Optional', '// @Snapshotable\n var legacy: String! = nil', 'cannot use an implicitly unwrapped Optional'],
    ['custom type', '// @Snapshotable\n var custom: CustomValue = .init()', 'uses unsupported snapshot type'],
  ])('diagnoses invalid %s declarations', (_label, declaration, expected) => {
    expect(() => parseSwift(`
@Observable
final class InvalidState {
  ${declaration}
}
`)).toThrow(expected);
  });

  test('aggregates invalid declaration diagnostics with class and line context', () => {
    try {
      parseSwift(`
@Observable
final class InvalidState {
  // @Snapshotable
  let first: Int = 1
  // @Snapshotable
  private var second: String = ""
}
`);
      throw new Error('expected parseSwift to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AccessorGenerationError);
      const generationError = error as AccessorGenerationError;
      expect(generationError.diagnostics).toHaveLength(2);
      expect(generationError.message).toContain('InvalidState (line 4)');
      expect(generationError.message).toContain('InvalidState (line 6)');
    }
  });
});

describe('computeCacheKey', () => {
  test('same source + same versioning = same key', () => {
    const f = join(workDir, 'a.swift');
    writeFileSync(f, '@Observable class A {}');
    const k1 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc123',
      platformTriple: 'darwin-arm64',
    });
    const k2 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc123',
      platformTriple: 'darwin-arm64',
    });
    expect(k1).toBe(k2);
  });

  test('source modification changes the key', () => {
    const f = join(workDir, 'a.swift');
    writeFileSync(f, '@Observable class A {}');
    const k1 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc123',
      platformTriple: 'darwin-arm64',
    });
    writeFileSync(f, '@Observable class A { @Snapshotable var x: Int = 0 }');
    const k2 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc123',
      platformTriple: 'darwin-arm64',
    });
    expect(k1).not.toBe(k2);
  });

  test('swift version change invalidates the key (codex catch)', () => {
    const f = join(workDir, 'a.swift');
    writeFileSync(f, '@Observable class A {}');
    const k1 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '5.9.0',
      toolGitRev: 'abc',
      platformTriple: 'darwin-arm64',
    });
    const k2 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc',
      platformTriple: 'darwin-arm64',
    });
    expect(k1).not.toBe(k2);
  });

  test('generator git rev change invalidates the key (codex catch)', () => {
    const f = join(workDir, 'a.swift');
    writeFileSync(f, '@Observable class A {}');
    const k1 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc123',
      platformTriple: 'darwin-arm64',
    });
    const k2 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'def456',
      platformTriple: 'darwin-arm64',
    });
    expect(k1).not.toBe(k2);
  });

  test('platform triple change invalidates the key', () => {
    const f = join(workDir, 'a.swift');
    writeFileSync(f, '@Observable class A {}');
    const k1 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc',
      platformTriple: 'darwin-arm64',
    });
    const k2 = computeCacheKey({
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc',
      platformTriple: 'darwin-x86_64',
    });
    expect(k1).not.toBe(k2);
  });

  test('adding/removing files invalidates the key', () => {
    const f1 = join(workDir, 'a.swift');
    const f2 = join(workDir, 'b.swift');
    writeFileSync(f1, '@Observable class A {}');
    writeFileSync(f2, '@Observable class B {}');
    const k1 = computeCacheKey({
      swiftFiles: [f1],
      swiftVersion: '6.0.0',
      toolGitRev: 'a',
      platformTriple: 'd-arm64',
    });
    const k2 = computeCacheKey({
      swiftFiles: [f1, f2],
      swiftVersion: '6.0.0',
      toolGitRev: 'a',
      platformTriple: 'd-arm64',
    });
    expect(k1).not.toBe(k2);
  });

  test('app build provenance invalidates the cache key', () => {
    const f = join(workDir, 'a.swift');
    writeFileSync(f, '@Observable class A {}');
    const shared = {
      swiftFiles: [f],
      swiftVersion: '6.0.0',
      toolGitRev: 'abc',
      platformTriple: 'darwin-arm64',
    };
    expect(computeCacheKey({ ...shared, buildId: '100' })).not.toBe(
      computeCacheKey({ ...shared, buildId: '101' }),
    );
  });

  test('equivalent source content does not depend on its absolute checkout path', () => {
    const firstDir = join(workDir, 'checkout-a');
    const secondDir = join(workDir, 'checkout-b');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const first = join(firstDir, 'State.swift');
    const second = join(secondDir, 'State.swift');
    writeFileSync(first, '@Observable class A {}');
    writeFileSync(second, '@Observable class A {}');
    const versioning = { swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' };
    expect(computeCacheKey({ swiftFiles: [first], ...versioning })).toBe(
      computeCacheKey({ swiftFiles: [second], ...versioning }),
    );
  });
});

describe('computeAccessorHash', () => {
  const base: AccessorSpec[] = [{
    className: 'AppState',
    fields: [
      { name: 'count', typeText: 'Int' },
      { name: 'nickname', typeText: 'String?' },
    ],
  }];

  test('is deterministic for the same ordered accessor signatures', () => {
    expect(computeAccessorHash(base)).toBe(computeAccessorHash(structuredClone(base)));
  });

  test('changes when field order, name, or type changes', () => {
    const reordered: AccessorSpec[] = [{
      className: 'AppState',
      fields: [...base[0]!.fields].reverse(),
    }];
    const renamed: AccessorSpec[] = [{
      className: 'AppState',
      fields: [{ name: 'total', typeText: 'Int' }, base[0]!.fields[1]!],
    }];
    const retyped: AccessorSpec[] = [{
      className: 'AppState',
      fields: [{ name: 'count', typeText: 'Int64' }, base[0]!.fields[1]!],
    }];
    const hash = computeAccessorHash(base);
    expect(computeAccessorHash(reordered)).not.toBe(hash);
    expect(computeAccessorHash(renamed)).not.toBe(hash);
    expect(computeAccessorHash(retyped)).not.toBe(hash);
  });
});

describe('generate', () => {
  test('first run writes StateAccessor.swift and populates cache', () => {
    const inputDir = join(workDir, 'src');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'state.swift'), `
@Observable
class AppState {
  @Snapshotable var x: Int = 0
}
`);
    const cacheRoot = join(workDir, 'cache');
    const r = generate({
      inputDir,
      cacheRoot,
      swiftVersion: '6.0.0',
      toolGitRev: 'test',
      platformTriple: 'darwin-arm64',
    });
    expect(r.cacheHit).toBe(false);
    expect(r.specs).toHaveLength(1);
    expect(r.specs[0]!.className).toBe('AppState');
    expect(existsSync(r.outputPath)).toBe(true);
    expect(existsSync(join(cacheRoot, r.cacheKey, 'StateAccessor.swift'))).toBe(true);
  });

  test('second run with same inputs hits the cache', () => {
    const inputDir = join(workDir, 'src');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'state.swift'), '@Observable class A { @Snapshotable var x: Int = 0 }');
    const cacheRoot = join(workDir, 'cache');
    const r1 = generate({ inputDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' });
    const r2 = generate({ inputDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' });
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r1.cacheKey).toBe(r2.cacheKey);
  });

  test('custom nested output subtree cannot poison the second-run cache key', () => {
    const inputDir = join(workDir, 'src');
    const outputDir = join(inputDir, 'generated', 'accessors');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'state.swift'), '@Observable class A { @Snapshotable var x: Int = 0 }');
    const cacheRoot = join(workDir, 'cache');

    const r1 = generate({
      inputDir,
      outputDir,
      cacheRoot,
      swiftVersion: '6',
      toolGitRev: 't',
      platformTriple: 'p',
    });
    writeFileSync(join(outputDir, 'Ignored.swift'), '@Observable class Poison { @Snapshotable var bad: Int = 1 }');
    const r2 = generate({
      inputDir,
      outputDir,
      cacheRoot,
      swiftVersion: '6',
      toolGitRev: 't',
      platformTriple: 'p',
    });

    expect(r2.cacheHit).toBe(true);
    expect(r2.cacheKey).toBe(r1.cacheKey);
  });

  test('modifying source invalidates the cache', () => {
    const inputDir = join(workDir, 'src');
    mkdirSync(inputDir);
    const file = join(inputDir, 'state.swift');
    writeFileSync(file, '@Observable class A { @Snapshotable var x: Int = 0 }');
    const cacheRoot = join(workDir, 'cache');
    const r1 = generate({ inputDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' });
    writeFileSync(file, '@Observable class A { @Snapshotable var y: String = "" }');
    const r2 = generate({ inputDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' });
    expect(r1.cacheKey).not.toBe(r2.cacheKey);
    expect(r2.cacheHit).toBe(false);
  });

  test('unmarked source churn changes cache identity but not schema identity', () => {
    const inputDir = join(workDir, 'src');
    mkdirSync(inputDir);
    const state = join(inputDir, 'state.swift');
    const unrelated = join(inputDir, 'unrelated.swift');
    writeFileSync(state, '@Observable class A { // @Snapshotable\n var x: Int = 0\n }');
    writeFileSync(unrelated, 'struct Unrelated { let a = 1 }');
    const cacheRoot = join(workDir, 'cache');
    const options = { inputDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' };
    const first = generate(options);
    writeFileSync(unrelated, 'struct Unrelated { let a = 2 }');
    const second = generate(options);
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.accessorHash).toBe(first.accessorHash);
  });

  test('buildId changes cannot reuse generated fallback provenance', () => {
    const inputDir = join(workDir, 'src');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'state.swift'), '@Observable class A { @Snapshotable var x: Int = 0 }');
    const cacheRoot = join(workDir, 'cache');
    const shared = { inputDir, cacheRoot, swiftVersion: '6', toolGitRev: 't', platformTriple: 'p' };
    const first = generate({ ...shared, buildId: 'build-100' });
    const second = generate({ ...shared, buildId: 'build-101' });
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.cacheHit).toBe(false);
    expect(readFileSync(second.outputPath, 'utf8')).toContain('?? "build-101"');
  });

  test('CLI exits 4 with actionable diagnostics and no generated output', () => {
    const inputDir = join(workDir, 'src');
    const outputDir = join(workDir, 'generated');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'state.swift'), `
@Observable final class InvalidState {
  // @Snapshotable
  private let secret = "nope"
}
`);
    const result = spawnSync('bun', [
      join(import.meta.dir, 'gen-accessors.ts'),
      '--input', inputDir,
      '--output', outputDir,
    ], {
      encoding: 'utf8',
      env: { ...process.env, GSTACK_IOS_CACHE_ROOT: join(workDir, 'cache') },
    });
    expect(result.status).toBe(4);
    // `let` is diagnosed first; either way the class/property is named and
    // generation never emits an accessor that will fail in xcodebuild.
    expect(result.stderr).toContain('InvalidState');
    expect(result.stderr).toContain("field 'secret' must be declared var, not let");
    expect(result.stderr).not.toContain('AccessorGenerationError:');
    expect(existsSync(join(outputDir, 'StateAccessor.swift'))).toBe(false);
  });
});

describe('pruneCache', () => {
  test('removes entries older than 30d, keeps recent', () => {
    const cacheRoot = join(workDir, 'cache');
    mkdirSync(cacheRoot, { recursive: true });
    const old = join(cacheRoot, 'old-key');
    const fresh = join(cacheRoot, 'fresh-key');
    mkdirSync(old);
    mkdirSync(fresh);
    writeFileSync(join(old, 'StateAccessor.swift'), '// old');
    writeFileSync(join(fresh, 'StateAccessor.swift'), '// fresh');

    // Backdate the old dir by 60 days.
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, sixtyDaysAgo, sixtyDaysAgo);

    const { pruned } = pruneCache(cacheRoot, 30);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toBe(old);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('no-op on empty cache dir', () => {
    const { pruned } = pruneCache(join(workDir, 'nope'), 30);
    expect(pruned).toHaveLength(0);
  });
});

describe('render', () => {
  test('emits valid-looking Swift for one class with two fields', () => {
    const specs: AccessorSpec[] = [{
      className: 'AppState',
      fields: [{ name: 'a', typeText: 'Int' }, { name: 'b', typeText: 'String' }],
    }];
    const out = render(specs, 'build-1.2.3', 'hash-abc');
    expect(out).toContain('enum AppStateAccessor');
    expect(out).not.toContain('public enum AppStateAccessor');
    expect(out).toContain('static func register(_ state: AppState)');
    expect(out).not.toContain('public static func register(_ state: AppState)');
    expect(out).toContain('key: "a"');
    expect(out).toContain('key: "b"');
    expect(out).toContain('return .missingKey("a")');
    expect(out).toContain('return .typeMismatch("b")');
    expect(out).toContain('guard let restored0 = Self.decodeSnapshotValue(raw0, as: Int.self)');
    expect(out).toContain('guard let restored1 = Self.decodeSnapshotValue(raw1, as: String.self)');
    expect(out).toContain('atomicRestore: { keys, apply in');
    expect(out).toContain('if apply {');
    expect(out).toContain('state.a = restored0');
    expect(out).toContain('state.b = restored1');
    expect(out.indexOf('state.a = restored0')).toBeGreaterThan(out.indexOf('guard let restored1'));
    expect(out).toContain('guard let typed = Self.decodeSnapshotValue(value, as: Int.self) else { return false }');
    expect(out).toContain('state.a = typed');
    expect(out).toContain('return true');
    expect(out).not.toContain('atomicRestore: { _ in .ok }');
    expect(out).not.toContain('write: { _ in false }');
    expect(out).toContain('CFBundleShortVersionString');
    expect(out).toContain('CFBundleVersion');
    expect(out).toContain('return shortVersion ?? bundleVersion ?? "build-1.2.3"');
    expect(out).toContain('accessorHash: "hash-abc"');
    expect(out).toContain('import DebugBridgeCore');
    expect(out).not.toContain('import DebugBridge\n');
    expect(out).toContain('#if DEBUG');
    expect(out).toContain('#endif');
  });

  test('emits explicit NSNull round-trip handling for Optional fields', () => {
    const out = render([{
      className: 'AppState',
      fields: [
        { name: 'nickname', typeText: 'String?' },
        { name: 'selection', typeText: 'Optional<Int>' },
      ],
    }], 'build', 'schema');

    expect(out).toContain('let restored0: String?');
    expect(out).toContain('if raw0 is NSNull');
    expect(out).toContain('else if let typed = Self.decodeSnapshotValue(raw0, as: String.self)');
    expect(out).toContain('let restored1: Optional<Int>');
    expect(out).toContain('else if let typed = Self.decodeSnapshotValue(raw1, as: Int.self)');
    expect(out).toContain('guard let value = state.nickname else { return NSNull() }');
    expect(out).toContain('if value is NSNull');
    expect(out).toContain('state.nickname = nil');
    expect(out).not.toContain('value as? String?');
  });

  test('rejects duplicate snapshot keys across observable models', () => {
    expect(() => render([
      { className: 'FirstState', fields: [{ name: 'count', typeText: 'Int' }] },
      { className: 'SecondState', fields: [{ name: 'count', typeText: 'Int' }] },
    ], 'build', 'schema')).toThrow("snapshot key 'count' is declared by both FirstState and SecondState");
  });

  test('typechecks beside an internal @Observable app state using a comment marker', () => {
    if (spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status !== 0) return;

    const coreSource = join(workDir, 'DebugBridgeCore.swift');
    const coreModule = join(workDir, 'DebugBridgeCore.swiftmodule');
    writeFileSync(coreSource, `
public typealias JSONDict = [String: Any]

@MainActor
public final class StateServer {
    public static let shared = StateServer()
    public enum RestoreResult {
        case ok
        case missingKey(String)
        case typeMismatch(String)
    }
    private init() {}
    public func register(
        buildId: String,
        accessorHash: String,
        atomicRestore: @escaping (JSONDict, Bool) -> RestoreResult
    ) {}
    public func registerAccessor(
        key: String,
        type: String,
        read: @escaping () -> Any?,
        write: @escaping (Any) -> Bool
    ) {}
}
`);
    const emitModule = spawnSync('swiftc', [
      '-emit-module',
      '-parse-as-library',
      '-module-name', 'DebugBridgeCore',
      coreSource,
      '-emit-module-path', coreModule,
    ], { encoding: 'utf8' });
    if (emitModule.status !== 0) {
      throw new Error(`failed to build DebugBridgeCore test stub:\n${emitModule.stderr}`);
    }

    const appSource = join(workDir, 'AppState.swift');
    writeFileSync(appSource, `import Observation

@Observable
final class AppState {
    // @Snapshotable
    var counter: Int = 0
}

${render([{
      className: 'AppState',
      fields: [{ name: 'counter', typeText: 'Int' }],
    }], 'build-test', 'hash-test')}`);
    const typecheck = spawnSync('swiftc', [
      '-typecheck',
      '-D', 'DEBUG',
      '-I', workDir,
      appSource,
    ], { encoding: 'utf8' });
    if (typecheck.status !== 0) {
      throw new Error(`generated accessor failed Swift type checking:\n${typecheck.stderr}`);
    }
  });

  test('strict JSON typing and cross-model validate-before-apply restore run correctly', () => {
    if (process.platform !== 'darwin') return;
    if (spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status !== 0) return;

    const coreSource = join(workDir, 'DebugBridgeCore.swift');
    const coreModule = join(workDir, 'DebugBridgeCore.swiftmodule');
    const coreLibrary = join(workDir, 'libDebugBridgeCore.dylib');
    writeFileSync(coreSource, `
public typealias JSONDict = [String: Any]

@MainActor
public final class StateServer {
    public typealias Restore = (JSONDict, Bool) -> RestoreResult
    public enum RestoreResult { case ok, missingKey(String), typeMismatch(String) }
    public static let shared = StateServer()
    public var restores: [Restore] = []
    public var reads: [String: () -> Any?] = [:]
    public var writes: [String: (Any) -> Bool] = [:]
    private init() {}
    public func register(buildId: String, accessorHash: String, atomicRestore: @escaping Restore) {
        restores.append(atomicRestore)
    }
    public func registerAccessor(
        key: String,
        type: String,
        read: @escaping () -> Any?,
        write: @escaping (Any) -> Bool
    ) {
        reads[key] = read
        writes[key] = write
    }
    public func restoreAll(_ keys: JSONDict) -> RestoreResult {
        for restore in restores {
            let result = restore(keys, false)
            guard case .ok = result else { return result }
        }
        for restore in restores {
            let result = restore(keys, true)
            guard case .ok = result else { return result }
        }
        return .ok
    }
}
`);
    const emitCore = spawnSync('swiftc', [
      '-emit-library', '-emit-module', '-parse-as-library',
      '-module-name', 'DebugBridgeCore', coreSource,
      '-emit-module-path', coreModule,
      '-o', coreLibrary,
    ], { encoding: 'utf8' });
    if (emitCore.status !== 0) throw new Error(`failed to build runtime stub:\n${emitCore.stderr}`);

    const appSource = join(workDir, 'OptionalRoundTrip.swift');
    writeFileSync(appSource, `
import Foundation
import Observation
import DebugBridgeCore

@Observable
final class AppState {
    // @Snapshotable
    var nickname: String? = nil
    // @Snapshotable
    var count: Int = 1
}

@Observable
final class FeatureState {
    // @Snapshotable
    var enabled: Bool = false
}

${render([
      {
        className: 'AppState',
        fields: [
          { name: 'nickname', typeText: 'String?' },
          { name: 'count', typeText: 'Int' },
        ],
      },
      {
        className: 'FeatureState',
        fields: [{ name: 'enabled', typeText: 'Bool' }],
      },
    ], 'fallback-build', 'schema-hash')}

@main
struct Runner {
    @MainActor static func main() {
        let state = AppState()
        let feature = FeatureState()
        AppStateAccessor.register(state)
        FeatureStateAccessor.register(feature)
        guard StateServer.shared.reads["nickname"]?() is NSNull else { fatalError("nil read") }
        guard StateServer.shared.writes["nickname"]?("Ada") == true, state.nickname == "Ada" else {
            fatalError("optional write")
        }
        guard StateServer.shared.writes["nickname"]?(NSNull()) == true, state.nickname == nil else {
            fatalError("null write")
        }
        guard StateServer.shared.writes["count"]?(true) == false, state.count == 1 else {
            fatalError("boolean must not coerce to integer")
        }
        guard StateServer.shared.writes["enabled"]?(1) == false, feature.enabled == false else {
            fatalError("integer must not coerce to boolean")
        }
        let valid = try! JSONSerialization.jsonObject(
            with: Data(#"{"nickname":"Grace","count":7,"enabled":true}"#.utf8)
        ) as! JSONDict
        switch StateServer.shared.restoreAll(valid) {
        case .ok: break
        default: fatalError("valid restore")
        }
        guard state.nickname == "Grace", state.count == 7, feature.enabled else { fatalError("restore values") }
        switch StateServer.shared.restoreAll(["nickname": NSNull(), "count": 8, "enabled": false]) {
        case .ok: break
        default: fatalError("null restore")
        }
        guard state.nickname == nil, state.count == 8, !feature.enabled else { fatalError("null restore values") }
        state.nickname = "unchanged"
        state.count = 9
        feature.enabled = false
        switch StateServer.shared.restoreAll(["nickname": "would-partially-apply", "count": 10, "enabled": 1]) {
        case .typeMismatch("enabled"): break
        default: fatalError("expected mismatch")
        }
        guard state.nickname == "unchanged", state.count == 9, !feature.enabled else { fatalError("cross-model partial mutation") }
    }
}
`);
    const executable = join(workDir, 'optional-round-trip');
    const compile = spawnSync('swiftc', [
      '-D', 'DEBUG', '-I', workDir, '-L', workDir, '-lDebugBridgeCore',
      '-parse-as-library', appSource, '-o', executable,
    ], { encoding: 'utf8' });
    if (compile.status !== 0) throw new Error(`generated Optional accessor failed compilation:\n${compile.stderr}`);
    const run = spawnSync(executable, [], {
      encoding: 'utf8',
      env: { ...process.env, DYLD_LIBRARY_PATH: workDir },
    });
    if (run.status !== 0) throw new Error(`generated Optional accessor failed at runtime:\n${run.stderr}`);
  });
});

describe('SwiftSyntax generator parity', () => {
  test('isolates canonical markers and rejects inaccessible fields', () => {
    if (process.platform !== 'darwin') return;
    if (spawnSync('swift', ['--version'], { encoding: 'utf8' }).status !== 0) return;

    const packageDir = join(import.meta.dir, 'gen-accessors-tool');
    const inputDir = join(workDir, 'swift-syntax-input');
    const outputDir = join(workDir, 'swift-syntax-output');
    const cacheRoot = join(workDir, 'swift-syntax-cache');
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, 'State.swift'), `
import Observation
@Observable
final class ToolState {
    let documentation = """
    // @Snapshotable
    var stringLeak: String = "no"
    """
    /* // @Snapshotable */
    var blockLeak: Int = 1
    var trailingLeak: Int = 2 // @Snapshotable
    // prose about @Snapshotable must not opt in
    var proseLeak: Int = 3
    // @Snapshotable
    var nickname: String? = nil
    // @Snapshotable
    var names:
        [String]
        = []
    // @Snapshotable
    var count: Int = 0
    // @Snapshotable
    var enabled: Bool = false
}
`);
    const env = {
      ...process.env,
      GSTACK_IOS_CACHE_ROOT: cacheRoot,
      APP_BUILD_ID: 'syntax-test-build',
      GEN_ACCESSORS_REV: 'syntax-test-v5',
    };
    const run = spawnSync('swift', [
      'run', '--package-path', packageDir, 'gen-accessors',
      '--input', inputDir, '--output', outputDir,
    ], { encoding: 'utf8', env, timeout: 180_000 });
    if (run.status !== 0) throw new Error(`SwiftSyntax generator failed:\n${run.stderr}`);
    const output = readFileSync(join(outputDir, 'StateAccessor.swift'), 'utf8');
    expect(output).toContain('key: "nickname"');
    expect(output).toContain('key: "names"');
    expect(output).toContain('key: "count"');
    expect(output).toContain('key: "enabled"');
    expect(output).toContain('_GStackDebugBridgeSnapshotJSON.decode(raw0');
    expect(output).toContain('atomicRestore: { keys, apply in');
    expect(output).toContain('if apply {');
    expect(output).not.toMatch(/raw\d+ as\?/);
    expect(output).toContain('CFBundleShortVersionString');
    expect(output).toContain(`accessorHash: "${computeAccessorHash([{
      className: 'ToolState',
      fields: [
        { name: 'nickname', typeText: 'String?' },
        { name: 'names', typeText: '[String]' },
        { name: 'count', typeText: 'Int' },
        { name: 'enabled', typeText: 'Bool' },
      ],
    }])}"`);
    expect(output).not.toContain('key: "stringLeak"');
    expect(output).not.toContain('key: "blockLeak"');
    expect(output).not.toContain('key: "trailingLeak"');
    expect(output).not.toContain('key: "proseLeak"');

    const invalidInput = join(workDir, 'swift-syntax-invalid');
    const invalidOutput = join(workDir, 'swift-syntax-invalid-output');
    mkdirSync(invalidInput);
    writeFileSync(join(invalidInput, 'Invalid.swift'), `
import Observation
@Observable
final class InvalidState {
    // @Snapshotable
    public private(set) var token: String = "secret"
    // @Snapshotable
    let immutable: Int = 1
    // @Snapshotable
    var inferred = 2
    // @Snapshotable
    var legacy: String! = nil
    // @Snapshotable
    var custom: Date = .now
}

enum Namespace {
    @Observable
    final class NestedState {
        // @Snapshotable
        var nestedValue: Int = 0
    }
}

@Observable
final class FirstState {
    // @Snapshotable
    var shared: String = "first"
}

@Observable
final class DuplicateState {
    // @Snapshotable
    var shared: String = "duplicate"
}
`);
    const invalid = spawnSync('swift', [
      'run', '--package-path', packageDir, 'gen-accessors',
      '--input', invalidInput, '--output', invalidOutput,
    ], { encoding: 'utf8', env, timeout: 180_000 });
    expect(invalid.status).toBe(4);
    expect(invalid.stderr).toContain('InvalidState.token cannot be private');
    expect(invalid.stderr).toContain('InvalidState.immutable must be declared var, not let');
    expect(invalid.stderr).toContain('InvalidState.inferred requires an explicit type annotation');
    expect(invalid.stderr).toContain('InvalidState.legacy cannot use an implicitly unwrapped Optional type');
    expect(invalid.stderr).toContain("InvalidState.custom uses unsupported non-JSON snapshot type 'Date'");
    expect(invalid.stderr).toContain('nested @Observable class NestedState');
    expect(invalid.stderr).toContain("snapshot key 'shared' is declared by both FirstState and DuplicateState");
    expect(existsSync(join(invalidOutput, 'StateAccessor.swift'))).toBe(false);
  }, 180_000);
});

describe('collectSwiftFiles', () => {
  test('walks subdirectories and finds all .swift files sorted', () => {
    const a = join(workDir, 'a.swift');
    const sub = join(workDir, 'sub');
    mkdirSync(sub);
    const b = join(sub, 'b.swift');
    const c = join(workDir, 'c.txt');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    writeFileSync(c, 'c');
    const files = collectSwiftFiles(workDir);
    expect(files.sort()).toEqual([a, b].sort());
  });

  test('excludes the configured output subtree and every StateAccessor.swift', () => {
    const source = join(workDir, 'App.swift');
    const staleAccessor = join(workDir, 'old', 'StateAccessor.swift');
    const outputDir = join(workDir, 'custom-output');
    mkdirSync(join(workDir, 'old'));
    mkdirSync(outputDir);
    writeFileSync(source, 'struct App {}');
    writeFileSync(staleAccessor, '// stale generated output');
    writeFileSync(join(outputDir, 'Poison.swift'), '// must not be scanned');

    expect(collectSwiftFiles(workDir, { outputDir })).toEqual([source]);
  });
});
