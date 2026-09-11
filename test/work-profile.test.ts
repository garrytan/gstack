import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareCandidateProfile, parseWorkProfile, resolveProfileRequirements } from '../lib/work-profile';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'work-profile', name), 'utf8');

describe('work profile', () => {
  test('normalizes and hashes a valid profile deterministically', () => {
    const first = parseWorkProfile(fixture('valid.yaml'));
    const second = parseWorkProfile(fixture('valid.yaml').replace('roles: [docs]', 'roles: [docs, docs]'));
    expect(first.schema_version).toBe('harness.gstack.work-profile.v1');
    expect(first.semantic_policy_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.semantic_policy_hash).toBe(first.semantic_policy_hash);
  });

  test.each([
    ['unknown top-level key', `${fixture('valid.yaml')}unknown: true\n`],
    ['shell validator argv', fixture('invalid-shell.yaml')],
    ['release recording without immutable subject', fixture('valid.yaml').replace('verified: session', 'verified: release')],
    ['zero deploy targets', fixture('valid.yaml').replace(/deploy_targets:[\s\S]*?recording:/, 'deploy_targets: {}\nrecording:')],
    ['unknown capability', fixture('valid.yaml').replace('required_capabilities: [unit]', 'required_capabilities: [missing]')],
  ])('rejects %s', (_name, source) => expect(() => parseWorkProfile(source)).toThrow());

  test('selects direct validators once and records provides coverage', () => {
    const source = fixture('valid.yaml')
      .replace('unit:\n    version: "1"', 'unit:\n    version: "1"\n  no_live:\n    version: "1"')
      .replace('capability: unit\n    execution_effect', 'capability: unit\n    provides: [no_live]\n    execution_effect');
    const profile = parseWorkProfile(source);
    const result = resolveProfileRequirements(profile, { roles: ['code'], lane: 'single_repo_code', finishLine: 'pr_open', explicitCapabilities: ['unit', 'no_live'] });
    expect(result.validator_ids).toEqual(['unit']);
    expect(result.covered_by).toEqual({ no_live: 'unit', unit: 'unit' });
    expect(result.unbound_capabilities).toEqual([]);
  });

  test('uses a selected broad provider without promoting it for a narrow-only request', () => {
    const source = fixture('valid.yaml')
      .replace('unit:\n    version: "1"', 'unit:\n    version: "1"\n  no_live:\n    version: "1"')
      .replace('capability: unit\n    execution_effect', 'capability: unit\n    provides: [no_live]\n    execution_effect')
      .replace('lanes:', '  no_live:\n    capability: no_live\n    execution_effect: read\n    argv: [bun, test, test/no-live.test.ts]\n    required_by_surface: [auth]\n    depends_on: [auth]\nlanes:');
    const profile = parseWorkProfile(source);
    expect(resolveProfileRequirements(profile, { roles: ['code'], lane: 'single_repo_code', finishLine: 'pr_open', explicitCapabilities: ['no_live'] }).validator_ids).toEqual(['unit']);
    expect(resolveProfileRequirements(profile, { roles: ['docs'], lane: 'docs_ux', finishLine: 'local_change', explicitCapabilities: ['no_live'] }).validator_ids).toEqual(['no_live']);
  });

  test('ignores an atomic candidate relaxation and applies a safe tightening', () => {
    const trusted = parseWorkProfile(fixture('shadow.yaml'));
    const forbidden = parseWorkProfile(fixture('candidate-relaxation.yaml'));
    const ignored = compareCandidateProfile(trusted, forbidden);
    expect(ignored.state).toBe('ignored_untrusted');
    expect(ignored.effective.semantic_policy_hash).toBe(trusted.semantic_policy_hash);

    const tightening = parseWorkProfile(fixture('shadow.yaml').replace('activation: shadow', 'activation: legacy'));
    const applied = compareCandidateProfile(trusted, tightening);
    expect(applied.state).toBe('strengthening_applied');
    expect(applied.effective.lanes.single_repo_code.activation).toBe('legacy');
  });

  test('applies only monotonic role, requirement, and TTL tightening atomically', () => {
    const trustedSource = fixture('shadow.yaml').replace('depends_on: [code]', 'depends_on: [code]\n    ttl: 2h');
    const trusted = parseWorkProfile(trustedSource);
    const safe = parseWorkProfile(trustedSource
      .replace('roles: [code]', 'roles: [code, auth]')
      .replace('stage_requirements: {} }\n  cross_repo_contract', 'stage_requirements: { pr_open: [unit] } }\n  cross_repo_contract')
      .replace('ttl: 2h', 'ttl: 30m'));
    expect(compareCandidateProfile(trusted, safe).state).toBe('strengthening_applied');
    const forbidden = parseWorkProfile(trustedSource.replace('roles: [code]', 'roles: [docs]'));
    expect(compareCandidateProfile(trusted, forbidden).state).toBe('ignored_untrusted');
  });

  test('recursively rejects unknown runtime and dependency fields', () => {
    const runtime = fixture('valid.yaml')
      .replace('validators:\n', 'runtimes:\n  py:\n    kind: python_venv\n    interpreter_relpath: .venv/bin/python\n    lockfiles: [requirements.lock]\n    source_roots: [src]\n    command: pip install\nvalidators:\n')
      .replace('release:', 'dependencies:\n  dep:\n    repo_id: example/dep\n    registry_id: dep\n    artifact_paths: [VERSION]\n    extra: true\nrelease:');
    expect(() => parseWorkProfile(runtime)).toThrow();
  });

  test('requires a release source mirrored by an identical evidence projection and target', () => {
    const released = fixture('valid.yaml')
      .replace('release:\n  mode: none\n  title_policy: free\nmetadata_projections: []', 'release:\n  mode: per_pr\n  title_policy: version_prefix\n  version_source: { path: VERSION, format: plain_text, selector: whole_file }\n  version_targets:\n    - { path: VERSION, format: plain_text, selector: whole_file, value_encoding: exact }\nmetadata_projections:\n  - { path: VERSION, format: plain_text, selector: whole_file }');
    expect(parseWorkProfile(released).release.mode).toBe('per_pr');
    expect(() => parseWorkProfile(released.replace('metadata_projections:\n  - { path: VERSION, format: plain_text, selector: whole_file }', 'metadata_projections: []'))).toThrow('release_projection_missing');
    expect(() => parseWorkProfile(released.replace('path: VERSION, format: plain_text, selector: whole_file, value_encoding: exact', 'path: CHANGELOG.md, format: plain_text, selector: whole_file, value_encoding: exact'))).toThrow('release_source_target_mismatch');
  });

  test('enforces the v1 recording lattice and deploy target identifier syntax', () => {
    const source = fixture('valid.yaml');
    expect(() => parseWorkProfile(source.replace('merged: receipt', 'merged: release'))).not.toThrow();
    expect(() => parseWorkProfile(source.replace('deployed: receipt', 'deployed: release'))).not.toThrow();
    expect(() => parseWorkProfile(source.replace('verified: session', 'verified: release'))).toThrow('recording_subject_missing');
    expect(() => parseWorkProfile(source.replace('operation_result: session', 'operation_result: release'))).toThrow('recording_subject_missing');
    expect(() => parseWorkProfile(source.replace('pr_open: session', 'pr_open: release'))).toThrow('recording_subject_missing');
    expect(() => parseWorkProfile(source.replace('response: response', 'response: release'))).toThrow('recording_subject_missing');
    expect(() => parseWorkProfile(source.replace('none:\n    id: none', 'Bad Target:\n    id: Bad Target'))).toThrow('deploy_target_id_invalid');
  });
});
