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

import { readWorkflowExcerpt } from './helpers/workflow-excerpt';
import { sharedLibsPlanExcerpt } from './helpers/shared-libs-plan-excerpt';

const ROOT = path.resolve(import.meta.dir, '..');

function registeredJudgeTestNames(source: string): string[] {
  // Inspect registrations, not arbitrary `name` fields such as Error.name.
  const registrations = [...source.matchAll(/^\s*testIfSelected\s*\(/gm)];
  const names = [...source.matchAll(/^\s*testIfSelected\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*,/gm)]
    .map(match => match[2]);
  if (names.length !== registrations.length) {
    throw new Error('LLM-judge test registrations must use literal case names for the TOUCHFILES inventory');
  }
  return [...new Set(names)];
}

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
  test('learnings rendering selects the Eng workflow consumers without unrelated review cases', () => {
    expect(fs.readFileSync(path.join(ROOT, 'plan-eng-review/sections/review-sections.md.tmpl'), 'utf8'))
      .toContain('{{LEARNINGS_SEARCH}}');
    const consumers = selectTests(['plan-eng-review/sections/review-sections.md'], E2E_TOUCHFILES).selected
      // These cases use an outside-only/Code Quality excerpt or descriptive metadata.
      .filter(id => !['outside-plan-disabled-no-fallback', 'plan-ceo-review-prosons-cadence',
        'plan-review-prosons-format', 'shared-libs-plan-callers'].includes(id));
    const existing = ['learnings-show', 'codex-plan-ceo-format-mode', 'codex-plan-ceo-format-approach',
      'codex-plan-eng-format-coverage', 'codex-plan-eng-format-kind'];
    const result = selectTests(['scripts/resolvers/learnings.ts'], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual([...new Set([...consumers, ...existing])].sort());
    expect(result.selected).toContain('plan-eng-review');
    expect(result.selected).toContain('plan-eng-finding-count');
    expect(result.selected).not.toContain('plan-ceo-review-prosons-cadence');
    expect(result.selected).not.toContain('outside-plan-disabled-no-fallback');
  });

  test('learnings rendering selects the Eng judge that consumes the changed instruction', () => {
    const result = selectTests(['scripts/resolvers/learnings.ts'], LLM_JUDGE_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected).toEqual(['plan-eng-review/SKILL.md sections']);
  });

  test.each(['bin/gstack-paths', 'bin/gstack-slug', 'scripts/resolvers/design.ts'])(
    'Design artifact dependencies select their native consumers: %s', (file) => {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.reason).toBe('diff');
      expect(result.selected).toContain('plan-design-finding-count');
      expect(result.selected).toContain('plan-design-with-ui-scope');
      if (file !== 'bin/gstack-slug') expect(result.selected).toContain('autoplan-chain-pty');
      expect(E2E_TIERS['plan-design-finding-count']).toBe('periodic');
      expect(E2E_TIERS['plan-design-with-ui-scope']).toBe('gate');
      expect(E2E_TIERS['autoplan-chain-pty']).toBe('periodic');
    },
  );

  test.each(['test/helpers/owned-claude-transcript.ts', 'test/helpers/plan-skill-completion.ts'])(
    'native completion changes select the Design UI gate: %s', (file) => {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.selected).toContain('plan-design-with-ui-scope');
      expect(E2E_TIERS['plan-design-with-ui-scope']).toBe('gate');
    },
  );

  test.each(['lib/cso/cli.ts', 'lib/cso/state.ts', 'test/cso-cli.test.ts', 'test/cso-snapshot-state.test.ts'])(
    'CSO runtime and report regressions select all three audit cases: %s', (file) => {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.reason).toBe('diff');
      expect(result.selected.sort()).toEqual(['cso-diff-mode', 'cso-full-audit', 'cso-infra-scope']);
      expect(E2E_TIERS['cso-diff-mode']).toBe('gate');
      expect(E2E_TIERS['cso-full-audit']).toBe('periodic');
      expect(E2E_TIERS['cso-infra-scope']).toBe('periodic');
    },
  );

  test.each(['lib/redact-engine.ts', 'lib/redact-patterns.ts'])(
    'shared redaction changes retain CSO audit consumers: %s', (file) => {
      const result = selectTests([file], E2E_TOUCHFILES);
      for (const id of ['cso-diff-mode', 'cso-full-audit', 'cso-infra-scope']) {
        expect(result.selected).toContain(id);
      }
    },
  );

  test.each(['test/helpers/coverage-audit.ts', 'test/coverage-audit.test.ts'])(
    'coverage-audit validation changes select all three gate cases: %s', (file) => {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.selected.sort()).toEqual(['plan-eng-coverage-audit', 'review-coverage-audit', 'ship-coverage-audit']);
      expect(result.selected.every(id => E2E_TIERS[id] === 'gate')).toBe(true);
    },
  );

  test('testing resolver source selects the same E2E consumers as its generated content', () => {
    const consumers = [
      ['plan-eng-review/sections/review-sections.md', 'TEST_COVERAGE_AUDIT_PLAN'],
      ['ship/sections/tests.md', 'TEST_BOOTSTRAP'],
      ['ship/sections/test-coverage.md', 'TEST_COVERAGE_AUDIT_SHIP'],
      ['qa/sections/test-bootstrap.md', 'TEST_BOOTSTRAP'],
      ['design-review/SKILL.md', 'TEST_BOOTSTRAP'],
    ];
    for (const [output, token] of consumers) {
      expect(fs.readFileSync(path.join(ROOT, `${output}.tmpl`), 'utf8')).toContain(`{{${token}}}`);
    }
    const generated = selectTests(consumers.map(([output]) => output), E2E_TOUCHFILES);
    // These two CEO-format cases already depend on every resolver through
    // scripts/resolvers/**; keep that existing selection alongside consumers.
    // The bounded Code Quality fixture stops before Test review.
    const expected = [...new Set([...generated.selected.filter(id => id !== 'shared-libs-plan-callers'),
      'codex-plan-ceo-format-mode', 'codex-plan-ceo-format-approach',
    ])].sort();
    const actual = selectTests(['scripts/resolvers/testing.ts'], E2E_TOUCHFILES);
    expect(actual.reason).toBe('diff');
    expect(actual.selected.sort()).toEqual(expected);
    for (const id of ['plan-eng-finding-count', 'plan-eng-multi-finding-batching',
      'autoplan-chain-pty', 'plan-eng-review-format-coverage', 'ship-section-loading', 'qa-fix-loop']) {
      expect(actual.selected).toContain(id);
      expect(E2E_TIERS[id]).toBe('periodic');
    }
    for (const id of ['plan-eng-coverage-audit', 'ship-coverage-audit']) {
      expect(actual.selected).toContain(id);
      expect(E2E_TIERS[id]).toBe('gate');
    }
    for (const unrelated of ['browse-basic', 'retro', 'office-hours-section-loading', 'review-coverage-audit']) {
      expect(actual.selected).not.toContain(unrelated);
    }
  });

  test('testing resolver source selects only judges that consume its generated workflow text', () => {
    const result = selectTests(['scripts/resolvers/testing.ts'], LLM_JUDGE_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected.sort()).toEqual(['plan-eng-review/SKILL.md sections', 'ship/SKILL.md workflow']);
  });

  test('bounded shared-code planning selects its consumed resolvers, excluding other Eng sections', () => {
    const entrypoint = fs.readFileSync(path.join(ROOT, 'plan-eng-review/SKILL.md'), 'utf8');
    const review = fs.readFileSync(path.join(ROOT, 'plan-eng-review/sections/review-sections.md'), 'utf8');
    const excerpt = sharedLibsPlanExcerpt(entrypoint, review);
    for (const [start, end] of [
      ['## Prior Learnings', '## Retrospective learning'],
      ['### 3. Test review', '### 4. Performance review'],
    ]) {
      const begin = review.indexOf(start), finish = review.indexOf(end, begin);
      expect(begin).toBeGreaterThan(0);
      expect(finish).toBeGreaterThan(begin);
      const changed = review.slice(0, begin + start.length) + '\nChanged excluded instructions.\n' + review.slice(finish);
      expect(sharedLibsPlanExcerpt(entrypoint, changed)).toBe(excerpt);
    }
    for (const source of ['scripts/resolvers/learnings.ts', 'scripts/resolvers/testing.ts']) {
      expect(selectTests([source], E2E_TOUCHFILES).selected).not.toContain('shared-libs-plan-callers');
    }
    expect(excerpt).toContain('## Confidence Calibration');
    expect(excerpt).toContain('## AskUserQuestion Format');
    expect(excerpt).toContain('### Shared-code evaluation rubric');
    for (const source of ['scripts/resolvers/confidence.ts',
      'scripts/resolvers/preamble/generate-ask-user-format.ts', 'scripts/resolvers/shared-libs.ts',
      'test/helpers/shared-libs-plan-excerpt.ts']) {
      expect(selectTests([source], E2E_TOUCHFILES).selected).toContain('shared-libs-plan-callers');
    }
  });

  test.each([
    ['plan-eng-review/sections/review-sections.md', 'plan-eng-review/SKILL.md sections',
      'plan-eng-review/SKILL.md', '## Scope gate', '## Section self-check', '### REGRESSION RULE (mandatory)'],
    ['ship/sections/tests.md', 'ship/SKILL.md workflow',
      'ship/SKILL.md', '# Ship:', '## Important Rules', '## Test Framework Bootstrap'],
    ['ship/sections/test-coverage.md', 'ship/SKILL.md workflow',
      'ship/SKILL.md', '# Ship:', '## Important Rules', '### REGRESSION RULE (mandatory)'],
    ['plan-design-review/sections/review-sections.md', 'plan-design-review/SKILL.md passes',
      'plan-design-review/SKILL.md', '## Review Sections', '## CRITICAL RULE',
      '## Review Sections (7 passes, after scope is agreed)'],
  ])('expanded judge content remains selected by its section alone: %s', (file, judge, skill, start, end, marker) => {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^<!--[^\n]*-->\n/gm, '').trim();
    const paragraph = body.split(`${marker}\n\n`)[1]?.split('\n\n')[0];
    expect(paragraph?.length).toBeGreaterThan(100);
    expect(readWorkflowExcerpt(skill, start, end)).toContain(`${marker}\n\n${paragraph}`);
    for (const changed of [file, `${file}.tmpl`]) {
      expect(selectTests([changed], LLM_JUDGE_TOUCHFILES).selected).toEqual([judge]);
    }
  });

  test.each(['scripts/resolvers/design.ts', 'scripts/resolvers/review.ts'])(
    'Design rendering source selects its workflow judge: %s', (file) => {
      const result = selectTests([file], LLM_JUDGE_TOUCHFILES);
      expect(result.reason).toBe('diff');
      expect(result.selected).toContain('plan-design-review/SKILL.md passes');
    });

  test('the shared recording lifecycle selects every bounded attempt', () => {
    const result = selectTests(['test/helpers/office-hours-attempt.ts'], E2E_TOUCHFILES);
    const expected = {
      'office-hours-forcing-energy': 'periodic',
      'office-hours-builder-wildness': 'periodic',
      'office-hours-brain-writeback': 'periodic',
      'plan-design-review-plan-mode': 'periodic',
      'plan-ceo-review-format-mode': 'periodic',
      'plan-ceo-review-format-approach': 'periodic',
      'plan-eng-review-format-coverage': 'periodic',
      'plan-eng-review-format-kind': 'periodic',
      'plan-ceo-review-prosons-cadence': 'periodic',
      'plan-review-prosons-format': 'periodic',
      'plan-review-prosons-hardstop-neg': 'periodic',
      'plan-review-prosons-neutral-neg': 'periodic',
      'setup-gbrain-bad-token': 'periodic',
      'setup-gbrain-path4-local-pglite': 'periodic',
      'setup-gbrain-remote': 'periodic',
      'review-army-red-team': 'periodic',
      'review-coverage-audit': 'gate',
      'plan-eng-coverage-audit': 'gate',
      'ship-coverage-audit': 'gate',
      'plan-review-report': 'gate',
    };
    expect(result.selected.sort()).toEqual(Object.keys(expected).sort());
    for (const [id, tier] of Object.entries(expected)) expect(E2E_TIERS[id]).toBe(tier);
  });

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

  test('aside resolver change selects the Aside-driven skill tests', () => {
    const result = selectTests(['scripts/resolvers/aside.ts'], E2E_TOUCHFILES);
    expect(result.selected).toContain('aside-browse-basic');
    expect(result.selected).toContain('aside-browse-flow');
    expect(result.selected).toContain('qa-quick');
    expect(result.selected).toContain('qa-fix-loop');
    expect(result.selected).toContain('design-review-fix');
    expect(result.reason).toBe('diff');
    expect(result.selected).not.toContain('plan-ceo-review');
    expect(result.selected).not.toContain('retro');
  });

  test('mode-question capture dependencies select its native gate', () => {
    for (const file of [
      'test/auq-mode-capture.test.ts', 'test/skill-ceo-section-ordering.test.ts',
      'test/helpers/agent-sdk-runner.ts', 'test/helpers/auq-native-capture.ts',
      'test/helpers/hermetic-env.ts', 'test/helpers/eval-store.ts',
      'lib/claude-bin.ts', 'test/workflow-excerpt.test.ts',
    ]) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toContain('auq-format-gate');
    }
  });

  test('shared-code evidence regressions select their consuming evaluations', () => {
    expect(selectTests(['test/fixtures/shared-libs-readonly-substitution-ci16358.json'], E2E_TOUCHFILES).selected.sort())
      .toEqual(['shared-libs-codex-read-only', 'shared-libs-opportunity-judgment', 'shared-libs-pr-coverage',
        'shared-libs-read-only', 'shared-libs-unsupported-git'].sort());
    for (const file of ['test/helpers/shared-libs-review-start-evidence.ts', 'test/shared-libs-review-start-evidence.test.ts',
      'test/fixtures/shared-libs-review-start-public.json',
      'test/fixtures/shared-libs-revalidation-max-turns-public.json']) {
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['shared-libs-review-revalidation']);
    }
    const pathCases = ['shared-libs-review-path-eligibility', 'shared-libs-review-index-flags',
      'shared-libs-review-prior-coverage'];
    expect(selectTests(['test/shared-libs-revalidation-prompt.test.ts'], E2E_TOUCHFILES).selected.sort())
      .toEqual([...pathCases, 'shared-libs-review-revalidation'].sort());
    expect(selectTests(['test/fixtures/shared-libs-index-flags-skip-question.json'], E2E_TOUCHFILES).selected.sort())
      .toEqual([...pathCases, 'shared-libs-review-revalidation', 'shared-libs-review-lifecycle'].sort());
    expect(selectTests(['test/fixtures/shared-libs-paths-max-turns-public.json'], E2E_TOUCHFILES).selected)
      .toEqual(['shared-libs-review-index-flags']);
  });

  test('skill-specific change selects only that skill and related tests', () => {
    const result = selectTests(['plan-ceo-review/SKILL.md'], E2E_TOUCHFILES);
    expect(result.selected).toContain('plan-ceo-review');
    expect(result.selected).toContain('plan-ceo-review-selective');
    expect(result.selected).toContain('plan-ceo-review-benefits');
    expect(result.selected).toContain('plan-ceo-review-expansion-energy');
    expect(result.selected).toContain('codex-offered-ceo-review');
    expect(result.selected).toContain('plan-ceo-review-format-mode');
    expect(result.selected).toContain('plan-ceo-review-format-approach');
    // v1.10.2.0 plan-mode handshake entries also depend on plan-ceo-review/**
    expect(result.selected).toContain('plan-ceo-review-plan-mode');
    expect(result.selected).toContain('plan-mode-no-op');
    expect(result.selected).toContain('plan-ceo-review-prosons-cadence');
    expect(result.selected).toContain('plan-review-prosons-format');
    expect(result.selected).toContain('plan-review-prosons-hardstop-neg');
    expect(result.selected).toContain('plan-review-prosons-neutral-neg');
    // v1.13.x real-PTY E2E batch entries that also depend on plan-ceo-review/**
    expect(result.selected).toContain('auq-format-gate');
    expect(result.selected).toContain('plan-ceo-mode-routing');
    expect(result.selected).toContain('autoplan-chain-pty');
    // The dual-voice fixture loads the CEO skill as its Phase 1 dependency.
    expect(result.selected).toContain('autoplan-dual-voice');
    // Per-finding count + review-report-at-bottom (v1.21.x)
    expect(result.selected).toContain('plan-ceo-finding-count');
    // v1.22+ AskUserQuestion-blocked regression: auto-decide-preserved
    // also depends on plan-ceo-review/** (autoplan-auto-mode test was
    // removed in v1.28 — see commit message for the rationale).
    expect(result.selected).toContain('auto-decide-preserved');
    // v1.27+ gate-tier reviewCount-floor regression for transcript bug
    expect(result.selected).toContain('plan-ceo-finding-floor');
    // garrytan/askuserquestion-split-on-overflow: split-overflow periodic
    // E2E test also depends on plan-ceo-review/** (5-option scope decision
    // regression for the "drop to fit 4 options" failure mode).
    expect(result.selected).toContain('plan-ceo-split-overflow');
    // v2 plan Phase B carve: the section-loading E2E depends on plan-ceo-review/**.
    expect(result.selected).toContain('plan-ceo-section-loading');
    expect(result.selected).toContain('codex-plan-ceo-format-mode');
    expect(result.selected).toContain('codex-plan-ceo-format-approach');
    expect(result.selected).toContain('outside-plan-disabled-no-fallback');
    expect(result.selected.length).toBe(25);
    expect(result.skipped.length).toBe(Object.keys(E2E_TOUCHFILES).length - 25);
  });

  test('global touchfile triggers ALL tests', () => {
    for (const file of ['test/helpers/session-runner.ts', 'scripts/test-strict-output.ts']) {
      const result = selectTests([file], E2E_TOUCHFILES);
      expect(result.selected.length).toBe(Object.keys(E2E_TOUCHFILES).length);
      expect(result.skipped.length).toBe(0);
      expect(result.reason).toContain('global');
    }
  });

  test.each([
    'test/helpers/hermetic-skill-runtime.ts',
    'test/hermetic-skill-runtime.test.ts',
    'lib/fs-atomic.ts',
  ])('live runtime dependency selects PTY consumers: %s', (file) => {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.reason).toBe('diff');
    expect(result.selected).toContain('autoplan-chain-pty');
    expect(result.selected).toContain('plan-ceo-mode-routing');
    expect(result.selected).not.toContain('codex-plan-ceo-format-mode');
    expect(result.selected).not.toContain('retro');
  });

  test('session tool isolation regression selects its capture workflows', () => {
    const result = selectTests(['test/session-runner-tools.test.ts'], E2E_TOUCHFILES);
    expect(result.selected.sort()).toEqual([
      'auq-format-gate', 'carve-section-loading', 'plan-ceo-section-loading', 'plan-design-review-plan-mode', 'ship-section-loading',
    ]);
    expect(result.reason).toBe('diff');
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

  test.each(['test/helpers/ceo-finding-fixture.ts', 'test/ceo-finding-fixture.test.ts', 'test/ceo-mode-routing-fixture.test.ts'])('mode input dependency selects its periodic eval: %s', file => {
    const result = selectTests([file], E2E_TOUCHFILES);
    expect(result.selected).toContain('plan-ceo-mode-routing');
    expect(result.reason).toBe('diff');
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

    const unique = registeredJudgeTestNames(llmContent);
    expect(unique).toHaveLength(26);

    const missing = unique.filter(name => !(name in LLM_JUDGE_TOUCHFILES));
    if (missing.length > 0) {
      throw new Error(
        `LLM-judge tests missing TOUCHFILES entries: ${missing.join(', ')}\n` +
        `Add these to LLM_JUDGE_TOUCHFILES in test/helpers/touchfiles.ts`,
      );
    }
  });

  test('judge inventory ignores error names and catches an unmapped registration', () => {
    const source = fs.readFileSync(path.join(ROOT, 'test', 'skill-llm-eval.test.ts'), 'utf8');
    const withUnmappedCase = `${source}\n
      Object.assign(new Error('deadline'), { name: 'WorkflowJudgeDeadline' });
      Object.assign(new Error('retry'), { name: 'WorkflowJudgeSuperseded' });
      testIfSelected('unmapped judge case', async () => {}, 120_000);
    `;
    const names = registeredJudgeTestNames(withUnmappedCase);
    expect(names).toHaveLength(27);
    expect(names.filter(name => !(name in LLM_JUDGE_TOUCHFILES))).toEqual(['unmapped judge case']);
  });

  test('judge inventory rejects dynamic registrations it cannot account for', () => {
    expect(() => registeredJudgeTestNames('testIfSelected(computedName, async () => {}, 120_000);'))
      .toThrow('must use literal case names');
  });
});

