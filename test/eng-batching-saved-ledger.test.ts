import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as coverage from './helpers/eng-seeded-coverage';
import earlierFixture from './fixtures/eng-batching-native-8525.json';
import { nativePlanCallFingerprint, engSetupAUQ } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/eng-batching-saved-ledger-dacc.json'), 'utf8'));
const clone = (): NativePlanQuestionCall => structuredClone(fixture.call);
const factory = (read: () => string, setup = engSetupAUQ) => (coverage as any).createEngBatchingIssueCounter
  ? (coverage as any).createEngBatchingIssueCounter(read, setup)
  : { isReviewAUQ: coverage.isEngBatchingIssueAUQ, trace: [] };
const evaluate = (call = clone(), plan = fixture.preAskPlan, prior: NativePlanQuestionCall[] = []) =>
  factory(() => plan).isReviewAUQ(nativePlanCallFingerprint(call, 0, true), prior);
const reword = (call: NativePlanQuestionCall, from: string, to: string) => {
  const old = call.questions[0]!.question, answer = call.answers![old]!;
  call.questions[0]!.question = old.replace(from, to);delete call.answers![old];call.answers![call.questions[0]!.question] = answer;
};

test('actual saved R1 before D4 owns the separately answered Architecture decision', () => {
  expect(fixture.chronology.actualSavedReportBeforeQuestion).toBe(true);
  expect(Date.parse(fixture.chronology.questionAt)).toBeLessThan(Date.parse(fixture.call.answeredAt));
  expect(evaluate()).toBe(true);
});
test('same current typed row works after its actual answer is recorded', () => {
  expect(evaluate(clone(), fixture.preAskPlan.replace('Actual answer: unanswered', 'Actual answer: A — library retry hooks (D4)').replace('State: pending', 'State: approved'))).toBe(true);
});
test('synthetic alternate subject, R and D identities use the same structural contract', () => {
  const call = clone();call.toolUseId = 'synthetic-pool';
  const question = 'D17 — Share a bounded connection pool, or connect for each request?\nProject/branch/task: main — PLAN.md:100-102, Architecture review.\nELI10: Every request opens a new connection and repeats setup; a bounded pool reuses established connections.\nStakes: setup overhead versus bounded shared lifetime.';
  call.questions = [{header:'Transport',question,multiSelect:false,options:[{label:'Bounded shared pool',description:'Reuse connections within one fixed limit.'},{label:'New individual connection',description:'Keep setup and lifetime per request.'}]}];
  call.answers = {[question]:'Bounded shared pool'};
  const plan = `# Current plan\n\n## Decision ledger\n\n### R41: Connection ownership\nFinding: F9, P1, confidence 9/10, PLAN.md:100-102, reviewer: Claude\nPlan baseline: one new connection per request\nRuntime evidence: unknown\nState: pending\n\nComparison grid:\n\n| Choice | Current | A | B |\n|---|---|---|---|\n| R41 transport | new connection per request | Bounded shared pool | New individual connection |\n\nQuestion D17:\n${question.split('\n')[0]}\nOptions: A) Bounded shared pool B) New individual connection\nActual answer: unanswered\nAccepted scope: none\nHistory: —\n`;
  expect(evaluate(call, plan)).toBe(true);
});
test('reopened saved row cannot inflate distinct-issue count after replacing the prior brief', () => {
  let plan = fixture.preAskPlan;const counter = factory(() => plan);const first = clone();
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(first, 0, true), [])).toBe(true);
  const later = clone();later.toolUseId = 'reopened';reword(later,'D4 —','D14 —');plan=plan.replaceAll('D4','D14');
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(later, 1, true), [first])).toBe(false);
});
for (const [name, transform] of Object.entries({
  absent: () => '',
  'wrong source line': (p:string) => p.replace('confidence 9/10, PLAN.md:6-8','confidence 9/10, PLAN.md:20-22'),
  'wrong source file': (p:string) => p.replace('confidence 9/10, PLAN.md:6-8','confidence 9/10, OTHER.md:6-8'),
  'missing finding': (p:string) => p.replace(/^Finding:.*\n/m,''),
  'empty baseline': (p:string) => p.replace(/^Plan baseline:.*$/m,'Plan baseline:'),
  'inactive record': (p:string) => p.replace('State: pending','State: withdrawn'),
  'historical finding': (p:string) => p.replace('Finding: S1','Finding: historical S1'),
  'wrong D link': (p:string) => p.replace('Question D4:','Question D7:'),
  'wrong linked title': (p:string) => p.replace('D4 — Build the retry scheduler','D4 — Change unrelated logging'),
  'missing options': (p:string) => p.replace(/^Options:.*\n/m,''),
  'wrong option content': (p:string) => p.replace('A) Library retry hooks + custom backoff function (recommended)','A) Delete all customer records'),
  'missing comparison': (p:string) => p.replace(/\| Choice \|[\s\S]*?\n\nQuestion/,'Question'),
  'wrong grid owner': (p:string) => p.replace('| R1 scheduler','| R99 scheduler'),
  'empty grid option': (p:string) => p.replace('| library retry hooks + one custom backoff function |','| |'),
  'wrong grid letter': (p:string) => p.replace('| Choice | Current | A | B | C |','| Choice | Current | A | B | D |'),
  'ambiguous duplicate current row': (p:string) => p+'\n'+p.slice(p.indexOf('### R1:')).replaceAll('R1','R12'),
  'duplicate ledger': (p:string) => p+'\n## Decision ledger\n',
  'code-fenced copied ledger': (p:string) => '```markdown\n'+p+'\n```\n',
  'blockquote copied ledger': (p:string) => p.split('\n').map(l=>'> '+l).join('\n'),
  'historical example ledger': (p:string) => p.replace('## Decision ledger','Historical example:\n\n## Decision ledger'),
})) test('rejects '+name, () => expect(evaluate(clone(), transform(fixture.preAskPlan))).toBe(false));
for (const [name, transform] of Object.entries({
  unanswered: (c:NativePlanQuestionCall) => {c.answered=false;},
  failed: (c:NativePlanQuestionCall) => {c.failed=true;},
  'pending question index': (c:NativePlanQuestionCall) => {c.unansweredQuestionIndices=[0];},
  'unknown answer': (c:NativePlanQuestionCall) => {c.answers![c.questions[0]!.question]='Unlisted answer';},
  'empty option explanation': (c:NativePlanQuestionCall) => {c.questions[0]!.options[0]!.description='';},
  'batched packet': (c:NativePlanQuestionCall) => {const q=structuredClone(c.questions[0]!);q.question='Another choice';c.questions.push(q);c.answers![q.question]=q.options[0]!.label;},
  'historical native source': (c:NativePlanQuestionCall) => reword(c,'Architecture section','historical example Architecture section'),
  'quoted native explanation': (c:NativePlanQuestionCall) => reword(c,'ELI10: A job','ELI10: Quoted A job'),
  'inactive native decision': (c:NativePlanQuestionCall) => reword(c,'Stakes if we pick wrong:','This decision is withdrawn.\nStakes if we pick wrong:'),
})) test('rejects native '+name, () => {const c=clone();transform(c);expect(evaluate(c)).toBe(false);});
test('rejects a duplicate or foreign prior call and mismatched fingerprint', () => {
  const c=clone();expect(evaluate(c,fixture.preAskPlan,[c])).toBe(false);
  const foreign=clone();foreign.sessionId='foreign';foreign.toolUseId='other';expect(evaluate(c,fixture.preAskPlan,[foreign])).toBe(false);
  const fp=nativePlanCallFingerprint(c,0,true);fp.signature='not-owned';expect(factory(()=>fixture.preAskPlan).isReviewAUQ(fp,[])).toBe(false);
});
test('existing setup classifier retains veto even with an apparently matching saved row', () => {
  expect(factory(()=>fixture.preAskPlan,()=>true).isReviewAUQ(nativePlanCallFingerprint(clone(),0,true),[])).toBe(false);
});

