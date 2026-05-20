import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileFactoryEventStore } from '../lib/factory-event-store';
import { FactoryRunner } from '../lib/factory-runner';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';
import type { FactoryRuntimeCapabilities } from '../lib/factory-capabilities';
import { compileRunPlan, type ArtifactRef, type CapabilityName, type WorkflowSpec } from '../lib/factory-core';

function tempStore() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-runner-'));
  return { rootDir, store: new FileFactoryEventStore({ rootDir }) };
}

const ISOLATED_WORKFLOW: WorkflowSpec = {
  id: 'isolated-build',
  title: 'Isolated Build',
  description: 'Build in an isolated worktree.',
  phases: [{
    id: 'implementation',
    title: 'Implementation',
    role: { id: 'worker', title: 'Worker' },
    objective: 'Write code in isolation.',
    concurrency: 'isolated-worktree',
    worktree: { owner: 'implementation', integrationStrategy: 'artifact-only' },
    outputs: [{ id: 'diff', kind: 'diff', description: 'Implementation diff.' }],
    modes: ['build'],
  }],
};

const POLICY_GATED_WORKFLOW: WorkflowSpec = {
  id: 'policy-gated',
  title: 'Policy Gated',
  description: 'Policy gate decisions are not user-approvable.',
  phases: [{
    id: 'deploy-readiness',
    title: 'Deploy Readiness',
    role: { id: 'policy', title: 'Policy' },
    objective: 'Require policy readiness.',
    gates: [{ id: 'deploy-readiness-confirmed', title: 'Deploy readiness confirmed', description: 'Policy must confirm readiness.', kind: 'policy', failClosed: true }],
    outputs: [{ id: 'approval', kind: 'plan', description: 'Approval record.' }],
  }],
};

