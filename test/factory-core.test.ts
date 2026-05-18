import { describe, expect, test } from 'bun:test';
import {
  compileRunPlan,
  DEFAULT_FACTORY_POLICY,
  mergePolicy,
  missingCapabilities,
  reduceFactoryEvents,
  selectWorkflow,
  slugifyFactoryId,
  type FactoryEvent,
  type WorkflowSpec,
} from '../lib/factory-core';

const workflow: WorkflowSpec = {
  id: 'autoplan-build',
  title: 'Autoplan Build',
  description: 'Plan, build, review, and QA a feature.',
  requiredCapabilities: ['agent-session', 'artifact-store'],
  defaultPolicy: { allowNetwork: true },
  phases: [
    {
      id: 'intake',
      title: 'Intake',
      role: { id: 'office-hours', title: 'Office Hours' },
      objective: 'Understand the user pain before designing a solution.',
      requiredCapabilities: ['questions'],
      outputs: [{ id: 'design-doc', kind: 'design-doc', description: 'Problem framing and chosen wedge.' }],
      modes: ['plan-only', 'build'],
    },
    {
      id: 'implementation',
      title: 'Implementation',
      role: { id: 'worker', title: 'Implementation Agent' },
      objective: 'Apply the approved plan in a repository.',
      concurrency: 'isolated-worktree',
      requiredCapabilities: ['filesystem', 'git', 'worktree'],
      outputs: [{ id: 'diff', kind: 'diff', description: 'Implemented code diff.' }],
      gates: [{ id: 'approve-plan', title: 'Approve plan', description: 'User approves the implementation plan.', kind: 'human-decision', failClosed: true }],
      modes: ['build'],
    },
    {
      id: 'qa',
      title: 'QA',
      role: { id: 'qa', title: 'QA Lead' },
      objective: 'Verify the feature in a browser.',
      requiredCapabilities: ['browser', 'test-runner'],
      outputs: [{ id: 'qa-report', kind: 'qa-report', description: 'Browser QA findings.' }],
      modes: ['build', 'review'],
    },
  ],
};

describe('factory-core pure calculations', () => {
  test('mergePolicy applies defaults, workflow policy, then request override', () => {
    expect(mergePolicy({ allowNetwork: true }, { allowWrites: true })).toEqual({
      ...DEFAULT_FACTORY_POLICY,
      allowNetwork: true,
      allowWrites: true,
    });
  });

  test('selectWorkflow returns matching workflow or throws with available ids', () => {
    expect(selectWorkflow([workflow], 'autoplan-build')).toBe(workflow);
    expect(() => selectWorkflow([workflow], 'missing')).toThrow('autoplan-build');
  });

  test('compileRunPlan filters phases by mode and derives capabilities/artifacts', () => {
    const plan = compileRunPlan(workflow, {
      workflow: 'autoplan-build',
      goal: 'Build notification settings',
      cwd: '/repo',
      mode: 'build',
      policy: { allowWrites: true, allowBrowser: true, maxParallelWriteTimelines: 2 },
    }, 'run-1');

    expect(plan.workflow).toBe('autoplan-build');
    expect(plan.mode).toBe('build');
    expect(plan.phases.map(phase => phase.id)).toEqual(['intake', 'implementation', 'qa']);
    expect(plan.requiredCapabilities).toEqual(['agent-session', 'artifact-store', 'browser', 'filesystem', 'git', 'questions', 'test-runner', 'worktree']);
    expect(plan.expectedArtifacts.map(artifact => artifact.kind)).toEqual(['design-doc', 'diff', 'qa-report']);
    expect(plan.risks.map(risk => risk.id)).toContain('parallel-writes-require-integration-plan');
  });

  test('compileRunPlan emits blocking risks when actions are not policy-authorized', () => {
    const plan = compileRunPlan(workflow, {
      workflow: 'autoplan-build',
      goal: 'Build notification settings',
      mode: 'build',
    }, 'run-2');

    expect(plan.risks.map(risk => risk.id)).toContain('writes-disabled');
    expect(plan.risks.map(risk => risk.id)).toContain('browser-disabled');
    expect(plan.risks.map(risk => risk.id)).toContain('missing-cwd');
  });

  test('missingCapabilities compares a plan against adapter-provided capabilities', () => {
    const plan = compileRunPlan(workflow, {
      workflow: 'autoplan-build',
      goal: 'Review only',
      mode: 'review',
      policy: { allowBrowser: true },
    }, 'run-3');

    expect(missingCapabilities(plan, ['agent-session', 'artifact-store'])).toEqual(['browser', 'test-runner']);
  });

  test('reduceFactoryEvents derives resumable run state from immutable events', () => {
    const plan = compileRunPlan(workflow, {
      workflow: 'autoplan-build',
      goal: 'Build notification settings',
      cwd: '/repo',
      mode: 'build',
      policy: { allowWrites: true, allowBrowser: true },
    }, 'run-4');

    const events: FactoryEvent[] = [
      { type: 'run_started', runId: 'run-4', plan },
      { type: 'phase_started', runId: 'run-4', phaseId: 'intake' },
      { type: 'gate_requested', runId: 'run-4', gate: { id: 'approve-plan', phaseId: 'implementation', title: 'Approve plan', description: 'Approve implementation?' } },
      { type: 'gate_decision', runId: 'run-4', decision: { gateId: 'approve-plan', requestSequence: 3, decision: 'approve', decidedBy: 'user' } },
      { type: 'artifact_created', runId: 'run-4', artifact: { id: 'design-doc', kind: 'design-doc', summary: 'Design accepted', phaseId: 'intake' } },
      { type: 'phase_completed', runId: 'run-4', phaseId: 'intake' },
      { type: 'run_completed', runId: 'run-4', result: { status: 'completed', summary: 'Done', artifacts: [{ id: 'pr-1', kind: 'pr', summary: 'PR created' }] } },
    ];

    const state = reduceFactoryEvents(events);
    expect(state.status).toBe('completed');
    expect(state.pendingGates).toEqual([]);
    expect(state.gateDecisions).toHaveLength(1);
    expect(state.completedPhaseIds).toEqual(['intake']);
    expect(state.artifacts.map(artifact => artifact.id)).toEqual(['design-doc', 'pr-1']);
    expect(state.result?.summary).toBe('Done');
  });

  test('reduceFactoryEvents preserves cancellation as distinct from failure', () => {
    const plan = compileRunPlan(workflow, {
      workflow: 'autoplan-build',
      goal: 'Build notification settings',
      mode: 'plan-only',
    }, 'run-cancelled');

    const state = reduceFactoryEvents([
      { type: 'run_started', runId: 'run-cancelled', plan },
      { type: 'run_completed', runId: 'run-cancelled', result: { status: 'cancelled', summary: 'User stopped the run', artifacts: [] } },
    ]);

    expect(state.status).toBe('cancelled');
    expect(state.result?.status).toBe('cancelled');
  });

  test('slugifyFactoryId creates stable url-safe ids', () => {
    expect(slugifyFactoryId('Build Notifications: V2!')).toBe('build-notifications-v2');
    expect(slugifyFactoryId('!!!')).toBe('run');
  });
});
