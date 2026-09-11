import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, type AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import fixture from './fixtures/ceo-contract-question-an.json';
import sectionFixture from './fixtures/ceo-section-finding-an.json';
import contractFixture from './fixtures/ceo-current-contract-an.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const calls = fixture.fingerprints as AskUserQuestionFingerprint[];
const findings = calls.slice(2);
const sectionCalls = sectionFixture.fingerprints as AskUserQuestionFingerprint[];
const sectionFindings = sectionCalls.slice(4, 6);
function change(fp: AskUserQuestionFingerprint, edit: (q: any, call: any, fp: any) => void) {
  const copy = structuredClone(fp), call = copy.nativeCall!, q = call.questions[0]!;
  const answerIndex = q.options.findIndex(o => o.label === call.answers?.[q.question]);
  edit(q, call, copy);
  call.answers = { [q.question]: q.options[answerIndex]?.label ?? '' };
  copy.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
  return copy;
}
test('both actual completed contract questions start review; routing and test layout remain setup', () => {
  expect(calls.map(ceoFirstReviewAUQ)).toEqual([false, false, true, true]);
});
test('the decision ordinal, punctuation and form of the remedy question do not carry the finding', () => {
  for (const fp of findings) for (const title of [
    'd19 — Test 1 checks only truthiness; what should the exact assertion verify?',
    'D4 - Test 1 asserts only truthiness. How should the test check the full contract?',
    'D7 — Test 1 checks only truthiness: assert the contract or keep this check?',
  ]) {
    expect(ceoFirstReviewAUQ(change(fp, q => {
      q.question = q.question.replace(q.question.split('\n')[0], title);
      q.header = 'Test contract';
    }))).toBe(true);
  }
});
test('a competing test header or explicit foreign issue cannot borrow a test assertion', () => {
  for (const header of ['Test 99 assert', 'Finding 3', 'Issue 1'])
    expect(ceoFirstReviewAUQ(change(findings[0]!, q => { q.header = header; }))).toBe(false);
});
test('a title alone or an administrative response does not establish a review finding', () => {
  for (const fp of findings) {
    expect(ceoFirstReviewAUQ({ ...fp, nativeCall: undefined })).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => {
      q.options = [
        { label: 'A) Keep the current assertion (recommended)', description: 'Leave the test unchanged.' },
        { label: 'B) Archive the review', description: 'Save the existing report without changing tests.' },
      ];
    }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => { q.header = 'Approach'; }))).toBe(false);
  }
});
test('the full native identity, selected answer and completed result remain required', () => {
  for (const fp of findings) {
    for (const edit of [
      (_q: any, c: any) => { c.answered = false; },
      (_q: any, c: any) => { c.failed = true; },
      (_q: any, c: any) => { c.unansweredQuestionIndices = [0]; },
      (_q: any, _c: any, f: any) => { f.signature = 'foreign:tool'; },
      (q: any) => { q.multiSelect = true; },
    ]) expect(ceoFirstReviewAUQ(change(fp, edit))).toBe(false);
    const answer = change(fp, () => {}); answer.nativeCall!.answers = {};
    expect(ceoFirstReviewAUQ(answer)).toBe(false);
    const menu = change(fp, () => {}); menu.options[0]!.label = 'Foreign selection';
    expect(ceoFirstReviewAUQ(menu)).toBe(false);
  }
});
test('source and conditional frames cannot own the current assertion assessment', () => {
  for (const intro of ['Source:', 'Example:', 'Earlier review assessment:', 'The following assessment is hypothetical.'])
    expect(ceoFirstReviewAUQ(change(findings[0]!, q => { q.question = q.question.replace('\nELI10:', '\n' + intro + '\nELI10:'); }))).toBe(false);
  for (const intro of ['Source excerpt: ', 'Previously, ', 'If approved, ', 'The following is a hypothetical example. '])
    expect(ceoFirstReviewAUQ(change(findings[0]!, q => { q.question = q.question.replace('ELI10: ', 'ELI10: ' + intro); }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(findings[0]!, q => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: If approved, '); }))).toBe(false);
});
test('literal titles and withdrawn current findings supply no first-review credit', () => {
  for (const fp of findings) {
    expect(ceoFirstReviewAUQ(change(fp, q => { const lines = q.question.split('\n'); lines[0] = '`' + lines[0] + '`'; q.question = lines.join('\n'); }))).toBe(false);
    for (const statement of [
      'Correction: this finding is withdrawn.',
      'Correction: this finding is "withdrawn".',
      'Correction: this explanation is not current.',
      'There is no current gap.',
    ]) expect(ceoFirstReviewAUQ(change(fp, q => { q.question += '\n' + statement; }))).toBe(false);
  }
});
test('quoted historical notes cannot withdraw the current finding', () => {
  expect(ceoFirstReviewAUQ(change(findings[0]!, q => {
    q.question = q.question.replace('\nELI10:', '\nArchive note: "Source: this finding is withdrawn."\nELI10:');
  }))).toBe(true);
});
test('uniform recommendation and option identities remain required', () => {
  for (const edit of [
    (q: any) => { q.question = q.question.replace('Recommendation: A', 'Recommendation: Z'); },
    (q: any) => { q.options[1].label = q.options[1].label.replace('B)', '9B)'); },
    (q: any) => { q.options[1].label = q.options[1].label.replace('B)', 'A)'); },
  ]) expect(ceoFirstReviewAUQ(change(findings[0]!, edit))).toBe(false);
});
test('the new regression inputs belong only to the dense CEO finding owner', () => {
  for (const name of ['test/ceo-contract-question-an.test.ts', 'test/fixtures/ceo-contract-question-an.json', 'test/fixtures/ceo-section-finding-an.json', 'test/fixtures/ceo-current-contract-an.json'])
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(name)).map(([owner]) => owner)).toEqual(['plan-ceo-finding-count']);
  const paths = E2E_TOUCHFILES['plan-ceo-finding-count']!;
  for (let i = 0; i < paths.length; i++) {
    expect(Object.hasOwn(paths, i)).toBe(true);
    expect(typeof paths[i]).toBe('string');
  }
});
test('owned Section finding briefs establish review through their current defect and remedy', () => {
  expect(sectionCalls.map(ceoFirstReviewAUQ)).toEqual([false, false, false, false, true, true, false]);
  for (const fp of sectionFindings) for (const separator of [':', '—', '-']) {
    expect(ceoFirstReviewAUQ(change(fp, q => {
      q.question = q.question.replace(/^D\d+ — Section 2 finding (\d):/, `d19 — Section 7 finding $1 ${separator}`);
      q.header = 'Section 7';
    }))).toBe(true);
  }
  expect(ceoFirstReviewAUQ(change(sectionFindings[0]!, q => {
    q.question = q.question.replace('the lookup reads request.params.userId into a raw SQL fragment', 'the query reads payload.accountId into a raw SQL string');
  }))).toBe(true);
  for (const term of ['“no error handling”', "'no error handling'", 'no error handling'])
    expect(ceoFirstReviewAUQ(change(sectionFindings[1]!, q => {
      q.question = q.question.replace('"no error handling"', term);
    }))).toBe(true);
});
test('Section dispatch requires an exact completed native question and consistent finding identity', () => {
  for (const fp of sectionFindings) for (const edit of [
    (_q: any, c: any) => { delete c.answeredAt; },
    (_q: any, c: any) => { c.answeredAt = 'not-a-time'; },
    (_q: any, _c: any, f: any) => { f.nativeQuestionIndex = 1; },
    (_q: any, c: any) => { c.answered = false; },
    (_q: any, c: any) => { c.failed = true; },
    (_q: any, _c: any, f: any) => { f.signature = 'foreign:call'; },
    (q: any) => { q.header = 'Section 8'; },
    (q: any) => { q.header = 'Finding 99'; },
    (q: any) => { q.header = 'Section 2 finding 99'; },
    (q: any) => { q.question = q.question.replace('Recommendation: A', 'Recommendation: 99A'); },
  ]) expect(ceoFirstReviewAUQ(change(fp, edit))).toBe(false);
});
test('Section declarations cannot borrow source, historical, conditional or negated defects', () => {
  for (const fp of sectionFindings) for (const prefix of ['Source: ', 'Previously, ', 'If approved, ', 'The hypothetical example: ', 'Earlier review assessment: ', 'For historical context, ']) {
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace(/(Section 2 finding \d: )/, '$1' + prefix); }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('ELI10: ', 'ELI10: ' + prefix); }))).toBe(false);
  }
  for (const fp of sectionFindings) for (const prefix of ['Source:', 'Earlier review assessment:', 'The following is a hypothetical example.'])
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('\nELI10:', '\n' + prefix + '\nELI10:'); }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(sectionFindings[0]!, q => {
    q.question = q.question.replace('the lookup reads', 'the lookup no longer reads');
  }))).toBe(false);
  expect(ceoFirstReviewAUQ(change(sectionFindings[1]!, q => {
    q.question = q.question.replace('the receipt email has "no error handling"', 'the receipt email no longer has "no error handling"');
  }))).toBe(false);
});
test('Section review requires a current offered amendment and an unwithdrawn assessment', () => {
  for (const fp of sectionFindings) {
    for (const status of ['This finding is withdrawn.', 'Correction: this finding is "withdrawn".', 'This explanation is not current.', 'There is no current gap.'])
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question += '\n' + status; }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => {
      q.options = [
        { label: 'A) Keep the existing implementation', description: 'Leave all behavior unchanged.' },
        { label: 'B) Archive the report', description: 'Export the report.' },
      ];
    }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => {
      for (const option of q.options) option.description = 'Source excerpt: ' + option.description;
    }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => {
      for (const option of q.options) option.description += '\nThis amendment is withdrawn.';
    }))).toBe(false);
    for (const status of [' This amendment is withdrawn.', ' This remedy is a historical example, not the current option.'])
      expect(ceoFirstReviewAUQ(change(fp, q => {
        for (const option of q.options) option.description += status;
      }))).toBe(false);
    for (const prefix of ['Source excerpt: ', 'If approved later: '])
      expect(ceoFirstReviewAUQ(change(fp, q => {
        for (const option of q.options) option.label = option.label.replace(/^([A-C]\)) /, '$1 ' + prefix);
      }))).toBe(false);
    expect(ceoFirstReviewAUQ(change(fp, q => {
      q.question = q.question.replace('\nELI10:', '\nArchive note: "Source: this finding is withdrawn."\nELI10:');
    }))).toBe(true);
  }
});
test('the current plan contract can establish the gap in a later ELI10 sentence', () => {
  const fp = contractFixture.fingerprints[2] as AskUserQuestionFingerprint;
  expect(ceoFirstReviewAUQ(fp)).toBe(true);
  for (const clause of [
    "The current plan states 'no error handling on the email leg'.",
    'The plan specifies “no error handling on the email leg”.',
    'This plan requires "no error handling on the email leg".',
    'The plan says no error handling on the email leg.',
  ]) expect(ceoFirstReviewAUQ(change(fp, q => {
    q.question = q.question.replace("The plan says 'no error handling on the email leg'.", clause);
  }))).toBe(true);
});
test('later contract declarations retain source, currentness and remedy ownership', () => {
  const fp = contractFixture.fingerprints[2] as AskUserQuestionFingerprint;
  for (const clause of [
    "The old plan said 'no error handling on the email leg'.",
    "If approved, the plan says 'no error handling on the email leg'.",
    "Source excerpt: the plan says 'no error handling on the email leg'.",
    '"The plan says no error handling on the email leg."',
    "The plan no longer says 'no error handling on the email leg'.",
    "The plan says 'no error handling on the email leg' only in a historical example.",
    "The plan says 'no error handling on the email leg”.",
  ]) expect(ceoFirstReviewAUQ(change(fp, q => {
    q.question = q.question.replace("The plan says 'no error handling on the email leg'.", clause);
  }))).toBe(false);
  for (const edit of [
    (q: any) => { q.question = q.question.replace('ELI10: ', 'ELI10: Earlier review assessment: '); },
    (q: any) => { q.question = q.question.replace('Project/branch/task: ', 'Project/branch/task: Source excerpt: '); },
    (q: any) => { q.question += '\nThis finding is "withdrawn".'; },
    (q: any) => { for (const o of q.options) o.description += ' This amendment is withdrawn.'; },
    (q: any) => { for (const o of q.options) o.description = 'Source excerpt: ' + o.description; },
    (_q: any, c: any) => { delete c.answeredAt; },
    (_q: any, _c: any, f: any) => { f.nativeQuestionIndex = 1; },
    (q: any) => { q.header = 'Finding 99'; },
    (q: any) => { q.question = q.question.replace("The plan says 'no error handling", "Source excerpt follows. The plan says 'no error handling"); },
    (q: any) => { q.question = q.question.replace("The plan says 'no error handling", "Earlier review assessment follows. The plan says 'no error handling"); },
    (q: any) => { q.question = q.question.replace("The plan says 'no error handling", "If approved later. The plan says 'no error handling"); },
    (q: any) => { q.question = q.question.replace("'no error handling on the email leg'.", "'no error handling on the email leg'. This no-error-handling contract is withdrawn."); },
    (q: any) => { q.question = q.question.replace("'no error handling on the email leg'.", "'no error handling on the email leg'. This contract is a historical example, not the current plan."); },
    (q: any) => { q.question += '\nThis finding is "resolved".'; },
    (q: any) => { for (const o of q.options) o.description += '\nThis amendment is "closed".'; },
    (q: any) => { for (const o of q.options) o.description += ' This amendment is "closed".'; },
  ]) expect(ceoFirstReviewAUQ(change(fp, edit))).toBe(false);
  expect(ceoFirstReviewAUQ(change(fp, q => {
    q.question += '\nArchive note: "This finding is withdrawn."';
  }))).toBe(true);
});
test('the assertion assessment and strengthening action retain their own current authority', () => {
  for (const edit of [
    (_q: any, c: any) => { delete c.answeredAt; },
    (_q: any, c: any) => { c.answeredAt = 'invalid'; },
    (_q: any, _c: any, f: any) => { f.nativeQuestionIndex = 1; },
    (q: any) => { q.question = q.question.replace('ELI10: The plan states', 'ELI10: The historical plan stated'); },
    (q: any) => { q.question = q.question.replace('But the planned test only checks', 'But the planned test no longer only checks'); },
    (q: any) => { q.options[0].label = q.options[0].label.replace('Assert deep equality with', 'Assert truthiness for'); },
    (q: any) => { q.options[0].description = 'Source excerpt:\n' + q.options[0].description; },
    (q: any) => { q.options[0].description = 'Earlier review assessment:\n' + q.options[0].description; },
    (q: any) => { q.options[0].description += '\nThis amendment is withdrawn.'; },
    (q: any) => { q.options[0].description += '\nThis amendment is "withdrawn".'; },
    (q: any) => { q.options[0].description += '\nThis amendment is “withdrawn”.'; },
    (q: any) => { q.options[0].description += '\nThis remedy is a historical example, not the current option.'; },
    (q: any) => { q.question = q.question.replace('ELI10: ', 'ELI10: Earlier review assessment: '); },
    (q: any) => { q.question = q.question.replace('ELI10: ', 'ELI10: For historical context, '); },
  ]) expect(ceoFirstReviewAUQ(change(findings[0]!, edit))).toBe(false);
  expect(ceoFirstReviewAUQ(change(findings[0]!, q => {
    q.options[1] = { label: 'B) Export documentation', description: 'Export the report.' };
  }))).toBe(true);
});
