import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const ROOT = path.resolve(import.meta.dir, '..');
const MIGRATOR = path.join(ROOT, 'bin/gstack-browse-migrate.ts');
const TRUSTED = 'hjcdllcckghjebjopehjhplcilonljjk';
let legacyExtensionPath: string;
let legacyId: string;
let temp: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-browse-migration-'));
  legacyExtensionPath = path.join(temp, 'legacy-extension');
  fs.mkdirSync(legacyExtensionPath);
  legacyId = [...createHash('sha256').update(legacyExtensionPath).digest('hex').slice(0, 32)]
    .map(char => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16))).join('');
  const profile = path.join(temp, 'Default');
  fs.mkdirSync(path.join(profile, 'Local Extension Settings', legacyId), { recursive: true });
  fs.mkdirSync(path.join(profile, 'Sync Extension Settings', legacyId), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Local Extension Settings', legacyId, '000003.log'), 'legacy token storage');
  fs.writeFileSync(path.join(profile, 'Preferences'), JSON.stringify({
    extensions: { settings: {
      [TRUSTED]: { manifest: { name: 'gstack browse' } },
      another_extension: { manifest: { name: 'other extension' } },
    } },
  }));
});

afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync('bun', [MIGRATOR, '--profile', temp, '--legacy-extension-path', legacyExtensionPath, '--json', ...args], { encoding: 'utf8' });
}

describe('gstack-browse-migrate', () => {
  test('reports legacy state without modifying it in check mode', () => {
    const result = run('--check');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).legacyExtensionIds).toEqual([legacyId]);
    expect(fs.existsSync(path.join(temp, 'Default', 'Local Extension Settings', legacyId))).toBe(true);
  });

  test('retires only the legacy gstack extension and preserves a rollback copy', () => {
    const result = run('--apply');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('migrated');
    expect(fs.existsSync(path.join(temp, 'Default', 'Local Extension Settings', legacyId))).toBe(false);
    expect(fs.existsSync(path.join(report.backup, 'Local Extension Settings', legacyId, '000003.log'))).toBe(true);

    const preferences = JSON.parse(fs.readFileSync(path.join(temp, 'Default', 'Preferences'), 'utf8'));
    expect(preferences.extensions.settings[TRUSTED]).toBeDefined();
    expect(preferences.extensions.settings.another_extension).toBeDefined();
  });

  test('defers safely while the dedicated GStack Browser profile is active', () => {
    const lock = path.join(temp, 'SingletonLock');
    if (process.platform === 'win32') fs.writeFileSync(lock, 'active');
    else fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
    const result = run('--apply');
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).status).toBe('deferred');
    expect(fs.existsSync(path.join(temp, 'Default', 'Local Extension Settings', legacyId))).toBe(true);
  });

  test('does not mistake a dangling stale Chromium lock symlink for an active profile', () => {
    if (process.platform === 'win32') return;
    fs.symlinkSync(`${os.hostname()}-2147483647`, path.join(temp, 'SingletonLock'));
    const result = run('--apply');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('migrated');
  });

  test('does not mark an invalid Preferences profile as migrated', () => {
    fs.writeFileSync(path.join(temp, 'Default', 'Preferences'), '{not json');
    const result = run('--apply');
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).status).toBe('deferred');
    expect(fs.existsSync(path.join(temp, 'Default', 'Local Extension Settings', legacyId))).toBe(true);
  });
});
