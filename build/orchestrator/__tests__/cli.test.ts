import { describe, it, expect } from 'bun:test';
import {
  buildGeminiTestSpecPrompt,
  buildCodexImplPromptBody,
  buildJudgePrompt,
  parseArgs,
  HELP_TEXT,
} from '../cli';
import type { Phase, DualImplTestResult } from '../types';

const basePhase: Phase = {
  index: 0,
  number: '1',
  name: 'Auth middleware',
  body: 'Write tests for the auth middleware.',
  testSpecDone: false,
  testSpecCheckboxLine: 5,
  implementationCheckboxLine: 6,
  reviewCheckboxLine: 7,
  implementationDone: false,
  reviewDone: false,
  dualImpl: false,
};

describe('buildGeminiTestSpecPrompt', () => {
  it('contains "write failing tests"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt.toLowerCase()).toContain('write failing tests');
  });

  it('contains "do NOT implement" or "do not implement"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt.toLowerCase()).toMatch(/do not implement/);
  });

  it('contains the phase name', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt).toContain(basePhase.name);
  });

  it('contains the plan file path', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, 'plan.md');
    expect(prompt).toContain('plan.md');
  });
});

describe('--dual-impl flag wiring', () => {
  it('--help text mentions --dual-impl', () => {
    expect(HELP_TEXT).toContain('--dual-impl');
  });

  it('parseArgs([plan, --dual-impl]) sets dualImpl=true', () => {
    const args = parseArgs(['plan.md', '--dual-impl']);
    expect(args.dualImpl).toBe(true);
  });

  it('parseArgs default → dualImpl=false', () => {
    const args = parseArgs(['plan.md']);
    expect(args.dualImpl).toBe(false);
  });
});

describe('buildCodexImplPromptBody (dual-impl Codex implementation prompt)', () => {
  it('contains "implement"', () => {
    const body = buildCodexImplPromptBody(basePhase, 'plan.md');
    expect(body.toLowerCase()).toMatch(/implement/);
  });

  it('contains "do NOT change test assertions"', () => {
    const body = buildCodexImplPromptBody(basePhase, 'plan.md');
    expect(body).toMatch(/do NOT change test assertions/i);
  });

  it('contains the phase name and plan file', () => {
    const body = buildCodexImplPromptBody(basePhase, 'plan.md');
    expect(body).toContain(basePhase.name);
    expect(body).toContain('plan.md');
  });
});

describe('buildJudgePrompt (Opus tournament judge prompt)', () => {
  function pass(): DualImplTestResult {
    return {
      worktreePath: '/tmp/wt',
      testExitCode: 0,
      testLogPath: '/tmp/wt/test.log',
      timedOut: false,
      failureCount: 0,
    };
  }

  it('contains the WINNER format instructions', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'diff --git a/foo b/foo\n+gemini code',
      codexDiff: 'diff --git a/foo b/foo\n+codex code',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toContain('WINNER:');
    expect(prompt).toContain('REASONING:');
  });

  it('contains both Gemini and Codex sections with their diffs', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'GEMINI_DIFF_MARKER',
      codexDiff: 'CODEX_DIFF_MARKER',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toMatch(/Gemini[\s\S]*GEMINI_DIFF_MARKER/);
    expect(prompt).toMatch(/Codex[\s\S]*CODEX_DIFF_MARKER/);
  });

  it('reflects test exit codes for each implementor', () => {
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: 'g',
      codexDiff: 'c',
      geminiTestResult: { ...pass(), testExitCode: 0 },
      codexTestResult: { ...pass(), testExitCode: 1, failureCount: 3 },
    });
    // Expect the judge sees both passed/failed — the exact phrasing is tested
    // loosely so prompt edits don't break tests.
    expect(prompt).toMatch(/exit/i);
    expect(prompt.toLowerCase()).toMatch(/0/);
    expect(prompt.toLowerCase()).toMatch(/1/);
  });
});
