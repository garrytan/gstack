/**
 * gbrain-repo-policy-client — the ONE TypeScript client for the per-remote
 * trust store (bin/gstack-gbrain-repo-policy, a bash CLI that owns URL
 * normalization and schema migration — do not reimplement either here).
 *
 * Extracted because two call sites (lib/code-intelligence/selection.ts consent
 * veto; bin/gstack-gbrain-sync.ts code-import gate) each spawnSync'd the script
 * themselves and had started to drift. On win32, spawning a
 * `#!/usr/bin/env bash` script directly fails ENOENT, which both sites'
 * fail-closed paths then reported as "store could not be read" for EVERY repo
 * — so this client invokes the script through `bash` there (an ENOENT then
 * genuinely means "no bash on PATH") and reports a spawn failure distinctly
 * from a policy-read failure, so callers can say what actually broke.
 *
 * POLARITY IS THE CALLER'S. This client only reads and classifies; each call
 * site keeps its own fail-open / fail-closed decision on `error`.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type RepoPolicyTierValue = "deny" | "read-only" | "read-write" | "none";

export interface RepoPolicyResult {
  /** `none` = no policy store, no remote URL, or no entry for this remote. */
  tier: RepoPolicyTierValue;
  /**
   * Set when the tier could not be determined (tier is `none` then):
   *  - `spawn-failed`: the policy script could not be executed at all
   *    (script missing, or no bash on PATH on win32) — the store itself may
   *    be perfectly fine.
   *  - `unreadable`: the script ran but could not read the store
   *    (permissions, corruption, unexpected output).
   */
  error?: "unreadable" | "spawn-failed";
}

/** Absolute path of the policy store for this env (GSTACK_HOME-aware). */
export function repoPolicyStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GSTACK_HOME || join(env.HOME || homedir(), ".gstack");
  return join(home, "gbrain-repo-policy.json");
}

/** No store on disk = no policy was ever set (the fast path — no subprocess). */
export function hasRepoPolicyStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(repoPolicyStorePath(env));
}

/** The bash script that owns the store — resolved relative to this file (lib/ → bin/), never cwd. */
const POLICY_SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-repo-policy");

/**
 * Trust tier for a remote URL, via `gstack-gbrain-repo-policy get <url>`.
 *
 * Fast paths (no subprocess): no store on disk → `none`; no remote URL →
 * `none` (policy is keyed by origin remote, so nothing can be set for the
 * repo). Everything else shells to the script, which owns normalization.
 */
export function repoPolicyTier(url: string | null, env: NodeJS.ProcessEnv = process.env): RepoPolicyResult {
  if (!hasRepoPolicyStore(env)) return { tier: "none" };
  if (!url) return { tier: "none" };
  // The script is `#!/usr/bin/env bash`; win32 can't exec a shebang file, so
  // invoke through bash there. An ENOENT then means bash is not on PATH.
  const [cmd, args]: [string, string[]] =
    process.platform === "win32" ? ["bash", [POLICY_SCRIPT, "get", url]] : [POLICY_SCRIPT, ["get", url]];
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: 10_000,
    // Explicit env: Bun's spawnSync default env snapshot misses runtime
    // process.env mutations (e.g. tests redirecting GSTACK_HOME).
    env: { ...env } as NodeJS.ProcessEnv,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return { tier: "none", error: code === "ENOENT" ? "spawn-failed" : "unreadable" };
  }
  if (res.status !== 0) return { tier: "none", error: "unreadable" };
  const tier = (res.stdout || "").trim();
  if (tier === "deny" || tier === "read-only" || tier === "read-write") return { tier };
  if (tier === "unset") return { tier: "none" };
  return { tier: "none", error: "unreadable" }; // unexpected output — a read failure, not a tier
}

/**
 * Bulk trust-tier lookup via `gstack-gbrain-repo-policy get --batch` — ONE
 * spawn total for the whole url list (memory-ingest checks every distinct
 * transcript remote in a run; per-url spawns would fork N bash+jq processes).
 *
 * The deduped url list goes to the script's stdin, one per line; the script
 * answers one tier per line in input order (`none` where single `get` says
 * `unset`). Fast paths mirror repoPolicyTier: no store on disk → every url
 * is `{ tier: "none" }` with no subprocess.
 *
 * Failure classification matches repoPolicyTier (spawn ENOENT →
 * `spawn-failed`, everything else → `unreadable`), applied to EVERY url: a
 * malformed, incomplete, or timed-out batch (wrong line count, unknown tier
 * token, non-zero exit) maps every url to `{ tier: "none", error:
 * "unreadable" }`. POLARITY IS STILL THE CALLER'S — this client only reads
 * and classifies.
 */
export function repoPolicyTierBatch(
  urls: string[],
  env: NodeJS.ProcessEnv = process.env,
): Map<string, RepoPolicyResult> {
  const out = new Map<string, RepoPolicyResult>();
  const distinct = [...new Set(urls)];
  if (distinct.length === 0) return out;
  if (!hasRepoPolicyStore(env)) {
    for (const u of distinct) out.set(u, { tier: "none" });
    return out;
  }
  const allWithError = (error: "unreadable" | "spawn-failed"): Map<string, RepoPolicyResult> => {
    for (const u of distinct) out.set(u, { tier: "none", error });
    return out;
  };
  // Same win32 bash-wrapping as repoPolicyTier: the script is
  // `#!/usr/bin/env bash`, which win32 can't exec directly.
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["bash", [POLICY_SCRIPT, "get", "--batch"]]
      : [POLICY_SCRIPT, ["get", "--batch"]];
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: 10_000,
    input: distinct.join("\n") + "\n",
    env: { ...env } as NodeJS.ProcessEnv,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return allWithError(code === "ENOENT" ? "spawn-failed" : "unreadable");
  }
  if (res.status !== 0) return allWithError("unreadable");
  const lines = (res.stdout || "").replace(/\n$/, "").split("\n");
  if (lines.length !== distinct.length) return allWithError("unreadable");
  const parsed: RepoPolicyResult[] = [];
  for (const raw of lines) {
    const tier = raw.trim();
    if (tier === "deny" || tier === "read-only" || tier === "read-write") {
      parsed.push({ tier });
    } else if (tier === "none") {
      parsed.push({ tier: "none" });
    } else {
      // Unknown token anywhere poisons the whole batch — a partially-garbled
      // response can't be trusted line-by-line (the ordering itself may be off).
      return allWithError("unreadable");
    }
  }
  for (let i = 0; i < distinct.length; i++) out.set(distinct[i], parsed[i]);
  return out;
}
