import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capturePlanCountQuestion, designFirstReviewAUQ, designStep0Boundary, hasNativePlanTerminal, nativePlanCallFingerprint, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCompletionHandoff, pickDesignCountQuestion } from './helpers/design-count-review';
import * as designReview from './helpers/design-count-review';
// The old caller had no setup callback; absence is equivalent to false.
const isDesignCountSetup = designReview.isDesignCountSetup ?? (() => false);
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import captured from './fixtures/design-review-j-calls.json';
import numberedPasses from './fixtures/design-review-l-calls.json';
import scoredPasses from './fixtures/design-review-n-calls.json';
import outsideCalls from './fixtures/design-outside-y-calls.json';
import boundaryCalls from './fixtures/design-boundaries-y-calls.json';
import gapCalls from './fixtures/design-gap-z-calls.json';

const calls = () => structuredClone(captured.calls) as NativePlanQuestionCall[];
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const handoff = () => calls().at(-1)!;
const numberedCalls = () => structuredClone(numberedPasses.calls) as NativePlanQuestionCall[];
function pending(call = handoff()) {
  call.answered = false;
  delete call.answers;
  delete call.unansweredQuestionIndices;
  return call;
}
function replay(input: NativePlanQuestionCall[], first = isDesignCountFirstReview) {
  let started = false;
  const counts = { step0: 0, review: 0, administrative: 0 };
  const phases = [];
  for (const call of input) {
    const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
      first, isDesignCountSetup, isDesignCompletionHandoff);
    if (phase.administrative) counts.administrative++;
    else if (phase.preReview) counts.step0++;
    else counts.review++;
    started = phase.reviewStarted;
    phases.push(phase);
  }
  return { ...counts, started, phases };
}

describe('a declared primary-action issue owns its native amendment and open gap', () => {
  // Minimal AZ public question and choices; the full transcript stays local.
  const current = (): NativePlanQuestionCall => {
    const question = 'D2 — Issue 1 (G1): make Save the visible primary action\n' +
      'Project/branch/task: main branch, account-settings header action group.\n' +
      'ELI10: Four header buttons currently share one style. A user who just edited their email has to read all four labels to find the one that stores the change.';
    const options = [
      {label: '1A Apply DESIGN.md token (recommended)', description: 'Save filled #1d4ed8 white; Reset, Cancel, Export neutral ghost. Verify ghost text and border contrast.'},
      {label: '1B Spacing-only separation', description: 'Keep four equal buttons, add a gap before Save. Violates DESIGN.md.'},
      {label: '1C Defer', description: 'Leave G1 open and record it as unresolved.'},
    ];
    return {sessionId: 'az-design', toolUseId: 'primary', answered: true, failed: false,
      unansweredQuestionIndices: [], answeredAt: '2026-09-11T04:04:10.000Z',
      questions: [{header: 'Issue 1', question, options, multiSelect: false}],
      answers: {[question]: options[0]!.label}};
  };
  const changed = (change: (q: NativePlanQuestionCall['questions'][number]) => void) => {
    const c = current(), q = c.questions[0]!; change(q);
    c.answers = {[q.question]: q.options[0]!.label}; return fingerprint(c);
  };
  test('the declared gap starts review for every offered answer, with optional question punctuation', () => {
    const c = current(), q = c.questions[0]!;
    for (const option of q.options) {
      c.answers = {[q.question]: option.label};
      expect(isDesignCountFirstReview(fingerprint(c))).toBe(true);
    }
    expect(isDesignCountFirstReview(changed(q => {q.question = q.question.replace('action\n', 'action?\n');}))).toBe(true);
    expect(isDesignCountFirstReview(changed(q => {
      q.question = q.question.replaceAll('Save', 'Publish').replace('(G1)', '(G7)').replace('Issue 1', 'Issue 3')
        .replace('Four', '4').replace('share one style', 'look identical').replace('\nELI10:', '\n[P1]\nELI10:');
      q.header = 'Issue 3';
      q.options = q.options.map(o => ({label: o.label.replace(/^1/, '3'), description: o.description.replaceAll('Save', 'Publish')
        .replace('#1d4ed8 white', '#ffee22 with black text').replace('Reset, Cancel, Export', 'Export/Reset/Cancel').replace('G1', 'G7')}));
    }))).toBe(true);
    expect(isDesignCountFirstReview(changed(q => {
      q.question = q.question.replace(' (G1)', ''); q.options[2]!.description = 'Leave Issue 1 open and record it as unresolved.';
    }))).toBe(true);
    expect(isDesignCountFirstReview(changed(q => {
      q.question = q.question.replace(' (G1)', '').replace('action\n', 'action?\n');
      q.options[2]!.description = 'Leave Issue 1 open and record it as unresolved.';
    }))).toBe(true);
  });
  test('current gap, distinct primary/peers, native authority and owned deferral are required together', () => {
    const changes: Array<(q: NativePlanQuestionCall['questions'][number]) => void> = [
      q => {q.question = q.question.replace('currently share', 'used to share');},
      q => {q.question = q.question.replace('Four', 'Three');},
      q => {q.question = q.question.replace('ELI10:', '> ELI10:');},
      q => {q.question = q.question.replace('Four header', 'If approved, four header');},
      q => {q.question += '\nELI10: Four header buttons currently share one style.';},
      q => {q.question = 'Historical example:\n' + q.question;},
      q => {q.question = q.question.replace('\nELI10:', '\nSource example:\nELI10:');},
      q => {q.header = 'Issue 2';},
      q => {q.options[0]!.description = q.options[0]!.description.replace('Save filled', 'Publish filled');},
      q => {q.options[0]!.description = q.options[0]!.description.replace('Reset, Cancel, Export', 'Save, Cancel, Export');},
      q => {q.options[0]!.description = q.options[0]!.description.replace('Reset, Cancel, Export', 'Reset, Cancel, Cancel');},
      q => {q.options[0]!.description = q.options[0]!.description.replace('#1d4ed8', 'blue');},
      q => {q.options[0]!.description = q.options[0]!.description.replace('neutral ghost', 'filled primary');},
      q => {q.options[0]!.label = '2A Apply DESIGN.md token (recommended)';},
      q => {q.options[0]!.label = '1A Prepare the review';},
      q => {q.options[1]!.description = q.options[0]!.description; q.options[0]!.description = 'Prepare the review.';},
      q => {q.options[2]!.label = '2C Defer';},
      q => {q.options[2]!.description = 'Leave G2 open and record it as unresolved.';},
      q => {q.options[2]!.description = 'Leave G1 closed and record it as resolved.';},
      q => {q.options[2]!.description = 'Prepare the next review.';},
      q => {q.question = q.question.replaceAll('Save', 'Fix'); q.options[0]!.description = 'This applies the next review step.';},
      q => {q.options[0]!.description += ' This amendment keeps all four header buttons identical.';},
      q => {q.options[2]!.description += ' Correction: do not leave G1 open.';},
      q => {q.options[2]!.description += ' Correction: never defer Issue 1.';},
      q => {q.question += ' G1 is historical.';},
      q => {q.options[0]!.description += ' This amendment applies only to another project.';},
    ];
    for (const change of changes) expect(isDesignCountFirstReview(changed(change)), change.toString()).toBe(false);
  });
  test('owned withdrawals and approval conditions cannot hide in any evidence body', () => {
    for (const suffix of [
      ' This finding is withdrawn.', ' Issue 1 is "closed".', ' G1 is ‘resolved’.',
      ' Assuming approval, proceed with this option.', ' G1 applies only if approved.',
      ' This finding requires approval.', ' This token contract is withdrawn.',
      ' G1 is "historical".',
    ]) for (const owner of [-1, 0, 2]) {
      expect(isDesignCountFirstReview(changed(q => {
        if (owner === -1) q.question += suffix;
        else q.options[owner]!.description += suffix;
      })), owner + suffix).toBe(false);
    }
    for (const owner of [-1, 0, 2]) expect(isDesignCountFirstReview(changed(q => {
      if (owner === -1) q.question += '\n"G1 is closed." G2 is closed.';
      else q.options[owner]!.description += ' "G1 is closed." G2 is closed.';
    }))).toBe(true);
    expect(isDesignCountFirstReview(changed(q => {
      q.options[0]!.description += ' "This amendment keeps all four header buttons identical."';
      q.options[2]!.description += ' "Correction: do not leave G1 open." Do not leave G2 open.';
    }))).toBe(true);
    expect(isDesignCountFirstReview(changed(q => {
      q.question += ' "G1 is historical." G2 is historical.';
      q.options[0]!.description += ' "This amendment applies only to another project."';
    }))).toBe(true);
  });
  test('the new declaration preserves native completion, answer and signature checks', () => {
    for (const change of [
      (c: NativePlanQuestionCall) => {c.answered = false;},
      (c: NativePlanQuestionCall) => {c.failed = true;},
      (c: NativePlanQuestionCall) => {delete c.answeredAt;},
      (c: NativePlanQuestionCall) => {c.answers = {};},
      (c: NativePlanQuestionCall) => {c.answers = {foreign: '1A Apply DESIGN.md token (recommended)'};},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [0];},
      (c: NativePlanQuestionCall) => {c.questions.push(structuredClone(c.questions[0]!));},
      (c: NativePlanQuestionCall) => {c.questions[0]!.multiSelect = true;},
    ]) {const c = current(); change(c); expect(isDesignCountFirstReview(fingerprint(c))).toBe(false);}
    expect(isDesignCountFirstReview({...fingerprint(current()), signature: 'foreign'})).toBe(false);
  });
});