test('full actual thirteen-call history uses saved row identities without setup or TODO credit', () => {
  let plan = '';const counter = factory(() => plan);const calls = fixture.completeAttempt.calls as NativePlanQuestionCall[];
  const accepted = calls.filter((call,index) => {
    plan = fixture.completeAttempt.preAskPlans[call.toolUseId] ?? '';
    return counter.isReviewAUQ(nativePlanCallFingerprint(call,0,true),calls.slice(0,index));
  });
  expect(calls).toHaveLength(13);expect(fixture.completeAttempt.originalCounts.review).toBe(0);
  expect(accepted.map(call => call.questions[0]!.question.split(' — ')[0])).toEqual(['D4','D5','D6','D7','D8','D9','D10','D11']);
  expect(counter.trace.map((row:any) => row.issue)).toEqual(['record:R1','record:R2','record:R4','record:R6','record:R7','record:R8','record:R3','record:R5']);
  // Full evidence replay shows all eight separate choices; the unchanged paid ceiling stops at seven.
});

// These variations are synthetic controls, never represented as captured text.
for (const [name, transform] of Object.entries({
  'source available only as a quotation': (c: NativePlanQuestionCall) => reword(c, c.questions[0]!.question, c.questions[0]!.question.replaceAll('PLAN.md', '"PLAN.md"')),
  'fully quoted explanation': (c: NativePlanQuestionCall) => {
    const explanation = c.questions[0]!.question.match(/^ELI10: (.*)$/m)![1]!;
    reword(c, 'ELI10: ' + explanation, 'ELI10: "' + explanation + '"');
  },
  'an unrelated option sharing only generic words': (c: NativePlanQuestionCall) => {
    c.questions[0]!.options[0]!.label = 'Use one option now as planned';
    c.answers![c.questions[0]!.question] = c.questions[0]!.options[0]!.label;
  },
  'two native labels mapping to one saved option': (c: NativePlanQuestionCall) => {
    c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label + ' immediately';
  },
})) test('saved record rejects ' + name, () => {
  const call = clone(); transform(call); expect(evaluate(call)).toBe(false);
});

