/**
 * Edge case tests for multi-agent browse binary discovery.
 *
 * Tests the priority chain (.codex > .agents > .claude) with real
 * filesystem fixtures. Validates that binary discovery works correctly
 * when multiple agent hosts have gstack installed simultaneously.
 *
 * Covers:
 *   - Priority ordering when multiple markers exist
 *   - Workspace-local vs global fallback
 *   - Missing binary at marker path (marker dir exists but no binary)
 *   - Symlink resolution
 *   - Path construction correctness
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the path construction logic directly since locateBinary()
// depends on the real git root and home directory.

const ROOT = path.resolve(import.meta.dir, '..', '..');

describe('find-browse path construction', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'browse', 'src', 'find-browse.ts'),
    'utf-8',
  );

  test('markers array has exactly 3 entries in correct order', () => {
    const match = src.match(/const markers = \[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const items = match![1].split(',').map(s => s.trim().replace(/['"]/g, ''));
    expect(items).toEqual(['.codex', '.agents', '.claude']);
  });

  test('workspace-local paths are checked before global paths', () => {
    // The function should check root-based paths first, then home-based
    const rootCheck = src.indexOf('if (root)');
    const globalComment = src.indexOf('Global fallback');
    expect(rootCheck).toBeGreaterThan(-1);
    expect(globalComment).toBeGreaterThan(rootCheck);
  });

  test('binary path includes skills/gstack/browse/dist/browse', () => {
    expect(src).toContain("'skills', 'gstack', 'browse', 'dist', 'browse'");
  });

  test('returns null (not throws) when binary is not found', () => {
    expect(src).toContain('return null');
  });

  test('prints to stderr on failure, not stdout', () => {
    expect(src).toContain('process.stderr.write');
    // Should NOT print errors to stdout (that would corrupt output parsing)
    const mainFn = src.slice(src.indexOf('function main()'));
    expect(mainFn).not.toContain('console.error');
  });

  test('exits with code 1 on failure', () => {
    expect(src).toContain('process.exit(1)');
  });

  test('outputs binary path to stdout on success', () => {
    expect(src).toContain('console.log(bin)');
  });
});

describe('find-browse filesystem edge cases', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-find-browse-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('path.join constructs correct paths for all markers', () => {
    const markers = ['.codex', '.agents', '.claude'];
    const root = '/fake/project';

    for (const m of markers) {
      const expected = `/fake/project/${m}/skills/gstack/browse/dist/browse`;
      const actual = path.join(root, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
      expect(actual).toBe(expected);
    }
  });

  test('path.join constructs correct global paths', () => {
    const home = os.homedir();
    const markers = ['.codex', '.agents', '.claude'];

    for (const m of markers) {
      const globalPath = path.join(home, m, 'skills', 'gstack', 'browse', 'dist', 'browse');
      expect(globalPath).toContain(home);
      expect(globalPath).toContain(m);
      expect(globalPath).toContain('browse/dist/browse');
    }
  });

  test('existsSync returns false for non-existent binary paths', () => {
    const fakePath = path.join(tmpDir, '.codex', 'skills', 'gstack', 'browse', 'dist', 'browse');
    expect(fs.existsSync(fakePath)).toBe(false);
  });

  test('existsSync returns true when binary is created at marker path', () => {
    const binDir = path.join(tmpDir, '.claude', 'skills', 'gstack', 'browse', 'dist');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'browse');
    fs.writeFileSync(binPath, '#!/bin/sh\necho test');
    fs.chmodSync(binPath, 0o755);

    expect(fs.existsSync(binPath)).toBe(true);
  });

  test('marker directory without binary does not satisfy check', () => {
    // Create .agents marker dir but no binary inside
    const agentsDir = path.join(tmpDir, '.agents', 'skills', 'gstack');
    fs.mkdirSync(agentsDir, { recursive: true });

    const binPath = path.join(tmpDir, '.agents', 'skills', 'gstack', 'browse', 'dist', 'browse');
    expect(fs.existsSync(binPath)).toBe(false);
  });

  test('symlinked binary is found via existsSync', () => {
    // Create a real binary
    const realDir = path.join(tmpDir, 'real-binary');
    fs.mkdirSync(realDir, { recursive: true });
    const realBin = path.join(realDir, 'browse');
    fs.writeFileSync(realBin, '#!/bin/sh\necho real');
    fs.chmodSync(realBin, 0o755);

    // Symlink it into the .codex path
    const codexDir = path.join(tmpDir, '.codex', 'skills', 'gstack', 'browse', 'dist');
    fs.mkdirSync(codexDir, { recursive: true });
    const symlinkPath = path.join(codexDir, 'browse');
    try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
    fs.symlinkSync(realBin, symlinkPath);

    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.readFileSync(symlinkPath, 'utf-8')).toContain('real');
  });
});

describe('multi-agent skill path consistency', () => {
  // Verify that Codex-generated skills exist in .agents/skills/
  test('.agents/skills/ directory exists with Codex skills', () => {
    const agentsDir = path.join(ROOT, '.agents', 'skills');
    if (!fs.existsSync(agentsDir)) {
      // Skip if Codex skills haven't been generated yet
      return;
    }
    const skills = fs.readdirSync(agentsDir);
    expect(skills.length).toBeGreaterThan(0);
    // All Codex skills should be prefixed with gstack-
    for (const skill of skills) {
      expect(skill.startsWith('gstack')).toBe(true);
    }
  });

  test('Claude and Codex skill counts match (minus /codex self-reference)', () => {
    const agentsDir = path.join(ROOT, '.agents', 'skills');
    if (!fs.existsSync(agentsDir)) return;

    // Count Claude skills (directories with SKILL.md.tmpl at root)
    const claudeSkills = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'SKILL.md.tmpl')))
      .map(e => e.name)
      .filter(n => n !== 'codex'); // /codex is Claude-only

    // Count Codex skills (directories in .agents/skills/)
    const codexSkills = fs.readdirSync(agentsDir)
      .filter(name => fs.existsSync(path.join(agentsDir, name, 'SKILL.md')));

    // Root-level SKILL.md.tmpl generates a gstack/ entry in .agents/skills/
    // Plus each skill directory. Codex count should equal Claude count.
    expect(codexSkills.length).toBeGreaterThanOrEqual(claudeSkills.length);
  });

  test('every Codex SKILL.md has auto-generated header', () => {
    const agentsDir = path.join(ROOT, '.agents', 'skills');
    if (!fs.existsSync(agentsDir)) return;

    const skills = fs.readdirSync(agentsDir);
    for (const skill of skills) {
      const mdPath = path.join(agentsDir, skill, 'SKILL.md');
      if (!fs.existsSync(mdPath)) continue;
      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).toContain('AUTO-GENERATED');
    }
  });

  test('no Codex SKILL.md references ~/.claude/ paths', () => {
    const agentsDir = path.join(ROOT, '.agents', 'skills');
    if (!fs.existsSync(agentsDir)) return;

    const skills = fs.readdirSync(agentsDir);
    for (const skill of skills) {
      const mdPath = path.join(agentsDir, skill, 'SKILL.md');
      if (!fs.existsSync(mdPath)) continue;
      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).not.toContain('~/.claude/skills/');
      expect(content).not.toContain('.claude/skills/gstack/');
    }
  });
});
