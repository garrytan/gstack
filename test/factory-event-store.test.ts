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

      writeFileSync(store.manifestPath('run-1'), `${JSON.stringify({ runId: 'run-1', createdAt: 'x', updatedAt: 'x', eventCount: 'abc' })}\n`);
      expect(() => store.readManifest('run-1')).toThrow("Factory run manifest for 'run-1' is invalid");

      const rawLog = readFileSync(store.eventsPath('run-1'), 'utf-8');
      expect(rawLog.trim().split('\n')).toHaveLength(3);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('appendPrepared validates against the locked snapshot before caller side effects', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-events-'));
    try {
      const store = new FileFactoryEventStore({ rootDir, now: () => new Date('2026-01-01T00:00:00.000Z') });
      const plan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Review auth changes', mode: 'review' }, 'run-prepared');
      const sideEffects: string[] = [];

      store.append('run-prepared', { type: 'run_started', runId: 'run-prepared', plan });
      const envelope = store.appendPrepared('run-prepared', (current) => {
        expect(current).toHaveLength(1);
        sideEffects.push('artifact-written-after-validation');
        return { type: 'artifact_created', runId: 'run-prepared', artifact: { id: 'review-1', kind: 'review', summary: 'Prepared', phaseId: 'review' } };
      });

      expect(envelope.sequence).toBe(2);
      expect(sideEffects).toEqual(['artifact-written-after-validation']);
      expect(store.readEvents('run-prepared')).toHaveLength(2);

      expect(() => store.appendPrepared('run-prepared', (current) => {
        if (current.length !== 1) throw new Error('run is no longer pending capture');
        sideEffects.push('stale-artifact-write');
        return { type: 'artifact_created', runId: 'run-prepared', artifact: { id: 'stale', kind: 'review', summary: 'stale', phaseId: 'review' } };
      })).toThrow('run is no longer pending capture');
      expect(sideEffects).toEqual(['artifact-written-after-validation']);

      expect(() => store.appendPrepared('run-prepared', () => ({
        type: 'artifact_created',
        runId: 'other-run',
        artifact: { id: 'wrong-run', kind: 'review', summary: 'wrong', phaseId: 'review' },
      }))).toThrow("does not match store runId");
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

      const otherPlan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Other run' }, 'other-run');
      mkdirSync(path.dirname(store.eventsPath('run-safe')), { recursive: true });
      writeFileSync(store.manifestPath('run-safe'), `${JSON.stringify({ runId: 'run-safe', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', eventCount: 1 })}\n`);
      writeFileSync(store.eventsPath('run-safe'), `${JSON.stringify({ sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', event: { type: 'run_started', runId: 'other-run', plan: otherPlan } })}\n`);
      expect(() => store.readEvents('run-safe')).toThrow("contains event for 'other-run'");

      writeFileSync(store.manifestPath('run-safe'), `${JSON.stringify({ runId: 'run-safe', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', eventCount: 0 })}\n`);
      writeFileSync(store.eventsPath('run-safe'), `${JSON.stringify({ sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', event: { type: 'run_started', runId: 'run-safe', plan } })}\n`);
      expect(() => store.append('run-safe', { type: 'run_started', runId: 'run-safe', plan })).toThrow('contains uncommitted tail after manifest eventCount 0');
      expect(readFileSync(store.eventsPath('run-safe'), 'utf-8').trim().split('\n')).toHaveLength(1);

      rmSync(store.manifestPath('run-safe'), { force: true });
      expect(store.readManifest('run-safe')).toBeNull();
      expect(() => store.readEvents('run-safe')).toThrow("exists without a manifest");

      writeFileSync(store.manifestPath('run-safe'), `${JSON.stringify({ runId: 'run-safe', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', eventCount: 1 })}\n`);
      rmSync(store.eventsPath('run-safe'), { force: true });
      expect(store.listRunIds()).toEqual([]);
      expect(() => store.readEvents('run-safe')).toThrow("exists without an event log");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on a valid-looking event-log tail when manifest eventCount lags', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-events-'));
    try {
      const store = new FileFactoryEventStore({ rootDir, now: () => new Date('2026-01-01T00:00:02.000Z') });
      const plan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Review auth changes', mode: 'review' }, 'run-recover-tail');
      mkdirSync(path.dirname(store.eventsPath('run-recover-tail')), { recursive: true });
      writeFileSync(store.manifestPath('run-recover-tail'), `${JSON.stringify({
        runId: 'run-recover-tail',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        eventCount: 1,
      })}\n`);
      writeFileSync(store.eventsPath('run-recover-tail'), [
        JSON.stringify({ sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', event: { type: 'run_started', runId: 'run-recover-tail', plan } }),
        JSON.stringify({ sequence: 2, timestamp: '2026-01-01T00:00:01.000Z', event: { type: 'artifact_created', runId: 'run-recover-tail', artifact: { id: 'review-1', kind: 'review', summary: 'Recovered artifact', phaseId: 'review' } } }),
        '',
      ].join('\n'));

      expect(() => store.readState('run-recover-tail')).toThrow('contains uncommitted tail after manifest eventCount 1');
      expect(store.readManifest('run-recover-tail')?.eventCount).toBe(1);
      expect(() => store.append('run-recover-tail', { type: 'run_completed', runId: 'run-recover-tail', result: { status: 'completed', summary: 'Done', artifacts: [] } })).toThrow(
        'contains uncommitted tail after manifest eventCount 1',
      );
      expect(store.readManifest('run-recover-tail')?.eventCount).toBe(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on torn event-log tails after the manifest count', () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-events-'));
    try {
      const store = new FileFactoryEventStore({ rootDir, now: () => new Date('2026-01-01T00:00:01.000Z') });
      const plan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Review auth changes', mode: 'review' }, 'run-torn-tail');
      mkdirSync(path.dirname(store.eventsPath('run-torn-tail')), { recursive: true });
      writeFileSync(store.manifestPath('run-torn-tail'), `${JSON.stringify({
        runId: 'run-torn-tail',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        eventCount: 1,
      })}\n`);
      writeFileSync(store.eventsPath('run-torn-tail'), `${JSON.stringify({ sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', event: { type: 'run_started', runId: 'run-torn-tail', plan } })}\n{not json`);

      expect(() => store.readEvents('run-torn-tail')).toThrow('contains uncommitted tail after manifest eventCount 1');
      expect(() => store.append('run-torn-tail', { type: 'artifact_created', runId: 'run-torn-tail', artifact: { id: 'review-1', kind: 'review', summary: 'Clean append', phaseId: 'review' } })).toThrow(
        'contains uncommitted tail after manifest eventCount 1',
      );
      const raw = readFileSync(store.eventsPath('run-torn-tail'), 'utf-8');
      expect(raw).toContain('{not json');
      expect(raw.trim().split('\n')).toHaveLength(2);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('parses event logs fail-closed on malformed lines', () => {
    expect(parseFactoryEventLog('')).toEqual([]);
    expect(parseFactoryEventLog('{"sequence":1,"timestamp":"now","event":{"type":"run_failed","runId":"run-1","error":{"code":"x","message":"boom"}}}\n{not json', { expectedCount: 1 })).toHaveLength(1);
    expect(() => parseFactoryEventLog('{not json}\n')).toThrow('Invalid factory event JSON on line 1');
    expect(() => parseFactoryEventLog('{"sequence":1,"timestamp":"now","event":{"type":"run_started"}}\n')).toThrow(
      'Invalid factory event envelope on line 1',
    );
    expect(() => parseFactoryEventLog('{"sequence":2,"timestamp":"now","event":{"type":"run_failed","runId":"run-1","error":{"code":"x","message":"boom"}}}\n')).toThrow(
      'Invalid factory event sequence on line 1: expected 1, got 2',
    );
  });

  test('rejects malformed nested event payloads before reduction', () => {
    const plan = compileRunPlan(workflow, { workflow: 'review-flow', goal: 'Review auth changes', mode: 'review' }, 'run-1');
    const envelope = (event: unknown) => `${JSON.stringify({ sequence: 1, timestamp: '2026-01-01T00:00:00.000Z', event })}\n`;

    expect(() => parseFactoryEventLog(envelope({ type: 'run_started', runId: 'run-1', plan: { runId: 'run-1' } }))).toThrow(
      'Invalid factory event envelope on line 1',
    );
    expect(() => parseFactoryEventLog(envelope({ type: 'run_started', runId: 'run-2', plan }))).toThrow(
      'Invalid factory event envelope on line 1',
    );
    const isolatedPlanWithoutMetadata = {
      ...plan,
      phases: plan.phases.map(phase => ({ ...phase, concurrency: 'isolated-worktree' as const, worktree: undefined })),
    };
    expect(() => parseFactoryEventLog(envelope({ type: 'run_started', runId: 'run-1', plan: isolatedPlanWithoutMetadata }))).toThrow(
      'Invalid factory event envelope on line 1',
    );
    const isolatedPlanWithoutSchedulerCapabilities = {
      ...plan,
      phases: plan.phases.map(phase => ({
        ...phase,
        concurrency: 'isolated-worktree' as const,
        worktree: { owner: 'worker', integrationStrategy: 'artifact-only' as const },
        requiredCapabilities: [],
      })),
    };
    expect(parseFactoryEventLog(envelope({ type: 'run_started', runId: 'run-1', plan: isolatedPlanWithoutSchedulerCapabilities }))).toHaveLength(1);
    expect(() => parseFactoryEventLog(envelope({ type: 'phase_completed', runId: 'run-1', phaseId: 'review', artifacts: ['not-artifact'] }))).toThrow(
      'Invalid factory event envelope on line 1',
    );
    expect(() => parseFactoryEventLog(envelope({ type: 'run_completed', runId: 'run-1', result: { status: 'completed', summary: 'Done', artifacts: ['not-artifact'] } }))).toThrow(
      'Invalid factory event envelope on line 1',
    );
  });
});
