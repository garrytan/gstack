import { describe, expect, test } from 'bun:test';
import { legacyValidatorDescriptor } from '../lib/legacy-validator';

describe('closed legacy validator registry', () => {
  test('freezes PortfolioOps full bootstrap descriptor', () => {
    expect(legacyValidatorDescriptor('portfolioops', 'full')).toEqual({
      id: 'full', repo_id: 'portfolioops', argv: ['scripts/validate.sh'], execution_effect: 'read', interpreter_relpath: '.venv/bin/python', lockfiles: ['requirements-dev.lock', 'requirements.lock'], source_roots: ['src'], runtime_binding: { mode: 'env', name: 'PYTHON_BIN' },
    });
  });
  test('freezes the harness T4 proof and rejects unknown/effectful selection', () => {
    expect(legacyValidatorDescriptor('harness', 'harness.t4').argv).toEqual(['python3', 'scripts/ops/harness_eval.py', '--core', '--no-manifest']);
    expect(() => legacyValidatorDescriptor('portfolioops', 'other')).toThrow('legacy_validator_unknown');
  });
});
