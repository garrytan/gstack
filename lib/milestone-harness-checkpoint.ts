import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findMilestoneBlockBySlot,
  milestoneNextProducer,
  updateMilestoneBlock,
  type DurableProofPosition,
} from './milestone-block';
import { withHarnessProducerGate } from './milestone-harness-producer-gate';

const digest = (value: string | Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex');

function git(cwd: string, args: string[], code: string): string {
  const child = spawnSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: os.homedir(),
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (child.status !== 0) throw new Error(code);
  return child.stdout.trim();
}

type ConsumeResult = {
  proof_id: string;
  result_id: string;
  consumption_id: string;
  coordinator_claim_id: string;
  handle: string;
  generation: 0 | 1;
  resource_lineage_id: string;
  covered_generations: Array<0 | 1>;
};
type DisposeResult = {
  result_id: string;
  disposition_id: string;
  coordinator_claim_id: string;
  failure_code: string;
  handle: string;
  generation: 0 | 1;
  resource_lineage_id: string;
  covered_generations: Array<0 | 1>;
};

function helperPath(governanceRoot: string): string {
  const helper = path.join(governanceRoot, 'scripts/ops/ecpe_verify_workspace.py');
  const info = fs.lstatSync(helper);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('harness_verification_helper_invalid');
  }
  return helper;
}

function consumeOwnedProof(
  governanceRoot: string,
  proofId: string,
  claimId: string,
): ConsumeResult {
  const child = spawnSync(
    '/usr/bin/python3',
    [
      helperPath(governanceRoot),
      'consume-proof',
      '--purpose',
      't4-final',
      '--proof-id',
      proofId,
      '--consumer',
      't4.harness_checkpoint',
      '--claim-id',
      claimId,
      '--json',
    ],
    {
      cwd: governanceRoot,
      encoding: 'utf8',
      timeout: 60_000,
      shell: false,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: os.homedir(),
        LC_ALL: 'C',
        PYTHONNOUSERSITE: '1',
      },
    },
  );
  if (child.status !== 0) throw new Error('harness_verification_handoff_invalid');
  let value: ConsumeResult;
  try {
    value = JSON.parse(child.stdout);
  } catch {
    throw new Error('harness_verification_handoff_invalid');
  }
  if (
    value.proof_id !== proofId ||
    typeof value.result_id !== 'string' ||
    typeof value.consumption_id !== 'string' ||
    value.coordinator_claim_id !== claimId ||
    typeof value.handle !== 'string' ||
    ![0, 1].includes(value.generation) ||
    !/^lineage-[0-9a-f]{24}$/.test(value.resource_lineage_id) ||
    JSON.stringify(value.covered_generations) !== JSON.stringify(value.generation === 0 ? [0] : [0, 1])
  ) {
    throw new Error('harness_verification_handoff_invalid');
  }
  return value;
}

function disposeOwnedResult(
  governanceRoot: string,
  resultId: string,
  claimId: string,
): DisposeResult {
  const child = spawnSync(
    '/usr/bin/python3',
    [
      helperPath(governanceRoot),
      'dispose-result',
      '--purpose',
      't4-final',
      '--result-id',
      resultId,
      '--consumer',
      't4.harness_checkpoint',
      '--claim-id',
      claimId,
      '--json',
    ],
    {
      cwd: governanceRoot,
      encoding: 'utf8',
      timeout: 60_000,
      shell: false,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: os.homedir(),
        LC_ALL: 'C',
        PYTHONNOUSERSITE: '1',
      },
    },
  );
  if (child.status !== 0) throw new Error('harness_verification_handoff_invalid');
  let value: DisposeResult;
  try {
    value = JSON.parse(child.stdout);
  } catch {
    throw new Error('harness_verification_handoff_invalid');
  }
  if (
    value.result_id !== resultId ||
    typeof value.disposition_id !== 'string' ||
    value.coordinator_claim_id !== claimId ||
    typeof value.failure_code !== 'string' ||
    typeof value.handle !== 'string' ||
    ![0, 1].includes(value.generation) ||
    !/^lineage-[0-9a-f]{24}$/.test(value.resource_lineage_id) ||
    JSON.stringify(value.covered_generations) !== JSON.stringify(value.generation === 0 ? [0] : [0, 1])
  ) {
    throw new Error('harness_verification_handoff_invalid');
  }
  return value;
}

export function classifyHarnessFailure(
  code: string,
): 'participant_unavailable' | 'safety_failure' {
  return code.startsWith('candidate_materialization_failed') ||
    code === 'allocation_failed' ||
    code === 'verification_result_ambiguous'
    ? 'participant_unavailable'
    : 'safety_failure';
}

function currentHarnessPosition(
  stateRoot: string,
  slotId: string,
): { position: DurableProofPosition; blockId: string; phase: string } {
  const block = findMilestoneBlockBySlot(stateRoot, slotId);
  const position = block.slot?.positions.find(
    (item) => item.participant === 'harness-governance',
  );
  if (!position) throw new Error('harness_checkpoint_phase_invalid');
  return { position, blockId: block.block_id, phase: block.phase };
}

