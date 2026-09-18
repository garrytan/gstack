import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/ceo-native-ledger-8525.json';
import { ceoPaymentFinding, createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ, ceoStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';

const clone = <T>(v: T): T => structuredClone(v);
const cab3 = fixture.attributedCurrentCab3.rows;
const currentCall = (i: number) => nativePlanCallFingerprint(clone(cab3[i]!.call), 1, true);
const currentDecision = (i: number, question = currentCall(i), plan = cab3[i]!.savedPlan) =>
  createCeoPaymentFindingCounter(cab3[i]!.seed, () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);
function amendCurrent(question: ReturnType<typeof currentCall>, change: (q: NonNullable<typeof question.nativeCall>['questions'][number]) => void) {
  const q=question.nativeCall!.questions[0]!,answer=question.nativeCall!.answers![q.question]!;change(q);
  question.nativeCall!.answers={[q.question]:answer};question.options=q.options.map((o,i)=>({index:i+1,label:o.label}));
}
test('actual current title attribution and inherited line citations preserve both completed decisions',()=>{
  for(let i=0;i<2;i++){
    expect(Date.parse(cab3[i]!.savedAt)).toBeLessThan(Date.parse(cab3[i]!.questionIssuedAt));
    expect(currentDecision(i)).toBe(true);
  }
  expect(ceoPaymentFinding(currentCall(0),cab3[0]!.seed,cab3[0]!.savedPlan)).toMatchObject({seed:'lookup',ledgerId:'R2'});
  const generic=createCeoPaymentFindingCounter(cab3[1]!.seed,()=>cab3[1]!.savedPlan,ceoFirstReviewAUQ);
  expect(generic.isReviewAUQ(currentCall(1))).toBe(true);
  expect(generic.trace).toMatchObject([{kind:'recorded-decision',ledgerId:'R1'}]);
});
for(const [name,mutation]of Object.entries({
  'as-written attribution':(q:any)=>{q.question=q.question.replace('raw SQL fragment as planned','raw SQL fragment as written');q.options[1].label=q.options[1].label.replace('as planned','as written');},
  'different affirmative explanation wording':(q:any)=>{q.question=q.question.replace('the plan pastes that text straight into a SQL query','the plan puts the untouched ID text directly in the SQL query');},
}))test(`attributed current baseline supports ${name}`,()=>{const q=currentCall(0);amendCurrent(q,mutation);expect(currentDecision(0,q)).toBe(true);});
for(const [name,mutation]of Object.entries({
  'quoted title attribution':(q:any)=>{q.question=q.question.replace('raw SQL fragment as planned','"raw SQL fragment as planned"');},
  'code-only title attribution':(q:any)=>{q.question=q.question.replace('raw SQL fragment as planned','`raw SQL fragment as planned`');},
  'historical title':(q:any)=>{q.question=q.question.replace('D3 —','D3 — Historical example:');},
  'missing affirmative explanation':(q:any)=>{q.question=q.question.replace(/^ELI10:.*$/m,'ELI10: These are some possible API choices.');},
  'foreign plan explanation':(q:any)=>{q.question=q.question.replace(/^ELI10:.*$/m,'ELI10: Another plan inserts this text into SQL.');},
  'healthy current explanation':(q:any)=>{q.question=q.question.replace(/^ELI10:.*$/m,'ELI10: The current plan binds each parameter in the SQL query.');},
  'negated current explanation':(q:any)=>{q.question=q.question.replace(/^ELI10:.*$/m,'ELI10: The plan does not put this ID text in SQL.');},
  'conditional explanation':(q:any)=>{q.question=q.question.replace(/^ELI10:.*$/m,'ELI10: If approved, the plan puts this ID text in SQL.');},
  'quoted current explanation':(q:any)=>{q.question=q.question.replace(/^ELI10:.*$/m,'ELI10: "The plan puts this ID text in SQL."');},
  'withdrawn explanation':(q:any)=>{q.question=q.question.replace('ELI10:','ELI10: This finding is withdrawn.');},
  'missing matching offered alternative':(q:any)=>{q.options[1].label='B) Keep the old ORM finder';},
  'withdrawn matching offered baseline':(q:any)=>{q.options[1].description+=' This option is withdrawn.';},
  'baseline alternative appends an action':(q:any)=>{q.options[1].label='B) Keep raw SQL fragment and delete the audit log (as planned)';},
  'partial baseline caption':(q:any)=>{q.question=q.question.replace('raw SQL fragment as planned','raw SQL frag as planned');q.options[1].label='B) Keep raw SQL frag (as planned)';},
  'duplicate attributed baseline':(q:any)=>{q.question=q.question.replace('raw SQL with manual escaping?','raw SQL fragment as planned?');},
}))test(`attributed baseline rejects ${name}`,()=>{const q=currentCall(0);amendCurrent(q,mutation);expect(()=>currentDecision(0,q)).toThrow(/cannot exclude/);});
for(const [name,mutation]of Object.entries({
  'foreign source':(p:string)=>p.replace('Source: `PLAN.md`','Source: `foreign.md`'),
  'missing source':(p:string)=>p.replace(/^Source:.*$/m,''),
  'ambiguous source':(p:string)=>p+'\nSource: other.md\n',
  'duplicate source':(p:string)=>p+'\nSource: PLAN.md\n',
  'quoted source':(p:string)=>p.replace('Source: `PLAN.md`','> Source: `PLAN.md`'),
  'code-only source':(p:string)=>p.replace(/^Source:.*$/m,m=>'```text\n'+m+'\n```'),
  'historical source':(p:string)=>p.replace('Source: `PLAN.md`','Historical source: `PLAN.md`'),
  'foreign row citation':(p:string)=>p.replace('Plan line 100-103:','Other plan line 100-103:'),
  'line-only subject with no line reference':(p:string)=>p.replace('Plan line 100-103:','Plan line unknown:'),
  'reversed line range':(p:string)=>p.replace('Plan line 100-103:','Plan line 103-100:'),
  'nonexistent source line':(p:string)=>p.replace('Plan line 100-103:','Plan line 9999:'),
  'withdrawn comparison':(p:string)=>p.replace('### R1 Handler routing','### Historical R1 Handler routing'),
  'missing same-option comparison':(p:string)=>p.replace(/^\| B\) Separate class, registered in dispatcher.*\n/m,''),
  'missing same-option risk':(p:string)=>p.replace('| low | One routing path;','| | One routing path;'),
  'foreign ledger':(p:string)=>p.replaceAll('R1','OTHER'),
}))test(`line citation inheritance rejects ${name}`,()=>{expect(()=>currentDecision(1,currentCall(1),mutation(cab3[1]!.savedPlan))).toThrow(/cannot exclude/);});
test('both new paths retain native answer ownership and active source guards',()=>{
  for(let i=0;i<2;i++)for(const change of [(q:ReturnType<typeof currentCall>)=>{q.nativeCall!.answered=false;},(q:ReturnType<typeof currentCall>)=>{q.signature='foreign';},(q:ReturnType<typeof currentCall>)=>{q.nativeCall!.answers={};}]){const q=currentCall(i);change(q);expect(()=>currentDecision(i,q)).toThrow();}
  for(const source of ['foreign.md','PLAN.md\n\nSource: PLAN.md'])expect(()=>currentDecision(0,currentCall(0),cab3[0]!.savedPlan.replace('Source plan: `PLAN.md`','Source plan: '+source))).toThrow(/cannot exclude/);
});
const five = fixture.groups.find(g => g.name === 'five-retry')!;
const paired = fixture.groups.find(g => g.name === 'paired-first')!;
const record = five.calls.at(-1)!;
const fp = (row = record) => nativePlanCallFingerprint(clone(row.call), 1, true);
const recognize = (question = fp(), plan = record.savedPlan, seed = five.seed) => ceoPaymentFinding(question, seed, plan);
const reanswer = (question: ReturnType<typeof fp>) => {
  const q = question.nativeCall!.questions[0]!;
  question.nativeCall!.answers = { [q.question]: q.options[0]!.label };
  question.options = q.options.map((o, i) => ({ index: i + 1, label: o.label }));
};

test('public capture lineage has a successful exact-path save before each remedy question and its actual ACK', () => {
  for (const group of [five, paired]) for (const row of group.calls.filter(c => c.savedPlan)) {
    const save = row.successfulPriorMutations.at(-1)!;
    expect(Date.parse(save.completedAt)).toBeLessThan(Date.parse(row.questionIssuedAt));
    expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt!));
    expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(save.savedPlanSha256);
    expect(save.path).toMatch(/gstack-test-plan-ceo(?:-paired)?\.md$/);
    expect(row.call.answered).toBe(true);
    expect(row.call.failed).toBe(false);
  }
});

for (const [name, expected] of [['five-first', 0], ['five-retry', 1], ['paired-first', 2], ['paired-second', 3]] as const) {
  test(`actual ${name} public calls count remedies independently and never read a missing plan for onboarding`, () => {
    const group = fixture.groups.find(g => g.name === name)!;
    let plan = '', count = 0, reads = 0, boundary = false;
    const counter = createCeoPaymentFindingCounter(group.seed, () => {
      reads += 1;
      if (!plan) throw new Error('working plan does not exist yet');
      return plan;
    }, ceoFirstReviewAUQ);
    const prior: typeof group.calls[number]['call'][] = [];
    for (const row of group.calls) {
      plan = row.savedPlan;
      const question = fp(row);
      const phase = planCountQuestionPhase(question, boundary, ceoStep0Boundary, ceoFirstReviewAUQ);
      count += Number(counter.isReviewAUQ(question, prior));
      boundary = phase.reviewStarted;
      prior.push(row.call);
    }
    expect(count).toBe(expected);
    expect(reads).toBe(expected);
    expect(boundary).toBe(false); // fixture metric does not advance the shared review phase
    expect(counter.trace.filter(t => 'seed' in t).map(t => 'seed' in t && t.seed)).toEqual(
      name === 'five-retry' ? ['dispatcher'] : []);
    if (name.startsWith('paired')) expect(counter.trace.filter(t => 'kind' in t && t.kind === 'recorded-decision'))
      .toHaveLength(expected);
  });
}

test('a correct existing dispatcher baseline does not erase its defective pending alternative', () => {
  expect(record.savedPlan).toContain('Prior library-adapter handler, dispatched through `WebhookDispatcher`.');
  expect(recognize()).toMatchObject({ seed: 'dispatcher', ledgerId: 'R1' });
  const renamed = fp(); renamed.nativeCall!.questions[0]!.question = renamed.nativeCall!.questions[0]!.question.replaceAll('R1', 'PAYMENT-19'); reanswer(renamed);
  expect(recognize(renamed, record.savedPlan.replaceAll('R1', 'PAYMENT-19'))).toMatchObject({ seed: 'dispatcher', ledgerId: 'PAYMENT-19' });
});

for (const [name, mutation] of Object.entries({
  'resolved proposal': (plan: string) => plan.replace('Bypass the dispatcher with a standalone class (plan) vs register the new app-owned class with the existing dispatcher. Options compared below.', 'Register the app-owned class with the existing dispatcher. This decision is resolved.'),
  'approved baseline with no pending defect': (plan: string) => plan.replace('| unresolved |', '| approved |'),
  'deferred proposal': (plan: string) => plan.replace('| unresolved |', '| deferred |'),
  'quoted ledger': (plan: string) => plan.split('\n').map(l => '> ' + l).join('\n'),
  'code-only ledger': (plan: string) => '```md\n' + plan + '\n```',
  'foreign row identity': (plan: string) => plan.replaceAll('R1', 'OTHER'),
  'unrelated source evidence': (plan: string) => plan.replaceAll('PLAN.md', 'elsewhere.md'),
  'duplicate row evidence': (plan: string) => plan + '\n' + plan,
})) test(`pending-proposal route rejects ${name}`, () => expect(recognize(fp(), mutation(record.savedPlan))).toBeNull());

for (const [name, mutation] of Object.entries({
  'missing answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.answered = false; q.nativeCall!.answers = {}; },
  'failed call': (q: ReturnType<typeof fp>) => { q.nativeCall!.failed = true; },
  'foreign owner': (q: ReturnType<typeof fp>) => { q.signature = 'another:call'; },
  'recommendation without offered answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.answers = { [q.nativeCall!.questions[0]!.question]: 'Recommendation: A' }; },
  'quoted question': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = q.nativeCall!.questions[0]!.question.split('\n').map(l => '> ' + l).join('\n'); reanswer(q); },
  'no current defect': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = q.nativeCall!.questions[0]!.question.replace(/^ELI10: .+$/m, 'ELI10: This finding is resolved. There is no current defect.'); reanswer(q); },
})) test(`native evidence rejects ${name}`, () => { const q = fp(); mutation(q); expect(recognize(q)).toBeNull(); });

test('learnings recognition delegates to shared setup semantics without accepting a component remedy or arbitrary menu', () => {
  const learnings = fixture.groups[0]!.calls.at(-1)!;
  const counter = createCeoPaymentFindingCounter(five.seed, () => { throw new Error('plan read'); }, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(fp(learnings))).toBe(false);
  for (const mutate of [
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.header = 'Security issue'; },
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.options[1]!.label = 'Discuss later'; },
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = 'D2 — Enable the new storage feature?'; },
    (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = '> ' + q.nativeCall!.questions[0]!.question.replaceAll('\n', '\n> '); },
  ]) {
    const q = fp(learnings); mutate(q); reanswer(q);
    expect(() => counter.isReviewAUQ(q)).toThrow('plan read');
  }
});

test('paired remedies require their own saved row and verification contract, not bare identifiers', () => {
  for (const row of paired.calls.slice(1)) {
    const q = fp(row);
    const counter = (plan: string) => createCeoPaymentFindingCounter(paired.seed, () => plan, ceoFirstReviewAUQ);
    expect(counter(row.savedPlan).isReviewAUQ(q)).toBe(true);
    expect(() => counter(paired.seed).isReviewAUQ(q)).toThrow(/cannot exclude/);
    q.nativeCall!.questions[0]!.options = [{label:'chargeId amountCents currency retries backoff'}, {label:'Other'}]; reanswer(q);
    expect(() => counter(row.savedPlan).isReviewAUQ(q)).toThrow(/cannot exclude/);
  }
});

for (const [name, mutate] of Object.entries({
  'missing document source': (plan: string) => plan.replace(/^Source plan:.*$/m, ''),
  'foreign document source': (plan: string) => plan.replace(/^Source plan: PLAN\.md/m, 'Source plan: unrelated.md'),
  'quoted document source': (plan: string) => plan.replace(/^Source plan:(.*)$/m, '> Source plan:$1'),
  'code-only document source': (plan: string) => plan.replace(/^Source plan:(.*)$/m, '\n```text\nSource plan:$1\n```\n'),
  'row lacking its own evidence reference': (plan: string) => plan.replaceAll('Evidence: plan text; factory/sleeper not in checkout.', 'No evidence available.'),
})) test(`paired source inheritance rejects ${name}`, () => {
  const row = paired.calls[2]!;
  const counter = createCeoPaymentFindingCounter(paired.seed, () => mutate(row.savedPlan), ceoFirstReviewAUQ);
  expect(() => counter.isReviewAUQ(fp(row))).toThrow(/cannot exclude/);
});

