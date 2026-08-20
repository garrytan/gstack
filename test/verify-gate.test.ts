/**
 * gstack-verify-gate — Stop-hook enforcement tier.
 *
 * Pins the behaviours the gate exists for:
 *   trust    — a declared command NEVER runs until the user records it via
 *              `gstack-verify-gate --trust` (per-repo command trust store).
 *   block    — trusted check fails, exit 2, turn cannot end.
 *   allow    — trusted check passes, exit 0.
 *   fail open — nothing declared, exit 0. Absence never blocks.
 *
 * Plus the two safety branches: the Stop re-entry guard, and the static
 * opt-in contract (our adaptation): ./setup never registers the gate; the
 * settings-hook helper.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const GATE = path.join(ROOT, 'bin', 'gstack-verify-gate');

let dir: string;
let gstackHome: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-verify-gate-'));
  gstackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-verify-gate-home-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(gstackHome, { recursive: true, force: true });
});

/** Declare a verification command in the project's CLAUDE.md (comment form). */
function declareCheck(command: string): void {
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Fixture\n\n<!-- gstack:verify: ${command} -->\n`);
}

/** Write the check script the declaration points at. Touches `check-ran` when executed. */
function check(exitCode: number, message: string): void {
  const script = path.join(dir, 'check.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch check-ran\necho "${message}"\nexit ${exitCode}\n`);
  fs.chmodSync(script, 0o755);
}

/** Did the declared check actually execute? */
function checkRan(): boolean {
  return fs.existsSync(path.join(dir, 'check-ran'));
}

interface RunOpts {
  stopHookActive?: boolean;
  cwd?: string;
  /** When false, CLAUDE_PROJECT_DIR is removed from the child env (walk-up mode). */
  projectDirEnv?: boolean;
  /** Hook-input session id, keys the re-entry attempt counter. */
  sessionId?: string;
}

function gateEnv(projectDirEnv: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_HOME: gstackHome };
  if (projectDirEnv) env.CLAUDE_PROJECT_DIR = dir;
  else delete env.CLAUDE_PROJECT_DIR;
  return env;
}

function runGate(opts: RunOpts = {}): { code: number; stdout: string; stderr: string } {
  const input: Record<string, unknown> = { stop_hook_active: opts.stopHookActive ?? false };
  if (opts.sessionId) input.session_id = opts.sessionId;
  const r = spawnSync(GATE, {
    cwd: opts.cwd ?? dir,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 15000,
    env: gateEnv(opts.projectDirEnv ?? true),
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Record the currently-declared command in the trust store. */
function trust(opts: RunOpts = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(GATE, ['--trust'], {
    cwd: opts.cwd ?? dir,
    encoding: 'utf-8',
    timeout: 15000,
    env: gateEnv(opts.projectDirEnv ?? true),
  });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('gstack-verify-gate trust store', () => {
  test('an untrusted declared command is NOT executed and does not block', () => {
    declareCheck('touch sentinel-ran');

    const r = runGate();

    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'sentinel-ran'))).toBe(false);
    expect(r.stderr).toContain('--trust');
    expect(r.stderr).toContain('touch sentinel-ran');
  });

  test('--trust records the command and prints a confirmation naming it', () => {
    declareCheck('./check.sh');
    check(0, 'all good');

    const t = trust();

    expect(t.code).toBe(0);
    expect(t.stdout).toContain('./check.sh');
  });

  test('after --trust the hook executes the command and block semantics work', () => {
    declareCheck('./check.sh');
    check(1, 'totals mismatch');

    expect(trust().code).toBe(0);
    const r = runGate();

    expect(checkRan()).toBe(true);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('FAILED');
    expect(r.stderr).toContain('totals mismatch');
  });

  test('a changed command is not executed until re-trusted', () => {
    declareCheck('true');
    expect(trust().code).toBe(0);

    // Attacker (or anyone) edits the declaration after trust was granted.
    declareCheck('touch sentinel-ran');
    const r = runGate();

    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'sentinel-ran'))).toBe(false);
    expect(r.stderr).toContain('--trust');

    // Re-trusting the new command restores execution.
    expect(trust().code).toBe(0);
    const r2 = runGate();
    expect(r2.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'sentinel-ran'))).toBe(true);
  });

  test('walk-up: hook run from a nested subdir keys trust on the CLAUDE.md root', () => {
    declareCheck('./check.sh');
    check(0, 'all good');
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });

    // No CLAUDE_PROJECT_DIR: both trust and hook must walk up from $PWD.
    expect(trust({ cwd: nested, projectDirEnv: false }).code).toBe(0);
    const r = runGate({ cwd: nested, projectDirEnv: false });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed');
    expect(checkRan()).toBe(true);
  });

  test('non-comment declaration form (gstack:verify: cmd without <!-- -->) is honored', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Fixture\n\ngstack:verify: ./check.sh\n');
    check(0, 'all good');

    expect(trust().stdout).toContain('./check.sh');
    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed');
    expect(checkRan()).toBe(true);
  });

  test('the trust store file is created 0600 under GSTACK_HOME', () => {
    declareCheck('./check.sh');
    check(0, 'all good');
    expect(trust().code).toBe(0);

    const store = path.join(gstackHome, 'verify-gate-trust');
    expect(fs.existsSync(store)).toBe(true);
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
  });

  test('--trust fails cleanly when nothing is declared', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Fixture\n\nNothing declared here.\n');

    const t = trust();

    expect(t.code).not.toBe(0);
  });
});

