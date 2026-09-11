import { parseStrictYaml } from './strict-yaml';

export const WORK_PROFILE_SCHEMA = 'harness.gstack.work-profile.v1' as const;
export const WORK_PROFILE_POLICY_VERSION = 'work-profile-policy.v1' as const;
export const DEPLOY_ADAPTER_REGISTRY_VERSION = 'deploy-adapter-registry.v1' as const;
export const SEMANTIC_ROLES = ['docs', 'code', 'contract', 'schema', 'prompt', 'auth', 'ui', 'runtime', 'data', 'release_metadata'] as const;
export const LANES = ['docs_ux', 'single_repo_code', 'cross_repo_contract'] as const;
export const FINISH_LINES = ['response', 'artifact', 'local_change', 'review_receipt', 'pr_open', 'merged', 'deployed', 'verified', 'operation_result'] as const;
export type SemanticRole = typeof SEMANTIC_ROLES[number];
export type Lane = typeof LANES[number];
export type FinishLine = typeof FINISH_LINES[number];
export type Activation = 'legacy' | 'shadow' | 'enforce';

type Dict = Record<string, unknown>;

export interface WorkProfile {
  schema_version: typeof WORK_PROFILE_SCHEMA;
  semantic_paths: Array<{ glob: string; roles: SemanticRole[] }>;
  prose_only_surfaces?: string[];
  dependency_surfaces?: Array<{ glob: string; dependency_ids: string[]; capability_ids: string[] }>;
  capabilities: Record<string, { version: string }>;
  validators: Record<string, {
    capability: string;
    provides?: string[];
    execution_effect: 'read' | 'paid_model';
    argv?: string[];
    compiled_adapter?: { kind: 'artifact_equivalence'; consumer_paths: string[]; dependency_artifacts: Array<{ dependency_id: string; path: string }> };
    required_by_surface: SemanticRole[];
    depends_on: SemanticRole[];
    dependency_ids?: string[];
    lockfiles?: string[];
    tools?: Array<{ id: string; argv: string[] }>;
    environment_class?: string;
    ttl?: string;
    suite_id?: string;
    evaluator_id?: string;
    model_id?: string;
    runtime_id?: string;
    runtime_binding?: { mode: 'argv0' } | { mode: 'env'; name: string };
  }>;
  runtimes?: Record<string, Dict>;
  dependencies?: Record<string, Dict>;
  lanes: Record<Lane, { activation: Activation; required_capabilities: string[]; stage_requirements: Partial<Record<FinishLine, string[]>> }>;
  release: Dict;
  metadata_projections: Dict[];
  deploy_targets: Record<string, Dict>;
  recording: Record<FinishLine, 'response' | 'receipt' | 'session' | 'release'>;
}

