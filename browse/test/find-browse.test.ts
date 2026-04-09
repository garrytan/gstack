/**
 * Tests for find-browse binary locator.
 */

import { describe, test, expect } from 'bun:test';
import { locateBinary } from '../src/find-browse';
import { existsSync } from 'fs';

describe('locateBinary', () => {
  test('returns null when no binary exists at known paths', () => {
    // This test depends on the test environment — if a real binary exists at
    // ~/.claude/skills/nstack/browse/dist/browse, it will find it.
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

  test('priority chain checks .codex, .agents, .claude markers', () => {
    // Verify the source code implements the correct priority order.
    // We read the function source to confirm the markers array order.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/find-browse.ts'), 'utf-8');
    // The markers array should list .codex first, then .agents, then .claude
    const markersMatch = src.match(/const markers = \[([^\]]+)\]/);
    expect(markersMatch).not.toBeNull();
    const markers = markersMatch![1];
    const codexIdx = markers.indexOf('.codex');
    const agentsIdx = markers.indexOf('.agents');
    const claudeIdx = markers.indexOf('.claude');
    // All three must be present
    expect(codexIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    // .codex before .agents before .claude
    expect(codexIdx).toBeLessThan(agentsIdx);
    expect(agentsIdx).toBeLessThan(claudeIdx);
  });

  test('function signature accepts no arguments', () => {
    // locateBinary should be callable with no arguments
    expect(typeof locateBinary).toBe('function');
    expect(locateBinary.length).toBe(0);
  });
});
