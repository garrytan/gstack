/**
 * Diff-based test selection for E2E and LLM-judge evals.
 *
 * Each test declares which source files it depends on ("touchfiles").
 * The test runner checks `git diff` and only runs tests whose
 * dependencies were modified. Override with EVALS_ALL=1 to run everything.
 */

import { spawnSync } from 'child_process';

// --- Glob matching ---

/**
 * Match a file path against a glob pattern.
 * Supports:
 *   ** — match any number of path segments
 *   *  — match within a single segment (no /)
 */
export function matchGlob(file: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(file);
}

// --- Touchfile maps ---

/**
 * E2E test touchfiles — keyed by testName (the string passed to runSkillTest).
 * Each test lists the file patterns that, if changed, require the test to run.
 */
export const E2E_TOUCHFILES: Record<string, string[]> = {
  // Browse core (+ test-server dependency)
  'browse-basic':    ['browse/src/**', 'browse/test/test-server.ts'],
  'browse-snapshot': ['browse/src/**', 'browse/test/test-server.ts'],

  // SKILL.md setup + preamble (depend on ROOT SKILL.md + gen-skill-docs)
  'skillmd-setup-discovery':  ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'skillmd-no-local-binary':  ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'skillmd-outside-git':      ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],

  'contributor-mode':           ['SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'session-awareness':        ['SKILL.md', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],

  // QA (+ test-server dependency)
  'qa-quick':       ['qa/**', 'browse/src/**', 'browse/test/test-server.ts'],
  'qa-b6-static':   ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval.html', 'test/fixtures/qa-eval-ground-truth.json'],
  'qa-b7-spa':      ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-spa.html', 'test/fixtures/qa-eval-spa-ground-truth.json'],
  'qa-b8-checkout': ['qa/**', 'browse/src/**', 'browse/test/test-server.ts', 'test/helpers/llm-judge.ts', 'browse/test/fixtures/qa-eval-checkout.html', 'test/fixtures/qa-eval-checkout-ground-truth.json'],
  'qa-only-no-fix': ['qa-only/**', 'qa/templates/**'],
  'qa-fix-loop':    ['qa/**', 'browse/src/**', 'browse/test/test-server.ts'],
  'qa-bootstrap':   ['qa/**', 'ship/**'],

  // Review
  'review-sql-injection':     ['review/**', 'test/fixtures/review-eval-vuln.rb'],
  'review-enum-completeness': ['review/**', 'test/fixtures/review-eval-enum*.rb'],
  'review-base-branch':       ['review/**'],
  'review-design-lite':       ['review/**', 'test/fixtures/review-eval-design-slop.*'],

  // Office Hours
  'office-hours-spec-review':  ['office-hours/**', 'scripts/gen-skill-docs.ts'],

  // Plan reviews
  'plan-ceo-review':           ['plan-ceo-review/**'],
  'plan-ceo-review-selective': ['plan-ceo-review/**'],
  'plan-ceo-review-benefits':  ['plan-ceo-review/**', 'scripts/gen-skill-docs.ts'],
  'plan-eng-review':           ['plan-eng-review/**'],
  'plan-eng-review-artifact':  ['plan-eng-review/**'],
  'plan-review-report':        ['plan-eng-review/**', 'scripts/gen-skill-docs.ts'],

  // Codex offering verification
  'codex-offered-office-hours':  ['office-hours/**', 'scripts/gen-skill-docs.ts'],
  'codex-offered-ceo-review':    ['plan-ceo-review/**', 'scripts/gen-skill-docs.ts'],
  'codex-offered-design-review': ['plan-design-review/**', 'scripts/gen-skill-docs.ts'],
  'codex-offered-eng-review':    ['plan-eng-review/**', 'scripts/gen-skill-docs.ts'],

  // Ship
  'ship-base-branch': ['ship/**', 'bin/gstack-repo-mode'],
  'ship-local-workflow': ['ship/**', 'scripts/gen-skill-docs.ts'],

  // Retro
  'retro':             ['retro/**'],
  'retro-base-branch': ['retro/**'],

  // Global discover
  'global-discover':   ['bin/gstack-global-discover.ts', 'test/global-discover.test.ts'],

  // CSO
  'cso-full-audit':   ['cso/**'],
  'cso-diff-mode':    ['cso/**'],
  'cso-infra-scope':  ['cso/**'],

  // Document-release
  'document-release': ['document-release/**'],

  // Codex (Claude E2E — tests /codex skill via Claude)
  'codex-review': ['codex/**'],

  // Codex E2E (tests skills via Codex CLI + worktree)
  'codex-discover-skill':  ['codex/**', '.agents/skills/**', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts'],
  'codex-review-findings': ['review/**', '.agents/skills/gstack-review/**', 'codex/**', 'test/helpers/codex-session-runner.ts', 'lib/worktree.ts'],

  // Gemini E2E (tests skills via Gemini CLI + worktree)
  'gemini-discover-skill':  ['.agents/skills/**', 'test/helpers/gemini-session-runner.ts', 'lib/worktree.ts'],
  'gemini-review-findings': ['review/**', '.agents/skills/gstack-review/**', 'test/helpers/gemini-session-runner.ts', 'lib/worktree.ts'],


  // Coverage audit (shared fixture) + triage
  'ship-coverage-audit': ['ship/**', 'test/fixtures/coverage-audit-fixture.ts', 'bin/gstack-repo-mode'],
  'review-coverage-audit': ['review/**', 'test/fixtures/coverage-audit-fixture.ts'],
  'plan-eng-coverage-audit': ['plan-eng-review/**', 'test/fixtures/coverage-audit-fixture.ts'],
  'ship-triage': ['ship/**', 'bin/gstack-repo-mode'],

  // Design
  'design-consultation-core':       ['design-consultation/**', 'scripts/gen-skill-docs.ts', 'test/helpers/llm-judge.ts'],
  'design-consultation-existing':   ['design-consultation/**', 'scripts/gen-skill-docs.ts'],
  'design-consultation-research':   ['design-consultation/**', 'scripts/gen-skill-docs.ts'],
  'design-consultation-preview':    ['design-consultation/**', 'scripts/gen-skill-docs.ts'],
  'plan-design-review-plan-mode':   ['plan-design-review/**', 'scripts/gen-skill-docs.ts'],
  'plan-design-review-no-ui-scope': ['plan-design-review/**', 'scripts/gen-skill-docs.ts'],
  'design-review-fix':              ['design-review/**', 'browse/src/**', 'scripts/gen-skill-docs.ts'],

  // gstack-upgrade
  'gstack-upgrade-happy-path': ['gstack-upgrade/**'],

  // Deploy skills
  'land-and-deploy-workflow':   ['land-and-deploy/**', 'scripts/gen-skill-docs.ts'],
  'canary-workflow':            ['canary/**', 'browse/src/**'],
  'benchmark-workflow':         ['benchmark/**', 'browse/src/**'],
  'setup-deploy-workflow':      ['setup-deploy/**', 'scripts/gen-skill-docs.ts'],

  // Autoplan
  'autoplan-core':  ['autoplan/**', 'plan-ceo-review/**', 'plan-eng-review/**', 'plan-design-review/**'],

  // Skill routing — journey-stage tests (depend on ALL skill descriptions)
  'journey-ideation':       ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-plan-eng':       ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-think-bigger':   ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-debug':          ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-qa':             ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-code-review':    ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-ship':           ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-docs':           ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-retro':          ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-design-system':  ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'journey-visual-qa':      ['*/SKILL.md.tmpl', 'SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
};

/**
 * E2E test tiers — 'gate' blocks PRs, 'periodic' runs weekly/on-demand.
 * Must have exactly the same keys as E2E_TOUCHFILES.
 */
export const E2E_TIERS: Record<string, 'gate' | 'periodic'> = {
  // Browse core — gate (if browse breaks, everything breaks)
  'browse-basic': 'gate',
  'browse-snapshot': 'gate',

  // SKILL.md setup — gate (if setup breaks, no skill works)
  'skillmd-setup-discovery': 'gate',
  'skillmd-no-local-binary': 'gate',
  'skillmd-outside-git': 'gate',
  'contributor-mode': 'gate',
  'session-awareness': 'gate',

  // QA — gate for functional, periodic for quality/benchmarks
  'qa-quick': 'gate',
  'qa-b6-static': 'periodic',
  'qa-b7-spa': 'periodic',
  'qa-b8-checkout': 'periodic',
  'qa-only-no-fix': 'gate',     // CRITICAL guardrail: Edit tool forbidden
  'qa-fix-loop': 'periodic',
  'qa-bootstrap': 'gate',

  // Review — gate for functional/guardrails, periodic for quality
  'review-sql-injection': 'gate',     // Security guardrail
  'review-enum-completeness': 'gate',
  'review-base-branch': 'gate',
  'review-design-lite': 'periodic',   // 4/7 threshold is subjective
  'review-coverage-audit': 'gate',

  // Office Hours
  'office-hours-spec-review': 'gate',

  // Plan reviews — gate for cheap functional, periodic for Opus quality
  'plan-ceo-review': 'periodic',
  'plan-ceo-review-selective': 'periodic',
  'plan-ceo-review-benefits': 'gate',
  'plan-eng-review': 'periodic',
  'plan-eng-review-artifact': 'periodic',
  'plan-eng-coverage-audit': 'gate',
  'plan-review-report': 'gate',

  // Codex offering verification
  'codex-offered-office-hours': 'gate',
  'codex-offered-ceo-review': 'gate',
  'codex-offered-design-review': 'gate',
  'codex-offered-eng-review': 'gate',

  // Ship — gate (end-to-end ship path)
  'ship-base-branch': 'gate',
  'ship-local-workflow': 'gate',
  'ship-coverage-audit': 'gate',
  'ship-triage': 'gate',

  // Retro — gate for cheap branch detection, periodic for full Opus retro
  'retro': 'periodic',
  'retro-base-branch': 'gate',

  // Global discover
  'global-discover': 'gate',

  // CSO — gate for security guardrails, periodic for quality
  'cso-full-audit': 'gate',      // Hardcoded secrets detection
  'cso-diff-mode': 'gate',
  'cso-infra-scope': 'periodic',

  // Document-release — gate (CHANGELOG guardrail)
  'document-release': 'gate',

  // Codex — periodic (Opus, requires codex CLI)
  'codex-review': 'periodic',

  // Multi-AI — periodic (require external CLIs)
  'codex-discover-skill': 'periodic',
  'codex-review-findings': 'periodic',
  'gemini-discover-skill': 'periodic',
  'gemini-review-findings': 'periodic',

  // Design — gate for cheap functional, periodic for Opus/quality
  'design-consultation-core': 'periodic',
  'design-consultation-existing': 'periodic',
  'design-consultation-research': 'gate',
  'design-consultation-preview': 'gate',
  'plan-design-review-plan-mode': 'periodic',
  'plan-design-review-no-ui-scope': 'gate',
  'design-review-fix': 'periodic',

  // gstack-upgrade
  'gstack-upgrade-happy-path': 'gate',

  // Deploy skills
  'land-and-deploy-workflow': 'gate',
  'canary-workflow': 'gate',
  'benchmark-workflow': 'gate',
  'setup-deploy-workflow': 'gate',

  // Autoplan — periodic (not yet implemented)
  'autoplan-core': 'periodic',

  // Skill routing — periodic (LLM routing is non-deterministic)
  'journey-ideation': 'periodic',
  'journey-plan-eng': 'periodic',
  'journey-think-bigger': 'periodic',
  'journey-debug': 'periodic',
  'journey-qa': 'periodic',
  'journey-code-review': 'periodic',
  'journey-ship': 'periodic',
  'journey-docs': 'periodic',
  'journey-retro': 'periodic',
  'journey-design-system': 'periodic',
  'journey-visual-qa': 'periodic',
};

/**
 * LLM-judge test touchfiles — keyed by test description string.
 */
export const LLM_JUDGE_TOUCHFILES: Record<string, string[]> = {
  'command reference table':          ['SKILL.md', 'SKILL.md.tmpl', 'browse/src/commands.ts'],
  'snapshot flags reference':         ['SKILL.md', 'SKILL.md.tmpl', 'browse/src/snapshot.ts'],
  'browse/SKILL.md reference':        ['browse/SKILL.md', 'browse/SKILL.md.tmpl', 'browse/src/**'],
  'setup block':                      ['SKILL.md', 'SKILL.md.tmpl'],
  'regression vs baseline':           ['SKILL.md', 'SKILL.md.tmpl', 'browse/src/commands.ts', 'test/fixtures/eval-baselines.json'],
  'qa/SKILL.md workflow':             ['qa/SKILL.md', 'qa/SKILL.md.tmpl'],
  'qa/SKILL.md health rubric':        ['qa/SKILL.md', 'qa/SKILL.md.tmpl'],
  'qa/SKILL.md anti-refusal':         ['qa/SKILL.md', 'qa/SKILL.md.tmpl', 'qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl'],
  'cross-skill greptile consistency': ['review/SKILL.md', 'review/SKILL.md.tmpl', 'ship/SKILL.md', 'ship/SKILL.md.tmpl', 'review/greptile-triage.md', 'retro/SKILL.md', 'retro/SKILL.md.tmpl'],
  'baseline score pinning':           ['SKILL.md', 'SKILL.md.tmpl', 'test/fixtures/eval-baselines.json'],

  // Ship & Release
  'ship/SKILL.md workflow':               ['ship/SKILL.md', 'ship/SKILL.md.tmpl'],
  'document-release/SKILL.md workflow':   ['document-release/SKILL.md', 'document-release/SKILL.md.tmpl'],

  // Plan Reviews
  'plan-ceo-review/SKILL.md modes':       ['plan-ceo-review/SKILL.md', 'plan-ceo-review/SKILL.md.tmpl'],
  'plan-eng-review/SKILL.md sections':    ['plan-eng-review/SKILL.md', 'plan-eng-review/SKILL.md.tmpl'],
  'plan-design-review/SKILL.md passes':   ['plan-design-review/SKILL.md', 'plan-design-review/SKILL.md.tmpl'],

  // Design skills
  'design-review/SKILL.md fix loop':      ['design-review/SKILL.md', 'design-review/SKILL.md.tmpl'],
  'design-consultation/SKILL.md research': ['design-consultation/SKILL.md', 'design-consultation/SKILL.md.tmpl'],

  // Office Hours
  'office-hours/SKILL.md spec review':    ['office-hours/SKILL.md', 'office-hours/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],
  'office-hours/SKILL.md design sketch':  ['office-hours/SKILL.md', 'office-hours/SKILL.md.tmpl', 'scripts/gen-skill-docs.ts'],

  // Deploy skills
  'land-and-deploy/SKILL.md workflow':    ['land-and-deploy/SKILL.md', 'land-and-deploy/SKILL.md.tmpl'],
  'canary/SKILL.md monitoring loop':      ['canary/SKILL.md', 'canary/SKILL.md.tmpl'],
  'benchmark/SKILL.md perf collection':   ['benchmark/SKILL.md', 'benchmark/SKILL.md.tmpl'],
  'setup-deploy/SKILL.md platform setup': ['setup-deploy/SKILL.md', 'setup-deploy/SKILL.md.tmpl'],

  // Other skills
  'retro/SKILL.md instructions':          ['retro/SKILL.md', 'retro/SKILL.md.tmpl'],
  'qa-only/SKILL.md workflow':            ['qa-only/SKILL.md', 'qa-only/SKILL.md.tmpl'],
  'gstack-upgrade/SKILL.md upgrade flow': ['gstack-upgrade/SKILL.md', 'gstack-upgrade/SKILL.md.tmpl'],
};

/**
 * Changes to any of these files trigger ALL tests (both E2E and LLM-judge).
 *
 * Keep this list minimal — only files that genuinely affect every test.
 * Scoped dependencies (gen-skill-docs, llm-judge, test-server, worktree,
 * codex/gemini session runners) belong in individual test entries instead.
 */
export const GLOBAL_TOUCHFILES = [
  'test/helpers/session-runner.ts',  // All E2E tests use this runner
  'test/helpers/eval-store.ts',      // All E2E tests store results here
  'test/helpers/touchfiles.ts',      // Self-referential — reclassifying wrong is dangerous
];

// --- Base branch detection ---

/**
 * Detect the base branch by trying refs in order.
 * Returns the first valid ref, or null if none found.
 */
export function detectBaseBranch(cwd: string): string | null {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const result = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd, stdio: 'pipe', timeout: 3000,
    });
    if (result.status === 0) return ref;
  }
  return null;
}

