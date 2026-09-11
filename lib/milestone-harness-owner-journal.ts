import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const digest = (value: string | Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex');

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) ===
      JSON.stringify([...keys].sort());
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function verifyCanonicalOwnerTerminalOutcome(input: {
  ownerRoot: string;
  handle: string;
  ownerOutcomeSha256: string;
  requireLast: boolean;
  errorCode: string;
}): Record<string, any> {
  const fail = (): never => { throw new Error(input.errorCode); };
  if (!/^[0-9a-f]{64}$/.test(input.ownerOutcomeSha256)) fail();
  const journal = join(input.ownerRoot, 'journals', input.handle);
  const journalInfo = lstatSync(journal);
  if (!journalInfo.isDirectory() || journalInfo.uid !== process.getuid?.() ||
      (journalInfo.mode & 0o777) !== 0o700) fail();
  const names = readdirSync(journal).sort();
  if (!names.length || names.some((name) => !/^\d{8}-[0-9a-f]{64}\.json$/.test(name))) fail();
  let previousHash: string | null = null;
  let previousEvent: Record<string, any> | null = null;
  let terminal: Record<string, any> | null = null;
  let terminalPredecessor: Record<string, any> | null = null;
  let terminalIndex = -1;
  const events: Record<string, any>[] = [];
  for (const [index, name] of names.entries()) {
    const target = join(journal, name);
    const info = lstatSync(target);
    const bytes = readFileSync(target);
    const fileHash = digest(bytes);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600 ||
        name !== `${String(index + 1).padStart(8, '0')}-${fileHash}.json`) fail();
    let event: Record<string, any>;
    try { event = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
    if (event.sequence !== index + 1 || event.previous_event !== previousHash ||
        event.handle !== input.handle) fail();
    events.push(event);
    if (fileHash === input.ownerOutcomeSha256) {
      if (terminal) fail();
      terminal = event;
      terminalPredecessor = previousEvent;
      terminalIndex = index;
    }
    previousHash = fileHash;
    previousEvent = event;
  }
  if (!terminal || !terminalPredecessor ||
      input.requireLast && terminalIndex !== names.length - 1) fail();
  const terminalKeys = [
    'sequence', 'previous_event', 'handle', 'kind', 'source', 'block_id',
    'evaluation_slot_id', 'claim_id', 'generation', 'resource_lineage_id',
    'covered_generations', 'recorded_at', 'terminal_evidence_sha256',
    ...(terminal.source === 'aborted_before_start' ? [
      'producer_kind', 'allocation_phase', 'root_state',
      'allocation_child_started', 'verification_child_started',
    ] : []),
  ];
  if (!exact(terminal, terminalKeys) || terminal.kind !== 'terminal_outcome' ||
      !['allocation_failed', 'retry_deadline_reached', 'second_ambiguity', 'aborted_before_start', 'evaluation_aborted']
        .includes(String(terminal.source)) ||
      terminal.terminal_evidence_sha256 !== terminal.previous_event ||
      terminal.source === 'allocation_failed' && terminalPredecessor.kind !== 'allocation_failed' ||
      terminal.source === 'second_ambiguity' && terminalPredecessor.kind !== 'terminal_ambiguity' ||
      terminal.source === 'aborted_before_start' && !validAbortPredecessor(
        terminalPredecessor, terminal, events,
      ) ||
      terminal.source === 'evaluation_aborted' && !validEvaluationAbortPredecessor(
        terminalPredecessor, terminal, events,
      )) fail();
  return terminal;
}

function validAbortPredecessor(
  predecessor: Record<string, any>,
  terminal: Record<string, any>,
  events: Record<string, any>[],
): boolean {
  if (
    terminal.producer_kind !== 'harness_verification' ||
    terminal.verification_child_started !== false
  ) return false;
  if (
    terminal.allocation_phase === 'allocation_complete' &&
    terminal.root_state === 'complete' &&
    terminal.allocation_child_started === true
  ) {
    const first = events[0];
    if (!validInitialStart(first, {
      ...terminal,
      claim_id: first?.coordinator_claim_id,
    })) return false;
    if (terminal.generation === 0) {
      return terminal.claim_id === first.coordinator_claim_id &&
        predecessor.kind === 'allocation_complete' &&
        terminal.covered_generations?.length === 1 &&
        terminal.covered_generations[0] === 0;
    }
    const binding = predecessor.coordinator_binding;
    return terminal.generation === 1 &&
      predecessor.kind === 'verification_replay_claimed' &&
      terminal.covered_generations?.length === 2 &&
      terminal.covered_generations[0] === 0 &&
      terminal.covered_generations[1] === 1 &&
      binding?.schema === 'ecpe.t4-replay-coordinator-binding.v1' &&
      binding.claim_id === terminal.claim_id && binding.generation === 1 &&
      binding.block_id === terminal.block_id &&
      binding.evaluation_slot_id === terminal.evaluation_slot_id &&
      predecessor.resource_lineage_id === terminal.resource_lineage_id;
  }
  return terminal.generation === 0 &&
    terminal.allocation_phase === 'allocation_started' &&
    terminal.root_state === 'never_created' &&
    terminal.allocation_child_started === false &&
    terminal.covered_generations?.length === 1 &&
    terminal.covered_generations[0] === 0 &&
    validInitialStart(predecessor, terminal) &&
    terminal.sequence === 2;
}

