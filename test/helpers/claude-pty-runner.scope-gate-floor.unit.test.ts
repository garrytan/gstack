/**
 * Scope-gate floor-exclusion regression pins (free, static).
 *
 * runPlanSkillFloorCheck's acceptance condition changed with the plan-mode
 * auto-select-B work: a render only satisfies the finding floor when
 *
 *   (isNumberedOptionListVisible(visible) || isProseAUQVisible(visible))
 *     && !isPermissionDialogVisible(tail)
 *     && !isScopeGateQuestionVisible(tail)      // <- new exclusion
 *
 * where tail = visible.slice(-TAIL_SCAN_BYTES). The composition lives inline
 * in the paid PTY loop, so these tests pin the load-bearing behavior of each
 * detector on the exact render shapes the floor passes them:
 *
 *  1. Both scope-gate render forms (native numbered UI, prose lettered
 *     fallback) trip the acceptance detectors — WITHOUT the exclusion the
 *     gate would trivially satisfy the floor inside the 3s pre-target
 *     window. The exclusion must catch both forms.
 *  2. A genuine finding-driven AskUserQuestion must NOT trip the exclusion,
 *     or the floor becomes unsatisfiable.
 *  3. The exclusion is TAIL-scoped by design: an early gate render that has
 *     scrolled past TAIL_SCAN_BYTES must not suppress a later real finding
 *     AskUserQuestion.
 *
 * Also closes the untested OR-branch of isScopeGateAutoSelectVisible: the
 * fully-collapsed hyphen-less 'autoselectedb' form.
 */

import { describe, test, expect } from 'bun:test';
import {
  TAIL_SCAN_BYTES,
  isNumberedOptionListVisible,
  isProseAUQVisible,
  isPermissionDialogVisible,
  isScopeGateQuestionVisible,
  isScopeGateAutoSelectVisible,
  parseNumberedOptions,
} from './claude-pty-runner';

// The gate's native AskUserQuestion render (numbered options + cursor) —
// what fires inside the floor check's 3s window before the seed arrives.
const GATE_NATIVE_RENDER = `
  What should I review?

  ❯ 1. The current branch diff — the work in progress on this branch.
    2. A plan or design doc I'll paste or point you to.
    3. A specific file, directory, or path.
`;

// The gate's prose fallback render (lettered options under --disallowedTools).
const GATE_PROSE_RENDER = `
What should I review?
A) The current branch diff — the work in progress on this branch.
B) A plan or design doc I'll paste or point you to.
C) A specific file, directory, or path.
Recommendation: A when a branch diff exists, otherwise B.
`;

// A genuine finding-driven AskUserQuestion — the render the floor MEASURES.
const FINDING_AUQ_RENDER = `
Finding 1: the plan reimplements test sharding that Bun provides natively.

  ❯ 1. Use Bun's native --shard flag (recommended)
    2. Keep the custom scheduler as planned
    3. Defer this decision to implementation
`;

describe('floor-check scope-gate exclusion (acceptance-condition regression)', () => {
  test('native gate render trips the acceptance detector — the exclusion is load-bearing', () => {
    // Pre-exclusion, this render satisfied the floor by itself.
    expect(isNumberedOptionListVisible(GATE_NATIVE_RENDER)).toBe(true);
    expect(isPermissionDialogVisible(GATE_NATIVE_RENDER)).toBe(false);
    // The new exclusion catches it.
    expect(isScopeGateQuestionVisible(GATE_NATIVE_RENDER)).toBe(true);
  });

  test('prose gate render trips the prose-AUQ arm — the exclusion catches that form too', () => {
    expect(isProseAUQVisible(GATE_PROSE_RENDER)).toBe(true);
    expect(isPermissionDialogVisible(GATE_PROSE_RENDER)).toBe(false);
    expect(isScopeGateQuestionVisible(GATE_PROSE_RENDER)).toBe(true);
  });

  test('a genuine finding AskUserQuestion is NOT excluded — the floor stays satisfiable', () => {
    expect(isNumberedOptionListVisible(FINDING_AUQ_RENDER)).toBe(true);
    expect(isPermissionDialogVisible(FINDING_AUQ_RENDER)).toBe(false);
    expect(isScopeGateQuestionVisible(FINDING_AUQ_RENDER)).toBe(false);
  });

  test('tail-scoping: an early gate render scrolled out of the tail does not suppress a later finding AUQ', () => {
    // Gate render, then >TAIL_SCAN_BYTES of review output, then the real
    // finding AskUserQuestion — the shape the TAIL-scoped exclusion exists for.
    const filler = 'Reading the plan and auditing the design system.\n'.repeat(
      Math.ceil(TAIL_SCAN_BYTES / 48) + 4,
    );
    const visible = GATE_NATIVE_RENDER + filler + FINDING_AUQ_RENDER;
    const tail = visible.slice(-TAIL_SCAN_BYTES);

    // Full buffer still remembers the gate (scrollback)…
    expect(isScopeGateQuestionVisible(visible)).toBe(true);
    // …but the floor's exclusion looks only at the tail, which is clean:
    expect(isScopeGateQuestionVisible(tail)).toBe(false);
    // and the acceptance arm (full-buffer scan) sees the finding AUQ.
    expect(isNumberedOptionListVisible(visible)).toBe(true);
    expect(isPermissionDialogVisible(tail)).toBe(false);
  });

  test('a gate render inside the tail IS suppressed (no false floor pass)', () => {
    const tail = GATE_NATIVE_RENDER.slice(-TAIL_SCAN_BYTES);
    expect(isScopeGateQuestionVisible(tail)).toBe(true);
  });

  test('active-render veto: a finding AUQ close after the gate is NOT vetoed (codex P2 re-review)', () => {
    // The finding menu renders <TAIL_SCAN_BYTES after the gate, then the
    // model waits (no further output). A blanket tail veto would suppress
    // this until timeout; the active-render veto anchors on the LAST cursor
    // menu, which is the finding AUQ, so the floor is satisfiable.
    const visible = GATE_NATIVE_RENDER + '\nAuditing the plan…\n' + FINDING_AUQ_RENDER;
    const activeMenu = parseNumberedOptions(visible);
    expect(activeMenu.length).toBeGreaterThan(0);
    const gateIsActiveRender = activeMenu.some((o) => /current\s*branch\s*diff/i.test(o.label));
    expect(gateIsActiveRender).toBe(false);
  });

  test('active-render veto: the gate as the pending menu IS vetoed', () => {
    const visible = 'booting…\n' + GATE_NATIVE_RENDER;
    const activeMenu = parseNumberedOptions(visible);
    expect(activeMenu.length).toBeGreaterThan(0);
    const gateIsActiveRender = activeMenu.some((o) => /current\s*branch\s*diff/i.test(o.label));
    expect(gateIsActiveRender).toBe(true);
  });
});

describe('isScopeGateAutoSelectVisible collapsed hyphen-less branch', () => {
  test("matches the fully-collapsed 'autoselectedb' form (hyphen lost in TTY reflow)", () => {
    const sample = 'Scopegate:planmode—autoselectedB(reviewingPLAN.md).';
    expect(isScopeGateAutoSelectVisible(sample)).toBe(true);
  });

  test('hyphen-less token without the announcement prefix stays false', () => {
    const sample = 'The agent autoselectedB from the menu without announcing a scope gate decision.';
    expect(isScopeGateAutoSelectVisible(sample)).toBe(false);
  });
});