/**
 * Get list of files changed between base branch and HEAD.
 */
export function getChangedFiles(baseBranch: string, cwd: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
    cwd, stdio: 'pipe', timeout: 5000,
  });
  if (result.status !== 0) return [];
  return result.stdout.toString().trim().split('\n').filter(Boolean);
}

// --- Test selection ---

/**
 * Select tests to run based on changed files.
 *
 * Algorithm:
 * 1. If any changed file matches a global touchfile → run ALL tests
 * 2. Otherwise, for each test, check if any changed file matches its patterns
 * 3. Return selected + skipped lists with reason
 */
export function selectTests(
  changedFiles: string[],
  touchfiles: Record<string, string[]>,
  globalTouchfiles: string[] = GLOBAL_TOUCHFILES,
): { selected: string[]; skipped: string[]; reason: string } {
  const allTestNames = Object.keys(touchfiles);

  // Global touchfile hit → run all
  for (const file of changedFiles) {
    if (globalTouchfiles.some(g => matchGlob(file, g))) {
      return { selected: allTestNames, skipped: [], reason: `global: ${file}` };
    }
  }

  // Per-test matching
  const selected: string[] = [];
  const skipped: string[] = [];
  for (const [testName, patterns] of Object.entries(touchfiles)) {
    const hit = changedFiles.some(f => patterns.some(p => matchGlob(f, p)));
    (hit ? selected : skipped).push(testName);
  }

  return { selected, skipped, reason: 'diff' };
}
