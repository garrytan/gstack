import {
  compileRunPlan,
  reduceFactoryEvents,
  selectWorkflow,
  type ArtifactKind,
  type ArtifactRef,
  type CapabilityName,
  type FactoryError,
  type FactoryEvent,
  type FactoryMode,
  type FactoryRunPlan,
  type FactoryRunRequest,
  type FactoryRunState,
  type GateDecision,
  type GateSpec,
  type RiskFinding,
  type WorkflowSpec,
} from './factory-core';
import { FileFactoryArtifactStore } from './factory-artifact-store';
import { FileFactoryEventStore, type FactoryEventEnvelope, type FactoryRunManifest } from './factory-event-store';
import { defaultRunId } from './factory-orchestrator';
import { FactoryRunner, findRunPlan, type FactoryRunnerResult } from './factory-runner';
import type { FactoryRuntimeCapabilities } from './factory-capabilities';
import { FACTORY_WORKFLOWS } from './factory-review-workflow';

export type FactoryPublicRunStatus = 'blocked' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type FactoryPauseKind = 'gate' | 'external-work';
export type FactoryGateDecisionValue = 'approve' | 'reject' | 'waive' | 'cancel';
export type FactoryGateStatus = 'not-reached' | 'pending' | 'approved' | 'rejected' | 'waived' | 'cancelled';

export interface FactoryFacadeOptions {
  readonly runsRoot: string;
  readonly workflows?: readonly WorkflowSpec[];
  readonly runtime?: FactoryRuntimeCapabilities;
  readonly makeRunId?: (request: FactoryRunRequest) => string;
}

export interface PlanFactoryRunOptions {
  readonly workflows?: readonly WorkflowSpec[];
  readonly makeRunId?: (request: FactoryRunRequest) => string;
}

export interface FactoryRunOperationResult {
  readonly persisted: boolean;
  readonly run: FactoryRunStatusDto;
  readonly missingCapabilities: readonly CapabilityName[];
  readonly blockingRisks: readonly RiskFinding[];
}

export interface FactoryRunStatusDto {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowTitle: string;
  readonly mode: FactoryMode;
  readonly goal: string;
  readonly status: FactoryPublicRunStatus;
  readonly pause?: {
    readonly kind: FactoryPauseKind;
    readonly phaseId: string;
    readonly gateIds?: readonly string[];
  };
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly currentPhase?: {
    readonly id: string;
    readonly title: string;
  };
  readonly progress: {
    readonly completed: number;
    readonly total: number;
  };
  readonly completedPhaseIds: readonly string[];
  readonly artifacts: readonly FactoryArtifactSummaryDto[];
  readonly gates: readonly FactoryGateInfoDto[];
  readonly risks: readonly RiskFinding[];
  readonly error?: FactoryError;
  readonly resultSummary?: string;
}

export interface FactoryRunListOptions {
  readonly workflowId?: string;
  readonly status?: Exclude<FactoryPublicRunStatus, 'blocked'>;
  readonly limit?: number;
}

export interface FactoryRunListItemDto {
  readonly runId: string;
  readonly workflowId: string;
  readonly mode: FactoryMode;
  readonly goal: string;
  readonly status: Exclude<FactoryPublicRunStatus, 'blocked'>;
  readonly updatedAt?: string;
  readonly artifactCount: number;
  readonly pendingGateCount: number;
  readonly currentPhaseId?: string;
}

