/**
 * XProtect launch-kill self-heal (P0 #2554).
 *
 * macOS XProtect definition updates can start killing the exact Chromium
 * revision the committed bun.lock pins (observed: revision 1208 under
 * playwright 1.58.2 — xprotectd SIGKILLs chrome-headless-shell at spawn, so
 * the failure surfaces as a Playwright launch timeout or a "Browser closed"
 * error carrying `signal=SIGKILL`, never anything naming XProtect).
 *
 * The heal, in order, at most ONCE per process (F4):
 *   1. Classify the launch failure against the XProtect kill signature
 *      (positive AND negative fixtures under test, F9).
 *   2. Clear com.apple.quarantine on the Playwright cache bundles ONLY —
 *      a GSTACK_CHROMIUM_PATH bundle belongs to the wrapper/embedder and is
 *      never touched (same scope contract as probePoisonedChromiumBundle).
 *   3. Force-reinstall Chromium FROM THE GSTACK INSTALL ROOT (ENG-OV3: the
 *      root whose node_modules pins the same playwright-core our compiled
 *      binary embeds — a cwd-resolved `bunx playwright install` would fetch
 *      the LATEST playwright's revision, which the embedded playwright-core
 *      won't find, and the one-shot guard would then block the retry).
 *      The install is BOUNDED (~120s, process-GROUP kill on timeout; E1).
 *   4. Verify the revision dir the embedded playwright-core EXPECTS exists
 *      post-heal (registry-derived expectation, not merely install exit 0).
 *
 * Every action emits one structured stderr line (F11). When the heal cannot
 * complete (offline, timeout, no install root, one-shot spent), the caller
 * surfaces the ORIGINAL launch error plus manual
 * `bunx playwright install chromium` guidance — the CLI never hangs on it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

/** F11: one structured stderr line per self-heal action. */
function logHeal(action: string, fields: Record<string, unknown> = {}): void {
  console.error(`[browse:xprotect-heal] ${JSON.stringify({ action, ...fields })}`);
}

// ─── Classifier (F9: positives AND negatives) ────────────────────────────

/**
 * Failure shapes that are definitively NOT an XProtect kill. Checked before
 * the positives so an ambiguous message never triggers a pointless reinstall:
 *   - missing executable (browser was never installed / cache wiped)
 *   - spawn-level permission errors (EACCES / EPERM / ENOENT)
 *   - Linux sandbox denials (wrong OS anyway, but the text is distinctive)
 */
const NEGATIVE_SIGNATURES: RegExp[] = [
  /executable doesn't exist/i,
  /spawn\s+\S+\s+(EACCES|EPERM|ENOENT)/i,
  /\b(EACCES|EPERM)\b/,
  /no usable sandbox/i,
  /failed to move to new namespace/i,
  /suid sandbox helper/i,
];

/**
 * Failure shapes an OS-level kill produces (sourced from the #2554 report
 * plus Playwright's launch-error format): the browser process SPAWNED, then
 * died to SIGKILL, or never became ready (launch timeout with a `<launched>`
 * marker — the report's visible symptom, since xprotectd kills the child
 * without Playwright ever learning why).
 */
