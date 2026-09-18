import {expect, test} from 'bun:test';
import fixture from './fixtures/devex-reconfirmation-ad-v2.json';
import {isDevexReviewIssue} from './helpers/devex-count-fixture';
import {nativePlanCallFingerprint} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
const calls = () => structuredClone(fixture.calls) as NativePlanQuestionCall[];
const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, true);
const classify = (c: NativePlanQuestionCall, history?: readonly NativePlanQuestionCall[]) => isDevexReviewIssue(fp(c), history);
const answer = (c: NativePlanQuestionCall) => {c.answers = {[c.questions[0]!.question]:c.questions[0]!.options[0]!.label}; return c;};

test('completed roleplay reconfirmation adds no eighth issue after the five actual approvals', () => {
  const all = calls();
  expect(classify(all[9]!, all.slice(0, 9))).toBe(false);
  expect(all.filter((c,i) => classify(c, all.slice(0,i)))).toHaveLength(7);
  expect(fixture.provenance.actualOutcome).toBe('ceiling_reached');
  expect(fixture.provenance.noRetroactivePass).toBe(true);
});

test('the five original issues plus later measurement and TODO decisions remain substantive', () => {
  const all = calls();
  for (const i of [4,5,6,7,8,11,12]) expect(classify(all[i]!, all.slice(0,i))).toBe(true);
});

test('recap text alone cannot stand in for earlier completed same-session approvals', () => {
  const all = calls(), recap = all[9]!;
  expect(classify(recap)).toBe(true);
  expect(classify(recap, [])).toBe(true);
  for (const mutation of [
    (h: NativePlanQuestionCall[]) => h.splice(4,1),
    (h: NativePlanQuestionCall[]) => {h[4]!.sessionId='foreign';},
    (h: NativePlanQuestionCall[]) => {h[4]!.answered=false;},
    (h: NativePlanQuestionCall[]) => {h[4]!.failed=true;},
    (h: NativePlanQuestionCall[]) => {h[4]!.unansweredQuestionIndices=[0];},
    (h: NativePlanQuestionCall[]) => {h[4]!.answers={[h[4]!.questions[0]!.question]:h[4]!.questions[0]!.options.at(-1)!.label};},
    (h: NativePlanQuestionCall[]) => {h[4]!.answeredAt=recap.answeredAt;},
    (h: NativePlanQuestionCall[]) => {h[4]!.answeredAt='invalid';},
  ]) {const h=all.slice(0,9).map(c=>structuredClone(c));mutation(h);expect(classify(recap,h)).toBe(true);}
});

test('a new repair in the recap or selected choice remains a substantive decision', () => {
  for (const text of ['Add a new credential wizard.', 'Disable authentication.', 'Repair the retry assertion.', 'The plan must add a new endpoint.']) {
    for (const place of ['tail','inside-body','selected-description','selected-label'] as const) {
      const all=calls(), c=all[9]!, q=c.questions[0]!;
      if(place==='tail') q.question+='\n'+text;
      if(place==='inside-body') q.question=q.question.replace('\nELI10:', '\n'+text+'\nELI10:');
      if(place==='selected-description') q.options[0]!.description+=' '+text;
      if(place==='selected-label') q.options[0]!.label+=' '+text;
      expect(classify(answer(c),all.slice(0,9))).toBe(true);
    }
  }
});

test('accuracy source, recap, and new measurement each keep distinct attribution', () => {
  const all=calls();
  expect(classify(all[3]!,all.slice(0,3))).toBe(false);
  expect(classify(all[9]!,all.slice(0,9))).toBe(false);
  expect(classify(all[11]!,all.slice(0,11))).toBe(true);
  expect(classify(all[12]!,all.slice(0,12))).toBe(true);
  expect(all.map((c,i)=>classify(c,all.slice(0,i)))).toEqual([
    false,false,false,false,true,true,true,true,true,false,false,true,true,
  ]);
});