describe('gstack-verify-gate', () => {
  test('blocks the turn when the trusted check fails', () => {
    declareCheck('./check.sh');
    check(1, 'totals mismatch');
    expect(trust().code).toBe(0);

    const r = runGate();

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('FAILED');
    expect(r.stderr).toContain('totals mismatch');
  });

  test('allows the turn when the trusted check passes', () => {
    declareCheck('./check.sh');
    check(0, 'all good');
    expect(trust().code).toBe(0);

    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed');
  });

  test('fails open when CLAUDE.md declares no check', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Fixture\n\nNothing declared here.\n');

    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("declares no 'gstack:verify:' command");
  });

  test('fails open when there is no CLAUDE.md at all', () => {
    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no CLAUDE.md');
  });

  test('never invents a command: an empty declaration fails open', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- gstack:verify: -->\n');

    const r = runGate();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("declares no 'gstack:verify:' command");
  });

});

describe('gstack-verify-gate re-entry enforcement (no one-shot bypass)', () => {
  test('re-entry with a still-failing trusted check is blocked again', () => {
    declareCheck('./check.sh');
    check(1, 'still failing');
    expect(trust().code).toBe(0);

    const r = runGate({ stopHookActive: true, sessionId: 'sess-refail' });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain('FAILED');
    expect(r.stderr).toContain('still failing');
    expect(checkRan()).toBe(true);
  });

  test('re-entry after the check now passes is allowed', () => {
    declareCheck('./check.sh');
    check(1, 'totals mismatch');
    expect(trust().code).toBe(0);
    expect(runGate({ sessionId: 'sess-fixed' }).code).toBe(2);

    check(0, 'fixed now');
    const r = runGate({ stopHookActive: true, sessionId: 'sess-fixed' });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('passed');
  });

  test('attempt bound: repeated failing re-entries allow with a loud warning at the bound', () => {
    declareCheck('./check.sh');
    check(1, 'never passing');
    expect(trust().code).toBe(0);
    const sid = 'sess-bound';

    // First entry blocks and resets the episode counter.
    expect(runGate({ sessionId: sid }).code).toBe(2);

    // Re-entries: bounded number of blocks, then allow-with-warning.
    const codes: number[] = [];
    let final: { code: number; stdout: string; stderr: string } | null = null;
    for (let i = 0; i < 6; i++) {
      const r = runGate({ stopHookActive: true, sessionId: sid });
      codes.push(r.code);
      if (r.code === 0) {
        final = r;
        break;
      }
      expect(r.code).toBe(2);
    }

    expect(codes).toEqual([2, 2, 2, 0]);
    expect(final).not.toBeNull();
    expect(final!.stdout + final!.stderr).toContain('WARNING');

    // A fresh first-entry run starts a new episode: blocked again, not allowed.
    expect(runGate({ sessionId: sid }).code).toBe(2);
  });

  test('re-entry with an untrusted command keeps the exit-0-with-hint path', () => {
    declareCheck('touch sentinel-ran');

    const r = runGate({ stopHookActive: true, sessionId: 'sess-untrusted' });

    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'sentinel-ran'))).toBe(false);
    expect(r.stderr).toContain('--trust');
  });
});

describe('gstack-verify-gate trust-grant audit trail', () => {
  test('every --trust grant appends a JSON audit line (right sha256, 0600, verbatim cmd)', () => {
    declareCheck('./check.sh');
    check(0, 'all good');

    const t = trust();
    expect(t.code).toBe(0);
    // --trust prints the VERBATIM command being trusted.
    expect(t.stdout).toContain('./check.sh');

    const log = path.join(gstackHome, 'security', 'verify-gate-trust-grants.jsonl');
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);

    const lines = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.cmd).toBe('./check.sh');
    expect(entry.cmd_sha256).toBe(createHash('sha256').update('./check.sh').digest('hex'));
    expect(entry.root).toBe(fs.realpathSync(dir));
    expect(typeof entry.tty).toBe('boolean');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A second grant appends, never truncates.
    declareCheck('true');
    expect(trust().code).toBe(0);
    const lines2 = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines2.length).toBe(2);
    expect(JSON.parse(lines2[1]).cmd).toBe('true');
  });
});

describe('opt-in contract (adapted from the fork: NOT registered by default)', () => {
  const setup = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
  const gate = fs.readFileSync(GATE, 'utf-8');

  test('./setup does NOT register the gate — a Stop hook running the verify command after every turn is opt-in', () => {
    // The only permitted mentions are comments and the --no-team sweep
    // EXCLUSION (protecting a user-registered gate from team-mode teardown).
    // A registration (add-event) referencing the gate stays banned.
    const mentions = setup.split('\n').filter((l) => l.includes('verify-gate'));
    expect(mentions.length).toBeGreaterThan(0);   // the exclusion itself is pinned
    for (const line of mentions) {
      const t = line.trim();
      const allowed = t.startsWith('#') || t.includes('GSTACK_SWEEP_EXCLUDE_SOURCES="verify-gate"');
      expect(allowed).toBe(true);
      expect(t).not.toContain('add-event');
    }
  });

  test('the bin documents its own registration and removal commands', () => {
    expect(gate).toContain('remove-source --source verify-gate');
    expect(gate).toContain('gstack:verify:');
  });
});