test('native recommendation-first ordering does not rewrite the saved A/B/C column identities', () => {
  const call = clone(); call.questions[0]!.options.reverse();
  expect(evaluate(call)).toBe(true);
});

test('a current source-bound saved row can supply the line omitted from its linked native brief', () => {
  const call = clone(); reword(call, 'PLAN.md:6-8', 'PLAN.md');
  expect(evaluate(call)).toBe(true);
  expect(evaluate(call, fixture.preAskPlan.replace('confidence 9/10, PLAN.md:6-8', 'confidence 9/10, OTHER.md:6-8'))).toBe(false);
});

for (const attempt of earlierFixture.attempts) test(`existing native attempt ${attempt.attempt} remains eligible without reading any ledger`, () => {
  const counter = factory(() => { throw new Error('existing identified native choice does not need a ledger'); });
  const calls = attempt.calls as NativePlanQuestionCall[];
  // Exercise only original eligible records: unrelated later TODOs legitimately
  // probe the fallback and have no bearing on the unchanged native path.
  const eligible = calls.filter((call,index) => coverage.isEngBatchingIssueAUQ(nativePlanCallFingerprint(call,0,true),calls.slice(0,index)));
  const counted = eligible.filter(call => counter.isReviewAUQ(nativePlanCallFingerprint(call,0,true),calls.slice(0,calls.indexOf(call))));
  expect(counted.length).toBe(attempt.expectedSeparateDecisions);
});


