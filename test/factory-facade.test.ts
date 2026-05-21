import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFactoryFacade, planFactoryRun } from '../lib/factory';
import { FileFactoryArtifactStore } from '../lib/factory-artifact-store';
import { FileFactoryEventStore } from '../lib/factory-event-store';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';
import type { FactoryRuntimeCapabilities } from '../lib/factory-capabilities';
import { compileRunPlan, type ArtifactRef, type CapabilityName, type WorkflowSpec } from '../lib/factory-core';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'factory-facade-'));
}

const POLICY_GATED_WORKFLOW: WorkflowSpec = {
  id: 'policy-gated',
  title: 'Policy Gated',
  description: 'Workflow with a policy gate.',
  phases: [{
    id: 'policy-check',
    title: 'Policy Check',
    role: { id: 'policy', title: 'Policy' },
    objective: 'Confirm policy readiness.',
    gates: [{ id: 'policy-ready', title: 'Policy ready', description: 'Policy readiness is confirmed.', kind: 'policy', failClosed: true }],
    outputs: [{ id: 'approval', kind: 'plan', description: 'Policy approval.' }],
  }],
};

const GATED_WORKFLOW: WorkflowSpec = {
  id: 'gated-review',
  title: 'Gated Review',
  description: 'Review with a human gate.',
  phases: [{
    id: 'review',
    title: 'Review',
    role: { id: 'reviewer', title: 'Reviewer' },
    objective: 'Review after approval.',
    gates: [{ id: 'approve-review', title: 'Approve review', description: 'Approve running review.', kind: 'human-decision', failClosed: true }],
    outputs: [{ id: 'review', kind: 'review', description: 'Review output.' }],
  }],
};

function runtime(capabilities: CapabilityName[] = ['agent-session', 'artifact-store', 'git'], rootDir?: string): FactoryRuntimeCapabilities & { executed: string[] } {
  const executed: string[] = [];
  const artifactStore = rootDir ? new FileFactoryArtifactStore({ rootDir }) : null;
  return {
    executed,
    availableCapabilities: capabilities,
    executePhase({ phase, plan }) {
      executed.push(phase.id);
      const artifact: ArtifactRef = { id: `${phase.id}-artifact`, kind: phase.expectedArtifacts[0]?.kind ?? 'review', phaseId: phase.id, summary: `${phase.id} artifact` };
      const ref = artifactStore ? artifactStore.writeText(plan.runId, artifact, `${phase.id} complete`) : artifact;
      return {
        summary: `${phase.id} complete`,
        artifacts: [ref],
      };
    },
  };
}