// --- dependency paths exist on disk ---
//
// The axis nobody guarded: a dep-list entry can point at a file that was
// deleted long ago (browse/src/sidebar-agent.ts sat in three entries for 48
// versions), and diff-based selection then silently never triggers those
// tests. Globs are skipped (they describe patterns, not files); every literal
// path must exist.

describe('touchfile dependency paths exist', () => {
  const allEntries: Array<[string, string]> = [];
  for (const [name, deps] of Object.entries(E2E_TOUCHFILES)) {
    for (const dep of deps) allEntries.push([name, dep]);
  }
  for (const [name, deps] of Object.entries(LLM_JUDGE_TOUCHFILES)) {
    for (const dep of deps) allEntries.push([name, dep]);
  }
  for (const dep of GLOBAL_TOUCHFILES) allEntries.push(['(global)', dep]);

  test('every non-glob dependency path exists', () => {
    const stale = allEntries
      .filter(([, dep]) => !dep.includes('*'))
      .filter(([, dep]) => !fs.existsSync(path.join(ROOT, dep)));
    if (stale.length > 0) {
      throw new Error(
        `Touchfile dep lists reference files that do not exist:\n` +
        stale.map(([name, dep]) => `  ${name} -> ${dep}`).join('\n') +
        `\nDelete or update these entries in test/helpers/touchfiles.ts — ` +
        `diff-based selection silently skips tests whose deps are gone.`,
      );
    }
  });

  test('every glob dependency anchors to a directory that exists', () => {
    // Cheap sanity for globs, two shapes: 'dir/**' (prefix ends with '/')
    // must have the directory itself; 'dir/file-prefix*.ext' must have the
    // containing directory. Catches 'deleted-dir/**' rot without a full
    // filesystem walk; deliberately does not chase file-prefix staleness.
    const stale = allEntries
      .filter(([, dep]) => dep.includes('*'))
      .map(([name, dep]) => {
        const prefix = dep.split('*')[0];
        const anchor = prefix.endsWith('/') ? prefix.slice(0, -1) : path.dirname(prefix);
        return [name, dep, anchor] as const;
      })
      .filter(([, , anchor]) => anchor.length > 0 && anchor !== '.' && !fs.existsSync(path.join(ROOT, anchor)));
    if (stale.length > 0) {
      throw new Error(
        `Touchfile glob deps whose anchor directory does not exist:\n` +
        stale.map(([name, dep]) => `  ${name} -> ${dep}`).join('\n'),
      );
    }
  });
});

