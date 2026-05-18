import {
  missingCapabilities,
  reduceFactoryEvents,
  type ArtifactRef,
  type FactoryError,
  type CapabilityName,
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

export type FactoryRunnerStatus = 'completed' | 'blocked' | 'cancelled' | 'failed' | 'paused' | 'running';

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
      missingCapabilities: missingRuntimeCapabilities(plan, this.runtime.availableCapabilities),
      blockingRisks: plan.risks.filter(risk => risk.severity === 'blocking'),
    };

    const initialGateHistoryError = validateGateHistory(events, plan);
    if (initialGateHistoryError) return this.failRun(runId, plan, effectiveStart, initialGateHistoryError);

    let state = reduceFactoryEvents(events);
    if (state.status === 'completed') {
      return { status: 'completed', plan, state, start: effectiveStart };
    }
    if (state.status === 'failed' || state.status === 'cancelled') {
      return { status: state.status === 'cancelled' ? 'cancelled' : 'failed', plan, state, start: effectiveStart };
    }
    if (effectiveStart.missingCapabilities.length > 0 || effectiveStart.blockingRisks.length > 0) {
      return { status: 'blocked', plan, state, start: effectiveStart };
    }

    for (const phase of plan.phases) {
      const latestEvents = this.eventSink.readEvents(runId);
      const gateHistoryError = validateGateHistory(latestEvents, plan);
      if (gateHistoryError) return this.failRun(runId, plan, effectiveStart, gateHistoryError);
      state = reduceFactoryEvents(latestEvents);
      if (state.completedPhaseIds.includes(phase.id)) continue;
      if (state.currentPhaseId === phase.id && hasPendingArtifactForPhase(state, phase.id)) {
        return { status: 'running', plan, state, start: effectiveStart };
      }

      const gateDecision = blockingGateDecision(state, phase.gates.map(gate => gate.id));
      if (gateDecision) {
        this.eventSink.append(runId, {
          type: 'run_completed',
          runId,
          result: {
            status: 'cancelled',
            summary: `Factory run '${runId}' cancelled by gate '${gateDecision.gateId}' decision '${gateDecision.decision}'.`,
            artifacts: state.artifacts,
          },
        });
        return {
          status: 'cancelled',
          plan,
          start: effectiveStart,
          state: reduceFactoryEvents(this.eventSink.readEvents(runId)),
        };
      }

      const unrequestedGates = phase.gates.filter(gate => !hasGateDecision(state, gate.id) && !hasPendingGate(state, gate.id));
      if (unrequestedGates.length > 0) {
        if (!hasPhaseStarted(latestEvents, phase.id)) {
          this.eventSink.append(runId, { type: 'phase_started', runId, phaseId: phase.id });
        }
        const requestedGates: { readonly gate: (typeof unrequestedGates)[number]; readonly requestSequence: number }[] = [];
        for (const gate of unrequestedGates) {
          const envelope = this.eventSink.append(runId, {
            type: 'gate_requested',
            runId,
            gate: {
              id: gate.id,
              phaseId: phase.id,
              title: gate.title,
              description: gate.description,
              options: ['approve', 'reject', 'waive', 'cancel'],
              recommendation: gate.failClosed ? 'reject' : 'approve',
            },
          });
          requestedGates.push({ gate, requestSequence: envelopeSequence(envelope) ?? this.eventSink.readEvents(runId).length });
        }
        if (shouldDenyGates(plan, this.runtime.availableCapabilities, unrequestedGates)) {
          for (const { gate, requestSequence } of requestedGates) {
            this.eventSink.append(runId, {
              type: 'gate_decision',
              runId,
              decision: { gateId: gate.id, requestSequence, decision: 'reject', decidedBy: 'policy', reason: 'Gate denied by fail-closed factory policy.' },
            });
          }
          const deniedState = reduceFactoryEvents(this.eventSink.readEvents(runId));
          this.eventSink.append(runId, {
            type: 'run_completed',
            runId,
            result: {
              status: 'cancelled',
              summary: `Factory run '${runId}' cancelled by fail-closed gate policy.`,
              artifacts: deniedState.artifacts,
            },
          });
          return {
            status: 'cancelled',
            plan,
            start: effectiveStart,
            state: reduceFactoryEvents(this.eventSink.readEvents(runId)),
          };
        }
        return {
          status: 'paused',
          plan,
          start: effectiveStart,
          state: reduceFactoryEvents(this.eventSink.readEvents(runId)),
        };
      }
      if (phase.gates.some(gate => hasPendingGate(state, gate.id))) {
        return { status: 'paused', plan, state, start: effectiveStart };
      }

      if (!hasPhaseStarted(latestEvents, phase.id)) {
        this.eventSink.append(runId, { type: 'phase_started', runId, phaseId: phase.id });
      }
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

  private failRun(runId: string, plan: FactoryRunPlan, start: FactoryStartResult, message: string): FactoryRunnerResult {
    this.eventSink.append(runId, {
      type: 'run_failed',
      runId,
      error: { code: 'invalid_gate_history', message, retryable: false },
    });
    return {
      status: 'failed',
      plan,
      start,
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
    && (request.mode === undefined || request.mode === expected.mode)
    && (request.cwd === undefined || request.cwd === expected.cwd)
    && (request.repo === undefined || stableJson(request.repo) === stableJson(expected.repo))
    && policySubsetMatches(expected.policy, request.policy)
    && (request.context === undefined || stableJson(request.context) === stableJson(expected.context));
  if (!matches) {
    throw new Error(`Resume request does not match persisted factory run '${plan.runId}' context`);
  }
  return expected;
}

function missingRuntimeCapabilities(plan: FactoryRunPlan, available: Iterable<CapabilityName>): CapabilityName[] {
  const required = uniqueCapabilities([
    ...plan.requiredCapabilities,
    ...plan.phases.flatMap(phase => schedulerCapabilitiesFor(phase.concurrency)),
  ]);
  return missingCapabilities({ ...plan, requiredCapabilities: required }, available);
}

function schedulerCapabilitiesFor(concurrency: string): CapabilityName[] {
  if (concurrency === 'parallel-readonly') return ['subagent-session'];
  if (concurrency === 'isolated-worktree') return ['subagent-session', 'worktree'];
  return [];
}

function uniqueCapabilities(capabilities: readonly CapabilityName[]): CapabilityName[] {
  return Array.from(new Set(capabilities)).sort();
}

function policySubsetMatches(expected: FactoryRunPlan['policy'], provided: FactoryRunRequest['policy']): boolean {
  if (!provided) return true;
  return Object.entries(provided).every(([key, value]) => expected[key as keyof typeof expected] === value);
}

function shouldDenyGates(plan: FactoryRunPlan, capabilities: Iterable<string>, gates: readonly { failClosed?: boolean }[]): boolean {
  const available = new Set(capabilities);
  const questionsUnavailable = !available.has('questions');
  return questionsUnavailable && (plan.policy.defaultQuestionMode === 'fail-closed' || gates.some(gate => gate.failClosed === true));
}

function validateGateHistory(events: readonly FactoryEvent[], plan: FactoryRunPlan): string | null {
  const declared = new Map<string, string>();
  for (const phase of plan.phases) {
    for (const gate of phase.gates) {
      if (declared.has(gate.id)) return `Factory gate id '${gate.id}' is declared in multiple phases`;
      declared.set(gate.id, phase.id);
    }
  }

  const requests = new Map<string, { readonly allowed: readonly string[]; readonly sequence: number; readonly count: number }>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const sequence = index + 1;
    if (event.type === 'gate_requested') {
      const phaseId = declared.get(event.gate.id);
      if (!phaseId || phaseId !== event.gate.phaseId) return `Factory gate request '${event.gate.id}' does not match the run plan`;
      const allowed = allowedGateDecisions(event.gate.options);
      if (typeof allowed === 'string') return allowed;
      requests.set(event.gate.id, { allowed, sequence, count: (requests.get(event.gate.id)?.count ?? 0) + 1 });
    } else if (event.type === 'gate_decision') {
      if (!declared.has(event.decision.gateId)) return `Factory gate decision '${event.decision.gateId}' does not match the run plan`;
      const request = requests.get(event.decision.gateId);
      if (!request) return `Factory gate '${event.decision.gateId}' has a decision without a request`;
      const legacySingleRequestDecision = event.decision.requestSequence === undefined && request.count === 1;
      if (!legacySingleRequestDecision && event.decision.requestSequence !== request.sequence) return `Factory gate '${event.decision.gateId}' request is stale`;
      if (!isGateDecisionValue(event.decision.decision)) {
        return `Invalid persisted factory gate decision '${event.decision.decision}' for gate '${event.decision.gateId}'`;
      }
      if (!request.allowed.includes(event.decision.decision)) {
        return `Persisted factory gate decision '${event.decision.decision}' is not allowed for gate '${event.decision.gateId}'`;
      }
    }
  }
  return null;
}

function allowedGateDecisions(options: readonly string[] | undefined): readonly string[] | string {
  if (!options || options.length === 0) return ['approve', 'reject', 'waive', 'cancel'];
  for (const option of options) {
    if (!isGateDecisionValue(option)) return `Invalid persisted factory gate option '${option}'`;
  }
  return [...new Set(options)];
}

function isGateDecisionValue(value: string): value is 'approve' | 'reject' | 'waive' | 'cancel' {
  return value === 'approve' || value === 'reject' || value === 'waive' || value === 'cancel';
}

function envelopeSequence(envelope: unknown): number | undefined {
  return envelope && typeof envelope === 'object' && Number.isInteger((envelope as { sequence?: unknown }).sequence)
    ? (envelope as { sequence: number }).sequence
    : undefined;
}

function hasPhaseStarted(events: readonly FactoryEvent[], phaseId: string): boolean {
  return events.some(event => event.type === 'phase_started' && event.phaseId === phaseId);
}

function hasPendingGate(state: FactoryRunState, gateId: string): boolean {
  return state.pendingGates.some(gate => gate.id === gateId);
}

function hasGateDecision(state: FactoryRunState, gateId: string): boolean {
  return state.gateDecisions.some(decision => decision.gateId === gateId);
}

function blockingGateDecision(state: FactoryRunState, gateIds: readonly string[]): { gateId: string; decision: string } | null {
  const phaseGateIds = new Set(gateIds);
  for (const decision of state.gateDecisions) {
    if (!phaseGateIds.has(decision.gateId)) continue;
    if (decision.decision === 'reject' || decision.decision === 'cancel') return decision;
  }
  return null;
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