describe('A descriptive hierarchy header owns its primary and peer controls', () => {
  // Minimal public excerpt of AY D3: retain its question, current gap and native
  // options, without copying the full review or its repeated option prose.
  const first = (): NativePlanQuestionCall => {
    const question = 'D3 — Issue 1: How should Save be distinguished from Reset, Cancel, and Export in the header?\n' +
      'Project/branch/task: settings on main, design review of PLAN.md.\n' +
      'ELI10: Right now all four header buttons look identical.';
    const options = [
      {label: '1A Filled primary + ghosts (recommended)', description: 'Save is #1d4ed8 with white text; Reset, Cancel, Export are neutral ghost buttons per DESIGN.md.'},
      {label: '1B Also move Export out', description: 'Primary + ghosts, plus relocate Export below the header; changes accepted DOM order.'},
      {label: '1C Bold label only', description: 'Keep identical buttons, bold the Save text. Weak signal, off-token.'},
    ];
    return {sessionId: 'ay-design', toolUseId: 'hierarchy', questions: [{header: 'Hierarchy', question, multiSelect: false, options}],
      answered: true, failed: false, unansweredQuestionIndices: [], answeredAt: '2026-09-11T03:10:11.660Z',
      answers: {[question]: options[0]!.label}};
  };
  const retry = (): NativePlanQuestionCall => {
    const c = first(), q = c.questions[0]!;
    q.header = 'Issue 1';
    q.question = q.question.replace('be distinguished from Reset, Cancel, and Export in the header', 'stand out from Reset, Cancel and Export')
      .replace('all four', 'the four') +
      ' DESIGN.md already names the answer: Save is the only filled primary button, the other three are neutral ghost buttons.';
    q.options = [
      {label: '1A Filled primary Save (recommended)', description: '✅ Save becomes the only filled button (#1d4ed8, white text); Reset/Cancel/Export use the existing neutral ghost variant (human: ~1h / CC: ~5min). ✅ Matches DESIGN.md exactly and reuses existing Button variants, no new styles.'},
      {label: '1B Position only, no fill', description: '✅ Keeps all four buttons visually calm with Save separated by a 16px gap from the secondaries. ❌ Violates DESIGN.md and still forces label reading.'},
      {label: '1C Leave as-is', description: "✅ Zero implementation work in this update. ✅ No visual change for users who already learned the layout. ❌ Ships a known DESIGN.md violation and the plan's own Visual Hierarchy gap stays open."},
    ];
    c.answers = {[q.question]: q.options[0]!.label};
    return c;
  };
  // A current property assessment and primary/secondary roles do not depend
  // on one captured label, palette, or control name.
  const properties = (): NativePlanQuestionCall => {
    const c = first(), q = c.questions[0]!;
    q.header = 'Issue 1';
    q.question = q.question.replace('all four header buttons look identical', 'the four header buttons are the same size, weight and color');
    q.options = [
      {label: '1A Apply DESIGN.md styles (recommended)', description: 'Save is the only filled #1d4ed8 button with white text; Reset, Cancel, Export are neutral ghost buttons. Geometry and states unchanged.'},
      {label: '1B Leave unchanged', description: 'No change; finding stays open and lowers the score.'},
    ];
    c.answers = {[q.question]: q.options[0]!.label};
    return c;
  };
  const edit = (change: (c: NativePlanQuestionCall) => void, source = first) => {
    const c = source(); change(c);
    if (c.answers && Object.keys(c.answers).length) c.answers = {[c.questions[0]!.question]: c.questions[0]!.options[0]!.label};
    return fingerprint(c);
  };
  test('a current gap, complete style and opposed partial fix start review for any offered answer', () => {
    const c = first(), q = c.questions[0]!;
    for (const o of q.options) {
      c.answers = {[q.question]: o.label};
      expect(isDesignCountFirstReview(fingerprint(c))).toBe(true);
    }
    expect(isDesignCountSetup(fingerprint(c))).toBe(false);
    expect(isDesignCompletionHandoff(fingerprint(c))).toBe(false);
  });
  test('names, palette, peer order, numeric count and severity metadata may vary consistently', () => {
    expect(isDesignCountFirstReview(edit(c => {
      const q = c.questions[0]!;
      q.header = 'Visual Hierarchy';
      q.question = q.question.replaceAll('Save', 'Publish').replace('all four', 'all 4').replace('\nELI10:', '\n[P1]\nELI10:');
      q.options = q.options.map(o => ({...o, description: o.description?.replaceAll('Save', 'Publish')
        .replace('#1d4ed8 with white', '#ffee22 with black').replace('Reset, Cancel, Export are', 'Export, Reset, Cancel are')}));
      q.options.reverse();
    }))).toBe(true);
  });
  test('equal visual properties bind concrete primary and secondary roles for any offered answer', () => {
    const c = properties(), q = c.questions[0]!;
    for (const o of q.options) {
      c.answers = {[q.question]: o.label};
      expect(isDesignCountFirstReview(fingerprint(c))).toBe(true);
    }
    for (const propertyList of ['fill and emphasis', 'colour, weight', 'weight']) {
      expect(isDesignCountFirstReview(edit(c => {
        c.questions[0]!.question = c.questions[0]!.question.replace('size, weight and color', propertyList);
      }, properties))).toBe(true);
    }
    expect(isDesignCountFirstReview(edit(c => {
      const q = c.questions[0]!;
      q.question = q.question.replaceAll('Save', 'Publish').replace('the four', 'the 4');
      q.options[0] = {label: '1A Reuse existing component roles', description: 'Publish becomes the single filled primary #ffee22 button with black text; Export/Reset/Cancel become neutral ghost buttons. Matches DESIGN.md exactly.'};
      q.options[1]!.description = 'This issue remains unresolved.';
    }, properties))).toBe(true);
    expect(isDesignCountFirstReview(edit(c => {
      c.questions[0]!.question += ' "This finding is historical."';
      c.questions[0]!.options[0]!.description += ' "This amendment applies only to another project."';
    }, properties))).toBe(true);
  });
  test('property evidence preserves currentness, authority and ownership within each native option', () => {
    const mutations: Array<(q: NativePlanQuestionCall['questions'][number]) => void> = [
      q => {q.question = q.question.replace('size, weight and color', 'size');},
      q => {q.question = q.question.replace('are the same', 'are not the same');},
      q => {q.question = q.question.replace('the four', 'the three');},
      q => {q.question = q.question.replace('ELI10:', '> ELI10:');},
      q => {q.question += '\nELI10: Right now the four header buttons are the same color.';},
      q => {q.question += ' This finding is historical.';},
      q => {q.question += ' This finding applies only to another project.';},
      q => {q.options[0]!.description = q.options[0]!.description!.replace('Save is', 'Reset is');},
      q => {q.options[0]!.description = q.options[0]!.description!.replace('Export are', 'Archive are');},
      q => {q.options[0]!.description = q.options[0]!.description!.replace('Reset, Cancel, Export', 'Save, Cancel, Export');},
      q => {q.options[0]!.description = q.options[0]!.description!.replace('Reset, Cancel, Export', 'Reset, Cancel, Cancel');},
      q => {q.options[0]!.description = q.options[0]!.description!.replace('#1d4ed8', 'blue');},
      q => {q.options[0]!.description = q.options[0]!.description!.replace('neutral ghost', 'filled primary');},
      q => {q.options[0]!.label = '1A DESIGN.md primary Reset';},
      q => {q.options[0]!.label = '1A Apply styles';},
      q => {q.options[0]!.label = '1A Apply styles'; q.options[1]!.label = '1B Leave DESIGN.md styles unchanged';},
      q => {q.options[0]!.label += ' only if approval is granted';},
      q => {q.options[0]!.description += ' This amendment is withdrawn.';},
      q => {q.options[0]!.description += ' This amendment keeps all four header buttons identical.';},
      q => {q.options[1]!.description = 'No change; finding is closed.';},
      q => {q.options[1]!.description += ' This option is historical.';},
      q => {q.options[1]!.description += ' This amendment applies only to another project.';},
      q => {q.options[1]!.description += ' This finding stays open only if approved.';},
    ];
    for (const mutate of mutations) {
      expect(isDesignCountFirstReview(edit(c => mutate(c.questions[0]!), properties)), mutate.toString()).toBe(false);
    }
    for (const mutate of [
      (c: NativePlanQuestionCall) => {c.answered = false;},
      (c: NativePlanQuestionCall) => {c.failed = true;},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [0];},
    ]) expect(isDesignCountFirstReview(edit(mutate, properties))).toBe(false);
  });
  test('retry stand-out wording binds existing variants and an owned open hierarchy gap', () => {
    const c = retry(), q = c.questions[0]!;
    for (const option of q.options) {
      c.answers = {[q.question]: option.label};
      expect(isDesignCountFirstReview(fingerprint(c))).toBe(true);
    }
    expect(isDesignCountFirstReview(edit(c => {
      const q = c.questions[0]!;
      q.question = q.question.replaceAll('Save', 'Publish').replace('the four', 'the 4');
      q.options = q.options.map(o => ({...o, label: o.label.replaceAll('Save', 'Publish'),
        description: o.description?.replaceAll('Save', 'Publish').replace('#1d4ed8, white', '#ffee22, black')
          .replace('Reset/Cancel/Export', 'Export, Reset and Cancel')}));
    }, retry))).toBe(true);
  });
  test('retry variants, authority, primary and peers must remain in the same native option', () => {
    const changes: Array<(c: NativePlanQuestionCall) => void> = [
      c => {c.questions[0]!.options[0]!.label = '1A Filled primary Reset (recommended)';},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('Save becomes', 'Publish becomes');},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('Reset/Cancel/Export', 'Reset/Cancel/Archive');},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('neutral ghost variant', 'filled primary variant');},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.split(' ✅ Matches')[0]!;},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('✅ Matches DESIGN.md exactly', '✅ If approved, matches DESIGN.md exactly');},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('✅ Matches DESIGN.md exactly', '✅ "Matches DESIGN.md exactly"');},
      c => {c.questions[0]!.options[1]!.description = c.questions[0]!.options[0]!.description; c.questions[0]!.options[0]!.description = 'Prepare the review.';},
      c => {c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('gap stays open', 'gap is closed');},
      c => {c.questions[0]!.options[2]!.description = 'Historical source excerpt:\n' + c.questions[0]!.options[2]!.description;},
      c => {c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('Ships a known', 'Does not ship a known');},
      c => {c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('Visual Hierarchy gap', 'account permission gap');},
    ];
    for (const change of changes) expect(isDesignCountFirstReview(edit(change, retry))).toBe(false);
  });
  const invalid: Array<[string, (c: NativePlanQuestionCall) => void]> = [
    ['unanswered native call', c => {c.answered = false;}],
    ['failed native call', c => {c.failed = true;}],
    ['no recorded answer', c => {c.answers = {};}],
    ['missing completion timestamp', c => {delete c.answeredAt;}],
    ['unanswered member', c => {c.unansweredQuestionIndices = [0];}],
    ['multiple native questions', c => {c.questions.push(structuredClone(c.questions[0]!));}],
    ['multi-select', c => {c.questions[0]!.multiSelect = true;}],
    ['duplicate native label', c => {c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label;}],
    ['wrong choice issue', c => {c.questions[0]!.options[0]!.label = '2A Filled primary + ghosts (recommended)';}],
    ['setup header', c => {c.questions[0]!.header = 'Routing';}],
    ['foreign Issue header', c => {c.questions[0]!.header = 'Issue 2';}],
    ['no D-numbered finding', c => {c.questions[0]!.question = c.questions[0]!.question.replace('D3 — ', '');}],
    ['source-framed question', c => {c.questions[0]!.question = 'Historical example:\n' + c.questions[0]!.question;}],
    ['conditional current gap', c => {c.questions[0]!.question = c.questions[0]!.question.replace('ELI10: Right now', 'ELI10: If right now');}],
    ['quoted current gap', c => {c.questions[0]!.question = c.questions[0]!.question.replace('ELI10:', '> ELI10:');}],
    ['negated current gap', c => {c.questions[0]!.question = c.questions[0]!.question.replace('look identical', 'do not look identical');}],
    ['duplicate assessment', c => {c.questions[0]!.question += '\nELI10: Right now all four header buttons look identical.';}],
    ['foreign pre-assessment prose', c => {c.questions[0]!.question = c.questions[0]!.question.replace('\nELI10:', '\nSource excerpt:\nELI10:');}],
    ['conditional metadata', c => {c.questions[0]!.question = c.questions[0]!.question.replace('Project/branch/task: settings', 'Project/branch/task: If settings');}],
    ['wrong control count', c => {c.questions[0]!.question = c.questions[0]!.question.replace('all four', 'all three');}],
    ['duplicate peer', c => {c.questions[0]!.question = c.questions[0]!.question.replace('Reset, Cancel, and Export', 'Reset, Cancel, and Cancel');}],
    ['primary also a peer', c => {c.questions[0]!.question = c.questions[0]!.question.replace('Reset, Cancel, and Export', 'Save, Cancel, and Export');}],
    ['foreign remedy primary', c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('Save is', 'Publish is');}],
    ['foreign remedy peer', c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('Export are', 'Archive are');}],
    ['no filled role in native label', c => {c.questions[0]!.options[0]!.label = '1A Prepare a review';}],
    ['no concrete color', c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('#1d4ed8', 'blue');}],
    ['no design authority', c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('per DESIGN.md', 'per an archived example');}],
    ['split label and remedy owners', c => {c.questions[0]!.options[1]!.description = c.questions[0]!.options[0]!.description; c.questions[0]!.options[0]!.description = 'Prepare the design review.';}],
    ['quoted remedy', c => {c.questions[0]!.options[0]!.description = '"' + c.questions[0]!.options[0]!.description + '"';}],
    ['conditional remedy', c => {c.questions[0]!.options[0]!.description = 'If approved: ' + c.questions[0]!.options[0]!.description;}],
    ['contradicted remedy', c => {c.questions[0]!.options[0]!.description += ' This amendment keeps all four buttons identical.';}],
    ['control named Fix cannot bypass owned style checks', c => {
      const q = c.questions[0]!;
      q.question = q.question.replaceAll('Save', 'Fix');
      q.options[0]!.description = 'This applies the next review step.';
    }],
    ['wrong declined control', c => {c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('Save text', 'Publish text');}],
    ['no retained equality', c => {c.questions[0]!.options[2]!.description = 'Make Save a filled primary button.';}],
    ['no retained violation', c => {c.questions[0]!.options[2]!.description = c.questions[0]!.options[2]!.description!.replace('Weak signal, off-token.', 'Strong signal, on-token.');}],
    ['quoted deferral', c => {c.questions[0]!.options[2]!.description = '> ' + c.questions[0]!.options[2]!.description;}],
    ['conditional deferral', c => {c.questions[0]!.options[2]!.description = 'If accepted: ' + c.questions[0]!.options[2]!.description;}],
    ['cancelled deferral', c => {c.questions[0]!.options[2]!.description += ' Correction: do not keep identical buttons.';}],
  ];
  test.each(invalid)('%s cannot provide current finding evidence', (_, change) => {
    expect(isDesignCountFirstReview(edit(change))).toBe(false);
  });
  test('withdrawal and approval status stay local even after a style or a partial-fix match', () => {
    for (const source of [first, retry]) for (const target of ['question', 'remedy', 'decline']) {
      for (const status of [' This issue is withdrawn.', ' This issue is "withdrawn".', ' This gap is now closed.', ' If approval is granted, use this option.']) {
        expect(isDesignCountFirstReview(edit(c => {
          const q = c.questions[0]!;
          if (target === 'question') q.question += status;
          else q.options[target === 'remedy' ? 0 : 2]!.description += status;
        }, source))).toBe(false);
      }
    }
    const fp = fingerprint(first());
    expect(isDesignCountFirstReview({...fp, signature: 'foreign:call'})).toBe(false);
    expect(isDesignCountFirstReview({...fp, nativeQuestionIndex: 1})).toBe(false);
    expect(isDesignCountFirstReview({...fp, options: fp.options.slice(1)})).toBe(false);
  });
});

