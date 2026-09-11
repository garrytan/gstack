import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  claimHarnessVerificationProducer,
  inspectMilestoneForPartial,
  readMilestoneBlock,
  startMilestoneBlock,
  stopMilestoneBlock,
} from '../lib/milestone-block';
import {
  attachPilotParticipant,
  buildPilotEvaluation,
  buildPilotReadiness,
  reservePilotEvaluation,
} from '../lib/pilot-evaluation';
import {
  attachHarnessVerificationCheckpoint,
  classifyHarnessFailure,
  terminalizeHarnessVerificationCheckpoint,
} from '../lib/milestone-harness-checkpoint';
import {
  admitHarnessVerificationReplayStart,
  claimHarnessVerificationReplay,
  recordHarnessVerificationAmbiguity,
} from '../lib/milestone-harness-replay';
import {
  terminalizeHarnessVerificationUnavailable,
} from '../lib/milestone-harness-terminal';
import { withHarnessProducerGate } from '../lib/milestone-harness-producer-gate';
import {
  acknowledgeHarnessVerificationCleanupAlreadyGated,
  inspectHarnessVerificationCleanup,
} from '../lib/milestone-harness-cleanup';
import { prepareHarnessAbortResourceHandoffAlreadyGated } from '../lib/milestone-harness-terminal-handoff';
import { verifyCanonicalOwnerTerminalOutcome } from '../lib/milestone-harness-owner-journal';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const sha = (value: string) =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex');
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function fixture(suffix: string, fill: string) {
  const root = mkdtempSync(join(tmpdir(), `harness-checkpoint-${suffix}-`));
  roots.push(root);
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(state, { mode: 0o700 });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e']);
  writeFileSync(join(repo, 'a'), 'a\n');
  git(repo, ['add', 'a']);
  git(repo, ['commit', '-m', 'base']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const registry = fill.repeat(64);
  const tuple = {
    code_root_id: 'code',
    workspace_root_id: 'workspace',
    state_root_id: 'state',
  };
  const started = startMilestoneBlock({
    stateRoot: state,
    roots: tuple,
    codeRootHead: head,
    registryHash: registry,
    duration: 'P30D',
    participants: ['harness-governance', 'portfolioops', 'cdo-os'],
    lanes: ['docs_ux', 'single_repo_code', 'cross_repo_contract'],
  });
  const readiness = buildPilotReadiness({
    blockJournalRevision: started.block.revision,
    compiledPolicyHash: 'p',
    roster: ['portfolioops', 'cdo-os', 'harness-governance'],
    sourceRegistryHash: 's',
    sourceCursorHash: 'c',
    participantSubjectHashes: {
      portfolioops: 'portfolio',
      'cdo-os': 'cdo',
      'harness-governance': sha(`${head}\0${tree}\0${registry}`),
    },
    roots: tuple,
  });
  const reserved = reservePilotEvaluation({
    stateRoot: state,
    blockId: started.block.block_id,
    readiness,
    assertReadiness: readiness.readiness_id,
    cdoRunId: `candidate-${fill.repeat(32)}`,
  });
  const slot = reserved.evaluation_slot.slot_id;
  attachPilotParticipant({
    stateRoot: state,
    blockId: started.block.block_id,
    slotId: slot,
    participant: 'portfolioops',
    proofId: 'portfolio-proof',
  });
  attachPilotParticipant({
    stateRoot: state,
    blockId: started.block.block_id,
    slotId: slot,
    participant: 'cdo-os',
    proofId: 'cdo-proof',
  });
  const claim = claimHarnessVerificationProducer({
    stateRoot: state,
    blockId: started.block.block_id,
    slotId: slot,
    expectedBase: head,
    expectedHead: head,
  });
  return { repo, state, head, registry, tuple, started, slot, claim };
}

describe('harness milestone checkpoint', () => {
  test('classifies infrastructure and ambiguous loss as unavailable', () => {
    expect(classifyHarnessFailure('candidate_materialization_failed:runtime')).toBe(
      'participant_unavailable',
    );
    expect(classifyHarnessFailure('verification_result_ambiguous')).toBe(
      'participant_unavailable',
    );
    expect(classifyHarnessFailure('verification_failed')).toBe('safety_failure');
  });

  test('the trusted abort probe reports an active evaluation without owner sealing', () => {
    const f = fixture('abort-probe-active', '0');
    const slotBefore = JSON.stringify(
      readMilestoneBlock(f.state, f.started.block.block_id).slot,
    );
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-terminal-boundary');
    const invoked = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state },
      input: `${JSON.stringify({
        operation: 'terminal-session',
        block_id: f.started.block.block_id,
        evaluation_slot_id: f.slot,
        source: 'aborted_before_start',
        resource_lineage_id: `lineage-${'1'.repeat(24)}`,
        handle: `verify-${'2'.repeat(24)}`,
      })}\n`,
      encoding: 'utf8',
    });

    expect(invoked.status).toBe(0);
    expect(invoked.stdout.trim()).toBe(JSON.stringify({ result: 'not_aborted' }));
    expect(JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot))
      .toBe(slotBefore);
  });

  test('consumes one sealed generation-0 ambiguity into retryable state', () => {
    const f = fixture('ambiguity', 'e');
    const recordedAt = '2026-09-09T01:00:00.000Z';
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'1'.repeat(24)}`,
      handle: `verify-${'2'.repeat(24)}`,
      recorded_at: recordedAt,
      ambiguity_sha256: '3'.repeat(64),
    };

    expect(recordHarnessVerificationAmbiguity({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      expectedBase: f.head,
      expectedHead: f.head,
      ambiguity,
    })).toMatchObject({
      result: 'retryable',
      disposition: 'retryable',
      generation: 0,
      replays_used: 0,
      retry_started_at: recordedAt,
      retry_deadline_at: '2026-09-09T01:30:00.000Z',
      next_operation: 'verification_workspace_run',
    });

    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position).toMatchObject({
      state: 'retryable_ambiguous',
      generation: 0,
      producer_claim_id: f.claim.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id,
      verification_resource_handle: ambiguity.handle,
      replays_used: 0,
      retry_started_at: recordedAt,
      retry_deadline_at: '2026-09-09T01:30:00.000Z',
    });
  });

  test('derives and reuses exactly one generation-1 replay claim', () => {
    const f = fixture('replay', 'f');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'4'.repeat(24)}`,
      handle: `verify-${'5'.repeat(24)}`,
      recorded_at: '2026-09-09T02:00:00.000Z',
      ambiguity_sha256: '6'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      expectedBase: f.head,
      expectedHead: f.head,
      ambiguity,
    });

    const first = claimHarnessVerificationReplay({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      now: new Date('2026-09-09T02:29:59.999Z'),
    });
    const second = claimHarnessVerificationReplay({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      now: new Date('2026-09-09T02:29:59.999Z'),
    });

    expect(first).toMatchObject({
      result: 'producer_replayed',
      generation: 1,
      parent_claim_id: f.claim.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id,
      verification_resource_handle: ambiguity.handle,
      consumed_ambiguous_sha256: ambiguity.ambiguity_sha256,
      replays_used: 1,
    });
    expect(second).toEqual({ ...first, result: 'reused' });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position.producer_events?.map((event) => event.kind)).toEqual([
      'producer_claimed',
      'producer_ambiguous',
      'producer_replayed',
    ]);
    expect(position.replays_used).toBe(1);
  });

  test('routes to checkpoint at the exact retry deadline without partial terminal mutation', () => {
    const f = fixture('deadline', '9');
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      expectedBase: f.head,
      expectedHead: f.head,
      ambiguity: {
        schema: 'ecpe.t4-ambiguous-attempt.v1',
        claim_id: f.claim.claim_id,
        generation: 0,
        resource_lineage_id: `lineage-${'a'.repeat(24)}`,
        handle: `verify-${'b'.repeat(24)}`,
        recorded_at: '2026-09-09T03:00:00.000Z',
        ambiguity_sha256: 'c'.repeat(64),
      },
    });

    const storeFile=join(f.state,'ecpe','milestones','ecpe-v3-pilot.json');
    const before=readFileSync(storeFile);
    expect(claimHarnessVerificationReplay({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      now: new Date('2026-09-09T03:30:00.000Z'),
    })).toMatchObject({
      result: 'checkpoint_required',
      disposition: 'retained',
      generation: 0,
      next_operation: 'milestone_block_checkpoint',
    });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position.state).toBe('retryable_ambiguous');
    expect(position.generation).toBe(0);
    expect(position.replays_used).toBe(0);
    expect(position.producer_events?.filter((event) => event.kind === 'producer_unavailable')).toHaveLength(0);
    expect(readFileSync(storeFile)).toEqual(before);
  });

  test('a generation-1 start loses admission at the exact deadline without mutation', () => {
    const f = fixture('start-deadline', '2');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'3'.repeat(24)}`,
      handle: `verify-${'4'.repeat(24)}`,
      recorded_at: '2026-09-09T03:00:00.000Z',
      ambiguity_sha256: '5'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      expectedBase: f.head, expectedHead: f.head, ambiguity,
    });
    const replay = claimHarnessVerificationReplay({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      now: new Date('2026-09-09T03:29:59.999Z'),
    });
    expect(admitHarnessVerificationReplayStart({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      claimId: replay.claim_id!,
      now: new Date('2026-09-09T03:30:00.000Z'),
    })).toMatchObject({
      result: 'checkpoint_required',
      disposition: 'retained',
      next_operation: 'milestone_block_checkpoint',
    });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position.state).toBe('producer_reserved');
    expect(position.generation).toBe(1);
    expect(position.producer_events?.map((event) => event.kind)).toEqual([
      'producer_claimed', 'producer_ambiguous', 'producer_replayed',
    ]);
  });

  test('atomically terminalizes an expired generation-0 retry without a synthetic result', () => {
    const f = fixture('terminal-deadline', '4');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'a'.repeat(24)}`,
      handle: `verify-${'b'.repeat(24)}`,
      recorded_at: '2026-09-09T04:00:00.000Z',
      ambiguity_sha256: 'c'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      expectedBase: f.head,
      expectedHead: f.head,
      ambiguity,
    });
    const terminalOutcome = {
      schema: 'ecpe.t4-terminal-outcome.v1' as const,
      source: 'retry_deadline_reached' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: ambiguity.resource_lineage_id,
      handle: ambiguity.handle,
      covered_generations: [0] as [0],
      recorded_at: '2026-09-09T04:30:00.000Z',
      terminal_evidence_sha256: 'e'.repeat(64),
      owner_outcome_sha256: 'd'.repeat(64),
    };

    expect(() => terminalizeHarnessVerificationUnavailable({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      terminalOutcome,
      now: new Date('2026-09-09T04:29:59.999Z'),
    })).toThrow('harness_terminal_outcome_invalid');

    const terminal = terminalizeHarnessVerificationUnavailable({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      terminalOutcome,
      now: new Date('2026-09-09T04:30:00.000Z'),
    });
    expect(terminal).toMatchObject({
      result: 'terminalized',
      disposition: 'terminalized',
      terminal_kind: 'participant_unavailable',
      proof_id: null,
      result_id: null,
      ambiguity_id: null,
      resource_lineage_id: ambiguity.resource_lineage_id,
      verification_resource_handle: ambiguity.handle,
      covered_generations: [0],
      next_operation: 'verification_lineage_finalize',
    });
    expect(terminal.terminal_receipt_id).toMatch(/^terminal-[0-9a-f]{32}$/);
    expect(terminal.cleanup_authorization_id).toMatch(/^cleanup-auth-[0-9a-f]{32}$/);
    expect(terminalizeHarnessVerificationUnavailable({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      terminalOutcome,
    })).toEqual(terminal);

    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    const position = block.slot!.positions.find(
      (item) => item.participant === 'harness-governance',
    )!;
    expect(block).toMatchObject({
      phase: 'terminal_unreported',
      terminal_reason: 'participant_unavailable',
      terminal_kind: 'participant_unavailable',
      stop_receipt_id: terminal.terminal_receipt_id,
      slot: { state: 'terminalized' },
    });
    expect(position).toMatchObject({
      state: 'terminalized',
      proof_id: null,
      terminal_kind: 'participant_unavailable',
      verification_result_id: null,
      verification_terminal_outcome_sha256: terminalOutcome.owner_outcome_sha256,
      verification_terminal_receipt_id: terminal.terminal_receipt_id,
      verification_cleanup_authorization_id: terminal.cleanup_authorization_id,
      verification_covered_generations: [0],
    });
    expect(position.producer_events?.map((event) => event.kind)).toEqual([
      'producer_claimed', 'producer_ambiguous', 'producer_unavailable',
    ]);
  });

  test('terminalizes a generation-0 allocation failure while binding its retained resource', () => {
    const f = fixture('terminal-allocation', '9');
    const terminal = terminalizeHarnessVerificationUnavailable({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      terminalOutcome: {
        schema: 'ecpe.t4-terminal-outcome.v1',
        source: 'allocation_failed',
        claim_id: f.claim.claim_id,
        generation: 0,
        resource_lineage_id: `lineage-${'7'.repeat(24)}`,
        handle: `verify-${'8'.repeat(24)}`,
        covered_generations: [0],
        recorded_at: '2026-09-09T04:00:00.000Z',
        terminal_evidence_sha256: 'a'.repeat(64),
        owner_outcome_sha256: '9'.repeat(64),
      },
    });

    expect(terminal).toMatchObject({
      result: 'terminalized',
      terminal_kind: 'participant_unavailable',
      proof_id: null,
      result_id: null,
      ambiguity_id: null,
      generation: 0,
      resource_lineage_id: `lineage-${'7'.repeat(24)}`,
      verification_resource_handle: `verify-${'8'.repeat(24)}`,
      covered_generations: [0],
    });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position).toMatchObject({
      state: 'terminalized',
      resource_lineage_id: `lineage-${'7'.repeat(24)}`,
      verification_resource_handle: `verify-${'8'.repeat(24)}`,
      verification_result_id: null,
      verification_covered_generations: [0],
    });
    expect(position.producer_events?.map((event) => event.kind)).toEqual([
      'producer_claimed', 'producer_unavailable',
    ]);
  });

  test('terminalizes a generation-1 second ambiguity and covers both retained generations', () => {
    const f = fixture('terminal-second-ambiguity', '5');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'e'.repeat(24)}`,
      handle: `verify-${'f'.repeat(24)}`,
      recorded_at: '2026-09-09T05:00:00.000Z',
      ambiguity_sha256: '1'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      expectedBase: f.head, expectedHead: f.head, ambiguity,
    });
    const replay = claimHarnessVerificationReplay({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      now: new Date('2026-09-09T05:29:00.000Z'),
    });
    const terminal = terminalizeHarnessVerificationUnavailable({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      terminalOutcome: {
        schema: 'ecpe.t4-terminal-outcome.v1',
        source: 'second_ambiguity',
        claim_id: replay.claim_id!,
        generation: 1,
        resource_lineage_id: ambiguity.resource_lineage_id,
        handle: ambiguity.handle,
        covered_generations: [0, 1],
        recorded_at: '2026-09-09T05:29:30.000Z',
        terminal_evidence_sha256: '3'.repeat(64),
        owner_outcome_sha256: '2'.repeat(64),
      },
    });

    expect(terminal).toMatchObject({
      result: 'terminalized',
      claim_id: replay.claim_id,
      covered_generations: [0, 1],
      proof_id: null,
      result_id: null,
      ambiguity_id: null,
    });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position.producer_events?.map((event) => event.kind)).toEqual([
      'producer_claimed', 'producer_ambiguous', 'producer_replayed',
      'producer_unavailable',
    ]);
    expect(position.verification_covered_generations).toEqual([0, 1]);
  });

  test('the terminal boundary retains the shared gate across owner sealing', async () => {
    const f = fixture('terminal-session', '8');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'3'.repeat(24)}`,
      handle: `verify-${'4'.repeat(24)}`,
      recorded_at: '2020-01-01T00:00:00.000Z',
      ambiguity_sha256: '5'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      expectedBase: f.head, expectedHead: f.head, ambiguity,
    });
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-terminal-boundary');
    const ownerState = join(f.state, 'owner-state');
    const child = spawn(process.execPath, [boundary], {
      env: {
        ...process.env,
        ECPE_TESTING: '1',
        ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const waitForLine = (count: number) => new Promise<void>((resolve, reject) => {
      const inspect = () => {
        if (stdout.split('\n').filter(Boolean).length >= count) resolve();
        else if (child.exitCode !== null) reject(new Error(stderr || `terminal boundary exited ${child.exitCode}`));
        else setTimeout(inspect, 5);
      };
      inspect();
    });
    child.stdin.write(`${JSON.stringify({
      operation: 'terminal-session',
      block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot,
      source: 'retry_deadline_reached',
    })}\n`);
    await waitForLine(1);
    const ready = JSON.parse(stdout.trim().split('\n')[0]);
    expect(ready).toMatchObject({
      result: 'ready',
      claim_id: f.claim.claim_id,
      generation: 0,
      covered_generations: [0],
    });
    expect(() => withHarnessProducerGate(f.state, () => 'entered', 20))
      .toThrow('harness_producer_gate_busy');
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    const journal = join(ownerState, 'journals', ready.handle);
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    chmodSync(join(ownerState, 'journals'), 0o700);
    chmodSync(journal, 0o700);
    const predecessor = {
      sequence: 1, previous_event: null, handle: ready.handle,
      kind: 'ambiguity_published',
    };
    const predecessorBytes = `${JSON.stringify(predecessor)}\n`;
    const evidenceHash = sha(predecessorBytes);
    const predecessorPath = join(journal, `00000001-${evidenceHash}.json`);
    writeFileSync(predecessorPath, predecessorBytes, { mode: 0o600 });
    const terminalOwner = {
      sequence: 2, previous_event: evidenceHash, handle: ready.handle,
      kind: 'terminal_outcome', source: 'retry_deadline_reached',
      block_id: ready.block_id, evaluation_slot_id: ready.evaluation_slot_id,
      claim_id: ready.claim_id, generation: ready.generation,
      resource_lineage_id: ready.resource_lineage_id,
      covered_generations: ready.covered_generations,
      recorded_at: new Date().toISOString(),
      terminal_evidence_sha256: evidenceHash,
    };
    const terminalBytes = `${JSON.stringify(terminalOwner)}\n`;
    const ownerHash = sha(terminalBytes);
    const terminalPath = join(journal, `00000002-${ownerHash}.json`);
    writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
    child.stdin.end(`${JSON.stringify({
      schema: 'ecpe.t4-terminal-outcome.v1',
      source: 'retry_deadline_reached',
      block_id: ready.block_id,
      evaluation_slot_id: ready.evaluation_slot_id,
      claim_id: ready.claim_id,
      generation: ready.generation,
      resource_lineage_id: ready.resource_lineage_id,
      handle: ready.handle,
      covered_generations: ready.covered_generations,
      recorded_at: terminalOwner.recorded_at,
      terminal_evidence_sha256: evidenceHash,
      owner_outcome_sha256: ownerHash,
    })}\n`);
    await waitForLine(2);
    const result = JSON.parse(stdout.trim().split('\n')[1]);
    expect(result).toMatchObject({
      result: 'terminalized',
      proof_id: null,
      result_id: null,
      covered_generations: [0],
    });
    await exited;
    expect(() => withHarnessProducerGate(f.state, () => 'entered', 20)).not.toThrow();
    const retry = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: {
        ...process.env,
        ECPE_TESTING: '1',
        ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState,
      },
      input: `${JSON.stringify({
        operation: 'terminal-session',
        block_id: ready.block_id,
        evaluation_slot_id: ready.evaluation_slot_id,
        source: 'retry_deadline_reached',
      })}\n${JSON.stringify({
        schema: 'ecpe.t4-terminal-outcome.v1',
        source: 'retry_deadline_reached',
        block_id: ready.block_id,
        evaluation_slot_id: ready.evaluation_slot_id,
        claim_id: ready.claim_id,
        generation: ready.generation,
        resource_lineage_id: ready.resource_lineage_id,
        handle: ready.handle,
        covered_generations: ready.covered_generations,
        recorded_at: terminalOwner.recorded_at,
        terminal_evidence_sha256: evidenceHash,
        owner_outcome_sha256: ownerHash,
      })}\n`,
      encoding: 'utf8',
    });
    expect(retry.status).toBe(0);
    const retryLines = retry.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(retryLines[1]).toEqual(result);
    const recoveredPosition = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(recoveredPosition.producer_events?.filter(
      (event) => event.kind === 'producer_unavailable',
    )).toHaveLength(1);
  });

  test('a durable abort converts a sealed terminal outcome into a resource-only handoff', () => {
    const f = fixture('terminal-abort-handoff', '9');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id, generation: 0 as const,
      resource_lineage_id: `lineage-${'a'.repeat(24)}`,
      handle: `verify-${'b'.repeat(24)}`,
      recorded_at: '2020-01-01T00:00:00.000Z',
      ambiguity_sha256: 'c'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      expectedBase: f.head, expectedHead: f.head, ambiguity,
    });
    const slotBefore = JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot);
    stopMilestoneBlock({
      stateRoot: f.state, roots: f.tuple,
      blockId: f.started.block.block_id, reason: 'aborted',
    });
    const ownerState = join(f.state, 'owner-abort-terminal');
    const journal = join(ownerState, 'journals', ambiguity.handle);
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    chmodSync(join(ownerState, 'journals'), 0o700);
    chmodSync(journal, 0o700);
    const predecessor = {
      sequence: 1, previous_event: null, handle: ambiguity.handle,
      kind: 'ambiguity_published',
    };
    const predecessorBytes = `${JSON.stringify(predecessor)}\n`;
    const evidenceHash = sha(predecessorBytes);
    writeFileSync(join(journal, `00000001-${evidenceHash}.json`), predecessorBytes, { mode: 0o600 });
    const recordedAt = '2026-09-09T06:00:00.000Z';
    const terminalOwner = {
      sequence: 2, previous_event: evidenceHash, handle: ambiguity.handle,
      kind: 'terminal_outcome', source: 'retry_deadline_reached',
      block_id: f.started.block.block_id, evaluation_slot_id: f.slot,
      claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: ambiguity.resource_lineage_id,
      covered_generations: [0], recorded_at: recordedAt,
      terminal_evidence_sha256: evidenceHash,
    };
    const terminalBytes = `${JSON.stringify(terminalOwner)}\n`;
    const ownerHash = sha(terminalBytes);
    writeFileSync(join(journal, `00000002-${ownerHash}.json`), terminalBytes, { mode: 0o600 });
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-terminal-boundary');
    const outcome = {
      schema: 'ecpe.t4-terminal-outcome.v1', source: 'retry_deadline_reached',
      block_id: f.started.block.block_id, evaluation_slot_id: f.slot,
      claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: ambiguity.resource_lineage_id, handle: ambiguity.handle,
      covered_generations: [0], recorded_at: recordedAt,
      terminal_evidence_sha256: evidenceHash, owner_outcome_sha256: ownerHash,
    };
    const request = {
      operation: 'terminal-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, source: 'retry_deadline_reached',
    };
    const invoked = () => spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(request)}\n${JSON.stringify(outcome)}\n`, encoding: 'utf8',
    });
    const first = invoked();
    expect(first.status).toBe(0);
    const lines = first.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[1]).toMatchObject({
      schema: 'ecpe.t4-terminal-resource-handoff.v1',
      result: 'terminal_handoff_disposition', disposition: null,
      proof_id: null, result_id: null, ambiguity_id: null,
      abort_receipt_id: expect.stringMatching(/^abort-/),
      next_operation: 'verification_lineage_finalize',
    });
    const second = invoked();
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout.trim().split('\n')[1])).toEqual(lines[1]);
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(block.slot!.positions.find((item) => item.participant === 'harness-governance')!
      .producer_events?.some((event) => event.kind === 'producer_unavailable')).toBe(false);

    const tombstones = join(ownerState, 'tombstones');
    mkdirSync(tombstones, { mode: 0o700 });
    const resourceRoot = join(ownerState, 'resource-root');
    mkdirSync(resourceRoot, { mode: 0o700 });
    const rootInfo = lstatSync(resourceRoot), parentInfo = lstatSync(ownerState);
    const identity = {
      root_device_id: String(rootInfo.dev), root_inode_id: String(rootInfo.ino),
      parent_device_id: String(parentInfo.dev), parent_inode_id: String(parentInfo.ino),
      owner_marker_sha256: 'd'.repeat(64),
    };
    const handoff = block.terminal_resource_handoffs![0];
    const tombstoneId = `tombstone-${'e'.repeat(24)}`;
    const common = {
      tombstone_id: tombstoneId, claim_id: f.claim.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id,
      cleanup_authority_id: handoff.cleanup_authority_id,
      covered_generations: [0], ...identity,
    };
    const started = {
      sequence: 3, previous_event: ownerHash, handle: ambiguity.handle,
      kind: 'cleanup_started', ...common,
    };
    const startedBytes = `${JSON.stringify(started)}\n`;
    const startedHash = sha(startedBytes);
    writeFileSync(join(journal, `00000003-${startedHash}.json`), startedBytes, { mode: 0o600 });
    const tombstoneBody = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      handle: ambiguity.handle, resource_lineage_id: ambiguity.resource_lineage_id,
      cleanup_authority_id: handoff.cleanup_authority_id,
      covered_generations: [0], tombstone_id: tombstoneId, ...identity,
    };
    const tombstoneBytes = `${JSON.stringify(tombstoneBody)}\n`;
    const tombstoneHash = sha(tombstoneBytes);
    writeFileSync(join(tombstones, `${tombstoneId}.json`), tombstoneBytes, { mode: 0o600 });
    const complete = {
      sequence: 4, previous_event: startedHash, handle: ambiguity.handle,
      kind: 'cleanup_complete', ...common, tombstone_sha256: tombstoneHash,
    };
    const completeBytes = `${JSON.stringify(complete)}\n`;
    const completeHash = sha(completeBytes);
    writeFileSync(join(journal, `00000004-${completeHash}.json`), completeBytes, { mode: 0o600 });
    const cleanupBoundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-cleanup-boundary');
    const cleanupRequest = {
      operation: 'cleanup-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id, handle: ambiguity.handle,
      cleanup_authority_id: handoff.cleanup_authority_id,
      covered_generations: [0], generation: 0,
      owner_record_kind: 'terminal_outcome', owner_record_id: ownerHash,
      owner_record_sha256: ownerHash,
    };
    const cleanupSeal = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id, handle: ambiguity.handle,
      cleanup_authority_id: handoff.cleanup_authority_id, tombstone_id: tombstoneId,
      covered_generations: [0], ...identity, tombstone_sha256: tombstoneHash,
      owner_cleanup_event_sha256: completeHash,
    };
    const cleaned = spawnSync(process.execPath, [cleanupBoundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(cleanupRequest)}\n${JSON.stringify(cleanupSeal)}\n`,
      encoding: 'utf8',
    });
    expect(cleaned.status).toBe(0);
    expect(JSON.parse(cleaned.stdout.trim().split('\n')[1])).toMatchObject({
      result: 'acknowledged', next_operation: 'milestone_block_inspect_for_partial',
    });
    expect(JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot))
      .toBe(slotBefore);
  });

  test('an aborted in-flight verifier preserves its canonical result before resource handoff', () => {
    const f = fixture('terminal-abort-in-flight-result', '0');
    const slotBefore = JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot);
    stopMilestoneBlock({
      stateRoot: f.state, roots: f.tuple,
      blockId: f.started.block.block_id, reason: 'aborted',
    });
    const handle = `verify-${'1'.repeat(24)}`;
    const lineage = `lineage-${'2'.repeat(24)}`;
    const ownerState = join(f.state, 'owner-aborted-in-flight-result');
    const journal = join(ownerState, 'journals', handle);
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    chmodSync(join(ownerState, 'journals'), 0o700);
    chmodSync(journal, 0o700);
    const frozen = readMilestoneBlock(f.state, f.started.block.block_id);
    const bindingCore = {
      schema: 'ecpe.t4-coordinator-binding.v1',
      claim_id: f.claim.claim_id, block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, participant: 'harness-governance',
      descriptor_id: 'harness.t4', generation: 0,
      expected_base_sha: f.head, expected_head_sha: f.head,
      participant_subject_hash: frozen.slot!.participant_subject_hashes['harness-governance'],
      roots: f.tuple, registry_hash: f.registry,
    };
    const binding = { ...bindingCore, binding_sha256: sha(stable(bindingCore)) };
    const bodies = [
      {
        handle, kind: 'allocation_started', purpose: 't4-final',
        candidate_id: 'candidate-aborted-in-flight-result',
        coordinator_claim_id: f.claim.claim_id, coordinator_binding: binding,
        resource_lineage_id: lineage, verification_resource_handle: handle,
      },
      { handle, kind: 'allocation_child_start_intent', attempt_id: `attempt-${'3'.repeat(24)}`, request_sha256: '3'.repeat(64) },
      { handle, kind: 'allocation_complete' },
      {
        handle, kind: 'verification_started', attempt_id: `attempt-${'4'.repeat(24)}`,
        request_sha256: '4'.repeat(64), generation: 0, coordinator_binding: binding,
      },
      {
        handle, kind: 'verification_result', passed: true,
        result_id: 'result-aborted-in-flight', proof_id: `proof-${'5'.repeat(24)}`,
        failure_code: null, generation: 0,
      },
    ];
    let previous: string | null = null;
    for (const [index, body] of bodies.entries()) {
      const event = { sequence: index + 1, previous_event: previous, ...body };
      const bytes = `${JSON.stringify(event)}\n`;
      previous = sha(bytes);
      writeFileSync(
        join(journal, `${String(index + 1).padStart(8, '0')}-${previous}.json`),
        bytes,
        { mode: 0o600 },
      );
    }
    const recordedAt = '2026-09-09T08:00:00.000Z';
    const terminalOwner = {
      sequence: 6, previous_event: previous, handle, kind: 'terminal_outcome',
      source: 'evaluation_aborted', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: lineage, covered_generations: [0],
      recorded_at: recordedAt, terminal_evidence_sha256: previous,
    };
    const terminalBytes = `${JSON.stringify(terminalOwner)}\n`;
    const ownerHash = sha(terminalBytes);
    writeFileSync(join(journal, `00000006-${ownerHash}.json`), terminalBytes, { mode: 0o600 });
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-terminal-boundary');
    const request = {
      operation: 'terminal-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, source: 'evaluation_aborted',
      resource_lineage_id: lineage, handle,
    };
    const outcome = {
      schema: 'ecpe.t4-terminal-outcome.v1', source: 'evaluation_aborted',
      block_id: f.started.block.block_id, evaluation_slot_id: f.slot,
      claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: lineage, handle, covered_generations: [0],
      recorded_at: recordedAt, terminal_evidence_sha256: previous,
      owner_outcome_sha256: ownerHash,
    };
    const invoked = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(request)}\n${JSON.stringify(outcome)}\n`, encoding: 'utf8',
    });

    expect(invoked.status).toBe(0);
    const lines = invoked.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[1]).toMatchObject({
      result: 'terminal_handoff_disposition', disposition: null,
      proof_id: null, result_id: null, ambiguity_id: null,
      covered_generations: [0], next_operation: 'verification_lineage_finalize',
    });
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(block.terminal_resource_handoffs![0]).toMatchObject({
      owner_record_kind: 'terminal_outcome', owner_record_id: ownerHash,
      resource_lineage_id: lineage, verification_resource_handle: handle,
    });
  });

  test('an abort after allocation complete seals the allocated no-verifier-start variant', () => {
    const f = fixture('terminal-abort-allocated-before-start', '1');
    const slotBefore = JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot);
    stopMilestoneBlock({ stateRoot: f.state, roots: f.tuple,
      blockId: f.started.block.block_id, reason: 'aborted' });
    const handle = `verify-${'2'.repeat(24)}`;
    const lineage = `lineage-${'3'.repeat(24)}`;
    const ownerState = join(f.state, 'owner-aborted-allocated-before-start');
    const journal = join(ownerState, 'journals', handle);
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    chmodSync(join(ownerState, 'journals'), 0o700);
    chmodSync(journal, 0o700);
    const frozen = readMilestoneBlock(f.state, f.started.block.block_id);
    const bindingCore = {
      schema: 'ecpe.t4-coordinator-binding.v1', claim_id: f.claim.claim_id,
      block_id: f.started.block.block_id, evaluation_slot_id: f.slot,
      participant: 'harness-governance', descriptor_id: 'harness.t4', generation: 0,
      expected_base_sha: f.head, expected_head_sha: f.head,
      participant_subject_hash: frozen.slot!.participant_subject_hashes['harness-governance'],
      roots: f.tuple, registry_hash: f.registry,
    };
    const binding = { ...bindingCore, binding_sha256: sha(stable(bindingCore)) };
    const bodies = [
      { handle, kind: 'allocation_started', purpose: 't4-final',
        candidate_id: 'candidate-aborted-allocated-before-start',
        coordinator_claim_id: f.claim.claim_id, coordinator_binding: binding,
        resource_lineage_id: lineage, verification_resource_handle: handle },
      { handle, kind: 'allocation_child_start_intent',
        attempt_id: `attempt-${'4'.repeat(24)}`, request_sha256: '4'.repeat(64) },
      { handle, kind: 'allocation_complete' },
    ];
    let previous: string | null = null;
    for (const [index, body] of bodies.entries()) {
      const event = { sequence: index + 1, previous_event: previous, ...body };
      const bytes = `${JSON.stringify(event)}\n`;
      previous = sha(bytes);
      writeFileSync(join(journal,
        `${String(index + 1).padStart(8, '0')}-${previous}.json`), bytes, { mode: 0o600 });
    }
    const terminalOwner = {
      sequence: 4, previous_event: previous, handle, kind: 'terminal_outcome',
      source: 'aborted_before_start', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: lineage, covered_generations: [0],
      recorded_at: '2026-09-09T08:30:00.000Z', terminal_evidence_sha256: previous,
      producer_kind: 'harness_verification', allocation_phase: 'allocation_complete',
      root_state: 'complete', allocation_child_started: true,
      verification_child_started: false,
    };
    const terminalBytes = `${JSON.stringify(terminalOwner)}\n`;
    const ownerHash = sha(terminalBytes);
    const terminalPath = join(journal, `00000004-${ownerHash}.json`);
    writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
    const mismatchedTerminal = {
      ...terminalOwner,
      claim_id: `claim-${'0'.repeat(32)}`,
    };
    const mismatchedBytes = `${JSON.stringify(mismatchedTerminal)}\n`;
    const mismatchedHash = sha(mismatchedBytes);
    rmSync(terminalPath);
    writeFileSync(
      join(journal, `00000004-${mismatchedHash}.json`),
      mismatchedBytes,
      { mode: 0o600 },
    );
    expect(() => verifyCanonicalOwnerTerminalOutcome({
      ownerRoot: ownerState,
      handle,
      ownerOutcomeSha256: mismatchedHash,
      requireLast: true,
      errorCode: 'expected_claim_mismatch_rejection',
    })).toThrow('expected_claim_mismatch_rejection');
    rmSync(join(journal, `00000004-${mismatchedHash}.json`));
    writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
    const outcome = { schema: 'ecpe.t4-terminal-outcome.v1',
      source: 'aborted_before_start', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: lineage, handle, covered_generations: [0],
      recorded_at: terminalOwner.recorded_at, terminal_evidence_sha256: previous,
      owner_outcome_sha256: ownerHash, producer_kind: 'harness_verification',
      allocation_phase: 'allocation_complete', root_state: 'complete',
      allocation_child_started: true, verification_child_started: false };
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-terminal-boundary');
    const invoked = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify({ operation: 'terminal-session',
        block_id: f.started.block.block_id, evaluation_slot_id: f.slot,
        source: 'aborted_before_start', resource_lineage_id: lineage, handle })}\n${JSON.stringify(outcome)}\n`,
      encoding: 'utf8',
    });
    expect(invoked.status).toBe(0);
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(block.terminal_resource_handoffs![0].owner_record_id).toBe(ownerHash);
  });

  test('an abort before allocation child start seals and cleans a never-created root', () => {
    const f = fixture('terminal-abort-never-created', 'a');
    const slotBefore = JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot);
    stopMilestoneBlock({
      stateRoot: f.state, roots: f.tuple,
      blockId: f.started.block.block_id, reason: 'aborted',
    });
    const handle = `verify-${'c'.repeat(24)}`;
    const lineage = `lineage-${'d'.repeat(24)}`;
    const ownerState = join(f.state, 'owner-never-created');
    const journal = join(ownerState, 'journals', handle);
    const tombstones = join(ownerState, 'tombstones');
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    mkdirSync(tombstones, { mode: 0o700 });
    chmodSync(join(ownerState, 'journals'), 0o700);
    chmodSync(journal, 0o700);
    const frozen = readMilestoneBlock(f.state, f.started.block.block_id);
    const bindingCore = {
      schema: 'ecpe.t4-coordinator-binding.v1',
      claim_id: f.claim.claim_id, block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, participant: 'harness-governance',
      descriptor_id: 'harness.t4', generation: 0,
      expected_base_sha: f.head, expected_head_sha: f.head,
      participant_subject_hash: frozen.slot!.participant_subject_hashes['harness-governance'],
      roots: f.tuple, registry_hash: f.registry,
    };
    const coordinatorBinding = {
      ...bindingCore, binding_sha256: sha(stable(bindingCore)),
    };
    const started = {
      sequence: 1, previous_event: null, handle, kind: 'allocation_started',
      purpose: 't4-final', candidate_id: 'candidate-never-created',
      coordinator_claim_id: f.claim.claim_id,
      coordinator_binding: coordinatorBinding,
      resource_lineage_id: lineage, verification_resource_handle: handle,
    };
    const startedBytes = `${JSON.stringify(started)}\n`;
    const startedHash = sha(startedBytes);
    writeFileSync(join(journal, `00000001-${startedHash}.json`), startedBytes, { mode: 0o600 });
    const recordedAt = '2026-09-09T07:00:00.000Z';
    const terminalOwner = {
      sequence: 2, previous_event: startedHash, handle, kind: 'terminal_outcome',
      source: 'aborted_before_start', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id, generation: 0,
      resource_lineage_id: lineage, covered_generations: [0],
      recorded_at: recordedAt, terminal_evidence_sha256: startedHash,
      producer_kind: 'harness_verification', allocation_phase: 'allocation_started',
      root_state: 'never_created', allocation_child_started: false,
      verification_child_started: false,
    };
    const terminalBytes = `${JSON.stringify(terminalOwner)}\n`;
    const ownerHash = sha(terminalBytes);
    const terminalPath = join(journal, `00000002-${ownerHash}.json`);
    writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
    const cleanupBoundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-cleanup-boundary');
    const invokeForgedCleanup = (forgedOwnerHash: string) => spawnSync(
      process.execPath,
      [cleanupBoundary],
      {
        timeout: 30_000,
        env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
          ECPE_TEST_OWNER_STATE_ROOT: ownerState },
        input: `${JSON.stringify({
          operation: 'cleanup-session', block_id: f.started.block.block_id,
          evaluation_slot_id: f.slot, claim_id: f.claim.claim_id,
          resource_lineage_id: lineage, handle,
          cleanup_authority_id: `cleanup-auth-${'f'.repeat(32)}`,
          covered_generations: [0], generation: 0,
          owner_record_kind: 'terminal_outcome', owner_record_id: forgedOwnerHash,
          owner_record_sha256: forgedOwnerHash,
        })}\n{}\n`,
        encoding: 'utf8',
      },
    );

    rmSync(terminalPath);
    const badEvidence = { ...terminalOwner, terminal_evidence_sha256: 'f'.repeat(64) };
    const badEvidenceBytes = `${JSON.stringify(badEvidence)}\n`;
    const badEvidenceHash = sha(badEvidenceBytes);
    const badEvidencePath = join(journal, `00000002-${badEvidenceHash}.json`);
    writeFileSync(badEvidencePath, badEvidenceBytes, { mode: 0o600 });
    expect(invokeForgedCleanup(badEvidenceHash).status).not.toBe(0);
    expect(readMilestoneBlock(f.state, f.started.block.block_id).terminal_resource_handoffs ?? [])
      .toHaveLength(0);

    rmSync(badEvidencePath);
    const childIntent = {
      sequence: 2, previous_event: startedHash, handle,
      kind: 'allocation_child_start_intent', attempt_id: `attempt-${'e'.repeat(24)}`,
      request_sha256: 'e'.repeat(64),
    };
    const childBytes = `${JSON.stringify(childIntent)}\n`;
    const childHash = sha(childBytes);
    writeFileSync(join(journal, `00000002-${childHash}.json`), childBytes, { mode: 0o600 });
    const afterChild = {
      ...terminalOwner, sequence: 3, previous_event: childHash,
      terminal_evidence_sha256: childHash,
    };
    const afterChildBytes = `${JSON.stringify(afterChild)}\n`;
    const afterChildHash = sha(afterChildBytes);
    writeFileSync(join(journal, `00000003-${afterChildHash}.json`), afterChildBytes, { mode: 0o600 });
    expect(invokeForgedCleanup(afterChildHash).status).not.toBe(0);
    expect(readMilestoneBlock(f.state, f.started.block.block_id).terminal_resource_handoffs ?? [])
      .toHaveLength(0);
    rmSync(join(journal, `00000002-${childHash}.json`));
    rmSync(join(journal, `00000003-${afterChildHash}.json`));

    const startedPath = join(journal, `00000001-${startedHash}.json`);
    rmSync(startedPath);
    const mismatchedStarted = {
      ...started,
      coordinator_claim_id: `claim-${'0'.repeat(32)}`,
    };
    const mismatchedStartedBytes = `${JSON.stringify(mismatchedStarted)}\n`;
    const mismatchedStartedHash = sha(mismatchedStartedBytes);
    writeFileSync(
      join(journal, `00000001-${mismatchedStartedHash}.json`),
      mismatchedStartedBytes,
      { mode: 0o600 },
    );
    const afterMismatch = {
      ...terminalOwner,
      previous_event: mismatchedStartedHash,
      terminal_evidence_sha256: mismatchedStartedHash,
    };
    const afterMismatchBytes = `${JSON.stringify(afterMismatch)}\n`;
    const afterMismatchHash = sha(afterMismatchBytes);
    writeFileSync(
      join(journal, `00000002-${afterMismatchHash}.json`),
      afterMismatchBytes,
      { mode: 0o600 },
    );
    expect(invokeForgedCleanup(afterMismatchHash).status).not.toBe(0);
    expect(readMilestoneBlock(f.state, f.started.block.block_id).terminal_resource_handoffs ?? [])
      .toHaveLength(0);
    rmSync(join(journal, `00000001-${mismatchedStartedHash}.json`));
    rmSync(join(journal, `00000002-${afterMismatchHash}.json`));
    writeFileSync(startedPath, startedBytes, { mode: 0o600 });
    writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
    const terminalBoundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-terminal-boundary');
    const terminalRequest = {
      operation: 'terminal-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, source: 'aborted_before_start',
      resource_lineage_id: lineage, handle,
    };
    const terminalOutcome = {
      schema: 'ecpe.t4-terminal-outcome.v1', source: 'aborted_before_start',
      block_id: f.started.block.block_id, evaluation_slot_id: f.slot,
      claim_id: f.claim.claim_id, generation: 0, resource_lineage_id: lineage,
      handle, covered_generations: [0], recorded_at: recordedAt,
      terminal_evidence_sha256: startedHash, owner_outcome_sha256: ownerHash,
      producer_kind: 'harness_verification', allocation_phase: 'allocation_started',
      root_state: 'never_created', allocation_child_started: false,
      verification_child_started: false,
    };
    const invokeTerminal = () => spawnSync(process.execPath, [terminalBoundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(terminalRequest)}\n${JSON.stringify(terminalOutcome)}\n`,
      encoding: 'utf8',
    });
    const terminal = invokeTerminal();
    expect(terminal.status).toBe(0);
    const terminalLines = terminal.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(invokeTerminal().status).toBe(0);
    let block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(block.slot!.positions.find((item) => item.participant === 'harness-governance')!
      .producer_events?.some((event) => event.kind === 'producer_unavailable')).toBe(false);

    const handoff = block.terminal_resource_handoffs![0];
    const parentInfo = lstatSync(ownerState);
    const identity = {
      root_state: 'never_created' as const,
      root_device_id: null, root_inode_id: null,
      parent_device_id: String(parentInfo.dev), parent_inode_id: String(parentInfo.ino),
      owner_marker_sha256: null,
    };
    const tombstoneId = `tombstone-${'e'.repeat(24)}`;
    const common = {
      tombstone_id: tombstoneId, claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, cleanup_authority_id: handoff.cleanup_authority_id,
      covered_generations: [0], ...identity,
    };
    const cleanupStarted = {
      sequence: 3, previous_event: ownerHash, handle,
      kind: 'cleanup_started', ...common,
    };
    const cleanupStartedBytes = `${JSON.stringify(cleanupStarted)}\n`;
    const cleanupStartedHash = sha(cleanupStartedBytes);
    writeFileSync(join(journal, `00000003-${cleanupStartedHash}.json`), cleanupStartedBytes, { mode: 0o600 });
    const tombstoneBody = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      handle, resource_lineage_id: lineage,
      cleanup_authority_id: handoff.cleanup_authority_id,
      covered_generations: [0], tombstone_id: tombstoneId, ...identity,
    };
    const tombstoneBytes = `${JSON.stringify(tombstoneBody)}\n`;
    const tombstoneHash = sha(tombstoneBytes);
    writeFileSync(join(tombstones, `${tombstoneId}.json`), tombstoneBytes, { mode: 0o600 });
    const cleanupComplete = {
      sequence: 4, previous_event: cleanupStartedHash, handle,
      kind: 'cleanup_complete', ...common, tombstone_sha256: tombstoneHash,
    };
    const cleanupCompleteBytes = `${JSON.stringify(cleanupComplete)}\n`;
    const cleanupHash = sha(cleanupCompleteBytes);
    writeFileSync(join(journal, `00000004-${cleanupHash}.json`), cleanupCompleteBytes, { mode: 0o600 });
    const cleanupRequest = {
      operation: 'cleanup-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, handle,
      cleanup_authority_id: handoff.cleanup_authority_id,
      covered_generations: [0], generation: 0,
      owner_record_kind: 'terminal_outcome', owner_record_id: ownerHash,
      owner_record_sha256: ownerHash,
    };
    const cleanupSeal = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, handle,
      cleanup_authority_id: handoff.cleanup_authority_id,
      tombstone_id: tombstoneId, covered_generations: [0], ...identity,
      tombstone_sha256: tombstoneHash, owner_cleanup_event_sha256: cleanupHash,
    };
    const invokeCleanup = (seal = cleanupSeal) => spawnSync(process.execPath, [cleanupBoundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(cleanupRequest)}\n${JSON.stringify(seal)}\n`, encoding: 'utf8',
    });
    const cleaned = invokeCleanup();
    expect(cleaned.status).toBe(0);
    expect(JSON.parse(cleaned.stdout.trim().split('\n')[1])).toMatchObject({
      result: 'acknowledged', next_operation: 'milestone_block_inspect_for_partial',
    });
    expect(invokeCleanup().status).toBe(0);
    const mixed = invokeCleanup({ ...cleanupSeal, root_inode_id: '123' });
    expect(mixed.status).not.toBe(0);
    block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(block.resource_cleanup_acks).toHaveLength(1);
    expect(terminalLines[1]).toMatchObject({ handoff_id: handoff.handoff_id });
  });

  test('the cleanup boundary verifies the canonical owner tombstone before acknowledging', () => {
    const f = fixture('cleanup-boundary', '4');
    const handle = `verify-${'4'.repeat(24)}`;
    const lineage = `lineage-${'5'.repeat(24)}`;
    const terminal = terminalizeHarnessVerificationUnavailable({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      terminalOutcome: {
        schema: 'ecpe.t4-terminal-outcome.v1', source: 'allocation_failed',
        claim_id: f.claim.claim_id, generation: 0,
        resource_lineage_id: lineage, handle, covered_generations: [0],
        recorded_at: new Date().toISOString(),
        terminal_evidence_sha256: '6'.repeat(64),
        owner_outcome_sha256: '7'.repeat(64),
      },
    });
    const ownerState = join(f.state, 'owner-state');
    const journal = join(ownerState, 'journals', handle);
    const tombstones = join(ownerState, 'tombstones');
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    mkdirSync(tombstones, { recursive: true, mode: 0o700 });
    chmodSync(join(ownerState, 'journals'), 0o700);
    chmodSync(journal, 0o700);
    chmodSync(tombstones, 0o700);
    const identity = {
      root_device_id: '1', root_inode_id: '2',
      parent_device_id: '1', parent_inode_id: '3',
      owner_marker_sha256: '8'.repeat(64),
    };
    const tombstoneId = `tombstone-${'9'.repeat(24)}`;
    const common = {
      tombstone_id: tombstoneId, claim_id: f.claim.claim_id,
      resource_lineage_id: lineage,
      cleanup_authority_id: terminal.cleanup_authorization_id,
      covered_generations: [0], ...identity,
    };
    const started = {
      sequence: 1, previous_event: null, handle,
      kind: 'cleanup_started', ...common,
    };
    const startedBytes = `${JSON.stringify(started)}\n`;
    const startedHash = sha(startedBytes);
    writeFileSync(join(journal, `00000001-${startedHash}.json`), startedBytes, { mode: 0o600 });
    const tombstoneBody = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      handle, resource_lineage_id: lineage,
      cleanup_authority_id: terminal.cleanup_authorization_id,
      covered_generations: [0], tombstone_id: tombstoneId, ...identity,
    };
    const tombstoneBytes = `${JSON.stringify(tombstoneBody)}\n`;
    const tombstoneHash = sha(tombstoneBytes);
    writeFileSync(join(tombstones, `${tombstoneId}.json`), tombstoneBytes, { mode: 0o600 });
    const complete = {
      sequence: 2, previous_event: startedHash, handle,
      kind: 'cleanup_complete', ...common, tombstone_sha256: tombstoneHash,
    };
    const completeBytes = `${JSON.stringify(complete)}\n`;
    const completeHash = sha(completeBytes);
    writeFileSync(join(journal, `00000002-${completeHash}.json`), completeBytes, { mode: 0o600 });
    const seal = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, handle,
      cleanup_authority_id: terminal.cleanup_authorization_id,
      tombstone_id: tombstoneId, covered_generations: [0], ...identity,
      tombstone_sha256: tombstoneHash,
      owner_cleanup_event_sha256: completeHash,
    };
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-cleanup-boundary');
    const request = {
      operation: 'cleanup-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, handle,
      cleanup_authority_id: terminal.cleanup_authorization_id,
      covered_generations: [0], generation: 0,
      owner_record_kind: null, owner_record_id: null, owner_record_sha256: null,
    };
    const result = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(request)}\n${JSON.stringify(seal)}\n`, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ result: 'ready', claim_id: f.claim.claim_id });
    expect(lines[1]).toMatchObject({
      schema: 'ecpe.t4-resource-cleanup-ack.v1',
      claim_id: f.claim.claim_id, tombstone_id: tombstoneId,
      next_operation: 'milestone_block_inspect_for_partial',
    });
    expect(readMilestoneBlock(f.state, f.started.block.block_id).resource_cleanup_acks).toHaveLength(1);
  });

  test('the cleanup boundary recovers after ready-response loss without mutating the frozen slot', async () => {
    const f = fixture('abort-cleanup-boundary', 'e');
    const slotBefore = JSON.stringify(
      readMilestoneBlock(f.state, f.started.block.block_id).slot,
    );
    const stopped = stopMilestoneBlock({
      stateRoot: f.state, roots: f.tuple,
      blockId: f.started.block.block_id, reason: 'aborted',
    });
    const ownerState = mkdtempSync(join(tmpdir(), 'owner-abort-cleanup-'));
    roots.push(ownerState);
    const handle = `verify-${'6'.repeat(24)}`;
    const lineage = `lineage-${'7'.repeat(24)}`;
    const authorityId = 'consumption-abort-boundary';
    const journal = join(ownerState, 'journals', handle);
    const tombstones = join(ownerState, 'tombstones');
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    mkdirSync(tombstones, { recursive: true, mode: 0o700 });
    let previous: string | null = null;
    const append = (body: Record<string, unknown>) => {
      const event = {
        sequence: Number(body.sequence), previous_event: previous,
        handle, ...body,
      };
      const bytes = `${JSON.stringify(event)}\n`;
      const hash = sha(bytes);
      writeFileSync(join(journal, `${String(event.sequence).padStart(8, '0')}-${hash}.json`), bytes, { mode: 0o600 });
      previous = hash;
      return hash;
    };
    append({
      sequence: 1, kind: 'allocation_started', purpose: 't4-final',
      candidate_id: 'candidate-abort', coordinator_claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, verification_resource_handle: handle,
    });
    const ownerRecordHash = append({
      sequence: 2, kind: 'proof_consumed', consumer: 't4.harness_checkpoint',
      consumption_id: authorityId,
    });
    const request = {
      operation: 'cleanup-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, handle, cleanup_authority_id: authorityId,
      covered_generations: [0], generation: 0,
      owner_record_kind: 'proof_consumed', owner_record_id: authorityId,
      owner_record_sha256: ownerRecordHash,
    };
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-cleanup-boundary');
    const interrupted = spawn(process.execPath, [boundary], {
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let interruptedStdout = '';
    interrupted.stdout.on('data', (chunk) => { interruptedStdout += String(chunk); });
    interrupted.stdin.write(`${JSON.stringify(request)}\n`);
    await new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (interruptedStdout.includes('\n')) resolve();
        else if (interrupted.exitCode !== null) reject(new Error('cleanup boundary exited before ready'));
        else setTimeout(poll, 5);
      };
      poll();
    });
    expect(JSON.parse(interruptedStdout.trim())).toMatchObject({ result: 'ready' });
    interrupted.kill('SIGKILL');
    await new Promise<void>((resolve) => interrupted.once('exit', () => resolve()));
    const afterReadyLoss = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(afterReadyLoss.slot)).toBe(slotBefore);
    expect(afterReadyLoss.terminal_resource_handoffs).toHaveLength(1);
    expect(afterReadyLoss.resource_cleanup_acks).toHaveLength(0);
    const root = join(ownerState, 'roots');
    mkdirSync(root, { mode: 0o700 });
    const rootInfo = lstatSync(root);
    const parentInfo = lstatSync(ownerState);
    const identity = {
      root_device_id: String(rootInfo.dev), root_inode_id: String(rootInfo.ino),
      parent_device_id: String(parentInfo.dev), parent_inode_id: String(parentInfo.ino),
      owner_marker_sha256: '8'.repeat(64),
    };
    const tombstoneId = `tombstone-${'9'.repeat(24)}`;
    const common = {
      tombstone_id: tombstoneId, claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, cleanup_authority_id: authorityId,
      covered_generations: [0], ...identity,
    };
    append({ sequence: 3, kind: 'cleanup_started', ...common });
    const tombstoneBody = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      handle, resource_lineage_id: lineage, cleanup_authority_id: authorityId,
      covered_generations: [0], tombstone_id: tombstoneId, ...identity,
    };
    const tombstoneBytes = `${JSON.stringify(tombstoneBody)}\n`;
    const tombstoneHash = sha(tombstoneBytes);
    writeFileSync(join(tombstones, `${tombstoneId}.json`), tombstoneBytes, { mode: 0o600 });
    const cleanupHash = append({
      sequence: 4, kind: 'cleanup_complete', ...common,
      tombstone_sha256: tombstoneHash,
    });
    const seal = {
      schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: f.claim.claim_id,
      resource_lineage_id: lineage, handle, cleanup_authority_id: authorityId,
      tombstone_id: tombstoneId, covered_generations: [0], ...identity,
      tombstone_sha256: tombstoneHash, owner_cleanup_event_sha256: cleanupHash,
    };
    const result = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(request)}\n${JSON.stringify(seal)}\n`, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ result: 'ready', owner_record_sha256: ownerRecordHash });
    expect(lines[1]).toMatchObject({ result: 'acknowledged', next_operation: 'milestone_block_inspect_for_partial' });
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(block.resource_cleanup_acks).toHaveLength(1);
    expect(block.resource_cleanup_acks?.[0]).toMatchObject({
      authority_kind: 'abort_handoff',
      terminal_handoff_id: block.terminal_resource_handoffs?.[0].handoff_id,
      abort_receipt_id: block.evaluation_abort_event?.stop_receipt_id,
      owner_record_sha256: ownerRecordHash,
    });
    const replayed = spawnSync(process.execPath, [boundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(request)}\n${JSON.stringify(seal)}\n`, encoding: 'utf8',
    });
    expect(replayed.status).toBe(0);
    expect(JSON.parse(replayed.stdout.trim().split('\n')[1])).toEqual(lines[1]);
    expect(readMilestoneBlock(f.state, f.started.block.block_id).resource_cleanup_acks)
      .toHaveLength(1);
  });

  test('two real replay-boundary processes publish one claim and one replay event', async () => {
    const f = fixture('process-race', '7');
    const payload = {
      initial_claim: {
        claim_id: f.claim.claim_id,
        block_id: f.started.block.block_id,
        evaluation_slot_id: f.slot,
        participant: 'harness-governance',
        expected_base_sha: f.head,
        expected_head_sha: f.head,
        descriptor_id: 'harness.t4',
        generation: 0,
        participant_subject_hash: sha(`${f.head}\0${git(f.repo, ['rev-parse', 'HEAD^{tree}'])}\0${f.registry}`),
        roots: f.tuple,
        registry_hash: f.registry,
      },
      ambiguity: {
        schema: 'ecpe.t4-ambiguous-attempt.v1',
        claim_id: f.claim.claim_id,
        generation: 0,
        resource_lineage_id: `lineage-${'d'.repeat(24)}`,
        handle: `verify-${'e'.repeat(24)}`,
        recorded_at: new Date().toISOString(),
        ambiguity_sha256: 'f'.repeat(64),
      },
    };
    const boundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-replay-boundary');
    const invoke = (operation:'publish-ambiguity'|'claim-replay') => new Promise<{code:number|null;stdout:string;stderr:string}>((resolve) => {
      const child = spawn(process.execPath, [boundary], {
        env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ ...payload, operation }));
    });

    const published=await invoke('publish-ambiguity');
    expect(published.code).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({result:'retryable',generation:0,replays_used:0});
    const publishedPosition=readMilestoneBlock(f.state,f.started.block.block_id).slot!.positions.find(item=>item.participant==='harness-governance')!;
    expect(publishedPosition.state).toBe('retryable_ambiguous');
    expect(publishedPosition.producer_events?.map(event=>event.kind)).toEqual(['producer_claimed','producer_ambiguous']);
    const results = await Promise.all([invoke('claim-replay'), invoke('claim-replay')]);
    if (results.some((item) => item.code !== 0)) throw new Error(JSON.stringify(results));
    expect(results.map((item) => item.code)).toEqual([0, 0]);
    const claims = results.map((item) => JSON.parse(item.stdout));
    expect(claims[0]).toEqual(claims[1]);
    expect(claims[0]).toMatchObject({ generation: 1, replays_used: 1 });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position.producer_events?.filter((event) => event.kind === 'producer_replayed')).toHaveLength(1);
  });

  test('attaches a generation-1 passing proof while retaining replay history', () => {
    const f = fixture('replay-pass', '6');
    const ambiguity = {
      schema: 'ecpe.t4-ambiguous-attempt.v1' as const,
      claim_id: f.claim.claim_id,
      generation: 0 as const,
      resource_lineage_id: `lineage-${'7'.repeat(24)}`,
      handle: `verify-${'8'.repeat(24)}`,
      recorded_at: new Date().toISOString(),
      ambiguity_sha256: '9'.repeat(64),
    };
    recordHarnessVerificationAmbiguity({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      expectedBase: f.head, expectedHead: f.head, ambiguity,
    });
    const replay = claimHarnessVerificationReplay({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
    });
    const attached = attachHarnessVerificationCheckpoint({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      governanceRoot: f.repo,
      registryHash: f.registry,
      expectedBase: f.head,
      expectedHead: f.head,
      verificationProofId: 'proof-generation-1',
    }, () => ({
      proof_id: 'proof-generation-1',
      result_id: 'result-generation-1',
      consumption_id: 'consumption-generation-1',
      coordinator_claim_id: replay.claim_id,
      handle: ambiguity.handle,
      generation: 1 as const,
      resource_lineage_id: ambiguity.resource_lineage_id,
      covered_generations: [0, 1] as Array<0 | 1>,
    }));

    expect(attached).toMatchObject({ result: 'attached', claim_id: replay.claim_id, next_operation: 'verification_lineage_finalize' });
    const position = readMilestoneBlock(f.state, f.started.block.block_id)
      .slot!.positions.find((item) => item.participant === 'harness-governance')!;
    expect(position).toMatchObject({
      state: 'attached', generation: 1, replays_used: 1,
      resource_lineage_id: ambiguity.resource_lineage_id,
      verification_resource_handle: ambiguity.handle,
    });
    expect(position.producer_events?.map((event) => event.kind)).toEqual([
      'producer_claimed', 'producer_ambiguous', 'producer_replayed',
    ]);
    expect(() => buildPilotEvaluation({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
    })).toThrow('verification_lineage_finalize_required');
    const ownerState = mkdtempSync(join(tmpdir(), 'owner-generation-1-cleanup-'));
    roots.push(ownerState);
    const journal = join(ownerState, 'journals', ambiguity.handle);
    const tombstones = join(ownerState, 'tombstones');
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    mkdirSync(tombstones, { recursive: true, mode: 0o700 });
    let previous: string | null = null;
    const append = (body: Record<string, unknown>) => {
      const event = { sequence: Number(body.sequence), previous_event: previous,
        handle: ambiguity.handle, ...body };
      const bytes = `${JSON.stringify(event)}\n`;
      const hash = sha(bytes);
      writeFileSync(join(journal, `${String(event.sequence).padStart(8, '0')}-${hash}.json`), bytes, { mode: 0o600 });
      previous = hash;
      return hash;
    };
    append({ sequence: 1, kind: 'allocation_started',
      coordinator_claim_id: f.claim.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id });
    append({ sequence: 2, kind: 'verification_replay_claimed',
      coordinator_binding: { claim_id: replay.claim_id },
      resource_lineage_id: ambiguity.resource_lineage_id });
    const ownerRecordHash = append({ sequence: 3, kind: 'proof_consumed',
      consumption_id: 'consumption-generation-1' });
    const ownerRoot = join(ownerState, 'root');
    mkdirSync(ownerRoot, { mode: 0o700 });
    const rootInfo = lstatSync(ownerRoot), parentInfo = lstatSync(ownerState);
    const identity = {
      root_device_id: String(rootInfo.dev), root_inode_id: String(rootInfo.ino),
      parent_device_id: String(parentInfo.dev), parent_inode_id: String(parentInfo.ino),
      owner_marker_sha256: 'b'.repeat(64) };
    const tombstoneId = `tombstone-${'a'.repeat(24)}`;
    const common = { tombstone_id: tombstoneId, claim_id: replay.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id,
      cleanup_authority_id: 'consumption-generation-1',
      covered_generations: [0, 1], ...identity };
    append({ sequence: 4, kind: 'cleanup_started', ...common });
    const tombstoneBody = { schema: 'ecpe.t4-lineage-tombstone.v1',
      claim_id: replay.claim_id, handle: ambiguity.handle,
      resource_lineage_id: ambiguity.resource_lineage_id,
      cleanup_authority_id: 'consumption-generation-1',
      covered_generations: [0, 1], tombstone_id: tombstoneId, ...identity };
    const tombstoneBytes = `${JSON.stringify(tombstoneBody)}\n`;
    const tombstoneHash = sha(tombstoneBytes);
    writeFileSync(join(tombstones, `${tombstoneId}.json`), tombstoneBytes, { mode: 0o600 });
    const cleanupHash = append({ sequence: 5, kind: 'cleanup_complete', ...common,
      tombstone_sha256: tombstoneHash });
    const cleanupBoundary = join(import.meta.dir, '..', 'bin', 'gstack-t4-cleanup-boundary');
    const request = { operation: 'cleanup-session', block_id: f.started.block.block_id,
      evaluation_slot_id: f.slot, claim_id: replay.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id, handle: ambiguity.handle,
      cleanup_authority_id: 'consumption-generation-1', covered_generations: [0, 1],
      generation: 1, owner_record_kind: 'proof_consumed',
      owner_record_id: 'consumption-generation-1', owner_record_sha256: ownerRecordHash };
    const seal = { schema: 'ecpe.t4-lineage-tombstone.v1', claim_id: replay.claim_id,
      resource_lineage_id: ambiguity.resource_lineage_id, handle: ambiguity.handle,
      cleanup_authority_id: 'consumption-generation-1', tombstone_id: tombstoneId,
      covered_generations: [0, 1], ...identity, tombstone_sha256: tombstoneHash,
      owner_cleanup_event_sha256: cleanupHash };
    const boundaryResult = spawnSync(process.execPath, [cleanupBoundary], { timeout: 30_000,
      env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: f.state,
        ECPE_TEST_OWNER_STATE_ROOT: ownerState },
      input: `${JSON.stringify(request)}\n${JSON.stringify(seal)}\n`, encoding: 'utf8',
    });
    expect(boundaryResult.status).toBe(0);
    const cleanup = JSON.parse(boundaryResult.stdout.trim().split('\n')[1]);
    expect(cleanup.next_operation).toBe('pilot_evaluation_build');
    expect(buildPilotEvaluation({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
    }).evaluation_slot.state).toBe('complete');
  });

  test('commits an exact prepared proof receipt once', () => {
    const f = fixture('pass', 'a');
    let calls = 0;
    const input = {
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      governanceRoot: f.repo,
      registryHash: f.registry,
      expectedBase: f.head,
      expectedHead: f.head,
      verificationProofId: 'proof-t4',
    };
    const consume = () => {
      calls += 1;
      return {
        proof_id: 'proof-t4',
        result_id: 'result-t4',
        consumption_id: 'consumption-t4',
        coordinator_claim_id: f.claim.claim_id,
        handle: `verify-${'1'.repeat(24)}`,
        generation: 0 as const,
        resource_lineage_id: `lineage-${'1'.repeat(24)}`,
        covered_generations: [0] as Array<0 | 1>,
      };
    };
    expect(attachHarnessVerificationCheckpoint(input, consume)).toMatchObject({
      result: 'attached',
      proof_id: 'proof-t4',
      consumption_id: 'consumption-t4',
    });
    expect(attachHarnessVerificationCheckpoint(input, consume).result).toBe(
      'receipt_current',
    );
    expect(calls).toBe(1);
    expect(
      readMilestoneBlock(f.state, f.started.block.block_id).slot?.positions.find(
        (item) => item.participant === 'harness-governance',
      ),
    ).toMatchObject({
      state: 'attached',
      verification_resource_handle: `verify-${'1'.repeat(24)}`,
      verification_result_id: 'result-t4',
      verification_consumption_id: 'consumption-t4',
    });
  });

  test('an abort between prepared receipt and commit preserves the resource', () => {
    const f = fixture('abort', 'b');
    const input = {
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      governanceRoot: f.repo,
      registryHash: f.registry,
      expectedBase: f.head,
      expectedHead: f.head,
      verificationProofId: 'proof-abort',
    };
    expect(() =>
      attachHarnessVerificationCheckpoint(input, () => {
        stopMilestoneBlock({
          stateRoot: f.state,
          roots: f.tuple,
          blockId: f.started.block.block_id,
          reason: 'aborted',
        });
        return {
          proof_id: 'proof-abort',
          result_id: 'result-abort',
          consumption_id: 'consumption-abort',
          coordinator_claim_id: f.claim.claim_id,
          handle: `verify-${'2'.repeat(24)}`,
          generation: 0 as const,
          resource_lineage_id: `lineage-${'2'.repeat(24)}`,
          covered_generations: [0] as Array<0 | 1>,
        };
      }),
    ).toThrow('harness_checkpoint_phase_invalid');
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(block.phase).toBe('terminal_unreported');
    expect(
      block.slot?.positions.find((item) => item.participant === 'harness-governance'),
    ).toMatchObject({
      state: 'producer_reserved',
      proof_id: null,
    });
    expect(
      block.slot?.positions.find((item) => item.participant === 'harness-governance')
        ?.verification_consumption_id,
    ).toBeUndefined();
  });

  test('binds an abort-owned resource above the frozen slot before cleanup', () => {
    const f = fixture('abort-resource-handoff', 'd');
    const before = JSON.stringify(
      readMilestoneBlock(f.state, f.started.block.block_id).slot,
    );
    stopMilestoneBlock({
      stateRoot: f.state,
      roots: f.tuple,
      blockId: f.started.block.block_id,
      reason: 'aborted',
    });
    const input = {
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      claimId: f.claim.claim_id,
      generation: 0 as const,
      resourceLineageId: `lineage-${'4'.repeat(24)}`,
      handle: `verify-${'5'.repeat(24)}`,
      cleanupAuthorityId: 'consumption-abort-handoff',
      coveredGenerations: [0] as Array<0 | 1>,
      ownerRecordKind: 'proof_consumed' as const,
      ownerRecordSha256: '6'.repeat(64),
      now: new Date('2026-01-02T00:00:00.000Z'),
    };
    const recorded = prepareHarnessAbortResourceHandoffAlreadyGated(input);
    expect(recorded).toMatchObject({
      result: 'recorded',
      next_operation: 'verification_lineage_finalize',
    });
    let block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(before);
    expect(block.terminal_resource_handoffs).toHaveLength(1);
    expect(prepareHarnessAbortResourceHandoffAlreadyGated(input).result).toBe('reused');

    const frozen = JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id));
    expect(() => prepareHarnessAbortResourceHandoffAlreadyGated({
      ...input,
      ownerRecordSha256: '7'.repeat(64),
    })).toThrow('harness_terminal_handoff_conflict');
    expect(JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id))).toBe(frozen);

    acknowledgeHarnessVerificationCleanupAlreadyGated({
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      seal: {
        schema: 'ecpe.t4-lineage-tombstone.v1',
        claim_id: input.claimId,
        resource_lineage_id: input.resourceLineageId,
        handle: input.handle,
        cleanup_authority_id: input.cleanupAuthorityId,
        tombstone_id: `tombstone-${'8'.repeat(24)}`,
        covered_generations: [0],
        root_device_id: '1', root_inode_id: '2',
        parent_device_id: '1', parent_inode_id: '3',
        owner_marker_sha256: '9'.repeat(64),
        tombstone_sha256: 'a'.repeat(64),
        owner_cleanup_event_sha256: 'b'.repeat(64),
      },
      now: new Date('2026-01-02T00:01:00.000Z'),
    });
    block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(before);
    expect(block.resource_cleanup_acks).toHaveLength(1);
    expect(inspectMilestoneForPartial({ stateRoot: f.state, roots: f.tuple })
      .next_operation).toBe('milestone_status_prepare_partial');
  });

  test('reuses a position cleanup ack after abort without creating a conflicting handoff', () => {
    const f = fixture('cleanup-ack-before-abort', 'f');
    const handle = `verify-${'1'.repeat(24)}`;
    const lineage = `lineage-${'2'.repeat(24)}`;
    const authority = 'consumption-before-abort';
    attachHarnessVerificationCheckpoint({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      governanceRoot: f.repo, registryHash: f.registry,
      expectedBase: f.head, expectedHead: f.head, verificationProofId: 'proof-before-abort',
    }, () => ({
      proof_id: 'proof-before-abort', result_id: 'result-before-abort',
      consumption_id: authority, coordinator_claim_id: f.claim.claim_id,
      handle, generation: 0 as const, resource_lineage_id: lineage,
      covered_generations: [0] as Array<0 | 1>,
    }));
    const seal = {
      schema: 'ecpe.t4-lineage-tombstone.v1' as const,
      claim_id: f.claim.claim_id, resource_lineage_id: lineage, handle,
      cleanup_authority_id: authority, tombstone_id: `tombstone-${'3'.repeat(24)}`,
      covered_generations: [0] as Array<0 | 1>,
      root_device_id: '1', root_inode_id: '2', parent_device_id: '1', parent_inode_id: '3',
      owner_marker_sha256: '4'.repeat(64), tombstone_sha256: '5'.repeat(64),
      owner_cleanup_event_sha256: '6'.repeat(64),
    };
    const first = acknowledgeHarnessVerificationCleanupAlreadyGated({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot, seal,
    });
    const slotBefore = JSON.stringify(readMilestoneBlock(f.state, f.started.block.block_id).slot);
    const stopped = stopMilestoneBlock({
      stateRoot: f.state, roots: f.tuple,
      blockId: f.started.block.block_id, reason: 'aborted',
    });
    const ready = inspectHarnessVerificationCleanup({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot,
      claimId: f.claim.claim_id, generation: 0, resourceLineageId: lineage,
      handle, cleanupAuthorityId: authority, coveredGenerations: [0],
      ownerRecordKind: 'proof_consumed', ownerRecordId: authority,
      ownerRecordSha256: '7'.repeat(64),
    });
    expect(ready.next_operation).toBe('milestone_block_inspect_for_partial');
    const reused = acknowledgeHarnessVerificationCleanupAlreadyGated({
      stateRoot: f.state, blockId: f.started.block.block_id, slotId: f.slot, seal,
    });
    expect(reused.cleanup_ack_sha256).toBe(first.cleanup_ack_sha256);
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    expect(JSON.stringify(block.slot)).toBe(slotBefore);
    expect(block.terminal_resource_handoffs).toHaveLength(0);
    expect(block.resource_cleanup_acks).toHaveLength(1);
    expect(stopped.next_operation).toBe('milestone_block_inspect_for_partial');
  });

  test('an evaluation abort records one immutable receipt and freezes the slot byte-for-byte', () => {
    const f = fixture('abort-receipt', 'c');
    const before = readMilestoneBlock(f.state, f.started.block.block_id).slot;

    const stopped = stopMilestoneBlock({
      stateRoot: f.state,
      roots: f.tuple,
      blockId: f.started.block.block_id,
      reason: 'aborted',
    });
    const block = readMilestoneBlock(f.state, f.started.block.block_id);
    const receipt = block.stop_receipt_id;

    expect(block.slot).toEqual(before);
    expect(receipt).toMatch(/^abort-[0-9a-f]{32}$/);
    expect(block).toMatchObject({
      phase: 'terminal_unreported',
      terminal_reason: 'aborted',
      terminal_kind: null,
      stop_receipt_id: receipt,
      evaluation_abort_event: {
        event_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        stop_receipt_id: receipt,
        evaluation_slot_id: f.slot,
        frozen_slot_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(stopped.block.stop_receipt_id).toBe(receipt);
    expect(stopMilestoneBlock({
      stateRoot: f.state,
      roots: f.tuple,
      blockId: f.started.block.block_id,
      reason: 'aborted',
    }).block.stop_receipt_id).toBe(receipt);
  });

  test('commits one failed-result disposition without a proof', () => {
    const f = fixture('fail', 'c');
    let calls = 0;
    const input = {
      stateRoot: f.state,
      blockId: f.started.block.block_id,
      slotId: f.slot,
      governanceRoot: f.repo,
      registryHash: f.registry,
      expectedBase: f.head,
      expectedHead: f.head,
      verificationResultId: 'result-t4',
    };
    const dispose = () => {
      calls += 1;
      return {
        result_id: 'result-t4',
        disposition_id: 'disposed-t4',
        coordinator_claim_id: f.claim.claim_id,
        failure_code: 'verification_failed',
        handle: `verify-${'3'.repeat(24)}`,
        generation: 0 as const,
        resource_lineage_id: `lineage-${'3'.repeat(24)}`,
        covered_generations: [0] as Array<0 | 1>,
      };
    };
    expect(terminalizeHarnessVerificationCheckpoint(input, dispose)).toMatchObject({
      disposition: 'terminalized',
      terminal_kind: 'safety_failure',
      proof_id: null,
    });
    expect(terminalizeHarnessVerificationCheckpoint(input, dispose)).toMatchObject({
      disposition_id: 'disposed-t4',
      result_id: 'result-t4',
    });
    expect(calls).toBe(1);
  });
});