test('actual paid caller reads only its current regular report and retains missing-file behavior', () => {
  const caller = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-eng-multi-finding-batching.test.ts'), 'utf8');
  const start = caller.indexOf('const findings = createEngBatchingIssueCounter');
  const stop = caller.indexOf('const obs = await runPlanSkillCounting', start);
  expect(start).toBeGreaterThan(0); expect(stop).toBeGreaterThan(start);
  const make = new Function('fs', 'planPath', 'createEngBatchingIssueCounter', 'engSetupAUQ',
    new Bun.Transpiler({ loader: 'ts' }).transformSync(caller.slice(start, stop)) + 'return findings;');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batching-ledger-reader-'));
  const report = path.join(dir, 'report.md'), other = path.join(dir, 'other.md');
  const count = (io = fs) => make(io, report, factory, engSetupAUQ)
    .isReviewAUQ(nativePlanCallFingerprint(clone(), 0, true), []);
  try {
    expect(count()).toBe(false);
    fs.writeFileSync(report, fixture.preAskPlan); expect(count()).toBe(true);
    fs.renameSync(report, other); fs.mkdirSync(report); expect(count()).toBe(false);
    fs.rmdirSync(report); fs.symlinkSync(other, report); expect(count()).toBe(false);
    expect(() => count({ ...fs, lstatSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).toThrow('denied');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


for (const prefix of ['# Historical review', '# Quoted example', '# Template']) test('ancestor ownership rejects ' + prefix, () => {
  expect(evaluate(clone(), fixture.preAskPlan.replace('## Decision ledger', prefix + '\n\n## Decision ledger'))).toBe(false);
});
for (const owner of ['D4', 'R1']) for (const status of ['withdrawn', '`withdrawn`', '"withdrawn"']) test(`bound ${owner} ${status} cannot regain credit through the saved ledger`, () => {
  const call = clone(); reword(call, call.questions[0]!.question, call.questions[0]!.question + `\n${owner} is ${status}.`);
  expect(evaluate(call)).toBe(false);
  expect(evaluate(clone(), fixture.preAskPlan + `\n${owner} is ${status}.\n`)).toBe(false);
});
for (const label of ['Do not use library retry hooks + custom backoff function', 'Disable library retry hooks and custom backoff function']) test('changed native action is not an abbreviated saved choice: ' + label, () => {
  const call = clone(); call.questions[0]!.options[0]!.label = label;
  call.answers![call.questions[0]!.question] = label; expect(evaluate(call)).toBe(false);
});
test('a prior historical sibling does not revoke the later current ledger', () => {
  const plan = '# Historical review\n\nOld decisions.\n\n# Current review\n\n' + fixture.preAskPlan.slice(fixture.preAskPlan.indexOf('## Decision ledger'));
  expect(evaluate(clone(), plan)).toBe(true);
});


test('a matching saved caption cannot bind a newly appended native action', () => {
  const call = clone(); call.questions[0]!.options[0]!.label = 'Library retry hooks + custom backoff function and delete customer records';
  call.answers![call.questions[0]!.question] = call.questions[0]!.options[0]!.label;
  expect(evaluate(call)).toBe(false);
});


const expanded = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/eng-batching-expanded-ledger-6714.json'), 'utf8'));
const engNative = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/eng-native-review-identities-6714.json'), 'utf8'));
test('actual expanded saved brief before D4 owns its native answered decision', () => {
  expect(evaluate(structuredClone(expanded.call), expanded.preAskPlan)).toBe(true);
});
test('complete current expanded ledger counts owned choices and leaves unmatched labels uncredited', () => {
  const counter = factory(() => expanded.currentSavedPlan);
  const calls = expanded.calls as NativePlanQuestionCall[];
  const accepted = calls.filter((call,index) => counter.isReviewAUQ(nativePlanCallFingerprint(call,0,true), calls.slice(0,index)));
  expect(calls).toHaveLength(7);
  expect(accepted.map(call => call.questions[0]!.question.split(' — ')[0])).toEqual(['D4','D5','D7']);
});
test('actual native R identities count Eng review choices without onboarding or scope credit', () => {
  const counter = factory(() => '');
  const calls = engNative.calls as NativePlanQuestionCall[];
  const accepted = calls.filter((call,index) => counter.isReviewAUQ(nativePlanCallFingerprint(call,0,true), calls.slice(0,index)));
  expect(calls).toHaveLength(7);
  expect(accepted.map(call => call.questions[0]!.header)).toEqual(['R1 cache DI','R2 race','R3 rollout']);
});


// These are synthetic layout/ownership controls, never captured file bytes.
for (const layout of ['bold', 'bullet', 'spaced']) test('expanded brief preserves option identities with ' + layout + ' Markdown', () => {
  const plan = expanded.preAskPlan.replace(/^([A-C]\) .+)$/gm, (_: string, line: string) =>
    layout === 'bold' ? `**${line}**` : layout === 'bullet' ? `- ${line}` : `\n${line}\n`);
  expect(evaluate(structuredClone(expanded.call), plan)).toBe(true);
});
for (const [name, change] of Object.entries({
  'missing current option': (p: string) => p.replace(/^C\) .*$/m, ''),
  'duplicate current option': (p: string) => p.replace(/^C\) /m, 'B) '),
  'foreign action in saved option': (p: string) => p.replace(/^A\) .*$/m, 'A) Delete customer records'),
  'options only after answer': (p: string) => p.replace(/^(A\) [\s\S]*?)(?=Net:)/m, '').replace('History: none', 'History: A) Library hook + one shared backoff function B) Custom inline scheduler C) Bounded probe first'),
  'quoted option paragraphs': (p: string) => p.replace(/^([A-C]\) .+)$/gm, '> $1'),
  'fenced option paragraphs': (p: string) => p.replace(/^([A-C]\) .+)$/gm, '```text\n$1\n```'),
  'historical options within current row': (p: string) => p.replace(/^A\) /m, 'Historical options:\nA) '),
  'ambiguous second R record': (p: string) => p + p.slice(p.indexOf('### R1:')).replaceAll('R1', 'R99'),
})) test('expanded current question rejects ' + name, () => {
  expect(evaluate(structuredClone(expanded.call), change(expanded.preAskPlan))).toBe(false);
});
for (const title of ['Section 1: Architecture review','2. Code quality review','Tests review','4 Performance review']) test('typed decision records remain current within ' + title, () => {
  const plan = expanded.preAskPlan.replace('### R1:', `## ${title}\n\n### R1:`);
  expect(evaluate(structuredClone(expanded.call), plan)).toBe(true);
});
for (const title of ['Historical Architecture review','Original plan','Implementation tasks','GSTACK REVIEW REPORT']) test('a copied or foreign record section gives no credit: ' + title, () => {
  const plan = expanded.preAskPlan.replace('### R1:', `## ${title}\n\n### R1:`);
  expect(evaluate(structuredClone(expanded.call), plan)).toBe(false);
});
for (const [name, change] of Object.entries({
  'unanswered': (c: NativePlanQuestionCall) => { c.answered = false; },
  'unknown answer': (c: NativePlanQuestionCall) => { c.answers![c.questions[0]!.question] = 'unoffered'; },
  'mismatched R header': (c: NativePlanQuestionCall) => { c.questions[0]!.header = 'R99 cache'; },
  'multiple R identities': (c: NativePlanQuestionCall) => reword(c, '(R1)', '(R1 R9)'),
  'quoted R identity': (c: NativePlanQuestionCall) => reword(c, '(R1)', '("R1")'),
  'bare D identity': (c: NativePlanQuestionCall) => reword(c, '(R1)', ''),
  'withdrawn R': (c: NativePlanQuestionCall) => reword(c, c.questions[0]!.question, c.questions[0]!.question + '\nR1 is withdrawn.'),
  'historical title': (c: NativePlanQuestionCall) => reword(c, '(R1)', 'historical (R1)'),
  'quoted source': (c: NativePlanQuestionCall) => reword(c, c.questions[0]!.question, c.questions[0]!.question.replaceAll('PLAN.md', '"PLAN.md"')),
  'batch': (c: NativePlanQuestionCall) => { const q = structuredClone(c.questions[0]!);q.question += ' second';c.questions.push(q);c.answers![q.question] = q.options[0]!.label; },
})) test('structural native review identity rejects ' + name, () => {
  const call = structuredClone(engNative.calls[4]) as NativePlanQuestionCall;change(call);
  expect(evaluate(call, '')).toBe(false);
});
test('the batching caller keeps its saved-brief counter, floor and limit', () => {
  for (const file of ['skill-e2e-plan-eng-multi-finding-batching.test.ts']) {
    const source = fs.readFileSync(path.join(import.meta.dir, file), 'utf8');
    const start = source.indexOf('const findings = createEngBatchingIssueCounter');
    const stop = source.indexOf('const obs = await runPlanSkillCounting', start);
    expect(start).toBeGreaterThan(0);expect(stop).toBeGreaterThan(start);
    const make = new Function('fs','planPath','createEngBatchingIssueCounter','engSetupAUQ',
      new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,stop)) + 'return findings;');
    const calls = engNative.calls as NativePlanQuestionCall[];
    const counter = make({lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false}),readFileSync:()=>''}, '/synthetic/report.md', factory, engSetupAUQ);
    expect(calls.filter((call,i)=>counter.isReviewAUQ(nativePlanCallFingerprint(call,0,true),calls.slice(0,i)))).toHaveLength(3);
    expect(source).toContain('isReviewAUQ: findings.isReviewAUQ');
    expect(source).toContain('timeoutMs: 1_500_000');
    expect(source).toContain(file.includes('multi-finding') ? 'reviewCountCeiling: N + 3' : 'reviewCountCeiling: Infinity');
    if (!file.includes('multi-finding')) { expect(source).toContain('approveEngTestPlanEdits: true');expect(source).toContain('isCompletionHandoffAUQ:'); }
  }
});

