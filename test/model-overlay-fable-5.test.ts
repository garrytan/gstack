/**
 * Fable 5 model overlay — gate-tier assertions on the family nudges.
 *
 * fable-5 inherits the claude base and adds Fable-family nudges: act when you
 * have enough context (avoid over-planning), ground progress claims in tool
 * results, assessment-vs-action boundaries, and delegate independent work.
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

describe('Fable 5 overlay — family nudges', () => {
  test('raw fable-5.md contains the act-when-ready nudge', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'model-overlays/fable-5.md'), 'utf-8');
    expect(raw).toContain('Act when you have enough to act');
  });

  test('resolved overlay inherits from claude base (INHERIT:claude)', () => {
    const out = generateModelOverlay(makeCtx('fable-5'));
    expect(out).toContain('Todo-list discipline');
    expect(out).toContain('subordinate');
  });

  test('resolved overlay carries the Fable nudges', () => {
    const out = generateModelOverlay(makeCtx('fable-5'));
    expect(out).toContain('Act when you have enough to act');
    expect(out).toContain('Ground progress claims in evidence');
  });

  test('resolved overlay has no unresolved INHERIT directive', () => {
    const out = generateModelOverlay(makeCtx('fable-5'));
    expect(out).not.toContain('{{INHERIT:');
  });

  test('claude overlay (base) does not carry the Fable nudge', () => {
    const out = generateModelOverlay(makeCtx('claude'));
    expect(out).not.toContain('Act when you have enough to act');
  });
});
