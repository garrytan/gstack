/**
 * Centralized gbrain CLI invocation.
 *
 * Every `gbrain ...` spawn from `bin/gstack-gbrain-sync.ts` and
 * `bin/gstack-memory-ingest.ts` MUST go through `spawnGbrain` (or
 * `execGbrainJson`), and the invariant test
 * `test/gbrain-exec-invariant.test.ts` enforces this with a static-source
 * grep. The helper layer guarantees three properties:
 *
 *   1. **DATABASE_URL is seeded from gbrain's own config**, not from the
 *      caller's `.env.local`. gbrain auto-loads `.env.local` via dotenv on
 *      startup. When `/sync-gbrain` runs inside a Next.js / Prisma / Rails
 *      project with its own `DATABASE_URL`, gbrain reads that one and not
 *      its own gbrain config (`$GBRAIN_HOME/.gbrain/config.json` on current
 *      releases, with the legacy direct layout still accepted). Auth fails;
 *      code + memory stages crash; only brain-sync's git push survives.
 *
 *   2. **Bun-aware env passing.** Mutating `process.env.DATABASE_URL` does
 *      NOT propagate to children of `child_process.spawnSync`/`spawn` in
 *      Bun — the child gets the original startup env. So we cannot just
 *      set process.env; we must thread an explicit `env:` dict to every
 *      spawn. This is the central bug the helper exists to prevent
 *      regressing on.
 *
 *   3. **`GBRAIN_HOME` honored consistently.** Other gstack helpers
 *      (`detectEngineTier`) already honor `GBRAIN_HOME`. `buildGbrainEnv`
 *      reads the current/legacy gbrain config layout so all
 *      gstack-side gbrain calls agree on which config file matters.
 *
 * **Escape hatch:** `GSTACK_RESPECT_ENV_DATABASE_URL=1` returns the
 * caller's env unchanged. Use only when the brain intentionally lives in
 * the project's local DB (rare).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync, spawn, execFileSync, type SpawnSyncReturns, type ChildProcess, type SpawnOptions } from "child_process";

export interface GbrainConfig {
  engine?: string;
  database_url?: string;
  database_path?: string;
  remote_mcp?: unknown;
}

export interface BuildGbrainEnvOptions {
  /**
   * Caller env to extend. Defaults to `process.env`. Tests inject a
   * synthetic env so the helper can be exercised without polluting the
   * real process env.
   */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * When true, announce on stderr that we overrode the caller's
   * DATABASE_URL. Suppressed for the `--quiet` sync flow.
   */
  announce?: boolean;
}

/**
 * Ordered gbrain config candidates for the active environment.
 *
 * Current gbrain treats GBRAIN_HOME as a parent and appends `.gbrain`.
 * Older releases treated GBRAIN_HOME as the state directory itself. Keep the
 * legacy direct path as a read-only fallback, but always prefer the current
 * nested layout when both exist.
 */
export function gbrainConfigCandidates(baseEnv: NodeJS.ProcessEnv = process.env): string[] {
  const homeBase = baseEnv.HOME || homedir();
  const override = baseEnv.GBRAIN_HOME?.trim();
  return override
    ? [join(override, ".gbrain", "config.json"), join(override, "config.json")]
    : [join(homeBase, ".gbrain", "config.json")];
}

/** Existing active config, or the current-layout path when no candidate exists. */
export function resolveGbrainConfigPath(baseEnv: NodeJS.ProcessEnv = process.env): string {
  const candidates = gbrainConfigCandidates(baseEnv);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export interface ActiveGbrainConfig {
  path: string;
  config: GbrainConfig;
}

function readGbrainConfigFile(path: string): ActiveGbrainConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { path, config: parsed as GbrainConfig };
  } catch {
    return null;
  }
}

/**
 * Read the active config as an object. Missing, malformed, array, and scalar
 * configs are rejected instead of being confused with a configured brain.
 */
