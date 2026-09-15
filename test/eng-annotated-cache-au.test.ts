import {expect,test} from 'bun:test';
import captured from './fixtures/eng-annotated-cache-au.json';
import {engFirstReviewAUQ,engSetupAUQ,engStep0Boundary,nativePlanCallFingerprint,planCountQuestionPhase} from './helpers/claude-pty-runner';
import type {NativePlanQuestionCall} from './helpers/plan-count-transcript';
import {E2E_TOUCHFILES} from './helpers/touchfiles-data';
const fresh=()=>structuredClone(captured.call) as NativePlanQuestionCall;
const fp=(c=fresh())=>nativePlanCallFingerprint(c,Date.parse(c.answeredAt!),true);
const first=(c=fresh())=>engFirstReviewAUQ(fp(c));
function change(edit:(q:NativePlanQuestionCall['questions'][number])=>void){const c=fresh(),q=c.questions[0]!,picked=q.options.findIndex(o=>o.label===c.answers[q.question]);edit(q);c.answers={[q.question]:q.options[picked]!.label};return c;}
test('exact acknowledged annotated cache finding opens review without changing native ownership',()=>{
 const c=fresh(),before=JSON.stringify(c);expect(first(c)).toBe(true);expect(engSetupAUQ(fp(c))).toBe(false);expect(planCountQuestionPhase(fp(c),false,engStep0Boundary,engFirstReviewAUQ,engSetupAUQ)).toMatchObject({preReview:false,reviewStarted:true});expect(JSON.stringify(c)).toBe(before);expect(captured.provenance.retrospectivePass).toBe(false);
});
test('incidental metadata and all offered choices retain substantive review identity',()=>{
 for(const edit of [
  (q:any)=>{q.question=q.question.replace('D5 — Issue 1','D15 — Issue 11');q.header='Arch 11';},
  (q:any)=>{q.question=q.question.replace('PLAN.md:19-20 + :10','docs/plan.md:42');},
  (q:any)=>{q.question=q.question.replace('[P1] (confidence 8/10)','[P2] (confidence 10/10)');},
  (q:any)=>{q.question=q.question.replaceAll('AuthCache','TenantStore').replaceAll('SessionMint','SessionWriter').replaceAll('AuthBroker','AuthReader');q.options=q.options.map((o:any)=>({...o,description:o.description.replaceAll('AuthCache','TenantStore').replaceAll('SessionMint','SessionWriter').replaceAll('AuthBroker','AuthReader')}));},
  (q:any)=>{q.question+='\n"Historical note: This finding is withdrawn."';},
  (q:any)=>{q.options[0].description+='\n"This option is withdrawn."';},
 ])expect(first(change(edit))).toBe(true);
 for(const reversed of [false,true])for(let i=0;i<3;i++){const c=fresh(),q=c.questions[0]!;if(reversed)q.options.reverse();c.answers={[q.question]:q.options[i]!.label};expect(first(c)).toBe(true);}
});
const changes:Array<[string,(q:NativePlanQuestionCall['questions'][number])=>void]>=[
 ['foreign issue header',q=>{q.header='Arch 2';}],['missing issue',q=>{q.question=q.question.replace('Issue 1 ','');}],['missing annotation',q=>{q.question=q.question.replace('[P1] (confidence 8/10) ','');}],['missing source location',q=>{q.question=q.question.replace('PLAN.md:19-20 + :10 — ','');}],['invalid confidence',q=>{q.question=q.question.replace('confidence 8/10','confidence 11/10');}],
 ['conditional defect',q=>{q.question=q.question.replace('both mutate','might both mutate');}],['same actor twice',q=>{q.question=q.question.replace('AuthBroker and SessionMint','AuthBroker and AuthBroker');}],['serialized title',q=>{q.question=q.question.replace('does not serialize mutations','serializes mutations');}],
 ['source title',q=>{q.question='Source: '+q.question;}],['quoted title',q=>{const lines=q.question.split('\n');lines[0]='"'+lines[0]+'"';q.question=lines.join('\n');}],['source context',q=>{q.question=q.question.replace('Project/branch/task:','Source:');}],['historical context',q=>{q.question=q.question.replace('Project/branch/task:','Project/branch/task: Historical assessment:');}],
 ['no own explanation',q=>{q.question=q.question.replace(/^ELI10:.*$/m,'');}],['quoted explanation',q=>{q.question=q.question.replace(/^ELI10: (.*)$/m,'ELI10: "$1"');}],['competing explanation',q=>{q.question+='\nELI10: There is no race.';}],['hypothetical explanation',q=>{q.question=q.question.replace('ELI10:','ELI10: If approved,');}],['missing race consequence',q=>{q.question=q.question.replace('the mint can land after the invalidation and a suspended tenant keeps a live session','the tenant always loses the session');}],
 ['repair wrong cache',q=>{q.options[0]!.description=q.options[0]!.description!.replace('AuthCache passed','OtherCache passed');}],['same writer and reader',q=>{q.options[0]!.description=q.options[0]!.description!.replace('AuthBroker reads','SessionMint reads');}],['missing invalidation rejection',q=>{q.options[0]!.description=q.options[0]!.description!.replace('are rejected if the entry was invalidated since read','are accepted even when invalidated');}],['missing owned repair',q=>{q.options[0]!.description='Choose later.';}],['missing opposed risk',q=>{q.options[2]!.description='The race is closed.';}],['opposition now serialized',q=>{q.options[2]!.description+='\nThe writers are now serialized.';}],['reader also writes',q=>{q.options[0]!.description+='\nAuthBroker also writes.';}],
];
test.each(changes)('%s cannot open review',(_,edit)=>expect(first(change(edit))).toBe(false));
test('current statuses, framing and conditional approval are enforced on finding and offered outcomes',()=>{
 for(const status of ['withdrawn','no longer current','hypothetical','optional'])for(const [open,close]of [['',''],['"','"'],["'","'"],['“','”'],['‘','’'],['`','`']]){
  for(const owner of ['This finding','D5','Issue 1'])expect(first(change(q=>{q.question+=`\n**${owner}** is ${open}${status}${close}.`;})),`${owner} ${open}${status}`).toBe(false);
  for(const i of [0,1,2])expect(first(change(q=>{q.options[i]!.description+=`\n**This option** is ${open}${status}${close}.`;}))).toBe(false);
 }
 for(const prefix of ['Source:','Historical assessment:','If approved,','Once approved,','Pending approval:'])for(const i of [0,1,2])expect(first(change(q=>{q.options[i]!.description=prefix+'\n'+q.options[i]!.description;})),prefix).toBe(false);
});
test('native completion, timestamp, exact answer, session and visible menu stay mandatory',()=>{
 const edits:Array<(c:NativePlanQuestionCall)=>void>=[c=>{c.answered=false;},c=>{c.failed=true;},c=>{c.answers={};},c=>{c.answers[c.questions[0]!.question]='not offered';},c=>{c.unansweredQuestionIndices=[0];},c=>{c.answeredAt='invalid';},c=>{c.sessionId='';},c=>{c.toolUseId='';},c=>{c.questions[0]!.multiSelect=true;},c=>{c.questions.push(structuredClone(c.questions[0]!));},c=>{c.questions[0]!.options[1]!.label=c.questions[0]!.options[0]!.label;}];
 for(const edit of edits){const c=fresh();edit(c);expect(first(c)).toBe(false);}const f=fp();expect(engFirstReviewAUQ({...f,signature:'foreign'})).toBe(false);expect(engFirstReviewAUQ({...f,options:f.options.slice().reverse()})).toBe(false);expect(engFirstReviewAUQ({...f,nativeQuestionIndex:1})).toBe(false);
});
test('regression fixture and control select the engineering finding-count workflow',()=>{
 for(const file of ['test/eng-annotated-cache-au.test.ts','test/fixtures/eng-annotated-cache-au.json'])expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(file)).map(([owner])=>owner)).toEqual(['plan-eng-finding-count']);
});