describe('Z numbered gap starts review at the actual plan amendment', () => {
  const actual = () => structuredClone(gapCalls.calls) as NativePlanQuestionCall[];
  const first = () => actual()[0]!;
  const reanswer = (c: NativePlanQuestionCall) => { c.answers = {[c.questions[0]!.question]:c.questions[0]!.options[0]!.label}; return c; };
  test('first visual hierarchy decision opens all eight substantive calls without changing raw count', () => {
    expect(isDesignCountFirstReview(fingerprint(first()))).toBe(true);
    const output = replay(actual());
    expect(output).toMatchObject({step0:0,review:8,administrative:0,started:true});
    expect(output.phases).toHaveLength(8);expect(output.phases.every(p=>!p.preReview&&!p.administrative)).toBe(true);
    expect(isDesignCompletionHandoff(fingerprint(first()))).toBe(false);
    expect(isDesignCountSetup(fingerprint(first()))).toBe(false);
  });
  test('control names, palette, gap/task numbers and offered answer order may vary', () => {
    const c=first(),q=c.questions[0]!;
    q.question=q.question.replace('Gap 1 of 8','Gap 3 of 12').replace('Save button','Submit button');q.header='Gap 3: Button';
    q.options[0]!.description=q.options[0]!.description!.replace('Save gets #1d4ed8','Submit gets #123abc').replace('T1','T9');q.options.reverse();
    for(const o of q.options){c.answers={[q.question]:o.label};expect(isDesignCountFirstReview(fingerprint(c))).toBe(true);}
  });
  test('setup, examples, mismatched finding identity and unknown offered clauses cannot open review', () => {
    for(const change of [(s:string)=>s.replace('apply DESIGN.md primary button style?','start reviewing the design?'),(s:string)=>s.replace('Gap 1 of 8','Gap 9 of 8'),(s:string)=>s.replace('Gap 1','Gap 0'),(s:string)=>'Example: '+s,(s:string)=>'> '+s,(s:string)=>'```\n'+s+'\n```',(s:string)=>s+' Ready to begin?']){const c=first();c.questions[0]!.question=change(c.questions[0]!.question);expect(isDesignCountFirstReview(fingerprint(reanswer(c)))).toBe(false);}
    for(const i of [0,1])for(const suffix of [' Review starts after this setup choice.',' Choose the design source first.',' Should we review the button?']){const c=first();c.questions[0]!.options[i]!.description+=suffix;expect(isDesignCountFirstReview(fingerprint(c))).toBe(false);}
    for(const mutate of [(c:NativePlanQuestionCall)=>{c.questions[0]!.header='Gap 2: Button';},(c:NativePlanQuestionCall)=>{c.questions[0]!.header='Focus';},(c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('Save gets','Publish gets');},(c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.label='Start the review';},(c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.label='Wait';}]){const c=first();mutate(c);expect(isDesignCountFirstReview(fingerprint(reanswer(c)))).toBe(false);}
  });
  test('only one explicitly completed current native question with an offered answer opens review', () => {
    for(const mutate of [(c:NativePlanQuestionCall)=>{c.answered=false;},(c:NativePlanQuestionCall)=>{delete (c as Partial<NativePlanQuestionCall>).answered;},(c:NativePlanQuestionCall)=>{c.failed=true;},(c:NativePlanQuestionCall)=>{delete c.failed;},(c:NativePlanQuestionCall)=>{c.sessionId='';},(c:NativePlanQuestionCall)=>{c.toolUseId='';},(c:NativePlanQuestionCall)=>{delete c.unansweredQuestionIndices;},(c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},(c:NativePlanQuestionCall)=>{c.answers={};},(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'Start reviewing'};},(c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},(c:NativePlanQuestionCall)=>{c.questions.push(structuredClone(c.questions[0]!));},(c:NativePlanQuestionCall)=>{c.questions[0]!.options.push({label:'Another choice'});}]){const c=first();mutate(c);expect(isDesignCountFirstReview(fingerprint(c))).toBe(false);}
    for(const f of [{...fingerprint(first()),signature:'foreign:call'},{...fingerprint(first()),nativeCall:undefined},{...fingerprint(first()),nativeQuestionIndex:1},{...fingerprint(first()),options:[]}])expect(isDesignCountFirstReview(f)).toBe(false);
  });
});

