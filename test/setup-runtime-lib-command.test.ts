import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
// OpenCode's Windows-copy cell installs bin, browse, and design assets in
// addition to lib and scripts. Keep the test-level deadline above the 30s
// setup subprocess guard so asset growth cannot race the outer Bun timeout.
const RUNTIME_ROOT_TEST_TIMEOUT_MS = 60000;

// gstack-learnings-log and gstack-question-preference cover both runtime dependency
// classes: bin scripts import shared modules via `$SCRIPT_DIR/../lib`, while
// preference/profile commands load classifiers and registry data from
// `$ROOT_DIR/scripts`. Running them end-to-end from each installed root proves
// bin, lib, and scripts travel together.
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
  const endAnchor = '_link_or_copy "$SOURCE_GSTACK_DIR/supabase/config.sh" "$KIRO_GSTACK/supabase/config.sh"\n  fi';
  const start = SETUP_SRC.indexOf(startAnchor);
  const end = SETUP_SRC.indexOf(endAnchor, start);
  if (start < 0 || end < 0) throw new Error('Could not locate the Kiro install block in setup');
  return SETUP_SRC.slice(start, end + endAnchor.length);
}

interface CommandResult {
  buildStatus: number | null;
  buildStderr: string;
  runStatus: number | null;
  runStderr: string;
  learningsWritten: boolean;
  libIsSymlink: boolean | null;
  scriptsIsSymlink: boolean | null;
  preferenceStatus: number | null;
  preferenceStdout: string;
  preferenceStderr: string;
  deriveStatus: number | null;
  deriveStdout: string;
  deriveStderr: string;
  vibeStatus: number | null;
  vibeStdout: string;
  vibeStderr: string;
  brainCacheStatus: number | null;
  brainCacheStdout: string;
  brainCacheStderr: string;
  supabaseConfigPresent: boolean;
}

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

    const { script, rootDir } = buildScript(sandbox);
    const build = spawnSync(
      'bash',
      ['-c', `IS_WINDOWS=${isWindows}\n${extractFunction('_link_or_copy')}\n${script}`],
      { encoding: 'utf-8', timeout: 30000 },
    );

    const libLst = fs.lstatSync(path.join(rootDir, 'lib'), { throwIfNoEntry: false });
    const scriptsLst = fs.lstatSync(path.join(rootDir, 'scripts'), { throwIfNoEntry: false });
    const run = spawnSync('bash', [path.join(rootDir, 'bin', 'gstack-learnings-log'), PAYLOAD], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
    });
    const preference = spawnSync(
      'bash',
      [path.join(rootDir, 'bin', 'gstack-question-preference'), '--check', 'runtime-root-probe', '--summary-stdin'],
      {
        cwd: project,
        encoding: 'utf-8',
        input: 'ordinary two-way question',
        timeout: 30000,
        env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
      },
    );
    const derive = spawnSync('bash', [path.join(rootDir, 'bin', 'gstack-developer-profile'), '--derive'], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
    });
    const vibe = spawnSync('bash', [path.join(rootDir, 'bin', 'gstack-developer-profile'), '--vibe'], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
    });
    const brainCache = spawnSync(
      process.execPath,
      [path.join(rootDir, 'bin', 'gstack-brain-cache'), 'meta', '--project', 'runtime-root-probe'],
      {
        cwd: project,
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
      },
    );

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
      scriptsIsSymlink: scriptsLst ? scriptsLst.isSymbolicLink() : null,
      preferenceStatus: preference.status,
      preferenceStdout: preference.stdout,
      preferenceStderr: preference.stderr,
      deriveStatus: derive.status,
      deriveStdout: derive.stdout,
      deriveStderr: derive.stderr,
      vibeStatus: vibe.status,
      vibeStdout: vibe.stdout,
      vibeStderr: vibe.stderr,
      brainCacheStatus: brainCache.status,
      brainCacheStdout: brainCache.stdout,
      brainCacheStderr: brainCache.stderr,
      // Distinct defect (#2215): telemetry-class bin scripts source
      // $GSTACK_DIR/supabase/config.sh to resolve GSTACK_SUPABASE_URL. The
      // [ -f ... ] guard means a missing file degrades SILENTLY, so only a
      // presence check on the installed root catches it.
      supabaseConfigPresent: fs.existsSync(path.join(rootDir, 'supabase', 'config.sh')),
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
      `SOURCE_GSTACK_DIR="${ROOT}"`,
      extractFunction('create_agents_sidecar'),
      `mkdir -p "${sandbox}/repo"`,
      `create_agents_sidecar "${sandbox}/repo"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'repo', '.agents', 'skills', 'gstack'),
  }),
  codex: (sandbox) => ({
    script: [
      extractFunction('create_codex_runtime_root'),
      `create_codex_runtime_root "${ROOT}" "${sandbox}/home/.codex/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.codex', 'skills', 'gstack'),
  }),
  factory: (sandbox) => ({
    script: [
      extractFunction('create_factory_runtime_root'),
      `create_factory_runtime_root "${ROOT}" "${sandbox}/home/.factory/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.factory', 'skills', 'gstack'),
  }),
  opencode: (sandbox) => ({
    script: [
      extractFunction('create_opencode_runtime_root'),
      `create_opencode_runtime_root "${ROOT}" "${sandbox}/home/.opencode/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.opencode', 'skills', 'gstack'),
  }),
  cursor: (sandbox) => ({
    script: [
      extractFunction('_sidecar_root_user_owned'),
      extractFunction('create_cursor_runtime_root'),
      `create_cursor_runtime_root "${ROOT}" "${sandbox}/home/.cursor/skills/gstack"`,
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.cursor', 'skills', 'gstack'),
  }),
  kiro: (sandbox) => ({
    script: [
      `HOME="${sandbox}/home"`,
      `SOURCE_GSTACK_DIR="${ROOT}"`,
      `KIRO_SKILLS="$HOME/.kiro/skills"`,
      `mkdir -p "$KIRO_SKILLS"`,
      extractKiroBlock(),
    ].join('\n'),
    rootDir: path.join(sandbox, 'home', '.kiro', 'skills', 'gstack'),
  }),
};

// The IS_WINDOWS=0 cells rely on Unix `ln -snf` semantics; on a real Windows
// runner without Developer Mode that silently degrades to a copy — the exact
// bug _link_or_copy works around — so only those cells skip there. The
// IS_WINDOWS=1 cells run on every platform and are force-included in
// test:windows so windows-latest exercises the real copy-install behavior.
describe('setup: runtime commands resolve lib and scripts from every host root', () => {
  function assertRuntimeCommands(r: CommandResult): void {
    expect(r.runStderr).not.toContain('lib/jsonl-store.ts');
    expect(r.runStatus).toBe(0);
    expect(r.learningsWritten).toBe(true);
    expect(r.preferenceStatus).toBe(0);
    expect(r.preferenceStdout).toContain('ASK_NORMALLY');
    expect(r.preferenceStderr).not.toContain('one-way-doors.ts');
    expect(r.deriveStatus).toBe(0);
    expect(r.deriveStdout).toContain('DERIVE: ok');
    expect(r.deriveStderr).not.toContain('registry or signals file missing');
    expect(r.vibeStatus).toBe(0);
    expect(r.vibeStdout).toContain('Builder-Coach');
    expect(r.vibeStderr).not.toContain('archetypes.ts');
    expect(r.brainCacheStatus).toBe(0);
    expect(r.brainCacheStdout).toContain('"schema_version"');
    expect(r.brainCacheStderr).not.toContain('brain-cache-spec');
  }

  for (const [host, buildScript] of Object.entries(HOST_ROOTS)) {
    test.skipIf(process.platform === 'win32')(
      `${host} root (symlink install) runs commands that import ../lib and ../scripts`,
      () => {
        const r = buildRootAndRunCommand('0', buildScript);
        expect(r.buildStatus).toBe(0);
        expect(r.libIsSymlink).toBe(true);
        expect(r.scriptsIsSymlink).toBe(true);
        assertRuntimeCommands(r);
        expect(r.supabaseConfigPresent).toBe(true);
      },
      RUNTIME_ROOT_TEST_TIMEOUT_MS,
    );

    test(
      `${host} root (Windows copy install) runs commands that import ../lib and ../scripts`,
      () => {
        const r = buildRootAndRunCommand('1', buildScript);
        expect(r.buildStatus).toBe(0);
        expect(r.libIsSymlink).toBe(false);
        expect(r.scriptsIsSymlink).toBe(false);
        assertRuntimeCommands(r);
        expect(r.supabaseConfigPresent).toBe(true);
      },
      RUNTIME_ROOT_TEST_TIMEOUT_MS,
    );
  }

  for (const isWindows of ['0', '1'] as const) {
    const installMode = isWindows === '0' ? 'symlink' : 'Windows copy';
    test.skipIf(process.platform === 'win32' && isWindows === '0')(
      `cursor sidecar (${installMode} install) includes runtime scripts`,
      () => {
        const r = buildRootAndRunCommand(isWindows, (sandbox) => ({
          script: [
            extractFunction('_sidecar_root_user_owned'),
            extractFunction('create_cursor_sidecar'),
            `mkdir -p "${sandbox}/repo"`,
            `_link_or_copy "${ROOT}/bin" "${sandbox}/repo/bin"`,
            `_link_or_copy "${ROOT}/lib" "${sandbox}/repo/lib"`,
            `_link_or_copy "${ROOT}/scripts" "${sandbox}/repo/scripts"`,
            `create_cursor_sidecar "${sandbox}/repo"`,
          ].join('\n'),
          rootDir: path.join(sandbox, 'repo', '.cursor', 'skills', 'gstack'),
        }));
        expect(r.buildStatus).toBe(0);
        expect(r.scriptsIsSymlink).toBe(isWindows === '0');
        assertRuntimeCommands(r);
      },
      RUNTIME_ROOT_TEST_TIMEOUT_MS,
    );
  }

  // Negative control: a root with bin/ but no lib/ (the pre-fix layout) must
  // fail on the ../lib import. Proves the positive cells detect the regression.
  test('a root missing lib/ beside bin/ fails the ../lib import (pre-fix layout)', () => {
    const r = buildRootAndRunCommand('1', (sandbox) => ({
      script: [
        `mkdir -p "${sandbox}/broken"`,
        `_link_or_copy "${ROOT}/bin" "${sandbox}/broken/bin"`,
      ].join('\n'),
      rootDir: path.join(sandbox, 'broken'),
    }));
    expect(r.buildStatus).toBe(0);
    expect(r.runStatus).not.toBe(0);
    expect(r.runStderr).toContain('lib/jsonl-store.ts');
    expect(r.learningsWritten).toBe(false);
  });

  test('a root missing scripts/ beside bin/ fails runtime imports (pre-fix layout)', () => {
    const r = buildRootAndRunCommand('1', (sandbox) => ({
      script: [
        `mkdir -p "${sandbox}/broken"`,
        `_link_or_copy "${ROOT}/bin" "${sandbox}/broken/bin"`,
        `_link_or_copy "${ROOT}/lib" "${sandbox}/broken/lib"`,
      ].join('\n'),
      rootDir: path.join(sandbox, 'broken'),
    }));
    expect(r.buildStatus).toBe(0);
    expect(r.runStatus).toBe(0);
    expect(r.learningsWritten).toBe(true);
    expect(r.preferenceStatus).not.toBe(0);
    expect(r.preferenceStderr).toContain('one-way-doors.ts');
    expect(r.deriveStatus).not.toBe(0);
    expect(r.deriveStderr).toContain('registry or signals file missing');
    expect(r.vibeStatus).not.toBe(0);
    expect(r.vibeStderr).toContain('archetypes.ts');
    expect(r.brainCacheStatus).not.toBe(0);
    expect(r.brainCacheStderr).toContain('brain-cache-spec');
  });
});
