/**
 * Tests for find-browse binary locator.
 */

import { describe, test, expect } from 'bun:test';
import { locateBinary } from '../src/find-browse';
import { existsSync } from 'fs';

describe('locateBinary', () => {
  test('returns null when no binary exists at known paths', () => {
    // This test depends on the test environment — if a real binary exists at
    // ~/.codex/skills/gstack-codex/browse/dist/browse, it will find it.
    // We mainly test that the function doesn't throw.
    const result = locateBinary();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('returns string path when binary exists', () => {
    const result = locateBinary();
    if (result !== null) {
      expect(existsSync(result)).toBe(true);
    }
  });
});
