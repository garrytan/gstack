import path from "node:path";
import { atomicWriteJson, readJson, withLock } from "./storage.js";
import { resolveRuntimePaths } from "./paths.js";

export const RUNTIME_SCHEMA_VERSION = 2;
export const RUNTIME_MIGRATION_ID = "2.0.0-host-neutral-runtime";

export async function ensureMigrations(home, options = {}) {
  const paths = resolveRuntimePaths({ home });
  return withLock(path.join(paths.locks, "migration.lock"), async () => {
    const existing = await readJson(paths.migrations, null);
    if (existing?.schemaVersion > RUNTIME_SCHEMA_VERSION) {
      const error = new Error(
        `State schema ${existing.schemaVersion} is newer than this runtime supports (${RUNTIME_SCHEMA_VERSION})`,
      );
      error.code = "MIGRATION_NEWER_THAN_RUNTIME";
      throw error;
    }

    if (existing?.schemaVersion === RUNTIME_SCHEMA_VERSION &&
        existing.applied?.some((entry) => entry.id === RUNTIME_MIGRATION_ID)) {
      return existing;
    }

    const now = (options.now ?? (() => new Date()))().toISOString();
    const marker = {
      format: "gstack-forward-migrations",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      direction: "forward-only",
      applied: [
        ...(Array.isArray(existing?.applied) ? existing.applied : []),
        { id: RUNTIME_MIGRATION_ID, appliedAt: now },
      ].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index),
      updatedAt: now,
    };
    await atomicWriteJson(paths.migrations, marker, { mode: 0o600 });
    return marker;
  });
}