// --- Reverse invariant: every selection key names a LIVING test ---
// The forward invariants above catch stale dep PATHS; nothing caught stale
// KEYS. The 2026-08 audit found 15 phantom E2E keys (6 gate-tier) selecting
// tests that existed nowhere — the merge-blocking census counted work that
// could not run. A key earns its place by appearing as a quoted testName in
// a living paid test file; constructed names get a reasoned exception.

describe('reverse invariant — keys must name living paid tests', () => {
  const { isPaidTestFile } = require('./helpers/paid-test-set') as typeof import('./helpers/paid-test-set');

  /** Keys whose testNames are CONSTRUCTED at runtime (template literals), so
   *  a quoted-occurrence scan cannot see them. Each entry needs the file that
   *  constructs it. Shrink-only: prefer literal names in new tests. */
  const CONSTRUCTED_NAME_EXCEPTIONS: Record<string, string> = {};

  const paidSources: string[] = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'test'))) {
    const rel = `test/${name}`;
    if (!isPaidTestFile(rel)) continue;
    paidSources.push(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
  }

  const quotedSomewhere = (key: string): boolean =>
    paidSources.some((src) =>
      src.includes(`'${key}'`) || src.includes(`"${key}"`) || src.includes('`' + key + '`'));

  /** Clause (b) of liveness: constructed testNames (template literals) bind
   *  through SELF-REGISTRATION — the 2026-08 dep-list sweep put each test
   *  FILE into its key's dep list, and the parent mapper keeps a shard on
   *  that registration union. So a key is alive when its name is quoted in a
   *  paid file OR its dep list names an existing paid test file. */
  const registeredToLivingFile = (key: string): boolean =>
    (E2E_TOUCHFILES[key] ?? []).some((dep) =>
      /\.test\.ts$/.test(dep) && isPaidTestFile(dep) && fs.existsSync(path.join(ROOT, dep)));

  test('every E2E_TOUCHFILES key is declared in a living paid test file', () => {
    expect(paidSources.length).toBeGreaterThan(50); // scan-rot guard
    const phantoms = Object.keys(E2E_TOUCHFILES)
      .filter((key) => !(key in CONSTRUCTED_NAME_EXCEPTIONS))
      .filter((key) => !quotedSomewhere(key) && !registeredToLivingFile(key));
    expect(
      phantoms,
      `E2E_TOUCHFILES key(s) with NO declaring paid test — the census counts tests that cannot run. ` +
      `Delete the key (both maps) or implement the test:\n  ${phantoms.join('\n  ')}`,
    ).toEqual([]);
  });

  test('every LLM_JUDGE_TOUCHFILES key is declared in a living paid test file', () => {
    const phantoms = Object.keys(LLM_JUDGE_TOUCHFILES).filter((key) => !quotedSomewhere(key));
    expect(
      phantoms,
      `LLM_JUDGE_TOUCHFILES key(s) with NO declaring test:\n  ${phantoms.join('\n  ')}`,
    ).toEqual([]);
  });

  test('constructed-name exceptions stay live (files exist and construct them)', () => {
    const stale = Object.entries(CONSTRUCTED_NAME_EXCEPTIONS)
      .filter(([, file]) => !fs.existsSync(path.join(ROOT, file)));
    expect(stale.map(([k]) => k), 'exception points at a deleted file — remove the entry').toEqual([]);
  });
});
