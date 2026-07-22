import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { generateModelOverlay } from '../scripts/resolvers/model-overlay';
import type { TemplateContext } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(__dirname, '..');

function makeCtx(model: string): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'codex',
    paths: HOST_PATHS.codex,
    preambleTier: 2,
    model,
  };
}

describe('GPT overlay — bounded execution', () => {
  test('replaces open-ended completion bias with bounded work units', () => {
    const raw = fs.readFileSync(
      path.join(ROOT, 'model-overlays/gpt.md'),
      'utf-8',
    );

    expect(raw).toContain('**Bounded execution (authoritative for execution posture).**');
    expect(raw).toContain('within about five minutes');
    expect(raw).toContain('After two unsuccessful attempts');
    expect(raw).not.toContain('**Completion bias.**');
  });

  test('makes bounded execution authoritative for GPT posture only', () => {
    const out = generateModelOverlay(makeCtx('gpt'));

    expect(out).toContain('authoritative for GPT execution');
    expect(out).toContain('controls work-unit size, retry limits');
    expect(out).toContain("skill's completion criteria");
  });

  test('gpt-5.4 inherits the bounded directive exactly once', () => {
    const out = generateModelOverlay(makeCtx('gpt-5.4'));
    const directiveCount = out.match(
      /\*\*Bounded execution \(authoritative for execution posture\)\.\*\*/g,
    )?.length ?? 0;

    expect(directiveCount).toBe(1);
    expect(out).toContain('Anti-verbosity protocol');
  });

  test('keeps the Claude wrapper byte-for-byte on the non-GPT path', () => {
    const raw = fs.readFileSync(
      path.join(ROOT, 'model-overlays/claude.md'),
      'utf-8',
    ).trim();
    const expected = `## Model-Specific Behavioral Patch (claude)

The following nudges are tuned for the claude model family. They are
**subordinate** to skill workflow, STOP points, AskUserQuestion gates, plan-mode
safety, and /ship review gates. If a nudge below conflicts with skill instructions,
the skill wins. Treat these as preferences, not rules.

${raw}`;

    expect(generateModelOverlay(makeCtx('claude'))).toBe(expected);
  });

  test('does not give the GPT precedence wrapper to o-series', () => {
    const out = generateModelOverlay(makeCtx('o-series'));

    expect(out).toContain('Treat these as preferences, not rules.');
    expect(out).not.toContain('authoritative for GPT execution');
  });
});