function assertReserved(
  position: DurableProofPosition,
  expectedBase: string,
  expectedHead: string,
): string {
  if (
    position.state !== 'producer_reserved' ||
    !position.producer_claim_id ||
    position.descriptor_id !== 'harness.t4' ||
    position.expected_base_sha !== expectedBase ||
    position.expected_head_sha !== expectedHead
  ) {
    throw new Error('harness_checkpoint_claim_invalid');
  }
  return position.producer_claim_id;
}

function subject(
  governanceRoot: string,
  expectedHead: string,
  registryHash?: string,
): { root: string; head: string; tree: string } {
  const root = fs.realpathSync(governanceRoot);
  const head = git(root, ['rev-parse', 'HEAD^{commit}'], 'harness_checkpoint_subject_invalid');
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'], 'harness_checkpoint_subject_invalid');
  if (
    head !== expectedHead ||
    (registryHash !== undefined && !/^[0-9a-f]{64}$/.test(registryHash))
  ) {
    throw new Error('harness_checkpoint_subject_moved');
  }
  return { root, head, tree };
}

export function attachHarnessVerificationCheckpoint(
  input: {
    stateRoot: string;
    blockId: string;
    slotId: string;
    governanceRoot: string;
    registryHash: string;
    expectedBase: string;
    expectedHead: string;
    verificationProofId: string;
  },
  consumer: (
    root: string,
    proofId: string,
    claimId: string,
  ) => ConsumeResult = consumeOwnedProof,
) {
  const observed = currentHarnessPosition(input.stateRoot, input.slotId);
  if (observed.blockId !== input.blockId) throw new Error('harness_checkpoint_phase_invalid');
  if (observed.position.state === 'attached') {
    if (
      observed.position.proof_id !== input.verificationProofId ||
      !observed.position.producer_claim_id ||
      !/^verify-[0-9a-f]{24}$/.test(
        observed.position.verification_resource_handle ?? '',
      ) ||
      !observed.position.verification_result_id ||
      !observed.position.verification_consumption_id
    ) {
      throw new Error('participant_proof_already_resolved');
    }
    return {
      result: 'receipt_current',
      proof_id: observed.position.proof_id,
      consumption_id: observed.position.verification_consumption_id,
      claim_id: observed.position.producer_claim_id,
      participant: 'harness-governance',
      lane: 'docs_ux',
      descriptor_id: 'harness.t4',
      next_operation: milestoneNextProducer(findMilestoneBlockBySlot(input.stateRoot, input.slotId)),
    };
  }
  if (observed.phase !== 'closing_evaluation') {
    throw new Error('harness_checkpoint_phase_invalid');
  }
  const claimId = assertReserved(
    observed.position,
    input.expectedBase,
    input.expectedHead,
  );
  const before = subject(input.governanceRoot, input.expectedHead, input.registryHash);
  const block = findMilestoneBlockBySlot(input.stateRoot, input.slotId);
  if (
    digest(`${before.head}\0${before.tree}\0${input.registryHash}`) !==
    block.slot?.participant_subject_hashes['harness-governance']
  ) {
    throw new Error('harness_checkpoint_subject_moved');
  }
  const handoff = consumer(before.root, input.verificationProofId, claimId);
  return withHarnessProducerGate(input.stateRoot, () => {
    const after = subject(input.governanceRoot, input.expectedHead, input.registryHash);
    return updateMilestoneBlock(input.stateRoot, input.blockId, (current) => {
      const position = current.slot?.positions.find(
        (item) => item.participant === 'harness-governance',
      );
      if (
        current.phase !== 'closing_evaluation' ||
        current.slot?.slot_id !== input.slotId ||
        current.slot.state !== 'collecting_proofs' ||
        !position
      ) {
        throw new Error('harness_checkpoint_phase_invalid');
      }
      if (position.state === 'attached') {
        if (
          position.proof_id !== input.verificationProofId ||
          position.verification_consumption_id !== handoff.consumption_id ||
          position.verification_resource_handle !== handoff.handle
        ) {
          throw new Error('participant_proof_already_resolved');
        }
        return {
          result: 'receipt_current',
          proof_id: position.proof_id,
          consumption_id: handoff.consumption_id,
          claim_id: claimId,
          participant: 'harness-governance',
          lane: 'docs_ux',
          descriptor_id: 'harness.t4',
          next_operation: milestoneNextProducer(current),
        };
      }
      assertReserved(position, input.expectedBase, input.expectedHead);
      if (
        handoff.coordinator_claim_id !== claimId ||
        handoff.generation !== position.generation ||
        JSON.stringify(handoff.covered_generations) !== JSON.stringify(position.generation === 0 ? [0] : [0, 1]) ||
        after.head !== input.expectedHead ||
        digest(`${after.head}\0${after.tree}\0${input.registryHash}`) !==
          current.slot.participant_subject_hashes['harness-governance']
      ) {
        throw new Error('harness_verification_claim_mismatch');
      }
      position.state = 'attached';
      position.proof_id = input.verificationProofId;
      position.terminal_kind = null;
      position.verification_resource_handle = handoff.handle;
      position.resource_lineage_id = handoff.resource_lineage_id;
      position.verification_result_id = handoff.result_id;
      position.verification_consumption_id = handoff.consumption_id;
      position.verification_cleanup_authorization_id = handoff.consumption_id;
      position.verification_covered_generations = [...handoff.covered_generations];
      return {
        result: 'attached',
        proof_id: input.verificationProofId,
        consumption_id: handoff.consumption_id,
        claim_id: claimId,
        participant: 'harness-governance',
        lane: 'docs_ux',
        descriptor_id: 'harness.t4',
        subject_head_sha: after.head,
        subject_tree_sha: after.tree,
        next_operation: milestoneNextProducer(current),
      };
    });
  });
}

