import { parseStrictYaml } from './strict-yaml';

export const DEPLOY_ADAPTER_REGISTRY = Object.freeze({
  schema: 'ecpe.deploy-adapter-registry.v1',
  adapters: {
    'github_actions.v1': { trigger: 'on_merge', operations: { preflight: true, status: true, canary: true, dispatch: false, rollback: false } },
    'none.v1': { trigger: 'none', operations: { preflight: false, status: false, canary: false, dispatch: false, rollback: false } },
  },
  health_targets: {},
});
export type DeployOperation = 'preflight' | 'status' | 'canary' | 'dispatch' | 'rollback';
type Target = { id: string; trigger: string; environment_class: string; binding: Record<string, any> };
function stable(value: unknown): unknown { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as any).sort().map((key) => [key, stable((value as any)[key])])); return value; }
function hash(value: unknown): string { return new Bun.CryptoHasher('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
export function adapterRegistryHash(): string { return hash(DEPLOY_ADAPTER_REGISTRY); }

export function resolveDeployOperation(target: Target, operation: DeployOperation) {
  const adapterId = target.binding.adapter_id as keyof typeof DEPLOY_ADAPTER_REGISTRY.adapters;
  const adapter = DEPLOY_ADAPTER_REGISTRY.adapters[adapterId];
  if (!adapter) throw new Error('deploy_adapter_unknown');
  if (adapter.trigger !== target.trigger) throw new Error('deploy_binding_mismatch');
  return { adapter_id: adapterId, operation, supported: adapter.operations[operation], dispatch_count: 0, adapter_registry_hash: adapterRegistryHash(), binding_hash: hash(target.binding) };
}
function list(value: unknown): string[] { if (typeof value === 'string') return [value]; if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value; throw new Error('deploy_topology_unsupported'); }
function anyMatch(patterns: string[], value: string): boolean { return patterns.some((pattern) => { if (pattern.includes('${{')) throw new Error('deploy_topology_unsupported'); return new Bun.Glob(pattern).match(value); }); }

export function detectGithubActionsTopology(input: { workflow: string; target: Target; baseBranch: string; changedPaths: string[] }) {
  try {
    if (input.target.binding.adapter_id !== 'github_actions.v1' || input.target.trigger !== 'on_merge') throw new Error('deploy_binding_mismatch');
    const root = parseStrictYaml(input.workflow) as Record<string, any>;
    const push = root.on?.push;
    if (!push || typeof push !== 'object' || Array.isArray(push)) throw new Error('deploy_topology_unsupported');
    const branches = push.branches === undefined ? ['**'] : list(push.branches);
    const branchesIgnore = push['branches-ignore'] === undefined ? [] : list(push['branches-ignore']);
    const paths = push.paths === undefined ? ['**'] : list(push.paths);
    const pathsIgnore = push['paths-ignore'] === undefined ? [] : list(push['paths-ignore']);
    const branchApplicable = anyMatch(branches, input.baseBranch) && !anyMatch(branchesIgnore, input.baseBranch);
    const pathApplicable = input.changedPaths.some((file) => anyMatch(paths, file) && !anyMatch(pathsIgnore, file));
    if (!branchApplicable || !pathApplicable) return { state: 'on_merge_trigger_not_applicable' as const, projection_hash: hash({ branches, branchesIgnore, paths, pathsIgnore, base: input.baseBranch, changed: [...input.changedPaths].sort() }) };
    const jobs = root.jobs;
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error('deploy_topology_unsupported');
    const reachable = Object.values(jobs).some((raw) => {
      const job = raw as Record<string, any>; if (!job || typeof job !== 'object' || typeof job.environment === 'object') return false;
      if (typeof job.if === 'string' && job.if.includes('${{')) return false;
      return job.environment === input.target.binding.environment_name;
    });
    if (!reachable) return { state: 'deploy_topology_unsupported' as const, projection_hash: hash({ jobs: stable(jobs) }) };
    const projection = { workflow_path: input.target.binding.workflow_path, environment_name: input.target.binding.environment_name, base_branch: input.baseBranch, changed_paths: [...input.changedPaths].sort(), branches, branches_ignore: branchesIgnore, paths, paths_ignore: pathsIgnore };
    return { state: 'applicable' as const, projection, projection_hash: hash(projection), adapter_registry_hash: adapterRegistryHash() };
  } catch (error) {
    if (error instanceof Error && ['deploy_binding_mismatch', 'deploy_topology_unsupported'].includes(error.message)) return { state: error.message as 'deploy_binding_mismatch' | 'deploy_topology_unsupported', projection_hash: hash({ state: error.message }) };
    return { state: 'deploy_topology_unsupported' as const, projection_hash: hash({ state: 'parse_failed' }) };
  }
}
