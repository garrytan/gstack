import { afterEach, describe, expect, test } from 'bun:test';
import { resolveEffectScope } from '../lib/effect-scope';

afterEach(() => delete process.env.ECPE_PAID_MODEL_AUTHORIZED);
describe('task-local paid model grants', () => {
  test('missing authorization and unknown validators fail closed', () => {
    expect(() => resolveEffectScope({ skill: 'review', capability: 'paid_model', validatorId: 'codex.review.v1' })).toThrow('grant_required');
    process.env.ECPE_PAID_MODEL_AUTHORIZED = '1';
    expect(() => resolveEffectScope({ skill: 'review', capability: 'paid_model', validatorId: 'caller-selected' })).toThrow('validator_id_invalid');
  });
  test('a compiled validator may receive one explicit grant', () => {
    process.env.ECPE_PAID_MODEL_AUTHORIZED = '1';
    expect(resolveEffectScope({ skill: 'review', capability: 'paid_model', validatorId: 'codex.review.v1' })[0].assertions.validatorId).toBe('codex.review.v1');
  });
});
