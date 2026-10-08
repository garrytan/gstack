import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateVoiceDirective } from '../scripts/resolvers/preamble/generate-voice-directive';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { between, expectMentions } from './helpers/prompt-structure';

const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude };
const tiers: number[] = [1, 3];

describe('shared voice directive', () => {
  test.each(tiers)('tier %i bans the load-bearing stock phrase on the AI-vocabulary line', tier => {
    const banLine = generateVoiceDirective(ctx, tier).split('\n').find(line => line.includes('No AI vocabulary:'));
    expect(banLine).toBeDefined();
    expect(banLine!).toContain('load-bearing');
  });

  test.each(tiers)('tier %i replies in the language of the latest message and keeps technical text verbatim', tier => {
    const voice = generateVoiceDirective(ctx, tier);
    expectMentions(voice, [
      ['reply', 'language', "user's latest message", 'unless'],
      ['code', 'commands', 'paths', 'identifiers', 'quoted output', 'verbatim'],
    ], `tier ${tier} voice`);
    if (tier >= 2) expectMentions(voice, [['question markers', '`D<N>`', 'option letters', '`(recommended)`', 'verbatim']], 'tier 3 voice');
  });

  test('every generated skill with a Voice section carries the reply-language rule', () => {
    const root = join(import.meta.dir, '..');
    const skills = execFileSync('git', ['ls-files', 'SKILL.md', '*/SKILL.md'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).split('\n').filter(Boolean);
    const voiced = skills.filter(file => readFileSync(join(root, file), 'utf8').includes('\n## Voice\n'));
    expect(voiced.length).toBeGreaterThan(40);
    const missing = voiced.filter(file => {
      const voice = between(readFileSync(join(root, file), 'utf8'), '\n## Voice\n', /\n## /).toLowerCase();
      return !(voice.includes('language') && voice.includes('latest message') && voice.includes('verbatim'));
    });
    expect(missing).toEqual([]);
  });
});
