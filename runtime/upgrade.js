import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPathInside, resolveRuntimePaths } from "./paths.js";
import { atomicWriteJson, pathExists, readJson, renameWithRetry } from "./storage.js";
import {
  assertManagedHome,
  ensureManagedHome,
  recoverRuntimeTransactionUnlocked,
  withRuntimeLifecycleLock,
} from "./managed-home.js";
import { errorWithCode as upgradeError } from "./errors.js";
import { currentIsoTimestamp as isoNow } from "./time.js";

export async function stageUpgrade(options) {
  const home = path.resolve(options.home);
  return withRuntimeLifecycleLock(home, async () => {
    await ensureManagedHome(home, options);
    await recoverRuntimeTransactionUnlocked(home);
    return stageUpgradeUnlocked({ ...options, home });
  }, options);
}

/**
 * Internal transaction primitive used by the managed installer while it holds
 * the one lifecycle lock. Callers may update stable launchers/manifest in
 * beforeActivate and restore their snapshot in onRollback.
 */
export async function stageUpgradeUnlocked(options) {
  const { home, sourceDir } = options;
  const version = validateVersion(options.version);
  const paths = resolveRuntimePaths({ home });
  const source = path.resolve(sourceDir);
  await validateStageSource(source);
  await fs.mkdir(paths.versions, { recursive: true, mode: 0o700 });

  await recoverPendingUpgradeUnlocked(paths, options);
  const previousExists = await pathExists(paths.versionPointer);
  const previous = await readJson(paths.versionPointer, emptyPointer());
  validatePointer(previous);
  const destination = assertPathInside(paths.versions, path.join(paths.versions, version));
  let staged = false;

  if (!(await pathExists(destination))) {
    const stage = assertPathInside(
      paths.versions,
      path.join(paths.versions, `.stage-${version}-${randomUUID()}`),
    );
    try {
      await copyDirectory(source, stage);
      await atomicWriteJson(path.join(stage, ".gstack-version.json"), {
        schemaVersion: 2,
        version,
        stagedAt: isoNow(options.now),
      }, { mode: 0o644 });
      await assertTreeContainsNoLinks(stage);
      if (options.verify) await options.verify(stage);
      await renameWithRetry(stage, destination);
      staged = true;
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } else {
    if (!(await isRealDirectory(destination))) {
      throw upgradeError(`Version destination is not a real directory: ${version}`, "UPGRADE_DESTINATION_INVALID");
    }
    await assertTreeContainsNoLinks(destination);
    if (options.verify) await options.verify(destination);
  }

  const lastKnownGood = previous.status === "active" && previous.current && previous.current !== version
    ? previous.current
    : previous.lastKnownGood ?? null;
  const active = {
    schemaVersion: 2,
    status: "active",
    current: version,
    lastKnownGood,
    activatedAt: isoNow(options.now),
    verifiedAt: isoNow(options.now),
  };

  try {
    // Health runs while the old active pointer remains visible. A candidate is
    // never published as `pending`, so concurrent launchers cannot execute it.
    if (options.healthCheck) await options.healthCheck(destination);
    if (options.beforeActivate) await options.beforeActivate({
      active,
      previous,
      previousExists,
      destination,
      staged,
      paths,
    });
    await atomicWriteJson(paths.versionPointer, active, { mode: 0o600 });
    if (options.afterActivate) await options.afterActivate({
      active,
      previous,
      previousExists,
      destination,
      staged,
      paths,
    });
    return { pointer: active, path: destination, staged };
  } catch (cause) {
    const rollbackErrors = [];
    let pointerRollbackError = null;
    try {
      if (previousExists) {
        await atomicWriteJson(paths.versionPointer, previous, { mode: 0o600 });
      } else {
        await atomicWriteJson(paths.versionPointer, {
          ...emptyPointer(),
          status: "rolled_back",
          failedVersion: version,
          rolledBackAt: isoNow(options.now),
        }, { mode: 0o600 });
      }
    } catch (error) {
      pointerRollbackError = error;
      rollbackErrors.push(error);
    }
    try {
      if (options.onRollback) await options.onRollback({
        active,
        previous,
        previousExists,
        destination,
        staged,
        paths,
        cause,
        pointerRollbackError,
      });
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (staged) {
      try {
        await fs.rm(destination, { recursive: true, force: true });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    const error = upgradeError(`Upgrade ${version} failed health checks and was rolled back`, "UPGRADE_ROLLED_BACK", cause);
    if (rollbackErrors.length === 1) error.rollbackError = rollbackErrors[0];
    else if (rollbackErrors.length > 1) error.rollbackError = new AggregateError(rollbackErrors, "Runtime rollback was incomplete");
    throw error;
  }
}

export async function recoverPendingUpgrade(home, options = {}) {
  const resolved = path.resolve(home);
  return withRuntimeLifecycleLock(resolved, async () => {
    await assertManagedHome(resolved, options);
    await recoverRuntimeTransactionUnlocked(resolved);
    return recoverPendingUpgradeUnlocked(resolveRuntimePaths({ home: resolved }), options);
  }, options);
}

export async function recoverPendingUpgradeUnlocked(paths, options = {}) {
  const pointer = await readJson(paths.versionPointer, emptyPointer());
  validatePointer(pointer);
  if (pointer.status !== "pending") return { recovered: false, pointer };
  const fallback = pointer.lastKnownGood;
  const fallbackPath = fallback
    ? assertPathInside(paths.versions, path.join(paths.versions, validateVersion(fallback)))
    : null;
  const fallbackExists = fallbackPath && await isRealDirectory(fallbackPath);
  const recovered = fallbackExists
    ? {
        schemaVersion: 2,
        status: "active",
        current: fallback,
        lastKnownGood: null,
        recoveredFrom: pointer.current,
        recoveredAt: isoNow(options.now),
      }
    : {
        ...emptyPointer(),
        status: "rolled_back",
        failedVersion: pointer.current,
        recoveredAt: isoNow(options.now),
      };
  await atomicWriteJson(paths.versionPointer, recovered, { mode: 0o600 });
  return { recovered: true, pointer: recovered };
}

export async function rollbackUpgrade(home, options = {}) {
  const resolved = path.resolve(home);
  return withRuntimeLifecycleLock(resolved, async () => {
    await assertManagedHome(resolved, options);
    await recoverRuntimeTransactionUnlocked(resolved);
    const paths = resolveRuntimePaths({ home: resolved });
    const recovered = await recoverPendingUpgradeUnlocked(paths, options);
    const pointer = recovered.pointer;
    if (!pointer.lastKnownGood) {
      throw upgradeError("No last-known-good version is available", "NO_ROLLBACK_VERSION");
    }
    const fallbackVersion = validateVersion(pointer.lastKnownGood);
    const fallbackPath = assertPathInside(paths.versions, path.join(paths.versions, fallbackVersion));
    if (!(await isRealDirectory(fallbackPath))) {
      throw upgradeError(`Last-known-good version is missing: ${fallbackVersion}`, "ROLLBACK_VERSION_MISSING");
    }
    await assertTreeContainsNoLinks(fallbackPath);
    if (options.healthCheck) await options.healthCheck(fallbackPath);
    const rolledBack = {
      schemaVersion: 2,
      status: "active",
      current: fallbackVersion,
      lastKnownGood: pointer.current ?? null,
      rolledBackFrom: pointer.current ?? null,
      rolledBackAt: isoNow(options.now),
    };
    await atomicWriteJson(paths.versionPointer, rolledBack, { mode: 0o600 });
    return rolledBack;
  }, options);
}

export async function activeVersion(home, options = {}) {
  const recovered = await recoverPendingUpgrade(home, options);
  return recovered.pointer;
}

export async function uninstallRuntime(home, options = {}) {
  const resolved = path.resolve(home);
  return withRuntimeLifecycleLock(resolved, async () => {
    await assertManagedHome(resolved, options);
    await recoverRuntimeTransactionUnlocked(resolved);
    if (options.purge) {
      return purgeManagedHomeUnlocked(resolved);
    }
    const paths = resolveRuntimePaths({ home: resolved });
    await fs.rm(paths.versions, { recursive: true, force: true });
    return { purged: false, preservedState: true, home: resolved };
  }, options);
}

export async function purgeManagedHomeUnlocked(home) {
  const resolved = path.resolve(home);
  const ownership = await assertManagedHome(resolved);
  const preexisting = new Set(ownership.sentinel.preexistingTopLevel ?? []);
  const managedEntries = new Set([
    ".gstack-managed-home.json",
    ".gstack-runtime-transaction.json",
    "bin",
    "config.json",
    "locks",
    "migration.json",
    "plans",
    "projects",
    "runtime-install.json",
    "secrets.json",
    "tmp",
    "versions",
  ]);
  const present = await fs.readdir(resolved);
  const preserved = present.filter((entry) => !managedEntries.has(entry) || preexisting.has(entry));
  const quarantine = `${resolved}.purge-${process.pid}-${randomUUID()}`;
  await fs.mkdir(quarantine, { mode: 0o700 });
  const moved = [];
  try {
    for (const entry of present.filter((name) => managedEntries.has(name) && !preexisting.has(name))) {
      const source = assertPathInside(resolved, path.join(resolved, entry));
      const destination = assertPathInside(quarantine, path.join(quarantine, entry));
      await renameWithRetry(source, destination);
      moved.push({ source, destination });
    }
    await fs.rm(quarantine, { recursive: true, force: true });
    await fs.rmdir(resolved).catch((error) => {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
    });
    return { purged: true, home: resolved, preserved };
  } catch (error) {
    for (const item of moved.reverse()) {
      await renameWithRetry(item.destination, item.source).catch(() => {});
    }
    await fs.rmdir(quarantine).catch(() => {});
    throw error;
  }
}

function validateVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/.test(value)) {
    throw new TypeError("Version must contain only letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

function validatePointer(pointer) {
  const validStatuses = new Set(["inactive", "pending", "active", "rolled_back"]);
  if (!pointer || pointer.schemaVersion !== 2 || !validStatuses.has(pointer.status)) {
    throw upgradeError("Managed version pointer is missing or unsupported", "UPGRADE_POINTER_INVALID");
  }
  if (pointer.current != null) validateVersion(pointer.current);
  if (pointer.lastKnownGood != null) validateVersion(pointer.lastKnownGood);
}

async function validateStageSource(source) {
  const stat = await fs.lstat(source).catch((error) => {
    if (error?.code === "ENOENT") throw upgradeError(`Upgrade source does not exist: ${source}`, "UPGRADE_SOURCE_INVALID", error);
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw upgradeError("Upgrade source must be a real directory, not a symlink", "UPGRADE_SOURCE_INVALID");
  }
  if ((await fs.readdir(source)).length === 0) {
    throw upgradeError("Upgrade source must not be empty", "UPGRADE_SOURCE_INVALID");
  }
  await assertTreeContainsNoLinks(source);
}

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function assertTreeContainsNoLinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw upgradeError(`Upgrade source contains a symlink: ${current}`, "UPGRADE_SOURCE_INVALID");
    }
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(current)) pending.push(path.join(current, child));
    } else if (!stat.isFile()) {
      throw upgradeError(`Upgrade source contains an unsupported entry: ${current}`, "UPGRADE_SOURCE_INVALID");
    }
  }
}

async function isRealDirectory(directory) {
  const stat = await fs.lstat(directory).catch(() => null);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function emptyPointer() {
  return { schemaVersion: 2, status: "inactive", current: null, lastKnownGood: null };
}
