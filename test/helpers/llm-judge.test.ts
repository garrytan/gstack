import { describe, test, expect } from 'bun:test';
import { extractAssistantText } from './llm-judge';

describe('extractAssistantText', () => {
  test('uses completed Codex agent messages and ignores started duplicates', () => {
    const stdout = [
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_0","type":"agent_message","text":"Planning..."}}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"winner\\":\\"B\\",\\"reasoning\\":\\"clearer\\"}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
    ].join('\n');

    expect(extractAssistantText(stdout)).toBe('{"winner":"B","reasoning":"clearer"}');
  });

  test('joins multiple completed agent messages in order', () => {
    const stdout = [
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"First line"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Second line"}}',
    ].join('\n');

    expect(extractAssistantText(stdout)).toBe('First line\nSecond line');
  });
});