const GATED_WORKFLOW: WorkflowSpec = {
  id: 'gated-review',
  title: 'Gated Review',
  description: 'Review with approval gates.',
  phases: [{
    id: 'review',
    title: 'Review',
    role: { id: 'reviewer', title: 'Reviewer' },
    objective: 'Run review after approval.',
    gates: [{ id: 'approve-review', title: 'Approve review', description: 'Approve running the review.', kind: 'human-decision', failClosed: true }],
    outputs: [{ id: 'review', kind: 'review', description: 'Review output.' }],
  }],
};

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

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' } });

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

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' } });

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

      const failed = await firstRunner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' } });
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

  test('blocks resumed runs when required scheduler capabilities are unavailable', async () => {
    const { rootDir, store } = tempStore();
    try {
      const compiledPlan = compileRunPlan(ISOLATED_WORKFLOW, {
        workflow: 'isolated-build',
        goal: 'Build auth changes',
        cwd: '/repo',
        mode: 'build',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      }, 'run-isolated-resume');
      const plan = {
        ...compiledPlan,
        requiredCapabilities: [],
        phases: compiledPlan.phases.map(phase => ({ ...phase, requiredCapabilities: [] })),
      };
      store.append('run-isolated-resume', { type: 'run_started', runId: 'run-isolated-resume', plan });
      const fakeRuntime = runtime(['agent-session', 'artifact-store']);
      const runner = new FactoryRunner({ workflows: [ISOLATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-isolated-resume');
      expect(result.status).toBe('blocked');
      expect(result.start.missingCapabilities).toEqual(['subagent-session', 'worktree']);
      expect(fakeRuntime.executed).toEqual([]);
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
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
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

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' } });
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

      await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' } });
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
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
        repo: { provider: 'github', owner: 'garrytan', name: 'gstack' },
        context: { ticket: 'ENG-1', nested: { attempt: 1 } },
      });

      await expect(runner.continueRun('run-context', {
        workflow: 'review',
        goal: 'Review auth changes',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      })).resolves.toMatchObject({ status: 'completed' });

      await expect(runner.continueRun('run-context', {
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
        repo: { provider: 'github', owner: 'garrytan', name: 'other' },
        context: { ticket: 'ENG-1', nested: { attempt: 2 } },
      })).rejects.toThrow('does not match persisted factory run');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('pauses on phase gates and resumes after approval', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({
        workflows: [GATED_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-gated',
      });

      const paused = await runner.run({ workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' });
      expect(paused.status).toBe('paused');
      expect(fakeRuntime.executed).toEqual([]);
      expect(paused.state.currentPhaseId).toBe('review');
      expect(paused.state.pendingGates).toMatchObject([{ id: 'approve-review', phaseId: 'review', options: ['approve', 'reject', 'cancel'] }]);

      const requestSequence = store.readEnvelopes('run-gated').find(envelope => envelope.event.type === 'gate_requested')!.sequence;
      store.append('run-gated', { type: 'gate_decision', runId: 'run-gated', decision: { gateId: 'approve-review', requestSequence, decision: 'approve', decidedBy: 'user' } });
      const resumed = await runner.continueRun('run-gated');
      expect(resumed.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['review']);
      expect(resumed.state.completedPhaseIds).toEqual(['review']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('cancels when a gate is rejected or cancelled', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({
        workflows: [GATED_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-gate-rejected',
      });

      await runner.run({ workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' });
      const requestSequence = store.readEnvelopes('run-gate-rejected').find(envelope => envelope.event.type === 'gate_requested')!.sequence;
      store.append('run-gate-rejected', { type: 'gate_decision', runId: 'run-gate-rejected', decision: { gateId: 'approve-review', requestSequence, decision: 'reject', decidedBy: 'user' } });
      const rejected = await runner.continueRun('run-gate-rejected');
      expect(rejected.status).toBe('cancelled');
      expect(rejected.state.status).toBe('cancelled');
      expect(rejected.state.result?.summary).toContain("cancelled by gate 'approve-review'");
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('treats reopened gates as pending instead of applying stale cancellation decisions', async () => {
    for (const decision of ['reject', 'cancel'] as const) {
      const { rootDir, store } = tempStore();
      try {
        const runId = `run-reopened-${decision}`;
        const fakeRuntime = runtime(['questions']);
        const runner = new FactoryRunner({
          workflows: [GATED_WORKFLOW],
          eventSink: store,
          runtime: fakeRuntime,
          makeRunId: () => runId,
        });

        await runner.run({ workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' });
        const requestSequence = store.readEnvelopes(runId).find(envelope => envelope.event.type === 'gate_requested')!.sequence;
        store.append(runId, { type: 'gate_decision', runId, decision: { gateId: 'approve-review', requestSequence, decision, decidedBy: 'user' } });
        store.append(runId, {
          type: 'gate_requested',
          runId,
          gate: { id: 'approve-review', phaseId: 'review', title: 'Reopened review gate', description: 'Fresh decision required.' },
        });

        const reopened = await runner.continueRun(runId);
        expect(reopened.status).toBe('paused');
        expect(reopened.state.pendingGates).toMatchObject([{ id: 'approve-review', title: 'Reopened review gate' }]);
        expect(reopened.state.gateDecisions).toEqual([]);
        expect(fakeRuntime.executed).toEqual([]);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  });

  test('grandfathers legacy gate decisions without request sequences for a single request', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-legacy-decision');
      store.append('run-legacy-decision', { type: 'run_started', runId: 'run-legacy-decision', plan });
      store.append('run-legacy-decision', {
        type: 'gate_requested',
        runId: 'run-legacy-decision',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      store.append('run-legacy-decision', {
        type: 'gate_decision',
        runId: 'run-legacy-decision',
        decision: { gateId: 'approve-review', decision: 'approve', decidedBy: 'user' },
      });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-legacy-decision');
      expect(result.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['review']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed when a stale decision is appended after a gate is reopened', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-stale-reopened-decision');
      store.append('run-stale-reopened-decision', { type: 'run_started', runId: 'run-stale-reopened-decision', plan });
      const firstRequest = store.append('run-stale-reopened-decision', {
        type: 'gate_requested',
        runId: 'run-stale-reopened-decision',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      store.append('run-stale-reopened-decision', {
        type: 'gate_decision',
        runId: 'run-stale-reopened-decision',
        decision: { gateId: 'approve-review', requestSequence: firstRequest.sequence, decision: 'approve', decidedBy: 'user' },
      });
      store.append('run-stale-reopened-decision', {
        type: 'gate_requested',
        runId: 'run-stale-reopened-decision',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      store.append('run-stale-reopened-decision', {
        type: 'gate_decision',
        runId: 'run-stale-reopened-decision',
        decision: { gateId: 'approve-review', decision: 'approve', decidedBy: 'user' },
      });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-stale-reopened-decision');
      expect(result.status).toBe('failed');
      expect(result.state.error?.message).toBe("Factory gate 'approve-review' request is stale");
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on persisted waive decisions for fail-closed gates with omitted options', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-fail-closed-waive');
      store.append('run-fail-closed-waive', { type: 'run_started', runId: 'run-fail-closed-waive', plan });
      const request = store.append('run-fail-closed-waive', {
        type: 'gate_requested',
        runId: 'run-fail-closed-waive',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      store.append('run-fail-closed-waive', {
        type: 'gate_decision',
        runId: 'run-fail-closed-waive',
        decision: { gateId: 'approve-review', requestSequence: request.sequence, decision: 'waive', decidedBy: 'user' },
      });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-fail-closed-waive');
      expect(result.status).toBe('failed');
      expect(result.state.error?.message).toBe("Persisted factory gate decision 'waive' is not allowed for gate 'approve-review'");
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('does not expose approve or waive options for policy gates', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({
        workflows: [POLICY_GATED_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-policy-gate',
      });

      const result = await runner.run({ workflow: 'policy-gated', goal: 'Check deploy readiness', mode: 'review' });
      expect(result.status).toBe('paused');
      expect(result.state.pendingGates[0]).toMatchObject({
        id: 'deploy-readiness-confirmed',
        kind: 'policy',
        options: ['reject', 'cancel'],
        recommendation: 'reject',
      });
      expect(fakeRuntime.executed).toEqual([]);
      const requestSequence = store.readEnvelopes('run-policy-gate').find(envelope => envelope.event.type === 'gate_requested')!.sequence;
      store.append('run-policy-gate', {
        type: 'gate_decision',
        runId: 'run-policy-gate',
        decision: { gateId: 'deploy-readiness-confirmed', requestSequence, decision: 'approve', decidedBy: 'policy' },
      });
      const approved = await runner.continueRun('run-policy-gate');
      expect(approved.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['deploy-readiness']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on persisted policy gate approvals when options are omitted', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(POLICY_GATED_WORKFLOW, { workflow: 'policy-gated', goal: 'Check deploy readiness', mode: 'review' }, 'run-policy-approve');
      store.append('run-policy-approve', { type: 'run_started', runId: 'run-policy-approve', plan });
      const request = store.append('run-policy-approve', {
        type: 'gate_requested',
        runId: 'run-policy-approve',
        gate: { id: 'deploy-readiness-confirmed', phaseId: 'deploy-readiness', title: 'Deploy readiness confirmed', description: 'Policy must confirm readiness.', kind: 'policy', options: ['approve', 'reject', 'cancel'] },
      });
      store.append('run-policy-approve', {
        type: 'gate_decision',
        runId: 'run-policy-approve',
        decision: { gateId: 'deploy-readiness-confirmed', requestSequence: request.sequence, decision: 'approve', decidedBy: 'user' },
      });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [POLICY_GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-policy-approve');
      expect(result.status).toBe('failed');
      expect(result.state.error?.message).toBe("Persisted factory gate decision 'approve' is not allowed for gate 'deploy-readiness-confirmed'");
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fail-closes gates when questions are unavailable', async () => {
    const { rootDir, store } = tempStore();
    try {
      const fakeRuntime = runtime([]);
      const runner = new FactoryRunner({
        workflows: [GATED_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-gate-fail-closed',
      });

      const result = await runner.run({ workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' });
      expect(result.status).toBe('cancelled');
      expect(result.state.status).toBe('cancelled');
      expect(result.state.gateDecisions).toMatchObject([{ gateId: 'approve-review', decision: 'reject', decidedBy: 'policy' }]);
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on malformed gate decisions before executing a gated phase', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-bogus-decision');
      store.append('run-bogus-decision', { type: 'run_started', runId: 'run-bogus-decision', plan });
      const request = store.append('run-bogus-decision', {
        type: 'gate_requested',
        runId: 'run-bogus-decision',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      store.append('run-bogus-decision', { type: 'gate_decision', runId: 'run-bogus-decision', decision: { gateId: 'approve-review', requestSequence: request.sequence, decision: 'bogus', decidedBy: 'user' } });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-bogus-decision');
      expect(result.status).toBe('failed');
      expect(result.state.error?.message).toBe("Invalid persisted factory gate decision 'bogus' for gate 'approve-review'");
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on disallowed gate decisions before executing a gated phase', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-disallowed-decision');
      store.append('run-disallowed-decision', { type: 'run_started', runId: 'run-disallowed-decision', plan });
      const request = store.append('run-disallowed-decision', {
        type: 'gate_requested',
        runId: 'run-disallowed-decision',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.', options: ['cancel'] },
      });
      store.append('run-disallowed-decision', { type: 'gate_decision', runId: 'run-disallowed-decision', decision: { gateId: 'approve-review', requestSequence: request.sequence, decision: 'approve', decidedBy: 'user' } });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-disallowed-decision');
      expect(result.status).toBe('failed');
      expect(result.state.error?.message).toBe("Persisted factory gate decision 'approve' is not allowed for gate 'approve-review'");
      expect(fakeRuntime.executed).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('fails closed on orphan gate decisions before executing a gated phase', async () => {
    const { rootDir, store } = tempStore();
    try {
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-orphan');
      store.append('run-orphan', { type: 'run_started', runId: 'run-orphan', plan });
      store.append('run-orphan', { type: 'gate_decision', runId: 'run-orphan', decision: { gateId: 'approve-review', decision: 'approve', decidedBy: 'user' } });
      const fakeRuntime = runtime(['questions']);
      const runner = new FactoryRunner({ workflows: [GATED_WORKFLOW], eventSink: store, runtime: fakeRuntime });

      const result = await runner.continueRun('run-orphan');
      expect(result.status).toBe('failed');
      expect(result.state.error?.message).toBe("Factory gate 'approve-review' has a decision without a request");
      expect(fakeRuntime.executed).toEqual([]);
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

      const result = await runner.run({ workflow: 'review', goal: 'Review auth changes', cwd: '/repo', mode: 'review', policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' } });
      expect(result.status).toBe('completed');
      expect(result.state.completedPhaseIds).toEqual(['review-intake', 'diff-review', 'review-summary']);
      expect(result.state.risks.map(risk => risk.id)).toContain('diff-review-continued-after-error');
      expect(result.state.artifacts.map(artifact => artifact.id)).toContain('diff-review-continued-after-error');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