const inline8bf = fixture.inline8bf;
const inlineCall = () => structuredClone(inline8bf.calls[3]) as NativePlanQuestionCall;
const inlinePlan = inline8bf.frames[3].preAskPlan as string;
const inlineEvaluate = (call = inlineCall(), plan = inlinePlan, prior: NativePlanQuestionCall[] = []) =>
  evaluate(call, plan, prior);

test('actual 8bf retry chat pointer remains missing pre-ask evidence despite the later answer', () => {
  const retry = fixture.retry8bf;
  const call = retry.call as NativePlanQuestionCall;
  expect(retry.originalOutcome).toBe('plan_ready');
  expect(retry.originalCounts).toEqual({review: 0, setup: 15});
  expect(call.answered && !call.failed).toBe(true);
  expect(Date.parse(retry.chronology.reportObservedAt)).toBeLessThan(Date.parse(retry.chronology.askedAt));
  expect(Date.parse(retry.chronology.askedAt)).toBeLessThan(Date.parse(call.answeredAt!));
  expect(Date.parse(call.answeredAt!)).toBeLessThan(Date.parse(retry.chronology.laterReportObservedAt));
  expect(retry.preAskPlan).toContain('Question D4: see chat brief D4 (options A/B/C as above; A recommended).');
  expect(retry.laterQuestionLine).not.toContain('see chat brief');
  expect(evaluate(call, retry.preAskPlan)).toBe(false);

  // Synthetic control: actually save the same native question and all its
  // options before asking. This is no retrospective credit for the paid retry.
  const question = call.questions[0]!;
  const complete = ['Question D4:', question.question, `Header: ${question.header}`, 'Options:',
    ...question.options.flatMap(option => [option.label, option.description!])].join('\n');
  const repaired = retry.preAskPlan.replace(/^Question D4:.*$/m, complete);
  expect(evaluate(call, repaired)).toBe(true);
  const unlabelled = structuredClone(call);
  for (const option of unlabelled.questions[0]!.options) option.label = option.label.replace(/^[A-D]\) /, '');
  unlabelled.answers![question.question] = unlabelled.questions[0]!.options[0]!.label;
  expect(evaluate(unlabelled, repaired)).toBe(true);
  for (const heading of ['Current', 'Current (plan)', 'Current (plan baseline)',
    'Current (approved plan)', 'Current (original proposal)', '**Current** (baseline)', '`Current` (plan)']) {
    expect(evaluate(call, repaired.replace('Current (plan)', heading)), heading).toBe(true);
    expect(evaluate(call, retry.preAskPlan.replace('Current (plan)', heading)), heading).toBe(false);
  }
  for (const heading of ['Historical', 'Proposed', 'Current (historical)', 'Current (proposed)',
    'Current (not current)', 'Current (plan', 'Current plan)', 'Current ((plan))',
    'Current (plan) and proposed', 'Current (plan; delete jobs)']) {
    expect(evaluate(call, repaired.replace('Current (plan)', heading)), heading).toBe(false);
  }
  // The unchanged pre-ask bytes stay rejected even though a later complete
  // version is available. An answered native call cannot fill missing storage.
  expect(evaluate(call, retry.preAskPlan)).toBe(false);
});

