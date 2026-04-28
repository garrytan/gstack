import { describe, it, expect } from 'bun:test';
import { buildGeminiTestSpecPrompt } from '../cli';
import type { Phase } from '../types';

describe('buildGeminiTestSpecPrompt', () => {
  const phase: Phase = {
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
  };

  it('contains "write failing tests"', () => {
    const prompt = buildGeminiTestSpecPrompt(phase, 'plan.md');
    expect(prompt.toLowerCase()).toContain('write failing tests');
  });

  it('contains "do NOT implement" or "do not implement"', () => {
    const prompt = buildGeminiTestSpecPrompt(phase, 'plan.md');
    expect(prompt.toLowerCase()).toMatch(/do not implement/);
  });

  it('contains the phase name', () => {
    const prompt = buildGeminiTestSpecPrompt(phase, 'plan.md');
    expect(prompt).toContain(phase.name);
  });

  it('contains the plan file path', () => {
    const prompt = buildGeminiTestSpecPrompt(phase, 'plan.md');
    expect(prompt).toContain('plan.md');
  });
});
