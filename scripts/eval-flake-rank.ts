#!/usr/bin/env bun
/**
 * eval-flake-rank — the flake-telemetry dial (WS1).
 *
 * Aggregates per-test series across every FINALIZED eval-store run on this
 * machine (default: ~/.gstack/projects/<slug>/evals/, shard dirs included)
 * plus the free suite's flake ledger, and ranks tests by flake signal:
 * retried passes first (a test that needs attempt 2 to go green is the
 * definition of a flake), then failure rate.
 *
 * This is the readable dial behind two policies:
 *   - a flaky pass never blocks a merge, but it is recorded and RANKED here;
 *   - the required-check promotion (WS16) needs weeks of clean flake-rank,
 *     not vibes.
 *
 * Usage:
 *   bun run eval:flake-rank                 # project eval dir
 *   bun run eval:flake-rank --dir <path>    # e.g. downloaded CI artifacts
 *   bun run eval:flake-rank --json          # machine-readable
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProjectEvalDir, isPartialEval, isFinalizedEvalResultFile, type EvalResult } from '../test/helpers/eval-store';
import { flakeLedgerPath, type FlakeLedgerEntry } from './test-free-shards';

interface TestSeries {
  name: string;
  runs: number;
  passes: number;
  fails: number;
  retriedPasses: number;
  totalAttempts: number;
  totalCostUsd: number;
  totalDurationMs: number;
  lastSeen: string;
}

export function aggregate(evalFiles: string[]): Map<string, TestSeries> {
  const series = new Map<string, TestSeries>();
  for (const file of evalFiles) {
    let run: EvalResult;
    try {
      run = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { continue; }
    if (isPartialEval(run, file)) continue; // in-progress accumulators are not runs
    if (!Array.isArray(run.tests)) continue;
    // Group this run's entries by name so N attempts = 1 run of that test.
    const byName = new Map<string, typeof run.tests>();
    for (const t of run.tests) {
      const list = byName.get(t.name) ?? [];
      list.push(t);
      byName.set(t.name, list);
    }
    for (const [name, entries] of byName) {
      const s = series.get(name) ?? {
        name, runs: 0, passes: 0, fails: 0, retriedPasses: 0,
        totalAttempts: 0, totalCostUsd: 0, totalDurationMs: 0, lastSeen: '',
      };
      const final = entries[entries.length - 1];
      s.runs += 1;
      s.totalAttempts += entries.length;
      if (final.passed) s.passes += 1; else s.fails += 1;
      if (final.passed && entries.length > 1) s.retriedPasses += 1;
      for (const e of entries) {
        s.totalCostUsd += e.cost_usd || 0;
        s.totalDurationMs += e.duration_ms || 0;
      }
      if (run.timestamp > s.lastSeen) s.lastSeen = run.timestamp;
      series.set(name, s);
    }
  }
  return series;
}

export function collectEvalFiles(dir: string, sinceDays = 60): string[] {
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const out: string[] = [];
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!isFinalizedEvalResultFile(name)) continue;
    const full = path.join(dir, name);
    try {
      // Recency bound (review finding): E2E results embed full transcripts
      // (MBs each) and the scan is otherwise unbounded over all-time history.
      if (fs.statSync(full).mtimeMs < cutoff) continue;
    } catch { continue; }
    out.push(full);
  }
  return out;
}

function readFreeLedger(): FlakeLedgerEntry[] {
  // Per-LINE parse: one malformed JSONL line (torn write, manual edit) must
  // drop that line, never vanish the whole series (codex adversarial finding).
  let raw: string;
  try {
    raw = fs.readFileSync(flakeLedgerPath(), 'utf-8');
  } catch { return []; }
  const out: FlakeLedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line — skip */ }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf('--dir');
  const dir = dirFlag !== -1 ? argv[dirFlag + 1] : getProjectEvalDir();
  const asJson = argv.includes('--json');
  const sinceFlag = argv.indexOf('--since-days');
  const sinceDays = sinceFlag !== -1 ? Number(argv[sinceFlag + 1]) || 60 : 60;

  const files = collectEvalFiles(dir, sinceDays);
  const series = [...aggregate(files).values()]
    .sort((a, b) => b.retriedPasses - a.retriedPasses || (b.fails / b.runs) - (a.fails / a.runs));
  const ledger = readFreeLedger();

  if (asJson) {
    console.log(JSON.stringify({ dir, runsScanned: files.length, tests: series, freeLedger: ledger }, null, 2));
  } else {
    console.log(`flake-rank: ${files.length} finalized run file(s) under ${dir}`);
    const flaky = series.filter((s) => s.retriedPasses > 0 || s.fails > 0);
    if (flaky.length === 0) {
      console.log('  no retried passes and no failures recorded — clean series');
    } else {
      console.log('  retries  fails/runs  avg-dur  test');
      for (const s of flaky.slice(0, 30)) {
        console.log(`  ${String(s.retriedPasses).padStart(7)}  ${String(s.fails).padStart(5)}/${String(s.runs).padEnd(4)}  `
          + `${Math.round(s.totalDurationMs / s.totalAttempts / 1000).toString().padStart(5)}s  ${s.name}`);
      }
    }
    if (ledger.length > 0) {
      const byFile = new Map<string, number>();
      for (const e of ledger) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
      console.log(`free-suite flaky-passes (${flakeLedgerPath()}):`);
      for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)}x  ${file}`);
      }
    }
  }
}
