import fs from "node:fs/promises";
import path from "node:path";
import { assertPathInside, resolveRuntimePaths } from "./paths.js";
import { pathExists } from "./storage.js";
import { recoverPendingUpgradeUnlocked } from "./upgrade.js";
import { assertManagedHome, withRuntimeLifecycleLock } from "./managed-home.js";

const HOME_ATOMIC_TARGETS = Object.freeze([
  ".gstack-managed-home.json",
  "config.json",
  "migration.json",
  "runtime-install.json",
  "secrets.json",
]);

const UUID_SUFFIX = "[0-9a-f-]{8,}";
const TMP_ATOMIC_PATTERN = new RegExp(`^\\.[A-Za-z0-9._-]+\\.tmp-\\d+-${UUID_SUFFIX}$`, "i");
const INSTALL_SCRATCH_PATTERN = new RegExp(`^(?:install|uninstall)-${UUID_SUFFIX}$`, "i");
const STALE_LOCK_SCRATCH_PATTERN = new RegExp(`^[A-Za-z0-9._-]+\\.lock\\.stale-\\d+-${UUID_SUFFIX}$`, "i");
const VERSION_STAGE_PATTERN = new RegExp(`^\\.stage-[0-9A-Za-z][0-9A-Za-z._-]{0,79}-${UUID_SUFFIX}$`, "i");

export async function cleanupRuntime(home, options = {}) {
  const paths = resolveRuntimePaths({ home });
  const olderThanMs = options.olderThanMs ?? 24 * 60 * 60 * 1000;
  const now = options.nowMs ?? Date.now();
  const dryRun = Boolean(options.dryRun);
  const removed = [];
  const skipped = [];
  if (!(await pathExists(paths.home))) return { removed, skipped, bytesReclaimed: 0, dryRun };

  const homeStat = await fs.lstat(paths.home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    const error = new Error(`Refusing to clean an unsafe gstack home: ${paths.home}`);
    error.code = "CLEANUP_HOME_UNSAFE";
    throw error;
  }

  return withRuntimeLifecycleLock(paths.home, async () => {
    await assertManagedHome(paths.home, options);
    return cleanupRuntimeUnlocked(paths, { olderThanMs, now, dryRun, removed, skipped });
  }, { lockOptions: options.lockOptions });
}

async function cleanupRuntimeUnlocked(paths, options) {
  const { olderThanMs, now, dryRun, removed, skipped } = options;
  const pendingRecovery = dryRun ? null : await recoverPendingUpgradeUnlocked(paths);
  let bytesReclaimed = 0;

  /**
   * Cleanup is intentionally shallow. In particular, never recurse through
   * projects, plans, or active immutable versions: those trees can contain
   * user-authored files whose names happen to look like runtime temporaries.
  */
  const cleanDirectory = async (directory, classify) => {
    const directoryStat = await fs.lstat(directory).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!directoryStat) return;
    if (directoryStat.isSymbolicLink()) {
      skipped.push({ path: directory, reason: "symlink-directory" });
      return;
    }
    if (!directoryStat.isDirectory()) {
      skipped.push({ path: directory, reason: "unexpected-directory-type" });
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = assertPathInside(paths.home, path.join(directory, entry.name));
      const stat = await fs.lstat(candidate).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        skipped.push({ path: candidate, reason: "symlink" });
        continue;
      }
      const age = now - stat.mtimeMs;
      if (age < olderThanMs) continue;
      const reason = await classify(entry.name, stat, candidate);
      if (reason) {
        const size = stat.isDirectory() ? await directorySize(candidate) : stat.size;
        removed.push({ path: candidate, reason, bytes: size });
        bytesReclaimed += size;
        if (!dryRun) await fs.rm(candidate, { recursive: true, force: true });
      }
    }
  };

  await cleanDirectory(paths.home, (name, stat) =>
    stat.isFile() && isAtomicSidecar(name, HOME_ATOMIC_TARGETS) ? "stale-temporary" : null);
  await cleanDirectory(paths.tmp, (name, stat) =>
    (stat.isFile() && TMP_ATOMIC_PATTERN.test(name)) ||
    (stat.isDirectory() && INSTALL_SCRATCH_PATTERN.test(name))
      ? "stale-install-scratch"
      : null);
  await cleanDirectory(paths.locks, async (name, stat, candidate) => {
    if (stat.isDirectory() && STALE_LOCK_SCRATCH_PATTERN.test(name)) return "stale-lock-scratch";
    if (!stat.isDirectory() || !/^[A-Za-z0-9._-]+\.lock$/.test(name)) return null;
    return await lockOwnerIsAlive(candidate) ? null : "stale-lock";
  });
  await cleanDirectory(paths.versions, (name, stat) => {
    if (stat.isDirectory() && VERSION_STAGE_PATTERN.test(name)) return "stale-version-stage";
    return stat.isFile() && isAtomicSidecar(name, ["current.json"]) ? "stale-temporary" : null;
  });

  return { removed, skipped, bytesReclaimed, dryRun, pendingRecovery };
}

function isAtomicSidecar(name, targets) {
  return targets.some((target) => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\.${escaped}\\.tmp-\\d+-${UUID_SUFFIX}$`, "i").test(name) ||
      new RegExp(`^${escaped}\\.replace-\\d+-${UUID_SUFFIX}$`, "i").test(name);
  });
}

async function lockOwnerIsAlive(lockDirectory) {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function directorySize(directory) {
  let total = 0;
  const rootStat = await fs.lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const stat = await fs.lstat(child).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += await directorySize(child);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}
