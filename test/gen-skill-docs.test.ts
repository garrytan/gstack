import { describe, test, expect } from 'bun:test';
import { COMMAND_DESCRIPTIONS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

function extractDescription(content: string): string {
  const fmEnd = content.indexOf('\n---', 4);
  expect(fmEnd).toBeGreaterThan(0);
  const frontmatter = content.slice(4, fmEnd);
  const lines = frontmatter.split('\n');
  let description = '';
  let inDescription = false;
  const descLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^description:\s*\|?\s*$/)) {
      inDescription = true;
      continue;
    }
    if (line.match(/^description:\s*\S/)) {
      return line.replace(/^description:\s*/, '').trim();
    }
    if (inDescription) {
      if (line === '' || line.match(/^\s/)) {
        descLines.push(line.replace(/^  /, ''));
      } else {
        break;
      }
    }
  }

  if (descLines.length > 0) {
    description = descLines.join('\n').trim();
  }
  return description;
}

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

  test(`every generated SKILL.md description stays within ${MAX_SKILL_DESCRIPTION_LENGTH} chars`, () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      const description = extractDescription(content);
      expect(description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_LENGTH);
    }
  });

  test(`every Codex SKILL.md description stays within ${MAX_SKILL_DESCRIPTION_LENGTH} chars`, () => {
    const agentsDir = path.join(ROOT, '.agents', 'skills');
    if (!fs.existsSync(agentsDir)) return; // skip if not generated
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(agentsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const description = extractDescription(content);
      expect(description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_LENGTH);
    }
  });

  test('every Codex SKILL.md description stays under 900-char warning threshold', () => {
    const WARN_THRESHOLD = 900;
    const agentsDir = path.join(ROOT, '.agents', 'skills');
    if (!fs.existsSync(agentsDir)) return;
    const violations: string[] = [];
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(agentsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const description = extractDescription(content);
      if (description.length > WARN_THRESHOLD) {
        violations.push(`${entry.name}: ${description.length} chars (limit ${MAX_SKILL_DESCRIPTION_LENGTH}, ${MAX_SKILL_DESCRIPTION_LENGTH - description.length} remaining)`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('package.json version matches VERSION file', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8').trim();
    expect(pkg.version).toBe(version);
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

  test('tier 2+ skills contain ELI16 simplification rules (AskUserQuestion format)', () => {
    // Root SKILL.md is tier 1 (no AskUserQuestion format). Check a tier 2+ skill instead.
    const content = fs.readFileSync(path.join(ROOT, 'cso', 'SKILL.md'), 'utf-8');
    expect(content).toContain('No raw function names');
    expect(content).toContain('plain English');
  });

  test('tier 1 skills do NOT contain AskUserQuestion format', () => {
    // Use benchmark (tier 1) instead of root — root SKILL.md gets overwritten by Codex test setup
    const content = fs.readFileSync(path.join(ROOT, 'benchmark', 'SKILL.md'), 'utf-8');
    expect(content).not.toContain('## AskUserQuestion Format');
    expect(content).not.toContain('## Completeness Principle');
  });

  test('generated SKILL.md contains telemetry line', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('skill-usage.jsonl');
    expect(content).toContain('~/.gstack/analytics');
  });

  test('preamble .pending-* glob is zsh-safe (uses find, not shell glob)', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      if (!content.includes('.pending-')) continue;
      // Must NOT have a bare shell glob ".pending-*" outside of find's -name argument
      expect(content).not.toMatch(/for _PF in [^\n]*\/\.pending-\*/);
      // Must use find to avoid zsh NOMATCH error on glob expansion
      expect(content).toContain("find ~/.gstack/analytics -maxdepth 1 -name '.pending-*'");
    }
  });

  test('bash blocks with shell globs are zsh-safe (setopt guard or find)', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      const bashBlocks = [...content.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);

      for (const block of bashBlocks) {
        const lines = block.split('\n');

        for (const line of lines) {
          const trimmed = line.trimStart();
          if (trimmed.startsWith('#')) continue;
          if (!trimmed.includes('*')) continue;
          // Skip lines where * is inside find -name, git pathspecs, or $(find)
          if (/\bfind\b/.test(trimmed)) continue;
          if (/\bgit\b/.test(trimmed)) continue;
          if (/\$\(find\b/.test(trimmed)) continue;

          // Check 1: "for VAR in <glob>" must use $(find ...) — caught above by the
          // $(find check, so any surviving for-in with a glob pattern is a violation
          if (/\bfor\s+\w+\s+in\b/.test(trimmed) && /\*\./.test(trimmed)) {
            throw new Error(
              `Unsafe for-in glob in ${skill.dir}/SKILL.md: "${trimmed}". ` +
              `Use \`for f in $(find ... -name '*.ext')\` for zsh compatibility.`
            );
          }

          // Check 2: ls/cat/rm/grep with glob file args must have setopt guard
          const isGlobCmd = /\b(?:ls|cat|rm|grep)\b/.test(trimmed) &&
                            /(?:\/\*[a-z.*]|\*\.[a-z])/.test(trimmed);
          if (isGlobCmd) {
            expect(block).toContain('setopt +o nomatch');
          }
        }
      }
    }
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

  test('resolver output contains GitLab CLI commands', () => {
    expect(shipContent).toContain('glab');
  });

  test('resolver output contains git-native fallback', () => {
    expect(shipContent).toContain('git symbolic-ref');
  });

  test('resolver output mentions GitLab platform', () => {
    expect(shipContent).toMatch(/gitlab/i);
  });
});

describe('GitLab support in generated skills', () => {
  const retroContent = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
  const shipSkillContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('retro contains GitLab MR number extraction', () => {
    expect(retroContent).toContain('[#!]');
  });

  test('retro uses BASE_BRANCH_DETECT (contains glab)', () => {
    expect(retroContent).toContain('glab');
  });

  test('ship contains glab mr create', () => {
    expect(shipSkillContent).toContain('glab mr create');
  });

  test('ship checks .gitlab-ci.yml', () => {
    expect(shipSkillContent).toContain('.gitlab-ci.yml');
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

  test('dashboard treats review as a valid Eng Review source', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('plan-eng-review, review, plan-design-review');
    expect(content).toContain('`review` (diff-scoped pre-landing review)');
    expect(content).toContain('`plan-eng-review` (plan-stage architecture review)');
    expect(content).toContain('from either \\`review\\` or \\`plan-eng-review\\`');
  });

  test('shared dashboard propagates review source to plan-eng-review', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('plan-eng-review, review, plan-design-review');
    expect(content).toContain('`review` (diff-scoped pre-landing review)');
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

// --- {{PLAN_COMPLETION_AUDIT}} resolver tests ---

describe('PLAN_COMPLETION_AUDIT placeholders', () => {
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
  const reviewSkill = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');

  test('ship SKILL.md contains plan completion audit step', () => {
    expect(shipSkill).toContain('Plan Completion Audit');
    expect(shipSkill).toContain('Step 3.45');
  });

  test('review SKILL.md contains plan completion in scope drift', () => {
    expect(reviewSkill).toContain('Plan File Discovery');
    expect(reviewSkill).toContain('Actionable Item Extraction');
    expect(reviewSkill).toContain('Integration with Scope Drift Detection');
  });

  test('both modes share plan file discovery methodology', () => {
    expect(shipSkill).toContain('Plan File Discovery');
    expect(reviewSkill).toContain('Plan File Discovery');
    // Both should have conversation context first
    expect(shipSkill).toContain('Conversation context (primary)');
    expect(reviewSkill).toContain('Conversation context (primary)');
    // Both should have grep fallback
    expect(shipSkill).toContain('Content-based search (fallback)');
    expect(reviewSkill).toContain('Content-based search (fallback)');
  });

  test('ship mode has gate logic for NOT DONE items', () => {
    expect(shipSkill).toContain('NOT DONE');
    expect(shipSkill).toContain('Stop — implement the missing items');
    expect(shipSkill).toContain('Ship anyway — defer');
    expect(shipSkill).toContain('intentionally dropped');
  });

  test('review mode is INFORMATIONAL only', () => {
    expect(reviewSkill).toContain('INFORMATIONAL');
    expect(reviewSkill).toContain('MISSING REQUIREMENTS');
    expect(reviewSkill).toContain('SCOPE CREEP');
  });

  test('item extraction has 50-item cap', () => {
    expect(shipSkill).toContain('at most 50 items');
  });

  test('uses file-level traceability (not commit-level)', () => {
    expect(shipSkill).toContain('Cite the specific file');
    expect(shipSkill).not.toContain('commit-level traceability');
  });
});

// --- {{PLAN_VERIFICATION_EXEC}} resolver tests ---

describe('PLAN_VERIFICATION_EXEC placeholder', () => {
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('ship SKILL.md contains plan verification step', () => {
    expect(shipSkill).toContain('Step 3.47');
    expect(shipSkill).toContain('Plan Verification');
  });

  test('references /qa-only invocation', () => {
    expect(shipSkill).toContain('qa-only/SKILL.md');
    expect(shipSkill).toContain('qa-only');
  });

  test('contains localhost reachability check', () => {
    expect(shipSkill).toContain('localhost:3000');
    expect(shipSkill).toContain('NO_SERVER');
  });

  test('skips gracefully when no verification section', () => {
    expect(shipSkill).toContain('No verification steps found in plan');
  });

  test('skips gracefully when no dev server', () => {
    expect(shipSkill).toContain('No dev server detected');
  });
});

// --- Coverage gate tests ---

describe('Coverage gate in ship', () => {
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
  const reviewSkill = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');

  test('ship SKILL.md contains coverage gate with thresholds', () => {
    expect(shipSkill).toContain('Coverage gate');
    expect(shipSkill).toContain('>= target');
    expect(shipSkill).toContain('< minimum');
  });

  test('ship SKILL.md supports configurable thresholds via CLAUDE.md', () => {
    expect(shipSkill).toContain('## Test Coverage');
    expect(shipSkill).toContain('Minimum:');
    expect(shipSkill).toContain('Target:');
  });

  test('coverage gate skips on parse failure (not block)', () => {
    expect(shipSkill).toContain('could not determine percentage — skipping');
  });

  test('review SKILL.md contains coverage WARNING', () => {
    expect(reviewSkill).toContain('COVERAGE WARNING');
    expect(reviewSkill).toContain('Consider writing tests before running /ship');
  });

  test('review coverage warning is INFORMATIONAL', () => {
    expect(reviewSkill).toContain('INFORMATIONAL');
  });
});

// --- Ship metrics logging ---

describe('Ship metrics logging', () => {
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('ship SKILL.md contains metrics persistence step', () => {
    expect(shipSkill).toContain('Step 8.75');
    expect(shipSkill).toContain('coverage_pct');
    expect(shipSkill).toContain('plan_items_total');
    expect(shipSkill).toContain('plan_items_done');
    expect(shipSkill).toContain('verification_result');
  });
});

// --- Plan file discovery shared helper ---

describe('Plan file discovery shared helper', () => {
  // The shared helper should appear in ship (via PLAN_COMPLETION_AUDIT_SHIP)
  // and in review (via PLAN_COMPLETION_AUDIT_REVIEW)
  const shipSkill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
  const reviewSkill = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');

  test('plan file discovery appears in both ship and review', () => {
    expect(shipSkill).toContain('Plan File Discovery');
    expect(reviewSkill).toContain('Plan File Discovery');
  });

  test('both include conversation context first', () => {
    expect(shipSkill).toContain('Conversation context (primary)');
    expect(reviewSkill).toContain('Conversation context (primary)');
  });

  test('both include content-based fallback', () => {
    expect(shipSkill).toContain('Content-based search (fallback)');
    expect(reviewSkill).toContain('Content-based search (fallback)');
  });
});

// --- Retro plan completion ---

describe('Retro plan completion section', () => {
  const retroSkill = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');

  test('retro SKILL.md contains plan completion section', () => {
    expect(retroSkill).toContain('### Plan Completion');
    expect(retroSkill).toContain('plan_items_total');
    expect(retroSkill).toContain('Plan Completion This Period');
  });
});

// --- Plan status footer in preamble ---

describe('Plan status footer in preamble', () => {
  test('preamble contains plan status footer', () => {
    // Read any skill that uses PREAMBLE
    const content = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Plan Status Footer');
    expect(content).toContain('GSTACK REVIEW REPORT');
    expect(content).toContain('gstack-review-read');
    expect(content).toContain('ExitPlanMode');
    expect(content).toContain('NO REVIEWS YET');
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

// --- {{CODEX_SECOND_OPINION}} resolver tests ---

describe('CODEX_SECOND_OPINION resolver', () => {
  const content = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');
  const codexContent = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'gstack-office-hours', 'SKILL.md'), 'utf-8');

  test('Phase 3.5 section appears in office-hours SKILL.md', () => {
    expect(content).toContain('Phase 3.5: Cross-Model Second Opinion');
  });

  test('contains codex exec invocation', () => {
    expect(content).toContain('codex exec');
  });

  test('contains opt-in AskUserQuestion text', () => {
    expect(content).toContain('second opinion from an independent AI perspective');
  });

  test('contains cross-model synthesis instructions', () => {
    expect(content).toMatch(/[Ss]ynthesis/);
    expect(content).toContain('Where Claude agrees with the second opinion');
  });

  test('contains Claude subagent fallback', () => {
    expect(content).toContain('CODEX_NOT_AVAILABLE');
    expect(content).toContain('Agent tool');
    expect(content).toContain('SECOND OPINION (Claude subagent)');
  });

  test('contains premise revision check', () => {
    expect(content).toContain('Codex challenged premise');
  });

  test('contains error handling for auth, timeout, and empty', () => {
    expect(content).toMatch(/[Aa]uth.*fail/);
    expect(content).toMatch(/[Tt]imeout/);
    expect(content).toMatch(/[Ee]mpty response/);
  });

  test('Codex host variant does NOT contain the Phase 3.5 resolver output', () => {
    // The resolver returns '' for codex host, so the interactive section is stripped.
    // Static template references to "Phase 3.5" in prose/conditionals are fine.
    // Other resolvers (design review lite) may contain CODEX_NOT_AVAILABLE, so we
    // check for Phase 3.5-specific markers only.
    expect(codexContent).not.toContain('Phase 3.5: Cross-Model Second Opinion');
    expect(codexContent).not.toContain('TMPERR_OH');
    expect(codexContent).not.toContain('gstack-codex-oh-');
  });
});

// --- Codex filesystem boundary tests ---

describe('Codex filesystem boundary', () => {
  // Skills that call codex exec/review and should contain boundary text
  const CODEX_CALLING_SKILLS = [
    'codex',         // /codex skill — 3 modes
    'autoplan',      // /autoplan — CEO/design/eng voices
    'review',        // /review — adversarial step resolver
    'ship',          // /ship — adversarial step resolver
    'plan-eng-review',  // outside voice resolver
    'plan-ceo-review',  // outside voice resolver
    'office-hours',     // second opinion resolver
  ];

  const BOUNDARY_MARKER = 'Do NOT read or execute any';

  test('boundary instruction appears in all skills that call codex', () => {
    for (const skill of CODEX_CALLING_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain(BOUNDARY_MARKER);
    }
  });

  test('codex skill has Filesystem Boundary section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('## Filesystem Boundary');
    expect(content).toContain('skill definitions meant for a different AI system');
  });

  test('codex skill has rabbit-hole detection rule', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Detect skill-file rabbit holes');
    expect(content).toContain('gstack-update-check');
    expect(content).toContain('Consider retrying');
  });

  test('review.ts CODEX_BOUNDARY constant is interpolated into resolver output', () => {
    // The adversarial step resolver should include boundary text in codex exec prompts
    const reviewContent = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    // Boundary should appear near codex exec invocations
    const boundaryIdx = reviewContent.indexOf(BOUNDARY_MARKER);
    const codexExecIdx = reviewContent.indexOf('codex exec');
    // Both must exist and boundary must come before a codex exec call
    expect(boundaryIdx).toBeGreaterThan(-1);
    expect(codexExecIdx).toBeGreaterThan(-1);
  });

  test('autoplan boundary text avoids host-specific paths for cross-host compatibility', () => {
    const content = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf-8');
    // autoplan template uses generic 'skills/gstack' pattern instead of host-specific
    // paths like ~/.claude/ or .agents/skills (which break Codex/Claude output tests)
    const boundaryStart = content.indexOf('Filesystem Boundary');
    const boundaryEnd = content.indexOf('---', boundaryStart + 1);
    const boundarySection = content.slice(boundaryStart, boundaryEnd);
    expect(boundarySection).not.toContain('~/.claude/');
    expect(boundarySection).not.toContain('.agents/skills');
    expect(boundarySection).toContain('skills/gstack');
    expect(boundarySection).toContain(BOUNDARY_MARKER);
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

  test('inline invocation — no "another window" language', () => {
    expect(ceoContent).not.toContain('another window');
    expect(engContent).not.toContain('another window');
  });

  test('inline invocation — read-and-follow path present', () => {
    expect(ceoContent).toContain('office-hours/SKILL.md');
    expect(engContent).toContain('office-hours/SKILL.md');
  });
});

// --- {{DESIGN_OUTSIDE_VOICES}} resolver tests ---

describe('DESIGN_OUTSIDE_VOICES resolver', () => {
  test('plan-design-review contains outside voices section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Design Outside Voices');
    expect(content).toContain('CODEX_AVAILABLE');
    expect(content).toContain('LITMUS SCORECARD');
  });

  test('design-review contains outside voices section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Design Outside Voices');
    expect(content).toContain('source audit');
  });

  test('design-consultation contains outside voices section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'design-consultation', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Design Outside Voices');
    expect(content).toContain('design direction');
  });

  test('branches correctly per skillName — different prompts', () => {
    const planContent = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    const consultContent = fs.readFileSync(path.join(ROOT, 'design-consultation', 'SKILL.md'), 'utf-8');
    // plan-design-review uses analytical prompt (high reasoning)
    expect(planContent).toContain('model_reasoning_effort="high"');
    // design-consultation uses creative prompt (medium reasoning)
    expect(consultContent).toContain('model_reasoning_effort="medium"');
  });
});

// --- {{DESIGN_HARD_RULES}} resolver tests ---

describe('DESIGN_HARD_RULES resolver', () => {
  test('plan-design-review Pass 4 contains hard rules', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Design Hard Rules');
    expect(content).toContain('Classifier');
    expect(content).toContain('MARKETING/LANDING PAGE');
    expect(content).toContain('APP UI');
  });

  test('design-review contains hard rules', () => {
    const content = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Design Hard Rules');
  });

  test('includes all 3 rule sets', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Landing page rules');
    expect(content).toContain('App UI rules');
    expect(content).toContain('Universal rules');
  });

  test('references shared AI slop blacklist items', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('3-column feature grid');
    expect(content).toContain('Purple/violet/indigo');
  });

  test('includes OpenAI hard rejection criteria', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Generic SaaS card grid');
    expect(content).toContain('Carousel with no narrative purpose');
  });

  test('includes OpenAI litmus checks', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Brand/product unmistakable');
    expect(content).toContain('premium with all decorative shadows removed');
  });
});