export interface FactoryArtifactSummaryDto {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly phaseId?: string;
  readonly summary: string;
  readonly path?: string;
  readonly uri?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FactoryArtifactDto {
  readonly runId: string;
  readonly artifact: FactoryArtifactSummaryDto;
  readonly createdAt: string;
  readonly content: string;
}

export interface FactoryGateInfoDto {
  readonly id: string;
  readonly phaseId: string;
  readonly title: string;
  readonly description: string;
  readonly kind: GateSpec['kind'];
  readonly failClosed: boolean;
  readonly status: FactoryGateStatus;
  readonly requestSequence?: number;
  readonly allowedDecisions: readonly FactoryGateDecisionValue[];
  readonly recommendation?: FactoryGateDecisionValue;
  readonly decision?: {
    readonly value: FactoryGateDecisionValue;
    readonly decidedBy: GateDecision['decidedBy'];
    readonly reason?: string;
  };
}

export interface FactoryGateDecisionInput {
  readonly runId: string;
  readonly gateId: string;
  readonly requestSequence: number;
  readonly decision: FactoryGateDecisionValue;
  readonly reason?: string;
}

export interface FactoryFacade {
  runFactoryWorkflow(request: FactoryRunRequest): Promise<FactoryRunOperationResult>;
  continueFactoryRun(runId: string, request?: FactoryRunRequest): Promise<FactoryRunOperationResult>;
  readFactoryRunStatus(runId: string): Promise<FactoryRunStatusDto>;
  listFactoryRuns(options?: FactoryRunListOptions): Promise<readonly FactoryRunListItemDto[]>;
  readFactoryArtifact(runId: string, artifactId: string): Promise<FactoryArtifactDto>;
  listFactoryGates(runId: string): Promise<readonly FactoryGateInfoDto[]>;
  decideFactoryGate(input: FactoryGateDecisionInput): Promise<FactoryRunStatusDto>;
}

export function planFactoryRun(request: FactoryRunRequest, options: PlanFactoryRunOptions = {}): FactoryRunPlan {
  const workflows = options.workflows ?? FACTORY_WORKFLOWS;
  const workflow = selectWorkflow([...workflows], request.workflow);
  const makeRunId = options.makeRunId ?? defaultRunId;
  return compileRunPlan(workflow, request, makeRunId(request));
}

export function createFactoryFacade(options: FactoryFacadeOptions): FactoryFacade {
  const workflows = options.workflows ?? FACTORY_WORKFLOWS;
  const eventStore = new FileFactoryEventStore({ rootDir: options.runsRoot });
  const artifactStore = new FileFactoryArtifactStore({ rootDir: options.runsRoot });

  const runner = () => {
    if (!options.runtime) throw new Error('factory runtime is required for run and continue operations');
    return new FactoryRunner({
      workflows,
      eventSink: eventStore,
      runtime: options.runtime,
      makeRunId: options.makeRunId,
    });
  };

  return {
    async runFactoryWorkflow(request) {
      const result = await runner().run(request);
      return operationResult(result, eventStore, artifactStore, workflows);
    },

    async continueFactoryRun(runId, request) {
      const result = await runner().continueRun(runId, request);
      return operationResult(result, eventStore, artifactStore, workflows);
    },

    async readFactoryRunStatus(runId) {
      return readStatus(eventStore, artifactStore, workflows, runId);
    },

    async listFactoryRuns(listOptions = {}) {
      const items = eventStore.listRunIds()
        .map(runId => readStatus(eventStore, artifactStore, workflows, runId))
        .map(status => listItemFromStatus(status))
        .filter(item => !listOptions.workflowId || item.workflowId === listOptions.workflowId)
        .filter(item => !listOptions.status || item.status === listOptions.status)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return typeof listOptions.limit === 'number' && listOptions.limit >= 0
        ? items.slice(0, Math.trunc(listOptions.limit))
        : items;
    },

    async readFactoryArtifact(runId, artifactId) {
      const stored = artifactStore.readText(runId, artifactId);
      return {
        runId,
        artifact: artifactSummary(stored.ref, runId, artifactStore),
        createdAt: stored.createdAt,
        content: stored.content,
      };
    },

    async listFactoryGates(runId) {
      return readStatus(eventStore, artifactStore, workflows, runId).gates;
    },

    async decideFactoryGate(input) {
      if (!isFactoryGateDecisionValue(input.decision)) {
        throw new Error(`Invalid factory gate decision '${String(input.decision)}'`);
      }
      if (input.reason !== undefined && typeof input.reason !== 'string') {
        throw new Error('Factory gate decision reason must be a string');
      }
      if ((input as { decidedBy?: unknown }).decidedBy !== undefined) {
        throw new Error('Factory gate decisions through the public facade are recorded as user decisions');
      }
      const status = readStatus(eventStore, artifactStore, workflows, input.runId);
      const gate = status.gates.find(candidate => candidate.id === input.gateId);
      if (!gate) throw new Error(`Factory gate '${input.gateId}' not found for run '${input.runId}'`);
      if (gate.status !== 'pending') throw new Error(`Factory gate '${input.gateId}' is not pending`);
      if (gate.requestSequence !== input.requestSequence) {
        throw new Error(`Factory gate '${input.gateId}' request is stale`);
      }
      if (!gateAllowsDecision(gate, input.decision, 'user')) {
        throw new Error(`Factory gate '${input.gateId}' does not allow decision '${input.decision}'`);
      }
      if (!options.runtime && (input.decision === 'approve' || input.decision === 'waive')) {
        throw new Error(`Factory gate '${input.gateId}' decision '${input.decision}' requires a runtime-backed facade to resume the run`);
      }

      eventStore.appendValidated(input.runId, {
        type: 'gate_decision',
        runId: input.runId,
        decision: {
          gateId: input.gateId,
          requestSequence: input.requestSequence,
          decision: input.decision,
          reason: input.reason,
          decidedBy: 'user',
        },
      }, (current) => {
        const currentGate = gateInfoFromEnvelopes(current, input.runId, input.gateId);
        if (currentGate.status !== 'pending') throw new Error(`Factory gate '${input.gateId}' is not pending`);
        if (currentGate.requestSequence !== input.requestSequence) throw new Error(`Factory gate '${input.gateId}' request is stale`);
        if (!gateAllowsDecision(currentGate, input.decision, 'user')) {
          throw new Error(`Factory gate '${input.gateId}' does not allow decision '${input.decision}'`);
        }
      });
      if (options.runtime) {
        const result = await runner().continueRun(input.runId);
        return operationResult(result, eventStore, artifactStore, workflows).run;
      }
      if (input.decision === 'reject' || input.decision === 'cancel') {
        const current = readStatus(eventStore, artifactStore, workflows, input.runId);
        eventStore.append(input.runId, {
          type: 'run_completed',
          runId: input.runId,
          result: {
            status: 'cancelled',
            summary: `Factory run '${input.runId}' cancelled by gate '${input.gateId}' decision '${input.decision}'.`,
            artifacts: current.artifacts.map(dto => ({
              id: dto.id,
              kind: dto.kind,
              phaseId: dto.phaseId,
              summary: dto.summary,
              path: dto.path,
              uri: dto.uri,
              metadata: dto.metadata,
            })),
          },
        });
      }
      return readStatus(eventStore, artifactStore, workflows, input.runId);
    },
  };
}

function operationResult(
  result: FactoryRunnerResult,
  eventStore: FileFactoryEventStore,
  artifactStore: FileFactoryArtifactStore,
  workflows: readonly WorkflowSpec[],
): FactoryRunOperationResult {
  return {
    persisted: result.status !== 'blocked' || result.state.runId === result.plan.runId,
    run: result.status === 'blocked'
      ? statusFromPlan(result.plan, result.state, null, workflows, 'blocked')
      : readStatus(eventStore, artifactStore, workflows, result.plan.runId),
    missingCapabilities: result.start.missingCapabilities,
    blockingRisks: result.start.blockingRisks,
  };
}

function gateAllowsDecision(gate: FactoryGateInfoDto, decision: FactoryGateDecisionValue, decidedBy: GateDecision['decidedBy']): boolean {
  return gate.allowedDecisions.includes(decision)
    || (gate.kind === 'policy' && decision === 'approve' && (decidedBy === 'policy' || decidedBy === 'adapter'));
}

function gateInfoFromEnvelopes(
  envelopes: readonly FactoryEventEnvelope[],
  runId: string,
  gateId: string,
): FactoryGateInfoDto {
  const events = envelopes.map(envelope => envelope.event);
  const plan = findRunPlan(events);
  if (!plan) throw new Error(`Factory run '${runId}' not found`);
  const state = reduceFactoryEvents(events);
  const gate = gateInfos(plan, state, envelopes).find(candidate => candidate.id === gateId);
  if (!gate) throw new Error(`Factory gate '${gateId}' not found for run '${runId}'`);
  return gate;
}

function readStatus(
  eventStore: FileFactoryEventStore,
  artifactStore: FileFactoryArtifactStore | undefined,
  workflows: readonly WorkflowSpec[],
  runId: string,
): FactoryRunStatusDto {
  const envelopes = eventStore.readEnvelopes(runId);
  const events = envelopes.map(envelope => envelope.event);
  const plan = findRunPlan(events);
  if (!plan) throw new Error(`Factory run '${runId}' not found`);
  const state = reduceFactoryEvents(events);
  return statusFromPlan(plan, state, eventStore.readManifest(runId), workflows, undefined, artifactStore, envelopes);
}

function statusFromPlan(
  plan: FactoryRunPlan,
  state: FactoryRunState,
  manifest: FactoryRunManifest | null,
  workflows: readonly WorkflowSpec[],
  forcedStatus?: FactoryPublicRunStatus,
  artifactStore?: FileFactoryArtifactStore,
  envelopes: readonly FactoryEventEnvelope[] = [],
): FactoryRunStatusDto {
  const workflow = workflows.find(candidate => candidate.id === plan.workflow);
  const currentPhase = plan.phases.find(phase => phase.id === state.currentPhaseId);
  const gates = gateInfos(plan, state, envelopes);
  const pendingGateIds = gates.filter(gate => gate.status === 'pending').map(gate => gate.id);
  const pause = pauseFromState(state, pendingGateIds);
  return {
    runId: plan.runId,
    workflowId: plan.workflow,
    workflowTitle: workflow?.title ?? plan.workflow,
    mode: plan.mode,
    goal: plan.goal,
    status: forcedStatus ?? publicStatus(state, pause),
    pause,
    createdAt: manifest?.createdAt,
    updatedAt: manifest?.updatedAt,
    currentPhase: currentPhase ? { id: currentPhase.id, title: currentPhase.title } : undefined,
    progress: { completed: state.completedPhaseIds.length, total: plan.phases.length },
    completedPhaseIds: [...state.completedPhaseIds],
    artifacts: state.artifacts.map(artifact => artifactSummary(artifact, plan.runId, artifactStore)),
    gates,
    risks: [...state.risks],
    error: state.error,
    resultSummary: state.result?.summary,
  };
}

function publicStatus(state: FactoryRunState, pause: FactoryRunStatusDto['pause']): FactoryPublicRunStatus {
  if (state.status !== 'running') return state.status;
  return pause ? 'paused' : 'running';
}

function pauseFromState(state: FactoryRunState, pendingGateIds: readonly string[]): FactoryRunStatusDto['pause'] {
  if (state.currentPhaseId && pendingGateIds.length > 0) {
    return { kind: 'gate', phaseId: state.currentPhaseId, gateIds: pendingGateIds };
  }
  const pendingExternal = state.artifacts.find(artifact => artifact.phaseId === state.currentPhaseId && artifact.metadata && (
    artifact.metadata.pendingExternalReview === true || artifact.metadata.pendingExternalWork === true
  ));
  if (state.currentPhaseId && pendingExternal) return { kind: 'external-work', phaseId: state.currentPhaseId };
  return undefined;
}

function artifactSummary(artifact: ArtifactRef, runId?: string, artifactStore?: FileFactoryArtifactStore): FactoryArtifactSummaryDto {
  const storedPath = runId && artifactStore ? normalizedArtifactPath(artifactStore, runId, artifact.id) : undefined;
  return {
    id: artifact.id,
    kind: artifact.kind,
    phaseId: artifact.phaseId,
    summary: artifact.summary,
    path: storedPath,
    uri: artifact.uri,
    metadata: artifact.metadata,
  };
}

function normalizedArtifactPath(artifactStore: FileFactoryArtifactStore, runId: string, artifactId: string): string | undefined {
  try {
    return artifactStore.readText(runId, artifactId).ref.path;
  } catch {
    return undefined;
  }
}

function listItemFromStatus(status: FactoryRunStatusDto): FactoryRunListItemDto {
  if (status.status === 'blocked') throw new Error(`Factory run '${status.runId}' was not persisted`);
  return {
    runId: status.runId,
    workflowId: status.workflowId,
    mode: status.mode,
    goal: status.goal,
    status: status.status,
    updatedAt: status.updatedAt,
    artifactCount: status.artifacts.length,
    pendingGateCount: status.gates.filter(gate => gate.status === 'pending').length,
    currentPhaseId: status.currentPhase?.id,
  };
}

function gateInfos(plan: FactoryRunPlan, state: FactoryRunState, envelopes: readonly FactoryEventEnvelope[]): FactoryGateInfoDto[] {
  const declared = declaredGateMap(plan);
  const histories = gateHistories(envelopes, declared);
  return plan.phases.flatMap(phase => phase.gates.map((gate) => {
    const history = histories.get(gate.id);
    if (history?.decision && !history.request) {
      throw new Error(`Factory gate '${gate.id}' has a decision without a request`);
    }
    const request = history?.request ?? state.pendingGates.find(candidate => candidate.id === gate.id);
    const decision = history ? history.decision : state.gateDecisions.find(candidate => candidate.gateId === gate.id);
    const allowedDecisions = allowedDecisionsFromRequest(request?.options, gate.kind, gate.failClosed === true);
    const decisionValue = decision ? validatedDecisionValue(decision, gate.id, allowedDecisions, gate.kind) : undefined;
    return {
      id: gate.id,
      phaseId: phase.id,
      title: request?.title ?? gate.title,
      description: request?.description ?? gate.description,
      kind: gate.kind,
      failClosed: gate.failClosed === true,
      status: gateStatus(request !== undefined, decisionValue),
      requestSequence: history?.requestSequence,
      allowedDecisions,
      recommendation: recommendationFromRequest(request?.recommendation, allowedDecisions),
      decision: decisionValue ? {
        value: decisionValue,
        decidedBy: decision!.decidedBy,
        reason: decision!.reason,
      } : undefined,
    } satisfies FactoryGateInfoDto;
  }));
}

function gateStatus(isPending: boolean, decision: FactoryGateDecisionValue | undefined): FactoryGateStatus {
  if (!decision) return isPending ? 'pending' : 'not-reached';
  switch (decision) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'waive':
      return 'waived';
    case 'cancel':
      return 'cancelled';
  }
}

