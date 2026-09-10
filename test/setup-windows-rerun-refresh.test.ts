/**
 * Windows re-run refresh (#2444).
 *
 * On Windows, _link_or_copy installs REAL directory copies (no Developer
 * Mode symlinks). The skill-linking guards `[ -L "$target" ] || [ ! -e
 * "$target" ]` in link_codex_skill_dirs / link_factory_skill_dirs /
 * link_opencode_skill_dirs / create_agents_sidecar therefore skipped every
 * re-run: `./setup --host codex` reported "gstack ready" but never refreshed
 * an already-installed SKILL.md after `git pull`. The fix bypasses the guard
 * when IS_WINDOWS=1 — _link_or_copy rm -rf's the destination first, so the
 * copy refreshes in place.
 *
 * The behavior fixture drives the REAL link_codex_skill_dirs /
 * create_agents_sidecar functions (extracted from setup) against a fake
 * install tree; the static block pins the bypass at all five guard sites so
 * factory/opencode can't silently regress.
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
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

const WINDOWS_BYPASS = '[ "$IS_WINDOWS" -eq 1 ] || [ -L ';

describe('setup: Windows re-run refresh — static guard sites (#2444)', () => {
  test('no install guard is missing the IS_WINDOWS bypass', () => {
    // Every `[ -L ...] || [ ! -e ...]` refresh guard in setup must carry the
    // bypass — a bare guard is a Windows re-run no-op waiting to happen.
    const bareGuards = SETUP_SRC
      .split('\n')
      .filter((l) => /\[ -L "\$[A-Za-z_/${}.]+" \] \|\| \[ ! -e /.test(l) && !l.includes('IS_WINDOWS'));
    expect(bareGuards).toEqual([]);
    expect(SETUP_SRC.split(WINDOWS_BYPASS).length - 1).toBeGreaterThanOrEqual(5);
  });

  test.each([
    'link_codex_skill_dirs',
    'link_factory_skill_dirs',
    'link_opencode_skill_dirs',
    'link_cursor_skill_dirs',
    'create_agents_sidecar',
    'create_cursor_sidecar',
  ])('%s bypasses the symlink-or-missing guard on Windows', (fn) => {
    expect(extractFn(fn)).toContain(WINDOWS_BYPASS);
  });

  // #2142 ownership census: the Windows bypass rm -rf's real dirs, so every
  // skill-dir installer must gate the replacement on provable gstack
  // ownership, and every sidecar/runtime-root installer must refuse a
  // user-owned root. A bypass without its gate deletes user data.
  test.each([
    'link_codex_skill_dirs',
    'link_factory_skill_dirs',
    'link_opencode_skill_dirs',
    'link_cursor_skill_dirs',
  ])('%s gates the Windows real-dir replacement on _owned_for_windows_refresh', (fn) => {
    expect(extractFn(fn)).toContain('_owned_for_windows_refresh "$target"');
  });

  test.each([
    'create_agents_sidecar',
    'create_cursor_sidecar',
    'create_cursor_runtime_root',
  ])('%s refuses a user-owned root via _sidecar_root_user_owned', (fn) => {
    expect(extractFn(fn)).toContain('_sidecar_root_user_owned');
  });
});

describe('setup: Windows refresh ownership gate — behavior fixture (#2142)', () => {
  test("IS_WINDOWS=1: a user's own real dir on a gstack* name survives; a bannered install refreshes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-owned-'));
    try {
      const fake = path.join(tmp, 'gstack');
      const skills = path.join(tmp, 'skills');
      const banner = '<!-- AUTO-GENERATED from SKILL.md.tmpl - DO NOT EDIT DIRECTLY -->\n';
      // Generated tree ships two skills.
      for (const name of ['gstack-demo', 'gstack-notes']) {
        const d = path.join(fake, '.agents', 'skills', name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'SKILL.md'), `${banner}upstream-v2\n`);
      }
      fs.mkdirSync(skills, { recursive: true });
      // gstack-demo: a prior gstack install (bannered) — must refresh.
      fs.mkdirSync(path.join(skills, 'gstack-demo'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'gstack-demo', 'SKILL.md'), `${banner}installed-v1\n`);
      // gstack-notes: the USER'S own hand-written skill — must survive.
      fs.mkdirSync(path.join(skills, 'gstack-notes'), { recursive: true });
      fs.writeFileSync(path.join(skills, 'gstack-notes', 'SKILL.md'), '# my own notes\n');

      const r = runInstaller(
        '1',
        ['_owned_for_windows_refresh', 'link_codex_skill_dirs'],
        `link_codex_skill_dirs "${tmp}/gstack" "${skills}"`,
      );
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(skills, 'gstack-demo', 'SKILL.md'), 'utf-8')).toContain('upstream-v2');
      expect(fs.readFileSync(path.join(skills, 'gstack-notes', 'SKILL.md'), 'utf-8')).toBe('# my own notes\n');
      expect(r.stderr).toContain('left in place');
      expect(r.stderr).toContain('gstack-notes');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=1: create_agents_sidecar refuses a user-owned root and writes nothing into it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-owned-sidecar-'));
    try {
      const fake = path.join(tmp, 'gstack');
      fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fake, 'bin', 'tool.sh'), 'v1\n');
      // The user's own skill squats on .agents/skills/gstack.
      const root = path.join(fake, '.agents', 'skills', 'gstack');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'SKILL.md'), '# hand-written\n');

      const vars = `SOURCE_GSTACK_DIR="${fake}"`;
      const r = runInstaller(
        '1',
        ['_sidecar_root_user_owned', 'create_agents_sidecar'],
        `create_agents_sidecar "${fake}"`,
        vars,
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('left in place');
      expect(fs.existsSync(path.join(root, 'bin'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf-8')).toBe('# hand-written\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the extracted installer functions against a fake tree. */
