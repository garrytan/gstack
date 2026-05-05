/**
 * gbrain-sources — TypeScript helper for idempotent gbrain federated source registration.
 *
 * Mirrors the bash logic in bin/gstack-gbrain-source-wireup:204-310 but in a form
 * importable by other TS callers (currently bin/gstack-gbrain-sync.ts; future
 * callers welcome). gbrain has no `sources update` — drift recovery is
 * `sources remove` followed by `sources add`.
 *
 * Per /plan-eng-review D3 (DRY extraction).
 */

import { execFileSync, spawnSync } from "child_process";
import { withErrorContext } from "./gstack-memory-helpers";

export interface SourceState {
  /** "absent" — id not registered. "match" — id at expected path. "drift" — id at different path. */
  status: "absent" | "match" | "drift";
  /** Path gbrain has registered for this id. Only set when status !== "absent". */
  registered_path?: string;
}

export interface EnsureResult {
  /** True if registration state changed (added or re-registered). False on no-op. */
  changed: boolean;
  /** Final source state after the call. */
  state: SourceState;
}

export interface EnsureOptions {
  /** Pass --federated to `gbrain sources add`. Default false. */
  federated?: boolean;
  /** When status=drift, force a remove+add to update the registered path. Default true. */
  reregister_on_drift?: boolean;
  /**
   * Optional env override for the spawned `gbrain` calls. Production callers
   * leave this unset (inherit process.env). Tests pass a custom env to point
   * at a fake `gbrain` on PATH (Bun's execFileSync does not respect runtime
   * mutations of process.env.PATH unless env is passed explicitly).
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Probe the registration state of a source by id.
 *
 * Errors:
 *   - "gbrain CLI not on PATH" (exit 127) — caller should treat as absent + skip stage.
 *   - "gbrain DB connection failed" — caller should treat as absent + skip stage.
 *   - JSON parse error — propagate via withErrorContext caller.
 */
export function probeSource(id: string, env?: NodeJS.ProcessEnv): SourceState {
  let stdout: string;
  try {
    stdout = execFileSync("gbrain", ["sources", "list", "--json"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr?.toString() || "";
    if (e.code === "ENOENT" || stderr.includes("command not found")) {
      throw new Error("gbrain CLI not on PATH");
    }
    if (stderr.includes("Cannot connect to database") || stderr.includes("config.json")) {
      throw new Error("gbrain not configured (run /setup-gbrain)");
    }
    throw err;
  }

  let parsed: { sources?: Array<{ id?: string; local_path?: string }> };
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gbrain sources list returned non-JSON output: ${(err as Error).message}`);
  }

  const sources = parsed.sources || [];
  const match = sources.find((s) => s.id === id);
  if (!match) return { status: "absent" };
  return {
    status: "match",
    registered_path: match.local_path,
  };
}

/**
 * Ensure source <id> is registered at <path>. Idempotent.
 *
 * Behavior:
 *   - status=absent  → `gbrain sources add <id> --path <path> [--federated]`, returns changed=true.
 *   - status=match + same path → no-op, returns changed=false.
 *   - status=match + different path → `sources remove` + `sources add`, returns changed=true.
 *     (Skip when reregister_on_drift=false; returns changed=false.)
 *
 * Caller is responsible for catching errors. The function uses withErrorContext for
 * forensic logging to ~/.gstack/.gbrain-errors.jsonl.
 */
export async function ensureSourceRegistered(
  id: string,
  path: string,
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  const federated = options.federated ?? false;
  const reregister_on_drift = options.reregister_on_drift ?? true;
  const env = options.env;

  return withErrorContext(`ensureSourceRegistered:${id}`, () => {
    const probed = probeSource(id, env);

    // Disambiguate match-but-different-path
    let state: SourceState = probed;
    if (probed.status === "match" && probed.registered_path !== path) {
      state = { status: "drift", registered_path: probed.registered_path };
    }

    if (state.status === "match") {
      return { changed: false, state };
    }

    if (state.status === "drift" && !reregister_on_drift) {
      return { changed: false, state };
    }

    // For drift, remove first.
    if (state.status === "drift") {
      const rm = spawnSync("gbrain", ["sources", "remove", id, "--yes"], {
        encoding: "utf-8",
        timeout: 30_000,
        env,
      });
      if (rm.status !== 0) {
        throw new Error(`gbrain sources remove ${id} failed: ${rm.stderr || rm.stdout || `exit ${rm.status}`}`);
      }
    }

    // Add.
    const addArgs = ["sources", "add", id, "--path", path];
    if (federated) addArgs.push("--federated");
    const add = spawnSync("gbrain", addArgs, {
      encoding: "utf-8",
      timeout: 30_000,
      env,
    });
    if (add.status !== 0) {
      throw new Error(`gbrain sources add ${id} failed: ${add.stderr || add.stdout || `exit ${add.status}`}`);
    }

    return {
      changed: true,
      state: { status: "match", registered_path: path },
    };
  }, "gbrain-sources");
}

/**
 * Get page_count for a registered source. Returns null if source is absent or if
 * page_count is missing/invalid in the JSON. Used by the verdict block + preamble
 * variant selection.
 */
export function sourcePageCount(id: string, env?: NodeJS.ProcessEnv): number | null {
  let stdout: string;
  try {
    stdout = execFileSync("gbrain", ["sources", "list", "--json"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(stdout) as { sources?: Array<{ id?: string; page_count?: number }> };
    const match = (parsed.sources || []).find((s) => s.id === id);
    if (!match) return null;
    if (typeof match.page_count !== "number") return null;
    return match.page_count;
  } catch {
    return null;
  }
}
