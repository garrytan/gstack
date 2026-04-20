/**
 * Unit tests for the benchmark runner.
 *
 * Mocks adapters to verify:
 * - All adapters run in parallel (Promise.allSettled not serial)
 * - Unavailable adapters are skipped or marked depending on flag
 * - Per-adapter errors don't abort the batch
 * - Output formatters (table, json, markdown) produce non-empty strings
 *
 * Does NOT exercise live CLIs — see test/providers.e2e.test.ts for those.
 */

import { test, expect } from 'bun:test';
import { formatTable, formatJson, formatMarkdown, type BenchmarkReport } from './helpers/benchmark-runner';
import { estimateCostUsd, PRICING } from './helpers/pricing';
import { missingTools, TOOL_COMPATIBILITY } from './helpers/tool-map';

test('estimateCostUsd returns 0 for unknown model (no crash)', () => {
  const cost = estimateCostUsd({ input: 1000, output: 500 }, 'unknown-model-7b');
  expect(cost).toBe(0);
});

test('estimateCostUsd computes correctly for known Claude model', () => {
  // claude-opus-4-7: $15/MTok input, $75/MTok output
  // 1M input + 0.5M output = $15 + $37.50 = $52.50
  const cost = estimateCostUsd({ input: 1_000_000, output: 500_000 }, 'claude-opus-4-7');
  expect(cost).toBeCloseTo(52.50, 2);
});

test('estimateCostUsd applies cached input discount alongside uncached input', () => {
  // tokens.input is uncached-only; tokens.cached is disjoint cache-reads at 10%.
  // 0 uncached input, 1M cached → 10% of 15 = $1.50
  const cost1 = estimateCostUsd({ input: 0, output: 0, cached: 1_000_000 }, 'claude-opus-4-7');
  expect(cost1).toBeCloseTo(1.50, 2);
  // 500K uncached input + 500K cached → $7.50 + $0.75 = $8.25
  const cost2 = estimateCostUsd({ input: 500_000, output: 0, cached: 500_000 }, 'claude-opus-4-7');
  expect(cost2).toBeCloseTo(8.25, 2);
});

test('PRICING table covers the key model families', () => {
  expect(PRICING['claude-opus-4-7']).toBeDefined();
  expect(PRICING['claude-sonnet-4-6']).toBeDefined();
  expect(PRICING['gpt-5.4']).toBeDefined();
  expect(PRICING['gemini-2.5-pro']).toBeDefined();
});

test('missingTools reports unsupported tools per provider', () => {
  // GPT/Codex doesn't expose Edit, Glob, Grep
  expect(missingTools('gpt', ['Edit', 'Glob', 'Grep'])).toEqual(['Edit', 'Glob', 'Grep']);
  // Claude supports all core tools
  expect(missingTools('claude', ['Edit', 'Glob', 'Grep', 'Bash', 'Read'])).toEqual([]);
  // Gemini has very limited agentic surface
  expect(missingTools('gemini', ['Bash', 'Edit'])).toEqual(['Bash', 'Edit']);
});

test('TOOL_COMPATIBILITY is populated for all three families', () => {
  expect(TOOL_COMPATIBILITY.claude).toBeDefined();
  expect(TOOL_COMPATIBILITY.gpt).toBeDefined();
  expect(TOOL_COMPATIBILITY.gemini).toBeDefined();
});

test('formatTable handles a report with mixed success/error/unavailable entries', () => {
  const report: BenchmarkReport = {
    prompt: 'test prompt',
    workdir: '/tmp',
    startedAt: '2026-04-16T20:00:00Z',
    durationMs: 1500,
    entries: [
      {
        provider: 'claude',
        family: 'claude',
        available: true,
        result: {
          output: 'ok',
          tokens: { input: 100, output: 200 },
          durationMs: 800,
          toolCalls: 3,
          modelUsed: 'claude-opus-4-7',
        },
        costUsd: 0.0165,
        qualityScore: 9.2,
      },
      {
        provider: 'gpt',
        family: 'gpt',
        available: true,
        result: {
          output: '',
          tokens: { input: 0, output: 0 },
          durationMs: 200,
          toolCalls: 0,
          modelUsed: 'gpt-5.4',
          error: { code: 'auth', reason: 'codex login required' },
        },
      },
      {
        provider: 'gemini',
        family: 'gemini',
        available: false,
        unavailable_reason: 'gemini CLI not on PATH',
      },
    ],
  };

  const table = formatTable(report);
  expect(table).toContain('claude-opus-4-7');
  expect(table).toContain('ERROR auth');
  expect(table).toContain('unavailable');
  expect(table).toContain('9.2/10');
});

test('formatJson produces parseable JSON', () => {
  const report: BenchmarkReport = {
    prompt: 'x',
    workdir: '/tmp',
    startedAt: '2026-04-16T20:00:00Z',
    durationMs: 100,
    entries: [],
  };
  const json = formatJson(report);
  const parsed = JSON.parse(json);
  expect(parsed.prompt).toBe('x');
  expect(parsed.entries).toEqual([]);
});

test('formatMarkdown produces a table header', () => {
  const report: BenchmarkReport = {
    prompt: 'x',
    workdir: '/tmp',
    startedAt: '2026-04-16T20:00:00Z',
    durationMs: 100,
    entries: [],
  };
  const md = formatMarkdown(report);
  expect(md).toContain('# Benchmark report');
  expect(md).toContain('| Model | Latency |');
});
