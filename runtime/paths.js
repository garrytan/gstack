import os from "node:os";
import path from "node:path";

/**
 * Resolve the one and only gstack state root.
 *
 * This deliberately does not consult host-specific variables such as
 * CLAUDE_PLUGIN_DATA. GSTACK_HOME wins; otherwise state lives in ~/.gstack.
 * Values are handled as paths, never evaluated by a shell.
 */
export function resolveGstackHome(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  let configured = env.GSTACK_HOME;

  if (configured != null && configured.includes("\0")) {
    throw new TypeError("GSTACK_HOME must not contain a NUL byte");
  }

  if (configured == null || configured === "") {
    if (!homeDir) throw new Error("Unable to resolve a home directory for ~/.gstack");
    configured = path.join(homeDir, ".gstack");
  } else if (configured === "~" || configured.startsWith(`~${path.sep}`)) {
    if (!homeDir) throw new Error("Unable to expand ~ in GSTACK_HOME");
    configured = path.join(homeDir, configured.slice(2));
  }

  return path.normalize(path.resolve(cwd, configured));
}

export function resolveRuntimePaths(options = {}) {
  const home = options.home ?? resolveGstackHome(options);
  return Object.freeze({
    home,
    config: path.join(home, "config.json"),
    secrets: path.join(home, "secrets.json"),
    migrations: path.join(home, "migration.json"),
    projects: path.join(home, "projects"),
    locks: path.join(home, "locks"),
    tmp: path.join(home, "tmp"),
    plans: path.join(home, "plans"),
    versions: path.join(home, "versions"),
    versionPointer: path.join(home, "versions", "current.json"),
  });
}

/** POSIX-shell literal used only by the legacy gstack-paths adapter. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function projectPaths(home, projectId) {
  assertSafeId(projectId, "project id");
  const root = path.join(home, "projects", projectId);
  return Object.freeze({
    root,
    state: path.join(root, "state.json"),
    timeline: path.join(root, "timeline.jsonl"),
    decisions: path.join(root, "decisions.jsonl"),
    evidence: path.join(root, "evidence"),
    artifacts: path.join(root, "artifacts"),
    reviews: path.join(root, "reviews"),
    checkpoints: path.join(root, "checkpoints"),
    lock: path.join(root, ".state.lock"),
  });
}

export function assertSafeId(value, label = "id") {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

/** Return candidate only when it is strictly inside root. */
export function assertPathInside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (relative === "" || relative === ".") return target;
  if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Path escapes gstack home: ${target}`);
  }
  return target;
}
