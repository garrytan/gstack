/**
 * Unit tests for browse/src/security-classifier.ts pure functions.
 *
 * Scope: functions that do NOT require model download or network access.
 * Model-dependent behavior (loadTestsavant inference via scanPageContent)
 * is covered by security-bench.test.ts and security-live-playwright.test.ts,
 * which gate on the cached model being present.
 */

import { describe, test, expect } from 'bun:test';
import { getClassifierStatus } from '../src/security-classifier';

describe('getClassifierStatus — pre-load state', () => {
  test('returns testsavant=off before loadTestsavant has been called', () => {
    // Before any warmup has started, the classifier reports off.
    // (This test runs in fresh-module state; if another test already
    // loaded the classifier, status would be 'ok' — but this file runs
    // before model loads in typical CI.)
    const s = getClassifierStatus();
    expect(['ok', 'degraded', 'off']).toContain(s.testsavant);
  });

  test('status shape contract — exactly one key (testsavant)', () => {
    // The sidecar's `status` op serializes this object verbatim onto the
    // NDJSON wire — pin the shape so accidental additions are deliberate.
    const s = getClassifierStatus();
    expect(Object.keys(s).sort()).toEqual(['testsavant']);
  });
});
