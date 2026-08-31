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

  function porcelain(): string {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8' });
    return r.status === 0 ? r.stdout : '';
  }

  test('renders :user to out-dir, rewrites section paths, leaves worktree canonical', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-out-'));
    const worktreeSkill = path.join(ROOT, 'ship', 'SKILL.md');
    const beforeHash = hashFile(worktreeSkill);
    const beforePorcelain = porcelain();
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

      // (a2, #2569) the render adds ZERO new dirt to the source checkout —
      // compared before/after rather than asserting empty, so a dev's own
      // unrelated dirty files can't false-fail the suite.
      expect(porcelain()).toBe(beforePorcelain);

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

  test('retired global extras (proactive-suggestions.json) are not written anywhere', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-out-'));
    try {
      const res = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'claude', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 },
      );
      expect(res.status).toBe(0);
      // The proactive-suggestions registry was removed (never had a consumer).
      // A gen run must not resurrect it in the out-dir or at the repo path.
      expect(fs.existsSync(path.join(outDir, 'scripts', 'proactive-suggestions.json'))).toBe(false);
      expect(fs.existsSync(path.join(ROOT, 'scripts', 'proactive-suggestions.json'))).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // ── External-host out-dir cases ─────────────────────────────
  // The former tree-mutating tests read codex/factory artifacts from out-dir
  // renders. That is only sound if an out-dir external render is (a) clean —
  // zero tracked-tree dirt — and (b) byte-identical to what the in-place
  // render would have produced. Both halves are pinned here.

  test('--host codex --out-dir adds no tracked dirt and is byte-identical to the in-place render', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-out-codex-'));
    const inPlaceShip = path.join(ROOT, '.agents', 'skills', 'gstack-ship', 'SKILL.md');
    // Compared before/after rather than asserting empty, so a dev's own
    // unrelated dirty files can't false-fail the suite (#2569 pattern).
    const beforePorcelain = porcelain();
    try {
      // 1) Fresh IN-PLACE codex render — the existing behavior: it writes
      //    only the gitignored .agents/ tree (itself invisible to porcelain).
      const inPlace = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex'],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 },
      );
      expect(inPlace.status).toBe(0);
      expect(porcelain()).toBe(beforePorcelain);
      const inPlaceBytes = fs.readFileSync(inPlaceShip);

      // 2) Out-dir render: zero new dirt, same bytes.
      const res = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 },
      );
      expect(res.status).toBe(0);
      expect(porcelain()).toBe(beforePorcelain);

      const outShip = path.join(outDir, '.agents', 'skills', 'gstack-ship', 'SKILL.md');
      expect(fs.existsSync(outShip)).toBe(true);
      expect(fs.readFileSync(outShip).equals(inPlaceBytes)).toBe(true);

      // Codex metadata (agents/openai.yaml) mirrors into the out-dir too.
      expect(fs.existsSync(path.join(outDir, '.agents', 'skills', 'gstack-ship', 'agents', 'openai.yaml'))).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);

  test('--host all --out-dir renders every host tree into the out-dir; tracked tree stays clean', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-out-all-'));
    const beforePorcelain = porcelain();
    try {
      const res = spawnSync(
        'bun',
        ['run', 'scripts/gen-skill-docs.ts', '--host', 'all', '--out-dir', outDir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 300_000 },
      );
      expect(res.status).toBe(0);
      // Zero new dirt in the source checkout.
      expect(porcelain()).toBe(beforePorcelain);

      // Claude host + external hosts + openclaw docs + llms.txt all landed in the out-dir.
      for (const rel of [
        'ship/SKILL.md',
        '.agents/skills/gstack-ship/SKILL.md',
        '.factory/skills/gstack-ship/SKILL.md',
        'gstack/llms.txt',
        'openclaw/gstack-lite-CLAUDE.md',
      ]) {
        expect({ file: rel, exists: fs.existsSync(path.join(outDir, rel)) })
          .toEqual({ file: rel, exists: true });
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 300_000);
});