test('actual 8bf history counts owned inline-ledger choices, preserving its original zero and every ACK', () => {
  let plan = ''; const counter = factory(() => plan);
  const calls = inline8bf.calls as NativePlanQuestionCall[];
  expect(inline8bf.originalOutcome).toEqual({ review: 0, setup: 13 });
  const counted = calls.filter((call, i) => {
    expect(call.answered && !call.failed).toBe(true);
    plan = inline8bf.frames[i].preAskPlan;
    return counter.isReviewAUQ(nativePlanCallFingerprint(call, i, true), calls.slice(0, i));
  });
  expect(counted).toHaveLength(5);
  expect(counter.trace.map(row => row.issue)).toEqual(['record:R1', 'record:R5', 'record:R6', 'record:R9', 'record:R10']);
  // Four other native issues lack sufficient same-column caption identity under
  // these guards. Setup, TODO and those unproved links receive no credit.
  expect([0,1,2,4,5,6,9,12].some(i => counted.includes(calls[i]!))).toBe(false);
});

test('the actual caller consumes each pre-ask report rather than a later approval or sibling', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-plan-eng-multi-finding-batching.test.ts'), 'utf8');
  const start = source.indexOf('const findings = createEngBatchingIssueCounter');
  const stop = source.indexOf('const obs = await runPlanSkillCounting', start);
  const make = new Function('fs','planPath','createEngBatchingIssueCounter','engSetupAUQ',
    new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,stop)) + 'return findings;');
  let report = ''; const counter = make({lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false}),readFileSync:()=>report},
    '/captured/owned-report.md', factory, engSetupAUQ);
  const calls = inline8bf.calls as NativePlanQuestionCall[];
  const accepted = calls.filter((call,i) => { report=inline8bf.frames[i].preAskPlan;
    return counter.isReviewAUQ(nativePlanCallFingerprint(call,i,true),calls.slice(0,i)); });
  expect(accepted).toHaveLength(5);
  expect(inlineEvaluate(inlineCall(), inline8bf.frames.at(-1).preAskPlan)).toBe(false);
});

