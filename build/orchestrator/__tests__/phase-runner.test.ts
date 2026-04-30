import { describe, it, expect } from 'bun:test';
import {
  decideNextAction,
  applyResult,
  markCommitted,
  findNextPhaseIndex,
  DEFAULT_MAX_CODEX_ITERATIONS,
} from '../phase-runner';
import type { PhaseState, Phase, DualImplState, DualImplTestResult } from '../types';
import type { SubAgentResult } from '../sub-agents';

function basePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: '1',
    name: 'Test Phase',
    status: 'pending',
    ...overrides,
  };
}

function geminiSuccess(): SubAgentResult {
  return {
    stdout: 'wrote code',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    logPath: '/tmp/gemini.log',
    durationMs: 1000,
    retries: 0,
  };
}

function geminiTimeout(): SubAgentResult {
  return { ...geminiSuccess(), timedOut: true, retries: 1 };
}

function geminiFailure(): SubAgentResult {
  return { ...geminiSuccess(), exitCode: 1 };
}

function codexPass(): SubAgentResult {
  return { ...geminiSuccess(), stdout: 'reviewed; GATE PASS' };
}
function codexFail(): SubAgentResult {
  return { ...geminiSuccess(), stdout: 'GATE FAIL — 3 issues' };
}
function codexUnclear(): SubAgentResult {
  return { ...geminiSuccess(), stdout: 'review complete (no verdict keyword)' };
}
function codexTimeout(): SubAgentResult {
  return { ...geminiSuccess(), stdout: '', timedOut: true, retries: 1 };
}

describe('decideNextAction', () => {
  it('pending → RUN_GEMINI iter 1', () => {
    const action = decideNextAction(basePhase({ status: 'pending' }));
    expect(action.type).toBe('RUN_GEMINI');
    if (action.type === 'RUN_GEMINI') expect(action.iteration).toBe(1);
  });

  it('gemini_running (resumed) → RUN_GEMINI iter 1', () => {
    const action = decideNextAction(basePhase({ status: 'gemini_running' }));
    expect(action.type).toBe('RUN_GEMINI');
  });

  it('impl_done (TDD phase) → RUN_TESTS iter 1', () => {
    const action = decideNextAction(basePhase({ status: 'impl_done' }), 5, { testSpecDone: false } as any);
    expect(action.type).toBe('RUN_TESTS');
    if (action.type === 'RUN_TESTS') expect(action.iteration).toBe(1);
  });

  it('impl_done (legacy phase, testSpecDone=true) → RUN_CODEX_REVIEW', () => {
    const action = decideNextAction(basePhase({ status: 'impl_done' }), 5, { testSpecDone: true } as any);
    expect(action.type).toBe('RUN_CODEX_REVIEW');
  });

  it('codex_running with iters < max → RUN_CODEX_REVIEW iter+1', () => {
    const action = decideNextAction(
      basePhase({
        status: 'codex_running',
        codexReview: { iterations: 2, outputLogPaths: [] },
      })
    );
    expect(action.type).toBe('RUN_CODEX_REVIEW');
    if (action.type === 'RUN_CODEX_REVIEW') expect(action.iteration).toBe(3);
  });

  it('codex_running with iters >= max → FAIL', () => {
    const action = decideNextAction(
      basePhase({
        status: 'codex_running',
        codexReview: { iterations: DEFAULT_MAX_CODEX_ITERATIONS, outputLogPaths: [] },
      })
    );
    expect(action.type).toBe('FAIL');
  });

  it('review_clean → MARK_COMPLETE', () => {
    const action = decideNextAction(basePhase({ status: 'review_clean' }));
    expect(action.type).toBe('MARK_COMPLETE');
  });

  it('committed → DONE', () => {
    const action = decideNextAction(basePhase({ status: 'committed' }));
    expect(action.type).toBe('DONE');
  });

  it('failed → FAIL', () => {
    const action = decideNextAction(basePhase({ status: 'failed', error: 'boom' }));
    expect(action.type).toBe('FAIL');
    if (action.type === 'FAIL') expect(action.reason).toBe('boom');
  });
});

