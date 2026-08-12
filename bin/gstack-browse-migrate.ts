#!/usr/bin/env bun
/**
 * Retire the pre-#1324 unpacked gstack browser extension from GStack's
 * dedicated Chromium profile.
 *
 * The old extension's ID was derived from its installation path, so it cannot
 * be a trust anchor. The current extension has a manifest key and a fixed ID.
 * This tool only edits ~/.gstack/chromium-profile (or an explicit test/profile
 * directory); it never touches a user's normal Chrome profile.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

const TRUSTED_EXTENSION_ID = 'hjcdllcckghjebjopehjhplcilonljjk';
const EXTENSION_NAME = 'gstack browse';

type Result = {
  profile: string;
  status: 'clean' | 'migrated' | 'deferred';
  legacyExtensionIds: string[];
  backup?: string;
  reason?: string;
};

function usage(): never {
  console.error('Usage: gstack-browse-migrate [--check|--apply] [--profile <gstack-profile>] [--legacy-extension-path <path>] [--json]');
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let mode: 'check' | 'apply' = 'check';
  let profile = process.env.CHROMIUM_PROFILE
    || path.join(process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack'), 'chromium-profile');
  let json = false;
  const legacyExtensionPaths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') mode = 'check';
    else if (argv[i] === '--apply') mode = 'apply';
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--profile') {
      profile = argv[++i] || usage();
    } else if (argv[i] === '--legacy-extension-path') {
      legacyExtensionPaths.push(argv[++i] || usage());
    } else usage();
  }
  return { mode, profile: path.resolve(profile), json, legacyExtensionPaths };
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.gstack-migrate-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function profileDirectories(profileRoot: string): string[] {
  if (!fs.existsSync(profileRoot)) return [];
  return fs.readdirSync(profileRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile ')))
    .map(entry => path.join(profileRoot, entry.name));
}

function findLegacyIds(preferences: any): string[] {
  const settings = preferences?.extensions?.settings;
  if (!settings || typeof settings !== 'object') return [];
  return Object.entries(settings)
    .filter(([id, value]: [string, any]) => id !== TRUSTED_EXTENSION_ID && value?.manifest?.name === EXTENSION_NAME)
    .map(([id]) => id);
}

/**
 * Before manifest.key, Chromium generated an unpacked extension's ID from the
 * absolute extension directory. The current manifest has a fixed key, but the
 * old ID can still be derived from that same path during an upgrade.
 */
function legacyIdForExtensionPath(extensionPath: string): string[] {
  const candidates = new Set([path.resolve(extensionPath)]);
  try { candidates.add(fs.realpathSync(extensionPath)); } catch {}
  return [...candidates].map(candidate => [...createHash('sha256').update(candidate).digest('hex').slice(0, 32)]
    .map(char => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16)))
    .join(''));
}

function storageLegacyIds(profileDir: string, extensionPaths: string[]): string[] {
  const storageRoots = ['Local Extension Settings', 'Sync Extension Settings'];
  const storedIds = new Set<string>();
  for (const storageRoot of storageRoots) {
    const root = path.join(profileDir, storageRoot);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) storedIds.add(entry.name);
    }
  }
  const knownLegacyIds = extensionPaths.flatMap(legacyIdForExtensionPath);
  return knownLegacyIds.filter(id => id !== TRUSTED_EXTENSION_ID && storedIds.has(id));
}

function output(result: Result, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(result));
  else {
    console.log(`[browse-migrate] ${result.status}: ${result.profile}`);
    if (result.legacyExtensionIds.length) console.log(`[browse-migrate] legacy extension IDs: ${result.legacyExtensionIds.join(', ')}`);
    if (result.backup) console.log(`[browse-migrate] backup: ${result.backup}`);
    if (result.reason) console.log(`[browse-migrate] ${result.reason}`);
  }
}

/** Chromium normally represents SingletonLock as a dangling hostname-PID symlink. */
function profileLockIsActive(lock: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lock);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    // If lock state cannot be inspected, do not risk editing the profile.
    return true;
  }
  if (!stat.isSymbolicLink()) return true;

  try {
    const target = fs.readlinkSync(lock);
    const match = target.match(/^(.*)-(\d+)$/);
    if (!match || match[1] !== os.hostname()) return true;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code !== 'ESRCH';
    }
  } catch {
    return true;
  }
}

function migrateProfile(profileRoot: string, mode: 'check' | 'apply', extensionPaths: string[]): Result[] {
  const lock = path.join(profileRoot, 'SingletonLock');
  if (profileLockIsActive(lock)) {
    return [{ profile: profileRoot, status: 'deferred', legacyExtensionIds: [], reason: 'browser profile is active; close GStack Browser and retry' }];
  }

  const results: Result[] = [];
  for (const profileDir of profileDirectories(profileRoot)) {
    const preferencesPath = path.join(profileDir, 'Preferences');
    const hasPreferences = fs.existsSync(preferencesPath);
    let preferences: any = { extensions: { settings: {} } };
    if (hasPreferences) {
      try {
        preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
      } catch {
        results.push({ profile: profileDir, status: 'deferred', legacyExtensionIds: [], reason: 'Preferences is not valid JSON; left unchanged' });
        continue;
      }
    }
    // Chrome may omit an unpacked extension from Preferences. In that case,
    // derive the old ID from the upgraded extension's path and require a
    // matching storage directory before acting. This remains narrowly scoped:
    // unrelated extension IDs are never selected by a broad directory scan.
    const legacyIds = [...new Set([
      ...findLegacyIds(preferences),
      ...storageLegacyIds(profileDir, extensionPaths),
    ])];
    if (!legacyIds.length) {
      results.push({ profile: profileDir, status: 'clean', legacyExtensionIds: [] });
      continue;
    }
    if (mode === 'check') {
      results.push({ profile: profileDir, status: 'deferred', legacyExtensionIds: legacyIds, reason: 'run with --apply to retire legacy extension state' });
      continue;
    }

    const migrationRoot = path.join(profileRoot, '..', 'browser-migrations', new Date().toISOString().replace(/[:.]/g, '-'));
    const backupDir = path.join(migrationRoot, path.basename(profileDir));
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (hasPreferences) fs.copyFileSync(preferencesPath, path.join(backupDir, 'Preferences'));

    if (hasPreferences) {
      for (const id of legacyIds) delete preferences.extensions?.settings?.[id];
      writeAtomic(preferencesPath, `${JSON.stringify(preferences, null, 2)}\n`);
    }

    // Extension storage is the only place the old design could retain its
    // daemon credential. Move it aside instead of deleting it so rollback is
    // possible without ever copying credentials into the new extension ID.
    for (const storageRoot of ['Local Extension Settings', 'Sync Extension Settings']) {
      for (const id of legacyIds) {
        const source = path.join(profileDir, storageRoot, id);
        if (!fs.existsSync(source)) continue;
        const target = path.join(backupDir, storageRoot, id);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.renameSync(source, target);
      }
    }
    results.push({ profile: profileDir, status: 'migrated', legacyExtensionIds: legacyIds, backup: backupDir });
  }
  return results.length ? results : [{ profile: profileRoot, status: 'clean', legacyExtensionIds: [] }];
}

const args = parseArgs(process.argv.slice(2));
const results = migrateProfile(args.profile, args.mode, args.legacyExtensionPaths);
for (const result of results) output(result, args.json);
// Check mode uses "deferred" to report work without failing. Apply mode must
// fail for every deferred profile so the versioned updater never writes its
// done marker while legacy credential state remains untouched.
process.exit(args.mode === 'apply' && results.some(result => result.status === 'deferred') ? 3 : 0);
