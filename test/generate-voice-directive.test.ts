import { describe, expect, test } from 'bun:test';
import { generateVoiceDirective } from '../scripts/resolvers/preamble/generate-voice-directive';

describe('generateVoiceDirective', () => {
  test('forbids both stock phrase spellings', () => {
    const directive = generateVoiceDirective(2);

    expect(directive).toContain('"load-bearing"');
    expect(directive).toContain('"load bearing"');
    expect(directive).toContain('State what depends on the thing instead.');
  });
});
