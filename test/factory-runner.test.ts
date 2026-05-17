import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileFactoryEventStore } from '../lib/factory-event-store';
import { FactoryRunner } from '../lib/factory-runner';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';
import type { FactoryRuntimeCapabilities } from '../lib/factory-capabilities';
import { compileRunPlan, type ArtifactRef, type CapabilityName } from '../lib/factory-core';

function tempStore() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-runner-'));
  return { rootDir, store: new FileFactoryEventStore({ rootDir }) };
}

function runtime(capabilities: CapabilityName[] = ['agent-session', 'artifact-store', 'git']): FactoryRuntimeCapabilities & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    availableCapabilities: capabilities,
    executePhase({ phase }) {
      executed.push(phase.id);
      const kind = phase.expectedArtifacts[0]?.kind ?? 'review';
      return {
        summary: `${phase.id} complete`,
        artifacts: [{ id: `${phase.id}-artifact`, kind, phaseId: phase.id, summary: `${phase.id} artifact` } satisfies ArtifactRef],
      };
    },
  };
}

describe('FactoryRunner', () => {
  test('runs structured review phases and persists completed state', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime();
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-review',
      });

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true } });

      expect(result.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['review-intake', 'diff-review', 'review-summary']);
      expect(result.state.status).toBe('completed');
      expect(result.state.completedPhaseIds).toEqual(['review-intake', 'diff-review', 'review-summary']);
      expect(result.state.artifacts.map(artifact => artifact.id)).toEqual([
        'review-intake-artifact',
        'diff-review-artifact',
        'review-summary-artifact',
      ]);
      expect(store.readManifest('run-review')?.eventCount).toBe(8);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('blocks before run_started when capabilities are missing', async () => {
    const { rootDir, store } = tempStore();
    try {
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: runtime(['artifact-store']),
        makeRunId: () => 'run-blocked',
      });

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true } });

      expect(result.status).toBe('blocked');
      expect(result.start.missingCapabilities).toEqual(['agent-session', 'git']);
      expect(store.readEvents('run-blocked')).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('does not resume runs already marked failed', async () => {
    const { rootDir, store } = tempStore();
    try {
      const firstRuntime = runtime();
      const firstRunner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: {
          ...firstRuntime,
          executePhase(input) {
            if (input.phase.id === 'diff-review') throw new Error('transient review failure');
            return firstRuntime.executePhase(input);
          },
        },
        makeRunId: () => 'run-resume',
      });

      const failed = await firstRunner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true } });
      expect(failed.status).toBe('failed');
      expect(failed.state.completedPhaseIds).toEqual(['review-intake']);

      const secondRuntime = runtime();
      const secondRunner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: secondRuntime,
      });

      const resumed = await secondRunner.continueRun('run-resume');
      expect(resumed.status).toBe('failed');
      expect(secondRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('continues an interrupted run from the first incomplete phase', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(FACTORY_REVIEW_WORKFLOW, {
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true },
      }, 'run-interrupted');
      store.append('run-interrupted', { type: 'run_started', runId: 'run-interrupted', plan });
      store.append('run-interrupted', { type: 'phase_started', runId: 'run-interrupted', phaseId: 'review-intake' });
      store.append('run-interrupted', {
        type: 'phase_completed',
        runId: 'run-interrupted',
        phaseId: 'review-intake',
        artifacts: [{ id: 'review-intake-artifact', kind: 'plan', phaseId: 'review-intake', summary: 'Existing intake artifact' }],
      });

      const fakeRuntime = runtime();
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
      });

      const result = await runner.continueRun('run-interrupted');
      expect(result.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['diff-review', 'review-summary']);
      expect(result.state.completedPhaseIds).toEqual(['review-intake', 'diff-review', 'review-summary']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('leaves run active when a phase returns pending external work', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime();
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: {
          ...fakeRuntime,
          executePhase(input) {
            if (input.phase.id === 'diff-review') {
              return {
                summary: 'Queued external review.',
                status: 'pending',
                artifacts: [{ id: 'diff-review-dispatch', kind: 'review', phaseId: 'diff-review', summary: 'External review queued.' }],
              };
            }
            return fakeRuntime.executePhase(input);
          },
        },
        makeRunId: () => 'run-pending',
      });

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true } });
      expect(result.status).toBe('running');
      expect(result.state.status).toBe('running');
      expect(result.state.currentPhaseId).toBe('diff-review');
      expect(result.state.completedPhaseIds).toEqual(['review-intake']);
      expect(result.state.artifacts.map(artifact => artifact.id)).toContain('diff-review-dispatch');
      expect(store.readEvents('run-pending').map(event => event.type)).not.toContain('run_completed');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('does not redispatch a pending external phase on resume', async () => {
    const { rootDir, store } = tempStore();
    try {
      const dispatches: string[] = [];
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: {
          availableCapabilities: ['agent-session', 'artifact-store', 'git'],
          executePhase({ phase }) {
            dispatches.push(phase.id);
            if (phase.id === 'diff-review') {
              return {
                summary: 'Queued external review.',
                status: 'pending',
                artifacts: [{
                  id: 'diff-review-dispatch',
                  kind: 'review',
                  phaseId: 'diff-review',
                  summary: 'External review queued.',
                }],
              };
            }
            return {
              summary: `${phase.id} complete`,
              artifacts: [{ id: `${phase.id}-artifact`, kind: phase.expectedArtifacts[0]?.kind ?? 'review', phaseId: phase.id, summary: `${phase.id} artifact` }],
            };
          },
        },
        makeRunId: () => 'run-pending-resume',
      });

      await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true } });
      const resumed = await runner.continueRun('run-pending-resume');
      expect(resumed.status).toBe('running');
      expect(dispatches).toEqual(['review-intake', 'diff-review']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('rejects resume requests that do not match persisted context', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime();
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-context',
      });

      await runner.run({
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true },
        repo: { provider: 'github', owner: 'garrytan', name: 'gstack' },
        context: { ticket: 'ENG-1', nested: { attempt: 1 } },
      });

      await expect(runner.continueRun('run-context', {
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true },
        repo: { provider: 'github', owner: 'garrytan', name: 'other' },
        context: { ticket: 'ENG-1', nested: { attempt: 2 } },
      })).rejects.toThrow('does not match persisted factory run');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('supports explicit continue-on-error hook for greenfield continuous runs', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime();
      const runner = new FactoryRunner({
        workflows: [FACTORY_REVIEW_WORKFLOW],
        eventSink: store,
        runtime: {
          ...fakeRuntime,
          executePhase(input) {
            if (input.phase.id === 'diff-review') throw new Error('known greenfield failure');
            return fakeRuntime.executePhase(input);
          },
          onPhaseError({ phase, error }) {
            return {
              action: 'continue',
              summary: `${phase.id} continued after ${(error as Error).message}`,
              risks: [{
                id: `${phase.id}-continued-after-error`,
                severity: 'warning',
                message: `${phase.id} failed but continuous mode kept the run moving.`,
                recommendation: 'Inspect the continued-after-error artifact before treating the run as final.',
              }],
            };
          },
        },
        makeRunId: () => 'run-continuous',
      });

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true } });
      expect(result.status).toBe('completed');
      expect(result.state.completedPhaseIds).toEqual(['review-intake', 'diff-review', 'review-summary']);
      expect(result.state.risks.map(risk => risk.id)).toContain('diff-review-continued-after-error');
      expect(result.state.artifacts.map(artifact => artifact.id)).toContain('diff-review-continued-after-error');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