function validInitialStart(
  predecessor: Record<string, any>,
  terminal: Record<string, any>,
): boolean {
  const binding = predecessor?.coordinator_binding;
  const bindingKeys = [
    'schema', 'claim_id', 'block_id', 'evaluation_slot_id', 'participant',
    'descriptor_id', 'generation', 'expected_base_sha', 'expected_head_sha',
    'participant_subject_hash', 'roots', 'registry_hash', 'binding_sha256',
  ];
  const predecessorKeys = [
    'sequence', 'previous_event', 'handle', 'kind', 'purpose', 'candidate_id',
    'coordinator_claim_id', 'coordinator_binding', 'resource_lineage_id',
    'verification_resource_handle',
  ];
  if (!exact(predecessor, predecessorKeys) ||
      predecessor.sequence !== 1 || predecessor.previous_event !== null ||
      predecessor.kind !== 'allocation_started' || predecessor.purpose !== 't4-final' ||
      typeof predecessor.candidate_id !== 'string' || !predecessor.candidate_id ||
      predecessor.coordinator_claim_id !== terminal.claim_id ||
      predecessor.resource_lineage_id !== terminal.resource_lineage_id ||
      predecessor.verification_resource_handle !== terminal.handle ||
      !exact(binding, bindingKeys)) return false;
  const { binding_sha256: observedHash, ...bindingCore } = binding;
  return binding.schema === 'ecpe.t4-coordinator-binding.v1' &&
    binding.claim_id === terminal.claim_id && binding.block_id === terminal.block_id &&
    binding.evaluation_slot_id === terminal.evaluation_slot_id &&
    binding.participant === 'harness-governance' && binding.descriptor_id === 'harness.t4' &&
    binding.generation === 0 &&
    /^[0-9a-f]{40}$/.test(String(binding.expected_base_sha)) &&
    /^[0-9a-f]{40}$/.test(String(binding.expected_head_sha)) &&
    /^[0-9a-f]{64}$/.test(String(binding.participant_subject_hash)) &&
    /^[0-9a-f]{64}$/.test(String(binding.registry_hash)) &&
    exact(binding.roots, ['code_root_id', 'workspace_root_id', 'state_root_id']) &&
    Object.values(binding.roots).every((value) => typeof value === 'string' && value.length > 0) &&
    observedHash === digest(stable(bindingCore));
}

function validEvaluationAbortPredecessor(
  predecessor: Record<string, any>,
  terminal: Record<string, any>,
  events: Record<string, any>[],
): boolean {
  if (!['verification_result', 'ambiguous_attempt', 'ambiguity_published', 'terminal_ambiguity']
    .includes(String(predecessor.kind))) return false;
  const first = events[0];
  if (!validInitialStart(first, {
    ...terminal,
    claim_id: first?.coordinator_claim_id,
  })) return false;
  const binding = terminal.generation === 0
    ? first.coordinator_binding
    : [...events].reverse().find((event) =>
      event.kind === 'verification_replay_claimed')?.coordinator_binding;
  if (!binding || binding.claim_id !== terminal.claim_id ||
      binding.generation !== terminal.generation ||
      binding.block_id !== terminal.block_id ||
      binding.evaluation_slot_id !== terminal.evaluation_slot_id ||
      terminal.resource_lineage_id !== first.resource_lineage_id) return false;
  if (predecessor.kind === 'verification_result') {
    return predecessor.generation === terminal.generation &&
      typeof predecessor.passed === 'boolean' &&
      typeof predecessor.result_id === 'string' && predecessor.result_id.length > 0 &&
      (predecessor.passed
        ? /^proof-[0-9a-f]{24}$/.test(String(predecessor.proof_id)) &&
          predecessor.failure_code === null
        : predecessor.proof_id === null &&
          typeof predecessor.failure_code === 'string' &&
          predecessor.failure_code.length > 0);
  }
  if (predecessor.kind === 'ambiguous_attempt') {
    return predecessor.claim_id === terminal.claim_id &&
      predecessor.generation === terminal.generation &&
      predecessor.resource_lineage_id === terminal.resource_lineage_id;
  }
  if (predecessor.kind === 'terminal_ambiguity') {
    return terminal.generation === 1 && predecessor.claim_id === terminal.claim_id &&
      predecessor.generation === 1 &&
      predecessor.resource_lineage_id === terminal.resource_lineage_id;
  }
  const ambiguity = events[events.length - 3];
  return terminal.generation === 0 && ambiguity?.kind === 'ambiguous_attempt' &&
    ambiguity.claim_id === terminal.claim_id &&
    ambiguity.resource_lineage_id === terminal.resource_lineage_id;
}
