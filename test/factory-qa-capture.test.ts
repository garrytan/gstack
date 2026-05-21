import { describe, expect, test } from 'bun:test';
import {
  parseQaLogJsonl,
  pendingQaDispatchFromState,
  qaLogEntryToArtifact,
  selectQaCaptureEntry,
} from '../lib/factory-qa-capture';
import type { FactoryRunState } from '../lib/factory-core';

const dispatch = {
  runId: 'run-qa-1',
  phaseId: 'qa-execution' as const,
  dispatchedAt: '2026-01-01T00:00:00.000Z',
  queuedSkillCommand: '/skill:gstack-qa-only QA http://localhost:8200',
};

const qaEntry = {
  skill: 'qa-only',
  timestamp: '2026-01-01T00:00:02.000Z',
  status: 'issues_found',
  mode: 'audit',
  summary: '3 failures found',
  target_url: 'https://tutor-match-preview.app',
  target_environment: 'preview',
  authenticated_as: 'test parent account',
  passed: 4,
  failed: 3,
  must_fix: 3,
  issues_found: 3,
  factory_run_id: 'run-qa-1',
  scenarios: [
    { name: 'Parent signs up via email link', result: 'pass', evidence: ['screenshots/issue-001-step-1.png'] },
    { name: 'Parent books a 60-min slot', result: 'fail', severity: 'must-fix', evidence: ['screenshots/issue-003-result.png'] },
  ],
  screenshots: [
    { uri: 'screenshots/issue-003-result.png', caption: 'Booking accepts a past date (FAIL)' },
    'screenshots/issue-004-result.png',
  ],
  trace_steps: [
    { timestamp: '00:00', detail: 'Loaded /tutors · 1.2s' },
    { timestamp: '00:12', detail: 'Past date accepted (unexpected)' },
  ],
};

describe('factory QA capture calculations', () => {
  test('parses QA log JSONL and ignores malformed lines', () => {
    expect(parseQaLogJsonl('{"skill":"qa-only","timestamp":"2026-01-01T00:00:02.000Z"}\nnot-json\n')).toEqual([
      { skill: 'qa-only', timestamp: '2026-01-01T00:00:02.000Z' },
    ]);
  });

  test('extracts pending QA dispatch metadata from run state', () => {
    const state: FactoryRunState = {
      runId: 'run-qa-1',
      status: 'running',
      currentPhaseId: 'qa-execution',
      completedPhaseIds: ['qa-intake'],
      pendingGates: [],
      gateDecisions: [],
      risks: [],
      artifacts: [{
        id: 'qa-execution-dispatch',
        kind: 'qa-report',
        phaseId: 'qa-execution',
        summary: 'Queued QA audit',
        metadata: {
          factoryRunId: 'run-qa-1',
          pendingExternalQa: true,
          dispatchedAt: '2026-01-01T00:00:00.000Z',
          queuedSkillCommand: '/skill:gstack-qa-only QA http://localhost:8200',
        },
      }],
    };

    expect(pendingQaDispatchFromState(state)).toEqual({
      runId: 'run-qa-1',
      phaseId: 'qa-execution',
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      queuedSkillCommand: '/skill:gstack-qa-only QA http://localhost:8200',
    });
  });

  test('does not extract QA dispatch metadata when artifact run id disagrees with state', () => {
    const state: FactoryRunState = {
      runId: 'run-qa-1',
      status: 'running',
      currentPhaseId: 'qa-execution',
      completedPhaseIds: ['qa-intake'],
      pendingGates: [],
      gateDecisions: [],
      risks: [],
      artifacts: [{
        id: 'qa-execution-dispatch',
        kind: 'qa-report',
        phaseId: 'qa-execution',
        summary: 'Queued QA audit',
        metadata: { factoryRunId: 'other-run', pendingExternalQa: true },
      }],
    };

    expect(pendingQaDispatchFromState(state)).toBeNull();
  });

  test('selects one exact post-dispatch QA entry with matching run id and queued skill family', () => {
    expect(selectQaCaptureEntry([
      qaEntry,
      { ...qaEntry, skill: 'qa' },
    ], dispatch)).toEqual({ ok: true, entry: qaEntry });
  });

  test('returns no-match when entries are before dispatch, missing correlation, or wrong skill family', () => {
    expect(selectQaCaptureEntry([
      { ...qaEntry, timestamp: '2025-12-31T23:59:59.000Z' },
    ], dispatch)).toEqual({ ok: false, reason: 'no-match' });

    expect(selectQaCaptureEntry([
      { ...qaEntry, factory_run_id: undefined },
    ], dispatch)).toEqual({ ok: false, reason: 'no-match' });

    expect(selectQaCaptureEntry([
      { ...qaEntry, skill: 'qa' },
    ], dispatch)).toEqual({ ok: false, reason: 'no-match' });

    expect(selectQaCaptureEntry([
      { ...qaEntry, status: undefined },
    ], dispatch)).toEqual({ ok: false, reason: 'no-match' });

    expect(selectQaCaptureEntry([
      qaEntry,
    ], { ...dispatch, dispatchedAt: undefined })).toEqual({ ok: false, reason: 'no-match' });
  });

  test('returns ambiguous for multiple correlated post-dispatch QA entries', () => {
    expect(selectQaCaptureEntry([
      qaEntry,
      { ...qaEntry, timestamp: '2026-01-01T00:00:03.000Z' },
    ], dispatch)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  test('renders QA log entries as structured browser-evidence artifacts', () => {
    const artifact = qaLogEntryToArtifact('run-qa-1', qaEntry);

    expect(artifact.ref).toMatchObject({
      id: 'qa-execution-captured',
      kind: 'qa-report',
      phaseId: 'qa-execution',
      summary: 'QA audit issues_found: 4 passed, 3 failed, 3 must-fix',
      metadata: {
        capturedFrom: 'gstack-qa-log',
        qaMode: 'audit',
        issuesFound: 3,
        scenariosPassed: 4,
        scenariosFailed: 3,
        mustFix: 3,
        screenshotCount: 2,
        traceStepCount: 2,
      },
    });

    expect(artifact.content).toContain('Browser QA audit — no code changes.');
    expect(artifact.content).toContain('| Scenario | Result | Severity | Evidence |');
    expect(artifact.content).toContain('Parent books a 60-min slot');
    expect(artifact.content).toContain('Booking accepts a past date (FAIL)');
    expect(artifact.content).toContain('[00:12] Past date accepted (unexpected)');
  });

  test('falls back to safe placeholders when browser evidence fields are missing', () => {
    const artifact = qaLogEntryToArtifact('run-qa-1', {
      skill: 'qa-only',
      timestamp: '2026-01-01T00:00:02.000Z',
      status: 'clean',
      factory_run_id: 'run-qa-1',
    });

    expect(artifact.content).toContain('_No scenario matrix was provided in the QA log._');
    expect(artifact.content).toContain('_No screenshots were listed in the QA log._');
    expect(artifact.content).toContain('_No trace steps were listed in the QA log._');
    expect(artifact.ref.metadata).toMatchObject({
      qaMode: 'audit',
      issuesFound: 0,
      scenariosPassed: 0,
      scenariosFailed: 0,
      mustFix: 0,
    });
  });
});