// --- Extended DESIGN_SKETCH resolver tests ---

describe('DESIGN_SKETCH extended with outside voices', () => {
  const content = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');

  test('contains outside design voices step', () => {
    expect(content).toContain('Outside design voices');
  });

  test('offers opt-in via AskUserQuestion', () => {
    expect(content).toContain('outside design perspectives');
  });

  test('still contains original wireframe steps', () => {
    expect(content).toContain('wireframe');
    expect(content).toContain('$B goto');
  });
});

// --- Extended DESIGN_REVIEW_LITE resolver tests ---

describe('DESIGN_REVIEW_LITE extended with Codex', () => {
  const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('contains Codex design voice block', () => {
    expect(content).toContain('Codex design voice');
    expect(content).toContain('CODEX (design)');
  });

  test('still contains original checklist steps', () => {
    expect(content).toContain('design-checklist.md');
    expect(content).toContain('SCOPE_FRONTEND');
  });

});

// ─── Codex Generation Tests ─────────────────────────────────

describe('Codex generation (--host codex)', () => {
  const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');

  // .agents/ is gitignored (v0.11.2.0) — generate on demand for tests
  Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
  });

  // Dynamic discovery of expected Codex skills: all templates except /codex
  // Also excludes skills where .agents/skills/{name} is a symlink back to the repo root
  // (vendored dev mode — gen-skill-docs skips these to avoid overwriting Claude SKILL.md)
  const CODEX_SKILLS = (() => {
    const skills: Array<{ dir: string; codexName: string }> = [];
    const isSymlinkLoop = (codexName: string): boolean => {
      const agentSkillDir = path.join(ROOT, '.agents', 'skills', codexName);
      try {
        return fs.realpathSync(agentSkillDir) === fs.realpathSync(ROOT);
      } catch { return false; }
    };
    if (fs.existsSync(path.join(ROOT, 'SKILL.md.tmpl'))) {
      if (!isSymlinkLoop('gstack')) {
        skills.push({ dir: '.', codexName: 'gstack' });
      }
    }
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.name === 'codex') continue; // /codex is excluded from Codex output
      if (!fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) continue;
      const codexName = entry.name.startsWith('gstack-') ? entry.name : `gstack-${entry.name}`;
      if (isSymlinkLoop(codexName)) continue;
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

  test('root gstack bundle has OpenAI metadata for Codex skill browsing', () => {
    const rootMetadata = path.join(ROOT, 'agents', 'openai.yaml');
    expect(fs.existsSync(rootMetadata)).toBe(true);
    const content = fs.readFileSync(rootMetadata, 'utf-8');
    expect(content).toContain('display_name: "gstack"');
    expect(content).toContain('Use $gstack to locate the bundled gstack skills.');
    expect(content).toContain('allow_implicit_invocation: true');
  });

  test('externalSkillName mapping: root is gstack, others are gstack-{dir}', () => {
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
      const fmEnd = content.indexOf('\n---', 4);
      expect(fmEnd).toBeGreaterThan(0);
      const frontmatter = content.slice(4, fmEnd);
      // Must have name and description
      expect(frontmatter).toContain('name:');
      expect(frontmatter).toContain('description:');
      // Must NOT have allowed-tools, version, or hooks
      expect(frontmatter).not.toContain('allowed-tools:');
      expect(frontmatter).not.toContain('version:');
      expect(frontmatter).not.toContain('hooks:');
    }
  });

  test('all Codex skills have agents/openai.yaml metadata', () => {
    for (const skill of CODEX_SKILLS) {
      const metadata = path.join(AGENTS_DIR, skill.codexName, 'agents', 'openai.yaml');
      expect(fs.existsSync(metadata)).toBe(true);
      const content = fs.readFileSync(metadata, 'utf-8');
      expect(content).toContain(`display_name: "${skill.codexName}"`);
      expect(content).toContain('short_description:');
      expect(content).toContain('allow_implicit_invocation: true');
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
    const fmEnd = content.indexOf('\n---', 4);
    const frontmatter = content.slice(4, fmEnd);
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
      const fmEnd = content.indexOf('\n---', 4);
      const frontmatter = content.slice(4, fmEnd);
      expect(frontmatter).not.toContain('hooks:');
    }
  });

  test('all Codex SKILL.md files have auto-generated header', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
      expect(content).toContain('Regenerate: bun run gen:skill-docs');
    }
  });

  test('Codex preamble resolves runtime assets from repo-local or global gstack roots', () => {
    // Check a skill that has a preamble (review is a good candidate)
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('GSTACK_ROOT');
    expect(content).toContain('$_ROOT/.agents/skills/gstack');
    expect(content).toContain('$GSTACK_BIN/gstack-config');
    expect(content).toContain('$GSTACK_ROOT/gstack-upgrade/SKILL.md');
    expect(content).not.toContain('~/.codex/skills/gstack/bin/gstack-config get telemetry');
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

    // Rule 1: ~/.claude/skills/gstack → $GSTACK_ROOT
    expect(content).not.toContain('~/.claude/skills/gstack');
    expect(content).toContain('$GSTACK_ROOT');

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
      if (content.includes('gstack-config') || content.includes('gstack-update-check') || content.includes('gstack-telemetry-log')) {
        expect(content).toContain('$GSTACK_ROOT');
      }
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
      // gstack-upgrade legitimately references .agents/skills for cross-platform detection
      if (skill.dir !== 'gstack-upgrade') {
        expect(content).not.toContain('.agents/skills');
      }
    }
  });

  // ─── Design outside voices: Codex host guard ─────────────────

  test('codex host produces empty outside voices in design-review', () => {
    const codexContent = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-design-review', 'SKILL.md'), 'utf-8');
    expect(codexContent).not.toContain('Design Outside Voices');
  });

  test('codex host does not include Codex design block in ship', () => {
    const codexContent = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-ship', 'SKILL.md'), 'utf-8');
    expect(codexContent).not.toContain('Codex design voice');
  });
});

