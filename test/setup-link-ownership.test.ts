/**
 * setup never links over, copies over, or deletes a skill it does not own
 * (#2119). The relink gate alone was not enough: link_claude_skill_dirs runs
 * BEFORE relink on every ./setup, and on Linux `ln -snf` replaces a user's
 * real SKILL.md with a symlink into gstack (on Windows: rm -rf + cp, then a
 * marker that makes the user's dir "ours" on the next flip). The reverse
 * mode-flip cleanup (cleanup_prefixed_claude_symlinks) kept a bare name-match
 * deletion and a `*gstack*` substring match. Same anchor-sliced convention as
 * test/setup-cleanup-orphans.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { runBashScript } from './helpers/bash-script';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function not found: ${name}`);
  return SETUP_SRC.slice(start, end + 2);
}
const HELPERS = [
  '_FOREIGN_SKIPPED_ENTRIES=()',
  '_link_skill_runtime_assets() { :; }',
  '_print_windows_copy_note_once() { :; }',
  extractFn('_link_or_copy'),
  extractFn('_gstack_link_target_abs'),
  extractFn('_gstack_target_is_ours'),
  extractFn('_claude_entry_is_ours'),
  extractFn('_write_owned_marker'),
  extractFn('_gstack_generated_header'),
  extractFn('_claude_entry_owned_strongly'),
  extractFn('_backup_skill_md'),
  extractFn('_cleanup_weak_dir'),
  extractFn('_gstack_dir_only_links'),
  extractFn('_cleanup_linked_dir'),
  '_BACKED_UP_SKILL_MDS=()',
  '_SKILL_BACKUP_ROOT="$HOME/.gstack/backups/skills/test"',
].join('\n');

const FOREIGN = '---\nname: qa\ndescription: mine\n---\n# not gstack\n';
const GENERATED = (name: string) => `---\nname: ${name}\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n# ${name}\n`;

function mkTree(): { tmp: string; skills: string; payload: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-link-own-'));
  const skills = path.join(tmp, 'skills');
  const payload = path.join(skills, 'gstack');
  fs.mkdirSync(payload, { recursive: true });
  return { tmp, skills, payload };
}
function bash(lines: string[], tmp: string) {
  const r = runBashScript(lines.join('\n'), { timeout: 10_000, env: { PATH: process.env.PATH ?? '', HOME: tmp, GSTACK_USER_RENDER_DIR: path.join(tmp, 'no-render') } });
  // An extracted function calling a helper this harness forgot to extract must
  // fail loudly, not degrade into "foreign, skipped".
  if (/command not found/.test(r.stderr ?? '')) throw new Error(`harness drift (missing extracted helper):\n${r.stderr}`);
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(process.platform === 'win32')('setup: link_claude_skill_dirs never links over a foreign skill (#2119)', () => {
  for (const isWindows of ['0', '1'] as const) {
    test(`IS_WINDOWS=${isWindows}: a foreign real SKILL.md survives byte-identical, gets no marker, is reported and counted`, () => {
      const t = mkTree();
      try {
        fs.mkdirSync(path.join(t.payload, 'qa'));
        fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
        fs.mkdirSync(path.join(t.payload, 'ship'));
        fs.writeFileSync(path.join(t.payload, 'ship', 'SKILL.md'), GENERATED('ship'));
        fs.mkdirSync(path.join(t.skills, 'qa'));
        fs.writeFileSync(path.join(t.skills, 'qa', 'SKILL.md'), FOREIGN);
        const r = bash(['set -e', `IS_WINDOWS=${isWindows}`, 'SKILL_PREFIX=0', HELPERS,
          extractFn('link_claude_skill_dirs'),
          `link_claude_skill_dirs "${t.payload}" "${t.skills}"`,
          'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
        expect(r.status).toBe(0);
        const md = path.join(t.skills, 'qa', 'SKILL.md');
        expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(md, 'utf-8')).toBe(FOREIGN);
        expect(fs.existsSync(path.join(t.skills, 'qa', '.gstack-owned'))).toBe(false);
        expect(r.stderr).toContain('skipped qa');
        expect(r.stdout).toContain('FOREIGN=qa');
        // The other skill still links normally.
        expect(fs.existsSync(path.join(t.skills, 'ship', 'SKILL.md'))).toBe(true);
        expect(r.stdout).toContain('linked skills: ship');
      } finally {
        fs.rmSync(t.tmp, { recursive: true, force: true });
      }
    });
  }

  test('our own previous entry (symlink into the payload) is refreshed, not skipped', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.skills, 'qa'));
      fs.symlinkSync(path.join(t.payload, 'qa', 'SKILL.md'), path.join(t.skills, 'qa', 'SKILL.md'));
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('FOREIGN=\n');
      expect(fs.lstatSync(path.join(t.skills, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('the Windows marker records the owning payload path and a marked copy is ours on the next run', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      const first = bash(['set -e', 'IS_WINDOWS=1', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`], t.tmp);
      expect(first.status).toBe(0);
      const marker = path.join(t.skills, 'qa', '.gstack-owned');
      expect(fs.readFileSync(marker, 'utf-8').trim()).toBe(fs.realpathSync(t.payload));
      // Second run over our own copy: refreshed, not reported.
      const second = bash(['set -e', 'IS_WINDOWS=1', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(second.stdout).toContain('FOREIGN=\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('setup: _install_alias_skill_md never overwrites a foreign alias-named skill (#2119)', () => {
  test('a user skill named connect-chrome survives; a generated alias copy is refreshed', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'open-gstack-browser'));
      fs.writeFileSync(path.join(t.payload, 'open-gstack-browser', 'SKILL.md'), GENERATED('open-gstack-browser'));
      fs.mkdirSync(path.join(t.skills, 'connect-chrome'));
      fs.writeFileSync(path.join(t.skills, 'connect-chrome', 'SKILL.md'), FOREIGN);
      fs.mkdirSync(path.join(t.skills, 'gstack-connect-chrome'));
      fs.writeFileSync(path.join(t.skills, 'gstack-connect-chrome', 'SKILL.md'), GENERATED('gstack-connect-chrome').replace('# gstack-connect-chrome', '# old alias copy'));
      const r = bash(['set -e', 'IS_WINDOWS=0', `SOURCE_GSTACK_DIR="${t.payload}"`, HELPERS, extractFn('_install_alias_skill_md'),
        `_install_alias_skill_md "${t.payload}/open-gstack-browser/SKILL.md" "${t.skills}/connect-chrome" connect-chrome`,
        `_install_alias_skill_md "${t.payload}/open-gstack-browser/SKILL.md" "${t.skills}/gstack-connect-chrome" gstack-connect-chrome`,
        'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(t.skills, 'connect-chrome', 'SKILL.md'), 'utf-8')).toBe(FOREIGN);
      expect(r.stdout).toContain('FOREIGN=connect-chrome');
      expect(fs.readFileSync(path.join(t.skills, 'gstack-connect-chrome', 'SKILL.md'), 'utf-8')).toContain('name: gstack-connect-chrome');
      expect(fs.readFileSync(path.join(t.skills, 'gstack-connect-chrome', 'SKILL.md'), 'utf-8')).not.toContain('old alias copy');
      // A pre-existing alias directory is never stamped (we did not create it); a created one is.
      expect(fs.existsSync(path.join(t.skills, 'gstack-connect-chrome', '.gstack-owned'))).toBe(false);
      expect(fs.existsSync(path.join(t.skills, 'connect-chrome', '.gstack-owned'))).toBe(false);
      const created = bash(['set -e', 'IS_WINDOWS=0', `SOURCE_GSTACK_DIR="${t.payload}"`, HELPERS, extractFn('_install_alias_skill_md'),
        `_install_alias_skill_md "${t.payload}/open-gstack-browser/SKILL.md" "${t.skills}/fresh-alias" fresh-alias`], t.tmp);
      expect(created.status).toBe(0);
      expect(fs.readFileSync(path.join(t.skills, 'fresh-alias', '.gstack-owned'), 'utf-8').trim()).toBe(fs.realpathSync(t.payload));
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('setup: cleanup_prefixed_claude_symlinks proves provenance (#2119)', () => {
  function runFlip(isWindows: '0' | '1', plant: (skills: string, payload: string) => void) {
    const t = mkTree();
    fs.mkdirSync(path.join(t.payload, 'qa'));
    fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
    plant(t.skills, t.payload);
    const r = bash(['set -e', `IS_WINDOWS=${isWindows}`, extractFn('_gstack_link_target_abs'), extractFn('_gstack_target_is_ours'), extractFn('_gstack_dir_only_links'), extractFn('_cleanup_linked_dir'), extractFn('_gstack_generated_header'), extractFn('_cleanup_weak_dir'), extractFn('_backup_skill_md'), '_BACKED_UP_SKILL_MDS=()', '_SKILL_BACKUP_ROOT="$HOME/.gstack/backups/skills/test"', extractFn('cleanup_prefixed_claude_symlinks'),
      `cleanup_prefixed_claude_symlinks "${t.payload}" "${t.skills}"`], t.tmp);
    const names = fs.readdirSync(t.skills).sort();
    fs.rmSync(t.tmp, { recursive: true, force: true });
    return { ...r, names };
  }

  test('Windows: a user-owned gstack-qa (no marker, not identical, no header) survives the prefix→flat flip', () => {
    const r = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n# user-owned\n');
    });
    expect(r.status).toBe(0);
    expect(r.names).toEqual(['gstack', 'gstack-qa']);
    expect(r.stdout).toBe('');
  });

  test('Windows: marker, byte-identical, and generated-header copies are reaped', () => {
    const r = runFlip('1', (skills, payload) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.copyFileSync(path.join(payload, 'qa', 'SKILL.md'), path.join(skills, 'gstack-qa', 'SKILL.md'));
    });
    expect(r.names).toEqual(['gstack']);
    const m = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n# stale\n');
      fs.writeFileSync(path.join(skills, 'gstack-qa', '.gstack-owned'), '');
    });
    expect(m.names).toEqual(['gstack']);
    const h = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), GENERATED('gstack-qa').replace('# gstack-qa', '# older render'));
    });
    expect(h.names).toEqual(['gstack']);
  });

  test('Windows: weak proof (banner, no marker) removes only SKILL.md; the user\'s other files and the directory survive', () => {
    const r = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa', 'my-templates'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), GENERATED('gstack-qa').replace('# gstack-qa', '# started from gstack, then customized'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'my-templates', 'checklist.md'), '- mine\n');
    });
    expect(r.status).toBe(0);
    expect(r.names).toEqual(['gstack', 'gstack-qa']);
    expect(r.stdout).toContain('cleaned gstack-qa/SKILL.md');
    // Strong proof (marker) still removes the directory we created.
    const m = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa', 'sections'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '# stale\n');
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'sections', 'x.md'), 'x\n');
      fs.writeFileSync(path.join(skills, 'gstack-qa', '.gstack-owned'), '/payload\n');
    });
    expect(m.names).toEqual(['gstack']);
  });

  test('Windows: a ONE-line AUTO-GENERATED substring from another generator is not provenance — the entry survives', () => {
    const r = runFlip('1', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.writeFileSync(path.join(skills, 'gstack-qa', 'SKILL.md'), '---\nname: gstack-qa\n---\n<!-- AUTO-GENERATED from my-skill-builder -->\n# theirs\n');
    });
    expect(r.status).toBe(0);
    expect(r.names).toEqual(['gstack', 'gstack-qa']);
  });

  test('a SKILL.md symlink whose target merely CONTAINS the substring gstack is not reaped; an anchored gstack/ segment is', () => {
    const keep = runFlip('0', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.symlinkSync('../../archive/my-gstack-backup/SKILL.md', path.join(skills, 'gstack-qa', 'SKILL.md'));
    });
    expect(keep.names).toEqual(['gstack', 'gstack-qa']);
    const reap = runFlip('0', (skills) => {
      fs.mkdirSync(path.join(skills, 'gstack-qa'));
      fs.symlinkSync('../gstack/qa/SKILL.md', path.join(skills, 'gstack-qa', 'SKILL.md'));
    });
    expect(reap.names).toEqual(['gstack']);
    expect(reap.stdout).toContain('cleaned up prefixed entries: gstack-qa');
  });
});

describe.skipIf(process.platform === 'win32')('setup: weakly-proven files are moved aside, never overwritten (#2119 review)', () => {
  test('Linux linker: a customized banner copy is moved to the backup root before the symlink lands; an identical copy is not', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.payload, 'ship'));
      fs.writeFileSync(path.join(t.payload, 'ship', 'SKILL.md'), GENERATED('ship'));
      const custom = GENERATED('qa').replace('# qa', '# my qa, started from gstack');
      fs.mkdirSync(path.join(t.skills, 'qa'));
      fs.writeFileSync(path.join(t.skills, 'qa', 'SKILL.md'), custom);
      fs.mkdirSync(path.join(t.skills, 'ship'));
      fs.copyFileSync(path.join(t.payload, 'ship', 'SKILL.md'), path.join(t.skills, 'ship', 'SKILL.md'));
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`,
        'echo "BACKED=${_BACKED_UP_SKILL_MDS[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.lstatSync(path.join(t.skills, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(t.skills, 'ship', 'SKILL.md')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(t.tmp, '.gstack', 'backups', 'skills', 'test', 'qa', 'SKILL.md'), 'utf-8')).toBe(custom);
      // Weakly-proven, pre-existing: no marker (it must never become deletable whole). Created dirs do get one.
      expect(fs.existsSync(path.join(t.skills, 'qa', '.gstack-owned'))).toBe(false);
      expect(fs.existsSync(path.join(t.tmp, '.gstack', 'backups', 'skills', 'test', 'ship'))).toBe(false);
      expect(r.stdout).toContain('BACKED=qa\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('Windows flip: weak proof leaves the user\'s files in place', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.skills, 'gstack-qa', 'my-templates'), { recursive: true });
      fs.writeFileSync(path.join(t.skills, 'gstack-qa', 'SKILL.md'), GENERATED('gstack-qa'));
      fs.writeFileSync(path.join(t.skills, 'gstack-qa', 'my-templates', 'checklist.md'), '- mine\n');
      const r = bash(['set -e', 'IS_WINDOWS=1', extractFn('_gstack_link_target_abs'), extractFn('_gstack_target_is_ours'), extractFn('_gstack_dir_only_links'), extractFn('_cleanup_linked_dir'), extractFn('_gstack_generated_header'), extractFn('_cleanup_weak_dir'), extractFn('_backup_skill_md'), '_BACKED_UP_SKILL_MDS=()', '_SKILL_BACKUP_ROOT="$HOME/.gstack/backups/skills/test"', extractFn('cleanup_prefixed_claude_symlinks'),
        `cleanup_prefixed_claude_symlinks "${t.payload}" "${t.skills}"`], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(t.skills, 'gstack-qa', 'SKILL.md'))).toBe(false);
      expect(fs.readFileSync(path.join(t.skills, 'gstack-qa', 'my-templates', 'checklist.md'), 'utf-8')).toBe('- mine\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('_run_relink_quiet forwards relink\'s skipped and moved lines once, deduped against setup\'s own report', () => {
    const t = mkTree();
    try {
      const fake = path.join(t.tmp, 'fake-relink');
      fs.writeFileSync(fake, '#!/usr/bin/env bash\necho "linked 3 skills"\necho "  skipped qa: existing entry is not gstack-managed (foreign skill with the same name) — left untouched" >&2\necho "  skipped ship: existing entry is not gstack-managed (foreign skill with the same name) — left untouched" >&2\necho "Moved 1 pre-existing SKILL.md file(s) to /x before linking gstack\'s: review"\n');
      fs.chmodSync(fake, 0o755);
      const r = bash(['set -e', '_FOREIGN_SKIPPED_ENTRIES=(qa)', `GSTACK_RELINK="${fake}"`, 'INSTALL_SKILLS_DIR=/dev/null', 'SOURCE_GSTACK_DIR=/dev/null',
        extractFn('_run_relink_quiet'), '_run_relink_quiet', 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(r.stderr.match(/skipped ship/g)?.length).toBe(1);
      expect(r.stderr).not.toContain('skipped qa');
      expect(r.stderr).toContain('Moved 1 pre-existing');
      expect(r.stderr).not.toContain('linked 3 skills');
      expect(r.stdout).toContain('FOREIGN=qa ship\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('setup: banner census, checkout naming, legacy linked dirs, markers (#2119 review)', () => {
  test('every generated SKILL.md in this tree passes _gstack_generated_header (four carry the banner past line 40)', () => {
    const files = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(ROOT, d.name, 'SKILL.md'))
      .concat([path.join(ROOT, 'SKILL.md')])
      .filter((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf-8').includes('<!-- AUTO-GENERATED from'));
    expect(files.length).toBeGreaterThan(30);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-banner-census-'));
    try {
      const r = bash(['set -e', extractFn('_gstack_generated_header'),
        `for f in ${files.map((f) => `"${f}"`).join(' ')}; do _gstack_generated_header "$f" || echo "MISS $f"; done`], tmp);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a link into a checkout named without a gstack segment is ours when the tree carries setup + VERSION + bin/', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      const other = path.join(t.tmp, 'gs-feature');
      fs.mkdirSync(path.join(other, 'qa'), { recursive: true });
      fs.mkdirSync(path.join(other, 'bin'));
      fs.writeFileSync(path.join(other, 'VERSION'), '1.0.0.0\n');
      fs.writeFileSync(path.join(other, 'setup'), '#!/bin/bash\n');
      fs.writeFileSync(path.join(other, 'bin', 'gstack-relink'), '#!/bin/bash\n');
      fs.writeFileSync(path.join(other, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.skills, 'qa'));
      fs.symlinkSync(path.join(other, 'qa', 'SKILL.md'), path.join(t.skills, 'qa', 'SKILL.md'));
      // A hand-written skill repo that happens to carry VERSION + setup + bin/ is NOT a gstack tree.
      const mine = path.join(t.tmp, 'myskills');
      fs.mkdirSync(path.join(mine, 'ship'), { recursive: true });
      fs.mkdirSync(path.join(mine, 'bin'));
      fs.writeFileSync(path.join(mine, 'VERSION'), '0.1\n');
      fs.writeFileSync(path.join(mine, 'setup'), '#!/bin/bash\n');
      fs.writeFileSync(path.join(mine, 'ship', 'SKILL.md'), FOREIGN);
      fs.mkdirSync(path.join(t.payload, 'ship'));
      fs.writeFileSync(path.join(t.payload, 'ship', 'SKILL.md'), GENERATED('ship'));
      fs.mkdirSync(path.join(t.skills, 'ship'));
      fs.symlinkSync(path.join(mine, 'ship', 'SKILL.md'), path.join(t.skills, 'ship', 'SKILL.md'));
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('FOREIGN=ship\n');
      expect(fs.readlinkSync(path.join(t.skills, 'ship', 'SKILL.md'))).toBe(path.join(mine, 'ship', 'SKILL.md'));
      expect(fs.readlinkSync(path.join(t.skills, 'qa', 'SKILL.md'))).toBe(path.join(t.payload, 'qa', 'SKILL.md'));
      // Re-pointed, but the directory pre-existed: no marker (only directories we create get one).
      expect(fs.existsSync(path.join(t.skills, 'qa', '.gstack-owned'))).toBe(false);
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('Linux linker: a created directory gets the marker; a pre-existing unclaimed directory (user files, no SKILL.md) is linked into without one', () => {
    const t = mkTree();
    try {
      for (const n of ['qa', 'ship']) { fs.mkdirSync(path.join(t.payload, n)); fs.writeFileSync(path.join(t.payload, n, 'SKILL.md'), GENERATED(n)); }
      fs.mkdirSync(path.join(t.skills, 'ship'));
      fs.writeFileSync(path.join(t.skills, 'ship', 'notes.md'), 'mine\n');
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('FOREIGN=\n');
      expect(fs.existsSync(path.join(t.skills, 'qa', '.gstack-owned'))).toBe(true);
      expect(fs.lstatSync(path.join(t.skills, 'ship', 'SKILL.md')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(t.skills, 'ship', '.gstack-owned'))).toBe(false);
      expect(fs.readFileSync(path.join(t.skills, 'ship', 'notes.md'), 'utf-8')).toBe('mine\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('flip on a legacy linked dir (no marker): all-links dir removed whole; a dir with a user file keeps the file, loses our links', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa', 'sections'), { recursive: true });
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.payload, 'ship'));
      fs.writeFileSync(path.join(t.payload, 'ship', 'SKILL.md'), GENERATED('ship'));
      for (const [name, src] of [['gstack-qa', 'qa'], ['gstack-ship', 'ship']] as const) {
        fs.mkdirSync(path.join(t.skills, name));
        fs.symlinkSync(path.join(t.payload, src, 'SKILL.md'), path.join(t.skills, name, 'SKILL.md'));
        fs.symlinkSync(path.join(t.payload, 'qa', 'sections'), path.join(t.skills, name, 'sections'));
      }
      fs.writeFileSync(path.join(t.skills, 'gstack-ship', 'my-notes.md'), 'keep\n');
      const r = bash(['set -e', 'IS_WINDOWS=0', extractFn('_gstack_link_target_abs'), extractFn('_gstack_target_is_ours'), extractFn('_gstack_dir_only_links'), extractFn('_cleanup_linked_dir'), extractFn('_gstack_generated_header'), extractFn('_cleanup_weak_dir'), extractFn('_backup_skill_md'), '_BACKED_UP_SKILL_MDS=()', '_SKILL_BACKUP_ROOT="$HOME/.gstack/backups/skills/test"', extractFn('cleanup_prefixed_claude_symlinks'),
        `cleanup_prefixed_claude_symlinks "${t.payload}" "${t.skills}"`], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(t.skills, 'gstack-qa'))).toBe(false);
      expect(fs.existsSync(path.join(t.skills, 'gstack-ship', 'SKILL.md'))).toBe(false);
      expect(fs.existsSync(path.join(t.skills, 'gstack-ship', 'sections'))).toBe(false);
      expect(fs.readFileSync(path.join(t.skills, 'gstack-ship', 'my-notes.md'), 'utf-8')).toBe('keep\n');
      expect(r.stdout).toContain('cleaned gstack-ship/SKILL.md');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('setup: cycle-3 hardening — assets, foreign dir links, failed backups, flip backups (#2119 review)', () => {
  const REAL_ASSETS = extractFn('_link_skill_runtime_assets');

  test('an unclaimed or weakly-owned directory keeps the user\'s same-named real assets; a created directory gets ours', () => {
    const t = mkTree();
    try {
      for (const n of ['qa', 'ship', 'review']) {
        fs.mkdirSync(path.join(t.payload, n, 'templates'), { recursive: true });
        fs.writeFileSync(path.join(t.payload, n, 'SKILL.md'), GENERATED(n));
        fs.writeFileSync(path.join(t.payload, n, 'templates', 'ours.md'), 'ours\n');
        fs.writeFileSync(path.join(t.payload, n, 'checklist.md'), 'ours\n');
      }
      // qa: unclaimed (no SKILL.md) with the user's templates/ and checklist.md
      fs.mkdirSync(path.join(t.skills, 'qa', 'templates'), { recursive: true });
      fs.writeFileSync(path.join(t.skills, 'qa', 'templates', 'mine.md'), 'mine\n');
      fs.writeFileSync(path.join(t.skills, 'qa', 'checklist.md'), 'my checklist\n');
      // ship: weakly owned (customized banner copy) with the user's templates/
      fs.mkdirSync(path.join(t.skills, 'ship', 'templates'), { recursive: true });
      fs.writeFileSync(path.join(t.skills, 'ship', 'SKILL.md'), GENERATED('ship').replace('# ship', '# customized'));
      fs.writeFileSync(path.join(t.skills, 'ship', 'templates', 'mine.md'), 'mine\n');
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, REAL_ASSETS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(t.skills, 'qa', 'templates', 'mine.md'), 'utf-8')).toBe('mine\n');
      expect(fs.readFileSync(path.join(t.skills, 'qa', 'checklist.md'), 'utf-8')).toBe('my checklist\n');
      expect(fs.lstatSync(path.join(t.skills, 'qa', 'checklist.md')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(t.skills, 'ship', 'templates', 'mine.md'), 'utf-8')).toBe('mine\n');
      expect(r.stderr).toContain('kept qa/templates');
      expect(r.stderr).toContain('kept qa/checklist.md');
      expect(r.stderr).toContain('kept ship/templates');
      // review: created by us → assets linked
      expect(fs.lstatSync(path.join(t.skills, 'review', 'templates')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(t.skills, 'review', 'checklist.md')).isSymbolicLink()).toBe(true);
      // ship's customized SKILL.md was backed up, its assets kept, its checklist (absent before) linked
      expect(fs.existsSync(path.join(t.tmp, '.gstack', 'backups', 'skills', 'test', 'ship', 'SKILL.md'))).toBe(true);
      expect(fs.lstatSync(path.join(t.skills, 'ship', 'checklist.md')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('a foreign DIRECTORY symlink (target has no SKILL.md) is foreign, not unclaimed: the user\'s link survives', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      const userdir = path.join(t.tmp, 'userdir');
      fs.mkdirSync(userdir);
      fs.writeFileSync(path.join(userdir, 'notes.md'), 'mine\n');
      fs.symlinkSync(userdir, path.join(t.skills, 'qa'));
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('FOREIGN=qa\n');
      expect(fs.lstatSync(path.join(t.skills, 'qa')).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(t.skills, 'qa'))).toBe(userdir);
      expect(fs.existsSync(path.join(userdir, 'SKILL.md'))).toBe(false);
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('when the backup cannot be written, the customized file is left untouched and the entry is reported, never overwritten', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      const custom = GENERATED('qa').replace('# qa', '# customized');
      fs.mkdirSync(path.join(t.skills, 'qa'));
      fs.writeFileSync(path.join(t.skills, 'qa', 'SKILL.md'), custom);
      fs.writeFileSync(path.join(t.tmp, 'not-a-dir'), 'x');
      const r = bash(['set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', HELPERS, `_SKILL_BACKUP_ROOT="${t.tmp}/not-a-dir/backups"`, extractFn('link_claude_skill_dirs'),
        `link_claude_skill_dirs "${t.payload}" "${t.skills}"`, 'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"'], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.lstatSync(path.join(t.skills, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(t.skills, 'qa', 'SKILL.md'), 'utf-8')).toBe(custom);
      expect(r.stderr).toContain('could not back up');
      expect(r.stdout).toContain('FOREIGN=qa\n');
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('Windows flip: a customized banner copy is moved to the backup root, not deleted; an alias-shaped copy (only name: differs) is just removed', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa'));
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.payload, 'ship'));
      fs.writeFileSync(path.join(t.payload, 'ship', 'SKILL.md'), GENERATED('ship'));
      const custom = GENERATED('gstack-qa').replace('# gstack-qa', '# customized on windows');
      fs.mkdirSync(path.join(t.skills, 'gstack-qa'));
      fs.writeFileSync(path.join(t.skills, 'gstack-qa', 'SKILL.md'), custom);
      fs.mkdirSync(path.join(t.skills, 'gstack-ship'));
      fs.writeFileSync(path.join(t.skills, 'gstack-ship', 'SKILL.md'), GENERATED('ship').replace('name: ship', 'name: gstack-ship'));
      const r = bash(['set -e', 'IS_WINDOWS=1', HELPERS, extractFn('cleanup_prefixed_claude_symlinks'),
        `cleanup_prefixed_claude_symlinks "${t.payload}" "${t.skills}"`], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(t.skills, 'gstack-qa'))).toBe(false);
      expect(fs.readFileSync(path.join(t.tmp, '.gstack', 'backups', 'skills', 'test', 'gstack-qa', 'SKILL.md'), 'utf-8')).toBe(custom);
      expect(fs.existsSync(path.join(t.skills, 'gstack-ship'))).toBe(false);
      expect(fs.existsSync(path.join(t.tmp, '.gstack', 'backups', 'skills', 'test', 'gstack-ship'))).toBe(false);
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });

  test('a legacy linked dir holding the user\'s OWN symlink is mixed: our links go, theirs stays, the dir stays', () => {
    const t = mkTree();
    try {
      fs.mkdirSync(path.join(t.payload, 'qa', 'sections'), { recursive: true });
      fs.writeFileSync(path.join(t.payload, 'qa', 'SKILL.md'), GENERATED('qa'));
      fs.mkdirSync(path.join(t.skills, 'gstack-qa'));
      fs.symlinkSync(path.join(t.payload, 'qa', 'SKILL.md'), path.join(t.skills, 'gstack-qa', 'SKILL.md'));
      fs.symlinkSync(path.join(t.payload, 'qa', 'sections'), path.join(t.skills, 'gstack-qa', 'sections'));
      fs.writeFileSync(path.join(t.tmp, 'my-notes.md'), 'mine\n');
      fs.symlinkSync(path.join(t.tmp, 'my-notes.md'), path.join(t.skills, 'gstack-qa', 'notes.md'));
      const r = bash(['set -e', 'IS_WINDOWS=0', HELPERS, extractFn('cleanup_prefixed_claude_symlinks'),
        `cleanup_prefixed_claude_symlinks "${t.payload}" "${t.skills}"`], t.tmp);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(t.skills, 'gstack-qa', 'SKILL.md'))).toBe(false);
      expect(fs.existsSync(path.join(t.skills, 'gstack-qa', 'sections'))).toBe(false);
      expect(fs.readlinkSync(path.join(t.skills, 'gstack-qa', 'notes.md'))).toBe(path.join(t.tmp, 'my-notes.md'));
    } finally {
      fs.rmSync(t.tmp, { recursive: true, force: true });
    }
  });
});
