import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { spawnSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '..');
const POSIX_LAUNCHER = join(ROOT, 'browse', 'bin', 'windows-browse');
const STAGE_LAUNCHER = join(ROOT, 'browse', 'bin', 'stage-windows-browse-launcher');
const BUILD_SCRIPT = readFileSync(join(ROOT, 'scripts', 'build.sh'), 'utf8');
const SETUP_SCRIPT = readFileSync(join(ROOT, 'setup'), 'utf8');
const BASH = process.platform === 'win32'
  ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  : 'bash';
const tempRoots: string[] = [];

function makeCompleteSource(): string {
  const root = mkdtempSync(join(tmpdir(), 'gstack-appcontrol-source-'));
  tempRoots.push(root);
  for (const relative of [
    'browse/src',
    'browse/dist',
    'node_modules/playwright',
    'node_modules/diff',
  ]) {
    mkdirSync(join(root, relative), { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(
    join(root, 'browse/src/cli.ts'),
    'console.log(`cwd=${process.cwd().replace(/\\\\/g, "/")}`);\n' +
      'for (const arg of Bun.argv.slice(2)) console.log(`arg=${arg}`);\n',
  );
  writeFileSync(join(root, 'browse/dist/server-node.mjs'), '// fixture\n');
  writeFileSync(join(root, 'node_modules/playwright/package.json'), '{}\n');
  writeFileSync(join(root, 'node_modules/diff/package.json'), '{}\n');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Windows Smart App Control browse launcher', () => {
  test('source launcher discovers complete installs without a hardcoded user path', () => {
    const posix = readFileSync(POSIX_LAUNCHER, 'utf8');

    expect(posix).toContain('GSTACK_SOURCE_ROOT');
    expect(posix).toContain('browse/src/cli.ts');
    expect(posix).toContain('browse/dist/server-node.mjs');
    expect(posix).toContain('node_modules');
    expect(posix).not.toMatch(/Users[\\/]Administrator|Users[\\/]garry/i);
    expect(posix).toContain('$HOME/.gstack/repos/gstack');
    expect(posix).toContain('$HOME/.claude/skills/gstack');
  });

  test('POSIX launcher forwards arguments through Bun from the discovered source root', () => {
    const sourceRoot = makeCompleteSource();
    if (process.platform === 'win32') expect(existsSync(BASH)).toBe(true);

    const result = spawnSync(BASH, ['browse/bin/windows-browse', 'goto', 'http://127.0.0.1:4322/'], {
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        GSTACK_SOURCE_ROOT: sourceRoot,
      },
    });

    expect(result.status).toBe(0);
    const cwdLine = result.stdout.split(/\r?\n/).find(line => line.startsWith('cwd='));
    expect(cwdLine?.replace(/\\/g, '/').endsWith(`/${basename(sourceRoot)}`)).toBe(true);
    expect(result.stdout).toContain('arg=goto');
    expect(result.stdout).toContain('arg=http://127.0.0.1:4322/');
  });

  test('explicit incomplete source roots fail closed', () => {
    const incomplete = mkdtempSync(join(tmpdir(), 'gstack-appcontrol-incomplete-'));
    tempRoots.push(incomplete);
    const result = spawnSync(BASH, ['browse/bin/windows-browse', 'status'], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, GSTACK_SOURCE_ROOT: incomplete },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not contain a complete gstack source install');
  });

  test('stager no-ops off Windows and preserves browse.exe while installing the exact launcher', () => {
    const stageRoot = mkdtempSync(join(tmpdir(), 'gstack-appcontrol-stage-'));
    tempRoots.push(stageRoot);
    mkdirSync(join(stageRoot, 'browse/bin'), { recursive: true });
    mkdirSync(join(stageRoot, 'browse/dist'), { recursive: true });
    writeFileSync(join(stageRoot, 'browse/bin/windows-browse'), '#!/usr/bin/env bash\necho staged\n');
    writeFileSync(join(stageRoot, 'browse/dist/browse.exe'), 'native sentinel\n');
    const shellRoot = stageRoot.replace(/\\/g, '/');

    const nonWindows = spawnSync(BASH, ['browse/bin/stage-windows-browse-launcher', 'Linux', shellRoot], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    expect(nonWindows.status).toBe(0);
    expect(existsSync(join(stageRoot, 'browse/dist/browse'))).toBe(false);

    const windows = spawnSync(BASH, ['browse/bin/stage-windows-browse-launcher', 'MINGW64_NT-10.0', shellRoot], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    expect(windows.status).toBe(0);
    expect(readFileSync(join(stageRoot, 'browse/dist/browse'), 'utf8')).toBe(
      readFileSync(join(stageRoot, 'browse/bin/windows-browse'), 'utf8'),
    );
    expect(readFileSync(join(stageRoot, 'browse/dist/browse.exe'), 'utf8')).toBe('native sentinel\n');
  });

  test('Windows build stages the extensionless launcher after compiling', () => {
    expect(BUILD_SCRIPT).toContain('bash browse/bin/stage-windows-browse-launcher');
    expect(BUILD_SCRIPT.indexOf('build --compile browse/src/cli.ts')).toBeLessThan(
      BUILD_SCRIPT.indexOf('bash browse/bin/stage-windows-browse-launcher'),
    );
  });

  test('setup rebuilds when either Windows launcher file changes', () => {
    expect(SETUP_SCRIPT).toContain('browse/bin/windows-browse" -nt "$BROWSE_BIN');
    expect(SETUP_SCRIPT).toContain('browse/bin/stage-windows-browse-launcher" -nt "$BROWSE_BIN');
  });
});
