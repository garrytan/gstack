import { describe, expect, test } from 'bun:test';
import {
  FactoryCommandGuardBlockedError,
  createFactoryGuardedCommandRuntime,
  withSafeCommandGuardCapability,
} from '../lib/factory-guarded-runtime';
import type { FactoryCommandGuardRequest } from '../lib/factory-command-guard';

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