export function readActiveGbrainConfig(
  baseEnv: NodeJS.ProcessEnv = process.env,
): ActiveGbrainConfig | null {
  return readGbrainConfigFile(resolveGbrainConfigPath(baseEnv));
}

/**
 * Strict environment for a capability probe that may mutate the brain.
 *
 * Unlike buildGbrainEnv(), this requires a valid active config and deliberately
 * ignores caller database overrides. A Postgres brain receives the configured
 * URL through both supported env names; PGLite and thin-client configs have all
 * caller database routing removed. This prevents a project/caller DATABASE_URL
 * from redirecting a temporary capability source into an unrelated database.
 */
export function buildConfiguredGbrainEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Mutating probes may use only the current upstream layout. The direct
  // GBRAIN_HOME/config.json candidate remains a read-only compatibility
  // fallback elsewhere, but current gbrain never reads it. Treating a stale
  // legacy file as active here could route writes to an unrelated database.
  const canonicalPath = gbrainConfigCandidates(baseEnv)[0];
  const active = readGbrainConfigFile(canonicalPath);
  if (!active) {
    throw new Error(`active gbrain config is missing or malformed at ${canonicalPath}`);
  }

  const out: NodeJS.ProcessEnv = { ...baseEnv };
  delete out.DATABASE_URL;
  delete out.GBRAIN_DATABASE_URL;

  const cfg = active.config;
  if (cfg.remote_mcp && typeof cfg.remote_mcp === "object") return out;
  if (cfg.engine === "pglite" || (typeof cfg.database_path === "string" && cfg.database_path.trim())) {
    return out;
  }
  if (typeof cfg.database_url === "string" && cfg.database_url.trim()) {
    out.DATABASE_URL = cfg.database_url;
    out.GBRAIN_DATABASE_URL = cfg.database_url;
    return out;
  }

  throw new Error(`active gbrain config at ${active.path} has no usable engine routing`);
}

/**
 * Detect whether a DATABASE_URL targets a PgBouncer transaction-mode pooler.
 *
 * Supabase transaction-mode poolers conventionally run on port 6543 at
 * `*.pooler.supabase.com`. gbrain auto-disables prepared statements on these
 * (prepared statements break under transaction pooling — #1965); its banner
 * documents `GBRAIN_PREPARE=true` as the override for poolers that actually
 * run in session mode on 6543.
 */
export function isTransactionModePooler(url: string): boolean {
  try {
    // DATABASE_URLs use postgresql:// scheme which URL() doesn't natively
    // parse host/port from, so swap to http:// for reliable parsing.
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    return parsed.port === "6543";
  } catch {
    return false;
  }
}

/**
 * Build an env dict with DATABASE_URL seeded from
 * the active gbrain config. Returns the base env
 * unchanged when:
 *   - `GSTACK_RESPECT_ENV_DATABASE_URL=1` (intentional opt-out),
 *   - the config file is missing or unparseable,
 *   - the config has no `database_url`,
 *   - the caller already set DATABASE_URL to the same value.
 *
 * GBRAIN_PREPARE is never set here (#1965): gbrain auto-disables prepared
 * statements on transaction-mode poolers itself, and forcing them on breaks
 * every write with "prepared statement does not exist". A caller-set
 * GBRAIN_PREPARE (either value) passes through untouched — that remains the
 * documented override for session-mode poolers on port 6543.
 *
 * Always returns a fresh object — mutating the returned env never
 * affects the caller's env. Tests assert on effective values, not
 * object identity.
 */
export function buildGbrainEnv(opts: BuildGbrainEnvOptions = {}): NodeJS.ProcessEnv {
  const baseEnv = opts.baseEnv || process.env;
  const out: NodeJS.ProcessEnv = { ...baseEnv };
  if (baseEnv.GSTACK_RESPECT_ENV_DATABASE_URL === "1") return out;

  const active = readActiveGbrainConfig(baseEnv);
  if (!active) return out;
  const { path: configPath, config: cfg } = active;
  if (!cfg.database_url) return out;

  const hadCaller = baseEnv.DATABASE_URL !== undefined;
  const alreadyMatch = baseEnv.DATABASE_URL === cfg.database_url;
  if (!alreadyMatch) {
    out.DATABASE_URL = cfg.database_url;
    if (opts.announce) {
      const note = hadCaller ? " (overrode value from caller env / .env.local)" : "";
      process.stderr.write(`[gbrain-exec] seeded DATABASE_URL from ${configPath}${note}\n`);
    }
  }

  return out;
}

