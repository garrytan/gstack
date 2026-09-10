import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import { classifyVisible } from './helpers/claude-pty-runner';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir,'fixtures/native-auto-decide-ag.json'),'utf8'));
const clone = (i=0) => structuredClone(captured.attempts[i]);
const verdict = (f=clone()) => findNativeAutoDecision(f.transcript,f.tools,f.options);
const ownedMessage = (f:any) => f.transcript.assistantMessages.find((m:any)=>m.sessionId===f.options.sessionId&&m.text.includes('Auto-decided'));
const literal = 'Auto-decided review mode → **HOLD SCOPE** (your preference). Change with /plan-tune.';

test('both exact native attempts preserve the asserted preference annotation despite terminal damage',()=>{
  for(const [i,attempt] of captured.attempts.entries()){
    const actual=verdict(attempt);expect(actual).not.toBeNull();expect(actual!.sessionId).toBe(attempt.options.sessionId);
    expect(actual!.option).toBe('HOLD SCOPE');expect(actual!.annotation).toContain('(your preference). Change with /plan-tune.');
    expect(ownedMessage(attempt).text).toContain(actual!.annotation);
    if(i===1)expect(attempt.transcript.assistantMessages.some((m:any)=>m.sessionId!==attempt.options.sessionId&&m.text.includes('Auto-decided'))).toBe(true);
  }
  expect(classifyVisible('Auto-dcided review mode: HOLD SCOPE. DONE.')).toBeNull();
});

