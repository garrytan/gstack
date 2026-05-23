import { describe, expect, test } from 'bun:test';
import type { FactoryCommandGuardDecision, FactoryCommandGuardRequest } from '../lib/factory-command-guard';
import type { FactoryFileWriteDecision, FactoryFileWriteRequest } from '../lib/factory-file-write-guard';
import {
  createFactoryGuardDenialArtifactDto,
  createFactoryGuardDenialEventDto,
  sanitizeFactoryCommandDenial,
  sanitizeFactoryFileWriteDenial,
} from '../lib/factory-guard-denial';

function commandRequest(command: string, runId = 'run-1'): FactoryCommandGuardRequest {
  return {
    command,
    cwd: '/repo',
    workspaceRoot: '/repo',
    profile: 'non-destructive-write',
    context: { workflowId: 'qa-fix', phaseId: 'qa-execution', runId },
  };
}

function commandDecision(ruleId: string, normalizedCommand: string): FactoryCommandGuardDecision {
  return {
    allowed: false,
    severity: 'block',
    reason: 'Command is not allowed by guarded policy.',
    matchedRuleId: ruleId,
    normalizedCommand,
  };
}

function writeRequest(target: string, runId = 'run-1'): FactoryFileWriteRequest {
  return {
    absolutePath: target,
    workspaceRoot: '/repo',
    profile: 'non-destructive-write',
    intent: 'edit-existing',
    targetExists: true,
    oldContentMatched: true,
    context: { workflowId: 'qa-fix', phaseId: 'qa-execution', runId },
  };
}

function writeDecision(ruleId: string, normalizedPath: string): FactoryFileWriteDecision {
  return {
    allowed: false,
    severity: 'block',
    reason: 'File write target is not allowed by guarded policy.',
    matchedRuleId: ruleId,
    normalizedPath,
  };
}

