// Tests for the gen-accessors TS port. Covers:
//
//   - Parse: 3 regex-failure-mode fixtures from the fork (codex catch)
//   - Cache: same input → same key; different swift version → different key;
//     different tool rev → different key; file modified → different key
//   - Prune: >30d entries removed, recent kept

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectSwiftFiles,
  parseSwift,
  computeCacheKey,
  generate,
  pruneCache,
  render,
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
  test('parses @Observable class with simple @Snapshotable fields', () => {
    const src = `
@Observable
final class AppState {
    @Snapshotable var isLoggedIn: Bool = false
    @Snapshotable var username: String = ""
    var notSnapshotable: Int = 0
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.className).toBe('AppState');
    expect(specs[0]!.fields.map(f => f.name)).toEqual(['isLoggedIn', 'username']);
    expect(specs[0]!.fields.find(f => f.name === 'isLoggedIn')!.typeText).toBe('Bool');
  });

  test('handles @Snapshotable on multi-line type signatures', () => {
    const src = `
@Observable
class Cart {
    @Snapshotable var items:
        [CartItem<Detail>]
        = []
    var unrelated: Int = 0
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.fields).toHaveLength(1);
    expect(specs[0]!.fields[0]!.name).toBe('items');
    expect(specs[0]!.fields[0]!.typeText).toContain('CartItem');
  });

  test('handles generic types in property signatures', () => {
    const src = `
@Observable
class Repo {
    @Snapshotable var pages: Dictionary<String, [Result<Item, Error>]> = [:]
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.fields[0]!.typeText).toContain('Dictionary');
    expect(specs[0]!.fields[0]!.typeText).toContain('Result');
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

  test('skips fields with computed body braces', () => {
    // Codex flagged "Properties with computed getters / didSet blocks" as a
    // failure mode of the fork's regex. We deliberately exclude them here —
    // computed properties are not snapshot-eligible.
    const src = `
@Observable
class M {
    @Snapshotable var snapshotted: Int = 0
    @Snapshotable var computed: Int {
        get { 42 }
    }
}
`;
    const specs = parseSwift(src);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.fields.map(f => f.name)).toEqual(['snapshotted']);
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
    expect(out).toContain('public enum AppStateAccessor');
    expect(out).toContain('key: "a"');
    expect(out).toContain('key: "b"');
    expect(out).toContain('buildId: "build-1.2.3"');
    expect(out).toContain('accessorHash: "hash-abc"');
    expect(out).toContain('#if DEBUG');
    expect(out).toContain('#endif');
  });
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
});