describe('applyResult — Gemini', () => {
  it('successful Gemini → status impl_done', () => {
    const initial = basePhase({ status: 'pending' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiSuccess());
    expect(next.status).toBe('impl_done');
    expect(next.gemini?.exitCode).toBe(0);
    expect(next.gemini?.outputLogPath).toBe('/tmp/gemini.log');
  });

  it('timed-out Gemini → status failed', () => {
    const initial = basePhase({ status: 'pending' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiTimeout());
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/timed out/i);
  });

  it('non-zero Gemini exit → status failed', () => {
    const initial = basePhase({ status: 'pending' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiFailure());
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/exited 1/);
  });

  it('does not mutate input PhaseState', () => {
    const initial = basePhase({ status: 'pending' });
    const action = decideNextAction(initial);
    const before = JSON.stringify(initial);
    applyResult(initial, action as any, geminiSuccess());
    expect(JSON.stringify(initial)).toBe(before);
  });
});

describe('applyResult — Codex review', () => {
  it('GATE PASS → review_clean and bumps iterations to 1', () => {
    const initial = basePhase({ status: 'tests_green' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexPass());
    expect(next.status).toBe('review_clean');
    expect(next.codexReview?.iterations).toBe(1);
    expect(next.codexReview?.finalVerdict).toBe('GATE PASS');
  });

  it('GATE FAIL on first iter → codex_running, iterations=1', () => {
    const initial = basePhase({ status: 'tests_green' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexFail());
    expect(next.status).toBe('codex_running');
    expect(next.codexReview?.iterations).toBe(1);
    expect(next.codexReview?.finalVerdict).toBe('GATE FAIL');
  });

  it('successive GATE FAIL passes accumulate iterations', () => {
    let s = basePhase({ status: 'tests_green' });
    for (let i = 1; i <= 3; i++) {
      const action = decideNextAction(s);
      s = applyResult(s, action as any, codexFail());
      expect(s.codexReview?.iterations).toBe(i);
      expect(s.status).toBe('codex_running');
    }
  });

  it('GATE PASS after multiple fails → review_clean, log paths preserved', () => {
    let s = basePhase({ status: 'tests_green' });
    let action = decideNextAction(s);
    s = applyResult(s, action as any, codexFail());
    action = decideNextAction(s);
    s = applyResult(s, action as any, codexFail());
    action = decideNextAction(s);
    s = applyResult(s, action as any, codexPass());
    expect(s.status).toBe('review_clean');
    expect(s.codexReview?.iterations).toBe(3);
    expect(s.codexReview?.outputLogPaths).toHaveLength(3);
  });

  it('Codex timeout → status failed, finalVerdict TIMEOUT', () => {
    const initial = basePhase({ status: 'tests_green' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexTimeout());
    expect(next.status).toBe('failed');
    expect(next.codexReview?.finalVerdict).toBe('TIMEOUT');
  });

  it('Codex non-zero exit → status failed', () => {
    const initial = basePhase({ status: 'tests_green' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, { ...codexPass(), exitCode: 5, stdout: '' });
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/exited 5/);
  });

  it('verdict unclear → status failed (cannot determine outcome)', () => {
    const initial = basePhase({ status: 'tests_green' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexUnclear());
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/GATE PASS or GATE FAIL/);
  });
});

describe('markCommitted', () => {
  it('flips status to committed and stamps committedAt', () => {
    const before = basePhase({ status: 'review_clean' });
    const after = markCommitted(before);
    expect(after.status).toBe('committed');
    expect(after.committedAt).toBeDefined();
    expect(before.status).toBe('review_clean'); // input unchanged
  });
});

describe('findNextPhaseIndex', () => {
  it('returns first non-committed index', () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: 'committed' }),
      basePhase({ index: 1, status: 'committed' }),
      basePhase({ index: 2, status: 'pending' }),
      basePhase({ index: 3, status: 'pending' }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(2);
  });
  it('returns -1 when all committed', () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: 'committed' }),
      basePhase({ index: 1, status: 'committed' }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(-1);
  });
  it('treats `impl_done` (partial-checked phase) as needing work', () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: 'committed' }),
      basePhase({ index: 1, status: 'impl_done' }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(1);
  });
});

