import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const ROOT = join(import.meta.dir, '..');
const SAFE_TEMPLATE_MAP = [
  ['Package.swift.template', 'Package.swift'],
  ['StateServer.swift.template', 'Sources/DebugBridgeCore/StateServer.swift'],
  ['DebugBridgeManager.swift.template', 'Sources/DebugBridgeCore/DebugBridgeManager.swift'],
  ['Bridges.swift.template', 'Sources/DebugBridgeUI/Bridges.swift'],
  ['DebugOverlay.swift.template', 'Sources/DebugBridgeUI/DebugOverlay.swift'],
  ['DebugBridgeTouch.m.template', 'Sources/DebugBridgeTouch/DebugBridgeTouch.m'],
  ['DebugBridgeTouch.h.template', 'Sources/DebugBridgeTouch/include/DebugBridgeTouch.h'],
] as const;

const workDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function copyIntoFakeInstall(workDir: string): { root: string; launcher: string } {
  const root = join(workDir, 'fake gstack install');
  const binDir = join(root, 'bin');
  const scriptsDir = join(root, 'ios-qa', 'scripts');
  const templatesDir = join(root, 'ios-qa', 'templates');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });

  const launcher = join(binDir, 'gstack-ios-qa-regen');
  copyFileSync(join(ROOT, 'bin', 'gstack-ios-qa-regen'), launcher);
  chmodSync(launcher, 0o755);
  copyFileSync(join(ROOT, 'ios-qa', 'scripts', 'gen-accessors.ts'), join(scriptsDir, 'gen-accessors.ts'));
  for (const [template] of SAFE_TEMPLATE_MAP) {
    copyFileSync(join(ROOT, 'ios-qa', 'templates', template), join(templatesDir, template));
  }

  // These files deliberately exist in the discovered template directory. If
  // the launcher ever regresses to wildcard copying, their sentinel content
  // will escape into the app and fail the absence assertions below.
  writeFileSync(join(templatesDir, 'DebugBridgeWiring.swift.template'), '// FORBIDDEN-WIRING-SENTINEL\n');
  writeFileSync(join(templatesDir, 'StateAccessor.swift.template'), '// FORBIDDEN-STATE-SENTINEL\n');
  writeFileSync(join(root, 'VERSION'), '9.8.7.6\n');
  return { root, launcher };
}

function treeHash(...roots: string[]): string {
  const hash = createHash('sha256');
  for (const root of roots) {
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          visit(path);
        } else {
          hash.update(relative(root, path));
          hash.update('\0');
          hash.update(readFileSync(path));
          hash.update('\0');
        }
      }
    };
    visit(root);
  }
  return hash.digest('hex');
}

function allFileContents(root: string): string {
  let contents = '';
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else contents += readFileSync(path, 'utf8');
    }
  };
  visit(root);
  return contents;
}

