import { describe, it, expect } from 'bun:test';
import {
  hasAwait,
  isSingleParenOrIifeExpression,
  needsBlockWrapper,
  wrapForEvaluate,
} from '../browse/src/read-commands';

describe('browse js / eval wrapping (#2727)', () => {
  it('detects presence of await keyword', () => {
    expect(hasAwait('await Promise.resolve(1)')).toBe(true);
    expect(hasAwait('(async()=>{ await 1; return 2; })()')).toBe(true);
    expect(hasAwait('Promise.resolve(1)')).toBe(false);
    expect(hasAwait('// await inside comment\nreturn 123')).toBe(false);
  });

  it('detects single paren and IIFE expressions containing statements', () => {
    expect(isSingleParenOrIifeExpression("(async()=>{ return 'x'; })()")).toBe(true);
    expect(isSingleParenOrIifeExpression("(async()=>{await 1; return 'y';})()")).toBe(true);
    expect(
      isSingleParenOrIifeExpression(
        "(async()=>{await new Promise(r=>setTimeout(r,50)); return 'done';})()"
      )
    ).toBe(true);
    expect(isSingleParenOrIifeExpression("((async () => { await 1; return 'z'; })())")).toBe(true);
    expect(isSingleParenOrIifeExpression("await (async () => { return 'ok'; })()")).toBe(true);
    expect(
      isSingleParenOrIifeExpression(`(async () => {
  const a = await Promise.resolve(10);
  return a * 2;
})()`)
    ).toBe(true);

    expect(isSingleParenOrIifeExpression('const a = 1; return a;')).toBe(false);
    expect(isSingleParenOrIifeExpression("await Promise.resolve(1); return 'ok';")).toBe(false);
  });

  it('correctly decides block vs expression wrapper', () => {
    expect(needsBlockWrapper("(async()=>{await 1; return 'y';})()")).toBe(false);
    expect(needsBlockWrapper('await Promise.resolve(7)')).toBe(false);
    expect(needsBlockWrapper('await Promise.resolve(7);')).toBe(false);
    expect(needsBlockWrapper("await Promise.resolve(1); return 'ok';")).toBe(true);
    expect(needsBlockWrapper('const x = await 1;\nreturn x + 1;')).toBe(true);
  });

  it('wraps code for evaluate properly preserving return values', () => {
    // Non-await expressions remain unwrapped
    expect(wrapForEvaluate("Promise.resolve('x')")).toBe("Promise.resolve('x')");
    expect(wrapForEvaluate("(async()=>{ return 'x'; })()")).toBe("(async()=>{ return 'x'; })()");

    // Simple await expression gets expression wrapper
    expect(wrapForEvaluate('await Promise.resolve(7)')).toBe('(async()=>(await Promise.resolve(7)))()');

    // Async IIFE with internal statements gets expression wrapper preserving return value
    expect(wrapForEvaluate("(async()=>{await 1; return 'y';})()")).toBe(
      "(async()=>((async()=>{await 1; return 'y';})()))()"
    );

    // Multi-statement sequence gets block wrapper
    expect(wrapForEvaluate("await Promise.resolve(1); return 'ok';")).toBe(
      "(async()=>{\nawait Promise.resolve(1); return 'ok';\n})()"
    );
  });
});
