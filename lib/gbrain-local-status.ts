/**
 * gbrain-local-status — classify the local gbrain engine into 6 states.
 *
 * Shared between bin/gstack-gbrain-detect (preamble probe on every skill start)
 * and bin/gstack-gbrain-sync.ts (orchestrator SKIP-when-not-ok semantics).
 * Single source of truth: same probe, same classification, same cache.
 *
 * Per the split-engine plan (D2 + D8):
 *   - Probe: `gbrain sources list --json`. Cheap (~80ms), actually hits the DB.
 *     Uses the same stderr patterns as lib/gbrain-sources.ts:66-67.
 *   - Cache: 60s TTL at ~/.gstack/.gbrain-local-status-cache.json, keyed on
 *     {home, gbrain_home, path_hash, gbrain_bin_path, gbrain_version,
 *     config_mtime, probe_timeout_ms}.
 *   - --no-cache bypass: /setup-gbrain and /sync-gbrain pass it after any
 *     state-mutating operation so the next read sees fresh status.
 *
 * No-cli  → gbrain not on PATH.
 * Missing → CLI present, config.json absent (honors GBRAIN_HOME).
 * Broken-config → config exists but `gbrain sources list` fails with config parse error
 *                 (or any non-recognized error — defensive default per codex #8).
 * Broken-db → config exists, DB unreachable per stderr classification.
 * Timeout → probe exceeded GSTACK_GBRAIN_PROBE_TIMEOUT_MS (default 15s) with no
 *           recognized error — engine is likely healthy but slow (e.g. a cold
 *           pooler connection, #1964). Consumers treat this as usable.
 * Ok → DB reachable, sources list returned valid JSON.
 */

import { execFileSync } from "child_process";
import {
  createHash,
} from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { buildGbrainEnv, NEEDS_SHELL_ON_WINDOWS } from "./gbrain-exec";

export type LocalEngineStatus =
  | "ok"
  | "no-cli"
  | "missing-config"
  | "broken-config"
  | "broken-db"
  | "timeout";

export interface ClassifyOptions {
  /** Bypass the 60s cache. Used after any state-mutating operation. */
  noCache?: boolean;
  /** Env override for the spawned `gbrain` (used by tests to point at a fake binary). */
  env?: NodeJS.ProcessEnv;
}

interface CacheEntry {
  // Local-cache schema version, controlled by gstack. Not to be confused
  // with `gbrain doctor --json` output schema_version (gbrain v0.25+ emits
  // schema_version: 2). Doctor-output parsing lives in
  // lib/gstack-memory-helpers.ts:freshDetectEngineTier and accepts both
  // doctor-output versions. This cache stays strictly at version 1 — a
  // future shape change here requires an explicit migration.
  schema_version: 1;
  status: LocalEngineStatus;
  cached_at: number;
  /** Cache invariants — entry is invalidated if any of these change between writes. */
  key: {
    home: string;
    gbrain_home: string; // honors GBRAIN_HOME (#1964 / codex D11)
    path_hash: string;
    gbrain_bin_path: string;
    gbrain_version: string;
    config_mtime: number; // 0 when config absent
    config_size: number; // 0 when config absent
    probe_timeout_ms: number; // raising the timeout invalidates a cached "timeout"
  };
}

export const CACHE_TTL_MS = 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Effective probe timeout. `GSTACK_GBRAIN_PROBE_TIMEOUT_MS` overrides the
 * 15s default (tests set it low; users with slow poolers raise it).
 * Non-numeric or non-positive values fall back to the default.
 */
export function probeTimeoutMs(env?: NodeJS.ProcessEnv): number {
  const raw = (env ?? process.env).GSTACK_GBRAIN_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROBE_TIMEOUT_MS;
  // Floor of 1ms: Math.floor(0.5) would yield 0, and execFileSync treats
  // timeout: 0 as NO timeout — the probe that exists to bound hangs would
  // itself hang forever (adversarial review finding 2).
  return Math.max(1, Math.floor(parsed));
}

/** Effective user home — respects HOME env override (used by tests). */
function userHome(env?: NodeJS.ProcessEnv): string {
  return (env ?? process.env).HOME || homedir();
}

/** Cache path computed fresh on each call so tests can mutate GSTACK_HOME per case. */
export function cacheFilePath(): string {
  return join(
    process.env.GSTACK_HOME || join(userHome(), ".gstack"),
    ".gbrain-local-status-cache.json",
  );
}

/** Honors GBRAIN_HOME (codex D11) — same resolution as buildGbrainEnv. */
function gbrainConfigPath(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const gbrainHome = e.GBRAIN_HOME || join(userHome(e), ".gbrain");
  return join(gbrainHome, "config.json");
}

function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

/**
 * Resolve the absolute path of `gbrain` on PATH. Returns null when missing.
 * Memoized per-process keyed on PATH so detect's call and the classifier's
 * call share one fork-exec (~200ms saved per skill preamble).
 */
const _gbrainBinCache = new Map<string, string | null>();
export function resolveGbrainBin(env?: NodeJS.ProcessEnv): string | null {
  const e = env ?? process.env;
  const key = e.PATH || "";
  if (_gbrainBinCache.has(key)) return _gbrainBinCache.get(key)!;
  let result: string | null = null;
  try {
    execFileSync("gbrain", ["--version"], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "ignore", "ignore"],
      env: e,
      shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
    });
    result = "gbrain";
  } catch {
    result = null;
  }
  _gbrainBinCache.set(key, result);
  return result;
}

