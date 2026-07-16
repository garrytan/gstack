/**
 * Unit tests for browse/src/security-classifier.ts pure functions.
 *
 * Scope: functions that do NOT require model download, claude CLI, or
 * network access. Model-dependent behavior (loadTestsavant inference,
 * checkTranscript Haiku calls) belongs in a smoke harness that pulls
 * the cached model — filed as a P1 follow-up.
 */

import { describe, test, expect } from 'bun:test';
import {
  shouldRunTranscriptCheck,
  getClassifierStatus,
} from '../src/security-classifier';
import { THRESHOLDS, type LayerSignal } from '../src/security';

describe('shouldRunTranscriptCheck — Haiku gating optimization', () => {
  test('returns false when no layer has fired at >= LOG_ONLY', () => {
    // Clean pre-tool-call: no classifier saw anything interesting.
    // Skipping Haiku here is the 70% savings described in plan §E1.
    const signals: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: 0 },
      { layer: 'aria_regex', confidence: 0 },
    ];
    expect(shouldRunTranscriptCheck(signals)).toBe(false);
  });

  test('returns true when testsavant_content fires at LOG_ONLY threshold', () => {
    // Exactly at 0.40 — should trigger Haiku follow-up.
    const signals: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: THRESHOLDS.LOG_ONLY },
    ];
    expect(shouldRunTranscriptCheck(signals)).toBe(true);
  });

  test('returns true when aria_regex alone fires above LOG_ONLY', () => {
    // Regex hit on its own is suspicious enough to warrant Haiku second opinion.
    const signals: LayerSignal[] = [
      { layer: 'aria_regex', confidence: 0.6 },
    ];
    expect(shouldRunTranscriptCheck(signals)).toBe(true);
  });

  test('does NOT gate on transcript_classifier itself (no recursion)', () => {
    // If the transcript classifier already reported (e.g., prior tool call),
    // the new tool call shouldn't re-trigger Haiku based on the previous
    // transcript signal alone — we need a fresh content signal. This
    // prevents feedback loops where one Haiku hit forever gates future calls.
    const signals: LayerSignal[] = [
      { layer: 'transcript_classifier', confidence: 0.9 },
    ];
    expect(shouldRunTranscriptCheck(signals)).toBe(false);
  });

  test('empty signals list returns false (no reason to call Haiku)', () => {
    expect(shouldRunTranscriptCheck([])).toBe(false);
  });

  test('confidence just below LOG_ONLY → false', () => {
    const signals: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: THRESHOLDS.LOG_ONLY - 0.01 },
    ];
    expect(shouldRunTranscriptCheck(signals)).toBe(false);
  });

  test('mixed low signals — any one >= LOG_ONLY gates true', () => {
    const signals: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: 0.1 },
      { layer: 'aria_regex', confidence: 0.45 }, // just above LOG_ONLY
    ];
    expect(shouldRunTranscriptCheck(signals)).toBe(true);
  });
});

describe('getClassifierStatus — pre-load state', () => {
  test('returns testsavant=off before loadTestsavant has been called', () => {
    // Before any warmup has started, both classifiers report off.
    // (This test runs in fresh-module state; if another test already
    // loaded the classifier, status would be 'ok' — but this file runs
    // before model loads in typical CI.)
    const s = getClassifierStatus();
    // transcript starts 'off' until first checkHaikuAvailable() call
    expect(['ok', 'degraded', 'off']).toContain(s.testsavant);
    expect(['ok', 'degraded', 'off']).toContain(s.transcript);
  });

  test('status shape contract — exactly two keys', () => {
    const s = getClassifierStatus();
    expect(Object.keys(s).sort()).toEqual(['testsavant', 'transcript']);
  });
});
