/**
 * Pins single-logical-line AskUserQuestion detection (the plan-design-with-ui
 * gate-timeout class). When the PTY reflows a boxed AskUserQuestion, ALL
 * options land on ONE logical line after stripAnsi — the per-line option
 * parser then finds only option 1 and the >= 2 check fails forever while the
 * (correct) question sits on screen. Both fixture strings below are condensed
 * from REAL observed failure buffers of
 * test/skill-e2e-plan-design-with-ui.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import {
  isNumberedOptionListVisible,
  parseNumberedOptions,
  stripPtyResidue,
} from './helpers/claude-pty-runner';

// Condensed from the 2026-08-13 failure buffer: whole AskUserQuestion on one
// logical line — dividers, cursor option, options 2-5, footer. Note the
// missing spaces ("2.Planordesigndoc") from stripped cursor-positioning
// escapes.
const SINGLE_LINE_QUESTION =
  '────────────Planning: /tmp/x/.claude/plans/soft-questing-jellyfish.md──────────' +
  ' ☐ Review target What should I review? <gstack-qid:plan-design-review-scope-gate>' +
  '❯1.Branch diff (current WIP)     Review the design implications of what changed. ' +
  'Recommendation: A when a branch diff exists.2.Planordesigndoc   Paste or point me to a plan file. ' +
  '3. Spcific page, file, r pah   Name a specific file. 4. Type something.' +
  '────────────5.ChataboutthisEnter to select · ↑/↓ o navigate · Escto cancel';

// The same AskUserQuestion with DEC cursor-visibility residue + spinner
// frames interleaved, as captured before stripPtyResidue existed.
const RESIDUE_QUESTION =
  '[?25l✻Sprouting…[?25h[?25l✶[?25h' + SINGLE_LINE_QUESTION.slice(0, 200) +
  '[?25l·still thinking[?25h' + SINGLE_LINE_QUESTION.slice(200);

describe('single-logical-line AskUserQuestion detection', () => {
  it('isNumberedOptionListVisible matches the reflowed one-line AskUserQuestion', () => {
    expect(isNumberedOptionListVisible(SINGLE_LINE_QUESTION)).toBe(true);
  });

  it('parseNumberedOptions finds the full ascending option run on one line', () => {
    const options = parseNumberedOptions(SINGLE_LINE_QUESTION);
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]).toEqual({ index: 1, label: expect.stringContaining('Branch diff') });
    expect(options[1]?.index).toBe(2);
  });

  it('survives DEC residue + spinner interleave', () => {
    expect(isNumberedOptionListVisible(RESIDUE_QUESTION)).toBe(true);
    expect(parseNumberedOptions(RESIDUE_QUESTION).length).toBeGreaterThanOrEqual(2);
  });

  it('stripPtyResidue removes cursor-visibility fragments only', () => {
    expect(stripPtyResidue('[?25la[?25hb')).toBe('ab');
    expect(stripPtyResidue('keep [?250] this')).toBe('keep [?250] this');
  });

  it('still rejects prose numbered lists (no cursor sigil)', () => {
    expect(parseNumberedOptions('steps: 1. Read the file 2. Edit it 3. Done')).toEqual([]);
  });

  it('still parses classic multi-line AskUserQuestions', () => {
    const multiLine = 'What should I do?\n❯ 1. First option\n  2. Second option\n  3. Third option\n';
    const options = parseNumberedOptions(multiLine);
    expect(options.map((o) => o.index)).toEqual([1, 2, 3]);
  });
});
