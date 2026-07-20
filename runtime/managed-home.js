import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPathInside, resolveRuntimePaths } from "./paths.js";
import { atomicWriteFile, atomicWriteJson, readJson, withLock } from "./storage.js";
import { errorWithCode as managedHomeError } from "./errors.js";
import { currentIsoTimestamp as isoNow } from "./time.js";

export const MANAGED_HOME_SCHEMA_VERSION = 1;
export const MANAGED_HOME_SENTINEL = ".gstack-managed-home.json";
export const RUNTIME_TRANSACTION_FILE = ".gstack-runtime-transaction.json";

/**
 * Runtime install/upgrade/uninstall use a sibling lock so a purge cannot
 * delete the lock that is protecting it. All destructive runtime lifecycle
 * operations must use this lock, not a command-specific lock under home.
 */
export function runtimeLifecycleLockPath(home) {
  const resolved = assertSafeManagedHomePath(home);
  return `${resolved}.runtime-lifecycle.lock`;
}

export function assertSafeManagedHomePath(home, options = {}) {
  if (typeof home !== "string" || home.length === 0 || home.includes("\0")) {
    throw managedHomeError("A non-empty managed home path is required", "MANAGED_HOME_UNSAFE");
  }
  const resolved = path.resolve(home);
  const root = path.parse(resolved).root;
  const userHome = path.resolve(options.homeDir ?? os.homedir());
  const cwd = path.resolve(options.cwd ?? process.cwd());

  if (resolved === root || resolved === userHome || path.dirname(resolved) === root) {
    throw managedHomeError(`Refusing unsafe managed home: ${resolved}`, "MANAGED_HOME_UNSAFE");
  }
  if (isSameOrAncestor(resolved, cwd)) {
    throw managedHomeError(
      `Refusing managed home that contains the current working directory: ${resolved}`,
      "MANAGED_HOME_UNSAFE",
    );
  }
  return resolved;
}

export async function ensureManagedHome(home, options = {}) {
  const resolved = assertSafeManagedHomePath(home, options);
  const existing = await fs.lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw managedHomeError(`Managed home must be a real directory, not a link or file: ${resolved}`, "MANAGED_HOME_UNSAFE");
  }
  if (!existing) await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const sentinelPath = path.join(resolved, MANAGED_HOME_SENTINEL);
  const sentinelStat = await fs.lstat(sentinelPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (sentinelStat?.isSymbolicLink() || (sentinelStat && !sentinelStat.isFile())) {
    throw managedHomeError(`Managed home sentinel is not a regular file: ${sentinelPath}`, "MANAGED_HOME_INVALID");
  }

  if (!sentinelStat) {
    const entries = await fs.readdir(resolved);
    const legacy = entries.length > 0
      ? await inspectRecognizedLegacyHome(resolved, entries)
      : null;
    if (entries.length > 0 && !legacy) {
      throw managedHomeError(
        `Refusing to claim a non-empty directory as managed home: ${resolved}`,
        "MANAGED_HOME_UNOWNED",
      );
    }
    const sentinel = {
      schemaVersion: MANAGED_HOME_SCHEMA_VERSION,
      kind: "gstack-managed-home",
      home: resolved,
      ownerId: randomUUID(),
      createdAt: isoNow(options.now),
      ...(legacy ? {
        adoptedLegacy: true,
        preexistingTopLevel: [...entries].sort(),
      } : {}),
    };
    await createOwnershipSentinel(sentinelPath, sentinel);
    const claimedEntries = (await fs.readdir(resolved)).sort();
    const expectedEntries = [...entries, MANAGED_HOME_SENTINEL].sort();
    if (JSON.stringify(claimedEntries) !== JSON.stringify(expectedEntries)) {
      await removeSentinelIfOwned(sentinelPath, sentinel.ownerId);
      throw managedHomeError(
        `Managed home changed while ownership was being claimed: ${resolved}`,
        "MANAGED_HOME_UNOWNED",
      );
    }
    return { home: resolved, sentinel, created: true };
  }

  const sentinel = await readAndValidateSentinel(sentinelPath, resolved);
  return { home: resolved, sentinel, created: false };
}

