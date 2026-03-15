import { describe, test, expect } from 'bun:test';
import { validateSkill, extractRemoteSlugPatterns, extractWeightsFromTable } from './helpers/skill-parser';
import { ALL_COMMANDS, COMMAND_DESCRIPTIONS, READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from '../lib/agent-browser-commands';
import { SNAPSHOT_FLAGS } from '../lib/snapshot-flags';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('SKILL.md command validation', () => {
  test('all agent-browser commands in SKILL.md are valid', () => {
    const result = validateSkill(path.join(ROOT, 'SKILL.md'));
    expect(result.invalid).toHaveLength(0);
    expect(result.valid.length).toBeGreaterThan(0);
  });

  test('all snapshot flags in SKILL.md are valid', () => {
    const result = validateSkill(path.join(ROOT, 'SKILL.md'));
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('all agent-browser commands in qa/SKILL.md are valid', () => {
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
      'interactive', 'compact', 'selector',
    ]);
    for (const flag of SNAPSHOT_FLAGS) {
      expect(validKeys.has(flag.optionKey)).toBe(true);
    }
  });
});

describe('Generated SKILL.md freshness', () => {
  test('no unresolved {{placeholders}} in generated SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
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
    'SKILL.md', 'qa/SKILL.md',
    'setup-browser-cookies/SKILL.md',
    'ship/SKILL.md', 'review/SKILL.md',
    'plan-ceo-review/SKILL.md', 'plan-eng-review/SKILL.md',
    'retro/SKILL.md',
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

  test('qa/SKILL.md has all 6 phases', () => {
    const phases = [
      'Phase 1', 'Initialize',
      'Phase 2', 'Authenticate',
      'Phase 3', 'Orient',
      'Phase 4', 'Explore',
      'Phase 5', 'Document',
      'Phase 6', 'Wrap Up',
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
    const html = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'qa-eval.html'), 'utf-8');
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
