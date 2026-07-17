import fs from "node:fs/promises";
import { resolveRuntimePaths } from "./paths.js";
import { ensureConfig } from "./config.js";
import { ensureMigrations } from "./migrations.js";
import { discoverProjectIdentity } from "./identity.js";
import { initializeProject } from "./state.js";
import { ensureManagedHome, recoverRuntimeTransactionUnlocked, withRuntimeLifecycleLock } from "./managed-home.js";

export async function setupRuntime(options = {}) {
  const paths = resolveRuntimePaths(options);
  return withRuntimeLifecycleLock(paths.home, async () => {
    await ensureManagedHome(paths.home, options);
    await recoverRuntimeTransactionUnlocked(paths.home);
    await fs.chmod(paths.home, 0o700).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
    await Promise.all([
      fs.mkdir(paths.projects, { recursive: true, mode: 0o700 }),
      fs.mkdir(paths.locks, { recursive: true, mode: 0o700 }),
      fs.mkdir(paths.tmp, { recursive: true, mode: 0o700 }),
      fs.mkdir(paths.versions, { recursive: true, mode: 0o700 }),
    ]);
    const { config } = await ensureConfig(paths.home);
    const migration = await ensureMigrations(paths.home, options);
    const identity = await discoverProjectIdentity(options.cwd ?? process.cwd(), options);
    const project = await initializeProject(paths.home, identity, options);
    return { paths, config, migration, identity, project: project.state };
  }, options);
}
