/**
 * Unit tests for assertRequiredReads (v2 plan T9 mitigation layer 5). Pure logic
 * over synthetic tool-call transcripts — the section-loading E2E (paid) drives
 * this against real /ship runs.
 */

import { describe, test, expect } from 'bun:test';
import { assertRequiredReads } from './helpers/required-reads';
import type { ToolCallLike } from './helpers/transcript-section-logger';

const read = (fp: string): ToolCallLike => ({ tool: 'Read', input: { file_path: fp }, output: '' });

describe('assertRequiredReads', () => {
  test('passes when every required section was Read', () => {
    const result = {
      toolCalls: [
        read('/Users/x/.claude/skills/gstack/ship/sections/review-army.md'),
        read('ship/sections/pr-body.md'),
      ],
    };
    const r = assertRequiredReads(result, ['review-army.md', 'pr-body.md']);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test('flags a required section the agent never opened', () => {
    const result = { toolCalls: [read('ship/sections/pr-body.md')] };
    const r = assertRequiredReads(result, ['review-army.md', 'pr-body.md']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['review-army.md']);
  });

  test('tolerates a sections/ prefix in the required list', () => {
    const result = { toolCalls: [read('/abs/gstack/ship/sections/review-army.md')] };
    expect(assertRequiredReads(result, ['sections/review-army.md']).ok).toBe(true);
  });

  test('empty required set always passes', () => {
    expect(assertRequiredReads({ toolCalls: [] }, []).ok).toBe(true);
  });
});
