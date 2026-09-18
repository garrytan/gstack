import { expect, test } from 'bun:test';
import fixture from './fixtures/eng-batching-native-8525.json';
import { createEngBatchingIssueCounter, isEngBatchingIssueAUQ } from './helpers/eng-seeded-coverage';
import { engSetupAUQ, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const copy = <T>(v: T): T => structuredClone(v);
const first = fixture.attempts[0]!, retry = fixture.attempts[1]!;
const check = (call: NativePlanQuestionCall, prior: readonly NativePlanQuestionCall[] = []) =>
  isEngBatchingIssueAUQ(nativePlanCallFingerprint(call, 0, true), prior);
const revise = (call: NativePlanQuestionCall, text: string) => {
  const answer = call.answers![call.questions[0]!.question]!;
  call.questions[0]!.question = text; call.answers = { [text]: answer };
};
for (const attempt of fixture.attempts) test(`actual attempt ${attempt.attempt} independently answered review decisions satisfy the unchanged floor`, () => {
  const calls = attempt.calls as NativePlanQuestionCall[];
  const decisions = calls.filter((call, i) => check(call, calls.slice(0, i)));
  expect(attempt.originalOutcome.reviewCount).toBe(0);
  expect(calls.every(call => call.answered && !call.failed && call.questions.length === 1)).toBe(true);
  expect(decisions).toHaveLength(attempt.expectedSeparateDecisions);
  expect(decisions.length).toBeGreaterThanOrEqual(3);
  // Replay the full retained history to expose extra real questions; the paid
  // runner keeps its original ceiling7 and stops on the seventh valid decision.
  expect(calls.slice(0, 3).some(call => check(call))).toBe(false);
  expect(calls.slice(-3).some(call => check(call))).toBe(false);
});

for (const [name, change] of Object.entries({
  'pending': (c: NativePlanQuestionCall) => { c.answered = false; },
  'failed': (c: NativePlanQuestionCall) => { c.failed = true; },
  'unanswered component': (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
  'missing timestamp': (c: NativePlanQuestionCall) => { delete c.answeredAt; },
  'unoffered recommendation': (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Recommendation: A' }; },
  'quoted question': (c: NativePlanQuestionCall) => revise(c, '> ' + c.questions[0]!.question.replaceAll('\n', '\n> ')),
  'code question': (c: NativePlanQuestionCall) => revise(c, '```text\n' + c.questions[0]!.question + '\n```'),
  'historical question': (c: NativePlanQuestionCall) => revise(c, 'Historical example:\n' + c.questions[0]!.question),
  'source only in quoted text': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replaceAll('PLAN.md', '"PLAN.md"')),
  'source-only metadata': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace('Project/branch/task:', 'Project/branch/task: quoted source material,')),
  'literal-only explanation': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace(/^ELI10: (.*)$/m, 'ELI10: "$1"')),
  'no own current source': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replaceAll('PLAN.md', 'another-project.md')),
  'no own explanation': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace(/^ELI10:.*$/m, '')),
  'quoted explanation': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question.replace(/^ELI10:/m, '> ELI10:')),
  'withdrawn own decision': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question + '\nThis decision is withdrawn.'),
  'scalar withdrawn own decision': (c: NativePlanQuestionCall) => revise(c, c.questions[0]!.question + '\nThis decision is `withdrawn`.'),
  'duplicate options': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
})) test(`current decision identity rejects ${name}`, () => {
  for (const source of [first.calls[3]!, retry.calls[3]!]) {
    const call = copy(source) as NativePlanQuestionCall; change(call); expect(check(call)).toBe(false);
  }
});

test('current question identity cannot come only from an unrelated recap or bare decision number', () => {
  const call = copy(first.calls[3]!) as NativePlanQuestionCall;
  revise(call, call.questions[0]!.question.replace('finding F1 (PLAN.md:6-8)', 'unrelated prior finding F1 is fixed (PLAN.md:6-8)'));
  expect(check(call)).toBe(false);
  const bare = copy(retry.calls[3]!) as NativePlanQuestionCall;
  revise(bare, bare.questions[0]!.question.replace('R1: ', ''));
  // review-sections.md.tmpl binds a stable R choice to a D question; it does
  // not require that R to be repeated in the title. Bare D lacks either owner.
  bare.questions[0]!.header = 'Retry envelope';
  expect(check(bare)).toBe(false);
});

