import type {
  ArtifactRef,
  CapabilityName,
  FactoryRunPlan,
  FactoryRunRequest,
  FactoryRunState,
  PlannedPhase,
  RiskFinding,
} from './factory-core';

export interface FactoryPhaseExecutionInput {
  readonly plan: FactoryRunPlan;
  readonly request: FactoryRunRequest;
  readonly phase: PlannedPhase;
  readonly state: FactoryRunState;
}

export interface FactoryPhaseExecutionResult {
  readonly summary: string;
  readonly status?: 'completed' | 'pending';
  readonly artifacts?: readonly ArtifactRef[];
  readonly risks?: readonly RiskFinding[];
}

export interface FactoryPhaseExecutionErrorInput extends FactoryPhaseExecutionInput {
  readonly error: unknown;
}

export type FactoryPhaseErrorDecision =
  | { readonly action: 'fail'; readonly message?: string; readonly retryable?: boolean }
  | { readonly action: 'continue'; readonly summary: string; readonly artifacts?: readonly ArtifactRef[]; readonly risks?: readonly RiskFinding[] };

export interface FactoryRuntimeCapabilities {
  readonly availableCapabilities: Iterable<CapabilityName>;
  executePhase(input: FactoryPhaseExecutionInput): Promise<FactoryPhaseExecutionResult> | FactoryPhaseExecutionResult;
  onPhaseError?(input: FactoryPhaseExecutionErrorInput): Promise<FactoryPhaseErrorDecision> | FactoryPhaseErrorDecision;
}

export function phaseArtifactId(phase: PlannedPhase, suffix = 'artifact'): string {
  return `${phase.id}-${suffix}`;
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown factory runtime error';
}