export interface ParsedWorkProfile extends WorkProfile {
  semantic_policy_hash: string;
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const DURATION = /^(\d+)(s|m|h|d)$/;
const ROLE_SET = new Set<string>(SEMANTIC_ROLES);
const FINISH_SET = new Set<string>(FINISH_LINES);
const ACTIVATION_SET = new Set(['legacy', 'shadow', 'enforce']);

function fail(code: string): never { throw new Error(code); }
function object(value: unknown, code: string): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Dict;
}
function keys(value: Dict, allowed: readonly string[], code = 'work_profile_unknown_key'): void {
  const valid = new Set(allowed);
  for (const key of Object.keys(value)) if (!valid.has(key)) fail(`${code}:${key}`);
}
function string(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) fail(code);
  return value;
}
function id(value: unknown, code: string): string {
  const result = string(value, code);
  if (!ID.test(result)) fail(code);
  return result;
}
function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) fail(code);
  return value;
}
function uniqueSorted(values: string[], code: string): string[] {
  const result = [...new Set(values)].sort();
  if (result.length !== values.length && code !== 'semantic_role_duplicate') fail(code);
  return result;
}
function repoPath(value: unknown, allowGlob = false): string {
  const raw = string(value, 'work_profile_path_invalid').replaceAll('\\', '/');
  if (raw.startsWith('/') || raw.includes('\0') || raw.split('/').includes('..') || raw === '.' || raw.startsWith('./')) fail('work_profile_path_invalid');
  if (!allowGlob && /[*?\[\]{}]/.test(raw)) fail('work_profile_path_invalid');
  return raw;
}
function roleList(value: unknown): SemanticRole[] {
  const roles = array(value, 'semantic_roles_invalid').map((item) => string(item, 'semantic_role_invalid'));
  if (!roles.length || roles.some((role) => !ROLE_SET.has(role))) fail('semantic_role_invalid');
  return uniqueSorted(roles, 'semantic_role_duplicate') as SemanticRole[];
}
function idList(value: unknown, code: string): string[] {
  return uniqueSorted(array(value, code).map((item) => id(item, code)), `${code}_duplicate`);
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const output = Object.create(null) as Dict;
    for (const key of Object.keys(value as Dict).sort()) output[key] = stable((value as Dict)[key]);
    return output;
  }
  return value;
}
export function canonicalProfileJson(value: unknown): string { return JSON.stringify(stable(value)); }
function sha256(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(canonicalProfileJson(value)).digest('hex');
}
function normalizeProjection(value: unknown, releaseTarget = false): Dict {
  const row = object(value, 'metadata_projection_invalid');
  keys(row, releaseTarget ? ['path', 'format', 'selector', 'value_encoding'] : ['path', 'format', 'selector']);
  const format = string(row.format, 'metadata_format_invalid');
  const selector = string(row.selector, 'metadata_selector_invalid');
  const file = repoPath(row.path);
  if (!['plain_text', 'json', 'toml'].includes(format)) fail('metadata_format_invalid');
  if (format === 'plain_text' && selector !== 'whole_file') fail('metadata_selector_invalid');
  if (format === 'json' && !['/version', '/packages//version'].includes(selector)) fail('metadata_selector_invalid');
  if (format === 'toml' && selector !== '/project/version') fail('metadata_selector_invalid');
  if (selector === 'whole_file' && !['VERSION', 'CHANGELOG.md'].includes(file)) fail('metadata_whole_file_forbidden');
  const normalized: Dict = { path: file, format, selector };
  if (releaseTarget) {
    const encoding = string(row.value_encoding, 'release_encoding_invalid');
    if (!['exact', 'npm_semver'].includes(encoding)) fail('release_encoding_invalid');
    normalized.value_encoding = encoding;
  }
  return normalized;
}

