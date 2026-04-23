import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SYNC = path.join(ROOT, 'bin', 'gstack-sync');

describe('gstack-sync', () => {
  test('syntax check passes', () => {
    const result = spawnSync('bash', ['-n', SYNC], { stdio: 'pipe' });
    expect(result.status).toBe(0);
  });

  test('--help prints usage and exits 0', () => {
    const result = spawnSync('bash', [SYNC, '--help'], { stdio: 'pipe' });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('gstack-sync');
    expect(output).toContain('--check');
    expect(output).toContain('--dry-run');
  });

  describe('integration tests with mock home', () => {
    let tmpDir: string;
    let mockHome: string;
    let targetSkillsDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-sync-test-'));
      mockHome = path.join(tmpDir, 'home');
      targetSkillsDir = path.join(mockHome, '.ai', 'skills');
      fs.mkdirSync(mockHome, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('exports the full generated skill set into ~/.ai/skills', () => {
      const result = spawnSync('bash', [SYNC, 'ai'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SOURCE_DIR: ROOT,
          GSTACK_AI_SKILLS_DIR: targetSkillsDir,
        },
        cwd: ROOT,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(targetSkillsDir, 'gstack', 'SKILL.md'))).toBe(true);

      const sourceSkills = fs.readdirSync(ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort();

      const manifest = fs.readFileSync(
        path.join(targetSkillsDir, 'gstack', '.gstack-export-manifest'),
        'utf-8',
      )
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();

      expect(manifest).toEqual(sourceSkills);
      for (const skillName of ['office-hours', 'plan-ceo-review', 'plan-design-review', 'review', 'ship', 'investigate']) {
        expect(manifest).toContain(skillName);
      }

      for (const skillName of sourceSkills) {
        expect(fs.existsSync(path.join(targetSkillsDir, skillName, 'SKILL.md'))).toBe(true);
      }

      const upgradeSkill = fs.readFileSync(path.join(targetSkillsDir, 'gstack-upgrade', 'SKILL.md'), 'utf-8');
      expect(upgradeSkill).toContain('$HOME/.ai/skills/gstack');
      expect(upgradeSkill).toContain('.gstack-source');
      expect(upgradeSkill).toContain('bin/gstack-sync ai');
      expect(upgradeSkill).not.toContain('~/.claude/skills/gstack');
    });

    test('exported browse server bundle starts without the source repo node_modules', () => {
      const result = spawnSync('bash', [SYNC, 'ai'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SOURCE_DIR: ROOT,
          GSTACK_AI_SKILLS_DIR: targetSkillsDir,
        },
        cwd: ROOT,
      });

      expect(result.status).toBe(0);

      const exportedBundle = path.join(targetSkillsDir, 'gstack', 'browse', 'dist', 'server-node.mjs');
      const exportedPolyfill = path.join(targetSkillsDir, 'gstack', 'browse', 'dist', 'bun-polyfill.cjs');
      const stateDir = path.join(tmpDir, 'browse-state');
      fs.mkdirSync(stateDir, { recursive: true });

      expect(fs.existsSync(exportedBundle)).toBe(true);
      expect(fs.existsSync(exportedPolyfill)).toBe(true);

      const stateFile = path.join(stateDir, 'browse.json');
      const logFile = path.join(stateDir, 'server.log');
      const errFile = path.join(stateDir, 'server.err');
      const shellScript = `
        set -euo pipefail
        rm -f ${JSON.stringify(logFile)} ${JSON.stringify(errFile)} ${JSON.stringify(stateFile)}
        BROWSE_STATE_FILE=${JSON.stringify(stateFile)} node ${JSON.stringify(exportedBundle)} >${JSON.stringify(logFile)} 2>${JSON.stringify(errFile)} &
        pid=$!
        ready=0
        for _ in $(seq 1 40); do
          if [ -f ${JSON.stringify(stateFile)} ]; then
            ready=1
            break
          fi
          sleep 0.2
        done
        pkill -TERM -P "$pid" >/dev/null 2>&1 || true
        kill "$pid" >/dev/null 2>&1 || true
        sleep 1
        pkill -KILL -P "$pid" >/dev/null 2>&1 || true
        kill -KILL "$pid" >/dev/null 2>&1 || true
        wait "$pid" >/dev/null 2>&1 || true
        echo "READY:$ready"
        echo "--- STDOUT ---"
        cat ${JSON.stringify(logFile)} 2>/dev/null || true
        echo "--- STDERR ---"
        cat ${JSON.stringify(errFile)} 2>/dev/null || true
      `;

      const serverResult = spawnSync('bash', ['-lc', shellScript], {
        stdio: 'pipe',
        timeout: 12000,
      });

      const combinedOutput = serverResult.stdout.toString() + serverResult.stderr.toString();
      expect(serverResult.status).toBe(0);
      expect(combinedOutput).toContain('READY:1');
      expect(combinedOutput).toContain('Server running on http://127.0.0.1:');
      expect(combinedOutput).not.toContain("Cannot find package 'diff'");
      expect(combinedOutput).not.toContain('Bun is not defined');
    });

    test('--check detects drift after sync', () => {
      let result = spawnSync('bash', [SYNC, 'ai'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SOURCE_DIR: ROOT,
          GSTACK_AI_SKILLS_DIR: targetSkillsDir,
        },
        cwd: ROOT,
      });
      expect(result.status).toBe(0);

      result = spawnSync('bash', [SYNC, 'ai', '--check'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SOURCE_DIR: ROOT,
          GSTACK_AI_SKILLS_DIR: targetSkillsDir,
        },
        cwd: ROOT,
      });
      expect(result.status).toBe(0);

      fs.appendFileSync(path.join(targetSkillsDir, 'gstack-upgrade', 'SKILL.md'), '\n<!-- drift -->\n');

      result = spawnSync('bash', [SYNC, 'ai', '--check'], {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: mockHome,
          GSTACK_SOURCE_DIR: ROOT,
          GSTACK_AI_SKILLS_DIR: targetSkillsDir,
        },
        cwd: ROOT,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr.toString()).toContain('gstack ai export is stale');
    });
  });
});
