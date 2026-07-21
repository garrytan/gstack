/**
 * Unit tests for benchmark tool-compatibility helpers.
 *
 * Orchestration and scoring moved to Braintrust (lib/model-benchmark/braintrust-eval.ts);
 * per-provider token/cost tracking was removed with the JSON-schema parsers.
 * Provider capability coverage is what's left to pin here.
 */

import { test, expect } from 'bun:test';
import { missingTools, TOOL_COMPATIBILITY } from './helpers/tool-map';

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
