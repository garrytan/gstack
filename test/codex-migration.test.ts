import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const SKILL_DIRS = [
  '.',
  'browse',
  'qa',
  'qa-only',
  'review',
  'ship',
  'plan-ceo-review',
  'plan-eng-review',
  'plan-design-review',
  'design-consultation',
  'design-review',
  'setup-browser-cookies',
  'retro',
  'document-release',
  'gstack-upgrade',
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

describe('Codex migration', () => {
  test('package metadata is renamed for the fork', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe('gstack-codex');
    expect(pkg.description.toLowerCase()).toContain('codex');
  });

  test('skills ship Codex UI metadata', () => {
    for (const dir of SKILL_DIRS) {
      const metadataPath = path.join(ROOT, dir, 'agents', 'openai.yaml');
      expect(fs.existsSync(metadataPath)).toBe(true);
    }
  });

  test('repo no longer hardcodes Claude skill install paths', () => {
    const targets = [
      'README.md',
      'ARCHITECTURE.md',
      'AGENTS.md',
      'setup',
      'scripts/gen-skill-docs.ts',
      'SKILL.md.tmpl',
      'browse/SKILL.md.tmpl',
      'qa/SKILL.md.tmpl',
      'qa-only/SKILL.md.tmpl',
      'review/SKILL.md.tmpl',
      'ship/SKILL.md.tmpl',
      'plan-ceo-review/SKILL.md.tmpl',
      'plan-eng-review/SKILL.md.tmpl',
      'plan-design-review/SKILL.md.tmpl',
      'design-consultation/SKILL.md.tmpl',
      'design-review/SKILL.md.tmpl',
      'setup-browser-cookies/SKILL.md.tmpl',
      'retro/SKILL.md.tmpl',
      'document-release/SKILL.md.tmpl',
      'gstack-upgrade/SKILL.md.tmpl',
    ];

    for (const relPath of targets) {
      const content = read(relPath);
      expect(content).not.toContain('~/.claude/skills');
      expect(content).not.toContain('.claude/skills');
      expect(content).not.toContain('CLAUDE.md');
    }
  });

  test('generated skills do not use Claude-only prompt conventions', () => {
    for (const dir of SKILL_DIRS) {
      const skillPath = path.join(ROOT, dir, 'SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content).not.toContain('allowed-tools:');
      expect(content).not.toContain('AskUserQuestion');
      expect(content).not.toContain('mcp__claude-in-chrome');
    }
  });

  test('eval harness is not tied to Claude CLI or the Anthropic SDK', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(JSON.stringify(pkg.scripts)).not.toContain('claude -p');
    expect(pkg.devDependencies?.['@anthropic-ai/sdk']).toBeUndefined();

    const repoText = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
      + '\n'
      + fs.readFileSync(path.join(ROOT, 'test', 'helpers', 'session-runner.ts'), 'utf-8');
    expect(repoText).not.toContain('claude -p');
    expect(repoText).toContain('codex exec');
  });

  test('core docs describe the actual Codex exec command and session model', () => {
    const architecture = read('ARCHITECTURE.md');
    const changelog = read('CHANGELOG.md');

    expect(architecture).not.toContain('codex -q --json');
    expect(architecture).not.toContain('Spawn real Claude session');
    expect(changelog).not.toContain('codex -q --json');
  });

  test('generated prompts do not contain malformed pause-for-user-input phrasing', () => {
    for (const dir of SKILL_DIRS) {
      const skillPath = path.join(ROOT, dir, 'SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content).not.toContain('an pause for user input');
      expect(content).not.toContain('call pause for user input');
    }
  });
});
