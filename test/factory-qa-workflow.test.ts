import { describe, expect, test } from 'bun:test';
import { compileRunPlan, missingCapabilities } from '../lib/factory-core';
import { FACTORY_QA_WORKFLOW } from '../lib/factory-qa-workflow';
import { FACTORY_WORKFLOWS } from '../lib/factory-review-workflow';

describe('FACTORY_QA_WORKFLOW', () => {
  test('compiles a browser-backed structured QA run plan', () => {
    const plan = compileRunPlan(FACTORY_QA_WORKFLOW, {
      workflow: 'qa',
      goal: 'QA http://localhost:8200',
      cwd: '/repo',
      mode: 'review',
      policy: { allowBrowser: true },
    }, 'run-qa');

    expect(plan.workflow).toBe('qa');
    expect(plan.phases.map(phase => phase.id)).toEqual(['qa-intake', 'qa-execution', 'qa-summary']);
    expect(plan.requiredCapabilities).toEqual(['agent-session', 'artifact-store', 'browser']);
    expect(plan.expectedArtifacts.map(artifact => artifact.kind)).toEqual(['plan', 'qa-report', 'qa-report']);
    expect(plan.risks.map(risk => risk.id)).not.toContain('browser-disabled');
    expect(missingCapabilities(plan, ['agent-session', 'artifact-store'])).toEqual(['browser']);
  });

  test('is registered in the public factory workflow list', () => {
    expect(FACTORY_WORKFLOWS.map(workflow => workflow.id)).toContain('qa');
  });
});