function normalizeValidator(name: string, value: unknown, capabilities: Set<string>): WorkProfile['validators'][string] {
  const row = object(value, 'validator_invalid');
  keys(row, ['capability', 'provides', 'execution_effect', 'argv', 'compiled_adapter', 'required_by_surface', 'depends_on', 'dependency_ids', 'lockfiles', 'tools', 'environment_class', 'ttl', 'suite_id', 'evaluator_id', 'model_id', 'runtime_id', 'runtime_binding']);
  const capability = id(row.capability, 'validator_capability_invalid');
  if (!capabilities.has(capability)) fail('validator_capability_unknown');
  const provides = row.provides === undefined ? undefined : idList(row.provides, 'validator_provides_invalid');
  if (provides?.some((item) => item === capability || !capabilities.has(item))) fail('validator_provides_invalid');
  const effect = string(row.execution_effect, 'validator_effect_invalid');
  if (!['read', 'paid_model'].includes(effect)) fail('validator_effect_invalid');
  if ((row.argv === undefined) === (row.compiled_adapter === undefined)) fail('validator_execution_union_invalid');
  let argv: string[] | undefined;
  if (row.argv !== undefined) {
    argv = array(row.argv, 'validator_argv_invalid').map((token) => string(token, 'validator_argv_invalid'));
    if (!argv.length || argv.some((token) => /[\0\r\n]/.test(token)) || ['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(argv[0]) || argv.some((token) => ['-c', '-lc'].includes(token))) fail('validator_shell_forbidden');
  }
  let compiled_adapter: WorkProfile['validators'][string]['compiled_adapter'];
  if (row.compiled_adapter !== undefined) {
    const adapter = object(row.compiled_adapter, 'compiled_adapter_invalid');
    keys(adapter, ['kind', 'consumer_paths', 'dependency_artifacts']);
    if (adapter.kind !== 'artifact_equivalence') fail('compiled_adapter_invalid');
    const consumerPaths = uniqueSorted(array(adapter.consumer_paths, 'compiled_adapter_invalid').map((item) => repoPath(item)), 'compiled_adapter_duplicate');
    const artifacts = array(adapter.dependency_artifacts, 'compiled_adapter_invalid').map((item) => {
      const artifact = object(item, 'compiled_adapter_invalid'); keys(artifact, ['dependency_id', 'path']);
      return { dependency_id: id(artifact.dependency_id, 'compiled_adapter_invalid'), path: repoPath(artifact.path) };
    });
    if (consumerPaths.length + artifacts.length < 3) fail('compiled_adapter_surface_minimum');
    compiled_adapter = { kind: 'artifact_equivalence', consumer_paths: consumerPaths, dependency_artifacts: artifacts };
  }
  const normalized: WorkProfile['validators'][string] = {
    capability,
    ...(provides ? { provides } : {}),
    execution_effect: effect as 'read' | 'paid_model',
    ...(argv ? { argv } : {}),
    ...(compiled_adapter ? { compiled_adapter } : {}),
    required_by_surface: roleList(row.required_by_surface),
    depends_on: roleList(row.depends_on),
  };
  for (const field of ['environment_class', 'suite_id', 'evaluator_id', 'model_id', 'runtime_id'] as const) {
    if (row[field] !== undefined) normalized[field] = id(row[field], `validator_${field}_invalid`);
  }
  if (row.ttl !== undefined) {
    const ttl = string(row.ttl, 'validator_ttl_invalid'); if (!DURATION.test(ttl)) fail('validator_ttl_invalid'); normalized.ttl = ttl;
  }
  if (row.dependency_ids !== undefined) normalized.dependency_ids = idList(row.dependency_ids, 'validator_dependencies_invalid');
  if (row.lockfiles !== undefined) normalized.lockfiles = uniqueSorted(array(row.lockfiles, 'validator_lockfiles_invalid').map((item) => repoPath(item)), 'validator_lockfiles_duplicate');
  if (row.runtime_binding !== undefined) {
    const binding = object(row.runtime_binding, 'runtime_binding_invalid');
    if (binding.mode === 'argv0') { keys(binding, ['mode']); if (argv?.[0] !== 'python') fail('runtime_binding_argv0_invalid'); normalized.runtime_binding = { mode: 'argv0' }; }
    else if (binding.mode === 'env') { keys(binding, ['mode', 'name']); const nameValue = string(binding.name, 'runtime_binding_env_invalid'); if (!/^(?:PYTHON_BIN|[A-Z][A-Z0-9_]*_PYTHON_BIN)$/.test(nameValue)) fail('runtime_binding_env_invalid'); normalized.runtime_binding = { mode: 'env', name: nameValue }; }
    else fail('runtime_binding_invalid');
  }
  if (row.tools !== undefined) normalized.tools = array(row.tools, 'validator_tools_invalid').map((item) => { const tool = object(item, 'validator_tool_invalid'); keys(tool, ['id', 'argv']); return { id: id(tool.id, 'validator_tool_invalid'), argv: array(tool.argv, 'validator_tool_invalid').map((token) => string(token, 'validator_tool_invalid')) }; });
  if (!ID.test(name)) fail('validator_id_invalid');
  return normalized;
}

function normalizeRuntimes(value: unknown): Record<string, Dict> {
  const source = object(value, 'runtimes_invalid'); const output: Record<string, Dict> = Object.create(null);
  for (const name of Object.keys(source).sort()) {
    id(name, 'runtime_id_invalid'); const row = object(source[name], 'runtime_invalid');
    if (row.kind === 'python_venv') {
      keys(row, ['kind', 'interpreter_relpath', 'lockfiles', 'source_roots']);
      if (row.interpreter_relpath !== '.venv/bin/python') fail('runtime_interpreter_invalid');
      const lockfiles = uniqueSorted(array(row.lockfiles, 'runtime_lockfiles_invalid').map((item) => repoPath(item)), 'runtime_lockfiles_duplicate');
      const sourceRoots = uniqueSorted(array(row.source_roots, 'runtime_source_roots_invalid').map((item) => repoPath(item)), 'runtime_source_roots_duplicate');
      if (!lockfiles.length || !sourceRoots.length) fail('runtime_inputs_missing');
      output[name] = { kind: 'python_venv', interpreter_relpath: '.venv/bin/python', lockfiles, source_roots: sourceRoots };
    } else if (row.kind === 'registered_python') {
      keys(row, ['kind', 'registry_runtime_id', 'source_roots']);
      if (!['harness_test_python', 'cdo_preview_python'].includes(String(row.registry_runtime_id))) fail('registered_runtime_id_invalid');
      const sourceRoots = uniqueSorted(array(row.source_roots, 'runtime_source_roots_invalid').map((item) => repoPath(item)), 'runtime_source_roots_duplicate');
      if (!sourceRoots.length) fail('runtime_inputs_missing');
      output[name] = { kind: 'registered_python', registry_runtime_id: row.registry_runtime_id as string, source_roots: sourceRoots };
    } else fail('runtime_kind_invalid');
  }
  return output;
}

function normalizeDependencies(value: unknown, capabilities: Set<string>, directCapabilities: Set<string>): Record<string, Dict> {
  const source = object(value, 'dependencies_invalid'); const output: Record<string, Dict> = Object.create(null);
  for (const name of Object.keys(source).sort()) {
    id(name, 'dependency_id_invalid'); const row = object(source[name], 'dependency_invalid'); keys(row, ['repo_id', 'registry_id', 'artifact_paths', 'counterpart_gate']);
    const artifacts = uniqueSorted(array(row.artifact_paths, 'dependency_artifacts_invalid').map((item) => repoPath(item)), 'dependency_artifacts_duplicate');
    if (!artifacts.length) fail('dependency_artifacts_missing');
    const normalized: Dict = { repo_id: string(row.repo_id, 'dependency_repo_invalid'), registry_id: id(row.registry_id, 'dependency_registry_invalid'), artifact_paths: artifacts };
    if (row.counterpart_gate !== undefined) {
      const gate = object(row.counterpart_gate, 'counterpart_gate_invalid'); keys(gate, ['capability', 'kind', 'runtime', 'test_paths', 'test_modules', 'source_roots']);
      const capability = id(gate.capability, 'counterpart_capability_invalid');
      if (!capabilities.has(capability) || directCapabilities.has(capability)) fail('counterpart_capability_invalid');
      if (!['python_pytest', 'python_unittest'].includes(String(gate.kind))) fail('counterpart_kind_invalid');
      const runtime = object(gate.runtime, 'counterpart_runtime_invalid');
      let runtimeOut: Dict;
      if (runtime.source === 'consumer') { keys(runtime, ['source', 'runtime_id']); runtimeOut = { source: 'consumer', runtime_id: id(runtime.runtime_id, 'counterpart_runtime_invalid') }; }
      else if (runtime.source === 'dependency') { keys(runtime, ['source', 'interpreter_relpath', 'requirements_files']); if (runtime.interpreter_relpath !== '.venv/bin/python') fail('counterpart_runtime_invalid'); runtimeOut = { source: 'dependency', interpreter_relpath: '.venv/bin/python', requirements_files: uniqueSorted(array(runtime.requirements_files, 'counterpart_runtime_invalid').map((item) => repoPath(item)), 'counterpart_runtime_duplicate') }; }
      else fail('counterpart_runtime_invalid');
      const testPaths = gate.test_paths === undefined ? [] : uniqueSorted(array(gate.test_paths, 'counterpart_tests_invalid').map((item) => repoPath(item)), 'counterpart_tests_duplicate');
      const testModules = gate.test_modules === undefined ? [] : uniqueSorted(array(gate.test_modules, 'counterpart_tests_invalid').map((item) => { const module = string(item, 'counterpart_module_invalid'); if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(module)) fail('counterpart_module_invalid'); return module; }), 'counterpart_tests_duplicate');
      if ((gate.kind === 'python_pytest' && (!testPaths.length || testModules.length)) || (gate.kind === 'python_unittest' && (!testModules.length || testPaths.length))) fail('counterpart_tests_invalid');
      normalized.counterpart_gate = { capability, kind: gate.kind, runtime: runtimeOut, ...(testPaths.length ? { test_paths: testPaths } : {}), ...(testModules.length ? { test_modules: testModules } : {}), source_roots: uniqueSorted(array(gate.source_roots, 'counterpart_source_roots_invalid').map((item) => repoPath(item)), 'counterpart_source_roots_duplicate') };
    }
    output[name] = normalized;
  }
  return output;
}

function normalizeProfile(raw: unknown): WorkProfile {
  const root = object(raw, 'work_profile_root_invalid');
  keys(root, ['schema_version', 'semantic_paths', 'prose_only_surfaces', 'dependency_surfaces', 'capabilities', 'validators', 'runtimes', 'dependencies', 'lanes', 'release', 'metadata_projections', 'deploy_targets', 'recording']);
  if (root.schema_version !== WORK_PROFILE_SCHEMA) fail('work_profile_schema_invalid');
  const capabilitiesRaw = object(root.capabilities, 'capabilities_invalid');
  const capabilities: Record<string, { version: string }> = Object.create(null);
  for (const name of Object.keys(capabilitiesRaw).sort()) { id(name, 'capability_id_invalid'); const row = object(capabilitiesRaw[name], 'capability_invalid'); keys(row, ['version']); capabilities[name] = { version: string(row.version, 'capability_version_invalid') }; }
  const capabilityIds = new Set(Object.keys(capabilities));
  const validatorsRaw = object(root.validators, 'validators_invalid');
  const validators: WorkProfile['validators'] = Object.create(null);
  const primary = new Set<string>();
  for (const name of Object.keys(validatorsRaw).sort()) { const spec = normalizeValidator(name, validatorsRaw[name], capabilityIds); if (primary.has(spec.capability)) fail('validator_primary_duplicate'); primary.add(spec.capability); validators[name] = spec; }
  const runtimes = root.runtimes === undefined ? undefined : normalizeRuntimes(root.runtimes);
  const dependencies = root.dependencies === undefined ? undefined : normalizeDependencies(root.dependencies, capabilityIds, primary);
  for (const validator of Object.values(validators)) {
    if (validator.runtime_id && !runtimes?.[validator.runtime_id]) fail('validator_runtime_unknown');
    if (validator.dependency_ids?.some((dependency) => !dependencies?.[dependency])) fail('validator_dependency_unknown');
    if (validator.compiled_adapter?.dependency_artifacts.some((artifact) => !dependencies?.[artifact.dependency_id] || !(dependencies[artifact.dependency_id].artifact_paths as string[]).includes(artifact.path))) fail('compiled_adapter_dependency_invalid');
  }
  const semanticPaths = array(root.semantic_paths, 'semantic_paths_invalid').map((item) => { const row = object(item, 'semantic_path_invalid'); keys(row, ['glob', 'roles']); return { glob: repoPath(row.glob, true), roles: roleList(row.roles) }; }).sort((a, b) => a.glob.localeCompare(b.glob));
  if (new Set(semanticPaths.map((entry) => entry.glob)).size !== semanticPaths.length) fail('semantic_path_duplicate');
  const lanesRaw = object(root.lanes, 'lanes_invalid');
  keys(lanesRaw, LANES, 'lane_unknown');
  const lanes = Object.create(null) as WorkProfile['lanes'];
  for (const lane of LANES) { const row = object(lanesRaw[lane], 'lane_missing'); keys(row, ['activation', 'required_capabilities', 'stage_requirements']); const activation = string(row.activation, 'lane_activation_invalid'); if (!ACTIVATION_SET.has(activation)) fail('lane_activation_invalid'); const required = idList(row.required_capabilities, 'lane_capability_invalid'); if (required.some((item) => !capabilityIds.has(item))) fail('lane_capability_unknown'); const stageRaw = object(row.stage_requirements, 'stage_requirements_invalid'); const stage = Object.create(null) as Partial<Record<FinishLine, string[]>>; for (const finish of Object.keys(stageRaw).sort()) { if (!FINISH_SET.has(finish)) fail('finish_line_invalid'); const list = idList(stageRaw[finish], 'stage_capability_invalid'); if (list.some((item) => !capabilityIds.has(item))) fail('stage_capability_unknown'); stage[finish as FinishLine] = list; } lanes[lane] = { activation: activation as Activation, required_capabilities: required, stage_requirements: stage }; }
  const releaseRaw = object(root.release, 'release_invalid');
  keys(releaseRaw, ['mode', 'title_policy', 'version_source', 'version_targets', 'changelog_path']);
  const mode = string(releaseRaw.mode, 'release_mode_invalid'); const title = string(releaseRaw.title_policy, 'release_title_policy_invalid');
  if (!['per_pr', 'required_on_release', 'none'].includes(mode) || !['version_prefix', 'conventional', 'free'].includes(title)) fail('release_invalid');
  const release: Dict = { mode, title_policy: title };
  if (releaseRaw.version_source !== undefined) release.version_source = normalizeProjection(releaseRaw.version_source);
  if (releaseRaw.version_targets !== undefined) release.version_targets = array(releaseRaw.version_targets, 'release_targets_invalid').map((item) => normalizeProjection(item, true)).sort((a, b) => `${a.path}:${a.selector}`.localeCompare(`${b.path}:${b.selector}`));
  if (releaseRaw.changelog_path !== undefined) release.changelog_path = repoPath(releaseRaw.changelog_path);
  if (mode === 'none' && (release.version_source || release.version_targets || release.changelog_path)) fail('release_none_metadata_forbidden');
  if (mode !== 'none' && !release.version_source) fail('release_version_source_required');
  if (mode !== 'none' && (!(release.version_targets as Dict[] | undefined)?.length)) fail('release_version_targets_required');
  if (title === 'version_prefix' && !release.version_source) fail('release_version_source_required');
  const metadata = array(root.metadata_projections, 'metadata_projections_invalid').map((item) => normalizeProjection(item)).sort((a, b) => `${a.path}:${a.selector}`.localeCompare(`${b.path}:${b.selector}`));
  const projectionKey = (projection: Dict) => `${projection.path}\0${projection.format}\0${projection.selector}`;
  if (new Set(metadata.map(projectionKey)).size !== metadata.length) fail('metadata_projection_duplicate');
  if (mode !== 'none') {
    const source = release.version_source as Dict;
    const targets = release.version_targets as Dict[];
    if (new Set(targets.map(projectionKey)).size !== targets.length) fail('release_target_duplicate');
    if (!targets.some((target) => projectionKey(target) === projectionKey(source))) fail('release_source_target_mismatch');
    const projected = new Set(metadata.map(projectionKey));
    if (!projected.has(projectionKey(source)) || targets.some((target) => !projected.has(projectionKey(target)))) fail('release_projection_missing');
  }
  const targetRaw = object(root.deploy_targets, 'deploy_targets_invalid');
  if (Object.keys(targetRaw).length !== 1) fail('deploy_target_count_invalid');
  const deployTargets: Record<string, Dict> = Object.create(null);
  for (const name of Object.keys(targetRaw)) { id(name, 'deploy_target_id_invalid'); const row = object(targetRaw[name], 'deploy_target_invalid'); keys(row, ['id', 'environment_class', 'trigger', 'binding']); if (row.id !== name) fail('deploy_target_id_mismatch'); id(row.id, 'deploy_target_id_invalid'); const trigger = string(row.trigger, 'deploy_trigger_invalid'); const binding = object(row.binding, 'deploy_binding_invalid'); const adapter = string(binding.adapter_id, 'deploy_adapter_invalid'); if (adapter === 'none.v1') { keys(binding, ['adapter_id']); if (trigger !== 'none') fail('deploy_binding_mismatch'); } else if (adapter === 'github_actions.v1') { keys(binding, ['adapter_id', 'workflow_database_id', 'workflow_path', 'environment_name', 'environment_database_id', 'health_target_id']); if (trigger !== 'on_merge' || !/^[1-9]\d*$/.test(string(binding.workflow_database_id, 'deploy_binding_invalid')) || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(string(binding.workflow_path, 'deploy_binding_invalid')) || !/^[1-9]\d*$/.test(string(binding.environment_database_id, 'deploy_binding_invalid'))) fail('deploy_binding_invalid'); string(binding.environment_name, 'deploy_binding_invalid'); if (binding.health_target_id !== undefined) id(binding.health_target_id, 'deploy_binding_invalid'); } else fail('deploy_adapter_unknown'); deployTargets[name] = { id: name, environment_class: id(row.environment_class, 'environment_class_invalid'), trigger, binding: stable(binding) as Dict }; }
  const recordingRaw = object(root.recording, 'recording_invalid'); keys(recordingRaw, FINISH_LINES, 'recording_finish_line_unknown'); const recording = Object.create(null) as WorkProfile['recording'];
  for (const finish of FINISH_LINES) { const level = string(recordingRaw[finish], 'recording_missing'); if (!['response', 'receipt', 'session', 'release'].includes(level)) fail('recording_level_invalid'); if (level === 'release' && !['merged', 'deployed'].includes(finish)) fail('recording_subject_missing'); recording[finish] = level as WorkProfile['recording'][FinishLine]; }
  return { schema_version: WORK_PROFILE_SCHEMA, semantic_paths: semanticPaths, ...(root.prose_only_surfaces === undefined ? {} : { prose_only_surfaces: uniqueSorted(array(root.prose_only_surfaces, 'prose_only_invalid').map((item) => repoPath(item, true)), 'prose_only_duplicate') }), ...(root.dependency_surfaces === undefined ? {} : { dependency_surfaces: array(root.dependency_surfaces, 'dependency_surfaces_invalid').map((item) => { const row = object(item, 'dependency_surface_invalid'); keys(row, ['glob', 'dependency_ids', 'capability_ids']); const capability_ids = idList(row.capability_ids, 'dependency_capabilities_invalid'); if (capability_ids.some((item) => !capabilityIds.has(item))) fail('dependency_capability_unknown'); const dependency_ids = idList(row.dependency_ids, 'dependency_ids_invalid'); if (dependency_ids.some((item) => !dependencies?.[item])) fail('dependency_id_unknown'); return { glob: repoPath(row.glob, true), dependency_ids, capability_ids }; }) }), capabilities, validators, ...(runtimes ? { runtimes } : {}), ...(dependencies ? { dependencies } : {}), lanes, release, metadata_projections: metadata, deploy_targets: deployTargets, recording };
}

export function parseWorkProfile(source: string): ParsedWorkProfile {
  const profile = normalizeProfile(parseStrictYaml(source));
  const semantic_policy_hash = sha256({ profile, schema: WORK_PROFILE_POLICY_VERSION, deploy_registry: DEPLOY_ADAPTER_REGISTRY_VERSION });
  return Object.assign(profile, { semantic_policy_hash });
}

export function resolveProfileRequirements(profile: ParsedWorkProfile, input: { roles: SemanticRole[]; lane: Lane; finishLine: FinishLine; explicitCapabilities?: string[] }) {
  const required = new Set<string>(input.explicitCapabilities ?? []);
  for (const capability of profile.lanes[input.lane].required_capabilities) required.add(capability);
  for (const capability of profile.lanes[input.lane].stage_requirements[input.finishLine] ?? []) required.add(capability);
  for (const validator of Object.values(profile.validators)) if (validator.required_by_surface.some((role) => input.roles.includes(role))) required.add(validator.capability);
  for (const capability of required) if (!profile.capabilities[capability]) fail('requirement_capability_unknown');
  const direct = new Map(Object.entries(profile.validators).map(([validatorId, spec]) => [spec.capability, validatorId]));
  const selectedPrimaries = new Set([...required].map((capability) => direct.get(capability)).filter((value): value is string => Boolean(value)));
  const coveredBy: Record<string, string> = Object.create(null);
  for (const capability of [...required].sort()) {
    const providers = [...selectedPrimaries].filter((validatorId) => profile.validators[validatorId].provides?.includes(capability)).sort();
    const owner = providers[0] ?? direct.get(capability); if (owner) coveredBy[capability] = owner;
  }
  const pruned = [...new Set(Object.values(coveredBy))].sort();
  const bindings: Record<string, Dict> = Object.create(null);
  for (const validatorId of pruned) { const spec = profile.validators[validatorId]; bindings[validatorId] = { capability_id: spec.capability, capability_version: profile.capabilities[spec.capability].version, validator_version: sha256(spec), semantic_policy_hash: profile.semantic_policy_hash }; }
  return { required_capabilities: [...required].sort(), validator_ids: pruned, covered_by: coveredBy, validator_bindings: bindings, unbound_capabilities: [...required].filter((capability) => !coveredBy[capability]).sort() };
}

function withoutHash(profile: ParsedWorkProfile): WorkProfile { const { semantic_policy_hash: _hash, ...plain } = profile; return plain; }
export function compareCandidateProfile(trusted: ParsedWorkProfile, candidate: ParsedWorkProfile): { state: 'same' | 'strengthening_applied' | 'ignored_untrusted'; effective: ParsedWorkProfile; warnings: string[] } {
  if (trusted.semantic_policy_hash === candidate.semantic_policy_hash) return { state: 'same', effective: trusted, warnings: [] };
  const trustedPlain = structuredClone(withoutHash(trusted)); const candidatePlain = structuredClone(withoutHash(candidate));
  const allowed: Record<Activation, Set<Activation>> = { legacy: new Set(), shadow: new Set(['legacy']), enforce: new Set(['shadow', 'legacy']) };
  let changed = false;
  for (const lane of LANES) { const from = trustedPlain.lanes[lane].activation; const to = candidatePlain.lanes[lane].activation; if (from !== to) { if (!allowed[from].has(to)) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] }; candidatePlain.lanes[lane].activation = from; changed = true; } }
  const candidatePaths = new Map(candidatePlain.semantic_paths.map((entry) => [entry.glob, entry]));
  if (candidatePaths.size !== trustedPlain.semantic_paths.length) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] };
  for (const trustedPath of trustedPlain.semantic_paths) {
    const candidatePath = candidatePaths.get(trustedPath.glob); if (!candidatePath || trustedPath.roles.some((role) => !candidatePath.roles.includes(role))) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] };
    if (candidatePath.roles.length !== trustedPath.roles.length) changed = true;
    candidatePath.roles = [...trustedPath.roles];
  }
  candidatePlain.semantic_paths.sort((a, b) => a.glob.localeCompare(b.glob));
  const seconds = (value: string) => { const match = value.match(DURATION)!; return Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[match[2]]; };
  for (const validatorId of Object.keys(trustedPlain.validators)) {
    const before = trustedPlain.validators[validatorId]; const after = candidatePlain.validators[validatorId]; if (!after) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] };
    if (before.ttl !== after.ttl) { if (!before.ttl || !after.ttl || seconds(after.ttl) > seconds(before.ttl)) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] }; after.ttl = before.ttl; changed = true; }
  }
  for (const lane of LANES) {
    const before = trustedPlain.lanes[lane]; const after = candidatePlain.lanes[lane];
    if (before.required_capabilities.some((item) => !after.required_capabilities.includes(item))) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] };
    if (after.required_capabilities.length !== before.required_capabilities.length) { after.required_capabilities = [...before.required_capabilities]; changed = true; }
    for (const finish of FINISH_LINES) { const prior = before.stage_requirements[finish] ?? []; const next = after.stage_requirements[finish] ?? []; if (prior.some((item) => !next.includes(item))) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] }; if (canonicalProfileJson(prior) !== canonicalProfileJson(next)) { if (next.some((item) => !trusted.capabilities[item] || !Object.values(trusted.validators).some((validator) => validator.capability === item))) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] }; if (prior.length) after.stage_requirements[finish] = [...prior]; else delete after.stage_requirements[finish]; changed = true; } }
  }
  if (canonicalProfileJson(trustedPlain) !== canonicalProfileJson(candidatePlain) || !changed) return { state: 'ignored_untrusted', effective: trusted, warnings: ['candidate_policy_ignored'] };
  return { state: 'strengthening_applied', effective: candidate, warnings: [] };
}
