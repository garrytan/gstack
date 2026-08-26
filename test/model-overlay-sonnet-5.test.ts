/**
 * Sonnet 5 model overlay — gate-tier assertions on the family nudges.
 *
 * sonnet-5 inherits the claude base and adds Sonnet-5 family nudges: literal
 * instruction following (state scope explicitly), scope work to the request
 * (raise effort rather than prompting around shallow reasoning), and
 * verbosity that tracks task complexity.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateModelOverlay } from '../scripts/resolvers/model-overlay';

function makeCtx(model: string): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 2,
    model,
  };
}

const ROOT = path.resolve(__dirname, '..');

describe('Sonnet 5 overlay — family nudges', () => {
  test('raw sonnet-5.md contains the literal-instructions nudge', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'model-overlays/sonnet-5.md'), 'utf-8');
    expect(raw).toContain('Instructions are read literally');
  });

  test('resolved overlay inherits from claude base (INHERIT:claude)', () => {
    const out = generateModelOverlay(makeCtx('sonnet-5'));
    expect(out).toContain('Todo-list discipline');
    expect(out).toContain('subordinate');
  });

  test('resolved overlay carries the Sonnet 5 nudges', () => {
    const out = generateModelOverlay(makeCtx('sonnet-5'));
    expect(out).toContain('Instructions are read literally');
    expect(out).toContain('Scope work to the request');
  });

  test('resolved overlay has no unresolved INHERIT directive', () => {
    const out = generateModelOverlay(makeCtx('sonnet-5'));
    expect(out).not.toContain('{{INHERIT:');
  });

  test('claude overlay (base) does not carry the Sonnet 5 nudge', () => {
    const out = generateModelOverlay(makeCtx('claude'));
    expect(out).not.toContain('Instructions are read literally');
  });
});
