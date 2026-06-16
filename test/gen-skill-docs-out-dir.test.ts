import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');

// Render the gbrain `:user` variant into a temp out-dir, forcing detection ON
// via a crafted GSTACK_HOME so the test is deterministic regardless of whether
// the dev machine actually has gbrain installed. Asserts the B2 contract:
//   (a) the worktree SKILL.md is byte-unchanged (source stays canonical),
//   (b) the out-dir SKILL.md gained the inline Brain Context Load block,
//   (c) its section refs point at the out-dir, not ~/.claude/skills/gstack,
//   (d) bin/ refs are left pointing at the global install,
//   (e) the out-dir section file gained the Save Results to Brain block.
describe('gen-skill-docs --out-dir (B2 render isolation)', () => {
  function hashFile(p: string): string {
    return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }

  test('renders :user to out-dir, rewrites section paths, leaves worktree canonical', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-out-'));
    const worktreeSkill = path.join(ROOT, 'ship', 'SKILL.md');
    const beforeHash = hashFile(worktreeSkill);
    try {
      // Force gbrain detection ON for --respect-detection.
      fs.writeFileSync(
        path.join(tmpHome, 'gbrain-detection.json'),
        JSON.stringify({ gbrain_local_status: 'ok', gbrain_version: '9.9.9' }),
      );

      const res = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--respect-detection', '--host', 'claude', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000, env: { ...process.env, GSTACK_HOME: tmpHome } },
      );
      expect(res.status).toBe(0);

      const outSkill = path.join(outDir, 'ship', 'SKILL.md');
      const outSection = path.join(outDir, 'ship', 'sections', 'adversarial.md');
      expect(fs.existsSync(outSkill)).toBe(true);
      const skillContent = fs.readFileSync(outSkill, 'utf-8');

      // (a) worktree byte-unchanged
      expect(hashFile(worktreeSkill)).toBe(beforeHash);

      // (b) inline block present in the rendered SKILL.md
      expect(skillContent).toContain('Brain Context Load');

      // (c) section refs repointed to the out-dir; none left pointing at the install
      expect(skillContent).toContain(`${outDir}/ship/sections/`);
      expect(skillContent).not.toContain('~/.claude/skills/gstack/ship/sections/');

      // (d) bin refs are NOT rewritten — they still resolve to the global install
      expect(skillContent).toContain('~/.claude/skills/gstack/bin/');

      // (e) the SAVE block landed in the rendered section file
      expect(fs.existsSync(outSection)).toBe(true);
      expect(fs.readFileSync(outSection, 'utf-8')).toContain('Save Results to Brain');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('global extras (proactive-suggestions.json) are NOT written in out-dir mode', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-out-'));
    try {
      const res = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'claude', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 },
      );
      expect(res.status).toBe(0);
      // proactive-suggestions.json lives at a repo path; out-dir mode must skip it.
      expect(fs.existsSync(path.join(outDir, 'scripts', 'proactive-suggestions.json'))).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
