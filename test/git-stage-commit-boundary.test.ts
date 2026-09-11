import { describe, expect, test } from 'bun:test';
import { buildGitCommitPlan, buildGitStagePlan } from '../lib/git-stage-commit-boundary';

describe('exact Git stage and commit boundary', () => {
  test('freezes the full projection and disables hooks, drivers, signing, and fsmonitor', () => {
    const plan = buildGitStagePlan({ operation: 'ship.delivery', headOid: 'a'.repeat(40), indexPreimage: 'b'.repeat(64), gateId: 'gate.1', paths: ['src/b.ts', 'src/a.ts'] });
    expect(plan.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(plan.configArgs.join(' ')).toContain('core.hooksPath=/dev/null');
    expect(plan.configArgs.join(' ')).toContain('commit.gpgSign=false');
  });
  test('rejects stale/unknown scope and external attribute drivers', () => {
    expect(() => buildGitStagePlan({ operation: 'unknown', headOid: 'a'.repeat(40), indexPreimage: 'b'.repeat(64), gateId: 'g', paths: ['a'] })).toThrow('git_operation_invalid');
    expect(() => buildGitStagePlan({ operation: 'ship.delivery', headOid: 'a'.repeat(40), indexPreimage: 'b'.repeat(64), gateId: 'g', paths: ['a'], attributes: { a: 'filter=lfs' } })).toThrow('git_attribute_driver_unsupported');
    expect(() => buildGitCommitPlan('short', 'a'.repeat(40))).toThrow('git_stage_intent_invalid');
  });
});
