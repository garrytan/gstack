/**
 * Windows-safe curation for the free suite (`--windows-only`): POSIX-only
 * source patterns, explicit known-incompatible files, and force-includes for
 * pattern hits that do not apply. Pinned by test/test-free-shards.test.ts and
 * test/windows-native-workflows.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');

// POSIX-only patterns that indicate a test will fail on windows-latest no
// matter how the runner shards. Codex's v1.18.0.0 review flagged the first
// three as concrete examples in the existing free suite (test/ship-version-sync.test.ts:72,
// test/helpers/providers/claude.ts:22, package.json:12). We scan the test's
// own content here so the filter stays automatic as new tests land. The
// "Windows-incompatible APIs" patterns at the bottom were added after the
// first windows-free-tests CI run surfaced concrete failure modes.
const WINDOWS_FRAGILE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Hardcoded POSIX shells / commands.
  { pattern: /['"`]\/bin\/(?:ba)?sh/, reason: 'hardcoded /bin/sh or /bin/bash' },
  { pattern: /spawnSync\(['"]sh['"],|spawn\(['"]sh['"],|exec\(['"]sh /, reason: 'spawn("sh", ...)' },
  { pattern: /['"]bash -c['"]|['"]sh -c['"]/, reason: 'bash -c / sh -c' },
  { pattern: /['"`]\/tmp\//, reason: 'raw /tmp/ path (use os.tmpdir())' },
  { pattern: /['"]chmod\b/, reason: 'chmod shell command' },
  { pattern: /['"]xargs\b/, reason: 'xargs pipeline' },
  { pattern: /\bwhich claude\b/, reason: 'which claude (use Bun.which)' },
  // Windows-incompatible APIs.
  { pattern: /\.mode\s*&\s*0o[0-7]+/, reason: 'POSIX file mode bitmask (mode & 0o600 etc — Windows fakes mode bits)' },
  { pattern: /\.endsWith\(['"]\//, reason: 'hardcoded forward-slash path assertion (Windows uses \\\\)' },
  { pattern: /['"]\.\/[a-zA-Z][^"']*['"]\)\s*\.\s*toBe\(true\)/, reason: 'forward-slash path comparison' },
  // Tests that spawn a bash shebang script in bin/ via spawnSync. Git Bash on
  // Windows can run `bash /path/to/script` but spawnSync(scriptPath, ...)
  // tries to execute the file directly via CreateProcess, which fails on the
  // shebang. The pattern matches `, 'bin'` as a path-join argument (closing
  // OR followed by another segment), which catches:
  //   - path.join(ROOT, 'bin', 'script-name')        — typical
  //   - join(import.meta.dir, '..', 'bin', 'name')   — destructured (diff-scope)
  //   - path.join(ROOT, 'bin')                       — bare BIN constant (brain-sync)
  { pattern: /,\s*['"]bin['"]\s*[,)]|['"]\.?\/?bin\/[a-z][\w-]+['"]/, reason: 'spawns bin/ shebang script (Windows CreateProcess does not parse shebangs)' },
  // Tests that spawn the browse server as a subprocess via `bun run server.ts`.
  // The Bun → server.ts → Playwright path is the same one that doesn't work
  // on Windows (PR #1238 windows-pty-bun-pty-fix). Tests typically set
  // BROWSE_HEADLESS_SKIP=1 to skip the browser launch but still need a working
  // server, which they don't get on Windows.
  { pattern: /BROWSE_HEADLESS_SKIP|spawn\(\[['"]bun['"],\s*['"]run['"]/, reason: 'spawns the browse server subprocess (Bun-driven path is Windows-broken)' },
];

// Explicit known-Windows-incompatible test files that don't fit a regex
// pattern. Listed here with the precise reason. Prefer adding a pattern above
// when possible; this list is for environment-/runtime-specific tests where
// the failure mode is structural rather than detectable via source-file scan.
export const KNOWN_WINDOWS_INCOMPATIBLE: Array<{ file: string; reason: string }> = [
  {
    file: 'test/ship-measure-seeded-fixture.test.ts',
    reason: 'drives a POSIX shell stub project (`./evals.sh` with a shebang) that CreateProcess cannot exec; the measure runner itself is covered by ship-measure.test.ts with in-process fake runners',
  },
  {
    file: 'test/qa-evidence-producer.test.ts',
    reason: 'executes the registered Linux native actor and its inotify observer; portable capture and Windows job behavior are covered by qa-evidence.test.ts',
  },
  {
    file: 'test/qa-functional-fixture.test.ts',
    reason: 'executes graceful POSIX signal cancellation; Bun on Windows uses TerminateProcess and cannot run the fixture SIGTERM cleanup handler',
  },
  {
    file: 'test/qa-functional-observer-atomic.test.ts',
    reason: 'exercises real Linux inotify inode and directory watches through libc.so.6; Windows has no equivalent kernel interface',
  },
  {
    file: 'test/docsync-report-interface.test.ts',
    reason: 'executes registered native documentation callbacks with their real Linux inotify write observer before the model boundary',
  },
  {
    file: 'test/setup-gbrain-fixture.test.ts',
    reason: 'the fixture invokes real POSIX detector/verifier helpers through executable shebang wrappers',
  },
  {
    file: 'test/hermetic-skills-seeding.test.ts',
    reason: 'seeds the POSIX PTY skill runtime, whose embedded shell paths require a POSIX temporary root',
  },
  {
    file: 'test/hermetic-wiring.test.ts',
    reason: 'its runtime contract check seeds the POSIX PTY skill runtime; the curated Windows lane does not run that harness',
  },
  {
    file: 'test/pty-workspace-trust.test.ts',
    reason: 'launches the POSIX PTY harness with a fake executable and bound skill runtime',
  },
  {
    file: 'test/host-config.test.ts',
    reason: 'asserts "claude" binary on PATH (only true when running inside Claude Code, not on bare CI runner)',
  },
  {
    file: 'browse/test/findport.test.ts',
    reason: 'asserts Bun.serve.stop() is fire-and-forget — Bun behavior differs on Windows for this polyfill',
  },
  // First full run of the expanded lane (v1.66, 13 → ~258 files) surfaced
  // seven POSIX-bound files the content patterns cannot see (their
  // POSIX-ness is what they TEST, or arrives via a variable). Receipts:
  // PR #2593 windows-free-tests run 31918591602.
  {
    file: 'test/codex-under-codex-detection.test.ts',
    reason: 'drives the rendered preflight bash under a hardcoded POSIX PATH (/usr/bin:/bin) — bash is unreachable through that PATH on Windows, so every case sees empty output (v1.67 windows lane run 95234224148)',
  },
  {
    file: 'test/regression-pr1169-build-app-sed.test.ts',
    reason: 'tests sed escape sequences in build-app.sh — sed/bash are the subject under test',
  },
  {
    file: 'test/setup-conductor-worktree.test.ts',
    reason: 'tests ln -snf symlink semantics in the setup script — POSIX ln is the subject under test',
  },
  {
    file: 'test/artifacts-init-migration.test.ts',
    reason: 'runs a bash migration script + jq against a scaffolded git state — POSIX toolchain paths break under cmd spawn',
  },
  {
    file: 'test/gstack-decision-semantic.test.ts',
    reason: 'installs a fake gbrain SHEBANG SHIM on PATH; Windows spawn cannot exec shebang scripts',
  },
  {
    file: 'test/question-log-hook.test.ts',
    reason: 'spawns the PostToolUse hook script (bash shebang) directly; Windows spawn cannot exec it',
  },
  {
    file: 'browse/test/browser-skills-e2e.test.ts',
    reason: 'asserts forward-slash tier paths (<repo>/browser-skills/) that resolve with backslashes on Windows',
  },
  {
    file: 'design/test/variants-retry-after.test.ts',
    reason: 'wall-clock retry-timing assertions — flaky on the slow windows-latest runner even with widened bounds',
  },
  // Round-2 census (PR #2593 run 31919227507) after the first seven:
  {
    file: 'test/skill-census.test.ts',
    reason: 'census walk throws at module load on Windows (skill-census.ts:63) — the skills-tree symlink layout needs Developer Mode that CI runners lack',
  },
  {
    file: 'browse/test/browser-manager-unit.test.ts',
    reason: 'wedges the shard to its wall deadline on windows-latest (in-flight at kill); needs a Windows repro to diagnose — macOS + Linux lanes cover the file',
  },
  // Round-3 census (PR #2593 run 31919871680): the round-2 wedge had been
  // TRUNCATING its shard, so these seven only surfaced once shard 2 completed.
  // All the same POSIX-environment classes: PID/cmdline identity probing,
  // bash scripts as the subject under test, env-scrubbed child spawns.
  {
    file: 'browse/test/server-embedder-terminal-port.test.ts',
    reason: 'identity-based terminal-agent kill probes PID/cmdline with POSIX semantics; teardown asserts fail on windows-latest',
  },
  {
    file: 'design/test/daemon-discovery.test.ts',
    reason: 'verifyIdentity matches a spawned daemon via /proc-style cmdline probing — POSIX identity semantics',
  },
  {
    file: 'test/context-save-hardening.test.ts',
    reason: 'bash context-save/migration scripts (HOME-unset semantics, random-suffix path) are the subject under test',
  },
  {
    file: 'test/eval-list-cli.test.ts',
    reason: 'spawns the eval:list CLI via bun with a constructed env — bun resolution fails under Windows spawn',
  },
  {
    file: 'test/memory-cache-injection.test.ts',
    reason: 'exercises hook/deny-enforcement shell scripts — POSIX toolchain is the subject under test',
  },
  {
    file: 'test/migrations-v1.65.0.0.test.ts',
    reason: 'bash migration script (bunx re-fetch, .done markers) is the subject under test',
  },
  {
    file: 'test/question-preference-hook.test.ts',
    reason: 'spawns the PreToolUse preference hook (shebang script) directly; Windows spawn cannot exec it',
  },
  // Round-4 census (PR #2593 run 31920052810): unhandled errors with no
  // (fail) lines — attributed statically (the lane had no log artifact yet).
  {
    file: 'browse/test/browser-skill-commands.test.ts',
    reason: 'spawnSkill spawns bun with a constructed env — bun resolution fails under Windows spawn (unhandled, no (fail) line)',
  },
  {
    file: 'browse/test/security-audit-r2.test.ts',
    reason: 'symlink-attack fixtures (evil-link) need Developer Mode CI runners lack; expect(toThrow) fires unhandled on Windows',
  },
  // CSO comprehensive execution is qualified only for Linux containers behind
  // the POSIX watchdog and Unix-domain registry broker. Keep the portable
  // static/parser contracts in the Windows lane while leaving these exact
  // containment suites to the Linux and macOS gates.
  {
    file: 'test/cso-preparation-adversarial.test.ts',
    reason: 'exercises POSIX prepared-tree and archive-cache containment for qualified Linux Docker execution, which Windows does not admit',
  },
  {
    file: 'test/cso-preparation-container.test.ts',
    reason: 'asserts POSIX permission and symlink semantics for inert exports consumed by qualified Linux Docker execution',
  },
  {
    file: 'test/cso-preparation-executor.test.ts',
    reason: 'executes the Linux Docker acquisition path and its Unix-domain registry broker; comprehensive execution is unavailable on Windows',
  },
  {
    file: 'test/cso-verification-cleanup.test.ts',
    reason: 'spawns the POSIX detached watchdog used by contained repair verification, which Windows intentionally leaves unavailable',
  },
  {
    file: 'test/cso-witness.test.ts',
    reason: 'tests the contained repair witness with POSIX private-directory and compiled-helper assumptions; comprehensive execution is unavailable on Windows',
  },
  {
    file: 'test/shard-engine-equivalence.test.ts',
    reason: 'its classification golden was recorded from the POSIX runners (process-group wall kill); the win32 engine path is pinned by the mocked-platform case in shard-engine.test.ts',
  },
  {
    file: 'test/claude-overlay-setup-default.test.ts',
    reason: 'every case runs the real ./setup under describe.skipIf(win32); its bin/ spawns live in test/helpers/claude-overlay-fixture.ts, so the source scan misses them',
  },
  {
    file: 'test/claude-overlay-setup-installs.test.ts',
    reason: 'every case runs the real ./setup under describe.skipIf(win32); its bin/ spawns live in test/helpers/claude-overlay-fixture.ts, so the source scan misses them',
  },
  {
    file: 'test/cso-scanner-cli.test.ts',
    reason: 'drives the prebuilt POSIX CSO launcher with /usr/bin/git and a POSIX-only PATH; native Windows launcher behavior is covered by the dedicated cso-windows-launcher gate',
  },
];

// Force-include overrides: files a WINDOWS_FRAGILE_PATTERNS regex excludes for
// a reason that does not actually apply to them. Each entry documents WHY the
// pattern hit is a false positive — the point of these files is Windows
// coverage, so auto-excluding them defeats the regression tests they carry.
export const KNOWN_WINDOWS_SAFE: Array<{ file: string; reason: string }> = [
  // Named Windows coverage for fixes whose bug only bites on Windows: kept in
  // the curated lane even if a future edit trips a content pattern.
  { file: 'browse/test/cli-chain-stdin.test.ts', reason: 'piped-stdin browse chain against a stub daemon, and no-flow usage errors before any daemon boots; spawns the CLI through Bun argv' },
  { file: 'browse/test/runtime-root-server-bundle.test.ts', reason: 'a runtime root copy without node_modules resolves the checkout bundle via .source-path and refuses on version skew; os.tmpdir layouts only' },
  { file: 'test/cso-windows-docker.test.ts', reason: '/cso docker.exe discovery under known-folder roots (real path, no reparse points) and the native-transport-unsupported outcome; pure win32 path logic' },
  { file: 'test/copilot-windows-bash.test.ts', reason: 'the Copilot glossary line that runs bash blocks in Git for Windows Bash; reads host config only' },
  { file: 'test/ship-hook-windows-paths.test.ts', reason: 'runs bin/ helpers through explicit bash and Bun argv with forward-slash paths; never executes a shebang; the path-spelling simulation is skipIf win32' },
  { file: 'test/state-root-parity.test.ts', reason: 'runs the bash twin and lib/state-root.ts over an env table with PATH empty; no shebang execution, raw-string comparison is platform-neutral' },
  { file: 'test/generator-eexist.test.ts',
    reason: 'E4: runs the generators through Bun argv with the Windows EEXIST emulation preload; no shebang execution' },
  { file: 'test/gstack-config-gbrain-refresh.test.ts', reason: 'E6: runs bin/gstack-config through explicit bash; its gbrain/python3 shims are found by bash PATH lookup, never launched by CreateProcess' },
  { file: 'test/hook-scripts.test.ts', reason: '#3067 PowerShell and NotebookEdit hook coverage: every hook runs through spawnSync("bash", [script]) with the payload on stdin, scratch state lives under os.tmpdir(); its /tmp/ literals are payload strings, never opened; symlink, newline-path and POSIX-PATH cases are skipIf win32' },
  { file: 'test/gstack-doctor.test.ts', reason: 'runs bin/gstack-doctor and setup --status through explicit bash argv in an os.tmpdir fixture; its bun/codex/claude/probe stubs are found by bash PATH lookup, and expected paths use bash spellings' },
  {
    file: 'test/qa-evidence.test.ts',
    reason: 'invokes the production helper through Bun argv and exercises native Windows job cleanup, private file captures and backpressured receipt output',
  },
  {
    file: 'test/qa-evidence-selection.test.ts',
    reason: 'bin/ strings are literal dependency and Windows-selection assertions; no native actor or shebang command is launched',
  },
  {
    file: 'test/qa-deadline.test.ts',
    reason: 'launches the guard through Bun argv; mode assertions and POSIX signal cases are platform-gated, while Windows job cleanup must execute natively',
  },
  {
    file: 'test/qa-deadline-selection.test.ts',
    reason: 'bin/ strings are dependency-selection inputs; this suite never launches a shebang executable',
  },
  {
    file: 'test/shared-libs-source-reads.test.ts',
    reason: 'bin/ literal is a mocked launch assertion; actual worktree fingerprinting explicitly invokes Bash on Windows',
  },
  {
    file: 'test/claude-code-windows-job.test.ts',
    reason: 'invokes Bun directly; verifies Windows job containment at the standalone CLI boundary',
  },
  {
    file: 'test/claude-code-runner.test.ts',
    // The bin/ path is launched through process.execPath (Bun), never as a shebang; keep taskkill supervision in the Windows lane.
    reason: 'invokes the runner via Bun argv; fake CLI and timeout descendant assertions cover native Windows taskkill',
  },
  {
    file: 'test/setup-gbrain-remote-caller.test.ts',
    // bin is an expected PATH component; the adapter injects the SDK boundary
    // and never launches a shebang. Keep the native delimiter cases in CI.
    reason: 'replays the registered SDK callback with fixture-only bin paths; covers native Windows PATH composition',
  },
  {
    file: 'test/cso-windows-build-contract.test.ts',
    // bin is a temporary staging directory. The adapter injects spawnSync;
    // real PowerShell/native execution remains in cso-windows-launcher.
    reason: 'replays the native build callbacks with an injected subprocess; bin paths are staging fixtures, not shebang launches',
  },
  {
    file: 'test/setup-windows-rerun-refresh.test.ts',
    // Trips the "spawns bin/ shebang script" pattern via path.join(..., 'bin',
    // 'tool.sh') fixture paths, but every spawn goes through test/helpers/bash-script.ts
    // (bash <tempfile>) — Git Bash executes it fine on windows-latest, with no argv-length ceiling. This file IS
    // the #2444 Windows regression coverage (IS_WINDOWS=1 copy-refresh path);
    // excluding it here would keep the bug class unexercised on the one
    // platform it bites.
    reason: 'bin/ hits are fixture path segments; spawns bash explicitly — the IS_WINDOWS=1 refresh path must run on windows-latest',
  },
  {
    file: 'test/uninstall-windows-copies.test.ts',
    // Trips the "spawns bin/ shebang script" pattern via the
    // path.join(ROOT, 'bin', 'gstack-uninstall') constant, but the script is
    // always spawned through spawnSync('bash', [UNINSTALL, ...]). This file
    // carries the #2563 Windows real-dir-copy uninstall coverage — the bug
    // ONLY reproduces on the copy install shape windows-latest exercises.
    // The symlink-shape describe block self-skips on win32.
    reason: 'bin/ hit is a bash-spawned script path; #2563 real-dir uninstall coverage must run on windows-latest',
  },
  {
    file: 'browse/test/file-permissions.test.ts',
    // Trips the POSIX-mode-bitmask pattern, but every `mode & 0o777` assertion
    // is platform-guarded: win32-only tests return early, POSIX-only tests
    // guard the bitmask behind `process.platform !== 'win32'`, and the
    // symlink-skip regression test both wraps symlinkSync in try/catch
    // (runners without Developer Mode can't create symlinks) and guards its
    // bitmask — on win32 it asserts behavior (warns, skips, doesn't throw,
    // target stays usable), never fake Windows mode bits (dirs stat 0o777
    // there, so a 0o755 expectation fails on runner semantics, not our code).
    // This file carries the win32-only icacls-by-SID regression tests, which
    // can ONLY execute on windows-latest — excluding it here means the
    // machine-account ACL lockout regression is never exercised on the one
    // platform it bricks.
    reason: 'every mode-bitmask assertion is guarded off win32 (behavior asserted instead); win32-only ACL regression tests must run on windows-latest',
  },
  {
    file: 'browse/test/terminal-agent-owner-watchdog.test.ts',
    // Trips the spawn(['bun','run',...]) pattern, whose reason is the
    // Playwright-bound browse server. This test spawns terminal-agent.ts,
    // which imports only fs/path/crypto + local helpers (no Playwright, no
    // PTY at module scope) and boots under Bun on Windows — the owner-PID
    // orphan leak it pins was reported on Windows (#2019).
    reason: 'spawns terminal-agent (no Playwright), not the browse server; owner-orphan leak is a Windows defect',
  },
];

/**
 * Pattern hits disproved by running each excluded file alone on windows-latest
 * (temporary probe run 37221995077, Bun 1.4.0, Chromium installed): every case
 * passed and at least one case executed. Their /tmp/ literals are fixture
 * strings or platform-gated, never opened on Windows.
 */
