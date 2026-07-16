/**
 * Unit tests for lib/gbrain-sources.ts (per /plan-eng-review D3 DRY extraction).
 *
 * The helper shells out to the real `gbrain` CLI. To test idempotency
 * deterministically without a live brain, we put a fake `gbrain` binary on
 * PATH that emits canned `sources list --json` output and records its
 * invocations. The same trick `test/gstack-gbrain-source-wireup.test.ts` uses.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ensureSourceRegistered, probeSource, sourcePageCount } from "../lib/gbrain-sources";

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
  const bindir = join(tmp, "bin");
  mkdirSync(bindir, { recursive: true });
  const statePath = join(tmp, "state.json");
  const logPath = join(tmp, "calls.log");
  writeFileSync(statePath, JSON.stringify(initialState));
  writeFileSync(logPath, "");

  const fake = `#!/bin/sh
echo "$@" >> "${logPath}"
case "$1 $2" in
  "--version ")
    echo "gbrain 0.25.1"
    exit 0
    ;;
  "sources list")
    cat "${statePath}"
    exit 0
    ;;
  "sources add")
    ID="$3"
    shift 3
    PATH_VAL=""
    FED="false"
    while [ $# -gt 0 ]; do
      case "$1" in
        --path) PATH_VAL="$2"; shift 2 ;;
        --federated) FED="true"; shift ;;
        *) shift ;;
      esac
    done
    NEW=$(jq --arg id "$ID" --arg path "$PATH_VAL" --argjson fed "$FED" \
      '.sources += [{id: $id, local_path: $path, federated: $fed, page_count: 0}]' "${statePath}")
    echo "$NEW" > "${statePath}"
    exit 0
    ;;
  "sources remove")
    ID="$3"
    NEW=$(jq --arg id "$ID" '.sources = (.sources | map(select(.id != $id)))' "${statePath}")
    echo "$NEW" > "${statePath}"
    exit 0
    ;;
esac
echo "fake gbrain: unknown command: $@" >&2
exit 1
`;
  const fakePath = join(bindir, "gbrain");
  writeFileSync(fakePath, fake);
  chmodSync(fakePath, 0o755);

  // Build the env override we'll pass to helper calls. We do NOT mutate
  // process.env globally because Bun's execFileSync caches PATH at process
  // start; explicit env is the only reliable way to redirect spawn-time PATH.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bindir}:${process.env.PATH || ""}` };

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
