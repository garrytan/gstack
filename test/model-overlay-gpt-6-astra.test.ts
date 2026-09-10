import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resolveModel } from '../scripts/models';
import { generateModelOverlay } from '../scripts/resolvers/model-overlay';
import type { TemplateContext } from '../scripts/resolvers/types';

function ctx(model: TemplateContext['model']): TemplateContext {
  return {
    skillName: 'investigate',
    tmplPath: 'investigate/SKILL.md.tmpl',
    host: 'codex',
    paths: {
      skillRoot: '$GSTACK_ROOT',
      localSkillRoot: '.agents/skills/gstack',
      binDir: '$GSTACK_BIN',
      browseDir: '$GSTACK_BROWSE',
      designDir: '$GSTACK_DESIGN',
      makePdfDir: '$GSTACK_MAKE_PDF',
    },
    preambleTier: 3,
    model,
  };
}

describe('GPT-6 Astra model profile', () => {
  test('exact and suffixed Astra IDs select the Astra profile', () => {
    expect(resolveModel('gpt-6-astra')).toBe('gpt-6-astra');
    expect(resolveModel('gpt-6-astra-2026-09-01')).toBe('gpt-6-astra');
  });

  test('overlay inherits generic GPT guidance', () => {
    const raw = fs.readFileSync(path.resolve(import.meta.dir, '..', 'model-overlays/gpt-6-astra.md'), 'utf-8');
    expect(raw).toContain('{{INHERIT:gpt}}');

    const out = generateModelOverlay(ctx('gpt-6-astra'));
    expect(out).toContain('make your best judgment and proceed');
    expect(out).toContain('Prefer decisive execution once scope is clear');
    expect(out).not.toContain('{{INHERIT:');
  });
});
