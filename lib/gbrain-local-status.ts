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
 * Engine-locked → PGLite probe hit gbrain's own connect timeout, usually
 *                 because another `gbrain serve` process owns the embedded DB.
 * Timeout → probe exceeded GSTACK_GBRAIN_PROBE_TIMEOUT_MS (default 15s) with no
 *           recognized error — engine is likely healthy but slow (e.g. a cold
 *           pooler connection, #1964). Consumers treat this as usable.
 * Thin-client → config carries gbrain's remote_mcp marker (#2051), OR the
 *           agent host's MCP registration is remote-HTTP-only (#2520 — bearer
 *           installs via `gbrain connect --token` never get the marker): NO
 *           local engine by design; queries go to a remote-HTTP MCP brain.
 *           Usable for brain-aware prose gates; sync stages that need a LOCAL
 *           engine (code/memory/dream) skip. Remote reachability is verified
 *           at USE time (gbrain calls degrade gracefully), never by a
 *           classifier network probe — that's the #1964 pathology.
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
  statSync,
} from "fs";
import { atomicWriteSync } from "./fs-atomic";
import { homedir } from "os";
import { dirname, join } from "path";
import { buildGbrainEnv, gbrainConfigDir, NEEDS_SHELL_ON_WINDOWS } from "./gbrain-exec";

export type LocalEngineStatus =
  | "ok"
  | "no-cli"
  | "missing-config"
  | "broken-config"
  | "broken-db"
  | "engine-locked"
  | "timeout"
  | "thin-client";

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

/**
 * Honors GBRAIN_HOME (codex D11) with gbrain's own configDir() semantics
 * (#2521): GBRAIN_HOME is a parent dir, `.gbrain` is appended. Same
 * resolution as buildGbrainEnv — both route through gbrainConfigDir.
 */
function gbrainConfigPath(env?: NodeJS.ProcessEnv): string {
  const e = env ?? process.env;
  return join(gbrainConfigDir(e), "config.json");
}

/**
 * Bearer-token thin-client evidence (#2520). `gbrain connect <url> --token`
 * registers a remote-HTTP MCP server with the agent host but never writes
 * gbrain's remote_mcp marker into config.json — that marker is OAuth-only,
 * written by `gbrain init --mcp-only`. So the config-file marker check misses
 * bearer installs entirely: they fall through to the local probe, which fails
 * against the dead-or-absent local engine and lands on missing-config /
 * broken-db / broken-config / engine-locked, silently suppressing brain
 * blocks for a fully-working remote brain.
 *
 * Evidence read: ~/.claude.json MCP registrations — user scope plus the
 * cwd's NEAREST-ANCESTOR project scope only (#2499 made project scope
 * visible; the per-project scoping fixes the machine-wide bleed where ONE
 * project's remote registration reclassified broken local engines as
 * thin-client for EVERY cwd). Ancestor matching mirrors the
 * GBRAIN_MCP_ENTRY_JQ resolution in
 * scripts/resolvers/preamble/generate-brain-sync-block.ts: cwd == key or
 * cwd startswith key + separator, longest matching key that actually
 * carries a gbrain entry wins (a nested project WITHOUT gbrain doesn't
 * shadow its parent's registration).
 *
 * Same-name conflicts resolve project-local over user scope — Claude
 * Code's own precedence, verified empirically against claude 2.1.233 with
 * a hermetic fake $HOME: `claude mcp get gbrain` reports "Scope: Local
 * config" and the project-local URL when both scopes define the name.
 *
 * File-read only: no subprocess, no network (a classifier network probe is
 * the #1964 pathology). Returns true only when a visible gbrain
 * registration is remote-HTTP AND no visible gbrain registration is
 * local-stdio — a local-stdio entry means the user runs a local engine
 * (possibly alongside a remote one, e.g. federation), and local-engine
 * statuses like engine-locked must keep their precise meaning there.
 */
