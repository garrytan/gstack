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
 *   3. **`GBRAIN_HOME` honored consistently — with gbrain's own semantics
 *      (#2521).** gbrain's configDir() treats `GBRAIN_HOME` as a PARENT
 *      directory and always appends `.gbrain` itself (GBRAIN_HOME=/tmp/x
 *      → /tmp/x/.gbrain/config.json). Every gstack-side read goes through
 *      `gbrainConfigDir()` below so gstack and gbrain agree on which
 *      config file matters.
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
 * gbrain's config directory, matching gbrain's own configDir() contract
 * (#2521): `GBRAIN_HOME` is a PARENT directory — gbrain always appends
 * `.gbrain` itself, so GBRAIN_HOME=/tmp/x reads /tmp/x/.gbrain/config.json.
 * Unset → ~/.gbrain. Every gstack-side gbrain-config read MUST resolve
 * through this helper, or gstack classifies engine status from a file
 * gbrain never reads.
 */
export function gbrainConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GBRAIN_HOME) return join(env.GBRAIN_HOME, ".gbrain");
  return join(env.HOME || homedir(), ".gbrain");
}

/**
 * Build an env dict with DATABASE_URL seeded from gbrain's config.json
 * (resolved via `gbrainConfigDir`). Returns the base env
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

  const configPath = join(gbrainConfigDir(baseEnv), "config.json");
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

/** Where Git for Windows puts bash, most-specific first. */
const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

export interface ScriptInvocation {
  cmd: string;
  argv: string[];
  /** Always false: we resolve the interpreter ourselves rather than via cmd.exe. */
  shell: false;
}

/**
 * How to invoke a **bash shebang script** (`gstack-brain-sync`) on this platform.
 *
 * POSIX execs it directly — the shebang does the work. Windows cannot, and
 * `shell: true` does NOT rescue it: that routes through cmd.exe, which resolves
 * `.cmd`/`.bat` via PATHEXT but has no concept of a shebang, so an
 * extension-less bash script comes back as *"is not recognized as an internal
 * or external command"*. This is why #1731's `shell: NEEDS_SHELL_ON_WINDOWS`
 * fix genuinely cured the `gbrain.cmd` shim while leaving the brain-sync stage
 * failing on **every** run on Windows. The two cases look identical and are not:
 * a `.cmd` shim needs a shell, a shebang script needs an interpreter.
 *
 * The consequence was quiet rather than loud. `artifacts_sync_mode` defaults to
 * pushing curated artifacts to git, so a Windows user's learnings accumulated in
 * `~/.gstack` and were never committed, while `/sync-gbrain` printed one red
 * line among four green ones.
 *
 * Git for Windows' bash is preferred over a bare `bash` on PATH because
 * WindowsApps ships a `bash.exe` that is the WSL launcher; if it wins PATH
 * order it interprets `C:\...` as a Linux path and the script never sees the
 * repo. `GSTACK_BASH` overrides everything for unusual installs.
 *
 * Returns `null` when no bash can be found, so the caller can say so plainly
 * instead of surfacing a spawn error nobody can act on.
 */
export function bashScriptInvocation(
  scriptPath: string,
  args: string[],
  opts: { platform?: string; exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): ScriptInvocation | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { cmd: scriptPath, argv: args, shell: false };

  const exists = opts.exists ?? existsSync;
  const env = opts.env ?? process.env;

  const override = env.GSTACK_BASH?.trim();
  const candidates = [...(override ? [override] : []), ...WINDOWS_BASH_CANDIDATES];
  const bash = candidates.find((p) => exists(p));
  if (!bash) return null;

  // Forward slashes: bash treats backslashes as escapes, so a Windows path
  // passed verbatim loses its separators.
  return { cmd: bash, argv: [scriptPath.replace(/\\/g, "/"), ...args], shell: false };
}

/**
 * Quote one argument for cmd.exe's re-parse (#2471). With `shell: true` on
 * Windows, Node/Bun JOIN the argv into a single cmd.exe string WITHOUT
 * quoting, so any argument containing a space — the default
 * `C:\Users\First Last\repo` home layout — splits into two arguments and the
 * gbrain call silently targets the wrong path. Pass-through for the safe
 * charset; everything else is double-quoted with embedded quotes doubled
 * (cmd.exe's escape). POSIX callers never see this (shell is false there).
 */
export function windowsShellQuote(arg: string): string {
  if (arg !== "" && /^[A-Za-z0-9_\-.:\\/=,@+]+$/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * The single seam for building a gbrain CLI invocation (#2471). Every
 * spawnSync/execFileSync of the `gbrain` shim must construct its
 * (cmd, argv, shell) triple here so the Windows quoting fix lives in exactly
 * one place — a direct spawn of the literal "gbrain" string with a shell
 * flag reopens the space-in-path split this exists to close.
 */
export function gbrainInvocation(args: string[]): { cmd: string; argv: string[]; shell: boolean } {
  return NEEDS_SHELL_ON_WINDOWS
    ? { cmd: "gbrain", argv: args.map(windowsShellQuote), shell: true }
    : { cmd: "gbrain", argv: args, shell: false };
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
  const inv = gbrainInvocation(args);
  return spawnSync(inv.cmd, inv.argv, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: buildGbrainEnv({ baseEnv: opts.baseEnv, announce: opts.announce }),
    shell: inv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
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
  const inv = gbrainInvocation(args);
  return spawn(inv.cmd, inv.argv, {
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    cwd: opts.cwd,
    env: buildGbrainEnv({ baseEnv: opts.baseEnv, announce: false }),
    shell: inv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
  });
}

/**
 * Run `gbrain <args>` via execFileSync. Throws on non-zero exit. Useful
 * for callers that want to surface gbrain's stderr as the error message.
 */
export function execGbrainText(args: string[], opts: SpawnGbrainOptions = {}): string {
  const inv = gbrainInvocation(args);
  return execFileSync(inv.cmd, inv.argv, {
    encoding: "utf-8",
    timeout: opts.timeout ?? 30_000,
    cwd: opts.cwd,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    env: buildGbrainEnv({ baseEnv: opts.baseEnv, announce: opts.announce }),
    shell: inv.shell, // #1731: gbrain is a .cmd shim on Windows (+#2471 quoting)
  });
}
