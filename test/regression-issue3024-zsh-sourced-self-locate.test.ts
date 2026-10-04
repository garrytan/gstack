/**
 * Regression tests for issue #3024 — libraries that skill blocks source into
 * the host's shell located themselves with BASH_SOURCE, which zsh (the macOS
 * default, and what Claude Code's Bash tool runs there) does not set.
 *
 *   - bin/gstack-codex-probe resolved its model resolver as
 *     "/../scripts/resolve-codex-generation-model.ts", so every Codex outside
 *     pass reported CODEX_MODEL: invalid / MODEL_UNUSABLE.
 *   - bin/gstack-egress-lib.sh fell back to the caller's working directory,
 *     looking up gstack-state-root.sh in whatever repo the user was in.
 *
 * Each case runs from a foreign cwd, so a cwd fallback cannot pass by luck.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(import.meta.dir, '..', 'bin');
const PROBE = path.join(BIN, 'gstack-codex-probe');
const EGRESS_LIB = path.join(BIN, 'gstack-egress-lib.sh');
const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync('sh', ['-c', `command -v ${sh}`]).status === 0);

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-3024-'));
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(shell: string, script: string) {
  const result = spawnSync(shell, ['-c', script], {
    cwd: home,
    env: { PATH: process.env.PATH ?? '', HOME: home, _TEL: 'off' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe.each(SHELLS)('sourced under %s', (shell) => {
  test('gstack-codex-probe locates its own bin directory', () => {
    const r = run(shell, `source "${PROBE}"; _gstack_codex_bin_dir`);
    expect(r.stdout.trim()).toBe(BIN);
  });

  test('gstack-codex-probe resolves the Codex model', () => {
    const r = run(shell, `source "${PROBE}"; _gstack_codex_select_model exec`);
    expect(r.stderr).not.toContain('Module not found');
    expect(r.stderr).toContain('CODEX_MODEL: ');
    expect(r.stderr).not.toContain('CODEX_MODEL: invalid');
    expect(r.status).toBe(0);
  });

  test('gstack-egress-lib.sh locates its own bin directory', () => {
    const r = run(shell, `. "${EGRESS_LIB}"; printf '%s' "$_gstack_egress_lib_dir"`);
    expect(fs.realpathSync(r.stdout)).toBe(fs.realpathSync(BIN));
  });
});
