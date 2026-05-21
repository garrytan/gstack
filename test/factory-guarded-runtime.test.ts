import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  FactoryCommandGuardBlockedError,
  createFactoryGuardedCommandRuntime,
  sanitizeFactoryGuardDecisionForAudit,
  withSafeCommandGuardCapability,
  type FactoryGuardedCommandDecisionObservation,
} from '../lib/factory-guarded-runtime';
import type { FactoryCommandGuardDecision, FactoryCommandGuardRequest } from '../lib/factory-command-guard';

function request(command: string): FactoryCommandGuardRequest {
  return {
    command,
    cwd: '/repo',
    workspaceRoot: '/repo',
    profile: 'non-destructive-write',
    context: { workflowId: 'qa-fix', phaseId: 'qa-execution', runId: 'run-1' },
  };
}

describe('factory guarded runtime', () => {
  test('does not execute denied commands when guard is active', async () => {
    const executed: string[] = [];
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      executeCommand(input) {
        executed.push(input.command);
        return 'executed';
      },
    });

    await expect(runtime.executeCommand(request('rm -rf dist'))).rejects.toBeInstanceOf(FactoryCommandGuardBlockedError);
    expect(executed).toEqual([]);
  });

  test('fails closed and does not execute when command classification throws', async () => {
    const executed: string[] = [];
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      evaluateCommandSafety() {
        throw new Error('classifier blew up');
      },
      executeCommand(input) {
        executed.push(input.command);
        return 'executed';
      },
    });

    let blocked: unknown;
    try {
      await runtime.executeCommand(request('git status'));
    } catch (error) {
      blocked = error;
    }

    expect(blocked).toBeInstanceOf(FactoryCommandGuardBlockedError);
    expect((blocked as FactoryCommandGuardBlockedError).decision).toMatchObject({
      allowed: false,
      matchedRuleId: 'guard-evaluation-error',
    });
    expect(executed).toEqual([]);
  });

  test('executes allowed commands and returns guard decision metadata', async () => {
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      executeCommand() {
        return 'ok';
      },
    });

    const result = await runtime.executeCommand(request('bun test test/factory-command-guard.test.ts'));
    expect(result.result).toBe('ok');
    expect(result.decision).toMatchObject({ allowed: true, matchedRuleId: 'project-check' });
  });

  test('invokes onCommandDecision for allowed commands with sanitized audit shape', async () => {
    const observed: FactoryGuardedCommandDecisionObservation[] = [];
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      executeCommand: () => 'ok',
      onCommandDecision(observation) {
        observed.push(observation);
      },
    });

    await runtime.executeCommand(request('bun test test/factory-command-guard.test.ts'));

    expect(observed).toHaveLength(1);
    expect(observed[0].decision.allowed).toBe(true);
    expect(observed[0].sanitized).toMatchObject({
      allowed: true,
      severity: 'allow',
      matchedRuleId: 'project-check',
      commandHead: 'bun',
    });
    expect(observed[0].sanitized.commandDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.values(observed[0].sanitized)).not.toContain('bun test test/factory-command-guard.test.ts');
  });

  test('invokes onCommandDecision before throwing for blocked commands', async () => {
    const observed: FactoryGuardedCommandDecisionObservation[] = [];
    const executed: string[] = [];
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      executeCommand(input) {
        executed.push(input.command);
        return 'executed';
      },
      onCommandDecision(observation) {
        observed.push(observation);
      },
    });

    await expect(runtime.executeCommand(request('rm -rf dist'))).rejects.toBeInstanceOf(FactoryCommandGuardBlockedError);

    expect(executed).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(observed[0].sanitized).toMatchObject({
      allowed: false,
      severity: 'block',
      matchedRuleId: 'rm-recursive-force',
      commandHead: 'rm',
    });
    expect(observed[0].sanitized.commandDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test('invokes onCommandDecision with guard-inactive-pass-through when guard is off', async () => {
    const observed: FactoryGuardedCommandDecisionObservation[] = [];
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: false,
      executeCommand: () => 'ok',
      onCommandDecision(observation) {
        observed.push(observation);
      },
    });

    await runtime.executeCommand(request('any thing here'));

    expect(observed).toHaveLength(1);
    expect(observed[0].decision.matchedRuleId).toBe('guard-inactive-pass-through');
    expect(observed[0].sanitized).toMatchObject({
      allowed: true,
      matchedRuleId: 'guard-inactive-pass-through',
      commandHead: 'any',
    });
  });

  test('swallows onCommandDecision errors so audit emission cannot change guard outcome', async () => {
    const runtime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      executeCommand: () => 'ok',
      onCommandDecision() {
        throw new Error('audit sink unavailable');
      },
    });

    const allow = await runtime.executeCommand(request('git status'));
    expect(allow.result).toBe('ok');
    expect(allow.decision.allowed).toBe(true);

    await expect(runtime.executeCommand(request('rm -rf dist'))).rejects.toBeInstanceOf(FactoryCommandGuardBlockedError);
  });

  test('sanitizeFactoryGuardDecisionForAudit hashes the command and redacts the tail', () => {
    const decision: FactoryCommandGuardDecision = {
      allowed: false,
      severity: 'block',
      reason: 'cat .env is denied',
      matchedRuleId: 'secret-path',
      normalizedCommand: 'cat .env.production SECRET_TOKEN=abc123',
    };

    const sanitized = sanitizeFactoryGuardDecisionForAudit(decision);

    expect(sanitized.allowed).toBe(false);
    expect(sanitized.severity).toBe('block');
    expect(sanitized.matchedRuleId).toBe('secret-path');
    expect(sanitized.commandHead).toBe('cat');
    expect(sanitized.commandDigest).toBe(createHash('sha256').update(decision.normalizedCommand).digest('hex').slice(0, 16));
    expect((sanitized as Record<string, unknown>).normalizedCommand).toBeUndefined();
    for (const value of Object.values(sanitized)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toContain('SECRET_TOKEN');
      expect(value).not.toContain('abc123');
      expect(value).not.toContain('.env.production');
    }
  });

  test('sanitizeFactoryGuardDecisionForAudit reduces path-style executables to a basename head', () => {
    const sanitized = sanitizeFactoryGuardDecisionForAudit({
      allowed: false,
      severity: 'block',
      reason: 'untrusted executable path',
      matchedRuleId: 'untrusted-executable-path',
      normalizedCommand: '/tmp/evil-helper --do-stuff',
    });
    expect(sanitized.commandHead).toBe('evil-helper');
  });

  test('advertises safe-command-guard capability only when wrapper is active', () => {
    const activeRuntime = createFactoryGuardedCommandRuntime({
      guardActive: true,
      baseCapabilities: ['artifact-store', 'filesystem', 'git', 'test-runner'],
      executeCommand: () => 'ok',
    });
    expect(activeRuntime.availableCapabilities).toContain('safe-command-guard');

    const inactiveRuntime = createFactoryGuardedCommandRuntime({
      guardActive: false,
      baseCapabilities: ['artifact-store', 'safe-command-guard'],
      executeCommand: () => 'ok',
    });
    expect(inactiveRuntime.availableCapabilities).toEqual(['artifact-store']);

    expect(withSafeCommandGuardCapability(['artifact-store', 'git'], true)).toContain('safe-command-guard');
    expect(withSafeCommandGuardCapability(['artifact-store', 'safe-command-guard'], false)).toEqual(['artifact-store']);
  });
});