describe('end-to-end happy path through the state machine', () => {
  it('pending → impl_done → tests_green → review_clean → committed', () => {
    let s = basePhase({ status: 'pending' });
    // TDD phase: testSpecDone=false means test spec is needed, but we start from impl_done
    // to test the post-impl path; use testSpecDone=false so impl_done routes to RUN_TESTS.
    let a = decideNextAction(s as any, 5, { testSpecDone: false } as any);
    expect(a.type).toBe('RUN_GEMINI_TEST_SPEC');
    // Simulate already having gone through test-spec + verify-red + impl: jump to impl_done.
    s = { ...basePhase({ status: 'impl_done' }) };

    a = decideNextAction(s as any, 5, { testSpecDone: false } as any);
    expect(a.type).toBe('RUN_TESTS');
    s = applyResult(s, a as any, { stdout: '', stderr: '', exitCode: 0, timedOut: false, logPath: '', durationMs: 100, retries: 0 });
    expect(s.status).toBe('tests_green');

    a = decideNextAction(s as any, 5, { testSpecDone: true } as any);
    expect(a.type).toBe('RUN_CODEX_REVIEW');
    s = applyResult(s, a as any, codexPass());
    expect(s.status).toBe('review_clean');

    a = decideNextAction(s as any, 5, { testSpecDone: true } as any);
    expect(a.type).toBe('MARK_COMPLETE');
    s = markCommitted(s);
    expect(s.status).toBe('committed');

    a = decideNextAction(s as any, 5, { testSpecDone: true } as any);
    expect(a.type).toBe('DONE');
  });
});

describe('TDD state machine transitions', () => {
  const tddPhase: Phase = {
    index: 0, number: '1', name: 'TDD Test', body: 'test content',
    testSpecDone: false, testSpecCheckboxLine: 3,
    implementationDone: false, implementationCheckboxLine: 4,
    reviewDone: false, reviewCheckboxLine: 5,
    dualImpl: false,
  };
  // Legacy 2-checkbox plan: testSpecDone=true via the "no checkbox" compat path.
  // testSpecCheckboxLine=-1 distinguishes it from a real prewritten testspec.
  const legacyPhase: Phase = {
    index: 0, number: '1', name: 'Legacy', body: 'content',
    testSpecDone: true, testSpecCheckboxLine: -1,
    implementationDone: false, implementationCheckboxLine: 4,
    reviewDone: false, reviewCheckboxLine: 5,
    dualImpl: false,
  };
  // Real prewritten testspec: checkbox exists in the plan (testSpecCheckboxLine >= 0)
  // and is already checked. Differs from legacy which has testSpecCheckboxLine = -1.
  const prewrittenPhase: Phase = {
    index: 0, number: '1', name: 'Prewritten', body: 'content',
    testSpecDone: true, testSpecCheckboxLine: 10,
    implementationDone: false, implementationCheckboxLine: 11,
    reviewDone: false, reviewCheckboxLine: 12,
    dualImpl: false,
  };
  const prewrittenDual: Phase = { ...prewrittenPhase, dualImpl: true };

  it('pending with testSpecDone=false → RUN_GEMINI_TEST_SPEC', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'pending' as any };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_GEMINI_TEST_SPEC');
  });

  it('pending with legacy phase (testSpecDone=true, no checkbox) → RUN_GEMINI', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'Legacy', status: 'pending' as any };
    const action = decideNextAction(state, 5, legacyPhase);
    expect(action.type).toBe('RUN_GEMINI');
  });

  it('pending with legacy phase + dual-impl → RUN_GEMINI (not VERIFY_RED — legacy skips dual-impl)', () => {
    const legacyDual: Phase = { ...legacyPhase, dualImpl: true };
    const state: PhaseState = { index: 0, number: '1', name: 'LegacyDual', status: 'pending' as any };
    const action = decideNextAction(state, 5, legacyDual);
    expect(action.type).toBe('RUN_GEMINI');
  });

  it('pending with prewritten testspec + dual-impl → VERIFY_RED (not RUN_GEMINI)', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'PrewrittenDual', status: 'pending' as any };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe('VERIFY_RED');
  });

  it('test_spec_running with prewritten testspec (VERIFY_RED found trivially passing) → FAIL', () => {
    const state: PhaseState = {
      index: 0, number: '1', name: 'PrewrittenDual',
      status: 'test_spec_running' as any,
      redSpecAttempts: 1,
    };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe('FAIL');
    expect((action as any).reason).toMatch(/Prewritten tests pass/);
  });

  it('test_spec_running crash-resume (redSpecAttempts=0) → VERIFY_RED (not FAIL)', () => {
    // If process crashes between writing test_spec_running and spawning VERIFY_RED,
    // redSpecAttempts stays 0. Must re-run VERIFY_RED, not spuriously FAIL.
    const state: PhaseState = {
      index: 0, number: '1', name: 'PrewrittenDual',
      status: 'test_spec_running' as any,
      redSpecAttempts: 0,
    };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe('VERIFY_RED');
  });

  it('test_spec_running without prewritten testspec → RUN_GEMINI_TEST_SPEC (unchanged)', () => {
    const state: PhaseState = {
      index: 0, number: '1', name: 'TDD',
      status: 'test_spec_running' as any,
      redSpecAttempts: 1,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_GEMINI_TEST_SPEC');
  });

  it('impl_done with prewritten testspec + dual-impl → RUN_TESTS (verify winner on main cwd)', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'PrewrittenDual', status: 'impl_done' as any };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe('RUN_TESTS');
  });

  it('test_spec_done → VERIFY_RED', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'test_spec_done' as any };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('VERIFY_RED');
  });

  it('tests_red → RUN_GEMINI', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'tests_red' as any };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_GEMINI');
  });

  it('impl_done → RUN_TESTS', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'impl_done' as any, gemini: { retries: 0 } as any };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_TESTS');
  });

  it('test_fix_running with fail result cycles → RUN_GEMINI_FIX', () => {
    const state: PhaseState = {
      index: 0, number: '1', name: 'TDD', status: 'test_fix_running' as any,
      testFix: { iterations: 2, outputLogPaths: ['a.log', 'b.log'] } as any
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_GEMINI_FIX');
    expect((action as any).iteration).toBe(3);
  });

  it('test_fix_running at max iterations → FAIL', () => {
    const state: PhaseState = {
      index: 0, number: '1', name: 'TDD', status: 'test_fix_running' as any,
      testFix: { iterations: 5, outputLogPaths: ['a','b','c','d','e'] } as any
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('FAIL');
  });

  it('tests_green → RUN_CODEX_REVIEW', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'tests_green' as any };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_CODEX_REVIEW');
  });
});

