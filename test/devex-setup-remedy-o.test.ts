import { describe, expect, test } from 'bun:test';
import captured from './fixtures/devex-review-o-retry-calls.json';
import { isDevexReviewIssue } from './helpers/devex-count-fixture';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const calls=()=>structuredClone(captured.calls) as NativePlanQuestionCall[];
const evaluate=(call:NativePlanQuestionCall)=>isDevexReviewIssue(nativePlanCallFingerprint(call,0,true));
const selected=(call:NativePlanQuestionCall,label:string)=>{call.answers={[call.questions[0]!.question]:label};};

describe('actual repair choices remain substantive within DX setup families',()=>{
  test('all thirteen retry calls retain five setup, seven substantive and one handoff',()=>{
    const original=calls();
    expect(original.map(evaluate)).toEqual([false,false,false,true,true,true,true,true,true,false,false,true,false]);
    expect(original).toEqual(calls());
    expect(original[3]!.questions[0]!.header).toBe('TTHW target');
    expect(original[4]!.questions[0]!.header).toBe('Magical moment');
    expect(original[9]!.questions[0]!.header).toBe('Confusion report');
  });

  test('selected CI bypass and new progress feedback are actual offered repairs',()=>{
    for(const index of [3,4]){
      const call=calls()[index]!;
      for(const preReview of [true,false]){
        const fp=nativePlanCallFingerprint(call,0,preReview);fp.promptSnippet='Short display hint';
        expect(isDevexReviewIssue(fp)).toBe(true);
      }
      expect(call.answers![call.questions[0]!.question]).toContain('add skip flag');
    }
  });

  test('pure confirmations, unselected repairs and unrelated premises remain setup',()=>{
    for(const index of [3,4])for(const mutate of [
      (call:NativePlanQuestionCall)=>{const q=call.questions[0]!;q.options.unshift({label:'Confirm the already agreed target and vehicle'});selected(call,q.options[0]!.label);},
      (call:NativePlanQuestionCall)=>{const q=call.questions[0]!;q.options[0]!.label=q.options[0]!.label.replace(/add skip flag[^()]*/i,'keep the already approved behavior ');selected(call,q.options[0]!.label);},
      (call:NativePlanQuestionCall)=>{const q=call.questions[0]!;q.question='Confirm the settled benchmark and delivery vehicle. <gstack-qid:'+ (index===3?'plan-devex-review-tthw-tier':'plan-devex-review-magical-moment') +'>';selected(call,q.options[0]!.label);},
      (call:NativePlanQuestionCall)=>{const q=call.questions[0]!;q.question=q.question.replace(/<gstack-qid:[^>]+>/,'<gstack-qid:plan-devex-review-persona>');selected(call,q.options[0]!.label);},
    ]) {const call=calls()[index]!;mutate(call);expect(evaluate(call)).toBe(false);}
  });

  test('native answer and exact offered choice are mandatory for repair precedence',()=>{
    for(const index of [3,4])for(const mutate of [
      (call:NativePlanQuestionCall)=>{call.answered=false;},
      (call:NativePlanQuestionCall)=>{call.failed=true;},
      (call:NativePlanQuestionCall)=>{call.answers={};},
      (call:NativePlanQuestionCall)=>{selected(call,'Invented remedy');},
      (call:NativePlanQuestionCall)=>{call.unansweredQuestionIndices=[0];},
      (call:NativePlanQuestionCall)=>{call.questions[0]!.options.push({...call.questions[0]!.options[0]!});},
    ]) {const call=calls()[index]!;mutate(call);expect(evaluate(call)).toBe(false);}
    for(const index of [3,4]) {
      const fp=nativePlanCallFingerprint(calls()[index]!,0,true);
      expect(isDevexReviewIssue({...fp,signature:'foreign:native-call'})).toBe(false);
      expect(isDevexReviewIssue({...fp,nativeCall:undefined,promptSnippet:'Confirm the already agreed target and vehicle'})).toBe(false);
    }
  });

  test('captured setup-repair boundaries stay in the paid dependency family',()=>{
    for(const file of ['test/devex-setup-remedy-o.test.ts','test/fixtures/devex-review-o-retry-calls.json'])
      expect(E2E_TOUCHFILES['plan-devex-finding-count']).toContain(file);
  });
});
