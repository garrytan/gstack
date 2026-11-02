/**
 * #2120: on Windows on ARM64, x64-emulated Git Bash intermittently deadlocks
 * in MSYS2's fork() emulation, and ./setup hung in the per-skill loops that
 * read each SKILL.md name with a grep | sed | tr pipeline plus a basename
 * (about four process starts per skill, ~55 skills a run). The deadlock
 * itself needs that host; these cases pin the cause they can see anywhere:
 * the loops start none of those processes per skill. Every grep, sed, tr and
 * basename the code under test starts goes through a logging shim on PATH.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBashScript } from './helpers/bash-script';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const HELPER = path.join(ROOT, 'bin/gstack-skill-name.sh');
const SHIMMED = ['grep', 'sed', 'tr', 'basename'];
const SKILLS = ['qa', 'review', 'ship', 'office-hours', 'investigate', 'land-and-deploy', 'retro', 'cso'];

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`\n${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function not found: ${name}`);
  return SETUP_SRC.slice(start + 1, end + 2);
}

/** A temp tree, a PATH whose grep/sed/tr/basename log each start to calls.log, and a reader for that log. */
function sandbox() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fork-free-')));
  const shim = path.join(tmp, 'shim');
  const log = path.join(tmp, 'calls.log');
  fs.mkdirSync(shim);
  for (const name of SHIMMED) {
    const real = spawnSync('bash', ['-c', `type -P ${name}`], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    fs.writeFileSync(path.join(shim, name), `#!/bin/sh\necho ${name} >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  }
  return {
    tmp, env: { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}`, HOME: tmp, GSTACK_USER_RENDER_DIR: path.join(tmp, 'no-render') },
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    reset: () => fs.rmSync(log, { force: true }),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

const skillMd = (name: string, eol = '\n') => ['---', `name: ${name}`, 'description: fixture', '---', `# ${name}`, ''].join(eol);

/** A payload of SKILLS (qa in CRLF, office-hours named "oh"), then "zz-nameless" with no name: line after them. */
function payload(dir: string) {
  for (const name of SKILLS) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), skillMd(name === 'office-hours' ? 'oh' : name, name === 'qa' ? '\r\n' : '\n'));
  }
  fs.mkdirSync(path.join(dir, 'zz-nameless'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'zz-nameless', 'SKILL.md'), '---\ndescription: no name\n---\n# nameless\n');
}

