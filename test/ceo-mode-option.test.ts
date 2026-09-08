import { describe, expect, test } from 'bun:test';
import { findCeoModeOption } from './helpers/ceo-mode-option';
import { parseNumberedOptions, stripAnsi } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

describe('CEO mode option matching', () => {
  test('selects option 4 from the failed Claude Code 2.1.257 menu capture', () => {
    // Labels and side-pane residue from the 2026-09-08 paid failure. The
    // option existed; literal includes("SCOPE EXPANSION") could not see it.
    // The failure log preserves parsed labels, not the original raw frame.
    const options = [
      { index: 1, label: 'SELECTIVEEXPANSION┌────────────────────────────────────────────────────────────────────────────────────┐\r    (ecommnded)                │SELECTIVEEXPANSION│' },
      { index: 2, label: 'HOLD SCOPE                  │  Hld scope: eview rigorusly fr failure modes, edg ass, observability.│' },
      { index: 3, label: 'SCOPE REDUCTION              │   Then surface: cherry-pikableadditions you ca Accept/Defer/Skip.│' },
      { index: 4, label: 'SCOPEEXPANSION│Neutralposture:presentopportunities,stateeffort,youdecide.│\r                           │  Good for: substantialfeaturewithsolidfoundation,shippedbeforescopelock.│\r└────────────────────────────────────────────────────────────────────────────────────┘' },
    ];
    expect(findCeoModeOption(options, 'SCOPE EXPANSION')).toBe(4);
    expect(findCeoModeOption(options, 'HOLD SCOPE')).toBe(2);
    expect(findCeoModeOption(options, 'SELECTIVE EXPANSION')).toBe(1);
  });

  test('recognizes the mode question when every label loses its inter-word spaces', () => {
    const frame = stripAnsi([
      '❯ 1. HOLD\x1b[1CSCOPE (recommended)',
      '  2. SELECTIVE\x1b[1CEXPANSION',
      '  3. SCOPE\x1b[1CEXPANSION',
      '  4. SCOPE\x1b[1CREDUCTION',
    ].join('\n'));
    const options = parseNumberedOptions(frame);
    expect(findCeoModeOption(options, 'SCOPE EXPANSION')).toBe(3);
    expect(findCeoModeOption(options, 'SCOPE REDUCTION')).toBe(4);
  });

  test('retains spaced, mixed-case labels and recommendation suffixes', () => {
    expect(findCeoModeOption([
      { index: 1, label: 'Scope Expansion (recommended)' },
      { index: 2, label: 'HOLD SCOPE' },
    ], 'SCOPE EXPANSION')).toBe(1);
  });

  test('still fails on the earlier three-option capture with no expansion target', () => {
    const options = [
      { index: 1, label: 'HOLD SCOPE (recommended)    ┌─────────────────────────────────────────────────────────────┐' },
      { index: 2, label: 'SELECTIVE EXPANSION        │HOLD SCOPE                                             │' },
      { index: 3, label: 'SCOPE REDUCTION             │   Codeiswritten.Makeitbulletproof.│' },
    ];
    expect(() => findCeoModeOption(options, 'SCOPE EXPANSION'))
      .toThrow('target "SCOPE EXPANSION" not in option labels');
  });

  test('does not select another mode because the side pane mentions the target', () => {
    expect(() => findCeoModeOption([
      { index: 1, label: 'HOLD SCOPE │ SCOPE EXPANSION is another option' },
      { index: 2, label: 'SELECTIVEEXPANSION┌ SCOPEEXPANSION' },
    ], 'SCOPE EXPANSION')).toThrow('target "SCOPE EXPANSION" not in option labels');
  });

  test('leaves unrelated navigation questions to the existing driver', () => {
    expect(findCeoModeOption([
      { index: 1, label: 'Review HOLD SCOPE examples' },
      { index: 2, label: 'Choose a plan │ SCOPE EXPANSION' },
    ], 'HOLD SCOPE')).toBeNull();
  });

  test('helper and regression changes select only the mode-routing paid eval', () => {
    for (const file of ['test/helpers/ceo-mode-option.ts', 'test/ceo-mode-option.test.ts']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-ceo-mode-routing']);
    }
  });
});