describe('Native finding and closed handoff boundaries', () => {
  const actual = () => structuredClone(boundaryCalls) as NativePlanQuestionCall[];
  const handoff = () => actual().at(-1)!;
  const pending = (call: NativePlanQuestionCall) => {
    const copy = structuredClone(call); copy.answered = false; delete copy.answers; delete copy.answeredAt;
    copy.unansweredQuestionIndices = [0]; return copy;
  };
  test('full native finding questions start review despite their arbitrary menu headers', () => {
    const input = actual();
    for (const call of input.slice(0, 3)) expect(isDesignCountFirstReview(fingerprint(call))).toBe(true);
    expect(replay(input)).toMatchObject({step0: 0, review: 7, administrative: 1});
    expect(input).toHaveLength(8); // Raw calls are preserved, including the handoff.
  });
  test('a finding requires native identity, an offered answer and a plan amendment choice', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [
      c => {c.answered = false;}, c => {c.failed = true;}, c => {delete (c as Partial<NativePlanQuestionCall>).failed;}, c => {c.answers = {};},
      c => {c.unansweredQuestionIndices = [0];},
      c => {c.questions[0]!.question = '> ' + c.questions[0]!.question;},
      c => {c.questions[0]!.question = '```\n' + c.questions[0]!.question + '\n```';},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('plan-design-review-save-button-primary', 'plan-design-review-setup');},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('Apply it to the plan?', 'Start the review now?');},
      c => {c.questions[0]!.options = [{label:'Start reviewing'}, {label:'Wait'}];},
    ];
    for (const mutate of mutations) {
      const call = actual()[0]!; mutate(call);
      if (call.answers && Object.keys(call.answers).length) call.answers = {[call.questions[0]!.question]:call.questions[0]!.options[0]!.label};
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    expect(isDesignCountFirstReview({...fingerprint(actual()[0]!), signature:'foreign'})).toBe(false);
  });
  test('the closed qidless next-review menu is administrative and picks only the offered manual option', () => {
    const call = handoff();
    expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
    const active = fingerprint(pending(call));
    expect(pickDesignCountQuestion(active, active)).toBe(2);
    expect(isDesignCompletionHandoff(active)).toBe(false);
    call.questions[0]!.options.reverse();
    const reordered = fingerprint(pending(call));
    expect(pickDesignCountQuestion(reordered, reordered)).toBe(1);
    for (const option of call.questions[0]!.options) {
      call.answers = {[call.questions[0]!.question]:option.label};
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
    }
  });
  test('closed scores, approved count and interaction-spec topics can vary consistently', () => {
    const call = handoff(); const q = call.questions[0]!;
    q.question = q.question.replace('6/10 → 9/10', '4.5/10 → 8.75/10').replace('All 7', 'All 3');
    q.options[0]!.description = q.options[0]!.description!.replace('the 7 approved', 'the 3 approved').replace('spinner, skeleton, switch keyboard', 'focus states, keyboard navigation');
    q.options[1]!.description = q.options[1]!.description!.replace('e2e output path', 'approved plan path');
    call.answers = {[q.question]:q.options[0]!.label};
    expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
  });
  test('pending selection uses explicit native pending metadata including the real producer absent-index form', () => {
    const producer = pending(handoff()); delete producer.unansweredQuestionIndices;
    const active = fingerprint(producer);
    expect(pickDesignCountQuestion(active, active)).toBe(2);
    for (const mutate of [
      (c: NativePlanQuestionCall) => {delete (c as Partial<NativePlanQuestionCall>).answered;},
      (c: NativePlanQuestionCall) => {delete (c as Partial<NativePlanQuestionCall>).failed;},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [];},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [1];},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [0, 0];},
      (c: NativePlanQuestionCall) => {c.answers = {};},
      (c: NativePlanQuestionCall) => {c.answeredAt = handoff().answeredAt;},
    ]) {
      const call = structuredClone(producer); mutate(call); const fp = fingerprint(call);
      expect(pickDesignCountQuestion(fp, fp)).toBeNull();
      expect(isDesignCompletionHandoff(fp)).toBe(false);
    }
  });
  test('unresolved, conditional, mixed or foreign menus do not become a closed handoff', () => {
    const mutations: Array<(c: NativePlanQuestionCall) => void> = [
      c => {c.failed = true;}, c => {delete (c as Partial<NativePlanQuestionCall>).failed;}, c => {c.questions[0]!.multiSelect = true;},
      c => {c.questions.push(structuredClone(c.questions[0]!));},
      c => {c.questions[0]!.question = '> ' + c.questions[0]!.question;},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('complete —', 'complete if Export is fixed —');},
      c => {c.questions[0]!.question += ' Also remove account-owner authorization.';},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('decisions resolved', 'decisions unresolved');},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('All 7', 'All 0');},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('6/10', '11/10');},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('the 7 approved', 'the 8 approved');},
      c => {c.questions[0]!.options[0]!.description += ' Also remove account-owner authorization.';},
      c => {c.questions[0]!.options[1]!.description += ' Also remove account-owner authorization.';},
      c => {c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('spinner, skeleton', 'spinner, remove authorization');},
      c => {c.questions[0]!.options[1]!.description = c.questions[0]!.options[1]!.description!.replace('before shipping', 'if desired');},
      c => {c.questions[0]!.options.push({label:'Fix one more gap'});},
    ];
    for (const mutate of mutations) {
      const call = handoff(); mutate(call);
      call.answers = {[call.questions[0]!.question]:call.questions[0]!.options[0]!.label};
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const active = fingerprint(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
    for (const mutate of [(c: NativePlanQuestionCall) => {c.answered = false;},
      (c: NativePlanQuestionCall) => {c.answers = {};},
      (c: NativePlanQuestionCall) => {c.unansweredQuestionIndices = [0];},
      (c: NativePlanQuestionCall) => {c.answers = {[c.questions[0]!.question]:'unoffered reply'};}]) {
      const call = handoff(); mutate(call); expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
    }
    const foreign = {...fingerprint(handoff()), signature:'foreign'};
    expect(isDesignCompletionHandoff(foreign)).toBe(false);
    const activeForeign = {...fingerprint(pending(handoff())), signature:'foreign'};
    expect(pickDesignCountQuestion(activeForeign, activeForeign)).toBeNull();
  });
  test('only the closed handoff leaves the final report freshness boundary at the last substantive decision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-boundaries-report-')); const file = path.join(dir, 'plan.md');
    try {
      const input = actual(); const lastIssue = Date.parse(input[6]!.answeredAt!);
      // Synthetic complete-report body/time inside the real D7→D8 interval;
      // this checks the unchanged gate, not historical report quality or success.
      fs.writeFileSync(file, '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n| Review | Status | Findings |\n|---|---|---|\n| Design | complete | resolved |\n\nVERDICT: DESIGN CLEARED — eng review required\n\nNO UNRESOLVED DECISIONS\n');
      fs.utimesSync(file, (lastIssue + 1000) / 1000, (lastIssue + 1000) / 1000);
      const transcript = {status:'ready' as const, calls:input, assistantMessages:[], planReadyRequests:[{
        sessionId:input[0]!.sessionId, toolUseId:'toolu_01AU7GkUZW2wWr2c6E9bdTEv', timestamp:'2026-09-09T11:24:48.896Z', failed:false, source:'pre_tool_use' as const}]};
      const admin = new Set(input.filter(c => isDesignCompletionHandoff(fingerprint(c))).map(c => fingerprint(c).signature));
      const start = Date.parse(input[0]!.answeredAt!) - 1000;
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', admin)).toBe(true);
      expect(hasNativePlanTerminal({...transcript, planReadyRequests:[]}, file, start, 'plan_ready', admin)).toBe(false);
      fs.utimesSync(file, (lastIssue - 1) / 1000, (lastIssue - 1) / 1000);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', admin)).toBe(false);
    } finally {fs.rmSync(dir, {recursive:true, force:true});}
  });
});

