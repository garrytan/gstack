import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import fixture from './fixtures/ceo-count-ad-v2.json';
import {readPlanCountTranscript,type NativePlanQuestionCall} from './helpers/plan-count-transcript';
import {ceoFirstReviewAUQ,ceoStep0Boundary,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import {isCeoCompletionHandoff,pickCeoCompletionHandoff} from './helpers/ceo-completion-handoff';
import {selectTests, E2E_TOUCHFILES} from './helpers/touchfiles';
const fp=(c:NativePlanQuestionCall)=>nativePlanCallFingerprint(c,0,true);
const get=(which:'distinct'|'paired'|'pairedRetry',index:number)=>structuredClone(fixture.cases[which].calls[index]) as NativePlanQuestionCall;
const realFindings=()=>[get('distinct',4),get('paired',4),get('paired',5),get('pairedRetry',2),get('pairedRetry',3)];
const answer=(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};return c;};
function count(calls:NativePlanQuestionCall[]){let started=false;const n={setup:0,review:0,administrative:0};for(const c of calls){const p=planCountQuestionPhase(fp(c),started,ceoStep0Boundary,ceoFirstReviewAUQ,undefined,isCeoCompletionHandoff);started=p.reviewStarted;n[p.administrative?'administrative':p.preReview?'setup':'review']++;}return n;}