export function hasRemoteOnlyGbrainMcp(
  env?: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): boolean {
  interface McpEntry {
    type?: string;
    transport?: string;
    command?: string;
    url?: string;
  }
  let cj: unknown;
  try {
    cj = JSON.parse(readFileSync(join(userHome(env), ".claude.json"), "utf-8"));
  } catch {
    return false;
  }
  // Same classification rules as gstack-gbrain-detect's detectMcpMode tier 3,
  // including the #2051 name generalization (gbrain, gbrain-remote, gbrain_work).
  const classify = (entry: McpEntry): "remote" | "local" | null => {
    const mtype = entry.type || entry.transport || "";
    if (mtype === "url" || mtype === "http" || mtype === "sse") return "remote";
    if (mtype === "stdio") return "local";
    if (entry.url) return "remote";
    if (entry.command) return "local";
    return null;
  };
  /** Extract the gbrain-relevant entries from an mcpServers object. */
  const gbrainEntries = (servers: unknown): Record<string, McpEntry> => {
    const out: Record<string, McpEntry> = {};
    if (!servers || typeof servers !== "object") return out;
    for (const [name, entry] of Object.entries(servers as Record<string, McpEntry>)) {
      if (!entry || typeof entry !== "object") continue;
      const isGbrainName = /^gbrain([-_][\w-]*)?$/.test(name);
      const cmdMentionsGbrain =
        typeof entry.command === "string" && /\bgbrain\b/.test(entry.command);
      if (!isGbrainName && !cmdMentionsGbrain) continue;
      out[name] = entry;
    }
    return out;
  };
  const root = cj as {
    mcpServers?: unknown;
    projects?: Record<string, { mcpServers?: unknown }>;
  } | null;
  const userGbrain = gbrainEntries(root?.mcpServers);
  // Nearest-ancestor project entry for cwd that carries a gbrain server.
  // Path-boundary-aware (/a/repo never matches /a/repo2); both separators
  // accepted so Windows project keys resolve.
  let projectGbrain: Record<string, McpEntry> = {};
  if (root?.projects && typeof root.projects === "object") {
    let bestKey: string | null = null;
    for (const [key, proj] of Object.entries(root.projects)) {
      if (!proj || typeof proj !== "object") continue;
      const entries = gbrainEntries((proj as { mcpServers?: unknown }).mcpServers);
      if (Object.keys(entries).length === 0) continue;
      const isAncestor =
        cwd === key || cwd.startsWith(`${key}/`) || cwd.startsWith(`${key}\\`);
      if (!isAncestor) continue;
      if (bestKey === null || key.length > bestKey.length) {
        bestKey = key;
        projectGbrain = entries;
      }
    }
  }
  // Effective view for this cwd: project-local shadows user scope per name.
  const effective: Record<string, McpEntry> = { ...userGbrain, ...projectGbrain };
  let sawRemote = false;
  let sawLocal = false;
  for (const entry of Object.values(effective)) {
    const c = classify(entry);
    if (c === "remote") sawRemote = true;
    if (c === "local") sawLocal = true;
  }
  return sawRemote && !sawLocal;
}

