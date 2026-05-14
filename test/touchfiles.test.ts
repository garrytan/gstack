/**
 * Unit tests for diff-based test selection.
 * Free (no API calls), runs with `bun test`.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  matchGlob,
  selectTests,
  detectBaseBranch,
  E2E_TOUCHFILES,
  E2E_TIERS,
  LLM_JUDGE_TOUCHFILES,
  GLOBAL_TOUCHFILES,
} from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');

// --- matchGlob ---

describe('matchGlob', () => {
  test('** matches any depth of path segments', () => {
    expect(matchGlob('browse/src/commands.ts', 'browse/src/**')).toBe(true);
    expect(matchGlob('browse/src/deep/nested/file.ts', 'browse/src/**')).toBe(true);
    expect(matchGlob('browse/src/cli.ts', 'browse/src/**')).toBe(true);
  });

  test('** does not match unrelated paths', () => {
    expect(matchGlob('browse/src/commands.ts', 'qa/**')).toBe(false);
    expect(matchGlob('review/SKILL.md', 'qa/**')).toBe(false);
  });

  test('exact match works', () => {
    expect(matchGlob('SKILL.md', 'SKILL.md')).toBe(true);
    expect(matchGlob('SKILL.md.tmpl', 'SKILL.md')).toBe(false);
    expect(matchGlob('qa/SKILL.md', 'SKILL.md')).toBe(false);
  });

  test('* matches within a single segment', () => {
    expect(matchGlob('test/fixtures/review-eval-enum.rb', 'test/fixtures/review-eval-enum*.rb')).toBe(true);
    expect(matchGlob('test/fixtures/review-eval-enum-diff.rb', 'test/fixtures/review-eval-enum*.rb')).toBe(true);
    expect(matchGlob('test/fixtures/review-eval-vuln.rb', 'test/fixtures/review-eval-enum*.rb')).toBe(false);
  });

  test('dots in patterns are escaped correctly', () => {
    expect(matchGlob('SKILL.md', 'SKILL.md')).toBe(true);
    expect(matchGlob('SKILLxmd', 'SKILL.md')).toBe(false);
  });

  test('** at end matches files in the directory', () => {
    expect(matchGlob('qa/SKILL.md', 'qa/**')).toBe(true);
    expect(matchGlob('qa/SKILL.md.tmpl', 'qa/**')).toBe(true);
    expect(matchGlob('qa/templates/report.md', 'qa/**')).toBe(true);
  });
});

// --- selectTests ---

describe('selectTests', () => {
  test('browse/src change selects browse and qa tests', () => {
    const result = selectTests(['browse/src/commands.ts'], E2E_TOUCHFILES);
    expect(result.selected).toContain('browse-basic');
    expect(result.selected).toContain('browse-snapshot');
    expect(result.selected).toContain('qa-quick');
    expect(result.selected).toContain('qa-fix-loop');
    expect(result.selected).toContain('design-review-fix');
    expect(result.reason).toBe('diff');
    // Should NOT include unrelated tests
    expect(result.selected).not.toContain('plan-ceo-review');
    expect(result.selected).not.toContain('retro');
    expect(result.selected).not.toContain('document-release');
  });

  test('skill-specific change selects only that skill and related tests', () => {
    const result = selectTests(['plan-ceo-review/SKILL.md'], E2E_TOUCHFILES);
    expect(result.selected).toContain('plan-ceo-review');
    expect(result.selected).toContain('plan-ceo-review-selective');
    expect(result.selected).toContain('plan-ceo-review-benefits');
    expect(result.selected).toContain('plan-ceo-review-expansion-energy');
    expect(result.selected).toContain('autoplan-core');
    expect(result.selected).toContain('codex-offered-ceo-review');
    expect(result.selected).toContain('plan-ceo-review-format-mode');
    expect(result.selected).toContain('plan-ceo-review-format-approach');
    // v1.10.2.0 plan-mode handshake entries also depend on plan-ceo-review/**
    expect(result.selected).toContain('plan-ceo-review-plan-mode');
    expect(result.selected).toContain('plan-mode-no-op');
    expect(result.selected).toContain('e2e-harness-audit');
    expect(result.selected).toContain('plan-ceo-review-prosons-cadence');
    expect(result.selected).toContain('plan-review-prosons-format');
    expect(result.selected).toContain('plan-review-prosons-hardstop-neg');
    expect(result.selected).toContain('plan-review-prosons-neutral-neg');
    // v1.13.x real-PTY E2E batch entries that also depend on plan-ceo-review/**
    expect(result.selected).toContain('ask-user-question-format-pty');
    expect(result.selected).toContain('plan-ceo-mode-routing');
    expect(result.selected).toContain('autoplan-chain-pty');
    // Per-finding count + review-report-at-bottom (v1.21.x)
    expect(result.selected).toContain('plan-ceo-finding-count');
    // v1.22+ AskUserQuestion-blocked regression: auto-decide-preserved
    // also depends on plan-ceo-review/** (autoplan-auto-mode test was
    // removed in v1.28 — see commit message for the rationale).
    expect(result.selected).toContain('auto-decide-preserved');
    // v1.27+ gate-tier reviewCount-floor regression for transcript bug
    expect(result.selected).toContain('plan-ceo-finding-floor');
    expect(result.selected.length).toBe(21);
    expect(result.skipped.length).toBe(Object.keys(E2E_TOUCHFILES).length - 21);
  });

  test('global touchfile triggers ALL tests', () => {
    const result = selectTests(['test/helpers/session-runner.ts'], E2E_TOUCHFILES);
    expect(result.selected.length).toBe(Object.keys(E2E_TOUCHFILES).length);
    expect(result.skipped.length).toBe(0);
    expect(result.reason).toContain('global');
  });

  test('gen-skill-docs.ts is a scoped touchfile, not global', () => {
    const result = selectTests(['scripts/gen-skill-docs.ts'], E2E_TOUCHFILES);
    // Should select tests that list gen-skill-docs.ts in their touchfiles, not ALL tests
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeLessThan(Object.keys(E2E_TOUCHFILES).length);
    expect(result.reason).toBe('diff');
    // Should include tests that depend on gen-skill-docs.ts
    expect(result.selected).toContain('skillmd-setup-discovery');
    expect(result.selected).toContain('session-awareness');
    expect(result.selected).toContain('journey-ideation');
    // Should NOT include tests that don't depend on it
    expect(result.selected).not.toContain('retro');
    expect(result.selected).not.toContain('cso-full-audit');
  });

  test('unrelated file selects nothing', () => {
    const result = selectTests(['README.md'], E2E_TOUCHFILES);
    expect(result.selected).toEqual([]);
    expect(result.skipped.length).toBe(Object.keys(E2E_TOUCHFILES).length);
  });

  test('empty changed files selects nothing', () => {
    const result = selectTests([], E2E_TOUCHFILES);
    expect(result.selected).toEqual([]);
  });

  test('multiple changed files union their selections', () => {
    const result = selectTests(
      ['plan-ceo-review/SKILL.md', 'retro/SKILL.md.tmpl'],
      E2E_TOUCHFILES,
    );
    expect(result.selected).toContain('plan-ceo-review');
    expect(result.selected).toContain('plan-ceo-review-selective');
    expect(result.selected).toContain('retro');
    expect(result.selected).toContain('retro-base-branch');
    // Also selects journey routing tests (*/SKILL.md.tmpl matches retro/SKILL.md.tmpl)
    expect(result.selected.length).toBeGreaterThanOrEqual(4);
  });

  test('works with LLM_JUDGE_TOUCHFILES', () => {
    const result = selectTests(['qa/SKILL.md'], LLM_JUDGE_TOUCHFILES);
    expect(result.selected).toContain('qa/SKILL.md workflow');
    expect(result.selected).toContain('qa/SKILL.md health rubric');
    expect(result.selected).toContain('qa/SKILL.md anti-refusal');
    expect(result.selected.length).toBe(3);
  });

  test('SKILL.md.tmpl root template selects root-dependent tests and routing tests', () => {
    const result = selectTests(['SKILL.md.tmpl'], E2E_TOUCHFILES);
    // Should select the 7 tests that depend on root SKILL.md
    expect(result.selected).toContain('skillmd-setup-discovery');
    expect(result.selected).toContain('session-awareness');
    expect(result.selected).toContain('session-awareness');
    // Also selects journey routing tests (SKILL.md.tmpl in their touchfiles)
    expect(result.selected).toContain('journey-ideation');
    // Should NOT select unrelated non-routing tests
    expect(result.selected).not.toContain('plan-ceo-review');
    expect(result.selected).not.toContain('retro');
  });

  test('global touchfiles work for LLM-judge tests too', () => {
    const result = selectTests(['test/helpers/session-runner.ts'], LLM_JUDGE_TOUCHFILES);
    expect(result.selected.length).toBe(Object.keys(LLM_JUDGE_TOUCHFILES).length);
  });
});

