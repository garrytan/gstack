import { describe, expect, test } from 'bun:test';
import { compileRunPlan, missingCapabilities } from '../lib/factory-core';
import { FACTORY_WORKFLOWS } from '../lib/factory-review-workflow';
import { FACTORY_SHIP_WORKFLOW } from '../lib/factory-ship-workflow';

describe('FACTORY_SHIP_WORKFLOW', () => {
  test('compiles a gated plan-only ship contract without executing actions', () => {
    const plan = compileRunPlan(FACTORY_SHIP_WORKFLOW, {
      workflow: 'ship',
      goal: 'Ship package 1.2.3',
      cwd: '/repo',
      mode: 'plan-only',
    }, 'run-ship-plan');

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

  test('is registered in the public factory workflow list', () => {
    expect(FACTORY_WORKFLOWS.map(workflow => workflow.id)).toEqual(['review', 'qa', 'ship']);
  });
});
