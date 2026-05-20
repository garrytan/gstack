import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileRunPlan, missingCapabilities, type ArtifactRef, type CapabilityName } from '../lib/factory-core';
import { FileFactoryEventStore } from '../lib/factory-event-store';
import { FactoryRunner } from '../lib/factory-runner';
import { FACTORY_WORKFLOWS } from '../lib/factory-review-workflow';
import { FACTORY_SHIP_WORKFLOW } from '../lib/factory-ship-workflow';
import type { FactoryRuntimeCapabilities } from '../lib/factory-capabilities';

describe('FACTORY_SHIP_WORKFLOW', () => {
  test('compiles a gated plan-only ship contract without executing actions', () => {
    const plan = compileRunPlan(FACTORY_SHIP_WORKFLOW, {
      workflow: 'ship',
      goal: 'Ship package 1.2.3',
      cwd: '/repo',
      mode: 'plan-only',
    }, 'run-ship-plan');

    expect(FACTORY_SHIP_WORKFLOW.title).toBe('Structured Ship Readiness');
    expect(FACTORY_SHIP_WORKFLOW.description).toContain('without executing release or deployment actions');
    expect(plan.workflow).toBe('ship');
    expect(plan.mode).toBe('plan-only');
    expect(plan.policy).toMatchObject({
      allowWrites: false,
      allowNetwork: false,
      requireHumanForDestructive: true,
      defaultQuestionMode: 'fail-closed',
    });
    expect(plan.phases.map(phase => phase.id)).toEqual(['ship-intake', 'ship-summary']);
    expect(plan.phases.flatMap(phase => phase.gates.map(gate => gate.id))).toEqual([]);
    expect(plan.requiredCapabilities).toEqual(['artifact-store']);
    expect(plan.expectedArtifacts.map(artifact => artifact.kind)).toEqual(['plan', 'release-note']);
  });

  test('blocks safely when ship runtime capabilities are missing', () => {
    const plan = compileRunPlan(FACTORY_SHIP_WORKFLOW, {
      workflow: 'ship',
      goal: 'Ship package 1.2.3',
      cwd: '/repo',
      mode: 'ship',
    }, 'run-ship');

    expect(plan.phases.flatMap(phase => phase.gates.map(gate => gate.id))).toEqual([
      'review-status-clean',
      'tests-passing',
      'version-bump-ready',
      'changelog-ready',
      'ci-green',
      'pr-ready',
      'release-approved',
      'deploy-readiness-confirmed',
    ]);
    expect(missingCapabilities(plan, ['artifact-store'])).toEqual(['ci', 'pull-request', 'questions', 'test-runner']);
    expect(plan.risks.map(risk => risk.id)).not.toContain('writes-disabled');
    expect(plan.risks.map(risk => risk.id)).toContain('network-disabled');
  });

  test('runs through ship-readiness gates without release or write capabilities', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-ship-lifecycle-'));
    try {
      const store = new FileFactoryEventStore({ rootDir });
      const fakeRuntime = runtime(['artifact-store', 'test-runner', 'ci', 'pull-request', 'questions']);
      const runner = new FactoryRunner({
        workflows: [FACTORY_SHIP_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-ship-lifecycle',
      });

      const started = await runner.run({
        workflow: 'ship',
        goal: 'Verify release readiness',
        cwd: '/repo',
        mode: 'ship',
        policy: { allowNetwork: true },
      });
      expect(started.status).toBe('paused');
      expect(fakeRuntime.executed).toEqual(['ship-intake']);
      expect(started.plan.requiredCapabilities).not.toContain('filesystem');
      expect(started.plan.requiredCapabilities).not.toContain('git');
      expect(started.plan.policy.commandSafetyProfile).toBe('read-only');
      expect(started.state.pendingGates.map(gate => gate.id)).toEqual([
        'review-status-clean',
        'tests-passing',
        'version-bump-ready',
        'changelog-ready',
      ]);

      approvePendingGates(store, 'run-ship-lifecycle');
      const afterReadiness = await runner.continueRun('run-ship-lifecycle');
      expect(afterReadiness.status).toBe('paused');
      expect(fakeRuntime.executed).toEqual(['ship-intake', 'ship-readiness']);
      expect(afterReadiness.state.pendingGates.map(gate => gate.id)).toEqual(['ci-green', 'pr-ready']);

      approvePendingGates(store, 'run-ship-lifecycle');
      const afterPublicationReadiness = await runner.continueRun('run-ship-lifecycle');
      expect(afterPublicationReadiness.status).toBe('paused');
      expect(fakeRuntime.executed).toEqual(['ship-intake', 'ship-readiness', 'ship-publication-readiness']);
      expect(afterPublicationReadiness.state.pendingGates.map(gate => gate.id)).toEqual(['release-approved', 'deploy-readiness-confirmed']);

      approvePendingGates(store, 'run-ship-lifecycle');
      const completed = await runner.continueRun('run-ship-lifecycle');
      expect(completed.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['ship-intake', 'ship-readiness', 'ship-publication-readiness', 'ship-release-gate', 'ship-summary']);
      expect(completed.state.result?.summary).toBe("Factory run 'run-ship-lifecycle' completed 5 phase(s).");
      expect(completed.state.artifacts.map(artifact => artifact.id)).toEqual([
        'ship-intake-artifact',
        'ship-readiness-artifact',
        'ship-publication-readiness-artifact',
        'ship-release-gate-artifact',
        'ship-summary-artifact',
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('cancels ship-readiness safely when a readiness gate is rejected', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-ship-reject-'));
    try {
      const store = new FileFactoryEventStore({ rootDir });
      const fakeRuntime = runtime(['artifact-store', 'test-runner', 'ci', 'pull-request', 'questions']);
      const runner = new FactoryRunner({
        workflows: [FACTORY_SHIP_WORKFLOW],
        eventSink: store,
        runtime: fakeRuntime,
        makeRunId: () => 'run-ship-reject',
      });

      const started = await runner.run({
        workflow: 'ship',
        goal: 'Verify release readiness',
        cwd: '/repo',
        mode: 'ship',
        policy: { allowNetwork: true },
      });
      expect(started.status).toBe('paused');
      expect(fakeRuntime.executed).toEqual(['ship-intake']);

      const request = store.readEnvelopes('run-ship-reject')
        .find(envelope => envelope.event.type === 'gate_requested' && envelope.event.gate.id === 'review-status-clean')!;
      store.append('run-ship-reject', {
        type: 'gate_decision',
        runId: 'run-ship-reject',
        decision: { gateId: 'review-status-clean', requestSequence: request.sequence, decision: 'reject', decidedBy: 'user', reason: 'Review findings are not accepted.' },
      });

      const rejected = await runner.continueRun('run-ship-reject');
      expect(rejected.status).toBe('cancelled');
      expect(rejected.state.result?.summary).toContain("cancelled by gate 'review-status-clean'");
      expect(fakeRuntime.executed).toEqual(['ship-intake']);
      expect(rejected.state.completedPhaseIds).toEqual(['ship-intake']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('is registered in the public factory workflow list', () => {
    expect(FACTORY_WORKFLOWS.map(workflow => workflow.id)).toEqual(['review', 'qa', 'qa-fix', 'ship']);
  });
});

function runtime(capabilities: CapabilityName[]): FactoryRuntimeCapabilities & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    availableCapabilities: capabilities,
    executePhase({ phase }) {
      executed.push(phase.id);
      const artifact: ArtifactRef = {
        id: `${phase.id}-artifact`,
        kind: phase.expectedArtifacts[0]?.kind ?? 'plan',
        phaseId: phase.id,
        summary: `${phase.id} readiness artifact`,
      };
      return { summary: `${phase.id} complete`, artifacts: [artifact] };
    },
  };
}

function approvePendingGates(store: FileFactoryEventStore, runId: string): void {
  for (const envelope of store.readEnvelopes(runId)) {
    if (envelope.event.type !== 'gate_requested') continue;
    const state = store.readState(runId);
    if (!state.pendingGates.some(gate => gate.id === envelope.event.gate.id)) continue;
    store.append(runId, {
      type: 'gate_decision',
      runId,
      decision: { gateId: envelope.event.gate.id, requestSequence: envelope.sequence, decision: 'approve', decidedBy: 'user' },
    });
  }
}
