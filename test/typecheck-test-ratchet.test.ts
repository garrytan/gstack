import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareDiagnostics, parseDiagnostics, readBaseline, sortTypeMembers } from '../scripts/typecheck-test';

const output = [
  "test/a.test.ts(3,5): error TS2339: Property 'questions' does not exist on type 'Plan'.",
  "test/a.test.ts(9,5): error TS2339: Property 'questions' does not exist on type 'Plan'.",
  'test/b.test.ts(1,1): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
  "  Type 'string' is not assignable to type 'number'.",
  'Found 3 errors.',
].join('\n');

describe('test typecheck ratchet', () => {
  test('counts repeated identical diagnostics instead of collapsing them', () => {
    expect(parseDiagnostics(output)).toEqual({
      "test/a.test.ts\tTS2339\tProperty 'questions' does not exist on type 'Plan'.": 2,
      "test/b.test.ts\tTS2345\tArgument of type 'string' is not assignable to parameter of type 'number'. Type 'string' is not assignable to type 'number'.": 1,
    });
  });

  test('strips the checkout root from messages so every clone shares one identity', () => {
    const line = "test/d.test.ts(1,1): error TS2322: Type 'import(\"/tmp/clone-a/lib/x\").A' is not assignable to type 'B'.";
    const a = parseDiagnostics(line, '/tmp/clone-a');
    const b = parseDiagnostics(line.replace('/tmp/clone-a', '/home/ci/work/gstack'), '/home/ci/work/gstack');
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.keys(a)[0]).toContain('import(\"lib/x\")');
  });

  test('ignores line and column so moving code does not churn the baseline', () => {
    const moved = output.replace('(3,5)', '(30,7)').replace('(9,5)', '(90,1)');
    expect(parseDiagnostics(moved)).toEqual(parseDiagnostics(output));
  });

  test('object-type member print order is not part of the identity', () => {
    // Observed on one unchanged diagnostic once lib/fs-utils joined the generator's import graph.
    const a = "test/e.test.ts(4,1): error TS2345: Argument of type '({ content?: undefined; isError?: undefined; kind: string; input: { questions: { header: string; }[]; }; } | { ...; })[]' is not assignable.";
    const b = a.replace('content?: undefined; isError?: undefined;', 'isError?: undefined; content?: undefined;');
    expect(Object.keys(parseDiagnostics(b))).toEqual(Object.keys(parseDiagnostics(a)));
    expect(sortTypeMembers('{ b: string; a: { d: 1; c: 2; }; }')).toBe('{ a: { c: 2; d: 1; }; b: string; }');
    expect(sortTypeMembers('{ a: string; b: number; }')).toBe('{ a: string; b: number; }');
    expect(sortTypeMembers("Type '{}' has no 'x'")).toBe("Type '{}' has no 'x'");
    expect(Object.keys(parseDiagnostics("test/e.test.ts(1,1): error TS2322: Type '{ a: 1; }' is not assignable to type '{ b: 2; }'."))).not.toEqual(
      Object.keys(parseDiagnostics("test/e.test.ts(1,1): error TS2322: Type '{ b: 2; }' is not assignable to type '{ a: 1; }'.")));
  });

  test('a baseline written before member sorting still matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-tc-order-'));
    try {
      const file = path.join(dir, 'baseline.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, diagnostics: { "test/e.test.ts\tTS2345\tType '{ z: 1; a: 2; }'.": 2 } }));
      const current = parseDiagnostics("test/e.test.ts(1,1): error TS2345: Type '{ a: 2; z: 1; }'.\ntest/e.test.ts(2,1): error TS2345: Type '{ z: 1; a: 2; }'.");
      expect(compareDiagnostics(readBaseline(file), current)).toEqual({ added: [], fixed: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a duplicate of an existing diagnostic and a new identity both fail', () => {
    const baseline = parseDiagnostics(output);
    const current = parseDiagnostics(output + "\ntest/a.test.ts(12,5): error TS2339: Property 'questions' does not exist on type 'Plan'.\ntest/c.test.ts(1,1): error TS2304: Cannot find name 'join'.");
    const { added, fixed } = compareDiagnostics(baseline, current);
    expect(added.map(d => [d.identity.split('\t')[0], d.baseline, d.current])).toEqual([
      ['test/a.test.ts', 2, 3],
      ['test/c.test.ts', 0, 1],
    ]);
    expect(fixed).toEqual([]);
  });

  test('a fixed diagnostic is reported so the smaller allowance gets locked in', () => {
    const baseline = parseDiagnostics(output);
    const { added, fixed } = compareDiagnostics(baseline, parseDiagnostics(output.split('\n').slice(1).join('\n')));
    expect(added).toEqual([]);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ baseline: 2, current: 1 });
  });

  test('a missing or malformed baseline fails closed with the regeneration command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-baseline-'));
    try {
      expect(() => readBaseline(path.join(dir, 'missing.json'))).toThrow('bun run typecheck:test --write-baseline');
      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ version: 1, diagnostics: { x: 0 } }));
      expect(() => readBaseline(path.join(dir, 'bad.json'))).toThrow('malformed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the committed baseline is readable and non-empty', () => {
    const baseline = readBaseline(path.join(import.meta.dir, '..', 'scripts', 'typecheck-test-baseline.json'));
    expect(Object.keys(baseline).length).toBeGreaterThan(0);
  });
});
