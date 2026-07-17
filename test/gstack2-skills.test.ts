import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runParity } from '../scripts/gstack2/run-parity';

const ROOT = join(import.meta.dir, '..');

describe('GStack 2 skill parity', () => {
  test('preserves the pinned specialist corpus and generated evidence', () => {
    const result = runParity();
    expect(result.sources).toBe(55);
    expect(result.sections).toBe(16);
    expect(result.regressions).toBe(16);
  }, 30_000);

  test('keeps image generation host-native, optional, and provider-free', () => {
    const design = readFileSync(join(ROOT, 'skills', 'design', 'SKILL.md'), 'utf8');
    expect(design).toContain('Use host-native image generation');
    expect(design).toContain('keep it optional');
    expect(design).toContain('Never install an image provider, local model, weights, GPU runtime, or background image server');
  });

  test('does not overclaim safety-hook enforcement in portable installs', () => {
    const debug = readFileSync(join(ROOT, 'skills', 'debug', 'SKILL.md'), 'utf8');
    expect(debug).toContain('inline advisory policy unless the active host explicitly confirms an installed hook');
    expect(debug).toContain('never claim every command is intercepted when no hook is active');
  });

  test('keeps the default catalog at least 75 percent below the measured 1.x baseline', () => {
    const baselineTokenEquivalents = 1_100;
    const catalogCharacters = ['plan', 'design', 'qa', 'debug', 'review', 'ship']
      .map((skill) => readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8'))
      .reduce((total, body) => {
        const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
        const descriptionBlock = body.match(/^description:\s*>-\r?\n((?:  .*\r?\n)+)/m)?.[1] ?? '';
        const description = descriptionBlock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ');
        expect(name).not.toBe('');
        expect(description).not.toBe('');
        return total + name.length + description.length;
      }, 0);
    const estimatedTokens = Math.ceil(catalogCharacters / 4);
    expect(estimatedTokens).toBeLessThanOrEqual(Math.floor(baselineTokenEquivalents * 0.25));
  });
});
