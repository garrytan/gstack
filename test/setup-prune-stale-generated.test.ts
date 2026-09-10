/**
 * setup: _prune_stale_generated — generated skill dirs whose source template
 * is gone are pruned from the per-host render tree AND from the host's skills
 * dir, so a skill removed from the source tree can't stay live on
 * Codex/Factory/OpenCode/Cursor/Kiro after `./setup` re-links.
 *
 * gen-skill-docs never deletes stale out-dir entries; setup is the one place
 * every host install passes through. Behavior fixture: extract the helper and
 * its gate from setup, run it against a temp tree.
 *
 * Ownership (#2119): a symlink into our render tree goes outright; a REAL
 * host directory proven only by the generated banner is weak proof, so only
 * our SKILL.md, marker and asset links are removed (_cleanup_weak_dir) and the
 * user's own files next to them survive.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n';

function mk(t: string) {
  const src = path.join(t, 'src');
  const gen = path.join(t, 'gen');
  const host = path.join(t, 'host');
  // Source templates: a flat skill, the one prefixed source (gstack-upgrade), and a
  // skill whose frontmatter `name:` differs from its directory (gen-skill-docs
  // renders that one as gstack-test, never gstack-run-tests).
  for (const s of ['qa', 'gstack-upgrade']) {
    fs.mkdirSync(path.join(src, s), { recursive: true });
    fs.writeFileSync(path.join(src, s, 'SKILL.md.tmpl'), 'x');
  }
  fs.mkdirSync(path.join(src, 'run-tests'), { recursive: true });
  fs.writeFileSync(path.join(src, 'run-tests', 'SKILL.md.tmpl'), '---\nname: test\n---\nx\n');
  // Generated tree: live renders + two retired ones + the gstack sidecar.
  for (const g of ['gstack-qa', 'gstack-upgrade', 'gstack-test', 'gstack-oldskill', 'gstack-gone', 'gstack-extra', 'gstack']) {
    fs.mkdirSync(path.join(gen, g), { recursive: true });
    fs.writeFileSync(path.join(gen, g, 'SKILL.md'), `${BANNER}# ${g}\n`);
  }
  // A symlink IN the render tree (a dev linking a WIP skill) whose target must
  // survive: `rm -rf` on a slash-terminated link would empty the target.
  const elsewhere = path.join(t, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), `${BANNER}# wip\n`);
  fs.symlinkSync(elsewhere, path.join(gen, 'gstack-wip'));
  fs.mkdirSync(host, { recursive: true });
  // Host entries: symlink (Unix), bannered real copy (Windows/Kiro), user's own dir.
  fs.symlinkSync(path.join(gen, 'gstack-qa') + '/', path.join(host, 'gstack-qa'));
  fs.symlinkSync(path.join(gen, 'gstack-oldskill') + '/', path.join(host, 'gstack-oldskill'));
  fs.mkdirSync(path.join(host, 'gstack-gone'));
  fs.writeFileSync(path.join(host, 'gstack-gone', 'SKILL.md'), `${BANNER}copy\n`);
  fs.mkdirSync(path.join(host, 'gstack-mine'));
  fs.writeFileSync(path.join(host, 'gstack-mine', 'SKILL.md'), '---\nname: mine\n---\nuser skill\n');
  // Bannered real copy of a retired render with the user's own file beside it:
  // weak proof covers only SKILL.md, so notes.md must survive (#2119).
  fs.mkdirSync(path.join(host, 'gstack-extra'));
  fs.writeFileSync(path.join(host, 'gstack-extra', 'SKILL.md'), `${BANNER}copy\n`);
  fs.writeFileSync(path.join(host, 'gstack-extra', 'notes.md'), 'my notes\n');
  return { src, gen, host, elsewhere };
}

function runPrune(src: string, gen: string, host?: string) {
  const script = [
    'set -e',
    'log() { echo "$@"; }',
    // _cleanup_weak_dir and the helpers it leans on come from main's ownership
    // gate; the prune routes bannered real dirs through it.
    extractFn('_gstack_link_target_abs'),
    extractFn('_gstack_target_is_ours'),
    extractFn('_gstack_generated_header'),
    extractFn('_backup_skill_md'),
    extractFn('_cleanup_weak_dir'),
    extractFn('_owned_for_windows_refresh'),
    extractFn('_skill_source_exists'),
    extractFn('_prune_stale_generated'),
    `_prune_stale_generated "${src}" "${gen}" ${host ? `"${host}"` : ''}`,
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
}

describe('setup: _prune_stale_generated', () => {
  test('call sites: every host link + the always-run codex render are pruned', () => {
    for (const site of [
      '"$SOURCE_GSTACK_DIR/.agents/skills"',
      '"$SOURCE_GSTACK_DIR/.agents/skills" "$CODEX_SKILLS"',
      '"$SOURCE_GSTACK_DIR/.factory/skills" "$FACTORY_SKILLS"',
      '"$SOURCE_GSTACK_DIR/.opencode/skills" "$OPENCODE_SKILLS"',
      '"$SOURCE_GSTACK_DIR/.cursor/skills" "$CURSOR_SKILLS"',
      '"$AGENTS_DIR" "$KIRO_SKILLS"',
    ]) {
      expect(SETUP_SRC).toContain(`_prune_stale_generated "$SOURCE_GSTACK_DIR" ${site}`);
    }
  });

  test('retired renders go; live, prefixed-source, and sidecar dirs stay; host entries follow provenance', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    try {
      const { src, gen, host } = mk(t);
      const r = runPrune(src, gen, host);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pruned retired skill: gstack-oldskill');
      expect(r.stdout).toContain('pruned retired skill: gstack-gone');

      // gstack-test survives on its frontmatter name; the wip symlink is skipped, its target intact.
      expect(fs.readdirSync(gen).sort()).toEqual(['gstack', 'gstack-qa', 'gstack-test', 'gstack-upgrade', 'gstack-wip']);
      expect(fs.readFileSync(path.join(t, 'elsewhere', 'SKILL.md'), 'utf-8')).toContain('# wip');
      expect(r.stdout).not.toContain('gstack-wip');
      expect(r.stdout).not.toContain('gstack-test');
      // Symlink to a retired render + bannered copy of one: removed.
      expect(fs.existsSync(path.join(host, 'gstack-oldskill'))).toBe(false);
      expect(fs.lstatSync(path.join(host, 'gstack-oldskill'), { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.existsSync(path.join(host, 'gstack-gone'))).toBe(false);
      // Bannered copy with the user's own file next to it: only our SKILL.md
      // goes, the file and the directory stay, and setup says so.
      expect(r.stdout).toContain('pruned retired skill: gstack-extra');
      expect(r.stdout).toContain('cleaned gstack-extra/SKILL.md (other files in that directory were left in place)');
      expect(fs.existsSync(path.join(host, 'gstack-extra', 'SKILL.md'))).toBe(false);
      expect(fs.readFileSync(path.join(host, 'gstack-extra', 'notes.md'), 'utf-8')).toBe('my notes\n');
      // Live link and the user's own (unbannered) dir: untouched.
      expect(fs.lstatSync(path.join(host, 'gstack-qa')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(host, 'gstack-mine', 'SKILL.md'), 'utf-8')).toContain('user skill');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('no host dir → prunes the render tree only; a host dir is cleaned even after the generator already removed the render', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    try {
      const { src, gen, host } = mk(t);
      expect(runPrune(src, gen).status).toBe(0);
      expect(fs.existsSync(path.join(gen, 'gstack-oldskill'))).toBe(false);
      expect(fs.lstatSync(path.join(host, 'gstack-oldskill')).isSymbolicLink()).toBe(true); // dangling, but no host dir was passed

      // gen-skill-docs prunes its own render tree before setup runs; the host
      // entries it left dangling must still be cleaned from the host dir alone.
      const r = runPrune(src, gen, host);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('pruned retired skill: gstack-oldskill');
      expect(fs.lstatSync(path.join(host, 'gstack-oldskill'), { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.existsSync(path.join(host, 'gstack-gone'))).toBe(false);
      expect(fs.lstatSync(path.join(host, 'gstack-qa')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(host, 'gstack-mine', 'SKILL.md'), 'utf-8')).toContain('user skill');

      // A render tree that does not exist at all is a no-op when no host dir is passed.
      const none = runPrune(src, path.join(t, 'nope'));
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('a host symlink that points outside gstack is never removed, even under a retired name', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    try {
      const { src, gen, host } = mk(t);
      const theirs = path.join(t, 'their-skill');
      fs.mkdirSync(theirs);
      fs.writeFileSync(path.join(theirs, 'SKILL.md'), '---\nname: gstack-gone\n---\ntheirs\n');
      fs.rmSync(path.join(host, 'gstack-gone'), { recursive: true, force: true });
      fs.symlinkSync(theirs, path.join(host, 'gstack-gone'));
      const r = runPrune(src, gen, host);
      expect(r.status).toBe(0);
      expect(fs.lstatSync(path.join(host, 'gstack-gone')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(theirs, 'SKILL.md'), 'utf-8')).toContain('theirs');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });
});
