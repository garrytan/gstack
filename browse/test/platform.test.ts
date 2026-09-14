import { describe, test, expect } from 'bun:test';
import { TEMP_DIR, isPathWithin, IS_WINDOWS } from '../src/platform';

describe('platform constants', () => {
  test('TEMP_DIR is /tmp on non-Windows', () => {
    if (!IS_WINDOWS) {
      expect(TEMP_DIR).toBe('/tmp');
    }
  });

  test('IS_WINDOWS reflects process.platform', () => {
    expect(IS_WINDOWS).toBe(process.platform === 'win32');
  });
});

describe('isPathWithin', () => {
  test('path inside directory returns true', () => {
    expect(isPathWithin('/tmp/foo', '/tmp')).toBe(true);
  });

  test('path outside directory returns false', () => {
    expect(isPathWithin('/etc/foo', '/tmp')).toBe(false);
  });

  test('exact match returns true', () => {
    expect(isPathWithin('/tmp', '/tmp')).toBe(true);
  });

  test('partial prefix does not match (path traversal)', () => {
    // /tmp-evil should NOT match /tmp
    expect(isPathWithin('/tmp-evil/foo', '/tmp')).toBe(false);
  });

  test('nested path returns true', () => {
    expect(isPathWithin('/tmp/a/b/c', '/tmp')).toBe(true);
  });
});
