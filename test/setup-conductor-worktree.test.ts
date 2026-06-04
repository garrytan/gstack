import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');

describe('setup: Conductor worktree guard', () => {
  test('setup contains the real-dir guard before the symlink-or-copy into ~/.claude/skills/', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    const guardIdx = content.indexOf('_SKIP_CLAUDE_REGISTER=0');
    // v1.36.0.0: symlink work routes through _link_or_copy helper for Windows fallback.
    const lnIdx = content.indexOf('_link_or_copy "$SOURCE_GSTACK_DIR" "$CLAUDE_GSTACK_LINK"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(lnIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(lnIdx);
  });

  test('guard resolves the existing real dir with `pwd -P` and compares against source', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    expect(content).toContain('[ -d "$CLAUDE_GSTACK_LINK" ] && [ ! -L "$CLAUDE_GSTACK_LINK" ]');
    expect(content).toContain('cd "$CLAUDE_GSTACK_LINK" 2>/dev/null && pwd -P');
    expect(content).toContain('"$_EXISTING_REAL" != "$SOURCE_GSTACK_DIR"');
  });

  test('skip branch prints "registration skipped" + remediation hint', () => {
    const content = fs.readFileSync(SETUP_SCRIPT, 'utf-8');
    expect(content).toContain('Skipping Claude skill registration');
    expect(content).toContain('claude registration skipped');
    expect(content).toContain('rm -rf $CLAUDE_GSTACK_LINK');
  });

  // Reproduce the BSD/macOS `ln -snf` behavior that caused the bug, then
  // confirm the guard avoids it. This is a behavioral test of the guard logic
  // running in an isolated tmpdir — not the full setup script.
  test('BSD ln -snf into an existing real dir creates a child symlink (bug reproduces)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-guard-'));
    try {
      const source = path.join(tmp, 'source-worktree');
      const dest = path.join(tmp, 'dest-real-dir');
      fs.mkdirSync(source);
      fs.mkdirSync(dest);
      // The buggy invocation: target dest is an existing real dir.
      const result = spawnSync('ln', ['-snf', source, dest], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      // Child symlink leaked inside dest.
      const leaked = path.join(dest, path.basename(source));
      expect(fs.existsSync(leaked)).toBe(true);
      expect(fs.lstatSync(leaked).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(leaked)).toBe(source);
      // dest itself stayed a real directory (not replaced).
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(dest).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('guard logic refuses to ln when dest is a real dir pointing elsewhere', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-guard-'));
    try {
      const source = path.join(tmp, 'source-worktree');
      const dest = path.join(tmp, 'dest-real-dir');
      fs.mkdirSync(source);
      fs.mkdirSync(dest);
      // Inline the guard logic from setup. If it triggers, $_SKIP=1 is echoed
      // and no ln is performed; otherwise ln runs and we'd see the leak.
      const script = `
        set -e
        SOURCE_GSTACK_DIR='${source}'
        CLAUDE_GSTACK_LINK='${dest}'
        _SKIP_CLAUDE_REGISTER=0
        if [ -d "$CLAUDE_GSTACK_LINK" ] && [ ! -L "$CLAUDE_GSTACK_LINK" ]; then
          _EXISTING_REAL=$(cd "$CLAUDE_GSTACK_LINK" 2>/dev/null && pwd -P || echo "")
          if [ -n "$_EXISTING_REAL" ] && [ "$_EXISTING_REAL" != "$SOURCE_GSTACK_DIR" ]; then
            _SKIP_CLAUDE_REGISTER=1
          fi
        fi
        if [ "$_SKIP_CLAUDE_REGISTER" -eq 1 ]; then
          echo "SKIP"
        else
          ln -snf "$SOURCE_GSTACK_DIR" "$CLAUDE_GSTACK_LINK"
          echo "LINKED"
        fi
      `;
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('SKIP');
      // No child symlink leaked.
      const leaked = path.join(dest, path.basename(source));
      expect(fs.existsSync(leaked)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('guard allows ln when dest does not exist (fresh install path)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-guard-'));
    try {
      const source = path.join(tmp, 'source-worktree');
      const dest = path.join(tmp, 'fresh-dest');
      fs.mkdirSync(source);
      const script = `
        set -e
        SOURCE_GSTACK_DIR='${source}'
        CLAUDE_GSTACK_LINK='${dest}'
        _SKIP_CLAUDE_REGISTER=0
        if [ -d "$CLAUDE_GSTACK_LINK" ] && [ ! -L "$CLAUDE_GSTACK_LINK" ]; then
          _EXISTING_REAL=$(cd "$CLAUDE_GSTACK_LINK" 2>/dev/null && pwd -P || echo "")
          if [ -n "$_EXISTING_REAL" ] && [ "$_EXISTING_REAL" != "$SOURCE_GSTACK_DIR" ]; then
            _SKIP_CLAUDE_REGISTER=1
          fi
        fi
        if [ "$_SKIP_CLAUDE_REGISTER" -eq 1 ]; then
          echo "SKIP"
        else
          ln -snf "$SOURCE_GSTACK_DIR" "$CLAUDE_GSTACK_LINK"
          echo "LINKED"
        fi
      `;
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('LINKED');
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(dest)).toBe(source);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('guard allows ln when dest is an existing symlink (upgrade-in-place path)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-guard-'));
    try {
      const source = path.join(tmp, 'new-source');
      const oldSource = path.join(tmp, 'old-source');
      const dest = path.join(tmp, 'dest-symlink');
      fs.mkdirSync(source);
      fs.mkdirSync(oldSource);
      fs.symlinkSync(oldSource, dest);
      // Existing symlink: -L is true, so the guard does NOT trigger. ln -snf
      // should atomically retarget the symlink to the new source.
      const script = `
        set -e
        SOURCE_GSTACK_DIR='${source}'
        CLAUDE_GSTACK_LINK='${dest}'
        _SKIP_CLAUDE_REGISTER=0
        if [ -d "$CLAUDE_GSTACK_LINK" ] && [ ! -L "$CLAUDE_GSTACK_LINK" ]; then
          _EXISTING_REAL=$(cd "$CLAUDE_GSTACK_LINK" 2>/dev/null && pwd -P || echo "")
          if [ -n "$_EXISTING_REAL" ] && [ "$_EXISTING_REAL" != "$SOURCE_GSTACK_DIR" ]; then
            _SKIP_CLAUDE_REGISTER=1
          fi
        fi
        if [ "$_SKIP_CLAUDE_REGISTER" -eq 1 ]; then
          echo "SKIP"
        else
          ln -snf "$SOURCE_GSTACK_DIR" "$CLAUDE_GSTACK_LINK"
          echo "LINKED"
        fi
      `;
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('LINKED');
      expect(fs.readlinkSync(dest)).toBe(source);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('guard allows ln when dest is a real dir already pointing to source (self-rerun)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-guard-'));
    try {
      const source = path.join(tmp, 'source-worktree');
      fs.mkdirSync(source);
      // Mirror setup's SOURCE_GSTACK_DIR resolution (`pwd -P`) so the comparison
      // is fair on macOS where /tmp itself is a symlink to /private/tmp.
      const resolvedSource = fs.realpathSync(source);
      // Degenerate case: existing real dir IS the source.
      const dest = source;
      const script = `
        set -e
        SOURCE_GSTACK_DIR='${resolvedSource}'
        CLAUDE_GSTACK_LINK='${dest}'
        _SKIP_CLAUDE_REGISTER=0
        if [ -d "$CLAUDE_GSTACK_LINK" ] && [ ! -L "$CLAUDE_GSTACK_LINK" ]; then
          _EXISTING_REAL=$(cd "$CLAUDE_GSTACK_LINK" 2>/dev/null && pwd -P || echo "")
          if [ -n "$_EXISTING_REAL" ] && [ "$_EXISTING_REAL" != "$SOURCE_GSTACK_DIR" ]; then
            _SKIP_CLAUDE_REGISTER=1
          fi
        fi
        echo "skip=$_SKIP_CLAUDE_REGISTER"
      `;
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('skip=0');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
