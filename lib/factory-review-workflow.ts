import type { WorkflowSpec } from './factory-core';

export const FACTORY_REVIEW_WORKFLOW: WorkflowSpec = Object.freeze({
  id: 'review',
  title: 'Structured Review',
  description: 'Run a structured, event-sourced gstack review workflow.',
  requiredCapabilities: ['artifact-store'],
  defaultPolicy: {
    allowWrites: false,
    allowNetwork: false,
    allowBrowser: false,
  },
  phases: [
    {
      id: 'review-intake',
      title: 'Review Intake',
      role: { id: 'factory-intake', title: 'Factory Intake' },
      objective: 'Record the review goal, repository context, and durable run path before dispatch.',
      requiredCapabilities: ['artifact-store'],
      outputs: [{ id: 'review-plan', kind: 'plan', description: 'Structured review run plan and input summary.' }],
      modes: ['review', 'plan-only'],
    },
    {
      id: 'diff-review',
      title: 'Diff Review',
      role: { id: 'gstack-review', title: 'GStack Review' },
      objective: 'Inspect the active repository changes using the existing gstack review methodology.',
      requiredCapabilities: ['agent-session', 'artifact-store', 'git'],
      outputs: [{ id: 'review-report', kind: 'review', description: 'Review findings or dispatch reference.' }],
      modes: ['review'],
    },
    {
      id: 'review-summary',
      title: 'Review Summary',
      role: { id: 'factory-summarizer', title: 'Factory Summarizer' },
      objective: 'Record final structured run state and next inspection path.',
      requiredCapabilities: ['artifact-store'],
      outputs: [{ id: 'review-summary', kind: 'review', description: 'Structured review run summary.' }],
      modes: ['review'],
    },
  ],
});

export const FACTORY_WORKFLOWS: readonly WorkflowSpec[] = Object.freeze([
  FACTORY_REVIEW_WORKFLOW,
]);