test('a packet that batches both paired findings earns no single-question substitute credit', () => {
  const q = fp(paired.calls[1]!);
  q.nativeCall!.questions.push(clone(paired.calls[2]!.call.questions[0]!));
  q.nativeCall!.answers = Object.assign({}, paired.calls[1]!.call.answers, paired.calls[2]!.call.answers);
  expect(ceoPaymentFinding(q, paired.seed, paired.calls[2]!.savedPlan)).toBeNull();
});

test('unknown decisions still fail closed and repeated owned remedies count toward the unchanged ceiling', () => {
  const counter = createCeoPaymentFindingCounter(five.seed, () => record.savedPlan, ceoFirstReviewAUQ);
  let count = 0;
  for (let i = 0; i < 8; i++) {
    const q = fp(); q.nativeCall!.toolUseId += `-${i}`; q.signature += `-${i}`;
    count += Number(counter.isReviewAUQ(q));
  }
  expect(count).toBe(8);
  const unknown = fp(); unknown.nativeCall!.questions[0]!.question = 'D5 — Should we change billing currency?'; reanswer(unknown);
  expect(() => counter.isReviewAUQ(unknown)).toThrow(/cannot exclude/);
});


const pairedRetry = fixture.groups.find(g => g.name === 'paired-second')!;
const addedDecision = pairedRetry.calls.at(-1)!;
const genericCounter = (plan = addedDecision.savedPlan) => createCeoPaymentFindingCounter(pairedRetry.seed, () => plan, ceoFirstReviewAUQ);

test('paired retry preserves all five original calls and labels missing saved-plan evidence as synthetic', () => {
  expect(pairedRetry.calls).toHaveLength(5);
  expect(pairedRetry.syntheticSavedPlans).toBe(true);
  expect(pairedRetry.limitations).toContain('do not prove original saved bytes or mutation timestamps');
  for (const row of pairedRetry.calls) {
    expect(row.call.answered).toBe(true);
    expect(row.call.failed).toBe(false);
    expect(row.successfulPriorMutations).toEqual([]);
    if (row.savedPlan) expect(row.savedPlan).toContain('not the original saved artifact');
  }
  const counter = genericCounter();
  expect(counter.isReviewAUQ(fp(addedDecision))).toBe(true);
  expect(counter.trace).toEqual([{ signature: fp(addedDecision).signature, kind: 'recorded-decision', ledgerId: 'R3', phase: 'R3 options' }]);
});

for (const [name, mutate] of Object.entries({
  'no saved decision record': (_plan: string) => pairedRetry.seed,
  'wrong ledger identity': (plan: string) => plan.replaceAll('R3', 'UNOWNED'),
  'wrong evidence source': (plan: string) => plan.replaceAll('PLAN.md', 'another-project.md'),
  'source named only in unrelated body': (plan: string) => plan.replace('Payment test review; source PLAN.md.', 'No evidence available.'),
  'unchanged proposal': (plan: string) => plan.replace('Also assert Stripe mock call history length === 1 in test 1', 'Test 1 asserts receipt only (R1)'),
  'withdrawn proposal': (plan: string) => plan.replace('Also assert Stripe mock call history length === 1 in test 1', 'This decision is withdrawn. Also assert Stripe mock call history length === 1 in test 1'),
  'inactive status': (plan: string) => plan.replace('| unresolved |', '| historical |'),
  'blockquote ledger': (plan: string) => plan.split('\n').map(line => '> ' + line).join('\n'),
  'code ledger': (plan: string) => '```markdown\n' + plan + '\n```',
  'comparison belongs to another row': (plan: string) => plan.replace('### R3 options', '### R2 options'),
  'historical comparison': (plan: string) => plan.replace('### R3 options', '### Historical R3 options'),
  'missing comparison': (plan: string) => plan.split('### R3 options')[0]!,
  'incomplete comparison': (plan: string) => plan.replace('| S | medium |', '|  | medium |'),
  'missing risk column': (plan: string) => plan.replace('| Risk |', '| Notes |'),
  'duplicate current row': (plan: string) => plan + '\n' + plan,
})) test(`generic saved-decision route rejects ${name}`, () => {
  expect(() => genericCounter(mutate(addedDecision.savedPlan)).isReviewAUQ(fp(addedDecision))).toThrow(/cannot exclude/);
});

for (const [name, mutate] of Object.entries({
  'unowned call': (q: ReturnType<typeof fp>) => { q.signature = 'other-session:other-tool'; },
  'pending answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.answered = false; q.nativeCall!.answers = {}; },
  'failed answer': (q: ReturnType<typeof fp>) => { q.nativeCall!.failed = true; },
  'recommendation only': (q: ReturnType<typeof fp>) => { q.nativeCall!.answers = { [q.nativeCall!.questions[0]!.question]: 'Recommendation: A' }; },
  'ID only in quoted recap': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = 'D3 — Should we alter the setup?\n> Earlier R3: single-attempt assertion'; reanswer(q); },
  'quoted current question': (q: ReturnType<typeof fp>) => { q.nativeCall!.questions[0]!.question = '> ' + q.nativeCall!.questions[0]!.question.replaceAll('\n', '\n> '); reanswer(q); },
  'unrelated menu with matching letters': (q: ReturnType<typeof fp>) => {
    q.nativeCall!.questions[0]!.question = 'D3 — R3: Which project theme should we use?';
    q.nativeCall!.questions[0]!.options = [{ label: 'A) Indigo palette', description: 'Use indigo.' }, { label: 'B) Orange palette', description: 'Use orange.' }]; reanswer(q);
  },
})) test(`generic saved-decision ownership rejects ${name}`, () => {
  const q = fp(addedDecision); mutate(q);
  expect(() => genericCounter().isReviewAUQ(q)).toThrow();
});

test('known onboarding and scope menus cannot borrow a saved decision row for finding credit', () => {
  for (const row of pairedRetry.calls.slice(0, 2)) {
    const counter = genericCounter();
    expect(counter.isReviewAUQ(fp(row))).toBe(false);
    expect(counter.trace).toEqual([{ signature: fp(row).signature, kind: 'setup' }]);
  }
  const q = fp(addedDecision);
  q.nativeCall!.questions[0]!.question = 'D3 — R3: Select review mode';
  q.nativeCall!.questions[0]!.options = ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'].map(label => ({ label })); reanswer(q);
  expect(genericCounter().isReviewAUQ(q)).toBe(false);
});

import currentFixture from './fixtures/ceo-recorded-decisions-dacc95ea.json';

const currentFp = (row = currentFixture.cases[1]!) =>
  nativePlanCallFingerprint(clone(row.call) as any, Date.parse(row.call.answeredAt), true);
const countCurrent = (question = currentFp(), plan = currentFixture.cases[1]!.savedPlan, seed = currentFixture.cases[1]!.seed) =>
  createCeoPaymentFindingCounter(seed, () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);

for (const row of currentFixture.cases) test(`captured dacc95ea ${row.name} counts its owned saved decision`, () => {
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedPlanSha256);
  expect(Date.parse(row.successfulPriorMutations.at(-1)!.completedAt)).toBeLessThan(Date.parse(row.questionIssuedAt));
  expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt));
  expect(countCurrent(currentFp(row), row.savedPlan, row.seed)).toBe(true);
});


const pairedCurrent = currentFixture.cases[1]!;
const optionsStart = pairedCurrent.savedPlan.indexOf('- **A)');
const beforeOptions = pairedCurrent.savedPlan.slice(0, optionsStart);
const optionBody = pairedCurrent.savedPlan.slice(optionsStart, pairedCurrent.savedPlan.indexOf('\nRecommendation:', optionsStart));
const afterOptions = pairedCurrent.savedPlan.slice(pairedCurrent.savedPlan.indexOf('\nRecommendation:', optionsStart));
const replaceOptions = (body: string) => beforeOptions + body + afterOptions;
const sourceLine = pairedCurrent.savedPlan.split('\n').find(line => line.startsWith('Working plan for'))!;
const currentOptions = optionBody.split(/\n(?=- \*\*[A-C]\))/);

for (const [name, plan] of Object.entries({
  'standalone source metadata': pairedCurrent.savedPlan.replace(sourceLine, 'Source plan: PLAN.md.'),
  'source-plan label in current metadata': pairedCurrent.savedPlan.replace('Source: `PLAN.md`', 'Source plan: `PLAN.md`'),
  'review-target source metadata': pairedCurrent.savedPlan.replace('Source: `PLAN.md`', 'Plan under review: `PLAN.md`'),
  'source section citations': pairedCurrent.savedPlan.replaceAll('plan §', 'plan section '),
  'paragraph alternatives': replaceOptions(currentOptions.map(block => block.replace(/^- /, '')).join('\n\n')),
  'plain list labels': replaceOptions(optionBody.replaceAll('**', '')),
  'named effort and risk fields': replaceOptions(optionBody.replaceAll('Effort S', 'Effort estimate: S').replaceAll('Risk low', 'Risk level: low').replaceAll('Risk high', 'Risk level: high')),
  'risk before effort': replaceOptions(optionBody.replace('Effort S (~6 lines).\n  Risk low.', 'Risk low. Effort S (~6 lines).')),
  'line-separated typed facts': replaceOptions(optionBody.replace(/\.\s+(?=Effort|Risk|Pros:|Cons:)/g, '\n  ')),
  'semicolon-separated typed facts': replaceOptions(optionBody.replace(/\.\s+(?=Effort|Risk|Pros:|Cons:)/g, '; ')),
})) test(`owned prose comparison accepts ${name}`, () => expect(countCurrent(currentFp(), plan)).toBe(true));

for (const [name, plan] of Object.entries({
  'source missing': pairedCurrent.savedPlan.replace(sourceLine, 'Working plan; source unavailable.'),
  'foreign source': pairedCurrent.savedPlan.replace('Source: `PLAN.md`', 'Source: `OTHER.md`'),
  'source in unrelated prose': pairedCurrent.savedPlan.replace(sourceLine, 'An unrelated example elsewhere mentions PLAN.md.'),
  'quoted source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '> ' + sourceLine),
  'fenced source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '```md\n' + sourceLine + '\n```'),
  'literal source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '"' + sourceLine + '"'),
  'historical source paragraph': pairedCurrent.savedPlan.replace(sourceLine, '## Historical metadata\n\n' + sourceLine + '\n\n## Current review'),
  'contradictory source records': pairedCurrent.savedPlan + '\n\nSource plan: OTHER.md.\n',
  'row has no source citation': pairedCurrent.savedPlan.replaceAll('(plan §Existing behavior)', '(unsupported)').replaceAll('(plan §Infrastructure)', '(unsupported)'),
  'row cites a foreign source': pairedCurrent.savedPlan.replaceAll('plan §', 'OTHER.md §'),
  'wrong row identity': pairedCurrent.savedPlan.replaceAll('D1', 'DIFFERENT'),
  'inactive row status': pairedCurrent.savedPlan.replaceAll('| unresolved |', '| historical |'),
  'unchanged current/proposed values': pairedCurrent.savedPlan.replace('Assert full receipt equality; optionally assert single charge call with `{amountCents:1000, currency:"USD"}` and zero sleeper records.', 'Assert receipt is truthy only.'),
  'withdrawn proposed remedy': pairedCurrent.savedPlan.replace('Assert full receipt equality;', 'This decision is withdrawn. Assert full receipt equality;'),
  'quoted ledger': pairedCurrent.savedPlan.split('\n').map(line => '> ' + line).join('\n'),
  'fenced ledger': '```md\n' + pairedCurrent.savedPlan + '\n```',
  'duplicate ledger': pairedCurrent.savedPlan + '\n' + pairedCurrent.savedPlan,
  'comparison under history': pairedCurrent.savedPlan.replace('### D1 — options comparison', '## Historical review\n\n### D1 — options comparison'),
  'historical comparison heading': pairedCurrent.savedPlan.replace('### D1 — options comparison', '### Historical D1 — options comparison'),
  'foreign comparison heading': pairedCurrent.savedPlan.replace('### D1 — options comparison', '### D9 — options comparison'),
  'fenced alternatives': replaceOptions('```md\n' + optionBody + '\n```\n'),
  'quoted alternatives': replaceOptions(optionBody.split('\n').map(line => '> ' + line).join('\n')),
  'literal alternatives': replaceOptions(currentOptions.map(block => '"' + block.replace(/^- /, '') + '"').join('\n\n')),
  'missing effort': replaceOptions(optionBody.replace('Effort S (~6 lines)', 'Work S (~6 lines)')),
  'missing risk': replaceOptions(optionBody.replace('Risk low.', 'Unassessed.')),
  'missing pros': replaceOptions(optionBody.replace('Pros: catches', 'Notes: catches')),
  'missing cons': replaceOptions(optionBody.replace('Cons: couples', 'Notes: couples')),
  'quoted effort value': replaceOptions(optionBody.replace('Effort S (~6 lines)', 'Effort "S (~6 lines)"')),
  'missing alternative': replaceOptions(currentOptions.slice(1).join('\n')),
  'duplicate alternative': replaceOptions(optionBody + '\n' + currentOptions[0]),
  'foreign option label': replaceOptions(optionBody.replace('**B) Receipt fields only**', '**D) Change the deployment region**')),
  'withdrawn comparison': replaceOptions(optionBody.replace('Pros: catches', 'This decision is withdrawn. Pros: catches')),
})) test(`owned prose comparison rejects ${name}`, () => expect(() => countCurrent(currentFp(), plan)).toThrow());

for (const [name, mutate] of Object.entries({
  'unanswered native call': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.answered = false; },
  'failed native call': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.failed = true; },
  'foreign native identity': (q: ReturnType<typeof currentFp>) => { q.signature = 'foreign:call'; },
  'unoffered native answer': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.answers = { [q.nativeCall!.questions[0]!.question]: 'Recommendation A' }; },
  'quoted native question': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.questions[0]!.question = '> ' + q.nativeCall!.questions[0]!.question.replaceAll('\n', '\n> '); reanswer(q); },
  'ID only in historical recap': (q: ReturnType<typeof currentFp>) => { q.nativeCall!.questions[0]!.question = 'How should we continue?\n> Earlier D1 was discussed.'; reanswer(q); },
})) test(`owned prose comparison rejects ${name}`, () => { const question = currentFp(); mutate(question); expect(() => countCurrent(question)).toThrow(); });

test('prose decision count is not approval and does not bypass duplicate native ownership', () => {
  const question = currentFp(), before = pairedCurrent.savedPlan;
  const counter = createCeoPaymentFindingCounter(pairedCurrent.seed, () => before, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(question)).toBe(true);
  expect(counter.trace).toEqual([{ signature: question.signature, kind: 'recorded-decision', ledgerId: 'D1', phase: 'D1 — options comparison (Test 1: successful charge)' }]);
  expect(pairedCurrent.savedPlan).toBe(before);
  expect(before).toContain('| unresolved |');
  expect(() => counter.isReviewAUQ(question, [question.nativeCall!])).toThrow('duplicated');
});