describe('Completed outside-review participation stays setup', () => {
  const actual = () => structuredClone(outsideCalls) as NativePlanQuestionCall[];
  test('the actual first opt-in cannot start review; all seven later decisions still count', () => {
    const input = actual();
    expect(input).toHaveLength(8);
    expect(isDesignCountSetup(fingerprint(input[0]!))).toBe(true);
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(false);
    expect(replay(input)).toMatchObject({step0: 1, review: 7, administrative: 0});
    expect(replay(input).phases[0]!.reviewStarted).toBe(false);
    for (const call of input.slice(1)) expect(isDesignCountSetup(fingerprint(call))).toBe(false);
  });
  test('a late opt-in and either offered answer preserve the other decisions', () => {
    for (const selected of [0, 1]) {
      const input = actual(); const setup = input.shift()!;
      const q = setup.questions[0]!; setup.answers = {[q.question]: q.options[selected]!.label};
      input.splice(3, 0, setup);
      expect(replay(input)).toMatchObject({step0: 1, review: 7, administrative: 0});
    }
  });
  test('the existing outside-voices identity and comma labels also stay setup', () => {
    const call = actual()[0]!; const q = call.questions[0]!;
    q.question = 'D4 — Want outside design voices before the detailed review? Codex evaluates the design; a Claude subagent reviews completeness. <gstack-qid:outside-voices-design>';
    q.options = [{label:'Yes, run outside design voices'}, {label:'No, proceed without (Recommended)'}];
    call.answers = {[q.question]:q.options[1]!.label};
    expect(isDesignCountSetup(fingerprint(call))).toBe(true);
    expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
  });
  test('incomplete, mismatched, mixed and substantive questions cannot be hidden as setup', () => {
    const mutations: Array<(call: NativePlanQuestionCall) => void> = [
      c => {c.answered = false;}, c => {c.failed = true;}, c => {c.answers = {};},
      c => {c.unansweredQuestionIndices = [0];}, c => {c.questions[0]!.multiSelect = true;},
      c => {c.questions.push(actual()[1]!.questions[0]!);},
      c => {c.questions[0]!.options.push({label: 'Fix the missing export state'});},
      c => {c.questions[0]!.options[0]!.label = 'No — leave the defect unfixed';},
      c => {c.questions[0]!.options[0]!.description += ' Also remove the account-owner authorization check from Export.';},
      c => {c.questions[0]!.options[1]!.description += ' Also remove the account-owner authorization check from Export.';},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace(' <gstack-qid:', ' Also remove the account-owner authorization check from Export. <gstack-qid:');},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('plan-design-review-outside-voices', 'plan-design-review-auth');},
      c => {c.questions[0]!.question = 'D1 — Should the product require outside design voices for every customer? <gstack-qid:plan-design-review-outside-voices>';},
      c => {c.questions[0]!.question = c.questions[0]!.question.replace('before the review passes?', 'before the review passes? Also fix Export?');},
    ];
    for (const mutate of mutations) {
      const call = actual()[0]!; mutate(call);
      expect(isDesignCountSetup(fingerprint(call))).toBe(false);
    }
    expect(isDesignCountSetup({...fingerprint(actual()[0]!), signature:'foreign'})).toBe(false);
  });
});

