import { describe, test, expect } from 'bun:test';
import { validateSkill, extractRemoteSlugPatterns, extractWeightsFromTable } from './helpers/skill-parser';
import { ALL_COMMANDS, COMMAND_DESCRIPTIONS, READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const CODEX_SKILLS = [
  '.',
  'browse',
  'design-consultation',
  'document-release',
  'gstack-upgrade',
  'plan-ceo-review',
  'plan-design-review',
  'plan-eng-review',
  'qa',
  'qa-design-review',
  'qa-only',
  'retro',
  'review',
  'setup-browser-cookies',
  'ship',
];

function codexSkillName(dir: string): string {
  if (dir === '.') return 'gstack';
  return dir.startsWith('gstack-') ? dir : `gstack-${dir}`;
}

function codexSkillPath(dir: string): string {
  return path.join(ROOT, '.agents', 'skills', codexSkillName(dir), 'SKILL.md');
}

function frontmatter(content: string): string {
  expect(content.startsWith('---\n')).toBe(true);
  const end = content.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(3);
  return content.slice(4, end);
}

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

  test('all $B commands in qa-design-review/SKILL.md are valid browse commands', () => {
    const skill = path.join(ROOT, 'qa-design-review', 'SKILL.md');
    if (!fs.existsSync(skill)) return;
    const result = validateSkill(skill);
    expect(result.invalid).toHaveLength(0);
  });

  test('all snapshot flags in qa-design-review/SKILL.md are valid', () => {
    const skill = path.join(ROOT, 'qa-design-review', 'SKILL.md');
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

describe('Codex-generated SKILL.md validation', () => {
  test('every Codex-generated SKILL.md has YAML frontmatter with the expected name', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(codexSkillPath(skill), 'utf-8');
      const yaml = frontmatter(content);
      expect(yaml).toContain(`name: ${codexSkillName(skill)}`);
      expect(yaml).toContain('description: |');
    }
  });

  test('every Codex-generated SKILL.md has a non-empty description', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(codexSkillPath(skill), 'utf-8');
      const yaml = frontmatter(content);
      const match = yaml.match(/description:\s*\|\n([\s\S]+)/);
      expect(match).not.toBeNull();
      const lines = match![1]
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
    }
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
    'plan-design-review/SKILL.md',
    'qa-design-review/SKILL.md',
    'design-consultation/SKILL.md',
    'document-release/SKILL.md',
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
  const skillsWithPreamble = [
    'SKILL.md', 'browse/SKILL.md', 'qa/SKILL.md',
    'qa-only/SKILL.md',
    'setup-browser-cookies/SKILL.md',
    'ship/SKILL.md', 'review/SKILL.md',
    'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md',
    'retro/SKILL.md',
    'plan-design-review/SKILL.md',
    'qa-design-review/SKILL.md',
    'design-consultation/SKILL.md',
    'document-release/SKILL.md',
  ];

  for (const skill of skillsWithPreamble) {
    test(`${skill} contains RECOMMENDATION format`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('RECOMMENDATION: Choose');
      expect(content).toContain('AskUserQuestion');
    });

    test(`${skill} contains session awareness`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('_SESSIONS');
      expect(content).toContain('RECOMMENDATION');
    });
  }
});

// --- Contributor mode preamble structure validation ---

describe('Contributor mode preamble structure', () => {
  const skillsWithPreamble = [
    'SKILL.md', 'browse/SKILL.md', 'qa/SKILL.md',
    'qa-only/SKILL.md',
    'setup-browser-cookies/SKILL.md',
    'ship/SKILL.md', 'review/SKILL.md',
    'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md',
    'retro/SKILL.md',
  ];

  for (const skill of skillsWithPreamble) {
    test(`${skill} has 0-10 rating in contributor mode`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('0 to 10');
      expect(content).toContain('My rating');
    });

    test(`${skill} has calibration example`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('Calibration');
      expect(content).toContain('the bar');
    });

    test(`${skill} has "what would make this a 10" field`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('What would make this a 10');
    });

    test(`${skill} uses periodic reflection (not per-command)`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill), 'utf-8');
      expect(content).toContain('workflow step');
      expect(content).not.toContain('After you use gstack-provided CLIs');
    });
  }
});

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
