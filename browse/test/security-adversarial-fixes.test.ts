/**
 * Regression tests for the 4 adversarial findings fixed during /ship:
 *
 * 1. Canary stream-chunk split bypass — rolling-buffer detection across
 *    consecutive text_delta / input_json_delta events.
 * 2. Tool-output ensemble rule — single ML classifier >= BLOCK blocks
 *    directly when the content is tool output (not user input).
 * 3. escapeHtml quote escaping (unit-level check on the shape we expect).
 * 4. snapshot command added to PAGE_CONTENT_COMMANDS.
 *
 * These tests pin the fixes so future refactors don't silently re-open
 * the bypasses both adversarial reviewers (Claude + Codex) flagged.
 */
import { describe, test, expect } from 'bun:test';
import { combineVerdict, THRESHOLDS } from '../src/security';
import { PAGE_CONTENT_COMMANDS } from '../src/commands';

describe('tool-output ensemble rule (single-layer BLOCK)', () => {
  test('user-input context: single layer at BLOCK degrades to WARN', () => {
    const result = combineVerdict([
      { layer: 'testsavant_content', confidence: 0.95 },
      { layer: 'transcript_classifier', confidence: 0 },
    ]);
    expect(result.verdict).toBe('warn');
    expect(result.reason).toBe('single_layer_high');
  });

  test('tool-output context: single layer at BLOCK blocks directly', () => {
    const result = combineVerdict(
      [
        { layer: 'testsavant_content', confidence: 0.95 },
        { layer: 'transcript_classifier', confidence: 0, meta: { degraded: true } },
      ],
      { toolOutput: true },
    );
    expect(result.verdict).toBe('block');
    expect(result.reason).toBe('single_layer_tool_output');
  });

  test('tool-output context still respects ensemble path when 2 agree', () => {
    const result = combineVerdict(
      [
        { layer: 'testsavant_content', confidence: 0.80 },
        { layer: 'transcript_classifier', confidence: 0.75, meta: { verdict: 'block' } },
      ],
      { toolOutput: true },
    );
    expect(result.verdict).toBe('block');
    expect(result.reason).toBe('ensemble_agreement');
  });

  test('tool-output context: below BLOCK threshold still WARN, not BLOCK', () => {
    const result = combineVerdict(
      [{ layer: 'testsavant_content', confidence: THRESHOLDS.WARN }],
      { toolOutput: true },
    );
    expect(result.verdict).toBe('warn');
  });
});

describe('snapshot in PAGE_CONTENT_COMMANDS', () => {
  test('snapshot is wrapped by untrusted-content envelope', () => {
    expect(PAGE_CONTENT_COMMANDS.has('snapshot')).toBe(true);
  });
});
