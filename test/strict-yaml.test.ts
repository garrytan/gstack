import { describe, expect, test } from 'bun:test';
import { parseStrictYaml } from '../lib/strict-yaml';

describe('strict authority YAML', () => {
  test('returns null-prototype objects for one core-schema document', () => {
    const value = parseStrictYaml('enabled: true\ncount: 3\nitems: [one, two]\n') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value).toEqual({ enabled: true, count: 3, items: ['one', 'two'] });
  });

  test.each([
    ['duplicate keys', 'a: 1\na: 2\n'],
    ['anchor', 'a: &x 1\nb: 2\n'],
    ['alias', 'a: &x 1\nb: *x\n'],
    ['merge key', 'a: { <<: { x: 1 } }\n'],
    ['custom tag', 'a: !unsafe x\n'],
    ['complex key', '? [a, b]\n: value\n'],
    ['multiple documents', 'a: 1\n---\nb: 2\n'],
    ['directive', '%YAML 1.2\n---\na: 1\n'],
    ['prototype key', '__proto__: bad\n'],
    ['constructor key', 'constructor: bad\n'],
    ['non-finite number', 'a: .inf\n'],
  ])('rejects %s', (_name, source) => {
    expect(() => parseStrictYaml(source)).toThrow();
  });

  test('enforces byte, depth, node, scalar, map, and sequence limits', () => {
    expect(() => parseStrictYaml('a'.repeat(65 * 1024))).toThrow('yaml_byte_limit');
    expect(() => parseStrictYaml('a:\n  b:\n    c: 1\n', { maxDepth: 2 })).toThrow('yaml_depth_limit');
    expect(() => parseStrictYaml('a: [1, 2, 3]\n', { maxSequenceLength: 2 })).toThrow('yaml_sequence_limit');
    expect(() => parseStrictYaml('a: 1\nb: 2\n', { maxMapSize: 1 })).toThrow('yaml_map_limit');
    expect(() => parseStrictYaml('a: abc\n', { maxScalarLength: 2 })).toThrow('yaml_scalar_limit');
    expect(() => parseStrictYaml('a: 1\nb: 2\n', { maxNodes: 3 })).toThrow('yaml_node_limit');
  });
});
