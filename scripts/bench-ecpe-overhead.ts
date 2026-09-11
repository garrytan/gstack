#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendEcpeBatch } from '../lib/ecpe-metrics';

const WARMUPS = 20;
const ITERATIONS = 200;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function baselineAppend(target: string, line: string): number {
  const started = performance.now();
  const fd = fs.openSync(target, 'a', 0o600);
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return performance.now() - started;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-overhead-bench-'));
try {
  const baselinePath = path.join(temporary, 'baseline.jsonl');
  const candidatePath = path.join(temporary, 'candidate.jsonl');
  const legacy = JSON.stringify({ skill: 'review', event: 'observation', run_id: 'run-bench', ts: '2026-08-31T00:00:00.000Z' });
  const observation = {
    schema_version: 1, run_id: 'run-bench', timestamp: '2026-08-31T00:00:00.000Z',
    wtree: 'repo-bench', kind: 'decision', work_kind: 'review', finish_line: 'review_receipt',
    capability_ids: ['review.complete'],
  };
  const baseline: number[] = [];
  const candidate: number[] = [];
  let candidateMetrics: any = null;
  for (let index = 0; index < WARMUPS + ITERATIONS; index++) {
    const baselineMs = baselineAppend(baselinePath, legacy);
    const metrics = appendEcpeBatch(candidatePath, [observation]);
    if (index >= WARMUPS) {
      baseline.push(baselineMs);
      candidate.push(metrics.writer_duration_ms);
      candidateMetrics = metrics;
    }
  }
  const baselineP50 = percentile(baseline, 0.5);
  const baselineP95 = percentile(baseline, 0.95);
  const candidateP50 = percentile(candidate, 0.5);
  const candidateP95 = percentile(candidate, 0.95);
  const output = {
    schema: 'ecpe.overhead-budget.v1',
    descriptor: { platform: `${process.platform}-${process.arch}`, bun: Bun.version, iterations: ITERATIONS, warmups: WARMUPS },
    baseline: { writer_p50_ms: Number(baselineP50.toFixed(3)), writer_p95_ms: Number(baselineP95.toFixed(3)) },
    candidate: { writer_p50_ms: Number(candidateP50.toFixed(3)), writer_p95_ms: Number(candidateP95.toFixed(3)) },
    ceilings: {
      telemetry_extra_processes: 0,
      append_lock_fsync_transactions: 1,
      fsync_calls: 1,
      open_plus_stat_calls: 16,
      bytes_written: 16384,
      writer_p50_ms: Math.min(50, Math.ceil(baselineP50 * 1.25)),
      writer_p95_ms: Math.min(100, Math.ceil(baselineP95 * 1.25)),
    },
    observed: {
      telemetry_extra_processes: candidateMetrics.telemetry_extra_processes,
      append_lock_fsync_transactions: candidateMetrics.append_lock_fsync_transactions,
      fsync_calls: candidateMetrics.fsync_calls,
      open_plus_stat_calls: candidateMetrics.open_plus_stat_calls,
      bytes_written: candidateMetrics.bytes_written,
    },
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
