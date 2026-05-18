import { describe, expect, test } from 'bun:test';
import { parseReviewLogJsonl, pendingReviewDispatchFromState, reviewLogEntryToArtifact, selectReviewCaptureEntry } from '../lib/factory-review-capture';
import type { FactoryRunState } from '../lib/factory-core';

const dispatch = {
  runId: 'run-1',
  phaseId: 'diff-review',
  dispatchedAt: '2026-01-01T00:00:00.000Z',
  commit: 'abc1234',
};

const reviewEntry = {
  skill: 'review',
  timestamp: '2026-01-01T00:00:01.000Z',
  status: 'clean',
  issues_found: 0,
  critical: 0,
  informational: 0,
  quality_score: 10,
  commit: 'abc1234',
  factory_run_id: 'run-1',
};

describe('factory review capture calculations', () => {
  test('parses review log JSONL and ignores malformed historical lines', () => {
    expect(parseReviewLogJsonl('{"skill":"review","timestamp":"2026-01-01T00:00:01.000Z"}\nnot-json\n')).toEqual([
      { skill: 'review', timestamp: '2026-01-01T00:00:01.000Z' },
    ]);
  });

  test('extracts pending review dispatch metadata from run state', () => {
    const state: FactoryRunState = {
      runId: 'run-1',
      status: 'running',
      currentPhaseId: 'diff-review',
      completedPhaseIds: ['review-intake'],
      pendingGates: [],
      gateDecisions: [],
      risks: [],
      artifacts: [{
        id: 'diff-review-dispatch',
        kind: 'review',
        phaseId: 'diff-review',
        summary: 'Queued review',
        metadata: {
          factoryRunId: 'run-1',
          pendingExternalWork: true,
          dispatchedAt: '2026-01-01T00:00:00.000Z',
          commit: 'abc1234',
          queuedSkillCommand: '/skill:gstack-review review this',
        },
      }],
    };

    expect(pendingReviewDispatchFromState(state)).toEqual({
      runId: 'run-1',
      phaseId: 'diff-review',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      commit: 'abc1234',
      queuedSkillCommand: '/skill:gstack-review review this',
    });
  });

  test('does not extract dispatch metadata when artifact run id disagrees with state', () => {
    const state: FactoryRunState = {
      runId: 'run-1',
      status: 'running',
      currentPhaseId: 'diff-review',
      completedPhaseIds: ['review-intake'],
      pendingGates: [],
      gateDecisions: [],
      risks: [],
      artifacts: [{
        id: 'diff-review-dispatch',
        kind: 'review',
        phaseId: 'diff-review',
        summary: 'Queued review',
        metadata: { factoryRunId: 'other-run', pendingExternalReview: true },
      }],
    };

    expect(pendingReviewDispatchFromState(state)).toBeNull();
  });

  test('returns no-match when entries are before dispatchedAt', () => {
    expect(selectReviewCaptureEntry([
      { ...reviewEntry, timestamp: '2025-12-31T23:59:59.000Z' },
    ], dispatch)).toEqual({ ok: false, reason: 'no-match' });
  });

  test('selects one exact post-dispatch review entry', () => {
    expect(selectReviewCaptureEntry([reviewEntry], dispatch)).toEqual({ ok: true, entry: reviewEntry });
  });

  test('returns ambiguous for multiple post-dispatch review entries', () => {
    expect(selectReviewCaptureEntry([
      reviewEntry,
      { ...reviewEntry, timestamp: '2026-01-01T00:00:02.000Z' },
    ], dispatch)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  test('excludes commit mismatches, missing dispatch metadata, missing correlation, and incomplete review entries', () => {
    expect(selectReviewCaptureEntry([{ ...reviewEntry, commit: 'different' }], dispatch)).toEqual({ ok: false, reason: 'no-match' });
    expect(selectReviewCaptureEntry([reviewEntry], { ...dispatch, commit: undefined })).toEqual({ ok: false, reason: 'no-match' });
    expect(selectReviewCaptureEntry([reviewEntry], { ...dispatch, dispatchedAt: undefined })).toEqual({ ok: false, reason: 'no-match' });
    expect(selectReviewCaptureEntry([{ ...reviewEntry, factory_run_id: undefined }], dispatch)).toEqual({ ok: false, reason: 'no-match' });
    expect(selectReviewCaptureEntry([{ ...reviewEntry, factory_run_id: 'other-run' }], dispatch)).toEqual({ ok: false, reason: 'no-match' });
    expect(selectReviewCaptureEntry([{ ...reviewEntry, status: undefined }], dispatch)).toEqual({ ok: false, reason: 'no-match' });
  });

  test('renders review log entries as factory artifacts with counts, specialists, and findings', () => {
    const artifact = reviewLogEntryToArtifact('run-1', {
      skill: 'review',
      timestamp: '2026-01-01T00:00:01.000Z',
      status: 'issues_found',
      issues_found: 2,
      critical: 1,
      informational: 1,
      quality_score: 7.5,
      commit: 'abc1234',
      specialists: { security: { dispatched: true, findings: 1 } },
      findings: [{ fingerprint: 'a.ts:1:security', severity: 'CRITICAL', action: 'skipped' }],
    });

    expect(artifact.ref).toMatchObject({
      id: 'diff-review-captured',
      kind: 'review',
      phaseId: 'diff-review',
      summary: 'Review issues_found: 2 issue(s), 1 critical, 1 informational',
      metadata: {
        capturedFrom: 'gstack-review-log',
        issuesFound: 2,
        critical: 1,
        informational: 1,
        qualityScore: 7.5,
      },
    });
    expect(artifact.content).toContain('Issues found: 2');
    expect(artifact.content).toContain('security');
    expect(artifact.content).toContain('a.ts:1:security');
  });
});
