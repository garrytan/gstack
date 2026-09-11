import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (script: string, args: string[], cwd?: string) => spawnSync(process.execPath, [join(import.meta.dir, '..', script), ...args], { timeout: 30_000, encoding: 'utf8', cwd });

describe('authority CLI argument allowlists', () => {
  test('work-profile rejects unknown base-selection flags', () => {
    const result = run('scripts/authority/work-profile.ts', ['resolve', '--lane', 'single_repo_code', '--target-base', 'HEAD', '--json']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('work_profile_arguments_invalid');
  });
  test('execution-plan rejects unknown base-selection flags', () => {
    const result = run('scripts/authority/execution-plan.ts', ['resolve', '--skill', 'review', '--work-kind', 'review', '--finish-line', 'local_change', '--target-base', 'HEAD', '--json']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('execution_plan_arguments_invalid');
  });
  test('effect-scope rejects unrecognized flags before resolving a grant', () => {
    const result = run('scripts/authority/effect-scope.ts', ['resolve', '--skill', 'review', '--mystery', 'value', '--json']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('effect_argument_invalid');
  });
  test('provider PR discovery accepts only its read-only identity arguments', () => {
    const result = run('scripts/authority/effect-scope.ts', ['provider-pr', 'discover', '--skill', 'ship', '--title', 'spoofed', '--json']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('effect_argument_invalid');
  });
  test('provider PR mutation requires the scanner-bound body digest', () => {
    const result = run('scripts/authority/effect-scope.ts', [
      'provider-pr', 'create', '--skill', 'ship', '--provider', 'github', '--base', 'main',
      '--title', 'feat: exact', '--body-file', '/tmp/body', '--lane', 'single_repo_code',
      '--assert-target-ref', 'origin/main', '--assert-release-mode', 'none', '--assert-title-policy', 'conventional', '--json',
    ]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('effect_argument_invalid');
  });
  test('evidence rejects unrecognized legacy flags', () => {
    const result = run('bin/gstack-evidence', ['check', '--label', 'x', '--target-base', 'HEAD']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('unknown check argument');
  });
  test('evidence rejects unrecognized milestone flags as usage errors', () => {
    const outsideRegistry = mkdtempSync(join(tmpdir(), 'gstack-evidence-args-'));
    try {
      const result = run('bin/gstack-evidence', ['milestone-block', 'inspect', '--purpose', 'ecpe-v3-pilot', '--caller-path', '/tmp/forged', '--json'], outsideRegistry);
      expect(result.status).toBe(2); expect(result.stderr).toContain('evidence_arguments_invalid');
    } finally {
      rmSync(outsideRegistry, { recursive: true, force: true });
    }
  });
  test('lane-canary keeps focused-run selection pathless and requires run ownership', () => {
    const chosen = run('bin/gstack-evidence', ['lane-canary', 'focused-run', 'inspect', '--block-id', `block-${'1'.repeat(32)}`, '--participant', 'portfolioops', '--lane', 'single_repo_code', '--focused-run-id', `focused-${'2'.repeat(32)}`, '--json']);
    expect(chosen.status).toBe(2); expect(chosen.stderr).toContain('lane_canary_arguments_invalid');
    const missing = run('bin/gstack-evidence', ['lane-canary', 'run', '--block-id', `block-${'1'.repeat(32)}`, '--participant', 'portfolioops', '--lane', 'single_repo_code', '--json']);
    expect(missing.status).toBe(2); expect(missing.stderr).toContain('lane_canary_arguments_invalid');
  });
});
