import {describe,expect,test} from 'bun:test';
import {nativePlanCallFingerprint,planCountQuestionPhase,designStep0Boundary} from './helpers/claude-pty-runner';
import {isDesignCountFirstReview,isDesignCountSetup,isDesignCompletionHandoff} from './helpers/design-count-review';
import {isDesignArtifactGeneration} from './helpers/design-artifact-question';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import captured from './fixtures/design-primary-group-as-calls.json';

const calls=()=>structuredClone(captured.calls) as NativePlanQuestionCall[];
const first=()=>calls()[1]!;
const fp=(c:NativePlanQuestionCall)=>nativePlanCallFingerprint(c,0,true);
const reanswer=(c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:c.questions[0]!.options[0]!.label};return c;};
const accepted=(c:NativePlanQuestionCall)=>isDesignCountFirstReview(fp(c));

describe('Design primary action named by the Issue header',()=>{
  test('exact eight native calls retain the three setup questions in one call and the six issues plus TODO',()=>{
    const input=calls(), before=JSON.stringify(input);
    expect(input.map(c=>c.questions.length)).toEqual([3,1,1,1,1,1,1,1]);
    expect(input.flatMap(c=>c.questions)).toHaveLength(10);
    let started=false; const phases=input.map(call=>{
      const phase=planCountQuestionPhase(fp(call),started,designStep0Boundary,isDesignCountFirstReview,isDesignCountSetup,isDesignCompletionHandoff,isDesignArtifactGeneration);
      started=phase.reviewStarted;return phase;
    });
    expect(phases.map(p=>p.preReview)).toEqual([true,false,false,false,false,false,false,false]);
    expect(phases.filter(p=>p.administrative)).toHaveLength(0);
    expect(input.map(accepted)).toEqual([false,true,false,false,false,false,false,false]);
    expect(phases.filter(p=>!p.preReview)).toHaveLength(7);
    expect(phases.filter(p=>p.preReview)).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
  });
  test('finding annotations, control names, palette and option order do not supply or restrict identity',()=>{
    for(const annotation of [' (F1)',' (F27)','']){
      const c=first(),q=c.questions[0]!;
      q.question=q.question.replace(' (F1)',annotation);
      expect(accepted(reanswer(c))).toBe(true);
    }
    const c=JSON.parse(JSON.stringify(first()).replaceAll('Save','Publish').replaceAll('#1d4ed8','#123abc')) as NativePlanQuestionCall;
    const q=c.questions[0]!;
    q.header='Issue 8: Publish';
    q.question=q.question.replace('D4 — Issue 1 (F1)','D31 — Issue 8 (F12)').replace(/\b1([ABC])\b/g,'8$1');
    for(const o of q.options)o.label=o.label.replace(/^1/,'8');
    q.options.reverse();
    for(const o of q.options){c.answers={[q.question]:o.label};expect(accepted(c)).toBe(true);}
    q.options.reverse();q.options=q.options.filter(o=>!o.label.startsWith('8B:'));expect(accepted(reanswer(c))).toBe(true);
  });
  test('the separately completed retry retains its existing two setup and six review calls',()=>{
    const input=structuredClone(captured.retryCalls) as NativePlanQuestionCall[];
    let started=false;const phases=input.map(call=>{
      const phase=planCountQuestionPhase(fp(call),started,designStep0Boundary,isDesignCountFirstReview,isDesignCountSetup,isDesignCompletionHandoff,isDesignArtifactGeneration);
      started=phase.reviewStarted;return phase;
    });
    expect(input).toHaveLength(8);
    expect(phases.map(p=>p.preReview)).toEqual([true,true,false,false,false,false,false,false]);
    expect(phases.filter(p=>p.administrative)).toHaveLength(0);
  });
  test('primary and ghost controls, documented count, issue identity and offered choice identities remain bound',()=>{
    const changes:Array<(c:NativePlanQuestionCall)=>void>=[
      c=>{c.questions[0]!.header='Issue 1';},
      c=>{c.questions[0]!.header='Issue 1: Export';},
      c=>{c.questions[0]!.header='Issue 2: Save';},
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('other three','other two');},
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('Reset, Cancel and Export','Reset, Reset and Export');},
      c=>{c.questions[0]!.question=c.questions[0]!.question.replace('Reset, Cancel and Export','Reset, Save and Export');},
      c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('Reset, Cancel, Export','Reset, Cancel, Delete');},
      c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('Reset, Cancel, Export','Reset, Cancel, Save');},
      c=>{c.questions[0]!.options[0]!.description=c.questions[0]!.options[0]!.description!.replace('Reset, Cancel, Export','Reset, Cancel, Export, Export');},
      c=>{c.questions[0]!.options[2]!.label='1C: Keep all three identical';},
      c=>{c.questions[0]!.options[2]!.label='2C: Keep all four identical';},
    ];
    for(const change of changes){const c=first();change(c);expect(accepted(reanswer(c))).toBe(false);}
  });
  test('readiness, focus, navigation, source-only questions and naked F labels cannot begin review',()=>{
    for(const title of [
      'D4 — Issue 1 (F1): Ready to review the header action group?',
      'D4 — Issue 1 (F1): Which design source should the reviewer use?',
      'D4 — Issue 1 (F1): Fix the primary action?',
      'D4 — Issue 1 (F1): How should the header action group establish the primary action? Ready?',
      'Example: D4 — Issue 1 (F1): How should the header action group establish the primary action?',
      '> D4 — Issue 1 (F1): How should the header action group establish the primary action?',
    ]){const c=first(),q=c.questions[0]!;q.question=title+'\n'+q.question.split('\n').slice(1).join('\n');expect(accepted(reanswer(c))).toBe(false);}
    for(const header of ['Focus','Routing','Next steps','Outside voices']){const c=first();c.questions[0]!.header=header;expect(accepted(c)).toBe(false);}
    const c=first();c.questions[0]!.options=[{label:'Start the review'},{label:'Wait'}];expect(accepted(reanswer(c))).toBe(false);
  });
  test('current gap and contract cannot be replaced by quoted, historical or conditional material',()=>{
    for(const prefix of ['Historical example: ','Hypothetical example: ','Quoted assessment: ','Source example: ','If approved, ','When approved, ','Unless rejected, ','Assuming approval, ','Provided approval, ']){
      const c=first();c.questions[0]!.question=c.questions[0]!.question.replace('ELI10: ','ELI10: '+prefix);expect(accepted(reanswer(c))).toBe(false);
    }
    for(const transform of [(s:string)=>'"'+s+'"',(s:string)=>'> '+s,(s:string)=>'    '+s,(s:string)=>'```\n'+s+'\n```']){
      const c=first(),q=c.questions[0]!;q.question=q.question.split('\n').map(line=>line.startsWith('ELI10:')?transform(line):line).join('\n');expect(accepted(reanswer(c))).toBe(false);
    }
    for(const suffix of [' This finding is no longer current.',' This finding is "no longer current".',' This requirement is withdrawn.',' This contract is "withdrawn".',' This gap is now resolved.',' This issue is superseded.']){
      const c=first();c.questions[0]!.question+=suffix;expect(accepted(reanswer(c))).toBe(false);
    }
  });
  test('each offered amendment and deferral must remain current and unconditional',()=>{
    for(const index of [0,2])for(const prefix of ['Historical example: ','Source example: ','Assuming approval, ','Provided approval, ','✅ Assuming approval, ','✅ Provided approval, ']){
      const c=first(),o=c.questions[0]!.options[index]!;o.description=prefix+o.description;expect(accepted(reanswer(c))).toBe(false);
    }
    for(const index of [0,2])for(const suffix of [' This finding is no longer current.',' This amendment is "withdrawn".',' This deferral is rejected.',' This choice is superseded.',' This gap is closed.',' This contract is withdrawn.',' This requirement is "no longer current".',' Assuming approval, this is proposed only.',' Provided approval, this will become current.']){
      const c=first();c.questions[0]!.options[index]!.description+=suffix;expect(accepted(reanswer(c))).toBe(false);
    }
    for(const suffix of [' These tokens are withdrawn.',' These styles are "no longer current".',' Do not apply these tokens.']){
      const c=first();c.questions[0]!.options[0]!.description+=suffix;expect(accepted(reanswer(c))).toBe(false);
    }
    const c=first();c.questions[0]!.options[2]!.description+=' Do not keep all four buttons identical.';expect(accepted(reanswer(c))).toBe(false);
  });
  test('quoted past statuses do not erase the current finding, style or opposed choice',()=>{
    for(const target of [-1,0,2])for(const history of [' The prior review said "This finding is no longer current."'," The prior review said 'This finding is withdrawn.'",' The prior review said ‘This finding is no longer current.’',' The prior review said "Estimate (human: ~1h / CC: ~5min) This finding is no longer current."',' The prior review said `This finding is no longer current.`',' The earlier decision was `no longer current`.','\n> This amendment is withdrawn.']){
      const c=first();if(target<0)c.questions[0]!.question+=history;else c.questions[0]!.options[target]!.description+=history;
      expect(accepted(reanswer(c))).toBe(true);
    }
  });
  test('current status scalars retain their subjects across quote styles and semicolon boundaries',()=>{
    for(const target of [-1,0,2])for(const subject of ['finding','amendment','contract'])for(const status of ['withdrawn','no longer current'])for(const quote of ['',"'","‘",'"','“','`'])for(const boundary of [' ','; ']){
      const closing=quote==='‘'?'’':quote==='“'?'”':quote;
      const suffix=boundary+'This '+subject+' is '+quote+status+closing+'.';
      const c=first();if(target<0)c.questions[0]!.question+=suffix;else c.questions[0]!.options[target]!.description+=suffix;
      expect(accepted(reanswer(c))).toBe(false);
    }
  });
  test('completed native ownership, answer membership, one question and exact option indices are required',()=>{
    const changes:Array<(c:NativePlanQuestionCall)=>void>=[
      c=>{c.answered=false;},c=>{delete (c as Partial<NativePlanQuestionCall>).answered;},
      c=>{c.failed=true;},c=>{delete c.failed;},c=>{c.sessionId='';},c=>{c.toolUseId='';},
      c=>{c.answers={};},c=>{c.answers={[c.questions[0]!.question]:'not offered'};},
      c=>{delete c.answeredAt;},c=>{c.answeredAt='invalid';},c=>{delete c.unansweredQuestionIndices;},c=>{c.unansweredQuestionIndices=[0];},
      c=>{c.questions[0]!.multiSelect=true;},c=>{c.questions.push(structuredClone(c.questions[0]!));},
      c=>{c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!));},
    ];
    for(const change of changes){const c=first();change(c);expect(accepted(c)).toBe(false);}
    for(const mutate of [
      (f:ReturnType<typeof fp>)=>{f.signature='foreign';},
      (f:ReturnType<typeof fp>)=>{f.nativeQuestionIndex=1;},
      (f:ReturnType<typeof fp>)=>{f.options=[];},
      (f:ReturnType<typeof fp>)=>{f.options[0]!.index=2;},
      (f:ReturnType<typeof fp>)=>{f.options[0]!.label='unrelated';},
    ]){const f=fp(first());mutate(f);expect(isDesignCountFirstReview(f)).toBe(false);}
  });
});