test('each owned issue counts once regardless of option order, recommendation or repeated tool ID', () => {
  for (const source of [first.calls[3]!, retry.calls[3]!]) {
    const call = copy(source) as NativePlanQuestionCall;
    call.questions[0]!.options.reverse(); call.answers = { [call.questions[0]!.question]: call.questions[0]!.options[0]!.label };
    expect(check(call)).toBe(true);
    expect(check(call, [call])).toBe(false);
    const reasked = copy(call); reasked.toolUseId += '_again';
    expect(check(reasked, [call])).toBe(false);
    expect(check(reasked, [{ ...call, sessionId: 'foreign-session' }])).toBe(false);
  }
});

test('one native batch cannot satisfy the floor and does not suppress a later separate issue', () => {
  const calls = first.calls.slice(3, 7).map(call => copy(call)) as NativePlanQuestionCall[];
  const batch = copy(calls[0]!);
  batch.questions = calls.flatMap(call => call.questions); batch.answers = Object.assign({}, ...calls.map(call => call.answers));
  expect(check(batch)).toBe(false);
  expect(Number(check(batch))).toBeLessThan(3);
  const separate = copy(calls[0]!); separate.toolUseId += '_separate';
  expect(check(separate, [batch])).toBe(true);
});

test('native fingerprint ownership stays mandatory', () => {
  const fp = nativePlanCallFingerprint(copy(retry.calls[3]!) as NativePlanQuestionCall, 0, true);
  fp.signature = 'different:owner'; expect(isEngBatchingIssueAUQ(fp)).toBe(false);
});


test('a record title must match its own native header and remains the same issue after a new D number', () => {
  const original = copy(retry.calls[3]!) as NativePlanQuestionCall;
  const wrong = copy(original); wrong.questions[0]!.header = 'R9 unrelated'; expect(check(wrong)).toBe(false);
  const repeated = copy(original); repeated.toolUseId += '_reopen';
  revise(repeated, repeated.questions[0]!.question.replace('D4 —', 'D24 —'));
  expect(check(repeated, [original])).toBe(false);
  revise(repeated, repeated.questions[0]!.question + '\nR1 is no longer current.');
  expect(check(repeated)).toBe(false);
});

const headerOwned = fixture.headerOwned6bd.calls as NativePlanQuestionCall[];
const headerDecision = headerOwned[2]!;

test('the complete 6bd native history binds header-owned current issue decisions without duplicating their R ID in the title', () => {
  const counter = createEngBatchingIssueCounter(() => '', engSetupAUQ);
  const counted = headerOwned.filter((call, index) => counter.isReviewAUQ(nativePlanCallFingerprint(call, 0, true), headerOwned.slice(0, index)));
  expect(fixture.headerOwned6bd.originalOutcome.reviewCount).toBe(0);
  expect(counted).toHaveLength(7);
  expect(counter.trace.map(row => row.issue)).toEqual(['record:R1','record:R3','record:R5','record:R6','record:R7','record:R2','record:R4']);
  // D9 names another approved decision instead of owning a PLAN.md source;
  // setup, TODO and navigation calls also never inflate the original floor3.
  expect([0,1,8,10,11].some(index => check(headerOwned[index]!))).toBe(false);
});

