/**
 * setup: _prune_stale_generated — generated skill dirs whose source template
 * is gone are pruned from the per-host render tree AND from the host's skills
 * dir, so a retired skill (v2.0: the browser-surface skills) can't stay live
 * on Codex/Factory/OpenCode/Cursor/Kiro after `./setup` re-links.
 *
 * gen-skill-docs never deletes stale out-dir entries; setup is the one place
 * every host install passes through. Behavior fixture: extract the helper and
 * its gate from setup, run it against a temp tree.
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
  // Source templates: a flat skill and the one prefixed source (gstack-upgrade).
  for (const s of ['qa', 'gstack-upgrade']) {
    fs.mkdirSync(path.join(src, s), { recursive: true });
    fs.writeFileSync(path.join(src, s, 'SKILL.md.tmpl'), 'x');
  }
  // Generated tree: live renders + two retired ones + the gstack sidecar.
  for (const g of ['gstack-qa', 'gstack-upgrade', 'gstack-skillify', 'gstack-pair-agent', 'gstack']) {
    fs.mkdirSync(path.join(gen, g), { recursive: true });
    fs.writeFileSync(path.join(gen, g, 'SKILL.md'), `${BANNER}# ${g}\n`);
  }
  fs.mkdirSync(host, { recursive: true });
  // Host entries: symlink (Unix), bannered real copy (Windows/Kiro), user's own dir.
  fs.symlinkSync(path.join(gen, 'gstack-qa') + '/', path.join(host, 'gstack-qa'));
  fs.symlinkSync(path.join(gen, 'gstack-skillify') + '/', path.join(host, 'gstack-skillify'));
  fs.mkdirSync(path.join(host, 'gstack-pair-agent'));
  fs.writeFileSync(path.join(host, 'gstack-pair-agent', 'SKILL.md'), `${BANNER}copy\n`);
  fs.mkdirSync(path.join(host, 'gstack-mine'));
  fs.writeFileSync(path.join(host, 'gstack-mine', 'SKILL.md'), '---\nname: mine\n---\nuser skill\n');
  return { src, gen, host };
}

function runPrune(src: string, gen: string, host?: string) {
  const script = [
    'set -e',
    extractFn('_owned_for_windows_refresh'),
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
      expect(r.stdout).toContain('pruned retired skill: gstack-skillify');
      expect(r.stdout).toContain('pruned retired skill: gstack-pair-agent');

      expect(fs.readdirSync(gen).sort()).toEqual(['gstack', 'gstack-qa', 'gstack-upgrade']);
      // Symlink to a retired render + bannered copy of one: removed.
      expect(fs.existsSync(path.join(host, 'gstack-skillify'))).toBe(false);
      expect(fs.lstatSync(path.join(host, 'gstack-skillify'), { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.existsSync(path.join(host, 'gstack-pair-agent'))).toBe(false);
      // Live link and the user's own (unbannered) dir: untouched.
      expect(fs.lstatSync(path.join(host, 'gstack-qa')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(host, 'gstack-mine', 'SKILL.md'), 'utf-8')).toContain('user skill');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('no host dir → prunes the render tree only; missing render tree → no-op', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
    try {
      const { src, gen, host } = mk(t);
      expect(runPrune(src, gen).status).toBe(0);
      expect(fs.existsSync(path.join(gen, 'gstack-skillify'))).toBe(false);
      expect(fs.lstatSync(path.join(host, 'gstack-skillify')).isSymbolicLink()).toBe(true); // dangling, but not ours to touch here

      const r = runPrune(src, path.join(t, 'nope'), host);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });
});
