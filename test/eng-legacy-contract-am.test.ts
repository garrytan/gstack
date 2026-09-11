import {test,expect} from 'bun:test';
import {evaluateEngSeedCoverage} from './helpers/eng-seeded-coverage';
import fixture from './fixtures/eng-legacy-contract-am.json';
const transcript:any={status:'ready',calls:fixture.calls,assistantMessages:[],planReadyRequests:[]};
const times=fixture.calls.map(c=>Date.parse(c.answeredAt));
const check=(plan=fixture.compact,calls=transcript.calls)=>evaluateEngSeedCoverage({...transcript,calls},plan,Math.min(...times)-1,Math.max(...times)+1);
test('the actual class inventory decision is a distinct complexity seed',()=>expect(check().missing).toEqual([]));
test('the actual mandatory current-output suite and linked before-rewrite task establish legacy parity',()=>expect(check().problems).toEqual([]));
test('the unchanged legacy function and exact output oracle remain required',()=>{
 expect(check(fixture.compact.replaceAll('legacyAuthFlow','anotherFlow')).regression).toBeUndefined();
 expect(check(fixture.compact.replace('record current outputs','record proposed outputs')).regression).toBeUndefined();
 expect(check(fixture.compact.replace('produces identical decisions and equivalent error surfaces','may produce different decisions and error surfaces')).regression).toBeUndefined();
});
const no:Array<[string,(s:string)=>string]>=[
 ['historical source ancestor',s=>'# Source\n'+s],
 ['quoted declaration',s=>s.replace(fixture.declaration,fixture.declaration.split('\n').map(l=>'> '+l).join('\n'))],
 ['fenced declaration',s=>s.replace(fixture.declaration,'```text\n'+fixture.declaration+'```\n')],
 ['optional declaration',s=>s.replace('REGRESSION (mandatory,','REGRESSION (optional,')],
 ['source declaration prefix',s=>s.replace('`legacyAuthFlow()` is existing','The following is a quoted source excerpt.\n`legacyAuthFlow()` is existing')],
 ['hypothetical declaration prefix',s=>s.replace('`legacyAuthFlow()` is existing','If approved:\n`legacyAuthFlow()` is existing')],
 ['after-rewrite capture',s=>s.replace('written BEFORE any rewrite','written AFTER any rewrite')],
 ['foreign declared task',s=>s.replace('rewrite (T1)','rewrite (T9)')],
 ['foreign task file',s=>s.replace('Files: `auth/legacyAuthFlow.characterization.test.ts`','Files: `auth/other.characterization.test.ts`')],
 ['proposed-only task owner',s=>s.replace('## Implementation Tasks','## Proposed Implementation Tasks')],
 ['task after rewrite',s=>s.replace('for `legacyAuthFlow()` before any rewrite','for `legacyAuthFlow()` after any rewrite')],
 ['missing current baseline',s=>s.replace('suite green on current main','suite green on the new implementation')],
 ['missing later rerun',s=>s.replace('; re-run after each later task','; no later runs needed')],
 ['conditional verification',s=>s.replace('  - Verify:','  If approved:\n  - Verify:')],
 ['source verification',s=>s.replace('  - Verify:','  Source excerpt:\n  - Verify:')],
 ['withdrawn task',s=>s+'\n## Final assessment\nT1 is withdrawn.\n'],
 ['withdrawn rerun',s=>s+'\n## Final assessment\nT1 rerun is cancelled.\n'],
 ['withdrawn suite',s=>s+'\n## Final assessment\nThe legacy regression suite is withdrawn.\n'],
 ['withdrawn baseline verification',s=>s.replace('  - Verify:','  Correction: this baseline verification is withdrawn.\n  - Verify:')],
];
test.each(no)('%s cannot supply the required unchanged legacy oracle',(_,change)=>expect(check(change(fixture.compact)).regression).toBeUndefined());
test('same file/task identity and harmless unrelated context are preserved',()=>{
 expect(check(fixture.compact.replaceAll('T1','T9').replaceAll('legacyAuthFlow.characterization.test.ts','legacy-behavior.test.ts')).ok).toBe(true);
 expect(check(fixture.compact+'\n## Payment regression suite\nThis regression suite is withdrawn.\n').ok).toBe(true);
 expect(check(fixture.compact.replace('  - Verify:','  Literal UI label: "This is a hypothetical example."\n  - Verify:')).ok).toBe(true);
});
test('a class-name or historical example cannot replace the class-inventory scope decision',()=>{
 for(const title of ['D1 — Rename the class before building?','Historical example: Reduce the class inventory before building?','D1 — A hypothetical example: reduce the class inventory before building?']){
  const calls=structuredClone(transcript.calls);const q=calls[0].questions[0];const selected=calls[0].answers[q.question];q.question=q.question.replace(/^.*\n/,title+'\n');calls[0].answers={[q.question]:selected};expect(check(fixture.compact,calls).missing).toContain('complexity');
 }
});

test('explicit current baseline changes and named verification withdrawal cancel this oracle',()=>{
 for(const suffix of [
  '## Current baseline correction\nlegacyAuthFlow() is modified before T1 records the baseline.',
  '## Final verification assessment\nT1 verification is withdrawn.',
  '## Final verification assessment\nT1 verification is "withdrawn".',
 ])expect(check(fixture.compact+'\n'+suffix).regression).toBeUndefined();
 expect(check(fixture.compact+'\n## History\nOld note: "legacyAuthFlow() is modified before T1 records the baseline."').regression).toBeDefined();
});
test('current class inventory ownership excludes literal, source-only and withdrawn actions',()=>{
 const changes=[
  (q:any)=>{q.question=q.question.replace(/^(D1 — )(.*)\n/,'$1`$2`\n')},
  (q:any)=>{q.options=q.options.map((o:any)=>({label:'Quoted source: '+o.label,description:'Source excerpt: '+o.description}))},
  (q:any)=>{q.question+='\nCorrection: this class-inventory decision is withdrawn.'},
  (q:any)=>{q.question+='\nCorrection: this class-inventory decision is "withdrawn".'},
 ];
 for(const change of changes){const calls=structuredClone(transcript.calls),c=calls[0],q=c.questions[0],selected=q.options.findIndex((o:any)=>o.label===c.answers[q.question]);change(q);c.answers={[q.question]:q.options[selected].label};expect(check(fixture.compact,calls).missing).toContain('complexity');}
 const calls=structuredClone(transcript.calls),c=calls[0],q=c.questions[0],selected=c.answers[q.question];q.question+='\nOld note: "This class-inventory decision is withdrawn."';c.answers={[q.question]:selected};expect(check(fixture.compact,calls).missing).not.toContain('complexity');
});
