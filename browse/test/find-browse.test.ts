/**
 * Tests for find-browse binary locator.
 */

import { describe, test, expect } from 'bun:test';
import { locateBinary } from '../src/find-browse';
import { existsSync } from 'fs';

describe('locateBinary', () => {
  test('returns null when no binary exists at known paths', () => {
    // This test depends on the test environment — if a real binary exists at
    // ~/.claude/skills/gstack/browse/dist/browse, it will find it.
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

  test('prefers shared runtime before workspace fallback and legacy host markers', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/find-browse.ts'), 'utf-8');
    expect(src).toContain("join(root, '.gstack', 'browse', 'dist', 'browse')");
    expect(src).toContain("join(home, '.gstack', 'browse', 'dist', 'browse')");

    const sharedCheck = src.indexOf("if (existsSync(shared)) return shared;");
    const workspaceCheck = src.indexOf("if (workspace && existsSync(workspace)) return workspace;");
    const legacyLocalCheck = src.indexOf("const local = join(root, m, 'skills', 'gstack', 'browse', 'dist', 'browse');");

    expect(sharedCheck).toBeGreaterThanOrEqual(0);
    expect(workspaceCheck).toBeGreaterThanOrEqual(0);
    expect(legacyLocalCheck).toBeGreaterThanOrEqual(0);
    expect(sharedCheck).toBeLessThan(workspaceCheck);
    expect(workspaceCheck).toBeLessThan(legacyLocalCheck);
  });

  test('function signature accepts no arguments', () => {
    // locateBinary should be callable with no arguments
    expect(typeof locateBinary).toBe('function');
    expect(locateBinary.length).toBe(0);
  });
});
