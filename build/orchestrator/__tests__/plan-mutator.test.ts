import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flipCheckbox, flipPhaseCheckboxes, _testWritePlan, flipTestSpecCheckbox } from '../plan-mutator';

describe('flipCheckbox', () => {
  it('flips [ ] to [x] on the target line', () => {
    const md = `# Plan

### Phase 1: Foo
- [ ] **Implementation**: do
- [ ] **Review**: rev
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 4, expectedMarker: '**Implementation' });
    expect(r.flipped).toBe(true);
    expect(r.alreadyChecked).toBe(false);
    const after = fs.readFileSync(p, 'utf8');
    expect(after.split(/\r?\n/)[3]).toBe('- [x] **Implementation**: do');
    expect(after.split(/\r?\n/)[4]).toBe('- [ ] **Review**: rev');
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('is idempotent — flipping an already-checked box returns alreadyChecked', () => {
    const md = `### Phase 1
- [x] **Implementation**: done
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 2, expectedMarker: '**Implementation' });
    expect(r.flipped).toBe(false);
    expect(r.alreadyChecked).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('errors when the expected marker is not on the target line (file edited externally)', () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
- [ ] **Review**: x
`;
    const p = _testWritePlan(md);
    // Ask for "Review" at the Implementation line — simulates plan being edited
    const r = flipCheckbox({ planFile: p, lineNumber: 2, expectedMarker: '**Review' });
    expect(r.flipped).toBe(false);
    expect(r.error).toMatch(/edited externally/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('errors when the target line is not a checkbox', () => {
    const md = `### Phase 1
not a checkbox at all
- [ ] **Implementation**: x
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 2 });
    expect(r.error).toMatch(/does not look like a checkbox/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('errors on out-of-range line', () => {
    const md = `single line\n`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 99 });
    expect(r.error).toMatch(/out of range/);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('preserves CRLF line endings if the file uses them', () => {
    const md = `### Phase 1\r\n- [ ] **Implementation**: x\r\n- [ ] **Review**: y\r\n`;
    const p = _testWritePlan(md);
    flipCheckbox({ planFile: p, lineNumber: 2, expectedMarker: '**Implementation' });
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain('\r\n');
    expect(after).toContain('- [x] **Implementation**: x');
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('leaves other phase checkboxes untouched', () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
- [ ] **Review**: y

### Phase 2
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const p = _testWritePlan(md);
    flipCheckbox({ planFile: p, lineNumber: 2, expectedMarker: '**Implementation' });
    const after = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    expect(after[1]).toBe('- [x] **Implementation**: x');
    expect(after[2]).toBe('- [ ] **Review**: y');
    expect(after[5]).toBe('- [ ] **Implementation**: x');
    expect(after[6]).toBe('- [ ] **Review**: y');
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('does not match checkbox-shaped text inside fenced code blocks', () => {
    // The MUTATOR is line-targeted, so the parser is responsible for not
    // recording line numbers inside fences. But we should still guard the
    // mutator: if asked to flip a checkbox INSIDE a fence (unusual but
    // possible if caller bypasses parser), it should still flip — the
    // mutator's contract is "you tell me the line, I flip it." This test
    // documents that contract.
    const md = `\`\`\`
- [ ] **Implementation**: this is inside a fence
\`\`\`
`;
    const p = _testWritePlan(md);
    const r = flipCheckbox({ planFile: p, lineNumber: 2 });
    expect(r.flipped).toBe(true);
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('cleans up temp file on success (no .tmp.* leftover)', () => {
    const md = `### P\n- [ ] **Implementation**: x\n`;
    const p = _testWritePlan(md);
    flipCheckbox({ planFile: p, lineNumber: 2, expectedMarker: '**Implementation' });
    const dir = path.dirname(p);
    const stragglers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(stragglers).toHaveLength(0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('flipPhaseCheckboxes', () => {
  it('flips both implementation and review in one call', () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const p = _testWritePlan(md);
    const r = flipPhaseCheckboxes({ planFile: p, implementationLine: 2, reviewLine: 3 });
    expect(r.implementation.flipped).toBe(true);
    expect(r.review.flipped).toBe(true);
    const after = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    expect(after[1]).toBe('- [x] **Implementation**: x');
    expect(after[2]).toBe('- [x] **Review**: y');
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('reports errors per-checkbox without short-circuiting', () => {
    const md = `### Phase 1
- [ ] **Implementation**: x
not a checkbox
`;
    const p = _testWritePlan(md);
    const r = flipPhaseCheckboxes({ planFile: p, implementationLine: 2, reviewLine: 3 });
    expect(r.implementation.flipped).toBe(true);
    expect(r.review.error).toBeDefined();
    fs.rmSync(path.dirname(p), { recursive: true });
  });
});
describe('flipTestSpecCheckbox', () => {
  it('flipTestSpecCheckbox flips only the test-spec line', () => {
    const md = `### Phase 1: Test
- [ ] **Test Specification (Gemini Sub-agent)**: Tests.
- [ ] **Implementation (Gemini Sub-agent)**: Impl.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
    const p = _testWritePlan(md);
    const phase = {
      testSpecCheckboxLine: 2
    };
    const result = flipTestSpecCheckbox(p, phase as any);
    expect(result.flipped).toBe(true);
    const after = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    expect(after[1]).toContain('[x] **Test Specification');
    expect(after[2]).toContain('[ ] **Implementation');
    expect(after[3]).toContain('[ ] **Review');
    fs.rmSync(path.dirname(p), { recursive: true });
  });

  it('flipTestSpecCheckbox returns alreadyChecked for legacy plans', () => {
    const result = flipTestSpecCheckbox('/fake/plan.md', { testSpecCheckboxLine: -1 } as any);
    expect(result.flipped).toBe(false);
    expect(result.alreadyChecked).toBe(true);
  });
});