test('native annotation needs one successful post-command load in the owned session',()=>{
  const mutations:Array<(f:any)=>void>=[
    f=>{f.transcript.status='missing';},f=>{f.transcript.status='error';},f=>{f.options.sessionId='foreign';},
    f=>{f.options.commandStartedAt=f.options.now;},f=>{f.options.commandStartedAt=NaN;},f=>{f.options.now=Infinity;},
    f=>{f.options.now=f.options.commandStartedAt-1;},f=>{f.options.skillName='other-skill';},
    f=>{const use=f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill');use.name='Read';},
    f=>{const use=f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill');f.tools.push({...use});},
    f=>{const use=f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill');f.tools=f.tools.filter((e:any)=>e.kind!=='result'||e.toolUseId!==use.toolUseId);},
    f=>{const use=f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill');f.tools.find((e:any)=>e.kind==='result'&&e.toolUseId===use.toolUseId).isError=true;},
    f=>{const use=f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill');const result=f.tools.find((e:any)=>e.kind==='result'&&e.toolUseId===use.toolUseId);f.tools.push({...result});},
    f=>{const use=f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill');f.tools.find((e:any)=>e.kind==='result'&&e.toolUseId===use.toolUseId).timestamp=new Date(f.options.commandStartedAt-1).toISOString();},
    f=>{ownedMessage(f).timestamp='invalid';},f=>{ownedMessage(f).timestamp=new Date(f.options.now+1).toISOString();},
    f=>{ownedMessage(f).timestamp=new Date(f.options.commandStartedAt-1).toISOString();},
    f=>{f.transcript.calls.push({sessionId:f.options.sessionId,toolUseId:'asked',questions:[{header:'Mode',question:'Choose mode?',options:[{label:'A'},{label:'B'}]}],answered:false});},
  ];
  for(const mutate of mutations){const f=clone();mutate(f);expect(verdict(f)).toBeNull();}
  const f=clone();f.tools.find((e:any)=>e.kind==='use'&&e.name==='Skill').input.skill='gstack:plan-ceo-review';expect(verdict(f)).not.toBeNull();
});

test('quotes, source introductions, conditions and incomplete template prose are not annotations',()=>{
  for(const text of [
    `> ${literal}`,`    ${literal}`,`\t${literal}`,`"${literal}"`,`\`\`\`text\n${literal}\n\`\`\``,
    `Example:\n\n${literal}`,`An unproven hypothesis.\n\n${literal}`,`Previous transcript:\n\n${literal}`,
    `If approved, ${literal}`,literal.replace('(your preference)','(if you approve)'),literal.replace('Auto-decided','Auto-dcided'),
    literal.replace('Change with /plan-tune.',''),`**Review mode: EXPANSION.**\n\n${literal}`,
    `Example:\n\n**Review mode: HOLD SCOPE.**\n\n${literal}`,
    'Auto-decided <summary> → <option> (your preference). Change with /plan-tune.',
    'Auto-decided review mode → <selected option> (your preference). Change with /plan-tune.',
    `**Review mode: HOLD SCOPE.**\n\n    ${literal}`,`**Review mode: HOLD SCOPE.**\n\n\t${literal}`,
  ]){const f=clone();ownedMessage(f).text=text;expect(verdict(f),text).toBeNull();}
  const f=clone(1);ownedMessage(f).text=ownedMessage(f).text.replace('Heads-up from gstack: this branch has unshipped work.', 'Heads-up from gstack: the following is a hypothetical example.');expect(verdict(f)).toBeNull();
});

test('same-session current retractions override an earlier annotation without borrowing quoted examples',()=>{
  for(const text of [
    'Correction: I withdraw this auto-decision.',
    'The annotation is only an example.',
    'This decision is withdrawn.',
    'Correction: "I retract this decision."',
    'I did not auto-decide the review mode.',
    'Correction: that statement was only an example.',
    'I did not make this choice.',
    '**Review mode: SCOPE EXPANSION.**',
  ]){
    const f=clone();ownedMessage(f).text+='\n\n'+text;expect(verdict(f),text).toBeNull();
    const g=clone();g.options.now++;g.transcript.assistantMessages.push({sessionId:g.options.sessionId,timestamp:new Date(g.options.now).toISOString(),text});expect(verdict(g),text).toBeNull();
  }
  for(const text of ['> I withdraw this decision.','Quoted example: "I withdraw this decision."','```text\nI withdraw this decision.\n```','Example: "I did not make this choice."','Example: "that statement was only an example."']){
    const f=clone();ownedMessage(f).text+='\n\n'+text;expect(verdict(f),text).not.toBeNull();
  }
  const f=clone();f.transcript.assistantMessages.push({sessionId:'foreign',timestamp:new Date(f.options.now).toISOString(),text:'I withdraw this decision.'});expect(verdict(f)).not.toBeNull();
});

test('the native reader cannot promote foreign cwd, child, user or tool-result text to an annotation',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auto-native-'));
  try {
    const config=path.join(dir,'config'),journals=path.join(config,'projects','fixture');fs.mkdirSync(journals,{recursive:true});
    const start=Date.now()-100,session='owned';
    const make=()=>[
      {type:'assistant',isSidechain:false,cwd:dir,sessionId:session,timestamp:new Date(start+1).toISOString(),message:{role:'assistant',content:[{type:'tool_use',id:'load',name:'Skill',input:{skill:'plan-ceo-review'}}]}},
      {type:'user',isSidechain:false,cwd:dir,sessionId:session,timestamp:new Date(start+2).toISOString(),message:{role:'user',content:[{type:'tool_result',tool_use_id:'load',content:'loaded',is_error:false}]}},
      {type:'assistant',isSidechain:false,cwd:dir,sessionId:session,timestamp:new Date(start+3).toISOString(),message:{role:'assistant',content:[{type:'text',text:literal}]}},
    ];
    const cases:Array<[(rows:any[])=>void,boolean]>=[
      [()=>{},true],[rows=>{for(const r of rows)r.cwd=dir+'-foreign';},false],
      [rows=>{rows[2].isSidechain=true;},false],[rows=>{rows[2].message.role='user';},false],
      [rows=>{rows[2].message.content=[{type:'tool_result',tool_use_id:'other',content:literal}];},false],
    ];
    for(const [mutate,expected]of cases){const rows=make();mutate(rows);fs.writeFileSync(path.join(journals,session+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
      const tools:NativePublicToolEvent[]=[];const transcript=readPlanCountTranscript(config,dir,e=>tools.push(e));
      expect(Boolean(findNativeAutoDecision(transcript,tools,{sessionId:session,skillName:'plan-ceo-review',commandStartedAt:start,now:Date.now()}))).toBe(expected);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('new native annotation dependencies retain all existing observation caller owners',()=>{
  const expected=['plan-ceo-review-plan-mode','plan-eng-review-plan-mode','plan-design-review-plan-mode','plan-devex-review-plan-mode','plan-mode-no-op','auto-decide-preserved','conductor-prose'];
  for(const file of ['test/helpers/native-auto-decide.ts','test/native-auto-decide.test.ts','test/native-auto-decide-pty.test.ts','test/fixtures/native-auto-decide-ag.json']){
    const owners=Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(file)).map(([name])=>name);expect(owners).toEqual(expected);
    expect(selectTests([file],E2E_TOUCHFILES).selected).toContain('auto-decide-preserved');
  }
});
