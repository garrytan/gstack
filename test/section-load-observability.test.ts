import { describe, expect, test } from 'bun:test';
import { aggregateEcpeObservations } from '../lib/ecpe-metrics';

const base = {
  schema_version: 1,
  run_id: 'run-sections',
  timestamp: '2026-09-01T00:00:00.000Z',
  wtree: 'repo-1',
  work_kind: 'review',
  finish_line: 'review_receipt',
};

function load(provenance: 'adapter_delivered' | 'host_reported_assertion', batch: string | null) {
  return {
    ...base,
    kind: 'section_load',
    section_load: {
      section_id: 'review-army',
      bundle_hash: `sha256:${'a'.repeat(64)}`,
      bytes: 123,
      delivery_provenance: provenance,
      delivery_batch_id: batch,
    },
  };
}

describe('section delivery observability', () => {
  test('host assertions and direct/manual reads never complete producer coverage', () => {
    const asserted = aggregateEcpeObservations([load('host_reported_assertion', 'batch-host')]);
    expect(asserted.runs[0].section_load_coverage).toBe('unknown');
    expect(asserted.runs[0].loaded_section_bytes).toBe(0);
    expect(aggregateEcpeObservations([{ ...base, kind: 'context', context: {
      skill: 'review', eager_bytes: 1, skillpack_identity: `sha256:${'b'.repeat(64)}`,
    } }]).runs[0].section_load_coverage).toBe('unknown');
  });

  test('non-terminal adapter events stay unknown; a terminal adapter batch is complete', () => {
    expect(aggregateEcpeObservations([load('adapter_delivered', null)]).runs[0].section_load_coverage)
      .toBe('unknown');
    const complete = aggregateEcpeObservations([load('adapter_delivered', 'batch-terminal')]);
    expect(complete.runs[0].section_load_coverage).toBe('complete');
    expect(complete.runs[0].loaded_section_bytes).toBe(123);
    expect(complete.runs[0].loaded_section_ids).toEqual(['review-army']);
  });

  test('reports eager plus actually adapter-delivered bytes as one total', () => {
    const report = aggregateEcpeObservations([
      { ...base, kind: 'context', context: {
        skill: 'review', eager_bytes: 77, skillpack_identity: `sha256:${'b'.repeat(64)}`,
      } },
      load('adapter_delivered', 'batch-terminal'),
    ]);
    expect(report.runs[0].total_context_bytes).toBe(200);
    expect(report.totals.total_context_bytes).toBe(200);
  });
});