interface GateHistory {
  request?: Extract<FactoryEvent, { type: 'gate_requested' }>['gate'];
  requestSequence?: number;
  requestCount: number;
  decision?: GateDecision;
}

function declaredGateMap(plan: FactoryRunPlan): Map<string, { readonly phaseId: string; readonly kind: GateSpec['kind'] }> {
  const declared = new Map<string, { readonly phaseId: string; readonly kind: GateSpec['kind'] }>();
  for (const phase of plan.phases) {
    for (const gate of phase.gates) {
      const existing = declared.get(gate.id);
      if (existing) throw new Error(`Factory gate id '${gate.id}' is declared in multiple phases`);
      declared.set(gate.id, { phaseId: phase.id, kind: gate.kind });
    }
  }
  return declared;
}

function gateHistories(envelopes: readonly FactoryEventEnvelope[], declared: ReadonlyMap<string, { readonly phaseId: string; readonly kind: GateSpec['kind'] }>): Map<string, GateHistory> {
  const histories = new Map<string, GateHistory>();
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.type === 'gate_requested') {
      const declaredGate = declared.get(event.gate.id);
      if (!declaredGate || declaredGate.phaseId !== event.gate.phaseId || (event.gate.kind !== undefined && event.gate.kind !== declaredGate.kind)) {
        throw new Error(`Factory gate request '${event.gate.id}' does not match the run plan`);
      }
      const previous = histories.get(event.gate.id);
      histories.set(event.gate.id, { request: event.gate, requestSequence: envelope.sequence, requestCount: (previous?.requestCount ?? 0) + 1 });
    } else if (event.type === 'gate_decision') {
      if (!declared.has(event.decision.gateId)) {
        throw new Error(`Factory gate decision '${event.decision.gateId}' does not match the run plan`);
      }
      const history = histories.get(event.decision.gateId);
      if (!history?.request) {
        throw new Error(`Factory gate decision '${event.decision.gateId}' appears before a matching gate request`);
      }
      const legacySingleRequestDecision = event.decision.requestSequence === undefined && history.requestCount === 1;
      if (!legacySingleRequestDecision && history.requestSequence !== undefined && event.decision.requestSequence !== history.requestSequence) {
        throw new Error(`Factory gate '${event.decision.gateId}' request is stale`);
      }
      histories.set(event.decision.gateId, { ...history, decision: event.decision });
    }
  }
  return histories;
}

