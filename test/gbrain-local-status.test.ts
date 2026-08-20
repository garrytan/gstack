/**
 * Unit tests for lib/gbrain-local-status.ts.
 *
 * Per the eng-review D6 (gate-tier = mocked, codex #9): no real gbrain CLI, no
 * real PGLite, no real Postgres. Each case builds a fake `gbrain` shell script
 * on PATH that emits canned exit codes + stderr matching the patterns the
 * classifier looks for.
 *
 * Seven status cases:
 *   1. no-cli         — gbrain absent from PATH
 *   2. missing-config — gbrain present, config.json absent (honors GBRAIN_HOME)
 *   3. broken-config  — gbrain present, config exists, stderr contains "config.json"
 *   4. broken-db      — gbrain present, config exists, stderr contains "Cannot connect to database"
 *   5. timeout        — probe exceeds GSTACK_GBRAIN_PROBE_TIMEOUT_MS with no recognized error (#1964)
 *   6. engine-locked  — PGLite CLI exits 124 because another process owns the DB (#2194)
 *   7. ok             — gbrain present, config exists, sources list returns valid JSON
 *
 * Plus cache behavior: hit, TTL expiry, invariant invalidation (HOME change,
 * probe-timeout change), --no-cache bypass. Timeout tests keep runtime sane by
 * setting GSTACK_GBRAIN_PROBE_TIMEOUT_MS=300 against a fake gbrain that sleeps 2s.
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
import { join, dirname } from "path";

import { spawnSync } from "child_process";

import {
  localEngineStatus,
  cacheFilePath,
  probeTimeoutMs,
  CACHE_TTL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
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
  gbrainBehavior?: "ok" | "broken-db" | "broken-config" | "engine-locked" | "throws" | "slow" | "thin-refusal";
  withConfig?: boolean;
  /** #2051: config carries gbrain's remote_mcp thin-client marker. */
  thinClientConfig?: boolean;
  /** #2520: content for ~/.claude.json (host MCP registrations). */
  claudeJson?: object;
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

  if (opts.thinClientConfig) {
    writeFileSync(
      configPath,
      JSON.stringify({ remote_mcp: { mcp_url: "https://brain.example.com/mcp" } }),
    );
  } else if (opts.withConfig) {
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

  if (opts.claudeJson) {
    writeFileSync(join(home, ".claude.json"), JSON.stringify(opts.claudeJson));
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
  behavior: "ok" | "broken-db" | "broken-config" | "engine-locked" | "throws" | "slow" | "thin-refusal",
): string {
  // "slow": healthy engine on a cold pooler connection (#1964) — sleeps past
  // the (test-lowered) probe timeout, then would answer fine.
  if (behavior === "slow") {
    return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gbrain 0.33.1.0"
  exit 0
fi
if [ "$1 $2" = "sources list" ]; then
  sleep 2
  echo '{"sources":[]}'
  exit 0
fi
exit 0
`;
  }
  const stderrLine =
    behavior === "broken-db"
      ? 'echo "Cannot connect to database: . Fix: Check your connection URL in ~/.gbrain/config.json" >&2'
      : behavior === "broken-config"
        ? 'echo "Error: malformed config.json at ~/.gbrain/config.json" >&2'
        : behavior === "engine-locked"
          ? 'echo "gbrain sources: connect timed out (default 10000ms; pass --timeout=Ns to override)." >&2'
        : behavior === "throws"
          ? 'echo "unexpected gbrain failure" >&2'
          : behavior === "thin-refusal"
            ? 'echo "Error: gbrain sources is not routable to the remote brain (thin-client of https://brain.example.com/mcp)" >&2'
            : "";
  const exitCode = behavior === "ok" ? 0 : behavior === "engine-locked" ? 124 : 1;
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
    GBRAIN_HOME: process.env.GBRAIN_HOME,
    GSTACK_GBRAIN_PROBE_TIMEOUT_MS: process.env.GSTACK_GBRAIN_PROBE_TIMEOUT_MS,
  };
  process.env.HOME = env.home;
  process.env.PATH = `${env.bindir}:/usr/bin:/bin`;
  process.env.GSTACK_HOME = env.gstackHome;
  delete process.env.GBRAIN_HOME;
  delete process.env.GSTACK_GBRAIN_PROBE_TIMEOUT_MS;
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("lib/gbrain-local-status — status classification", () => {
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

  it("returns 'engine-locked' when PGLite exits 124 with its own connect timeout (#2194)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "engine-locked", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("engine-locked");
  });

  it("classifies a non-PGLite connect timeout as unreachable DB, not malformed config", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "engine-locked", withConfig: true });
    restoreEnv = applyEnv(env);
    writeFileSync(env.configPath, JSON.stringify({ engine: "postgres", database_url: "postgres://fake" }));
    expect(localEngineStatus({ noCache: true })).toBe("broken-db");
  });

  it("returns 'ok' when sources list succeeds", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("ok");
  });

  it("returns 'timeout' (not broken-config) when the probe exceeds the deadline (#1964)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    restoreEnv = applyEnv(env);
    process.env.GSTACK_GBRAIN_PROBE_TIMEOUT_MS = "300";
    expect(localEngineStatus({ noCache: true })).toBe("timeout");
  });

  it("honors GBRAIN_HOME for config detection (codex D11) with gbrain's parent-dir semantics (#2521)", () => {
    // Config lives ONLY under the alternate GBRAIN_HOME; ~/.gbrain has none.
    // gbrain's configDir() treats GBRAIN_HOME as a PARENT dir and appends
    // `.gbrain` itself: GBRAIN_HOME=/x → /x/.gbrain/config.json.
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: false });
    restoreEnv = applyEnv(env);
    const altHome = join(env.tmp, "alt-gbrain");
    mkdirSync(join(altHome, ".gbrain"), { recursive: true });
    writeFileSync(
      join(altHome, ".gbrain", "config.json"),
      JSON.stringify({ engine: "pglite", database_url: "pglite:///fake" }),
    );
    // Without GBRAIN_HOME: misclassified as missing-config.
    expect(localEngineStatus({ noCache: true })).toBe("missing-config");
    // With GBRAIN_HOME: the relocated config is found at $GBRAIN_HOME/.gbrain.
    process.env.GBRAIN_HOME = altHome;
    expect(localEngineStatus({ noCache: true })).toBe("ok");
  });

  it("does NOT read $GBRAIN_HOME/config.json directly — gbrain never reads that file (#2521)", () => {
    // A config placed at gstack's OLD (wrong) resolution must be invisible:
    // gbrain itself would report "No brain configured" for this layout, so
    // gstack classifying "ok" from it is the #2521 split-brain.
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: false });
    restoreEnv = applyEnv(env);
    const altHome = join(env.tmp, "alt-gbrain-flat");
    mkdirSync(altHome, { recursive: true });
    writeFileSync(
      join(altHome, "config.json"),
      JSON.stringify({ engine: "pglite", database_url: "pglite:///fake" }),
    );
    process.env.GBRAIN_HOME = altHome;
    expect(localEngineStatus({ noCache: true })).toBe("missing-config");
  });

  it("with GBRAIN_HOME unset, config resolution stays at ~/.gbrain (#2521 unset half)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    // applyEnv deletes GBRAIN_HOME; config was written at $HOME/.gbrain.
    expect(process.env.GBRAIN_HOME).toBeUndefined();
    expect(localEngineStatus({ noCache: true })).toBe("ok");
  });
});

describe("gstack-gbrain-detect --is-ok — timeout is usable (eng review D1)", () => {
  it("exits 0 when the engine probe times out (slow-but-healthy must not suppress brain features)", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    try {
      const detect = join(import.meta.dir, "..", "bin", "gstack-gbrain-detect");
      const r = spawnSync(process.execPath, [detect, "--is-ok"], {
        encoding: "utf-8",
        timeout: 20_000,
        env: {
          ...process.env,
          HOME: env.home,
          GSTACK_HOME: env.gstackHome,
          PATH: `${env.bindir}:/usr/bin:/bin`,
          GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "300",
          GSTACK_DETECT_NO_CACHE: "1",
          GBRAIN_HOME: "",
        },
      });
      expect(r.status).toBe(0);
    } finally {
      env.cleanup();
    }
  });
});

describe("probeTimeoutMs — env override parsing", () => {
  it("defaults to 15s when unset", () => {
    expect(probeTimeoutMs({})).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(15_000);
  });

  it("parses a numeric override", () => {
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "300" })).toBe(300);
  });

  it("falls back to the default on non-numeric, empty, and non-positive values", () => {
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "fast" })).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "" })).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "0" })).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "-5" })).toBe(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it("never returns 0 for fractional sub-millisecond values (0 = NO timeout in execFileSync)", () => {
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "0.5" })).toBe(1);
    expect(probeTimeoutMs({ GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "0.0001" })).toBe(1);
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

  it("caches a 'timeout' result (sync probes 3x/run — uncached would cost 3 deadlines)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    restoreEnv = applyEnv(env);
    process.env.GSTACK_GBRAIN_PROBE_TIMEOUT_MS = "300";
    expect(localEngineStatus({ noCache: false })).toBe("timeout");

    // Swap the fake to a fast-ok binary; the cached timeout should still win
    // within TTL (same key — proving the result was cached, not re-probed).
    writeFileSync(join(env.bindir, "gbrain"), makeFakeGbrainScript("ok"));
    chmodSync(join(env.bindir, "gbrain"), 0o755);
    expect(localEngineStatus({ noCache: false })).toBe("timeout");
  });

  it("invalidates a cached 'timeout' when GSTACK_GBRAIN_PROBE_TIMEOUT_MS changes (key invariant, codex D13)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    restoreEnv = applyEnv(env);
    process.env.GSTACK_GBRAIN_PROBE_TIMEOUT_MS = "300";
    expect(localEngineStatus({ noCache: false })).toBe("timeout");

    // User raises the timeout past the fake's 2s sleep: cache key changes,
    // re-probe succeeds.
    process.env.GSTACK_GBRAIN_PROBE_TIMEOUT_MS = "5000";
    expect(localEngineStatus({ noCache: false })).toBe("ok");
  });

  it("invalidates cache when GBRAIN_HOME changes (key invariant, codex D11)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: false })).toBe("ok");

    // Point GBRAIN_HOME at an empty dir: a stale cached "ok" must not win —
    // gbrain_home is part of the cache key, so this re-probes and finds no
    // config at the new location.
    const altHome = join(env.tmp, "alt-gbrain-empty");
    mkdirSync(altHome, { recursive: true });
    process.env.GBRAIN_HOME = altHome;
    expect(localEngineStatus({ noCache: false })).toBe("missing-config");
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

// ---------------------------------------------------------------------------
// #2051: thin-client classification + the end-to-end --is-ok gate
// ---------------------------------------------------------------------------

describe("lib/gbrain-local-status — thin-client (#2051)", () => {
  let env: FakeEnv | null = null;
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    if (restoreEnv) restoreEnv();
    if (env) env.cleanup();
    env = null;
    restoreEnv = null;
  });

  it("returns 'thin-client' when config carries gbrain's remote_mcp marker (pre-probe, no engine call)", () => {
    // The fake gbrain would answer "ok" if probed — proving the marker is
    // read from config BEFORE any probe (zero network, no error-string
    // dependence).
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", thinClientConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("returns 'thin-client' via the stderr refusal fallback when the config marker is unreadable", () => {
    // Regular (non-thin) config on disk, but gbrain itself refuses with the
    // dispatch-guard message — the catch-path backstop.
    env = makeEnv({ withGbrain: true, gbrainBehavior: "thin-refusal", withConfig: true });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  // The eng-review 3A tripwire: the END-TO-END gate, not just the classifier
  // return. --is-ok drives setup:1299 and gstack-config gbrain-refresh — this
  // exit code is what decides whether brain-aware blocks render for a
  // thin-client user (the #2051 report).
  it("--is-ok exits 0 on a thin-client fixture (end-to-end gate)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", thinClientConfig: true });
    const detectBin = join(import.meta.dir, "..", "bin", "gstack-gbrain-detect");
    const bunDir = dirname(process.execPath);
    const r = spawnSync(detectBin, ["--is-ok"], {
      encoding: "utf-8",
      env: {
        HOME: env.home,
        PATH: `${env.bindir}:${bunDir}:/usr/bin:/bin`,
        GSTACK_HOME: env.gstackHome,
        GSTACK_DETECT_NO_CACHE: "1",
      },
    });
    expect(r.status).toBe(0);
  });

  it("--is-ok still exits 1 on broken-config (thin-client did not widen the gate)", () => {
    env = makeEnv({ withGbrain: true, gbrainBehavior: "broken-config", withConfig: true });
    const detectBin = join(import.meta.dir, "..", "bin", "gstack-gbrain-detect");
    const bunDir = dirname(process.execPath);
    const r = spawnSync(detectBin, ["--is-ok"], {
      encoding: "utf-8",
      env: {
        HOME: env.home,
        PATH: `${env.bindir}:${bunDir}:/usr/bin:/bin`,
        GSTACK_HOME: env.gstackHome,
        GSTACK_DETECT_NO_CACHE: "1",
      },
    });
    expect(r.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #2520: bearer-token thin clients (`gbrain connect --token`) — no remote_mcp
// marker in config.json; the evidence is the host's remote-HTTP MCP
// registration in ~/.claude.json.
// ---------------------------------------------------------------------------

describe("lib/gbrain-local-status — bearer-token thin-client (#2520)", () => {
  let env: FakeEnv | null = null;
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    if (restoreEnv) restoreEnv();
    if (env) env.cleanup();
    env = null;
    restoreEnv = null;
  });

  const REMOTE_GBRAIN = {
    type: "http",
    url: "https://brain.example.com/mcp",
    headers: { Authorization: "Bearer test-token" },
  };
  const LOCAL_GBRAIN = { type: "stdio", command: "gbrain", args: ["serve"] };

  it("returns 'thin-client' when config.json is absent but a remote-HTTP gbrain MCP is registered (user scope)", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: { mcpServers: { gbrain: REMOTE_GBRAIN } },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("returns 'thin-client' when config.json is absent and the registration is PROJECT-scoped for THIS cwd (#2499)", () => {
    // The project key must be the running process's cwd (or an ancestor):
    // per-project scoping (C15) means only registrations visible to this
    // cwd count.
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: {
        projects: { [process.cwd()]: { mcpServers: { "gbrain-remote": REMOTE_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("reclassifies a failed local probe (engine-locked) as 'thin-client' when the only gbrain MCP is remote", () => {
    // The reporter's exact shape: leftover local pglite config, dead/absent
    // local engine (probe exits 124 "connect timed out"), brain fully working
    // over remote-HTTP MCP with a bearer token.
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
      claudeJson: { mcpServers: { gbrain: REMOTE_GBRAIN } },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("reclassifies broken-db as 'thin-client' when the only gbrain MCP is remote", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "broken-db",
      withConfig: true,
      claudeJson: { mcpServers: { gbrain: REMOTE_GBRAIN } },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("preserves 'engine-locked' when a local-stdio gbrain MCP is ALSO registered (federation guard)", () => {
    // A local-stdio registration means the user runs a local engine —
    // local-engine statuses must keep their precise meaning, even if a
    // second (e.g. team) brain is registered remote-HTTP.
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
      claudeJson: {
        mcpServers: { gbrain: LOCAL_GBRAIN, "gbrain-work": REMOTE_GBRAIN },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("engine-locked");
  });

  it("still returns 'missing-config' when no gbrain MCP registration exists (discriminator)", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: { mcpServers: { "other-server": { type: "http", url: "https://x.example/mcp" } } },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("missing-config");
  });

  // ── C15: project scan is scoped to the cwd's nearest-ancestor project ──
  // Before the fix, hasRemoteOnlyGbrainMcp scanned EVERY project's
  // mcpServers, so one project's remote registration reclassified broken
  // local engines as thin-client machine-wide.

  it("C15: an OTHER project's remote entry no longer flips thin-client for this cwd (no config)", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: {
        projects: { "/some/other/repo": { mcpServers: { gbrain: REMOTE_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("missing-config");
  });

  it("C15: an OTHER project's remote entry no longer reclassifies a broken local engine", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
      claudeJson: {
        projects: { "/some/other/repo": { mcpServers: { gbrain: REMOTE_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("engine-locked");
  });

  it("C15: path boundary — a sibling-prefix project key is NOT this cwd's project", () => {
    // /path/to/repo2 must never match a scan from /path/to/repo (and vice
    // versa) — same boundary rule as the jq resolver and brain-cache.
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: {
        projects: { [`${process.cwd()}-sibling`]: { mcpServers: { gbrain: REMOTE_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("missing-config");
  });

  it("C15: an ANCESTOR project key of this cwd still counts (nearest-ancestor matching)", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: {
        projects: { [dirname(process.cwd())]: { mcpServers: { gbrain: REMOTE_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("C15: a nearer project WITHOUT gbrain does not shadow an ancestor's registration (jq parity)", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
      claudeJson: {
        projects: {
          [dirname(process.cwd())]: { mcpServers: { gbrain: REMOTE_GBRAIN } },
          [process.cwd()]: { mcpServers: { "other-server": { type: "http", url: "https://x.example/mcp" } } },
        },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  // ── C15: adopted precedence — project-local beats user scope per name ──
  // Claude Code's own conflict resolution, verified empirically against
  // claude 2.1.233 with a hermetic fake $HOME (`claude mcp get gbrain`
  // reports "Scope: Local config" when both scopes define the name).

  it("C15 precedence: THIS project's remote gbrain shadows a user-scope local-stdio gbrain → thin-client", () => {
    // Union semantics would see the user-scope stdio entry and keep
    // engine-locked; the adopted precedence says this project's queries go
    // remote, so thin-client is the truthful classification here.
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
      claudeJson: {
        mcpServers: { gbrain: LOCAL_GBRAIN },
        projects: { [process.cwd()]: { mcpServers: { gbrain: REMOTE_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("thin-client");
  });

  it("C15 precedence: THIS project's local-stdio gbrain shadows a user-scope remote gbrain → local statuses keep their meaning", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
      claudeJson: {
        mcpServers: { gbrain: REMOTE_GBRAIN },
        projects: { [process.cwd()]: { mcpServers: { gbrain: LOCAL_GBRAIN } } },
      },
    });
    restoreEnv = applyEnv(env);
    expect(localEngineStatus({ noCache: true })).toBe("engine-locked");
  });

  it("--is-ok exits 0 on a bearer thin-client fixture (end-to-end gate)", () => {
    env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
      claudeJson: { mcpServers: { gbrain: REMOTE_GBRAIN } },
    });
    const detectBin = join(import.meta.dir, "..", "bin", "gstack-gbrain-detect");
    const bunDir = dirname(process.execPath);
    const r = spawnSync(detectBin, ["--is-ok"], {
      encoding: "utf-8",
      env: {
        HOME: env.home,
        PATH: `${env.bindir}:${bunDir}:/usr/bin:/bin`,
        GSTACK_HOME: env.gstackHome,
        GSTACK_DETECT_NO_CACHE: "1",
      },
    });
    expect(r.status).toBe(0);
  });
});
