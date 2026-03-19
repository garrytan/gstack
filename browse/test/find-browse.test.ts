/**
 * Tests for find-browse binary locator.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { locateBinary } from '../src/find-browse';

describe('locateBinary', () => {
  const home = '/tmp/home';
  const root = '/tmp/repo';

  test('prefers workspace-local Codex install', () => {
    const result = locateBinary({
      root,
      home,
      exists: (candidate) => candidate === join(root, '.codex', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    });

    expect(result).toBe(join(root, '.codex', 'skills', 'gstack', 'browse', 'dist', 'browse'));
  });

  test('falls back to workspace-local Claude install when Codex path is absent', () => {
    const result = locateBinary({
      root,
      home,
      exists: (candidate) => candidate === join(root, '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    });

    expect(result).toBe(join(root, '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'));
  });

  test('falls back to global Codex install after workspace paths', () => {
    const result = locateBinary({
      root,
      home,
      exists: (candidate) => candidate === join(home, '.codex', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    });

    expect(result).toBe(join(home, '.codex', 'skills', 'gstack', 'browse', 'dist', 'browse'));
  });

  test('falls back to global Claude install last', () => {
    const result = locateBinary({
      root: null,
      home,
      exists: (candidate) => candidate === join(home, '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    });

    expect(result).toBe(join(home, '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'));
  });

  test('returns null when no candidate exists', () => {
    const result = locateBinary({
      root,
      home,
      exists: () => false,
    });

    expect(result).toBeNull();
  });
});
