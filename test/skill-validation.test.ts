import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Research skill validation', () => {
  const skills = ['SKILL.md', 'hypothesis/SKILL.md', 'run-experiment/SKILL.md', 'report/SKILL.md'];

  for (const skill of skills) {
    const skillPath = path.join(ROOT, skill);

    test(`${skill} exists`, () => {
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    test(`${skill} has no unresolved placeholders`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      const placeholders = content.match(/\{\{[A-Z_]+\}\}/g);
      expect(placeholders).toBeNull();
    });

    test(`${skill} has valid frontmatter`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('\n---\n');
      expect(content).toMatch(/^name:\s+\S+/m);
      expect(content).toMatch(/^description:\s/m);
    });

    test(`${skill} has AUTO-GENERATED header`, () => {
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content).toContain('AUTO-GENERATED from');
    });
  }

  test('hypothesis/SKILL.md contains key workflow steps', () => {
    const content = fs.readFileSync(path.join(ROOT, 'hypothesis', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Step 1: Capture the idea');
    expect(content).toContain('spec.yaml');
    expect(content).toContain('AskUserQuestion');
    expect(content).toContain('learnings');
  });

  test('run-experiment/SKILL.md has approval gate', () => {
    const content = fs.readFileSync(path.join(ROOT, 'run-experiment', 'SKILL.md'), 'utf-8');
    expect(content).toContain('APPROVAL GATE');
    expect(content).toContain('Phase A');
    expect(content).toContain('Phase B');
    expect(content).toContain('provenance');
  });

  test('report/SKILL.md references baselines and plots', () => {
    const content = fs.readFileSync(path.join(ROOT, 'report', 'SKILL.md'), 'utf-8');
    expect(content).toContain('baseline');
    expect(content).toContain('matplotlib');
    expect(content).toContain('metrics.json');
    expect(content).toContain('provenance.json');
  });

  test('root SKILL.md has routing rules for all 3 skills', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('/hypothesis');
    expect(content).toContain('/run-experiment');
    expect(content).toContain('/report');
  });

  test('all skills reference provenance spec', () => {
    const runExp = fs.readFileSync(path.join(ROOT, 'run-experiment', 'SKILL.md'), 'utf-8');
    expect(runExp).toContain('git_sha');
    expect(runExp).toContain('wall_clock_seconds');
    expect(runExp).toContain('random_seeds');
  });

  test('research conventions resolver outputs convention reading instructions', () => {
    const root = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(root).toContain('Research conventions');
    expect(root).toContain('CLAUDE.md');
  });

  test('experiment structure resolver outputs directory layout', () => {
    const root = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(root).toContain('research/');
    expect(root).toContain('hypotheses/');
    expect(root).toContain('experiments/');
    expect(root).toContain('results/');
    expect(root).toContain('baselines/');
    expect(root).toContain('reports/');
  });
});

describe('Template freshness', () => {
  const templates = [
    'SKILL.md.tmpl',
    'hypothesis/SKILL.md.tmpl',
    'run-experiment/SKILL.md.tmpl',
    'report/SKILL.md.tmpl',
  ];

  for (const tmpl of templates) {
    test(`${tmpl} exists`, () => {
      expect(fs.existsSync(path.join(ROOT, tmpl))).toBe(true);
    });
  }
});
