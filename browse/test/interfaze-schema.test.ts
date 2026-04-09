import { describe, test, expect } from 'bun:test';
import { parseSchemaJson, buildZodFromHints } from '../src/interfaze-schema';
import { interfazeSetupHint } from '../src/interfaze-auth';

describe('interfaze-schema', () => {
  test('parseSchemaJson builds string/number/boolean fields', () => {
    const s = parseSchemaJson('{"title":"string","n":"number","ok":"bool"}');
    const r = s.safeParse({ title: 'x', n: 1, ok: true });
    expect(r.success).toBe(true);
  });

  test('parseSchemaJson rejects empty object', () => {
    expect(() => parseSchemaJson('{}')).toThrow();
  });

  test('buildZodFromHints defaults unknown types to string', () => {
    const s = buildZodFromHints({ x: 'unknown' });
    const r = s.safeParse({ x: 'hi' });
    expect(r.success).toBe(true);
  });
});

describe('interfaze-auth', () => {
  test('interfazeSetupHint mentions setup and dashboard', () => {
    const h = interfazeSetupHint('ocr');
    expect(h).toContain('interfaze-setup');
    expect(h).toContain('interfaze.ai');
  });
});