export const WINDOWS_PROBE_SAFE: string[] = [
  'browse/test/data-platform.test.ts',
  'browse/test/dual-listener.test.ts',
  'browse/test/error-handling.test.ts',
  'browse/test/learnings-injection.test.ts',
  'browse/test/pdf-flags.test.ts',
  'browse/test/security-adversarial.test.ts',
  'browse/test/tunnel-gate-unit.test.ts',
  'browse/test/xprotect-heal.test.ts',
  'design/test/feedback-roundtrip.test.ts',
  'ios-qa/daemon/test/tailscale-localapi.test.ts',
  'make-pdf/test/asideClient.test.ts',
  'make-pdf/test/e2e/diagram-gate.test.ts',
  'make-pdf/test/e2e/emoji-gate.test.ts',
  'make-pdf/test/e2e/format-gate.test.ts',
  'make-pdf/test/e2e/landscape-gate.test.ts',
  'test/brain-preflight.test.ts',
  'test/ceo-barless-submit.test.ts',
  'test/ceo-split-collection.test.ts',
  'test/ceo-split-question-policy.test.ts',
  'test/ci-paid-coordination.test.ts',
  'test/design-md.test.ts',
  'test/document-skills-redaction.test.ts',
  'test/evals-workflow-wiring.test.ts',
  'test/gbrain-guards.test.ts',
  'test/global-discover.test.ts',
  'test/helpers-unit.test.ts',
  'test/helpers/hermetic-env.test.ts',
  'test/office-hours-review.test.ts',
  'test/paid-run-manifest.test.ts',
  'test/paid-shards.test.ts',
  'test/plan-count-completion.test.ts',
  'test/plan-design-floor-fixture.test.ts',
  'test/pty-skill-seeding-wiring.test.ts',
  'test/regression-issue2091-bsd-mktemp.test.ts',
  'test/regression-pr1169-mktemp-fallbacks.test.ts',
  'test/resolvers-gbrain-save-results.test.ts',
  'test/skill-preflight-budget.test.ts',
  'test/takes-fence-fallback.test.ts',
  'test/terse-build.test.ts',
  'test/typecheck-test-ratchet.test.ts',
];