// ─── Factory generation tests ────────────────────────────────

describe('Factory generation (--host factory)', () => {
  const FACTORY_DIR = path.join(ROOT, '.factory', 'skills');

  // Generate Factory output for tests
  Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'factory'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
  });

  const FACTORY_SKILLS = (() => {
    const skills: Array<{ dir: string; factoryName: string }> = [];
    const isSymlinkLoop = (name: string): boolean => {
      const factorySkillDir = path.join(ROOT, '.factory', 'skills', name);
      try { return fs.realpathSync(factorySkillDir) === fs.realpathSync(ROOT); }
      catch { return false; }
    };
    if (fs.existsSync(path.join(ROOT, 'SKILL.md.tmpl'))) {
      if (!isSymlinkLoop('gstack')) skills.push({ dir: '.', factoryName: 'gstack' });
    }
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.name === 'codex') continue;
      if (!fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) continue;
      const factoryName = entry.name.startsWith('gstack-') ? entry.name : `gstack-${entry.name}`;
      if (isSymlinkLoop(factoryName)) continue;
      skills.push({ dir: entry.name, factoryName });
    }
    return skills;
  })();

  test('--host factory generates correct output paths', () => {
    for (const skill of FACTORY_SKILLS) {
      const skillMd = path.join(FACTORY_DIR, skill.factoryName, 'SKILL.md');
      expect(fs.existsSync(skillMd)).toBe(true);
    }
  });

  test('Factory frontmatter has name + description + user-invocable', () => {
    for (const skill of FACTORY_SKILLS) {
      const content = fs.readFileSync(path.join(FACTORY_DIR, skill.factoryName, 'SKILL.md'), 'utf-8');
      const fmEnd = content.indexOf('\n---', 4);
      const frontmatter = content.slice(4, fmEnd);
      expect(frontmatter).toContain('name:');
      expect(frontmatter).toContain('description:');
      expect(frontmatter).toContain('user-invocable: true');
      expect(frontmatter).not.toContain('allowed-tools:');
      expect(frontmatter).not.toContain('preamble-tier:');
      expect(frontmatter).not.toContain('sensitive:');
    }
  });

  test('sensitive skills have disable-model-invocation', () => {
    const SENSITIVE = ['gstack-ship', 'gstack-land-and-deploy', 'gstack-guard', 'gstack-careful', 'gstack-freeze', 'gstack-unfreeze'];
    for (const name of SENSITIVE) {
      const content = fs.readFileSync(path.join(FACTORY_DIR, name, 'SKILL.md'), 'utf-8');
      const fmEnd = content.indexOf('\n---', 4);
      const frontmatter = content.slice(4, fmEnd);
      expect(frontmatter).toContain('disable-model-invocation: true');
    }
  });

  test('non-sensitive skills lack disable-model-invocation', () => {
    const NON_SENSITIVE = ['gstack-qa', 'gstack-review', 'gstack-investigate', 'gstack-browse'];
    for (const name of NON_SENSITIVE) {
      const content = fs.readFileSync(path.join(FACTORY_DIR, name, 'SKILL.md'), 'utf-8');
      const fmEnd = content.indexOf('\n---', 4);
      const frontmatter = content.slice(4, fmEnd);
      expect(frontmatter).not.toContain('disable-model-invocation');
    }
  });

  test('no .claude/skills/ in Factory output', () => {
    for (const skill of FACTORY_SKILLS) {
      const content = fs.readFileSync(path.join(FACTORY_DIR, skill.factoryName, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('.claude/skills');
    }
  });

  test('no ~/.claude/skills/ paths in Factory output', () => {
    for (const skill of FACTORY_SKILLS) {
      const content = fs.readFileSync(path.join(FACTORY_DIR, skill.factoryName, 'SKILL.md'), 'utf-8');
      // ~/.claude/skills should be rewritten, but ~/.claude/plans is legitimate
      // (plan directory lookup) and ~/.claude/ in codex prompts is intentional
      expect(content).not.toContain('~/.claude/skills');
    }
  });

  test('/codex skill excluded from Factory output', () => {
    expect(fs.existsSync(path.join(FACTORY_DIR, 'gstack-codex', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(FACTORY_DIR, 'gstack-codex'))).toBe(false);
  });

  test('Factory keeps Codex integration blocks', () => {
    // Factory users CAN use Codex second opinions (codex exec is a standalone binary)
    const shipContent = fs.readFileSync(path.join(FACTORY_DIR, 'gstack-ship', 'SKILL.md'), 'utf-8');
    expect(shipContent).toContain('codex');
  });

  test('no agents/openai.yaml in Factory output', () => {
    for (const skill of FACTORY_SKILLS) {
      const yamlPath = path.join(FACTORY_DIR, skill.factoryName, 'agents', 'openai.yaml');
      expect(fs.existsSync(yamlPath)).toBe(false);
    }
  });

  test('--host droid alias works', () => {
    const factoryResult = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'factory', '--dry-run'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    const droidResult = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'droid', '--dry-run'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    expect(factoryResult.exitCode).toBe(0);
    expect(droidResult.exitCode).toBe(0);
    expect(factoryResult.stdout.toString()).toBe(droidResult.stdout.toString());
  });

  test('--host factory --dry-run freshness', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'factory', '--dry-run'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    for (const skill of FACTORY_SKILLS) {
      expect(output).toContain(`FRESH: .factory/skills/${skill.factoryName}/SKILL.md`);
    }
    expect(output).not.toContain('STALE');
  });

  test('Factory preamble uses .factory paths', () => {
    const content = fs.readFileSync(path.join(FACTORY_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('GSTACK_ROOT');
    expect(content).toContain('$_ROOT/.factory/skills/gstack');
    expect(content).toContain('$GSTACK_BIN/gstack-config');
  });
});

// ─── --host all tests ────────────────────────────────────────

describe('--host all', () => {
  test('--host all generates for claude, codex, and factory', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--dry-run'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    // All three hosts should appear in output
    expect(output).toContain('FRESH: SKILL.md');           // claude
    expect(output).toContain('FRESH: .agents/skills/');     // codex
    expect(output).toContain('FRESH: .factory/skills/');    // factory
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
    expect(codexSection).toContain('create_codex_runtime_root');
    expect(codexSection).toContain('link_codex_skill_dirs');
    expect(codexSection).not.toContain('link_claude_skill_dirs');
    expect(codexSection).not.toContain('ln -snf "$GSTACK_DIR" "$CODEX_GSTACK"');
  });

  test('Codex install prefers repo-local .agents/skills when setup runs from there', () => {
    expect(setupContent).toContain('SKILLS_PARENT_BASENAME');
    expect(setupContent).toContain('CODEX_REPO_LOCAL=0');
    expect(setupContent).toContain('[ "$SKILLS_PARENT_BASENAME" = ".agents" ]');
    expect(setupContent).toContain('CODEX_REPO_LOCAL=1');
    expect(setupContent).toContain('CODEX_SKILLS="$INSTALL_SKILLS_DIR"');
  });

  test('setup separates install path from source path for symlinked repo-local installs', () => {
    expect(setupContent).toContain('INSTALL_GSTACK_DIR=');
    expect(setupContent).toContain('SOURCE_GSTACK_DIR=');
    expect(setupContent).toContain('INSTALL_SKILLS_DIR=');
    expect(setupContent).toContain('CODEX_GSTACK="$INSTALL_GSTACK_DIR"');
    expect(setupContent).toContain('link_codex_skill_dirs "$SOURCE_GSTACK_DIR" "$CODEX_SKILLS"');
  });

  test('Codex installs always create sidecar runtime assets for the real skill target', () => {
    expect(setupContent).toContain('if [ "$INSTALL_CODEX" -eq 1 ]; then');
    expect(setupContent).toContain('create_agents_sidecar "$SOURCE_GSTACK_DIR"');
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

  test('setup supports --host auto|claude|codex|kiro', () => {
    expect(setupContent).toContain('--host');
    expect(setupContent).toContain('claude|codex|kiro|factory|auto');
  });

  test('auto mode detects claude, codex, and kiro binaries', () => {
    expect(setupContent).toContain('command -v claude');
    expect(setupContent).toContain('command -v codex');
    expect(setupContent).toContain('command -v kiro-cli');
  });

  // T1: Sidecar skip guard — prevents .agents/skills/gstack from being linked as a skill
  test('link_codex_skill_dirs skips the gstack sidecar directory', () => {
    const fnStart = setupContent.indexOf('link_codex_skill_dirs()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('done', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('[ "$skill_name" = "gstack" ] && continue');
  });

  // T2: Dynamic $GSTACK_ROOT paths in generated Codex preambles
  test('generated Codex preambles use dynamic GSTACK_ROOT paths', () => {
    const codexSkillDir = path.join(ROOT, '.agents', 'skills', 'gstack-ship');
    if (!fs.existsSync(codexSkillDir)) return; // skip if .agents/ not generated
    const content = fs.readFileSync(path.join(codexSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('GSTACK_ROOT=');
    expect(content).toContain('$GSTACK_BIN/');
  });

  // T3: Kiro host support in setup script
  test('setup supports --host kiro with install section and sed rewrites', () => {
    expect(setupContent).toContain('INSTALL_KIRO=');
    expect(setupContent).toContain('kiro-cli');
    expect(setupContent).toContain('KIRO_SKILLS=');
    expect(setupContent).toContain('~/.kiro/skills/gstack');
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

  test('create_codex_runtime_root exposes only runtime assets', () => {
    const fnStart = setupContent.indexOf('create_codex_runtime_root()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('done', setupContent.indexOf('review/', fnStart)));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('gstack/SKILL.md');
    expect(fnBody).toContain('browse/dist');
    expect(fnBody).toContain('browse/bin');
    expect(fnBody).toContain('gstack-upgrade/SKILL.md');
    // Review runtime assets (individual files, not the whole dir)
    expect(fnBody).toContain('checklist.md');
    expect(fnBody).toContain('design-checklist.md');
    expect(fnBody).toContain('greptile-triage.md');
    expect(fnBody).toContain('TODOS-format.md');
    expect(fnBody).not.toContain('ln -snf "$gstack_dir" "$codex_gstack"');
  });

  test('direct Codex installs are migrated out of ~/.codex/skills/gstack', () => {
    expect(setupContent).toContain('migrate_direct_codex_install');
    expect(setupContent).toContain('$HOME/.gstack/repos/gstack');
    expect(setupContent).toContain('avoid duplicate skill discovery');
  });

  // --- Symlink prefix tests (PR #503) ---

  test('link_claude_skill_dirs applies gstack- prefix by default', () => {
    const fnStart = setupContent.indexOf('link_claude_skill_dirs()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('linked[@]}', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('SKILL_PREFIX');
    expect(fnBody).toContain('link_name="gstack-$skill_name"');
  });

  test('link_claude_skill_dirs preserves already-prefixed dirs', () => {
    const fnStart = setupContent.indexOf('link_claude_skill_dirs()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('linked[@]}', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    // gstack-* dirs should keep their name (e.g., gstack-upgrade stays gstack-upgrade)
    expect(fnBody).toContain('gstack-*) link_name="$skill_name"');
  });

  test('setup supports --no-prefix flag', () => {
    expect(setupContent).toContain('--no-prefix');
    expect(setupContent).toContain('SKILL_PREFIX=0');
  });

  test('cleanup_old_claude_symlinks removes only gstack-pointing symlinks', () => {
    expect(setupContent).toContain('cleanup_old_claude_symlinks');
    const fnStart = setupContent.indexOf('cleanup_old_claude_symlinks()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('removed[@]}', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    // Should check readlink before removing
    expect(fnBody).toContain('readlink');
    expect(fnBody).toContain('gstack/*');
    // Should skip already-prefixed dirs
    expect(fnBody).toContain('gstack-*) continue');
  });

  test('cleanup runs before link when prefix is enabled', () => {
    // In the Claude install section, cleanup should happen before linking
    const claudeInstallSection = setupContent.slice(
      setupContent.indexOf('INSTALL_CLAUDE'),
      setupContent.lastIndexOf('link_claude_skill_dirs')
    );
    expect(claudeInstallSection).toContain('cleanup_old_claude_symlinks');
  });

  // --- Persistent config + interactive prompt tests ---

  test('setup reads skill_prefix from config', () => {
    expect(setupContent).toContain('get skill_prefix');
    expect(setupContent).toContain('GSTACK_CONFIG');
  });

  test('setup supports --prefix flag', () => {
    expect(setupContent).toContain('--prefix)');
    expect(setupContent).toContain('SKILL_PREFIX=1; SKILL_PREFIX_FLAG=1');
  });

  test('--prefix and --no-prefix persist to config', () => {
    expect(setupContent).toContain('set skill_prefix');
  });

  test('interactive prompt shows when no config', () => {
    expect(setupContent).toContain('Short names');
    expect(setupContent).toContain('Namespaced');
    expect(setupContent).toContain('Choice [1/2]');
  });

  test('non-TTY defaults to flat names', () => {
    // Should check if stdin is a TTY before prompting
    expect(setupContent).toContain('-t 0');
  });

  test('cleanup_prefixed_claude_symlinks exists and uses readlink', () => {
    expect(setupContent).toContain('cleanup_prefixed_claude_symlinks');
    const fnStart = setupContent.indexOf('cleanup_prefixed_claude_symlinks()');
    const fnEnd = setupContent.indexOf('}', setupContent.indexOf('removed[@]}', fnStart));
    const fnBody = setupContent.slice(fnStart, fnEnd);
    expect(fnBody).toContain('readlink');
    expect(fnBody).toContain('gstack-$skill_name');
  });

  test('reverse cleanup runs before link when prefix is disabled', () => {
    const claudeInstallSection = setupContent.slice(
      setupContent.indexOf('INSTALL_CLAUDE'),
      setupContent.lastIndexOf('link_claude_skill_dirs')
    );
    expect(claudeInstallSection).toContain('cleanup_prefixed_claude_symlinks');
  });

  test('welcome message references SKILL_PREFIX', () => {
    // gstack-upgrade is always called gstack-upgrade (it's the actual dir name)
    // but the welcome section should exist near the prefix logic
    expect(setupContent).toContain('Run /gstack-upgrade anytime');
  });
});

describe('discover-skills hidden directory filtering', () => {
  test('discoverTemplates skips dot-prefixed directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-discover-'));
    try {
      // Create a hidden dir with a template (should be excluded)
      fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'SKILL.md.tmpl'), '---\nname: evil\n---\ntest');
      // Create a visible dir with a template (should be included)
      fs.mkdirSync(path.join(tmpDir, 'visible'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'visible', 'SKILL.md.tmpl'), '---\nname: good\n---\ntest');

      const { discoverTemplates } = require('../scripts/discover-skills');
      const results = discoverTemplates(tmpDir);
      const dirs = results.map((r: { tmpl: string }) => r.tmpl);

      expect(dirs).toContain('visible/SKILL.md.tmpl');
      expect(dirs).not.toContain('.hidden/SKILL.md.tmpl');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

describe('codex commands must not use inline $(git rev-parse --show-toplevel) for cwd', () => {
  // Regression test: inline $(git rev-parse --show-toplevel) in codex exec -C
  // or codex review without cd evaluates in whatever cwd the background shell
  // inherits, which may be a different project in Conductor workspaces.
  // The fix is to resolve _REPO_ROOT eagerly at the top of each bash block.

  // Scan all source files that could contain codex commands
  // Use Bun.Glob to avoid ELOOP from .claude/skills/gstack symlink back to ROOT
  const tmplGlob = new Bun.Glob('**/*.tmpl');
  const sourceFiles = [
    ...Array.from(tmplGlob.scanSync({ cwd: ROOT, followSymlinks: false })),
    ...fs.readdirSync(path.join(ROOT, 'scripts/resolvers'))
      .filter(f => f.endsWith('.ts'))
      .map(f => `scripts/resolvers/${f}`),
    'scripts/gen-skill-docs.ts',
  ];

  test('no codex exec command uses inline $(git rev-parse --show-toplevel) in -C flag', () => {
    const violations: string[] = [];
    for (const rel of sourceFiles) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('codex exec') && line.includes('-C') && line.includes('$(git rev-parse --show-toplevel)')) {
          violations.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('no generated SKILL.md has codex exec with inline $(git rev-parse --show-toplevel) in -C flag', () => {
    const violations: string[] = [];
    const skillMdGlob = new Bun.Glob('**/SKILL.md');
    const skillMdFiles = Array.from(skillMdGlob.scanSync({ cwd: ROOT, followSymlinks: false }));
    for (const rel of skillMdFiles) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('codex exec') && line.includes('-C') && line.includes('$(git rev-parse --show-toplevel)')) {
          violations.push(`${rel}:${i + 1}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('codex review commands must be preceded by cd "$_REPO_ROOT" (no -C support)', () => {
    // codex review does not support -C, so the pattern must be:
    //   _REPO_ROOT=$(git rev-parse --show-toplevel) || { ... }
    //   cd "$_REPO_ROOT"
    //   codex review ...
    // NOT: codex review ... with inline $(git rev-parse --show-toplevel)
    const allFiles = [
      ...Array.from(tmplGlob.scanSync({ cwd: ROOT, followSymlinks: false })),
      ...Array.from(new Bun.Glob('**/SKILL.md').scanSync({ cwd: ROOT, followSymlinks: false })),
      ...fs.readdirSync(path.join(ROOT, 'scripts/resolvers'))
        .filter(f => f.endsWith('.ts'))
        .map(f => `scripts/resolvers/${f}`),
      'scripts/gen-skill-docs.ts',
    ];
    const violations: string[] = [];
    for (const rel of allFiles) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip non-executable lines (markdown table cells, prose references)
        if (line.includes('|') && line.includes('`/codex review`')) continue;
        if (line.includes('`codex review`')) continue;
        // Check for codex review with inline $(git rev-parse)
        if (line.includes('codex review') && line.includes('$(git rev-parse --show-toplevel)')) {
          violations.push(`${rel}:${i + 1} — inline git rev-parse in codex review`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ─── Learnings + Confidence Resolver Tests ─────────────────────

describe('LEARNINGS_SEARCH resolver', () => {
  const SEARCH_SKILLS = ['review', 'ship', 'plan-eng-review', 'investigate', 'office-hours', 'plan-ceo-review'];

  for (const skill of SEARCH_SKILLS) {
    test(`${skill} generated SKILL.md contains learnings search`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('Prior Learnings');
      expect(content).toContain('gstack-learnings-search');
    });
  }

  test('learnings search includes cross-project config check', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('cross_project_learnings');
    expect(content).toContain('--cross-project');
  });

  test('learnings search includes AskUserQuestion for first-time cross-project opt-in', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Enable cross-project learnings');
    expect(content).toContain('project-scoped only');
  });

  test('learnings search mentions prior learning applied display format', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Prior learning applied');
  });
});

describe('LEARNINGS_LOG resolver', () => {
  const LOG_SKILLS = ['review', 'retro', 'investigate'];

  for (const skill of LOG_SKILLS) {
    test(`${skill} generated SKILL.md contains learnings log`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('Capture Learnings');
      expect(content).toContain('gstack-learnings-log');
    });
  }

  test('learnings log documents all type values', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    for (const type of ['pattern', 'pitfall', 'preference', 'architecture', 'tool']) {
      expect(content).toContain(type);
    }
  });

  test('learnings log documents all source values', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    for (const source of ['observed', 'user-stated', 'inferred', 'cross-model']) {
      expect(content).toContain(source);
    }
  });

  test('learnings log includes files field for staleness detection', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('"files"');
    expect(content).toContain('staleness detection');
  });
});

describe('CONFIDENCE_CALIBRATION resolver', () => {
  const CONFIDENCE_SKILLS = ['review', 'ship', 'plan-eng-review', 'cso'];

  for (const skill of CONFIDENCE_SKILLS) {
    test(`${skill} generated SKILL.md contains confidence calibration`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('Confidence Calibration');
      expect(content).toContain('confidence score');
    });
  }

  test('confidence calibration includes scoring rubric with all tiers', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('9-10');
    expect(content).toContain('7-8');
    expect(content).toContain('5-6');
    expect(content).toContain('3-4');
    expect(content).toContain('1-2');
  });

  test('confidence calibration includes display rules', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Show normally');
    expect(content).toContain('Suppress from main report');
  });

  test('confidence calibration includes finding format example', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('[P1] (confidence:');
    expect(content).toContain('SQL injection');
  });

  test('confidence calibration includes calibration learning feedback loop', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('calibration event');
    expect(content).toContain('Log the corrected pattern');
  });

  test('skills without confidence calibration do NOT contain it', () => {
    // office-hours and retro do NOT use confidence calibration
    for (const skill of ['office-hours', 'retro']) {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('## Confidence Calibration');
    }
  });
});
