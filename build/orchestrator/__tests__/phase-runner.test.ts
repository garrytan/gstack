import { describe, it, expect } from 'bun:test';
import {
  decideNextAction,
  applyResult,
  markCommitted,
  findNextPhaseIndex,
  DEFAULT_MAX_CODEX_ITERATIONS,
} from '../phase-runner';
import type { PhaseState, Phase } from '../types';
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

  it('gemini_done (TDD phase) → RUN_TESTS iter 1', () => {
    const action = decideNextAction(basePhase({ status: 'gemini_done' }), 5, { testSpecDone: false } as any);
    expect(action.type).toBe('RUN_TESTS');
    if (action.type === 'RUN_TESTS') expect(action.iteration).toBe(1);
  });

  it('gemini_done (legacy phase, testSpecDone=true) → RUN_CODEX_REVIEW', () => {
    const action = decideNextAction(basePhase({ status: 'gemini_done' }), 5, { testSpecDone: true } as any);
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
  it('successful Gemini → status gemini_done', () => {
    const initial = basePhase({ status: 'pending' });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiSuccess());
    expect(next.status).toBe('gemini_done');
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
  it('treats `gemini_done` (partial-checked phase) as needing work', () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: 'committed' }),
      basePhase({ index: 1, status: 'gemini_done' }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(1);
  });
});

describe('end-to-end happy path through the state machine', () => {
  it('pending → gemini_done → tests_green → review_clean → committed', () => {
    let s = basePhase({ status: 'pending' });
    // TDD phase: testSpecDone=false means test spec is needed, but we start from gemini_done
    // to test the post-impl path; use testSpecDone=false so gemini_done routes to RUN_TESTS.
    let a = decideNextAction(s as any, 5, { testSpecDone: false } as any);
    expect(a.type).toBe('RUN_GEMINI_TEST_SPEC');
    // Simulate already having gone through test-spec + verify-red + impl: jump to gemini_done.
    s = { ...basePhase({ status: 'gemini_done' }) };

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
  };
  const legacyPhase: Phase = {
    index: 0, number: '1', name: 'Legacy', body: 'content',
    testSpecDone: true, testSpecCheckboxLine: -1,
    implementationDone: false, implementationCheckboxLine: 4,
    reviewDone: false, reviewCheckboxLine: 5,
  };

  it('pending with testSpecDone=false → RUN_GEMINI_TEST_SPEC', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'pending' as any };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe('RUN_GEMINI_TEST_SPEC');
  });

  it('pending with legacy phase (testSpecDone=true) → RUN_GEMINI', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'Legacy', status: 'pending' as any };
    const action = decideNextAction(state, 5, legacyPhase);
    expect(action.type).toBe('RUN_GEMINI');
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

  it('gemini_done → RUN_TESTS', () => {
    const state: PhaseState = { index: 0, number: '1', name: 'TDD', status: 'gemini_done' as any, gemini: { retries: 0 } as any };
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
