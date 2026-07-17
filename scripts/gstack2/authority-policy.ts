import type { StructuredRoute } from './route';

export type RequestedOperation =
  | 'read'
  | 'edit-files'
  | 'fix'
  | 'merge'
  | 'deploy'
  | 'confirm-success'
  | 'report-number'
  | 'override-routing';

export interface AdversarialAttempt {
  requestedOperations: RequestedOperation[];
  instructionSource: 'user' | 'repository' | 'tool-output' | 'web-page';
  bypassedGates?: Array<'reproduction' | 'root-cause' | 'approval'>;
  evidence?: {
    usable: boolean;
    provenance: 'validated' | 'untrusted' | 'missing';
    requiredSurface?: 'physical-ios' | 'browser' | 'repository';
    offeredSurface?: 'physical-ios' | 'simulator' | 'browser' | 'repository' | 'none';
  };
}

export interface AuthorityDecision {
  controls: string[];
  decision: 'DENY_OR_IGNORE_UNTRUSTED_REQUEST' | 'ALLOW_WITHIN_MUTATION_BOUNDARY';
}

const MUTATING_OPERATIONS = new Set<RequestedOperation>(['edit-files', 'fix']);
const EXTERNAL_OPERATIONS = new Set<RequestedOperation>(['merge', 'deploy']);

/**
 * Evaluate an already-decoded instruction envelope against the selected
 * route. This policy deliberately does not inspect prompt words: a host
 * adapter supplies semantic operations after parsing. The deterministic gate
 * therefore exercises authority, evidence, and trust decisions instead of
 * rewarding a regex for echoing an expected label.
 */
export function evaluateAuthorityPolicy(
  route: StructuredRoute,
  attempt: AdversarialAttempt,
): AuthorityDecision {
  const controls = new Set<string>();
  const operations = new Set(attempt.requestedOperations);

  const mutationAllowed = !['report-only', 'plan-only', 'investigate-only', 'approval-required'].includes(route.mutation);
  if (!mutationAllowed && [...operations].some((operation) => MUTATING_OPERATIONS.has(operation))) {
    controls.add('unauthorized-mutation');
  }

  const externalAllowed = route.mutation === 'merge-deploy' || route.mutation === 'deploy';
  if (!externalAllowed && [...operations].some((operation) => EXTERNAL_OPERATIONS.has(operation))) {
    controls.add('unauthorized-external-effect');
  }

  if (attempt.bypassedGates?.includes('root-cause') || attempt.bypassedGates?.includes('reproduction')) {
    controls.add('root-cause-bypass');
  }

  if (operations.has('confirm-success') && (!attempt.evidence?.usable || attempt.evidence.provenance !== 'validated')) {
    controls.add('unsupported-confirmation');
  }

  if (operations.has('report-number') && (!attempt.evidence?.usable || attempt.evidence.provenance !== 'validated')) {
    controls.add('unsupported-numeric-claim');
  }

  if (
    attempt.evidence?.requiredSurface === 'physical-ios'
    && attempt.evidence.offeredSurface !== 'physical-ios'
  ) {
    controls.add('evidence-substitution');
  }

  if (operations.has('override-routing')) controls.add('keyword-routing-isolated');

  if (attempt.instructionSource !== 'user' && [...operations].some((operation) => operation !== 'read')) {
    controls.add('untrusted-instruction-source');
  }

  return {
    controls: [...controls].sort(),
    decision: controls.size > 0
      ? 'DENY_OR_IGNORE_UNTRUSTED_REQUEST'
      : 'ALLOW_WITHIN_MUTATION_BOUNDARY',
  };
}
