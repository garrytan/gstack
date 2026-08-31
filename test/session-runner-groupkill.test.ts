/**
 * Group-kill regression pin for the provider session runners (F7 in the
 * test-infra audit): a timed-out `claude -p` used to get a bare proc.kill()
 * — the direct child died but tool subprocesses it had spawned survived as
 * orphans holding our pipes open and burning shared API rate (observed: a
 * 600s timeout stretching past 1400s; a stalled legacy run once burned a
 * core for 15 hours). The fix: node:child_process spawn with `detached`
 * (child leads its own process group) + killProcessGroup(SIGKILL) in the
 * timeout handler, mirroring runShardChild's proven pattern.
 *
 * The behavioral test drives the REAL runSkillTest against a fake `claude`
 * shim (PATH override — hermeticChildEnv allowlists PATH through) that
 * spawns a grandchild and never exits: the run must classify as timeout
 * within its budget AND leave neither shim nor grandchild alive.
 *
 * Windows note: the shim is a '/bin/bash' shebang script, which the free
 * runner's Windows curation auto-excludes (CreateProcess cannot exec
 * shebangs) — this literal mention is what trips the content scan.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runSkillTest } from './helpers/session-runner';

const ROOT = path.resolve(import.meta.dir, '..');

function aliveWithArg(marker: string): boolean {
  const result = spawnSync('pgrep', ['-f', marker], { stdio: 'pipe', timeout: 5_000 });
  return result.status === 0;
}

describe('session-runner timeout kills the whole process group', () => {
  test('fake claude + its grandchild are both dead after a timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupkill-'));
    const shimDir = path.join(dir, 'bin');
    fs.mkdirSync(shimDir);
    // Markers are unique PER RUN (fractional seconds carry this process's
    // pid): sibling Conductor worktrees run free suites concurrently with no
    // machine lock, and fixed markers let one run pgrep/pkill the OTHER
    // run's shims (review finding — a cross-run flake inside the anti-flake
    // tests). GNU sleep accepts decimals, argv stays greppable.
    const mark = (n: number) => `${n}.${process.pid}`;
    const shim = [
      '#!/bin/bash',
      `sleep ${mark(6041)} &`,   // the orphan-candidate grandchild
      `exec sleep ${mark(6042)}`, // the shim itself, wedged forever, no NDJSON
    ].join('\n');
    fs.writeFileSync(path.join(shimDir, 'claude'), `${shim}\n`, { mode: 0o755 });

    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    try {
      const started = Date.now();
      const result = await runSkillTest({
        prompt: 'irrelevant — the shim never reads it',
        workingDirectory: dir,
        maxTurns: 1,
        allowedTools: ['Bash'],
        timeout: 3_000,
        testName: 'groupkill-probe',
      });
      const wall = Date.now() - started;

      // The shim never prints NDJSON, so the two-phase timer kills it in the
      // STARTUP phase (grace = min(default, timeout) = 3s here) — the
      // distinct reason is the point: no byte ever arrived.
      expect(result.exitReason).toBe('timeout_startup');
      // The old bug's signature was the drain blocking long past the budget
      // (600s -> 1400s). Generous 10x bound: timeout 3s + the 5s stderr
      // grace race must return promptly once the group is dead.
      expect(wall).toBeLessThan(30_000);

      // The kill is SIGKILL on the GROUP: give the OS a beat to reap, then
      // require both the wedged shim and its grandchild gone.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(aliveWithArg(`sleep ${mark(6042)}`), 'the fake claude itself survived the timeout kill').toBe(false);
      expect(aliveWithArg(`sleep ${mark(6041)}`), 'the grandchild ORPHANED — group kill regressed to a direct-child kill').toBe(false);
    } finally {
      process.env.PATH = realPath;
      // Belt and braces: never leak the markers into later tests even on
      // assertion failure.
      spawnSync('pkill', ['-f', `sleep 604[12]\\.${process.pid}`], { stdio: 'ignore', timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('all three provider runners carry the group-kill wiring', () => {
  // Source pin, not behavior: codex/gemini need their real binaries for a
  // behavioral run, but the kill wiring is identical code — a runner that
  // drops `detached` or reverts to a bare kill() re-opens the orphan class.
  const runners = [
    'test/helpers/session-runner.ts',
    'test/helpers/codex-session-runner.ts',
    'test/helpers/gemini-session-runner.ts',
  ];
  for (const rel of runners) {
    test(`${path.basename(rel)}: detached spawn + killProcessGroup, no bare timeout kill`, () => {
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(source).toContain("detached: process.platform !== 'win32'");
      expect(source).toContain('killProcessGroup(proc');
      expect(source, `${rel} reverted to Bun.spawn for the provider child — detached group-kill is impossible there`)
        .not.toMatch(/Bun\.spawn\(\[['"](?:claude|codex|gemini)['"]/);
      expect(source, `${rel} has a bare proc.kill() in a timeout handler`)
        .not.toMatch(/timedOut = true;\s*\n\s*proc\.kill\(\)/);
    });
  }
});
