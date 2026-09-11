import { describe, expect, test } from 'bun:test';

async function subject(): Promise<any> {
  return import('../lib/ecpe-metrics').catch(() => null);
}

const base = {
  schema_version: 1,
  run_id: 'run-1',
  timestamp: '2026-08-31T00:00:00.000Z',
  wtree: 'repo-1',
  work_kind: 'review',
  finish_line: 'review_receipt',
};

const scope = {
  repo_id: 'repo-1',
  ref_or_pr: 'refs/heads/main',
  target_id: null,
  paths_or_surface: ['src/a.ts', 'src/b.ts'],
  environment: null,
  index_preimage_hash: null,
  binding_id: null,
  projection_id: null,
};

describe('strict content-free ECPE observations', () => {
  test('accepts canonical project slugs only in project-identity fields', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    for (const valid of ['legacy-project', 'fixture%2Dproject', 'fixture%25project', 'caf%C3%A9']) {
      expect(api.isProjectSlug(valid)).toBe(true);
    }
    for (const invalid of ['fixture%2Gproject', 'fixture%2dproject', 'fixture%41project', 'fixture%2Fproject', '../escape', 'a'.repeat(129)]) {
      expect(api.isProjectSlug(invalid)).toBe(false);
    }

    expect(api.validateEcpeObservation({
      ...base,
      wtree: 'fixture%2Dproject',
      kind: 'gate',
      gate: { phase: 'before_final', gate_wtree: 'fixture%2Dproject' },
    })).toMatchObject({ wtree: 'fixture%2Dproject' });

    expect(() => api.validateEcpeObservation({
      ...base,
      wtree: 'fixture%2Dproject',
      kind: 'decision',
      capability_ids: ['fixture%2Dproject'],
    })).toThrow(/ecpe_schema_invalid/);
  });

  test('accepts closed enums and validated IDs but rejects unknown and content-bearing keys recursively', async () => {
    const api = await subject();
    expect(api).not.toBeNull();

    expect(api.validateEcpeObservation({
      ...base,
      kind: 'decision',
      semantic_roles: ['code', 'contract'],
      capability_ids: ['review.complete'],
    })).toMatchObject({ kind: 'decision', execution_purpose: 'ordinary' });

    for (const forbidden of ['prompt', 'payload', 'diff', 'secret', 'content']) {
      expect(() => api.validateEcpeObservation({
        ...base,
        kind: 'decision',
        semantic_roles: ['code'],
        [forbidden]: 'sensitive',
      })).toThrow(/ecpe_schema_invalid/);
    }
    expect(() => api.validateEcpeObservation({ ...base, kind: 'decision', semantic_roles: ['unknown-role'] }))
      .toThrow(/ecpe_schema_invalid/);
    expect(() => api.validateEcpeObservation({ ...base, kind: 'decision', capability_ids: ['HAS SPACE'] }))
      .toThrow(/ecpe_schema_invalid/);
    expect(() => api.validateEcpeObservation({ ...base, kind: 'receipt', receipt: { capability_id: 'review.complete', disposition: 'hit', reason_ids: [] }, validator: { id: 'x', duration_s: 1, result: 'pass' } }))
      .toThrow(/ecpe_schema_invalid/);
  });

  test('protects canary-control and reserved T3/T5 producer kinds from ordinary callers', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    expect(() => api.validateEcpeObservation({
      ...base,
      kind: 'spawn',
      execution_purpose: 'canary_control',
      spawn: { kind: 'model', id: 'control-model', execution_effect: 'paid_model' },
    })).toThrow(/protected_producer/);
    expect(() => api.validateEcpeObservation({
      ...base,
      kind: 'shadow_comparison',
      shadow_comparison: {},
    })).toThrow(/protected_producer/);
    expect(() => api.validateEcpeObservation({
      ...base,
      kind: 'candidate_preview',
      candidate_preview: {},
    })).toThrow(/protected_producer/);
  });

  test('authorizes an observed subset only under an exact effect-scope key', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const grant = {
      effect: 'tracked_write', phase: 'granted', source: 'explicit_user_request', scope,
    };
    const observed = {
      effect: 'tracked_write', phase: 'observed', source: 'adapter_observed',
      scope: { ...scope, paths_or_surface: ['src/a.ts'] },
    };
    expect(api.effectIsAuthorized(observed, [grant])).toBe(true);

    for (const mismatch of [
      { repo_id: 'repo-2' },
      { ref_or_pr: 'refs/heads/other' },
      { target_id: 'prod' },
      { environment: 'prod' },
      { index_preimage_hash: 'sha256:bad' },
      { binding_id: 'binding-other' },
      { projection_id: 'projection-other' },
      { paths_or_surface: ['src/other.ts'] },
    ]) {
      expect(api.effectIsAuthorized({ ...observed, scope: { ...observed.scope, ...mismatch } }, [grant])).toBe(false);
    }
  });

  test('keeps token provenance explicit and reports duplicate capabilities, misses and validator percentiles', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const observations = [
      { ...base, kind: 'decision', semantic_roles: ['code'], capability_ids: ['review.complete'] },
      { ...base, timestamp: '2026-08-31T00:00:01.000Z', kind: 'decision', capability_ids: ['review.complete'] },
      { ...base, timestamp: '2026-08-31T00:00:02.000Z', kind: 'receipt', receipt: { capability_id: 'review.complete', disposition: 'miss', reason_ids: ['proof.stale'] } },
      { ...base, timestamp: '2026-08-31T00:00:03.000Z', kind: 'validator', validator: { id: 'tests', duration_s: 2, result: 'pass' } },
      { ...base, timestamp: '2026-08-31T00:00:04.000Z', kind: 'validator', validator: { id: 'lint', duration_s: 8, result: 'pass' } },
      { ...base, timestamp: '2026-08-31T00:00:05.000Z', kind: 'token', token_usage: { input: null, output: null, total: null, source: 'unknown' } },
    ];
    const report = api.aggregateEcpeObservations(observations);
    expect(report.runs[0].capabilities).toEqual(['review.complete']);
    expect(report.runs[0].receipt_miss_reasons).toEqual(['proof.stale']);
    expect(report.validator_duration_p50_s).toBe(2);
    expect(report.validator_duration_p95_s).toBe(8);
    expect(report.runs[0].token_usage).toEqual({ input: null, output: null, total: null, source: 'unknown' });
  });

  test('reports same-worktree duplicate capability runs, totals, and missing producer coverage', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const observations = [
      { ...base, run_id: 'run-a', kind: 'context', context: { skill: 'review', eager_bytes: 100, skillpack_identity: 'sha256:' + 'a'.repeat(64) } },
      { ...base, run_id: 'run-a', timestamp: '2026-08-31T00:00:01.000Z', kind: 'decision', capability_ids: ['review.complete'] },
      { ...base, run_id: 'run-b', timestamp: '2026-08-31T00:00:02.000Z', kind: 'decision', capability_ids: ['review.complete'] },
    ];
    const report = api.aggregateEcpeObservations(observations);

    expect(report.totals.eager_bytes).toBe(100);
    expect(report.duplicate_capability_runs).toEqual([{
      wtree: 'repo-1', capability_id: 'review.complete', run_ids: ['run-a', 'run-b'],
    }]);
    expect(report.missing_producer_coverage).toEqual({
      record_runs: 2, section_load_runs: 2, token_runs: 2,
    });
  });
});