/**
 * Windows can't directly spawn the `gbrain` launcher (bun/npm install it as a
 * `gbrain.cmd`/`.ps1` shim) or a shebang script like the bash `gstack-brain-sync`
 * — `spawnSync`/`spawn` resolve those only through a shell's PATHEXT + interpreter
 * lookup. Without `shell: true` the child spawn fails ENOENT, which on the sync
 * orchestrator surfaced as "brain-sync exited undefined" (#1731). Gate on platform
 * so POSIX keeps the cheaper no-shell path. Exported so the static-grep tripwire
 * (test/gbrain-spawn-windows-shell.test.ts) can assert every gbrain/brain-sync
 * spawn carries it.
 */
export const NEEDS_SHELL_ON_WINDOWS = process.platform === "win32";

export interface SpawnGbrainOptions {
  /** Timeout in milliseconds. Defaults to 30s. */
  timeout?: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Stdio configuration. Defaults to capturing both stdout and stderr. */
  stdio?: "inherit" | "pipe" | "ignore" | Array<"inherit" | "pipe" | "ignore">;
  /**
   * Base env to extend before seeding DATABASE_URL. Defaults to
   * `process.env`. Tests inject a synthetic env so the spawn picks up a
   * gbrain shim on PATH and a fake `~/.gbrain/config.json`.
   */
  baseEnv?: NodeJS.ProcessEnv;
  /** Whether to announce DATABASE_URL seeding on stderr. */
  announce?: boolean;
}

/**
 * Spawn `gbrain <args>` with the seeded env. Returns the raw
 * `SpawnSyncReturns<string>` so callers can inspect `status`, `stdout`,
 * `stderr` exactly as they would with `spawnSync` directly.
 */
export function spawnGbrain(args: string[], opts: SpawnGbrainOptions = {}): SpawnSyncReturns<string> {
  return spawnSync("gbrain", args, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: buildGbrainEnv({ baseEnv: opts.baseEnv, announce: opts.announce }),
    shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
  });
}

/**
 * Run `gbrain <args>` and parse stdout as JSON. Returns `null` on
 * non-zero exit, parse failure, or timeout. Useful for `gbrain sources
 * list --json` and similar.
 */
export function execGbrainJson<T = unknown>(args: string[], opts: SpawnGbrainOptions = {}): T | null {
  const r = spawnGbrain(args, opts);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || "null") as T;
  } catch {
    return null;
  }
}

/**
 * Async streaming variant for callers that need to attach stdout/stderr
 * listeners (e.g., `gbrain import` in `gstack-memory-ingest.ts`). Always
 * injects the seeded env. Returns the raw `ChildProcess` so the caller
 * can wire up its own promise around exit/timeout/signal handling.
 */
export function spawnGbrainAsync(
  args: string[],
  opts: { stdio?: SpawnOptions["stdio"]; cwd?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  return spawn("gbrain", args, {
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    cwd: opts.cwd,
    env: buildGbrainEnv({ baseEnv: opts.baseEnv, announce: false }),
    shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
  });
}

/**
 * Run `gbrain <args>` via execFileSync. Throws on non-zero exit. Useful
 * for callers that want to surface gbrain's stderr as the error message.
 */
export function execGbrainText(args: string[], opts: SpawnGbrainOptions = {}): string {
  return execFileSync("gbrain", args, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: buildGbrainEnv({ baseEnv: opts.baseEnv, announce: opts.announce }),
    shell: NEEDS_SHELL_ON_WINDOWS, // #1731: gbrain is a .cmd shim on Windows
  });
}
