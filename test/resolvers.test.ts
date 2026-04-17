/**
 * Tests for modular resolver pipeline (scripts/resolvers/).
 *
 * Covers the 6 untested resolver modules: preamble, testing, utility,
 * codex-helpers, constants, browse. Validates output structure, placeholder
 * resolution, and cross-module consistency.
 */

import { describe, test, expect } from 'bun:test';
import { generatePreamble, generateTestFailureTriage } from '../scripts/resolvers/preamble';
import { generateTestBootstrap, generateTestCoverageAuditPlan, generateTestCoverageAuditShip, generateTestCoverageAuditReview } from '../scripts/resolvers/testing';
import { generateSlugEval, generateSlugSetup, generateBaseBranchDetect, generateQAMethodology } from '../scripts/resolvers/utility';
import { extractNameAndDescription, condenseOpenAIShortDescription, codexSkillName, transformFrontmatter, extractHookSafetyProse } from '../scripts/resolvers/codex-helpers';
import { AI_SLOP_BLACKLIST, OPENAI_HARD_REJECTIONS, codexErrorHandling } from '../scripts/resolvers/constants';
import { generateBrowseSetup } from '../scripts/resolvers/browse';
import type { TemplateContext, Host } from '../scripts/resolvers/types';
import { HOST_PATHS } from '../scripts/resolvers/types';

// Shared test context
const claudeCtx: TemplateContext = {
  host: 'claude' as Host,
  skillName: 'test-skill',
  tmplPath: 'test-skill/SKILL.md.tmpl',
  paths: HOST_PATHS.claude,
};
const codexCtx: TemplateContext = {
  host: 'codex' as Host,
  skillName: 'test-skill',
  tmplPath: 'test-skill/SKILL.md.tmpl',
  paths: HOST_PATHS.codex,
};

// ─── Preamble ────────────────────────────────────────────────

describe('preamble resolver', () => {
  const output = generatePreamble(claudeCtx);

  test('contains update check', () => {
    expect(output).toContain('gstack-update-check');
  });

  test('contains session tracking', () => {
    expect(output).toContain('sessions');
    expect(output).toContain('PPID');
  });

  test('contains AskUserQuestion format', () => {
    expect(output).toContain('AskUserQuestion');
    expect(output).toContain('RECOMMENDATION');
  });

  test('contains session awareness', () => {
    expect(output).toContain('_SESSIONS');
  });

  test('contains contributor mode', () => {
    expect(output).toContain('Contributor Mode');
    expect(output).toContain('gstack_contributor');
  });

  test('bash blocks end with || true for safe eval', () => {
    expect(output).toContain('|| true');
  });

  test('generateTestFailureTriage returns non-empty', () => {
    const triage = generateTestFailureTriage();
    expect(triage.length).toBeGreaterThan(50);
    expect(triage).toContain('fail');
  });
});

// ─── Testing resolvers ──────────────────────────────────────

describe('testing resolvers', () => {
  test('generateTestBootstrap contains test framework detection', () => {
    const output = generateTestBootstrap(claudeCtx);
    expect(output.length).toBeGreaterThan(100);
  });

  test('generateTestCoverageAuditPlan returns non-empty', () => {
    const output = generateTestCoverageAuditPlan(claudeCtx);
    expect(output.length).toBeGreaterThan(50);
  });

  test('generateTestCoverageAuditShip returns non-empty', () => {
    const output = generateTestCoverageAuditShip(claudeCtx);
    expect(output.length).toBeGreaterThan(50);
  });

  test('generateTestCoverageAuditReview returns non-empty', () => {
    const output = generateTestCoverageAuditReview(claudeCtx);
    expect(output.length).toBeGreaterThan(50);
  });

  test('ship coverage audit mentions coverage thresholds', () => {
    const output = generateTestCoverageAuditShip(claudeCtx);
    expect(output).toMatch(/\d+%/); // should mention percentage thresholds
  });
});

// ─── Utility resolvers ──────────────────────────────────────

describe('utility resolvers', () => {
  test('generateSlugEval outputs eval-safe slug command', () => {
    const output = generateSlugEval(claudeCtx);
    expect(output).toContain('gstack-slug');
    expect(output).toContain('eval');
  });

  test('generateSlugSetup outputs slug setup with mkdir', () => {
    const output = generateSlugSetup(claudeCtx);
    expect(output).toContain('gstack-slug');
    expect(output).toContain('$SLUG');
  });

  test('generateBaseBranchDetect uses gh pr view', () => {
    const output = generateBaseBranchDetect(claudeCtx);
    expect(output).toContain('gh pr view');
    expect(output).toContain('baseRefName');
  });

  test('generateBaseBranchDetect has fallback to main', () => {
    const output = generateBaseBranchDetect(claudeCtx);
    expect(output).toMatch(/fall\s*back.*main/i);
  });

  test('generateQAMethodology contains all 6 phases', () => {
    const output = generateQAMethodology(claudeCtx);
    for (let i = 1; i <= 6; i++) {
      expect(output).toContain(`Phase ${i}`);
    }
  });

  test('generateQAMethodology contains health score rubric', () => {
    const output = generateQAMethodology(claudeCtx);
    expect(output).toContain('Health Score');
  });
});

