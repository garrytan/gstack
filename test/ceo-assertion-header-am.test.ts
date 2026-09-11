import { expect, test } from 'bun:test';
import { ceoFirstReviewAUQ, nativePlanCallFingerprint, type AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import fixture from './fixtures/ceo-assertion-header-am-calls.json';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const calls = fixture.calls as AskUserQuestionFingerprint[];
const findings = calls.slice(2);
function change(fp: AskUserQuestionFingerprint, edit: (q: NonNullable<AskUserQuestionFingerprint['nativeCall']>['questions'][number]) => void) {
  const call = structuredClone(fp.nativeCall!);
  const selected = call.questions[0]!.options.findIndex(o => o.label === call.answers?.[call.questions[0]!.question]);
  edit(call.questions[0]!);
  call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[selected]!.label };
  return nativePlanCallFingerprint(call, fp.observedAtMs, fp.preReview);
}

for (const [i, fp] of findings.entries()) {
  test(`the actual completed assertion finding ${i + 1} starts review with its descriptive header`, () => {
    expect(ceoFirstReviewAUQ(fp)).toBe(true);
  });
}
test('routing and implementation layout remain setup', () => {
  for (const fp of calls.slice(0, 2)) expect(ceoFirstReviewAUQ(fp)).toBe(false);
});
test('the same current issue is already recognized with an explicit numbered header', () => {
  findings.forEach((fp, i) => expect(ceoFirstReviewAUQ(change(fp, q => { q.header = `Issue ${i + 1}`; }))).toBe(true));
});
test('a competing numbered header cannot borrow the title issue', () => {
  findings.forEach((fp, i) => expect(ceoFirstReviewAUQ(change(fp, q => { q.header = `Issue ${i + 2}`; }))).toBe(false));
});
test('only the completed owned native decision supplies the finding', () => {
  for (const fp of findings) {
    for (const mutate of [
      (x: AskUserQuestionFingerprint) => { x.nativeCall!.answered = false; },
      (x: AskUserQuestionFingerprint) => { x.nativeCall!.failed = true; },
      (x: AskUserQuestionFingerprint) => { x.nativeCall!.unansweredQuestionIndices = [0]; },
      (x: AskUserQuestionFingerprint) => { x.signature = 'foreign:call'; },
      (x: AskUserQuestionFingerprint) => { x.nativeCall!.answers = {}; },
      (x: AskUserQuestionFingerprint) => { x.options[0]!.label = 'different menu'; },
    ]) {
      const modified = structuredClone(fp); mutate(modified);
      expect(ceoFirstReviewAUQ(modified)).toBe(false);
    }
  }
});
test('descriptive headers and decision ordinals do not replace the issue identity', () => {
  for (const fp of findings) {
    for (const titlePrefix of ['D19', 'd4']) {
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace(/^D\d+/, titlePrefix); }))).toBe(true);
    }
    expect(ceoFirstReviewAUQ(change(fp, q => { q.header = 'Test contract'; }))).toBe(true);
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace(/^Recommendation: \d+/m, 'Recommendation: 9'); }))).toBe(false);
  }
});
test('source, earlier and conditional framing cannot own the current assessment', () => {
  for (const fp of findings) {
    for (const prefix of ['Source excerpt:', 'The following assessment is hypothetical.', 'Earlier review assessment:', 'If approved:', 'Source:', 'Example:', 'Historical review:']) {
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('\nELI10:', `\n${prefix}\nELI10:`); }))).toBe(false);
    }
    for (const prefix of ['Source excerpt. ', 'Previously, ', 'If approved, ']) {
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('ELI10: ', `ELI10: ${prefix}`); }))).toBe(false);
    }
    expect(ceoFirstReviewAUQ(change(fp, q => { q.question = q.question.replace('\nELI10:', '\nArchived wording: "Source excerpt."\nELI10:'); }))).toBe(true);
  }
});
test('the assertion gap and offered remedy must still be current', () => {
  for (const fp of findings) {
    for (const correction of ['This finding is withdrawn.', 'No current defect remains.']) {
      expect(ceoFirstReviewAUQ(change(fp, q => { q.question += '\n' + correction; }))).toBe(false);
    }
    expect(ceoFirstReviewAUQ(change(fp, q => {
      q.question = q.question.replace(/^\d+[A-Z]\)[\s\S]*?(?=^Net:)/m, '');
      const issue = q.options[0]!.label.match(/^\d+/)![0];
      q.options.forEach((option, i) => {
        option.label = `${issue}${String.fromCharCode(65 + i)}: Keep the current assertion`;
        option.description = 'Leave the assertion unchanged.';
      });
    }))).toBe(false);
  }
});
test('regression inputs belong only to the existing CEO finding owner without sparse paths', () => {
  for (const input of ['test/ceo-assertion-header-am.test.ts', 'test/fixtures/ceo-assertion-header-am-calls.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(input)).map(([owner]) => owner)).toEqual(['plan-ceo-finding-count']);
  }
  const paths = E2E_TOUCHFILES['plan-ceo-finding-count']!;
  for (let i = 0; i < paths.length; i++) {
    expect(Object.hasOwn(paths, i)).toBe(true);
    expect(typeof paths[i]).toBe('string');
  }
});