/**
 * Returns the first POSIX-only pattern hit in the file, or null if Windows-safe.
 */
export function detectWindowsFragility(absolutePath: string): { reason: string } | null {
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }
  for (const { pattern, reason } of WINDOWS_FRAGILE_PATTERNS) {
    if (pattern.test(content)) return { reason };
  }
  return null;
}

export interface CurationResult {
  safe: string[];
  excluded: Array<{ file: string; reason: string }>;
}

export function curateWindowsSafe(files: string[], rootDir = ROOT): CurationResult {
  const safe: string[] = [];
  const excluded: Array<{ file: string; reason: string }> = [];
  const knownBad = new Map(KNOWN_WINDOWS_INCOMPATIBLE.map((e) => [e.file, e.reason]));
  const knownSafe = new Set([...KNOWN_WINDOWS_SAFE.map((e) => e.file), ...WINDOWS_PROBE_SAFE]);
  for (const relativePath of files) {
    const knownReason = knownBad.get(relativePath);
    if (knownReason) {
      excluded.push({ file: relativePath, reason: knownReason });
      continue;
    }
    if (knownSafe.has(relativePath)) {
      safe.push(relativePath);
      continue;
    }
    const absolute = path.join(rootDir, relativePath);
    const fragility = detectWindowsFragility(absolute);
    if (fragility) {
      excluded.push({ file: relativePath, reason: fragility.reason });
    } else {
      safe.push(relativePath);
    }
  }
  return { safe, excluded };
}

