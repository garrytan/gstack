import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  cleanupRuntime,
  ensureManagedHome,
  ensureMigrations,
  readJson,
  recoverPendingUpgrade,
  resolveRuntimePaths,
  rollbackUpgrade,
  runDoctor,
  stageUpgrade,
} from "../runtime/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack2 upgrade "));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("gstack 2 upgrade, migration, and cleanup", () => {
  test("upgrade activation is atomic and a failed health check restores last-known-good", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "home with spaces");
    const v1 = path.join(root, "source one");
    const v2 = path.join(root, "source two");
    await fs.mkdir(v1);
    await fs.mkdir(v2);
    await fs.writeFile(path.join(v1, "version.txt"), "one\n");
    await fs.writeFile(path.join(v2, "version.txt"), "two\n");

    const first = await stageUpgrade({ home, sourceDir: v1, version: "2.0.0" });
    expect(first.pointer.current).toBe("2.0.0");
    expect(first.pointer.status).toBe("active");

    let failure: any;
    try {
      await stageUpgrade({
        home,
        sourceDir: v2,
        version: "2.1.0",
        healthCheck: async () => { throw new Error("broken runtime"); },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code).toBe("UPGRADE_ROLLED_BACK");
    const paths = resolveRuntimePaths({ home });
    expect((await readJson(paths.versionPointer)).current).toBe("2.0.0");

    const second = await stageUpgrade({ home, sourceDir: v2, version: "2.1.0" });
    expect(second.pointer).toMatchObject({ current: "2.1.0", lastKnownGood: "2.0.0", status: "active" });
    const rolledBack = await rollbackUpgrade(home);
    expect(rolledBack).toMatchObject({ current: "2.0.0", lastKnownGood: "2.1.0", status: "active" });
  });

  test("an interrupted pending pointer rolls back before it can be selected", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "ok"), "ok");
    await stageUpgrade({ home, sourceDir: source, version: "known-good" });
    const paths = resolveRuntimePaths({ home });
    await atomicWriteJson(paths.versionPointer, {
      schemaVersion: 2,
      status: "pending",
      current: "crashed-version",
      lastKnownGood: "known-good",
    }, { mode: 0o600 });
    const recovered = await recoverPendingUpgrade(home);
    expect(recovered.recovered).toBe(true);
    expect(recovered.pointer).toMatchObject({ status: "active", current: "known-good", recoveredFrom: "crashed-version" });
  });

  test("health checks run while the previous verified pointer remains active", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const firstSource = path.join(root, "first");
    const candidateSource = path.join(root, "candidate");
    await fs.mkdir(firstSource);
    await fs.mkdir(candidateSource);
    await fs.writeFile(path.join(firstSource, "ok"), "first\n");
    await fs.writeFile(path.join(candidateSource, "ok"), "candidate\n");
    await stageUpgrade({ home, sourceDir: firstSource, version: "1.0.0" });
    const paths = resolveRuntimePaths({ home });

    await stageUpgrade({
      home,
      sourceDir: candidateSource,
      version: "2.0.0",
      healthCheck: async () => {
        expect(await readJson(paths.versionPointer)).toMatchObject({ status: "active", current: "1.0.0" });
      },
    });
    expect(await readJson(paths.versionPointer)).toMatchObject({ status: "active", current: "2.0.0" });
  });

  test("raw staging rejects empty and symlinked source directories", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    await expect(stageUpgrade({ home, sourceDir: empty, version: "1.0.0" })).rejects.toMatchObject({
      code: "UPGRADE_SOURCE_INVALID",
    });

    if (process.platform !== "win32") {
      const real = path.join(root, "real");
      const linked = path.join(root, "linked");
      await fs.mkdir(real);
      await fs.writeFile(path.join(real, "ok"), "ok\n");
      await fs.symlink(real, linked, "dir");
      await expect(stageUpgrade({ home, sourceDir: linked, version: "1.0.0" })).rejects.toMatchObject({
        code: "UPGRADE_SOURCE_INVALID",
      });
    }
  });

  test("doctor repairs an interrupted pointer before reporting the selected runtime", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const source = path.join(root, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "ok"), "ok\n");
    await stageUpgrade({ home, sourceDir: source, version: "known-good" });
    const paths = resolveRuntimePaths({ home });
    await atomicWriteJson(paths.versionPointer, {
      schemaVersion: 2,
      status: "pending",
      current: "candidate",
      lastKnownGood: "known-good",
    }, { mode: 0o600 });

    const report = await runDoctor({ home, cwd: root, nodeCommand: "node" });
    expect(report.checks.find((check) => check.id === "upgrade")).toMatchObject({ status: "warn" });
    expect(await readJson(paths.versionPointer)).toMatchObject({ status: "active", current: "known-good" });
  });

  test("forward-only migration refuses a marker from a newer runtime", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const paths = resolveRuntimePaths({ home });
    await fs.mkdir(home, { recursive: true });
    await atomicWriteJson(paths.migrations, { schemaVersion: 999, applied: [] }, { mode: 0o600 });
    let error: any;
    try {
      await ensureMigrations(home);
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("MIGRATION_NEWER_THAN_RUNTIME");
    expect((await readJson(paths.migrations)).schemaVersion).toBe(999);
  });

  test("cleanup dry-run is non-mutating and later removes only stale runtime temporaries", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const paths = resolveRuntimePaths({ home });
    await ensureManagedHome(home);
    await fs.mkdir(paths.tmp, { recursive: true });
    const stale = path.join(paths.tmp, ".state.json.tmp-123-deadbeef");
    const keep = path.join(paths.tmp, "user-data.txt");
    await fs.writeFile(stale, "temporary");
    await fs.writeFile(keep, "keep");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    const preview = await cleanupRuntime(home, { dryRun: true, olderThanMs: 60_000 });
    expect(preview.removed.map((entry) => entry.path)).toContain(stale);
    expect(await fs.readFile(stale, "utf8")).toBe("temporary");
    const result = await cleanupRuntime(home, { olderThanMs: 60_000 });
    expect(result.removed.map((entry) => entry.path)).toContain(stale);
    expect(await fs.readFile(keep, "utf8")).toBe("keep");
    await expect(fs.stat(stale)).rejects.toThrow();
  });
});
