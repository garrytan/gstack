import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';

// Static tripwires for the C (machine-wide) render in `gstack-config
// gbrain-refresh`. The render mutates the shared global install, so the guards
// that stop it from touching the wrong directory are load-bearing — these fail
// CI if any guard is dropped.
const ROOT = path.resolve(import.meta.dir, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-config'), 'utf-8');

// Pull out just the gbrain-refresh healthy-status branch so assertions can't
// be satisfied by unrelated text elsewhere in the file. The case label grew
// from `ok)` to `ok|timeout|thin-client)` (#1964, #2051) and may grow again,
// so match any label that STARTS with `ok` followed by alternations.
function okBranch(): string {
  const start = SRC.indexOf('gbrain-refresh)');
  if (start < 0) throw new Error('Could not locate gbrain-refresh case');
  const labelMatch = /^\s*ok(?:\|[\w-]+)*\)/m.exec(SRC.slice(start));
  if (!labelMatch) throw new Error('Could not locate gbrain-refresh ok) branch');
  const ok = start + labelMatch.index;
  const end = SRC.indexOf(';;', ok);
  if (end < 0) throw new Error('Could not locate gbrain-refresh ok) branch terminator');
  return SRC.slice(ok, end);
}

describe('gstack-config gbrain-refresh: machine-wide render guards', () => {
  const branch = okBranch();

  test('targets the global install', () => {
    expect(branch).toContain('$HOME/.claude/skills/gstack');
  });

  test('refuses a symlinked install (would dirty a dev worktree)', () => {
    expect(branch).toMatch(/\[ -L "\$INSTALL_DIR" \]/);
  });

  test('verifies it is a real gstack clone before mutating it', () => {
    expect(branch).toContain('$INSTALL_DIR/VERSION');
    expect(branch).toContain('$INSTALL_DIR/package.json');
  });

  test('requires bun on PATH', () => {
    expect(branch).toContain('command -v bun');
  });

  test('renders the :user variant for the claude host', () => {
    expect(branch).toContain('gen:skill-docs:user --host claude');
  });

  // #2569: the render goes to an UNTRACKED out-dir, never in place — the old
  // in-place render dirtied the install checkout on every refresh, and this
  // branch used to self-document a reset --hard / re-run cycle as the
  // workaround. The out-dir render makes that cycle unnecessary.
  test('renders to an untracked out-dir, never in place (#2569)', () => {
    expect(branch).toContain('--out-dir');
    expect(branch).toContain('render/claude');
    expect(branch).not.toContain('reset --hard');
  });
});

describe('CLAUDE.md: deploy section documents the re-run', () => {
  test('notes re-running gbrain-refresh after reset --hard', () => {
    const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf-8');
    const idx = claudeMd.indexOf('## Deploying to the active skill');
    expect(idx).toBeGreaterThan(-1);
    const section = claudeMd.slice(idx, idx + 1200);
    expect(section).toContain('gbrain-refresh');
  });
});