test('exact public native requests and successful replies reconstruct the captured calls once',()=>{
 for(const which of ['distinct','paired','pairedRetry'] as const){const c=fixture.cases[which],dir=fs.mkdtempSync(path.join(os.tmpdir(),'ceo-count-public-'));try{const project=path.join(dir,'projects','owned');fs.mkdirSync(project,{recursive:true});const records=c.nativeRecords.map(r=>JSON.stringify(r)).join('\n')+'\n';fs.writeFileSync(path.join(project,c.calls[0]!.sessionId+'.jsonl'),records+records);expect(readPlanCountTranscript(dir,c.observation.capture.cwd).calls).toEqual(c.calls);for(const a of c.timeAnchors){expect(Date.parse(a.requestAt)).toBeLessThanOrEqual(Date.parse(a.replyAt));expect(Date.parse(a.replyAt)).toBeLessThanOrEqual(Date.parse(c.observation.capture.at));}}finally{fs.rmSync(dir,{recursive:true,force:true});}}
});
for(const [which,index] of [['distinct',4],['paired',4],['paired',5]] as const)test(`actual ${which} issue ${index} starts review from a completed native decision`,()=>expect(ceoFirstReviewAUQ(fp(get(which,index)))).toBe(true));
test('exact snapshots keep real issue counts and separate the administrative handoff',()=>{
 expect(count(fixture.cases.distinct.calls as NativePlanQuestionCall[])).toEqual({setup:4,review:1,administrative:0});
 expect(count(fixture.cases.paired.calls as NativePlanQuestionCall[])).toEqual({setup:4,review:2,administrative:1});
 expect(fixture.cases.distinct.observation.state).toBe('in_progress');expect(fixture.cases.paired.observation.state).toBe('in_progress');
 expect(count(fixture.cases.distinct.calls as NativePlanQuestionCall[]).review).toBeLessThan(4);
});
test('finding numbering and matching header identity are presentation, not extra findings',()=>{
 for(const c of realFindings()){
  const q=c.questions[0]!,oldTitle=q.question.split('\n')[0]!;q.question=q.question.replace(/^D\d+\s*[—–-]\s*/,'');answer(c);expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  q.question=q.question.replace(/^(Finding|Issue)\s+[\d.]+:/,'$1 27.3:');if(/^(Finding|Issue)\s+[\d.]+$/i.test(q.header))q.header=q.header.replace(/[\d.]+/,'27.3');answer(c);expect(ceoFirstReviewAUQ(fp(c))).toBe(true);
  expect(oldTitle).toContain('?');
 }
});
test('native completion, identity, offered answer and unambiguous single issue remain mandatory',()=>{
 const mutations:Array<(c:NativePlanQuestionCall)=>void>=[c=>{c.answered=false;},c=>{c.failed=true;},c=>{c.answers={};},c=>{c.unansweredQuestionIndices=[0];},c=>{c.questions[0]!.multiSelect=true;},c=>{c.answers={[c.questions[0]!.question]:'unoffered'};},c=>{c.questions.push(structuredClone(c.questions[0]!));},c=>{c.questions[0]!.options[1]!.label=c.questions[0]!.options[0]!.label;answer(c);}];
 for(const mutate of mutations)for(const c of realFindings()){mutate(c);expect(ceoFirstReviewAUQ(fp(c))).toBe(false);}
 for(const c of realFindings()){expect(ceoFirstReviewAUQ({...fp(c),signature:'foreign:call'})).toBe(false);expect(ceoFirstReviewAUQ({...fp(c),nativeCall:undefined})).toBe(false);expect(ceoFirstReviewAUQ({...fp(c),options:[]})).toBe(false);}
});
test('setup, quoted examples, foreign qids and contradictory numbered headers cannot start review',()=>{
 for(const prefix of ['Example: ','> ','"','```\n'])for(const c of realFindings()){c.questions[0]!.question=prefix+c.questions[0]!.question;expect(ceoFirstReviewAUQ(fp(answer(c)))).toBe(false);}
 for(const header of ['Approach','Mode','Next review','Setup','Finding 88','Issue 88'])for(const c of realFindings()){c.questions[0]!.header=header;expect(ceoFirstReviewAUQ(fp(c))).toBe(false);}
 for(const c of realFindings()){c.questions[0]!.question+=' <gstack-qid:plan-eng-review-finding>';expect(ceoFirstReviewAUQ(fp(answer(c)))).toBe(false);}
 for(const which of ['distinct','paired'] as const)for(const c of fixture.cases[which].calls.slice(0,4))expect(ceoFirstReviewAUQ(fp(c as NativePlanQuestionCall))).toBe(false);
});
test('a completed pure next-review menu is administrative without granting pending input permission',()=>{
 const c=get('paired',6);expect(isCeoCompletionHandoff(fp(c))).toBe(true);expect(ceoFirstReviewAUQ(fp(c))).toBe(false);expect(pickCeoCompletionHandoff(fp(c))).toBeNull();c.answered=false;delete c.answers;delete c.answeredAt;c.unansweredQuestionIndices=[0];expect(isCeoCompletionHandoff(fp(c))).toBe(false);expect(pickCeoCompletionHandoff(fp(c))).toBeNull();
});
test('new work or uncertain closure in the next-review choice stays substantive',()=>{
 for(const suffix of ['\nFix the missing authentication check.','\nDelete the CI gate.','\nShip the new endpoint now.','\nWhich new endpoint should we add?']){const c=get('paired',6);c.questions[0]!.question+=suffix;expect(isCeoCompletionHandoff(fp(answer(c)))).toBe(false);}
 for(const change of ['CEO review is not complete.','CEO review will be complete.','Example: CEO review complete.']){const c=get('paired',6);c.questions[0]!.question=c.questions[0]!.question.replace('CEO review complete.',change);expect(isCeoCompletionHandoff(fp(answer(c)))).toBe(false);}
 for(const mutation of [c=>{c.failed=true;},c=>{c.questions[0].multiSelect=true;},c=>{c.answers={[c.questions[0].question]:'Fix the bug first'};},c=>{c.questions[0].options.push({label:'Fix the security issue',description:'Add a new check.'});}] as Array<(c:NativePlanQuestionCall)=>void>){const c=get('paired',6);mutation(c);expect(isCeoCompletionHandoff(fp(c))).toBe(false);}
});

// The next-gate explanation must never turn conditional CEO closure into a
// completed review. Its narrow normalization is for counting only.
test('next Eng gate timing cannot supply conditional CEO completion', () => {
  for (const replacement of [
    'The CEO review is complete until someone runs it later.',
    'The CEO review is complete if someone runs it later.',
    'The CEO review will be complete after someone runs it later.',
    'The CEO review still has unresolved findings.',
  ]) {
    const call = get('paired', 6);
    call.questions[0]!.question = call.questions[0]!.question.replace(
      'The CEO review cleared scope and strengthened both test assertions.', replacement);
    expect(isCeoCompletionHandoff(fp(answer(call)))).toBe(false);
  }
});