/** Memoized per-process. */
const _gbrainVersionCache = new Map<string, string>();
export function readGbrainVersion(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  const key = `${e.PATH || ""}|${resolveGbrainBin(e) || ""}`;
  if (_gbrainVersionCache.has(key)) return _gbrainVersionCache.get(key)!;
  let result = "";
  try {
    const out = execFileSync("gbrain", ["--version"], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: e,
      shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
    });
    result = out.trim().split("\n")[0] || "";
  } catch {
    result = "";
  }
  _gbrainVersionCache.set(key, result);
  return result;
}

function configFingerprint(env?: NodeJS.ProcessEnv): { mtime: number; size: number } {
  try {
    const st = statSync(gbrainConfigPath(env));
    return { mtime: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return { mtime: 0, size: 0 };
  }
}

function buildCacheKey(
  gbrainBin: string | null,
  gbrainVersion: string,
  env?: NodeJS.ProcessEnv,
): CacheEntry["key"] {
  const e = env ?? process.env;
  const config = configFingerprint(e);
  return {
    home: e.HOME || "",
    gbrain_home: e.GBRAIN_HOME || "",
    path_hash: hashPath(e.PATH || ""),
    gbrain_bin_path: gbrainBin || "",
    gbrain_version: gbrainVersion,
    config_mtime: config.mtime,
    config_size: config.size,
    probe_timeout_ms: probeTimeoutMs(e),
  };
}

function keysEqual(a: CacheEntry["key"], b: CacheEntry["key"]): boolean {
  return (
    a.home === b.home &&
    a.gbrain_home === b.gbrain_home &&
    a.path_hash === b.path_hash &&
    a.gbrain_bin_path === b.gbrain_bin_path &&
    a.gbrain_version === b.gbrain_version &&
    a.config_mtime === b.config_mtime &&
    a.config_size === b.config_size &&
    a.probe_timeout_ms === b.probe_timeout_ms
  );
}

function readCache(key: CacheEntry["key"]): LocalEngineStatus | null {
  if (!existsSync(cacheFilePath())) return null;
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(), "utf-8")) as CacheEntry;
    if (raw.schema_version !== 1) return null;
    if (Date.now() - raw.cached_at > CACHE_TTL_MS) return null;
    if (!keysEqual(raw.key, key)) return null;
    return raw.status;
  } catch {
    return null;
  }
}

function writeCache(status: LocalEngineStatus, key: CacheEntry["key"]): void {
  const entry: CacheEntry = {
    schema_version: 1,
    status,
    cached_at: Date.now(),
    key,
  };
  try {
    mkdirSync(dirname(cacheFilePath()), { recursive: true });
    const tmp = cacheFilePath() + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf-8");
    renameSync(tmp, cacheFilePath());
  } catch {
    // Cache write failure is non-fatal — we re-probe next call.
  }
}

/**
 * Probe via `gbrain sources list --json`. Classify the outcome.
 *
 * Pattern strings ("Cannot connect to database", "config.json") are deliberately
 * the same strings used in lib/gbrain-sources.ts:66-67. If gbrain reworks its
 * error messages, classifier returns broken-config defensively (codex #8).
 */
function freshClassify(env?: NodeJS.ProcessEnv): LocalEngineStatus {
  // 1. CLI on PATH?
  const gbrainBin = resolveGbrainBin(env);
  if (!gbrainBin) return "no-cli";

  // 2. Config file present?
  if (!existsSync(gbrainConfigPath(env))) return "missing-config";

  // 3. Probe gbrain sources list.
  //
  // Seed DATABASE_URL from ~/.gbrain/config.json (via buildGbrainEnv, the
  // same helper the sync orchestrator uses in lib/gbrain-exec.ts). Without
  // this, Bun autoloads a project's .env when the probe runs inside a repo
  // that defines its own DATABASE_URL (e.g. an app DB on a different port),
  // gbrain connects to the wrong DB, and the classifier falsely reports
  // broken-db. This also makes the result cwd-independent, so the 60s cache
  // can no longer propagate a poisoned negative to clean directories.
  try {
    execFileSync("gbrain", ["sources", "list", "--json"], {
      encoding: "utf-8",
      timeout: probeTimeoutMs(env),
      stdio: ["ignore", "pipe", "pipe"],
      env: buildGbrainEnv({ baseEnv: env ?? process.env }),
      shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
    });
    return "ok";
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: Buffer | string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const stderr = (e.stderr ? e.stderr.toString() : "") || "";

    // ENOENT can happen if gbrain disappeared between resolveGbrainBin and now.
    if (e.code === "ENOENT") return "no-cli";

    // Pattern match against gbrain's known error strings. Order matters:
    // "Cannot connect to database" is the more specific DB-unreachable signal.
    if (stderr.includes("Cannot connect to database")) return "broken-db";
    if (stderr.includes("config.json")) return "broken-config";

    // Probe killed by the timeout with no recognized error: the engine is
    // most likely healthy but slow (cold pooler connections measured at
    // 6.9-10.7s in #1964). Don't tell the user their config is malformed.
    if (e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      return "timeout";
    }

    // Defensive default per codex #8: unrecognized failures classify as
    // broken-config so the user sees the raw stderr surfaced upstream.
    return "broken-config";
  }
}

/**
 * Classify the local gbrain engine status. Cached for 60s; bypassable.
 *
 * Returns one of 5 states. Never throws — failure modes are surfaced as states.
 */
export function localEngineStatus(opts: ClassifyOptions = {}): LocalEngineStatus {
  const env = opts.env ?? process.env;
  const gbrainBin = resolveGbrainBin(env);
  const gbrainVersion = gbrainBin ? readGbrainVersion(env) : "";
  const key = buildCacheKey(gbrainBin, gbrainVersion, env);

  if (!opts.noCache) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const fresh = freshClassify(env);
  writeCache(fresh, key);
  return fresh;
}
