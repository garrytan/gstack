import { randomUUID } from 'node:crypto';
import {
  compileRunPlan,
  missingCapabilities,
  selectWorkflow,
  slugifyFactoryId,
  type CapabilityName,
  type FactoryEvent,
  type FactoryRunPlan,
  type FactoryRunRequest,
  type FactoryRunState,
  type WorkflowSpec,
} from './factory-core';

export interface FactoryEventSink {
  append(runId: string, event: FactoryEvent): unknown;
  readState?(runId: string): FactoryRunState;
}

export interface FactoryOrchestratorOptions {
  readonly workflows: readonly WorkflowSpec[];
  readonly eventSink: FactoryEventSink;
  readonly makeRunId?: (request: FactoryRunRequest) => string;
}

export interface FactoryStartOptions {
  readonly availableCapabilities?: Iterable<CapabilityName>;
}

export interface FactoryStartResult {
  readonly plan: FactoryRunPlan;
  readonly missingCapabilities: readonly CapabilityName[];
  readonly blockingRisks: FactoryRunPlan['risks'];
}

export class FactoryOrchestrator {
  private readonly workflows: readonly WorkflowSpec[];
  private readonly eventSink: FactoryEventSink;
  private readonly makeRunId: (request: FactoryRunRequest) => string;

  constructor(options: FactoryOrchestratorOptions) {
    this.workflows = options.workflows;
    this.eventSink = options.eventSink;
    this.makeRunId = options.makeRunId ?? defaultRunId;
  }

  plan(request: FactoryRunRequest): FactoryRunPlan {
    const workflow = selectWorkflow([...this.workflows], request.workflow);
    return compileRunPlan(workflow, request, this.makeRunId(request));
  }

  start(request: FactoryRunRequest, options: FactoryStartOptions = {}): FactoryStartResult {
    const plan = this.plan(request);
    const gaps = options.availableCapabilities
      ? missingCapabilities(plan, options.availableCapabilities)
      : [];

    const blockingRisks = plan.risks.filter(risk => risk.severity === 'blocking');

    if (gaps.length > 0 || blockingRisks.length > 0) {
      return { plan, missingCapabilities: gaps, blockingRisks };
    }

    this.eventSink.append(plan.runId, { type: 'run_started', runId: plan.runId, plan });
    for (const risk of plan.risks) {
      this.eventSink.append(plan.runId, { type: 'risk_detected', runId: plan.runId, risk });
    }

    return { plan, missingCapabilities: gaps, blockingRisks };
  }

  state(runId: string): FactoryRunState {
    if (!this.eventSink.readState) {
      throw new Error('Factory event sink does not support readState');
    }
    return this.eventSink.readState(runId);
  }
}

export function defaultRunId(request: FactoryRunRequest): string {
  const workflow = slugifyFactoryId(request.workflow);
  const goal = slugifyFactoryId(request.goal).slice(0, 48).replace(/-+$/g, '') || 'run';
  const suffix = randomUUID().slice(0, 8);
  return `${workflow}-${goal}-${suffix}`;
}
