import { describe, expect, test } from 'bun:test';
import { adapterRegistryHash, detectGithubActionsTopology, resolveDeployOperation } from '../lib/deploy-adapter-registry';

const target = {
  id: 'production', environment_class: 'production', trigger: 'on_merge',
  binding: { adapter_id: 'github_actions.v1', workflow_database_id: '41', workflow_path: '.github/workflows/deploy.yml', environment_name: 'production', environment_database_id: '73' },
} as const;

describe('compiled deploy adapter registry', () => {
  test('uses a stable versioned registry hash and closed operation matrix', () => {
    expect(adapterRegistryHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveDeployOperation(target, 'status').supported).toBe(true);
    expect(resolveDeployOperation(target, 'dispatch').supported).toBe(false);
    expect(resolveDeployOperation(target, 'rollback').supported).toBe(false);
    expect(() => resolveDeployOperation({ ...target, binding: { ...target.binding, adapter_id: 'custom.v1' as any } }, 'status')).toThrow('deploy_adapter_unknown');
  });

  test('proves an exact on-merge branch/path/environment topology', () => {
    const workflow = `name: deploy\non:\n  push:\n    branches: [main]\n    paths: [src/**]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps: []\n`;
    const result = detectGithubActionsTopology({ workflow, target, baseBranch: 'main', changedPaths: ['src/app.ts'] });
    expect(result.state).toBe('applicable'); expect(result.projection_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(detectGithubActionsTopology({ workflow, target, baseBranch: 'dev', changedPaths: ['src/app.ts'] }).state).toBe('on_merge_trigger_not_applicable');
    expect(detectGithubActionsTopology({ workflow: workflow.replace('environment: production', 'environment: ${{ matrix.env }}'), target, baseBranch: 'main', changedPaths: ['src/app.ts'] }).state).toBe('deploy_topology_unsupported');
  });
});
