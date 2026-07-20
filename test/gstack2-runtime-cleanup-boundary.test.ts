import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostname } from "node:os";
import {
  acquireLock,
  cleanupRuntime,
  ensureManagedHome,
  pathExists,
  renameWithRetry,
  resolveRuntimePaths,
  runtimeLifecycleLockPath,
  syncDirectory,
} from "../runtime/index.js";

const roots: string[] = [];

async function temporaryHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack2-cleanup-boundary-"));
  roots.push(root);
  const home = path.join(root, "home");
  await ensureManagedHome(home);
  return home;
}

async function makeOld(target: string) {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(target, old, old);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime cleanup boundary", () => {
  test("immediately reclaims a same-host lock whose owner PID is dead", async () => {
    const home = await temporaryHome();
    const lockPath = runtimeLifecycleLockPath(home);
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    }));
    const started = Date.now();
    const release = await acquireLock(lockPath, { staleMs: 60 * 60 * 1000, timeoutMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    await release();
  });

  test("retries transient Windows lock creation and rename races", async () => {
    const home = await temporaryHome();
    const lockPath = path.join(home, "locks", "windows-race.lock");
    let mkdirAttempts = 0;
    let releaseOptions: Record<string, unknown> | undefined;
    const release = await acquireLock(lockPath, {
      platform: "win32",
      mkdir: async (target: string, options: Record<string, unknown>) => {
        if (target === lockPath && mkdirAttempts++ === 0) {
          throw Object.assign(new Error("simulated Windows delete race"), { code: "EPERM" });
        }
        return fs.mkdir(target, options);
      },
      rm: async (target: string, options: Record<string, unknown>) => {
        releaseOptions = options;
        return fs.rm(target, options);
      },
    });
    expect(mkdirAttempts).toBe(2);
    await release();
    expect(releaseOptions).toMatchObject({ recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    await expect(acquireLock(path.join(home, "locks", "permanently-denied.lock"), {
      platform: "win32",
      transientPermissionMs: 20,
      mkdir: async (target: string, options: Record<string, unknown>) => {
        if (target.endsWith("permanently-denied.lock")) {
          throw Object.assign(new Error("permanent permission denial"), { code: "EPERM" });
        }
        return fs.mkdir(target, options);
      },
    })).rejects.toMatchObject({ code: "EPERM" });

    let renameAttempts = 0;
    await renameWithRetry("source", "destination", {
      platform: "win32",
      timeoutMs: 100,
      rename: async () => {
        if (renameAttempts++ < 2) throw Object.assign(new Error("simulated scanner race"), { code: "EPERM" });
      },
    });
    expect(renameAttempts).toBe(3);
  });

  test("closes a directory handle when Windows does not support directory fsync", async () => {
    let closes = 0;
    await expect(syncDirectory("fixture", {
      open: async () => ({
        sync: async () => { throw Object.assign(new Error("unsupported directory sync"), { code: "EPERM" }); },
        close: async () => { closes += 1; },
      }),
    })).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });

  test("removes only allowlisted stale runtime scratch and dead locks", async () => {
    const home = await temporaryHome();
    const paths = resolveRuntimePaths({ home });
    const installScratch = path.join(paths.tmp, "install-11111111-1111-4111-8111-111111111111");
    const uninstallScratch = path.join(paths.tmp, "uninstall-22222222-2222-4222-8222-222222222222");
    const stage = path.join(paths.versions, ".stage-2.0.0-33333333-3333-4333-8333-333333333333");
    const deadLock = path.join(paths.locks, "migration.lock");
    await fs.mkdir(installScratch, { recursive: true });
    await fs.mkdir(uninstallScratch, { recursive: true });
    await fs.mkdir(stage, { recursive: true });
    await fs.mkdir(deadLock, { recursive: true });
    await fs.writeFile(path.join(deadLock, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    await Promise.all([installScratch, uninstallScratch, stage, deadLock].map(makeOld));

    const result = await cleanupRuntime(home, { olderThanMs: 60_000 });
    expect(result.removed.map((entry) => entry.path).sort()).toEqual([
      deadLock,
      installScratch,
      stage,
      uninstallScratch,
    ].sort());
    for (const candidate of [installScratch, uninstallScratch, stage, deadLock]) {
      expect(await pathExists(candidate)).toBe(false);
    }
  });

  test("never traverses project data, plans, or active versions", async () => {
    const home = await temporaryHome();
    const paths = resolveRuntimePaths({ home });
    const protectedFiles = [
      path.join(paths.projects, "example", "artifacts", ".report.tmp-123-deadbeef"),
      path.join(paths.projects, "example", "install-11111111-1111-4111-8111-111111111111"),
      path.join(paths.plans, ".draft.tmp-123-deadbeef"),
      path.join(paths.versions, "2.0.0", ".state.json.tmp-123-deadbeef"),
    ];
    for (const file of protectedFiles) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "keep\n");
      await makeOld(file);
    }

    const result = await cleanupRuntime(home, { olderThanMs: 60_000 });
    expect(result.removed).toEqual([]);
    for (const file of protectedFiles) expect(await fs.readFile(file, "utf8")).toBe("keep\n");
  });

  test("preserves live locks and skips symlinked scratch", async () => {
    const home = await temporaryHome();
    const paths = resolveRuntimePaths({ home });
    const liveLock = path.join(paths.locks, "config.lock");
    const outside = path.join(path.dirname(home), "outside");
    const linkedScratch = path.join(paths.tmp, "install-44444444-4444-4444-8444-444444444444");
    await fs.mkdir(liveLock, { recursive: true });
    await fs.writeFile(path.join(liveLock, "owner.json"), JSON.stringify({ pid: process.pid }));
    await makeOld(liveLock);
    if (process.platform !== "win32") {
      await fs.mkdir(paths.tmp, { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "sentinel"), "keep");
      await fs.symlink(outside, linkedScratch, "dir");
    }

    const result = await cleanupRuntime(home, { olderThanMs: 60_000 });
    expect(result.removed).toEqual([]);
    expect(await pathExists(liveLock)).toBe(true);
    if (process.platform !== "win32") {
      expect(result.skipped).toContainEqual({ path: linkedScratch, reason: "symlink" });
      expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("keep");
    }
  });

  test("cannot reap install scratch while the installer lifecycle lock is held", async () => {
    const home = await temporaryHome();
    const paths = resolveRuntimePaths({ home });
    const installScratch = path.join(paths.tmp, "install-55555555-5555-4555-8555-555555555555");
    await fs.mkdir(installScratch, { recursive: true });
    await makeOld(installScratch);
    const release = await acquireLock(runtimeLifecycleLockPath(home), { staleMs: 60_000 });
    let caught: any;
    try {
      await cleanupRuntime(home, {
        olderThanMs: 0,
        lockOptions: { timeoutMs: 20, staleMs: 60_000 },
      });
    } catch (error) {
      caught = error;
    } finally {
      await release();
    }
    expect(caught?.code).toBe("LOCK_TIMEOUT");
    expect(await pathExists(installScratch)).toBe(true);
  });

  test("never follows a symlinked runtime scratch root", async () => {
    if (process.platform === "win32") return;
    const home = await temporaryHome();
    const paths = resolveRuntimePaths({ home });
    const outside = path.join(path.dirname(home), "outside-tmp");
    const outsideScratch = path.join(outside, "install-66666666-6666-4666-8666-666666666666");
    await fs.mkdir(outsideScratch, { recursive: true });
    await makeOld(outsideScratch);
    await fs.mkdir(home, { recursive: true });
    await fs.symlink(outside, paths.tmp, "dir");

    const result = await cleanupRuntime(home, { olderThanMs: 0 });
    expect(result.skipped).toContainEqual({ path: paths.tmp, reason: "symlink-directory" });
    expect(await pathExists(outsideScratch)).toBe(true);
  });
});

describe("pathExists error semantics", () => {
  test("returns false for absent paths and a non-directory parent", async () => {
    const home = await temporaryHome();
    expect(await pathExists(path.join(home, "missing"))).toBe(false);
    await fs.mkdir(home, { recursive: true });
    const file = path.join(home, "file");
    await fs.writeFile(file, "x");
    expect(await pathExists(path.join(file, "child"))).toBe(false);
  });

  test("propagates errors other than ENOENT and ENOTDIR", async () => {
    await expect(pathExists("bad\0path")).rejects.toThrow();
  });
});
