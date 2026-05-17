import {
  reduceFactoryEvents,
  type ArtifactRef,
  type FactoryError,
  type FactoryEvent,
  type FactoryRunPlan,
  type FactoryRunRequest,
  type FactoryRunState,
  type WorkflowSpec,
} from './factory-core';
import { FactoryOrchestrator, type FactoryEventSink, type FactoryStartResult } from './factory-orchestrator';
import { errorToMessage, type FactoryRuntimeCapabilities } from './factory-capabilities';

export interface FactoryEventLogSink extends FactoryEventSink {
  readEvents(runId: string): FactoryEvent[];
}

export interface FactoryRunnerOptions {
  readonly workflows: readonly WorkflowSpec[];
  readonly eventSink: FactoryEventLogSink;
  readonly runtime: FactoryRuntimeCapabilities;
  readonly makeRunId?: (request: FactoryRunRequest) => string;
}

export type FactoryRunnerStatus = 'completed' | 'blocked' | 'failed' | 'running';

export interface FactoryRunnerResult {
  readonly status: FactoryRunnerStatus;
  readonly plan: FactoryRunPlan;
  readonly state: FactoryRunState;
  readonly start: FactoryStartResult;
}

export class FactoryRunner {
  private readonly workflows: readonly WorkflowSpec[];
  private readonly eventSink: FactoryEventLogSink;
  private readonly runtime: FactoryRuntimeCapabilities;
  private readonly makeRunId?: (request: FactoryRunRequest) => string;

  constructor(options: FactoryRunnerOptions) {
    this.workflows = options.workflows;
    this.eventSink = options.eventSink;
    this.runtime = options.runtime;
    this.makeRunId = options.makeRunId;
  }

  async run(request: FactoryRunRequest): Promise<FactoryRunnerResult> {
    const orchestrator = new FactoryOrchestrator({
      workflows: this.workflows,
      eventSink: this.eventSink,
      makeRunId: this.makeRunId,
    });
    const start = orchestrator.start(request, { availableCapabilities: this.runtime.availableCapabilities });

    if (start.missingCapabilities.length > 0 || start.blockingRisks.length > 0) {
      return {
        status: 'blocked',
        plan: start.plan,
        start,
        state: reduceFactoryEvents(this.eventSink.readEvents(start.plan.runId)),
      };
    }

    return this.continueRun(start.plan.runId, undefined, start);
  }

