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
 *      its own `${GBRAIN_HOME:-$HOME/.gbrain}/config.json`. Auth fails;
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
 *      reads from `${GBRAIN_HOME:-$HOME/.gbrain}/config.json` so all
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

interface GbrainConfig {
  database_url?: string;
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
 * Detect whether a DATABASE_URL targets a PgBouncer transaction-mode pooler.
 *
 * Supabase transaction-mode poolers conventionally run on port 6543 at
 * `*.pooler.supabase.com`. When gbrain connects through one of these, it
 * auto-disables prepared statements — but search requires them (#1435).
 * Returns `true` when the URL looks like a transaction-mode pooler so the
 * caller can set `GBRAIN_PREPARE=true` to re-enable prepared statements.
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
 * `${GBRAIN_HOME:-$HOME/.gbrain}/config.json`. Returns the base env
 * unchanged when:
 *   - `GSTACK_RESPECT_ENV_DATABASE_URL=1` (intentional opt-out),
 *   - the config file is missing or unparseable,
 *   - the config has no `database_url`,
 *   - the caller already set DATABASE_URL to the same value.
 *
 * When the effective DATABASE_URL targets a PgBouncer transaction-mode
 * pooler (port 6543), sets `GBRAIN_PREPARE=true` so gbrain re-enables
 * prepared statements needed for search (#1435). Caller can override
 * with `GBRAIN_PREPARE=false` in the base env.
 *
 * Always returns a fresh object — mutating the returned env never
 * affects the caller's env. Tests assert on effective values, not
 * object identity.
 */
export function buildGbrainEnv(opts: BuildGbrainEnvOptions = {}): NodeJS.ProcessEnv {
  const baseEnv = opts.baseEnv || process.env;
  const out: NodeJS.ProcessEnv = { ...baseEnv };
  if (baseEnv.GSTACK_RESPECT_ENV_DATABASE_URL === "1") return out;

  const homeBase = baseEnv.HOME || homedir();
  const gbrainHome = baseEnv.GBRAIN_HOME || join(homeBase, ".gbrain");
  const configPath = join(gbrainHome, "config.json");
  if (!existsSync(configPath)) return out;

  let cfg: GbrainConfig = {};
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf-8")) as GbrainConfig;
  } catch {
    return out;
  }
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

  // PgBouncer transaction-mode pooler detection (#1435): when the effective
  // DATABASE_URL targets port 6543 (Supabase transaction-mode convention),
  // gbrain auto-disables prepared statements — but search needs them.
  // Set GBRAIN_PREPARE=true unless the caller explicitly opted out.
  const effectiveUrl = out.DATABASE_URL || cfg.database_url;
  if (effectiveUrl && !out.GBRAIN_PREPARE && isTransactionModePooler(effectiveUrl)) {
    out.GBRAIN_PREPARE = "true";
    if (opts.announce) {
      process.stderr.write(
        `[gbrain-exec] set GBRAIN_PREPARE=true (port 6543 transaction-mode pooler detected)\n`,
      );
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