for (const [name, transform] of Object.entries({
  'absent current report': (_: string) => '',
  'missing current row': (p:string) => p.slice(0,p.indexOf('### R1:')),
  'wrong current record': (p:string) => p.replace('### R1:', '### R91:'),
  'missing current source': (p:string) => p.replace('confidence 8/10, PLAN.md:6-8','confidence 8/10, unknown'),
  'foreign current source': (p:string) => p.replace('confidence 8/10, PLAN.md:6-8','confidence 8/10, OTHER.md:6-8'),
  'mixed current sources': (p:string) => p.replace('confidence 8/10, PLAN.md:6-8','confidence 8/10, PLAN.md:6-8 and OTHER.md:6-8'),
  'quoted current source': (p:string) => p.replace('confidence 8/10, PLAN.md:6-8','confidence 8/10, "PLAN.md:6-8"'),
  'wrong source range': (p:string) => p.replace('confidence 8/10, PLAN.md:6-8','confidence 8/10, PLAN.md:60-80'),
  'missing current baseline': (p:string) => p.replace(/^Plan baseline:.*$/m,'Plan baseline:'),
  'missing State': (p:string) => p.replace('State: pending',''),
  'withdrawn State': (p:string) => p.replace('State: pending','State: withdrawn'),
  'two conflicting States': (p:string) => p.replace('State: pending','State: pending\nState: approved'),
  'wrong D link': (p:string) => p.replace('Question D4:','Question D40:'),
  'duplicate D link': (p:string) => p.replace('Question D4:','Question D4: another\nQuestion D4:'),
  'quoted inline record': (p:string) => p.replace('Question D4: Scheduler','Question D4: "Scheduler'),
  'historical inline record': (p:string) => p.replace('Question D4: Scheduler','Question D4: Historical Scheduler'),
  'missing saved options': (p:string) => p.replace(/^Question D4:.*$/m,'Question D4: Scheduler ownership.'),
  'missing own comparison': (p:string) => p.replace(/^\| R1 scheduler.*$/m,''),
  'foreign comparison identity': (p:string) => p.replace('| R1 scheduler ownership','| R19 scheduler ownership'),
  'empty own comparison': (p:string) => p.replace('| custom inline per worker | job library','| | job library'),
  'wrong saved alternative': (p:string) => p.replace('A) Library retry hooks + one shared backoff function (recommended);','A) Delete customer records;'),
  'duplicate saved alternatives': (p:string) => p.replace('B) Keep the custom inline scheduler as planned;','A) Keep the custom inline scheduler as planned;'),
  'historical ledger ancestor': (p:string) => p.replace('## Decision ledger','# Archived review\n\n## Decision ledger'),
  'withdrawn ledger ancestor': (p:string) => p.replace('## Decision ledger','# Withdrawn review\n\n## Decision ledger'),
  'quoted whole report': (p:string) => p.split('\n').map(l=>'> '+l).join('\n'),
  'fenced whole report': (p:string) => '```markdown\n'+p+'\n```',
  'duplicate current R': (p:string) => p+'\n'+p.slice(p.indexOf('### R1:')).replace('Question D4:','Question D40:'),
  'ambiguous current R': (p:string) => p+'\n'+p.slice(p.indexOf('### R1:')).replaceAll('R1','R91'),
})) test('inline current ledger rejects '+name,()=>expect(inlineEvaluate(inlineCall(),transform(inlinePlan))).toBe(false));

