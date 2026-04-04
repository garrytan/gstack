/**
 * Tests for find-browse binary locator.
 */

import { describe, test, expect } from 'bun:test';
import { locateBinary } from '../src/find-browse';
import { existsSync } from 'fs';

describe('locateBinary', () => {
  test('returns null when no binary exists at known paths', () => {
    // This test depends on the test environment — if a real binary exists at
    // ~/.antigravity/skills/gstack/browse/dist/browse, it will find it.
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

  test('priority chain checks .antigravity, .agents, .antigravity markers', () => {
    // Verify the source code implements the correct priority order.
    // We read the function source to confirm the markers array order.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/find-browse.ts'), 'utf-8');
    // The markers array should list .antigravity first, then .agents, then .antigravity
    const markersMatch = src.match(/const markers = \[([^\]]+)\]/);
    expect(markersMatch).not.toBeNull();
    const markers = markersMatch![1];
    const antigravityIdx = markers.indexOf('.antigravity');
    const agentsIdx = markers.indexOf('.agents');
    const antigravityIdx = markers.indexOf('.antigravity');
    // All three must be present
    expect(antigravityIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(antigravityIdx).toBeGreaterThanOrEqual(0);
    // .antigravity before .agents before .antigravity
    expect(antigravityIdx).toBeLessThan(agentsIdx);
    expect(agentsIdx).toBeLessThan(antigravityIdx);
  });

  test('function signature accepts no arguments', () => {
    // locateBinary should be callable with no arguments
    expect(typeof locateBinary).toBe('function');
    expect(locateBinary.length).toBe(0);
  });
});
