/**
 * XProtect launch-kill self-heal (P0 #2554) — unit tests.
 *
 * F9: the classifier is tested with POSITIVE signatures (sourced from the
 * #2554 report + Playwright's launch-error format) AND NEGATIVES (missing
 * executable, EPERM/EACCES, sandbox denial, plain crash) so a generic launch
 * failure can never trigger a pointless reinstall.
 *
 * F4: the one-shot guard is pinned — at most one heal attempt per process,
 * even when the heal fails.
 *
 * ENG-OV3/F9: the post-heal verification target is REGISTRY-derived (the
 * revision playwright-core's browsers.json expects), not disk-derived, and
 * the install-root finder rejects roots pinning a different revision.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chromium } from 'playwright';
import {
  isXProtectKillSignature,
  findPlaywrightRevisionDir,
  expectedChromiumRevision,
  findGstackInstallRoot,
  clearQuarantineOnPlaywrightCache,
  maybeHealXProtectKill,
  launchWithXProtectHeal,
  resetXProtectHealForTests,
  buildXProtectGuidance,
  runBoundedChromiumReinstall,
} from '../src/xprotect-heal';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');

// ─── Fixtures: POSITIVE signatures (real Playwright error shapes for an
// OS-level SIGKILL at spawn — what xprotectd does per the #2554 report) ────

const SIGKILL_BROWSER_CLOSED = `browserType.launch: Browser closed.
==================== Browser output: ====================
<launched> pid=48213
[pid=48213] <process did exit: exitCode=null, signal=SIGKILL>
[pid=48213] starting temporary directories cleanup
=========================== logs ===========================`;

const SIGKILL_PERSISTENT_CONTEXT = `browserType.launchPersistentContext: Target page, context or browser has been closed
Browser logs:
<launched> pid=9021
[pid=9021] <process did exit: exitCode=null, signal=SIGKILL>`;

// The #2554 report's visible symptom: the kill surfaces as a launch timeout
// where the process DID spawn (<launched>) but never became ready.
const LAUNCH_TIMEOUT_AFTER_SPAWN = `browserType.launch: Timeout 180000ms exceeded.
=========================== logs ===========================
<launched> pid=51677
============================================================`;

// ─── Fixtures: NEGATIVE signatures (F9) ──────────────────────────────────

const MISSING_EXECUTABLE = `browserType.launch: Executable doesn't exist at /Users/dev/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-mac-arm64/headless_shell
╔═══════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.  ║
║ Please run the following command to download browsers:║
║     bunx playwright install                           ║
╚═══════════════════════════════════════════════════════╝`;

const SPAWN_EACCES = `browserType.launch: spawn /Users/dev/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing EACCES`;

const EPERM_FAILURE = `browserType.launch: Browser closed.
==================== Browser output: ====================
Error: EPERM: operation not permitted, open '/Users/dev/Library/Caches/ms-playwright/.links/lock'`;

const SANDBOX_DENIAL = `browserType.launch: Browser closed.
==================== Browser output: ====================
<launched> pid=7211
[pid=7211][err] Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted
[pid=7211] <process did exit: exitCode=1, signal=null>`;

const PLAIN_CRASH_EXIT_1 = `browserType.launch: Browser closed.
==================== Browser output: ====================
<launched> pid=3300
[pid=3300] <process did exit: exitCode=1, signal=null>`;

// ─── Classifier ──────────────────────────────────────────────────────────

describe('isXProtectKillSignature — positives (darwin)', () => {
  it('classifies SIGKILL in a Browser closed error', () => {
    expect(isXProtectKillSignature(SIGKILL_BROWSER_CLOSED, 'darwin')).toBe(true);
  });

  it('classifies SIGKILL in a launchPersistentContext error', () => {
    expect(isXProtectKillSignature(SIGKILL_PERSISTENT_CONTEXT, 'darwin')).toBe(true);
  });

  it('classifies a launch timeout where the process spawned (<launched>)', () => {
    expect(isXProtectKillSignature(LAUNCH_TIMEOUT_AFTER_SPAWN, 'darwin')).toBe(true);
  });
});

describe('isXProtectKillSignature — negatives (F9)', () => {
  it('rejects a missing executable', () => {
    expect(isXProtectKillSignature(MISSING_EXECUTABLE, 'darwin')).toBe(false);
  });

  it('rejects spawn EACCES', () => {
    expect(isXProtectKillSignature(SPAWN_EACCES, 'darwin')).toBe(false);
  });

  it('rejects EPERM failures', () => {
    expect(isXProtectKillSignature(EPERM_FAILURE, 'darwin')).toBe(false);
  });

  it('rejects Linux sandbox denials even with a <launched> marker', () => {
    expect(isXProtectKillSignature(SANDBOX_DENIAL, 'darwin')).toBe(false);
  });

  it('rejects a plain crash (exitCode=1, no signal)', () => {
    expect(isXProtectKillSignature(PLAIN_CRASH_EXIT_1, 'darwin')).toBe(false);
  });

  it('rejects a bare timeout with no <launched> marker (process never spawned)', () => {
    expect(isXProtectKillSignature('browserType.launch: Timeout 180000ms exceeded.', 'darwin')).toBe(false);
  });

  it('rejects empty messages', () => {
    expect(isXProtectKillSignature('', 'darwin')).toBe(false);
  });

  it('is platform-gated: the SIGKILL signature on linux/win32 is NOT XProtect', () => {
    expect(isXProtectKillSignature(SIGKILL_BROWSER_CLOSED, 'linux')).toBe(false);
    expect(isXProtectKillSignature(SIGKILL_BROWSER_CLOSED, 'win32')).toBe(false);
  });
});

// ─── Cache path helpers ──────────────────────────────────────────────────

describe('findPlaywrightRevisionDir', () => {
  it('finds the revision dir for the headed bundle layout', () => {
    const p = '/Users/dev/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    expect(findPlaywrightRevisionDir(p)).toBe('/Users/dev/Library/Caches/ms-playwright/chromium-1234');
  });

  it('finds the revision dir for the headless shell layout', () => {
    const p = '/Users/dev/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-mac-arm64/headless_shell';
    expect(findPlaywrightRevisionDir(p)).toBe('/Users/dev/Library/Caches/ms-playwright/chromium_headless_shell-1234');
  });

  it('returns null outside the Playwright cache layout', () => {
    expect(findPlaywrightRevisionDir('/Applications/GStack Browser.app/Contents/MacOS/Chromium')).toBe(null);
  });
});

describe('expectedChromiumRevision — registry-derived expectation (F9/ENG-OV3)', () => {
  it('matches the revision playwright-core browsers.json declares for chromium', () => {
    const browsersJson = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf-8',
    ));
    const registryRevision = browsersJson.browsers.find((b: { name: string }) => b.name === 'chromium').revision;
    // chromium.executablePath() is computed from the embedded registry (not
    // read from disk) — the heal's post-install verification target is
    // therefore the revision dir playwright-core EXPECTS, which is exactly
    // what a wrong-revision heal would fail.
    expect(expectedChromiumRevision(chromium.executablePath())).toBe(registryRevision);
  });
});

describe('findGstackInstallRoot (ENG-OV3: revision-matched roots only)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xprotect-root-'));
    const pwCore = path.join(tmpRoot, 'node_modules', 'playwright-core');
    fs.mkdirSync(pwCore, { recursive: true });
    fs.writeFileSync(path.join(pwCore, 'browsers.json'), JSON.stringify({
      browsers: [{ name: 'chromium', revision: '1234' }],
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('accepts a root whose pinned playwright-core expects the same revision', () => {
    expect(findGstackInstallRoot('1234', [tmpRoot])).toBe(tmpRoot);
  });

  it('rejects a root pinning a DIFFERENT revision (wrong-revision heal guard)', () => {
    expect(findGstackInstallRoot('9999', [tmpRoot])).toBe(null);
  });

  it('rejects roots without node_modules/playwright-core', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'xprotect-bare-'));
    try {
      expect(findGstackInstallRoot('1234', [bare])).toBe(null);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('resolves the dev checkout by default (its node_modules pins our revision)', () => {
    const browsersJson = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf-8',
    ));
    const registryRevision = browsersJson.browsers.find((b: { name: string }) => b.name === 'chromium').revision;
    const root = findGstackInstallRoot(registryRevision);
    expect(root).not.toBe(null);
    expect(fs.existsSync(path.join(root!, 'node_modules', 'playwright-core', 'browsers.json'))).toBe(true);
  });
});

// ─── Quarantine-clear scope contract ─────────────────────────────────────

describe('clearQuarantineOnPlaywrightCache', () => {
  let tmpCache: string;
  let execPath: string;
  const savedCustomPath = process.env.GSTACK_CHROMIUM_PATH;

  beforeEach(() => {
    tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'xprotect-cache-'));
    for (const dir of ['chromium-1234', 'chromium_headless_shell-1234', 'firefox-5678', 'webkit-2222']) {
      fs.mkdirSync(path.join(tmpCache, dir), { recursive: true });
    }
    execPath = path.join(tmpCache, 'chromium-1234', 'chrome-mac-arm64', 'App.app', 'Contents', 'MacOS', 'chromium');
    delete process.env.GSTACK_CHROMIUM_PATH;
  });

  afterEach(() => {
    fs.rmSync(tmpCache, { recursive: true, force: true });
    if (savedCustomPath === undefined) delete process.env.GSTACK_CHROMIUM_PATH;
    else process.env.GSTACK_CHROMIUM_PATH = savedCustomPath;
  });

  it('clears every chromium* revision dir, never firefox/webkit', () => {
    const cleared: string[] = [];
    const ok = clearQuarantineOnPlaywrightCache(execPath, (target) => {
      cleared.push(path.basename(target));
      return 0;
    });
    expect(ok).toBe(true);
    expect(cleared.sort()).toEqual(['chromium-1234', 'chromium_headless_shell-1234']);
  });

  it('NEVER touches a GSTACK_CHROMIUM_PATH bundle (embedder scope contract)', () => {
    process.env.GSTACK_CHROMIUM_PATH = execPath;
    const cleared: string[] = [];
    const ok = clearQuarantineOnPlaywrightCache(execPath, (target) => {
      cleared.push(target);
      return 0;
    });
    expect(ok).toBe(false);
    expect(cleared).toEqual([]);
  });

  it('skips executables outside the Playwright cache layout', () => {
    const cleared: string[] = [];
    const ok = clearQuarantineOnPlaywrightCache('/Applications/Foo.app/Contents/MacOS/foo', (target) => {
      cleared.push(target);
      return 0;
    });
    expect(ok).toBe(false);
    expect(cleared).toEqual([]);
  });
});

// ─── One-shot heal orchestration (F4) ────────────────────────────────────

function makeDeps(counters: { installs: number; quarantines: number }, overrides: Record<string, unknown> = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    executablePath: () => '/tmp/ms-playwright/chromium-1234/chrome-mac-arm64/App.app/Contents/MacOS/chromium',
    clearQuarantine: () => { counters.quarantines++; return true; },
    installRoot: () => '/tmp/fake-gstack-root',
    runReinstall: async () => { counters.installs++; return { ok: true }; },
    verifyInstalled: () => true,
    ...overrides,
  };
}

describe('maybeHealXProtectKill', () => {
  beforeEach(() => resetXProtectHealForTests());

  it('heals a classified failure: quarantine-clear + reinstall + verify', async () => {
    const counters = { installs: 0, quarantines: 0 };
    const healed = await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, makeDeps(counters));
    expect(healed).toBe(true);
    expect(counters.quarantines).toBe(1);
    expect(counters.installs).toBe(1);
  });

  it('F4: runs AT MOST ONCE per process, even across distinct errors', async () => {
    const counters = { installs: 0, quarantines: 0 };
    expect(await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, makeDeps(counters))).toBe(true);
    expect(await maybeHealXProtectKill(new Error(LAUNCH_TIMEOUT_AFTER_SPAWN), {}, makeDeps(counters))).toBe(false);
    expect(counters.installs).toBe(1);
  });

  it('F4: a FAILED heal also consumes the one-shot (no reinstall loops)', async () => {
    const counters = { installs: 0, quarantines: 0 };
    const failing = makeDeps(counters, { runReinstall: async () => { counters.installs++; return { ok: false, reason: 'timeout' }; } });
    expect(await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, failing)).toBe(false);
    expect(await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, makeDeps(counters))).toBe(false);
    expect(counters.installs).toBe(1);
  });

  it('an unclassified error does NOT consume the one-shot', async () => {
    const counters = { installs: 0, quarantines: 0 };
    expect(await maybeHealXProtectKill(new Error(MISSING_EXECUTABLE), {}, makeDeps(counters))).toBe(false);
    expect(counters.installs).toBe(0);
    // Guard not consumed — a real signature afterwards still heals.
    expect(await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, makeDeps(counters))).toBe(true);
  });

  it('never heals over a custom executable (GSTACK_CHROMIUM_PATH scope)', async () => {
    const counters = { installs: 0, quarantines: 0 };
    const healed = await maybeHealXProtectKill(
      new Error(SIGKILL_BROWSER_CLOSED),
      { usesCustomExecutable: true },
      makeDeps(counters),
    );
    expect(healed).toBe(false);
    expect(counters.quarantines).toBe(0);
    expect(counters.installs).toBe(0);
  });

  it('fails the heal when no install root pins our revision (ENG-OV3)', async () => {
    const counters = { installs: 0, quarantines: 0 };
    const deps = makeDeps(counters, { installRoot: () => null });
    expect(await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, deps)).toBe(false);
    expect(counters.installs).toBe(0);
  });

  it('fails the heal when post-install verification misses the expected revision dir (F9)', async () => {
    const counters = { installs: 0, quarantines: 0 };
    const deps = makeDeps(counters, { verifyInstalled: () => false });
    expect(await maybeHealXProtectKill(new Error(SIGKILL_BROWSER_CLOSED), {}, deps)).toBe(false);
    expect(counters.installs).toBe(1);
  });
});

// ─── Launch wrapper ──────────────────────────────────────────────────────

describe('launchWithXProtectHeal', () => {
  beforeEach(() => resetXProtectHealForTests());

  it('retries the launch exactly once after a successful heal', async () => {
    const counters = { installs: 0, quarantines: 0 };
    let attempts = 0;
    const result = await launchWithXProtectHeal(async () => {
      attempts++;
      if (attempts === 1) throw new Error(SIGKILL_BROWSER_CLOSED);
      return 'browser';
    }, {}, makeDeps(counters));
    expect(result).toBe('browser');
    expect(attempts).toBe(2);
    expect(counters.installs).toBe(1);
  });

  it('surfaces the ORIGINAL error + manual guidance when the heal fails (E1)', async () => {
    const counters = { installs: 0, quarantines: 0 };
    const deps = makeDeps(counters, { runReinstall: async () => ({ ok: false, reason: 'timeout' }) });
    let thrown: Error | null = null;
    try {
      await launchWithXProtectHeal(async () => { throw new Error(SIGKILL_BROWSER_CLOSED); }, {}, deps);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBe(null);
    // Original launch error text preserved…
    expect(thrown!.message).toContain('signal=SIGKILL');
    // …plus the manual remediation.
    expect(thrown!.message).toContain('bunx playwright install chromium');
  });

  it('passes unclassified failures through untouched', async () => {
    const counters = { installs: 0, quarantines: 0 };
    let thrown: Error | null = null;
    try {
      await launchWithXProtectHeal(async () => { throw new Error(MISSING_EXECUTABLE); }, {}, makeDeps(counters));
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toBe(MISSING_EXECUTABLE);
    expect(counters.installs).toBe(0);
  });
});

describe('buildXProtectGuidance', () => {
  it('carries both the original message and the manual command', () => {
    const out = buildXProtectGuidance('original launch error');
    expect(out).toContain('original launch error');
    expect(out).toContain('bunx playwright install chromium');
    expect(out).toContain('#2554');
  });
});

// ─── runBoundedChromiumReinstall (T3) — previously zero coverage ──────────
//
// Exercised end-to-end against a STUB `bunx` on a prepended PATH: real spawn,
// real process group, real timer — only the binary is fake. Shell stubs
// don't exist on Windows, and the group-kill path is POSIX (`kill(-pid)`),
// so the suite is Unix-only like the shape it tests.
describe.skipIf(process.platform === 'win32')('runBoundedChromiumReinstall', () => {
  let stubDir: string;
  let savedPath: string | undefined;

  function installStubBunx(script: string): void {
    const stub = path.join(stubDir, 'bunx');
    fs.writeFileSync(stub, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  beforeEach(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xprotect-stub-'));
    savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('resolves ok on exit 0', async () => {
    installStubBunx('exit 0');
    const result = await runBoundedChromiumReinstall(stubDir, 10_000);
    expect(result).toEqual({ ok: true, exitCode: 0 });
  });

  it('reports install-exit-N with the stderr tail on a nonzero exit', async () => {
    installStubBunx('echo "download failed: mirror unreachable" >&2\nexit 7');
    const result = await runBoundedChromiumReinstall(stubDir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.reason).toStartWith('install-exit-7');
    expect(result.reason).toContain('download failed: mirror unreachable');
  });

  it('group-kills a hung install at timeoutMs and reports timeout', async () => {
    // The stub spawns its own child (like bunx → playwright CLI → download
    // workers) and sleeps well past the bound; the detached process group
    // must take BOTH down, and the result must arrive at ~timeoutMs, not
    // after the sleep.
    installStubBunx('sleep 30 &\nsleep 30');
    const started = Date.now();
    const result = await runBoundedChromiumReinstall(stubDir, 500);
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(elapsed).toBeLessThan(5_000); // resolved at the bound, not the sleep
  });

  it('reports spawn-error when the binary cannot be executed', async () => {
    // No stub installed and PATH reduced to the empty stub dir only.
    process.env.PATH = stubDir;
    const result = await runBoundedChromiumReinstall(stubDir, 10_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toStartWith('spawn-error:');
  });
});
