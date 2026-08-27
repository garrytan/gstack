import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

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
  skillMdIsSymlink: boolean | null;
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
    const skillMdLst = fs.lstatSync(path.join(rootDir, 'SKILL.md'), { throwIfNoEntry: false });
    const run = spawnSync('bash', [path.join(rootDir, 'bin', 'gstack-learnings-log'), PAYLOAD], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, GSTACK_HOME: path.join(home, '.gstack') },
    });

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
      skillMdIsSymlink: skillMdLst ? skillMdLst.isSymbolicLink() : null,
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
// bug _link_or_copy works around — so skip there, matching the behavior-matrix
// precedent in setup-windows-fallback.test.ts. The IS_WINDOWS=1 cells exercise
// the Windows copy branch itself, which is plain `cp -R` and portable.
describe.skipIf(process.platform === 'win32')('setup: bin commands resolve sibling lib from every host root', () => {
  test('Codex stage path is recorded before creation for crash recovery', () => {
    const source = extractFunction('create_codex_runtime_root');
    const assign = source.indexOf('staged_gstack="$codex_parent/.gstack-stage.$lock_owner"');
    const record = source.indexOf('> "$lock_dir/stage"', assign);
    const create = source.indexOf('mkdir "$staged_gstack"', record);
    expect(assign).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(assign);
    expect(create).toBeGreaterThan(record);
    expect(source).not.toContain('mktemp -d "$codex_parent/.gstack-stage.XXXXXX"');
  });
  for (const [host, buildScript] of Object.entries(HOST_ROOTS)) {
    test(`${host} root (symlink install): gstack-learnings-log imports ../lib and writes the learning`, () => {
      const r = buildRootAndRunCommand('0', buildScript);
      expect(r.buildStatus).toBe(0);
      expect(r.libIsSymlink).toBe(true);
      if (host === 'codex') {
        // Codex discovers leaf skills through directory symlinks, but the root
        // router lives in a real runtime directory. Its SKILL.md must therefore
        // be a real file rather than a file-level symlink.
        expect(r.skillMdIsSymlink).toBe(false);
      }
      expect(r.runStderr).not.toContain('lib/jsonl-store.ts');
      expect(r.runStatus).toBe(0);
      expect(r.learningsWritten).toBe(true);
      expect(r.supabaseConfigPresent).toBe(true);
    });

    test(`${host} root (Windows copy install): gstack-learnings-log imports ../lib and writes the learning`, () => {
      const r = buildRootAndRunCommand('1', buildScript);
      expect(r.buildStatus).toBe(0);
      // Windows branch copies: lib must be a real directory, not a symlink.
      expect(r.libIsSymlink).toBe(false);
      expect(r.runStderr).not.toContain('lib/jsonl-store.ts');
      expect(r.runStatus).toBe(0);
      expect(r.learningsWritten).toBe(true);
      expect(r.supabaseConfigPresent).toBe(true);
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
      ].join('\n'),
      rootDir: path.join(sandbox, 'broken'),
    }));
    expect(r.buildStatus).toBe(0);
    expect(r.runStatus).not.toBe(0);
    expect(r.runStderr).toContain('lib/jsonl-store.ts');
    expect(r.learningsWritten).toBe(false);
  });

  test('Codex runtime restores the previous root when the final staged rename fails', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-rollback-'));
    try {
      const liveRoot = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
      fs.mkdirSync(liveRoot, { recursive: true });
      fs.writeFileSync(path.join(liveRoot, 'previous-install-marker'), 'keep me\n');

      const script = [
        'IS_WINDOWS=0',
        extractFunction('_link_or_copy'),
        extractFunction('create_codex_runtime_root'),
        '_test_mv_calls=0',
        'mv() {',
        '  _test_mv_calls=$((_test_mv_calls + 1))',
        '  if [ "$_test_mv_calls" -eq 2 ]; then return 1; fi',
        '  command mv "$@"',
        '}',
        `create_codex_runtime_root "${ROOT}" "${liveRoot}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 30000,
      });

      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(path.join(liveRoot, 'previous-install-marker'), 'utf-8')).toBe('keep me\n');
      expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.startsWith('.gstack-rollback.'))).toBe(false);
      expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.startsWith('.gstack-stage.'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('concurrent Codex runtime refreshes serialize without nested or orphaned roots', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-concurrent-'));
    try {
      const liveRoot = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
      fs.mkdirSync(liveRoot, { recursive: true });
      fs.writeFileSync(path.join(liveRoot, 'previous-install-marker'), 'replace me\n');
      const script = [
        'set -e',
        'IS_WINDOWS=0',
        extractFunction('_link_or_copy'),
        extractFunction('create_codex_runtime_root'),
        `create_codex_runtime_root "${ROOT}" "${liveRoot}" &`,
        'first=$!',
        `create_codex_runtime_root "${ROOT}" "${liveRoot}" &`,
        'second=$!',
        'wait "$first"',
        'wait "$second"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 30000,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(liveRoot, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(liveRoot, 'gstack'))).toBe(false);
      expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.startsWith('.gstack-stage.'))).toBe(false);
      expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.startsWith('.gstack-rollback.'))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(liveRoot), '.gstack-install.lock'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('Codex runtime reclaims abandoned empty and malformed install locks after a grace period', () => {
    for (const [label, pidContents] of [['empty', null], ['malformed', 'not-a-pid\n']] as const) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `gstack-runtime-${label}-lock-`));
      try {
        const liveRoot = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
        const lockDir = path.join(path.dirname(liveRoot), '.gstack-install.lock');
        fs.mkdirSync(lockDir, { recursive: true });
        if (pidContents !== null) fs.writeFileSync(path.join(lockDir, 'pid'), pidContents);

        const script = [
          'set -e',
          'IS_WINDOWS=0',
          extractFunction('_link_or_copy'),
          extractFunction('create_codex_runtime_root'),
          `create_codex_runtime_root "${ROOT}" "${liveRoot}"`,
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf-8',
          timeout: 30000,
        });

        expect(result.status).toBe(0);
        expect(fs.existsSync(path.join(liveRoot, 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(lockDir)).toBe(false);
        expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.includes('.gstack-install.lock.stale.'))).toBe(false);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  test('Codex runtime reclaims an install lock whose recorded owner has exited', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-dead-lock-'));
    try {
      const liveRoot = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
      const lockDir = path.join(path.dirname(liveRoot), '.gstack-install.lock');
      const script = [
        'set -e',
        'IS_WINDOWS=0',
        extractFunction('_link_or_copy'),
        extractFunction('create_codex_runtime_root'),
        `mkdir -p "${lockDir}"`,
        'sleep 30 &',
        'dead_owner=$!',
        `printf '%s\\n' "$dead_owner" > "${path.join(lockDir, 'pid')}"`,
        'kill "$dead_owner"',
        'wait "$dead_owner" 2>/dev/null || true',
        `create_codex_runtime_root "${ROOT}" "${liveRoot}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 30000,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(liveRoot, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.includes('.gstack-install.lock.stale.'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('Codex runtime cleans a rollback when final rename succeeds but reports failure', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-post-rename-'));
    try {
      const liveRoot = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
      fs.mkdirSync(liveRoot, { recursive: true });
      fs.writeFileSync(path.join(liveRoot, 'previous-install-marker'), 'old\n');
      const script = [
        'IS_WINDOWS=0',
        extractFunction('_link_or_copy'),
        extractFunction('create_codex_runtime_root'),
        '_test_mv_calls=0',
        'mv() {',
        '  _test_mv_calls=$((_test_mv_calls + 1))',
        '  if [ "$_test_mv_calls" -eq 2 ]; then command mv "$@"; return 1; fi',
        '  command mv "$@"',
        '}',
        `create_codex_runtime_root "${ROOT}" "${liveRoot}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30000 });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(liveRoot, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(liveRoot, 'previous-install-marker'))).toBe(false);
      expect(fs.readdirSync(path.dirname(liveRoot)).some((name) => name.startsWith('.gstack-rollback.'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('Codex runtime removes stale stage metadata and restores stale rollback exactly', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-stale-artifacts-'));
    try {
      const liveRoot = path.join(sandbox, 'home', '.codex', 'skills', 'gstack');
      const parent = path.dirname(liveRoot);
      const lockDir = path.join(parent, '.gstack-install.lock');
      const staleStage = path.join(parent, '.gstack-stage.abandoned');
      const staleRollback = path.join(parent, '.gstack-rollback.abandoned');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.mkdirSync(staleStage);
      fs.mkdirSync(staleRollback);
      fs.writeFileSync(path.join(staleStage, 'stale-stage-marker'), 'remove\n');
      fs.writeFileSync(path.join(staleRollback, 'previous-install-marker'), 'restore\n');
      fs.writeFileSync(path.join(lockDir, 'pid'), '99999999\n');
      fs.writeFileSync(path.join(lockDir, 'stage'), `${staleStage}\n`);
      fs.writeFileSync(path.join(lockDir, 'rollback'), `${staleRollback}\n`);

      const script = [
        'IS_WINDOWS=0',
        extractFunction('_link_or_copy'),
        extractFunction('create_codex_runtime_root'),
        '_test_mv_calls=0',
        'mv() {',
        '  _test_mv_calls=$((_test_mv_calls + 1))',
        '  if [ "$_test_mv_calls" -eq 4 ]; then return 1; fi',
        '  command mv "$@"',
        '}',
        `create_codex_runtime_root "${ROOT}" "${liveRoot}"`,
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30000 });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(staleStage)).toBe(false);
      expect(fs.readFileSync(path.join(liveRoot, 'previous-install-marker'), 'utf8')).toBe('restore\n');
      expect(fs.existsSync(lockDir)).toBe(false);
      expect(fs.readdirSync(parent).some((name) => name.includes('.gstack-install.lock.stale.'))).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
