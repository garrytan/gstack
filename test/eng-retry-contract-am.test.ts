import {test,expect} from 'bun:test';
import {evaluateEngSeedCoverage} from './helpers/eng-seeded-coverage';
import fixture from './fixtures/eng-retry-contract-am.json';
const times=fixture.calls.map(c=>Date.parse(c.answeredAt));
const check=(text=fixture.compact)=>evaluateEngSeedCoverage({status:'ready',calls:fixture.calls,assistantMessages:[]},text,Math.min(...times)-1,Math.max(...times)+1);
test('the exact retry binds mandatory characterization before extraction to the unchanged baseline and same-task rerun',()=>expect(check().ok).toBe(true));
const negatives:Array<[string,(s:string)=>string]>=[
 ['source ancestor',s=>'# Source excerpt\n'+s],
 ['quoted declaration',s=>s.replace(fixture.declaration,'> '+fixture.declaration)],
 ['conditional declaration',s=>s.replace(fixture.declaration,'If approved:\n'+fixture.declaration)],
 ['source declaration prefix',s=>s.replace(fixture.declaration,'Source excerpt:\n'+fixture.declaration)],
 ['optional rule',s=>s.replace('mandatory, not a decision','optional, not a decision')],
 ['changed baseline subject',s=>s.replaceAll('legacyAuthFlow','anotherFlow')],
 ['foreign declaration task',s=>s.replace('T1 adds','T8 adds')],
 ['foreign extraction identity',s=>s.replace('before* the 4A','before* the 9A')],
 ['baseline on modified code',s=>s.replace('against unmodified legacy','against modified legacy')],
 ['baseline after other commits',s=>s.replace('before any other commit','after the other commits')],
 ['different extraction behavior',s=>s.replace('behavior unchanged','behavior changed')],
 ['unlinked rerun',s=>s.replace('Verify: T1 still green','Verify: T8 still green')],
 ['omitted rerun',s=>s.replace('T1 still green','no rerun needed')],
 ['source baseline verification',s=>s.replace('  - Verify: test passes','  Source excerpt:\n  - Verify: test passes')],
 ['conditional rerun verification',s=>s.replace('  - Verify: T1','  If approved:\n  - Verify: T1')],
 ['withdrawn baseline task',s=>s+'\n## Final assessment\nT1 is withdrawn.\n'],
 ['withdrawn extraction rerun',s=>s+'\n## Final assessment\nT2 verification is withdrawn.\n'],
 ['quoted current withdrawal',s=>s+'\n## Final assessment\nT1 verification is "withdrawn".\n'],
 ['current legacy changed before baseline',s=>s+'\n## Current correction\nlegacyAuthFlow() is modified before T1 records the baseline.\n'],
 ['withdrawn legacy suite',s=>s+'\n## Final assessment\nThe legacy regression suite is withdrawn.\n'],
];
test.each(negatives)('%s does not provide a current unchanged oracle',(_,change)=>expect(check(change(fixture.compact)).regression).toBeUndefined());
test('consistent task/extraction renaming and attributed historical/foreign context preserve the oracle',()=>{
 expect(check(fixture.compact.replaceAll('T1','T8').replaceAll('T2','T9').replaceAll('4A','6B').replaceAll('validate()','checkToken()')).ok).toBe(true);
 expect(check(fixture.compact+'\n## Payment regression suite\nThe regression suite is withdrawn.\n').ok).toBe(true);
 expect(check(fixture.compact+'\n## Notes\nOld note: "T1 verification is withdrawn."\n').ok).toBe(true);
});

test('the owned regression-test and extraction-rerun obligation remain current',()=>{
 for(const value of ['T1 regression test is withdrawn.','Correction: T2 no longer reruns T1.'])expect(check(fixture.compact+'\n## Final assessment\n'+value).regression).toBeUndefined();
 expect(check(fixture.compact+'\n## History\nOld note: "T1 regression test is withdrawn."').regression).toBeDefined();
 expect(check(fixture.compact+'\n## Payment task\nT8 no longer reruns T7.').regression).toBeDefined();
});

test('standalone source and prior-review frames cannot own the current retry declaration',()=>{
 for(const prefix of ['Source:','Earlier review assessment:'])expect(check(fixture.compact.replace(fixture.declaration,prefix+'\n'+fixture.declaration)).regression).toBeUndefined();
 expect(check(fixture.compact.replace(fixture.declaration,'Old note: "Source:"\n'+fixture.declaration)).regression).toBeDefined();
});
