import {expect,test} from 'bun:test';
import fixture from './fixtures/sdk-stale-table-ad-v3.json';
import {hasStaleFillRaceFinding as found} from './helpers/ceo-section-loading-fixture';
const allowance='Original reader still returns v1 to its own caller (allowed: it began before commit)';
test('actual table finding distinguishes forbidden later stale reads from the permitted original caller',()=>{
 expect(found(fixture.report)).toBe(true);
 expect(found(fixture.table)).toBe(true);
 expect(fixture.provenance.noRetroactivePass).toBe(true);
});
test('the already-started original read may use a version label without changing ownership',()=>{
 for(const token of ['v17','VERSION_A','snapshot-A'])expect(found(fixture.table.replaceAll('v1',token))).toBe(true);
});
test('allowance cannot migrate to later readers, a post-commit start, or a cache fill',()=>{
 for(const changed of [
  'Later readers return v1 (allowed: they began after commit)',
  'Original reader still returns v1 to its own caller (allowed: it began after commit)',
  'Original reader still returns v1 to its own caller (allowed: it never began before commit)',
  'Original reader fills the cache with v1 (allowed: it began before commit)',
  'Original reader still returns v1 to later readers (allowed: it began before commit)',
 ])expect(found(fixture.table.replace(allowance,changed))).toBe(false);
});
test('a permitted original caller cannot hide acceptance of later stale reads or no required fix',()=>{
 for(const suffix of [' This stale-read behavior is accepted.',' No fix is required.',' Later readers may return stale data; this is the accepted consistency model.'])
  expect(found(fixture.table.replace('None against the invariant.','None against the invariant.'+suffix))).toBe(false);
});
test('copied table source and absent late-fill evidence cannot provide coverage',()=>{
 expect(found('```text\n'+fixture.table+'\n```')).toBe(false);
 expect(found(fixture.table.split('\n').map(x=>'> '+x).join('\n'))).toBe(false);
 expect(found(fixture.table.split('\n').map(x=>'    '+x).join('\n'))).toBe(false);
 const rows=fixture.table.split('\n'),cells=rows[2]!.split('|');
 cells[4]=' There is no stale-fill race; later reads observe the committed value. ';
 rows[2]=cells.join('|');expect(found(rows.join('\n'))).toBe(false);
});


test('original-caller exception requires asserted chronology for that reader',()=>{
 for(const changed of [
  'Original reader still returns v1 to its own caller (allowed: it may have begun before commit)',
  'Original reader still returns v1 to its own caller (allowed: it did not begin before commit)',
  'Original reader still returns v1 to its own caller (allowed: it began before commit only if the write failed)',
  'Original reader still returns v1 to its own caller (allowed: another reader began before commit)',
  'Original reader still returns v1 to its own caller (allowed: the write began before commit)',
  'If the original reader still returns v1 to its own caller, that is allowed: it began before commit',
 ])expect(found(fixture.table.replace(allowance,changed))).toBe(false);
});

test('an original-return allowance cannot erase another allowed stale consequence',()=>{
 for(const changed of [
  allowance+' and stores that v1 in the cache for later readers',
  allowance+'; later readers may reuse this old value and that is allowed',
  allowance+'. New readers may reuse this old value and that is permitted',
  allowance+'. The stale cache refill is acceptable',
 ])expect(found(fixture.table.replace(allowance,changed))).toBe(false);
});

test('table rows cannot borrow an ordering defect from another issue or from quoted source',()=>{
 const rows=fixture.table.split('\n'),cells=rows[2]!.split('|');
 const originalFailure=cells[4]!;
 cells[4]=' The original reader receives its pre-commit snapshot; later reads observe the committed version. ';
 const missing=rows.slice(0,2).concat(cells.join('|')).join('\n');
 expect(found(missing)).toBe(false);
 const other=cells.slice();other[1]=' D2 ';other[4]=originalFailure;
 other[5]=' This stale-read behavior is accepted; no fix is required. ';
 expect(found(missing+'\n'+other.join('|'))).toBe(false);
 expect(found('> '+originalFailure+'\n\n'+missing)).toBe(false);
 expect(found('```text\n'+originalFailure+'\n```\n\n'+missing)).toBe(false);
});

import {E2E_TOUCHFILES,selectTests} from './helpers/touchfiles';
test('the new table evidence selects only the existing SDK section-loading case',()=>{
 for(const file of ['test/sdk-stale-table-ad-v3.test.ts','test/fixtures/sdk-stale-table-ad-v3.json'])
  expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-ceo-section-loading']);
});
