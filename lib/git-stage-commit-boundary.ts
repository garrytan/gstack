import { canonicalAssertionPath, validateFullOid } from './effect-scope';

export type GitMutationOperation =
  | 'ship.delivery' | 'ship.base_sync' | 'rollback.revert_pr'
  | 'implementation.checkpoint' | 'governance.t4_cutover' | 'recording.closeout';

const OPERATIONS = new Set<GitMutationOperation>([
  'ship.delivery', 'ship.base_sync', 'rollback.revert_pr',
  'implementation.checkpoint', 'governance.t4_cutover', 'recording.closeout',
]);
const SHA256 = /^[0-9a-f]{64}$/;

export interface GitStagePlan {
  operation: GitMutationOperation;
  headOid: string;
  indexPreimage: string;
  gateId: string;
  paths: readonly string[];
  environment: Readonly<Record<string, string>>;
  configArgs: readonly string[];
}

export function buildGitStagePlan(input: {
  operation: string; headOid: string; indexPreimage: string; gateId: string; paths: string[];
  attributes?: Record<string, string>;
}): GitStagePlan {
  if (!OPERATIONS.has(input.operation as GitMutationOperation)) throw new Error('git_operation_invalid');
  const paths = [...new Set(input.paths.map(canonicalAssertionPath))].sort();
  if (!paths.length || paths.length !== input.paths.length) throw new Error('git_stage_projection_invalid');
  if (!SHA256.test(input.indexPreimage) || !/^[A-Za-z0-9._:-]+$/.test(input.gateId)) throw new Error('git_stage_assertion_invalid');
  for (const value of Object.values(input.attributes ?? {})) {
    if (/\b(filter|merge|diff)\b|^(?!unset$|unspecified$|set$)/i.test(value)) throw new Error('git_attribute_driver_unsupported');
  }
  return Object.freeze({
    operation: input.operation as GitMutationOperation,
    headOid: validateFullOid(input.headOid), indexPreimage: input.indexPreimage,
    gateId: input.gateId, paths: Object.freeze(paths),
    environment: Object.freeze({ GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_CONFIG_NOSYSTEM: '1' }),
    configArgs: Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false']),
  });
}

export function buildGitCommitPlan(stageIntent: string, treeOid: string): { stageIntent: string; treeOid: string } {
  if (!/^[0-9a-f]{64}$/.test(stageIntent)) throw new Error('git_stage_intent_invalid');
  return Object.freeze({ stageIntent, treeOid: validateFullOid(treeOid) });
}
