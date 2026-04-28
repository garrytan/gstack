import { describe, it, expect } from 'bun:test';
import { parsePlan, isPhaseComplete, findNextPhase } from '../parser';

describe('parsePlan', () => {
  it('parses a minimal two-phase plan', () => {
    const md = `# Plan

### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo

### Phase 2: Bar
- [x] **Implementation (Gemini Sub-agent)**: do bar
- [ ] **Review & QA (Codex Sub-agent)**: review bar
`;
    const { phases, warnings } = parsePlan(md);
    expect(warnings).toEqual([]);
    expect(phases).toHaveLength(2);
    expect(phases[0].number).toBe('1');
    expect(phases[0].name).toBe('Foo');
    expect(phases[0].implementationDone).toBe(false);
    expect(phases[0].reviewDone).toBe(false);
    expect(phases[1].number).toBe('2');
    expect(phases[1].implementationDone).toBe(true);
    expect(phases[1].reviewDone).toBe(false);
  });

  it('handles decimal phase numbers like 2.1', () => {
    const md = `### Phase 2.1: Sub-phase
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases[0].number).toBe('2.1');
  });

  it('captures 1-based line numbers for both checkboxes', () => {
    const md = `# header
prose

### Phase 1: Foo
extra prose here

- [ ] **Implementation**: do
- [ ] **Review**: rev
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationCheckboxLine).toBe(7);
    expect(phases[0].reviewCheckboxLine).toBe(8);
  });

  it('ignores phase-shaped text inside fenced code blocks', () => {
    const md = `### Phase 1: Real
- [ ] **Implementation**: x
- [ ] **Review**: y

\`\`\`markdown
### Phase 99: Fake one
- [ ] **Implementation**: nope
- [ ] **Review**: nope
\`\`\`

### Phase 2: Also real
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases.map((p) => p.number)).toEqual(['1', '2']);
  });

  it('warns and skips a phase missing one checkbox', () => {
    const md = `### Phase 1: Half-shaped
- [ ] **Implementation**: only
`;
    const { phases, warnings } = parsePlan(md);
    expect(phases).toHaveLength(0);
    expect(warnings.some((w) => w.includes('Review checkbox'))).toBe(true);
  });

  it('treats X (uppercase) as checked', () => {
    const md = `### Phase 1: Caps
- [X] **Implementation**: did
- [x] **Review**: did
`;
    const { phases } = parsePlan(md);
    expect(phases[0].implementationDone).toBe(true);
    expect(phases[0].reviewDone).toBe(true);
  });

  it('strips a leading BOM', () => {
    const md = `﻿### Phase 1: BOM
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases).toHaveLength(1);
  });

  it('preserves CRLF line endings without breaking', () => {
    const md = `### Phase 1: CRLF\r\n- [ ] **Implementation**: x\r\n- [ ] **Review**: y\r\n`;
    const { phases } = parsePlan(md);
    expect(phases).toHaveLength(1);
    expect(phases[0].number).toBe('1');
  });

  it('captures phase body content (between heading and next phase)', () => {
    const md = `### Phase 1: With body
This phase needs context.

- [ ] **Implementation**: do
- [ ] **Review**: rev

Some trailing notes.

### Phase 2: Next
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(phases[0].body).toContain('This phase needs context.');
    expect(phases[0].body).toContain('Some trailing notes.');
    expect(phases[0].body).not.toContain('### Phase 2');
  });

  describe('dualImpl opt stamping', () => {
    it('stamps dualImpl=true on all phases when passed via opts', () => {
      const md = `### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo

### Phase 2: Bar
- [ ] **Implementation (Gemini Sub-agent)**: do bar
- [ ] **Review & QA (Codex Sub-agent)**: review bar
`;
      const { phases } = parsePlan(md, { dualImpl: true });
      expect(phases[0].dualImpl).toBe(true);
      expect(phases[1].dualImpl).toBe(true);
    });

    it('dualImpl defaults to false when opts not passed', () => {
      const md = `### Phase 1: Foo
- [ ] **Implementation (Gemini Sub-agent)**: do foo
- [ ] **Review & QA (Codex Sub-agent)**: review foo
`;
      const { phases } = parsePlan(md);
      expect(phases[0].dualImpl).toBe(false);
    });
  });

  describe('TDD checkbox parsing', () => {
    it('Test A: Parse a 3-checkbox TDD phase', () => {
      const md = `### Phase 1: Foo
- [ ] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
      const { phases } = parsePlan(md);
      expect(phases[0].testSpecDone).toBe(false);
      expect(phases[0].testSpecCheckboxLine).toBeGreaterThan(0);
      expect(phases[0].implementationDone).toBe(false);
      expect(phases[0].reviewDone).toBe(false);
    });

    it('Test B: Legacy 2-checkbox phase -> backward compat', () => {
      const md = `### Phase 1: Bar
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
      const { phases } = parsePlan(md);
      expect(phases[0].testSpecDone).toBe(true);
      expect(phases[0].testSpecCheckboxLine).toBe(-1);
    });

    it('Test C: testSpecDone=true when checkbox is [x]', () => {
      const md = `### Phase 1: Baz
- [x] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`;
      const { phases } = parsePlan(md);
      expect(phases[0].testSpecDone).toBe(true);
      expect(phases[0].implementationDone).toBe(false);
    });
  });
});

describe('isPhaseComplete + findNextPhase', () => {
  it('isPhaseComplete requires both checkboxes', () => {
    const md = `### Phase 1: A
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 2: B
- [x] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(isPhaseComplete(phases[0])).toBe(true);
    expect(isPhaseComplete(phases[1])).toBe(false);
  });

  it('findNextPhase returns the first incomplete phase, including partial', () => {
    const md = `### Phase 1: Done
- [x] **Implementation**: x
- [x] **Review**: y

### Phase 2: Partial (resume here)
- [x] **Implementation**: x
- [ ] **Review**: y

### Phase 3: Pending
- [ ] **Implementation**: x
- [ ] **Review**: y
`;
    const { phases } = parsePlan(md);
    const next = findNextPhase(phases);
    expect(next?.number).toBe('2');
  });

  it('findNextPhase returns null when all done', () => {
    const md = `### Phase 1: A
- [x] **Implementation**: x
- [x] **Review**: y
`;
    const { phases } = parsePlan(md);
    expect(findNextPhase(phases)).toBeNull();
  });
});
