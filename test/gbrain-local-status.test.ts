/**
 * Unit tests for lib/gbrain-local-status.ts.
 *
 * Per the eng-review D6 (gate-tier = mocked, codex #9): no real gbrain CLI, no
 * real PGLite, no real Postgres. Each case builds a fake `gbrain` shell script
 * on PATH that emits canned exit codes + stderr matching the patterns the
 * classifier looks for.
 *
 * Five status cases:
 *   1. no-cli         — gbrain absent from PATH
 *   2. missing-config — gbrain present, ~/.gbrain/config.json absent
 *   3. broken-config  — gbrain present, config exists, stderr contains "config.json"
 *   4. broken-db      — gbrain present, config exists, stderr contains "Cannot connect to database"
 *   5. ok             — gbrain present, config exists, sources list returns valid JSON
 *
 * Plus cache behavior: hit, TTL expiry, invariant invalidation (HOME change),
 * --no-cache bypass.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  existsSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  localEngineStatus,
  cacheFilePath,
  CACHE_TTL_MS,
  type LocalEngineStatus,
} from "../lib/gbrain-local-status";

interface FakeEnv {
  tmp: string;
  bindir: string;
  home: string;
  gstackHome: string;
  configPath: string;
  cleanup: () => void;
}

/**
 * Build a tmp HOME + GSTACK_HOME + optional fake `gbrain` on PATH.
 *
 * The classifier reads HOME via os.homedir() which reads process.env.HOME, so
 * we mutate process.env ambiently in each test (restored in afterEach).
 */