describe('factory facade', () => {
  test('plans factory runs without requiring stores or runtime wiring', () => {
    const plan = planFactoryRun({
      workflow: 'review',
      goal: 'Review auth changes',
      cwd: '/repo',
      mode: 'review',
      policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
    }, {
      workflows: [FACTORY_REVIEW_WORKFLOW],
      makeRunId: () => 'run-planned',
    });

    expect(plan.runId).toBe('run-planned');
    expect(plan.workflow).toBe('review');
    expect(plan.phases.map(phase => phase.id)).toEqual(['review-intake', 'diff-review', 'review-summary']);
  });

  test('runs, inspects, lists, continues, and reads artifacts through stable DTOs', async () => {
    const rootDir = tempRoot();
    try {
      const fakeRuntime = runtime(['agent-session', 'artifact-store', 'git'], rootDir);
      const facade = createFactoryFacade({
        runsRoot: rootDir,
        workflows: [FACTORY_REVIEW_WORKFLOW],
        runtime: fakeRuntime,
        makeRunId: () => 'run-facade',
      });

      const result = await facade.runFactoryWorkflow({
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      });

      expect(result.persisted).toBe(true);
      expect(result.run).toMatchObject({
        runId: 'run-facade',
        workflowId: 'review',
        workflowTitle: FACTORY_REVIEW_WORKFLOW.title,
        mode: 'review',
        goal: 'Review auth changes',
        status: 'completed',
        progress: { completed: 3, total: 3 },
      });
      expect(result.run.artifacts.map(artifact => artifact.id)).toEqual([
        'review-intake-artifact',
        'diff-review-artifact',
        'review-summary-artifact',
      ]);
      expect(result.run.updatedAt).toBeString();

      const listed = await facade.listFactoryRuns();
      expect(listed).toEqual([{
        runId: 'run-facade',
        workflowId: 'review',
        mode: 'review',
        goal: 'Review auth changes',
        status: 'completed',
        updatedAt: result.run.updatedAt,
        artifactCount: 3,
        pendingGateCount: 0,
        currentPhaseId: undefined,
      }]);

      const artifact = await facade.readFactoryArtifact('run-facade', 'diff-review-artifact');
      expect(artifact.runId).toBe('run-facade');
      expect(artifact.artifact.id).toBe('diff-review-artifact');
      expect(artifact.content).toBe(`${'diff-review'} complete`);

      const continued = await facade.continueFactoryRun('run-facade');
      expect(continued.run.status).toBe('completed');
      expect(fakeRuntime.executed).toEqual(['review-intake', 'diff-review', 'review-summary']);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('returns stable public DTO shapes for completed run list, status, and artifact reads', async () => {
    const rootDir = tempRoot();
    try {
      const facade = createFactoryFacade({
        runsRoot: rootDir,
        workflows: [FACTORY_REVIEW_WORKFLOW],
        runtime: runtime(['agent-session', 'artifact-store', 'git'], rootDir),
        makeRunId: () => 'run-dto-completed',
      });

      const result = await facade.runFactoryWorkflow({
        workflow: 'review',
        goal: 'Review DTO shape',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      });
      const status = await facade.readFactoryRunStatus('run-dto-completed');
      expect(Object.keys(status).sort()).toEqual([
        'artifacts',
        'completedPhaseIds',
        'createdAt',
        'currentPhase',
        'error',
        'gates',
        'goal',
        'mode',
        'pause',
        'progress',
        'resultSummary',
        'risks',
        'runId',
        'status',
        'updatedAt',
        'workflowId',
        'workflowTitle',
      ].sort());
      expect(status).toMatchObject({
        runId: 'run-dto-completed',
        workflowId: 'review',
        workflowTitle: 'Structured Review',
        mode: 'review',
        goal: 'Review DTO shape',
        status: 'completed',
        progress: { completed: 3, total: 3 },
        completedPhaseIds: ['review-intake', 'diff-review', 'review-summary'],
        gates: [],
        risks: [],
      });
      expect(result.run.updatedAt).toBe(status.updatedAt);

      const listItem = (await facade.listFactoryRuns())[0];
      expect(Object.keys(listItem).sort()).toEqual([
        'artifactCount',
        'currentPhaseId',
        'goal',
        'mode',
        'pendingGateCount',
        'runId',
        'status',
        'updatedAt',
        'workflowId',
      ].sort());
      expect(listItem).toMatchObject({
        runId: 'run-dto-completed',
        workflowId: 'review',
        mode: 'review',
        goal: 'Review DTO shape',
        status: 'completed',
        artifactCount: 3,
        pendingGateCount: 0,
        currentPhaseId: undefined,
      });

      const artifact = await facade.readFactoryArtifact('run-dto-completed', 'diff-review-artifact');
      expect(Object.keys(artifact).sort()).toEqual(['artifact', 'content', 'createdAt', 'runId'].sort());
      expect(artifact.runId).toBe('run-dto-completed');
      expect(artifact.artifact).toMatchObject({
        id: 'diff-review-artifact',
        kind: 'review',
        phaseId: 'diff-review',
        summary: 'diff-review artifact',
      });
      expect(artifact.artifact.path).toEndWith('diff-review-artifact.md');
      expect(artifact.content).toBe('diff-review complete');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('returns stable public DTO shape for paused gated runs', async () => {
    const rootDir = tempRoot();
    try {
      const store = new FileFactoryEventStore({ rootDir });
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review gated DTO', mode: 'review' }, 'run-dto-gated');
      store.append('run-dto-gated', { type: 'run_started', runId: 'run-dto-gated', plan });
      const request = store.append('run-dto-gated', {
        type: 'gate_requested',
        runId: 'run-dto-gated',
        gate: {
          id: 'approve-review',
          phaseId: 'review',
          title: 'Approve review',
          description: 'Approve running review.',
          options: ['approve', 'cancel'],
          recommendation: 'approve',
        },
      });
      const facade = createFactoryFacade({ runsRoot: rootDir, workflows: [GATED_WORKFLOW] });

      const status = await facade.readFactoryRunStatus('run-dto-gated');
      expect(status.status).toBe('paused');
      expect(status.pause).toEqual({ kind: 'gate', phaseId: 'review', gateIds: ['approve-review'] });
      expect(status.progress).toEqual({ completed: 0, total: 1 });
      expect(status.gates).toHaveLength(1);
      expect(Object.keys(status.gates[0]).sort()).toEqual([
        'allowedDecisions',
        'decision',
        'description',
        'failClosed',
        'id',
        'kind',
        'phaseId',
        'recommendation',
        'requestSequence',
        'status',
        'title',
      ].sort());
      expect(status.gates[0]).toEqual({
        id: 'approve-review',
        phaseId: 'review',
        title: 'Approve review',
        description: 'Approve running review.',
        kind: 'human-decision',
        failClosed: true,
        status: 'pending',
        requestSequence: request.sequence,
        allowedDecisions: ['approve', 'cancel'],
        recommendation: 'approve',
        decision: undefined,
      });

      const [gate] = await facade.listFactoryGates('run-dto-gated');
      expect(gate).toEqual(status.gates[0]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('reports pending external work as a paused run and omits untrusted event paths', async () => {
    const rootDir = tempRoot();
    try {
      const facade = createFactoryFacade({
        runsRoot: rootDir,
        workflows: [FACTORY_REVIEW_WORKFLOW],
        runtime: {
          availableCapabilities: ['agent-session', 'artifact-store', 'git'],
          executePhase({ phase }) {
            if (phase.id === 'diff-review') {
              return {
                summary: 'Queued external review.',
                status: 'pending',
                artifacts: [{
                  id: 'diff-review-dispatch',
                  kind: 'review',
                  phaseId: 'diff-review',
                  summary: 'External review queued.',
                  path: '/tmp/untrusted-event-path',
                }],
              };
            }
            return {
              summary: `${phase.id} complete`,
              artifacts: [{ id: `${phase.id}-artifact`, kind: phase.expectedArtifacts[0]?.kind ?? 'review', phaseId: phase.id, summary: `${phase.id} artifact` }],
            };
          },
        },
        makeRunId: () => 'run-paused-external',
      });

      const result = await facade.runFactoryWorkflow({
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      });

      expect(result.run.status).toBe('paused');
      expect(result.run.pause).toEqual({ kind: 'external-work', phaseId: 'diff-review' });
      expect(result.run.artifacts.find(artifact => artifact.id === 'diff-review-dispatch')?.path).toBeUndefined();
      expect((await facade.listFactoryRuns())[0].status).toBe('paused');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('lists and decides gates with runtime validation for untyped callers', async () => {
    const rootDir = tempRoot();
    try {
      const store = new FileFactoryEventStore({ rootDir });
      const plan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Review auth changes', mode: 'review' }, 'run-gated');
      store.append('run-gated', { type: 'run_started', runId: 'run-gated', plan });
      store.append('run-gated', {
        type: 'gate_requested',
        runId: 'run-gated',
        gate: {
          id: 'approve-review',
          phaseId: 'review',
          title: 'Approve review',
          description: 'Approve running review.',
          options: ['approve', 'cancel'],
          recommendation: 'approve',
        },
      });
      const facade = createFactoryFacade({ runsRoot: rootDir, workflows: [GATED_WORKFLOW] });

      const pendingGates = await facade.listFactoryGates('run-gated');
      expect(pendingGates).toMatchObject([{
        id: 'approve-review',
        status: 'pending',
        requestSequence: 2,
        allowedDecisions: ['approve', 'cancel'],
        recommendation: 'approve',
      }]);
      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'bogus' as any })).rejects.toThrow(
        "Invalid factory gate decision 'bogus'",
      );
      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'approve', reason: { why: 'bad' } as any })).rejects.toThrow(
        'Factory gate decision reason must be a string',
      );
      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'approve', decidedBy: 'robot' } as any)).rejects.toThrow(
        'Factory gate decisions through the public facade are recorded as user decisions',
      );
      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'reject' })).rejects.toThrow(
        "does not allow decision 'reject'",
      );

      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: 1, decision: 'approve' })).rejects.toThrow(
        "Factory gate 'approve-review' request is stale",
      );

      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'approve', reason: 'Looks safe' })).rejects.toThrow(
        "decision 'approve' requires a runtime-backed facade",
      );
      const runtimeFacade = createFactoryFacade({ runsRoot: rootDir, workflows: [GATED_WORKFLOW], runtime: runtime(['questions'], rootDir) });
      const decided = await runtimeFacade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'approve', reason: 'Looks safe' });
      expect(decided.gates[0]).toMatchObject({
        id: 'approve-review',
        status: 'approved',
        allowedDecisions: ['approve', 'cancel'],
        recommendation: 'approve',
        decision: { value: 'approve', decidedBy: 'user', reason: 'Looks safe' },
      });
      expect((await facade.listFactoryGates('run-gated'))[0]).toMatchObject({
        status: 'approved',
        allowedDecisions: ['approve', 'cancel'],
        recommendation: 'approve',
      });
      store.append('run-gated', {
        type: 'gate_requested',
        runId: 'run-gated',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve again', description: 'Reopened gate.', options: ['cancel'] },
      });
      const reopenedGate = (await facade.listFactoryGates('run-gated'))[0];
      expect(reopenedGate).toMatchObject({
        title: 'Approve again',
        status: 'pending',
        allowedDecisions: ['cancel'],
        decision: undefined,
      });
      expect(reopenedGate.requestSequence).toBeGreaterThan(pendingGates[0].requestSequence!);
      await expect(facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: pendingGates[0].requestSequence!, decision: 'cancel' })).rejects.toThrow(
        "Factory gate 'approve-review' request is stale",
      );
      const cancelled = await facade.decideFactoryGate({ runId: 'run-gated', gateId: 'approve-review', requestSequence: reopenedGate.requestSequence!, decision: 'cancel' });
      expect(cancelled.status).toBe('cancelled');

      const policyPlan = compileRunPlan(POLICY_GATED_WORKFLOW, { workflow: 'policy-gated', goal: 'Check deploy readiness', mode: 'review' }, 'run-policy-gate');
      store.append('run-policy-gate', { type: 'run_started', runId: 'run-policy-gate', plan: policyPlan });
      const policyRequest = store.append('run-policy-gate', {
        type: 'gate_requested',
        runId: 'run-policy-gate',
        gate: { id: 'policy-ready', phaseId: 'policy-check', title: 'Policy ready', description: 'Policy readiness is confirmed.', kind: 'policy', options: ['approve', 'reject', 'cancel'] },
      });
      const policyFacade = createFactoryFacade({ runsRoot: rootDir, workflows: [POLICY_GATED_WORKFLOW] });
      expect((await policyFacade.listFactoryGates('run-policy-gate'))[0].allowedDecisions).toEqual(['reject', 'cancel']);
      await expect(policyFacade.decideFactoryGate({ runId: 'run-policy-gate', gateId: 'policy-ready', requestSequence: policyRequest.sequence, decision: 'approve' })).rejects.toThrow(
        "does not allow decision 'approve'",
      );
      await expect(policyFacade.decideFactoryGate({ runId: 'run-policy-gate', gateId: 'policy-ready', requestSequence: policyRequest.sequence, decision: 'approve', decidedBy: 'policy' } as any)).rejects.toThrow(
        'Factory gate decisions through the public facade are recorded as user decisions',
      );

      const failClosedPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Fail closed omitted options', mode: 'review' }, 'run-fail-closed-options');
      store.append('run-fail-closed-options', { type: 'run_started', runId: 'run-fail-closed-options', plan: failClosedPlan });
      const failClosedRequest = store.append('run-fail-closed-options', {
        type: 'gate_requested',
        runId: 'run-fail-closed-options',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      expect((await facade.listFactoryGates('run-fail-closed-options'))[0].allowedDecisions).toEqual(['approve', 'reject', 'cancel']);
      await expect(facade.decideFactoryGate({ runId: 'run-fail-closed-options', gateId: 'approve-review', requestSequence: failClosedRequest.sequence, decision: 'waive' })).rejects.toThrow(
        "does not allow decision 'waive'",
      );

      const invalidPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Bad gate decision', mode: 'review' }, 'run-invalid-gate');
      store.append('run-invalid-gate', { type: 'run_started', runId: 'run-invalid-gate', plan: invalidPlan });
      const invalidRequest = store.append('run-invalid-gate', {
        type: 'gate_requested',
        runId: 'run-invalid-gate',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      store.append('run-invalid-gate', {
        type: 'gate_decision',
        runId: 'run-invalid-gate',
        decision: { gateId: 'approve-review', requestSequence: invalidRequest.sequence, decision: 'bogus', decidedBy: 'user' },
      });
      await expect(facade.listFactoryGates('run-invalid-gate')).rejects.toThrow(
        "Invalid persisted factory gate decision 'bogus' for gate 'approve-review'",
      );

      const disallowedPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Disallowed gate decision', mode: 'review' }, 'run-disallowed-gate');
      store.append('run-disallowed-gate', { type: 'run_started', runId: 'run-disallowed-gate', plan: disallowedPlan });
      const disallowedRequest = store.append('run-disallowed-gate', {
        type: 'gate_requested',
        runId: 'run-disallowed-gate',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.', options: ['cancel'] },
      });
      store.append('run-disallowed-gate', {
        type: 'gate_decision',
        runId: 'run-disallowed-gate',
        decision: { gateId: 'approve-review', requestSequence: disallowedRequest.sequence, decision: 'approve', decidedBy: 'user' },
      });
      await expect(facade.listFactoryGates('run-disallowed-gate')).rejects.toThrow(
        "Persisted factory gate decision 'approve' is not allowed for gate 'approve-review'",
      );

      const invalidOptionsPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Bad gate options', mode: 'review' }, 'run-invalid-options');
      store.append('run-invalid-options', { type: 'run_started', runId: 'run-invalid-options', plan: invalidOptionsPlan });
      store.append('run-invalid-options', {
        type: 'gate_requested',
        runId: 'run-invalid-options',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.', options: ['bogus'] },
      });
      await expect(facade.listFactoryGates('run-invalid-options')).rejects.toThrow(
        "Invalid persisted factory gate option 'bogus'",
      );

      const orphanPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Orphan gate decision', mode: 'review' }, 'run-orphan-gate');
      store.append('run-orphan-gate', { type: 'run_started', runId: 'run-orphan-gate', plan: orphanPlan });
      store.append('run-orphan-gate', {
        type: 'gate_decision',
        runId: 'run-orphan-gate',
        decision: { gateId: 'approve-review', decision: 'approve', decidedBy: 'user' },
      });
      await expect(facade.listFactoryGates('run-orphan-gate')).rejects.toThrow(
        "Factory gate decision 'approve-review' appears before a matching gate request",
      );

      const decisionBeforeRequestPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Decision before request', mode: 'review' }, 'run-decision-before-request');
      store.append('run-decision-before-request', { type: 'run_started', runId: 'run-decision-before-request', plan: decisionBeforeRequestPlan });
      store.append('run-decision-before-request', {
        type: 'gate_decision',
        runId: 'run-decision-before-request',
        decision: { gateId: 'approve-review', decision: 'approve', decidedBy: 'user' },
      });
      store.append('run-decision-before-request', {
        type: 'gate_requested',
        runId: 'run-decision-before-request',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.' },
      });
      await expect(facade.listFactoryGates('run-decision-before-request')).rejects.toThrow(
        "Factory gate decision 'approve-review' appears before a matching gate request",
      );

      const unknownPlan = compileRunPlan(GATED_WORKFLOW, { workflow: 'gated-review', goal: 'Unknown gate', mode: 'review' }, 'run-unknown-gate');
      store.append('run-unknown-gate', { type: 'run_started', runId: 'run-unknown-gate', plan: unknownPlan });
      store.append('run-unknown-gate', {
        type: 'gate_requested',
        runId: 'run-unknown-gate',
        gate: { id: 'missing-gate', phaseId: 'review', title: 'Unknown', description: 'Unknown gate.' },
      });
      await expect(facade.listFactoryGates('run-unknown-gate')).rejects.toThrow(
        "Factory gate request 'missing-gate' does not match the run plan",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('terminal gate decisions cancel even when runtime cannot resume the gated phase', async () => {
    const rootDir = tempRoot();
    try {
      const questionsGatedWorkflow: WorkflowSpec = {
        id: 'questions-gated',
        title: 'Questions Gated',
        description: 'Gate cancellation should not require runtime resume capabilities.',
        phases: [{
          id: 'review',
          title: 'Review',
          role: { id: 'reviewer', title: 'Reviewer' },
          objective: 'Review after approval.',
          requiredCapabilities: ['questions'],
          gates: [{ id: 'approve-review', title: 'Approve review', description: 'Approve running review.', kind: 'human-decision', failClosed: true }],
          outputs: [{ id: 'review', kind: 'review', description: 'Review output.' }],
        }],
      };
      const store = new FileFactoryEventStore({ rootDir });
      const plan = compileRunPlan(questionsGatedWorkflow, { workflow: 'questions-gated', goal: 'Review gated cancellation', mode: 'review' }, 'run-terminal-without-questions');
      store.append('run-terminal-without-questions', { type: 'run_started', runId: 'run-terminal-without-questions', plan });
      const request = store.append('run-terminal-without-questions', {
        type: 'gate_requested',
        runId: 'run-terminal-without-questions',
        gate: { id: 'approve-review', phaseId: 'review', title: 'Approve review', description: 'Approve running review.', options: ['approve', 'reject', 'cancel'], recommendation: 'reject' },
      });
      const facade = createFactoryFacade({ runsRoot: rootDir, workflows: [questionsGatedWorkflow], runtime: runtime([]) });

      const cancelled = await facade.decideFactoryGate({
        runId: 'run-terminal-without-questions',
        gateId: 'approve-review',
        requestSequence: request.sequence,
        decision: 'reject',
        reason: 'Do not run this phase.',
      });

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.resultSummary).toContain("cancelled by gate 'approve-review' decision 'reject'");
      expect((await facade.readFactoryRunStatus('run-terminal-without-questions')).status).toBe('cancelled');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('listFactoryArtifactContent returns trusted stored-text descriptors for store-attested artifacts', async () => {
    const rootDir = tempRoot();
    try {
      const facade = createFactoryFacade({
        runsRoot: rootDir,
        workflows: [FACTORY_REVIEW_WORKFLOW],
        runtime: runtime(['agent-session', 'artifact-store', 'git'], rootDir),
        makeRunId: () => 'run-content-trusted',
      });

      await facade.runFactoryWorkflow({
        workflow: 'review',
        goal: 'Review descriptor listing',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      });

      const descriptors = await facade.listFactoryArtifactContent('run-content-trusted', 'diff-review-artifact');
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        runId: 'run-content-trusted',
        artifactId: 'diff-review-artifact',
        kind: 'text',
        provenance: { source: 'artifact-store', trusted: true },
        hasInlineText: true,
        mediaType: 'text/markdown',
      });
      expect(descriptors[0].safeUri).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('listFactoryArtifactContent treats event-only artifacts as untrusted metadata-only descriptors and rejects unknown ids', async () => {
    const rootDir = tempRoot();
    try {
      const facade = createFactoryFacade({
        runsRoot: rootDir,
        workflows: [FACTORY_REVIEW_WORKFLOW],
        runtime: {
          availableCapabilities: ['agent-session', 'artifact-store', 'git'],
          executePhase({ phase }) {
            if (phase.id === 'diff-review') {
              return {
                summary: 'External review queued.',
                status: 'pending',
                artifacts: [{
                  id: 'diff-review-dispatch',
                  kind: 'review',
                  phaseId: 'diff-review',
                  summary: 'External review queued.',
                  uri: 'https://untrusted.example.test/raw',
                  path: '/tmp/untrusted-event-path',
                }],
              };
            }
            return {
              summary: `${phase.id} complete`,
              artifacts: [{ id: `${phase.id}-artifact`, kind: phase.expectedArtifacts[0]?.kind ?? 'review', phaseId: phase.id, summary: `${phase.id} artifact` }],
            };
          },
        },
        makeRunId: () => 'run-content-untrusted',
      });

      await facade.runFactoryWorkflow({
        workflow: 'review',
        goal: 'Review descriptor listing',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      });

      const descriptors = await facade.listFactoryArtifactContent('run-content-untrusted', 'diff-review-dispatch');
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        artifactId: 'diff-review-dispatch',
        kind: 'external-uri',
        provenance: { source: 'event-metadata', trusted: false },
      });
      expect(descriptors[0].safeUri).toBeUndefined();

      await expect(facade.listFactoryArtifactContent('run-content-untrusted', 'missing-artifact')).rejects.toThrow(
        "Factory artifact 'missing-artifact' not found for run 'run-content-untrusted'",
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('reports blocked preflight runs without persisting fake status records', async () => {
    const rootDir = tempRoot();
    try {
      const facade = createFactoryFacade({
        runsRoot: rootDir,
        workflows: [FACTORY_REVIEW_WORKFLOW],
        runtime: runtime(['artifact-store']),
        makeRunId: () => 'run-blocked',
      });

      const result = await facade.runFactoryWorkflow({
        workflow: 'review',
        goal: 'Review auth changes',
        cwd: '/repo',
        mode: 'review',
        policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
      });

      expect(result.persisted).toBe(false);
      expect(result.run.status).toBe('blocked');
      expect(result.missingCapabilities).toEqual(['agent-session', 'git']);
      expect(await facade.listFactoryRuns()).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
