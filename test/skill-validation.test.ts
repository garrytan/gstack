import { describe, test, expect } from 'bun:test';
import { validateSkill, extractRemoteSlugPatterns, extractWeightsFromTable } from './helpers/skill-parser';
import { ALL_COMMANDS, COMMAND_DESCRIPTIONS, READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('SKILL.md command validation', () => {
  test('all $B commands in SKILL.md are valid browse commands', () => {
    const result = validateSkill(path.join(ROOT, 'SKILL.md'));
    expect(result.invalid).toHaveLength(0);
    expect(result.valid.length).toBeGreaterThan(0);
  });

  test('all snapshot flags in SKILL.md are valid', () => {
    const result = validateSkill(path.join(ROOT, 'SKILL.md'));
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in browse/SKILL.md are valid browse commands', () => {
    const result = validateSkill(path.join(ROOT, 'browse', 'SKILL.md'));
    expect(result.invalid).toHaveLength(0);
    expect(result.valid.length).toBeGreaterThan(0);
  });

  test('all snapshot flags in browse/SKILL.md are valid', () => {
    const result = validateSkill(path.join(ROOT, 'browse', 'SKILL.md'));
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in qa/SKILL.md are valid browse commands', () => {
    const qaSkill = path.join(ROOT, 'qa', 'SKILL.md');
    if (!fs.existsSync(qaSkill)) return; // skip if missing
    const result = validateSkill(qaSkill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in qa/SKILL.md are valid', () => {
    const qaSkill = path.join(ROOT, 'qa', 'SKILL.md');
    if (!fs.existsSync(qaSkill)) return;
    const result = validateSkill(qaSkill);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in qa-only/SKILL.md are valid browse commands', () => {
    const qaOnlySkill = path.join(ROOT, 'qa-only', 'SKILL.md');
    if (!fs.existsSync(qaOnlySkill)) return;
    const result = validateSkill(qaOnlySkill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in qa-only/SKILL.md are valid', () => {
    const qaOnlySkill = path.join(ROOT, 'qa-only', 'SKILL.md');
    if (!fs.existsSync(qaOnlySkill)) return;
    const result = validateSkill(qaOnlySkill);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in plan-design-review/SKILL.md are valid browse commands', () => {
    const skill = path.join(ROOT, 'plan-design-review', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in plan-design-review/SKILL.md are valid', () => {
    const skill = path.join(ROOT, 'plan-design-review', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in design-review/SKILL.md are valid browse commands', () => {
    const skill = path.join(ROOT, 'design-review', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in design-review/SKILL.md are valid', () => {
    const skill = path.join(ROOT, 'design-review', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in design-consultation/SKILL.md are valid browse commands', () => {
    const skill = path.join(ROOT, 'design-consultation', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in design-consultation/SKILL.md are valid', () => {
    const skill = path.join(ROOT, 'design-consultation', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all $B commands in autoplan/SKILL.md are valid browse commands', () => {
    const skill = path.join(ROOT, 'autoplan', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in autoplan/SKILL.md are valid', () => {
    const skill = path.join(ROOT, 'autoplan', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });
});

describe('Command registry consistency', () => {
  test('COMMAND_DESCRIPTIONS covers all commands in sets', () => {
    const allCmds = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
    const descKeys = new Set(Object.keys(COMMAND_DESCRIPTIONS));
    for (const cmd of allCmds) {
      expect(descKeys.has(cmd)).toBe(true);
    }
  });

  test('COMMAND_DESCRIPTIONS has no extra commands not in sets', () => {
    const allCmds = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
    for (const key of Object.keys(COMMAND_DESCRIPTIONS)) {
      expect(allCmds.has(key)).toBe(true);
    }
  });

  test('ALL_COMMANDS matches union of all sets', () => {
    const union = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS]);
    expect(ALL_COMMANDS.size).toBe(union.size);
    for (const cmd of union) {
      expect(ALL_COMMANDS.has(cmd)).toBe(true);
    }
  });

  test('SNAPSHOT_FLAGS option keys are valid SnapshotOptions fields', () => {
    const validKeys = new Set([
      'interactive', 'compact', 'depth', 'selector',
      'diff', 'annotate', 'outputPath', 'cursorInteractive',
      'heatmap',
    ]);
    for (const flag of SNAPSHOT_FLAGS) {
      expect(validKeys.has(flag.optionKey)).toBe(true);
    }
  });
});

describe('Usage string consistency', () => {
  // Normalize a usage string to its structural skeleton for comparison.
  // Replaces <param-names> with <>, [optional] with [], strips parenthetical hints.
  // This catches format mismatches (e.g., <name>:<value> vs <name> <value>)
  // without tripping on abbreviation differences (e.g., <sel> vs <selector>).
  function skeleton(usage: string): string {
    return usage
      .replace(/\(.*?\)/g, '')        // strip parenthetical hints like (e.g., Enter, Tab)
      .replace(/<[^>]*>/g, '<>')      // normalize <param-name> → <>
      .replace(/\[[^\]]*\]/g, '[]')   // normalize [optional] → []
      .replace(/\s+/g, ' ')           // collapse whitespace
      .trim();
  }

  // Cross-check Usage: patterns in implementation against COMMAND_DESCRIPTIONS
  test('implementation Usage: structural format matches COMMAND_DESCRIPTIONS', () => {
    const implFiles = [
      path.join(ROOT, 'browse', 'src', 'write-commands.ts'),
      path.join(ROOT, 'browse', 'src', 'read-commands.ts'),
      path.join(ROOT, 'browse', 'src', 'meta-commands.ts'),
    ];

    // Extract "Usage: browse <pattern>" from throw new Error(...) calls
    const usagePattern = /throw new Error\(['"`]Usage:\s*browse\s+(.+?)['"`]\)/g;
    const implUsages = new Map<string, string>();

    for (const file of implFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = usagePattern.exec(content)) !== null) {
        const usage = match[1].split('\\n')[0].trim();
        const cmd = usage.split(/\s/)[0];
        implUsages.set(cmd, usage);
      }
    }

    // Compare structural skeletons
    const mismatches: string[] = [];
    for (const [cmd, implUsage] of implUsages) {
      const desc = COMMAND_DESCRIPTIONS[cmd];
      if (!desc) continue;
      if (!desc.usage) continue;
      const descSkel = skeleton(desc.usage);
      const implSkel = skeleton(implUsage);
      if (descSkel !== implSkel) {
        mismatches.push(`${cmd}: docs "${desc.usage}" (${descSkel}) vs impl "${implUsage}" (${implSkel})`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});

describe('Generated SKILL.md freshness', () => {
  test('no unresolved {{placeholders}} in generated SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const unresolved = content.match(/\{\{\w+\}\}/g);
    expect(unresolved).toBeNull();
  });

  test('no unresolved {{placeholders}} in generated browse/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    const unresolved = content.match(/\{\{\w+\}\}/g);
    expect(unresolved).toBeNull();
  });

  test('generated SKILL.md has AUTO-GENERATED header', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('AUTO-GENERATED');
  });
});

// --- Update check preamble validation ---

describe('Update check preamble', () => {
  const skillsWithUpdateCheck = [
    'SKILL.md', 'browse/SKILL.md', 'qa/SKILL.md',
    'qa-only/SKILL.md',
    'setup-browser-cookies/SKILL.md',
    'ship/SKILL.md', 'review/SKILL.md',
    'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md',
    'retro/SKILL.md',
    'office-hours/SKILL.md', 'investigate/SKILL.md',
    'plan-design-review/SKILL.md',
    'design-review/SKILL.md',
    'design-consultation/SKILL.md',
    'document-release/SKILL.md',
    'canary/SKILL.md',
    'benchmark/SKILL.md',
    'land-and-deploy/SKILL.md',
    'setup-deploy/SKILL.md',
    'cso/SKILL.md',
  ];

  for (const skill of skillsWithUpdateCheck) {
    test(`${skill} update check line ends with || true`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      // The second line of the bash block must end with || true
      // to avoid exit code 1 when _UPD is empty (up to date)
      const match = content.match(/\[ -n "\$_UPD" \].*$/m);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('|| true');
    });
  }

  test('all skills with update check are generated from .tmpl', () => {
    for (const skill of skillsWithUpdateCheck) {
      const tmplPath = path.join(ROOT, skill + '.tmpl');
      expect(fs.existsSync(tmplPath)).toBe(true);
    }
  });

  test('update check bash block exits 0 when up to date', () => {
    // Simulate the exact preamble command from SKILL.md
    const result = Bun.spawnSync(['bash', '-c',
      '_UPD=$(echo "" || true); [ -n "$_UPD" ] && echo "$_UPD" || true'
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
  });

  test('update check bash block exits 0 when upgrade available', () => {
    const result = Bun.spawnSync(['bash', '-c',
      '_UPD=$(echo "UPGRADE_AVAILABLE 0.3.3 0.4.0" || true); [ -n "$_UPD" ] && echo "$_UPD" || true'
    ], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });
});

// --- Part 7: Cross-skill path consistency (A1) ---

describe('Cross-skill path consistency', () => {
  test('REMOTE_SLUG derivation pattern is identical across files that use it', () => {
    const patterns = extractRemoteSlugPatterns(ROOT, ['qa', 'review']);
    const allPatterns: string[] = [];

    for (const [, filePatterns] of patterns) {
      allPatterns.push(...filePatterns);
    }

    // Should find at least 2 occurrences (qa/SKILL.md + review/greptile-triage.md)
    expect(allPatterns.length).toBeGreaterThanOrEqual(2);

    // All occurrences must be character-for-character identical
    const unique = new Set(allPatterns);
    if (unique.size > 1) {
      const variants = Array.from(unique);
      throw new Error(
        `REMOTE_SLUG pattern differs across files:\n` +
        variants.map((v, i) => `  ${i + 1}: ${v}`).join('\n')
      );
    }
  });

  test('all greptile-history write references specify both per-project and global paths', () => {
    const filesToCheck = [
      'review/SKILL.md',
      'ship/SKILL.md',
      'review/greptile-triage.md',
    ];

    for (const file of filesToCheck) {
      const filePath = path.join(ROOT, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');

      const hasBoth = (content.includes('per-project') && content.includes('global')) ||
        (content.includes('$REMOTE_SLUG/greptile-history') && content.includes('~/.gstack/greptile-history'));

      expect(hasBoth).toBe(true);
    }
  });

  test('greptile-triage.md contains both project and global history paths', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), 'utf-8');
    expect(content).toContain('$REMOTE_SLUG/greptile-history.md');
    expect(content).toContain('~/.gstack/greptile-history.md');
  });

  test('retro/SKILL.md reads global greptile-history (not per-project)', () => {
    const content = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
    expect(content).toContain('~/.gstack/greptile-history.md');
    // Should NOT reference per-project path for reads
    expect(content).not.toContain('$REMOTE_SLUG/greptile-history.md');
  });
});

// --- Part 7: QA skill structure validation (A2) ---

describe('QA skill structure validation', () => {
  const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');

  test('qa/SKILL.md has all 11 phases', () => {
    const phases = [
      'Phase 1', 'Initialize',
      'Phase 2', 'Authenticate',
      'Phase 3', 'Orient',
      'Phase 4', 'Explore',
      'Phase 5', 'Document',
      'Phase 6', 'Wrap Up',
      'Phase 7', 'Triage',
      'Phase 8', 'Fix Loop',
      'Phase 9', 'Final QA',
      'Phase 10', 'Report',
      'Phase 11', 'TODOS',
    ];
    for (const phase of phases) {
      expect(qaContent).toContain(phase);
    }
  });

  test('has all four QA modes defined', () => {
    const modes = [
      'Diff-aware',
      'Full',
      'Quick',
      'Regression',
    ];
    for (const mode of modes) {
      expect(qaContent).toContain(mode);
    }

    // Mode triggers/flags
    expect(qaContent).toContain('--quick');
    expect(qaContent).toContain('--regression');
  });

  test('has all three tiers defined', () => {
    const tiers = ['Quick', 'Standard', 'Exhaustive'];
    for (const tier of tiers) {
      expect(qaContent).toContain(tier);
    }
  });

  test('health score weights sum to 100%', () => {
    const weights = extractWeightsFromTable(qaContent);
    expect(weights.size).toBeGreaterThan(0);

    let sum = 0;
    for (const pct of weights.values()) {
      sum += pct;
    }
    expect(sum).toBe(100);
  });

  test('health score has all 8 categories', () => {
    const weights = extractWeightsFromTable(qaContent);
    const expectedCategories = [
      'Console', 'Links', 'Visual', 'Functional',
      'UX', 'Performance', 'Content', 'Accessibility',
    ];
    for (const cat of expectedCategories) {
      expect(weights.has(cat)).toBe(true);
    }
    expect(weights.size).toBe(8);
  });

  test('has four mode definitions (Diff-aware/Full/Quick/Regression)', () => {
    expect(qaContent).toContain('### Diff-aware');
    expect(qaContent).toContain('### Full');
    expect(qaContent).toContain('### Quick');
    expect(qaContent).toContain('### Regression');
  });

  test('output structure references report directory layout', () => {
    expect(qaContent).toContain('qa-report-');
    expect(qaContent).toContain('baseline.json');
    expect(qaContent).toContain('screenshots/');
    expect(qaContent).toContain('.gstack/qa-reports/');
  });
});

// --- Part 7: Greptile history format consistency (A3) ---

describe('Greptile history format consistency', () => {
  test('greptile-triage.md defines the canonical history format', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), 'utf-8');
    expect(content).toContain('<YYYY-MM-DD>');
    expect(content).toContain('<owner/repo>');
    expect(content).toContain('<type');
    expect(content).toContain('<file-pattern>');
    expect(content).toContain('<category>');
  });

  test('review/SKILL.md and ship/SKILL.md both reference greptile-triage.md for write details', () => {
    const reviewContent = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    const shipContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

    expect(reviewContent.toLowerCase()).toContain('greptile-triage.md');
    expect(shipContent.toLowerCase()).toContain('greptile-triage.md');
  });

  test('greptile-triage.md defines all 9 valid categories', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), 'utf-8');
    const categories = [
      'race-condition', 'null-check', 'error-handling', 'style',
      'type-safety', 'security', 'performance', 'correctness', 'other',
    ];
    for (const cat of categories) {
      expect(content).toContain(cat);
    }
  });
});

// --- Hardcoded branch name detection in templates ---

describe('No hardcoded branch names in SKILL templates', () => {
  const tmplFiles = [
    'ship/SKILL.md.tmpl',
    'review/SKILL.md.tmpl',
    'qa/SKILL.md.tmpl',
    'plan-ceo-review/SKILL.md.tmpl',
    'retro/SKILL.md.tmpl',
    'document-release/SKILL.md.tmpl',
    'plan-eng-review/SKILL.md.tmpl',
    'plan-design-review/SKILL.md.tmpl',
    'codex/SKILL.md.tmpl',
  ];

  // Patterns that indicate hardcoded 'main' in git commands
  const gitMainPatterns = [
    /\bgit\s+diff\s+(?:origin\/)?main\b/,
    /\bgit\s+log\s+(?:origin\/)?main\b/,
    /\bgit\s+fetch\s+origin\s+main\b/,
    /\bgit\s+merge\s+origin\/main\b/,
    /\borigin\/main\b/,
  ];

  // Lines that are allowed to mention 'main' (fallback logic, prose)
  const allowlist = [
    /fall\s*back\s+to\s+`main`/i,
    /fall\s*back\s+to\s+`?main`?/i,
    /typically\s+`?main`?/i,
    /If\s+on\s+`main`/i,  // old pattern — should not exist
  ];

  for (const tmplFile of tmplFiles) {
    test(`${tmplFile} has no hardcoded 'main' in git commands`, () => {
      const filePath = path.join(ROOT, tmplFile);
      if (!fs.existsSync(filePath)) return;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const violations: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isAllowlisted = allowlist.some(p => p.test(line));
        if (isAllowlisted) continue;

        for (const pattern of gitMainPatterns) {
          if (pattern.test(line)) {
            violations.push(`Line ${i + 1}: ${line.trim()}`);
            break;
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${tmplFile} has hardcoded 'main' in git commands:\n` +
          violations.map(v => `  ${v}`).join('\n')
        );
      }
    });
  }
});

// --- Part 7b: TODOS-format.md reference consistency ---

describe('TODOS-format.md reference consistency', () => {
  test('review/TODOS-format.md exists and defines canonical format', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'TODOS-format.md'), 'utf-8');
    expect(content).toContain('**What:**');
    expect(content).toContain('**Why:**');
    expect(content).toContain('**Priority:**');
    expect(content).toContain('**Effort:**');
    expect(content).toContain('## Completed');
  });

  test('skills that write TODOs reference TODOS-format.md', () => {
    const shipContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const ceoPlanContent = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    const engPlanContent = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');

    expect(shipContent).toContain('TODOS-format.md');
    expect(ceoPlanContent).toContain('TODOS-format.md');
    expect(engPlanContent).toContain('TODOS-format.md');
  });
});

// --- v0.4.1 feature coverage: RECOMMENDATION format, session awareness, enum completeness ---

describe('v0.4.1 preamble features', () => {
  // Tier 1 skills have core preamble only (no AskUserQuestion format)
  const tier1Skills = ['SKILL.md', 'browse/SKILL.md', 'setup-browser-cookies/SKILL.md', 'benchmark/SKILL.md'];

  // Tier 2+ skills have AskUserQuestion format with RECOMMENDATION
  const tier2PlusSkills = [
    'qa/SKILL.md', 'qa-only/SKILL.md',
    'ship/SKILL.md', 'review/SKILL.md',
    'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md',
    'retro/SKILL.md',
    'office-hours/SKILL.md', 'investigate/SKILL.md',
    'plan-design-review/SKILL.md',
    'design-review/SKILL.md',
    'design-consultation/SKILL.md',
    'document-release/SKILL.md',
    'canary/SKILL.md',
    'land-and-deploy/SKILL.md',
    'setup-deploy/SKILL.md',
    'cso/SKILL.md',
  ];

  const skillsWithPreamble = [...tier1Skills, ...tier2PlusSkills];

  for (const skill of tier2PlusSkills) {
    test(`${skill} contains AskUserQuestion Pros/Cons format`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      // v1.7.0.0 Pros/Cons format tokens. The preamble resolver
      // (generate-ask-user-format.ts) injects all of these into every
      // tier-2+ skill. Drop any of them and the test catches it on the
      // next `bun test` run.
      expect(content).toContain('AskUserQuestion');
      expect(content).toContain('Pros / cons:');
      expect(content).toContain('Recommendation: <choice>');
      expect(content).toContain('Net:');
      expect(content).toContain('ELI10');
      expect(content).toContain('Stakes if we pick wrong:');
      // Concrete format markers must be documented in the resolver text
      expect(content).toMatch(/✅/);
      expect(content).toMatch(/❌/);
    });
  }

  for (const skill of skillsWithPreamble) {
    test(`${skill} contains session awareness`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('_SESSIONS');
    });
  }

  for (const skill of skillsWithPreamble) {
    test(`${skill} contains escalation protocol`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('DONE_WITH_CONCERNS');
      expect(content).toContain('BLOCKED');
      expect(content).toContain('NEEDS_CONTEXT');
    });
  }
});

// --- Structural tests for new skills ---

describe('office-hours skill structure', () => {
  const content = fs.readFileSync(path.join(ROOT, 'office-hours', 'SKILL.md'), 'utf-8');

  // Original structural assertions
  for (const section of ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'Phase 6',
                          'Design Doc', 'Supersedes', 'APPROVED', 'Premise Challenge',
                          'Alternatives', 'Smart-skip']) {
    test(`contains ${section}`, () => expect(content).toContain(section));
  }

  // Dual-mode structure
  for (const section of ['Startup mode', 'Builder mode']) {
    test(`contains ${section}`, () => expect(content).toContain(section));
  }

  // Mode detection question
  test('contains explicit mode detection question', () => {
    expect(content).toContain("what's your goal");
  });

  // Six forcing questions (startup mode)
  for (const question of ['Demand Reality', 'Status Quo', 'Desperate Specificity',
                           'Narrowest Wedge', 'Observation & Surprise', 'Future-Fit']) {
    test(`contains forcing question: ${question}`, () => expect(content).toContain(question));
  }

  // Builder mode questions
  test('contains builder brainstorming questions', () => {
    expect(content).toContain('coolest version');
    expect(content).toContain('delightful');
  });

  // Intrapreneurship adaptation
  test('contains intrapreneurship adaptation', () => {
    expect(content).toContain('Intrapreneurship');
  });

  // YC founder discovery engine
  test('contains YC apply CTA with ref tracking', () => {
    expect(content).toContain('ycombinator.com/apply?ref=gstack');
  });

  test('contains "What I noticed" design doc section', () => {
    expect(content).toContain('What I noticed about how you think');
  });

  test('contains golden age framing', () => {
    expect(content).toContain('golden age');
  });

  test('contains Garry Tan personal plea', () => {
    expect(content).toContain('Garry Tan, the creator of GStack');
  });

  test('contains founder signal synthesis phase', () => {
    expect(content).toContain('Founder Signal Synthesis');
  });

  test('contains three-tier decision rubric', () => {
    expect(content).toContain('Top tier');
    expect(content).toContain('Middle tier');
    expect(content).toContain('Base tier');
  });

  test('contains anti-slop examples', () => {
    expect(content).toContain('GOOD:');
    expect(content).toContain('BAD:');
  });

  test('contains "One more thing" transition beat', () => {
    expect(content).toContain('One more thing');
  });

  // Operating principles per mode
  test('contains startup operating principles', () => {
    expect(content).toContain('Specificity is the only currency');
  });

  test('contains builder operating principles', () => {
    expect(content).toContain('Delight is the currency');
  });

  // Spec Review Loop (Phase 5.5)
  test('contains spec review loop', () => {
    expect(content).toContain('Spec Review Loop');
  });

  test('contains adversarial review dimensions', () => {
    for (const dim of ['Completeness', 'Consistency', 'Clarity', 'Scope', 'Feasibility']) {
      expect(content).toContain(dim);
    }
  });

  test('contains subagent dispatch instruction', () => {
    expect(content).toMatch(/Agent.*tool|subagent/i);
  });

  test('contains max 3 iterations', () => {
    expect(content).toMatch(/3.*iteration|maximum.*3/i);
  });

  test('contains quality score', () => {
    expect(content).toContain('quality score');
  });

  test('contains spec review metrics path', () => {
    expect(content).toContain('spec-review.jsonl');
  });

  test('contains convergence guard', () => {
    expect(content).toMatch(/convergence/i);
  });

  // Visual Sketch (Phase 4.5)
  test('contains visual sketch section', () => {
    expect(content).toContain('Visual Sketch');
  });

  test('contains wireframe generation', () => {
    expect(content).toMatch(/wireframe|sketch/i);
  });

  test('contains DESIGN.md awareness', () => {
    expect(content).toContain('DESIGN.md');
  });

  test('contains browse rendering', () => {
    expect(content).toContain('$B goto');
    expect(content).toContain('$B screenshot');
  });

  test('contains rough aesthetic instruction', () => {
    expect(content).toMatch(/rough|hand-drawn/i);
  });
});

describe('investigate skill structure', () => {
  const content = fs.readFileSync(path.join(ROOT, 'investigate', 'SKILL.md'), 'utf-8');
  for (const section of ['Iron Law', 'Root Cause', 'Pattern Analysis', 'Hypothesis',
                          'DEBUG REPORT', '3-strike', 'BLOCKED']) {
    test(`contains ${section}`, () => expect(content).toContain(section));
  }
});

// Contributor mode was removed in v0.13.10.0 — replaced by operational self-improvement.
// Tests for contributor mode preamble structure are no longer applicable.

describe('Enum & Value Completeness in review checklist', () => {
  const checklist = fs.readFileSync(path.join(ROOT, 'review', 'checklist.md'), 'utf-8');

  test('checklist has Enum & Value Completeness section', () => {
    expect(checklist).toContain('Enum & Value Completeness');
  });

  test('Enum & Value Completeness is classified as CRITICAL', () => {
    // It should appear under Pass 1 — CRITICAL, not Pass 2
    const pass1Start = checklist.indexOf('### Pass 1');
    const pass2Start = checklist.indexOf('### Pass 2');
    const enumStart = checklist.indexOf('Enum & Value Completeness');
    expect(enumStart).toBeGreaterThan(pass1Start);
    expect(enumStart).toBeLessThan(pass2Start);
  });

  test('Enum & Value Completeness mentions tracing through consumers', () => {
    expect(checklist).toContain('Trace it through every consumer');
    expect(checklist).toContain('case');
    expect(checklist).toContain('allowlist');
  });

  test('Enum & Value Completeness is in the severity classification as CRITICAL', () => {
    const gateSection = checklist.slice(checklist.indexOf('## Severity Classification'));
    // The ASCII art has CRITICAL on the left and INFORMATIONAL on the right
    // Enum & Value Completeness should appear on a line with the CRITICAL tree (├─ or └─)
    const enumLine = gateSection.split('\n').find(l => l.includes('Enum & Value Completeness'));
    expect(enumLine).toBeDefined();
    // It's on the left (CRITICAL) side — starts with ├─ or └─
    expect(enumLine!.trimStart().startsWith('├─') || enumLine!.trimStart().startsWith('└─')).toBe(true);
  });

  test('Fix-First Heuristic exists in checklist and is referenced by review + ship', () => {
    expect(checklist).toContain('## Fix-First Heuristic');
    expect(checklist).toContain('AUTO-FIX');
    expect(checklist).toContain('ASK');

    const reviewSkill = fs.readFileSync(path.join(ROOT, 'review/SKILL.md'), 'utf-8');
    const shipSkill = fs.readFileSync(path.join(ROOT, 'ship/SKILL.md'), 'utf-8');
    expect(reviewSkill).toContain('AUTO-FIX');
    expect(reviewSkill).toContain('[AUTO-FIXED]');
    expect(shipSkill).toContain('AUTO-FIX');
    expect(shipSkill).toContain('[AUTO-FIXED]');
  });
});

// --- Completeness Principle spot-check ---

describe('Completeness Principle in generated SKILL.md files', () => {
  const skillsWithPreamble = [
    'qa/SKILL.md',
    'qa-only/SKILL.md',
    'ship/SKILL.md', 'review/SKILL.md',
    'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md',
    'retro/SKILL.md',
    'plan-design-review/SKILL.md',
    'design-review/SKILL.md',
    'design-consultation/SKILL.md',
    'document-release/SKILL.md',
    'cso/SKILL.md',  ];

  for (const skill of skillsWithPreamble) {
    test(`${skill} contains Completeness Principle section`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('Completeness Principle');
      expect(content).toContain('Boil the Lake');
    });
  }

  test('Completeness Principle keeps compact scoring guidance in tier 2+ skills', () => {
    const content = fs.readFileSync(path.join(ROOT, 'cso', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Completeness: X/10');
    expect(content).toContain('10 = all edge cases');
    expect(content).toContain('Note: options differ in kind, not coverage');
    expect(content).toContain('Do not fabricate scores');
  });
});

// --- Part 7: Planted-bug fixture validation (A4) ---

describe('Planted-bug fixture validation', () => {
  test('qa-eval ground truth has exactly 5 planted bugs', () => {
    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'qa-eval-ground-truth.json'), 'utf-8')
    );
    expect(groundTruth.bugs).toHaveLength(5);
    expect(groundTruth.total_bugs).toBe(5);
  });

  test('qa-eval-spa ground truth has exactly 5 planted bugs', () => {
    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'qa-eval-spa-ground-truth.json'), 'utf-8')
    );
    expect(groundTruth.bugs).toHaveLength(5);
    expect(groundTruth.total_bugs).toBe(5);
  });

  test('qa-eval-checkout ground truth has exactly 5 planted bugs', () => {
    const groundTruth = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'qa-eval-checkout-ground-truth.json'), 'utf-8')
    );
    expect(groundTruth.bugs).toHaveLength(5);
    expect(groundTruth.total_bugs).toBe(5);
  });

  test('qa-eval.html contains the planted bugs', () => {
    const html = fs.readFileSync(path.join(ROOT, 'browse', 'test', 'fixtures', 'qa-eval.html'), 'utf-8');
    // BUG 1: broken link
    expect(html).toContain('/nonexistent-404-page');
    // BUG 2: disabled submit
    expect(html).toContain('disabled');
    // BUG 3: overflow
    expect(html).toContain('overflow: hidden');
    // BUG 4: missing alt
    expect(html).toMatch(/<img[^>]*src="\/logo\.png"[^>]*>/);
    expect(html).not.toMatch(/<img[^>]*src="\/logo\.png"[^>]*alt=/);
    // BUG 5: console error
    expect(html).toContain("Cannot read properties of undefined");
  });

  test('review-eval-vuln.rb contains expected vulnerability patterns', () => {
    const content = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'review-eval-vuln.rb'), 'utf-8');
    expect(content).toContain('params[:id]');
    expect(content).toContain('update_column');
  });
});

// --- CEO review mode validation ---

describe('CEO review mode validation', () => {
  const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');

  test('has all four CEO review modes defined', () => {
    const modes = ['SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'HOLD SCOPE', 'SCOPE REDUCTION'];
    for (const mode of modes) {
      expect(content).toContain(mode);
    }
  });

  test('has CEO plan persistence step', () => {
    expect(content).toContain('ceo-plans');
    expect(content).toContain('status: ACTIVE');
  });

  test('has docs/designs promotion section', () => {
    expect(content).toContain('docs/designs');
    expect(content).toContain('PROMOTED');
  });

  test('mode quick reference has four columns', () => {
    expect(content).toContain('EXPANSION');
    expect(content).toContain('SELECTIVE');
    expect(content).toContain('HOLD SCOPE');
    expect(content).toContain('REDUCTION');
  });

  // Skill chaining (benefits-from)
  test('contains prerequisite skill offer for office-hours', () => {
    expect(content).toContain('Prerequisite Skill Offer');
    expect(content).toContain('/office-hours');
  });

  test('contains mid-session detection', () => {
    expect(content).toContain('Mid-session detection');
    expect(content).toMatch(/still figuring out|seems lost/i);
  });

  // Spec review on CEO plans
  test('contains spec review loop for CEO plan documents', () => {
    expect(content).toContain('Spec Review Loop');
  });
});

// --- gstack-slug helper ---

describe('gstack-slug', () => {
  const SLUG_BIN = path.join(ROOT, 'bin', 'gstack-slug');

  test('binary exists and is executable', () => {
    expect(fs.existsSync(SLUG_BIN)).toBe(true);
    const stat = fs.statSync(SLUG_BIN);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  test('outputs SLUG and BRANCH lines in a git repo', () => {
    const result = Bun.spawnSync([SLUG_BIN], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('SLUG=');
    expect(output).toContain('BRANCH=');
  });

  test('SLUG does not contain forward slashes', () => {
    const result = Bun.spawnSync([SLUG_BIN], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const slug = result.stdout.toString().match(/SLUG=(.*)/)?.[1] ?? '';
    expect(slug).not.toContain('/');
    expect(slug.length).toBeGreaterThan(0);
  });

  test('BRANCH does not contain forward slashes', () => {
    const result = Bun.spawnSync([SLUG_BIN], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const branch = result.stdout.toString().match(/BRANCH=(.*)/)?.[1] ?? '';
    expect(branch).not.toContain('/');
    expect(branch.length).toBeGreaterThan(0);
  });

  test('output is eval-compatible (KEY=VALUE format)', () => {
    const result = Bun.spawnSync([SLUG_BIN], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^SLUG=.+/);
    expect(lines[1]).toMatch(/^BRANCH=.+/);
  });

  test('output values contain only safe characters (no shell metacharacters)', () => {
    const result = Bun.spawnSync([SLUG_BIN], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const slug = result.stdout.toString().match(/SLUG=(.*)/)?.[1] ?? '';
    const branch = result.stdout.toString().match(/BRANCH=(.*)/)?.[1] ?? '';
    // Only alphanumeric, dot, dash, underscore are allowed (#133)
    expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(branch).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
  test('eval sets variables under bash with set -euo pipefail', () => {
    const result = Bun.spawnSync(
      ['bash', '-c', 'set -euo pipefail; eval "$(./bin/gstack-slug 2>/dev/null)"; echo "SLUG=$SLUG"; echo "BRANCH=$BRANCH"'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toMatch(/^SLUG=.+/m);
    expect(output).toMatch(/^BRANCH=.+/m);
  });

  test('no templates or bin scripts use source process substitution for gstack-slug', () => {
    const result = Bun.spawnSync(
      ['grep', '-r', 'source <(.*gstack-slug', '--include=*.tmpl', '--include=gstack-review-*', '.'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    // grep returns exit code 1 when no matches found — that's what we want
    expect(result.stdout.toString().trim()).toBe('');
  });
});

// --- Test Bootstrap validation ---

describe('Test Bootstrap ({{TEST_BOOTSTRAP}}) integration', () => {
  test('TEST_BOOTSTRAP resolver produces valid content', () => {
    const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(qaContent).toContain('Test Framework Bootstrap');
    expect(qaContent).toContain('RUNTIME:ruby');
    expect(qaContent).toContain('RUNTIME:node');
    expect(qaContent).toContain('RUNTIME:python');
    expect(qaContent).toContain('no-test-bootstrap');
    expect(qaContent).toContain('BOOTSTRAP_DECLINED');
  });

  test('TEST_BOOTSTRAP appears in qa/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Test Framework Bootstrap');
    expect(content).toContain('TESTING.md');
    expect(content).toContain('CLAUDE.md');
  });

  test('TEST_BOOTSTRAP appears in ship/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Test Framework Bootstrap');
    expect(content).toContain('Step 4');
  });

  test('TEST_BOOTSTRAP appears in design-review/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Test Framework Bootstrap');
  });

  test('TEST_BOOTSTRAP does NOT appear in qa-only/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md'), 'utf-8');
    expect(content).not.toContain('Test Framework Bootstrap');
    // But should have the recommendation note
    expect(content).toContain('No test framework detected');
    expect(content).toContain('Run `/qa` to bootstrap');
  });

  test('bootstrap includes framework knowledge table', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('vitest');
    expect(content).toContain('minitest');
    expect(content).toContain('pytest');
    expect(content).toContain('cargo test');
    expect(content).toContain('phpunit');
    expect(content).toContain('ExUnit');
  });

  test('bootstrap includes CI/CD pipeline generation', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('.github/workflows/test.yml');
    expect(content).toContain('GitHub Actions');
  });

  test('bootstrap includes first real tests step', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('First real tests');
    expect(content).toContain('git log --since=30.days');
    expect(content).toContain('Prioritize by risk');
  });

  test('bootstrap includes vibe coding philosophy', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('vibe coding');
    expect(content).toContain('100% test coverage');
  });

  test('WebSearch is in allowed-tools for qa, ship, design-review', () => {
    const qa = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    const ship = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const qaDesign = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
    expect(qa).toContain('WebSearch');
    expect(ship).toContain('WebSearch');
    expect(qaDesign).toContain('WebSearch');
  });
});

// --- Phase 8e.5 regression test validation ---

describe('Phase 8e.5 regression test generation', () => {
  test('qa/SKILL.md contains Phase 8e.5', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('8e.5. Regression Test');
    expect(content).toContain('test(qa): regression test');
    expect(content).toContain('WTF-likelihood exclusion');
  });

  test('qa/SKILL.md Rule 13 is amended for regression tests', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Only modify tests when generating regression tests in Phase 8e.5');
    expect(content).not.toContain('Never modify tests or CI configuration');
  });

  test('design-review has CSS-aware Phase 8e.5 variant', () => {
    const content = fs.readFileSync(path.join(ROOT, 'design-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('8e.5. Regression Test (design-review variant)');
    expect(content).toContain('CSS-only');
    expect(content).toContain('test(design): regression test');
  });

  test('regression test includes full attribution comment format', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('// Regression: ISSUE-NNN');
    expect(content).toContain('// Found by /qa on');
    expect(content).toContain('// Report: .gstack/qa-reports/');
  });

  test('regression test uses auto-incrementing names', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    expect(content).toContain('auto-incrementing');
    expect(content).toContain('max number + 1');
  });
});

// --- Step 3.4 coverage audit validation ---

describe('Step 3.4 test coverage audit', () => {
  test('ship/SKILL.md contains Step 7', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Step 7: Test Coverage Audit');
    // The coverage diagram collapses code-path and user-flow counts onto one
    // summary line. Verify that summary is present (labels are stable).
    expect(content).toContain('Code paths:');
  });

  test('Step 3.4 includes quality scoring rubric', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('★★★');
    expect(content).toContain('★★');
    expect(content).toContain('edge cases AND error paths');
    expect(content).toContain('happy path only');
  });

  test('Step 3.4 includes before/after test count', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Count test files before');
    expect(content).toContain('Count test files after');
  });

  test('ship PR body includes Test Coverage section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('## Test Coverage');
  });

  test('ship rules include test generation rule', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Step 7 generates coverage tests');
    expect(content).toContain('Never commit failing tests');
  });

  test('Step 3.4 includes vibe coding philosophy', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('vibe coding becomes yolo coding');
  });

  test('Step 3.4 traces actual codepaths, not just syntax', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Trace every codepath');
    expect(content).toContain('Trace data flow');
    expect(content).toContain('Diagram the execution');
  });

  test('Step 3.4 maps user flows and interaction edge cases', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Map user flows');
    expect(content).toContain('Interaction edge cases');
    expect(content).toContain('Double-click');
    expect(content).toContain('Navigate away');
    expect(content).toContain('Error states the user can see');
    expect(content).toContain('Empty/zero/boundary states');
  });

  test('Step 3.4 diagram includes user-flow coverage summary', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    // The diagram was compressed from separate CODE PATH COVERAGE / USER FLOW
    // COVERAGE section headers into a single summary line. Assert on the
    // labels that still appear on that summary line.
    expect(content).toContain('Code paths:');
    expect(content).toContain('User flows:');
  });
});

// --- Ship step numbering regression guard ---

describe('ship step numbering', () => {
  // Allowed sub-steps that are resolver-generated and intentionally nested:
  // 8.1 (Plan Verification), 8.2 (Scope Drift), 9.1 (Review Army), 9.2 (Findings Merge),
  // 9.3 (Cross-review dedup), 15.0 (WIP squash — continuous checkpoint), 15.1 (Bisectable commits).
  const ALLOWED_SUBSTEPS = new Set(['8.1', '8.2', '9.1', '9.2', '9.3', '15.0', '15.1']);

  test('ship/SKILL.md.tmpl contains no unexpected fractional step numbers', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md.tmpl'), 'utf-8');
    // Match "Step X.Y" where X.Y is a decimal step reference (e.g., "Step 3.47", "Step 8.1")
    const matches = Array.from(tmpl.matchAll(/Step (\d+\.\d+)/g));
    const violations = matches
      .map((m) => m[1])
      .filter((n) => !ALLOWED_SUBSTEPS.has(n));
    if (violations.length > 0) {
      const unique = Array.from(new Set(violations)).sort();
      throw new Error(
        `ship/SKILL.md.tmpl contains fractional step numbers that are not in the allowed sub-step list.\n` +
          `  Found: ${unique.join(', ')}\n` +
          `  Allowed sub-steps: ${Array.from(ALLOWED_SUBSTEPS).sort().join(', ')}\n` +
          `  Fix: use clean integer step numbers (1-20), or add to ALLOWED_SUBSTEPS if intentional.`
      );
    }
  });

  test('ship/SKILL.md main headings use clean integer step numbers', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    // Headings like "## Step 7: Test Coverage Audit" — NOT sub-steps like "## Step 8.1:"
    const headings = Array.from(skill.matchAll(/^## Step (\d+(?:\.\d+)?):/gm)).map(
      (m) => m[1]
    );
    const fractional = headings.filter((n) => n.includes('.'));
    const unexpected = fractional.filter((n) => !ALLOWED_SUBSTEPS.has(n));
    expect(unexpected).toEqual([]);
  });

  test('review/SKILL.md step numbers unchanged (regression guard for resolver conditionals)', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    // /review uses its own fractional numbering: 1.5, 2.5, 4.5, 5.5, 5.6, 5.7, 5.8
    // If the ship-side renumber accidentally touched the review-side of resolver conditionals,
    // these would vanish. This test catches that.
    expect(skill).toContain('## Step 1.5: Scope Drift Detection');
    expect(skill).toContain('## Step 4.5: Review Army');
    expect(skill).toContain('## Step 5.7: Adversarial review');
  });
});

// --- Retro test health validation ---

describe('Retro test health tracking', () => {
  test('retro/SKILL.md has test health data gathering commands', () => {
    const content = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
    expect(content).toContain('# 10. Test file count');
    expect(content).toContain('# 11. Regression test commits');
    expect(content).toContain('# 12. Test files changed');
  });

  test('retro/SKILL.md has Test Health metrics row', () => {
    const content = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Test Health');
    expect(content).toContain('regression tests');
  });

  test('retro/SKILL.md has Test Health narrative section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
    expect(content).toContain('### Test Health');
    expect(content).toContain('Total test files');
    expect(content).toContain('vibe coding safe');
  });

  test('retro JSON schema includes test_health field', () => {
    const content = fs.readFileSync(path.join(ROOT, 'retro', 'SKILL.md'), 'utf-8');
    expect(content).toContain('test_health');
    expect(content).toContain('total_test_files');
    expect(content).toContain('regression_test_commits');
  });
});

// --- QA report template regression tests section ---

describe('QA report template', () => {
  test('qa-report-template.md has Regression Tests section', () => {
    const content = fs.readFileSync(path.join(ROOT, 'qa', 'templates', 'qa-report-template.md'), 'utf-8');
    expect(content).toContain('## Regression Tests');
    expect(content).toContain('committed / deferred / skipped');
    expect(content).toContain('### Deferred Tests');
    expect(content).toContain('**Precondition:**');
  });
});

// --- Codex skill validation ---

describe('Codex skill', () => {
  test('codex/SKILL.md exists and has correct frontmatter', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('name: codex');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('allowed-tools:');
  });

  test('codex/SKILL.md contains all three modes', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Step 2A: Review Mode');
    expect(content).toContain('Step 2B: Challenge');
    expect(content).toContain('Step 2C: Consult Mode');
  });

  test('codex/SKILL.md contains gate verdict logic', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('[P1]');
    expect(content).toContain('GATE: PASS');
    expect(content).toContain('GATE: FAIL');
  });

  test('codex/SKILL.md contains session continuity', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('codex-session-id');
    expect(content).toContain('codex exec resume');
  });

  test('codex/SKILL.md contains cost tracking', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('tokens used');
    expect(content).toContain('Est. cost');
  });

  test('codex/SKILL.md contains cross-model comparison', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('CROSS-MODEL ANALYSIS');
    expect(content).toContain('Agreement rate');
  });

  test('codex/SKILL.md contains review log persistence', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('codex-review');
    expect(content).toContain('gstack-review-log');
  });

  test('codex/SKILL.md uses which for binary discovery, not hardcoded path', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('which codex');
    expect(content).not.toContain('/opt/homebrew/bin/codex');
  });

  test('codex/SKILL.md contains error handling for missing binary and auth', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('NOT_FOUND');
    expect(content).toContain('codex login');
  });

  test('codex/SKILL.md uses mktemp for temp files', () => {
    const content = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(content).toContain('mktemp');
  });

  test('adversarial review in /review always runs both passes', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Adversarial review (always-on)');
    // Always-on: both Claude and Codex adversarial
    expect(content).toContain('Claude adversarial subagent (always runs)');
    expect(content).toContain('Codex adversarial challenge (always runs when available)');
    // Claude adversarial subagent dispatch
    expect(content).toContain('Agent tool');
    expect(content).toContain('FIXABLE');
    expect(content).toContain('INVESTIGATE');
    // Codex availability check
    expect(content).toContain('CODEX_NOT_AVAILABLE');
    // OLD_CFG only gates Codex, not Claude
    expect(content).toContain('skip Codex passes only');
    // Review log
    expect(content).toContain('adversarial-review');
    expect(content).toContain('reasoning_effort="high"');
    expect(content).toContain('ADVERSARIAL REVIEW SYNTHESIS');
    // Large diff structured review still gated
    expect(content).toContain('Codex structured review (large diffs only');
    expect(content).toContain('200');
  });

  test('adversarial review in /ship always runs both passes', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Adversarial review (always-on)');
    expect(content).toContain('adversarial-review');
    expect(content).toContain('reasoning_effort="high"');
    expect(content).toContain('Investigate and fix');
    expect(content).toContain('Claude adversarial subagent (always runs)');
  });

  test('scope drift detection in /review and /ship', () => {
    const reviewContent = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    const shipContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    // Both should contain scope drift from the shared resolver
    for (const content of [reviewContent, shipContent]) {
      expect(content).toContain('Scope Check:');
      expect(content).toContain('DRIFT DETECTED');
      expect(content).toContain('SCOPE CREEP');
      expect(content).toContain('MISSING REQUIREMENTS');
      expect(content).toContain('stated intent');
    }
  });

  test('codex-host ship/review do NOT contain adversarial review step', () => {
    // .agents/ is gitignored — generate on demand
    Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    const shipContent = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'gstack-ship', 'SKILL.md'), 'utf-8');
    expect(shipContent).not.toContain('codex review --base');
    expect(shipContent).not.toContain('CODEX_REVIEWS');

    const reviewContent = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(reviewContent).not.toContain('codex review --base');
    expect(reviewContent).not.toContain('codex_reviews');
    expect(reviewContent).not.toContain('CODEX_REVIEWS');
    expect(reviewContent).not.toContain('adversarial-review');
    expect(reviewContent).not.toContain('Investigate and fix');
  });

  test('codex integration in /plan-eng-review offers plan critique', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Codex');
    expect(content).toContain('codex exec');
  });

  test('/review persists a review-log entry for ship readiness', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('"skill":"review"');
    expect(content).toContain('"issues_found":N');
    expect(content).toContain('Persist Eng Review result');
  });

  test('Review Readiness Dashboard includes Adversarial Review row', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Adversarial');
    expect(content).toContain('codex-review');
  });
});

// --- Trigger phrase validation ---

describe('Skill trigger phrases', () => {
  // Skills that must have "Use when" trigger phrases in their description.
  // Excluded: root gstack (browser tool), gstack-upgrade (gstack-specific),
  // humanizer (text tool)
  const SKILLS_REQUIRING_TRIGGERS = [
    'qa', 'qa-only', 'ship', 'review', 'investigate', 'office-hours',
    'plan-ceo-review', 'plan-eng-review', 'plan-design-review',
    'design-review', 'design-consultation', 'retro', 'document-release',
    'codex', 'browse', 'setup-browser-cookies',
  ];

  for (const skill of SKILLS_REQUIRING_TRIGGERS) {
    test(`${skill}/SKILL.md has "Use when" trigger phrases`, () => {
      const skillPath = path.join(ROOT, skill, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return;
      const content = fs.readFileSync(skillPath, 'utf-8');
      // Extract description from frontmatter
      const frontmatterEnd = content.indexOf('---', 4);
      const frontmatter = content.slice(0, frontmatterEnd);
      expect(frontmatter).toMatch(/Use when/i);
    });
  }

  // Skills with proactive triggers should have "Proactively suggest" in description
  const SKILLS_REQUIRING_PROACTIVE = [
    'qa', 'qa-only', 'ship', 'review', 'investigate', 'office-hours',
    'plan-ceo-review', 'plan-eng-review', 'plan-design-review',
    'design-review', 'design-consultation', 'retro', 'document-release',
  ];

  for (const skill of SKILLS_REQUIRING_PROACTIVE) {
    test(`${skill}/SKILL.md has proactive routing phrase`, () => {
      const skillPath = path.join(ROOT, skill, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return;
      const content = fs.readFileSync(skillPath, 'utf-8');
      const frontmatterEnd = content.indexOf('---', 4);
      const frontmatter = content.slice(0, frontmatterEnd);
      expect(frontmatter).toMatch(/Proactively (suggest|invoke)/i);
    });
  }
});

// ─── Codex Skill Validation ──────────────────────────────────

describe('Codex skill validation', () => {
  const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');

  // .agents/ is gitignored (v0.11.2.0) — generate on demand for tests
  Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
  });

  // Discover all shared skills with templates.
  // Host-exclusive outside-voice skills are intentionally omitted here:
  // - /codex is Claude-only
  // - /claude is external-host-only
  const CLAUDE_SKILLS_WITH_TEMPLATES = (() => {
    const skills: string[] = [];
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.name === 'codex') continue; // Claude-only skill
      if (entry.name === 'claude') continue; // External-host-only skill
      if (fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) {
        skills.push(entry.name);
      }
    }
    return skills;
  })();

  test('all skills (except /codex) have both Claude and Codex variants', () => {
    for (const skillDir of CLAUDE_SKILLS_WITH_TEMPLATES) {
      // Claude variant
      const claudeMd = path.join(ROOT, skillDir, 'SKILL.md');
      expect(fs.existsSync(claudeMd)).toBe(true);

      // Codex variant
      const codexName = skillDir.startsWith('gstack-') ? skillDir : `gstack-${skillDir}`;
      const codexMd = path.join(AGENTS_DIR, codexName, 'SKILL.md');
      expect(fs.existsSync(codexMd)).toBe(true);
    }
    // Root template has both too
    expect(fs.existsSync(path.join(ROOT, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack', 'SKILL.md'))).toBe(true);
  });

  test('/codex skill is Claude-only — no Codex variant', () => {
    // Claude variant should exist
    expect(fs.existsSync(path.join(ROOT, 'codex', 'SKILL.md'))).toBe(true);
    // Codex variant must NOT exist
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-codex', 'SKILL.md'))).toBe(false);
  });

  test('/claude skill is external-host-only — no Claude-host variant', () => {
    // Claude host should not get an outside-voice skill that shells into Claude.
    expect(fs.existsSync(path.join(ROOT, 'claude', 'SKILL.md'))).toBe(false);
    // Codex/external hosts should get the generated wrapper.
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-claude', 'SKILL.md'))).toBe(true);
  });

  test('Codex skill names follow gstack-{name} convention', () => {
    const codexDirs = fs.readdirSync(AGENTS_DIR);
    for (const dir of codexDirs) {
      // Every directory should start with gstack
      expect(dir.startsWith('gstack')).toBe(true);
      // Root is just 'gstack', others are 'gstack-{name}'
      if (dir !== 'gstack') {
        expect(dir.startsWith('gstack-')).toBe(true);
      }
    }
  });

  test('$B commands in Codex SKILL.md files are valid browse commands', () => {
    const codexDirs = fs.readdirSync(AGENTS_DIR);
    for (const dir of codexDirs) {
      const skillMd = path.join(AGENTS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Only validate if the skill contains $B commands
      if (!content.includes('$B ')) continue;
      const result = validateSkill(skillMd);
      expect(result.invalid).toHaveLength(0);
    }
  });
});

// --- Repo mode and test failure triage validation ---

describe('Repo mode preamble validation', () => {
  test('generated SKILL.md preamble contains REPO_MODE output', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('REPO_MODE:');
    expect(content).toContain('gstack-repo-mode');
  });

  test('tier 3+ skills contain See Something Say Something section', () => {
    // Root SKILL.md is tier 1 (no Repo Mode). Check a tier 3 skill instead.
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('See Something, Say Something');
    expect(content).toContain('REPO_MODE');
    expect(content).toContain('solo');
    expect(content).toContain('collaborative');
  });
});

describe('Test failure triage in ship skill', () => {
  test('ship/SKILL.md contains Test Failure Ownership Triage', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Test Failure Ownership Triage');
  });

  test('ship/SKILL.md triage uses git diff for classification', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('git diff origin/<base>...HEAD --name-only');
  });

  test('ship/SKILL.md triage has solo and collaborative paths', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('REPO_MODE');
    expect(content).toContain('solo');
    expect(content).toContain('collaborative');
    expect(content).toContain('Investigate and fix now');
    expect(content).toContain('Add as P0 TODO');
  });

  test('ship/SKILL.md triage has GitHub issue assignment for collaborative mode', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('gh issue create');
    expect(content).toContain('--assignee');
  });

  test('{{TEST_FAILURE_TRIAGE}} placeholder is fully resolved in ship/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).not.toContain('{{TEST_FAILURE_TRIAGE}}');
  });

  test('ship/SKILL.md uses in-branch language for stop condition', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('In-branch test failures');
  });
});

describe('no compiled binaries in git', () => {
  // Tracked files enumerated once and reused by both assertions. git ls-files -z
  // + split is ~ms; the previous xargs-per-file shell loops blew past 5s on CI.
  const trackedFiles: string[] = require('child_process')
    .execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter(Boolean);

  test('git tracks no Mach-O or ELF binaries', () => {
    // Only mode 100755 (executable) files can be binaries we care about. Pre-filter
    // via git ls-files -s to avoid running `file` on every text file.
    const lsOut: string = require('child_process').execSync('git ls-files -s', {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    const executableFiles = lsOut
      .split('\n')
      .filter(Boolean)
      .map((line: string) => {
        const parts = line.split(/\s+/);
        return { mode: parts[0], file: line.split('\t')[1] };
      })
      .filter((e: { mode: string; file: string }) => e.mode === '100755')
      .map((e: { mode: string; file: string }) => e.file);

    if (executableFiles.length === 0) return;

    // Batch-invoke `file --mime-type` across all executable files at once.
    const result: string = require('child_process')
      .execSync(`file --mime-type -- ${executableFiles.map((f: string) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')}`, {
        cwd: ROOT,
        encoding: 'utf-8',
      })
      .trim();

    const binaries = result
      .split('\n')
      .filter((l: string) =>
        /application\/(x-mach-binary|x-executable|x-pie-executable|x-sharedlib)/.test(l)
      )
      .map((l: string) => l.split(':')[0].trim());

    expect(binaries).toEqual([]);
  });

  test('warns about tracked files larger than 2MB', () => {
    // Large fixtures can be legitimate test infrastructure. Keep visibility on
    // repository size without blocking those fixtures from living in git.
    // Known-good fixtures are exempted from the warning to keep CI logs clean.
    const MAX_BYTES = 2 * 1024 * 1024;
    const knownLargeFixtures = new Set([
      // Deterministic replay fixture for BrowseSafe-Bench. The live bench is
      // expensive; this file is intentionally committed so the gate is free.
      'browse/test/fixtures/security-bench-haiku-responses.json',
    ]);
    const oversized = trackedFiles.flatMap((f: string) => {
      if (knownLargeFixtures.has(f)) return [];
      const full = path.join(ROOT, f);
      try {
        const size = fs.statSync(full).size;
        return size > MAX_BYTES ? [{ file: f, size }] : [];
      } catch {
        return [];
      }
    });

    if (oversized.length > 0) {
      const formatted = oversized
        .map(({ file, size }: { file: string; size: number }) => {
          const mib = (size / (1024 * 1024)).toFixed(1);
          return `${file} (${mib} MiB)`;
        })
        .join(', ');
      console.warn(`[size-warning] tracked files over 2 MiB: ${formatted}`);
    }

    expect(Array.isArray(oversized)).toBe(true);
  });
});

// `sidebar agent (#584)` describe block was here. sidebar-agent.ts and
// the entire chat-queue path were ripped in favor of the interactive
// claude PTY (terminal-agent.ts); these assertions had no target file.
// Terminal-pane invariants are covered by browse/test/sidebar-tabs.test.ts
// and browse/test/terminal-agent.test.ts.

// ─── Browser-skills validation ──────────────────────────────────
//
// Browser-skills are bundled in <gstack-root>/browser-skills/<name>/. Each
// must have a SKILL.md whose frontmatter satisfies the contract enforced by
// browse/src/browser-skills.ts:parseSkillFile (host required, args + triggers
// parseable as the right shape). This test catches malformed bundled skills
// at CI time, before they ship.

describe('Bundled browser-skills frontmatter contract', () => {
  const browserSkillsRoot = path.join(ROOT, 'browser-skills');

  function listBundledSkillDirs(): string[] {
    if (!fs.existsSync(browserSkillsRoot)) return [];
    return fs.readdirSync(browserSkillsRoot)
      .filter(name => !name.startsWith('.'))
      .map(name => path.join(browserSkillsRoot, name))
      .filter(dir => {
        try { return fs.statSync(dir).isDirectory(); } catch { return false; }
      });
  }

  test('each bundled skill has a SKILL.md', () => {
    for (const dir of listBundledSkillDirs()) {
      const skillFile = path.join(dir, 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);
    }
  });

  test('each bundled skill SKILL.md frontmatter parses with required fields', async () => {
    const { parseSkillFile } = await import('../browse/src/browser-skills');
    for (const dir of listBundledSkillDirs()) {
      const name = path.basename(dir);
      const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      // parseSkillFile throws on missing required fields; we just want to
      // make sure none of our shipped skills tripwire it.
      const { frontmatter } = parseSkillFile(content, { skillName: name });
      expect(frontmatter.name).toBe(name);
      expect(typeof frontmatter.host).toBe('string');
      expect(frontmatter.host.length).toBeGreaterThan(0);
      expect(Array.isArray(frontmatter.triggers)).toBe(true);
      expect(Array.isArray(frontmatter.args)).toBe(true);
    }
  });

  test('each bundled skill has a script.ts', () => {
    for (const dir of listBundledSkillDirs()) {
      expect(fs.existsSync(path.join(dir, 'script.ts'))).toBe(true);
    }
  });

  test('each bundled skill ships a sibling SDK at _lib/browse-client.ts', () => {
    for (const dir of listBundledSkillDirs()) {
      expect(fs.existsSync(path.join(dir, '_lib', 'browse-client.ts'))).toBe(true);
    }
  });

  test('each bundled skill has a script.test.ts', () => {
    for (const dir of listBundledSkillDirs()) {
      expect(fs.existsSync(path.join(dir, 'script.test.ts'))).toBe(true);
    }
  });

  test("each bundled skill's _lib/browse-client.ts matches the canonical SDK", () => {
    // If the canonical SDK changes, the bundled copy must be updated. This
    // test enforces that — the _lib copy should be byte-identical.
    const canonical = fs.readFileSync(path.join(ROOT, 'browse', 'src', 'browse-client.ts'), 'utf-8');
    for (const dir of listBundledSkillDirs()) {
      const sibling = fs.readFileSync(path.join(dir, '_lib', 'browse-client.ts'), 'utf-8');
      expect(sibling).toBe(canonical);
    }
  });

  test('script.ts imports browse from ./_lib/browse-client', () => {
    for (const dir of listBundledSkillDirs()) {
      const content = fs.readFileSync(path.join(dir, 'script.ts'), 'utf-8');
      expect(content).toMatch(/from\s+['"]\.\/_lib\/browse-client['"]/);
    }
  });
});