// --- detectBaseBranch ---

describe('detectBaseBranch', () => {
  test('detects local main branch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touchfiles-test-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'test.txt'), 'hello\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'init']);

    const result = detectBaseBranch(dir);
    // Should find 'main' (or 'master' depending on git default)
    expect(result).toMatch(/^(main|master)$/);

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test('returns null for empty repo with no branches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touchfiles-test-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init']);
    // No commits = no branches
    const result = detectBaseBranch(dir);
    expect(result).toBeNull();

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test('returns null for non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touchfiles-test-'));
    const result = detectBaseBranch(dir);
    expect(result).toBeNull();

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});

// --- Completeness: every testName in skill-e2e-*.test.ts has a TOUCHFILES entry ---

describe('TOUCHFILES completeness', () => {
  test('every E2E testName has a TOUCHFILES entry', () => {
    // Read all split E2E test files
    const testDir = path.join(ROOT, 'test');
    const e2eFiles = fs.readdirSync(testDir).filter(f => f.startsWith('skill-e2e-') && f.endsWith('.test.ts'));
    let e2eContent = '';
    for (const f of e2eFiles) {
      e2eContent += fs.readFileSync(path.join(testDir, f), 'utf-8') + '\n';
    }

    // Extract all testName: 'value' entries
    const testNameRegex = /testName:\s*['"`]([^'"`]+)['"`]/g;
    const testNames: string[] = [];
    let match;
    while ((match = testNameRegex.exec(e2eContent)) !== null) {
      let name = match[1];
      // Handle template literals like `qa-${label}` — these expand to
      // qa-b6-static, qa-b7-spa, qa-b8-checkout
      if (name.includes('${')) continue; // skip template literals, check expanded forms below
      testNames.push(name);
    }

    // Add the template-expanded testNames from runPlantedBugEval calls
    const plantedBugRegex = /runPlantedBugEval\([^,]+,\s*[^,]+,\s*['"`]([^'"`]+)['"`]\)/g;
    while ((match = plantedBugRegex.exec(e2eContent)) !== null) {
      testNames.push(`qa-${match[1]}`);
    }

    expect(testNames.length).toBeGreaterThan(0);

    const missing = testNames.filter(name => !(name in E2E_TOUCHFILES));
    if (missing.length > 0) {
      throw new Error(
        `E2E tests missing TOUCHFILES entries: ${missing.join(', ')}\n` +
        `Add these to E2E_TOUCHFILES in test/helpers/touchfiles.ts`,
      );
    }
  });

  test('E2E_TIERS covers exactly the same tests as E2E_TOUCHFILES', () => {
    const touchfileKeys = new Set(Object.keys(E2E_TOUCHFILES));
    const tierKeys = new Set(Object.keys(E2E_TIERS));

    const missingFromTiers = [...touchfileKeys].filter(k => !tierKeys.has(k));
    const extraInTiers = [...tierKeys].filter(k => !touchfileKeys.has(k));

    if (missingFromTiers.length > 0) {
      throw new Error(
        `E2E tests missing TIER entries: ${missingFromTiers.join(', ')}\n` +
        `Add these to E2E_TIERS in test/helpers/touchfiles.ts`,
      );
    }
    if (extraInTiers.length > 0) {
      throw new Error(
        `E2E_TIERS has extra entries not in E2E_TOUCHFILES: ${extraInTiers.join(', ')}\n` +
        `Remove these from E2E_TIERS or add to E2E_TOUCHFILES`,
      );
    }
  });

  test('E2E_TIERS only contains valid tier values', () => {
    const validTiers = ['gate', 'periodic'];
    for (const [name, tier] of Object.entries(E2E_TIERS)) {
      if (!validTiers.includes(tier)) {
        throw new Error(`E2E_TIERS['${name}'] has invalid tier '${tier}'. Valid: ${validTiers.join(', ')}`);
      }
    }
  });

  test('every LLM-judge test has a TOUCHFILES entry', () => {
    const llmContent = fs.readFileSync(
      path.join(ROOT, 'test', 'skill-llm-eval.test.ts'),
      'utf-8',
    );

    // Extract test names from addTest({ name: '...' }) calls
    const nameRegex = /name:\s*['"`]([^'"`]+)['"`]/g;
    const testNames: string[] = [];
    let match;
    while ((match = nameRegex.exec(llmContent)) !== null) {
      testNames.push(match[1]);
    }

    // Deduplicate (some tests call addTest with the same name)
    const unique = [...new Set(testNames)];
    expect(unique.length).toBeGreaterThan(0);

    const missing = unique.filter(name => !(name in LLM_JUDGE_TOUCHFILES));
    if (missing.length > 0) {
      throw new Error(
        `LLM-judge tests missing TOUCHFILES entries: ${missing.join(', ')}\n` +
        `Add these to LLM_JUDGE_TOUCHFILES in test/helpers/touchfiles.ts`,
      );
    }
  });
});