for (const [name, change] of Object.entries({
  'unanswered': (c: NativePlanQuestionCall) => { c.answered = false; },
  'failed': (c: NativePlanQuestionCall) => { c.failed = true; },
  'missing ACK timestamp': (c: NativePlanQuestionCall) => { delete c.answeredAt; },
  'unanswered tab': (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
  'unoffered answer': (c: NativePlanQuestionCall) => { c.answers = {[c.questions[0]!.question]: 'Approve everything'}; },
  'no header owner': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'Retry'; },
  'quoted header identity': (c: NativePlanQuestionCall) => { c.questions[0]!.header = '"R1" Retry'; },
  'inline-code header identity': (c: NativePlanQuestionCall) => { c.questions[0]!.header = '`R1` Retry'; },
  'historical header': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'R1 historical'; },
  'withdrawn header': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'R1 withdrawn'; },
  'multiple header owners': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'R1 / R2 Retry'; },
  'duplicate header owners': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'R1 / R1 Retry'; },
  'conflicting title owner': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('D3 —','D3 — R9 —')),
  'quoted title owner': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('D3 —','D3 — "R9" —')),
  'multiple title owners': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('D3 —','D3 — R1 and R2 —')),
  'repeated decision identity': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('D3 —','D3 — D3 —')),
  'multiple decision identities': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('D3 —','D3 — D4 —')),
  'historical title': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('D3 —','D3 — Historical example:')),
  'quoted question': (c: NativePlanQuestionCall) => revise(c,'> '+c.questions[0]!.question.replaceAll('\n','\n> ')),
  'no source citation': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('PLAN.md:6-8','the proposal')),
  'quoted source citation': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('PLAN.md:6-8','"PLAN.md:6-8"')),
  'foreign source': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('PLAN.md:6-8','OTHER.md:6-8')),
  'mixed source': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('PLAN.md:6-8','OTHER.md:2 and PLAN.md:6-8')),
  'duplicate source': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('PLAN.md:6-8','PLAN.md:6-8 and PLAN.md:6-8')),
  'source example': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('Project/branch/task:','Project/branch/task: quoted source material,')),
  'no explanation': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace(/^ELI10:.*$/m,'')),
  'quoted explanation': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace(/^ELI10: (.*)$/m,'ELI10: "$1"')),
  'historical explanation': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question.replace('ELI10:','ELI10: Historical example:')),
  'withdrawn current record': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question+'\nR1 is withdrawn.'),
  'withdrawn quoted scalar': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question+'\nR1 is `withdrawn`.'),
  'no own alternative details': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description=''; },
  'short native aliases': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description='Use the saved option B comparison.'; },
  'missing own pro': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description=c.questions[0]!.options[1]!.description!.replace(/✅[^✅❌]*/,''); },
  'missing own con': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description=c.questions[0]!.options[1]!.description!.replace(/❌[^✅❌]*/,''); },
  'quoted option comparison': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description='"'+c.questions[0]!.options[1]!.description!.replaceAll('"','')+'"'; },
  'borrowed option comparison': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description='Option A comparison: '+c.questions[0]!.options[1]!.description; },
  'fenced option comparison': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.description='```text\n'+c.questions[0]!.options[1]!.description+'\n```'; },
  'separately declared option captions': (c: NativePlanQuestionCall) => revise(c,c.questions[0]!.question+'\nA) Some other comparison; B) Preserve the baseline.'),
  'duplicate alternatives': (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label=c.questions[0]!.options[0]!.label; },
})) test(`header-owned current identity rejects ${name}`, () => {
  const call=copy(headerDecision);change(call);expect(check(call)).toBe(false);
});

test('header-owned native issue keeps authentic fingerprint, single-question and distinct-choice guards', () => {
  const call=copy(headerDecision);
  expect(check(call)).toBe(true);
  const reordered=copy(call);reordered.questions[0]!.options.reverse();expect(check(reordered)).toBe(true);
  const wrong=nativePlanCallFingerprint(call,0,true);wrong.signature='foreign:identity';expect(isEngBatchingIssueAUQ(wrong)).toBe(false);
  const tab=nativePlanCallFingerprint(call,0,true);tab.nativeQuestionIndex=1;expect(isEngBatchingIssueAUQ(tab)).toBe(false);
  const mismatch=nativePlanCallFingerprint(call,0,true);mismatch.options.reverse();expect(isEngBatchingIssueAUQ(mismatch)).toBe(false);
  const reask=copy(call);reask.toolUseId+='_reask';revise(reask,reask.questions[0]!.question.replace('D3 —','D33 —'));
  expect(check(reask,[call])).toBe(false);expect(check(call,[call])).toBe(false);
  expect(check(reask,[{...call,sessionId:'another-session'}])).toBe(false);
  const batch=copy(call);batch.questions.push(...copy(headerOwned[3]!.questions));Object.assign(batch.answers!,headerOwned[3]!.answers);
  expect(check(batch)).toBe(false);
});

test('an existing current question also owns its R identity in the header without a line-number requirement', () => {
  const call=copy(retry.calls[3]!) as NativePlanQuestionCall;
  revise(call,call.questions[0]!.question.replace('R1: ',''));
  expect(check(call)).toBe(true);
});

test('a title-owned R cannot hide another or repeated current identity in its native header', () => {
  for (const header of ['R1 / R2 envelope','R1 / R1 envelope']) {
    const call=copy(retry.calls[3]!) as NativePlanQuestionCall;
    call.questions[0]!.header=header;
    expect(check(call)).toBe(false);
  }
});