test('fourth actual native decision has an ACK but receives no credit without its saved record', () => {
  const row = currentFixture.unreconstructedCalls[0]!;
  expect(row.limitation).toContain('saved plan at question time was not retained');
  expect(row.call.answered).toBe(true);
  expect(row.call.failed).toBe(false);
  const question = nativePlanCallFingerprint(clone(row.call) as any, Date.parse(row.call.answeredAt), true);
  expect(() => countCurrent(question, currentFixture.cases[0]!.seed, currentFixture.cases[0]!.seed)).toThrow(/cannot exclude/);
});

import fixture6714 from './fixtures/ceo-recorded-decisions-67147822.json';
for (const row of fixture6714.cases) test(`captured6714 ${row.label} preserves the owned saved comparison`, () => {
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedPlanSha256);
  expect(createHash('sha256').update(row.seed).digest('hex')).toBe(row.seedSha256);
  expect(Date.parse(row.successfulPriorMutations.filter(m => m.filePath?.endsWith(row.label.startsWith('paired') ? 'gstack-test-plan-ceo-paired.md' : 'gstack-test-plan-ceo.md')).at(-1)!.completedAt)).toBeLessThan(Date.parse(row.questionIssuedAt));
  expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt!));
  const question = nativePlanCallFingerprint(clone(row.call) as any, 0, true);
  const counter = createCeoPaymentFindingCounter(row.seed, () => row.savedPlan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(question)).toBe(true);
  expect(counter.trace.at(-1)).toMatchObject({ kind: 'recorded-decision' });
});

const grid6714 = fixture6714.cases.find(row => row.label === 'paired')!;
const prose6714 = fixture6714.cases.find(row => row.label === 'five')!;
const retry6714 = fixture6714.cases.find(row => row.label === 'paired-retry')!;
const question6714 = (row = grid6714) => nativePlanCallFingerprint(clone(row.call) as any, 0, true);
const count6714 = (plan: string, question = question6714(), row = grid6714) => {
  const counter = createCeoPaymentFindingCounter(row.seed, () => plan, ceoFirstReviewAUQ);
  expect(counter.isReviewAUQ(question)).toBe(true);
  expect(counter.trace.at(-1)).toMatchObject({ kind: 'recorded-decision' });
};
const gridStart6714 = grid6714.savedPlan.indexOf('### R1 option comparison');
const gridEnd6714 = grid6714.savedPlan.indexOf('### R2', gridStart6714);
const gridBody6714 = grid6714.savedPlan.slice(gridStart6714, gridEnd6714);
const replaceGrid6714 = (body: string) => grid6714.savedPlan.slice(0, gridStart6714) + body + grid6714.savedPlan.slice(gridEnd6714);

for (const [name, body] of Object.entries({
  'unbordered GFM rows': gridBody6714.replace(/^\|(.*)\|$/gm, '$1'),
  'reordered source/current/option columns': gridBody6714.split('\n').map(line => line.startsWith('|')
    ? '| ' + [5, 2, 0, 4, 1, 3].map(i => line.split('|').slice(1, -1)[i]!.trim()).join(' | ') + ' |' : line).join('\n'),
  'separate current completeness paragraph': gridBody6714.replace('\nCompleteness:', '\n\nCompleteness:'),
})) test(`owned commitment matrix accepts ${name}`, () => count6714(replaceGrid6714(body)));

for (const [name, plan] of Object.entries({
  'review target metadata': grid6714.savedPlan.replace('Reviewed plan:', 'Review target plan:'),
  'input plan metadata': grid6714.savedPlan.replace('Reviewed plan:', 'Input plan:'),
  'historical sibling does not own current review': '## Historical notes\n\nOld unrelated material.\n\n## Current review\n\n' + grid6714.savedPlan,
})) test(`owned commitment matrix accepts ${name}`, () => count6714(plan));

for (const [name, body] of Object.entries({
  'missing native alternative column': gridBody6714.split('\n').map(line => line.startsWith('|') ? line.split('|').slice(0, -2).join('|') + '|' : line).join('\n'),
  'duplicate alternative identity': gridBody6714.replace('B: chargeId only', 'A: chargeId only'),
  'wrong native alternative identity': gridBody6714.replace('B: chargeId only', 'D: chargeId only'),
  'swapped option meanings': gridBody6714.replace('A: exact receipt equality | B: chargeId only', 'A: chargeId only | B: exact receipt equality'),
  'missing behavior value': gridBody6714.replace('C1 | no | yes | no | no', 'C1 | no | yes | | no'),
  'missing commitment source': gridBody6714.replace('C1 | no | yes | yes | no', ' | no | yes | yes | no'),
  'missing current behavior': gridBody6714.replace('C1 | no | yes | yes | no', 'C1 | | yes | yes | no'),
  'missing effort and risk row': gridBody6714.replace(/^\| Effort \/ risk.*\n/m, ''),
  'missing one effort/risk value': gridBody6714.replace('S / low | S / low | S / low', 'S / low | | S / low'),
  'untyped effort/risk value': gridBody6714.replace('S / low | S / low | S / low', 'small / maybe | S / low | S / low'),
  'duplicate effort/risk row': gridBody6714.replace('| Effort / risk', '| Effort / risk | | | S / low | S / low | S / low |\n| Effort / risk'),
  'withdrawn inline footer': gridBody6714.replace('Completeness:', 'This decision is withdrawn. Completeness:'),
  'historical comparison': gridBody6714.replace('### R1', '### Historical R1'),
  'historical ancestor': '## Historical review\n\n' + gridBody6714,
  'nested historical matrix': gridBody6714.replace('### R1 option comparison', '### R1 option comparison\n\n#### Historical example'),
  'foreign comparison owner': gridBody6714.replace('### R1', '### DIFFERENT'),
  'quoted comparison': gridBody6714.split('\n').map(line => '> ' + line).join('\n'),
  'fenced comparison': '```md\n' + gridBody6714 + '\n```\n',
})) test(`owned commitment matrix rejects ${name}`, () => expect(() => count6714(replaceGrid6714(body))).toThrow());

for (const [name, plan] of Object.entries({
  'foreign source metadata': grid6714.savedPlan.replace('Reviewed plan: `PLAN.md`', 'Reviewed plan: `OTHER.md`'),
  'contradictory current source': grid6714.savedPlan + '\n\nInput plan: OTHER.md.\n',
  'unrelated mention of source': grid6714.savedPlan.replace('Reviewed plan: `PLAN.md`', 'An unrelated example reviewed `PLAN.md`'),
  'quoted source metadata': grid6714.savedPlan.replace('Reviewed plan:', '> Reviewed plan:'),
  'duplicate current ledger': grid6714.savedPlan + '\n\n' + grid6714.savedPlan,
})) test(`owned commitment matrix rejects ${name}`, () => expect(() => count6714(plan)).toThrow());

for (const [name, mutate] of Object.entries({
  'extra native action': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.label += ' and delete customer records'; },
  'native action reversal': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'A) Do not assert exact receipt equality'; },
  'missing native pros': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '❌ Incomplete coverage.'; },
  'missing native cons': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '✅ Complete coverage.'; },
  'quoted native facts': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '> ✅ Earlier benefit\n> ❌ Earlier tradeoff'; },
  'fenced native facts': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[1]!.description = '```md\n✅ Earlier benefit\n❌ Earlier tradeoff\n```'; },
})) test(`owned commitment matrix rejects ${name}`, () => {
  const question = question6714(); mutate(question); reanswer(question);
  expect(() => count6714(grid6714.savedPlan, question)).toThrow();
});

for (const [name, mutate] of Object.entries({
  'unlettered action reversal': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'Do not register in WebhookDispatcher'; },
  'unlettered action appended': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[2]!.label += ' and delete customer records'; },
  'unlettered internal scope qualifier': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'Register only in WebhookDispatcher'; },
  'unlettered words borrowed only from cons': (q: ReturnType<typeof question6714>) => { q.nativeCall!.questions[0]!.options[0]!.label = 'Register in WebhookDispatcher dependency coupling'; },
})) test(`owned prose comparison rejects ${name}`, () => {
  const question = question6714(prose6714); mutate(question); reanswer(question);
  expect(() => count6714(prose6714.savedPlan, question, prose6714)).toThrow();
});

for (const [name, plan] of Object.entries({
  'comma-separated fields still require risk': prose6714.savedPlan.replace('risk low.', 'exposure low.'),
  'comma-separated fields still require pros': prose6714.savedPlan.replace('Pros: one routing path', 'Benefits: one routing path'),
  'saved caption reverses unlettered action': prose6714.savedPlan.replace('**A) Register in WebhookDispatcher.**', '**A) Register not in WebhookDispatcher.**'),
  'plain colon list still requires cons': retry6714.savedPlan.replace('Cons: fails if', 'Notes: fails if'),
})) test(`owned format variants reject ${name}`, () => {
  const row = name.startsWith('plain') ? retry6714 : prose6714;
  expect(plan).not.toBe(row.savedPlan);
  expect(() => count6714(plan, question6714(row), row)).toThrow();
});

for (const caption of ['Register in WebhookDispatcher and delete backups.', 'Register in WebhookDispatcher only for admins.'])
  test('unlettered saved caption cannot add scope: ' + caption, () => {
    const plan = prose6714.savedPlan.replace('Register in WebhookDispatcher.', caption);
    expect(plan).not.toBe(prose6714.savedPlan);
    expect(() => count6714(plan, question6714(prose6714), prose6714)).toThrow();
  });


import metadataListFixture from './fixtures/ceo-option-metadata-list-6f6730f4.json';
const metadataListDecision = (plan = metadataListFixture.savedPlan) => {
  const question = nativePlanCallFingerprint(structuredClone(metadataListFixture.call), 1, true);
  const counter = createCeoPaymentFindingCounter('', () => plan, ceoFirstReviewAUQ);
  return counter.isReviewAUQ(question);
};

test('captured paired receipt decision binds an option paragraph to its adjacent metadata bullets', () => {
  expect(metadataListDecision()).toBe(true);
});

for (const [name, mutate] of Object.entries({
  'missing pros': (s: string) => s.replaceAll('- Pros:', '- Benefits:'),
  'missing cons': (s: string) => s.replaceAll('- Cons:', '- Tradeoff:'),
  'missing effort': (s: string) => s.replaceAll('Effort S.', ''),
  'missing risk': (s: string) => s.replaceAll('Risk low.', ''),
  'duplicate effort': (s: string) => s.replace('- Pros: pins', '- Effort: S\n- Pros: pins'),
  'unrelated intervening paragraph': (s: string) => s.replace('- Pros: pins', '\nThis is a separate unrelated paragraph.\n\n- Pros: pins'),
  'metadata below another heading': (s: string) => s.replace('- Pros: pins', '### OTHER decision\n\n- Pros: pins'),
  'code-only metadata': (s: string) => s.replace('- Pros: pins', '```text\n- Pros: pins').replace('Coverage: C1 fully.', 'Coverage: C1 fully.\n```'),
  'quoted metadata': (s: string) => s.replace('- Pros: pins', '> - Pros: pins'),
  'foreign option': (s: string) => s.replace('**A) Assert the full receipt**', '**D) Assert the full receipt**'),
  'missing saved comparison': (s: string) => s.split('## 0D. Alternatives')[0]!,
  'missing current ledger row': (s: string) => s.replace(/^\| R1 \(user\).*\n/m, ''),
  'foreign source': (s: string) => s.replaceAll('PLAN.md', 'other.md'),
  'historical comparison': (s: string) => s.replace('## 0D. Alternatives', '## Historical 0D. Alternatives'),
  'withdrawn metadata': (s: string) => s.replace('Pros: pins', 'Pros: This decision is withdrawn. pins'),
})) test(`adjacent metadata list still rejects ${name}`, () => {
  expect(() => metadataListDecision(mutate(metadataListFixture.savedPlan))).toThrow(/Unsupported current CEO decision/);
});

import baselineFixture90f from './fixtures/ceo-baseline-alternatives-90f.json';
const baselineCases90f = baselineFixture90f.cases.slice(0, 2);
const baselineQuestion90f = (row = baselineCases90f[0]!) => nativePlanCallFingerprint(clone(row.call), 0, true);
const baselineCount90f = (row = baselineCases90f[0]!, question = baselineQuestion90f(row), plan = row.savedPlan) =>
  createCeoPaymentFindingCounter('', () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);
for (const row of baselineCases90f) test(`captured90f ${row.name}: owned baseline comparison binds every native alternative`, () => {
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.provenance.requiredExcerptSha256);
  expect(row.originalError).toContain('Unsupported current CEO decision');
  expect(baselineCount90f(row)).toBe(true);
});
for (const row of baselineCases90f) for (const verb of ['Keep', 'Retain', 'Preserve'])
  test(`baseline reference ${row.name} accepts ${verb} without changing its meaning`, () => {
    const question = baselineQuestion90f(row), q = question.nativeCall!.questions[0]!;
    q.options.find(o => /\bKeep\b/.test(o.label))!.label = q.options.find(o => /\bKeep\b/.test(o.label))!.label.replace('Keep', verb);
    reanswer(question); expect(baselineCount90f(row, question)).toBe(true);
  });