describe('gstack-ios-qa-regen', () => {
  test('repository launcher is executable', () => {
    expect(statSync(join(ROOT, 'bin', 'gstack-ios-qa-regen')).mode & 0o111).not.toBe(0);
  });

  test('requires the documented app-source and bridge-dir contract', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ios-qa-regen-'));
    workDirs.push(workDir);
    const { launcher } = copyIntoFakeInstall(workDir);
    const result = spawnSync('bash', [launcher, '--app-source', workDir], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('both --app-source and --bridge-dir are required');
  });

  test('leaves no completion marker when accessor generation fails', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ios-qa-regen-'));
    workDirs.push(workDir);
    const { launcher } = copyIntoFakeInstall(workDir);
    const appSource = join(workDir, 'app-source');
    const bridgeDir = join(workDir, 'bridge');
    const generatedDir = join(appSource, 'DebugBridgeGenerated');
    const fakeBin = join(workDir, 'fake-bin');
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(appSource, 'AppState.swift'), '@Observable final class AppState {}\n');
    writeFileSync(join(generatedDir, '.gstack-version'), 'stale-complete-marker\n');
    const fakeBun = join(fakeBin, 'bun');
    writeFileSync(fakeBun, '#!/bin/sh\nexit 17\n');
    chmodSync(fakeBun, 0o755);

    const result = spawnSync('bash', [
      launcher,
      '--app-source', appSource,
      '--bridge-dir', bridgeDir,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });

    expect(result.status).toBe(17);
    expect(existsSync(join(generatedDir, '.gstack-version'))).toBe(false);
  });

  test('regenerates the allowlisted package and accessors idempotently', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ios-qa-regen-'));
    workDirs.push(workDir);
    const { root, launcher } = copyIntoFakeInstall(workDir);
    const appSource = join(workDir, 'app source');
    const bridgeDir = join(appSource, 'DebugBridge');
    const generatedDir = join(appSource, 'DebugBridgeGenerated');
    const cacheRoot = join(workDir, 'isolated cache');
    mkdirSync(appSource, { recursive: true });
    writeFileSync(join(appSource, 'AppState.swift'), `
@Observable
final class AppState {
    // @Snapshotable
    var counter: Int = 0
}
`);

    // Seed the flat legacy layout that old ios-sync versions produced. A
    // correct regeneration must remove these known generated artifacts rather
    // than letting Xcode compile a second, stale harness implementation.
    mkdirSync(generatedDir, { recursive: true });
    for (const obsolete of [
      join(bridgeDir, 'DebugBridgeWiring.swift'),
      join(bridgeDir, 'StateAccessor.swift'),
      join(generatedDir, 'Package.swift'),
      join(generatedDir, 'StateServer.swift'),
      join(generatedDir, 'DebugBridgeManager.swift'),
      join(generatedDir, 'Bridges.swift'),
      join(generatedDir, 'DebugOverlay.swift'),
      join(generatedDir, 'DebugBridgeTouch.m'),
      join(generatedDir, 'DebugBridgeTouch.h'),
      join(generatedDir, 'DebugBridgeWiring.swift'),
    ]) {
      mkdirSync(join(obsolete, '..'), { recursive: true });
      writeFileSync(obsolete, '// OBSOLETE-HARNESS-SENTINEL\n');
    }

    const env = {
      ...process.env,
      GSTACK_IOS_CACHE_ROOT: cacheRoot,
      SWIFT_VERSION: '6.3.3',
      GEN_ACCESSORS_REV: 'regen-test',
    };
    const args = [launcher, '--app-source', appSource, '--bridge-dir', bridgeDir];
    const first = spawnSync('bash', args, { encoding: 'utf8', env });
    expect(first.status).toBe(0);
    expect(first.stderr).toBe('');

    // Every installed package file must be byte-identical to its explicit
    // source template: this is the durable template/output parity contract.
    for (const [template, destination] of SAFE_TEMPLATE_MAP) {
      expect(readFileSync(join(bridgeDir, destination))).toEqual(
        readFileSync(join(root, 'ios-qa', 'templates', template)),
      );
    }

    const accessorPath = join(generatedDir, 'StateAccessor.swift');
    const accessor = readFileSync(accessorPath, 'utf8');
    expect(accessor).toContain('import DebugBridgeCore');
    expect(accessor).toContain('enum AppStateAccessor');
    expect(accessor).not.toContain('public enum AppStateAccessor');
    expect(accessor).not.toContain('import DebugBridge\n');
    expect(accessor).toContain('guard let restored0 = Self.decodeSnapshotValue(raw0, as: Int.self)');
    expect(accessor).toContain('atomicRestore: { keys, apply in');
    expect(accessor).toContain('state.counter = restored0');
    expect(accessor).toContain('state.counter = typed');
    expect(accessor).toContain('return true');
    expect(accessor).not.toContain('atomicRestore: { _ in .ok }');
    expect(accessor).not.toContain('write: { _ in false }');
    expect(readFileSync(join(generatedDir, '.gstack-version'), 'utf8')).toBe(
      readFileSync(join(root, 'VERSION'), 'utf8'),
    );

    expect(existsSync(join(bridgeDir, 'DebugBridgeWiring.swift'))).toBe(false);
    expect(existsSync(join(bridgeDir, 'StateAccessor.swift'))).toBe(false);
    for (const obsoleteName of [
      'Package.swift',
      'StateServer.swift',
      'DebugBridgeManager.swift',
      'Bridges.swift',
      'DebugOverlay.swift',
      'DebugBridgeTouch.m',
      'DebugBridgeTouch.h',
      'DebugBridgeWiring.swift',
    ]) {
      expect(existsSync(join(generatedDir, obsoleteName))).toBe(false);
    }
    const installedContents = allFileContents(bridgeDir) + allFileContents(generatedDir);
    expect(installedContents).not.toContain('FORBIDDEN-WIRING-SENTINEL');
    expect(installedContents).not.toContain('FORBIDDEN-STATE-SENTINEL');
    expect(installedContents).not.toContain('OBSOLETE-HARNESS-SENTINEL');

    const swiftAvailable = spawnSync('swift', ['--version'], { encoding: 'utf8' }).status === 0;
    if (swiftAvailable) {
      const dump = spawnSync('swift', ['package', 'dump-package', '--package-path', bridgeDir], {
        encoding: 'utf8',
      });
      expect(dump.status).toBe(0);
      const manifest = JSON.parse(dump.stdout) as { targets: Array<{ name: string }> };
      expect(manifest.targets.map(target => target.name).sort()).toEqual([
        'DebugBridgeCore',
        'DebugBridgeTouch',
        'DebugBridgeUI',
      ]);
    }

    const firstHash = treeHash(bridgeDir, generatedDir);
    const firstAccessorHash = accessor.match(/accessorHash: "([a-f0-9]+)"/)?.[1];
    const second = spawnSync('bash', args, { encoding: 'utf8', env });
    expect(second.status).toBe(0);
    expect(second.stderr).toBe('');
    expect(second.stdout).toContain('gen-accessors: cache hit');
    expect(treeHash(bridgeDir, generatedDir)).toBe(firstHash);
    expect(readFileSync(accessorPath, 'utf8').match(/accessorHash: "([a-f0-9]+)"/)?.[1]).toBe(firstAccessorHash);
  });
});
