/**
 * Unit tests for benchmark pricing + tool-compatibility helpers.
 *
 * Orchestration, scoring, and reporting moved to Braintrust
 * (lib/model-benchmark/braintrust-eval.ts); those are covered by
 * model-benchmark-braintrust.test.ts and the live e2e suite.
 */

import { test, expect } from 'bun:test';
import { estimateCostUsd, PRICING } from '../lib/model-benchmark/pricing';
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