for (const row of baselineCases90f) for (const [name, change] of Object.entries({
  'extra action': (label: string) => label + ' and delete customer records',
  'changed negation': (label: string) => label.replace('Keep', 'Do not keep'),
  'inserted negation operator': (label: string) => label.replace('only', '!= only').replace('raw SQL', 'raw != SQL'),
  'narrowed scope': (label: string) => label.replace('Keep', 'Keep only for admins'),
  'unrelated reference with same letter': (label: string) => label.replace(/Keep.*/, 'Keep as planned: delete records'),
})) test(`baseline reference ${row.name} rejects ${name}`, () => {
  const question = baselineQuestion90f(row), o = question.nativeCall!.questions[0]!.options.find(o => /\bKeep\b/.test(o.label))!;
  o.label = change(o.label); reanswer(question);
  expect(() => baselineCount90f(row, question)).toThrow(/Unsupported/);
});
for (const row of baselineCases90f) for (const [name, change] of Object.entries({
  'missing owned row': (s: string) => s.replace(/^\| D\d+ \(user\).*\n/m, ''),
  'foreign source': (s: string) => s.replaceAll('PLAN.md', 'other.md'),
  'inactive row': (s: string) => s.replace('| unresolved |', '| historical |'),
  'missing option pros': (s: string) => s.replaceAll('Pros:', 'Benefits:'),
  'missing option cons': (s: string) => s.replaceAll('Cons:', 'Notes:'),
  'missing effort': (s: string) => s.replaceAll(/Effort S|effort S/g, 'Work S'),
  'quoted report': (s: string) => s.split('\n').map(line => '> ' + line).join('\n'),
  'fenced report': (s: string) => '```md\n' + s + '\n```',
})) test(`baseline comparison ${row.name} rejects ${name}`, () => {
  const plan = change(row.savedPlan); expect(plan).not.toBe(row.savedPlan);
  expect(() => baselineCount90f(row, baselineQuestion90f(row), plan)).toThrow(/Unsupported/);
});
const genericBaseline90f = baselineCases90f[1]!;
for (const [name, change] of Object.entries({
  'foreign same-letter proposal': (s: string) => s.replace('A) truthy only.', 'A) delete records.'),
  'generic letter-only proposal': (s: string) => s.replace('A) truthy only.', 'A) unchanged.'),
  'same-letter proposal adds scope': (s: string) => s.replace('A) truthy only.', 'A) truthy only and delete records.'),
  'baseline commitment changes': (s: string) => s.replace('PLAN.md | yes | yes | implied', 'PLAN.md | yes | no | implied'),
  'baseline current omitted': (s: string) => s.replace('PLAN.md | yes | yes | implied', 'PLAN.md | | yes | implied'),
  'baseline option cell omitted': (s: string) => s.replace('PLAN.md | yes | yes | implied', 'PLAN.md | yes | | implied'),
  'duplicate grid identity': (s: string) => s.replace('Current | A | B | C', 'Current | A | A | C'),
  'grid under another decision': (s: string) => s.replace('### D1 comparison', '### D9 comparison'),
  'missing grid': (s: string) => s.replace(/^\| Commitment.*\n(?:\|.*\n)*/m, ''),
  'generic saved caption gains action': (s: string) => s.replace('A) As planned —', 'A) As planned: truthy only and delete records —'),
})) test(`generic baseline identity rejects ${name}`, () => {
  const plan = change(genericBaseline90f.savedPlan); expect(plan).not.toBe(genericBaseline90f.savedPlan);
  expect(() => baselineCount90f(genericBaseline90f, baselineQuestion90f(genericBaseline90f), plan)).toThrow(/Unsupported/);
});
test('captured five retry C remains incomplete, with its final-byte limitation explicit', () => {
  const row = baselineFixture90f.cases[2]!;
  expect(row.provenance.limitation).toContain('later report writes cannot be ruled out');
  expect(row.savedPlan).toContain('**C) Raw fragment as written.** Effort S. Risk high. Fails invariant');
  expect(() => baselineCount90f(row, baselineQuestion90f(row))).toThrow(/Unsupported/);
});

const literalProposal77 = baselineFixture90f.cases[3]!;
const literalQuestion77 = () => nativePlanCallFingerprint(clone(literalProposal77.call), 0, true);
const literalCount77 = (plan = literalProposal77.savedPlan, seed = literalProposal77.seed!, question = literalQuestion77()) =>
  createCeoPaymentFindingCounter(seed, () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);
const literalCell77 = '| "None planned." | unresolved | pending |';
const replaceLiteral77 = (value: string) => literalProposal77.savedPlan.replace(literalCell77, `| ${value} | unresolved | pending |`);