function makeEnv(opts: {
  withGbrain?: boolean;
  gbrainBehavior?: "ok" | "broken-db" | "broken-config" | "throws";
  withConfig?: boolean;
}): FakeEnv {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-local-status-test-"));
  const bindir = join(tmp, "bin");
  const home = join(tmp, "home");
  const gstackHome = join(home, ".gstack");
  const configDir = join(home, ".gbrain");
  const configPath = join(configDir, "config.json");

  mkdirSync(bindir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(gstackHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  if (opts.withConfig) {
    writeFileSync(
      configPath,
      JSON.stringify({ engine: "pglite", database_url: "pglite:///fake" }),
    );
  }

  if (opts.withGbrain) {
    const behavior = opts.gbrainBehavior || "ok";
    const fake = makeFakeGbrainScript(behavior);
    const gbrainPath = join(bindir, "gbrain");
    writeFileSync(gbrainPath, fake);
    chmodSync(gbrainPath, 0o755);
  }

  return {
    tmp,
    bindir,
    home,
    gstackHome,
    configPath,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function makeFakeGbrainScript(
  behavior: "ok" | "broken-db" | "broken-config" | "throws",
): string {
  const stderrLine =
    behavior === "broken-db"
      ? 'echo "Cannot connect to database: . Fix: Check your connection URL in ~/.gbrain/config.json" >&2'
      : behavior === "broken-config"
        ? 'echo "Error: malformed config.json at ~/.gbrain/config.json" >&2'
        : behavior === "throws"
          ? 'echo "unexpected gbrain failure" >&2'
          : "";
  const exitCode = behavior === "ok" ? 0 : 1;
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gbrain 0.33.1.0"
  exit 0
fi
if [ "$1 $2" = "sources list" ]; then
  if [ ${exitCode} -eq 0 ]; then
    echo '{"sources":[]}'
    exit 0
  fi
  ${stderrLine}
  exit ${exitCode}
fi
exit 0
`;
}

/**
 * Apply a FakeEnv to process.env. Returns a function that restores previous values.
 *
 * PATH is REPLACED (not prepended) so a real `gbrain` on the inherited PATH
 * can't shadow the test's fake-or-absent binary. /usr/bin:/bin is kept so `sh`
 * and `command` work.
 */
function applyEnv(env: FakeEnv): () => void {
  const prev = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    GSTACK_HOME: process.env.GSTACK_HOME,
  };
  process.env.HOME = env.home;
  process.env.PATH = `${env.bindir}:/usr/bin:/bin`;
  process.env.GSTACK_HOME = env.gstackHome;
  return () => {
    if (prev.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = prev.HOME;
    if (prev.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = prev.PATH;
    if (prev.GSTACK_HOME === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = prev.GSTACK_HOME;
  };
}

describe("lib/gbrain-local-status — five status cases", () => {
  let env: FakeEnv | null = null;
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    if (restoreEnv) restoreEnv();
    if (env) env.cleanup();
    env = null;
    restoreEnv = null;
  });

  it("probes the gbrain executable directly instead of shelling through command -v", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "lib", "gbrain-local-status.ts"),
      "utf-8",
    );

    expect(source).not.toContain('command -v gbrain');
    expect(source).toContain('execFileSync("gbrain", ["--version"]');
  });

  it("returns 'no-cli' when gbrain is not on PATH", () => {
    env = makeEnv({ withGbrain: false });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("no-cli");
  });

  it("returns 'missing-config' when CLI is present but ~/.gbrain/config.json absent", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: false });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("missing-config");
  });

  it("returns 'broken-db' when sources list emits 'Cannot connect to database'", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "broken-db", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("broken-db");
  });

  it("returns 'broken-config' when sources list emits config.json error", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "broken-config", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("broken-config");
  });

  it("returns 'broken-config' defensively when stderr matches neither pattern", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "throws", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("broken-config");
  });

  it("returns 'ok' when sources list succeeds", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("ok");
  });
});

describe("lib/gbrain-local-status — cache behavior", () => {
  let env: FakeEnv | null = null;
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    if (restoreEnv) restoreEnv();
    if (env) env.cleanup();
    env = null;
    restoreEnv = null;
  });

  it("writes a cache entry on first call", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    localEngineStatus({ noCache: false });
    expect(existsSync(cacheFilePath())).toBe(true);
  });

  it("returns cached value within TTL even if underlying state would change", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    const first = localEngineStatus({ noCache: false });
    expect(first).toBe("ok");

    // Make the fake gbrain emit broken-db now. Cache should still say ok.
    writeFileSync(
      join(env.bindir, "gbrain"),
      makeFakeGbrainScript("broken-db"),
    );
    chmodSync(join(env.bindir, "gbrain"), 0o755);

    const second = localEngineStatus({ noCache: false });
    expect(second).toBe("ok"); // cache hit
  });

  it("re-probes when --no-cache is passed", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: false })).toBe("ok");

    writeFileSync(
      join(env.bindir, "gbrain"),
      makeFakeGbrainScript("broken-db"),
    );
    chmodSync(join(env.bindir, "gbrain"), 0o755);

    expect(localEngineStatus({ noCache: true })).toBe("broken-db");
  });

  it("invalidates cache when config_mtime changes (key invariant)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: false })).toBe("ok");

    // Bump config mtime artificially (touch +10s) AND rewrite gbrain to broken-db.
    const future = Math.floor(Date.now() / 1000) + 10;
    utimesSync(env.configPath, future, future);
    writeFileSync(
      join(env.bindir, "gbrain"),
      makeFakeGbrainScript("broken-db"),
    );
    chmodSync(join(env.bindir, "gbrain"), 0o755);

    // Even with cache enabled, mtime mismatch forces re-probe.
    expect(localEngineStatus({ noCache: false })).toBe("broken-db");
  });

  it("invalidates cache when HOME changes (key invariant)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: false })).toBe("ok");

    // Switch to a new HOME (different user). Same gstack home (shared cache file).
    const env2 = makeEnv({
      withGbrain: true,
      gbrainBehavior: "broken-db",
      withConfig: true,
    });
    process.env.HOME = env2.home;
    process.env.PATH = `${env2.bindir}:/usr/bin:/bin`;
    // GSTACK_HOME stays pointing at env.gstackHome (the original cache file).

    try {
      expect(localEngineStatus({ noCache: false })).toBe("broken-db");
    } finally {
      env2.cleanup();
    }
  });
});
