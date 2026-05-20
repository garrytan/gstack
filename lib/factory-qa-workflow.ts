import type { WorkflowSpec } from './factory-core';

const QA_AUDIT_PHASES: WorkflowSpec['phases'] = [
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
    title: 'QA Audit Execution',
    role: { id: 'gstack-qa-only', title: 'GStack QA Audit' },
    objective: 'Exercise the target using the existing gstack QA-only methodology and browser tooling where needed, without editing the repository.',
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
];

const QA_FIX_PHASES: WorkflowSpec['phases'] = [
  QA_AUDIT_PHASES[0],
  {
    id: 'qa-execution',
    title: 'QA Fix Execution',
    role: { id: 'gstack-qa', title: 'GStack QA Fixer' },
    objective: 'Exercise the target using the existing gstack QA methodology, allowing non-destructive local fixes when explicitly requested.',
    requiredCapabilities: ['agent-session', 'artifact-store', 'browser', 'filesystem', 'git', 'safe-command-guard', 'test-runner'],
    outputs: [{ id: 'qa-report', kind: 'qa-report', description: 'QA findings, fixes, or dispatch reference.' }],
    modes: ['review'],
  },
  QA_AUDIT_PHASES[2],
];

export const FACTORY_QA_WORKFLOW: WorkflowSpec = Object.freeze({
  id: 'qa',
  title: 'Structured QA Audit',
  description: 'Run a structured, event-sourced gstack QA audit workflow without repository edits.',
  requiredCapabilities: ['artifact-store'],
  defaultPolicy: {
    allowWrites: false,
    allowNetwork: false,
    allowBrowser: true,
  },
  phases: QA_AUDIT_PHASES,
});

export const FACTORY_QA_FIX_WORKFLOW: WorkflowSpec = Object.freeze({
  id: 'qa-fix',
  title: 'Structured QA Fix',
  description: 'Run a structured, event-sourced gstack QA workflow that may make non-destructive local fixes after explicit write opt-in.',
  requiredCapabilities: ['artifact-store'],
  defaultPolicy: {
    allowWrites: false,
    allowNetwork: false,
    allowBrowser: true,
  },
  allowedCommandSafetyProfiles: ['non-destructive-write'],
  phases: QA_FIX_PHASES,
});
