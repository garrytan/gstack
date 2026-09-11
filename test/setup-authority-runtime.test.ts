import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const roots: string[] = [];
const digest = (file: string) => new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function extractFunction(name: string): string {
  const start = SETUP.indexOf(`${name}() {`);
  const end = SETUP.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function_missing:${name}`);
  return SETUP.slice(start, end + 2);
}

function fixture(): { source: string; destination: string; sentinel: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-authority-setup-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(path.join(source, 'dist', 'authority'), { recursive: true });
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  for (const name of ['gstack-anchor', 'gstack-project-identity']) {
    fs.copyFileSync(path.join(ROOT, 'bin', name), path.join(source, 'bin', name));
  }
  fs.mkdirSync(path.join(destination, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'dist', 'authority', 'manifest.json'), '{"schema":"ecpe.authority-bundles.v1"}\n');
  fs.writeFileSync(path.join(source, 'dist', 'authority', 'gstack-project-identity.mjs'), 'process.stdout.write("ok\\n")\n');
  fs.writeFileSync(path.join(source, '.ecpe-installed-runtime.json'), '{"schema":"ecpe.gstack-runtime.v1"}\n');
  fs.writeFileSync(sentinel, 'do-not-overwrite\n');
  fs.symlinkSync(sentinel, path.join(destination, '.ecpe-installed-runtime.json'));
  fs.symlinkSync(path.join(source, 'dist', 'authority'), path.join(destination, 'dist', 'authority'));
  fs.symlinkSync(path.join(source, 'bin'), path.join(destination, 'bin'));
  return { source, destination, sentinel };
}

describe('setup authority runtime installation', () => {
  test('a sidecar refresh does not replace bin before authority staging succeeds', () => {
    const f = fixture();
    const repo = path.join(path.dirname(f.source), 'repo');
    const runtime = path.join(repo, '.agents/skills/gstack');
    for (const asset of ['scripts', 'lib', 'hosts']) {
      fs.cpSync(path.join(ROOT, asset), path.join(f.source, asset), { recursive: true });
    }
    const render = spawnSync(process.execPath, ['run', 'gen:skill-docs', '--host', 'codex', '--out-dir', f.source], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    expect(render.status, render.stderr).toBe(0);
    const script = [
      'set -e', 'IS_WINDOWS=1', 'SOURCE_GSTACK_DIR="$1"',
      extractFunction('_link_or_copy'), extractFunction('_sidecar_root_user_owned'),
      extractFunction('_install_authority_runtime'), extractFunction('create_agents_sidecar'),
    ].join('\n');
    const first = spawnSync('bash', ['-c', `${script}\ncreate_agents_sidecar "$2"`, 'fixture', f.source, repo], { encoding: 'utf8', timeout: 30_000 });
    expect(first.status, first.stderr).toBe(0);
    fs.writeFileSync(path.join(runtime, 'SKILL.md'), '<!-- AUTO-GENERATED from SKILL.md.tmpl -->\n');
    const original = fs.readFileSync(path.join(runtime, 'bin/gstack-project-identity'), 'utf8');
    fs.appendFileSync(path.join(f.source, 'bin/gstack-project-identity'), '\n# new wrapper\n');
    const refresh = spawnSync('bash', ['-c', `${script}\ncp() { case "${'${@: -1}'}" in */new-bin) return 73 ;; esac; command cp "$@"; }\ncreate_agents_sidecar "$2"`,
      'fixture', f.source, repo], { encoding: 'utf8', timeout: 30_000 });
    expect(refresh.status).not.toBe(0);
    expect(fs.readFileSync(path.join(runtime, 'bin/gstack-project-identity'), 'utf8')).toBe(original);
  });

  test('rolls back a copied payload that fails final leaf validation', () => {
    const f = fixture();
    const result = spawnSync('bash', ['-c', [
      'set -e',
      'cp() { command cp "$@" || return; local destination="${@: -1}"; case "$destination" in */new-manifest) rm -f "$destination"; ln -s "$3" "$destination" ;; esac; }',
      extractFunction('_install_authority_runtime'),
      '_install_authority_runtime "$1" "$2"',
    ].join('\n'), 'fixture', f.source, f.destination], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).not.toBe(0);
    expect(fs.lstatSync(path.join(f.destination, 'dist/authority')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(f.destination, '.ecpe-installed-runtime.json'))).toBe(f.sentinel);
    expect(fs.readlinkSync(path.join(f.destination, 'bin'))).toBe(path.join(f.source, 'bin'));
  });

  for (const symlink of [false, true]) {
    test(`manifest replacement failure restores the old ${symlink ? 'symlink' : 'file'}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-rename-failure-')); roots.push(root);
      const output = path.join(root, 'runtime.json');
      const sentinel = path.join(root, 'sentinel');
      const previous = '{"schema":"ecpe.gstack-runtime.v1","tools":{}}\n';
      fs.writeFileSync(sentinel, previous);
      if (symlink) fs.symlinkSync(sentinel, output);
      else fs.copyFileSync(sentinel, output);
      const result = spawnSync(process.execPath, ['--preload', path.join(import.meta.dir, 'helpers/fail-runtime-manifest-rename.ts'),
        path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts'), '--output', output], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_TEST_FAIL_SECOND_RENAME: '1' },
      });
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(output), result.stderr).toBe(true);
      expect(fs.readFileSync(output, 'utf8')).toBe(previous);
      expect(fs.lstatSync(output).isSymbolicLink()).toBe(symlink);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe(previous);
      expect(fs.readdirSync(root).sort()).toEqual(['runtime.json', 'sentinel']);
    });
  }

  test('manifest replacement fallback removes its backup only after success', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-rename-success-')); roots.push(root);
    const output = path.join(root, 'runtime.json');
    fs.writeFileSync(output, '{"schema":"ecpe.gstack-runtime.v1","tools":{}}\n');
    const result = spawnSync(process.execPath, ['--preload', path.join(import.meta.dir, 'helpers/fail-runtime-manifest-rename.ts'),
      path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts'), '--output', output], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).schema).toBe('ecpe.gstack-runtime.v1');
    expect(fs.readdirSync(root)).toEqual(['runtime.json']);
  });

  for (const [command, failures] of [['cp', 3], ['mv', 6]] as const) {
    for (let failure = 1; failure <= failures; failure++) {
      test(`preserves the previous runtime after ${command} failure ${failure}`, () => {
        const f = fixture();
        const result = spawnSync('bash', ['-c', [
          'set -e',
          'count=0',
          `${command}() { count=$((count + 1)); if [ "$count" -eq "${failure}" ]; then return 73; fi; command ${command} "$@"; }`,
          extractFunction('_install_authority_runtime'),
          '_install_authority_runtime "$1" "$2"',
        ].join('\n'), 'fixture', f.source, f.destination], { encoding: 'utf8', timeout: 30_000 });
        expect(result.status, result.stderr).not.toBe(0);
        expect(fs.lstatSync(path.join(f.destination, 'dist', 'authority')).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(path.join(f.destination, 'dist', 'authority'))).toBe(path.join(f.source, 'dist', 'authority'));
        expect(fs.readlinkSync(path.join(f.destination, '.ecpe-installed-runtime.json'))).toBe(f.sentinel);
        expect(fs.readlinkSync(path.join(f.destination, 'bin'))).toBe(path.join(f.source, 'bin'));
        expect(fs.readFileSync(f.sentinel, 'utf8')).toBe('do-not-overwrite\n');
        expect(fs.readdirSync(f.destination).sort()).toEqual(['.ecpe-installed-runtime.json', 'bin', 'dist']);
        expect(fs.readdirSync(path.join(f.destination, 'dist'))).toEqual(['authority']);
      });
    }
  }

  test('installed wrappers use their copied payload without a source manifest', () => {
    const f = fixture();
    const bundle = path.join(f.source, 'dist/authority/gstack-project-identity.mjs');
    const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(bundle)).digest('hex');
    fs.writeFileSync(path.join(f.source, 'dist/authority/manifest.json'), JSON.stringify({ commands: {
      'gstack-project-identity': { sha256: hash },
    } }));
    const writer = spawnSync(process.execPath, [path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts'),
      '--output', path.join(f.source, '.ecpe-installed-runtime.json')], { encoding: 'utf8', timeout: 30_000 });
    expect(writer.status, writer.stderr).toBe(0);
    const install = spawnSync('bash', ['-c', `${extractFunction('_install_authority_runtime')}\n_install_authority_runtime "$1" "$2"`,
      'fixture', f.source, f.destination], { encoding: 'utf8', timeout: 30_000 });
    expect(install.status, install.stderr).toBe(0);
    fs.unlinkSync(path.join(f.source, '.ecpe-installed-runtime.json'));
    const identity = spawnSync('bash', [path.join(f.destination, 'bin/gstack-project-identity')], { encoding: 'utf8', timeout: 30_000 });
    expect(identity.status, identity.stderr).toBe(0);
    expect(identity.stdout).toBe('ok\n');
    expect(fs.lstatSync(path.join(f.destination, 'bin')).isSymbolicLink()).toBe(false);
    fs.appendFileSync(path.join(f.destination, 'dist/authority/gstack-project-identity.mjs'), '// changed');
    const changed = spawnSync('bash', [path.join(f.destination, 'bin/gstack-project-identity')], { encoding: 'utf8', timeout: 30_000 });
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain('authority_bundle_mismatch');
  });

  test('every executable host runtime root installs the closed authority payload', () => {
    for (const name of [
      'create_agents_sidecar',
      'create_codex_runtime_root',
      'create_factory_runtime_root',
      'create_opencode_runtime_root',
      'create_cursor_runtime_root',
      'create_cursor_sidecar',
    ]) {
      expect(extractFunction(name), name).toContain('_install_authority_runtime');
    }
    const kiro = SETUP.slice(SETUP.indexOf('# 6. Install for Kiro CLI'), SETUP.indexOf('# 6b. Install for Factory Droid'));
    expect(kiro).toContain('_install_authority_runtime "$SOURCE_GSTACK_DIR" "$KIRO_GSTACK"');
    expect(SETUP).toContain('write-installed-runtime-manifest.ts');
    expect(SETUP).toContain('BUN_RUNTIME_PATH="$(command -v bun)"');
    expect(SETUP).toContain('--bun-path "$BUN_RUNTIME_PATH"');
    for (const [host, next] of [['slate', 'openclaw'], ['openclaw', 'hermes'], ['hermes', 'gbrain'], ['gbrain', '*']] as const) {
      const start = SETUP.indexOf(`  ${host})`);
      const end = SETUP.indexOf(`\n  ${next})`, start + 3);
      const arm = SETUP.slice(start, end);
      expect(start, host).toBeGreaterThan(-1);
      expect(arm, host).toContain('exit 0');
      expect(arm, host).not.toContain('_install_authority_runtime');
    }
  });

  for (const isWindows of ['0', '1'] as const) {
    test(`authority payload is a real-file copy with IS_WINDOWS=${isWindows}`, () => {
      const f = fixture();
      const result = spawnSync('bash', ['-c', [
        'set -e',
        `IS_WINDOWS=${isWindows}`,
        extractFunction('_install_authority_runtime'),
        `_install_authority_runtime "${f.source}" "${f.destination}"`,
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      for (const relative of [
        '.ecpe-installed-runtime.json',
        'dist/authority/manifest.json',
        'dist/authority/gstack-project-identity.mjs',
      ]) {
        const installed = path.join(f.destination, relative);
        expect(fs.lstatSync(installed).isFile(), relative).toBe(true);
        expect(fs.lstatSync(installed).isSymbolicLink(), relative).toBe(false);
      }
      expect(fs.readFileSync(f.sentinel, 'utf8')).toBe('do-not-overwrite\n');
    });
  }

  test('runtime manifest writer records the exact executable identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-runtime-manifest-'));
    roots.push(root);
    const sourceSection = path.join(ROOT, 'review/sections/review-army.md');
    const codexSection = path.join(ROOT, '.agents/skills/gstack-ship/sections/pr-body.md');
    const output = path.join(root, '.ecpe-installed-runtime.json');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'write-installed-runtime-manifest.ts'), '--output', output, '--artifact-root', ROOT], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(manifest.schema).toBe('ecpe.gstack-runtime.v1');
    expect(manifest.tools.bun.realpath).toBe(fs.realpathSync(process.execPath));
    expect(manifest.tools.bun.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.tools.bun.owner_uid).toBe(fs.statSync(fs.realpathSync(process.execPath)).uid);
    expect(manifest.artifacts['review/sections/review-army.md']).toMatchObject({
      sha256: digest(sourceSection), size: fs.statSync(sourceSection).size,
    });
    expect(manifest.artifacts['.agents/skills/gstack-ship/sections/pr-body.md']).toMatchObject({
      sha256: digest(codexSection), size: fs.statSync(codexSection).size,
    });
    expect(fs.lstatSync(output).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(root, '.local'))).toBe(false);
  });

  test('the Claude source runtime passes the installed anchor contract', () => {
    const build = spawnSync(process.execPath, ['run', 'build:authority'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(build.status, build.stderr).toBe(0);
    const manifest = spawnSync(process.execPath, ['run', 'scripts/write-installed-runtime-manifest.ts', '--output', path.join(ROOT, '.ecpe-installed-runtime.json'), '--artifact-root', ROOT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(manifest.status, manifest.stderr).toBe(0);
    const identity = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-project-identity')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(identity.status, identity.stderr).toBe(0);
    expect(JSON.parse(identity.stdout).repo_id).toBe('github.com/garrytan/gstack');
  });
});
