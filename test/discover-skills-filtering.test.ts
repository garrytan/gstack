import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverTemplates, discoverSkillFiles } from '../scripts/discover-skills';

describe('discover-skills directory exclusions', () => {
  test('discoverTemplates skips dot-prefixed and excluded host directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-discover-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'SKILL.md.tmpl'), '---\nname: evil\n---\ntest');
      fs.mkdirSync(path.join(tmpDir, 'claude'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'claude', 'SKILL.md.tmpl'), '---\nname: claude\n---\ntest');
      fs.mkdirSync(path.join(tmpDir, 'patches'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'patches', 'SKILL.md.tmpl'), '---\nname: patches\n---\ntest');
      fs.mkdirSync(path.join(tmpDir, 'visible'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'visible', 'SKILL.md.tmpl'), '---\nname: good\n---\ntest');

      const results = discoverTemplates(tmpDir);
      const dirs = results.map(r => r.tmpl);

      expect(dirs).toContain('visible/SKILL.md.tmpl');
      expect(dirs).not.toContain('.hidden/SKILL.md.tmpl');
      expect(dirs).not.toContain('claude/SKILL.md.tmpl');
      expect(dirs).not.toContain('patches/SKILL.md.tmpl');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('discoverSkillFiles skips dot-prefixed and excluded host directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-discover-skills-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'SKILL.md'), '---\nname: hidden\n---\ntest');
      fs.mkdirSync(path.join(tmpDir, 'claude'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'claude', 'SKILL.md'), '---\nname: claude\n---\ntest');
      fs.mkdirSync(path.join(tmpDir, 'valid-skill'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'valid-skill', 'SKILL.md'), '---\nname: valid\n---\ntest');

      const results = discoverSkillFiles(tmpDir);

      expect(results).toContain('valid-skill/SKILL.md');
      expect(results).not.toContain('.hidden/SKILL.md');
      expect(results).not.toContain('claude/SKILL.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
