import { evaluateFactoryCommandSafety, type FactoryCommandGuardDecision, type FactoryCommandGuardRequest } from './factory-command-guard';
import type { CapabilityName } from './factory-core';
import {
  sanitizeFactoryCommandDenial,
  type SanitizedFactoryCommandDenial,
} from './factory-guard-denial';

export interface FactoryGuardedCommandDecisionObservation {
  readonly request: FactoryCommandGuardRequest;
  readonly decision: FactoryCommandGuardDecision;
  readonly sanitized: SanitizedFactoryGuardDecision;
}

export interface FactoryGuardedCommandRuntimeOptions<TResult> {
  readonly executeCommand: (request: FactoryCommandGuardRequest) => Promise<TResult> | TResult;
  readonly baseCapabilities?: Iterable<CapabilityName>;
  readonly guardActive?: boolean;
  readonly evaluateCommandSafety?: (request: FactoryCommandGuardRequest) => FactoryCommandGuardDecision;
  readonly onCommandDecision?: (observation: FactoryGuardedCommandDecisionObservation) => void | Promise<void>;
}

export interface FactoryGuardedCommandExecutionResult<TResult> {
  readonly decision: FactoryCommandGuardDecision;
  readonly result: TResult;
}

export interface FactoryGuardedCommandRuntime<TResult> {
  readonly guardActive: boolean;
  readonly availableCapabilities: readonly CapabilityName[];
  executeCommand(request: FactoryCommandGuardRequest): Promise<FactoryGuardedCommandExecutionResult<TResult>>;
}

export type SanitizedFactoryGuardDecision = SanitizedFactoryCommandDenial;

export class FactoryCommandGuardBlockedError extends Error {
  readonly decision: FactoryCommandGuardDecision;

  constructor(decision: FactoryCommandGuardDecision) {
    super(`Factory command blocked by safe command guard (${decision.matchedRuleId ?? 'unknown-rule'}): ${decision.reason}`);
    this.name = 'FactoryCommandGuardBlockedError';
    this.decision = decision;
  }
}

export function createFactoryGuardedCommandRuntime<TResult>(options: FactoryGuardedCommandRuntimeOptions<TResult>): FactoryGuardedCommandRuntime<TResult> {
  const guardActive = options.guardActive !== false;
  const evaluate = options.evaluateCommandSafety ?? evaluateFactoryCommandSafety;
  const availableCapabilities = withSafeCommandGuardCapability(options.baseCapabilities ?? [], guardActive);
  const emit = options.onCommandDecision;

  return {
    guardActive,
    availableCapabilities,
    async executeCommand(request: FactoryCommandGuardRequest): Promise<FactoryGuardedCommandExecutionResult<TResult>> {
      if (!guardActive) {
        const passThroughDecision: FactoryCommandGuardDecision = {
          allowed: true,
          severity: 'allow',
          reason: 'Safe command guard wrapper is inactive; command passed through runtime boundary.',
          matchedRuleId: 'guard-inactive-pass-through',
          normalizedCommand: normalizeCommandForError(request.command),
        };
        await observeDecisionSafely(emit, request, passThroughDecision);
        const result = await options.executeCommand(request);
        return { decision: passThroughDecision, result };
      }

      const decision = evaluateFailClosed(evaluate, request);
      await observeDecisionSafely(emit, request, decision);
      if (!decision.allowed) {
        throw new FactoryCommandGuardBlockedError(decision);
      }

      const result = await options.executeCommand(request);
      return { decision, result };
    },
  };
}

export function withSafeCommandGuardCapability(
  baseCapabilities: Iterable<CapabilityName>,
  guardActive: boolean,
): CapabilityName[] {
  const capabilities = new Set(baseCapabilities);
  if (guardActive) capabilities.add('safe-command-guard');
  else capabilities.delete('safe-command-guard');
  return Array.from(capabilities).sort();
}

export function sanitizeFactoryGuardDecisionForAudit(
  decision: FactoryCommandGuardDecision,
  request?: FactoryCommandGuardRequest,
): SanitizedFactoryGuardDecision {
  return sanitizeFactoryCommandDenial({ decision, request });
}

async function observeDecisionSafely(
  emit: FactoryGuardedCommandRuntimeOptions<unknown>['onCommandDecision'] | undefined,
  request: FactoryCommandGuardRequest,
  decision: FactoryCommandGuardDecision,
): Promise<void> {
  if (!emit) return;
  try {
    await emit({ request, decision, sanitized: sanitizeFactoryGuardDecisionForAudit(decision, request) });
  } catch {
    // Audit emission is best-effort; never let it change the guard outcome.
  }
}

function evaluateFailClosed(
  evaluate: (request: FactoryCommandGuardRequest) => FactoryCommandGuardDecision,
  request: FactoryCommandGuardRequest,
): FactoryCommandGuardDecision {
  try {
    return evaluate(request);
  } catch {
    return {
      allowed: false,
      severity: 'block',
      reason: 'Safe command guard failed to classify the command; failing closed.',
      matchedRuleId: 'guard-evaluation-error',
      normalizedCommand: normalizeCommandForError(request.command),
    };
  }
}

function normalizeCommandForError(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}
