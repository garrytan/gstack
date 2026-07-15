/**
 * Unit tests for lib/gbrain-sources.ts (per /plan-eng-review D3 DRY extraction).
 *
 * The helper shells out to the real `gbrain` CLI. To test idempotency
 * deterministically without a live brain, we put a fake `gbrain` binary on
 * PATH that emits canned `sources list --json` output and records its
 * invocations. The same trick `test/gstack-gbrain-source-wireup.test.ts` uses.
 */

import { afterAll, describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnSync } from "child_process";

import { ensureSourceRegistered, probeSource, sourcePageCount } from "../lib/gbrain-sources";

const FAKE_BUILD_ROOT = mkdtempSync(join(tmpdir(), "gbrain-sources-fake-bin-"));
const FAKE_SOURCE = join(FAKE_BUILD_ROOT, "fake-gbrain.ts");
const FAKE_BINARY = join(FAKE_BUILD_ROOT, process.platform === "win32" ? "gbrain.exe" : "gbrain");

writeFileSync(
  FAKE_SOURCE,
  `import { appendFileSync, readFileSync, writeFileSync } from "fs";
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GBRAIN_STATE_PATH!;
const logPath = process.env.FAKE_GBRAIN_LOG_PATH!;
appendFileSync(logPath, args.join(" ") + "\\n");
if (args[0] === "--version") { console.log("gbrain 0.25.1"); process.exit(0); }
if (args[0] !== "sources") process.exit(1);
const state = JSON.parse(readFileSync(statePath, "utf-8"));
if (args[1] === "list") { console.log(JSON.stringify(state)); process.exit(0); }
if (args[1] === "add") {
  const pathIndex = args.indexOf("--path");
  state.sources.push({
    id: args[2],
    local_path: pathIndex >= 0 ? args[pathIndex + 1] : "",
    federated: args.includes("--federated"),
    page_count: 0,
  });
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
if (args[1] === "remove") {
  state.sources = state.sources.filter((source: { id?: string }) => source.id !== args[2]);
  writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(1);
`,
);
const fakeBuild = spawnSync(
  process.execPath,
  ["build", FAKE_SOURCE, "--compile", "--outfile", FAKE_BINARY],
  { encoding: "utf-8", timeout: 30_000 },
);
if (fakeBuild.status !== 0) {
  throw new Error(`Could not build fake gbrain: ${fakeBuild.stderr || fakeBuild.stdout}`);
}
chmodSync(FAKE_BINARY, 0o755);

afterAll(() => rmSync(FAKE_BUILD_ROOT, { recursive: true, force: true }));

interface FakeGbrainSetup {
  bindir: string;
  statePath: string;
  logPath: string;
  /**
   * Env to pass to helper calls. Bun's execFileSync does NOT respect runtime
   * mutations of process.env.PATH; we have to pass env explicitly. Production
   * callers leave this unset (inherit process.env) — the helper signature has
   * an optional `env` param specifically for tests.
   */
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Build a temp dir with a fake `gbrain` shell script on PATH. The fake honors:
 *   gbrain sources list --json     → cat $STATE_PATH
 *   gbrain sources add <id> --path <p> [--federated]  → append to state, log
 *   gbrain sources remove <id> --yes                  → drop from state, log
 *   gbrain --version                                  → echo "gbrain 0.25.1"
 * Anything else exits 1.
 */
function makeFakeGbrain(initialState: { sources: Array<{ id: string; local_path: string; federated?: boolean; page_count?: number }> }): FakeGbrainSetup {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-sources-test-"));
  const bindir = FAKE_BUILD_ROOT;
  const statePath = join(tmp, "state.json");
  const logPath = join(tmp, "calls.log");
  writeFileSync(statePath, JSON.stringify(initialState));
  writeFileSync(logPath, "");

  // Build the env override we'll pass to helper calls. We do NOT mutate
  // process.env globally because Bun's execFileSync caches PATH at process
  // start; explicit env is the only reliable way to redirect spawn-time PATH.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bindir}${delimiter}${process.env.PATH || ""}`,
    FAKE_GBRAIN_STATE_PATH: statePath,
    FAKE_GBRAIN_LOG_PATH: logPath,
  };

  return {
    bindir,
    statePath,
    logPath,
    env,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("probeSource", () => {
  it("returns absent when source id is not in the list", () => {
    const fake = makeFakeGbrain({ sources: [{ id: "other-source", local_path: "/x" }] });
    const state = probeSource("gstack-code-foo", fake.env);
    expect(state.status).toBe("absent");
    expect(state.registered_path).toBeUndefined();
    fake.cleanup();
  });

  it("returns match when source id is registered (path included)", () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "/Users/me/repo" }],
    });
    const state = probeSource("gstack-code-foo", fake.env);
    expect(state.status).toBe("match");
    expect(state.registered_path).toBe("/Users/me/repo");
    fake.cleanup();
  });
});

