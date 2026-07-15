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
 * `${GBRAIN_HOME:-$HOME/.gbrain}/config.json`. Returns the base env
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

  return out;
}

/**
 * Windows still needs a shell for bash helpers such as `gstack-brain-sync`.
 * Direct gbrain calls deliberately do NOT use this flag: planGbrainSpawn resolves
 * Bun's executable shim and preserves argv structurally (DEV-206). Exported for
 * the remaining shebang-script spawns and legacy literal-argument probes.
 */
export const NEEDS_SHELL_ON_WINDOWS = process.platform === "win32";

export interface GbrainSpawnPlan {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * Build a structural gbrain invocation. Supported Windows installs use Bun's
 * direct `.exe` shim, so argv values (especially worktree paths containing
 * spaces) never pass through `cmd.exe` tokenization.
 *
 * A `.cmd`/`.bat`/`.ps1` launcher would require rebuilding the command as a
 * shell string. Fail closed instead of risking argument splitting or command
 * injection; `bin/gstack-gbrain-install` uses `bun link`, which installs the
 * directly executable shim this contract requires.
 */
export function planGbrainSpawn(
  args: string[],
  resolvedExecutable: string | null,
  platform: NodeJS.Platform = process.platform,
): GbrainSpawnPlan {
  const command = resolvedExecutable || "gbrain";
  if (platform === "win32" && resolvedExecutable && !/\.(?:exe|com)$/i.test(resolvedExecutable)) {
    throw new Error(
      `unsafe Windows gbrain launcher at ${resolvedExecutable}; ` +
        "re-run /setup-gbrain so bun link installs a direct gbrain.exe shim",
    );
  }
  return { command, args: [...args], shell: false };
}

/** Resolve gbrain against the exact PATH that will be passed to the child. */
export function resolveGbrainExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return Bun.which("gbrain", { PATH: env.PATH });
  } catch {
    return null;
  }
}

function gbrainSpawnPlan(args: string[], env: NodeJS.ProcessEnv): GbrainSpawnPlan {
  return planGbrainSpawn(args, resolveGbrainExecutable(env));
}

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
  const env = buildGbrainEnv({ baseEnv: opts.baseEnv, announce: opts.announce });
  const plan = gbrainSpawnPlan(args, env);
  return spawnSync(plan.command, plan.args, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env,
    shell: plan.shell,
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
  const env = buildGbrainEnv({ baseEnv: opts.baseEnv, announce: false });
  const plan = gbrainSpawnPlan(args, env);
  return spawn(plan.command, plan.args, {
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    cwd: opts.cwd,
    env,
    shell: plan.shell,
  });
}

/**
 * Run `gbrain <args>` via execFileSync. Throws on non-zero exit. Useful
 * for callers that want to surface gbrain's stderr as the error message.
 */
export function execGbrainText(args: string[], opts: SpawnGbrainOptions = {}): string {
  const env = buildGbrainEnv({ baseEnv: opts.baseEnv, announce: opts.announce });
  const plan = gbrainSpawnPlan(args, env);
  return execFileSync(plan.command, plan.args, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env,
    shell: plan.shell,
  });
}