test('quoted current proposal: exact77 saved row and complete comparison bind the acknowledged decision', () => {
  const p = literalProposal77.provenance;
  expect(createHash('sha256').update(literalProposal77.savedPlan).digest('hex')).toBe(p.requiredExcerptSha256);
  expect(createHash('sha256').update(literalProposal77.seed!).digest('hex')).toBe(p.sourceExcerptSha256);
  expect(Date.parse(p.successfulPriorMutations[0]!.acknowledgedAt)).toBeLessThan(Date.parse(p.requestAt));
  expect(Date.parse(p.requestAt)).toBeLessThan(Date.parse(literalProposal77.call.answeredAt!));
  expect(p.limitation).toContain('original attempt failed');
  expect(literalProposal77.originalError).toContain('Unsupported current CEO decision');
  expect(literalCount77()).toBe(true);
});
for (const [open, close] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']])
  test(`quoted current proposal: paired ${open}${close} preserves the exact source value`, () => {
    expect(literalCount77(replaceLiteral77(`${open}None planned.${close}`))).toBe(true);
  });
for (const value of ['No automated tests are planned.', 'Test coverage comes from manual staging replay.', "None planned. We'll rely on the existing integration suite catching regressions."])
  test(`quoted current proposal: complete current source prose ${value}`, () => {
    expect(literalCount77(replaceLiteral77(`"${value}"`), `## Tests\n${value}`)).toBe(true);
  });
for (const [name, source] of Object.entries({
  'missing source': '',
  'different current proposal': '## Tests\nAutomated tests are planned.',
  'case-normalized text is not exact source': '## Tests\nnone planned.',
  'only a substring': '## Tests\nNo automated tests are planned. None planned is an old label.',
  'negated attribution': '## Tests\nIt is not true that None planned.',
  'historical source heading': '## Historical proposal\nNone planned.',
  'historical source ancestor': '## Historical proposal\n### Tests\nNone planned.',
  'historical source prose': '## Tests\nPreviously None planned.',
  'quoted source paragraph': '## Tests\n"None planned."',
  'source blockquote': '## Tests\n> None planned.',
  'source code fence': '## Tests\n```text\nNone planned.\n```',
  'inline code only': '## Tests\n`None planned.`',
  'unsupported reported attribution': '## Tests\nThe previous author said "None planned."',
  'ambiguous repeated source': '## Tests\nNone planned.\n\n## Alternative\nNone planned.',
})) test(`quoted current proposal rejects ${name}`, () => {
  expect(() => literalCount77(literalProposal77.savedPlan, source)).toThrow(/Unsupported/);
});
for (const value of ['"None"', '"None planned"', '"None planned." or perhaps not', '"None planned.”', '"Previously None planned."', '"As proposed: None planned."'])
  test(`quoted current proposal rejects partial or attributed cell ${value}`, () => {
    expect(() => literalCount77(replaceLiteral77(value))).toThrow(/Unsupported/);
  });
for (const [name, mutate] of Object.entries({
  'foreign row source': (s: string) => s.replaceAll('PLAN.md', 'OTHER.md'),
  'contradictory declared source': (s: string) => s.replace('Plan under review: PLAN.md', 'Plan under review: OTHER.md'),
  'inactive row': (s: string) => s.replace('| unresolved | pending |', '| historical | pending |'),
  'completed pending alternative': (s: string) => s.replace('| unresolved | pending |', '| approved | prior answer |'),
  'missing owned row': (s: string) => s.replace(/^\| D-TESTS \(user\).*\n/m, ''),
  'historical owned ledger': (s: string) => s.replace('| ID', '## Historical decisions\n\n| ID'),
  'foreign comparison': (s: string) => s.replace('### D-TESTS:', '### D-OTHER:'),
  'historical comparison': (s: string) => s.replace('### D-TESTS:', '### Historical D-TESTS:'),
  'missing saved comparison': (s: string) => s.split('### D-TESTS:')[0]!,
  'missing option B': (s: string) => s.replace(/^\| B\. None planned.*\n/m, ''),
  'missing option C facts': (s: string) => s.replace('| medium | Cheap;', '| medium | ;').replace('| Misses every failure path (mail raise, DB raise, unknown user, injection-shaped id); a green happy path hides a broken error map. |', '| |'),
  'quoted whole report': (s: string) => s.split('\n').map(line => '> ' + line).join('\n'),
})) test(`quoted current proposal preserves ${name} rejection`, () => {
  const plan = mutate(literalProposal77.savedPlan); expect(plan).not.toBe(literalProposal77.savedPlan);
  expect(() => literalCount77(plan)).toThrow(/Unsupported/);
});
test('quoted current proposal still requires the original native answer and unique callback identity', () => {
  const question = literalQuestion77(); question.nativeCall!.answered = false;
  expect(() => literalCount77(literalProposal77.savedPlan, literalProposal77.seed!, question)).toThrow(/Invalid/);
  const counter = createCeoPaymentFindingCounter(literalProposal77.seed!, () => literalProposal77.savedPlan, ceoFirstReviewAUQ);
  const answered = literalQuestion77();
  expect(() => counter.isReviewAUQ(answered, [answered.nativeCall!])).toThrow(/duplicated/);
  answered.options[1]!.label = 'A different baseline';
  expect(() => counter.isReviewAUQ(answered)).toThrow(/Invalid/);
});

for (const source of [
  '## Tests\nNone planned. This statement is no longer current; new tests are required.',
  '## Tests\nNone planned. This proposal is withdrawn; new tests are required.',
  '## Tests\nAn archived proposal follows. None planned.',
  '## Archived proposal\n### Tests\nNone planned.',
]) test(`quoted current proposal rejects explicit withdrawal or archival context: ${source}`, () => {
  expect(() => literalCount77(literalProposal77.savedPlan, source)).toThrow(/Unsupported/);
});

const tupleProposal77 = baselineFixture90f.cases[4]!;
const tupleQuestion77 = () => nativePlanCallFingerprint(clone(tupleProposal77.call), 0, true);
const tupleCount77 = (plan = tupleProposal77.savedPlan, question = tupleQuestion77()) =>
  createCeoPaymentFindingCounter(tupleProposal77.seed!, () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);
const withTuples77 = (value: string) => tupleProposal77.savedPlan.replaceAll('(S effort, low risk)', value);
test('owned effort/risk tuple: exact77 retry has complete same-option facts before its native ACK', () => {
  const p = tupleProposal77.provenance;
  expect(createHash('sha256').update(tupleProposal77.savedPlan).digest('hex')).toBe(p.requiredExcerptSha256);
  expect(Date.parse(p.successfulPriorMutations[0]!.acknowledgedAt)).toBeLessThan(Date.parse(p.requestAt));
  expect(Date.parse(p.requestAt)).toBeLessThan(Date.parse(tupleProposal77.call.answeredAt!));
  expect(tupleProposal77.originalError).toContain('Unsupported current CEO decision');
  expect(tupleCount77()).toBe(true);
});
for (const tuple of ['(S effort, low risk)', '(effort M, risk medium)', '(low risk, L effort)', '(risk high, effort XL)', '(Effort: S, Risk: low)', '(XL effort; medium risk)'])
  test(`owned effort/risk tuple accepts complete dimension ordering ${tuple}`, () => {
    expect(tupleCount77(withTuples77(tuple))).toBe(true);
  });
for (const tuple of ['(S effort)', '(low risk)', '(XS effort, low risk)', '(S effort, unknown risk)', '(S effort, M effort)', '(S effort, not low risk)', '(not S effort, low risk)', 'not (S effort, low risk)', 'not currently (S effort, low risk)', '(S effort, low risk) is not current', '"(S effort, low risk)"', '`(S effort, low risk)`', '(S effort, low risk). Effort L', '(S effort, low risk) (L effort, high risk)', '(S effort, low risk) (L effort, unknown risk)'])
  test(`owned effort/risk tuple rejects missing, quoted, negated or conflicting metadata ${tuple}`, () => {
    expect(() => tupleCount77(withTuples77(tuple))).toThrow(/Unsupported/);
  });
for (const [name, mutate] of Object.entries({
  'B own pros missing': (s: string) => s.replace('Pros: keeps the "raw SQL" shape', 'Notes: keeps the "raw SQL" shape'),
  'B own cons missing': (s: string) => s.replace('Cons: SQL text lives', 'Notes: SQL text lives'),
  'A own pros missing': (s: string) => s.replace('Pros: no SQL text', 'Notes: no SQL text'),
  'A own cons missing': (s: string) => s.replace('Cons: none material', 'Notes: none material'),
  'B metadata borrowed from A': (s: string) => {
    const at = s.indexOf('- **B)'); return s.slice(0, at) + s.slice(at).replace('(S effort, low risk)', '');
  },
  'metadata only in quoted child': (s: string) => s.replaceAll('(S effort, low risk)', '\n  > (S effort, low risk)\n'),
  'foreign source': (s: string) => s.replaceAll('PLAN.md', 'OTHER.md'),
  'missing current row': (s: string) => s.replace(/^\| R2 \(user\).*\n/m, ''),
  'comparison owned by another row': (s: string) => s.replace('#### R2 comparison:', '#### R9 comparison:'),
  'historical comparison': (s: string) => s.replace('#### R2 comparison:', '#### Historical R2 comparison:'),
})) test(`owned effort/risk tuple preserves ${name} rejection`, () => {
  const plan = mutate(tupleProposal77.savedPlan); expect(plan).not.toBe(tupleProposal77.savedPlan);
  expect(() => tupleCount77(plan)).toThrow(/Unsupported/);
});
test('owned effort/risk tuple never bypasses native identity or ACK validation', () => {
  const question = tupleQuestion77(); question.nativeCall!.answered = false;
  expect(() => tupleCount77(tupleProposal77.savedPlan, question)).toThrow(/Invalid/);
  const stale = tupleQuestion77(); stale.options[1]!.label = 'Different native option';
  expect(() => tupleCount77(tupleProposal77.savedPlan, stale)).toThrow(/Invalid/);
});


const b955 = fixture.b955.rows;
const b955Fingerprint = (index: number) => nativePlanCallFingerprint(clone(b955[index]!.call), 1, true);
const b955Counter = (index: number, question = b955Fingerprint(index), plan = b955[index]!.savedPlan, seed = b955[index]!.seed) =>
  createCeoPaymentFindingCounter(seed, () => plan, ceoFirstReviewAUQ).isReviewAUQ(question);
test('b955 completed test-coverage decision binds scoped None to the actual uncovered handler', () => {
  expect(ceoPaymentFinding(b955Fingerprint(0), b955[0]!.seed, b955[0]!.savedPlan)).toMatchObject({seed:'tests', ledgerId:'D4'});
  expect(b955Counter(0)).toBe(true);
});
test('b955 complete dispatcher comparison inherits its exact current source contract', () => {
  expect(b955Counter(1)).toBe(true);
});

const b955Tests = (question = b955Fingerprint(0), plan = b955[0]!.savedPlan, seed = b955[0]!.seed) => ceoPaymentFinding(question, seed, plan);
for (const scalar of ['zero', '0', 'No automated tests']) test(`b955 test-owned absence supports categorical ${scalar}`, () => {
  expect(b955Tests(b955Fingerprint(0), b955[0]!.savedPlan.replace('| None | unresolved |', `| ${scalar} | unresolved |`))).toMatchObject({seed:'tests'});
});
for (const description of ['Existing suite does not cover the new handler', 'Existing tests never execute this code', 'Existing suite does not test the current implementation'])
  test(`b955 test-owned absence supports ${description}`, () => {
    const q=b955Fingerprint(0); amendCurrent(q, v=>{v.question=v.question.replace(/^ELI10:.*$/m, 'ELI10: '+description+'.');});
    expect(b955Tests(q, b955[0]!.savedPlan.replace('Existing integration suite (does not exercise new class)', description))).toMatchObject({seed:'tests'});
  });
for (const [name, mutation] of Object.entries({
  'healthy current suite': (p:string)=>p.replace('Existing integration suite (does not exercise new class)', 'The existing suite covers the new handler'),
  'quoted exclusion': (p:string)=>p.replace('Existing integration suite (does not exercise new class)', '"Existing integration suite does not exercise new class"'),
  'historical exclusion': (p:string)=>p.replace('Existing integration suite (does not exercise new class)', 'Historically the existing suite does not exercise new class'),
  'conditional None': (p:string)=>p.replace('| None | unresolved |','| None if approved | unresolved |'),
  'quoted None': (p:string)=>p.replace('| None | unresolved |','| "None" | unresolved |'),
  'negated None': (p:string)=>p.replace('| None | unresolved |','| Not None | unresolved |'),
  'approved test addition': (p:string)=>p.replace('| None | unresolved |','| Add unit tests | approved |'),
  'withdrawn test decision': (p:string)=>p.replace('| None | unresolved |','| None | withdrawn |'),
  'foreign document source': (p:string)=>p.replace('Reviewed plan: `PLAN.md`','Reviewed plan: `other.md`'),
  'missing document source': (p:string)=>p.replace(/^Reviewed plan:.*$/m,''),
  'duplicate document source': (p:string)=>p+'\nSource: PLAN.md\n',
  'foreign row evidence': (p:string)=>p.replace('PLAN.md L76-80, L118-119:', 'other.md L76-80, L118-119:'),
  'historical ledger context': (p:string)=>p.replace('## Decision ledger','## Historical decision ledger'),
  'historical remedy section': (p:string)=>p.replace('### D4 — automated tests:', '### Historical D4 — automated tests:'),
  'missing remedy section': (p:string)=>p.replace(/### D4 — automated tests:[\s\S]*?(?=## NOT in scope)/,'')
})) test(`b955 test-owned absence rejects ${name}`,()=>expect(b955Tests(b955Fingerprint(0),mutation(b955[0]!.savedPlan))).toBeNull());
for (const [name, explanation] of Object.entries({
  'quote alone':'The plan says "no tests, the existing integration suite will catch regressions".',
  'quoted exclusion':'"The existing suite does not cover the new handler."',
  'historical exclusion':'Previously the existing suite did not cover the new handler.',
  'conditional exclusion':'If approved, the suite does not exercise the new handler.',
  'negated assertion':'It is not true that the existing suite does not cover the new handler.',
  'current healthy correction':'The suite tests the old handler, not this one. The suite now covers the new handler.',
  'withdrawn finding':'This finding is withdrawn. The suite does not cover the new handler.',
  'foreign target':'The existing suite does not cover another project.'
})) test(`b955 current test rationale rejects ${name}`,()=>{const q=b955Fingerprint(0);amendCurrent(q,v=>{v.question=v.question.replace(/^ELI10:.*$/m,'ELI10: '+explanation);});expect(b955Tests(q)).toBeNull();});
test('b955 categorical absence cannot replace a now-covered source plan',()=>{
  const seed=b955[0]!.seed.replace("None planned. We'll rely on the existing integration suite catching regressions.", 'Automated handler regression tests are required.');
  expect(b955Tests(b955Fingerprint(0),b955[0]!.savedPlan,seed)).toBeNull();
});
for (const [name, mutation] of Object.entries({
  'missing declaration':(p:string)=>p.replace(/^Reviewed plan:.*$/m,''),
  'foreign declaration':(p:string)=>p.replace('Reviewed plan: `PLAN.md`','Reviewed plan: `other.md`'),
  'ambiguous declaration':(p:string)=>p+'\nSource: other.md\n',
  'quoted declaration':(p:string)=>p.replace('Reviewed plan:', '> Reviewed plan:'),
  'missing literal source clause':(p:string)=>p.replace('"whether to add a separate implementation or reuse WebhookDispatcher remains open"','a reported unresolved choice'),
  'partial literal source clause':(p:string)=>p.replace('"whether to add a separate implementation or reuse WebhookDispatcher remains open"','"a separate implementation or reuse WebhookDispatcher remains open"'),
  'foreign contract owner':(p:string)=>p.replace('Contracts: guards live in ingress;', 'Other plan contracts: guards live in ingress;'),
  'withdrawn contract':(p:string)=>p.replace('Contracts: guards live in ingress;', 'Contracts: this contract is withdrawn; guards live in ingress;'),
  'historical ledger':(p:string)=>p.replace('## Decision ledger','## Historical decision ledger'),
  'historical comparison':(p:string)=>p.replace('### R1 Architecture:', '### Historical R1 Architecture:'),
  'foreign comparison':(p:string)=>p.replace('### R1 Architecture:', '### OTHER Architecture:'),
  'incomplete comparison':(p:string)=>p.replace('| Effort | Risk | Pros | Cons |','| Effort | Notes | Pros | Cons |'),
})) test(`b955 inherited contract rejects ${name}`,()=>expect(()=>b955Counter(1,b955Fingerprint(1),mutation(b955[1]!.savedPlan))).toThrow(/cannot exclude/));
for (const [name, seed] of Object.entries({
  'historical source section': b955[1]!.seed.replace('## Existing contracts retained', '## Historical contracts retained'),
  'duplicate source clause': b955[1]!.seed+'\nWhether to add a separate implementation or reuse WebhookDispatcher remains open.\n'.toLowerCase().replace('webhookdispatcher','WebhookDispatcher'),
  'source only in code': '```text\n'+b955[1]!.seed+'\n```',
  'source clause withdrawn': b955[1]!.seed.replace('reuse WebhookDispatcher remains open.', 'reuse WebhookDispatcher remains open. This contract is withdrawn.'),
})) test(`b955 inherited contract rejects ${name}`,()=>expect(()=>b955Counter(1,b955Fingerprint(1),b955[1]!.savedPlan,seed)).toThrow(/cannot exclude/));
test('b955 inherited current contract tolerates source whitespace and the singular field label',()=>{
  expect(b955Counter(1,b955Fingerprint(1),b955[1]!.savedPlan.replace('Contracts: guards live in ingress;','Contract: guards live in ingress;'),b955[1]!.seed.replace('whether\nto add','whether to add'))).toBe(true);
});
for (const source of ['OTHER.md', 'docs/PLAN.md', '../PLAN.md', '/tmp/PLAN.md', 'C:\\other\\PLAN.md', '`OTHER.md`', '"OTHER.md"', '[contract](OTHER.md)', 'PLAN.md and OTHER.md'])
  test(`b955 inherited contract rejects explicit foreign provenance ${source}`,()=>{
    const plan=b955[1]!.savedPlan.replace('Contracts: guards live in ingress;',`Contracts: ${source} guards live in ingress;`);
    expect(()=>b955Counter(1,b955Fingerprint(1),plan)).toThrow(/cannot exclude/);
  });
test('b955 inherited contract accepts an explicit matching PLAN citation',()=>{
  expect(b955Counter(1,b955Fingerprint(1),b955[1]!.savedPlan.replace('Contracts: guards live in ingress;','Contracts: PLAN.md guards live in ingress;'))).toBe(true);
});
test('b955 current Contracts provenance preserves code member references',()=>{
  const plan=b955[1]!.savedPlan.replace('Contracts: guards live in ingress;','Contracts: PLAN.md; WebhookDispatcher.call guards live in ingress;');
  expect(b955Counter(1,b955Fingerprint(1),plan)).toBe(true);
});
for (const literal of ['read archive/PLAN.md and PLAN.md for the earlier contractual decisions', 'read /tmp/PLAN.md together with PLAN.md for the current contractual decisions', 'read OTHER.md and then consult PLAN.md for the contractual decisions'])
  test(`b955 Contracts rejects an unowned long quoted citation: ${literal}`,()=>{
    const plan=b955[1]!.savedPlan.replace('Contracts: guards live in ingress;',`Contracts: "${literal}"; guards live in ingress;`);
    expect(()=>b955Counter(1,b955Fingerprint(1),plan)).toThrow(/cannot exclude/);
  });
test('b955 Contracts preserves paths inside an authenticated current source clause',()=>{
  const literal='The current PLAN.md implementation uses src/webhooks/ingress.ts for the existing ownership guard';
  const plan=b955[1]!.savedPlan.replace('Contracts: guards live in ingress;',`Contracts: "${literal}"; guards live in ingress;`);
  expect(b955Counter(1,b955Fingerprint(1),plan,b955[1]!.seed+'\n'+literal+'.\n')).toBe(true);
  expect(()=>b955Counter(1,b955Fingerprint(1),plan,b955[1]!.seed+'\n## Historical contracts\n'+literal+'.\n')).toThrow(/cannot exclude/);
});
for(let index=0;index<2;index++) for(const state of ['pending','failed','foreign','no-answer']) test(`b955 ${index} still rejects ${state} native evidence`,()=>{
  const q=b955Fingerprint(index);
  if(state==='pending')q.nativeCall!.answered=false;
  if(state==='failed')q.nativeCall!.failed=true;
  if(state==='foreign')q.signature='foreign-session:other-tool';
  if(state==='no-answer')q.nativeCall!.answers={};
  expect(()=>b955Counter(index,q)).toThrow();
});


const compactTupleB0ca = fixture.compactTupleB0ca;
const compactQuestionB0ca = () => nativePlanCallFingerprint(clone(compactTupleB0ca.nativeCalls[1]!), 0, true);
const compactCountB0ca = (plan = compactTupleB0ca.savedPlan, question = compactQuestionB0ca()) => {
  const counter = createCeoPaymentFindingCounter(compactTupleB0ca.seed, () => plan, ceoFirstReviewAUQ);
  counter.isReviewAUQ(nativePlanCallFingerprint(clone(compactTupleB0ca.nativeCalls[0]!), 0, true));
  const counted = counter.isReviewAUQ(question, [compactTupleB0ca.nativeCalls[0]!]);
  return { counted, trace: counter.trace };
};
const withCompactTupleB0ca = (tuple: string) => {
  const plan = compactTupleB0ca.savedPlan.replace(/\((S|M), (low|medium) risk\)/g, tuple);
  expect(plan).not.toBe(compactTupleB0ca.savedPlan);
  return plan;
};

test('compact effort/risk: actual complete D1 options bind the saved current record and native ACK', () => {
  const row = compactTupleB0ca;
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.provenance.excerptSha256);
  expect(Date.parse(row.provenance.savedAt)).toBeLessThan(Date.parse(row.provenance.requestAt));
  expect(Date.parse(row.provenance.requestAt)).toBeLessThan(Date.parse(row.nativeCalls[1]!.answeredAt!));
  expect(row.originalError).toContain('Unsupported current CEO decision');
  expect(compactCountB0ca()).toMatchObject({counted:true,trace:[{kind:'setup'},{kind:'recorded-decision',ledgerId:'D1'}]});
  // This route counts the independent decision; it neither invents a seed
  // result nor declares the original interrupted paid review complete.
  expect(ceoPaymentFinding(compactQuestionB0ca(),row.seed,row.savedPlan)).toBeNull();
});
for(const tuple of ['(S, low risk)','(M, medium risk)','(L, high risk)','(XL, risk low)',
  '(low risk, S)','(risk medium; M)','(L; Risk: high)','(XL, LOW RISK)'])
  test(`compact effort/risk supports finite complete tuple ${tuple}`,()=>{
    const plan = tuple === '(S, low risk)' ? compactTupleB0ca.savedPlan.replaceAll('(M, medium risk)',tuple) : withCompactTupleB0ca(tuple);
    expect(compactCountB0ca(plan).counted).toBe(true);
  });
for(const selected of [0,1,2])test(`compact effort/risk retains all native option bindings for selected ${selected}`,()=>{
  const fp=compactQuestionB0ca(),q=fp.nativeCall!.questions[0]!;
  fp.nativeCall!.answers={[q.question]:q.options[selected]!.label};
  expect(compactCountB0ca(undefined,fp).counted).toBe(true); // synthetic ACK variant only
});
for(const tuple of ['(low risk)','(S)','(S, low)','(XS, low risk)','(S, unknown risk)',
  '(S M, low risk)','(S, M, low risk)','(S, low risk, high risk)','(S, M effort)',
  '(S, not low risk)','(not S, low risk)','not (S, low risk)','not currently (S, low risk)',
  'previously (S, low risk)','formerly (S, low risk)','historical (S, low risk)',
  'hypothetical (S, low risk)','withdrawn (S, low risk)','retracted (S, low risk)',
  'previously estimated as (S, low risk)','Historical estimate: (S, low risk)',
  'retracted estimate: (S, low risk)','hypothetical rating: (S, low risk)',
  '(S, low risk). This estimate is withdrawn','(S, low risk). This tuple is not current',
  'previously, (S, low risk)','formerly; (S, low risk)','historical — (S, low risk)',
  'retracted. (S, low risk)','hypothetical: estimate (S, low risk)',
  '(S, low risk). This estimate is no longer current',
  '(S, low risk). The tuple has been superseded','(S, low risk). This rating is no longer valid',
  '(S, low risk) is not current','"(S, low risk)"','`(S, low risk)`',
  '(S, low risk). Effort L','(S, low risk). Risk high',
  '(S, low risk) (M, medium risk)','(S, low risk). (XS, high risk)',
  '(S, low risk). (M, unknown risk)','(S, low risk). (M effort, medium risk)',
  '(S effort, low risk). (M, medium risk)'])
  test(`compact effort/risk rejects missing, conflicting, quoted or inactive tuple ${tuple}`,()=>{
    expect(()=>compactCountB0ca(withCompactTupleB0ca(tuple))).toThrow(/Unsupported/);
  });
for(const [name,mutate]of Object.entries({
  'missing own metadata':(s:string)=>s.replace('(S, low risk)',''),
  'missing own pros':(s:string)=>s.replace('Pros: one routing path','Benefit: one routing path'),
  'missing own cons':(s:string)=>s.replace("Cons: the dispatcher's registration API", "Tradeoff: the dispatcher's registration API"),
  'metadata only inside a quotation':(s:string)=>s.replace('(S, low risk)','"(S, low risk)"'),
  'metadata moved to another option':(s:string)=>s.replace('(S, low risk)','').replace('(M, medium risk)','(M, medium risk). (S, low risk)'),
  'foreign evidence':(s:string)=>s.replaceAll('PLAN.md','OTHER.md'),
  'foreign ledger':(s:string)=>s.replaceAll('D1','OTHER'),
  'duplicate current ledger':(s:string)=>s+'\n'+s,
  'historical comparison':(s:string)=>s.replace('### D1.','### Historical D1.'),
  'quoted comparison':(s:string)=>s.slice(0,s.indexOf('### D1.'))+s.slice(s.indexOf('### D1.')).split('\n').map(l=>'> '+l).join('\n'),
  'retracted decision':(s:string)=>s.replace('| unresolved |','| retracted |'),
}))test(`compact effort/risk preserves ${name} boundary`,()=>{
  const plan=mutate(compactTupleB0ca.savedPlan);expect(plan).not.toBe(compactTupleB0ca.savedPlan);
  expect(()=>compactCountB0ca(plan)).toThrow(/Unsupported/);
});
test('compact effort/risk retains native ownership, complete answer and offered-option guards',()=>{
  for(const mutate of [
    (q:ReturnType<typeof compactQuestionB0ca>)=>{q.nativeCall!.answered=false;},
    (q:ReturnType<typeof compactQuestionB0ca>)=>{q.nativeCall!.failed=true;},
    (q:ReturnType<typeof compactQuestionB0ca>)=>{q.signature='foreign';},
    (q:ReturnType<typeof compactQuestionB0ca>)=>{q.nativeCall!.answers={};},
    (q:ReturnType<typeof compactQuestionB0ca>)=>{q.options[1]!.label='unoffered choice';},
  ]){const q=compactQuestionB0ca();mutate(q);expect(()=>compactCountB0ca(undefined,q)).toThrow(/Invalid/);}
});

test('compact effort/risk preserves current metadata beside inert quoted history',()=>{
  const plan=compactTupleB0ca.savedPlan.replace(/\(([SM]), (low|medium) risk\)/g, '"Historical estimate: (XL, high risk)" $&');
  expect(compactCountB0ca(plan).counted).toBe(true);
});

const comparison6bd = fixture.contextualComparison6bd;
const comparisonQuestion6bd = () => nativePlanCallFingerprint(clone(comparison6bd.nativeCalls[0]!),0,true);
const comparisonCount6bd = (plan=comparison6bd.savedPlan,q=comparisonQuestion6bd()) => {
  const counter=createCeoPaymentFindingCounter(comparison6bd.seed,()=>plan,ceoFirstReviewAUQ);
  const counted=counter.isReviewAUQ(q);return {counted,trace:counter.trace};
};
test('6bd comparison binds the complete actual current report and native answer without seed credit',()=>{
  expect(createHash('sha256').update(comparison6bd.savedPlan).digest('hex')).toBe(comparison6bd.provenance.reportSha256);
  expect(Date.parse(comparison6bd.provenance.savedAt)).toBeLessThan(Date.parse(comparison6bd.provenance.questionAt));
  expect(Date.parse(comparison6bd.provenance.questionAt)).toBeLessThan(Date.parse(comparison6bd.nativeCalls[0]!.answeredAt!));
  expect(comparisonCount6bd()).toMatchObject({counted:true,trace:[{kind:'recorded-decision',ledgerId:'D1'}]});
  expect(ceoPaymentFinding(comparisonQuestion6bd(),comparison6bd.seed,comparison6bd.savedPlan)).toBeNull();
});
for(const risk of ['low-medium','low–medium','low—medium','low to medium','medium-high','low-high','LOW TO HIGH'])
  test(`6bd comparison accepts an explicit finite ascending risk interval ${risk}`,()=>{
    expect(comparisonCount6bd(comparison6bd.savedPlan.replace('low-medium risk',risk+' risk')).counted).toBe(true);
  });
for(const risk of ['medium-low','high-low','low-low','low-unknown','unknown-medium','low or medium','low/medium','low-medium-high','not low-medium','at most medium','low-medium and high'])
  test(`6bd comparison rejects an invalid or ambiguous risk interval ${risk}`,()=>{
    expect(()=>comparisonCount6bd(comparison6bd.savedPlan.replace('low-medium risk',risk+' risk'))).toThrow(/Unsupported/);
  });
for(const label of ['Bypass, as planned','Bypass (as written)','Bypass (as planned)'])
  test(`6bd comparison resolves the explicit same-row baseline caption ${label}`,()=>{
    expect(comparisonCount6bd(comparison6bd.savedPlan.replace('**B) Bypass, as written**',`**B) ${label}**`)).counted).toBe(true);
  });
test('6bd comparison permits coherent native option reordering while retaining semantic identity',()=>{
  const q=comparisonQuestion6bd();q.nativeCall!.questions[0]!.options.reverse();reanswer(q);
  expect(comparisonCount6bd(undefined,q).counted).toBe(true);
});
test('6bd comparison preserves instrumental direction without requiring one preposition spelling',()=>{
  const q=comparisonQuestion6bd();q.nativeCall!.questions[0]!.options[2]!.label='Register through a thin adapter shim';reanswer(q);
  const plan=comparison6bd.savedPlan.replace('**C) Register through a thin adapter shim**','**C) Register via a thin adapter shim**');
  expect(comparisonCount6bd(plan,q).counted).toBe(true);
});
for(const selected of [0,1,2])test(`6bd comparison binds every offered option with selected index ${selected}`,()=>{
  const q=comparisonQuestion6bd(),native=q.nativeCall!.questions[0]!;
  q.nativeCall!.answers={[native.question]:native.options[selected]!.label};
  expect(comparisonCount6bd(undefined,q).counted).toBe(true);
});
for(const [name,change]of Object.entries({
  'missing baseline attribution':(p:string)=>p.replace('**B) Bypass, as written**','**B) Bypass**'),
  'foreign current target':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','New class bypasses `ForeignDispatcher`'),
  'opposed current action':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','New class registers with `WebhookDispatcher`'),
  'negated current action':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','New class never bypasses `WebhookDispatcher`'),
  'contracted current negation':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`',"New class doesn't bypass WebhookDispatcher"),
  'future current value':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','New class will bypass WebhookDispatcher'),
  'foreign current attribution':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','Another plan says its new class bypasses WebhookDispatcher'),
  'historical current action':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','Previously the new class bypasses `WebhookDispatcher`'),
  'quoted current action':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','"New class bypasses WebhookDispatcher"'),
  'duplicate current identity':(p:string)=>p.replace('New class bypasses `WebhookDispatcher`','New class bypasses `WebhookDispatcher`; new class bypasses `WebhookDispatcher`'),
  'saved extra action':(p:string)=>p.replace('**B) Bypass, as written**','**B) Bypass and deploy, as written**'),
  'foreign source':(p:string)=>p.replaceAll('PLAN.md','OTHER.md'),
  'ambiguous current source':(p:string)=>p+'\nSource plan: OTHER.md\n',
  'duplicate current source':(p:string)=>p+'\nSource plan: PLAN.md\n',
  'foreign comparison owner':(p:string)=>p.replace('### D1 Architecture:','### OTHER Architecture:'),
  'historical comparison':(p:string)=>p.replace('### D1 Architecture:','### Historical D1 Architecture:'),
  'quoted comparison':(p:string)=>p.slice(0,p.indexOf('### D1 Architecture:'))+p.slice(p.indexOf('### D1 Architecture:')).split('\n').map(l=>'> '+l).join('\n'),
  'missing same-option pros':(p:string)=>p.replace('Pros: no coupling','Benefit: no coupling'),
  'missing same-option cons':(p:string)=>p.replace('Cons: two ways','Tradeoff: two ways'),
  'missing same-option effort':(p:string)=>p.replace('(M effort, low-medium risk)','(low-medium risk)'),
  'duplicate risk claims':(p:string)=>p.replace('(M effort, low-medium risk)','(M effort, low-medium risk). (S, low risk)'),
  'historical range':(p:string)=>p.replace('(M effort, low-medium risk)','Previously, (M effort, low-medium risk)'),
  'withdrawn range':(p:string)=>p.replace('(M effort, low-medium risk)','(M effort, low-medium risk). This estimate is no longer current'),
  'retracted record':(p:string)=>p.replace('| unresolved | pending |','| retracted | pending |'),
}))test(`6bd comparison rejects ${name}`,()=>{
  const plan=change(comparison6bd.savedPlan);expect(plan).not.toBe(comparison6bd.savedPlan);
  expect(()=>comparisonCount6bd(plan)).toThrow(/Unsupported/);
});
for(const [name,index,label]of [
  ['missing native baseline',1,'Bypass WebhookDispatcher'],
  ['native extra action',1,'Bypass WebhookDispatcher and delete the audit log (as written)'],
  ['native negation',1,'Do not bypass WebhookDispatcher (as written)'],
  ['foreign native target',1,'Bypass ForeignDispatcher (as written)'],
  ['different direction',2,'Register from a thin adapter shim'],
  ['instrumental extra action',2,'Register via a thin adapter shim and deploy'],
  ['instrumental negation',2,'Register without a thin adapter shim'],
] as const)test(`6bd comparison rejects ${name}`,()=>{
  const q=comparisonQuestion6bd();q.nativeCall!.questions[0]!.options[index]!.label=label;reanswer(q);
  expect(()=>comparisonCount6bd(undefined,q)).toThrow(/Unsupported/);
});
test('6bd comparison retains complete authenticated native-call gates',()=>{
  for(const change of [
    (q:ReturnType<typeof comparisonQuestion6bd>)=>{q.nativeCall!.answered=false;},
    (q:ReturnType<typeof comparisonQuestion6bd>)=>{q.nativeCall!.failed=true;},
    (q:ReturnType<typeof comparisonQuestion6bd>)=>{q.signature='foreign:call';},
    (q:ReturnType<typeof comparisonQuestion6bd>)=>{q.nativeCall!.answers={};},
    (q:ReturnType<typeof comparisonQuestion6bd>)=>{q.nativeCall!.unansweredQuestionIndices=[0];},
    (q:ReturnType<typeof comparisonQuestion6bd>)=>{q.options[1]!.label='not offered';},
  ]){const q=comparisonQuestion6bd();change(q);expect(()=>comparisonCount6bd(undefined,q)).toThrow(/Invalid/);}
});
for(const side of ['saved','native'] as const)for(const correction of [
  'This option is withdrawn.',
  'This baseline is no longer current.',
  'This option is now "withdrawn".',
  'This option never bypasses WebhookDispatcher.',
  'Also delete the audit log.',
  'Then deploy the handler.',
])test(`6bd comparison rejects ${side} baseline correction: ${correction}`,()=>{
  let plan=comparison6bd.savedPlan;const q=comparisonQuestion6bd();
  if(side==='native')q.nativeCall!.questions[0]!.options[1]!.description+=' '+correction;
  else plan=plan.replace('unless D5 adds tests.','unless D5 adds tests. '+correction);
  expect(()=>comparisonCount6bd(plan,q)).toThrow(/Unsupported/);
});
test('6bd comparison ignores quoted historical baseline corrections',()=>{
  const q=comparisonQuestion6bd();q.nativeCall!.questions[0]!.options[1]!.description+=' Historical note: "This option is withdrawn."';
  const plan=comparison6bd.savedPlan.replace('unless D5 adds tests.','unless D5 adds tests. Historical note: "This baseline is no longer current."');
  expect(comparisonCount6bd(plan,q).counted).toBe(true);
});

const currentCf74 = fixture.currentComparisonsCf74;
const emailCf74 = currentCf74.groups.find(g => g.case === 'distinct5')!;
const pairedCf74 = currentCf74.groups.find(g => g.attempt.endsWith('7XHXDl'))!;
const incompleteCf74 = currentCf74.groups.find(g => g.attempt.endsWith('U4p1F0'))!;
const cf74Question = (group = emailCf74) => nativePlanCallFingerprint(clone(group.calls.at(-1)!.call), 1, true);
const cf74Count = (group = emailCf74, plan = group.calls.at(-1)!.savedPlan, question = cf74Question(group), source = group.seed) => {
  const counter = createCeoPaymentFindingCounter(source, () => plan, ceoFirstReviewAUQ);
  const counted = counter.isReviewAUQ(question, group.calls.slice(0, -1).map(row => row.call));
  return { counted, trace: counter.trace };
};
test('cf74 captured current comparisons count complete source-bound choices with native ACKs', () => {
  for (const group of [emailCf74, pairedCf74]) {
    let plan = '', count = 0;
    const counter = createCeoPaymentFindingCounter(group.seed, () => plan, ceoFirstReviewAUQ);
    const prior: typeof group.calls[number]['call'][] = [];
    for (const row of group.calls) {
      plan = row.savedPlan;
      if (plan) {
        expect(createHash('sha256').update(plan).digest('hex')).toBe(row.savedPlanSha256!);
        expect(Date.parse(row.savedAt!)).toBeLessThan(Date.parse(row.questionIssuedAt));
      }
      expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt!));
      count += Number(counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.call), 1, true), prior));
      prior.push(row.call);
    }
    expect(count).toBe(group === emailCf74 ? 3 : 1);
    expect(counter.trace.at(-1)).toMatchObject({ kind: 'recorded-decision', ledgerId: group === emailCf74 ? 'R3' : 'T1' });
    expect(ceoPaymentFinding(cf74Question(group), group.seed, plan)).toBeNull();
  }
});
test('cf74 missing saved comparisons and mixed setup-review packets remain rejected', () => {
  expect(() => cf74Count(incompleteCf74)).toThrow(/Unsupported/);
  const counter = createCeoPaymentFindingCounter('', () => { throw new Error('mixed packet must not read a plan'); }, ceoFirstReviewAUQ);
  expect(() => counter.isReviewAUQ(nativePlanCallFingerprint(clone(currentCf74.mixedSetupReview), 1, true))).toThrow(/Invalid/);
});

const cf74Plan = emailCf74.calls.at(-1)!.savedPlan;
const pairedCf74Plan = pairedCf74.calls.at(-1)!.savedPlan;
const replaceCf74 = (text: string, from: string, to: string) => {
  expect(text.split(from).length).toBe(2);
  return text.replace(from, to);
};
const quotedTradeoffCf74 = '"retry only the notification." Cons:';
for (const ending of ['"notification."', '“notification.”', "'notification.'", '‘notification.’', '"notification!"', '"notification?"'])
  test(`cf74 prose fields remain operative after ${ending}`, () => {
    const plan = replaceCf74(cf74Plan, quotedTradeoffCf74, ending + '\n  Cons:');
    expect(cf74Count(emailCf74, plan).counted).toBe(true);
  });
for (const literal of ['"Cons: this is a quoted example."', '`Cons: a code-only example.`', '“Risk: high. Cons: an example.”'])
  test(`cf74 literal field names cannot replace current fields: ${literal}`, () => {
    const plan = replaceCf74(cf74Plan, quotedTradeoffCf74, 'the notification. ' + literal);
    expect(() => cf74Count(emailCf74, plan)).toThrow(/Unsupported/);
  });
test('cf74 quoted and code field names beside complete current facts stay inert', () => {
  const plan = replaceCf74(cf74Plan, quotedTradeoffCf74,
    'the notification. Historical example: "Effort XL. Risk high. Pros: old. Cons: old." `Risk: low.` Cons:');
  expect(cf74Count(emailCf74, plan).counted).toBe(true);
});
for (const marker of ['Effort S, risk low. Pros: payment alert', 'risk low. Pros: payment alert', 'Pros: payment alert', 'Cons: the handler now'])
  test(`cf74 quoted current fact cannot supply ${marker}`, () => {
    const plan = replaceCf74(cf74Plan, marker, '"' + marker + '"');
    expect(() => cf74Count(emailCf74, plan)).toThrow(/Unsupported/);
  });
for (const suffix of [' Cons: a second current cost.', ' This decision is withdrawn.', ' This option is no longer current.'])
  test(`cf74 complete facts reject current correction ${suffix}`, () => {
    const plan = replaceCf74(cf74Plan, 'rescue must be class-specific and covered by a test.', 'rescue must be class-specific and covered by a test.' + suffix);
    expect(() => cf74Count(emailCf74, plan)).toThrow(/Unsupported/);
  });
for (const state of ['Archived', 'Withdrawn', 'Retracted', 'Superseded', 'Obsolete', 'Historical'])
  for (const owner of ['comparison', 'comparison ancestor', 'ledger'] as const)
    test(`cf74 inactive comparison ownership rejects ${state} ${owner}`, () => {
      const from = owner === 'comparison' ? '### R3 — Email leg:' : owner === 'comparison ancestor'
        ? '## Step 0D. Alternatives' : '## Decision ledger';
      const to = owner === 'comparison' ? `### ${state} R3 — Email leg:` : owner === 'comparison ancestor'
        ? `## ${state} Step 0D. Alternatives` : `## ${state} Decision ledger`;
      expect(() => cf74Count(emailCf74, replaceCf74(cf74Plan, from, to))).toThrow(/Unsupported/);
    });
test('cf74 inactive comparison ownership ignores an archived sibling beside the current comparison', () => {
  const plan = cf74Plan + '\n## Archived unrelated comparison\n### OLD — Prior decision\nRetained history.\n';
  expect(cf74Count(emailCf74, plan).counted).toBe(true);
});
for (const location of ['comparison', 'saved source', 'input source'] as const)
  for (const descendant of [false, true])
    test(`cf74 current section ancestry excludes inactive siblings at ${location}, descendant=${descendant}`, () => {
      const heading = location === 'comparison' ? '### T1 — Test 1 assertion depth'
        : location === 'saved source' ? '## Existing behavior retained (from PLAN.md)' : '## Existing behavior retained';
      const depth = location === 'comparison' ? 3 : 2;
      const archived = '#'.repeat(depth) + ' Archived unrelated comparison\nRetained history.\n\n' +
        (descendant ? '#'.repeat(depth + 1) + ' Withdrawn child\nPrior details.\n\n' : '');
      const plan = location === 'input source' ? pairedCf74Plan : replaceCf74(pairedCf74Plan, heading, archived + heading);
      const source = location === 'input source' ? replaceCf74(pairedCf74.seed, heading, archived + heading) : pairedCf74.seed;
      expect(cf74Count(pairedCf74, plan, cf74Question(pairedCf74), source)).toMatchObject({
        counted: true, trace: [{ kind: 'recorded-decision', ledgerId: 'T1' }],
      });
    });
test('cf74 current section ancestry preserves archived ancestors and native ownership', () => {
  const plan = replaceCf74(pairedCf74Plan, '## 0D comparisons', '## Archived 0D comparisons');
  expect(() => cf74Count(pairedCf74, plan)).toThrow(/Unsupported/);
  const q = cf74Question(pairedCf74); q.nativeCall!.answered = false;
  expect(() => cf74Count(pairedCf74, pairedCf74Plan, q)).toThrow(/Invalid/);
});
const baselineCurrentCf74 = 'Inline email, no error handling, exception propagates to ingress → HTTP 500 → Stripe retry';
for (const value of [
  'Inline email, exception propagates to another endpoint → HTTP 500',
  'Inline email, exception propagates to ingress → HTTP 200',
  'Inline email, exception never propagates to ingress → HTTP 500',
  'Previously, exception propagates to ingress → HTTP 500',
  'If approved, exception propagates to ingress → HTTP 500',
  'Inline email; "exception propagates to ingress → HTTP 500"',
  'Inline email; exception propagates to ingress → HTTP 500; exception propagates to ingress → HTTP 500',
]) test(`cf74 short baseline does not borrow ${value}`, () => {
  expect(() => cf74Count(emailCf74, replaceCf74(cf74Plan, baselineCurrentCf74, value))).toThrow(/Unsupported/);
});
for (const [name, from, to] of [
  ['foreign own grid caption', '| B: rethrow (as written) |', '| B: forward (as written) |'],
  ['duplicate option column', '| C: enqueue send after commit |', '| B: rethrow (as written) |'],
  ['different own outcome', '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |', '| HTTP result on mail failure | pending | 500 | 200 | 200 | 200 |'],
  ['different current outcome', '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |', '| HTTP result on mail failure | pending | 200 | 200 | 500 | 200 |'],
  ['missing outcome', '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |', ''],
  ['duplicate outcome', '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |', '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |\n| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |'],
  ['quoted outcome', '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |', '| HTTP result on mail failure | pending | "500" | 200 | 500 | 200 |'],
  ['foreign ledger identity', '| R3 (plan author) |', '| OTHER (plan author) |'],
  ['historical owned comparison', '### R3 — Email leg:', '### Historical R3 — Email leg:'],
] as const) test(`cf74 short baseline rejects ${name}`, () => {
  expect(() => cf74Count(emailCf74, replaceCf74(cf74Plan, from, to))).toThrow(/Unsupported/);
});
for (const side of ['saved', 'native'] as const) for (const correction of [
  'This option is withdrawn.', 'This baseline is no longer current.', 'This option is now "rejected".',
  "This option is now 'withdrawn'.", 'This option is now ‘withdrawn’.',
  'This option does not rethrow to ingress.', 'Also delete the audit log.', 'Then deploy the handler.',
  'Instead return HTTP 200.',
]) test(`cf74 short baseline rejects ${side} correction ${correction}`, () => {
  const q = cf74Question();
  const plan = side === 'saved' ? replaceCf74(cf74Plan, 'every mail blip pages as a payment failure; two retry channels for one receipt.',
    'every mail blip pages as a payment failure; two retry channels for one receipt. ' + correction) : cf74Plan;
  if (side === 'native') q.nativeCall!.questions[0]!.options[1]!.description += ' ' + correction;
  expect(() => cf74Count(emailCf74, plan, q)).toThrow(/Unsupported/);
});
for (const label of ['B) Rethrow to foreignIngress, HTTP 500 (as written)', 'B) Rethrow to ingress, HTTP 200 (as written)',
  'B) Rethrow without ingress, HTTP 500 (as written)', 'B) Rethrow to ingress and deploy, HTTP 500 (as written)'])
  test(`cf74 short baseline requires exact native operands ${label}`, () => {
    const q = cf74Question(); q.nativeCall!.questions[0]!.options[1]!.label = label; reanswer(q);
    expect(() => cf74Count(emailCf74, cf74Plan, q)).toThrow(/Unsupported/);
  });
test('cf74 short baseline binds a coherent action/destination/result class without email-specific names', () => {
  const q = cf74Question();
  q.nativeCall!.questions[0]!.options[1]!.label = 'B) Forward to gateway, status 503 (as written)'; reanswer(q);
  let plan = replaceCf74(cf74Plan, baselineCurrentCf74, 'Exception flows to gateway → status 503');
  plan = replaceCf74(plan, '| B: rethrow (as written) |', '| B: forward (as written) |');
  plan = replaceCf74(plan, '**B) Rethrow (as written).**', '**B) Forward (as written).**');
  plan = replaceCf74(plan, '| HTTP result on mail failure | pending | 500 | 200 | 500 | 200 |', '| Status result on mail failure | pending | 503 | 200 | 503 | 200 |');
  expect(cf74Count(emailCf74, plan, q).counted).toBe(true);
});
const t1EvidenceCf74 = 'Test 1 success-path assertion depth. Evidence: §Existing behavior gives exact receipt; §Proposed tests 1 says "assert only truthy". Code unverified in this checkout.';
for (const source of ['OTHER.md', 'docs/PLAN.md', '../PLAN.md', '/tmp/PLAN.md', 'PLAN.md and OTHER.md'])
  test(`cf74 section ownership rejects current heading source ${source}`, () => {
    const plan = pairedCf74Plan.replaceAll('(from PLAN.md)', '(from ' + source + ')');
    expect(() => cf74Count(pairedCf74, plan)).toThrow(/Unsupported/);
  });
for (const [name, evidence] of [
  ['unknown section', 'Evidence: §Unknown section gives exact receipt.'],
  ['partial section name', 'Evidence: §Existing behav gives exact receipt.'],
  ['prefix lookalike', 'Evidence: §Existing behaviorExtra gives exact receipt.'],
  ['foreign citation', 'OTHER.md ' + t1EvidenceCf74],
  ['mixed foreign/current citation', 'PLAN.md + OTHER.md ' + t1EvidenceCf74],
  ['quoted sections only', 'Evidence: "§Existing behavior gives exact receipt; §Proposed tests says truthy".'],
  ['single quoted sections only', "Evidence: '§Existing behavior gives exact receipt; §Proposed tests says truthy'."],
  ['curly single quoted sections only', 'Evidence: ‘§Existing behavior gives exact receipt; §Proposed tests says truthy’.'],
  ['coded sections only', 'Evidence: `§Existing behavior` gives exact receipt; `§Proposed tests` says truthy.'],
  ['historical attribution', 'Historical ' + t1EvidenceCf74],
  ['withdrawn attribution', t1EvidenceCf74 + ' This decision is withdrawn.'],
] as const) test(`cf74 section ownership rejects ${name}`, () => {
  expect(() => cf74Count(pairedCf74, replaceCf74(pairedCf74Plan, t1EvidenceCf74, evidence))).toThrow(/Unsupported/);
});
for (const [name, mutate] of Object.entries({
  'missing current source heading': (p: string) => p.replaceAll('(from PLAN.md)', ''),
  'duplicate current source heading': (p: string) => p + '\n## Existing behavior retained (from PLAN.md)\nDuplicate.\n',
  'quoted source heading': (p: string) => p.replaceAll('## Existing behavior retained (from PLAN.md)', '> ## Existing behavior retained (from PLAN.md)'),
  'historical source heading': (p: string) => p.replaceAll('## Existing behavior retained (from PLAN.md)', '## Historical Existing behavior retained (from PLAN.md)'),
  'withdrawn source heading': (p: string) => p.replaceAll('## Existing behavior retained (from PLAN.md)', '## Existing behavior withdrawn (from PLAN.md)'),
  'duplicate global source': (p: string) => p + '\nSource: PLAN.md\n\nSource: PLAN.md\n',
  'foreign global source': (p: string) => p + '\nSource: OTHER.md\n',
  'foreign current ledger': (p: string) => p.replace('| T1 (user / processPayment suite) |', '| OTHER (user / processPayment suite) |'),
  'historical comparison': (p: string) => p.replace('### T1 — Test 1 assertion depth', '### Historical T1 — Test 1 assertion depth'),
  'historical ledger': (p: string) => p.replace('## Decision ledger', '## Historical Decision ledger'),
  'withdrawn ledger heading': (p: string) => p.replace('## Decision ledger', '## Decision ledger (withdrawn)'),
  'archived comparison ancestor': (p: string) => p.replace('## 0D comparisons', '## Archived 0D comparisons'),
  'withdrawn source ancestor': (p: string) => p.replace('## Existing behavior retained (from PLAN.md)', '## Source material (withdrawn)\n### Existing behavior retained (from PLAN.md)'),
  'archived source ancestor': (p: string) => p.replace('## Existing behavior retained (from PLAN.md)', '## Archived source material\n### Existing behavior retained (from PLAN.md)'),
})) test(`cf74 section ownership rejects ${name}`, () => {
  const plan = mutate(pairedCf74Plan); expect(plan).not.toBe(pairedCf74Plan);
  expect(() => cf74Count(pairedCf74, plan)).toThrow(/Unsupported/);
});
for (const source of [
  pairedCf74.seed.replace('## Existing behavior retained', '## Different behavior'),
  pairedCf74.seed + '\n## Existing behavior retained\nSecond declaration.\n',
  pairedCf74.seed.replace('## Existing behavior retained', '## Historical Existing behavior retained'),
  pairedCf74.seed.replace('## Proposed tests', '## Different tests'),
  pairedCf74.seed.replace('## Existing behavior retained', '## Previous material (withdrawn)\n### Existing behavior retained'),
  pairedCf74.seed.replace('## Existing behavior retained', '## Archived material\n### Existing behavior retained'),
]) test(`cf74 section citations authenticate actual source headings ${createHash('sha256').update(source).digest('hex').slice(0,8)}`, () => {
  expect(() => cf74Count(pairedCf74, pairedCf74Plan, cf74Question(pairedCf74), source)).toThrow(/Unsupported/);
});
test('cf74 source descriptors and inert historical headings do not change current ownership', () => {
  const plan = pairedCf74Plan.replaceAll(' retained (from PLAN.md)', ' (from PLAN.md)') +
    '\n## Historical record\n### Existing behavior retained (from OTHER.md)\nObsolete record.\n';
  expect(cf74Count(pairedCf74, plan).counted).toBe(true);
});
for (const group of [emailCf74, pairedCf74]) test(`cf74 complete ${group.case} current comparisons still require native ownership`, () => {
  for (const change of [
    (q: ReturnType<typeof cf74Question>) => { q.nativeCall!.answered = false; },
    (q: ReturnType<typeof cf74Question>) => { q.nativeCall!.failed = true; },
    (q: ReturnType<typeof cf74Question>) => { q.signature = 'foreign:call'; },
    (q: ReturnType<typeof cf74Question>) => { q.nativeCall!.answers = {}; },
    (q: ReturnType<typeof cf74Question>) => { q.nativeCall!.unansweredQuestionIndices = [0]; },
    (q: ReturnType<typeof cf74Question>) => { q.nativeCall!.questions.push(clone(q.nativeCall!.questions[0]!)); },
  ]) { const q = cf74Question(group); change(q); expect(() => cf74Count(group, group.calls.at(-1)!.savedPlan, q)).toThrow(/Invalid/); }
});
for(const side of ['saved','native'] as const)for(const correction of [
  'This option is withdrawn.','This option is now "rejected".',
  'This option does not register through a thin adapter shim.',
  'Also delete the audit log.','Then deploy the handler.',
])test(`6bd comparison rejects ${side} instrumental-option correction: ${correction}`,()=>{
  let plan=comparison6bd.savedPlan;const q=comparisonQuestion6bd();
  if(side==='native')q.nativeCall!.questions[0]!.options[2]!.description+=' '+correction;
  else plan=plan.replace('premature abstraction until a second handler exists.','premature abstraction until a second handler exists. '+correction);
  expect(()=>comparisonCount6bd(plan,q)).toThrow(/Unsupported/);
});


const current8bf = fixture.current8bf.rows;
function replay8bf(row: typeof current8bf.pending, savedPlan = row.savedPlan, call = clone(row.call)) {
  const counter = createCeoPaymentFindingCounter(row.seed, () => savedPlan, ceoFirstReviewAUQ);
  const counted = counter.isReviewAUQ(nativePlanCallFingerprint(call, 1, true), row.priorCalls);
  return { counted, trace: counter.trace };
}
function rowStatus8bf(plan: string, status: string) {
  const lines = plan.split('\n');
  const index = lines.findIndex(line => /^\| R1 \(/.test(line));
  expect(index).toBeGreaterThanOrEqual(0);
  const cells = lines[index]!.split('|');
  expect(cells[5]!.trim()).toBe('pending');
  cells[5] = ` ${status} `; lines[index] = cells.join('|');
  return lines.join('\n');
}
test('8bf current pending row is an unresolved owned decision', () => {
  const row=current8bf.pending;
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedPlanSha256);
  expect(row.savedAtMs).toBeLessThan(Date.parse(row.questionIssuedAt));
  expect(Date.parse(row.questionIssuedAt)).toBeLessThanOrEqual(Date.parse(row.call.answeredAt!));
  expect(replay8bf(row)).toMatchObject({ counted:true, trace:[{seed:'dispatcher',ledgerId:'R1'}] });
});
test('8bf source-declared bare columns and separate effort/risk preserve the actual complete decision', () => {
  const row=current8bf.grid;
  expect(createHash('sha256').update(row.savedPlan).digest('hex')).toBe(row.savedPlanSha256);
  expect(row.savedAtMs).toBeLessThan(Date.parse(row.questionIssuedAt));
  expect(replay8bf(row)).toMatchObject({counted:true,trace:[{kind:'recorded-decision',ledgerId:'R1'}]});
  expect(ceoPaymentFinding(nativePlanCallFingerprint(clone(row.call),1,true),row.seed,row.savedPlan)).toBeNull();
});
test('8bf mixed setup and review still rejects the entire answered packet', () => {
  let reads=0;const row=current8bf.mixed,counter=createCeoPaymentFindingCounter(row.seed,()=>{reads++;return row.savedPlan;},ceoFirstReviewAUQ);
  expect(()=>counter.isReviewAUQ(nativePlanCallFingerprint(clone(row.call),1,true),row.priorCalls)).toThrow(/Invalid or duplicated/);
  expect(reads).toBe(0);expect(counter.trace).toEqual([]);
});

function replaceOnce8bf(value:string, before:string, after:string) {
  expect(value.split(before)).toHaveLength(2);
  return value.replace(before,after);
}
for (const status of ['pending','PENDING','unresolved','approved','reopened','deferred','declined'])
  test(`8bf ledger preserves current disposition ${status}`,()=>{
    expect(replay8bf(current8bf.pending,rowStatus8bf(current8bf.pending.savedPlan,status)).counted).toBe(true);
  });
for (const status of ["'pending'",'“pending”','not pending','no longer pending','pending / approved','pending but withdrawn','pending: historical','formerly pending','pending?','pending approval','withdrawn','archived','superseded','cancelled','unknown',''])
  test(`8bf ledger rejects non-current or qualified pending scalar ${status}`,()=>{
    expect(()=>replay8bf(current8bf.pending,rowStatus8bf(current8bf.pending.savedPlan,status))).toThrow(/Unsupported/);
  });
for (const [name,change] of Object.entries({
  'archived ledger':(p:string)=>replaceOnce8bf(p,'## Decision ledger','## Archived decision ledger'),
  'withdrawn owner':(p:string)=>replaceOnce8bf(p,'R1 (plan author)','R1 (withdrawn plan author)'),
  'archived comparison':(p:string)=>replaceOnce8bf(p,'### R1 — Handler registration','### Archived R1 — Handler registration'),
  'duplicate source':(p:string)=>p+'\nSource plan: PLAN.md\n',
  'foreign document source':(p:string)=>replaceOnce8bf(p,'Source plan: `PLAN.md`','Source plan: `OTHER.md`'),
  'foreign row evidence':(p:string)=>replaceOnce8bf(p,'(PLAN.md L100-103, L105-108)','(OTHER.md L100-103, L105-108)'),
  'mixed source evidence':(p:string)=>replaceOnce8bf(p,'(PLAN.md L100-103, L105-108)','(PLAN.md and OTHER.md L100-103, L105-108)'),
  'missing status column':(p:string)=>replaceOnce8bf(p,'| Status |','| State |'),
  'duplicate status column':(p:string)=>replaceOnce8bf(p,'| Exact approval and scope |','| Status |'),
  'duplicate owned row':(p:string)=>p.replace(/^(\| R1 \(plan author\).*)$/m,'$1\n$1'),
  'second current comparison':(p:string)=>p+'\n### R1 — Another current comparison\nRegister the dispatcher.\n',
})) test(`8bf pending ownership rejects ${name}`,()=>{
  expect(()=>replay8bf(current8bf.pending,change(current8bf.pending.savedPlan))).toThrow(/Unsupported/);
});
test('8bf pending ownership ignores a quoted historical ledger',()=>{
  const quote=current8bf.pending.savedPlan.split('\n').map(line=>'> '+line).join('\n');
  expect(replay8bf(current8bf.pending,current8bf.pending.savedPlan+'\n\n'+quote).counted).toBe(true);
});
function grid8bf(change:(block:string)=>string, plan=current8bf.grid.savedPlan) {
  const start=plan.indexOf('### R1 option comparison'),end=plan.indexOf('### R2 option comparison');
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);
  return plan.slice(0,start)+change(plan.slice(start,end))+plan.slice(end);
}
for (const [name,change] of Object.entries({
  'combined metadata':(b:string)=>b.replace(/^\| Effort \|.*\n\| Risk \|.*\n/m,'| Effort / risk | | | S / low | S / low | S / low |\n'),
  'plain finite metadata':(b:string)=>b.replace('S (human ~10 min / CC ~1 min)','S').replace('low (test cannot fail meaningfully)','low'),
  'metadata row order':(b:string)=>b.replace(/^(\| Effort \|.*)\n(\| Risk \|.*)$/m,'$2\n$1'),
  'grid column order':(b:string)=>b.split('\n').map(line=>{if(!line.startsWith('|'))return line;const c=line.split('|');[c[4],c[6]]=[c[6],c[4]];return c.join('|');}).join('\n'),
})) test(`8bf owned bare grid accepts ${name}`,()=>{
  expect(replay8bf(current8bf.grid,grid8bf(change)).counted).toBe(true);
});
for (const [name,change] of Object.entries({
  'missing effort':(b:string)=>b.replace(/^\| Effort \|.*\n/m,''),
  'missing risk':(b:string)=>b.replace(/^\| Risk \|.*\n/m,''),
  'duplicate effort':(b:string)=>b.replace(/^(\| Effort \|.*)$/m,'$1\n$1'),
  'duplicate risk':(b:string)=>b.replace(/^(\| Risk \|.*)$/m,'$1\n$1'),
  'mixed combined metadata':(b:string)=>b.trimEnd()+'\n| Effort / risk | | | S / low | S / low | S / low |\n\n',
  'blank risk cell':(b:string)=>replaceOnce8bf(b,'| low | low | low (','| low | | low ('),
  'unknown effort':(b:string)=>replaceOnce8bf(b,'| S | S |','| unknown | S |'),
  'unknown risk':(b:string)=>replaceOnce8bf(b,'| low | low | low (','| low | unknown | low ('),
  'negated risk':(b:string)=>replaceOnce8bf(b,'| low | low | low (','| not low | low | low ('),
  'quoted risk':(b:string)=>replaceOnce8bf(b,'| low | low | low (','| "low" | low | low ('),
  'withdrawn risk metadata':(b:string)=>replaceOnce8bf(b,'low (test cannot fail meaningfully)','low (this estimate is withdrawn)'),
  'contradictory risk metadata':(b:string)=>replaceOnce8bf(b,'low (test cannot fail meaningfully)','low (actually high)'),
  'contradictory effort metadata':(b:string)=>replaceOnce8bf(b,'S (human ~10 min / CC ~1 min)','S (actually XL)'),
  'duplicate column identity':(b:string)=>replaceOnce8bf(b,'| A | B | C |','| A | B | B |'),
  'unoffered column identity':(b:string)=>replaceOnce8bf(b,'| A | B | C |','| A | B | D |'),
  'missing column identity':(b:string)=>replaceOnce8bf(b,'| A | B | C |','| A | B | |'),
  'mismatched column caption':(b:string)=>replaceOnce8bf(b,'| A | B | C |','| A) Delete the receipt | B | C |'),
  'foreign commitment source':(b:string)=>replaceOnce8bf(b,'| Receipt is returned | PLAN.md |','| Receipt is returned | OTHER.md |'),
  'blank commitment source':(b:string)=>replaceOnce8bf(b,'| Receipt is returned | PLAN.md |','| Receipt is returned | |'),
  'missing commitment value':(b:string)=>replaceOnce8bf(b,'| truthy | equality | equality | truthy |','| truthy | | equality | truthy |'),
  'withdrawn comparison':(b:string)=>b.replace('### R1 option comparison','### Withdrawn R1 option comparison'),
  'quoted grid':(b:string)=>b.split('\n').map(line=>line.startsWith('|')?'> '+line:line).join('\n'),
  'code-only grid':(b:string)=>b.replace('| Commitment','```text\n| Commitment')+'```\n',
  'duplicate current grid':(b:string)=>b+b.slice(b.indexOf('| Commitment')),
})) test(`8bf bare grid rejects ${name}`,()=>{
  expect(()=>replay8bf(current8bf.grid,grid8bf(change))).toThrow(/Unsupported/);
});
for (const [name,change] of Object.entries({
  'foreign ledger source':(p:string)=>p.replaceAll('PLAN.md','OTHER.md'),
  'archived ledger':(p:string)=>replaceOnce8bf(p,'## Step 0D — Decision ledger','## Archived Step 0D — Decision ledger'),
  'duplicate document source':(p:string)=>p+'\nSource plan: PLAN.md\n',
  'duplicate owned ledger row':(p:string)=>p.replace(/^(\| R1 \(owner: test author\).*)$/m,'$1\n$1'),
  'missing option declaration':(p:string)=>replaceOnce8bf(p,'C) keep truthy-only.','keep truthy-only.'),
  'mismatched option declaration':(p:string)=>replaceOnce8bf(p,'B) assert full receipt equality only.','B) delete the database.'),
})) test(`8bf grid provenance rejects ${name}`,()=>{
  expect(()=>replay8bf(current8bf.grid,change(current8bf.grid.savedPlan))).toThrow(/Unsupported/);
});
for (const declaration of [
  'delete the receipt', 'assert full invoice equality only', 'assert full receipt inequality only',
  'do not assert full receipt equality only', 'assert full receipt equality only and delete the receipt',
  'assert only receipt equality', 'assert full receipt equality without currency',
  'assert full receipt != equality only', 'assert full "receipt equality only"',
]) test(`8bf bare declaration rejects conflicting whole choice: ${declaration}`, () => {
  const plan = replaceOnce8bf(current8bf.grid.savedPlan, 'B) assert full receipt equality only.', `B) ${declaration}.`);
  expect(() => replay8bf(current8bf.grid, plan)).toThrow(/Unsupported/);
});
for (const side of ['saved', 'native'] as const)
  test(`8bf bare declaration preserves complete action counts on ${side}`, () => {
    const call = clone(current8bf.grid.call);
    const plan = side === 'saved' ? replaceOnce8bf(current8bf.grid.savedPlan,
      'plus exactly one mock charge call', 'plus exactly two mock charge calls') : current8bf.grid.savedPlan;
    if (side === 'native') {
      const q = call.questions[0]!;
      q.options[0]!.label = q.options[0]!.label.replace('one charge call', 'two charge calls');
      call.answers = { [q.question]: q.options[0]!.label };
    }
    expect(() => replay8bf(current8bf.grid, plan, call)).toThrow(/Unsupported/);
  });
for (const connector of ['+', 'plus', 'and'])
  test(`8bf bare declaration accepts complete nominal assertion with ${connector}`, () => {
    const plan = replaceOnce8bf(current8bf.grid.savedPlan,
      'A) assert full receipt equality plus exactly one mock charge call with amountCents=1000, currency=USD.',
      `A) Receipt equality ${connector} one charge call.`);
    expect(replay8bf(current8bf.grid, plan)).toMatchObject({ counted: true, trace: [{ kind: 'recorded-decision', ledgerId: 'R1' }] });
  });
for (const argumentsText of [
  'amountCents=1001, currency=USD', 'amountCents=1000, currency=EUR', 'amountCents=1000, currency=usd',
  'amountcents=1000, currency=USD', 'amountCents=1000, currency=USD, deleteReceipt=1',
  'amountCents=1000, currency=USD, max_retries=1', 'amountCents=1000, amountCents=1000, currency=USD',
]) test(`8bf bare declaration rejects unbound call arguments: ${argumentsText}`, () => {
  const plan = replaceOnce8bf(current8bf.grid.savedPlan, 'with amountCents=1000, currency=USD', `with ${argumentsText}`);
  expect(() => replay8bf(current8bf.grid, plan)).toThrow(/Unsupported/);
});
test('8bf bare declaration source arguments retain identity across order and inert history', () => {
  const plan = replaceOnce8bf(current8bf.grid.savedPlan, 'with amountCents=1000, currency=USD', 'with currency=USD, amountCents=1000');
  const row = { ...current8bf.grid, seed: current8bf.grid.seed + '\n## Archived calls\nCall processPayment with amountCents=1001 and currency=usd.\n' };
  expect(replay8bf(row, plan)).toMatchObject({ counted: true, trace: [{ kind: 'recorded-decision', ledgerId: 'R1' }] });
});
for (const [name, source] of Object.entries({
  'quoted call': current8bf.grid.seed.replace('processPayment with amountCents=1000 and currency=USD', '"processPayment with amountCents=1000 and currency=USD"'),
  'changed operand': current8bf.grid.seed.replace('processPayment with amountCents=1000 and currency=USD', 'processPayment with amountCents=1001 and currency=USD'),
  'inactive source section': current8bf.grid.seed.replace('## Proposed tests', '## Archived Proposed tests'),
})) test(`8bf bare declaration cannot borrow source arguments from ${name}`, () => {
  expect(source).not.toBe(current8bf.grid.seed);
  expect(() => replay8bf({ ...current8bf.grid, seed: source })).toThrow(/Unsupported/);
});
for (const [name,change] of Object.entries({
  'missing native pros':(c:typeof current8bf.grid.call)=>{c.questions[0]!.options[1]!.description='❌ There is no stated benefit.';},
  'missing native cons':(c:typeof current8bf.grid.call)=>{c.questions[0]!.options[1]!.description='✅ This adds exact coverage.';},
  'withdrawn native choice':(c:typeof current8bf.grid.call)=>{c.questions[0]!.options[1]!.description+=' This option is withdrawn.';},
  'missing native selector':(c:typeof current8bf.grid.call)=>{c.questions[0]!.options[1]!.label='Receipt equality only';},
  'duplicate native selector':(c:typeof current8bf.grid.call)=>{c.questions[0]!.options[1]!.label='A: Receipt equality only';},
  'unoffered native selector':(c:typeof current8bf.grid.call)=>{c.questions[0]!.options[1]!.label='D: Receipt equality only';},
  'failed ACK':(c:typeof current8bf.grid.call)=>{c.failed=true;},
  'missing ACK':(c:typeof current8bf.grid.call)=>{c.answered=false;},
  'unanswered tab':(c:typeof current8bf.grid.call)=>{c.unansweredQuestionIndices=[0];},
  'unoffered answer':(c:typeof current8bf.grid.call)=>{c.answers={[c.questions[0]!.question]:'Not an offered choice'};},
})) test(`8bf complete native ownership rejects ${name}`,()=>{
  const c=clone(current8bf.grid.call);change(c);
  expect(()=>replay8bf(current8bf.grid,current8bf.grid.savedPlan,c)).toThrow();
});
