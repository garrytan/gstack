/**
 * gstack-session-kind — classifies the session so skills know whether a human can
 * answer an AskUserQuestion. Drives the AUQ-failure fallback branch:
 *   spawned     → auto-choose (orchestrator)
 *   headless    → BLOCK on AUQ failure
 *   interactive → prose fallback on AUQ failure
 *
 * These permutations are the contract the resolver rule depends on. Run with a
 * SCRUBBED env (the test process itself runs inside Conductor, so CONDUCTOR_* /
 * CLAUDE_CODE_* would leak in and contaminate the classification).
 *
 * Free, deterministic, gate-tier.
 */
import { afterAll, describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-session-kind');

/** Run the helper with ONLY the supplied env (plus PATH so bash resolves). */
function kind(env: Record<string, string>): string {
  return execFileSync(BIN, [], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

describe('gstack-session-kind', () => {
  test('OPENCLAW_SESSION → spawned (highest precedence)', () => {
    expect(kind({ OPENCLAW_SESSION: '1' })).toBe('spawned');
    // spawned wins even when other markers are also present
    expect(kind({ OPENCLAW_SESSION: '1', GSTACK_HEADLESS: '1', CONDUCTOR_PORT: '5' })).toBe('spawned');
  });

  test('GSTACK_HEADLESS → headless', () => {
    expect(kind({ GSTACK_HEADLESS: '1' })).toBe('headless');
  });

  test('CONDUCTOR_* → interactive (a human host is present)', () => {
    expect(kind({ CONDUCTOR_WORKSPACE_PATH: '/tmp/ws' })).toBe('interactive');
    expect(kind({ CONDUCTOR_PORT: '55010' })).toBe('interactive');
  });

  test('CLAUDE_CODE_ENTRYPOINT=cli → interactive', () => {
    expect(kind({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('interactive');
  });

  test('interactive host beats CI markers', () => {
    expect(kind({ CONDUCTOR_PORT: '5', CI: '1' })).toBe('interactive');
  });

  test('CI / GITHUB_ACTIONS with no host → headless', () => {
    expect(kind({ CI: '1' })).toBe('headless');
    expect(kind({ GITHUB_ACTIONS: 'true' })).toBe('headless');
  });

  test('GSTACK_HEADLESS beats CONDUCTOR (explicit override wins)', () => {
    expect(kind({ GSTACK_HEADLESS: '1', CONDUCTOR_PORT: '5' })).toBe('headless');
  });

  test('bare env → interactive (degrade-safe default)', () => {
    expect(kind({})).toBe('interactive');
  });

  test('empty GSTACK_HEADLESS is treated as unset (interactive)', () => {
    // The resolver/helper guard on -n, so an empty string must NOT mean headless —
    // this is the opt-out path harness suites use to exercise the interactive branch.
    expect(kind({ GSTACK_HEADLESS: '' })).toBe('interactive');
  });
});

// Codex 0.170 gives every tool shell CODEX_THREAD_ID in its TUI and in exec
// alike; only the nearest codex process's subcommand tells them apart (exec
// runs tool shells itself, the TUI runs them under `codex app-server`). A fake
// `codex` script stands in for that process and runs the helper as its child.
describe.skipIf(process.platform === 'win32')('Codex sessions (GST-3161)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-codex-kind-'));
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, `#!/usr/bin/env bash\nbash -c '"$SK_BIN"'\n`, { mode: 0o755 });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const underCodex = (args: string[], env: Record<string, string> = {}) => execFileSync(fake, args, {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SK_BIN: BIN, CODEX_THREAD_ID: 't-1', CODEX_CI: '1', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();

  test('codex exec (and its alias and global flags) → headless', () => {
    expect(underCodex(['exec', '--json', 'fix the bug'])).toBe('headless');
    expect(underCodex(['e', 'fix the bug'])).toBe('headless');
    expect(underCodex(['-c', 'model="gpt-6.1-sol"', '--dangerously-bypass-approvals-and-sandbox', 'exec', '-'])).toBe('headless');
    expect(underCodex(['review', '--uncommitted'])).toBe('headless');
  });

  test('interactive Codex (the TUI app-server, a resumed session, a prompt that says exec) → interactive', () => {
    expect(underCodex(['app-server', '--listen', 'unix://', '--managed-daemon'])).toBe('interactive');
    expect(underCodex(['resume', '--last'])).toBe('interactive');
    // Linux reads argv from /proc; ps elsewhere joins argv, so this prompt reads as exec there.
    if (process.platform === 'linux') expect(underCodex(['--no-daemon', 'exec the tests and fix them'])).toBe('interactive');
    expect(underCodex([])).toBe('interactive');
  });

  test('negative controls: Conductor outranks codex exec; no CODEX_THREAD_ID means no Codex signal', () => {
    expect(underCodex(['exec', 'x'], { CONDUCTOR_WORKSPACE_PATH: '/tmp/ws' })).toBe('interactive');
    expect(underCodex(['exec', 'x'], { CONDUCTOR_PORT: '55010' })).toBe('interactive');
    expect(underCodex(['exec', 'x'], { CODEX_THREAD_ID: '' })).toBe('interactive');
    expect(underCodex(['exec', 'x'], { GSTACK_SESSION_KIND: 'unattended' })).toBe('unattended');
  });

  test.skipIf(process.platform !== 'linux')('a shell between codex exec and the helper, with no ps on PATH → headless (Linux reads parent pids from /proc)', () => {
    const nested = path.join(dir, 'nested', 'codex');
    const noPs = path.join(dir, 'no-ps-bin');
    fs.mkdirSync(path.dirname(nested));
    fs.mkdirSync(noPs);
    fs.writeFileSync(nested, `#!/usr/bin/env bash\nbash -c '"$SK_BIN"; true'\n`, { mode: 0o755 });
    for (const tool of ['bash', 'tr']) fs.symlinkSync(Bun.which(tool)!, path.join(noPs, tool));
    const run = (args: string[]) => execFileSync(nested, args, {
      env: { PATH: noPs, SK_BIN: BIN, CODEX_THREAD_ID: 't-1', CODEX_CI: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    expect(run(['exec', 'fix the bug'])).toBe('headless');
    expect(run(['app-server', '--listen', 'unix://'])).toBe('interactive');
  });
});

describe('GSTACK_SESSION_KIND explicit override (#2733)', () => {
  test('spawned wins over every ambient marker (step 0, explicit beats ambient)', () => {
    // Claude Code subagents inherit the parent env byte-for-byte, so the
    // per-command marker must outrank whatever the parent session looks like.
    expect(kind({ GSTACK_SESSION_KIND: 'spawned' })).toBe('spawned');
    expect(kind({ GSTACK_SESSION_KIND: 'spawned', CONDUCTOR_PORT: '5' })).toBe('spawned');
    expect(kind({ GSTACK_SESSION_KIND: 'spawned', CONDUCTOR_WORKSPACE_PATH: '/x', CI: '1' })).toBe('spawned');
    expect(kind({ GSTACK_SESSION_KIND: 'spawned', GSTACK_HEADLESS: '1' })).toBe('spawned');
    expect(kind({ GSTACK_SESSION_KIND: 'spawned', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('spawned');
  });

  test('only "spawned" and "unattended" are honored — reserved values fall through to detection', () => {
    // Deliberately narrow: "headless" already has GSTACK_HEADLESS, and letting
    // an env var force "interactive" over CI markers would be a footgun.
    expect(kind({ GSTACK_SESSION_KIND: 'headless' })).toBe('interactive');
    expect(kind({ GSTACK_SESSION_KIND: 'headless', OPENCLAW_SESSION: '1' })).toBe('spawned');
    expect(kind({ GSTACK_SESSION_KIND: 'interactive', CI: '1' })).toBe('headless');
  });

  test('invalid values are ignored (case-sensitive)', () => {
    expect(kind({ GSTACK_SESSION_KIND: 'bogus' })).toBe('interactive');
    expect(kind({ GSTACK_SESSION_KIND: 'bogus', CI: '1' })).toBe('headless');
    expect(kind({ GSTACK_SESSION_KIND: 'SPAWNED' })).toBe('interactive');
  });

  test('empty GSTACK_SESSION_KIND is treated as unset', () => {
    expect(kind({ GSTACK_SESSION_KIND: '' })).toBe('interactive');
    expect(kind({ GSTACK_SESSION_KIND: '', OPENCLAW_SESSION: '1' })).toBe('spawned');
  });
});

describe('unattended: the fourth kind (plan B1, decision D2)', () => {
  test('explicit override only, outranking every ambient marker including GSTACK_HEADLESS', () => {
    expect(kind({ GSTACK_SESSION_KIND: 'unattended' })).toBe('unattended');
    expect(kind({ GSTACK_SESSION_KIND: 'unattended', GSTACK_HEADLESS: '1' })).toBe('unattended');
    expect(kind({ GSTACK_SESSION_KIND: 'unattended', CI: '1', GITHUB_ACTIONS: 'true' })).toBe('unattended');
    expect(kind({ GSTACK_SESSION_KIND: 'unattended', OPENCLAW_SESSION: '1' })).toBe('unattended');
    expect(kind({ GSTACK_SESSION_KIND: 'unattended', CONDUCTOR_PORT: '5', CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('unattended');
  });

  test('negative control: headless keeps BLOCK semantics — GSTACK_HEADLESS, CI and the eval harness never yield unattended', () => {
    expect(kind({ GSTACK_HEADLESS: '1' })).toBe('headless');
    expect(kind({ CI: '1' })).toBe('headless');
    expect(kind({ GSTACK_HEADLESS: '1', GSTACK_SESSION_KIND: '' })).toBe('headless');
    expect(kind({ GSTACK_HEADLESS: '1', GSTACK_SESSION_KIND: 'UNATTENDED' })).toBe('headless');
  });

  test('the eval harness and the free-suite environment never set GSTACK_SESSION_KIND=unattended', () => {
    const roots = ['test/helpers', 'scripts', 'test/test-setup.ts', '.github/workflows'];
    const files = roots.flatMap(function walk(rel: string): string[] {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) return [];
      if (fs.statSync(full).isFile()) return [rel];
      return fs.readdirSync(full).filter(f => f !== 'node_modules').flatMap(f => walk(path.join(rel, f)));
    });
    const offenders = files.filter(f => /GSTACK_SESSION_KIND\s*[:=]\s*['"]?unattended/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