describe('factory guard denial DTOs', () => {
  test('normalizes command denials into digest/head-only records without raw command leakage', () => {
    const raw = '  git   push --force origin/main   GH_TOKEN=super-secret-value  ';
    const decision = commandDecision('git-push-blocked', 'git push --force origin/main GH_TOKEN=super-secret-value');

    const denial = sanitizeFactoryCommandDenial({ request: commandRequest(raw), decision });

    expect(denial).toMatchObject({
      kind: 'command',
      allowed: false,
      severity: 'block',
      category: 'release-mutation',
      profile: 'non-destructive-write',
      commandHead: 'git',
    });
    expect(denial.commandDigest).toMatch(/^[a-f0-9]{16}$/);
    expect(denial.correlationDigest).toBe(denial.commandDigest);

    expect(denial.reason).toBe('Guard denied by policy.');

    const serialized = JSON.stringify(denial);
    expect(serialized).not.toContain('git push --force origin/main');
    expect(serialized).not.toContain('--force');
    expect(serialized).not.toContain('GH_TOKEN');
    expect(serialized).not.toContain('super-secret-value');
  });

  test('redacts static blocked-command text from public command denial reasons', () => {
    const denial = sanitizeFactoryCommandDenial({
      request: commandRequest('git reset --hard'),
      decision: {
        ...commandDecision('git-reset-hard', 'git reset --hard'),
        reason: 'git reset --hard is not allowed.',
      },
    });

    expect(denial.reason).toBe('Guard denied by policy.');
    const serialized = JSON.stringify(denial);
    expect(serialized).not.toContain('reset --hard');
    expect(serialized).not.toContain('git reset');
  });

  test('normalizes path denials with deterministic digest and secret basename redaction', () => {
    const request = writeRequest('/repo/.env.production');
    const decision = {
      ...writeDecision('secret-path', '/repo/.env.production'),
      reason: 'Attempted write to .env.production was denied.',
    };

    const denial = sanitizeFactoryFileWriteDenial({ request, decision });

    expect(denial).toMatchObject({
      kind: 'path',
      allowed: false,
      severity: 'block',
      category: 'secret-protection',
      profile: 'non-destructive-write',
      intent: 'edit-existing',
      pathBasename: '[redacted]',
    });
    expect(denial.pathDigest).toMatch(/^[a-f0-9]{16}$/);
    expect(denial.correlationDigest).toBe(denial.pathDigest);
    expect(denial.reason).toBe('Guard denied by policy.');

    const serialized = JSON.stringify(denial);
    expect(serialized).not.toContain('/repo/.env.production');
    expect(serialized).not.toContain('.env.production');
  });

  test('redacts benign-looking basenames below secret directories', () => {
    const denial = sanitizeFactoryFileWriteDenial({
      request: writeRequest('/repo/.ssh/config'),
      decision: writeDecision('secret-path', '/repo/.ssh/config'),
    });

    expect(denial.pathBasename).toBe('[redacted]');
    const serialized = JSON.stringify(denial);
    expect(serialized).not.toContain('/repo/.ssh/config');
    expect(serialized).not.toContain('.ssh');
    expect(serialized).not.toContain('config');
  });

  test('correlation digest is deterministic for equal inputs and scoped to context', () => {
    const requestA = commandRequest('rm -rf dist', 'run-1');
    const requestB = commandRequest('rm -rf dist', 'run-1');
    const requestC = commandRequest('rm -rf dist', 'run-2');
    const decision = commandDecision('rm-recursive-force', 'rm -rf dist');

    const a = sanitizeFactoryCommandDenial({ request: requestA, decision });
    const b = sanitizeFactoryCommandDenial({ request: requestB, decision });
    const c = sanitizeFactoryCommandDenial({ request: requestC, decision });

    expect(a.commandDigest).toBe(b.commandDigest);
    expect(a.commandDigest).not.toBe(c.commandDigest);
  });

  test('uses opaque default category for unknown or missing rule ids', () => {
    expect(sanitizeFactoryCommandDenial({
      request: commandRequest('unknown thing'),
      decision: { ...commandDecision('unknown-new-rule', 'unknown thing'), matchedRuleId: 'unknown-new-rule' },
    }).category).toBe('opaque');

    expect(sanitizeFactoryFileWriteDenial({
      request: writeRequest('/repo/lib/example.ts'),
      decision: { ...writeDecision('mystery-rule', '/repo/lib/example.ts'), matchedRuleId: undefined },
    }).category).toBe('opaque');
  });

  test('builds public denial artifact/event DTOs safe for cockpit rendering', () => {
    const command = sanitizeFactoryCommandDenial({
      request: commandRequest('git push --force origin/main GH_TOKEN=super-secret-value'),
      decision: commandDecision('git-push-blocked', 'git push --force origin/main GH_TOKEN=super-secret-value'),
    });
    const path = sanitizeFactoryFileWriteDenial({
      request: writeRequest('/repo/.env.production'),
      decision: writeDecision('secret-path', '/repo/.env.production'),
    });

    const event = createFactoryGuardDenialEventDto({
      runId: 'run-1',
      phaseId: 'qa-execution',
      workflowId: 'qa-fix',
      denial: command,
      occurredAt: '2026-01-01T00:00:00.000Z',
    });

    const artifact = createFactoryGuardDenialArtifactDto({
      runId: 'run-1',
      phaseId: 'qa-execution',
      workflowId: 'qa-fix',
      createdAt: '2026-01-01T00:00:00.000Z',
      denials: [command, path],
    });

    expect(event).toMatchObject({
      schemaVersion: 'factory.guard-denial.v1',
      type: 'factory.guard.denial',
      runId: 'run-1',
      phaseId: 'qa-execution',
      workflowId: 'qa-fix',
      denial: {
        category: 'release-mutation',
        profile: 'non-destructive-write',
      },
    });

    expect(artifact).toMatchObject({
      schemaVersion: 'factory.guard-denial.v1',
      runId: 'run-1',
      phaseId: 'qa-execution',
      workflowId: 'qa-fix',
      summary: {
        total: 2,
        blocked: 2,
      },
    });
    expect(artifact.summary.categories.map(entry => entry.category)).toEqual(['release-mutation', 'secret-protection']);

    const serialized = `${JSON.stringify(event)}\n${JSON.stringify(artifact)}`;
    expect(serialized).not.toContain('git push --force origin/main');
    expect(serialized).not.toContain('/repo/.env.production');
    expect(serialized).not.toContain('GH_TOKEN');
    expect(serialized).not.toContain('super-secret-value');
  });
});