describe('Design count native review phases and completion handoff', () => {
  test('numbered native pass decisions retain the first hierarchy approval after learnings setup', () => {
    const input = numberedCalls();
    const original = structuredClone(input);
    const hierarchy = input[1]!;
    expect(hierarchy.questions[0]!.options[0]!.description).toContain('cannot ship all-same-weight buttons');
    expect(hierarchy.questions[0]!.options[1]!.description).toContain('visual hierarchy problem ships as-is');
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(false);
    expect(isDesignCountFirstReview(fingerprint(hierarchy))).toBe(true);
    expect(replay(input)).toMatchObject({ step0: 1, review: 3, administrative: 0 });
    expect(input).toEqual(original);
  });
  test('numbered pass identity cannot turn actual setup or unrelated questions into findings', () => {
    for (const [header, question] of [
      ['Learnings', 'D1 — Pass 1 (Information Architecture): enable cross-project learnings? <gstack-qid:cross-project-learnings>'],
      ['Focus', 'D2 — Pass 1 (Information Architecture): which review focus should come first? <gstack-qid:plan-design-pass1-focus>'],
      ['Scope', 'D2 — Pass 1 (Information Architecture): reduce scope or review every dimension? <gstack-qid:plan-design-pass1-scope>'],
      ['Outside voices', 'D2 — Pass 1 (Information Architecture): run outside reviewers? <gstack-qid:outside-voices-design>'],
      ['Info Arch', 'D2 — Review Pass 1 (Information Architecture) next? <gstack-qid:plan-design-pass1-save-prominence>'],
      ['Info Arch', 'D2 — Pass 2 (Interaction States): fix the missing pending state? <gstack-qid:plan-design-pass1-save-prominence>'],
      ['Info Arch', 'D2 — Pass 1 (Information Architecture): which planning workflow should run? <gstack-qid:unrelated-workflow>'],
    ]) {
      const call = numberedCalls()[1]!;
      const q = call.questions[0]!;
      q.header = header!;
      q.question = question!;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
  });
  test('numbered pass decisions still require an answered native question and count a packet once', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.answered = false; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.answers = {}; },
    ]) {
      const call = numberedCalls()[1]!;
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    const [setup, finding] = numberedCalls();
    setup!.questions.push(finding!.questions[0]!);
    setup!.unansweredQuestionIndices = [1];
    expect(isDesignCountFirstReview(fingerprint(setup!))).toBe(false);
    setup!.answers = { ...setup!.answers, ...finding!.answers };
    setup!.unansweredQuestionIndices = [];
    expect(replay([setup!])).toMatchObject({ step0: 0, review: 1, administrative: 0 });
    expect(isDesignCountFirstReview({ ...fingerprint(finding!), nativeCall: undefined })).toBe(false);
  });
  test('native pass readiness and continuation confirmations do not supply a finding', () => {
    for (const question of [
      'D2 — Pass 1 (Information Architecture): ready to start this pass? <gstack-qid:plan-design-pass1-start>',
      'D2 — Pass 1 (Information Architecture): continue with the review? <gstack-qid:plan-design-pass1-continue>',
    ]) {
      const call = numberedCalls()[1]!;
      const q = call.questions[0]!;
      q.question = question;
      q.options = [{ label: 'Begin' }, { label: 'Not yet' }];
      call.answers = { [question]: 'Begin' };
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
      expect(replay([call])).toMatchObject({ step0: 1, review: 0 });
    }
  });
  test('captured J calls retain three actual findings, including the TODO; this still fails the four-finding floor', () => {
    const input = calls(); const original = structuredClone(input);
    expect(replay(input, designFirstReviewAUQ).review).toBe(0);
    const result = replay(input);
    expect(result).toMatchObject({ step0: 1, review: 3, administrative: 1 });
    expect(result.review).toBeLessThan(4);
    expect(result.phases.slice(1, 4).every(p => !p.preReview && !p.administrative)).toBe(true);
    expect(input).toEqual(original);
  });
  test('completion-only cannot establish or satisfy review coverage', () => {
    expect(replay([handoff()])).toMatchObject({ step0: 0, review: 0, administrative: 1, started: false });
  });
  test('an actual pass finding starts review without a numbered heading or prescribed question ID', () => {
    for (const call of calls().slice(1, 4)) expect(isDesignCountFirstReview(fingerprint(call))).toBe(true);
    expect(isDesignCountFirstReview(fingerprint(calls()[0]!))).toBe(false);
    expect(isDesignCountFirstReview(fingerprint(handoff()))).toBe(false);
  });
  test('pending, failed or skipped finding tabs cannot establish a review boundary', () => {
    const finding = calls()[1]!;
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
    ]) {
      const call = structuredClone(finding); mutate(call);
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    const partial = calls()[0]!;
    partial.questions.push(finding.questions[0]!); partial.unansweredQuestionIndices = [1];
    expect(isDesignCountFirstReview(fingerprint(partial))).toBe(false);
    partial.answers = { ...partial.answers, ...finding.answers }; partial.unansweredQuestionIndices = [];
    expect(isDesignCountFirstReview(fingerprint(partial))).toBe(true);
    expect(replay([partial]).review).toBe(1); // One native call, not one count per tab.
  });
  test('setup and generic pass mentions are not positive finding evidence', () => {
    for (const question of [
      'Review all seven passes. Which design dimension should get attention first?',
      'Pass 7 is complete. What should run next?',
      'Pass 7 found the design focus options. Which review focus do you prefer? <gstack-qid:plan-design-review-focus>',
    ]) {
      const call = calls()[1]!; const q = call.questions[0]!; q.question = question;
      call.answers = { [question]: q.options[0]!.label };
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    expect(isDesignCountFirstReview({ ...fingerprint(calls()[1]!), nativeCall: undefined })).toBe(false);
  });
  test('manual navigation is selected in both orders only for the active matching native handoff', () => {
    for (const reverse of [false, true]) {
      const call = pending(); if (reverse) call.questions[0]!.options.reverse();
      const q = call.questions[0]!;
      const visible = `☐ ${q.header}\n${q.question}\n` + q.options.map((o, i) => `${i === 0 ? '❯' : ' '} ${i + 1}. ${o.label}`).join('\n') + '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
      const active = capturePlanCountQuestion(visible, new Set(), 0, true, call)!;
      expect(pickDesignCountQuestion(fingerprint(call), active)).toBe(reverse ? 1 : 4);
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const uiOnly = capturePlanCountQuestion(visible, new Set(), 0, true)!;
      expect(pickDesignCountQuestion(fingerprint(call), uiOnly)).toBeNull();
      const other = capturePlanCountQuestion('☐ Contrast finding\nHow should we fix the low contrast?\n❯ 1. Fix it\n  2. Add a TODO\nEnter to select · ↑/↓ to navigate · Esc to cancel', new Set(), 0, true, call)!;
      expect(pickDesignCountQuestion(fingerprint(call), other)).toBeNull();
    }
    const completed = fingerprint(handoff());
    expect(pickDesignCountQuestion(completed, completed)).toBeNull();
  });
  test('mixed or unknown calls keep their substantive count and default choice', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.questions.push(calls()[1]!.questions[0]!); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push({ label: 'Add a contrast regression test now' }); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Error summary'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question = 'Should we fix this gap before running /plan-eng-review? <gstack-qid:plan-design-review-next-step>'; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.question += ' <gstack-qid:settings-contrast-finding>'; },
    ]) {
      const call = handoff(); mutate(call);
      call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const phase = planCountQuestionPhase(fingerprint(call), true, designStep0Boundary, isDesignCountFirstReview, undefined, isDesignCompletionHandoff);
      expect(phase.administrative).toBeUndefined(); expect(phase.preReview).toBe(false);
      const active = fingerprint(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
  });
  test('failed, partial, unmatched and free-form handoff answers never create administrative coverage', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'First fix another contrast issue' }; },
    ]) {
      const call = handoff(); mutate(call);
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
    }
    const mismatched = { ...fingerprint(pending()), signature: 'unrelated-call' };
    expect(pickDesignCountQuestion(mismatched, mismatched)).toBeNull();
  });
  test('conditional or negative completion is a remaining finding, even with the known navigation labels', () => {
    for (const declaration of [
      'Design review complete only after fixing contrast.',
      'Design review complete if the remaining contrast gap is fixed.',
      'Design review is not complete.',
      'Design review complete (after fixing contrast).',
    ]) {
      const call = handoff(); const q = call.questions[0]!;
      q.question = `${declaration} What’s next? <gstack-qid:plan-design-review-next-step>`;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(false);
      const active = fingerprint(pending(call));
      expect(pickDesignCountQuestion(active, active)).toBeNull();
    }
    for (const declaration of ['Design review complete.', 'Design review is complete!', 'Design review complete (10/10).']) {
      const call = handoff(); const q = call.questions[0]!;
      q.question = `${declaration} What’s next? <gstack-qid:plan-design-review-next-step>`;
      call.answers = { [q.question]: q.options[0]!.label };
      expect(isDesignCompletionHandoff(fingerprint(call))).toBe(true);
    }
  });
  test('the existing outside opt-out keeps precedence under the composed caller policy', () => {
    const question = 'Want outside design voices before the detailed review? <gstack-qid:outside-voices-design>';
    const call: NativePlanQuestionCall = { sessionId: 'outside', toolUseId: 'opt-in', answered: false,
      questions: [{ header: 'Outside voices', question, multiSelect: false,
        options: [{ label: 'Yes, run outside design voices' }, { label: 'No, proceed without (Recommended)' }] }] };
    const fp = fingerprint(call);
    expect(pickDesignCountQuestion(fp, fp)).toBe(2);
    expect(isDesignCompletionHandoff(fp)).toBe(false);
  });
  test('captured handoff timing does not make a completed report stale; a missing substantive update still does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-handoff-report-'));
    const file = path.join(dir, 'plan.md');
    try {
      fs.writeFileSync(file, '# Reviewed plan\n\n## GSTACK REVIEW REPORT\n\n' +
        '| Review | Status | Findings |\n|---|---|---|\n| Design | complete | resolved |\n\n' +
        'VERDICT: DESIGN CLEARED — eng review required\n\nNO UNRESOLVED DECISIONS\n');
      const input = calls();
      const transcript = { status: 'ready' as const, calls: input, assistantMessages: [],
        planReadyRequests: [{ sessionId: input[0]!.sessionId,
          toolUseId: 'toolu_01G1mgoSTfmimd7QpazqTNa2', timestamp: '2026-09-08T21:51:11.927Z', failed: false }] };
      const administrative = new Set(input.filter(c => isDesignCompletionHandoff(fingerprint(c))).map(c => fingerprint(c).signature));
      const written = Date.parse('2026-09-08T21:49:47.841Z') / 1000;
      fs.utimesSync(file, written, written);
      const start = Date.parse('2026-09-08T21:40:28.504Z');
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready')).toBe(false);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', administrative)).toBe(true);
      expect(replay(input).review).toBe(3); // Terminal evidence never creates the missing seed approvals.
      const stale = Date.parse(input[3]!.answeredAt!) / 1000 - 1;
      fs.utimesSync(file, stale, stale);
      expect(hasNativePlanTerminal(transcript, file, start, 'plan_ready', administrative)).toBe(false);
      const incomplete = structuredClone(transcript); incomplete.calls[3]!.answered = false;
      expect(hasNativePlanTerminal(incomplete, file, start, 'plan_ready', administrative)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('scored native Design pass decisions', () => {
  const actualCalls = () => structuredClone(scoredPasses.calls) as NativePlanQuestionCall[];
  const actual = () => actualCalls()[0]!;
  const answer = (call: NativePlanQuestionCall) => {
    call.answers = Object.fromEntries(call.questions.map(q => [q.question, q.options[0]!.label]));
    return call;
  };

  test('the captured scored first pass retains all eight substantive decisions above the unchanged ceiling', () => {
    const input = actualCalls().slice(0, 8);
    const before = structuredClone(input);
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(true);
    const result = replay(input);
    expect(result).toMatchObject({ step0: 0, review: 8, administrative: 0 });
    expect(result.review).toBeGreaterThan(7);
    expect(input).toEqual(before);
  });

  test('the complete first attempt retains all eleven issue and TODO approvals before its handoff', () => {
    const input = actualCalls();
    expect(input).toHaveLength(12);
    expect(input[10]!.questions[0]!.header).toContain('TODO');
    expect(replay(input.slice(0, -1))).toMatchObject({ step0: 0, review: 11, administrative: 0 });
  });

  test('the captured retry begins at its explicit missing-spec decision and retains every issue', () => {
    const input = structuredClone(scoredPasses.retry.calls) as NativePlanQuestionCall[];
    const original = structuredClone(input);
    expect(isDesignCountFirstReview(fingerprint(input[0]!))).toBe(true);
    expect(replay(input.slice(0, 8))).toMatchObject({ step0: 0, review: 8, administrative: 0 });
    expect(input).toEqual(original);
  });

  test('named pass identity cannot turn phase readiness or a missing answer into a finding', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Pass 1 — Information Architecture: ready to begin? <gstack-qid:plan-design-review-ia-hierarchy>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options = [{ label: 'Begin' }, { label: 'Not yet' }]; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'Focus'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Example: ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-ia-hierarchy', 'plan-design-review-focus'); },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
    ]) {
      const call = structuredClone(scoredPasses.retry.calls[0]) as NativePlanQuestionCall;
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(answer(call)))).toBe(false);
    }
  });

  test('native numeric score and missing-requirement decision do not depend on a D-number', () => {
    for (const prefix of ['Pass 1 (Info Architecture) — 7/10.', 'D2 — Pass 1 (Information Architecture): 7.5/10.']) {
      const call = actual();
      call.questions[0]!.question = call.questions[0]!.question.replace(/^Pass 1 \(Info Architecture\) — 7\/10\./, prefix);
      expect(isDesignCountFirstReview(fingerprint(answer(call)))).toBe(true);
    }
  });

  test('readiness, setup, quoted examples and missing substantive choices cannot start review', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Pass 1 (Info Architecture) — 7/10. Ready to start this pass? <gstack-qid:plan-design-review-ia-scan-path>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Pass 1 (Info Architecture) — 7/10. The plan has no missing requirements. Should I begin this pass? <gstack-qid:plan-design-review-ia-scan-path>'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = 'Example: ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = '> ' + call.questions[0]!.question; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-ia-scan-path', 'plan-design-review-focus'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.question = call.questions[0]!.question.replace('plan-design-review-ia-scan-path', 'unrelated-setup'); },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header = 'Outside voices'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options = [{ label: 'Begin' }, { label: 'Not yet' }]; },
    ]) {
      const call = actual();
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(answer(call)))).toBe(false);
    }
  });

  test('the scored pass needs a successfully answered offered native decision', () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.answered = false; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.answers = {}; },
      (call: NativePlanQuestionCall) => { call.answers = { [call.questions[0]!.question]: 'Unknown free-form request' }; },
      (call: NativePlanQuestionCall) => { call.unansweredQuestionIndices = [0]; },
    ]) {
      const call = actual();
      mutate(call);
      expect(isDesignCountFirstReview(fingerprint(call))).toBe(false);
    }
    const missing = fingerprint(actual());
    delete missing.nativeCall;
    expect(isDesignCountFirstReview(missing)).toBe(false);
  });
});
