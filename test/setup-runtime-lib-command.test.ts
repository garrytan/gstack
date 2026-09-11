import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
let runtimeSource: string;

// gstack-learnings-log is the command from the original bug report: bin scripts
// import shared modules via `$SCRIPT_DIR/../lib`, so a runtime root that
// exposes bin/ without lib/ fails with "Cannot find module .../lib/jsonl-store.ts".
// Running it end-to-end from each installed root proves bin and lib travel together.
const PAYLOAD = JSON.stringify({
  skill: 'review',
  type: 'pattern',
  key: 'runtime-lib-e2e',
  insight: 'bin commands resolve sibling lib modules after setup',
  confidence: 8,
  source: 'observed',
});

// Slice a named shell function out of setup by its anchors so the tests are
// resilient to line-number drift (same idiom as setup-windows-fallback.test.ts).
function extractFunction(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

// The Kiro install is an inline block, not a function. Slice from the runtime
// root assignment through the last runtime-asset link so the extracted code is
// a complete statement list.
function extractKiroBlock(): string {
  const startAnchor = 'KIRO_GSTACK="$KIRO_SKILLS/gstack"';
  const endAnchor = '_install_authority_runtime "$SOURCE_GSTACK_DIR" "$KIRO_GSTACK"';
  const start = SETUP_SRC.indexOf(startAnchor);
  const end = SETUP_SRC.indexOf(endAnchor, start);
  if (start < 0 || end < 0) throw new Error('Could not locate the Kiro install block in setup');
  return SETUP_SRC.slice(start, SETUP_SRC.indexOf('\n', end));
}

interface CommandResult {
  buildStatus: number | null;
  buildStderr: string;
  runStatus: number | null;
  runStderr: string;
  learningsWritten: boolean;
  libIsSymlink: boolean | null;
  supabaseConfigPresent: boolean;
  authorityManifestIsFile: boolean;
  authorityManifestIsSymlink: boolean;
  authorityBundleIsFile: boolean;
  authorityBundleIsSymlink: boolean;
  anchoredIdentityStatus: number | null;
  anchoredIdentityStderr: string;
}

beforeAll(() => {
  runtimeSource = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-lib-source-'));
  const build = spawnSync(process.execPath, ['run', 'build:authority'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  expect(build.status, build.stderr).toBe(0);
  for (const asset of ['bin', 'lib', 'scripts', 'hosts', 'dist/authority', 'supabase']) {
    fs.cpSync(path.join(ROOT, asset), path.join(runtimeSource, asset), { recursive: true });
  }
  for (const host of ['codex', 'factory', 'opencode', 'cursor']) {
    const render = spawnSync(process.execPath, ['run', 'gen:skill-docs', '--host', host, '--out-dir', runtimeSource], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    expect(render.status, render.stderr).toBe(0);
  }
  const manifest = spawnSync(process.execPath, ['run', 'scripts/write-installed-runtime-manifest.ts', '--output', path.join(runtimeSource, '.ecpe-installed-runtime.json')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(manifest.status, manifest.stderr).toBe(0);
}, 120_000);
afterAll(() => { if (runtimeSource) fs.rmSync(runtimeSource, { recursive: true, force: true }); });

// Build one host runtime root inside a sandbox using the real setup shell code
// (IS_WINDOWS toggles _link_or_copy between symlink and copy), then execute
// gstack-learnings-log from the installed root and check the learning landed.
function buildRootAndRunCommand(
  isWindows: '0' | '1',
  buildScript: (sandbox: string) => { script: string; rootDir: string },
): CommandResult {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-lib-'));
  try {
    const home = path.join(sandbox, 'home');
    const project = path.join(sandbox, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.name', 'Fixture'],
      ['config', 'user.email', 'fixture@example.invalid'],
    ]) {
      const git = spawnSync('/usr/bin/git', args, { cwd: project, encoding: 'utf8', timeout: 30_000 });
      if (git.status !== 0) throw new Error(git.stderr);
    }
    fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
    for (const args of [['add', '.'], ['commit', '-qm', 'fixture'], ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']]) {
      const git = spawnSync('/usr/bin/git', args, { cwd: project, encoding: 'utf8', timeout: 30_000 });
      if (git.status !== 0) throw new Error(git.stderr);
    }

    const { script, rootDir } = buildScript(sandbox);
    const build = spawnSync(
      'bash',
      ['-c', `IS_WINDOWS=${isWindows}\n${extractFunction('_link_or_copy')}\n${extractFunction('_install_authority_runtime')}\n${script}`],
      { encoding: 'utf-8', timeout: 30000 },
    );

    const libLst = fs.lstatSync(path.join(rootDir, 'lib'), { throwIfNoEntry: false });
    const run = spawnSync('bash', [path.join(rootDir, 'bin', 'gstack-learnings-log'), PAYLOAD], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
    });
    const anchoredIdentity = spawnSync('bash', [path.join(rootDir, 'bin', 'gstack-project-identity')], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home },
    });
    const authorityManifest = fs.lstatSync(path.join(rootDir, 'dist', 'authority', 'manifest.json'), { throwIfNoEntry: false });
    const authorityBundle = fs.lstatSync(path.join(rootDir, 'dist', 'authority', 'gstack-project-identity.mjs'), { throwIfNoEntry: false });

    const projectsDir = path.join(home, '.gstack', 'projects');
    const learningsWritten = fs.existsSync(projectsDir)
      && fs.readdirSync(projectsDir).some((slug) => {
        const file = path.join(projectsDir, slug, 'learnings.jsonl');
        return fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes('runtime-lib-e2e');
      });

    return {
      buildStatus: build.status,
      buildStderr: build.stderr,
      runStatus: run.status,
      runStderr: run.stderr,
      learningsWritten,
      libIsSymlink: libLst ? libLst.isSymbolicLink() : null,
      // Distinct defect (#2215): telemetry-class bin scripts source
      // $GSTACK_DIR/supabase/config.sh to resolve GSTACK_SUPABASE_URL. The
      // [ -f ... ] guard means a missing file degrades SILENTLY, so only a
      // presence check on the installed root catches it.
      supabaseConfigPresent: fs.existsSync(path.join(rootDir, 'supabase', 'config.sh')),
      authorityManifestIsFile: authorityManifest?.isFile() ?? false,
      authorityManifestIsSymlink: authorityManifest?.isSymbolicLink() ?? false,
      authorityBundleIsFile: authorityBundle?.isFile() ?? false,
      authorityBundleIsSymlink: authorityBundle?.isSymbolicLink() ?? false,
      anchoredIdentityStatus: anchoredIdentity.status,
      anchoredIdentityStderr: anchoredIdentity.stderr,
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// One builder per host root the lib fix touches. Each returns the shell that
// setup itself runs plus where the installed runtime root lands.
const HOST_ROOTS: Record<string, (sandbox: string) => { script: string; rootDir: string }> = {
  'agents sidecar': (sandbox) => ({
    script: [
      `SOURCE_GSTACK_DIR="${runtimeSource}"`,
      extractFunction('create_agents_sidecar'),
      `mkdir -p "${sandbox}/repo"`,
      `create_agents_sidecar "${sandbox}/repo"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'repo', '.agents', 'skills', 'gstack'),
  }),
  codex: (sandbox) => ({
    script: [
      extractFunction('create_codex_runtime_root'),
      `create_codex_runtime_root "${runtimeSource}" "${sandbox}/home/.codex/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.codex', 'skills', 'gstack'),
  }),
  factory: (sandbox) => ({
    script: [
      extractFunction('create_factory_runtime_root'),
      `create_factory_runtime_root "${runtimeSource}" "${sandbox}/home/.factory/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.factory', 'skills', 'gstack'),
  }),
  opencode: (sandbox) => ({
    script: [
      extractFunction('create_opencode_runtime_root'),
      `create_opencode_runtime_root "${runtimeSource}" "${sandbox}/home/.opencode/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.opencode', 'skills', 'gstack'),
  }),
  kiro: (sandbox) => ({
    script: [
      `HOME="${sandbox}/home"`,
      `SOURCE_GSTACK_DIR="${runtimeSource}"`,
      `KIRO_SKILLS="$HOME/.kiro/skills"`,
      `mkdir -p "$KIRO_SKILLS"`,
      extractKiroBlock(),
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.kiro', 'skills', 'gstack'),
  }),
  cursor: (sandbox) => ({
    script: [
      extractFunction('_sidecar_root_user_owned'),
      extractFunction('create_cursor_runtime_root'),
      `create_cursor_runtime_root "${runtimeSource}" "${sandbox}/home/.cursor/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.cursor', 'skills', 'gstack'),
  }),
  'cursor sidecar': (sandbox) => ({
    script: [
      extractFunction('_sidecar_root_user_owned'),
      extractFunction('create_cursor_sidecar'),
      `mkdir -p "${sandbox}/repo"`,
      `_link_or_copy "${runtimeSource}/lib" "${sandbox}/repo/lib"`,
      `_link_or_copy "${runtimeSource}/scripts" "${sandbox}/repo/scripts"`,
      `_link_or_copy "${runtimeSource}/hosts" "${sandbox}/repo/hosts"`,
      `_link_or_copy "${runtimeSource}/.cursor" "${sandbox}/repo/.cursor"`,
      `mkdir -p "${sandbox}/repo/supabase"`,
      `_link_or_copy "${runtimeSource}/supabase/config.sh" "${sandbox}/repo/supabase/config.sh"`,
      `_install_authority_runtime "${runtimeSource}" "${sandbox}/repo"`,
      `create_cursor_sidecar "${sandbox}/repo"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'repo', '.cursor', 'skills', 'gstack'),
  }),
};

// The IS_WINDOWS=0 cells rely on Unix `ln -snf` semantics; on a real Windows
// runner without Developer Mode that silently degrades to a copy — the exact
// bug _link_or_copy works around — so skip there, matching the behavior-matrix
// precedent in setup-windows-fallback.test.ts. The IS_WINDOWS=1 cells exercise
// the Windows copy branch itself, which is plain `cp -R` and portable.
describe.skipIf(process.platform === 'win32')('setup: bin commands resolve sibling lib from every host root', () => {
  for (const [host, buildScript] of Object.entries(HOST_ROOTS)) {
    test(`${host} root (symlink install): gstack-learnings-log imports ../lib and writes the learning`, () => {
      const r = buildRootAndRunCommand('0', buildScript);
      expect(r.buildStatus).toBe(0);
      expect(r.libIsSymlink).toBe(true);
      expect(r.runStderr).not.toContain('lib/jsonl-store.ts');
      expect(r.runStatus).toBe(0);
      expect(r.learningsWritten).toBe(true);
      // The repo-local Cursor sidecar has never copied this unrelated
      // telemetry asset; this matrix adds it only to cover authority roots.
      expect(r.supabaseConfigPresent).toBe(host !== 'cursor sidecar');
      expect(r.authorityManifestIsFile).toBe(true);
      expect(r.authorityManifestIsSymlink).toBe(false);
      expect(r.authorityBundleIsFile).toBe(true);
      expect(r.authorityBundleIsSymlink).toBe(false);
      expect(r.anchoredIdentityStatus, r.anchoredIdentityStderr).toBe(0);
    });

    test(`${host} root (Windows copy install): gstack-learnings-log imports ../lib and writes the learning`, () => {
      const r = buildRootAndRunCommand('1', buildScript);
      expect(r.buildStatus).toBe(0);
      // Windows branch copies: lib must be a real directory, not a symlink.
      expect(r.libIsSymlink).toBe(false);
      expect(r.runStderr).not.toContain('lib/jsonl-store.ts');
      expect(r.runStatus).toBe(0);
      expect(r.learningsWritten).toBe(true);
      expect(r.supabaseConfigPresent).toBe(host !== 'cursor sidecar');
      expect(r.authorityManifestIsFile).toBe(true);
      expect(r.authorityManifestIsSymlink).toBe(false);
      expect(r.authorityBundleIsFile).toBe(true);
      expect(r.authorityBundleIsSymlink).toBe(false);
      expect(r.anchoredIdentityStatus, r.anchoredIdentityStderr).toBe(0);
    });
  }

  // Negative control: a root with bin/ but no lib/ (the pre-fix layout) must
  // fail on the ../lib import. Proves the positive cells actually detect the
  // regression rather than passing vacuously.
  test('a root missing lib/ beside bin/ fails the ../lib import (pre-fix layout)', () => {
    const r = buildRootAndRunCommand('0', (sandbox) => ({
      script: [
        `mkdir -p "${sandbox}/broken"`,
        `_link_or_copy "${ROOT}/bin" "${sandbox}/broken/bin"`,
        `_install_authority_runtime "${ROOT}" "${sandbox}/broken"`,
      ].join('\n'),
      rootDir: path.join(sandbox, 'broken'),
    }));
    expect(r.buildStatus).toBe(0);
    expect(r.runStatus).not.toBe(0);
    expect(r.runStderr).toContain('lib/jsonl-store.ts');
    expect(r.learningsWritten).toBe(false);
  });
});
