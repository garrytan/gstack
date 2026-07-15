import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";
import {
  detectAutopilot,
  decideSourceRemove,
  decideCodeSync,
  isInside,
  gbrainHome,
  gbrainSourceRemoveConfirmationArgs,
  _resetCapabilityMemo,
  type GbrainSourceRow,
} from "../lib/gbrain-guards";
import {
  guardCodeSyncBeforeWalk,
  safeSourcesRemove,
} from "../bin/gstack-gbrain-sync";

const HOME = os.homedir();
const clonesPath = (name: string) => join(HOME, ".gbrain", "clones", name);

afterEach(() => _resetCapabilityMemo());

describe("fetchSources global routing", () => {
  test("stale env and dotfile pins cannot block authoritative metadata discovery", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "gbrain-global-sources-"));
    const bin = join(root, "bin");
    const cwd = join(root, "repo");
    const log = join(root, "calls.log");
    fs.mkdirSync(bin);
    fs.mkdirSync(cwd);
    fs.writeFileSync(join(cwd, ".gbrain-source"), "also-stale\n");
    const fake = join(bin, "gbrain");
    fs.writeFileSync(fake, `#!/bin/sh
printf '%s|%s\n' "\${GBRAIN_SOURCE:-}" "$*" >> "${log}"
[ -z "\${GBRAIN_SOURCE:-}" ] || exit 31
if [ "$1 $2 $3" = "sources list --json" ]; then
  printf '%s\n' '{"sources":[{"id":"good-source","local_path":"/repo"}]}'
  exit 0
fi
if [ "$1" = "call" ] && [ "$2" = "--source" ] && [ "$3" = "good-source" ] && [ "$4" = "sources_list" ]; then
  printf '%s\n' '{"sources":[{"id":"good-source","local_path":"/repo","remote_url":null}]}'
  exit 0
fi
exit 32
`, { mode: 0o755 });
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "lib", "gbrain-guards.ts")).href;
    const runner = `
      const { fetchSources } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify(fetchSources(process.env)));
    `;
    try {
      const result = spawnSync(process.execPath, ["-e", runner], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          GBRAIN_HOME: root,
          GBRAIN_SOURCE: "stale-source",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)[0]?.config?.remote_url).toBeNull();
      const calls = fs.readFileSync(log, "utf8");
      expect(calls).toContain("|sources list --json");
      expect(calls).toContain("|call --source good-source sources_list {}");
      expect(calls).not.toContain("stale-source|");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsupported successful metadata JSON fails closed", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "gbrain-global-shape-"));
    const bin = join(root, "bin");
    fs.mkdirSync(bin);
    const fake = join(bin, "gbrain");
    fs.writeFileSync(fake, `#!/bin/sh
if [ "$1 $2 $3" = "sources list --json" ]; then
  printf '%s\n' '{"sources":[{"id":"good-source","local_path":"/repo"}]}'
  exit 0
fi
if [ "$1" = "call" ]; then
  printf '%s\n' "$FIXTURE_AUTHORITATIVE_JSON"
  exit 0
fi
exit 32
`, { mode: 0o755 });
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "lib", "gbrain-guards.ts")).href;
    const runner = `
      const { fetchSources } = await import(${JSON.stringify(moduleUrl)});
      try { fetchSources(process.env); process.exit(0); }
      catch (error) { console.error(String(error)); process.exit(4); }
    `;
    try {
      for (const raw of ["{}", '{"sources":null}', '{"error":"denied"}']) {
        const result = spawnSync(process.execPath, ["-e", runner], {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            GBRAIN_HOME: root,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            FIXTURE_AUTHORITATIVE_JSON: raw,
          },
        });
        expect(result.status).toBe(4);
        expect(result.stderr).toContain("unsupported gbrain sources-list JSON shape");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("gbrain 0.30 uses the pre-0.31.8 global call and keeps ownership metadata", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "gbrain-global-030-"));
    const bin = join(root, "bin");
    const log = join(root, "calls.log");
    fs.mkdirSync(bin);
    const fake = join(bin, "gbrain");
    fs.writeFileSync(fake, `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
if [ "$1" = "--version" ]; then
  printf '%s\n' 'gbrain 0.30.4'
  exit 0
fi
if [ "$1 $2 $3" = "sources list --json" ]; then
  printf '%s\n' '{"sources":[{"id":"old-source","local_path":"/repo"}]}'
  exit 0
fi
if [ "$1 $2" = "call sources_list" ]; then
  printf '%s\n' '{"sources":[{"id":"old-source","local_path":"/repo","remote_url":null}]}'
  exit 0
fi
exit 32
`, { mode: 0o755 });
    const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "lib", "gbrain-guards.ts")).href;
    const runner = `
      const { fetchSources } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify(fetchSources(process.env)));
    `;
    try {
      const result = spawnSync(process.execPath, ["-e", runner], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          GBRAIN_HOME: root,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)[0]?.config?.remote_url).toBeNull();
      const calls = fs.readFileSync(log, "utf8");
      expect(calls).toContain("call sources_list {}");
      expect(calls).not.toContain("call --source");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── #1734 autopilot detection (E1: affirmative multi-signal) ────────────────
