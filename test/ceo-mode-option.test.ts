import { describe, expect, test } from 'bun:test';
import { findCeoModeOption, hasPostAnswerCeoPosture, nextCeoModeNavigation } from './helpers/ceo-mode-option';
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
    for (const file of ['test/helpers/ceo-mode-option.ts', 'test/ceo-mode-option.test.ts', 'test/pty-option-selection.test.ts']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['plan-ceo-mode-routing']);
    }
  });
});

describe('CEO mode navigation replay', () => {
  test('advances different setup questions with the same choices and ignores redraws', () => {
    const seen = new Set<string>();
    const first = '☐Routing\rEnable skill routing?\r❯1.Enable\r2.Skip';
    const next = '☐Learnings\rEnable cross-project learnings?\r❯1.Enable\r2.Skip';
    expect(nextCeoModeNavigation(first, 'HOLD SCOPE', seen).kind).toBe('question');
    expect(nextCeoModeNavigation(first, 'HOLD SCOPE', seen).kind).toBe('wait');
    expect(nextCeoModeNavigation(next, 'HOLD SCOPE', seen).kind).toBe('question');
    expect(seen.size).toBe(2);
  });

  test('navigates the captured unanswered setup tab before submitting, without counting Submit', () => {
    const seen = new Set<string>();
    const partial = [
      '← ☒ Skill routing ☐ Learnings scope ✔ Submit →',
      'Review your answers',
      '⚠You have not answered all questions',
      '❯1.Submit aswers',
      '2Cancel',
    ].join('\r\r');
    expect(nextCeoModeNavigation(partial, 'HOLD SCOPE', seen)).toEqual({ kind: 'submission', input: '\x1b[Z' });
    expect(seen.size).toBe(0);
    const question = '← ☒ Skill routing ☐ Learnings scope ✔ Submit →\rEnable cross-project learnings?\r❯1.Enable\r2.Skip';
    expect(nextCeoModeNavigation(`${partial}\r${question}`, 'HOLD SCOPE', seen).kind).toBe('question');
    const answered = partial.replace('☐ Learnings scope', '☒ Learnings scope').replace('⚠You have not answered all questions', '');
    expect(nextCeoModeNavigation(answered, 'HOLD SCOPE', seen)).toEqual({ kind: 'submission', input: '\r' });
    expect(seen.size).toBe(1);
  });

  test('handles native permission controls before question parsing and dedup', () => {
    const seen = new Set<string>();
    const permission = 'DoyouwanttooverwriteCLAUDE.md?\r❯1.Yes\r2.No\rEsctocancel·Tabtoamend';
    expect(nextCeoModeNavigation(permission, 'HOLD SCOPE', seen)).toEqual({ kind: 'permission', input: '1\r' });
    expect(seen.size).toBe(0);
    const actual = '☐ Approaches\rWhich storage strategy?\r❯1.Server\r2.Local';
    expect(nextCeoModeNavigation(`${permission}\r${actual}`, 'HOLD SCOPE', seen).kind).toBe('question');
  });

  test('selects the intended mode from the observed menu, preserving its index', () => {
    const frame = '☐ReviewMode\rWhat review posture should I use?\r❯1.SELECTIVEEXPANSION(recommended)\r2.HOLDSCOPE\r3.SCOPEEXPANSION\r4.SCOPEREDUCTION';
    for (const [mode, index] of [['HOLD SCOPE', 2], ['SCOPE EXPANSION', 3]] as const) {
      const action = nextCeoModeNavigation(frame, mode, new Set());
      expect(action.kind).toBe('mode');
      if (action.kind === 'mode') expect(action.index).toBe(index);
    }
  });
});

describe('CEO posture evidence after mode selection', () => {
  const posture = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;
  const menu = [
    '☐ Review mode',
    '❯1.SELECTIVEEXPANSION(recommended)',
    '2.HOLD SCOPE │ Code is written. Make it bulletproof.',
    '3.SCOPE EXPANSION',
    '4.SCOPE REDUCTION',
    'Enter to select · ↑/↓ to navigate',
  ].join('\r');

  test('menu redraw and native selected-option echo cannot satisfy the posture gate', () => {
    expect(posture.test(menu)).toBe(true); // The old unscoped check passed here.
    expect(hasPostAnswerCeoPosture(menu, posture)).toBe(false);
    const answer = "⏺ User answered Claude's questions:\r⎿ · Review mode? → HOLD SCOPE";
    expect(hasPostAnswerCeoPosture(`${menu}\r${answer}`, posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('❯ HOLD SCOPE\r● HOLD SCOPE', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('● Selected option: HOLD SCOPE', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('● HOLD SCOPE\r✶ Honking… (5s · ↓ 300 tokens)', posture)).toBe(false);
  });

  test('assistant output must itself contain the existing posture evidence', () => {
    expect(hasPostAnswerCeoPosture(`${menu}\r● I will inspect the plan now.`, posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('⏺ Read(plan-ceo-review/SKILL.md)\r  Review with maximum rigor.', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture('● high · /effort\rHOLD SCOPE', posture)).toBe(false);
    expect(hasPostAnswerCeoPosture(`● I will inspect the plan now.\r${menu}`, posture)).toBe(false);
  });

  test('accepts new assistant posture after the answered-question echo, including wrapped prose', () => {
    const answer = "⏺UseransweredClaude'squestions:\r⎿Reviewmode?→HOLDSCOPE";
    expect(hasPostAnswerCeoPosture(`${answer}\r● HOLD SCOPE. I will review the existing scope for failure modes.`, posture)).toBe(true);
    expect(hasPostAnswerCeoPosture(`${answer}\r⏺\rI will apply maximum rigor\rto the agreed scope.`, posture)).toBe(true);
    const expansion = /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i;
    expect(hasPostAnswerCeoPosture(`${answer}\r● I will explore expansion opportunities that improve the saved-view workflow.`, expansion)).toBe(true);
  });
});