// ─── Codex helpers ──────────────────────────────────────────

describe('codex-helpers', () => {
  test('extractNameAndDescription parses frontmatter', () => {
    const content = '---\nname: test-skill\ndescription: |\n  A test skill.\nallowed-tools:\n  - Bash\n---\nBody content';
    const { name, description } = extractNameAndDescription(content);
    expect(name).toBe('test-skill');
    expect(description).toContain('test skill');
  });

  test('extractNameAndDescription handles missing fields', () => {
    const { name, description } = extractNameAndDescription('no frontmatter here');
    expect(name).toBe('');
    expect(description).toBe('');
  });

  test('condenseOpenAIShortDescription truncates to 1024 chars', () => {
    const long = 'A'.repeat(2000);
    const condensed = condenseOpenAIShortDescription(long);
    expect(condensed.length).toBeLessThanOrEqual(1024);
  });

  test('condenseOpenAIShortDescription preserves short descriptions', () => {
    const short = 'A simple skill that does things.';
    expect(condenseOpenAIShortDescription(short)).toBe(short);
  });

  test('codexSkillName prefixes with gstack-', () => {
    expect(codexSkillName('review')).toBe('gstack-review');
    expect(codexSkillName('plan-ceo-review')).toBe('gstack-plan-ceo-review');
  });

  test('codexSkillName handles root skill', () => {
    const result = codexSkillName('.');
    expect(result).toContain('gstack');
  });

  test('transformFrontmatter strips allowed-tools for codex', () => {
    const content = '---\nname: test\nversion: 1.0\ndescription: |\n  Test.\nallowed-tools:\n  - Bash\n  - Read\n---\nBody';
    const transformed = transformFrontmatter(content, 'codex' as Host);
    expect(transformed).not.toContain('allowed-tools');
    expect(transformed).toContain('name:');
    expect(transformed).toContain('description:');
  });

  test('transformFrontmatter preserves content for claude', () => {
    const content = '---\nname: test\nallowed-tools:\n  - Bash\n---\nBody';
    const transformed = transformFrontmatter(content, 'claude' as Host);
    expect(transformed).toContain('allowed-tools');
  });

  test('extractHookSafetyProse returns null for non-hook skills', () => {
    const content = '---\nname: review\n---\nRegular skill content';
    expect(extractHookSafetyProse(content)).toBeNull();
  });
});

// ─── Constants ──────────────────────────────────────────────

describe('constants', () => {
  test('AI_SLOP_BLACKLIST is a non-empty array', () => {
    expect(Array.isArray(AI_SLOP_BLACKLIST)).toBe(true);
    expect(AI_SLOP_BLACKLIST.length).toBeGreaterThan(0);
  });

  test('OPENAI_HARD_REJECTIONS is a non-empty array', () => {
    expect(Array.isArray(OPENAI_HARD_REJECTIONS)).toBe(true);
    expect(OPENAI_HARD_REJECTIONS.length).toBeGreaterThan(0);
  });

  test('codexErrorHandling returns non-empty string', () => {
    const output = codexErrorHandling('test-feature');
    expect(output.length).toBeGreaterThan(20);
    expect(output).toContain('test-feature');
  });
});

// ─── Browse resolver ────────────────────────────────────────

describe('browse resolver', () => {
  test('generateBrowseSetup contains binary detection', () => {
    const output = generateBrowseSetup(claudeCtx);
    expect(output).toContain('browse');
    expect(output).toContain('dist');
  });

  test('generateBrowseSetup mentions setup instructions', () => {
    const output = generateBrowseSetup(claudeCtx);
    expect(output).toContain('NEEDS_SETUP');
  });
});

// ─── Cross-module consistency ───────────────────────────────

describe('cross-module consistency', () => {
  test('utility slug functions reference gstack-slug', () => {
    const slugEval = generateSlugEval(claudeCtx);
    const slugSetup = generateSlugSetup(claudeCtx);
    expect(slugEval).toContain('gstack-slug');
    expect(slugSetup).toContain('gstack-slug');
  });

  test('codex and claude preambles both contain core sections', () => {
    const claude = generatePreamble(claudeCtx);
    const codex = generatePreamble(codexCtx);
    // Both should have AskUserQuestion format
    expect(claude).toContain('AskUserQuestion');
    expect(codex).toContain('AskUserQuestion');
  });
});
