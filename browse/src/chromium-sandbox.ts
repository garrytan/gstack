/**
 * Chromium sandbox policy and the one error for a sandbox that cannot start.
 *
 * The sandbox needs unprivileged user namespaces. gstack turns it off only
 * where we already know they are missing (Windows, root, CI, a container) or
 * where the user asked (GSTACK_CHROMIUM_NO_SANDBOX=1). Everywhere else it
 * stays on, and when Chromium then aborts with "No usable sandbox" the launch
 * fails with CHROMIUM_SANDBOX_HELP instead of retrying without the sandbox:
 * turning it off is the user's call, because it changes what a hostile page
 * can reach.
 */
import * as fs from 'fs';

export const CHROMIUM_SANDBOX_HELP = 'Chromium could not start its sandbox: this Linux host does not let unprivileged users create user namespaces (Ubuntu 23.10+ AppArmor policy, a container\'s seccomp profile, or user.max_user_namespaces=0). Fix it one of two ways: allow them (on Ubuntu, `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile for Chromium, per the link in Chromium\'s message; elsewhere, raise user.max_user_namespaces), or set GSTACK_CHROMIUM_NO_SANDBOX=1 to run Chromium without its sandbox. Use that only for pages you trust: without the sandbox, a page that exploits a Chromium bug can reach your files and accounts.';

/**
 * Hosts known to lack unprivileged user namespaces: root, CI, or a container
 * (CONTAINER set, or Docker's /.dockerenv).
 */
export function sandboxBlockedByHost(exists: (p: string) => boolean = fs.existsSync): boolean {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return Boolean(process.env.CI || process.env.CONTAINER || isRoot || exists('/.dockerenv'));
}

/**
 * Decide whether Playwright should request Chromium's sandbox.
 *
 * Returns false on Windows (Bun→Node→Chromium chain breaks the sandbox,
 * GitHub #276), when GSTACK_CHROMIUM_NO_SANDBOX=1 (#1562), and on hosts
 * sandboxBlockedByHost() names.
 *
 * When false, Playwright auto-adds --no-sandbox to the launch args. When true,
 * Playwright does NOT add --no-sandbox, which keeps Chromium's "unsupported
 * command-line flag" yellow infobar from appearing on every headed launch.
 */
export function shouldEnableChromiumSandbox(exists: (p: string) => boolean = fs.existsSync): boolean {
  if (process.platform === 'win32') return false;
  if (process.env.GSTACK_CHROMIUM_NO_SANDBOX === '1') return false;
  return !sandboxBlockedByHost(exists);
}

/** Chromium's "No usable sandbox" abort found in launch output, as CHROMIUM_SANDBOX_HELP with Chromium's own line below it; null for any other failure. */
export function sandboxFailure(output: string): string | null {
  const raw = output.split('\n').find((line) => line.includes('No usable sandbox'));
  return raw ? `${CHROMIUM_SANDBOX_HELP}\n${raw.trim().replace(/^- /, '')}` : null;
}

/** Launch-site catch: a sandbox abort becomes the actionable error; anything else is rethrown as it was. */
export function explainSandboxFailure(err: unknown): never {
  const explained = sandboxFailure(err instanceof Error ? err.message : String(err));
  throw explained ? new Error(explained, { cause: err }) : err;
}
