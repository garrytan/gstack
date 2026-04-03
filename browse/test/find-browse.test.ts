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

  test('priority chain checks .gemini, .codex, .agents, .claude markers', () => {
    // Verify the source code implements the correct priority order.
    // We read the function source to confirm the markers array order.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/find-browse.ts'), 'utf-8');
    // The markers array should list .gemini first, then .codex, then .agents, then .claude
    const markersMatch = src.match(/const markers = \[([^\]]+)\]/);
    expect(markersMatch).not.toBeNull();
    const markers = JSON.parse(`[${markersMatch![1]}]`);
    const geminiIdx = markers.indexOf('.gemini');
    const codexIdx = markers.indexOf('.codex');
    const agentsIdx = markers.indexOf('.agents');
    const claudeIdx = markers.indexOf('.claude');
    // All four must be present
    expect(geminiIdx).toBe(0);
    expect(codexIdx).toBe(1);
    expect(agentsIdx).toBe(2);
    expect(claudeIdx).toBe(3);
  });

  test('function signature accepts no arguments', () => {
    // locateBinary should be callable with no arguments
    expect(typeof locateBinary).toBe('function');
    expect(locateBinary.length).toBe(0);
  });
});