describe("ensureSourceRegistered", () => {
  it("adds source when absent, returns changed=true", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const result = await ensureSourceRegistered("gstack-code-foo", "/Users/me/repo", {
      federated: true,
      env: fake.env,
    });
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe("match");
    expect(result.state.registered_path).toBe("/Users/me/repo");

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).toContain("sources add gstack-code-foo --path /Users/me/repo --federated");
    expect(log).not.toContain("sources remove");
    fake.cleanup();
  });

  it("is a no-op when source is already at the correct path, returns changed=false", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "/Users/me/repo" }],
    });
    const result = await ensureSourceRegistered("gstack-code-foo", "/Users/me/repo", { env: fake.env });
    expect(result.changed).toBe(false);
    expect(result.state.status).toBe("match");

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).toContain("sources list --json");
    expect(log).not.toContain("sources add");
    expect(log).not.toContain("sources remove");
    fake.cleanup();
  });

  it("recreates source when path differs (gbrain has no `sources update`), returns changed=true", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "/old/path" }],
    });
    const result = await ensureSourceRegistered("gstack-code-foo", "/new/path", {
      federated: true,
      env: fake.env,
    });
    expect(result.changed).toBe(true);
    expect(result.state.status).toBe("match");
    expect(result.state.registered_path).toBe("/new/path");

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).toContain("sources remove gstack-code-foo --yes");
    expect(log).toContain("sources add gstack-code-foo --path /new/path --federated");
    fake.cleanup();
  });

  it("when reregister_on_drift=false and source is at different path, returns changed=false", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "/old/path" }],
    });
    const result = await ensureSourceRegistered("gstack-code-foo", "/new/path", {
      reregister_on_drift: false,
      env: fake.env,
    });
    expect(result.changed).toBe(false);
    expect(result.state.status).toBe("drift");
    expect(result.state.registered_path).toBe("/old/path");

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).not.toContain("sources remove");
    expect(log).not.toContain("sources add");
    fake.cleanup();
  });

  it("reuses equivalent Windows slash/case paths without destructive re-registration", async () => {
    const fake = makeFakeGbrain({
      sources: [{ id: "gstack-code-foo", local_path: "C:\\Work Trees\\Example Repo" }],
    });
    const result = await ensureSourceRegistered(
      "gstack-code-foo",
      "c:/work trees/example repo",
      { env: fake.env },
    );
    expect(result.changed).toBe(false);
    expect(result.state.status).toBe("match");

    const log = readFileSync(fake.logPath, "utf-8");
    expect(log).not.toContain("sources remove");
    expect(log).not.toContain("sources add");
    fake.cleanup();
  });

  it("registers a Windows worktree path containing spaces as one argument", async () => {
    const fake = makeFakeGbrain({ sources: [] });
    const sourcePath = "C:\\Work Trees\\Example Repo";
    const result = await ensureSourceRegistered("gstack-code-foo", sourcePath, {
      federated: true,
      env: fake.env,
    });
    expect(result.changed).toBe(true);

    const state = JSON.parse(readFileSync(fake.statePath, "utf-8")) as {
      sources: Array<{ local_path?: string }>;
    };
    expect(state.sources[0]?.local_path).toBe(sourcePath);
    fake.cleanup();
  });
});

describe("sourcePageCount", () => {
  it("returns the page_count when the source is registered", () => {
    const fake = makeFakeGbrain({
      sources: [
        { id: "gstack-code-foo", local_path: "/x", page_count: 1247 },
        { id: "other-source", local_path: "/y", page_count: 99 },
      ],
    });
    expect(sourcePageCount("gstack-code-foo", fake.env)).toBe(1247);
    expect(sourcePageCount("other-source", fake.env)).toBe(99);
    fake.cleanup();
  });

  it("returns null when the source is absent", () => {
    const fake = makeFakeGbrain({ sources: [{ id: "other", local_path: "/x", page_count: 5 }] });
    expect(sourcePageCount("missing", fake.env)).toBeNull();
    fake.cleanup();
  });

  it("returns null when page_count is missing from the source object", () => {
    const fake = makeFakeGbrain({ sources: [{ id: "no-count", local_path: "/x" } as { id: string; local_path: string }] });
    expect(sourcePageCount("no-count", fake.env)).toBeNull();
    fake.cleanup();
  });
});
