/**
 * Hermetic child environment for E2E test runners.
 *
 * Local E2E runs spawn `claude` (and codex/gemini/SDK) children that, until
 * this module, inherited the operator's full session context: ~/.claude
 * (user CLAUDE.md, .claude.json MCP servers incl. gbrain + Conductor,
 * skills), ~/.gstack decision logs, and CONDUCTOR_-/CLAUDECODE-style env vars.
 * CI was hermetic only by accident (fresh Docker /home/runner). This module
 * makes local children see a CI-equivalent clean room by default.
 *
 *   operator shell (contaminated)            hermetic child env
 *   ┌─────────────────────────────┐  buildHermeticEnv()
 *   │ PATH, HOME, TMPDIR, ...     │── allowlist ─────────► kept
 *   │ HTTP(S)_PROXY, SSL_CERT_*   │── allowlist ─────────► kept (network)
 *   │ ANTHROPIC_API_KEY/BASE_URL/ │── named list ────────► kept (auth)
 *   │   AUTH_TOKEN                │
 *   │ GSTACK_ANTHROPIC_API_KEY    │── promotedEnv() ─────► ANTHROPIC_API_KEY
 *   │ CONDUCTOR_*, CLAUDECODE,    │
 *   │ CLAUDE_*, GSTACK_*, MCP_*,  │── dropped ───────────► ∅
 *   │ GBRAIN_*, GH_TOKEN, ...     │
 *   └─────────────────────────────┘
 *      + per-runner extraAllow (codex: OpenAI vars; gemini: Google vars)
 *      + CLAUDE_CONFIG_DIR=<runRoot>/.claude  GSTACK_HOME=<runRoot>/gstack-home
 *      + per-test overrides spread LAST
 *
 * Escape hatch: EVALS_HERMETIC=0 restores the legacy contaminated env
 * byte-identically (runners must also gate --strict-mcp-config on
 * isHermeticEnabled() so the escape hatch restores args too).
 *
 * isHermeticEnabled() is evaluated at CALL time, never at module load —
 * ESM hoists imports above any in-file `process.env.EVALS_HERMETIC = '0'`
 * assignment, so a module-load-time read would silently ignore test pins.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promotedEnv } from '../../lib/conductor-env-shim';
import { isProcessAlive } from '../../browse/src/error-handling';

/** Exact env names a hermetic child keeps. Everything not listed (or matched
 * by a prefix rule below) is dropped. */
const ALLOW_EXACT = new Set([
  // Process basics
  'PATH', 'HOME', 'TMPDIR', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'SHELL',
  'USER', 'LOGNAME', 'TZ', 'NODE_ENV', 'CI',
  // Browser/runtime caches the child legitimately shares with the operator
  'PLAYWRIGHT_BROWSERS_PATH',
  // Network reachability — without these, children on proxied networks can't
  // reach the Anthropic API at all
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Auth — named, NOT the broad ANTHROPIC_* prefix: a prefix rule would
  // smuggle model/beta/debug knobs that change eval behavior
  'ANTHROPIC_API_KEY',   // the auth credential evals require
  'ANTHROPIC_BASE_URL',  // API endpoint override (corp proxies)
  'ANTHROPIC_AUTH_TOKEN', // bearer-token auth variant
]);

/** Prefix rules: eval-harness knobs + CI metadata. Deliberately NOT here:
 * CONDUCTOR_* / CLAUDE_* (incl. CLAUDECODE, CLAUDE_CODE_ENTRYPOINT) /
 * GSTACK_* / MCP_* / GBRAIN_* — session-context contamination; and operator
 * credentials (GH_TOKEN, SSH_AUTH_SOCK, GIT_*, OPENAI_API_KEY,
 * VOYAGE_API_KEY) — CI doesn't have them and eval children have no business
 * using them. A test that legitimately needs one opts in via its own env
 * override; a provider runner (codex/gemini) re-admits its auth vars via
 * opts.extraAllow. */
