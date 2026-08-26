/**
 * Static-grep tripwire for the hermetic E2E wiring. Free tier — no API.
 *
 * Every E2E runner spawns its child through hermeticChildEnv(); if a refactor
 * reverts any spawn site to a raw `...process.env` spread (or a callsite
 * smuggles the operator env back in through the overrides parameter), local
 * evals silently re-contaminate and nothing fails until a human notices
 * weird results again — which took three burned suites last time.
 *
 * Pattern mirrors browse/test/terminal-agent-pid-identity.test.ts and
 * browse/test/server-embedder-terminal-port.test.ts: read source files as
 * text, assert invariants on their contents. Brittle by design — renaming
 * the helper must force the author to look here.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getHermeticDirs, hermeticSkillsConfigDir } from './helpers/hermetic-env';

const ROOT = path.resolve(import.meta.path, '..', '..');

const RUNNERS = [
  'test/helpers/session-runner.ts',
  'test/helpers/claude-pty-runner.ts',
  'test/helpers/codex-session-runner.ts',
  'test/helpers/gemini-session-runner.ts',
  'test/helpers/agent-sdk-runner.ts',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('hermetic wiring tripwire', () => {
  test('every runner builds its child env via hermeticChildEnv()', () => {
    for (const rel of RUNNERS) {
      const src = read(rel);
      expect(src.includes('hermeticChildEnv(') ).toBe(true);
      expect(src.includes("from './hermetic-env'")).toBe(true);
    }
  });

  test('no runner spawns a child with a raw process.env spread', () => {
    // `...process.env` inside an env object is the exact pre-hermetic leak.
    // hermetic-env.ts itself legitimately READS process.env (call-time
    // snapshot); the runners must not SPREAD it into a child env.
    for (const rel of RUNNERS) {
      const offenders = read(rel)
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes('...process.env'));
      expect(
        offenders,
        `${rel} spreads raw process.env into a child env at line(s) ` +
          offenders.map((o) => o.n).join(', ') +
          ' — route through hermeticChildEnv() instead',
      ).toEqual([]);
    }
  });

  test('claude runners gate --strict-mcp-config on isHermeticEnabled()', () => {
    // Zero MCP servers for hermetic children; EVALS_HERMETIC=0 must restore
    // operator MCP along with the operator env (the flag may not be
    // unconditional, or the escape hatch lies).
    for (const rel of ['test/helpers/session-runner.ts', 'test/helpers/claude-pty-runner.ts']) {
      const src = read(rel);
      expect(src.includes('--strict-mcp-config')).toBe(true);
      const gated =
        /if\s*\(\s*isHermeticEnabled\(\)\s*\)\s*(args\.push\(\s*)?['"]--strict-mcp-config['"]/.test(src) ||
        /const hermetic = isHermeticEnabled\(\);[\s\S]{0,200}if\s*\(hermetic\)\s*args\.push\(\s*['"]--strict-mcp-config['"]/.test(src);
      expect(gated, `${rel}: --strict-mcp-config must be gated on isHermeticEnabled()`).toBe(true);
    }
  });

  test('no test callsite passes the whole operator env as a RUNNER override', () => {
    // Overrides merge last by design (per-test GSTACK_HOME etc.) — passing
    // process.env itself through that hole defeats the entire scrub. Scoped
    // to OUR runner calls: unit tests that spawnSync gstack bin scripts with
    // `...process.env` are test-process spawns, not eval children, and are
    // legitimately the test's own business.
    const RUNNER_CALL =
      /\b(runSkillTest|launchClaudePty|runPlanSkillObservation|runPlanSkillCounting|runPlanSkillFloorCheck|runAgentSdkTest|runCodexSkillTest|runGeminiSkillTest)\s*\(/;
    const DIRECT_SPAWN = /\b(spawnSync|spawn|execSync|exec|Bun\.spawn|Bun\.spawnSync)\s*\(/;
    const testDir = path.join(ROOT, 'test');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'hermetic-wiring.test.ts') continue;
        const lines = fs.readFileSync(full, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!/env:\s*(\{\s*\.\.\.\s*process\.env|process\.env\b(?!\.))/.test(lines[i])) continue;
          // Walk backwards to the nearest enclosing call: runner vs direct spawn.
          for (let j = i; j >= Math.max(0, i - 25); j--) {
            if (DIRECT_SPAWN.test(lines[j])) break; // test's own spawn — fine
            if (RUNNER_CALL.test(lines[j])) {
              offenders.push(`${path.relative(ROOT, full)}:${i + 1}`);
              break;
            }
          }
        }
      }
    };
    walk(testDir);
    expect(
      offenders,
      'These callsites pass the operator env into an eval child, defeating the hermetic scrub: ' +
        offenders.join(', '),
    ).toEqual([]);
  });

  test('skill seeding stays under runRoot and reads the live repo tree, never operator ~/.claude', () => {
    // hermeticSkillsConfigDir() is a BLESSED non-hermetic edge: it registers
    // the LIVE repo tree's skills (the skills are the subject under test).
    // What it must never do is hand children the operator's ~/.claude — the
    // seeded CLAUDE_CONFIG_DIR lives under the hermetic runRoot, and every
    // registered symlink resolves into the repo checkout.
    const configDir = hermeticSkillsConfigDir();
    const { runRoot } = getHermeticDirs();
    const operatorClaude = path.join(os.homedir(), '.claude') + path.sep;
    expect(configDir.startsWith(runRoot + path.sep)).toBe(true);
    expect(configDir.startsWith(operatorClaude)).toBe(false);
    const skillsDir = path.join(configDir, 'skills');
    const repoRootReal = fs.realpathSync(ROOT) + path.sep;
    for (const entry of fs.readdirSync(skillsDir)) {
      const target = fs.readlinkSync(path.join(skillsDir, entry, 'SKILL.md'));
      const resolved = fs.realpathSync(target);
      // Targets inside the live repo checkout are the blessed edge — exempt
      // them BEFORE the operator-~/.claude ban. On the default global-git
      // install the repo itself lives at ~/.claude/skills/gstack, so every
      // CORRECT symlink carries the operatorClaude prefix and an unexempted
      // ban can never pass (regression 2026-08-15: pristine v1.64.1.0 fails
      // this test in any worktree under ~/.claude/skills/ and passes
      // elsewhere — realpath both sides so a symlinked HOME can't dodge it).
      if (!resolved.startsWith(repoRootReal)) {
        expect(resolved.startsWith(operatorClaude), `${entry}: symlink escapes to ${target}`).toBe(false);
      }
      expect(resolved.startsWith(repoRootReal), `${entry}: symlink outside repo: ${target}`).toBe(true);
    }
  });
});
