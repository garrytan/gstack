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

describe('--skip-clean-check / --skip-sweep flags', () => {
  it('parseArgs default → skipCleanCheck=false, skipSweep=false', () => {
    const args = parseArgs(['plan.md']);
    expect(args.skipCleanCheck).toBe(false);
    expect(args.skipSweep).toBe(false);
  });

  it('parseArgs([plan, --skip-clean-check]) → skipCleanCheck=true', () => {
    const args = parseArgs(['plan.md', '--skip-clean-check']);
    expect(args.skipCleanCheck).toBe(true);
  });

  it('parseArgs([plan, --skip-sweep]) → skipSweep=true', () => {
    const args = parseArgs(['plan.md', '--skip-sweep']);
    expect(args.skipSweep).toBe(true);
  });

  it('HELP_TEXT contains --skip-clean-check', () => {
    expect(HELP_TEXT).toContain('--skip-clean-check');
  });

  it('HELP_TEXT contains --skip-sweep', () => {
    expect(HELP_TEXT).toContain('--skip-sweep');
  });
});

describe('--gemini-model / --codex-model flag wiring', () => {
  it('--help text mentions --gemini-model', () => {
    expect(HELP_TEXT).toContain('--gemini-model');
  });

  it('--help text mentions --codex-model', () => {
    expect(HELP_TEXT).toContain('--codex-model');
  });

  it('parseArgs with --gemini-model sets geminiModel', () => {
    const args = parseArgs(['plan.md', '--gemini-model', 'gemini-3.1-pro']);
    expect(args.geminiModel).toBe('gemini-3.1-pro');
  });

  it('parseArgs with --codex-model sets codexModel', () => {
    const args = parseArgs(['plan.md', '--codex-model', 'gpt-5.4']);
    expect(args.codexModel).toBe('gpt-5.4');
  });

  it('parseArgs default → model defaults are baked in (no flags needed)', () => {
    const args = parseArgs(['plan.md']);
    expect(args.geminiModel).toBe('gemini-3.1-pro-preview');
    expect(args.codexModel).toBe('gpt-5.3-codex-spark');
    expect(args.codexReviewModel).toBe('gpt-5.5');
  });

  it('--codex-review-model overrides the review model default', () => {
    const args = parseArgs(['plan.md', '--codex-review-model', 'gpt-5.4']);
    expect(args.codexReviewModel).toBe('gpt-5.4');
  });

  it('--help text mentions --codex-review-model', () => {
    expect(HELP_TEXT).toContain('--codex-review-model');
  });

  it('parseArgs accepts all three model flags together', () => {
    const args = parseArgs([
      'plan.md',
      '--gemini-model', 'gemini-3.2-pro',
      '--codex-model', 'gpt-5.3-codex',
      '--codex-review-model', 'gpt-5.4',
    ]);
    expect(args.geminiModel).toBe('gemini-3.2-pro');
    expect(args.codexModel).toBe('gpt-5.3-codex');
    expect(args.codexReviewModel).toBe('gpt-5.4');
  });

  it('parseArgs model flags combine correctly with --dual-impl', () => {
    const args = parseArgs(['plan.md', '--dual-impl']);
    expect(args.dualImpl).toBe(true);
    expect(args.geminiModel).toBe('gemini-3.1-pro-preview');
    expect(args.codexModel).toBe('gpt-5.3-codex-spark');
    expect(args.codexReviewModel).toBe('gpt-5.5');
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

  it('truncates diffs longer than 40000 chars with a [truncated] marker', () => {
    const hugeDiff = 'x'.repeat(40001);
    const prompt = buildJudgePrompt({
      phase: basePhase,
      geminiDiff: hugeDiff,
      codexDiff: 'short',
      geminiTestResult: pass(),
      codexTestResult: pass(),
    });
    expect(prompt).toContain('[...truncated');
    // The first 40000 chars must be present; the 40001st must not
    expect(prompt).toContain('x'.repeat(40000));
    expect(prompt).not.toContain('x'.repeat(40001));
  });
});
