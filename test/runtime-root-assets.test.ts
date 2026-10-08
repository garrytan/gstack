/**
 * Every file a generated skill reads through $GSTACK_ROOT exists in the
 * runtime root setup builds for that host (#1077 residue, fix wave C2).
 *
 * Env-var hosts reach gstack only through their runtime root
 * (~/.codex/skills/gstack, ~/.factory/skills/gstack, ...). The roots carried
 * bin/, lib/ and the compiled tools, but not the files the shared preamble and
 * several skills read on demand: the jargon list and question registry, the
 * AskUserQuestion split and CJK docs, the DX Hall of Fame, the test-value bar,
 * VERSION, design-html's vendored pretext.js and plan-design-review/SKILL.md.
 * Those reads failed silently on every non-Claude host.
 *
 * This test renders every host, builds each runtime root with setup's own
 * shell functions, then checks every $GSTACK_ROOT/<path> literal in that
 * host's render (prose and fences) against the staged root on disk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_CONFIG_MAP } from '../hosts';
import { runGeneration } from '../scripts/gen-skill-docs';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-root-assets-'));
const renderDir = path.join(tmp, 'render');
const src = path.join(tmp, 'gstack');

// Host -> the setup function that builds its global runtime root. Kiro builds
// its root inline in the Kiro arm and is covered by a source assertion below.
const ROOT_BUILDERS: Record<string, string> = {
  codex: 'create_codex_runtime_root',
  factory: 'create_factory_runtime_root',
  opencode: 'create_opencode_runtime_root',
  cursor: 'create_cursor_runtime_root',
  copilot: 'create_copilot_runtime_root',
};

// Deferred, with the reason recorded in TODOS.md: /ship's measure loop runs
// scripts/ship-measure.ts, which imports gstack's test helpers and eval
// harness; a runtime root would need the whole development tree.
const DEFERRED = new Set(['scripts/ship-measure.ts']);

// Compiled outputs: the stub source carries placeholder binaries, so a fresh
// checkout without a build still exercises the links to them.
const BUILT = ['browse/dist/browse', 'browse/dist/find-browse', 'design/dist/design', 'make-pdf/dist/pdf'];
// Compiled into bin/, which every root links whole: checked through that link.
const BUILT_IN_BIN = new Set(['bin/gstack-global-discover']);

function extractFunction(name: string): string {
  const start = SETUP_SRC.indexOf(`\n${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start + 1, end + 2);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/** Every $GSTACK_ROOT/<path> literal in a host's rendered skills. */
function referencedPaths(host: string): Set<string> {
  const out = new Set<string>();
  for (const file of walk(path.join(renderDir, HOST_CONFIG_MAP[host]!.hostSubdir, 'skills'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\$\{?GSTACK_ROOT\}?\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g)) {
      out.add(m[1]!.replace(/\.+$/, ''));
    }
  }
  return out;
}

// A source tree that links every tracked top-level entry of this checkout,
// with stub compiled binaries and each host's render in its usual place.
function makeSource(): void {
  fs.mkdirSync(src, { recursive: true });
  const built = new Set(BUILT.map(rel => rel.split('/')[0]!));
  for (const name of fs.readdirSync(ROOT)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (!built.has(name)) { fs.symlinkSync(path.join(ROOT, name), path.join(src, name)); continue; }
    fs.mkdirSync(path.join(src, name));
    for (const child of fs.readdirSync(path.join(ROOT, name))) {
      if (child !== 'dist') fs.symlinkSync(path.join(ROOT, name, child), path.join(src, name, child));
    }
  }
  for (const rel of BUILT) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  for (const host of Object.keys(ROOT_BUILDERS)) {
    const sub = HOST_CONFIG_MAP[host]!.hostSubdir;
    fs.symlinkSync(path.join(renderDir, sub), path.join(src, sub));
  }
}

function buildRoot(host: string): { root: string; stderr: string; status: number | null } {
  const root = path.join(tmp, 'home', host, 'skills', 'gstack');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const functions = ['_link_or_copy', '_link_runtime_dists', '_copy_runtime_skill_refs', '_copy_skill_md',
    '_sidecar_root_user_owned', '_gstack_generated_header', ROOT_BUILDERS[host]!]
    .filter(name => SETUP_SRC.includes(`\n${name}() {`)).map(extractFunction).join('\n');
  const r = spawnSync('bash', ['-c', `set -e\nIS_WINDOWS=0\n${functions}\n${ROOT_BUILDERS[host]} "${src}" "${root}"`],
    { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(tmp, 'home') } });
  return { root, stderr: r.stderr, status: r.status };
}

beforeAll(async () => {
  const result = await runGeneration({ host: 'all', outputRoot: renderDir });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.filter(d => d.kind === 'error').map(d => d.message).join('\n'));
  makeSource();
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('runtime roots carry every $GSTACK_ROOT file their skills read', () => {
  test('the extractor finds the known read-on-demand files in the Codex render', () => {
    const paths = referencedPaths('codex');
    for (const rel of ['scripts/jargon-list.json', 'scripts/question-registry.ts', 'docs/askuserquestion-split.md', 'plan-devex-review/dx-hall-of-fame.md']) {
      expect(paths.has(rel), rel).toBe(true);
    }
  });

  for (const host of Object.keys(ROOT_BUILDERS)) {
    test(`${host}: every referenced path exists in the staged runtime root`, () => {
      const { root, stderr, status } = buildRoot(host);
      expect(stderr).toBe('');
      expect(status).toBe(0);
      const missing = [...referencedPaths(host)]
        .filter(rel => !DEFERRED.has(rel) && !BUILT_IN_BIN.has(rel) && !fs.existsSync(path.join(root, rel))).sort();
      expect(missing).toEqual([]);
      // Each one is the same kind of entry as in the source: a file stays a file.
      const wrongKind = [...referencedPaths(host)].filter(rel => fs.existsSync(path.join(root, rel)) && fs.existsSync(path.join(ROOT, rel))
        && fs.statSync(path.join(root, rel)).isFile() !== fs.statSync(path.join(ROOT, rel)).isFile());
      expect(wrongKind).toEqual([]);
      expect(fs.realpathSync(path.join(root, 'bin'))).toBe(fs.realpathSync(path.join(ROOT, 'bin')));
    });
  }

  test('a runtime root never gains a whole skill directory beside the rendered copies', () => {
    const { root } = buildRoot('codex');
    for (const dir of ['plan-design-review', 'office-hours']) {
      expect(fs.readdirSync(path.join(root, dir))).toEqual(['SKILL.md']);
      expect(fs.lstatSync(path.join(root, dir, 'SKILL.md')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(root, dir, 'SKILL.md'), 'utf8')).toContain('$GSTACK_ROOT');
    }
    expect(fs.existsSync(path.join(root, 'design-html', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'plan-devex-review', 'SKILL.md'))).toBe(false);
  });

  test('the Kiro arm uses the same shared asset helpers as every other root', () => {
    const arm = SETUP_SRC.slice(SETUP_SRC.indexOf('# 6. Install for Kiro CLI'), SETUP_SRC.indexOf('# 6b. Install for Factory Droid'));
    expect(arm.includes('_link_runtime_dists "$SOURCE_GSTACK_DIR" "$KIRO_GSTACK"')).toBe(true);
    expect(arm.includes('_copy_runtime_skill_refs "$KIRO_DIR" "$KIRO_GSTACK"')).toBe(true);
  });
});
