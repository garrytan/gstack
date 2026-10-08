import { describe, expect, test } from 'bun:test';
import { generateVoiceDirective } from '../scripts/resolvers/preamble/generate-voice-directive';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude };
const tiers: number[] = [1, 3];

describe('shared voice directive', () => {
  test.each(tiers)('tier %i bans the load-bearing stock phrase on the AI-vocabulary line', tier => {
    const banLine = generateVoiceDirective(ctx, tier).split('\n').find(line => line.includes('No AI vocabulary:'));
    expect(banLine).toBeDefined();
    expect(banLine!).toContain('load-bearing');
  });
});
