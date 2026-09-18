import {describe,expect,test} from 'bun:test';
import {ceoExpansionPacingChoice,ceoExpansionPacingReady} from './helpers/ceo-mode-option';
import captured from './fixtures/ceo-expansion-pacing-fb10.json';
function state(){return structuredClone(captured);}
function choose(e=state(),screen=e.viewport){return ceoExpansionPacingChoice(screen,e.transcript as any,e.selectionStartedAt,e.pendingQuestion as any);}
describe('native complete-candidate pacing',()=>{
 test('the exact first pending menu is a full walkthrough, with no scope disposition',()=>{
  const e=state();expect(e.transcript.calls).toHaveLength(2);expect(e.pendingQuestion.answered).toBe(false);
  const c=choose(e);expect(c?.index).toBe(1);
  expect(ceoExpansionPacingReady('next screen',e.transcript as any,c!,[])).toBe(false);
 });
});

function pane(e:ReturnType<typeof state>){const q=e.pendingQuestion.questions[0]!;return ['☐ '+q.header,q.question,...q.options.map((o,i)=>`${i?' ':'❯'} ${i+1}. ${o.label}`),'4. Type something.','5. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');}
type Question=ReturnType<typeof state>['pendingQuestion']['questions'][number];
const positive:Record<string,(q:Question)=>void>={
 'native labels may carry selectors':q=>{q.options.forEach((o,i)=>{o.label=String.fromCharCode(65+i)+') '+o.label;});},
 'native option order supplies the actual key':q=>{q.options.reverse();},
 'numeric counts bind the same inventory':q=>{q.question=q.question.replaceAll('Nine','9').replaceAll('nine','9');q.options[0]!.description=q.options[0]!.description.replaceAll('Nine','9');},
 'mixed count presentation':q=>{q.question=q.question.replace('Nine expansion','9 expansion');},
 'different chain identity':q=>{q.question=q.question.replace('D4.0','D12.0');q.options[0]!.description=q.options[0]!.description.replaceAll('D4.','D12.');},
 'different inventory prefix':q=>{q.question=q.question.replace(/\bE(?=\d)/g,'P');},
 'inventory belongs to the explanation too':q=>{const list=/\(E1[^\n]+?E9 picker polish bundle\)/.exec(q.question)![0];q.question=q.question.replace(' '+list,'').replace('ELI10:','ELI10: Nine expansion proposals are pending '+list+'.');},
 'complete walkthrough label':q=>{q.options[0]!.label='Complete walkthrough, one per item (recommended)';},
 'procedural Hold pauses without disposing any item':q=>{q.options[0]!.description=q.options[0]!.description.replace('Hold on any item stops the chain so we can discuss before continuing','Hold pauses this chain for discussion before proceeding.');},
 'rationale counts the separate final prompt':q=>{q.question=q.question.replace('nine short prompts','ten short prompts including a final confirmation');},
 'description counts the separate final prompt':q=>{q.options[0]!.description=q.options[0]!.description.replace('Nine prompts','Ten prompts including a final confirmation');},
 'another complete count':q=>{q.question=q.question.replaceAll('Nine','Eight').replaceAll('nine','eight').replace(', E9 picker polish bundle','');q.options[0]!.description=q.options[0]!.description.replaceAll('Nine','Eight').replace('D4.9','D4.8');},
};
for(const [name,change]of Object.entries(positive))test(name,()=>{const e=state();change(e.pendingQuestion.questions[0]!);expect(choose(e,pane(e))?.index).toBe(name==='native option order supplies the actual key'?3:1);});
const negative:Record<string,(q:Question)=>void>={
 'missing candidate':q=>{q.question=q.question.replace(', E9 picker polish bundle','');},
 'duplicate candidate':q=>{q.question=q.question.replace('E9 picker','E8 picker');},
 'foreign inventory prefix':q=>{q.question=q.question.replace('E9 picker','P9 picker');},
 'wrong declared count':q=>{q.question=q.question.replace('Nine expansion','Eight expansion');},
 'wrong rationale count':q=>{q.question=q.question.replace('nine short prompts','eight short prompts');},
 'extra rationale prompt with no final':q=>{q.question=q.question.replace('nine short prompts','ten short prompts');},
 'extra rationale item question despite final':q=>{q.question=q.question.replace('nine short prompts','ten short questions plus a final confirmation');},
 'too few total prompts including final':q=>{q.question=q.question.replace('nine short prompts','eight short prompts including a final confirmation');},
 'quoted final does not authenticate an extra prompt':q=>{q.question=q.question.replace('nine short prompts','ten short prompts including a “final confirmation”');},
 'absent final cannot explain a tenth prompt':q=>{q.options[0]!.description=q.options[0]!.description.replace(', then D4.final to confirm the assembled scope','').replace('Nine prompts','Ten prompts')+' No final confirmation.';},
 'negated rationale final cannot explain a tenth prompt':q=>{q.question=q.question.replace('nine short prompts','ten short prompts, no final confirmation');},
 'withdrawn final cannot explain a tenth prompt':q=>{q.options[0]!.description=q.options[0]!.description.replace('Nine prompts','Ten prompts including a final confirmation')+' The final confirmation is withdrawn.';},
 'cancelled rationale final cannot explain a tenth prompt':q=>{q.question=q.question.replace('nine short prompts','ten short prompts including a final confirmation, but the final confirmation is cancelled');},
 'historical final cannot explain a tenth prompt':q=>{q.options[0]!.description=q.options[0]!.description.replace('Nine prompts','Ten prompts')+' Previously, ten prompts including a final confirmation.';},
 'conditional final cannot explain a tenth prompt':q=>{q.options[0]!.description=q.options[0]!.description.replace('Nine prompts','Ten prompts')+' If requested, then a final confirmation.';},
 'wrong chosen count':q=>{q.options[0]!.description=q.options[0]!.description.replace('Nine prompts','Eight prompts');},
 'larger composite count':q=>{q.question=q.question.replace('Nine expansion','Twenty-nine expansion');},
 'short range':q=>{q.options[0]!.description=q.options[0]!.description.replace('D4.9','D4.8');},
 'late range start':q=>{q.options[0]!.description=q.options[0]!.description.replace('D4.1','D4.2');},
 'foreign chain':q=>{q.options[0]!.description=q.options[0]!.description.replaceAll('D4.','D5.');},
 'extra sequence endpoint':q=>{q.options[0]!.description+=' Then D5.1.';},
 'missing per-item choice':q=>{q.options[0]!.label='Full split (recommended)';},
 'quoted inventory':q=>{q.question=q.question.replace('Nine expansion proposals are pending (','“Nine expansion proposals are pending (').replace('E9 picker polish bundle).','E9 picker polish bundle).”');},
 'historical inventory':q=>{q.question=q.question.replace('Nine expansion','Previously, nine expansion');},
 'conditional inventory':q=>{q.question=q.question.replace('Nine expansion','If nine expansion');},
 'quoted selected mapping':q=>{q.options[0]!.description='“'+q.options[0]!.description+'”';},
 'fenced selected mapping':q=>{q.options[0]!.description='```\n'+q.options[0]!.description+'\n```';},
 'historical selected mapping':q=>{q.options[0]!.description='Previously, '+q.options[0]!.description;},
 'conditional selected mapping':q=>{q.options[0]!.description='If approved, '+q.options[0]!.description;},
 'negated selected mapping':q=>{q.options[0]!.label='Not a full split, one per item';},
 'scope approved by the question':q=>{q.question=q.question.replace('ELI10:','ELI10: This answer approves all proposals.');},
 'scope disposition hidden in inventory':q=>{q.question=q.question.replace('E9 picker polish bundle','E9 picker polish bundle (approved)');},
 'scope approved by the option':q=>{q.options[0]!.description+=' Approve E1 now.';},
 'omission after complete sequence':q=>{q.options[0]!.description+=' Except E9.';},
 'grouping after complete sequence':q=>{q.options[0]!.description+=' Batch E1 and E2 together.';},
 'stop after an incomplete sequence':q=>{q.options[0]!.description+=' Stop after four questions.';},
 'Hold omits instead of pausing':q=>{q.options[0]!.description=q.options[0]!.description.replace('so we can discuss before continuing','and drops the remaining proposals');},
 'Hold pause conceals an extra grant':q=>{q.options[0]!.description=q.options[0]!.description.replace('before continuing','before continuing and approve E1');},
 'Hold belongs to another chain':q=>{q.options[0]!.description=q.options[0]!.description.replace('stops the chain','stops another chain');},
 'Hold already happened':q=>{q.options[0]!.description=q.options[0]!.description.replace('Hold on any item stops','Previously Hold on any item stopped');},
 'conditional Hold pause':q=>{q.options[0]!.description=q.options[0]!.description.replace('Hold on any item stops','If approved, Hold on any item stops');},
 'a quoted pause cannot remove a stop veto':q=>{q.options[0]!.description=q.options[0]!.description.replace('Hold on any item stops the chain so we can discuss before continuing','“Hold on any item stops the chain so we can discuss before continuing”');},
 'unconditional grant in unchosen option':q=>{q.options[1]!.description+=' Regardless of choice, approve E1 now.';},
 'cross-option complete sequence':q=>{q.options[1]!.description=q.options[0]!.description;q.options[0]!.description='Review the proposals.';},
 'duplicate complete choice':q=>{q.options[1]=structuredClone(q.options[0]!);},
 'second decision':q=>{q.question=q.question.replace('ELI10:','ELI10: Should every proposal ship?');},
 'missing brief field':q=>{q.question=q.question.replace('ELI10:','Explanation:');},
 'multi-select':q=>{q.multiSelect=true;},
};
for(const [name,change]of Object.entries(negative))test(name,()=>{const e=state();change(e.pendingQuestion.questions[0]!);expect(choose(e,pane(e))?.index).not.toBe(1);});
test.each(['foreign session','unanswered mode','wrong mode','answered pacing','multiple pending calls','changed viewport'])('%s cannot borrow the native invitation',kind=>{
 const e=state();
 if(kind==='foreign session')e.pendingQuestion.sessionId='foreign';
 if(kind==='unanswered mode')e.transcript.calls[1]!.answered=false;
 if(kind==='wrong mode')e.transcript.calls[1]!.answers={[e.transcript.calls[1]!.questions[0]!.question]:'HOLD SCOPE'} as any;
 if(kind==='answered pacing')e.pendingQuestion.answered=true;
 if(kind==='multiple pending calls')e.transcript.calls.push({...e.pendingQuestion,toolUseId:'other'} as any,{...e.pendingQuestion,toolUseId:'another'} as any);
 const screen=kind==='changed viewport'?e.viewport.replace('Full split, one per item','Approve everything'):e.viewport;
 expect(choose(e,screen)?.index).not.toBe(1);
});
