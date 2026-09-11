import { describe, expect, test } from 'bun:test';
import { ProcessLocalGrant, resolveEffectScope } from '../lib/effect-scope';

describe('closed workflow effect scope', () => {
  test('document release cannot mint an unbound transferable paths-only grant', () => {
    expect(() => resolveEffectScope({ skill: 'ship', capability: 'document_release', paths: ['README.md'] }))
      .toThrow('effect_closed_adapter_required');
  });
  test('default review is read-only and setup writes only operations docs', () => {
    expect(resolveEffectScope({ skill: 'review' })).toEqual([]);
    expect(resolveEffectScope({ skill: 'setup-deploy' })[0].assertions.paths).toEqual(['docs/OPERATIONS.md']);
  });
  test('exact provider and deploy assertions are mandatory', () => {
    expect(() => resolveEffectScope({ skill: 'land-and-deploy', capability: 'merge' })).toThrow('effect_land_assertion_invalid');
    expect(resolveEffectScope({ skill: 'land-and-deploy', capability: 'deploy', pr: 7, mode: 'merge-and-deploy', environment: 'production' })[0].assertions).toEqual({ pr: 7, mode: 'merge-and-deploy', environment: 'production' });
  });
  test('grants are task-local and one-use', () => {
    const local = new ProcessLocalGrant(resolveEffectScope({ skill: 'review', capability: 'external_reply', pr: 4, commentId: 'c_9' })[0]);
    expect(local.consume('external_reply').capability).toBe('external_reply');
    expect(() => local.consume('external_reply')).toThrow('effect_grant_replayed');
  });
  test('binds land effects to the sole trusted target and provider environment ID', () => {
    const target = { id: 'production', environment_class: 'production', trigger: 'on_merge', binding: { adapter_id: 'github_actions.v1', workflow_database_id: '41', workflow_path: '.github/workflows/deploy.yml', environment_name: 'production', environment_database_id: '73' } } as const;
    const grant = resolveEffectScope({ skill: 'land-and-deploy', capability: 'deploy', pr: 7, mode: 'merge-and-deploy', environment: '73', trustedDeployTarget: target })[0];
    expect(grant.assertions.target_id).toBe('production'); expect(grant.assertions.environment).toBe('73'); expect(grant.assertions.binding_hash).toMatch(/^[0-9a-f]{64}$/); expect(grant.assertions.adapter_registry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => resolveEffectScope({ skill: 'land-and-deploy', capability: 'deploy', pr: 7, mode: 'merge-and-deploy', environment: 'production', trustedDeployTarget: target })).toThrow('effect_environment_mismatch');
    expect(() => resolveEffectScope({ skill: 'land-and-deploy', capability: 'merge', pr: 7, mode: 'merge-and-deploy', trustedDeployTarget: { id: 'none', environment_class: 'none', trigger: 'none', binding: { adapter_id: 'none.v1' } } })).toThrow('deploy_binding_mismatch');
  });
  test('rechecks semantic declaration completeness at the effect boundary', () => {
    expect(() => resolveEffectScope({ skill: 'land-and-deploy', capability: 'merge', pr: 7, mode: 'merge-only', classificationState: 'semantic_declaration_required' })).toThrow('semantic_declaration_required');
    expect(() => resolveEffectScope({ skill: 'land-and-deploy', capability: 'deploy', pr: 7, mode: 'merge-and-deploy', environment: '73', classificationState: 'semantic_declaration_required' })).toThrow('semantic_declaration_required');
  });
  test('blocks unresolved candidate policy changes at the land effect boundary', () => {
    expect(() => resolveEffectScope({ skill: 'land-and-deploy', capability: 'merge', pr: 7, mode: 'merge-only', candidatePolicyState: 'ignored_untrusted' })).toThrow('candidate_policy_unresolved');
  });
});