describe.skipIf(process.platform === 'win32')('setup name reads start no process per skill (#2120)', () => {
  // Value: protects=the helper returns what the old grep -m1 | sed | tr pipeline returned, and never a stale name; fails_when=it keeps the
  //   previous value, reads a non-column-0 name, keeps a CR or space, or returns non-zero; why_new=the helper is new; seam=none
  test('gstack_skill_md_name matches the old pipeline on odd inputs, resets between files and always returns 0', () => {
    const s = sandbox();
    try {
      const cases: Record<string, string> = {
        plain: '---\nname: qa\n---\n', crlf: '---\r\nname: qa\r\n---\r\n', spaced: 'name:   my skill \t\n', noeol: 'name: last',
        indented: '  name: no\nname: yes\n', nameless: '---\ndescription: x\n---\n', empty: '', later: '# t\nbody\nname: deep\nname: second\n',
      };
      const files = Object.entries(cases).map(([k, v]) => { const f = path.join(s.tmp, k); fs.writeFileSync(f, v); return f; });
      files.push(path.join(s.tmp, 'missing'));
      const old = (f: string) => spawnSync('bash', ['-c', "grep -m1 '^name:' \"$1\" 2>/dev/null | sed 's/^name:[[:space:]]*//' | tr -d '[:space:]'", '_', f], { encoding: 'utf8', timeout: 10_000 }).stdout;
      const script = [`set -euo pipefail; . "${HELPER}"; GSTACK_SKILL_NAME=stale`,
        ...files.map(f => `gstack_skill_md_name "${f}"; printf '%s\n' "[$GSTACK_SKILL_NAME]"`)].join('\n');
      const r = runBashScript(script, { timeout: 10_000, env: s.env });
      expect(r.status, r.stderr ?? '').toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(files.map(f => `[${old(f)}]`));
      expect(s.calls()).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  // Value: protects=no caller re-adds a fork per skill by wrapping the helper in $( ), and the helper itself stays fork-free;
  //   fails_when=a call site uses $(gstack_skill_md_name ...) or the helper body gains $(, a pipe or a backquote; why_new=the shims cannot see a subshell fork; seam=none
  test('the helper starts no subshell and no caller wraps it in $( )', () => {
    const body = fs.readFileSync(HELPER, 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    expect(body).not.toMatch(/\$\(|`|(^|[^|])\|([^|]|$)/m);
    for (const rel of ['setup', 'bin/gstack-patch-names', 'bin/gstack-uninstall']) {
      expect(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel).not.toMatch(/\$\(\s*gstack_skill_md_name/);
    }
  });

  // Value: protects=gstack-patch-names reads every name without a per-skill grep|sed|tr|basename (the first loop #2120 hung in);
  //   fails_when=the loop goes back to a process pipeline per SKILL.md; why_new=no case counted process starts; seam=PATH shims
  test('gstack-patch-names: no process per skill when nothing needs a rename; a rename starts only its own sed', () => {
    const s = sandbox();
    try {
      const dir = path.join(s.tmp, 'gstack');
      payload(dir);
      const off = spawnSync('bash', [path.join(ROOT, 'bin/gstack-patch-names'), dir, '0'], { encoding: 'utf8', env: s.env, timeout: 30_000 });
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).toBe('');
      expect(s.calls()).toEqual([]);

      const on = spawnSync('bash', [path.join(ROOT, 'bin/gstack-patch-names'), dir, '1'], { encoding: 'utf8', env: s.env, timeout: 30_000 });
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toContain(`patched name: field in ${SKILLS.length} skills`);
      for (const name of SKILLS) expect(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8')).toContain(`name: gstack-${name === 'office-hours' ? 'oh' : name}`);
      expect(fs.readFileSync(path.join(dir, 'zz-nameless', 'SKILL.md'), 'utf8')).not.toContain('name:');
      expect(s.calls()).toEqual(Array(SKILLS.length).fill('sed'));
    } finally {
      s.cleanup();
    }
  });

  // Value: protects=link_claude_skill_dirs and both cleanup loops run with no per-skill grep, sed, tr or basename, and a nameless SKILL.md links
  //   under its directory name, never the previous skill's name (#2120); fails_when=a loop goes back to a pipeline or basename, or the name leaks;
  //   why_new=link tests checked links, not process starts; seam=PATH shims
  test('link_claude_skill_dirs and the two cleanup loops: no per-skill grep, sed, tr or basename; names come from frontmatter', () => {
    const s = sandbox();
    try {
      const pl = path.join(s.tmp, 'skills', 'gstack');
      payload(pl);
      const script = [
        'set -e', 'IS_WINDOWS=0', 'SKILL_PREFIX=0', '_FOREIGN_SKIPPED_ENTRIES=()', '_BACKED_UP_SKILL_MDS=()',
        '_link_skill_runtime_assets() { :; }', '_print_windows_copy_note_once() { :; }',
        ...['_link_or_copy', '_gstack_link_target_abs', '_gstack_target_is_ours', '_claude_entry_is_ours', '_write_owned_marker',
          '_gstack_generated_header', '_claude_entry_owned_strongly', '_backup_skill_md', '_cleanup_weak_dir', '_gstack_dir_only_links',
          '_cleanup_linked_dir'].map(extractFn),
        `. "${HELPER}"`,
        ...['link_claude_skill_dirs', 'cleanup_old_claude_symlinks', 'cleanup_prefixed_claude_symlinks'].map(extractFn),
        `cleanup_old_claude_symlinks "${pl}" "${path.dirname(pl)}"`,
        `cleanup_prefixed_claude_symlinks "${pl}" "${path.dirname(pl)}"`,
        `link_claude_skill_dirs "${pl}" "${path.dirname(pl)}"`,
      ].join('\n');
      const r = runBashScript(script, { timeout: 30_000, env: s.env });
      expect(r.stderr ?? '').not.toContain('command not found');
      expect(r.status, r.stderr ?? '').toBe(0);
      expect(r.stdout).toContain('linked skills:');
      for (const name of [...SKILLS.map(n => n === 'office-hours' ? 'oh' : n), 'zz-nameless']) {
        expect(fs.existsSync(path.join(s.tmp, 'skills', name, 'SKILL.md')), name).toBe(true);
      }
      expect(fs.existsSync(path.join(s.tmp, 'skills', 'office-hours'))).toBe(false);
      expect(s.calls()).toEqual([]);
    } finally {
      s.cleanup();
    }
  });
});
