/**
 * Unit tests for the terse-build flag (v1.46.0.0 T3).
 *
 * `--explain-level=terse` makes the gen-skill-docs pipeline drop 4 preamble
 * sections at gen time. Default builds keep them. Without these tests, a
 * refactor that breaks the explainLevel threading silently regresses one
 * of the opt-in compression paths — the runtime EXPLAIN_LEVEL: terse runtime
 * gate still works, so users wouldn't notice immediately.
 *
 * Pure-function tests against the resolvers — fast, free, no subprocess.
 */

import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateWritingStyle } from '../scripts/resolvers/preamble/generate-writing-style';
import { generateCompletenessSection } from '../scripts/resolvers/preamble/generate-completeness-section';
import { generateConfusionProtocol } from '../scripts/resolvers/preamble/generate-confusion-protocol';
import { generateContextHealth } from '../scripts/resolvers/preamble/generate-context-health';
import { generatePreamble } from '../scripts/resolvers/preamble';

function makeCtx(explainLevel?: 'default' | 'terse', tier: number = 4): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: '/tmp/test/SKILL.md.tmpl',
    host: 'claude',
    paths: {
      skillRoot: '~/.claude/skills/gstack',
      localSkillRoot: '.claude/skills',
      binDir: '~/.claude/skills/gstack/bin',
      browseDir: '~/.claude/skills/gstack/browse/dist',
      designDir: '~/.claude/skills/gstack/design/dist',
      makePdfDir: '~/.claude/skills/gstack/make-pdf/dist',
    },
    preambleTier: tier,
    explainLevel,
  };
}

describe('terse build — per-resolver behavior', () => {
  describe('generateWritingStyle', () => {
    test('default: emits full section with jargon-list pointer', () => {
      const out = generateWritingStyle(makeCtx('default'));
      expect(out).toContain('## Writing Style');
      expect(out).toContain('jargon-list.json');
      expect(out).toContain('Curated jargon list');
      expect(out).toContain('outcome');
    });

    test('terse: emits one-line terse directive only', () => {
      const out = generateWritingStyle(makeCtx('terse'));
      expect(out).toContain('## Writing Style');
      expect(out).toContain('Terse mode (build-time)');
      // Negative: NONE of the default-mode prose
      expect(out).not.toContain('jargon-list.json');
      expect(out).not.toContain('Curated jargon list');
      expect(out).not.toContain('Frame questions in outcome terms');
    });

    test('terse is meaningfully shorter than default', () => {
      const fullLen = generateWritingStyle(makeCtx('default')).length;
      const terseLen = generateWritingStyle(makeCtx('terse')).length;
      expect(terseLen).toBeLessThan(fullLen / 3);
    });
  });

  describe('generateCompletenessSection', () => {
    test('default: emits full section with Boil-the-Ocean prose', () => {
      const out = generateCompletenessSection(makeCtx('default'));
      expect(out).toContain('## Completeness Principle');
      expect(out).toContain('Boil the Ocean');
    });

    test('terse: returns empty string', () => {
      expect(generateCompletenessSection(makeCtx('terse'))).toBe('');
    });

    test('no ctx arg: defaults to non-terse (back-compat with old callers)', () => {
      const out = generateCompletenessSection();
      expect(out).toContain('## Completeness Principle');
    });
  });

  describe('generateConfusionProtocol', () => {
    test('default: emits full section', () => {
      const out = generateConfusionProtocol(makeCtx('default'));
      expect(out).toContain('## Confusion Protocol');
      expect(out).toContain('high-stakes ambiguity');
    });

    test('terse: returns empty string', () => {
      expect(generateConfusionProtocol(makeCtx('terse'))).toBe('');
    });

    test('no ctx arg: defaults to non-terse', () => {
      expect(generateConfusionProtocol()).toContain('## Confusion Protocol');
    });
  });

  describe('generateContextHealth', () => {
    test('default: emits full section', () => {
      const out = generateContextHealth(makeCtx('default'));
      expect(out).toContain('## Context Health');
      expect(out).toContain('PROGRESS');
    });

    test('terse: returns empty string', () => {
      expect(generateContextHealth(makeCtx('terse'))).toBe('');
    });
  });
});

describe('terse build — generatePreamble integration', () => {
  test('default tier-2 preamble includes all 4 terse-gated sections', () => {
    const out = generatePreamble(makeCtx('default', 2));
    expect(out).toContain('## Writing Style');
    expect(out).toContain('## Completeness Principle');
    expect(out).toContain('## Confusion Protocol');
    expect(out).toContain('## Context Health');
  });

  test('terse tier-2 preamble drops 3 of 4 sections + collapses Writing Style', () => {
    const out = generatePreamble(makeCtx('terse', 2));
    // Writing Style heading still present (collapsed to one line)
    expect(out).toContain('## Writing Style');
    expect(out).toContain('Terse mode (build-time)');
    // Three sections dropped entirely
    expect(out).not.toContain('## Completeness Principle');
    expect(out).not.toContain('## Confusion Protocol');
    expect(out).not.toContain('## Context Health');
  });

  test('terse preamble is measurably smaller', () => {
    const defaultLen = generatePreamble(makeCtx('default', 2)).length;
    const terseLen = generatePreamble(makeCtx('terse', 2)).length;
    // Saving roughly 2-4 KB across the 4 sections; assert at least 1 KB saved.
    expect(defaultLen - terseLen).toBeGreaterThan(1024);
  });

  test('terse preamble at tier 1 is identical to default (terse only affects tier-2+ sections)', () => {
    // Tier 1 doesn't include the 4 terse-gated sections in the first place.
    const defaultT1 = generatePreamble(makeCtx('default', 1));
    const terseT1 = generatePreamble(makeCtx('terse', 1));
    expect(terseT1).toBe(defaultT1);
  });

  test('explainLevel undefined behaves as default', () => {
    const undefinedOut = generatePreamble(makeCtx(undefined, 2));
    const defaultOut = generatePreamble(makeCtx('default', 2));
    expect(undefinedOut).toBe(defaultOut);
  });
});