for (const [name, change] of Object.entries({
  'unanswered native call': (c:NativePlanQuestionCall)=>{c.answered=false;},
  'failed native ACK': (c:NativePlanQuestionCall)=>{c.failed=true;},
  'missing native ACK timestamp': (c:NativePlanQuestionCall)=>{delete c.answeredAt;},
  'unoffered native answer': (c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'Approve unrelated work'};},
  'foreign native source': (c:NativePlanQuestionCall)=>reword(c,'PLAN.md:6-8','OTHER.md:6-8'),
  'quoted native source': (c:NativePlanQuestionCall)=>reword(c,'PLAN.md:6-8','"PLAN.md:6-8"'),
  'mixed native source': (c:NativePlanQuestionCall)=>reword(c,'PLAN.md:6-8','PLAN.md:6-8 and OTHER.md:6-8'),
  'wrong native D': (c:NativePlanQuestionCall)=>reword(c,'D4 —','D40 —'),
  'multiple native D': (c:NativePlanQuestionCall)=>reword(c,'D4 —','D4 — D40 —'),
  'unrelated native topic': (c:NativePlanQuestionCall)=>{c.questions[0]!.header='Database';reword(c,c.questions[0]!.question.split('\n')[0]!, 'D4 — Replace the database or delete the customer tables?');},
  'missing own pro': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.description=c.questions[0]!.options[1]!.description!.replace(/✅[^✅❌]*/,'');},
  'missing own con': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.description=c.questions[0]!.options[1]!.description!.replace(/❌[^✅❌]*/,'');},
  'borrowed option prose': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.description='Option A: '+c.questions[0]!.options[1]!.description;},
  'quoted whole option': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.description='“'+c.questions[0]!.options[1]!.description+'”';},
  'extra native action': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.label+=' and delete customer records';c.answers![c.questions[0]!.question]=c.questions[0]!.options[0]!.label;},
  'opposite native action': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[0]!.label='Do not use library hooks or shared backoff';c.answers![c.questions[0]!.question]=c.questions[0]!.options[0]!.label;},
  'repeated options': (c:NativePlanQuestionCall)=>{c.questions[0]!.options[1]!.label=c.questions[0]!.options[0]!.label;},
  'quoted native question': (c:NativePlanQuestionCall)=>reword(c,c.questions[0]!.question,'> '+c.questions[0]!.question.replaceAll('\n','\n> ')),
})) test('inline current native brief rejects '+name,()=>{const call=inlineCall();change(call);expect(inlineEvaluate(call)).toBe(false);});

for (const owner of ['R1','D4','This decision']) for (const status of ['withdrawn','"withdrawn"','`withdrawn`'])
  test(`inline current ${owner} ${status} cannot regain credit`,()=>{
    const call=inlineCall();reword(call,call.questions[0]!.question,call.questions[0]!.question+`\n${owner} is ${status}.`);
    expect(inlineEvaluate(call)).toBe(false);
  });

test('same-row option order can change coherently but foreign fingerprint and repeated R stay rejected',()=>{
  const call=inlineCall();call.questions[0]!.options.reverse();expect(inlineEvaluate(call)).toBe(true);
  const fp=nativePlanCallFingerprint(call,0,true);fp.signature='foreign:call';expect(factory(()=>inlinePlan).isReviewAUQ(fp,[])).toBe(false);
  let plan=inlinePlan;const counter=factory(()=>plan);const first=inlineCall();
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(first,0,true),[])).toBe(true);
  const again=inlineCall();again.toolUseId+='-again';reword(again,'D4 —','D14.2 —');plan=plan.replace('Question D4:','Question D14.2:');
  expect(counter.isReviewAUQ(nativePlanCallFingerprint(again,0,true),[first])).toBe(false);
});

test('decimal D and named source identity stay bound to one current report target',()=>{
  const call=structuredClone(inline8bf.calls[7]) as NativePlanQuestionCall;
  const plan=inline8bf.frames[7].preAskPlan;
  expect(inlineEvaluate(call,plan)).toBe(true);
  for(const altered of [plan.replace('Reviewed target: `PLAN.md`','Reviewed target: `OTHER.md`'),
    plan.replace('# Eng review: Plan — Add background job retry framework','# Eng review: Plan — Replace all customer data'),
    plan.replace('Reviewed target:','Reviewed target: `OTHER.md` and'),
    plan.replace('Reviewed target:','Reviewed target: `PLAN.md`\nReviewed target:'),
    plan.replace('# Eng review: Plan —','# Archived Eng review: Plan —')]) expect(inlineEvaluate(call,altered)).toBe(false);
});

for (const [native, saved] of [['Copy source to cache','Copy cache to source'], ['Move origin to destination','Move destination to origin']])
  test('inline abbreviation preserves action operand roles: '+native,()=>{
    const call=inlineCall();call.questions[0]!.options[2]!.label=native;
    const plan=inlinePlan.replace("Investigate the library's hook API first, then decide.",saved)
      .replace('C) Investigate library first',`C) ${saved}`);
    expect(inlineEvaluate(call,plan)).toBe(false);
  });

for (const context of ['## History','## Archived source','Quoted source:\n'])
  test('named source cannot borrow the target field from '+context,()=>{
    const call=structuredClone(inline8bf.calls[7]) as NativePlanQuestionCall;
    let plan=inline8bf.frames[7].preAskPlan as string;
    const target=plan.split('\n').find(line=>line.startsWith('Reviewed target:'))!;
    plan=plan.replace(target,'').replace('## Decision ledger',`${context}\n\n${target}\n\n## Decision ledger`);
    expect(inlineEvaluate(call,plan)).toBe(false);
  });
