import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';

// Static tripwires for the C (machine-wide) render in `gstack-config
// gbrain-refresh`. The render mutates the shared global install, so the guards
// that stop it from touching the wrong directory are load-bearing — these fail
// CI if any guard is dropped.
const ROOT = path.resolve(import.meta.dir, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-config'), 'utf-8');

// Pull out just the gbrain-refresh `ok)` branch so assertions can't be
// satisfied by unrelated text elsewhere in the file.
function okBranch(): string {
  const start = SRC.indexOf('gbrain-refresh)');
  const ok = SRC.indexOf('ok)', start);
  const end = SRC.indexOf(';;', ok);
  if (start < 0 || ok < 0 || end < 0) throw new Error('Could not locate gbrain-refresh ok) branch');
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

  test('renders the :user variant in place into the install', () => {
    expect(branch).toContain('gen:skill-docs:user --host claude');
  });

  test('is self-documenting about the reset --hard / re-run cycle', () => {
    expect(branch).toContain('reset --hard');
    expect(branch).toContain('gbrain-refresh');
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