test('accuracy explanations or choices cannot authorize an additional repair', () => {
  for(const text of ['Add a new credential wizard.','Disable authentication.','Repair the retry assertion.']) {
    for(const place of ['tail','outside-quote','description','label'] as const) {
      const all=calls(),c=all[3]!,q=c.questions[0]!;
      if(place==='tail')q.question+='\n'+text;
      if(place==='outside-quote')q.question=q.question.replace('\n\nELI10:', '\n\n'+text+'\n\nELI10:');
      if(place==='description')q.options[0]!.description+=' '+text;
      if(place==='label')q.options[0]!.label+=' '+text;
      expect(classify(answer(c),all.slice(0,3))).toBe(true);
    }
  }
});

test('missing measurement must be an actual completed decision about a new release gate', () => {
  for(const mutate of [
    (c:NativePlanQuestionCall)=>{c.questions[0]!.question='Example: '+c.questions[0]!.question;answer(c);},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.question=c.questions[0]!.question.replace('never re-measured','already re-measured');answer(c);},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.question=c.questions[0]!.question.replace('Nothing in the plan re-runs','The existing plan already re-runs');answer(c);},
    (c:NativePlanQuestionCall)=>{c.answered=false;},
    (c:NativePlanQuestionCall)=>{c.failed=true;},
    (c:NativePlanQuestionCall)=>{c.unansweredQuestionIndices=[0];},
    (c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'unoffered'};},
    (c:NativePlanQuestionCall)=>{c.questions[0]!.multiSelect=true;},
  ]) {const c=calls()[11]!;mutate(c);expect(classify(c)).toBe(false);}
});

test('history identities cannot be replaced by similarly labelled unapproved evidence', () => {
  for(const mutate of [
    (h:NativePlanQuestionCall[])=>{h[4]!.questions[0]!.question=h[4]!.questions[0]!.question.replace('D4','D40');answer(h[4]!);},
    (h:NativePlanQuestionCall[])=>{h[4]!.questions[0]!.multiSelect=true;},
    (h:NativePlanQuestionCall[])=>{h[4]!.answers={[h[4]!.questions[0]!.question]:'Fix in plan: unoffered new action'};},
    (h:NativePlanQuestionCall[])=>{h.push(structuredClone(h[4]!));},
  ]) {const all=calls(),h=all.slice(0,9);mutate(h);expect(classify(all[9]!,h)).toBe(true);}
  const all=calls();
  expect(isDevexReviewIssue({...fp(all[9]!),signature:'foreign:call'},all.slice(0,9))).toBe(true);
});

test('the same subject with a different approved change cannot establish the recapped repair', () => {
  const cases = [
    (c: NativePlanQuestionCall) => {
      c.questions[0]!.question = 'D4 — Add debug logging to examples/first_eval.py?';
      c.questions[0]!.options[0] = {label:'Fix in plan: add debug logging',description:'Add diagnostics without changing which files ship.'};
    },
    (c: NativePlanQuestionCall) => {
      c.questions[0]!.options[0] = {label:'Fix in plan: document the missing example without shipping it',description:'Document the absent file; do not ship or replace it.'};
    },
  ];
  for (const change of cases) {
    const all = calls(); change(all[4]!); answer(all[4]!);
    expect(classify(all[9]!, all.slice(0,9))).toBe(true);
  }
  for (let i=4; i<=8; i++) {
    const all = calls();
    all[i]!.questions[0]!.options[0]!.description = 'Document the existing behavior; leave the runtime and published contracts unchanged.';
    answer(all[i]!);
    expect(classify(all[9]!,all.slice(0,9))).toBe(true);
    const more = calls();
    more[i]!.questions[0]!.options[0]!.description += ' Also disable authentication.';
    answer(more[i]!);
    expect(classify(more[9]!,more.slice(0,9))).toBe(true);
  }
});

import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
test('DX native evidence and history integration select its paid workflow',()=>{
  for(const file of ['test/devex-reconfirmation-ad-v2.test.ts','test/fixtures/devex-reconfirmation-ad-v2.json','test/plan-count-history.test.ts'])
    expect(selectTests([file],E2E_TOUCHFILES).selected).toContain('plan-devex-finding-count');
});
