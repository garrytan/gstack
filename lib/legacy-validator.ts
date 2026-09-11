export interface LegacyValidatorDescriptor {
  id: string;
  repo_id: string;
  argv: string[];
  execution_effect: 'read';
  interpreter_relpath?: string;
  lockfiles?: string[];
  source_roots: string[];
  runtime_binding?: { mode: 'env'; name: 'PYTHON_BIN' };
}

const REGISTRY: Record<string, Record<string, LegacyValidatorDescriptor>> = Object.freeze({
  portfolioops: Object.freeze({
    full: Object.freeze({ id: 'full', repo_id: 'portfolioops', argv: ['scripts/validate.sh'], execution_effect: 'read', interpreter_relpath: '.venv/bin/python', lockfiles: ['requirements-dev.lock', 'requirements.lock'], source_roots: ['src'], runtime_binding: { mode: 'env', name: 'PYTHON_BIN' } }),
  }),
  harness: Object.freeze({
    'harness.t4': Object.freeze({ id: 'harness.t4', repo_id: 'harness', argv: ['python3', 'scripts/ops/harness_eval.py', '--core', '--no-manifest'], execution_effect: 'read', source_roots: ['.'] }),
  }),
});

export function legacyValidatorDescriptor(repoId: string, id: string): LegacyValidatorDescriptor {
  const descriptor = REGISTRY[repoId]?.[id];
  if (!descriptor) throw new Error('legacy_validator_unknown');
  return structuredClone(descriptor);
}
