/**
 * Multi-provider benchmark runner.
 *
 * Orchestrates running the same prompt across multiple provider adapters and
 * aggregates RunResult outputs + judge scores into a single report. Adapters
 * run in parallel (Promise.allSettled) so a slow provider doesn't block a fast
 * one. Per-provider auth/timeout/rate-limit errors don't abort the batch.
 */

import type { ProviderAdapter, RunOpts, RunResult } from './providers/types';
import { ClaudeAdapter } from './providers/claude';
import { GptAdapter } from './providers/gpt';
import { GeminiAdapter } from './providers/gemini';

export interface BenchmarkInput {
  prompt: string;
  workdir: string;
  timeoutMs?: number;
  /** Adapter names to run (e.g., ['claude', 'gpt', 'gemini']). */
  providers: Array<'claude' | 'gpt' | 'gemini'>;
  /** Optional per-provider model overrides. */
  models?: Partial<Record<'claude' | 'gpt' | 'gemini', string>>;
  /** If true, skip providers whose available() returns !ok. If false, include them with error. */
  skipUnavailable?: boolean;
}

export interface BenchmarkEntry {
  provider: string;
  family: 'claude' | 'gpt' | 'gemini';
  available: boolean;
  unavailable_reason?: string;
  result?: RunResult;
  costUsd?: number;
  /** Judge score 0-10 across dimensions. Populated separately by the judge step. */
  qualityScore?: number;
  qualityDetails?: Record<string, number>;
}

export interface BenchmarkReport {
  prompt: string;
  workdir: string;
  startedAt: string;
  durationMs: number;
  entries: BenchmarkEntry[];
}

const ADAPTERS: Record<'claude' | 'gpt' | 'gemini', () => ProviderAdapter> = {
  claude: () => new ClaudeAdapter(),
  gpt: () => new GptAdapter(),
  gemini: () => new GeminiAdapter(),
};

export async function runBenchmark(input: BenchmarkInput): Promise<BenchmarkReport> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const timeoutMs = input.timeoutMs ?? 300_000;

  const entries: BenchmarkEntry[] = [];
  const runPromises: Array<Promise<void>> = [];

  for (const name of input.providers) {
    const factory = ADAPTERS[name];
    if (!factory) {
      entries.push({ provider: name, family: 'claude', available: false, unavailable_reason: `unknown provider: ${name}` });
      continue;
    }
    const adapter = factory();
    const entry: BenchmarkEntry = { provider: adapter.name, family: adapter.family, available: true };
    entries.push(entry);

    runPromises.push((async () => {
      const check = await adapter.available();
      entry.available = check.ok;
      if (!check.ok) {
        entry.unavailable_reason = check.reason;
        if (input.skipUnavailable) return;
      }
      const opts: RunOpts = {
        prompt: input.prompt,
        workdir: input.workdir,
        timeoutMs,
        model: input.models?.[name],
      };
      const res = await adapter.run(opts);
      entry.result = res;
      entry.costUsd = adapter.estimateCost(res.tokens, res.modelUsed);
    })());
  }

  await Promise.allSettled(runPromises);

  return {
    prompt: input.prompt,
    workdir: input.workdir,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    entries,
  };
}

export function formatTable(report: BenchmarkReport): string {
  const header = `Model                Latency   In→Out Tokens       Cost       Quality   Tool Calls   Notes`;
  const sep = '-'.repeat(header.length);
  const rows: string[] = [header, sep];
  for (const e of report.entries) {
    if (!e.available) {
      rows.push(`${pad(e.provider, 20)} ${pad('-', 9)} ${pad('-', 20)} ${pad('-', 10)} ${pad('-', 9)} ${pad('-', 12)} unavailable: ${e.unavailable_reason ?? 'unknown'}`);
      continue;
    }
    const r = e.result!;
    if (r.error) {
      rows.push(`${pad(r.modelUsed, 20)} ${pad(msToStr(r.durationMs), 9)} ${pad(`${r.tokens.input}→${r.tokens.output}`, 20)} ${pad(fmtCost(e.costUsd), 10)} ${pad('-', 9)} ${pad(String(r.toolCalls), 12)} ERROR ${r.error.code}: ${r.error.reason.slice(0, 40)}`);
      continue;
    }
    const quality = e.qualityScore !== undefined ? `${e.qualityScore.toFixed(1)}/10` : '-';
    rows.push(`${pad(r.modelUsed, 20)} ${pad(msToStr(r.durationMs), 9)} ${pad(`${r.tokens.input}→${r.tokens.output}`, 20)} ${pad(fmtCost(e.costUsd), 10)} ${pad(quality, 9)} ${pad(String(r.toolCalls), 12)}`);
  }
  return rows.join('\n');
}

export function formatJson(report: BenchmarkReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    `# Benchmark report — ${report.startedAt}`,
    '',
    `**Prompt:** ${report.prompt.length > 200 ? report.prompt.slice(0, 200) + '…' : report.prompt}`,
    `**Workdir:** \`${report.workdir}\``,
    `**Total duration:** ${msToStr(report.durationMs)}`,
    '',
    '| Model | Latency | Tokens (in→out) | Cost | Quality | Tools | Notes |',
    '|-------|---------|-----------------|------|---------|-------|-------|',
  ];
  for (const e of report.entries) {
    if (!e.available) {
      lines.push(`| ${e.provider} | - | - | - | - | - | unavailable: ${e.unavailable_reason ?? 'unknown'} |`);
      continue;
    }
    const r = e.result!;
    if (r.error) {
      lines.push(`| ${r.modelUsed} | ${msToStr(r.durationMs)} | ${r.tokens.input}→${r.tokens.output} | ${fmtCost(e.costUsd)} | - | ${r.toolCalls} | ERROR ${r.error.code}: ${r.error.reason.slice(0, 80)} |`);
      continue;
    }
    const quality = e.qualityScore !== undefined ? `${e.qualityScore.toFixed(1)}/10` : '-';
    lines.push(`| ${r.modelUsed} | ${msToStr(r.durationMs)} | ${r.tokens.input}→${r.tokens.output} | ${fmtCost(e.costUsd)} | ${quality} | ${r.toolCalls} | |`);
  }
  return lines.join('\n');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function msToStr(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd?: number): string {
  if (usd === undefined) return '-';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
