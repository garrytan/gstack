import { describe, it, expect } from 'bun:test';
import { parseVerdict, stripAnsi } from '../sub-agents';

describe('stripAnsi', () => {
  it('removes ANSI color codes', () => {
    const colored = '\x1b[31mGATE FAIL\x1b[0m and then \x1b[32mGATE PASS\x1b[0m';
    expect(stripAnsi(colored)).toBe('GATE FAIL and then GATE PASS');
  });
  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
  it('handles complex sequences (cursor movement etc)', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Goutput\x1b[0m')).toBe('output');
  });
});

describe('parseVerdict', () => {
  it('returns pass when GATE PASS is the only verdict', () => {
    expect(parseVerdict('All checks complete. GATE PASS.')).toBe('pass');
  });
  it('returns fail when GATE FAIL is the only verdict', () => {
    expect(parseVerdict('Found 3 issues. GATE FAIL.')).toBe('fail');
  });
  it('returns unclear when neither keyword present', () => {
    expect(parseVerdict('Review complete. No issues found.')).toBe('unclear');
  });
  it('returns the LAST verdict when both keywords appear', () => {
    expect(parseVerdict('GATE FAIL first pass. After fix: GATE PASS')).toBe('pass');
    expect(parseVerdict('GATE PASS initially, then GATE FAIL on closer look')).toBe('fail');
  });
  it('strips ANSI before matching', () => {
    expect(parseVerdict('\x1b[32mGATE PASS\x1b[0m')).toBe('pass');
  });
  it('case-sensitive (lowercase gate pass does NOT match)', () => {
    // Per the convention in real plans — Codex emits the keyword in caps.
    expect(parseVerdict('gate pass')).toBe('unclear');
  });
});
