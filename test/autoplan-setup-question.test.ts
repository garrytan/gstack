import { describe, expect, test } from 'bun:test';
import { autoplanRoutingSetupInput } from './helpers/autoplan-setup-question';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

// Sanitized terminal frame from the 2026-09-08 autoplan timeout. The qid is
// visibly incomplete; the prompt body and explicit choices remain intact.
const CAPTURE = [
  '─'.repeat(120),
  'Planning: /tmp/hermetic/.claude/plans/modular-bouncing-swing.md',
  '─'.repeat(120),
  ' ☐ Routing rules',
  "│ gstack works best when your project's CLAUDE.md includes skill routing rules. Add them now?",
  '│<gstck-qid:routing-injectin>',
  '❯1.Addroutingrules(Recommended)',
  'CreatesCLAUDE.mdwithskillroutingrulessogstackknowswhentoinvoke/office-hours,/autoplan,/ship,/qa,',
  "etc.automatically.We'lldothisafterthereview.",
  '2.Nothanks',
  "Skip—I'llinvokeskillsmanually.Youcanenablethislaterbyrunninggstack-configsetrouting_declinedfalse.",
  '3.Typesomething.',
  '4.Chataboutthis',
  'Entertoselect·↑/↓tonavigate·Esctocancel',
].join('\r\r');

describe('autoplan routing setup handling', () => {
  test('answers the captured setup once, using the full question identity', () => {
    const seen = new Set<string>();
    expect(autoplanRoutingSetupInput(CAPTURE, seen)).toBe('1\r');
    expect(autoplanRoutingSetupInput(CAPTURE, seen)).toBeNull();
    expect(autoplanRoutingSetupInput(CAPTURE.replace('works best', 'works   best'), seen)).toBeNull();
  });

  test('chooses Add routing rules by label when option order changes', () => {
    const reordered = CAPTURE.replace('❯1.Addroutingrules(Recommended)', '❯1.Nothanks')
      .replace('2.Nothanks', '2.Add routing rules (Recommended)');
    expect(autoplanRoutingSetupInput(reordered, new Set())).toBe('2\r');
  });

  test('accepts the full option labels captured from the subsequent live setup prompt', () => {
    const fullLabels = CAPTURE.replace('Addroutingrules(Recommended)', 'Add routing rules to CLAUDE.md (Recommended)')
      .replace('2.Nothanks', "2.No thanks, I'll invoke skills manually");
    expect(autoplanRoutingSetupInput(fullLabels, new Set())).toBe('1\r');
    expect(autoplanRoutingSetupInput(fullLabels.replace('CLAUDE.md (Recommended)', 'product routes (Recommended)'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(fullLabels.replace("I'll invoke skills manually", 'delete the existing rules'), new Set())).toBeNull();
  });

  test('waits for complete recognized choices rather than guessing a default', () => {
    expect(autoplanRoutingSetupInput(CAPTURE.replace('2.Nothanks', '2.Ask me later'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput(CAPTURE.replace('Addroutingrules(Recommended)', 'Accept recommendation'), new Set())).toBeNull();
    expect(autoplanRoutingSetupInput('❯1.Addroutingrules(Recommended)\r2.Nothanks', new Set())).toBeNull();
  });

  test('never answers review or taste questions, even with a routing qid or the same choices', () => {
    const prompts = [
      'Which visual direction should this settings page use?',
      'Should the payment handler bypass the existing dispatcher?',
      'Add routing rules to the product API now? <gstack-qid:routing-injection>',
      'The plan quotes CLAUDE.md skill routing rules. Should we change this feature?',
    ];
    for (const prompt of prompts) {
      const frame = `☐ Review decision\r${prompt}\r❯1.Addroutingrules(Recommended)\r2.Nothanks`;
      expect(autoplanRoutingSetupInput(frame, new Set())).toBeNull();
    }
  });

  test('setup helper and captured-frame changes select the autoplan eval only', () => {
    for (const file of ['test/helpers/autoplan-setup-question.ts', 'test/autoplan-setup-question.test.ts']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
    }
  });
});
