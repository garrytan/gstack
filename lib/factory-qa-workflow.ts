import type { WorkflowSpec } from './factory-core';

export const FACTORY_QA_WORKFLOW: WorkflowSpec = Object.freeze({
  id: 'qa',
  title: 'Structured QA',
  description: 'Run a structured, event-sourced gstack QA workflow.',
  requiredCapabilities: ['artifact-store'],
  defaultPolicy: {
    allowWrites: false,
    allowNetwork: false,
    allowBrowser: true,
  },
  phases: [
    {
      id: 'qa-intake',
      title: 'QA Intake',
      role: { id: 'factory-intake', title: 'Factory Intake' },
      objective: 'Record the QA goal, target, repository context, and durable run path before dispatch.',
      requiredCapabilities: ['artifact-store'],
      outputs: [{ id: 'qa-plan', kind: 'plan', description: 'Structured QA run plan and input summary.' }],
      modes: ['review', 'plan-only'],
    },
    {
      id: 'qa-execution',
      title: 'QA Execution',
      role: { id: 'gstack-qa', title: 'GStack QA' },
      objective: 'Exercise the target using the existing gstack QA methodology and browser tooling where needed.',
      requiredCapabilities: ['agent-session', 'artifact-store', 'browser'],
      outputs: [{ id: 'qa-report', kind: 'qa-report', description: 'QA findings or dispatch reference.' }],
      modes: ['review'],
    },
    {
      id: 'qa-summary',
      title: 'QA Summary',
      role: { id: 'factory-summarizer', title: 'Factory Summarizer' },
      objective: 'Record final structured QA run state and next inspection path.',
      requiredCapabilities: ['artifact-store'],
      outputs: [{ id: 'qa-summary', kind: 'qa-report', description: 'Structured QA run summary.' }],
      modes: ['review'],
    },
  ],
});
