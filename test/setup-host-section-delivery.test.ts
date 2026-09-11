import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECTION_BATCHES } from '../lib/section-delivery';
import { releaseRuntimeBinding, resolveRegisteredRuntimeBinding } from '../lib/validator-runtime';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const roots: string[] = [];
let rendered: string;

function shellFunction(name: string): string {
  const start = SETUP.indexOf(`${name}() {`);
  const end = SETUP.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function_missing:${name}`);
  return SETUP.slice(start, end + 2);
}

function kiroBlock(): string {
  const start = SETUP.indexOf('KIRO_GSTACK="$KIRO_SKILLS/gstack"');
  const end = SETUP.indexOf('\n\n  # Rewrite root SKILL.md paths for Kiro', start);
  if (start < 0 || end < 0) throw new Error('kiro_block_missing');
  return SETUP.slice(start, end);
}

beforeAll(() => {
  rendered = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-host-sections-source-'));
  const build = spawnSync(process.execPath, ['run', 'build:authority'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  expect(build.status, build.stderr).toBe(0);
  for (const host of ['codex', 'factory', 'opencode', 'cursor']) {
    const render = spawnSync(process.execPath, ['run', 'gen:skill-docs', '--host', host,
      '--model', 'claude', '--out-dir', rendered], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(render.status, render.stderr).toBe(0);
  }
  for (const relative of ['bin', 'lib', 'scripts', 'hosts', 'dist/authority']) {
    fs.cpSync(path.join(ROOT, relative), path.join(rendered, relative), { recursive: true });
  }
  const manifest = spawnSync(process.execPath, [path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts'),
    '--output', path.join(rendered, '.ecpe-installed-runtime.json'), '--artifact-root', ROOT], {
    encoding: 'utf8', timeout: 30_000,
  });
  expect(manifest.status, manifest.stderr).toBe(0);
}, 120_000);

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
afterAll(() => { if (rendered) fs.rmSync(rendered, { recursive: true, force: true }); });

const HOSTS = [
  { host: 'codex', name: 'codex', tree: '.agents', fn: 'create_codex_runtime_root' },
  { host: 'codex', name: 'agents sidecar', tree: '.agents', fn: 'create_agents_sidecar' },
  { host: 'factory', name: 'factory', tree: '.factory', fn: 'create_factory_runtime_root' },
  { host: 'opencode', name: 'opencode', tree: '.opencode', fn: 'create_opencode_runtime_root' },
  { host: 'cursor', name: 'cursor', tree: '.cursor', fn: 'create_cursor_runtime_root' },
  { host: 'cursor', name: 'cursor sidecar', tree: '.cursor', fn: 'create_cursor_sidecar' },
  { host: 'kiro', name: 'kiro', tree: '.agents', fn: '' },
] as const;
type Host = typeof HOSTS[number];

function provision(host: Host, isWindows: '0' | '1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-host-sections-')); roots.push(root);
  const source = path.join(root, 'source');
  const runtime = host.name.endsWith('sidecar')
    ? path.join(source, host.tree, 'skills/gstack') : path.join(root, 'skills/gstack');
  fs.cpSync(rendered, source, { recursive: true });
  const install = installRuntime(host, isWindows, { source, runtime });
  expect(install.status, install.stderr).toBe(0);
  return { root, source, runtime };
}

function installRuntime(host: Host, isWindows: '0' | '1', { source, runtime }: { source: string; runtime: string }) {
  const script = [
    'set -e', `IS_WINDOWS=${isWindows}`, `SOURCE_GSTACK_DIR=${quote(source)}`,
    `BUN_RUNTIME_PATH=${quote(process.execPath)}`, `BUN_CMD=${quote(process.execPath)}`,
    shellFunction('bun_cmd'), shellFunction('_link_or_copy'), shellFunction('_sidecar_root_user_owned'),
    shellFunction('_install_authority_runtime'),
    ...(host.fn ? [shellFunction(host.fn), `${host.fn} ${quote(source)} ${quote(runtime)}`]
      : [`KIRO_SKILLS=${quote(path.dirname(runtime))}`, `AGENTS_DIR=${quote(path.join(source, '.agents/skills'))}`, kiroBlock()]),
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
}

function registerPython(f: { root: string; runtime: string }) {
  const interpreter = path.join(f.root, 'registered-python');
  fs.writeFileSync(interpreter, '#!/bin/sh\nexec /usr/bin/python3 "$@"\n', { mode: 0o700 });
  const info = fs.statSync(interpreter);
  const version = spawnSync(interpreter, ['-S', '-c', 'import platform;print(platform.python_version())'], { encoding: 'utf8', timeout: 10_000 });
  expect(version.status, version.stderr).toBe(0);
  const purelib = path.join(f.root, 'registered-purelib'), platlib = path.join(f.root, 'registered-platlib');
  fs.mkdirSync(purelib, { mode: 0o700 }); fs.mkdirSync(platlib, { mode: 0o700 });
  const runtimes = Object.fromEntries(['harness_test_python', 'cdo_preview_python'].map(runtime_id => [runtime_id, {
    runtime_id, realpath: fs.realpathSync(interpreter), owner_uid: info.uid, mode: info.mode & 0o777,
    sha256: digest(fs.readFileSync(interpreter)), version: version.stdout.trim(), purelib, platlib, packages: {},
  }]));
  const manifestPath = path.join(f.runtime, '.ecpe-installed-runtime.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.execution_environment = { runtimes };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
  return { manifestPath, runtimes };
}

function deliver(f: { root: string; runtime: string }, skill: string, stage: string) {
  const state = path.join(f.root, `state-${skill}-${stage}`);
  fs.mkdirSync(path.join(state, 'ecpe/inflight'), { recursive: true });
  fs.chmodSync(state, 0o700);
  fs.mkdirSync(path.join(state, 'projects/repo-1'), { recursive: true });
  fs.writeFileSync(path.join(state, 'ecpe/inflight/run-sections.json'), JSON.stringify({
    schema: 'ecpe.lifecycle-inflight.v1', run_id: 'run-sections', slug: 'repo-1', skill,
    repository_root: fs.realpathSync(f.root), contract: { work_kind: 'review', finish_line: 'review_receipt' },
  }));
  return spawnSync('bash', [path.join(f.runtime, 'bin/gstack-section-delivery'), 'resolve',
    '--skill', skill, '--stage', stage, '--json'], {
    cwd: f.root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: state },
  });
}

function refresh(f: { source: string; runtime: string }, before = '') {
  return spawnSync('bash', ['-c', [
    'set -e', `BUN_CMD=${quote(process.execPath)}`, `BUN_RUNTIME_PATH=${quote(process.execPath)}`,
    shellFunction('_install_authority_runtime'), before,
    `_install_authority_runtime ${quote(f.source)} ${quote(f.runtime)} factory`,
  ].join('\n')], { encoding: 'utf8', timeout: 30_000 });
}

describe.skipIf(process.platform === 'win32')('every host installs its attested authority sections', () => {
  for (const tree of ['.factory', '.opencode', '.cursor']) {
    test(`${tree}: authority fragments do not create discoverable skills or replace inline content`, () => {
      const skills = path.join(rendered, tree, 'skills');
      for (const [skill, stages] of Object.entries(SECTION_BATCHES)) {
        if (skill === 'codex') continue;
        const directory = path.join(skills, `gstack-${skill}`);
        const ids = [...new Set(Object.values(stages).flat())];
        expect(fs.readdirSync(path.join(directory, 'sections')).sort()).toEqual(ids.map(id => `${id}.md`).sort());
        const inline = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
        for (const id of ids) {
          const fragment = fs.readFileSync(path.join(directory, 'sections', `${id}.md`), 'utf8');
          expect(fragment).not.toMatch(/^---\s*\n/);
          if (skill === 'review' && id === 'review-army') {
            const heading = fragment.split('\n').find(line => /^## Step 4.5:/.test(line));
            expect(heading).toBeDefined();
            expect(inline.split(heading!).length, `${tree}/${skill}/${id}`).toBe(2);
          }
        }
      }
    });
  }

  for (const host of HOSTS) for (const isWindows of ['0', '1'] as const) {
    test(`${host.name}, IS_WINDOWS=${isWindows}: actual host refresh preserves destination-only validator registrations`, () => {
      const f = provision(host, isWindows);
      const { manifestPath, runtimes } = registerPython(f);
      expect(JSON.parse(fs.readFileSync(path.join(f.source, '.ecpe-installed-runtime.json'), 'utf8')).execution_environment).toBeUndefined();
      const refreshed = installRuntime(host, isWindows, f);
      expect(refreshed.status, refreshed.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).execution_environment).toEqual({ runtimes });
      for (const runtimeId of ['harness_test_python', 'cdo_preview_python'] as const) {
        const binding = resolveRegisteredRuntimeBinding({ repositoryRoot: f.root, manifestPath, runtimeId,
          sourceRoots: [], binding: { mode: 'argv0' }, argv: ['python', '--version'] });
        try { expect(binding.interpreter).toBe(runtimes[runtimeId].realpath); }
        finally { releaseRuntimeBinding(binding); }
      }
      expect(deliver(f, 'review', 'review-army').status).toBe(0);
    }, 30_000);
  }

  for (const host of HOSTS.filter(host => host.fn.endsWith('_runtime_root'))) {
    test(`${host.name}: actual host refresh rejects malformed destination metadata before replacing authority`, () => {
      const f = provision(host, '0');
      const manifest = path.join(f.runtime, '.ecpe-installed-runtime.json');
      const before = fs.readFileSync(path.join(f.runtime, 'sections/review/review-army.md'), 'utf8');
      fs.writeFileSync(manifest, '{invalid\n');
      fs.appendFileSync(path.join(f.source, host.tree, 'skills/gstack-review/sections/review-army.md'), '\nnew version\n');
      const refreshed = installRuntime(host, '0', f);
      expect(refreshed.status).not.toBe(0);
      expect(refreshed.stderr).toContain('registered_runtime_manifest_invalid');
      expect(fs.readFileSync(manifest, 'utf8')).toBe('{invalid\n');
      expect(fs.readFileSync(path.join(f.runtime, 'sections/review/review-army.md'), 'utf8')).toBe(before);
    }, 30_000);
  }

  for (const isWindows of ['0', '1'] as const) {
    test(`repo-local Codex source runtime binds Codex sections, IS_WINDOWS=${isWindows}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-repo-local-codex-')); roots.push(root);
      const runtime = path.join(root, 'project/.agents/skills/gstack');
      fs.cpSync(rendered, runtime, { recursive: true });
      for (const skill of Object.keys(SECTION_BATCHES)) {
        fs.cpSync(path.join(ROOT, skill, 'sections'), path.join(runtime, skill, 'sections'), { recursive: true });
      }
      // Execute setup's source attestation and repo-local runtime selection,
      // including the branch that intentionally keeps the checkout itself.
      const bindStart = SETUP.indexOf('# Bind');
      const bindEnd = SETUP.indexOf('\n# 1c. Generate .factory/', bindStart);
      const classifyStart = SETUP.indexOf('SKILLS_BASENAME=');
      const classifyEnd = SETUP.indexOf('\nfi\n', classifyStart) + 4;
      const selectionStart = SETUP.indexOf('# 5. Install for Codex');
      const selectionEnd = SETUP.indexOf('  # Install generated Codex-format skills', selectionStart);
      expect(bindStart).toBeGreaterThan(-1);
      expect(selectionEnd).toBeGreaterThan(selectionStart);
      const installed = spawnSync('bash', ['-c', [
        'set -e', 'unset CODEX_REPO_LOCAL', `IS_WINDOWS=${isWindows}`, 'INSTALL_CODEX=1',
        `SOURCE_GSTACK_DIR=${quote(runtime)}`, `INSTALL_GSTACK_DIR=${quote(runtime)}`,
        `INSTALL_SKILLS_DIR=${quote(path.dirname(runtime))}`,
        `BUN_CMD=${quote(process.execPath)}`, `BUN_RUNTIME_PATH=${quote(process.execPath)}`,
        shellFunction('bun_cmd'), shellFunction('_install_authority_runtime'),
        // Keep the actual setup order, without pre-seeding its derived flag.
        ...[[bindStart, bindEnd], [classifyStart, classifyEnd]].sort((a, b) => a[0] - b[0])
          .map(([start, end]) => SETUP.slice(start, end)),
        SETUP.slice(selectionStart, selectionEnd), 'fi',
        'printf "%s\\n" "$CODEX_GSTACK"',
      ].join('\n')], { encoding: 'utf8', timeout: 30_000 });
      expect(installed.status, installed.stderr).toBe(0);
      expect(installed.stdout.trim()).toBe(runtime);
      for (const [skill, stage] of [['review', 'review-army'], ['ship', 'pr-body'], ['land-and-deploy', 'first-run-validation']]) {
        const expected = fs.readFileSync(path.join(runtime, '.agents/skills', `gstack-${skill}/sections/${stage}.md`), 'utf8');
        const result = deliver({ root, runtime }, skill, stage);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).sections[0].content).toBe(expected);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(runtime, '.ecpe-installed-runtime.json'), 'utf8'));
      expect(Object.keys(manifest.artifacts).every(key => key.startsWith('.agents/skills/'))).toBe(true);
      // A bound source runtime must fail closed if its Codex section vanishes,
      // even though a valid Claude source section still exists beside it.
      fs.unlinkSync(path.join(runtime, '.agents/skills/gstack-review/sections/plan-completion.md'));
      const missing = deliver({ root, runtime }, 'review', 'plan-completion');
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('installed_section_missing');
    }, 30_000);
  }

  test('Claude source runtime delivers its canonical sections through the installed anchor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-claude-sections-')); roots.push(root);
    const runtime = path.join(root, 'runtime');
    for (const relative of ['bin', 'dist/authority']) {
      fs.cpSync(path.join(rendered, relative), path.join(runtime, relative), { recursive: true });
    }
    for (const skill of Object.keys(SECTION_BATCHES)) {
      fs.cpSync(path.join(ROOT, skill, 'sections'), path.join(runtime, skill, 'sections'), { recursive: true });
    }
    const manifest = spawnSync(process.execPath, [path.join(ROOT, 'scripts/write-installed-runtime-manifest.ts'),
      '--output', path.join(runtime, '.ecpe-installed-runtime.json'), '--artifact-root', runtime], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(manifest.status, manifest.stderr).toBe(0);
    for (const [skill, stage] of [['review', 'review-army'], ['ship', 'pr-body'], ['land-and-deploy', 'first-run-validation']]) {
      const result = deliver({ root, runtime }, skill, stage);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).sections[0].content).toBe(fs.readFileSync(path.join(ROOT, skill, 'sections', `${stage}.md`), 'utf8'));
    }
  }, 30_000);

  for (const host of HOSTS) for (const isWindows of ['0', '1'] as const) {
    test(`${host.name}, IS_WINDOWS=${isWindows}: installed anchor delivers host-rendered sections`, () => {
      const f = provision(host, isWindows);
      for (const [skill, stage] of [['review', 'review-army'], ['ship', 'pr-body'], ['land-and-deploy', 'first-run-validation']]) {
        const result = deliver(f, skill, stage);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).sections[0].id).toBe(stage);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(f.runtime, '.ecpe-installed-runtime.json'), 'utf8'));
      const expectedKeys: string[] = [];
      for (const [skill, stages] of Object.entries(SECTION_BATCHES)) {
        // All external hosts deliberately omit the Claude-only codex wrapper.
        if (skill === 'codex') continue;
        for (const section of new Set(Object.values(stages).flat())) {
          const relative = `sections/${skill}/${section}.md`;
          const installed = path.join(f.runtime, relative);
          const info = fs.lstatSync(installed);
          let expected = fs.readFileSync(path.join(f.source, host.tree, `skills/gstack-${skill}/sections/${section}.md`), 'utf8');
          if (host.host === 'kiro') expected = expected.replaceAll('$HOME/.codex/skills/gstack', '$HOME/.kiro/skills/gstack')
            .replaceAll('~/.codex/skills/gstack', '~/.kiro/skills/gstack')
            .replaceAll('~/.claude/skills/gstack', '~/.kiro/skills/gstack')
            .replaceAll('./setup --host codex', './setup --host kiro');
          const bytes = fs.readFileSync(installed);
          expect(bytes.toString('utf8'), relative).toBe(expected);
          expect(info.isFile() && !info.isSymbolicLink(), relative).toBe(true);
          expect(info.nlink, relative).toBe(1);
          expect(manifest.artifacts[relative], relative).toEqual({ sha256: digest(bytes), size: bytes.length, mode: info.mode & 0o777 });
          expectedKeys.push(relative);
        }
      }
      expect(Object.keys(manifest.artifacts).sort()).toEqual(expectedKeys.sort());
    }, 30_000);
  }

  for (const mutation of ['bytes', 'mode', 'symlink', 'hardlink'] as const) {
    test(`installed delivery rejects section ${mutation} drift`, () => {
      const f = provision(HOSTS[2], '0');
      const section = path.join(f.runtime, 'sections/review/review-army.md');
      expect(fs.existsSync(section)).toBe(true);
      if (mutation === 'bytes') fs.appendFileSync(section, '\nchanged\n');
      else if (mutation === 'mode') fs.chmodSync(section, 0o600);
      else {
        const other = path.join(f.root, 'section-copy');
        fs.renameSync(section, other);
        if (mutation === 'symlink') fs.symlinkSync(other, section);
        else fs.linkSync(other, section);
      }
      const result = deliver(f, 'review', 'review-army');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('installed_section_mismatch');
      expect(result.stdout).toBe('');
    }, 30_000);
  }

  for (let failure = 1; failure <= 8; failure++) {
    test(`section transaction restores all four runtime leaves after rename ${failure} fails`, () => {
      const f = provision(HOSTS[2], '0');
      const files = ['bin/gstack-anchor', 'dist/authority/manifest.json', '.ecpe-installed-runtime.json', 'sections/review/review-army.md'];
      const before = files.map(file => fs.readFileSync(path.join(f.runtime, file), 'utf8'));
      fs.appendFileSync(path.join(f.source, '.factory/skills/gstack-review/sections/review-army.md'), '\nnew version\n');
      const result = refresh(f, `count=0\nmv() { count=$((count + 1)); if [ "$count" -eq "${failure}" ]; then return 73; fi; command mv "$@"; }`);
      expect(result.status).not.toBe(0);
      expect(files.map(file => fs.readFileSync(path.join(f.runtime, file), 'utf8'))).toEqual(before);
      expect(fs.readdirSync(f.runtime).some(name => name.startsWith('.authority-install.'))).toBe(false);
      expect(fs.readdirSync(path.join(f.runtime, 'dist'))).toEqual(['authority']);
      const delivery = deliver(f, 'review', 'review-army');
      expect(delivery.status, delivery.stderr).toBe(0);
    }, 30_000);
  }

  for (const missing of ['section', 'skill', 'host-tree'] as const) {
    test(`missing generated ${missing} cannot shrink the attested host registry`, () => {
      const f = provision(HOSTS[2], '0');
      const manifest = fs.readFileSync(path.join(f.runtime, '.ecpe-installed-runtime.json'), 'utf8');
      const relative = missing === 'section' ? '.factory/skills/gstack-review/sections/review-army.md'
        : missing === 'skill' ? '.factory/skills/gstack-review' : '.factory';
      fs.rmSync(path.join(f.source, relative), { recursive: true });
      const result = refresh(f);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('runtime_artifact_missing');
      expect(fs.readFileSync(path.join(f.runtime, '.ecpe-installed-runtime.json'), 'utf8')).toBe(manifest);
      const delivery = deliver(f, 'review', 'review-army');
      expect(delivery.status, delivery.stderr).toBe(0);
    }, 30_000);
  }
});