const POSITIVE_SIGNATURES: RegExp[] = [
  /<process did exit:[^>]*signal=SIGKILL/i,
  /signal[:=]\s*['"]?SIGKILL/i,
];

/**
 * True when a launch failure message matches the macOS XProtect kill
 * signature. Platform-gated: XProtect exists only on darwin.
 */
export function isXProtectKillSignature(
  message: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false;
  if (!message) return false;
  for (const neg of NEGATIVE_SIGNATURES) {
    if (neg.test(message)) return false;
  }
  for (const pos of POSITIVE_SIGNATURES) {
    if (pos.test(message)) return true;
  }
  // XProtect kill at spawn also surfaces as a launch timeout where the
  // process DID launch (<launched> marker present) but never became ready —
  // this is the exact symptom the #2554 report describes.
  return /timeout \d+\s*ms exceeded/i.test(message) && /<launched>/i.test(message);
}

// ─── Playwright cache path helpers (pure) ────────────────────────────────

const REVISION_DIR_RE = /^chromium(?:_headless_shell)?-\d+$/;

/**
 * Walk up from a Chromium executable to its Playwright cache revision dir
 * (e.g. …/ms-playwright/chromium-1234 or …/chromium_headless_shell-1234).
 * Returns null when the executable is not in the standard cache layout.
 */
export function findPlaywrightRevisionDir(executablePath: string): string | null {
  let dir = path.dirname(executablePath);
  for (let i = 0; i < 8; i++) {
    if (REVISION_DIR_RE.test(path.basename(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * The Chromium revision the EMBEDDED playwright-core expects, derived from
 * the registry-computed executable path (chromium.executablePath() embeds
 * the revision from playwright-core's browsers.json — it is not read from
 * disk, so it stays correct even when nothing is installed yet).
 */
export function expectedChromiumRevision(executablePath: string): string | null {
  const revDir = findPlaywrightRevisionDir(executablePath);
  if (!revDir) return null;
  const m = path.basename(revDir).match(/-(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Find the gstack install root whose node_modules pins the SAME
 * playwright-core revision our binary embeds (ENG-OV3). Candidates:
 * the dev checkout (source runs) and the global ./setup install. A candidate
 * qualifies only when its playwright-core/browsers.json chromium revision
 * matches — running the reinstall anywhere else heals to the WRONG revision.
 */
export function findGstackInstallRoot(
  expectedRevision: string,
  candidates?: string[],
): string | null {
  const roots = candidates ?? [
    // Dev checkout: browse/src/ → repo root. In the compiled binary
    // __dirname points into the bunfs bundle and won't exist on disk,
    // so this candidate simply fails the existsSync below.
    path.resolve(__dirname, '..', '..'),
    // Global install root (the ./setup target). os.homedir() rather than
    // process.env.HOME: with HOME unset the env form produced the RELATIVE
    // path '.claude/skills/gstack' under the daemon's cwd — often an
    // untrusted repo being QA'd, whose planted node_modules would then be
    // where the heal runs the playwright install (repo-controlled code
    // execution). The absolute-or-skip guard below backstops the class.
    path.join(os.homedir(), '.claude', 'skills', 'gstack'),
  ];
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue;
    try {
      const browsersJson = path.join(root, 'node_modules', 'playwright-core', 'browsers.json');
      if (!fs.existsSync(browsersJson)) continue;
      const parsed = JSON.parse(fs.readFileSync(browsersJson, 'utf-8'));
      const rev = parsed?.browsers?.find((b: { name?: string }) => b?.name === 'chromium')?.revision;
      if (String(rev) === String(expectedRevision)) return root;
    } catch {
      continue; // unreadable/malformed candidate — try the next one
    }
  }
  return null;
}

// ─── Quarantine clear ────────────────────────────────────────────────────

function defaultRunXattr(target: string): number | null {
  const res = Bun.spawnSync(['xattr', '-dr', 'com.apple.quarantine', target], {
    windowsHide: true,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  return res.exitCode;
}

/**
 * Clear com.apple.quarantine on every chromium* revision dir in the
 * Playwright cache (the headless shell is what XProtect actually killed in
 * #2554; the headed bundle rides along so a later headed launch doesn't
 * re-trip). Scope contract mirrors probePoisonedChromiumBundle: NEVER act
 * on a GSTACK_CHROMIUM_PATH bundle — that belongs to the wrapper/embedder.
 * Best-effort: xattr failures are logged, never thrown (the forced
 * reinstall below is the real heal).
 */
export function clearQuarantineOnPlaywrightCache(
  executablePath: string,
  runXattr: (target: string) => number | null = defaultRunXattr,
): boolean {
  const customPath = process.env.GSTACK_CHROMIUM_PATH;
  if (customPath && path.resolve(executablePath) === path.resolve(customPath)) {
    logHeal('quarantine-clear-skipped', { reason: 'custom-chromium-path' });
    return false;
  }
  const revDir = findPlaywrightRevisionDir(executablePath);
  if (!revDir) {
    logHeal('quarantine-clear-skipped', { reason: 'not-in-playwright-cache', executablePath });
    return false;
  }
  const cacheRoot = path.dirname(revDir);
  let cleared = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch (err) {
    logHeal('quarantine-clear-skipped', {
      reason: 'cache-unreadable',
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  for (const entry of entries) {
    if (!REVISION_DIR_RE.test(entry)) continue;
    const target = path.join(cacheRoot, entry);
    try {
      const exitCode = runXattr(target);
      // Non-zero usually means "no such xattr" — nothing to clear, fine.
      logHeal('quarantine-clear', { target, exitCode });
      cleared++;
    } catch (err) {
      logHeal('quarantine-clear', {
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return cleared > 0;
}

// ─── Bounded forced reinstall (E1) ───────────────────────────────────────

export const XPROTECT_REINSTALL_TIMEOUT_MS = 120_000;

export interface ReinstallResult {
  ok: boolean;
  reason?: string;
  exitCode?: number | null;
}

/**
 * Run `bunx playwright install --force chromium` from the gstack install
 * root, bounded at ~120s. The child gets its own process group (detached)
 * so a timeout kills the WHOLE tree (bunx → playwright CLI → download
 * workers), never leaving a zombie download saturating the network.
 */
export function runBoundedChromiumReinstall(
  installRoot: string,
  timeoutMs: number = XPROTECT_REINSTALL_TIMEOUT_MS,
): Promise<ReinstallResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bunx', ['playwright', 'install', '--force', 'chromium'], {
        cwd: installRoot,
        detached: true, // own process group → group-kill on timeout
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, reason: `spawn-error: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + String(d)).slice(-2000);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // whole group
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn-error: ${err.message}` });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, exitCode: code });
      } else {
        resolve({
          ok: false,
          reason: `install-exit-${code}${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`,
          exitCode: code,
        });
      }
    });
  });
}

// ─── One-shot orchestration (F4) ─────────────────────────────────────────

let healAttempted = false;

/** Test seam only — production never resets the one-shot guard. */
export function resetXProtectHealForTests(): void {
  healAttempted = false;
}

export interface XProtectHealDeps {
  platform?: NodeJS.Platform;
  executablePath?: () => string;
  clearQuarantine?: (execPath: string) => boolean;
  installRoot?: (expectedRevision: string) => string | null;
  runReinstall?: (installRoot: string) => Promise<ReinstallResult>;
  verifyInstalled?: (execPath: string) => boolean;
}

/**
 * Attempt the XProtect self-heal for a classified launch failure.
 *
 * Returns true when the heal completed AND the revision dir the embedded
 * playwright-core expects exists on disk — the caller should retry the
 * launch exactly once. Returns false when the error doesn't match the
 * signature, the launch used a custom executable, the one-shot guard
 * already fired, or any heal step failed (the caller then surfaces the
 * original error + manual guidance).
 */
export async function maybeHealXProtectKill(
  err: unknown,
  opts: { usesCustomExecutable?: boolean } = {},
  deps: XProtectHealDeps = {},
): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  if (!isXProtectKillSignature(message, deps.platform ?? process.platform)) return false;
  if (opts.usesCustomExecutable) {
    // A GSTACK_CHROMIUM_PATH bundle belongs to the wrapper/embedder — never
    // quarantine-clear or reinstall over it (probePoisonedChromiumBundle's
    // scope contract).
    logHeal('skip', { reason: 'custom-executable' });
    return false;
  }
  if (healAttempted) {
    logHeal('skip', { reason: 'already-attempted-this-process' });
    return false;
  }
  healAttempted = true; // F4: at most one heal per process, even on failure
  logHeal('classified', { signature: 'xprotect-kill' });

  const execPath = (deps.executablePath ?? (() => chromium.executablePath()))();
  (deps.clearQuarantine ?? clearQuarantineOnPlaywrightCache)(execPath);

  const revision = expectedChromiumRevision(execPath);
  if (!revision) {
    logHeal('reinstall-skipped', { reason: 'no-revision-in-path', execPath });
    return false;
  }
  const root = (deps.installRoot ?? findGstackInstallRoot)(revision);
  if (!root) {
    // No install root pins our revision — a cwd-resolved install would heal
    // to the WRONG revision (ENG-OV3), so surface guidance instead.
    logHeal('reinstall-skipped', { reason: 'no-install-root', revision });
    return false;
  }

  logHeal('reinstall-start', { installRoot: root, revision, timeoutMs: XPROTECT_REINSTALL_TIMEOUT_MS });
  const result = await (deps.runReinstall ?? runBoundedChromiumReinstall)(root);
  if (!result.ok) {
    logHeal('reinstall-failed', { reason: result.reason });
    return false;
  }

  // F9/ENG-OV3: assert the revision dir the embedded playwright-core
  // EXPECTS exists post-heal — install exit 0 alone can mean "installed the
  // wrong revision" when resolution went sideways.
  const verify = deps.verifyInstalled ?? ((p: string) => fs.existsSync(p));
  if (!verify(execPath)) {
    logHeal('verify-failed', { expected: execPath });
    return false;
  }
  logHeal('reinstall-ok', { installRoot: root, revision });
  return true;
}

/**
 * Original launch error + manual remediation, for classified failures the
 * heal could not fix (offline, timeout, one-shot spent, no install root).
 */
export function buildXProtectGuidance(originalMessage: string): string {
  return (
    `${originalMessage}\n` +
    '[browse] This launch failure matches the macOS XProtect kill signature (#2554): ' +
    "the OS killed Playwright's Chromium at spawn. Automatic self-heal did not complete. " +
    'Fix manually: run `bunx playwright install chromium` from your gstack install ' +
    '(the directory whose node_modules pins playwright — ~/.claude/skills/gstack for ' +
    'global installs), then retry.'
  );
}

/**
 * Wrap a Playwright launch call with the XProtect self-heal: on a classified
 * failure, heal once and retry the launch once. On a classified failure the
 * heal could not fix, throw the ORIGINAL error text augmented with manual
 * guidance. Unclassified failures pass through untouched.
 */
export async function launchWithXProtectHeal<T>(
  doLaunch: () => Promise<T>,
  opts: { usesCustomExecutable?: boolean } = {},
  deps: XProtectHealDeps = {},
): Promise<T> {
  try {
    return await doLaunch();
  } catch (err) {
    const healed = await maybeHealXProtectKill(err, opts, deps);
    if (healed) {
      logHeal('retry-launch', {});
      try {
        return await doLaunch();
      } catch (retryErr) {
        // The heal ran but the retry died too. Without this wrap the second
        // error propagated raw and the manual-remediation guidance was lost
        // exactly when the automatic path had just proven insufficient.
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (isXProtectKillSignature(retryMessage, deps.platform ?? process.platform)) {
          throw new Error(buildXProtectGuidance(retryMessage), { cause: retryErr });
        }
        throw retryErr;
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isXProtectKillSignature(message, deps.platform ?? process.platform)) {
      throw new Error(buildXProtectGuidance(message), { cause: err });
    }
    throw err;
  }
}