function configuredEngine(env?: NodeJS.ProcessEnv): "pglite" | "postgres" | null {
  try {
    const parsed = JSON.parse(readFileSync(gbrainConfigPath(env), "utf-8")) as { engine?: string };
    return parsed.engine === "pglite" || parsed.engine === "postgres" ? parsed.engine : null;
  } catch {
    return null;
  }
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
// On Windows the shim is `gbrain.cmd` → `bun run cli.ts`; a cold spawn can
// exceed 2s, and a false negative here poisons the 60s status cache with
// "no-cli". Give the shim headroom; POSIX keeps the tight timeout.
const VERSION_PROBE_TIMEOUT_MS = NEEDS_SHELL_ON_WINDOWS ? 10_000 : 2_000;
export function resolveGbrainBin(env?: NodeJS.ProcessEnv): string | null {
  const e = env ?? process.env;
  const key = e.PATH || "";
  if (_gbrainBinCache.has(key)) return _gbrainBinCache.get(key)!;
  let result: string | null = null;
  try {
    execFileSync("gbrain", ["--version"], {
      encoding: "utf-8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
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
      timeout: VERSION_PROBE_TIMEOUT_MS,
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
    atomicWriteSync(cacheFilePath(), JSON.stringify(entry, null, 2));
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

  // 2. Config file present? A bearer thin client (#2520) may never have run
  // a local init, so config.json can be absent while the remote-HTTP MCP
  // registration IS the user's brain.
  if (!existsSync(gbrainConfigPath(env))) {
    return hasRemoteOnlyGbrainMcp(env) ? "thin-client" : "missing-config";
  }

  // 2.5 Thin client? gbrain's own marker (mirrors gbrain isThinClient():
  // truthy remote_mcp in config). A thin client has NO local engine — gbrain
  // REFUSES `sources` commands on it (THIN_CLIENT_REFUSED_COMMANDS, exit 1
  // with no recognized error string), so the probe below would fall to the
  // defensive broken-config default and silently suppress brain-aware blocks
  // (#2051). Detected PRE-probe from the config file: zero network cost,
  // immune to gbrain error-string drift. Remote reachability is deliberately
  // NOT probed here — a classifier network probe is the #1964 pathology.
  try {
    const cfg = JSON.parse(readFileSync(gbrainConfigPath(env), "utf-8")) as {
      remote_mcp?: unknown;
    };
    if (cfg && typeof cfg === "object" && cfg.remote_mcp) {
      return "thin-client";
    }
  } catch {
    // Unparseable config: fall through to the probe, whose stderr
    // classification surfaces broken-config with the raw error upstream.
  }

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
      status?: number | null;
    };
    const stderr = (e.stderr ? e.stderr.toString() : "") || "";

    // ENOENT can happen if gbrain disappeared between resolveGbrainBin and now.
    if (e.code === "ENOENT") return "no-cli";

    // Pattern match against gbrain's known error strings. Order matters:
    // thin-client refusal first (backstop for a config the pre-probe check
    // couldn't read — gbrain's dispatch guard says e.g. "`gbrain sources` is
    // not routable ... (thin-client of <url>)"), then the more specific
    // DB-unreachable signal.
    const raw = ((): LocalEngineStatus => {
      if (/thin[- ]client/i.test(stderr)) return "thin-client";
      if (stderr.includes("Cannot connect to database")) return "broken-db";
      if (stderr.includes("config.json")) return "broken-config";

      // PGLite is single-process. A long-lived `gbrain serve` can own the
      // embedded database, causing the CLI to finish with its own exit 124 and
      // "connect timed out" message. This is neither our watchdog timeout nor
      // evidence that the valid config is malformed (#2194).
      if (stderr.includes("connect timed out") || e.status === 124) {
        return configuredEngine(env) === "pglite" ? "engine-locked" : "broken-db";
      }

      // Probe killed by the timeout with no recognized error: the engine is
      // most likely healthy but slow (cold pooler connections measured at
      // 6.9-10.7s in #1964). Don't tell the user their config is malformed.
      if (e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
        return "timeout";
      }

      // Defensive default per codex #8: unrecognized failures classify as
      // broken-config so the user sees the raw stderr surfaced upstream.
      return "broken-config";
    })();

    // #2520 bearer-token fallback: the local probe failed, but the user's
    // only gbrain MCP registration is remote-HTTP — the dead-or-locked local
    // engine is not their brain (typical shape: a leftover local config plus
    // `gbrain connect --token`). Reclassify as thin-client so brain blocks
    // stay rendered and sync's local stages skip with the accurate "nothing
    // to do locally" message. "timeout" is deliberately excluded: it already
    // counts as usable and may be a genuinely healthy slow LOCAL engine.
    if (
      (raw === "broken-db" || raw === "broken-config" || raw === "engine-locked") &&
      hasRemoteOnlyGbrainMcp(env)
    ) {
      return "thin-client";
    }
    return raw;
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
