/**
 * :user render never dirties the global-git install (#2569).
 *
 * Pre-v1.67, gbrain-enabled setups ran `gen:skill-docs:user --host claude`
 * IN PLACE inside the install checkout, rewriting ~16 tracked SKILL.md files.
 * The checkout stayed permanently dirty and every upgrade stashed a redundant
 * snapshot of generated content. The fix renders to an untracked out-dir
 * (~/.gstack/render/claude) and makes the Claude installers — setup's
 * link_claude_skill_dirs AND bin/gstack-relink — prefer rendered files when
 * present. A one-time migration (v1.67.0.0.sh) restores the legacy dirt.
 *
 * (The render mechanism itself — worktree byte-unchanged, section repointing —
 * is pinned by test/gen-skill-docs-out-dir.test.ts.)
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const CONFIG_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-config'), 'utf-8');
const RELINK_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-relink'), 'utf-8');
const MIGRATION = path.join(ROOT, 'gstack-upgrade', 'migrations', 'v1.67.0.0.sh');

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  const end = src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}()`);
  return src.slice(start, end + 2);
}

describe(':user render targets the out-dir, never the checkout (#2569)', () => {
  test('setup renders gen:skill-docs:user with --out-dir only', () => {
    const sites = SETUP_SRC.split('gen:skill-docs:user').length - 1;
    const outDirSites = SETUP_SRC.split('gen:skill-docs:user --host claude --out-dir').length - 1;
    // Every executable :user invocation carries --out-dir. (Prose/log
    // mentions don't pair with `bun_cmd run`.)
    const executableSites = SETUP_SRC.split('run gen:skill-docs:user').length - 1;
    expect(executableSites).toBeGreaterThan(0);
    expect(outDirSites).toBe(executableSites);
    expect(sites).toBeGreaterThanOrEqual(outDirSites);
  });

  test('setup renders into a TMP dir, swaps on success, repoints after (never wipes first)', () => {
    const block = SETUP_SRC.slice(
      SETUP_SRC.indexOf('# ─── GBrain detection + conditional SKILL.md render'),
      SETUP_SRC.indexOf('# 11. Plan-tune cathedral hook install'),
    );
    // The live render dir is symlinked into by installed skills — it may only
    // be replaced AFTER a successful render (a pre-render wipe left every
    // brain-aware SKILL.md link dangling on a transient render failure).
    expect(block).toContain('--out-dir "$_GSTACK_RENDER_TMP"');
    expect(block).not.toContain('--out-dir "$_GSTACK_RENDER_DIR"');
    expect(block).toContain('_swap_in_render "$_GSTACK_RENDER_DIR" "$_GSTACK_RENDER_TMP"');
    expect(block).toContain('link_claude_skill_dirs "$SOURCE_GSTACK_DIR" "$INSTALL_SKILLS_DIR"');
    // Stale-render cleanup on the gbrain-gone path (a deliberate wipe).
    expect(block).toContain('gbrain not detected');
    expect(block).toContain('rm -rf "$_GSTACK_RENDER_DIR"');
  });

  test('gstack-config gbrain-refresh renders to a TMP out-dir, swaps on success', () => {
    expect(CONFIG_SRC).toContain('gen:skill-docs:user --host claude --out-dir');
    expect(CONFIG_SRC).not.toContain("this dirties the install's git tree");
    expect(CONFIG_SRC).toContain('gstack-relink');
    expect(CONFIG_SRC).toContain('--out-dir "$RENDER_TMP"');
    expect(CONFIG_SRC).not.toContain('--out-dir "$RENDER_DIR"');
    expect(CONFIG_SRC).toContain('_swap_in_render "$RENDER_DIR" "$RENDER_TMP"');
  });

  test('_swap_in_render behavior: success replaces, and the shape means failure never touches the live dir', () => {
    // Both files carry the same-contract helper — drive each for real.
    for (const src of [SETUP_SRC, CONFIG_SRC]) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-swap-'));
      try {
        const live = path.join(tmp, 'claude');
        const fresh = path.join(tmp, 'claude.tmp.123');
        fs.mkdirSync(path.join(live, 'ship'), { recursive: true });
        fs.writeFileSync(path.join(live, 'ship', 'SKILL.md'), 'old-render\n');
        fs.mkdirSync(path.join(fresh, 'ship'), { recursive: true });
        fs.writeFileSync(path.join(fresh, 'ship', 'SKILL.md'), 'new-render\n');

        const script = [
          'set -e',
          extractFn(src, '_swap_in_render'),
          `_swap_in_render "${live}" "${fresh}"`,
        ].join('\n');
        const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 15_000 });
        expect(r.status).toBe(0);
        // Live dir now serves the fresh render at the SAME path (links into
        // it stay valid), tmp and .old are gone.
        expect(fs.readFileSync(path.join(live, 'ship', 'SKILL.md'), 'utf-8')).toBe('new-render\n');
        expect(fs.existsSync(fresh)).toBe(false);
        expect(fs.readdirSync(tmp)).toEqual(['claude']);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  test('a FAILED render leaves the previous render dir fully intact (gstack-config path, end-to-end shape)', () => {
    // Reconstruct the exact failure branch: render into tmp fails → tmp is
    // removed, the live dir (and the symlinks into it) are untouched, and
    // _swap_in_render is never called.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-fail-'));
    try {
      const live = path.join(tmp, 'claude');
      fs.mkdirSync(path.join(live, 'ship'), { recursive: true });
      fs.writeFileSync(path.join(live, 'ship', 'SKILL.md'), 'previous-render\n');
      // An installed skill symlinks into the live render dir.
      const installed = path.join(tmp, 'installed-ship-SKILL.md');
      fs.symlinkSync(path.join(live, 'ship', 'SKILL.md'), installed);

      const script = [
        'set -u',
        extractFn(CONFIG_SRC, '_swap_in_render'),
        `RENDER_DIR="${live}"`,
        'RENDER_TMP="$RENDER_DIR.tmp.$$"',
        'rm -rf "$RENDER_TMP"',
        // The render fails (broken template, bun error, disk full).
        'if ( mkdir -p "$RENDER_TMP" && false ); then',
        '  _swap_in_render "$RENDER_DIR" "$RENDER_TMP"',
        'else',
        '  rm -rf "$RENDER_TMP"',
        '  echo "render failed — previous render left in place" >&2',
        'fi',
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 15_000 });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(live, 'ship', 'SKILL.md'), 'utf-8')).toBe('previous-render\n');
      // The installed symlink still resolves — the skill set did not vanish.
      expect(fs.readFileSync(installed, 'utf-8')).toBe('previous-render\n');
      expect(fs.readdirSync(tmp).sort()).toEqual(['claude', 'installed-ship-SKILL.md']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gstack-relink prefers the render dir when a rendered SKILL.md exists', () => {
    expect(RELINK_SRC).toContain('render/claude');
    expect(RELINK_SRC).toContain('[ -f "$RENDER_DIR/$skill/SKILL.md" ] && skill_md_src="$RENDER_DIR/$skill/SKILL.md"');
  });
});

describe('link_claude_skill_dirs prefers rendered SKILL.md (behavior)', () => {
  test('a rendered variant is served; skills without one fall back to source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-render-pref-'));
    try {
      const src = path.join(tmp, 'src');
      const skills = path.join(tmp, 'skills');
      const home = path.join(tmp, 'gstack-home');
      // Source tree: two skills.
      for (const s of ['alpha', 'beta']) {
        fs.mkdirSync(path.join(src, s), { recursive: true });
        fs.writeFileSync(
          path.join(src, s, 'SKILL.md'),
          `---\nname: ${s}\ndescription: t\n---\ncanonical-${s}\n`,
        );
      }
      // Render exists for alpha only.
      fs.mkdirSync(path.join(home, 'render', 'claude', 'alpha'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'render', 'claude', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: t\n---\nrendered-alpha with Brain Context Load\n',
      );
      fs.mkdirSync(skills, { recursive: true });

      const script = [
        'set -e',
        'IS_WINDOWS=0',
        'SKILL_PREFIX=0',
        '_WINDOWS_COPY_NOTE_PRINTED=1',
        `GSTACK_HOME="${home}"`,
        extractFn(SETUP_SRC, '_link_or_copy'),
        extractFn(SETUP_SRC, '_print_windows_copy_note_once'),
        extractFn(SETUP_SRC, '_link_skill_runtime_assets'),
        extractFn(SETUP_SRC, 'link_claude_skill_dirs'),
        `link_claude_skill_dirs "${src}" "${skills}"`,
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 15_000 });
      expect(r.status).toBe(0);

      expect(fs.readFileSync(path.join(skills, 'alpha', 'SKILL.md'), 'utf-8')).toContain('rendered-alpha');
      expect(fs.readFileSync(path.join(skills, 'beta', 'SKILL.md'), 'utf-8')).toContain('canonical-beta');
      // The SOURCE stayed canonical — the render is served via the link only.
      expect(fs.readFileSync(path.join(src, 'alpha', 'SKILL.md'), 'utf-8')).toContain('canonical-alpha');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('migration v1.67.0.0 — legacy in-place render cleanup (F12)', () => {
  function git(cwd: string, ...args: string[]): void {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }

  function makeLegacyInstall(tmp: string): string {
    const install = path.join(tmp, 'install');
    fs.mkdirSync(path.join(install, 'ship', 'sections'), { recursive: true });
    fs.writeFileSync(path.join(install, 'VERSION'), '1.66.0.0\n');
    fs.writeFileSync(path.join(install, 'ship', 'SKILL.md'), 'canonical ship\n');
    fs.writeFileSync(path.join(install, 'ship', 'sections', 'tests.md'), 'canonical section\n');
    fs.writeFileSync(path.join(install, 'README.md'), 'readme\n');
    git(install, 'init', '-b', 'main');
    git(install, 'config', 'user.email', 't@t.test');
    git(install, 'config', 'user.name', 't');
    git(install, 'add', '-A');
    git(install, 'commit', '-m', 'base', '-q');
    return install;
  }

  function runMigration(install: string): { status: number | null; stdout: string } {
    const r = spawnSync('bash', [MIGRATION], {
      encoding: 'utf-8',
      env: { ...process.env, GSTACK_INSTALL_DIR: install },
      timeout: 15_000,
    });
    return { status: r.status, stdout: r.stdout };
  }

  test('restores render-class dirt, leaves user changes alone, idempotent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-migration-'));
    try {
      const install = makeLegacyInstall(tmp);
      // Legacy render dirt + a genuine user edit + an untracked file.
      fs.writeFileSync(path.join(install, 'ship', 'SKILL.md'), 'brain-aware rendered ship\n');
      fs.writeFileSync(path.join(install, 'ship', 'sections', 'tests.md'), 'brain-aware section\n');
      fs.writeFileSync(path.join(install, 'README.md'), 'user edit\n');
      fs.writeFileSync(path.join(install, 'notes.txt'), 'untracked\n');

      const r1 = runMigration(install);
      expect(r1.status).toBe(0);
      expect(r1.stdout).toContain('restored 2 tracked file(s)');
      expect(fs.readFileSync(path.join(install, 'ship', 'SKILL.md'), 'utf-8')).toBe('canonical ship\n');
      expect(fs.readFileSync(path.join(install, 'ship', 'sections', 'tests.md'), 'utf-8')).toBe('canonical section\n');
      // The user's own edits are NOT the render footprint — untouched, reported.
      expect(fs.readFileSync(path.join(install, 'README.md'), 'utf-8')).toBe('user edit\n');
      expect(fs.existsSync(path.join(install, 'notes.txt'))).toBe(true);
      expect(r1.stdout).toContain('left');

      // Idempotent: nothing left in the footprint on the second run.
      const r2 = runMigration(install);
      expect(r2.status).toBe(0);
      expect(r2.stdout).not.toContain('restored');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('clean checkout, missing dir, and symlinked install are all silent no-ops', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-migration-noop-'));
    try {
      const install = makeLegacyInstall(tmp);
      const clean = runMigration(install);
      expect(clean.status).toBe(0);
      expect(clean.stdout.trim()).toBe('');

      const missing = runMigration(path.join(tmp, 'does-not-exist'));
      expect(missing.status).toBe(0);

      const link = path.join(tmp, 'symlinked-install');
      fs.symlinkSync(install, link);
      const sym = runMigration(link);
      expect(sym.status).toBe(0);
      expect(sym.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
