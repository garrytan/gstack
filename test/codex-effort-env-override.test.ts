import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CODEX_DEFAULT_EFFORT,
  CODEX_REASONING_EFFORT_FLAG,
  codexReasoningEffortFlag,
} from '../scripts/resolvers/constants';
import { outsideVoiceCommand } from '../scripts/resolvers/outside-voice';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { claudeCodeArgs } from '../lib/claude-code';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Codex and Claude reasoning effort environment overrides', () => {
  const ctx: TemplateContext = {
    skillName: 'review',
    tmplPath: 'review/SKILL.md.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
  };

  test('codexReasoningEffortFlag helper defaults to high and honors argument default', () => {
    expect(CODEX_DEFAULT_EFFORT).toBe('high');
    expect(codexReasoningEffortFlag()).toBe('-c "model_reasoning_effort=\\"${GSTACK_CODEX_EFFORT:-high}\\""');
    expect(CODEX_REASONING_EFFORT_FLAG).toBe('-c "model_reasoning_effort=\\"${GSTACK_CODEX_EFFORT:-high}\\""');
    expect(codexReasoningEffortFlag('medium')).toBe('-c "model_reasoning_effort=\\"${GSTACK_CODEX_EFFORT:-medium}\\""');
    expect(codexReasoningEffortFlag('low')).toBe('-c "model_reasoning_effort=\\"${GSTACK_CODEX_EFFORT:-low}\\""');
  });

  test('outsideVoiceCommand renders GSTACK_CODEX_EFFORT:-high without hardcoded high literal', () => {
    const cmd = outsideVoiceCommand(ctx, { timeoutMs: 1000, gate: 'review' });
    expect(cmd).toContain('${GSTACK_CODEX_EFFORT:-high}');
    expect(cmd).not.toContain('model_reasoning_effort="high"');
  });

  test('spec gate preserves its medium reasoning effort default', () => {
    const cmd = outsideVoiceCommand(ctx, {
      timeoutMs: 1000,
      gate: 'spec',
      reasoningEffort: 'medium',
    });
    expect(cmd).toContain('${GSTACK_CODEX_EFFORT:-medium}');
    expect(cmd).not.toContain('model_reasoning_effort="medium"');
  });

  test('claudeCodeArgs adds NO --effort when env unset and adds --effort when GSTACK_CLAUDE_EFFORT is set', () => {
    const dummyCommand = { command: 'claude', argsPrefix: [] };

    const argsEmpty = claudeCodeArgs({ access: 'none' }, dummyCommand, {});
    expect(argsEmpty).not.toContain('--effort');

    const argsHigh = claudeCodeArgs({ access: 'none' }, dummyCommand, { GSTACK_CLAUDE_EFFORT: 'high' });
    expect(argsHigh).toContain('--effort');
    const idxHigh = argsHigh.indexOf('--effort');
    expect(argsHigh[idxHigh + 1]).toBe('high');

    const argsMedium = claudeCodeArgs({ access: 'none' }, dummyCommand, { GSTACK_CLAUDE_EFFORT: 'medium' });
    expect(argsMedium).toContain('--effort');
    const idxMed = argsMedium.indexOf('--effort');
    expect(argsMedium[idxMed + 1]).toBe('medium');
  });

  test('rendered consult-mode section keeps medium default while review-mode keeps high', () => {
    const consultMd = fs.readFileSync(path.join(ROOT, 'codex', 'sections', 'consult-mode.md'), 'utf-8');
    expect(consultMd).toContain('${GSTACK_CODEX_EFFORT:-medium}');
    expect(consultMd).not.toContain('${GSTACK_CODEX_EFFORT:-high}');
    expect(consultMd).not.toContain('model_reasoning_effort="medium"');

    const reviewMd = fs.readFileSync(path.join(ROOT, 'codex', 'sections', 'review-mode.md'), 'utf-8');
    expect(reviewMd).toContain('${GSTACK_CODEX_EFFORT:-high}');
    expect(reviewMd).not.toContain('${GSTACK_CODEX_EFFORT:-medium}');
    expect(reviewMd).not.toContain('model_reasoning_effort="high"');
  });
});
