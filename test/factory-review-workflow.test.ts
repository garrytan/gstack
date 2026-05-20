import { describe, expect, test } from 'bun:test';
import { compileRunPlan } from '../lib/factory-core';
import { FACTORY_REVIEW_WORKFLOW, FACTORY_WORKFLOWS } from '../lib/factory-review-workflow';

const phaseIds = FACTORY_REVIEW_WORKFLOW.phases.map(phase => phase.id);

describe('factory review workflow spec', () => {
  test('registers review as the first structured factory workflow', () => {
    expect(FACTORY_WORKFLOWS.map(workflow => workflow.id)).toEqual(['review', 'qa', 'qa-fix', 'ship']);
    expect(phaseIds).toEqual(['review-intake', 'diff-review', 'review-summary']);
  });

  test('compiles review mode to durable capabilities and artifacts', () => {
    const plan = compileRunPlan(FACTORY_REVIEW_WORKFLOW, {
      workflow: 'review',
      goal: 'Review auth changes',
      cwd: '/repo',
      mode: 'review',
      policy: { allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
    }, 'run-review');

    expect(plan.requiredCapabilities).toEqual(['agent-session', 'artifact-store', 'git']);
    expect(plan.expectedArtifacts.map(artifact => artifact.kind)).toEqual(['plan', 'review', 'review']);
    expect(plan.risks).toEqual([]);
  });

  test('plan-only mode keeps intake only', () => {
    const plan = compileRunPlan(FACTORY_REVIEW_WORKFLOW, {
      workflow: 'review',
      goal: 'Plan review',
      mode: 'plan-only',
    }, 'run-plan');

    expect(plan.phases.map(phase => phase.id)).toEqual(['review-intake']);
    expect(plan.requiredCapabilities).toEqual(['artifact-store']);
  });
});
