import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-count-sep21-declared-first-call.json';
import headerCaptured from './fixtures/design-count-sep21-header-first-call.json';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const current = () => structuredClone(captured.calls[0]) as NativePlanQuestionCall;
type Question = NativePlanQuestionCall['questions'][number];
const changed = (change: (q: Question) => void) => {
  const c = current(), q = c.questions[0]!;
  change(q);
  c.answers = {[q.question]: q.options[0]!.label};
  return nativePlanCallFingerprint(c, 0, true);
};

describe('primary finding facts are independent of presentation', () => {
  test('the exact native declaration starts review for every offered answer', () => {
    const c = current(), q = c.questions[0]!;
    for (const option of q.options) {
      c.answers = {[q.question]: option.label};
      expect(isDesignCountFirstReview(nativePlanCallFingerprint(c, 0, true))).toBe(true);
    }
  });

  test('title adapters, owned role location, header and separators compose', () => {
    const titles = [
      'D2 — Issue 1: Save has no visual primacy in the header action group',
      'D2 — Issue 1: Make Save the visible primary action',
      'D2 — Issue 1: How should Save be distinguished from Reset, Cancel, and Export in the header?',
    ];
    for (const title of titles) for (const header of ['Issue 1', 'Issue 1: Save', 'Issue 1 Save', 'Save primary']) {
      for (const role of ['label', 'body']) for (const separator of [', ', '; ', '. ']) {
        expect(isDesignCountFirstReview(changed(q => {
          q.header = header;
          q.question = title + q.question.slice(q.question.indexOf('\n'));
          if (role === 'body') {
            q.options[0]!.label = '1A — Apply DESIGN.md token (recommended)';
            q.options[0]!.description = q.options[0]!.description?.replace('Save #', 'Save filled primary #');
          }
          q.options[0]!.description = q.options[0]!.description?.replace('white text, Reset/Cancel/Export', `white text${separator}Export, Reset, Cancel`);
          q.options.reverse();
        })), `${title}/${header}/${role}/${separator}`).toBe(true);
      }
    }
    expect(isDesignCountFirstReview(changed(q => {
      q.header = 'Issue 3 Publish';
      q.question = q.question.replace('Issue 1:', 'Issue 3:').replaceAll('Save', 'Publish').replace('Four buttons', '4 buttons');
      q.options = q.options.map(o => ({label: o.label.replace(/^1/, '3').replaceAll('Save', 'Publish').replace('four', '4'),
        description: o.description?.replaceAll('Save', 'Publish').replace('#1d4ed8 with white', '#ffee22 with black')}));
    }))).toBe(true);
    expect(isDesignCountFirstReview(changed(q => {
      q.question = q.question.replace('header action group\n', 'header action group.\n');
    }))).toBe(true);
  });

  test('native identity, current ownership, counts, authority and substantive options remain required', () => {
    const changes: Array<(q: Question) => void> = [
      q => {q.header = 'Issue 2';},
      q => {q.header = 'Issue 1 Publish';},
      q => {q.question = q.question.replace('Save has no visual primacy', 'Choose the next reviewer');},
      q => {q.question = q.question.replace('ELI10:', '> ELI10:');},
      q => {q.question = q.question.replace('ELI10:', 'ELI10: If approved,');},
      q => {q.question = q.question.replace('Four buttons', 'Three buttons');},
      q => {q.options[0]!.label = q.options[0]!.label.replace('Save filled primary', 'Publish filled primary');},
      q => {q.options[0]!.label = '1A — Prepare the review';},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Save #', 'Publish #');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('#1d4ed8', 'blue');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('with white text', '');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Reset/Cancel/Export', 'Reset//Cancel');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Reset/Cancel/Export', 'Reset/Cancel/Save');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('neutral ghost', 'filled primary');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Matches DESIGN.md exactly: ', '');},
      q => {
        q.options[0]!.description = q.options[0]!.description?.replace('Matches DESIGN.md exactly: ', '');
        q.options[1]!.description += ' Matches DESIGN.md exactly.';
      },
      q => {q.options[0]!.description += ' ❌ These tokens do not match DESIGN.md.';},
      q => {q.options[1]!.label = q.options[1]!.label.replace('four', 'three');},
      q => {q.options[1]!.description = 'The primary action is clear; no gap remains.';},
      q => {q.options[1]!.description = '> ' + q.options[1]!.description;},
      q => {q.options[1]!.description = q.options[1]!.description?.replace('Violates DESIGN.md', 'Satisfies DESIGN.md');},
      q => {q.options[1]!.description += ' This gap is resolved.';},
    ];
    for (const change of changes) expect(isDesignCountFirstReview(changed(change)), change.toString()).toBe(false);
    for (const owner of [-1, 0, 1]) for (const suffix of [
      ' This finding is "withdrawn".', ' ❌ Issue 1 is closed.', ' Assuming approval, use this option.',
      ' This finding applies only to another project.',
    ]) expect(isDesignCountFirstReview(changed(q => {
      if (owner === -1) q.question += suffix;
      else q.options[owner]!.description += suffix;
    })), owner + suffix).toBe(false);
    expect(isDesignCountFirstReview(changed(q => {
      q.question += '\n"Issue 1 is closed." Issue 2 is closed.';
      q.options[0]!.description += ' "This amendment is withdrawn."';
    }))).toBe(true);
    for (const owner of [0, 1]) for (const suffix of [
      '. This option is withdrawn.', '. If approved, apply this option.', '. Do not apply these styles.',
    ]) expect(isDesignCountFirstReview(changed(q => {
      q.options[owner]!.label += suffix;
    })), owner + suffix).toBe(false);
    for (const role of ['Export primary', 'Export filled primary', 'Save ghost']) {
      expect(isDesignCountFirstReview(changed(q => {
        q.options[0]!.label = q.options[0]!.label.replace('others ghost', `${role}, others ghost`);
      })), role).toBe(false);
      expect(isDesignCountFirstReview(changed(q => {
        q.options[0]!.description += ` ${role}.`;
      })), role + ' in description').toBe(false);
    }
    expect(isDesignCountFirstReview(changed(q => {
      q.options[0]!.label += '. These tokens do not match DESIGN.md.';
    }))).toBe(false);
    expect(isDesignCountFirstReview(changed(q => {
      q.options[0]!.label += '. "Export filled primary." "Save ghost." "These tokens do not match DESIGN.md."';
      q.options[0]!.description += ' "Export filled primary." "Save ghost." "These tokens do not match DESIGN.md."';
    }))).toBe(true);
  });

  test('recognized invalid primary findings cannot fall through to a generic review marker', () => {
    const c = current(), q = c.questions[0]!;
    q.question += '\n<gstack-qid:plan-design-review-primary-action>';
    c.answers = {[q.question]: q.options[0]!.label};
    const fp = nativePlanCallFingerprint(c, 0, true);
    // The loose marker is deliberately visible even when the real public
    // question is too long for a short prompt projection.
    fp.promptSnippet = 'D2 — Issue 1 <gstack-qid:plan-design-review-primary-action>';
    expect(isDesignCountFirstReview(fp)).toBe(false);
    expect(isDesignCountFirstReview({...fp, signature: 'foreign:call'})).toBe(false);
    const multiple = structuredClone(fp);
    multiple.nativeCall!.questions.push(structuredClone(q));
    expect(isDesignCountFirstReview(multiple)).toBe(false);
  });
});