describe("detectAutopilot", () => {
  test("uses the supplied HOME instead of inspecting the caller's real home", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "ap-env-home-"));
    const state = join(root, ".gbrain");
    fs.mkdirSync(state);
    const lock = join(state, "autopilot.lock");
    fs.writeFileSync(lock, String(process.pid));
    try {
      const env = { ...process.env, HOME: root, GBRAIN_HOME: "" };
      expect(gbrainHome(env)).toBe(state);
      const r = detectAutopilot(env, { processRunning: () => false });
      expect(r.active).toBe(true);
      expect(r.signal).toContain(lock);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses current GBRAIN_HOME parent semantics for the canonical lock", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "ap-home-"));
    const state = join(root, ".gbrain");
    fs.mkdirSync(state);
    const lock = join(state, "autopilot.lock");
    fs.writeFileSync(lock, String(process.pid));
    try {
      expect(gbrainHome({ ...process.env, GBRAIN_HOME: root })).toBe(state);
      const r = detectAutopilot(
        { ...process.env, GBRAIN_HOME: root },
        { processRunning: () => false },
      );
      expect(r.active).toBe(true);
      expect(r.signal).toContain(lock);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects legacy GBRAIN_HOME lock and pid paths", () => {
    for (const name of ["autopilot.lock", "autopilot.pid"]) {
      const root = fs.mkdtempSync(join(os.tmpdir(), "ap-legacy-"));
      const legacy = join(root, name);
      fs.writeFileSync(legacy, String(process.pid));
      try {
        const r = detectAutopilot(
          { ...process.env, GBRAIN_HOME: root },
          { processRunning: () => false },
        );
        expect(r.active).toBe(true);
        expect(r.signal).toContain(legacy);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses on a present lock file (secondary signal)", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, "");
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true);
    expect(r.signal).toContain("lock:");
  });

  test("refuses on a live autopilot process (primary signal)", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => true });
    expect(r.active).toBe(true);
    expect(r.signal).toBe("process:gbrain autopilot");
  });

  test("proceeds when no signal fires (never blanket-refuses)", () => {
    const r = detectAutopilot(process.env, { lockPaths: [], processRunning: () => false });
    expect(r.active).toBe(false);
    expect(r.signal).toBeNull();
  });

  // Stale-lock self-heal: a crashed daemon's lock (dead holder pid) must NOT
  // wedge syncs forever (observed: dead pid refused --full indefinitely).
  const DEAD_PID = 2999999; // above macOS pid_max; vanishingly unlikely elsewhere

  test("ignores a STALE lock whose holder pid is dead", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, `${DEAD_PID}\n`);
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(false);
    expect(r.signal).toBeNull();
  });

  test("treats a FRESH lock (live holder pid) as active", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, String(process.pid)); // the test runner itself is alive
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true);
    expect(r.signal).toContain(`pid ${process.pid}`);
  });

  test("parses a JSON lock body and ignores it when the pid is dead", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, started_at: "x" }));
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(false);
  });

  test("a stale lock does not mask a live autopilot process", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, `${DEAD_PID}`);
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => true });
    expect(r.active).toBe(true);
    expect(r.signal).toBe("process:gbrain autopilot");
  });

  test("a lock with no parseable pid stays conservative (active, no pid in signal)", () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ap-"));
    const lock = join(tmp, "autopilot.lock");
    fs.writeFileSync(lock, "corrupted-no-pid-here");
    const r = detectAutopilot(process.env, { lockPaths: [lock], processRunning: () => false });
    expect(r.active).toBe(true); // can't introspect → don't ignore the lock
    expect(r.signal).toContain("lock:");
    expect(r.signal).not.toContain("pid");
  });
});

