// Exact acknowledged public decisions and owned plan excerpts from the cancelled f359 run.
// These free controls diagnose detectors; they do not credit the paid attempt.
import { expect, test } from 'bun:test';
import captured from './fixtures/eng-count-owned-outcomes-f359.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
const result = (calls: any[] = [], plan = '') => evaluateEngSeedCoverage({status:'ready',calls,assistantMessages:[],planReadyRequests:[]}, plan, captured.startedAt, captured.finishedAt);
const regression = (plan: string) => result([],plan).regression;
const replace = (s: string, from: string, to: string) => {expect(s).toContain(from); return s.replace(from,to);};
const decision = (mutate: (q:any,c:any)=>void = () => {}) => {const c=structuredClone(captured.calls[7]!); const q=c.questions[0]!; mutate(q,c); c.answers={[q.question]: q.options[0]!.label}; return c;};
test('captured decisions independently cover four seeds without administrative or duplicate credit', () => {
  const seeds = [[3,'sequential-idp'],[4,'complexity'],[5,'shared-cache'],[7,'swallowed-errors']] as const;
  for(const [index,seed] of seeds) expect(Object.keys(result([captured.calls[index]!]).decisions)).toEqual([seed]);
  for(const index of [0,1,2,6,8,9,10]) expect(result([captured.calls[index]!]).decisions).toEqual({});
});
test('captured required corpus binds capture before rewrite and identical replay to one approved decision',()=>{expect(regression(captured.plan)).toBe('plan');});
for (const [name, mutate] of Object.entries({
 'missing function':(q:any)=>{q.question=q.question.replaceAll('validateAndDispatch()', 'otherFunction()');},
 'foreign source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','OTHER.md');},
 'archived source':(q:any)=>{q.question=q.question.replaceAll('PLAN.md','archive/PLAN.md');},
 'quoted explanation':(q:any)=>{q.question=q.question.replace(/^ELI10: (.+)$/m,'ELI10: "$1"');},
 'historical explanation':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: Historical example: ');},
 'conditional explanation':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: If approved, ');},
 'withdrawn question':(q:any)=>{q.question+='\nThis decision is withdrawn.';},
 'reopened question':(q:any)=>{q.question+='\nThis decision is reopened.';},
 'no current swallow defect':(q:any)=>{q.question=q.question.replace(/quietly eating/g,'correctly propagating');},
 'no named steps':(q:any)=>{q.options[0].description=replace(q.options[0].description,'named steps','unrelated helpers');},
 'no error boundary':(q:any)=>{q.options[0].description=replace(q.options[0].description,'one top-level boundary','several independent handlers');},
 'partial mapping':(q:any)=>{q.options[0].description=replace(q.options[0].description,'each error class','some error classes');},
 'no explicit outcomes':(q:any)=>{q.options[0].description=replace(q.options[0].description,'an explicit outcome','a log entry');},
 'no legacy oracle':(q:any)=>{q.options[0].description=replace(q.options[0].description,'legacyAuthFlow()', 'otherAuthFlow()');},
 'borrowed remedy':(q:any)=>{q.question+='\nNet: '+q.options[0].description;q.options[0].description='Discuss the next steps.';},
 'split remedy across options':(q:any)=>{const [a,b]=q.options[0].description.split(';');q.options[0].description=a;q.options[1].description=b;},
 'quoted option':(q:any)=>{q.options[0].description='"'+q.options[0].description+'"';},
 'option withdrawn':(q:any)=>{q.options[0].description+='\nThis remedy is withdrawn.';},
 'option conditional':(q:any)=>{q.options[0].description='If approved, '+q.options[0].description;},
 'imperative mapping veto':(q:any)=>{q.options[0].description+='\nDo not map each error class.';},
 'declarative mapping veto':(q:any)=>{q.options[0].description=replace(q.options[0].description,'boundary maps','boundary does not map');},
 'negated legacy match':(q:any)=>{q.options[0].description=replace(q.options[0].description,'that matches','that never matches');},
})) {
 test('owned outcome mapping rejects '+name,()=>{expect(result([decision(mutate)]).decisions).toEqual({});});
}
for(const [name,mutate] of Object.entries({
 'pending':(c:any)=>{c.answered=false;},'failed':(c:any)=>{c.failed=true;},'late ACK':(c:any)=>{c.answeredAt=new Date(captured.finishedAt+1).toISOString();},'foreign ACK':(c:any)=>{c.answers={'another question':'A'};},
}))test('outcome mapping preserves '+name+' control',()=>{const c=decision();mutate(c);expect(result([c]).decisions).toEqual({});});
const planChanges: Record<string,(s:string)=>string> = {
 'missing source record':s=>s.replace(/### R4:[\s\S]*?(?=## Implementation Tasks)/,''),
 'foreign plan source':s=>s.replaceAll('PLAN.md','OTHER.md'),
 'archived record':s=>s.replace('## Decision ledger','## Historical decision ledger'),
 'source-owned record':s=>s.replace('### R4:','Source example:\n\n### R4:'),
 'source-owned task section':s=>s.replace('## Implementation Tasks','Source example:\n\n## Implementation Tasks'),
 'missing baseline task':s=>s.replace(/- \[ \] \*\*T1 [\s\S]*?(?=- \[ \] \*\*T6 )/,''),
 'missing replay task':s=>s.replace(/- \[ \] \*\*T6 [\s\S]*/,''),
 'foreign replay file':s=>replace(s,'tests/auth/legacyCharacterization.test.* (target switch)','tests/auth/other.test.* (target switch)'),
 'duplicate source decision':s=>replace(s,'(D9 → A)\n  - Files: tests/auth/legacyCharacterization.test.* (target switch)','(D9 → A; D10 → A)\n  - Files: tests/auth/legacyCharacterization.test.* (target switch)'),
 'wrong selected source':s=>s.replaceAll('(D9 → A)','(D9 → B)'),
 'different actual answer':s=>replace(s,'**A — Full characterization suite**','**B — Reduced characterization matrix**'),
 'ambiguous record state':s=>replace(s,'State: approved\n','State: rejected\n'),
 'duplicate accepted scope':s=>s.replace(/^(Accepted scope: .+)$/m,'$1\n$1'),
 'duplicate record':s=>s.replace('## Implementation Tasks',s.slice(s.indexOf('### R4:'),s.indexOf('## Implementation Tasks'))+'\n## Implementation Tasks'),
 'duplicate task':s=>s+ '\n'+s.slice(s.indexOf('- [ ] **T6 ')),
 'no full inventory':s=>s.replace(/^\| Input matrix \|.*$/m,''),
 'late task baseline':s=>replace(s,'doubles) before any rewrite','doubles) after any rewrite'),
 'negated task baseline':s=>replace(s,'doubles) before any rewrite','doubles) not before any rewrite'),
 'baseline does not pass':s=>replace(s,'Verify: suite green against legacy','Verify: suite not green against legacy'),
 'partial baseline corpus':s=>replace(s,'every matrix row present','some matrix rows present'),
 'partial replay outcomes':s=>replace(s,'identical outcomes on every row','identical outcomes on some rows'),
 'negated replay outcomes':s=>replace(s,'Verify: identical outcomes on every row','Verify: not identical outcomes on every row'),
 'foreign replay target':s=>replace(s,'suite against `AuthBroker` + `SessionMint`;','suite against `OtherBroker` + `SessionMint`;'),
 'no deletion parity gate':s=>replace(s,'only when identical','whenever convenient'),
 'selected option lacks capture':s=>replace(s,"Capture legacyAuthFlow()'s observable behavior",'Discuss the observable behavior'),
 'scope late baseline':s=>replace(s,'Accepted scope: before any rewrite','Accepted scope: after any rewrite'),
 'scope different corpus':s=>replace(s,'Replay the identical suite','Replay a different suite'),
 'scope conditional':s=>replace(s,'Accepted scope: before','Accepted scope: If approved, before'),
 'quoted whole report':s=>s.split('\n').map(l=>'> '+l).join('\n'),
 'fenced whole report':s=>'```\n'+s+'\n```',
 'withdrawn T1':s=>s+'\n## Current status\nT1 is withdrawn.\n',
 'withdrawn T6':s=>s+'\n## Current status\nT6 is withdrawn.\n',
 'withdrawn R4':s=>s+'\n## Current status\nR4 is withdrawn.\n',
 'changed expected outcomes':s=>s+'\n## Current status\nChange T1 assertions to match the new behavior.\n',
 'modified before capture':s=>s+'\n## Current status\nlegacyAuthFlow() is rewritten before T1.\n',
};
for(const [name,change] of Object.entries(planChanges))test('owned corpus rejects '+name,()=>{const s=change(captured.plan);expect(s).not.toBe(captured.plan);expect(regression(s)).toBeUndefined();});
for(const [name,change] of Object.entries({
 'renamed task IDs':(s:string)=>s.replaceAll('T1','T13').replaceAll('T6','T18'),
 'renamed corpus file':(s:string)=>s.replaceAll('tests/auth/legacyCharacterization.test.*','spec/previousBehavior.test.ts'),
 'renamed R/D IDs':(s:string)=>s.replaceAll('R4','R23').replaceAll('D9','D17'),
 'quoted withdrawn status':(s:string)=>s+'\n## Current status\n"T1 is withdrawn."\n',
 'historical withdrawn status':(s:string)=>s+'\n## History\nT1 is withdrawn.\n',
}))test('owned corpus supports '+name,()=>{expect(regression(change(captured.plan))).toBe('plan');});
for(const veto of ['The boundary does not map each error class.', 'The rewrite will not preserve the captured behavior.', 'The boundary will not match legacyAuthFlow() outcomes.']) test('a later current outcome veto overrides the earlier remedy: '+veto,()=>{
 expect(result([decision(q=>{q.options[0].description+='\n'+veto;})]).decisions).toEqual({});
 expect(Object.keys(result([decision(q=>{q.options[0].description+='\nPrior note: "'+veto+'"';})]).decisions)).toEqual(['swallowed-errors']);
});
for(const [name,change] of Object.entries({
 'inconsistent inventory count':(s:string)=>replace(s,'15 rows listed in R4 grid','14 rows listed in R4 grid'),
 'foreign inventory owner':(s:string)=>replace(s,'15 rows listed in R4 grid','15 rows listed in R9 grid'),
 'withdrawn replay verification':(s:string)=>s+'\n## Current status\nT6 verification is optional.\n',
 'mismatched selected label':(s:string)=>replace(s,'**A — Full characterization suite**','**A — Reduced characterization matrix**'),
 'duplicate baseline verification':(s:string)=>s.replace(/^(  - Verify: suite green.*)$/m,'$1\n$1'),
 'conditional task':(s:string)=>replace(s,'— Capture `legacyAuthFlow()`','— If approved, capture `legacyAuthFlow()`'),
 'borrowed record under example ancestor':(s:string)=>replace(s,'## Decision ledger','## Copied example\n### Decision ledger'),
}))test('owned corpus rejects '+name,()=>{expect(regression(change(captured.plan))).toBeUndefined();});

for(const [name,change] of Object.entries({
 'selected capture refused':(s:string)=>replace(s,"Capture legacyAuthFlow()'s observable behavior","Do not capture legacyAuthFlow()'s observable behavior"),
 'selected recording refused':(s:string)=>replace(s,"Capture legacyAuthFlow()'s observable behavior","Never record legacyAuthFlow()'s observable behavior"),
 'selected capture conditional':(s:string)=>replace(s,"Capture legacyAuthFlow()'s observable behavior","If approved, capture legacyAuthFlow()'s observable behavior"),
 'scope replay refused':(s:string)=>replace(s,'Replay the identical suite','Do not replay the identical suite'),
 'task replay refused':(s:string)=>replace(s,'only when identical\n','only when identical; do not replay the characterization suite\n'),
 'task replay prohibited':(s:string)=>replace(s,'only when identical\n','only when identical; never replay the characterization suite\n'),
}))test('owned corpus rejects current action veto: '+name,()=>{expect(regression(change(captured.plan))).toBeUndefined();});
test('owned corpus keeps a quoted replay veto distinct from the required task',()=>{
 const plan=replace(captured.plan,'only when identical\n','only when identical; prior note: "do not replay the characterization suite"\n');
 expect(regression(plan)).toBe('plan');
});
for(const [name,change] of Object.entries({
 'negated accepted baseline':(s:string)=>replace(s,'Accepted scope: before any rewrite','Accepted scope: not before any rewrite'),
 'duplicate selected grid column':(s:string)=>replace(s,'| Choice | Current | A | B | C |','| Choice | Current | A | A | C |'),
}))test('owned corpus rejects '+name,()=>{expect(regression(change(captured.plan))).toBeUndefined();});