describe('primary facts with identity carried by the native header', () => {
  const altered = (change: (q: Question) => void = () => {}) => {
    const c = structuredClone(headerCaptured.calls[0]) as NativePlanQuestionCall;
    const q = c.questions[0]!;
    change(q);
    c.answers = {[q.question]: q.options[0]!.label};
    return nativePlanCallFingerprint(c, 0, true);
  };

  test('the exact public question starts review for every answer', () => {
    const c = structuredClone(headerCaptured.calls[0]) as NativePlanQuestionCall;
    for (const option of c.questions[0]!.options) {
      c.answers = {[c.questions[0]!.question]: option.label};
      expect(isDesignCountFirstReview(nativePlanCallFingerprint(c, 0, true))).toBe(true);
    }
  });

  test('identity, actor-list, property separator and authority location vary independently', () => {
    for (const identity of ['header', 'title', 'both']) for (const list of ['Reset, Cancel, Export', 'Export/Reset/Cancel', 'Cancel, Export and Reset']) {
      for (const separator of [': ', ' = ', ' ']) for (const authority of ['label', 'body']) {
        expect(isDesignCountFirstReview(altered(q => {
          if (identity !== 'header') q.question = q.question.replace('D1 — Should', 'D1 — Issue 1: Should');
          if (identity === 'title') q.header = 'Issue 1';
          q.question = q.question.replace('Save, Reset, Cancel and Export', `Save, ${list}`);
          q.options[0]!.description = q.options[0]!.description?.replace('Save: ', `Save${separator}`)
            .replace('Reset, Cancel, Export: ', `${list}${separator}`);
          if (authority === 'body') {
            q.options[0]!.label = '1A) Filled primary';
            q.options[0]!.description = q.options[0]!.description?.replace('Uses the exact approved tokens;', 'Matches DESIGN.md exactly;');
          }
          q.options.reverse();
        })), `${identity}/${list}/${separator}/${authority}`).toBe(true);
      }
    }
    expect(isDesignCountFirstReview(altered(q => {
      q.header = 'Issue 7: Publish';
      q.question = q.question.replaceAll('Save', 'Publish');
      q.options = q.options.map(o => ({label: o.label.replace(/^1/, '7').replaceAll('Save', 'Publish'),
        description: o.description?.replaceAll('Save', 'Publish').replace('#1d4ed8 with white', '#eeeeff with black')}));
    }))).toBe(true);
  });

  test('independent identity and fact fields cannot disagree or borrow evidence', () => {
    const mutations: Array<(q: Question) => void> = [
      q => {q.header = 'Issue 2: Save';},
      q => {q.header = 'Issue 1: Publish';},
      q => {q.question = q.question.replace('D1 — Should', 'D1 — Issue 2: Should');},
      q => {q.question = q.question.replace('D1 — Should', 'D1 — Issue 1: Should').replace('Should Save', 'Should Publish');},
      q => {q.header = 'Issue 1: Save/Publish';},
      q => {q.question = q.question.replace(/^D1[^\n]+/, 'D1 — Choose the next reviewer for Save primary action');},
      q => {q.question = q.question.replace(/^D1([^\n]+)/, 'D1 — Historical example:$1');},
      q => {q.question = q.question.replace(/^D1([^\n]+)/, 'D1 — If approved,$1');},
      q => {q.question = q.question.replace(/^D1([^\n]+)/, 'D1 — "$1"');},
      q => {q.question = q.question.replace('Save, Reset, Cancel and Export', 'Save, Reset, Reset and Export');},
      q => {q.question = q.question.replace('Save, Reset, Cancel and Export', 'Save, Reset and Export');},
      q => {q.question = q.question.replace('look identical', 'are three identical buttons');},
      q => {q.question = q.question.replace('Right now Save, Reset, Cancel and Export look identical.', '"Right now Save, Reset, Cancel and Export look identical."');},
      q => {q.options[0]!.label = '1A) Primary';},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Uses the exact approved tokens', 'Uses unapproved tokens');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Uses the exact approved tokens;', 'Uses the exact approved tokens is false;');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Uses the exact approved tokens;', 'Uses the exact approved tokens from another unrelated design system;');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Save: filled', 'Publish: filled');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Reset, Cancel, Export:', 'Reset, Save, Export:');},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Reset, Cancel, Export:', 'Reset//Export:');},
      q => {q.options[0]!.label = '1A) Primary'; q.options[1]!.label = '1B) DESIGN.md primary';},
      q => {q.options[0]!.description = q.options[0]!.description?.replace('Uses the exact approved tokens;', ''); q.options[1]!.description += ' Uses the exact approved tokens.';},
      q => {q.options[2]!.label = q.options[2]!.label.replace('four', 'three');},
      q => {q.options[2]!.description = q.options[2]!.description?.replace('Leaves a known DESIGN.md violation and no primary action', 'Resolves the DESIGN.md violation and makes the primary action clear');},
    ];
    for (const change of mutations) expect(isDesignCountFirstReview(altered(change)), change.toString()).toBe(false);
    for (const field of ['label', 'description'] as const) for (const statement of [
      'This option is withdrawn.', 'If approved, apply this option.', 'Do not apply these styles.',
      'These tokens do not match DESIGN.md.', 'These tokens are not approved.',
      'Save: ghost.', 'Export: filled primary.',
    ]) expect(isDesignCountFirstReview(altered(q => {q.options[0]![field] += ` ${statement}`;})), `${field}/${statement}`).toBe(false);
    for (const field of ['label', 'description'] as const) expect(isDesignCountFirstReview(altered(q => {
      q.options[0]![field] += ' "These tokens do not match DESIGN.md." "Save: ghost."';
    }))).toBe(true);
    expect(isDesignCountFirstReview(altered(q => {
      q.question = q.question.replace(/^D1[^\n]+/, 'D1 — Issue 1: How should Save be distinguished from Reset, Cancel, and Export?')
        .replace('Save, Reset, Cancel and Export look identical', 'Save, Reset, Cancel and Discard look identical');
    }))).toBe(false);
  });

  test('header identity failures stay invalid in the presence of generic review markers', () => {
    for (const header of ['Issue 1: Save/Publish', 'Design', 'Issue 2: Save', 'Issue 01: Save']) {
      const fp = altered(q => {
        q.header = header;
        q.question += '\n<gstack-qid:plan-design-review-primary-action>';
      });
      fp.promptSnippet = 'D1 <gstack-qid:plan-design-review-primary-action>';
      expect(isDesignCountFirstReview(fp), header).toBe(false);
    }
    const quoted = altered(q => {
      q.question = q.question.replace(/^D1([^\n]+)/, 'D1 — "$1"') + '\n<gstack-qid:plan-design-review-primary-action>';
    });
    quoted.promptSnippet = 'D1 <gstack-qid:plan-design-review-primary-action>';
    expect(isDesignCountFirstReview(quoted)).toBe(false);
  });
});
