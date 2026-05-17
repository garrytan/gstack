import { describe, expect, test } from 'bun:test';
import { reduceFactoryEvents, type FactoryEvent, type WorkflowSpec } from '../lib/factory-core';
import { FactoryOrchestrator, defaultRunId, type FactoryEventSink } from '../lib/factory-orchestrator';

const workflow: WorkflowSpec = {
  id: 'review-flow',
  title: 'Review Flow',
  description: 'Review a branch and produce a report.',
  requiredCapabilities: ['artifact-store'],
  phases: [
    {
      id: 'review',
      title: 'Review',
      role: { id: 'reviewer', title: 'Reviewer' },
      objective: 'Inspect the diff.',
      requiredCapabilities: ['git'],
      outputs: [{ id: 'review', kind: 'review', description: 'Review report.' }],
    },
  ],
};

class MemoryEventSink implements FactoryEventSink {
  readonly events: FactoryEvent[] = [];

  append(runId: string, event: FactoryEvent): void {
    expect(event.runId).toBe(runId);
    this.events.push(event);
  }

  readState(runId: string) {
    return reduceFactoryEvents(this.events.filter(event => event.runId === runId));
  }
}

describe('FactoryOrchestrator', () => {
  test('defaultRunId is unique and url-safe', () => {
    const first = defaultRunId({ workflow: 'Review Flow', goal: 'Ship Auth: V2!', mode: 'review' });
    const second = defaultRunId({ workflow: 'Review Flow', goal: 'Ship Auth: V2!', mode: 'review' });
    expect(first).toMatch(/^review-flow-ship-auth-v2-[a-f0-9-]{8}$/);
    expect(second).toMatch(/^review-flow-ship-auth-v2-[a-f0-9-]{8}$/);
    expect(first).not.toBe(second);
  });

  test('plans without writing events', () => {
    const sink = new MemoryEventSink();
    const orchestrator = new FactoryOrchestrator({ workflows: [workflow], eventSink: sink, makeRunId: () => 'run-1' });

    const plan = orchestrator.plan({ workflow: 'review-flow', goal: 'Review auth', mode: 'review' });
    expect(plan.runId).toBe('run-1');
    expect(plan.requiredCapabilities).toEqual(['artifact-store', 'git']);
    expect(sink.events).toEqual([]);
  });

  test('does not start when declared capability preflight has gaps', () => {
    const sink = new MemoryEventSink();
    const orchestrator = new FactoryOrchestrator({ workflows: [workflow], eventSink: sink, makeRunId: () => 'run-missing' });

    const result = orchestrator.start({ workflow: 'review-flow', goal: 'Review auth', cwd: '/repo', mode: 'review', policy: { allowWrites: true } }, {
      availableCapabilities: ['artifact-store'],
    });

    expect(result.missingCapabilities).toEqual(['git']);
    expect(sink.events).toEqual([]);
  });

  test('starts a run by appending run and risk events, then exposes reduced state', () => {
    const sink = new MemoryEventSink();
    const orchestrator = new FactoryOrchestrator({ workflows: [workflow], eventSink: sink, makeRunId: () => 'run-2' });

    const result = orchestrator.start({ workflow: 'review-flow', goal: 'Review auth', cwd: '/repo', mode: 'review', policy: { allowWrites: true } }, {
      availableCapabilities: ['artifact-store', 'git'],
    });

    expect(result.plan.runId).toBe('run-2');
    expect(result.missingCapabilities).toEqual([]);
    expect(sink.events.map(event => event.type)).toEqual(['run_started']);

    const state = orchestrator.state('run-2');
    expect(state.status).toBe('running');
    expect(state.currentPhaseId).toBe('review');
  });

  test('emits plan risks as durable events', () => {
    const writeWorkflow: WorkflowSpec = {
      ...workflow,
      phases: [{ ...workflow.phases[0], requiredCapabilities: ['filesystem'] }],
    };
    const sink = new MemoryEventSink();
    const orchestrator = new FactoryOrchestrator({ workflows: [writeWorkflow], eventSink: sink, makeRunId: () => 'run-risk' });

    const result = orchestrator.start({ workflow: 'review-flow', goal: 'Write files', mode: 'review' });
    expect(result.plan.risks.map(risk => risk.id)).toContain('writes-disabled');
    expect(sink.events.map(event => event.type)).toEqual(['run_started', 'risk_detected', 'risk_detected']);
    expect(orchestrator.state('run-risk').risks.map(risk => risk.id)).toEqual(['writes-disabled', 'missing-cwd']);
  });

  test('throws when state is unavailable from the event sink', () => {
    const orchestrator = new FactoryOrchestrator({
      workflows: [workflow],
      eventSink: { append() {} },
    });

    expect(() => orchestrator.state('run-1')).toThrow('does not support readState');
  });
});
