import { describe, test, expect } from 'bun:test';
import { COMMAND_DESCRIPTIONS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// Dynamic template discovery — matches the generator's findTemplates() behavior.
// New skills automatically get test coverage without updating a static list.
const ALL_SKILLS = (() => {
  const skills: Array<{ dir: string; name: string }> = [];
  if (fs.existsSync(path.join(ROOT, 'SKILL.md.tmpl'))) {
    skills.push({ dir: '.', name: 'root gstack' });
  }
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) {
      skills.push({ dir: entry.name, name: entry.name });
    }
  }
  return skills;
})();

function extractFrontmatter(content: string): string {
  const fmEnd = content.indexOf('\n---', 4);
  expect(fmEnd).toBeGreaterThan(0);
  return content.slice(4, fmEnd);
}

function extractBlockScalarDescription(frontmatter: string): string {
  const lines = frontmatter.split('\n');
  const descStart = lines.findIndex(line => line === 'description: |');
  expect(descStart).toBeGreaterThanOrEqual(0);

  const descLines: string[] = [];
  for (const line of lines.slice(descStart + 1)) {
    if (line === '' || line.startsWith('  ')) {
      descLines.push(line.replace(/^  /, ''));
      continue;
    }
    break;
  }

  return descLines.join('\n').trim();
}