function runInstaller(
  isWindows: '0' | '1',
  fns: string[],
  invocation: string,
  extraVars = '',
): RunResult {
  const script = [
    'set -e',
    `IS_WINDOWS=${isWindows}`,
    extraVars,
    extractFn('_link_or_copy'),
    // Ownership gates (#2142) — dependencies of every installer under test.
    extractFn('_owned_for_windows_refresh'),
    extractFn('_sidecar_root_user_owned'),
    ...fns.map(extractFn),
    invocation,
  ].join('\n');
  const r = runBashScript(script, { timeout: 15_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('setup: Windows re-run refresh — behavior fixture (#2444)', () => {
  test('IS_WINDOWS=1: link_codex_skill_dirs refreshes an already-installed skill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-'));
    try {
      const fake = path.join(tmp, 'gstack');
      const skills = path.join(tmp, 'skills');
      const demo = path.join(fake, '.agents', 'skills', 'gstack-demo');
      fs.mkdirSync(demo, { recursive: true });
      fs.mkdirSync(skills, { recursive: true });
      // Generated SKILL.md files always carry the banner — the #2142
      // ownership gate keys the Windows refresh on it.
      const banner = '<!-- AUTO-GENERATED from SKILL.md.tmpl - DO NOT EDIT DIRECTLY -->\n';
      fs.writeFileSync(path.join(demo, 'SKILL.md'), `${banner}v1-original\n`);

      // First run: installs the copy.
      let r = runInstaller('1', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
      expect(r.status).toBe(0);
      const installed = path.join(skills, 'gstack-demo', 'SKILL.md');
      expect(fs.readFileSync(installed, 'utf-8')).toBe(`${banner}v1-original\n`);
      expect(fs.lstatSync(path.join(skills, 'gstack-demo')).isSymbolicLink()).toBe(false);

      // Upstream ships a change (the git pull).
      fs.writeFileSync(path.join(demo, 'SKILL.md'), `${banner}v2-UPDATED\n`);

      // Second run: pre-#2444 this was a silent no-op on Windows.
      r = runInstaller('1', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(installed, 'utf-8')).toBe(`${banner}v2-UPDATED\n`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=1: create_agents_sidecar refreshes copied runtime assets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-sidecar-'));
    try {
      const fake = path.join(tmp, 'gstack');
      fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fake, 'bin', 'tool.sh'), 'v1\n');
      fs.writeFileSync(path.join(fake, 'ETHOS.md'), 'ethos-v1\n');

      const vars = `SOURCE_GSTACK_DIR="${fake}"`;
      let r = runInstaller('1', ['create_agents_sidecar'], `create_agents_sidecar "${fake}"`, vars);
      expect(r.status).toBe(0);
      const sidecarBin = path.join(fake, '.agents', 'skills', 'gstack', 'bin', 'tool.sh');
      const sidecarEthos = path.join(fake, '.agents', 'skills', 'gstack', 'ETHOS.md');
      expect(fs.readFileSync(sidecarBin, 'utf-8')).toBe('v1\n');
      expect(fs.readFileSync(sidecarEthos, 'utf-8')).toBe('ethos-v1\n');

      fs.writeFileSync(path.join(fake, 'bin', 'tool.sh'), 'v2\n');
      fs.writeFileSync(path.join(fake, 'ETHOS.md'), 'ethos-v2\n');

      r = runInstaller('1', ['create_agents_sidecar'], `create_agents_sidecar "${fake}"`, vars);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(sidecarBin, 'utf-8')).toBe('v2\n');
      expect(fs.readFileSync(sidecarEthos, 'utf-8')).toBe('ethos-v2\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=1: nested gitignored build output does NOT survive the runtime-asset copy (P5)', () => {
    // The exclusion list in _link_skill_runtime_assets filters direct
    // children only; cp -R swept NESTED node_modules/.build/dist too
    // (concrete: ios-qa/scripts/gen-accessors-tool/.build, 252MB). The
    // Windows branch prunes them post-copy; real asset files at every level
    // survive.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-prune-'));
    try {
      const src = path.join(tmp, 'skill-src');
      const dst = path.join(tmp, 'skill-dst');
      fs.mkdirSync(path.join(src, 'scripts', 'gen-tool', '.build'), { recursive: true });
      fs.mkdirSync(path.join(src, 'scripts', 'gen-tool', 'node_modules', 'dep'), { recursive: true });
      fs.mkdirSync(path.join(src, 'scripts', 'gen-tool', 'dist'), { recursive: true });
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(path.join(src, 'scripts', 'runner.sh'), 'echo run\n');
      fs.writeFileSync(path.join(src, 'scripts', 'gen-tool', 'main.swift'), 'source\n');
      fs.writeFileSync(path.join(src, 'scripts', 'gen-tool', '.build', 'blob.bin'), '#'.repeat(4096));
      fs.writeFileSync(path.join(src, 'scripts', 'gen-tool', 'node_modules', 'dep', 'index.js'), 'x\n');
      fs.writeFileSync(path.join(src, 'scripts', 'gen-tool', 'dist', 'compiled'), 'bin\n');

      const r = runInstaller(
        '1',
        ['_link_skill_runtime_assets'],
        `_link_skill_runtime_assets "${src}" "${dst}"`,
      );
      expect(r.status).toBe(0);
      // Real assets at both levels survive…
      expect(fs.readFileSync(path.join(dst, 'scripts', 'runner.sh'), 'utf-8')).toBe('echo run\n');
      expect(fs.readFileSync(path.join(dst, 'scripts', 'gen-tool', 'main.swift'), 'utf-8')).toBe('source\n');
      // …nested build output does not.
      expect(fs.existsSync(path.join(dst, 'scripts', 'gen-tool', '.build'))).toBe(false);
      expect(fs.existsSync(path.join(dst, 'scripts', 'gen-tool', 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(dst, 'scripts', 'gen-tool', 'dist'))).toBe(false);
      // The source tree is untouched — the prune runs on the COPY only.
      expect(fs.existsSync(path.join(src, 'scripts', 'gen-tool', '.build', 'blob.bin'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=0: the Unix symlink path never prunes through into the source', () => {
    // On Unix the asset is a SYMLINK into the working tree; pruning through
    // it would delete real build output from the repo. The prune is gated on
    // the Windows real-copy shape ([ -d ] && [ ! -L ]).
    // Not runnable ON Windows: this sub-case models the UNIX shape, but Git
    // Bash's `ln -snf` produces a real copy there (no Developer Mode on CI),
    // so the symlink assertion is false by platform, not by regression. The
    // Unix lanes (macOS dev boxes + Linux CI) own this case.
    if (process.platform === 'win32') return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-prune-unix-'));
    try {
      const src = path.join(tmp, 'skill-src');
      const dst = path.join(tmp, 'skill-dst');
      fs.mkdirSync(path.join(src, 'scripts', 'gen-tool', '.build'), { recursive: true });
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(path.join(src, 'scripts', 'gen-tool', '.build', 'blob.bin'), 'keep');

      const r = runInstaller(
        '0',
        ['_link_skill_runtime_assets'],
        `_link_skill_runtime_assets "${src}" "${dst}"`,
      );
      expect(r.status).toBe(0);
      expect(fs.lstatSync(path.join(dst, 'scripts')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(src, 'scripts', 'gen-tool', '.build', 'blob.bin'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('IS_WINDOWS=1: the gstack sidecar dir is still skipped by the skill loop', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-skip-'));
    try {
      const fake = path.join(tmp, 'gstack');
      const skills = path.join(tmp, 'skills');
      const sidecar = path.join(fake, '.agents', 'skills', 'gstack');
      fs.mkdirSync(sidecar, { recursive: true });
      fs.mkdirSync(skills, { recursive: true });
      fs.writeFileSync(path.join(sidecar, 'SKILL.md'), 'sidecar\n');

      const r = runInstaller('1', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(skills, 'gstack'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// On real Windows, `ln -snf` under Git Bash silently produces copies, so the
// Unix-mode symlink assertions are meaningless there — the same skip the
// _link_or_copy behavior matrix uses (test/setup-windows-fallback.test.ts).
describe.skipIf(process.platform === 'win32')(
  'setup: Unix path unchanged by the #2444 bypass',
  () => {
    test('IS_WINDOWS=0: installs a symlink and re-runs still refresh through it', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rerun-unix-'));
      try {
        const fake = path.join(tmp, 'gstack');
        const skills = path.join(tmp, 'skills');
        const demo = path.join(fake, '.agents', 'skills', 'gstack-demo');
        fs.mkdirSync(demo, { recursive: true });
        fs.mkdirSync(skills, { recursive: true });
        fs.writeFileSync(path.join(demo, 'SKILL.md'), 'v1-original\n');

        let r = runInstaller('0', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
        expect(r.status).toBe(0);
        const target = path.join(skills, 'gstack-demo');
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

        // A symlink serves updates without any re-run at all…
        fs.writeFileSync(path.join(demo, 'SKILL.md'), 'v2-UPDATED\n');
        expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8')).toBe('v2-UPDATED\n');

        // …and the re-run keeps it a symlink (guard still passes via -L).
        r = runInstaller('0', ['link_codex_skill_dirs'], `link_codex_skill_dirs "${fake}" "${skills}"`);
        expect(r.status).toBe(0);
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);