function allowedDecisionsFromRequest(options: readonly string[] | undefined, gateKind: GateSpec['kind'], failClosed: boolean): readonly FactoryGateDecisionValue[] {
  if (gateKind === 'policy') return ['reject', 'cancel'];
  const defaults: readonly FactoryGateDecisionValue[] = failClosed ? ['approve', 'reject', 'cancel'] : ['approve', 'reject', 'waive', 'cancel'];
  if (!options || options.length === 0) return defaults;
  const allowed = options.map((option) => {
    if (!isFactoryGateDecisionValue(option)) throw new Error(`Invalid persisted factory gate option '${option}'`);
    if (failClosed && option === 'waive') throw new Error(`Invalid persisted factory gate option '${option}'`);
    return option;
  });
  return uniqueGateDecisions(allowed);
}

function uniqueGateDecisions(values: readonly FactoryGateDecisionValue[]): readonly FactoryGateDecisionValue[] {
  const seen = new Set<FactoryGateDecisionValue>();
  const result: FactoryGateDecisionValue[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function validatedDecisionValue(
  decision: GateDecision,
  gateId: string,
  allowedDecisions: readonly FactoryGateDecisionValue[],
  gateKind: GateSpec['kind'],
): FactoryGateDecisionValue {
  if (!isFactoryGateDecisionValue(decision.decision)) {
    throw new Error(`Invalid persisted factory gate decision '${decision.decision}' for gate '${gateId}'`);
  }
  const policyApproval = gateKind === 'policy'
    && decision.decision === 'approve'
    && (decision.decidedBy === 'policy' || decision.decidedBy === 'adapter');
  if (!policyApproval && !allowedDecisions.includes(decision.decision)) {
    throw new Error(`Persisted factory gate decision '${decision.decision}' is not allowed for gate '${gateId}'`);
  }
  return decision.decision;
}

function recommendationFromRequest(
  recommendation: string | undefined,
  allowedDecisions: readonly FactoryGateDecisionValue[],
): FactoryGateDecisionValue | undefined {
  if (!recommendation) return undefined;
  if (!isFactoryGateDecisionValue(recommendation)) throw new Error(`Invalid persisted factory gate recommendation '${recommendation}'`);
  if (!allowedDecisions.includes(recommendation)) throw new Error(`Factory gate recommendation '${recommendation}' is not allowed by gate options`);
  return recommendation;
}

function isFactoryGateDecisionValue(value: unknown): value is FactoryGateDecisionValue {
  return value === 'approve' || value === 'reject' || value === 'waive' || value === 'cancel';
}
