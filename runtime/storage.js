import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WINDOWS_TRANSIENT_FS_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function pathExists(file) {
  try {
    await fs.access(file, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
    throw error;
  }
}

export async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT" && arguments.length >= 2) return fallback;
    if (error instanceof SyntaxError) {
      error.message = `Invalid JSON in ${file}: ${error.message}`;
    }
    throw error;
  }
}

export async function atomicWriteFile(file, data, options = {}) {
  const directory = path.dirname(file);
  const mode = options.mode ?? 0o644;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await fs.open(temp, "wx", mode);
    await handle.writeFile(data, options.encoding ?? "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await replaceFile(temp, file);
    // umask does not get to weaken the privacy guarantee on secret files.
    await fs.chmod(file, mode);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(file, value, options = {}) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteFile(file, serialized, options);
}

async function replaceFile(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    // Windows cannot always rename over an existing file. Preserve the old
    // copy until the new name is in place so a failed activation is recoverable.
    if (!(["EEXIST", "EPERM", "EACCES"].includes(error?.code))) throw error;
    const backup = `${destination}.replace-${process.pid}-${randomUUID()}`;
    let backedUp = false;
    try {
      await fs.rename(destination, backup);
      backedUp = true;
    } catch (backupError) {
      if (backupError?.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(source, destination);
      if (backedUp) await fs.rm(backup, { force: true });
    } catch (replacementError) {
      if (backedUp) await fs.rename(backup, destination).catch(() => {});
      throw replacementError;
    }
  }
}

export async function syncDirectory(directory, options = {}) {
  // Directory fsync is supported on Unix and not consistently on Windows.
  const open = options.open ?? fs.open;
  let handle;
  let operationError;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  let closeError;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  const unsupported = operationError && ["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"].includes(operationError?.code);
  if (operationError && !unsupported) {
    if (closeError) throw new AggregateError([operationError, closeError], `Directory sync and close failed: ${directory}`);
    throw operationError;
  }
  if (closeError) throw closeError;
}

export async function acquireLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 120_000;
  const platform = options.platform ?? process.platform;
  const mkdir = options.mkdir ?? fs.mkdir;
  const started = Date.now();
  const token = randomUUID();
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; ; attempt += 1) {
    let mkdirError;
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      mkdirError = error;
    }
    if (mkdirError) {
      const contended = mkdirError?.code === "EEXIST";
      const windowsDeleteRace = platform === "win32" && mkdirError?.code === "EPERM";
      if (!contended && !windowsDeleteRace) throw mkdirError;
      if (contended) await reapStaleLock(lockPath, staleMs, platform);
      if (Date.now() - started >= timeoutMs) {
        const timeout = new Error(`Timed out waiting for lock ${lockPath}`);
        timeout.code = "LOCK_TIMEOUT";
        throw timeout;
      }
      const delay = Math.min(20, 2 + Math.floor(attempt / 3));
      await sleep(delay);
      continue;
    }

    try {
      const owner = { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() };
      await atomicWriteJson(path.join(lockPath, "owner.json"), owner, { mode: 0o600 });
      const heartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.utimes(lockPath, now, now).catch(() => {});
      }, heartbeatMs);
      heartbeat.unref?.();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        // Locks are leases. A stale-lock reaper may already have removed it,
        // which readJson represents as null; other failures remain actionable.
        const current = await readJson(path.join(lockPath, "owner.json"), null);
        if (current?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

async function reapStaleLock(lockPath, staleMs, platform = process.platform) {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= staleMs) return false;
    const owner = await readJson(path.join(lockPath, "owner.json"), null).catch(() => null);
    if (owner?.hostname === os.hostname() && processIsAlive(owner.pid)) return false;
    const staleName = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    await renameWithRetry(lockPath, staleName, { platform });
    await fs.rm(staleName, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    if (platform === "win32" && error?.code === "EPERM") return false;
    throw error;
  }
}

/** Retry Windows rename races without weakening permanent errors elsewhere. */
export async function renameWithRetry(source, destination, options = {}) {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? fs.rename;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(source, destination);
    } catch (error) {
      if (platform !== "win32" || !WINDOWS_TRANSIENT_FS_ERRORS.has(error?.code) || Date.now() - started >= timeoutMs) {
        throw error;
      }
      await sleep(Math.min(50, 5 + attempt * 5));
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function withLock(lockPath, callback, options = {}) {
  const release = await acquireLock(lockPath, options);
  let callbackError;
  let callbackFailed = false;
  try {
    return await callback();
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (releaseError) {
      if (callbackFailed) {
        throw new AggregateError(
          [callbackError, releaseError],
          `Locked operation and lock release both failed: ${lockPath}`,
          { cause: callbackError },
        );
      }
      throw releaseError;
    }
  }
}

export async function appendJsonLine(file, value, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, "a", options.mode ?? 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(options.mode ?? 0o600);
  } finally {
    await handle.close();
  }
}

export async function ensurePrivateFile(file, initial = "") {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(initial, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await fs.chmod(file, 0o600);
}
