import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileRunPlan, type FactoryEvent, type WorkflowSpec } from '../lib/factory-core';
import { FileFactoryEventStore, assertSafeRunId, parseFactoryEventLog } from '../lib/factory-event-store';

const workflow: WorkflowSpec = {
  id: 'review-flow',
  title: 'Review Flow',
  description: 'Review a branch and record artifacts.',
  phases: [
    {
      id: 'review',
      title: 'Review',
      role: { id: 'reviewer', title: 'Reviewer' },
      objective: 'Inspect the diff.',
      outputs: [{ id: 'review', kind: 'review', description: 'Review report.' }],
    },
  ],
};

describe('FileFactoryEventStore', () => {
  test('appends JSONL envelopes and reconstructs state through the core reducer', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-events-'));
    try {
      const times = [
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:01.000Z'),
        new Date('2026-01-01T00:00:02.000Z'),
      ];
      const store = new FileFactoryEventStore({ rootDir, now: () => times.shift() ?? new Date('2026-01-01T00:00:03.000Z') });
      const plan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Review auth changes', mode: 'review' }, 'run-1');

      const events: FactoryEvent[] = [
        { type: 'run_started', runId: 'run-1', plan },
        { type: 'artifact_created', runId: 'run-1', artifact: { id: 'review-1', kind: 'review', summary: 'Looks good', phaseId: 'review' } },
        { type: 'run_completed', runId: 'run-1', result: { status: 'completed', summary: 'Review complete', artifacts: [] } },
      ];

      expect(store.append('run-1', events[0]).sequence).toBe(1);
      expect(store.append('run-1', events[1]).sequence).toBe(2);
      expect(store.append('run-1', events[2]).sequence).toBe(3);

      const envelopes = store.readEnvelopes('run-1');
      expect(envelopes.map(envelope => envelope.sequence)).toEqual([1, 2, 3]);
      expect(envelopes.map(envelope => envelope.timestamp)).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:02.000Z',
      ]);

      const state = store.readState('run-1');
      expect(state.status).toBe('completed');
      expect(state.artifacts.map(artifact => artifact.id)).toEqual(['review-1']);
      expect(state.result?.summary).toBe('Review complete');

      expect(store.readManifest('run-1')).toEqual({
        runId: 'run-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        eventCount: 3,
      });
      expect(store.listRunIds()).toEqual(['run-1']);

      const rawLog = readFileSync(store.eventsPath('run-1'), 'utf-8');
      expect(rawLog.trim().split('\n')).toHaveLength(3);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('rejects mismatched or unsafe run ids', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-events-'));
    try {
      const store = new FileFactoryEventStore({ rootDir });
      const plan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Review auth changes' }, 'run-safe');

      expect(() => assertSafeRunId('../escape')).toThrow('Unsafe factory run id');
      expect(() => store.readEvents('../escape')).toThrow('Unsafe factory run id');
      expect(() => store.append('run-safe', { type: 'run_started', runId: 'other-run', plan })).toThrow("does not match store runId");

      mkdirSync(path.dirname(store.eventsPath('run-safe')), { recursive: true });
      writeFileSync(store.eventsPath('run-safe'), `${JSON.stringify({ sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', event: { type: 'run_started', runId: 'other-run', plan } })}\n`);
      expect(() => store.readEvents('run-safe')).toThrow("contains event for 'other-run'");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('parses event logs fail-closed on malformed lines', () => {
    expect(parseFactoryEventLog('')).toEqual([]);
    expect(() => parseFactoryEventLog('{not json}\n')).toThrow('Invalid factory event JSON on line 1');
    expect(() => parseFactoryEventLog('{"sequence":1,"timestamp":"now","event":{"type":"run_started"}}\n')).toThrow(
      'Invalid factory event envelope on line 1',
    );
    expect(() => parseFactoryEventLog('{"sequence":2,"timestamp":"now","event":{"type":"run_failed","runId":"run-1","error":{"code":"x","message":"boom"}}}\n')).toThrow(
      'Invalid factory event sequence on line 1: expected 1, got 2',
    );
  });
});