test('current approval conditions and same-option effort boundaries cannot hide withdrawals',()=>{
 for(const phrase of ['requires approval','is conditional on approval','is contingent on acceptance']) for(const target of ['finding','option']) expect(first(change(q=>{if(target==='finding')q.question+='\nThis finding '+phrase+'.';else q.options[0]!.description+='\nThis option '+phrase+'.';}))).toBe(false);
 for(const status of ['withdrawn','no longer current']) for(const [open,close]of [['',''],['"','"'],["'","'"],['“','”'],['‘','’']]) expect(first(change(q=>{q.options[0]!.description=q.options[0]!.description!.replace(/\.$/,'')+` This option is ${open}${status}${close}.`;}))).toBe(false);
 expect(first(change(q=>{q.options[2]!.description+='\nOnly SessionMint writes.';}))).toBe(false);
 expect(first(change(q=>{q.options[0]!.description+='\nDo not inject the cache.';}))).toBe(false);
});

test('the injection-only alternative must retain its stated unresolved race',()=>{
 for(const text of ['AuthCache is now serialized.','Only SessionMint writes.']) expect(first(change(q=>{q.options[1]!.description+='\n'+text;}))).toBe(false);
 for(const text of ['"AuthCache is now serialized."',"'Only SessionMint writes.'",'ArchiveCache is now serialized.']) expect(first(change(q=>{q.options[1]!.description+='\n'+text;}))).toBe(true);
});
