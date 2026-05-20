import { describe, expect, test } from 'bun:test';
import { compileRunPlan, missingCapabilities } from '../lib/factory-core';
import { FACTORY_QA_FIX_WORKFLOW, FACTORY_QA_WORKFLOW } from '../lib/factory-qa-workflow';
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

  test('compiles an explicit write-capable QA fix run plan', () => {
    const plan = compileRunPlan(FACTORY_QA_FIX_WORKFLOW, {
      workflow: 'qa-fix',
      goal: 'QA and fix http://localhost:8200',
      cwd: '/repo',
      mode: 'review',
      policy: { allowBrowser: true, allowWrites: true, commandSafetyProfile: 'non-destructive-write' },
    }, 'run-qa-fix');

    expect(plan.workflow).toBe('qa-fix');
    expect(plan.phases.map(phase => phase.role.id)).toEqual(['factory-intake', 'gstack-qa', 'factory-summarizer']);
    expect(plan.requiredCapabilities).toEqual(['agent-session', 'artifact-store', 'browser', 'filesystem', 'git', 'safe-command-guard', 'test-runner']);
    expect(plan.risks).toEqual([]);
    expect(missingCapabilities(plan, ['agent-session', 'artifact-store', 'browser'])).toEqual(['filesystem', 'git', 'safe-command-guard', 'test-runner']);
  });

  test('blocks QA fix unless writes and a non-destructive safety profile are explicitly enabled by the caller', () => {
    const plan = compileRunPlan(FACTORY_QA_FIX_WORKFLOW, {
      workflow: 'qa-fix',
      goal: 'QA and fix http://localhost:8200',
      cwd: '/repo',
      mode: 'review',
      policy: { allowBrowser: true },
    }, 'run-qa-fix-blocked');

    expect(plan.risks).toContainEqual(expect.objectContaining({ id: 'writes-disabled', severity: 'blocking' }));

    const missingSafety = compileRunPlan(FACTORY_QA_FIX_WORKFLOW, {
      workflow: 'qa-fix',
      goal: 'QA and fix http://localhost:8200',
      cwd: '/repo',
      mode: 'review',
      policy: { allowBrowser: true, allowWrites: true },
    }, 'run-qa-fix-no-safety');
    expect(missingSafety.risks).toContainEqual(expect.objectContaining({ id: 'write-safety-profile-required', severity: 'blocking' }));

    const releaseAction = compileRunPlan(FACTORY_QA_FIX_WORKFLOW, {
      workflow: 'qa-fix',
      goal: 'QA and fix http://localhost:8200',
      cwd: '/repo',
      mode: 'review',
      policy: { allowBrowser: true, allowWrites: true, commandSafetyProfile: 'release-action' },
    }, 'run-qa-fix-release-action');
    expect(releaseAction.risks).toContainEqual(expect.objectContaining({ id: 'command-safety-profile-disallowed', severity: 'blocking' }));
  });

  test('blocks browser-backed QA when browser policy is disabled', () => {
    const plan = compileRunPlan(FACTORY_QA_WORKFLOW, {
      workflow: 'qa',
      goal: 'QA http://localhost:8200',
      cwd: '/repo',
      mode: 'review',
      policy: { allowBrowser: false },
    }, 'run-qa-blocked');

    expect(plan.risks).toContainEqual(expect.objectContaining({ id: 'browser-disabled', severity: 'blocking' }));
  });

  test('is registered in the public factory workflow list', () => {
    expect(FACTORY_WORKFLOWS.map(workflow => workflow.id)).toEqual(['review', 'qa', 'qa-fix', 'ship']);
  });
});
