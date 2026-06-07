import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

// Run a bash snippet, return {stdout, stderr, status}.
function runBash(script: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? -1 };
}

describe('setup: gen:skill-docs:user exit-code propagation (pipe-masking fix)', () => {
  // The bug: `cmd 2>&1 | tail -3` makes the subshell exit status `tail`'s,
  // so `(...) || log "warning"` never fires when `cmd` fails. The fix removes
  // the pipe. These tests RUN the pattern (not grep source) to prove the
  // exit-code semantics actually change.

  test('without pipe: failing bun_cmd triggers the || warning clause', () => {
    const r = runBash(`
      set +e
      bun_cmd() { return 1; }      # stub: gen:skill-docs:user failed
      log() { echo "LOG:$*"; }
      (
        cd /tmp
        bun_cmd run gen:skill-docs:user --host claude
      ) || log "  warning: gen:skill-docs:user failed"
    `);
    expect(r.stdout).toContain('LOG:  warning: gen:skill-docs:user failed');
  });

  test('with pipe (the bug shape): failing bun_cmd does NOT trigger the warning', () => {
    const r = runBash(`
      set +e
      bun_cmd() { return 1; }      # stub: gen:skill-docs:user failed
      log() { echo "LOG:$*"; }
      (
        cd /tmp
        bun_cmd run gen:skill-docs:user --host claude 2>&1 | tail -3
      ) || log "  warning: gen:skill-docs:user failed"
    `);
    expect(r.stdout).not.toContain('LOG:  warning');
  });

  test('setup: the live gbrain regen block has no pipe before the || guard', () => {
    // Slice the exact block from setup and confirm the fix is in place
    // without resorting to a fragile line-number check.
    const start = SETUP_SRC.indexOf('gbrain detected — regenerating');
    expect(start).toBeGreaterThan(-1);
    const end = SETUP_SRC.indexOf('|| log', start);
    expect(end).toBeGreaterThan(start);
    const block = SETUP_SRC.slice(start, end);
    expect(block).toContain('bun_cmd run gen:skill-docs:user --host claude');
    // The bug shape: `... | tail -N` between the call and the `|| log` guard.
    expect(block).not.toMatch(/gen:skill-docs:user[^\n]*\|\s*tail/);
  });
});

describe('setup: bun_cmd routing in link_*_skill_dirs (Windows non-ASCII path fix)', () => {
  // The bug: `bun run ...` bypasses the BUN_CMD wrapper installed by
  // prepare_bun_for_windows_compile. On a non-ASCII Windows username,
  // BUN_CMD points to an ASCII-path copy of bun and the literal `bun`
  // on PATH may not work. Test by stubbing BUN_CMD to a sentinel that
  // writes a marker file, and proving the wrapper path actually invokes it.

  test('bun_cmd wrapper invokes $BUN_CMD (not literal bun on PATH)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-buncmd-'));
    const marker = path.join(tmp, 'invoked');
    const sentinel = path.join(tmp, 'fake-bun');
    fs.writeFileSync(sentinel, `#!/usr/bin/env bash\necho "ARGS:$*" > "${marker}"\n`);
    fs.chmodSync(sentinel, 0o755);

    const r = runBash(`
      set -e
      BUN_CMD="${sentinel}"
      bun_cmd() { "$BUN_CMD" "$@"; }
      ( cd /tmp && bun_cmd run gen:skill-docs --host codex )
    `);

    expect(r.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, 'utf-8').trim()).toBe('ARGS:run gen:skill-docs --host codex');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('setup: the three link_*_skill_dirs helpers all use bun_cmd, not literal bun', () => {
    // Extract each helper body and check the gen:skill-docs invocation
    // inside it. Source-anchored (not line-number) and not a global grep,
    // so we only assert about the actual code path the bug fix touches.
    for (const fn of [
      'link_codex_skill_dirs',
      'link_factory_skill_dirs',
      'link_opencode_skill_dirs',
    ]) {
      const start = SETUP_SRC.indexOf(`${fn}() {`);
      expect(start).toBeGreaterThan(-1);
      const end = SETUP_SRC.indexOf('\n}\n', start);
      expect(end).toBeGreaterThan(start);
      const body = SETUP_SRC.slice(start, end);
      // Must call through the wrapper.
      expect(body).toMatch(/bun_cmd run gen:skill-docs/);
      // Bug shape: a literal `bun run gen:skill-docs` in executable position
      // (skipping any comment / warning-string mentions that aren't being run).
      const lines = body.split('\n').filter((l) => {
        const t = l.trim();
        if (!t || t.startsWith('#')) return false;
        // Strings inside echo/warning messages don't execute bun.
        if (/echo\s+['"]/.test(t)) return false;
        return true;
      });
      for (const l of lines) {
        // `bun_cmd run ...` is fine; a bare `bun run ...` is the bug.
        const stripped = l.replace(/bun_cmd run/g, '');
        expect(stripped).not.toMatch(/\bbun run gen:skill-docs/);
      }
    }
  });
});