const ALLOW_PREFIXES = ['EVALS_', 'GITHUB_'];

export interface HermeticEnvOpts {
  /** Per-runner additional allowed names (exact match) or prefixes (entries
   * ending in '*'). Example: codex runner passes ['OPENAI_API_KEY', 'CODEX_*']. */
  extraAllow?: string[];
}

/** EVALS_HERMETIC !== '0'. Read at call time (see module doc — ESM hoist). */
export function isHermeticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EVALS_HERMETIC !== '0';
}

/**
 * Pure allowlist scrub. No I/O. Overrides spread LAST so per-test env
 * (GSTACK_HOME, CONDUCTOR_WORKSPACE_PATH, GSTACK_HEADLESS opt-out) always
 * wins over the scrub — that is the documented re-contamination escape and
 * the wiring tripwire forbids passing raw process.env through it.
 */
export function buildHermeticEnv(
  base: NodeJS.ProcessEnv,
  hermeticVars: Record<string, string>,
  overrides?: Record<string, string | undefined>,
  opts?: HermeticEnvOpts,
): Record<string, string> {
  if (!isHermeticEnabled(base)) {
    // Escape hatch: byte-identical to the legacy spread.
    const legacy: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined) legacy[k] = v;
    for (const [k, v] of Object.entries(overrides ?? {})) if (v !== undefined) legacy[k] = v;
    return legacy;
  }

  const promoted = promotedEnv(base);
  const extraExact = new Set<string>();
  const extraPrefixes: string[] = [];
  for (const entry of opts?.extraAllow ?? []) {
    if (entry.endsWith('*')) extraPrefixes.push(entry.slice(0, -1));
    else extraExact.add(entry);
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(promoted)) {
    if (v === undefined) continue;
    const allowed =
      ALLOW_EXACT.has(k) ||
      extraExact.has(k) ||
      ALLOW_PREFIXES.some((p) => k.startsWith(p)) ||
      extraPrefixes.some((p) => k.startsWith(p));
    if (allowed) out[k] = v;
  }
  if (!out.TERM) out.TERM = 'xterm-256color';
  Object.assign(out, hermeticVars);
  for (const [k, v] of Object.entries(overrides ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

export interface SeedConfigOpts {
  /** When undefined (operator has no key exported), customApiKeyResponses is
   * omitted — the child fails auth exactly as it would today, no throw here. */
  apiKey: string | undefined;
  trustedDirs: string[];
}

/**
 * Minimal $CLAUDE_CONFIG_DIR/.claude.json for fresh-config children.
 *
 * Empirically verified 2026-06-12 on claude 2.1.175: PRINT MODE (`claude -p`)
 * with ANTHROPIC_API_KEY needs NO seed at all — a fresh empty config dir ran
 * non-interactively (exit 0, real cost billed to the key). The seed exists
 * for the PTY path, where first-run TUI prompts DO appear:
 * - hasCompletedOnboarding: suppresses the onboarding flow
 * - customApiKeyResponses.approved: suppresses the "use this API key?"
 *   prompt; entries are the key's LAST 20 CHARS (shape verified against a
 *   real ~/.claude.json)
 * - projects[dir].hasTrustDialogAccepted: pre-trusts repo-cwd PTY sessions
 *   (the pty-runner's 15s trust-watcher remains as fallback for temp cwds)
 * bypassPermissionsModeAccepted was considered and dropped: absent from a
 * real config even though --dangerously-skip-permissions is in daily use.
 */
export function buildSeedConfig(opts: SeedConfigOpts): Record<string, unknown> {
  const seed: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    projects: Object.fromEntries(
      opts.trustedDirs.map((dir) => [
        dir,
        { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      ]),
    ),
  };
  if (opts.apiKey) {
    seed.customApiKeyResponses = { approved: [opts.apiKey.slice(-20)] };
  }
  return seed;
}

export interface HermeticDirs {
  /** Ends in `/.claude` — load-bearing: extractPlanFilePath in
   * claude-pty-runner.ts:191 anchors plan-file paths on `.claude/plans/`
   * under a /var|/tmp prefix. Renaming this segment breaks PTY plan tests. */
  configDir: string;
  gstackHome: string;
  runRoot: string;
}

const DIR_PREFIX = 'gstack-hermetic-';

let cachedDirs: HermeticDirs | null = null;

/** Repo root for the trusted-dir seed: test files live in <root>/test/helpers. */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Sync memoized per-process singleton — intentionally NO async gap between
 * the cache check and create+seed, so concurrent first calls under
 * `bun test --concurrent` cannot double-create or observe a half-seeded dir.
 * Shared across all tests in the process: that matches CI's within-job
 * shared /home/runner (operator isolation, not per-test isolation).
 */
export function getHermeticDirs(): HermeticDirs {
  if (cachedDirs) return cachedDirs;

  gcStaleHermeticDirs();

  // Embed our pid so the GC of future processes can check liveness.
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${DIR_PREFIX}${process.pid}-`));
  const configDir = path.join(runRoot, '.claude');
  const gstackHome = path.join(runRoot, 'gstack-home');

  // A half-seeded config dir means children hang on first-run prompts until
  // the test timeout — far worse than failing loudly here. So we throw on
  // failure, but tear down the partial dir first: an unseeded runRoot named
  // with our (alive) pid would be skipped by this process's GC and leak until
  // process exit, so remove it before rethrowing.
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(gstackHome, { recursive: true });
    const seed = buildSeedConfig({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.GSTACK_ANTHROPIC_API_KEY,
      trustedDirs: [repoRoot()],
    });
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(seed, null, 2));
  } catch (err) {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  process.on('exit', () => {
    // Exit handlers cannot await: sync best-effort removal only. Anything
    // left behind is reclaimed by the next process's pid-aware GC.
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch { /* GC reclaims */ }
  });

  cachedDirs = { configDir, gstackHome, runRoot };
  return cachedDirs;
}

/** A dir younger than this is never GC'd even if its pid looks dead — guards
 * against PID reuse deleting a freshly-created dir whose original pid exited
 * and was recycled to an unrelated live process between create and GC. */
const GC_MIN_AGE_MS = 60 * 60 * 1000; // 1h

/**
 * Reclaim leftovers from crashed runs. Two signals, both required: the
 * embedded pid is dead AND the dir is older than GC_MIN_AGE_MS. Pid-alone
 * would risk PID-reuse false-deletes of live dirs; age-alone would delete a
 * live >24h eval run's config out from under it. Exported for tests.
 */
export function gcStaleHermeticDirs(tmpDir: string = os.tmpdir()): void {
  let entries: string[];
  try { entries = fs.readdirSync(tmpDir); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const pidStr = name.slice(DIR_PREFIX.length).split('-')[0];
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid || isProcessAlive(pid)) continue;
    const full = path.join(tmpDir, name);
    try {
      if (now - fs.statSync(full).mtimeMs < GC_MIN_AGE_MS) continue; // too fresh
    } catch { continue; } // vanished or unreadable — leave it
    try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * The composition runners use: scrub process.env, point the child at the
 * singleton hermetic dirs, apply per-test overrides last. Returns the legacy
 * env untouched when EVALS_HERMETIC=0 (and skips dir creation entirely).
 */
export function hermeticChildEnv(
  overrides?: Record<string, string | undefined>,
  opts?: HermeticEnvOpts,
): Record<string, string> {
  if (!isHermeticEnabled()) {
    return buildHermeticEnv(process.env, {}, overrides, opts);
  }
  const dirs = getHermeticDirs();
  return buildHermeticEnv(
    process.env,
    { CLAUDE_CONFIG_DIR: dirs.configDir, GSTACK_HOME: dirs.gstackHome },
    overrides,
    opts,
  );
}