// ── #1734 remove safety (E7: fail closed on user-managed without keep-storage) ─
describe("decideSourceRemove", () => {
  const rows = (extra: GbrainSourceRow[] = []): GbrainSourceRow[] => [
    { id: "gbrain-managed", local_path: clonesPath("gbrain-managed"), config: { remote_url: "https://x/r.git" } },
    { id: "user-managed", local_path: "/tmp/user-repo", config: { remote_url: "https://x/r.git" } },
    { id: "path-managed", local_path: "/tmp/path-repo", config: {} }, // authoritative no remote_url
    ...extra,
  ];
  const fetchRows = (extra?: GbrainSourceRow[]) => () => rows(extra);

  test("absent source → allow (no-op)", () => {
    const d = decideSourceRemove("nope", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
    expect(d.reason).toContain("absent");
  });

  test("user-managed + no --keep-storage → FAIL CLOSED", () => {
    const d = decideSourceRemove("user-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("user-managed");
  });

  test("user-managed + --keep-storage supported → allow with flag", () => {
    const d = decideSourceRemove("user-managed", process.env, { keepStorage: true, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
    expect(d.extraArgs).toContain("--keep-storage");
  });

  test("gbrain-managed (inside clones) → allow even without keep-storage", () => {
    const env = { ...process.env, HOME, GBRAIN_HOME: "" };
    const d = decideSourceRemove("gbrain-managed", env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
  });

  test("path-managed without remote_url → allow (normal --path case)", () => {
    const d = decideSourceRemove("path-managed", process.env, { keepStorage: false, fetchRows: fetchRows() });
    expect(d.allow).toBe(true);
  });

  test("CLI row without ownership metadata → FAIL CLOSED", () => {
    const d = decideSourceRemove("metadata-omitted", process.env, {
      keepStorage: false,
      fetchRows: () => [{ id: "metadata-omitted", local_path: "/tmp/path-repo" }],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("no ownership metadata");
  });

  test("gbrain before 0.28 safely allows metadata-free path-managed rows", () => {
    const d = decideSourceRemove("metadata-omitted", process.env, {
      keepStorage: false,
      urlManagedSources: false,
      fetchRows: () => [{ id: "metadata-omitted", local_path: "/tmp/path-repo" }],
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toContain("predates URL-managed sources");
  });

  test("a user checkout merely nested under legacy GBRAIN_HOME/clones is not owned", () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "gbrain-parent-"));
    const userCheckout = join(root, "clones", "nested-user-checkout");
    fs.mkdirSync(userCheckout, { recursive: true });
    try {
      const d = decideSourceRemove(
        "remote-source",
        { ...process.env, GBRAIN_HOME: root },
        {
          keepStorage: false,
          fetchRows: () => [{
            id: "remote-source",
            local_path: userCheckout,
            config: { remote_url: "https://x/r.git" },
          }],
        },
      );
      expect(d.allow).toBe(false);
      expect(d.reason).toContain("user-managed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("sources unreadable → FAIL CLOSED", () => {
    const d = decideSourceRemove("user-managed", process.env, {
      keepStorage: false,
      fetchRows: () => { throw new Error("boom"); },
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("fail closed");
  });
});

describe("gbrain source-remove confirmation contract", () => {
  function withFakeVersion(versionOutput: string, run: (env: NodeJS.ProcessEnv) => void): void {
    const root = fs.mkdtempSync(join(os.tmpdir(), "gbrain-version-"));
    const fake = join(root, "gbrain");
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${versionOutput}'\n`, { mode: 0o755 });
    try {
      run({ ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test("positively identified pre-0.26.5 CLI uses legacy --yes", () => {
    withFakeVersion("gbrain 0.25.9", (env) => {
      expect(gbrainSourceRemoveConfirmationArgs(env)).toEqual(["--yes"]);
    });
  });

  test("0.26.5 and newer CLI uses --confirm-destructive", () => {
    withFakeVersion("gbrain 0.26.5", (env) => {
      expect(gbrainSourceRemoveConfirmationArgs(env)).toEqual(["--confirm-destructive"]);
    });
  });

  test("unknown CLI identity stays on the current fail-closed contract", () => {
    withFakeVersion("development-build", (env) => {
      expect(gbrainSourceRemoveConfirmationArgs(env)).toEqual(["--confirm-destructive"]);
    });
  });
});

// ── #1734 reclone guard (E-level: require --allow-reclone for URL-managed) ───
describe("decideCodeSync", () => {
  const rows: GbrainSourceRow[] = [
    { id: "url-managed", local_path: "/tmp/u", config: { remote_url: "https://x/r.git" } },
    { id: "plain", local_path: "/tmp/p", config: {} },
    { id: "metadata-omitted", local_path: "/tmp/unknown" },
  ];
  const fetch = () => rows;

  test("URL-managed + no --allow-reclone → refuse", () => {
    const d = decideCodeSync("url-managed", process.env, false, fetch);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("auto-reclone");
  });

  test("URL-managed + --allow-reclone → allow", () => {
    const d = decideCodeSync("url-managed", process.env, true, fetch);
    expect(d.allow).toBe(true);
  });

  test("no remote_url → allow", () => {
    const d = decideCodeSync("plain", process.env, false, fetch);
    expect(d.allow).toBe(true);
  });

  test("sources unreadable → fail CLOSED unless reclone is explicitly allowed", () => {
    const d = decideCodeSync("url-managed", process.env, false, () => { throw new Error("boom"); });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("--allow-reclone");
    expect(decideCodeSync("url-managed", process.env, true, () => { throw new Error("boom"); }).allow).toBe(true);
  });

  test("CLI row without ownership metadata requires explicit reclone opt-in", () => {
    const refused = decideCodeSync("metadata-omitted", process.env, false, fetch);
    expect(refused.allow).toBe(false);
    expect(refused.reason).toContain("no ownership metadata");
    expect(decideCodeSync("metadata-omitted", process.env, true, fetch).allow).toBe(true);
  });

  test("gbrain before 0.28 keeps normal metadata-free code sync compatible", () => {
    const allowed = decideCodeSync(
      "metadata-omitted",
      process.env,
      false,
      fetch,
      { urlManagedSources: false },
    );
    expect(allowed.allow).toBe(true);
    expect(allowed.reason).toContain("predates URL-managed sources");
  });
});

describe("destructive spawn race gates", () => {
  function withAutopilotStartingDuringProbe(
    run: (env: NodeJS.ProcessEnv, log: string) => void,
    startAutopilot = true,
  ): void {
    const root = fs.mkdtempSync(join(os.tmpdir(), "gbrain-autopilot-race-"));
    const bin = join(root, "bin");
    const state = join(root, ".gbrain");
    const lock = join(state, "autopilot.lock");
    const trigger = join(root, "triggered");
    const log = join(root, "calls.log");
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    const fake = join(bin, "gbrain");
    fs.writeFileSync(fake, `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
if [ "$START_AUTOPILOT" = "1" ] && [ ! -f "${trigger}" ]; then
  printf '%s\n' "$LOCK_PID" > "${lock}"
  : > "${trigger}"
fi
if [ "$1" = "--version" ]; then
  printf '%s\n' 'gbrain 0.42.59.0'
  exit 0
fi
if [ "$1 $2 $3" = "sources remove --help" ] || [ "$1" = "--help" ]; then
  exit 0
fi
if [ "$1 $2 $3" = "sources list --json" ]; then
  printf '%s\n' '{"sources":[{"id":"race-source","local_path":"/repo"}]}'
  exit 0
fi
if [ "$1" = "call" ]; then
  printf '%s\n' '{"sources":[{"id":"race-source","local_path":"/repo","remote_url":null}]}'
  exit 0
fi
if [ "$1 $2 $3" = "sources remove race-source" ]; then
  printf '%s\n' 'DESTRUCTIVE_REMOVE' >> "${log}"
  exit 0
fi
exit 32
`, { mode: 0o755 });
    try {
      run(
        {
          ...process.env,
          HOME: root,
          GBRAIN_HOME: root,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LOCK_PID: String(process.pid),
          START_AUTOPILOT: startAutopilot ? "1" : "0",
        },
        log,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test("source removal rechecks Autopilot after metadata probes", () => {
    withAutopilotStartingDuringProbe((env, log) => {
      const lock = join(env.GBRAIN_HOME ?? "", ".gbrain", "autopilot.lock");
      const detector = () => fs.existsSync(lock)
        ? { active: true, signal: `lock:${lock}` }
        : { active: false, signal: null };
      const result = safeSourcesRemove("race-source", env, { detectAutopilot: detector });
      expect(result.removed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("autopilot active");
      expect(fs.readFileSync(log, "utf8")).not.toContain("DESTRUCTIVE_REMOVE");
    });
  });

  test("source removal performs no gbrain probe after the final Autopilot check", () => {
    withAutopilotStartingDuringProbe((env, log) => {
      const detector = () => {
        fs.appendFileSync(log, "AUTOPILOT_CHECK\n");
        return { active: false, signal: null };
      };
      const result = safeSourcesRemove("race-source", env, { detectAutopilot: detector });

      expect(result.removed).toBe(true);
      expect(result.skipped).toBe(false);
      const calls = fs.readFileSync(log, "utf8").trim().split("\n");
      const removeIndex = calls.findIndex((line) => line.startsWith("sources remove race-source"));
      expect(removeIndex).toBeGreaterThan(0);
      expect(calls[removeIndex - 1]).toBe("AUTOPILOT_CHECK");
    }, false);
  });

  test("code walk rechecks Autopilot after ownership probes", () => {
    withAutopilotStartingDuringProbe((env) => {
      const lock = join(env.GBRAIN_HOME ?? "", ".gbrain", "autopilot.lock");
      const detector = () => fs.existsSync(lock)
        ? { active: true, signal: `lock:${lock}` }
        : { active: false, signal: null };
      const result = guardCodeSyncBeforeWalk("race-source", env, false, {
        detectAutopilot: detector,
      });
      expect(result.allow).toBe(false);
      expect(result.status).toBe("refused-autopilot");
      expect(result.reason).toContain("autopilot active");
    });
  });
});

// ── path containment uses realpath (symlink can't smuggle a delete out) ──────
describe("isInside", () => {
  test("plain path inside dir", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/x", "/a/b")).toBe(false);
  });

  test("sibling-prefix is not 'inside' (clonesX vs clones)", () => {
    expect(isInside("/a/clones-evil/x", "/a/clones")).toBe(false);
  });

  test("symlink pointing outside resolves outside", () => {
    const base = fs.mkdtempSync(join(os.tmpdir(), "clones-"));
    const outside = fs.mkdtempSync(join(os.tmpdir(), "outside-"));
    const link = join(base, "sneaky");
    fs.symlinkSync(outside, link);
    // link lives under base, but realpath resolves to `outside` → not inside base.
    expect(isInside(link, base)).toBe(false);
  });
});
