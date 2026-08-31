/**
 * Direct unit tests for lib/version-source.ts — the single owner of the
 * 4-digit VERSION ↔ 3-digit npm translation and of version-path
 * interpretation (raw text vs JSON `.version`).
 *
 * Before this file, lib/version-source.ts was exercised only INDIRECTLY
 * through bin/gstack-version-bump (test/gstack-version-bump.test.ts spawns
 * the bin; nothing imported the lib). These tests pin the translation rules
 * documented in the module header so a regression is attributed to the lib,
 * not to whichever CLI happened to surface it.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseVersion,
  versionWidth,
  fmtVersion,
  cmpVersion,
  bumpVersion,
  bumpWasCoerced,
  npmVersion,
  isJsonVersionPath,
  extractVersion,
  setVersionInJson,
  type Version,
} from '../lib/version-source';

describe('parseVersion', () => {
  test('4-digit versions parse to all four components', () => {
    expect(parseVersion('1.67.0.0')).toEqual([1, 67, 0, 0]);
    expect(parseVersion('12.3.45.6')).toEqual([12, 3, 45, 6]);
  });

  test('3-digit versions pad MICRO to 0 so comparison stays uniform', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3, 0]);
  });

  test('surrounding whitespace is tolerated (file reads carry newlines)', () => {
    expect(parseVersion(' 1.2.3.4\n')).toEqual([1, 2, 3, 4]);
  });

  test('anything else is null, never a guess', () => {
    for (const bad of ['1.2', 'v1.2.3', '1.2.3.4.5', '1.2.3-rc1', 'abc', '', '{"name":"frontend"']) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe('versionWidth + fmtVersion', () => {
  test('width reflects how many components the string actually had', () => {
    expect(versionWidth('1.2.3.4')).toBe(4);
    expect(versionWidth(' 1.2.3.4 ')).toBe(4);
    expect(versionWidth('1.2.3')).toBe(3);
  });

  test('formatting round-trips at each width', () => {
    const v: Version = [1, 67, 2, 5];
    expect(fmtVersion(v, 4)).toBe('1.67.2.5');
    expect(fmtVersion(v, 3)).toBe('1.67.2');
    expect(fmtVersion(v)).toBe('1.67.2.5'); // default width 4
  });

  test('parse → fmt round-trip preserves the original string at its own width', () => {
    for (const s of ['1.67.0.0', '2.0.1']) {
      expect(fmtVersion(parseVersion(s)!, versionWidth(s))).toBe(s);
    }
  });
});

describe('cmpVersion', () => {
  test('orders component-wise, MICRO included', () => {
    const parse = (s: string) => parseVersion(s)!;
    expect(cmpVersion(parse('1.2.3.4'), parse('1.2.3.4'))).toBe(0);
    expect(cmpVersion(parse('1.2.3.5'), parse('1.2.3.4'))).toBeGreaterThan(0);
    expect(cmpVersion(parse('1.2.3.4'), parse('1.3.0.0'))).toBeLessThan(0);
    expect(cmpVersion(parse('2.0.0.0'), parse('1.99.99.99'))).toBeGreaterThan(0);
    // Padded 3-digit compares equal to its explicit .0 form.
    expect(cmpVersion(parse('1.2.3'), parse('1.2.3.0'))).toBe(0);
  });
});

describe('bumpVersion + bumpWasCoerced', () => {
  const base = parseVersion('1.2.3.4')!;

  test('each level zeroes everything below it', () => {
    expect(bumpVersion(base, 'major')).toEqual([2, 0, 0, 0]);
    expect(bumpVersion(base, 'minor')).toEqual([1, 3, 0, 0]);
    expect(bumpVersion(base, 'patch')).toEqual([1, 2, 4, 0]);
    expect(bumpVersion(base, 'micro')).toEqual([1, 2, 3, 5]);
  });

  test('micro in a 3-digit repo is carried out as PATCH — never a silent no-op', () => {
    const v = parseVersion('1.2.3')!;
    expect(bumpVersion(v, 'micro', 3)).toEqual([1, 2, 4, 0]);
    expect(fmtVersion(bumpVersion(v, 'micro', 3), 3)).toBe('1.2.4');
  });

  test('bumpWasCoerced is true exactly for micro-at-width-3', () => {
    expect(bumpWasCoerced('micro', 3)).toBe(true);
    expect(bumpWasCoerced('micro', 4)).toBe(false);
    expect(bumpWasCoerced('patch', 3)).toBe(false);
    expect(bumpWasCoerced('major', 3)).toBe(false);
  });
});

describe('npmVersion (4-digit VERSION → 3-digit npm translation)', () => {
  test('truncates the MICRO component', () => {
    expect(npmVersion('1.67.0.0')).toBe('1.67.0');
    expect(npmVersion('1.67.2.5')).toBe('1.67.2');
  });

  test('3-digit versions pass through unchanged', () => {
    expect(npmVersion('1.2.3')).toBe('1.2.3');
  });

  test('trims before translating', () => {
    expect(npmVersion(' 1.2.3.4\n')).toBe('1.2.3');
  });
});

describe('isJsonVersionPath', () => {
  test('detection is by shape (.json suffix), case-insensitive, trimmed', () => {
    expect(isJsonVersionPath('package.json')).toBe(true);
    expect(isJsonVersionPath('frontend/package.JSON')).toBe(true);
    expect(isJsonVersionPath(' pkg.json ')).toBe(true);
    expect(isJsonVersionPath('VERSION')).toBe(false);
    expect(isJsonVersionPath('version.txt')).toBe(false);
    expect(isJsonVersionPath('jsonfile')).toBe(false);
  });
});

describe('extractVersion', () => {
  test('non-JSON paths read as text with ALL whitespace stripped', () => {
    expect(extractVersion('1.67.0.0\n', 'VERSION')).toBe('1.67.0.0');
    expect(extractVersion('  1.2.3 \r\n', 'VERSION')).toBe('1.2.3');
  });

  test('JSON paths read the .version field, not the raw bytes (#2501 regression class)', () => {
    const pkg = '{\n  "name": "frontend",\n  "version": "2.0.1"\n}\n';
    expect(extractVersion(pkg, 'frontend/package.json')).toBe('2.0.1');
    // The old whitespace-strip-as-text behavior would return mangled JSON.
    expect(extractVersion(pkg, 'frontend/package.json')).not.toContain('{');
  });

  test('JSON without a usable version yields "" for the caller\'s own fallback', () => {
    expect(extractVersion('{"name":"x"}', 'package.json')).toBe('');
    expect(extractVersion('{"version": 42}', 'package.json')).toBe('');
    expect(extractVersion('not json at all', 'package.json')).toBe('');
  });

  test('JSON version values are trimmed', () => {
    expect(extractVersion('{"version": " 1.2.3 "}', 'package.json')).toBe('1.2.3');
  });
});

describe('setVersionInJson', () => {
  test('rewrites only the version, preserving key order, 2-space indent, trailing newline', () => {
    const raw = '{"name":"frontend","version":"1.0.0","private":true,"scripts":{"build":"x"}}';
    const out = setVersionInJson(raw, '1.1.0');
    expect(out).toBe([
      '{',
      '  "name": "frontend",',
      '  "version": "1.1.0",',
      '  "private": true,',
      '  "scripts": {',
      '    "build": "x"',
      '  }',
      '}',
      '',
    ].join('\n'));
  });

  test('round-trips with extractVersion', () => {
    const out = setVersionInJson('{"name":"x","version":"1.0.0"}', '2.3.4');
    expect(extractVersion(out, 'package.json')).toBe('2.3.4');
  });

  test('adds a version field when the manifest had none', () => {
    const out = setVersionInJson('{"name":"x"}', '0.1.0');
    expect(JSON.parse(out)).toEqual({ name: 'x', version: '0.1.0' });
  });
});