test('actual evidence and its regression select the paid CEO counting test', () => {
  for (const file of ['test/ceo-count-ad-v2.test.ts', 'test/fixtures/ceo-count-ad-v2.json']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected).toContain('plan-ceo-finding-count');
  }
});

test('the actual completed retry keeps two findings and its body-closure handoff administrative', () => {
  const calls = fixture.cases.pairedRetry.calls as NativePlanQuestionCall[];
  expect(count(calls)).toEqual({setup: 2, review: 2, administrative: 1});
  expect(fixture.cases.pairedRetry.observation.outcome).toBe('no_review_questions');
  expect(fixture.cases.pairedRetry.observation.completionCredit).toBe(false);
  expect(isCeoCompletionHandoff(fp(get('pairedRetry', 4)))).toBe(true);
  expect(pickCeoCompletionHandoff(fp(get('pairedRetry', 4)))).toBeNull();
});

test('body closure and echoed choices cannot hide new work or uncertain CEO closure', () => {
  for (const text of ['Fix the missing authentication check.', 'Delete the CI gate.', 'Ship the new endpoint now.', 'Which endpoint should we add?']) {
    const call = get('pairedRetry', 4);
    call.questions[0]!.question += '\n' + text;
    expect(isCeoCompletionHandoff(fp(answer(call)))).toBe(false);
  }
  for (const text of ['The CEO review is not done', 'The CEO review will be done', 'The CEO review is done if the fixes land', 'Example: The CEO review is done']) {
    const call = get('pairedRetry', 4);
    call.questions[0]!.question = call.questions[0]!.question.replace('The CEO review is done', text);
    expect(isCeoCompletionHandoff(fp(answer(call)))).toBe(false);
  }
  const pending = get('pairedRetry', 4); pending.answered = false; delete pending.answers; delete pending.answeredAt; pending.unansweredQuestionIndices = [0];
  expect(isCeoCompletionHandoff(fp(pending))).toBe(false);
  expect(pickCeoCompletionHandoff(fp(pending))).toBeNull();
  expect(isCeoCompletionHandoff({...fp(get('pairedRetry', 4)), signature: 'foreign:call'})).toBe(false);
});

test('every offered navigation clause rejects a new repair rather than hiding it under a valid recap', () => {
  for (const [which, index] of [['paired', 6], ['pairedRetry', 4]] as const) {
    for (const extra of ['Delete the CI gate.', 'Repair the retry assertion.', 'Disable authentication.', 'Please rewrite the endpoint.']) {
      for (const optionIndex of [0, 1]) {
        const call = get(which, index);
        call.questions[0]!.options[optionIndex]!.description += ' ' + extra;
        expect(isCeoCompletionHandoff(fp(call))).toBe(false);
      }
      for (const where of ['before-net', 'inside-eli10'] as const) {
        const call = get(which, index);
        call.questions[0]!.question = where === 'before-net'
          ? call.questions[0]!.question.replace('\nNet:', '\n' + extra + '\nNet:')
          : call.questions[0]!.question.replace('\nStakes if', ' ' + extra + '\nStakes if');
        expect(isCeoCompletionHandoff(fp(answer(call)))).toBe(false);
      }
    }
  }
});

test('timing annotations cannot conceal substantive instructions', () => {
  for (const [which, index] of [['paired', 6], ['pairedRetry', 4]] as const) {
    for (const text of [' (human: Delete the CI gate)', ' (human: ~2 min / CC: Disable authentication)', ' (human: ~2 min / CC: ~1 min; repair the retry assertion)']) {
      const c = get(which, index); c.questions[0]!.options[0]!.description += text;
      expect(isCeoCompletionHandoff(fp(c))).toBe(false);
    }
  }
});