describe('Dual-implementor state machine transitions', () => {
  const dualPhase: Phase = {
    index: 0, number: '1', name: 'Dual', body: 'content',
    testSpecDone: false, testSpecCheckboxLine: 3,
    implementationDone: false, implementationCheckboxLine: 4,
    reviewDone: false, reviewCheckboxLine: 5,
    dualImpl: true,
  };
  const singlePhase: Phase = { ...dualPhase, dualImpl: false };

  function minDualImpl(): DualImplState {
    return {
      geminiWorktreePath: '/tmp/g',
      codexWorktreePath: '/tmp/c',
      geminiBranch: 'g-branch',
      codexBranch: 'c-branch',
      baseCommit: 'abc123',
    };
  }

  function passResult(failureCount = 0): DualImplTestResult {
    return { worktreePath: '/tmp/x', testExitCode: 0, testLogPath: 'x.log', timedOut: false, failureCount };
  }
  function failResult(failureCount = 3): DualImplTestResult {
    return { worktreePath: '/tmp/x', testExitCode: 1, testLogPath: 'x.log', timedOut: false, failureCount };
  }

  // (a)
  it('(a) tests_red + dualImpl=true → RUN_DUAL_IMPL', () => {
    const state = basePhase({ status: 'tests_red' as any });
    const action = decideNextAction(state, 5, dualPhase);
    expect(action.type).toBe('RUN_DUAL_IMPL');
  });

  // (b)
  it('(b) dual_impl_done → RUN_DUAL_TESTS', () => {
    const state = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const action = decideNextAction(state);
    expect(action.type).toBe('RUN_DUAL_TESTS');
  });

  // (c): both pass → dual_judge_pending → RUN_JUDGE
  it('(c) both tests pass → dual_judge_pending + decideNextAction → RUN_JUDGE', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      { geminiTestResult: passResult(), codexTestResult: passResult() }
    );
    expect(next.status).toBe('dual_judge_pending');
    expect(decideNextAction(next).type).toBe('RUN_JUDGE');
  });

  // (d): one passes → auto-select + APPLY_WINNER
  it('(d) gemini passes, codex fails → dual_winner_pending selectedBy=auto + APPLY_WINNER', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      { geminiTestResult: passResult(), codexTestResult: failResult(3) }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('gemini');
    expect(next.dualImpl?.selectedBy).toBe('auto');
    const action = decideNextAction(next);
    expect(action.type).toBe('APPLY_WINNER');
    if (action.type === 'APPLY_WINNER') expect(action.winner).toBe('gemini');
  });

  // (e): both fail → auto-select fewer-failures
  it('(e) both fail → auto-select fewer-failures winner (codex has 2 < gemini 5)', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      { geminiTestResult: failResult(5), codexTestResult: failResult(2) }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('codex');
    expect(next.dualImpl?.selectedBy).toBe('auto');
  });

  // (f): judge complete → dual_winner_pending with judge verdict
  it('(f) RUN_JUDGE result → dual_winner_pending with judge verdict + APPLY_WINNER', () => {
    const initial = basePhase({ status: 'dual_judge_running' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_JUDGE', phaseIndex: 0 } as any,
      geminiSuccess(),
      { judgeVerdict: 'codex', judgeReasoning: 'Codex solution is cleaner' }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('codex');
    expect(next.dualImpl?.selectedBy).toBe('judge');
    expect(next.dualImpl?.judgeReasoning).toBe('Codex solution is cleaner');
    expect(decideNextAction(next).type).toBe('APPLY_WINNER');
  });

  it('(f2) RUN_JUDGE result propagates judgeHardeningNotes', () => {
    const initial = basePhase({ status: 'dual_judge_running' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_JUDGE', phaseIndex: 0 } as any,
      geminiSuccess(),
      { judgeVerdict: 'gemini', judgeReasoning: 'Gemini is more idiomatic', judgeHardeningNotes: 'Add edge case for null input' }
    );
    expect(next.dualImpl?.judgeHardeningNotes).toBe('Add edge case for null input');
  });

  // (g): APPLY_WINNER done → impl_done (handoff to existing pipeline)
  it('(g) APPLY_WINNER applied → impl_done', () => {
    const initial = basePhase({
      status: 'dual_winner_pending' as any,
      dualImpl: { ...minDualImpl(), selectedImplementor: 'gemini', selectedBy: 'auto' },
    });
    const next = applyResult(
      initial,
      { type: 'APPLY_WINNER', phaseIndex: 0, winner: 'gemini' } as any,
      geminiSuccess()
    );
    expect(next.status).toBe('impl_done');
  });

  // (h): tests_red + dualImpl=false → RUN_GEMINI (single-impl path unchanged)
  it('(h) tests_red + dualImpl=false → RUN_GEMINI (unchanged single-impl path)', () => {
    const state = basePhase({ status: 'tests_red' as any });
    const action = decideNextAction(state, 5, singlePhase);
    expect(action.type).toBe('RUN_GEMINI');
  });

  // Fail-closed: dual_winner_pending without selectedImplementor → FAIL
  it('dual_winner_pending without selectedImplementor → FAIL (fail-closed)', () => {
    const state = basePhase({ status: 'dual_winner_pending' as any, dualImpl: minDualImpl() });
    const action = decideNextAction(state);
    expect(action.type).toBe('FAIL');
  });

  // Fail-closed: RUN_DUAL_IMPL without dualImplInit → status failed
  it('RUN_DUAL_IMPL without dualImplInit in extra → status failed', () => {
    const initial = basePhase({ status: 'dual_impl_running' as any });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_IMPL', phaseIndex: 0, iteration: 1 } as any,
      geminiSuccess()
      // no extra
    );
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/dualImplInit/);
  });

  // Fail-closed: both timed out → status failed (no auto-select)
  it('RUN_DUAL_TESTS with both timed out → status failed', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        geminiTestResult: { worktreePath: '/g', testExitCode: null, testLogPath: 'g.log', timedOut: true },
        codexTestResult: { worktreePath: '/c', testExitCode: null, testLogPath: 'c.log', timedOut: true },
      }
    );
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/timed out/);
  });

  // Fail-closed: both fail with no failureCount → status failed
  it('RUN_DUAL_TESTS both fail with missing failureCount on both → status failed', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        geminiTestResult: { worktreePath: '/g', testExitCode: 1, testLogPath: 'g.log', timedOut: false },
        codexTestResult: { worktreePath: '/c', testExitCode: 1, testLogPath: 'c.log', timedOut: false },
      }
    );
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/failureCount/);
  });

  // Symmetric auto-select: codex passes, gemini fails (mirror of test (d))
  it('codex passes, gemini fails → dual_winner_pending selectedImplementor=codex selectedBy=auto', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      { geminiTestResult: failResult(3), codexTestResult: passResult() }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('codex');
    expect(next.dualImpl?.selectedBy).toBe('auto');
    const action = decideNextAction(next);
    expect(action.type).toBe('APPLY_WINNER');
    if (action.type === 'APPLY_WINNER') expect(action.winner).toBe('codex');
  });

  // One-side timeout: gemini timed out, codex passed → auto-select codex
  it('gemini timed out, codex passed → auto-select codex', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        geminiTestResult: { worktreePath: '/g', testExitCode: null, testLogPath: 'g.log', timedOut: true },
        codexTestResult: passResult(),
      }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('codex');
    expect(next.dualImpl?.selectedBy).toBe('auto');
  });

  // One-side timeout: codex timed out, gemini passed → auto-select gemini
  it('codex timed out, gemini passed → auto-select gemini', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        geminiTestResult: passResult(),
        codexTestResult: { worktreePath: '/c', testExitCode: null, testLogPath: 'c.log', timedOut: true },
      }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('gemini');
    expect(next.dualImpl?.selectedBy).toBe('auto');
  });

  // RUN_DUAL_IMPL failure: timedOut=true → status failed
  it('RUN_DUAL_IMPL with timedOut result → status failed', () => {
    const initial = basePhase({ status: 'dual_impl_running' as any });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_IMPL', phaseIndex: 0, iteration: 1 } as any,
      { stdout: '', stderr: 'timeout', exitCode: null, timedOut: true, logPath: 'x.log', durationMs: 0, retries: 0 },
    );
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/failed/i);
  });

  // RUN_DUAL_IMPL failure: exitCode !== 0 → status failed
  it('RUN_DUAL_IMPL with exitCode=1 result → status failed', () => {
    const initial = basePhase({ status: 'dual_impl_running' as any });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_IMPL', phaseIndex: 0, iteration: 1 } as any,
      { stdout: '', stderr: 'crash', exitCode: 1, timedOut: false, logPath: 'x.log', durationMs: 0, retries: 0 },
    );
    expect(next.status).toBe('failed');
  });

  // RUN_JUDGE missing judgeVerdict in extra → status failed
  it('RUN_JUDGE without judgeVerdict in extra → status failed', () => {
    const initial = basePhase({ status: 'dual_judge_running' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_JUDGE', phaseIndex: 0 } as any,
      geminiSuccess(),
      {} // no judgeVerdict
    );
    expect(next.status).toBe('failed');
    expect(next.error).toMatch(/judgeVerdict/);
  });

  // APPLY_WINNER with winner=codex also lands in impl_done
  it('APPLY_WINNER with winner=codex → impl_done (codex win uses same handoff state)', () => {
    const initial = basePhase({
      status: 'dual_winner_pending' as any,
      dualImpl: { ...minDualImpl(), selectedImplementor: 'codex', selectedBy: 'judge' },
    });
    const next = applyResult(
      initial,
      { type: 'APPLY_WINNER', phaseIndex: 0, winner: 'codex' } as any,
      geminiSuccess()
    );
    expect(next.status).toBe('impl_done');
    expect(next.dualImpl?.worktreesTornDownAt).toBeDefined();
  });

  // Tie-breaking: both fail with equal failureCount → gemini (documented preference)
  it('both fail with equal failureCount → gemini wins tie (documented preference)', () => {
    const initial = basePhase({ status: 'dual_impl_done' as any, dualImpl: minDualImpl() });
    const next = applyResult(
      initial,
      { type: 'RUN_DUAL_TESTS', phaseIndex: 0 } as any,
      geminiSuccess(),
      { geminiTestResult: failResult(3), codexTestResult: failResult(3) }
    );
    expect(next.status).toBe('dual_winner_pending');
    expect(next.dualImpl?.selectedImplementor).toBe('gemini');
  });

  // Resume path: dual_tests_running → RUN_DUAL_TESTS
  it('dual_tests_running → RUN_DUAL_TESTS (resume mid-test)', () => {
    const state = basePhase({ status: 'dual_tests_running' as any, dualImpl: minDualImpl() });
    const action = decideNextAction(state);
    expect(action.type).toBe('RUN_DUAL_TESTS');
  });
});
