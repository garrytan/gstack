import {expect,test} from 'bun:test';
import {engFirstReviewAUQ,nativePlanCallFingerprint,type AskUserQuestionFingerprint as FP} from './helpers/claude-pty-runner';
import fixture from './fixtures/eng-cache-brief-am.json';
const calls=fixture.calls as FP[];
function edit(change:(q:any,f:FP)=>void):FP { const f=structuredClone(calls[1]!),c=f.nativeCall!,q=c.questions[0]!,selected=q.options.findIndex(o=>o.label===c.answers?.[q.question]);change(q,f);c.answers={[q.question]:q.options[selected]!.label};return nativePlanCallFingerprint(c,f.observedAtMs,f.preReview); }
test('the completed current cache ownership brief starts the engineering review',()=>expect(engFirstReviewAUQ(calls[1]!)).toBe(true));
test('the earlier whole-plan scope choice does not become a finding',()=>expect(engFirstReviewAUQ(calls[0]!)).toBe(false));
test('equivalent decision ordinal and current wording retain the owned finding',()=>{
 expect(engFirstReviewAUQ(edit(q=>{q.question=q.question.replace(/^D2/,'D17');q.header='D17 DI';}))).toBe(true);
 expect(engFirstReviewAUQ(edit(q=>{q.question=q.question.replace('Right now both services grab','Today both services import').replace('and both write to it.','and both mutate it.');}))).toBe(true);
});
test('unrelated current decisions remain outside this dependency branch',()=>{
 expect(engFirstReviewAUQ(edit(q=>{q.header='D3 DI';}))).toBe(false);
 expect(engFirstReviewAUQ(edit(q=>{q.question=q.question.replace('Architecture finding A1','Architecture finding A2');}))).toBe(false);
});
const negative:Array<[string,(q:any,f:FP)=>void]>=[
 ['source preface',q=>q.question=q.question.replace('\nELI10:','\nSource excerpt:\nELI10:')],
 ['historical current clause',q=>q.question=q.question.replace('ELI10: Right now','ELI10: Previously')],
 ['hypothetical current clause',q=>q.question=q.question.replace('ELI10: Right now','ELI10: If approved, right now')],
 ['negated current writes',q=>q.question=q.question.replace('and both write to it.','and neither writes to it.')],
 ['quoted current assessment',q=>q.question=q.question.replace('ELI10: Right now','ELI10: "Right now').replace('it. Nobody','it." Nobody')],
 ['withdrawn finding',q=>q.question+='\nCorrection: this finding is withdrawn.'],
 ['resolved current finding',q=>q.question+='\nNo current gap remains.'],
 ['foreign cache title',q=>q.question=q.question.replace('Module-level AuthCache','Module-level OtherCache')],
 ['source remedy preface',q=>q.options[0].description='Source excerpt:\n'+q.options[0].description],
 ['conditional writer ownership',q=>q.options[0].description=q.options[0].description.replace('✅ SessionMint','✅ If SessionMint')],
 ['quoted writer ownership',q=>q.options[0].description=q.options[0].description.replace('✅ SessionMint','✅ "SessionMint').replace('not convention.','not convention."')],
 ['read-only claim only in con',q=>q.options[0].description=q.options[0].description.replace('✅ SessionMint','❌ SessionMint')],
 ['same writable and read-only actor',q=>q.options[0].description=q.options[0].description.replace('AuthBroker gets','SessionMint gets')],
 ['withdrawn remedy',q=>q.options[0].description+=' This remedy is withdrawn.'],
 ['foreign opposing finding',q=>q.options[2].description=q.options[2].description.replace('Both A1','Both A9')],
 ['opposed gap resolved',q=>q.options[2].description+=' No current gap remains.'],
 ['conditional opposed gap',q=>q.options[2].description=q.options[2].description.replace('❌ Both A1','❌ If Both A1')],
 ['unoffered recommendation',q=>q.question=q.question.replace('Recommendation: A','Recommendation: D')],
 ['multiple recommendations',q=>q.options[1].label+=' (recommended)'],
 ['unlettered choice',q=>q.options[1].label=q.options[1].label.slice(3)],
 ['unanswered',(_,f)=>f.nativeCall!.answered=false],
 ['failed',(_,f)=>f.nativeCall!.failed=true],
 ['incomplete member',(_,f)=>f.nativeCall!.unansweredQuestionIndices=[0]],
 ['invalid completion time',(_,f)=>f.nativeCall!.answeredAt='invalid'],
];
test.each(negative)('%s cannot supply current owned engineering review',(_,change)=>expect(engFirstReviewAUQ(edit(change))).toBe(false));
test('whole quoted history and consistent identifiers preserve the current decision',()=>{
 expect(engFirstReviewAUQ(edit(q=>q.question+='\nPrior note: "This finding is withdrawn."'))).toBe(true);
 expect(engFirstReviewAUQ(edit(q=>{q.question=q.question.replaceAll('AuthCache','SessionCache').replaceAll('A1','A9');q.options.forEach((o:any)=>o.description=o.description.replaceAll('A1','A9'));}))).toBe(true);
 expect(engFirstReviewAUQ(edit(q=>{q.question=q.question.replace(/^D2/,'d2');q.header='d2 DI';}))).toBe(true);
});

import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
test('new inputs have only the engineering finding owner and dense paths',()=>{
 for(const file of ['test/eng-cache-brief-am.test.ts','test/fixtures/eng-cache-brief-am.json']) expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes(file)).map(([owner])=>owner)).toEqual(['plan-eng-finding-count']);
 const paths=E2E_TOUCHFILES['plan-eng-finding-count']!;
 for(let i=0;i<paths.length;i++){expect(Object.hasOwn(paths,i)).toBe(true);expect(typeof paths[i]).toBe('string');}
});
test('current-owner withdrawals and conditional metadata cannot lend review evidence',()=>{
 for(const text of ['Correction: this finding is rejected.','Correction: this remedy is cancelled.','Correction: this finding is "withdrawn".','Correction: this explanation is not current.']) expect(engFirstReviewAUQ(edit(q=>q.question+='\n'+text))).toBe(false);
 expect(engFirstReviewAUQ(edit(q=>q.question=q.question.replace('Architecture finding A1','If approved, Architecture finding A1')))).toBe(false);
});
