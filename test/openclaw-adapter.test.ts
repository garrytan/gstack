/**
 * scripts/host-adapters/openclaw-adapter.ts — post-processing content transform.
 *
 * Zero coverage before this file: gen-skill-docs' idempotency test only asserts
 * that an adapter exists, never what it produces. OpenClaw has no
 * AskUserQuestion tool and no Agent tool, so a regression here ships skills
 * that instruct the agent to call tools it does not have — a silent runtime
 * failure on a host we don't run evals against.
 */

import { describe, test, expect } from 'bun:test';
import { transform } from '../scripts/host-adapters/openclaw-adapter';
import { openclaw } from '../hosts/index';

const config = openclaw;

describe('AskUserQuestion → prose', () => {
  test('bare references become chat instructions', () => {
    expect(transform('Call AskUserQuestion with two options.', config)).toBe(
      'Call ask the user directly in chat with two options.',
    );
  });

  test('every occurrence is rewritten, not just the first', () => {
    const out = transform('AskUserQuestion once, AskUserQuestion twice.', config);
    expect(out).not.toContain('AskUserQuestion');
    expect(out.match(/ask the user directly in chat/g)!.length).toBe(2);
  });

  test('"Use AskUserQuestion" phrasing still loses the tool name', () => {
    // The bare replacement runs first, so the "Use ..." rules never match. What
    // matters for OpenClaw is that no tool name survives; the sentence reads
    // "Use ask the user directly in chat".
    const out = transform('Use AskUserQuestion to confirm.', config);
    expect(out).not.toContain('AskUserQuestion');
    expect(out).toContain('ask the user directly in chat');
  });
});

describe('Agent tool → sessions_spawn', () => {
  test('"the Agent tool" and bare "Agent tool" both map to sessions_spawn', () => {
    expect(transform('Spawn via the Agent tool.', config)).toBe('Spawn via sessions_spawn.');
    expect(transform('Agent tool spawns workers.', config)).toBe('sessions_spawn spawns workers.');
  });

  test('subagent_type parameter is renamed', () => {
    expect(transform('Pass subagent_type: general-purpose.', config)).toBe(
      'Pass task parameter: general-purpose.',
    );
  });

  test('unrelated uses of "Agent" are left alone', () => {
    expect(transform('The Agent SDK runner.', config)).toBe('The Agent SDK runner.');
  });
});

describe('browse binary patterns', () => {
  test('inline `$B commands become exec-based', () => {
    expect(transform('Run `$B goto https://x` first.', config)).toBe(
      'Run `exec $B goto https://x` first.',
    );
  });

  test('$B outside a code span is untouched', () => {
    expect(transform('The $B binary.', config)).toBe('The $B binary.');
  });

  test('already-exec-prefixed spans are not double-prefixed', () => {
    expect(transform('`exec $B goto x`', config)).toBe('`exec $B goto x`');
  });
});

describe('gstack bin references', () => {
  test('openclaw skill bin paths survive the transform verbatim', () => {
    const line = 'eval "$(~/.openclaw/skills/gstack/bin/gstack-slug)"';
    expect(transform(line, config)).toBe(line);
  });
});

describe('general contract', () => {
  test('content with nothing to rewrite is returned unchanged', () => {
    const content = '---\nname: gstack-review\n---\n\n# Review\nNo host-specific tokens here.\n';
    expect(transform(content, config)).toBe(content);
  });

  test('empty input is handled', () => {
    expect(transform('', config)).toBe('');
  });

  test('transform is idempotent (gen-skill-docs may re-run over output)', () => {
    const content = [
      'Use AskUserQuestion to confirm, then spawn via the Agent tool',
      'with subagent_type: general-purpose and run `$B goto https://x`.',
    ].join('\n');
    const once = transform(content, config);
    expect(transform(once, config)).toBe(once);
  });
});