export function terminalizeHarnessVerificationCheckpoint(
  input: {
    stateRoot: string;
    blockId: string;
    slotId: string;
    governanceRoot: string;
    registryHash: string;
    expectedBase: string;
    expectedHead: string;
    verificationResultId: string;
  },
  disposer: (
    root: string,
    resultId: string,
    claimId: string,
  ) => DisposeResult = disposeOwnedResult,
) {
  const observed = currentHarnessPosition(input.stateRoot, input.slotId);
  if (observed.blockId !== input.blockId || observed.phase !== 'closing_evaluation') {
    throw new Error('harness_checkpoint_phase_invalid');
  }
  if (observed.position.state === 'terminalized') {
    if (
      observed.position.verification_result_id !== input.verificationResultId ||
      !observed.position.producer_claim_id ||
      !/^verify-[0-9a-f]{24}$/.test(
        observed.position.verification_resource_handle ?? '',
      ) ||
      !observed.position.verification_disposition_id
    ) {
      throw new Error('participant_proof_already_resolved');
    }
    return {
      result: 'terminal_verification_disposition',
      disposition: 'terminalized',
      result_id: input.verificationResultId,
      disposition_id: observed.position.verification_disposition_id,
      terminal_kind: observed.position.terminal_kind,
      proof_id: null,
      claim_id: observed.position.producer_claim_id,
      next_operation: milestoneNextProducer(findMilestoneBlockBySlot(input.stateRoot, input.slotId)),
    };
  }
  const claimId = assertReserved(
    observed.position,
    input.expectedBase,
    input.expectedHead,
  );
  const handoff = disposer(
    subject(input.governanceRoot, input.expectedHead, input.registryHash).root,
    input.verificationResultId,
    claimId,
  );
  return withHarnessProducerGate(input.stateRoot, () => {
    const after = subject(
      input.governanceRoot,
      input.expectedHead,
      input.registryHash,
    );
    return updateMilestoneBlock(input.stateRoot, input.blockId, (current) => {
      const position = current.slot?.positions.find(
        (item) => item.participant === 'harness-governance',
      );
      if (
        current.phase !== 'closing_evaluation' ||
        current.slot?.slot_id !== input.slotId ||
        current.slot.state !== 'collecting_proofs' ||
        !position
      ) {
        throw new Error('harness_checkpoint_phase_invalid');
      }
      if (position.state === 'terminalized') {
        if (
          position.verification_disposition_id !== handoff.disposition_id ||
          position.verification_resource_handle !== handoff.handle
        ) {
          throw new Error('participant_proof_already_resolved');
        }
      } else {
        assertReserved(position, input.expectedBase, input.expectedHead);
        if (
          handoff.coordinator_claim_id !== claimId ||
          handoff.generation !== position.generation ||
          JSON.stringify(handoff.covered_generations) !== JSON.stringify(position.generation === 0 ? [0] : [0, 1]) ||
          digest(`${after.head}\0${after.tree}\0${input.registryHash}`) !==
            current.slot.participant_subject_hashes['harness-governance']
        ) {
          throw new Error('harness_verification_claim_mismatch');
        }
        position.state = 'terminalized';
        position.proof_id = null;
        position.terminal_kind = classifyHarnessFailure(handoff.failure_code);
        position.verification_resource_handle = handoff.handle;
        position.resource_lineage_id = handoff.resource_lineage_id;
        position.verification_result_id = input.verificationResultId;
        position.verification_disposition_id = handoff.disposition_id;
        position.verification_cleanup_authorization_id = handoff.disposition_id;
        position.verification_covered_generations = [...handoff.covered_generations];
      }
      return {
        result: 'terminal_verification_disposition',
        disposition: 'terminalized',
        result_id: input.verificationResultId,
        disposition_id: handoff.disposition_id,
        terminal_kind: position.terminal_kind,
        proof_id: null,
        claim_id: claimId,
        next_operation: milestoneNextProducer(current),
      };
    });
  });
}