  async continueRun(runId: string, request?: FactoryRunRequest, start?: FactoryStartResult): Promise<FactoryRunnerResult> {
    const events = this.eventSink.readEvents(runId);
    const plan = findRunPlan(events);
    if (!plan) {
      throw new Error(`Cannot continue factory run '${runId}': run_started event not found`);
    }

    const effectiveRequest = request ? validateResumeRequest(plan, request) : requestFromPlan(plan);
    const effectiveStart = start ?? {
      plan,
      missingCapabilities: [],
      blockingRisks: [],
    };

    let state = reduceFactoryEvents(events);
    if (state.status === 'completed') {
      return { status: 'completed', plan, state, start: effectiveStart };
    }
    if (state.status === 'failed' || state.status === 'cancelled') {
      return { status: 'failed', plan, state, start: effectiveStart };
    }

    for (const phase of plan.phases) {
      state = reduceFactoryEvents(this.eventSink.readEvents(runId));
      if (state.completedPhaseIds.includes(phase.id)) continue;
      if (state.currentPhaseId === phase.id && hasPendingArtifactForPhase(state, phase.id)) {
        return { status: 'running', plan, state, start: effectiveStart };
      }

      this.eventSink.append(runId, { type: 'phase_started', runId, phaseId: phase.id });
      state = reduceFactoryEvents(this.eventSink.readEvents(runId));

      try {
        const result = await this.runtime.executePhase({ plan, request: effectiveRequest, phase, state });
        for (const risk of result.risks || []) {
          this.eventSink.append(runId, { type: 'risk_detected', runId, risk });
        }
        if (result.status === 'pending') {
          for (const artifact of pendingArtifactsForPhase(phase.id, result.artifacts || [], result.summary)) {
            this.eventSink.append(runId, { type: 'artifact_created', runId, artifact });
          }
          return {
            status: 'running',
            plan,
            start: effectiveStart,
            state: reduceFactoryEvents(this.eventSink.readEvents(runId)),
          };
        }
        this.eventSink.append(runId, {
          type: 'phase_completed',
          runId,
          phaseId: phase.id,
          artifacts: [...(result.artifacts || [])],
        });
      } catch (error) {
        const decision = this.runtime.onPhaseError
          ? await this.runtime.onPhaseError({ plan, request: effectiveRequest, phase, state, error })
          : { action: 'fail' as const, message: errorToMessage(error), retryable: true };

        if (decision.action === 'continue') {
          for (const risk of decision.risks || []) {
            this.eventSink.append(runId, { type: 'risk_detected', runId, risk });
          }
          this.eventSink.append(runId, {
            type: 'phase_completed',
            runId,
            phaseId: phase.id,
            artifacts: [...(decision.artifacts || [phaseErrorArtifact(phase.id, decision.summary)])],
          });
          continue;
        }

        const factoryError: FactoryError = {
          code: 'phase_failed',
          message: decision.message || errorToMessage(error),
          phaseId: phase.id,
          retryable: decision.retryable !== false,
        };
        this.eventSink.append(runId, { type: 'run_failed', runId, error: factoryError });
        return {
          status: 'failed',
          plan,
          start: effectiveStart,
          state: reduceFactoryEvents(this.eventSink.readEvents(runId)),
        };
      }
    }

    const finalState = reduceFactoryEvents(this.eventSink.readEvents(runId));
    if (finalState.status !== 'completed') {
      this.eventSink.append(runId, {
        type: 'run_completed',
        runId,
        result: {
          status: 'completed',
          summary: `Factory run '${runId}' completed ${plan.phases.length} phase(s).`,
          artifacts: finalState.artifacts,
        },
      });
    }

    return {
      status: 'completed',
      plan,
      start: effectiveStart,
      state: reduceFactoryEvents(this.eventSink.readEvents(runId)),
    };
  }
}

export function findRunPlan(events: readonly FactoryEvent[]): FactoryRunPlan | null {
  const started = events.find((event): event is Extract<FactoryEvent, { type: 'run_started' }> => event.type === 'run_started');
  return started?.plan ?? null;
}

function requestFromPlan(plan: FactoryRunPlan): FactoryRunRequest {
  return {
    workflow: plan.workflow,
    goal: plan.goal,
    cwd: plan.cwd,
    repo: plan.repo,
    mode: plan.mode,
    policy: plan.policy,
    context: plan.context,
  };
}

function validateResumeRequest(plan: FactoryRunPlan, request: FactoryRunRequest): FactoryRunRequest {
  const expected = requestFromPlan(plan);
  const matches = request.workflow === expected.workflow
    && request.goal === expected.goal
    && request.mode === expected.mode
    && request.cwd === expected.cwd
    && stableJson(request.repo) === stableJson(expected.repo)
    && stableJson(request.policy) === stableJson(expected.policy)
    && stableJson(request.context) === stableJson(expected.context);
  if (!matches) {
    throw new Error(`Resume request does not match persisted factory run '${plan.runId}' context`);
  }
  return expected;
}

function hasPendingArtifactForPhase(state: FactoryRunState, phaseId: string): boolean {
  return state.artifacts.some(artifact => artifact.phaseId === phaseId && artifact.metadata && (
    artifact.metadata.pendingExternalReview === true || artifact.metadata.pendingExternalWork === true
  ));
}

function pendingArtifactsForPhase(phaseId: string, artifacts: readonly ArtifactRef[], summary: string): ArtifactRef[] {
  const pending = artifacts.length > 0 ? artifacts : [{
    id: `${phaseId}-pending`,
    kind: 'review' as const,
    phaseId,
    summary,
  }];

  return pending.map(artifact => ({
    ...artifact,
    phaseId: artifact.phaseId ?? phaseId,
    metadata: {
      ...(artifact.metadata || {}),
      pendingExternalWork: true,
    },
  }));
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = canonicalize(record[key]);
    return acc;
  }, {});
}

function phaseErrorArtifact(phaseId: string, summary: string): ArtifactRef {
  return {
    id: `${phaseId}-continued-after-error`,
    kind: 'review',
    phaseId,
    summary,
    metadata: { continuedAfterError: true },
  };
}