describe('gen-skill-docs', () => {
  test('generated SKILL.md contains all command categories', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const categories = new Set(Object.values(COMMAND_DESCRIPTIONS).map(d => d.category));
    for (const cat of categories) {
      expect(content).toContain(`### ${cat}`);
    }
  });

  test('generated SKILL.md contains all commands', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
      const display = meta.usage || cmd;
      expect(content).toContain(display);
    }
  });

  test('command table is sorted alphabetically within categories', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    // Extract command names from the Navigation section as a test
    const navSection = content.match(/### Navigation\n\|.*\n\|.*\n([\s\S]*?)(?=\n###|\n## )/);
    expect(navSection).not.toBeNull();
    const rows = navSection![1].trim().split('\n');
    const commands = rows.map(r => {
      const match = r.match(/\| `(\w+)/);
      return match ? match[1] : '';
    }).filter(Boolean);
    const sorted = [...commands].sort();
    expect(commands).toEqual(sorted);
  });

  test('generated header is present in SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
    expect(content).toContain('Regenerate: bun run gen:skill-docs');
  });

  test('generated header is present in browse/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
  });

  test('snapshot flags section contains all flags', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    for (const flag of SNAPSHOT_FLAGS) {
      expect(content).toContain(flag.short);
      expect(content).toContain(flag.description);
    }
  });

  test('every skill has a SKILL.md.tmpl template', () => {
    for (const skill of ALL_SKILLS) {
      const tmplPath = path.join(ROOT, skill.dir, 'SKILL.md.tmpl');
      expect(fs.existsSync(tmplPath)).toBe(true);
    }
  });

  test('every skill has a generated SKILL.md with auto-generated header', () => {
    for (const skill of ALL_SKILLS) {
      const mdPath = path.join(ROOT, skill.dir, 'SKILL.md');
      expect(fs.existsSync(mdPath)).toBe(true);
      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
      expect(content).toContain('Regenerate: bun run gen:skill-docs');
    }
  });

  test('every generated SKILL.md has valid YAML frontmatter', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('name:');
      expect(content).toContain('description:');
    }
  });

  test('generated files are fresh (match --dry-run)', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    // Every skill should be FRESH
    for (const skill of ALL_SKILLS) {
      const file = skill.dir === '.' ? 'SKILL.md' : `${skill.dir}/SKILL.md`;
      expect(output).toContain(`FRESH: ${file}`);
    }
    expect(output).not.toContain('STALE');
  });

  test('no generated SKILL.md contains unresolved placeholders', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      const unresolved = content.match(/\{\{[A-Z_]+\}\}/g);
      expect(unresolved).toBeNull();
    }
  });

  test('templates contain placeholders', () => {
    const rootTmpl = fs.readFileSync(path.join(ROOT, 'SKILL.md.tmpl'), 'utf-8');
    expect(rootTmpl).toContain('{{COMMAND_REFERENCE}}');
    expect(rootTmpl).toContain('{{SNAPSHOT_FLAGS}}');
    expect(rootTmpl).toContain('{{PREAMBLE}}');

    const browseTmpl = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md.tmpl'), 'utf-8');
    expect(browseTmpl).toContain('{{COMMAND_REFERENCE}}');
    expect(browseTmpl).toContain('{{SNAPSHOT_FLAGS}}');
    expect(browseTmpl).toContain('{{PREAMBLE}}');
  });

  test('generated SKILL.md contains contributor mode check', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Contributor Mode');
    expect(content).toContain('gstack_contributor');
    expect(content).toContain('contributor-logs');
  });

  test('generated SKILL.md contains session awareness', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('_SESSIONS');
    expect(content).toContain('RECOMMENDATION');
  });

  test('generated SKILL.md contains branch detection', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('_BRANCH');
    expect(content).toContain('git branch --show-current');
  });

  test('generated SKILL.md contains ELI16 simplification rules', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('No raw function names');
    expect(content).toContain('plain English');
  });

  test('generated SKILL.md contains telemetry line', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('skill-usage.jsonl');
    expect(content).toContain('~/.gstack/analytics');
  });

  test('preamble-using skills have correct skill name in telemetry', () => {
    const PREAMBLE_SKILLS = [
      { dir: '.', name: 'gstack' },
      { dir: 'ship', name: 'ship' },
      { dir: 'review', name: 'review' },
      { dir: 'qa', name: 'qa' },
      { dir: 'retro', name: 'retro' },
    ];
    for (const skill of PREAMBLE_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      expect(content).toContain(`"skill":"${skill.name}"`);
    }
  });

  test('qa and qa-only templates use QA_METHODOLOGY placeholder', () => {
    const qaTmpl = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md.tmpl'), 'utf-8');
    expect(qaTmpl).toContain('{{QA_METHODOLOGY}}');

    const qaOnlyTmpl = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md.tmpl'), 'utf-8');
    expect(qaOnlyTmpl).toContain('{{QA_METHODOLOGY}}');
  });

  test('QA_METHODOLOGY appears expanded in both qa and qa-only generated files', () => {
    const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    const qaOnlyContent = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md'), 'utf-8');

    // Both should contain the health score rubric
    expect(qaContent).toContain('Health Score Rubric');
    expect(qaOnlyContent).toContain('Health Score Rubric');

    // Both should contain framework guidance
    expect(qaContent).toContain('Framework-Specific Guidance');
    expect(qaOnlyContent).toContain('Framework-Specific Guidance');

    // Both should contain the important rules
    expect(qaContent).toContain('Important Rules');
    expect(qaOnlyContent).toContain('Important Rules');

    // Both should contain the 6 phases
    expect(qaContent).toContain('Phase 1');
    expect(qaOnlyContent).toContain('Phase 1');
    expect(qaContent).toContain('Phase 6');
    expect(qaOnlyContent).toContain('Phase 6');
  });

  test('qa-only has no-fix guardrails', () => {
    const qaOnlyContent = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md'), 'utf-8');
    expect(qaOnlyContent).toContain('Never fix bugs');
    expect(qaOnlyContent).toContain('NEVER fix anything');
    // Should not have Edit, Glob, or Grep in allowed-tools
    expect(qaOnlyContent).not.toMatch(/allowed-tools:[\s\S]*?Edit/);
    expect(qaOnlyContent).not.toMatch(/allowed-tools:[\s\S]*?Glob/);
    expect(qaOnlyContent).not.toMatch(/allowed-tools:[\s\S]*?Grep/);
  });

  test('qa has fix-loop tools and phases', () => {
    const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    // Should have Edit, Glob, Grep in allowed-tools
    expect(qaContent).toContain('Edit');
    expect(qaContent).toContain('Glob');
    expect(qaContent).toContain('Grep');
    // Should have fix-loop phases
    expect(qaContent).toContain('Phase 7');
    expect(qaContent).toContain('Phase 8');
    expect(qaContent).toContain('Fix Loop');
    expect(qaContent).toContain('Triage');
    expect(qaContent).toContain('WTF');
  });
});

describe('BASE_BRANCH_DETECT resolver', () => {
  // Find a generated SKILL.md that uses the placeholder (ship is guaranteed to)
  const shipContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('resolver output contains PR base detection command', () => {
    expect(shipContent).toContain('gh pr view --json baseRefName');
  });

  test('resolver output contains repo default branch detection command', () => {
    expect(shipContent).toContain('gh repo view --json defaultBranchRef');
  });

  test('resolver output contains fallback to main', () => {
    expect(shipContent).toMatch(/fall\s*back\s+to\s+`main`/i);
  });

  test('resolver output uses "the base branch" phrasing', () => {
    expect(shipContent).toContain('the base branch');
  });
});

/**
 * Quality evals — catch description regressions.
 *
 * These test that generated output is *useful for an AI agent*,
 * not just structurally valid. Each test targets a specific
 * regression we actually shipped and caught in review.
 */
describe('description quality evals', () => {
  // Regression: snapshot flags lost value hints (-d <N>, -s <sel>, -o <path>)
  test('snapshot flags with values include value hints in output', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    for (const flag of SNAPSHOT_FLAGS) {
      if (flag.takesValue) {
        expect(flag.valueHint).toBeDefined();
        expect(content).toContain(`${flag.short} ${flag.valueHint}`);
      }
    }
  });

  // Regression: "is" lost the valid states enum
  test('is command lists valid state values', () => {
    const desc = COMMAND_DESCRIPTIONS['is'].description;
    for (const state of ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'editable', 'focused']) {
      expect(desc).toContain(state);
    }
  });

  // Regression: "press" lost common key examples
  test('press command lists example keys', () => {
    const desc = COMMAND_DESCRIPTIONS['press'].description;
    expect(desc).toContain('Enter');
    expect(desc).toContain('Tab');
    expect(desc).toContain('Escape');
  });

  // Regression: "console" lost --errors filter note
  test('console command describes --errors behavior', () => {
    const desc = COMMAND_DESCRIPTIONS['console'].description;
    expect(desc).toContain('--errors');
  });

  // Regression: snapshot -i lost "@e refs" context
  test('snapshot -i mentions @e refs', () => {
    const flag = SNAPSHOT_FLAGS.find(f => f.short === '-i')!;
    expect(flag.description).toContain('@e');
  });

  // Regression: snapshot -C lost "@c refs" context
  test('snapshot -C mentions @c refs', () => {
    const flag = SNAPSHOT_FLAGS.find(f => f.short === '-C')!;
    expect(flag.description).toContain('@c');
  });

  // Guard: every description must be at least 8 chars (catches empty or stub descriptions)
  test('all command descriptions have meaningful length', () => {
    for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
      expect(meta.description.length).toBeGreaterThanOrEqual(8);
    }
  });

  // Guard: snapshot flag descriptions must be at least 10 chars
  test('all snapshot flag descriptions have meaningful length', () => {
    for (const flag of SNAPSHOT_FLAGS) {
      expect(flag.description.length).toBeGreaterThanOrEqual(10);
    }
  });

  // Guard: descriptions must not contain pipe (breaks markdown table cells)
  // Usage strings are backtick-wrapped in the table so pipes there are safe.
  test('no command description contains pipe character', () => {
    for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
      expect(meta.description).not.toContain('|');
    }
  });

  // Guard: generated output uses → not ->
  test('generated SKILL.md uses unicode arrows', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    // Check the Tips section specifically (where we regressed -> from →)
    const tipsSection = content.slice(content.indexOf('## Tips'));
    expect(tipsSection).toContain('→');
    expect(tipsSection).not.toContain('->');
  });
});

describe('REVIEW_DASHBOARD resolver', () => {
  const REVIEW_SKILLS = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review'];

  for (const skill of REVIEW_SKILLS) {
    test(`review dashboard appears in ${skill} generated file`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('gstack-review');
      expect(content).toContain('REVIEW READINESS DASHBOARD');
    });
  }

  test('review dashboard appears in ship generated file', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('reviews.jsonl');
    expect(content).toContain('REVIEW READINESS DASHBOARD');
  });

  test('resolver output contains key dashboard elements', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('VERDICT');
    expect(content).toContain('CLEARED');
    expect(content).toContain('Eng Review');
    expect(content).toContain('7 days');
    expect(content).toContain('Design Review');
    expect(content).toContain('skip_eng_review');
  });

  test('dashboard bash block includes git HEAD for staleness detection', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('git rev-parse --short HEAD');
    expect(content).toContain('---HEAD---');
  });

  test('dashboard includes staleness detection prose', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Staleness detection');
    expect(content).toContain('commit');
  });

  for (const skill of REVIEW_SKILLS) {
    test(`${skill} contains review chaining section`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('Review Chaining');
    });

    test(`${skill} Review Log includes commit field`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('"commit"');
    });
  }

  test('plan-ceo-review chaining mentions eng and design reviews', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('/plan-eng-review');
    expect(content).toContain('/plan-design-review');
  });

  test('plan-eng-review chaining mentions design and ceo reviews', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('/plan-design-review');
    expect(content).toContain('/plan-ceo-review');
  });

  test('plan-design-review chaining mentions eng and ceo reviews', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('/plan-eng-review');
    expect(content).toContain('/plan-ceo-review');
  });

  test('ship does NOT contain review chaining', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).not.toContain('Review Chaining');
  });
});

// ─── Test Coverage Audit Resolver Tests ─────────────────────

describe('TEST_COVERAGE_AUDIT placeholders', () => {
  const planSkill = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
  const reviewSkill = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');

  test('all three modes share codepath tracing methodology', () => {
    const sharedPhrases = [
      'Trace data flow',
      'Diagram the execution',
      'Quality scoring rubric',
      '★★★',
      '★★',
      'GAP',
    ];
    for (const phrase of sharedPhrases) {
      expect(planSkill).toContain(phrase);
      expect(shipSkill).toContain(phrase);
      expect(reviewSkill).toContain(phrase);
    }
    // Plan mode traces the plan, not a git diff
    expect(planSkill).toContain('Trace every codepath in the plan');
    expect(planSkill).not.toContain('git diff origin');
    // Ship and review modes trace the diff
    expect(shipSkill).toContain('Trace every codepath changed');
    expect(reviewSkill).toContain('Trace every codepath changed');
  });

  test('all three modes include E2E decision matrix', () => {
    for (const skill of [planSkill, shipSkill, reviewSkill]) {
      expect(skill).toContain('E2E Test Decision Matrix');
      expect(skill).toContain('→E2E');
      expect(skill).toContain('→EVAL');
    }
  });

  test('all three modes include regression rule', () => {
    for (const skill of [planSkill, shipSkill, reviewSkill]) {
      expect(skill).toContain('REGRESSION RULE');
      expect(skill).toContain('IRON RULE');
    }
  });

  test('all three modes include test framework detection', () => {
    for (const skill of [planSkill, shipSkill, reviewSkill]) {
      expect(skill).toContain('Test Framework Detection');
      expect(skill).toContain('CLAUDE.md');
    }
  });

  test('plan mode adds tests to plan + includes test plan artifact', () => {
    expect(planSkill).toContain('Add missing tests to the plan');
    expect(planSkill).toContain('eng-review-test-plan');
    expect(planSkill).toContain('Test Plan Artifact');
  });

  test('ship mode auto-generates tests + includes before/after count', () => {
    expect(shipSkill).toContain('Generate tests for uncovered paths');
    expect(shipSkill).toContain('Before/after test count');
    expect(shipSkill).toContain('30 code paths max');
    expect(shipSkill).toContain('ship-test-plan');
  });

  test('review mode generates via Fix-First + gaps are INFORMATIONAL', () => {
    expect(reviewSkill).toContain('Fix-First');
    expect(reviewSkill).toContain('INFORMATIONAL');
    expect(reviewSkill).toContain('Step 4.75');
    expect(reviewSkill).toContain('subsumes the "Test Gaps" category');
  });

  test('plan mode does NOT include ship-specific content', () => {
    expect(planSkill).not.toContain('Before/after test count');
    expect(planSkill).not.toContain('30 code paths max');
    expect(planSkill).not.toContain('ship-test-plan');
  });

  test('review mode does NOT include test plan artifact', () => {
    expect(reviewSkill).not.toContain('Test Plan Artifact');
    expect(reviewSkill).not.toContain('eng-review-test-plan');
    expect(reviewSkill).not.toContain('ship-test-plan');
  });

  // Regression guard: ship output contains key phrases from before the refactor
  test('ship SKILL.md regression guard — key phrases preserved', () => {
    const regressionPhrases = [
      '100% coverage is the goal',
      'ASCII coverage diagram',
      'processPayment',
      'refundPayment',
      'billing.test.ts',
      'checkout.e2e.ts',
      'COVERAGE:',
      'QUALITY:',
      'GAPS:',
      'Code paths:',
      'User flows:',
    ];
    for (const phrase of regressionPhrases) {
      expect(shipSkill).toContain(phrase);
    }
  });
});

// --- {{TEST_FAILURE_TRIAGE}} resolver tests ---

describe('TEST_FAILURE_TRIAGE resolver', () => {
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('contains all 4 triage steps', () => {
    expect(shipSkill).toContain('Step T1: Classify each failure');
    expect(shipSkill).toContain('Step T2: Handle in-branch failures');
    expect(shipSkill).toContain('Step T3: Handle pre-existing failures');
    expect(shipSkill).toContain('Step T4: Execute the chosen action');
  });

  test('T1 includes classification criteria (in-branch vs pre-existing)', () => {
    expect(shipSkill).toContain('In-branch');
    expect(shipSkill).toContain('Likely pre-existing');
    expect(shipSkill).toContain('git diff origin/');
  });

  test('T3 branches on REPO_MODE (solo vs collaborative)', () => {
    expect(shipSkill).toContain('REPO_MODE');
    expect(shipSkill).toContain('solo');
    expect(shipSkill).toContain('collaborative');
  });

  test('solo mode offers fix-now, TODO, and skip options', () => {
    expect(shipSkill).toContain('Investigate and fix now');
    expect(shipSkill).toContain('Add as P0 TODO');
    expect(shipSkill).toContain('Skip');
  });

  test('collaborative mode offers blame + assign option', () => {
    expect(shipSkill).toContain('Blame + assign GitHub issue');
    expect(shipSkill).toContain('gh issue create');
  });

  test('defaults ambiguous failures to in-branch (safety)', () => {
    expect(shipSkill).toContain('When ambiguous, default to in-branch');
  });
});

// --- {{PLAN_FILE_REVIEW_REPORT}} resolver tests ---

describe('PLAN_FILE_REVIEW_REPORT resolver', () => {
  const REVIEW_SKILLS = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'codex'];

  for (const skill of REVIEW_SKILLS) {
    test(`plan file review report appears in ${skill} generated file`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('GSTACK REVIEW REPORT');
    });
  }

  test('resolver output contains key report elements', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Trigger');
    expect(content).toContain('Findings');
    expect(content).toContain('VERDICT');
    expect(content).toContain('/plan-ceo-review');
    expect(content).toContain('/plan-eng-review');
    expect(content).toContain('/plan-design-review');
    expect(content).toContain('/codex review');
  });
});

// --- {{SPEC_REVIEW_LOOP}} resolver tests ---

describe('SPEC_REVIEW_LOOP resolver', () => {
  const content = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');

  test('contains all 5 review dimensions', () => {
    for (const dim of ['Completeness', 'Consistency', 'Clarity', 'Scope', 'Feasibility']) {
      expect(content).toContain(dim);
    }
  });

  test('references Agent tool for subagent dispatch', () => {
    expect(content).toMatch(/Agent.*tool/i);
  });

  test('specifies max 3 iterations', () => {
    expect(content).toMatch(/3.*iteration|maximum.*3/i);
  });

  test('includes quality score', () => {
    expect(content).toContain('quality score');
  });

  test('includes metrics path', () => {
    expect(content).toContain('spec-review.jsonl');
  });

  test('includes convergence guard', () => {
    expect(content).toMatch(/[Cc]onvergence/);
  });

  test('includes graceful failure handling', () => {
    expect(content).toMatch(/skip.*review|unavailable/i);
  });
});

// --- {{DESIGN_SKETCH}} resolver tests ---

describe('DESIGN_SKETCH resolver', () => {
  const content = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');

  test('references DESIGN.md for design system constraints', () => {
    expect(content).toContain('DESIGN.md');
  });

  test('contains wireframe or sketch terminology', () => {
    expect(content).toMatch(/wireframe|sketch/i);
  });

  test('references browse binary for rendering', () => {
    expect(content).toContain('$B goto');
  });

  test('references screenshot capture', () => {
    expect(content).toContain('$B screenshot');
  });

  test('specifies rough aesthetic', () => {
    expect(content).toMatch(/[Rr]ough|hand-drawn/);
  });

  test('includes skip conditions', () => {
    expect(content).toMatch(/no UI component|skip/i);
  });
});

// --- {{BENEFITS_FROM}} resolver tests ---

describe('BENEFITS_FROM resolver', () => {
  const ceoContent = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
  const engContent = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');

  test('plan-ceo-review contains prerequisite skill offer', () => {
    expect(ceoContent).toContain('Prerequisite Skill Offer');
    expect(ceoContent).toContain('/office-hours');
  });

  test('plan-eng-review contains prerequisite skill offer', () => {
    expect(engContent).toContain('Prerequisite Skill Offer');
    expect(engContent).toContain('/office-hours');
  });

  test('offer includes graceful decline', () => {
    expect(ceoContent).toContain('No worries');
  });

  test('skills without benefits-from do NOT have prerequisite offer', () => {
    const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(qaContent).not.toContain('Prerequisite Skill Offer');
  });
});

// ─── Codex Generation Tests ─────────────────────────────────

describe('Codex generation (--host codex)', () => {
  const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');

  // Dynamic discovery of expected Codex skills: all templates except /codex
  const CODEX_SKILLS = (() => {
    const skills: Array<{ dir: string; codexName: string }> = [];
    if (fs.existsSync(path.join(ROOT, 'SKILL.md.tmpl'))) {
      skills.push({ dir: '.', codexName: 'gstack' });
    }
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.name === 'codex') continue; // /codex is excluded from Codex output
      if (!fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) continue;
      const codexName = entry.name.startsWith('gstack-') ? entry.name : `gstack-${entry.name}`;
      skills.push({ dir: entry.name, codexName });
    }
    return skills;
  })();

  test('--host codex generates correct output paths', () => {
    for (const skill of CODEX_SKILLS) {
      const skillMd = path.join(AGENTS_DIR, skill.codexName, 'SKILL.md');
      expect(fs.existsSync(skillMd)).toBe(true);
    }
  });

  test('codexSkillName mapping: root is gstack, others are gstack-{dir}', () => {
    // Root → gstack
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack', 'SKILL.md'))).toBe(true);
    // Subdirectories → gstack-{dir}
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-ship', 'SKILL.md'))).toBe(true);
    // gstack-upgrade doesn't double-prefix
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-upgrade', 'SKILL.md'))).toBe(true);
    // No double-prefix: gstack-gstack-upgrade must NOT exist
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-gstack-upgrade', 'SKILL.md'))).toBe(false);
  });

  test('Codex frontmatter has ONLY name + description', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content.startsWith('---\n')).toBe(true);
      const frontmatter = extractFrontmatter(content);
      // Must have name and description
      expect(frontmatter).toContain('name:');
      expect(frontmatter).toContain('description:');
      // Must NOT have allowed-tools, version, or hooks
      expect(frontmatter).not.toContain('allowed-tools:');
      expect(frontmatter).not.toContain('version:');
      expect(frontmatter).not.toContain('hooks:');
    }
  });

  test('no .claude/skills/ in Codex output', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('.claude/skills');
    }
  });

  test('no ~/.claude/ paths in Codex output', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('~/.claude/');
    }
  });

  test('/codex skill excluded from Codex output', () => {
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-codex', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-codex'))).toBe(false);
  });

  test('Codex review step stripped from Codex-host ship and review', () => {
    const shipContent = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-ship', 'SKILL.md'), 'utf-8');
    expect(shipContent).not.toContain('codex review --base');
    expect(shipContent).not.toContain('CODEX_REVIEWS');

    const reviewContent = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(reviewContent).not.toContain('codex review --base');
    expect(reviewContent).not.toContain('CODEX_REVIEWS');
  });

  test('--host codex --dry-run freshness', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    // Every Codex skill should be FRESH
    for (const skill of CODEX_SKILLS) {
      expect(output).toContain(`FRESH: .agents/skills/${skill.codexName}/SKILL.md`);
    }
    expect(output).not.toContain('STALE');
  });

  test('--host agents alias produces same output as --host codex', () => {
    const codexResult = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const agentsResult = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'agents', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(codexResult.exitCode).toBe(0);
    expect(agentsResult.exitCode).toBe(0);
    // Both should produce the same output (same FRESH lines)
    expect(codexResult.stdout.toString()).toBe(agentsResult.stdout.toString());
  });

  test('multiline descriptions preserved in Codex output', () => {
    // office-hours has a multiline description — verify it survives the frontmatter transform
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-office-hours', 'SKILL.md'), 'utf-8');
    const frontmatter = extractFrontmatter(content);
    // Description should span multiple lines (block scalar)
    const descLines = frontmatter.split('\n').filter(l => l.startsWith('  '));
    expect(descLines.length).toBeGreaterThan(1);
    // Verify key phrases survived
    expect(frontmatter).toContain('YC Office Hours');
  });

  test('hook skills have safety prose and no hooks: in frontmatter', () => {
    const HOOK_SKILLS = ['gstack-careful', 'gstack-freeze', 'gstack-guard'];
    for (const skillName of HOOK_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skillName, 'SKILL.md'), 'utf-8');
      // Must have safety advisory prose
      expect(content).toContain('Safety Advisory');
      // Must NOT have hooks: in frontmatter
      const frontmatter = extractFrontmatter(content);
      expect(frontmatter).not.toContain('hooks:');
    }
  });

  test('root gstack descriptions stay within Codex CLI frontmatter limit', () => {
    const skillFiles = [
      path.join(ROOT, 'SKILL.md'),
      path.join(AGENTS_DIR, 'gstack', 'SKILL.md'),
    ];

    for (const skillFile of skillFiles) {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const description = extractBlockScalarDescription(extractFrontmatter(content));
      expect(description.length).toBeLessThanOrEqual(1024);
    }
  });

  test('all Codex SKILL.md files have auto-generated header', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
      expect(content).toContain('Regenerate: bun run gen:skill-docs');
    }
  });

  test('Codex preamble uses codex paths', () => {
    // Check a skill that has a preamble (review is a good candidate)
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('~/.codex/skills/gstack');
    expect(content).toContain('.agents/skills/gstack');
  });

  // ─── Path rewriting regression tests ─────────────────────────

  test('sidecar paths point to .agents/skills/gstack/review/ (not gstack-review/)', () => {
    // Regression: gen-skill-docs rewrote .claude/skills/review → .agents/skills/gstack-review
    // but setup puts sidecars under .agents/skills/gstack/review/. Must match setup layout.
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    // Correct: references to sidecar files use gstack/review/ path
    expect(content).toContain('.agents/skills/gstack/review/checklist.md');
    expect(content).toContain('.agents/skills/gstack/review/design-checklist.md');
    // Wrong: must NOT reference gstack-review/checklist.md (file doesn't exist there)
    expect(content).not.toContain('.agents/skills/gstack-review/checklist.md');
    expect(content).not.toContain('.agents/skills/gstack-review/design-checklist.md');
  });

  test('sidecar paths in ship skill point to gstack/review/ for pre-landing review', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-ship', 'SKILL.md'), 'utf-8');
    // Ship references the review checklist in its pre-landing review step
    if (content.includes('checklist.md')) {
      expect(content).toContain('.agents/skills/gstack/review/');
      expect(content).not.toContain('.agents/skills/gstack-review/checklist');
    }
  });

  test('greptile-triage sidecar path is correct', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    if (content.includes('greptile-triage')) {
      expect(content).toContain('.agents/skills/gstack/review/greptile-triage.md');
      expect(content).not.toContain('.agents/skills/gstack-review/greptile-triage');
    }
  });

  test('all four path rewrite rules produce correct output', () => {
    // Test each of the 4 path rewrite rules individually
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');

    // Rule 1: ~/.claude/skills/gstack → ~/.codex/skills/gstack
    expect(content).not.toContain('~/.claude/skills/gstack');
    expect(content).toContain('~/.codex/skills/gstack');

    // Rule 2: .claude/skills/gstack → .agents/skills/gstack
    expect(content).not.toContain('.claude/skills/gstack');

    // Rule 3: .claude/skills/review → .agents/skills/gstack/review
    expect(content).not.toContain('.claude/skills/review');

    // Rule 4: .claude/skills → .agents/skills (catch-all)
    expect(content).not.toContain('.claude/skills');
  });

  test('path rewrite rules apply to all Codex skills with sidecar references', () => {
    // Verify across ALL generated skills, not just review
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      // No skill should reference Claude paths
      expect(content).not.toContain('~/.claude/skills');
      expect(content).not.toContain('.claude/skills');
      // If a skill references checklist.md, it must use the correct sidecar path
      if (content.includes('checklist.md') && !content.includes('design-checklist.md')) {
        expect(content).not.toContain('gstack-review/checklist.md');
      }
    }
  });

  // ─── Claude output regression guard ─────────────────────────

  test('Claude output unchanged: review skill still uses .claude/skills/ paths', () => {
    // Codex changes must NOT affect Claude output
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('.claude/skills/review/checklist.md');
    expect(content).toContain('~/.claude/skills/gstack');
    // Must NOT contain Codex paths
    expect(content).not.toContain('.agents/skills');
    expect(content).not.toContain('~/.codex/');
  });

  test('Claude output unchanged: ship skill still uses .claude/skills/ paths', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('~/.claude/skills/gstack');
    expect(content).not.toContain('.agents/skills');
    expect(content).not.toContain('~/.codex/');
  });

  test('Claude output unchanged: all Claude skills have zero Codex paths', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('~/.codex/');
      expect(content).not.toContain('.agents/skills');
    }
  });
});

// ─── Setup script validation ─────────────────────────────────
// These tests verify the setup script's install layout matches
// what the generator produces — catching the bug where setup
// installed Claude-format source dirs for Codex users.

describe('setup script validation', () => {
  const setupContent = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

  test('setup has separate link functions for Claude and Codex', () => {
    expect(setupContent).toContain('link_claude_skill_dirs');
    expect(setupContent).toContain('link_codex_skill_dirs');
    // Old unified function must not exist
    expect(setupContent).not.toMatch(/^link_skill_dirs\(\)/m);
  });

  test('Claude install uses link_claude_skill_dirs', () => {
    // The Claude install section (section 4) should use the Claude function
    const claudeSection = setupContent.slice(
      setupContent.indexOf('# 4. Install for Claude'),
      setupContent.indexOf('# 5. Install for Codex')
    );
    expect(claudeSection).toContain('link_claude_skill_dirs');
    expect(claudeSection).not.toContain('link_codex_skill_dirs');
  });

  test('Codex install uses link_codex_skill_dirs', () => {
    // The Codex install section (section 5) should use the Codex function
    const codexSection = setupContent.slice(
      setupContent.indexOf('# 5. Install for Codex'),
      setupContent.indexOf('# 6. Create')
    );
    expect(codexSection).toContain('link_codex_skill_dirs');
    expect(codexSection).not.toContain('link_claude_skill_dirs');
  });

  test('link_codex_skill_dirs reads from .agents/skills/', () => {
    // The Codex link function must reference .agents/skills for generated Codex skills
    const fnStart = setupContent.indexOf('link_codex_skill_dirs()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('linked[@]}', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('.agents/skills');
    expect(fnBody).toContain('gstack*');
  });

  test('link_claude_skill_dirs creates relative symlinks', () => {
    // Claude links should be relative: ln -snf "gstack/skill_name"
    const fnStart = setupContent.indexOf('link_claude_skill_dirs()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('linked[@]}', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('ln -snf "gstack/$skill_name"');
  });

  test('setup supports --host auto|claude|codex', () => {
    expect(setupContent).toContain('--host');
    expect(setupContent).toContain('claude|codex|auto');
  });

  test('auto mode detects claude and codex binaries', () => {
    expect(setupContent).toContain('command -v claude');
    expect(setupContent).toContain('command -v codex');
  });

  test('create_agents_sidecar links runtime assets', () => {
    // Sidecar must link bin, browse, review, qa
    const fnStart = setupContent.indexOf('create_agents_sidecar()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('done', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('bin');
    expect(fnBody).toContain('browse');
    expect(fnBody).toContain('review');
    expect(fnBody).toContain('qa');
  });
});

describe('telemetry', () => {
  test('generated SKILL.md contains telemetry start block', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('_TEL_START');
    expect(content).toContain('_SESSION_ID');
    expect(content).toContain('TELEMETRY:');
    expect(content).toContain('TEL_PROMPTED:');
    expect(content).toContain('gstack-config get telemetry');
  });

  test('generated SKILL.md contains telemetry opt-in prompt', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('.telemetry-prompted');
    expect(content).toContain('Help gstack get better');
    expect(content).toContain('gstack-config set telemetry community');
    expect(content).toContain('gstack-config set telemetry anonymous');
    expect(content).toContain('gstack-config set telemetry off');
  });

  test('generated SKILL.md contains telemetry epilogue', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Telemetry (run last)');
    expect(content).toContain('gstack-telemetry-log');
    expect(content).toContain('_TEL_END');
    expect(content).toContain('_TEL_DUR');
    expect(content).toContain('SKILL_NAME');
    expect(content).toContain('OUTCOME');
    expect(content).toContain('PLAN MODE EXCEPTION');
  });

  test('generated SKILL.md contains pending marker handling', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('.pending');
    expect(content).toContain('_pending_finalize');
  });

  test('telemetry blocks appear in all skill files that use PREAMBLE', () => {
    const skills = ['qa', 'ship', 'review', 'plan-ceo-review', 'plan-eng-review', 'retro'];
    for (const skill of skills) {
      const skillPath = path.join(ROOT, skill, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, 'utf-8');
        expect(content).toContain('_TEL_START');
        expect(content).toContain('Telemetry (run last)');
      }
    }
  });
});