/** Create/verify one direct runtime-owned directory without following links. */
export async function ensureManagedRuntimeDirectory(home, directory) {
  const resolvedHome = path.resolve(home);
  const resolvedDirectory = path.resolve(directory);
  if (path.dirname(resolvedDirectory) !== resolvedHome) {
    throw managedHomeError("Managed runtime directory must be a direct child of GSTACK_HOME", "MANAGED_HOME_SUBDIRECTORY_UNSAFE");
  }
  try {
    await fs.mkdir(resolvedDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(resolvedDirectory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw managedHomeError(`Managed runtime directory is missing or unsafe: ${resolvedDirectory}`, "MANAGED_HOME_SUBDIRECTORY_UNSAFE");
  }
  const [physicalHome, physicalDirectory] = await Promise.all([
    fs.realpath(resolvedHome),
    fs.realpath(resolvedDirectory),
  ]);
  if (path.dirname(physicalDirectory) !== physicalHome) {
    throw managedHomeError(`Managed runtime directory escaped GSTACK_HOME: ${resolvedDirectory}`, "MANAGED_HOME_SUBDIRECTORY_UNSAFE");
  }
  return resolvedDirectory;
}

async function inspectRecognizedLegacyHome(home, entries) {
  // Record all pre-existing top-level entries in the sentinel so purge can
  // never remove them, even if their names later overlap the managed runtime
  // allowlist. Reject links before inspecting either legacy fingerprint.
  for (const entry of entries) {
    const stat = await fs.lstat(path.join(home, entry));
    if (stat.isSymbolicLink()) return null;
  }

  // A legacy config with a known GStack key is the original adoption proof.
  if (entries.includes("config.yaml")) {
    const configPath = path.join(home, "config.yaml");
    const configStat = await fs.lstat(configPath);
    if (configStat.isFile() && configStat.size <= 1024 * 1024) {
      const text = await fs.readFile(configPath, "utf8");
      const knownKey = /^(?:proactive|routing_declined|telemetry|auto_upgrade|update_check|skill_prefix|checkpoint_mode|checkpoint_push|explain_level|codex_reviews|gstack_contributor|skip_eng_review|workspace_root|cross_project_learnings|artifacts_sync_mode|plan_tune_hooks|redact_repo_visibility|redact_prepush_hook|brain_trust_policy(?:@[a-f0-9]+)?):\s*/m;
      if (knownKey.test(text)) return { kind: "legacy-config", configPath };
    }
  }

  // gstack-artifacts-init historically ran before the first config write, so
  // an existing artifacts repo can have no config.yaml and no ownership
  // sentinel. Require the complete, content-bearing GStack fingerprint: a
  // bare .git directory (or one marker file) must never make an arbitrary
  // directory adoptable.
  const artifactFiles = [
    ".gitignore",
    ".brain-allowlist",
    ".brain-privacy-map.json",
    ".gitattributes",
  ];
  if (!entries.includes(".git") || !artifactFiles.every((entry) => entries.includes(entry))) return null;
  const gitStat = await fs.lstat(path.join(home, ".git"));
  if (!gitStat.isDirectory()) return null;
  const stats = await Promise.all(artifactFiles.map((entry) => fs.lstat(path.join(home, entry))));
  if (stats.some((stat) => !stat.isFile() || stat.size > 1024 * 1024)) return null;

  const [gitignore, allowlist, privacyText, attributes] = await Promise.all(
    artifactFiles.map((entry) => fs.readFile(path.join(home, entry), "utf8")),
  );
  let privacyMap;
  try {
    privacyMap = JSON.parse(privacyText);
  } catch {
    // Invalid legacy metadata is not sufficient proof that this home is ours.
    privacyMap = null;
  }
  const hasCanonicalPrivacyEntry = Array.isArray(privacyMap) && privacyMap.some((entry) =>
    entry?.pattern === "projects/*/learnings.jsonl" && entry?.class === "artifact",
  );
  const recognized = gitignore.includes("gstack-artifacts sync") &&
    gitignore.includes(".brain-allowlist") &&
    allowlist.split(/\r?\n/).includes("projects/*/learnings.jsonl") &&
    allowlist.split(/\r?\n/).includes("retros/*.md") &&
    attributes.split(/\r?\n/).includes("*.jsonl merge=jsonl-append") &&
    hasCanonicalPrivacyEntry;
  return recognized ? { kind: "legacy-artifacts-repo" } : null;
}

async function createOwnershipSentinel(sentinelPath, sentinel) {
  let handle;
  try {
    handle = await fs.open(sentinelPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(sentinel, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw managedHomeError(`Managed home ownership changed concurrently: ${sentinelPath}`, "MANAGED_HOME_UNOWNED");
    }
    if (handle) await fs.rm(sentinelPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeSentinelIfOwned(sentinelPath, ownerId) {
  const sentinel = await readJson(sentinelPath, null).catch(() => null);
  if (sentinel?.ownerId === ownerId) await fs.rm(sentinelPath, { force: true });
}

export async function assertManagedHome(home, options = {}) {
  const resolved = assertSafeManagedHomePath(home, options);
  const stat = await fs.lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw managedHomeError(`Managed home does not exist or is not a real directory: ${resolved}`, "MANAGED_HOME_UNOWNED");
  }
  const sentinelPath = path.join(resolved, MANAGED_HOME_SENTINEL);
  const sentinelStat = await fs.lstat(sentinelPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!sentinelStat?.isFile() || sentinelStat.isSymbolicLink()) {
    throw managedHomeError(
      `Refusing runtime mutation because the ownership sentinel is missing or invalid: ${sentinelPath}`,
      "MANAGED_HOME_UNOWNED",
    );
  }
  const sentinel = await readAndValidateSentinel(sentinelPath, resolved);
  return { home: resolved, sentinel };
}

export async function withRuntimeLifecycleLock(home, callback, options = {}) {
  const resolved = assertSafeManagedHomePath(home, options);
  return withLock(`${resolved}.runtime-lifecycle.lock`, () => callback(resolved), options.lockOptions);
}

/** Restore a launcher/manifest/pointer snapshot left by a killed installer. */
export async function recoverRuntimeTransactionUnlocked(home) {
  const resolved = path.resolve(home);
  const journalPath = path.join(resolved, RUNTIME_TRANSACTION_FILE);
  const journal = await readJson(journalPath, null);
  if (!journal) return { recovered: false };
  const journalHomeMatches = typeof journal?.home === "string" && await pathsReferToSameLocation(journal.home, resolved);
  const valid = journal.schemaVersion === 1 &&
    journal.kind === "gstack-runtime-install-transaction" &&
    journal.status === "prepared" &&
    journalHomeMatches &&
    Array.isArray(journal.files) &&
    typeof journal.previousPointerExists === "boolean";
  if (!valid) {
    throw managedHomeError(`Runtime transaction journal is invalid: ${journalPath}`, "RUNTIME_TRANSACTION_INVALID");
  }

  for (const file of journal.files) {
    const relative = validateTransactionPath(file?.path);
    const absolute = assertPathInside(resolved, path.join(resolved, relative));
    if (file.existed === false) {
      const stat = await fs.lstat(absolute).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        throw managedHomeError(`Refusing to remove transaction path directory: ${relative}`, "RUNTIME_TRANSACTION_INVALID");
      }
      await fs.rm(absolute, { force: true });
      continue;
    }
    if (file.existed !== true || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 ||
        typeof file.dataBase64 !== "string" || file.dataBase64.length > 16 * 1024 * 1024 || !validBase64(file.dataBase64)) {
      throw managedHomeError(`Runtime transaction snapshot is invalid: ${relative}`, "RUNTIME_TRANSACTION_INVALID");
    }
    await atomicWriteFile(absolute, Buffer.from(file.dataBase64, "base64"), { mode: file.mode });
  }

  const pointerPath = resolveRuntimePaths({ home: resolved }).versionPointer;
  if (journal.previousPointerExists) {
    if (!journal.previousPointer || journal.previousPointer.schemaVersion !== 2) {
      throw managedHomeError("Runtime transaction pointer snapshot is invalid", "RUNTIME_TRANSACTION_INVALID");
    }
    await atomicWriteJson(pointerPath, journal.previousPointer, { mode: 0o600 });
  } else {
    await fs.rm(pointerPath, { force: true });
  }
  await fs.rm(journalPath, { force: true });
  await fs.rmdir(path.join(resolved, "bin")).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  });
  return { recovered: true, version: journal.version ?? null };
}

async function readAndValidateSentinel(sentinelPath, expectedHome) {
  const sentinel = await readJson(sentinelPath, null);
  const homeMatches = typeof sentinel?.home === "string" && await pathsReferToSameLocation(sentinel.home, expectedHome);
  const valid = sentinel?.schemaVersion === MANAGED_HOME_SCHEMA_VERSION &&
    sentinel?.kind === "gstack-managed-home" &&
    homeMatches &&
    typeof sentinel?.ownerId === "string" &&
    /^[0-9a-f-]{16,}$/i.test(sentinel.ownerId) &&
    (!sentinel.adoptedLegacy || (
      Array.isArray(sentinel.preexistingTopLevel) &&
      sentinel.preexistingTopLevel.every((entry) => typeof entry === "string" && entry.length > 0 && entry !== MANAGED_HOME_SENTINEL && path.basename(entry) === entry)
    ));
  if (!valid) {
    throw managedHomeError(`Managed home sentinel is invalid or belongs to another path: ${sentinelPath}`, "MANAGED_HOME_INVALID");
  }
  return sentinel;
}

async function pathsReferToSameLocation(left, right) {
  if (path.resolve(left) === path.resolve(right)) return true;
  const [physicalLeft, physicalRight] = await Promise.all([
    fs.realpath(left).catch(() => path.resolve(left)),
    fs.realpath(right).catch(() => path.resolve(right)),
  ]);
  return physicalLeft === physicalRight;
}

function validateTransactionPath(value) {
  if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) {
    throw managedHomeError("Invalid runtime transaction path", "RUNTIME_TRANSACTION_INVALID");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "runtime-install.json" || /^bin\/[A-Za-z0-9._-]+$/.test(normalized)) return normalized;
  throw managedHomeError(`Invalid runtime transaction path: ${value}`, "RUNTIME_TRANSACTION_INVALID");
}

function validBase64(value) {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isSameOrAncestor(candidate, target) {
  const relative = path.relative(candidate, target);
  return relative === "" || relative === "." || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
